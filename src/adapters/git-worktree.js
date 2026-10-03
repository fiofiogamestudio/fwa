import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateActualWrites } from '../core/effects.js';
import { stableStringify } from '../core/events.js';
import { createGitEnvironment } from './git-environment.js';
import {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_GIT_TERMINATION_GRACE_MS,
  GitProcessGuard,
  runGitProcess,
  validateGitProcessOptions
} from './git-process.js';

const DEFAULT_BASE_REVISION = 'HEAD';
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const FILESYSTEM_REMOVE_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100
});

export class GitWorktreeError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'GitWorktreeError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * A deliberately narrow Git adapter for isolated FWA runs.
 *
 * Linked worktrees live below <project>/.fwa/worktrees. Git supports this
 * layout, and keeping it below the already-private FWA state directory makes
 * ownership checks unambiguous. Every destructive operation requires the
 * canonical path to be the direct child assigned to a validated run id.
 */
export class GitWorktreeAdapter {
  constructor(projectRoot, {
    gitPath = 'git',
    clock = () => new Date(),
    gitRunner = runProcess,
    gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    gitTerminationGraceMs = DEFAULT_GIT_TERMINATION_GRACE_MS
  } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new GitWorktreeError(
        'projectRoot must be a non-empty string.',
        'invalid-project-root'
      );
    }
    if (typeof gitPath !== 'string' || gitPath.trim() === '' || gitPath.includes('\0')) {
      throw new GitWorktreeError('gitPath must be a non-empty executable path.', 'invalid-git-path');
    }
    if (typeof clock !== 'function') {
      throw new GitWorktreeError('clock must be a function.', 'invalid-clock');
    }
    if (typeof gitRunner !== 'function') {
      throw new GitWorktreeError('gitRunner must be a function.', 'invalid-git-runner');
    }

    this.projectRoot = path.resolve(projectRoot);
    this.gitPath = gitPath;
    this.clock = clock;
    this.gitRunner = gitRunner;
    this.gitProcessOptions = validateGitProcessOptions({
      gitTimeoutMs, gitTerminationGraceMs
    }, GitWorktreeError);
    this.gitProcessGuard = new GitProcessGuard(this.projectRoot, GitWorktreeError);
    this.stateDirectory = path.join(this.projectRoot, '.fwa');
    this.worktreesDirectory = path.join(this.stateDirectory, 'worktrees');
    this.evaluationsDirectory = path.join(this.stateDirectory, 'evaluations');
  }

  async inspect({ baseRevision = DEFAULT_BASE_REVISION } = {}) {
    const projectRoot = await this.#assertProjectRoot();
    const requestedBaseRevision = validateRevision(baseRevision, 'baseRevision');
    const headRevision = await this.#resolveCommit(projectRoot, 'HEAD');
    const resolvedBaseRevision = await this.#resolveCommit(projectRoot, requestedBaseRevision);
    const coreIgnoreCase = await this.#readCoreIgnoreCase(projectRoot);
    await this.#assertStateDirectoryIsUntrackedAndIgnored(projectRoot);
    const entries = await this.#readPorcelainStatus(projectRoot);

    if (entries.length > 0) {
      throw new GitWorktreeError(
        'The project worktree must be Git-clean before a run starts.',
        'dirty-project-root',
        {
          details: {
            changes: entries.map((entry) => ({ ...entry }))
          }
        }
      );
    }

    return {
      projectRoot,
      requestedBaseRevision,
      baseRevision: resolvedBaseRevision,
      headRevision,
      coreIgnoreCase,
      core: { ignoreCase: coreIgnoreCase },
      clean: true
    };
  }

  async create({ runId, baseRevision = DEFAULT_BASE_REVISION } = {}) {
    const normalizedRunId = validateRunId(runId);
    const inspection = await this.inspect({ baseRevision });
    await this.#ensureWorktreesDirectory();

    const workspacePath = this.#expectedWorkspacePath(normalizedRunId);
    await assertPathDoesNotExist(workspacePath, 'workspace-already-exists');
    const branch = branchForRun(normalizedRunId);
    const ref = `refs/heads/${branch}`;
    const existingRef = await this.#git(
      ['show-ref', '--verify', '--quiet', ref],
      { cwd: inspection.projectRoot, allowedExitCodes: [0, 1] }
    );
    if (existingRef.status === 0) {
      throw new GitWorktreeError(
        `Run branch ${ref} already exists.`,
        'run-ref-already-exists',
        { details: { runId: normalizedRunId, ref } }
      );
    }

    try {
      await this.#git([
        'worktree',
        'add',
        '-b',
        branch,
        workspacePath,
        inspection.baseRevision
      ], { cwd: inspection.projectRoot });
    } catch (error) {
      throw gitOperationError(
        `Failed to create the linked worktree for run ${normalizedRunId}.`,
        'worktree-create-failed',
        error,
        { runId: normalizedRunId, workspacePath, ref }
      );
    }

    const workspace = await this.#assertOwnedWorkspace({
      runId: normalizedRunId,
      workspacePath,
      requireRunBranch: true
    });
    const headRevision = await this.#resolveCommit(workspace.workspacePath, 'HEAD');
    const baselineChanges = await this.#collectChangedFiles(
      workspace.workspacePath,
      inspection.baseRevision
    );
    if (baselineChanges.length > 0) {
      throw new GitWorktreeError(
        'The newly created run worktree did not start from a clean baseline.',
        'worktree-baseline-dirty',
        {
          details: {
            runId: normalizedRunId,
            workspacePath: workspace.workspacePath,
            changes: baselineChanges
          }
        }
      );
    }

    return {
      runId: normalizedRunId,
      workspacePath: workspace.workspacePath,
      branch,
      ref,
      baseRevision: inspection.baseRevision,
      headRevision
    };
  }

  async getChangedFiles({ workspacePath, baseRevision = DEFAULT_BASE_REVISION, runId } = {}) {
    const normalizedRunId = runId === undefined
      ? inferRunId(workspacePath)
      : validateRunId(runId);
    const workspace = await this.#assertOwnedWorkspace({
      runId: normalizedRunId,
      workspacePath,
      requireRunBranch: true
    });
    const resolvedBaseRevision = await this.#resolveCommit(
      workspace.workspacePath,
      validateRevision(baseRevision, 'baseRevision')
    );

    return this.#collectChangedFiles(workspace.workspacePath, resolvedBaseRevision);
  }

  /**
   * Read-only ownership proof for a terminal Run workspace. Archive code uses
   * this before copying bytes so a same-repository clone cannot be mistaken for
   * the registered FWA worktree.
   */
  async inspectRunWorkspace({ workspacePath, runId } = {}) {
    await this.gitProcessGuard.assertAvailable();
    const normalizedRunId = validateRunId(runId);
    const workspace = await this.#assertOwnedWorkspace({
      runId: normalizedRunId,
      workspacePath,
      requireRunBranch: true
    });
    const registration = await this.#registeredWorktreeRecord(workspace.workspacePath);
    if (!registration) {
      throw new GitWorktreeError(
        `Run ${normalizedRunId} is not currently registered as a Git worktree.`,
        'worktree-registration-missing',
        { details: { runId: normalizedRunId, workspacePath: workspace.workspacePath } }
      );
    }
    const identity = await this.#captureRealDirectoryIdentity(workspace.workspacePath, {
      code: 'invalid-workspace-path',
      label: 'run workspace'
    });
    const headRevision = await this.#resolveCommit(workspace.workspacePath, 'HEAD');
    if (registration.headRevision !== headRevision) {
      throw new GitWorktreeError(
        `Git registration HEAD differs from Run workspace HEAD ${normalizedRunId}.`,
        'worktree-registration-head-mismatch',
        { details: { registration, headRevision } }
      );
    }
    return {
      runId: normalizedRunId,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      headRevision,
      registration,
      identity: {
        path: identity.path,
        device: identity.device,
        inode: identity.inode
      }
    };
  }

  /** Inspect only a never-started Run's assigned setup location; never clean it. */
  async inspectRunSetupWorkspace({ runId, baseRevision, workspaceRelativePath } = {}) {
    await this.gitProcessGuard.assertAvailable();
    const normalizedRunId = validateRunId(runId);
    const expectedBase = assertObjectId(baseRevision, 'baseRevision');
    if (workspaceRelativePath !== `.fwa/worktrees/${normalizedRunId}`) {
      throw new GitWorktreeError('Setup recovery requires the recorded direct Run child.', 'workspace-path-outside-run');
    }
    const projectRoot = await this.#assertProjectRoot();
    if (await this.#resolveCommit(projectRoot, expectedBase) !== expectedBase) {
      throw new GitWorktreeError('Recorded setup base is not an exact commit.', 'workspace-setup-base-mismatch');
    }
    // Inspect each existing ancestor before absence is considered proof. lstat
    // catches dangling links too; an absent directory under a link is not safe.
    const workspacePath = this.#expectedWorkspacePath(normalizedRunId);
    let missing = false;
    for (const candidate of [this.stateDirectory, this.worktreesDirectory, workspacePath]) {
      try {
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new GitWorktreeError('Setup path must contain only real directories.', 'invalid-workspace-path');
        }
        await canonicalRealDirectory(candidate, { code: 'invalid-workspace-path', label: 'Run setup directory' });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        missing = true;
        break;
      }
    }
    const registration = await this.#registeredWorktreeRecord(workspacePath);
    const branch = branchForRun(normalizedRunId);
    const refResult = await this.#git(['show-ref', '--verify', '--hash', `refs/heads/${branch}`],
      { cwd: projectRoot, allowedExitCodes: [0, 1, 128] });
    // show-ref --verify may use 128 for absence; ask quiet mode to distinguish
    // a genuinely missing ref from an unexpected Git failure.
    if (refResult.status !== 0) {
      const absent = await this.#git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        { cwd: projectRoot, allowedExitCodes: [0, 1] });
      if (absent.status !== 1) throw new GitWorktreeError('Run ref changed during inspection.', 'workspace-setup-identity-changed');
    }
    const refRevision = refResult.status === 0 ? refResult.stdout.trim() : null;
    if (missing) {
      if (registration || refRevision) {
        throw new GitWorktreeError('Missing setup directory still has Git registration or a Run ref.',
          'workspace-setup-partial', { details: { workspacePath, registration, refRevision } });
      }
      return { disposition: 'absent', runId: normalizedRunId, workspacePath, baseRevision: expectedBase,
        branch, headRevision: null, registration: null, identity: null };
    }
    const beforeIdentity = await lstat(workspacePath, { bigint: true });
    const ownership = await this.inspectRunWorkspace({ runId: normalizedRunId, workspacePath });
    const afterIdentity = await lstat(workspacePath, { bigint: true });
    if (!beforeIdentity.isDirectory() || beforeIdentity.isSymbolicLink()
      || !afterIdentity.isDirectory() || afterIdentity.isSymbolicLink()
      || beforeIdentity.dev !== afterIdentity.dev || beforeIdentity.ino !== afterIdentity.ino) {
      throw new GitWorktreeError('Setup directory changed during ownership inspection.', 'workspace-setup-identity-changed');
    }
    if (ownership.headRevision !== expectedBase || refRevision !== expectedBase) {
      throw new GitWorktreeError('Never-started setup HEAD differs from its recorded base.',
        'workspace-setup-base-mismatch', { details: { expectedBase, headRevision: ownership.headRevision, refRevision } });
    }
    // NTFS file IDs can exceed Number.MAX_SAFE_INTEGER. Preserve exact decimal
    // identities in the durable observation instead of rejecting or rounding them.
    return { ...ownership, disposition: 'preserved', baseRevision: expectedBase,
      identity: { path: ownership.identity.path,
        device: afterIdentity.dev.toString(), inode: afterIdentity.ino.toString() } };
  }

  async capture({ workspacePath, baseRevision = DEFAULT_BASE_REVISION, runId } = {}) {
    const normalizedRunId = validateRunId(runId);
    const workspace = await this.#assertOwnedWorkspace({
      runId: normalizedRunId,
      workspacePath,
      requireRunBranch: true
    });
    const resolvedBaseRevision = await this.#resolveCommit(
      workspace.workspacePath,
      validateRevision(baseRevision, 'baseRevision')
    );
    let previousHeadRevision = await this.#resolveCommit(workspace.workspacePath, 'HEAD');

    const ancestry = await this.#git(
      ['merge-base', '--is-ancestor', resolvedBaseRevision, previousHeadRevision],
      { cwd: workspace.workspacePath, allowedExitCodes: [0, 1] }
    );
    if (ancestry.status !== 0) {
      throw new GitWorktreeError(
        'baseRevision must be an ancestor of the run worktree HEAD.',
        'base-not-ancestor',
        {
          details: {
            baseRevision: resolvedBaseRevision,
            headRevision: previousHeadRevision
          }
        }
      );
    }

    const preCaptureChanges = await this.#collectChangedFiles(
      workspace.workspacePath,
      resolvedBaseRevision
    );
    const ignoredFiles = preCaptureChanges.filter(
      (change) => change.status === 'ignored-untracked'
    );
    if (ignoredFiles.length > 0) {
      throw new GitWorktreeError(
        'Ignored untracked files cannot be silently omitted from a captured change set.',
        'uncapturable-ignored-files',
        {
          details: {
            phase: 'pre-capture',
            ignoredFiles,
            changedFiles: preCaptureChanges
          }
        }
      );
    }

    const unmerged = await this.#git(
      ['diff', '--name-only', '--diff-filter=U', '-z', '--'],
      { cwd: workspace.workspacePath }
    );
    const unmergedFiles = splitNul(unmerged.stdout).map(assertSafeGitPath);
    if (unmergedFiles.length > 0) {
      throw new GitWorktreeError(
        'Cannot capture a worktree with unresolved merge conflicts.',
        'unmerged-worktree',
        { details: { files: unmergedFiles } }
      );
    }

    try {
      await this.#git(['add', '-A', '--', '.'], { cwd: workspace.workspacePath });
    } catch (error) {
      throw gitOperationError(
        `Failed to stage run ${normalizedRunId} changes.`,
        'capture-stage-failed',
        error,
        { runId: normalizedRunId, workspacePath: workspace.workspacePath }
      );
    }

    const staged = await this.#git(
      ['diff', '--cached', '--quiet', '--exit-code', '--'],
      { cwd: workspace.workspacePath, allowedExitCodes: [0, 1] }
    );
    let captureCommit = null;

    if (staged.status === 1) {
      const tree = singleLine(await this.#git(
        ['write-tree'],
        { cwd: workspace.workspacePath }
      ), 'write-tree');
      const timestamp = normalizeTimestamp(this.clock());
      const commitEnvironment = {
        GIT_AUTHOR_NAME: 'FWA',
        GIT_AUTHOR_EMAIL: 'fwa@local.invalid',
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_NAME: 'FWA',
        GIT_COMMITTER_EMAIL: 'fwa@local.invalid',
        GIT_COMMITTER_DATE: timestamp
      };
      const message = `fwa(${normalizedRunId}): capture run changes`;
      const commitResult = await this.#git([
        'commit-tree',
        tree,
        '-p',
        previousHeadRevision,
        '-m',
        message
      ], {
        cwd: workspace.workspacePath,
        env: commitEnvironment
      });
      captureCommit = singleLine(commitResult, 'commit-tree');
      assertObjectId(captureCommit, 'commit-tree');

      const ref = `refs/heads/${branchForRun(normalizedRunId)}`;
      try {
        await this.#git([
          'update-ref',
          '-m',
          `fwa capture ${normalizedRunId}`,
          ref,
          captureCommit,
          previousHeadRevision
        ], { cwd: workspace.workspacePath });
      } catch (error) {
        throw gitOperationError(
          `Failed to advance ${ref} to the captured commit.`,
          'capture-ref-update-failed',
          error,
          {
            runId: normalizedRunId,
            ref,
            expectedRevision: previousHeadRevision,
            captureCommit
          }
        );
      }
      previousHeadRevision = captureCommit;
    }

    const headRevision = await this.#resolveCommit(workspace.workspacePath, 'HEAD');
    if (headRevision !== previousHeadRevision) {
      throw new GitWorktreeError(
        'The run ref changed while the capture was being finalized.',
        'capture-ref-race',
        { details: { expected: previousHeadRevision, actual: headRevision } }
      );
    }

    const residualChanges = await this.#collectChangedFiles(
      workspace.workspacePath,
      headRevision
    );
    const revisionList = await this.#git(
      ['rev-list', '--reverse', `${resolvedBaseRevision}..${headRevision}`],
      { cwd: workspace.workspacePath }
    );
    const commits = revisionList.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((revision) => assertObjectId(revision, 'rev-list'));
    const patchResult = await this.#git([
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      resolvedBaseRevision,
      headRevision,
      '--'
    ], { cwd: workspace.workspacePath });

    const finalIgnoredFiles = residualChanges.filter(
      (change) => change.status === 'ignored-untracked'
    );
    if (finalIgnoredFiles.length > 0) {
      throw new GitWorktreeError(
        'Ignored untracked files appeared while the change set was being captured.',
        'uncapturable-ignored-files',
        {
          details: {
            phase: 'post-capture',
            runId: normalizedRunId,
            ref: `refs/heads/${branchForRun(normalizedRunId)}`,
            baseRevision: resolvedBaseRevision,
            headRevision,
            captureCommit,
            commits,
            ignoredFiles: finalIgnoredFiles,
            residualChanges
          }
        }
      );
    }
    if (residualChanges.length > 0) {
      throw new GitWorktreeError(
        'The captured commit does not contain every workspace effect.',
        'uncapturable-worktree-effects',
        {
          details: {
            phase: 'post-capture',
            runId: normalizedRunId,
            ref: `refs/heads/${branchForRun(normalizedRunId)}`,
            baseRevision: resolvedBaseRevision,
            headRevision,
            captureCommit,
            commits,
            residualChanges
          }
        }
      );
    }

    const changedFiles = await this.#collectCommittedChanges(
      workspace.workspacePath,
      resolvedBaseRevision,
      headRevision
    );

    return {
      runId: normalizedRunId,
      workspacePath: workspace.workspacePath,
      branch: branchForRun(normalizedRunId),
      ref: `refs/heads/${branchForRun(normalizedRunId)}`,
      baseRevision: resolvedBaseRevision,
      headRevision,
      captureCommit,
      commits,
      changedFiles,
      patch: patchResult.stdout
    };
  }

  /**
   * Materialize an immutable ChangeSet revision for evaluation. Evaluation
   * worktrees are detached and live in their own namespace: they never reuse a
   * production Run branch or mutate the target checkout.
   */
  async createEvaluation({ evaluationId, revision } = {}) {
    const normalizedEvaluationId = validateEvaluationId(evaluationId);
    const projectRoot = await this.#assertProjectRoot();
    const resolvedRevision = await this.#resolveCommit(
      projectRoot,
      validateRevision(revision, 'revision')
    );
    await this.#assertStateDirectoryIsUntrackedAndIgnored(projectRoot);
    await this.#ensureEvaluationsDirectory();

    const workspacePath = this.#expectedEvaluationWorkspacePath(normalizedEvaluationId);
    await assertPathDoesNotExist(workspacePath, 'evaluation-workspace-already-exists');
    try {
      await this.#git([
        'worktree',
        'add',
        '--detach',
        workspacePath,
        resolvedRevision
      ], { cwd: projectRoot });
    } catch (error) {
      throw gitOperationError(
        `Failed to create the evaluation worktree ${normalizedEvaluationId}.`,
        'evaluation-worktree-create-failed',
        error,
        { evaluationId: normalizedEvaluationId, workspacePath, revision: resolvedRevision }
      );
    }

    const workspace = await this.#assertOwnedEvaluationWorkspace({
      evaluationId: normalizedEvaluationId,
      workspacePath,
      revision: resolvedRevision
    });
    const changes = await this.#readPorcelainStatus(workspace.workspacePath);
    if (changes.length > 0) {
      throw new GitWorktreeError(
        'The newly created evaluation worktree did not start clean.',
        'evaluation-worktree-baseline-dirty',
        {
          details: {
            evaluationId: normalizedEvaluationId,
            workspacePath: workspace.workspacePath,
            changes
          }
        }
      );
    }
    return workspace;
  }

  /** Re-check identity, detached HEAD, exact revision, and observable effects. */
  async inspectEvaluation({ evaluationId, workspacePath, revision } = {}) {
    const workspace = await this.#assertOwnedEvaluationWorkspace({
      evaluationId,
      workspacePath,
      revision
    });
    const changes = await this.#readPorcelainStatus(workspace.workspacePath);
    return {
      ...workspace,
      changes,
      trackedChanges: changes.filter((change) => change.code !== '??')
    };
  }

  /**
   * Remove only the direct, repository-owned detached worktree assigned to an
   * Evaluation. A missing directory is not success while Git still registers
   * it, matching the production-worktree fail-closed rule.
   */
  async removeEvaluation({ evaluationId, workspacePath, revision, force = true } = {}) {
    await this.gitProcessGuard.assertAvailable();
    const normalizedEvaluationId = validateEvaluationId(evaluationId);
    const expectedRevision = revision === undefined
      ? undefined
      : assertObjectId(revision, 'revision');
    if (typeof force !== 'boolean') {
      throw new GitWorktreeError('force must be a boolean.', 'invalid-force');
    }
    const expectedPath = this.#expectedEvaluationWorkspacePath(normalizedEvaluationId);
    const requestedPath = workspacePath === undefined
      ? expectedPath
      : requirePathString(workspacePath, 'workspacePath');
    let workspace;
    try {
      workspace = await this.#assertOwnedEvaluationWorkspace({
        evaluationId: normalizedEvaluationId,
        workspacePath: requestedPath,
        revision: expectedRevision,
        requireDetached: false
      });
    } catch (error) {
      const missingOwnedPath = error?.cause?.code === 'ENOENT'
        && ['invalid-evaluation-workspace-path', 'invalid-evaluations-directory']
          .includes(error?.code);
      if (!missingOwnedPath) {
        throw error;
      }
      const registration = await this.#registeredWorktreeRecord(expectedPath);
      if (registration !== null) {
        if (expectedRevision !== undefined
          && registration.headRevision !== expectedRevision) {
          throw new GitWorktreeError(
            'The stale evaluation worktree registration is not at the expected revision.',
            'evaluation-workspace-revision-mismatch',
            {
              cause: error,
              details: {
                evaluationId: normalizedEvaluationId,
                workspacePath: expectedPath,
                expectedRevision,
                actualRevision: registration.headRevision
              }
            }
          );
        }
        // Git refuses `worktree remove` when an ancestor of a stale registered
        // path is missing. Recreate only FWA's verified evaluations container;
        // the owned child remains absent and Git can then remove its metadata.
        await this.#ensureEvaluationsDirectory();
        let removalError = null;
        try {
          await this.#git(
            ['worktree', 'remove', '--force', expectedPath],
            { cwd: await this.#assertProjectRoot() }
          );
        } catch (error) {
          removalError = error;
        }
        if (await this.#isRegisteredWorktree(expectedPath)
          || await pathExists(expectedPath)) {
          if (removalError !== null) {
            throw gitOperationError(
              `Failed to remove the stale evaluation worktree registration ${normalizedEvaluationId}.`,
              'evaluation-worktree-remove-failed',
              removalError,
              { evaluationId: normalizedEvaluationId, workspacePath: expectedPath }
            );
          }
          throw new GitWorktreeError(
            'Git did not completely remove the stale evaluation worktree registration.',
            'evaluation-worktree-registration-remains',
            {
              cause: error,
              details: { evaluationId: normalizedEvaluationId, workspacePath: expectedPath }
            }
          );
        }
        return {
          removed: true,
          alreadyAbsent: false,
          filesystemFallbackUsed: false,
          evaluationId: normalizedEvaluationId,
          workspacePath: expectedPath
        };
      }
      return {
        removed: false,
        alreadyAbsent: true,
        filesystemFallbackUsed: false,
        evaluationId: normalizedEvaluationId,
        workspacePath: expectedPath
      };
    }

    const removalIdentity = await this.#captureRemovalIdentity({
      parentPath: this.evaluationsDirectory,
      workspacePath: workspace.workspacePath,
      expectedPath,
      parentCode: 'invalid-evaluations-directory',
      workspaceCode: 'invalid-evaluation-workspace-path',
      ownershipCode: 'evaluation-workspace-path-outside-owner',
      parentLabel: 'FWA evaluations directory',
      workspaceLabel: 'evaluation worktree'
    });
    const arguments_ = ['worktree', 'remove'];
    if (force) arguments_.push('--force');
    arguments_.push(workspace.workspacePath);
    let removalError = null;
    try {
      await this.#git(arguments_, { cwd: await this.#assertProjectRoot() });
    } catch (error) {
      removalError = error;
    }
    if (await this.#isRegisteredWorktree(workspace.workspacePath)) {
      if (removalError !== null) {
        throw gitOperationError(
          `Failed to remove evaluation worktree ${normalizedEvaluationId}.`,
          'evaluation-worktree-remove-failed',
          removalError,
          {
            evaluationId: normalizedEvaluationId,
            workspacePath: workspace.workspacePath,
            force,
            registered: true
          }
        );
      }
      throw new GitWorktreeError(
        'Git reported success but retained the evaluation worktree registration.',
        'evaluation-worktree-registration-remains',
        {
          details: {
            evaluationId: normalizedEvaluationId,
            workspacePath: workspace.workspacePath
          }
        }
      );
    }
    let filesystemFallbackUsed = false;
    if (await pathExists(workspace.workspacePath)) {
      await this.#removeFilesystemResidual(removalIdentity, {
        parentCode: 'invalid-evaluations-directory',
        workspaceCode: 'invalid-evaluation-workspace-path',
        ownershipCode: 'evaluation-workspace-path-outside-owner',
        identityCode: 'evaluation-worktree-filesystem-identity-changed',
        removalCode: 'evaluation-worktree-filesystem-remove-failed',
        registrationCode: 'evaluation-worktree-registration-remains',
        parentLabel: 'FWA evaluations directory',
        workspaceLabel: 'evaluation worktree'
      });
      filesystemFallbackUsed = true;
    }
    if (await this.#isRegisteredWorktree(workspace.workspacePath)
      || await pathExists(workspace.workspacePath)) {
      throw new GitWorktreeError(
        'The evaluation worktree remains after removal recovery.',
        'evaluation-worktree-registration-remains',
        {
          cause: removalError,
          details: {
            evaluationId: normalizedEvaluationId,
            workspacePath: workspace.workspacePath,
            filesystemFallbackUsed
          }
        }
      );
    }
    return {
      removed: true,
      filesystemFallbackUsed,
      evaluationId: normalizedEvaluationId,
      workspacePath: workspace.workspacePath
    };
  }

  async inspectEvaluationResidue() {
    const projectRoot = await this.#assertProjectRoot();
    const entries = [];
    for (const registeredPath of await this.#registeredWorktreePaths()) {
      const workspacePath = path.resolve(registeredPath);
      const relative = path.relative(this.evaluationsDirectory, workspacePath);
      if (path.isAbsolute(relative)
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)) {
        continue;
      }
      if (relative === '' || relative.includes(path.sep)) {
        throw new GitWorktreeError(
          'A registered worktree under .fwa/evaluations has an invalid managed path.',
          'invalid-evaluation-worktree-registration',
          { details: { workspacePath, relative } }
        );
      }
      let evaluationId;
      try {
        evaluationId = validateEvaluationId(relative);
      } catch (error) {
        throw new GitWorktreeError(
          'A registered worktree under .fwa/evaluations has an invalid evaluation id.',
          'invalid-evaluation-worktree-registration',
          { cause: error, details: { workspacePath, relative } }
        );
      }
      const exists = await pathExists(workspacePath);
      if (exists) {
        const owned = await this.#assertOwnedEvaluationWorkspace({
          evaluationId,
          workspacePath,
          requireDetached: false
        });
        entries.push({
          evaluationId,
          workspacePath: owned.workspacePath,
          registered: true,
          exists: true
        });
      } else {
        entries.push({ evaluationId, workspacePath, registered: true, exists: false });
      }
    }
    entries.sort((left, right) => left.workspacePath.localeCompare(
      right.workspacePath,
      'en'
    ));
    return { ok: entries.length === 0, entries, count: entries.length, projectRoot };
  }

  /**
   * Re-resolve a persisted ChangeSet against the repository object database.
   * The event log and artifacts remain the durable record; this additionally
   * detects missing objects or a convenience ref that was later moved.
   */
  async verifyChangeSet(changeSet) {
    if (changeSet === null || typeof changeSet !== 'object' || Array.isArray(changeSet)) {
      throw new GitWorktreeError('changeSet must be an object.', 'invalid-change-set');
    }
    const runId = validateRunId(changeSet.runId);
    const expectedBranch = branchForRun(runId);
    const expectedRef = `refs/heads/${expectedBranch}`;
    if (changeSet.branch !== expectedBranch || changeSet.ref !== expectedRef) {
      throw new GitWorktreeError(
        'ChangeSet branch/ref does not belong to its run.',
        'invalid-change-set',
        { details: { runId, expectedBranch, expectedRef } }
      );
    }
    const baseRevision = assertObjectId(changeSet.baseRevision, 'changeSet.baseRevision');
    const headRevision = assertObjectId(changeSet.headRevision, 'changeSet.headRevision');
    if (!Array.isArray(changeSet.commits)
      || changeSet.commits.some((commit) => (
        typeof commit !== 'string' || !/^[a-f0-9]{40,64}$/u.test(commit)
      ))) {
      throw new GitWorktreeError(
        'ChangeSet commits must be Git object ids.',
        'invalid-change-set'
      );
    }
    const projectRoot = await this.#assertProjectRoot();
    const [resolvedBase, resolvedHead, resolvedRef] = await Promise.all([
      this.#resolveCommit(projectRoot, baseRevision),
      this.#resolveCommit(projectRoot, headRevision),
      this.#resolveCommit(projectRoot, expectedRef)
    ]);
    if (resolvedBase !== baseRevision
      || resolvedHead !== headRevision
      || resolvedRef !== headRevision) {
      throw new GitWorktreeError(
        `ChangeSet ${changeSet.id ?? runId} no longer resolves to its recorded objects.`,
        'changeset-ref-mismatch',
        {
          details: {
            baseRevision,
            headRevision,
            ref: expectedRef,
            actualRefRevision: resolvedRef
          }
        }
      );
    }
    const ancestry = await this.#git(
      ['merge-base', '--is-ancestor', baseRevision, headRevision],
      { cwd: projectRoot, allowedExitCodes: [0, 1] }
    );
    if (ancestry.status !== 0) {
      throw new GitWorktreeError(
        'ChangeSet base is not an ancestor of its head.',
        'changeset-history-mismatch'
      );
    }
    const revisionList = await this.#git(
      ['rev-list', '--reverse', `${baseRevision}..${headRevision}`],
      { cwd: projectRoot }
    );
    const commits = revisionList.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((revision) => assertObjectId(revision, 'rev-list'));
    if (JSON.stringify(commits) !== JSON.stringify(changeSet.commits)) {
      throw new GitWorktreeError(
        'ChangeSet commit list differs from repository history.',
        'changeset-history-mismatch',
        { details: { expected: changeSet.commits, actual: commits } }
      );
    }
    const changes = await this.#collectCommittedChanges(
      projectRoot,
      baseRevision,
      headRevision
    );
    const patch = (await this.#git([
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      baseRevision,
      headRevision,
      '--'
    ], { cwd: projectRoot })).stdout;
    return {
      ok: true,
      runId,
      ref: expectedRef,
      baseRevision,
      headRevision,
      commits,
      changes,
      patchDigest: createHash('sha256').update(patch, 'utf8').digest('hex')
    };
  }

  /** Restore verified prior work into a fresh Run without advancing its HEAD. */
  async restoreCandidate({ workspacePath, runId, baseRevision, changeSet, patch, writes } = {}) {
    let phase = 'target-invalid';
    let temporaryDirectory;
    let patchPath;
    try {
      await this.gitProcessGuard.assertAvailable();
      const normalizedRunId = validateRunId(runId);
      const expectedBase = assertObjectId(baseRevision, 'baseRevision');
      const assertFreshTarget = async () => {
        const workspace = await this.inspectRunWorkspace({ workspacePath, runId: normalizedRunId });
        if (workspace.headRevision !== expectedBase
          || (await this.#collectChangedFiles(workspace.workspacePath, expectedBase)).length > 0) {
          throw new GitWorktreeError(
            'Candidate restoration requires a clean Run still at its recorded base.',
            'repair-candidate-target-not-fresh'
          );
        }
        return workspace;
      };
      const workspace = await assertFreshTarget();
      phase = 'source-invalid';
      if (changeSet?.runId === normalizedRunId) {
        throw new GitWorktreeError('A Run cannot restore its own candidate.', 'repair-candidate-same-run');
      }
      const verified = await this.verifyChangeSet(changeSet);
      if (stableStringify(verified.changes) !== stableStringify(changeSet.changes)
        || stableStringify(verified.commits) !== stableStringify(changeSet.commits)
        || verified.patchDigest !== changeSet.patchArtifact?.digest) {
        throw new GitWorktreeError('Candidate records differ from verified Git evidence.',
          'repair-candidate-source-mismatch');
      }
      phase = 'patch-invalid';
      if (!(typeof patch === 'string' || Buffer.isBuffer(patch))) {
        throw new GitWorktreeError('The candidate patch must be verified bytes.', 'repair-candidate-patch-invalid');
      }
      const patchBytes = Buffer.isBuffer(patch) ? Buffer.from(patch) : Buffer.from(patch, 'utf8');
      if (createHash('sha256').update(patchBytes).digest('hex') !== verified.patchDigest) {
        throw new GitWorktreeError('Candidate artifact differs from its Git patch.', 'repair-candidate-patch-mismatch');
      }
      const actualFiles = [...new Set(verified.changes.flatMap((change) => (
        change.previousPath === undefined ? [change.path] : [change.path, change.previousPath]
      )))].sort((left, right) => left.localeCompare(right));
      if (!Array.isArray(changeSet.changedFiles)
        || JSON.stringify(actualFiles) !== JSON.stringify(changeSet.changedFiles)) {
        throw new GitWorktreeError(
          'Candidate changedFiles differs from the complete Git change set.',
          'repair-candidate-paths-mismatch',
          { details: { expected: changeSet.changedFiles, actual: actualFiles } }
        );
      }
      phase = 'scope-invalid';
      const scope = validateActualWrites(writes, actualFiles, {
        ignoreCase: await this.#readCoreIgnoreCase(workspace.workspacePath)
      });
      if (!scope.ok) {
        throw new GitWorktreeError('Candidate writes exceed this Run scope.',
          'repair-candidate-scope-violation', { details: scope });
      }
      const result = { changeSetId: changeSet.id, baseRevision: expectedBase,
        candidateRevision: verified.headRevision };
      if (verified.baseRevision !== expectedBase) {
        return { status: 'baseline-changed', ...result, candidateBaseRevision: verified.baseRevision };
      }
      phase = 'target-invalid';
      // Recheck after source/artifact inspection. git apply --index additionally
      // requires each affected working file to match the index before writing.
      await assertFreshTarget();
      if (patchBytes.length === 0) return { status: 'restored', ...result };
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'fwa-repair-'));
      patchPath = path.join(temporaryDirectory, 'candidate.patch');
      await writeFile(patchPath, patchBytes, { mode: 0o600, flag: 'wx' });
      phase = 'apply-failed';
      const applyArguments = ['apply', '--index', '--binary'];
      await this.#git([...applyArguments, '--check', '--', patchPath], { cwd: workspace.workspacePath });
      await assertFreshTarget();
      await this.#git([...applyArguments, '--', patchPath], { cwd: workspace.workspacePath });
      phase = 'restore-mismatch';
      const restoredHead = await this.#resolveCommit(workspace.workspacePath, 'HEAD');
      const restoredTree = singleLine(await this.#git(['write-tree'], { cwd: workspace.workspacePath }), 'write-tree');
      const candidateTree = singleLine(await this.#git(
        ['rev-parse', '--verify', `${verified.headRevision}^{tree}`], { cwd: workspace.workspacePath }
      ), 'candidate tree');
      const residual = await this.#git(['diff', '--quiet', '--exit-code', '--'], {
        cwd: workspace.workspacePath, allowedExitCodes: [0, 1]
      });
      if (restoredHead !== expectedBase || restoredTree !== candidateTree || residual.status !== 0) {
        throw new GitWorktreeError('Restored work differs from its candidate or the Run base moved.',
          'repair-candidate-restore-mismatch');
      }
      return { status: 'restored', ...result };
    } catch (error) {
      if (error?.code?.startsWith('repair-candidate-')
        || error?.code === 'git-process-termination-unconfirmed') throw error;
      throw new GitWorktreeError(`Candidate restoration failed: ${error.message}`,
        `repair-candidate-${phase}`, { cause: error, details: { causeCode: error.code ?? null } });
    } finally {
      // Only our two private temporary paths are removed; never clean a Run.
      if (patchPath) await unlink(patchPath).catch(() => {});
      if (temporaryDirectory) await rmdir(temporaryDirectory).catch(() => {});
    }
  }

  async remove({ runId, workspacePath, force = false } = {}) {
    await this.gitProcessGuard.assertAvailable();
    const normalizedRunId = validateRunId(runId);
    if (typeof force !== 'boolean') {
      throw new GitWorktreeError('force must be a boolean.', 'invalid-force');
    }
    const expectedPath = this.#expectedWorkspacePath(normalizedRunId);
    const requestedPath = workspacePath === undefined
      ? expectedPath
      : requirePathString(workspacePath, 'workspacePath');
    let workspace;
    try {
      workspace = await this.#assertOwnedWorkspace({
        runId: normalizedRunId,
        workspacePath: requestedPath,
        requireRunBranch: true
      });
    } catch (error) {
      if (error?.code !== 'invalid-workspace-path' || error?.cause?.code !== 'ENOENT') {
        throw error;
      }
      const registered = await this.#isRegisteredWorktree(expectedPath);
      if (registered) {
        throw new GitWorktreeError(
          'The worktree directory is missing but its Git administrative registration remains.',
          'worktree-registration-remains',
          {
            cause: error,
            details: { runId: normalizedRunId, workspacePath: expectedPath }
          }
        );
      }
      return {
        removed: false,
        alreadyAbsent: true,
        filesystemFallbackUsed: false,
        runId: normalizedRunId,
        workspacePath: expectedPath,
        ref: `refs/heads/${branchForRun(normalizedRunId)}`
      };
    }

    const removalIdentity = await this.#captureRemovalIdentity({
      parentPath: this.worktreesDirectory,
      workspacePath: workspace.workspacePath,
      expectedPath,
      parentCode: 'invalid-worktrees-directory',
      workspaceCode: 'invalid-workspace-path',
      ownershipCode: 'workspace-path-outside-run',
      parentLabel: 'FWA worktrees directory',
      workspaceLabel: 'run worktree'
    });
    const arguments_ = ['worktree', 'remove'];
    if (force) arguments_.push('--force');
    arguments_.push(workspace.workspacePath);
    let removalError = null;
    try {
      await this.#git(arguments_, { cwd: await this.#assertProjectRoot() });
    } catch (error) {
      removalError = error;
    }
    if (await this.#isRegisteredWorktree(workspace.workspacePath)) {
      if (removalError !== null) {
        throw gitOperationError(
          `Failed to remove the worktree for run ${normalizedRunId}.`,
          'worktree-remove-failed',
          removalError,
          {
            runId: normalizedRunId,
            workspacePath: workspace.workspacePath,
            force,
            registered: true
          }
        );
      }
      throw new GitWorktreeError(
        'Git reported success but retained the worktree registration.',
        'worktree-registration-remains',
        { details: { runId: normalizedRunId, workspacePath: workspace.workspacePath } }
      );
    }
    let filesystemFallbackUsed = false;
    if (await pathExists(workspace.workspacePath)) {
      await this.#removeFilesystemResidual(removalIdentity, {
        parentCode: 'invalid-worktrees-directory',
        workspaceCode: 'invalid-workspace-path',
        ownershipCode: 'workspace-path-outside-run',
        identityCode: 'worktree-filesystem-identity-changed',
        removalCode: 'worktree-filesystem-remove-failed',
        registrationCode: 'worktree-registration-remains',
        parentLabel: 'FWA worktrees directory',
        workspaceLabel: 'run worktree'
      });
      filesystemFallbackUsed = true;
    }
    if (await this.#isRegisteredWorktree(workspace.workspacePath)
      || await pathExists(workspace.workspacePath)) {
      throw new GitWorktreeError(
        'The run worktree remains after removal recovery.',
        'worktree-registration-remains',
        {
          cause: removalError,
          details: {
            runId: normalizedRunId,
            workspacePath: workspace.workspacePath,
            filesystemFallbackUsed
          }
        }
      );
    }

    return {
      removed: true,
      filesystemFallbackUsed,
      runId: normalizedRunId,
      workspacePath: workspace.workspacePath,
      ref: `refs/heads/${branchForRun(normalizedRunId)}`
    };
  }

  async #assertProjectRoot() {
    const inputRoot = await canonicalRealDirectory(this.projectRoot, {
      code: 'invalid-project-root',
      label: 'projectRoot'
    });
    let topLevel;
    try {
      const result = await this.#git(
        ['rev-parse', '--show-toplevel'],
        { cwd: inputRoot }
      );
      topLevel = requireOutputLine(result.stdout, 'git top-level');
    } catch (error) {
      if (error instanceof GitWorktreeError && error.code === 'invalid-git-output') throw error;
      throw gitOperationError(
        `${inputRoot} is not a usable Git worktree.`,
        'not-a-git-worktree',
        error,
        { projectRoot: inputRoot }
      );
    }

    const canonicalTopLevel = await canonicalRealDirectory(path.resolve(inputRoot, topLevel), {
      code: 'not-a-git-worktree',
      label: 'Git top-level'
    });
    if (!samePath(inputRoot, canonicalTopLevel)) {
      throw new GitWorktreeError(
        'projectRoot must be the Git worktree top-level, not one of its descendants.',
        'project-root-not-top-level',
        { details: { projectRoot: inputRoot, topLevel: canonicalTopLevel } }
      );
    }
    return canonicalTopLevel;
  }

  async #ensureWorktreesDirectory() {
    const projectRoot = await this.#assertProjectRoot();
    await ensureRealDirectory(this.stateDirectory, projectRoot, 'FWA state directory');
    await ensureRealDirectory(this.worktreesDirectory, this.stateDirectory, 'FWA worktrees directory');
  }

  async #ensureEvaluationsDirectory() {
    const projectRoot = await this.#assertProjectRoot();
    await ensureRealDirectory(this.stateDirectory, projectRoot, 'FWA state directory');
    await ensureRealDirectory(
      this.evaluationsDirectory,
      this.stateDirectory,
      'FWA evaluations directory'
    );
  }

  #expectedWorkspacePath(runId) {
    return path.join(this.worktreesDirectory, validateRunId(runId));
  }

  #expectedEvaluationWorkspacePath(evaluationId) {
    return path.join(this.evaluationsDirectory, validateEvaluationId(evaluationId));
  }

  async #captureRemovalIdentity({
    parentPath,
    workspacePath,
    expectedPath,
    parentCode,
    workspaceCode,
    ownershipCode,
    parentLabel,
    workspaceLabel
  }) {
    const expectedWorkspacePath = path.resolve(expectedPath);
    const requestedWorkspacePath = path.resolve(workspacePath);
    if (!samePath(requestedWorkspacePath, expectedWorkspacePath)) {
      throw new GitWorktreeError(
        `${workspaceLabel} is not the exact owned path selected for removal.`,
        ownershipCode,
        { details: { expectedPath: expectedWorkspacePath, workspacePath: requestedWorkspacePath } }
      );
    }
    const parent = await this.#captureRealDirectoryIdentity(parentPath, {
      code: parentCode,
      label: parentLabel
    });
    const workspace = await this.#captureRealDirectoryIdentity(requestedWorkspacePath, {
      code: workspaceCode,
      label: workspaceLabel
    });
    if (!samePath(workspace.path, expectedWorkspacePath)
      || !isDirectChild(parent.path, workspace.path)) {
      throw new GitWorktreeError(
        `${workspaceLabel} is not the exact direct child owned by its managed parent.`,
        ownershipCode,
        {
          details: {
            expectedPath: expectedWorkspacePath,
            parentPath: parent.path,
            workspacePath: workspace.path
          }
        }
      );
    }
    return { parent, workspace, expectedWorkspacePath };
  }

  async #captureRealDirectoryIdentity(candidate, { code, label }) {
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      throw new GitWorktreeError(`${label} does not exist: ${candidate}`, code, { cause: error });
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new GitWorktreeError(`${label} must be a real directory: ${candidate}`, code);
    }
    let canonicalPath;
    try {
      canonicalPath = path.resolve(await realpath(candidate));
    } catch (error) {
      throw new GitWorktreeError(`Cannot resolve ${label}: ${candidate}`, code, { cause: error });
    }
    return {
      path: canonicalPath,
      device: metadata.dev,
      inode: metadata.ino
    };
  }

  async #removeFilesystemResidual(identity, {
    parentCode,
    workspaceCode,
    ownershipCode,
    identityCode,
    removalCode,
    registrationCode,
    parentLabel,
    workspaceLabel
  }) {
    const observed = await this.#captureRemovalIdentity({
      parentPath: identity.parent.path,
      workspacePath: identity.workspace.path,
      expectedPath: identity.expectedWorkspacePath,
      parentCode,
      workspaceCode,
      ownershipCode,
      parentLabel,
      workspaceLabel
    });
    if (observed.parent.device !== identity.parent.device
      || observed.parent.inode !== identity.parent.inode
      || observed.workspace.device !== identity.workspace.device
      || observed.workspace.inode !== identity.workspace.inode) {
      throw new GitWorktreeError(
        `${workspaceLabel} or its managed parent changed identity during Git removal.`,
        identityCode,
        {
          details: {
            expectedPath: identity.expectedWorkspacePath,
            expectedParent: identity.parent,
            actualParent: observed.parent,
            expectedWorkspace: identity.workspace,
            actualWorkspace: observed.workspace
          }
        }
      );
    }
    if (await this.#isRegisteredWorktree(observed.workspace.path)) {
      throw new GitWorktreeError(
        `Git still registers ${workspaceLabel}; refusing filesystem fallback.`,
        registrationCode,
        { details: { workspacePath: observed.workspace.path } }
      );
    }
    try {
      await rm(observed.workspace.path, FILESYSTEM_REMOVE_OPTIONS);
    } catch (error) {
      throw new GitWorktreeError(
        `Failed to remove the residual ${workspaceLabel} after Git unregistered it.`,
        removalCode,
        { cause: error, details: { workspacePath: observed.workspace.path } }
      );
    }
  }

  async #assertOwnedEvaluationWorkspace({
    evaluationId,
    workspacePath,
    revision,
    requireDetached = true
  }) {
    const normalizedEvaluationId = validateEvaluationId(evaluationId);
    const expectedPath = this.#expectedEvaluationWorkspacePath(normalizedEvaluationId);
    const requestedPath = path.resolve(requirePathString(workspacePath, 'workspacePath'));
    if (!samePath(requestedPath, expectedPath)) {
      throw new GitWorktreeError(
        'workspacePath must be the direct .fwa/evaluations child assigned to evaluationId.',
        'evaluation-workspace-path-outside-owner',
        {
          details: {
            evaluationId: normalizedEvaluationId,
            expectedPath,
            workspacePath: requestedPath
          }
        }
      );
    }

    const canonicalEvaluationsDirectory = await canonicalRealDirectory(
      this.evaluationsDirectory,
      { code: 'invalid-evaluations-directory', label: 'FWA evaluations directory' }
    );
    const canonicalWorkspacePath = await canonicalRealDirectory(requestedPath, {
      code: 'invalid-evaluation-workspace-path',
      label: 'evaluation worktree'
    });
    if (!isDirectChild(canonicalEvaluationsDirectory, canonicalWorkspacePath)) {
      throw new GitWorktreeError(
        'The resolved evaluation worktree is not a direct child of its store.',
        'evaluation-workspace-path-outside-owner'
      );
    }

    const topLevelResult = await this.#git(
      ['rev-parse', '--show-toplevel'],
      { cwd: canonicalWorkspacePath }
    );
    const workspaceTopLevel = await canonicalRealDirectory(
      path.resolve(
        canonicalWorkspacePath,
        requireOutputLine(topLevelResult.stdout, 'evaluation workspace top-level')
      ),
      { code: 'invalid-evaluation-workspace-path', label: 'evaluation Git top-level' }
    );
    if (!samePath(workspaceTopLevel, canonicalWorkspacePath)) {
      throw new GitWorktreeError(
        'The evaluation path is not its Git worktree top-level.',
        'evaluation-workspace-not-top-level'
      );
    }

    const [projectCommonDirectory, workspaceCommonDirectory] = await Promise.all([
      this.#commonGitDirectory(await this.#assertProjectRoot()),
      this.#commonGitDirectory(canonicalWorkspacePath)
    ]);
    if (!samePath(projectCommonDirectory, workspaceCommonDirectory)) {
      throw new GitWorktreeError(
        'The evaluation worktree does not belong to this project repository.',
        'evaluation-workspace-repository-mismatch'
      );
    }

    const branchResult = await this.#git(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { cwd: canonicalWorkspacePath, allowedExitCodes: [0, 1] }
    );
    if (requireDetached && branchResult.status === 0) {
      throw new GitWorktreeError(
        'Evaluation worktrees must remain on a detached HEAD.',
        'evaluation-workspace-not-detached',
        { details: { branch: branchResult.stdout.trimEnd() } }
      );
    }
    const headRevision = await this.#resolveCommit(canonicalWorkspacePath, 'HEAD');
    if (revision !== undefined) {
      const expectedRevision = assertObjectId(revision, 'revision');
      if (headRevision !== expectedRevision) {
        throw new GitWorktreeError(
          'The evaluation worktree HEAD differs from its recorded ChangeSet revision.',
          'evaluation-workspace-revision-mismatch',
          { details: { expectedRevision, actualRevision: headRevision } }
        );
      }
    }
    return {
      evaluationId: normalizedEvaluationId,
      workspacePath: canonicalWorkspacePath,
      headRevision,
      detached: branchResult.status !== 0
    };
  }

  async #assertOwnedWorkspace({ runId, workspacePath, requireRunBranch }) {
    const normalizedRunId = validateRunId(runId);
    const expectedPath = this.#expectedWorkspacePath(normalizedRunId);
    const requestedPath = path.resolve(requirePathString(workspacePath, 'workspacePath'));
    if (!samePath(requestedPath, expectedPath)) {
      throw new GitWorktreeError(
        'workspacePath must be the direct .fwa/worktrees child assigned to runId.',
        'workspace-path-outside-run',
        { details: { runId: normalizedRunId, expectedPath, workspacePath: requestedPath } }
      );
    }

    const canonicalWorktreesDirectory = await canonicalRealDirectory(this.worktreesDirectory, {
      code: 'invalid-worktrees-directory',
      label: 'FWA worktrees directory'
    });
    const canonicalWorkspacePath = await canonicalRealDirectory(requestedPath, {
      code: 'invalid-workspace-path',
      label: 'run workspace'
    });
    if (!isDirectChild(canonicalWorktreesDirectory, canonicalWorkspacePath)) {
      throw new GitWorktreeError(
        'The resolved workspace is not a direct child of this project worktree store.',
        'workspace-path-outside-run',
        {
          details: {
            runId: normalizedRunId,
            worktreesDirectory: canonicalWorktreesDirectory,
            workspacePath: canonicalWorkspacePath
          }
        }
      );
    }

    const topLevelResult = await this.#git(
      ['rev-parse', '--show-toplevel'],
      { cwd: canonicalWorkspacePath }
    );
    const workspaceTopLevel = await canonicalRealDirectory(
      path.resolve(canonicalWorkspacePath, requireOutputLine(topLevelResult.stdout, 'workspace top-level')),
      { code: 'invalid-workspace-path', label: 'run Git top-level' }
    );
    if (!samePath(workspaceTopLevel, canonicalWorkspacePath)) {
      throw new GitWorktreeError(
        'The run workspace path is not its Git worktree top-level.',
        'workspace-not-top-level'
      );
    }

    const [projectCommonDirectory, workspaceCommonDirectory] = await Promise.all([
      this.#commonGitDirectory(await this.#assertProjectRoot()),
      this.#commonGitDirectory(canonicalWorkspacePath)
    ]);
    if (!samePath(projectCommonDirectory, workspaceCommonDirectory)) {
      throw new GitWorktreeError(
        'The run workspace does not belong to this project Git repository.',
        'workspace-repository-mismatch',
        {
          details: {
            projectCommonDirectory,
            workspaceCommonDirectory
          }
        }
      );
    }

    let branch = null;
    if (requireRunBranch) {
      const branchResult = await this.#git(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        { cwd: canonicalWorkspacePath, allowedExitCodes: [0, 1] }
      );
      branch = branchResult.status === 0 ? branchResult.stdout.trimEnd() : null;
      const expectedBranch = branchForRun(normalizedRunId);
      if (branch !== expectedBranch) {
        throw new GitWorktreeError(
          `The run workspace must have ${expectedBranch} checked out.`,
          'workspace-branch-mismatch',
          { details: { expectedBranch, actualBranch: branch } }
        );
      }
    }

    return {
      runId: normalizedRunId,
      workspacePath: canonicalWorkspacePath,
      branch
    };
  }

  async #commonGitDirectory(cwd) {
    const result = await this.#git(['rev-parse', '--git-common-dir'], { cwd });
    const output = requireOutputLine(result.stdout, 'Git common directory');
    return canonicalRealDirectory(path.resolve(cwd, output), {
      code: 'invalid-git-common-directory',
      label: 'Git common directory'
    });
  }

  async #isRegisteredWorktree(workspacePath) {
    return (await this.#registeredWorktreePaths())
      .some((candidate) => samePath(candidate, workspacePath));
  }

  async #registeredWorktreeRecord(workspacePath) {
    return (await this.#registeredWorktreeRecords())
      .find((candidate) => samePath(candidate.workspacePath, workspacePath)) ?? null;
  }

  async #registeredWorktreePaths() {
    return (await this.#registeredWorktreeRecords())
      .map((record) => record.workspacePath);
  }

  async #registeredWorktreeRecords() {
    const projectRoot = await this.#assertProjectRoot();
    const result = await this.#git(
      ['worktree', 'list', '--porcelain', '-z'],
      { cwd: projectRoot }
    );
    return parseWorktreeRecords(result.stdout);
  }

  async #resolveCommit(cwd, revision) {
    const result = await this.#git(
      ['rev-parse', '--verify', `${validateRevision(revision, 'revision')}^{commit}`],
      { cwd }
    ).catch((error) => {
      throw gitOperationError(
        `Revision ${JSON.stringify(revision)} does not resolve to a commit.`,
        'revision-not-found',
        error,
        { revision }
      );
    });
    const commit = singleLine(result, 'rev-parse');
    return assertObjectId(commit, 'rev-parse');
  }

  async #readCoreIgnoreCase(cwd) {
    const result = await this.#git(
      ['config', '--type=bool', '--get', 'core.ignorecase'],
      { cwd, allowedExitCodes: [0, 1] }
    );
    // Git's documented effective default is false when the key is absent.
    // `git init` often writes a platform probe, but callers must not have to.
    if (result.status === 1 || result.stdout.trim() === '') return false;
    const value = result.stdout.trim().toLowerCase();
    if (value !== 'true' && value !== 'false') {
      throw new GitWorktreeError(
        `Unexpected core.ignorecase value ${JSON.stringify(result.stdout.trim())}.`,
        'invalid-git-output'
      );
    }
    return value === 'true';
  }

  async #assertStateDirectoryIsUntrackedAndIgnored(cwd) {
    const trackedResult = await this.#git(
      ['ls-files', '-z', '--', '.fwa'],
      { cwd }
    );
    const trackedPaths = splitNul(trackedResult.stdout).map(assertSafeGitPath);
    if (trackedPaths.length > 0) {
      throw new GitWorktreeError(
        'FWA runtime state must never be tracked by the host repository.',
        'fwa-state-tracked',
        {
          details: {
            paths: trackedPaths,
            remediation: 'Remove .fwa files from the Git index and add /.fwa/ to the root .gitignore.'
          }
        }
      );
    }

    const ignored = await this.#git(
      ['check-ignore', '--quiet', '--no-index', '--', '.fwa/probe'],
      { cwd, allowedExitCodes: [0, 1] }
    );
    if (ignored.status !== 0) {
      throw new GitWorktreeError(
        'The host repository must ignore FWA runtime state at .fwa/**.',
        'fwa-state-not-ignored',
        {
          details: {
            probe: '.fwa/probe',
            remediation: 'Add /.fwa/ to the repository root .gitignore before running FWA.'
          }
        }
      );
    }
  }

  async #readPorcelainStatus(cwd) {
    const result = await this.#git([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none'
    ], { cwd });
    return parsePorcelainStatus(result.stdout);
  }

  async #collectChangedFiles(cwd, baseRevision) {
    const trackedResult = await this.#git([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--no-ext-diff',
      baseRevision,
      '--'
    ], { cwd });
    const untrackedResult = await this.#git([
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--'
    ], { cwd });
    const ignoredResult = await this.#git([
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
      '--'
    ], { cwd });
    const changes = parseNameStatus(trackedResult.stdout);
    const trackedPaths = new Set();
    for (const change of changes) {
      trackedPaths.add(change.path);
      if (change.previousPath) trackedPaths.add(change.previousPath);
    }
    for (const file of splitNul(untrackedResult.stdout)) {
      const safePath = assertSafeGitPath(file);
      if (!trackedPaths.has(safePath)) {
        changes.push({ status: 'untracked', code: '??', path: safePath });
      }
    }
    for (const file of splitNul(ignoredResult.stdout)) {
      const safePath = assertSafeGitPath(file);
      if (!trackedPaths.has(safePath)) {
        changes.push({
          status: 'ignored-untracked',
          code: '!!',
          path: safePath,
          capturable: false
        });
      }
    }
    changes.sort(compareChanges);
    return changes;
  }

  async #collectCommittedChanges(cwd, baseRevision, headRevision) {
    const result = await this.#git([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--no-ext-diff',
      baseRevision,
      headRevision,
      '--'
    ], { cwd });
    return parseNameStatus(result.stdout).sort(compareChanges);
  }

  inspectProcessFence() {
    return this.gitProcessGuard.inspect();
  }

  recoverProcessFence(options = {}) {
    return this.gitProcessGuard.recover(options);
  }

  async #git(arguments_, options = {}) {
    const { env, ...processOptions } = options;
    return this.gitProcessGuard.run(this.gitRunner, this.gitPath, arguments_, {
      ...processOptions,
      timeoutMs: this.gitProcessOptions.gitTimeoutMs,
      terminationGraceMs: this.gitProcessOptions.gitTerminationGraceMs,
      env: createGitEnvironment(env)
    });
  }
}

function validateRunId(value) {
  if (typeof value !== 'string'
      || !RUN_ID_PATTERN.test(value)
      || WINDOWS_DEVICE_NAME_PATTERN.test(value)) {
    throw new GitWorktreeError(
      'runId must be a portable 1-64 character identifier using ASCII letters, digits, underscores, or hyphens.',
      'invalid-run-id'
    );
  }
  return value;
}

function validateEvaluationId(value) {
  if (typeof value !== 'string'
      || !RUN_ID_PATTERN.test(value)
      || WINDOWS_DEVICE_NAME_PATTERN.test(value)) {
    throw new GitWorktreeError(
      'evaluationId must be a portable 1-64 character identifier using ASCII letters, digits, underscores, or hyphens.',
      'invalid-evaluation-id'
    );
  }
  return value;
}

function inferRunId(workspacePath) {
  const candidate = requirePathString(workspacePath, 'workspacePath');
  return validateRunId(path.basename(path.resolve(candidate)));
}

function validateRevision(value, label) {
  if (typeof value !== 'string'
      || value.trim() === ''
      || value.startsWith('-')
      || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new GitWorktreeError(
      `${label} must be a non-empty revision and cannot start with "-" or contain control characters.`,
      'invalid-revision'
    );
  }
  return value;
}

function requirePathString(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new GitWorktreeError(`${label} must be a non-empty path.`, 'invalid-workspace-path');
  }
  return value;
}

function branchForRun(runId) {
  return `fwa/runs/${validateRunId(runId)}`;
}

async function canonicalRealDirectory(candidate, { code, label }) {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    throw new GitWorktreeError(`${label} does not exist: ${candidate}`, code, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new GitWorktreeError(`${label} must be a real directory: ${candidate}`, code);
  }
  try {
    return path.resolve(await realpath(candidate));
  } catch (error) {
    throw new GitWorktreeError(`Cannot resolve ${label}: ${candidate}`, code, { cause: error });
  }
}

async function ensureRealDirectory(candidate, parent, label) {
  const canonicalParent = await canonicalRealDirectory(parent, {
    code: 'invalid-worktrees-directory',
    label: `${label} parent`
  });
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw new GitWorktreeError(`Cannot create ${label}: ${candidate}`, 'worktree-state-create-failed', {
        cause: error
      });
    }
  }
  const canonicalCandidate = await canonicalRealDirectory(candidate, {
    code: 'invalid-worktrees-directory',
    label
  });
  if (!isDirectChild(canonicalParent, canonicalCandidate)) {
    throw new GitWorktreeError(
      `${label} must resolve directly below its expected parent.`,
      'invalid-worktrees-directory'
    );
  }
  return canonicalCandidate;
}

async function assertPathDoesNotExist(candidate, code) {
  try {
    await lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new GitWorktreeError(`Cannot inspect workspace path ${candidate}.`, code, { cause: error });
  }
  throw new GitWorktreeError(`Workspace path already exists: ${candidate}`, code);
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function isDirectChild(parent, candidate) {
  return samePath(path.dirname(candidate), parent);
}

function parsePorcelainStatus(output) {
  const tokens = splitNul(output);
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    const record = tokens[index];
    index += 1;
    if (record.length < 4 || record[2] !== ' ') {
      throw new GitWorktreeError(
        `Malformed porcelain status record ${JSON.stringify(record)}.`,
        'invalid-git-output'
      );
    }
    const code = record.slice(0, 2);
    const filePath = assertSafeGitPath(record.slice(3));
    const entry = { code, path: filePath };
    if (code.includes('R') || code.includes('C')) {
      if (index >= tokens.length) {
        throw new GitWorktreeError('Rename status is missing its source path.', 'invalid-git-output');
      }
      entry.previousPath = assertSafeGitPath(tokens[index]);
      index += 1;
    }
    entries.push(entry);
  }
  return entries;
}

function parseNameStatus(output) {
  const tokens = splitNul(output);
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    let code = tokens[index];
    index += 1;
    let firstPath;
    const tab = code.indexOf('\t');
    if (tab >= 0) {
      firstPath = code.slice(tab + 1);
      code = code.slice(0, tab);
    } else {
      if (index >= tokens.length) {
        throw new GitWorktreeError('Name-status record is missing its path.', 'invalid-git-output');
      }
      firstPath = tokens[index];
      index += 1;
    }
    if (!/^[A-Z][0-9]*$/u.test(code)) {
      throw new GitWorktreeError(
        `Malformed name-status code ${JSON.stringify(code)}.`,
        'invalid-git-output'
      );
    }

    if (code.startsWith('R') || code.startsWith('C')) {
      if (index >= tokens.length) {
        throw new GitWorktreeError('Rename/copy status is missing its destination path.', 'invalid-git-output');
      }
      const previousPath = assertSafeGitPath(firstPath);
      const destinationPath = assertSafeGitPath(tokens[index]);
      index += 1;
      if (code.startsWith('R')) {
        // A rename has two write effects: deleting the old path and creating
        // the destination. Keeping both as concrete `path` entries prevents a
        // caller from accidentally validating only the destination.
        entries.push({
          status: 'deleted',
          code,
          path: previousPath,
          renamedTo: destinationPath,
          change: 'rename'
        });
        entries.push({
          status: 'renamed',
          code,
          path: destinationPath,
          previousPath,
          change: 'rename'
        });
      } else {
        entries.push({
          status: 'copied',
          code,
          path: destinationPath,
          copiedFrom: previousPath
        });
      }
    } else {
      entries.push({
        status: statusName(code[0]),
        code,
        path: assertSafeGitPath(firstPath)
      });
    }
  }
  return entries;
}

function statusName(code) {
  const names = {
    A: 'added',
    D: 'deleted',
    M: 'modified',
    T: 'type-changed',
    U: 'unmerged',
    X: 'unknown',
    B: 'broken'
  };
  return names[code] ?? 'changed';
}

function assertSafeGitPath(value) {
  if (typeof value !== 'string'
      || value === ''
      || value.includes('\0')
      || path.posix.isAbsolute(value)
      || path.win32.isAbsolute(value)) {
    throw new GitWorktreeError(
      `Git returned an unsafe repository-relative path ${JSON.stringify(value)}.`,
      'invalid-git-path-output'
    );
  }
  const components = value.split('/');
  if (components.some((component) => component === '..')) {
    throw new GitWorktreeError(
      `Git returned a path traversal ${JSON.stringify(value)}.`,
      'invalid-git-path-output'
    );
  }
  return value;
}

function splitNul(value) {
  if (value === '') return [];
  const tokens = value.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  return tokens;
}

function parseWorktreeRecords(value) {
  const records = [];
  let current = null;
  const finish = () => {
    if (current === null) return;
    if (current.headRevision === null) {
      throw new GitWorktreeError(
        'Git omitted HEAD from a worktree registration.',
        'invalid-git-output',
        { details: { workspacePath: current.workspacePath } }
      );
    }
    records.push(current);
    current = null;
  };
  for (const token of value.split('\0')) {
    if (token === '') {
      finish();
      continue;
    }
    if (token.startsWith('worktree ')) {
      finish();
      const workspacePath = token.slice('worktree '.length);
      if (workspacePath === '' || workspacePath.includes('\0')) {
        throw new GitWorktreeError(
          'Git returned a malformed worktree path.',
          'invalid-git-output'
        );
      }
      const resolved = path.resolve(workspacePath);
      if (records.some((candidate) => samePath(candidate.workspacePath, resolved))) {
        throw new GitWorktreeError(
          'Git returned a duplicate worktree registration.',
          'invalid-git-output',
          { details: { workspacePath: resolved } }
        );
      }
      current = { workspacePath: resolved, headRevision: null };
      continue;
    }
    if (current === null) {
      throw new GitWorktreeError(
        'Git returned worktree metadata without an owning path.',
        'invalid-git-output'
      );
    }
    if (token.startsWith('HEAD ')) {
      if (current.headRevision !== null) {
        throw new GitWorktreeError(
          'Git returned duplicate HEAD metadata for a worktree.',
          'invalid-git-output'
        );
      }
      current.headRevision = assertObjectId(token.slice('HEAD '.length), 'worktree HEAD');
    }
  }
  finish();
  return records;
}

function compareChanges(left, right) {
  const byPath = left.path.localeCompare(right.path, 'en');
  if (byPath !== 0) return byPath;
  return (left.previousPath ?? '').localeCompare(right.previousPath ?? '', 'en');
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GitWorktreeError('clock must return a valid date.', 'invalid-clock-value');
  }
  return date.toISOString();
}

function assertObjectId(value, command) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new GitWorktreeError(
      `${command} returned an invalid object id ${JSON.stringify(value)}.`,
      'invalid-git-output'
    );
  }
  return value;
}

function singleLine(result, command) {
  return requireOutputLine(result.stdout, command);
}

function requireOutputLine(output, label) {
  const normalized = output.replace(/\r?\n$/u, '');
  if (normalized === '' || normalized.includes('\n') || normalized.includes('\r')) {
    throw new GitWorktreeError(`${label} returned malformed output.`, 'invalid-git-output');
  }
  return normalized;
}

function gitOperationError(message, code, cause, details) {
  if (cause instanceof GitWorktreeError && cause.code !== 'git-command-failed') return cause;
  return new GitWorktreeError(message, code, { cause, details });
}

function runProcess(executable, arguments_, options = {}) {
  return runGitProcess(executable, arguments_, { ...options, ErrorType: GitWorktreeError });
}
