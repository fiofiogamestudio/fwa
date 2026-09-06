import {
  lstat,
  mkdir,
  realpath,
  rm,
  rmdir
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { createGitEnvironment } from './git-environment.js';
import {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_GIT_TERMINATION_GRACE_MS,
  GitProcessGuard,
  runGitProcess,
  validateGitProcessOptions
} from './git-process.js';

const CANDIDATE_REF_ROOT = 'refs/fwa/integrations';
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const FILESYSTEM_REMOVE_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100
});

export class GitIntegrationWorkspaceError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'GitIntegrationWorkspaceError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * Materialize merge and revert candidates without moving the integration
 * target. Each operation owns one detached linked worktree under
 * `.fwa/integrations/<integrationId>/worktree` and, on success, one durable
 * `refs/fwa/integrations/<integrationId>/candidate` ref.
 *
 * Prepared results also contain `changedFiles`, structured `changes`, and a
 * UTF-8 string `patch` captured from an exact binary/full-index diff between
 * the requested target revision and the immutable candidate revision.
 *
 * A physical conflict is a normal, inspectable result. Its unmerged worktree
 * remains available until the caller explicitly invokes cleanup with
 * `force: true`. Cleanup never deletes the durable candidate ref.
 */
export class GitIntegrationWorkspaceAdapter {
  constructor(projectRoot, {
    gitPath = 'git',
    clock = () => new Date(),
    gitRunner = runProcess,
    gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    gitTerminationGraceMs = DEFAULT_GIT_TERMINATION_GRACE_MS
  } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new GitIntegrationWorkspaceError(
        'projectRoot must be a non-empty string.',
        'invalid-project-root'
      );
    }
    if (typeof gitPath !== 'string' || gitPath.trim() === '' || gitPath.includes('\0')) {
      throw new GitIntegrationWorkspaceError(
        'gitPath must be a non-empty executable path.',
        'invalid-git-path'
      );
    }
    if (typeof clock !== 'function') {
      throw new GitIntegrationWorkspaceError('clock must be a function.', 'invalid-clock');
    }
    if (typeof gitRunner !== 'function') {
      throw new GitIntegrationWorkspaceError(
        'gitRunner must be a function.',
        'invalid-git-runner'
      );
    }

    this.projectRoot = path.resolve(projectRoot);
    this.gitPath = gitPath;
    this.clock = clock;
    this.gitRunner = gitRunner;
    this.gitProcessOptions = validateGitProcessOptions({
      gitTimeoutMs, gitTerminationGraceMs
    }, GitIntegrationWorkspaceError);
    this.gitProcessGuard = new GitProcessGuard(this.projectRoot, GitIntegrationWorkspaceError);
    this.stateDirectory = path.join(this.projectRoot, '.fwa');
    this.integrationsDirectory = path.join(this.stateDirectory, 'integrations');
  }

  async prepareMerge(input = {}) {
    const request = normalizeMergeRequest(input);
    const context = await this.#createWorkspace(request);

    let result;
    try {
      result = await this.#git([
        '-c',
        'rerere.enabled=false',
        'merge',
        '--no-commit',
        '--no-ff',
        '--no-edit',
        request.sourceRevision
      ], {
        cwd: context.workspacePath,
        allowedExitCodes: [0, 1]
      });
    } catch (error) {
      throw operationError(
        `Failed to merge the source for integration ${request.integrationId}.`,
        'merge-candidate-failed',
        error,
        publicContext(context, request)
      );
    }

    const conflicts = await this.#collectConflicts(context.workspacePath);
    if (conflicts.length > 0) {
      if (result.status === 0) {
        throw new GitIntegrationWorkspaceError(
          'Git reported a successful merge while the index remained unmerged.',
          'invalid-git-output',
          { details: { ...publicContext(context, request), conflicts } }
        );
      }
      await this.#assertOriginalState(context, request);
      return conflictResult('merge', context, request, conflicts);
    }
    if (result.status !== 0) {
      throw new GitIntegrationWorkspaceError(
        'Git did not create a merge candidate and exposed no physical conflicts.',
        'merge-candidate-failed',
        {
          details: {
            ...publicContext(context, request),
            status: result.status,
            stderr: result.stderr.trimEnd()
          }
        }
      );
    }

    const mergeHead = await this.#resolvePseudoRef(
      context.workspacePath,
      'MERGE_HEAD',
      'merge head'
    );
    if (mergeHead !== request.sourceRevision) {
      throw new GitIntegrationWorkspaceError(
        'The merge worktree does not record the exact requested source revision.',
        'merge-head-mismatch',
        {
          details: {
            ...publicContext(context, request),
            expectedMergeHead: request.sourceRevision,
            mergeHead
          }
        }
      );
    }

    return this.#finishCandidate({
      kind: 'merge',
      context,
      request,
      parents: [request.expectedTargetRevision, request.sourceRevision],
      message: `fwa(${request.integrationId}): merge ${request.sourceRevision}`
    });
  }

  async prepareRevert(input = {}) {
    const request = normalizeRevertRequest(input);
    const context = await this.#createWorkspace(request);
    const revertedParents = await this.#parents(
      context.projectRoot,
      request.revertedRevision
    );
    if (revertedParents.length === 0) {
      throw new GitIntegrationWorkspaceError(
        'Reverting a root commit is outside the V0.1 integration contract.',
        'unsupported-root-revert',
        { details: publicContext(context, request) }
      );
    }

    const arguments_ = [
      '-c',
      'rerere.enabled=false',
      'revert',
      '--no-commit',
      '--no-edit'
    ];
    if (revertedParents.length > 1) arguments_.push('--mainline', '1');
    arguments_.push(request.revertedRevision);

    let result;
    try {
      result = await this.#git(arguments_, {
        cwd: context.workspacePath,
        allowedExitCodes: [0, 1]
      });
    } catch (error) {
      throw operationError(
        `Failed to revert the selected revision for integration ${request.integrationId}.`,
        'revert-candidate-failed',
        error,
        publicContext(context, request)
      );
    }

    const conflicts = await this.#collectConflicts(context.workspacePath);
    if (conflicts.length > 0) {
      if (result.status === 0) {
        throw new GitIntegrationWorkspaceError(
          'Git reported a successful revert while the index remained unmerged.',
          'invalid-git-output',
          { details: { ...publicContext(context, request), conflicts } }
        );
      }
      await this.#assertOriginalState(context, request);
      return conflictResult('revert', context, request, conflicts);
    }
    if (result.status !== 0) {
      throw new GitIntegrationWorkspaceError(
        'Git did not create a revert candidate and exposed no physical conflicts.',
        'revert-candidate-failed',
        {
          details: {
            ...publicContext(context, request),
            status: result.status,
            stderr: result.stderr.trimEnd()
          }
        }
      );
    }

    const candidateTree = await this.#writeTree(context.workspacePath);
    const targetTree = await this.#resolveTree(
      context.projectRoot,
      request.expectedTargetRevision
    );
    if (candidateTree === targetTree) {
      throw new GitIntegrationWorkspaceError(
        'Reverting the selected revision produces no tree change at the current target.',
        'empty-revert-candidate',
        { details: { ...publicContext(context, request), candidateTree } }
      );
    }

    return this.#finishCandidate({
      kind: 'revert',
      context,
      request,
      parents: [request.expectedTargetRevision],
      message: `fwa(${request.integrationId}): revert ${request.revertedRevision}`,
      candidateTree,
      mainline: revertedParents.length > 1 ? 1 : null
    });
  }

  async cleanup(input = {}) {
    await this.gitProcessGuard.assertAvailable();
    const request = normalizeCleanupRequest(input);
    const projectRoot = await this.#assertProjectRoot();
    const expectedWorkspacePath = this.#workspacePath(request.integrationId);
    const requestedWorkspacePath = request.workspacePath === undefined
      ? expectedWorkspacePath
      : path.resolve(request.workspacePath);
    if (!samePath(requestedWorkspacePath, expectedWorkspacePath)) {
      throw new GitIntegrationWorkspaceError(
        'workspacePath does not belong to the supplied integrationId.',
        'integration-workspace-path-outside-owner',
        {
          details: {
            integrationId: request.integrationId,
            expectedWorkspacePath,
            workspacePath: requestedWorkspacePath
          }
        }
      );
    }

    const registered = await this.#isRegisteredWorktree(projectRoot, expectedWorkspacePath);
    const exists = await pathExists(expectedWorkspacePath);
    if (!exists) {
      if (registered) {
        const residue = await this.#managedResidueEntry(projectRoot, expectedWorkspacePath);
        if (residue?.integrationId !== request.integrationId) {
          throw new GitIntegrationWorkspaceError(
            'The stale integration worktree registration is not owned by the request.',
            'integration-worktree-not-owned',
            { details: { integrationId: request.integrationId, workspacePath: expectedWorkspacePath } }
          );
        }
        if (!await pathExists(this.#operationDirectory(request.integrationId))) {
          // Git refuses to remove a stale registration when its managed
          // ancestors are gone. Recreate only the verified FWA-owned parent.
          await this.#ensureIntegrationDirectories(request.integrationId);
        }
        let removalError = null;
        try {
          await this.#git(
            ['worktree', 'remove', '--force', expectedWorkspacePath],
            { cwd: projectRoot }
          );
        } catch (error) {
          removalError = error;
        }
        if (await this.#isRegisteredWorktree(projectRoot, expectedWorkspacePath)
          || await pathExists(expectedWorkspacePath)) {
          if (removalError !== null) {
            throw operationError(
              `Failed to remove the stale integration worktree registration ${expectedWorkspacePath}.`,
              'integration-worktree-remove-failed',
              removalError,
              { integrationId: request.integrationId, workspacePath: expectedWorkspacePath }
            );
          }
          throw new GitIntegrationWorkspaceError(
            'Git did not completely remove the stale integration worktree registration.',
            'integration-worktree-remove-incomplete',
            {
              details: {
                integrationId: request.integrationId,
                workspacePath: expectedWorkspacePath
              }
            }
          );
        }
        await this.#removeEmptyOperationDirectory(request.integrationId);
        const candidateRevision = await this.#resolveCandidateRef(
          projectRoot,
          request.integrationId,
          { allowMissing: true }
        );
        return {
          removed: true,
          alreadyAbsent: false,
          filesystemFallbackUsed: false,
          integrationId: request.integrationId,
          workspacePath: expectedWorkspacePath,
          candidateRef: candidateRefFor(request.integrationId),
          candidateRevision,
          candidateRetained: candidateRevision !== null
        };
      }
      await this.#removeEmptyOperationDirectory(request.integrationId);
      return {
        removed: false,
        alreadyAbsent: true,
        filesystemFallbackUsed: false,
        integrationId: request.integrationId,
        workspacePath: expectedWorkspacePath,
        candidateRef: candidateRefFor(request.integrationId)
      };
    }

    const workspace = await this.#assertOwnedWorkspace({
      projectRoot,
      integrationId: request.integrationId,
      workspacePath: expectedWorkspacePath
    });
    if (!registered) {
      throw new GitIntegrationWorkspaceError(
        'The owned integration path is not registered as a Git worktree.',
        'integration-worktree-not-registered',
        { details: { integrationId: request.integrationId, workspacePath: workspace.workspacePath } }
      );
    }
    if (!request.force) {
      const changes = await this.#readPorcelainStatus(workspace.workspacePath, {
        includeIgnored: true
      });
      if (changes.length > 0) {
        throw new GitIntegrationWorkspaceError(
          'The integration worktree is dirty; force is required to discard its state.',
          'integration-workspace-dirty',
          {
            details: {
              integrationId: request.integrationId,
              workspacePath: workspace.workspacePath,
              changes
            }
          }
        );
      }
    }

    const removalIdentity = await this.#captureRemovalIdentity(
      request.integrationId,
      workspace.workspacePath
    );
    const arguments_ = ['worktree', 'remove'];
    if (request.force) arguments_.push('--force');
    arguments_.push(workspace.workspacePath);
    let removalError = null;
    try {
      await this.#git(arguments_, { cwd: projectRoot });
    } catch (error) {
      removalError = error;
    }

    if (await this.#isRegisteredWorktree(projectRoot, workspace.workspacePath)) {
      if (removalError !== null) {
        throw operationError(
          `Failed to remove integration worktree ${workspace.workspacePath}.`,
          'integration-worktree-remove-failed',
          removalError,
          {
            integrationId: request.integrationId,
            workspacePath: workspace.workspacePath,
            registered: true
          }
        );
      }
      throw new GitIntegrationWorkspaceError(
        'Git did not remove the integration worktree registration.',
        'integration-worktree-remove-incomplete',
        { details: { integrationId: request.integrationId, workspacePath: workspace.workspacePath } }
      );
    }
    let filesystemFallbackUsed = false;
    if (await pathExists(workspace.workspacePath)) {
      await this.#removeFilesystemResidual(
        projectRoot,
        request.integrationId,
        removalIdentity
      );
      filesystemFallbackUsed = true;
    }
    if (await pathExists(workspace.workspacePath)
      || await this.#isRegisteredWorktree(projectRoot, workspace.workspacePath)) {
      throw new GitIntegrationWorkspaceError(
        'The integration worktree remains after removal recovery.',
        'integration-worktree-remove-incomplete',
        {
          cause: removalError,
          details: {
            integrationId: request.integrationId,
            workspacePath: workspace.workspacePath,
            filesystemFallbackUsed
          }
        }
      );
    }
    await this.#removeEmptyOperationDirectory(request.integrationId);
    const candidateRevision = await this.#resolveCandidateRef(
      projectRoot,
      request.integrationId,
      { allowMissing: true }
    );
    return {
      removed: true,
      alreadyAbsent: false,
      filesystemFallbackUsed,
      integrationId: request.integrationId,
      workspacePath: workspace.workspacePath,
      candidateRef: candidateRefFor(request.integrationId),
      candidateRevision,
      candidateRetained: candidateRevision !== null
    };
  }

  async listResidue() {
    const projectRoot = await this.#assertProjectRoot();
    const registeredPaths = await this.#registeredWorktreePaths(projectRoot);
    const entries = [];
    for (const registeredPath of registeredPaths) {
      const entry = await this.#managedResidueEntry(projectRoot, registeredPath);
      if (entry !== null) entries.push(entry);
    }
    return entries.sort((left, right) => (
      left.workspacePath.localeCompare(right.workspacePath, 'en')
    ));
  }

  async listCandidateRefs() {
    const projectRoot = await this.#assertProjectRoot();
    const result = await this.#git([
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(symref)',
      'refs'
    ], { cwd: projectRoot });
    const records = parseRefRecords(result.stdout)
      .filter((record) => {
        const normalizedRef = record.ref.toLowerCase();
        const normalizedRoot = CANDIDATE_REF_ROOT.toLowerCase();
        return normalizedRef === normalizedRoot
          || normalizedRef.startsWith(`${normalizedRoot}/`)
          || normalizedRoot.startsWith(`${normalizedRef}/`);
      });
    const candidateRefs = [];
    for (const record of records) {
      if (record.symbolicRef !== null) {
        throw new GitIntegrationWorkspaceError(
          'Symbolic candidate refs are not supported.',
          'symbolic-candidate-ref',
          { details: { candidateRef: record.ref, symbolicRef: record.symbolicRef } }
        );
      }
      const integrationId = integrationIdFromCandidateRef(record.ref);
      candidateRefs.push({
        integrationId,
        candidateRef: record.ref,
        candidateRevision: await this.#resolveExactCommit(
          projectRoot,
          record.revision,
          'candidate revision'
        ),
        structurallyValid: integrationId !== null
      });
    }
    return candidateRefs.sort((left, right) => (
      left.candidateRef.localeCompare(right.candidateRef, 'en')
    ));
  }

  async inspectResidue() {
    const [entries, candidateRefs] = await Promise.all([
      this.listResidue(),
      this.listCandidateRefs()
    ]);
    return {
      ok: entries.length === 0,
      entries,
      count: entries.length,
      candidateRefs,
      candidateRefCount: candidateRefs.length
    };
  }

  /**
   * Delete only the canonical candidate ref for one durable operation. The
   * expected revision is a compare-and-swap guard, and no ref is removed while
   * its managed candidate worktree still exists or remains registered.
   */
  async pruneCandidateRef(input = {}) {
    await this.gitProcessGuard.assertAvailable();
    const request = normalizeCandidateRefPruneRequest(input);
    const projectRoot = await this.#assertProjectRoot();
    const workspacePath = this.#workspacePath(request.integrationId);
    const [registered, exists] = await Promise.all([
      this.#isRegisteredWorktree(projectRoot, workspacePath),
      pathExists(workspacePath)
    ]);
    if (registered || exists) {
      throw new GitIntegrationWorkspaceError(
        'The candidate ref cannot be pruned while its managed worktree remains.',
        'candidate-ref-workspace-remains',
        {
          details: {
            integrationId: request.integrationId,
            workspacePath,
            registered,
            exists
          }
        }
      );
    }

    const candidateRef = candidateRefFor(request.integrationId);
    const observedRevision = await this.#resolveCandidateRef(
      projectRoot,
      request.integrationId,
      { allowMissing: true }
    );
    if (observedRevision === null) {
      await this.#removeEmptyOperationDirectory(request.integrationId);
      return {
        removed: false,
        alreadyAbsent: true,
        integrationId: request.integrationId,
        candidateRef,
        expectedRevision: request.expectedRevision
      };
    }
    if (observedRevision !== request.expectedRevision) {
      throw new GitIntegrationWorkspaceError(
        'The candidate ref no longer matches the expected revision.',
        'candidate-ref-revision-mismatch',
        {
          details: {
            integrationId: request.integrationId,
            candidateRef,
            expectedRevision: request.expectedRevision,
            observedRevision
          }
        }
      );
    }
    try {
      await this.#git([
        'update-ref',
        '-m',
        `fwa prune orphan candidate ${request.integrationId}`,
        '-d',
        candidateRef,
        request.expectedRevision
      ], { cwd: projectRoot });
    } catch (error) {
      throw operationError(
        `Failed to prune candidate ref ${candidateRef}.`,
        'candidate-ref-prune-failed',
        error,
        {
          integrationId: request.integrationId,
          candidateRef,
          expectedRevision: request.expectedRevision
        }
      );
    }
    const after = await this.#resolveCandidateRef(
      projectRoot,
      request.integrationId,
      { allowMissing: true }
    );
    if (after !== null) {
      throw new GitIntegrationWorkspaceError(
        'Git reported success but retained the candidate ref.',
        'candidate-ref-prune-incomplete',
        {
          details: {
            integrationId: request.integrationId,
            candidateRef,
            expectedRevision: request.expectedRevision,
            observedRevision: after
          }
        }
      );
    }
    await this.#removeEmptyOperationDirectory(request.integrationId);
    return {
      removed: true,
      alreadyAbsent: false,
      integrationId: request.integrationId,
      candidateRef,
      expectedRevision: request.expectedRevision
    };
  }

  async #createWorkspace(request) {
    const projectRoot = await this.#assertProjectRoot();
    await this.#assertStateDirectoryIsUntrackedAndIgnored(projectRoot);
    const rootBefore = await this.#snapshotRoot(projectRoot);
    if (rootBefore.changes.length > 0) {
      throw new GitIntegrationWorkspaceError(
        'The project worktree must be Git-clean before integration preparation.',
        'dirty-project-root',
        { details: { changes: rootBefore.changes } }
      );
    }

    await this.#assertTargetRef(projectRoot, request.targetRef);
    const targetRevision = await this.#resolveTarget(projectRoot, request.targetRef);
    if (targetRevision !== request.expectedTargetRevision) {
      throw new GitIntegrationWorkspaceError(
        `Target ${request.targetRef} is not at the exact recorded revision.`,
        'target-revision-mismatch',
        {
          details: {
            targetRef: request.targetRef,
            expectedTargetRevision: request.expectedTargetRevision,
            targetRevision
          }
        }
      );
    }
    await this.#resolveExactCommit(
      projectRoot,
      request.expectedTargetRevision,
      'expectedTargetRevision'
    );
    if (request.sourceRevision !== undefined) {
      await this.#resolveExactCommit(projectRoot, request.sourceRevision, 'sourceRevision');
      if (await this.#isAncestor(
        projectRoot,
        request.sourceRevision,
        request.expectedTargetRevision
      )) {
        throw new GitIntegrationWorkspaceError(
          'sourceRevision is already contained by the exact target revision.',
          'source-already-contained',
          { details: commonPublicRequest(request) }
        );
      }
      if (!await this.#hasMergeBase(
        projectRoot,
        request.expectedTargetRevision,
        request.sourceRevision
      )) {
        throw new GitIntegrationWorkspaceError(
          'The target and source revisions do not share a merge base.',
          'unrelated-source',
          { details: commonPublicRequest(request) }
        );
      }
    } else {
      await this.#resolveExactCommit(projectRoot, request.revertedRevision, 'revertedRevision');
      if (!await this.#isAncestor(
        projectRoot,
        request.revertedRevision,
        request.expectedTargetRevision
      )) {
        throw new GitIntegrationWorkspaceError(
          'revertedRevision is not contained by the exact current target.',
          'revert-not-contained',
          { details: commonPublicRequest(request) }
        );
      }
    }

    const candidateRef = candidateRefFor(request.integrationId);
    const existingCandidate = await this.#resolveCandidateRef(
      projectRoot,
      request.integrationId,
      { allowMissing: true }
    );
    if (existingCandidate !== null) {
      throw new GitIntegrationWorkspaceError(
        `Candidate ref already exists: ${candidateRef}`,
        'candidate-ref-already-exists',
        { details: { integrationId: request.integrationId, candidateRef, existingCandidate } }
      );
    }

    await this.#ensureIntegrationDirectories(request.integrationId);
    const workspacePath = this.#workspacePath(request.integrationId);
    await assertPathDoesNotExist(workspacePath, 'integration-workspace-already-exists');
    try {
      await this.#git([
        'worktree',
        'add',
        '--detach',
        workspacePath,
        request.expectedTargetRevision
      ], { cwd: projectRoot });
    } catch (error) {
      throw operationError(
        `Failed to create the integration worktree for ${request.integrationId}.`,
        'integration-worktree-create-failed',
        error,
        { integrationId: request.integrationId, workspacePath }
      );
    }

    const workspace = await this.#assertOwnedWorkspace({
      projectRoot,
      integrationId: request.integrationId,
      workspacePath
    });
    if (!workspace.detached || workspace.headRevision !== request.expectedTargetRevision) {
      throw new GitIntegrationWorkspaceError(
        'The new integration worktree is not detached at the exact target revision.',
        'integration-worktree-baseline-mismatch',
        {
          details: {
            integrationId: request.integrationId,
            workspacePath: workspace.workspacePath,
            expectedTargetRevision: request.expectedTargetRevision,
            headRevision: workspace.headRevision,
            detached: workspace.detached
          }
        }
      );
    }
    const baselineChanges = await this.#readPorcelainStatus(workspace.workspacePath, {
      includeIgnored: true
    });
    if (baselineChanges.length > 0) {
      throw new GitIntegrationWorkspaceError(
        'The new integration worktree did not start from a clean baseline.',
        'integration-worktree-baseline-dirty',
        {
          details: {
            integrationId: request.integrationId,
            workspacePath: workspace.workspacePath,
            changes: baselineChanges
          }
        }
      );
    }

    const context = {
      projectRoot,
      workspacePath: workspace.workspacePath,
      candidateRef,
      rootBefore
    };
    await this.#assertOriginalState(context, request);
    return context;
  }

  async #finishCandidate({
    kind,
    context,
    request,
    parents,
    message,
    candidateTree = undefined,
    mainline = null
  }) {
    const tree = candidateTree ?? await this.#writeTree(context.workspacePath);
    const timestamp = normalizeTimestamp(this.clock());
    const arguments_ = ['commit-tree', tree];
    for (const parent of parents) arguments_.push('-p', parent);
    arguments_.push('-m', message);

    let candidateRevision;
    try {
      const result = await this.#git(arguments_, {
        cwd: context.workspacePath,
        env: {
          GIT_AUTHOR_NAME: 'FWA',
          GIT_AUTHOR_EMAIL: 'fwa@local.invalid',
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_NAME: 'FWA',
          GIT_COMMITTER_EMAIL: 'fwa@local.invalid',
          GIT_COMMITTER_DATE: timestamp
        }
      });
      candidateRevision = requireSingleLine(result.stdout, 'commit-tree');
      requireObjectId(candidateRevision, 'candidateRevision');
    } catch (error) {
      throw operationError(
        `Failed to create the ${kind} candidate for integration ${request.integrationId}.`,
        'candidate-create-failed',
        error,
        { ...publicContext(context, request), kind, candidateTree: tree, parents }
      );
    }

    await this.#assertOriginalState(context, request);
    try {
      await this.#git(['reset', '--hard', candidateRevision], { cwd: context.workspacePath });
      await this.#git([
        'update-ref',
        '-m',
        `fwa ${kind} candidate ${request.integrationId}`,
        context.candidateRef,
        candidateRevision,
        ''
      ], { cwd: context.projectRoot });
    } catch (error) {
      throw operationError(
        `Failed to publish the candidate for integration ${request.integrationId}.`,
        'candidate-ref-publish-failed',
        error,
        {
          ...publicContext(context, request),
          kind,
          candidateRevision,
          candidateTree: tree,
          parents
        }
      );
    }

    const [workspace, recordedParents, recordedTree, pinnedCandidate] = await Promise.all([
      this.#assertOwnedWorkspace({
        projectRoot: context.projectRoot,
        integrationId: request.integrationId,
        workspacePath: context.workspacePath
      }),
      this.#parents(context.projectRoot, candidateRevision),
      this.#resolveTree(context.projectRoot, candidateRevision),
      this.#resolveCandidateRef(context.projectRoot, request.integrationId)
    ]);
    const changes = await this.#readPorcelainStatus(workspace.workspacePath, {
      includeIgnored: true
    });
    if (!workspace.detached
      || workspace.headRevision !== candidateRevision
      || recordedTree !== tree
      || pinnedCandidate !== candidateRevision
      || !sameArray(recordedParents, parents)
      || changes.length > 0) {
      throw new GitIntegrationWorkspaceError(
        'The materialized candidate does not match its durable integration contract.',
        'candidate-contract-mismatch',
        {
          details: {
            ...publicContext(context, request),
            kind,
            candidateRevision,
            candidateTree: tree,
            expectedParents: parents,
            parents: recordedParents,
            recordedTree,
            pinnedCandidate,
            workspaceHeadRevision: workspace.headRevision,
            detached: workspace.detached,
            changes
          }
        }
      );
    }
    const capture = await this.#captureCandidate(
      context.projectRoot,
      request.expectedTargetRevision,
      candidateRevision
    );
    await this.#assertOriginalState(context, request);

    return {
      disposition: 'prepared',
      kind,
      integrationId: request.integrationId,
      targetRef: request.targetRef,
      expectedTargetRevision: request.expectedTargetRevision,
      ...(kind === 'merge'
        ? { sourceRevision: request.sourceRevision }
        : { revertedRevision: request.revertedRevision, mainline }),
      workspacePath: context.workspacePath,
      candidateRef: context.candidateRef,
      candidateRevision,
      candidateTree: tree,
      parents: [...parents],
      conflicts: [],
      ...capture
    };
  }

  async #captureCandidate(cwd, baseRevision, candidateRevision) {
    const [nameStatus, patch] = await Promise.all([
      this.#git([
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        '--no-ext-diff',
        baseRevision,
        candidateRevision,
        '--'
      ], { cwd }),
      this.#git([
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        baseRevision,
        candidateRevision,
        '--'
      ], { cwd })
    ]);
    const changes = parseNameStatus(nameStatus.stdout).sort(compareChanges);
    const changedFiles = [...new Set(changes.flatMap((change) => [
      change.path,
      ...(change.previousPath === undefined ? [] : [change.previousPath])
    ]))].sort((left, right) => left.localeCompare(right, 'en'));
    return {
      changedFiles,
      changes,
      patch: patch.stdout
    };
  }

  async #assertOriginalState(context, request) {
    const targetRevision = await this.#resolveTarget(context.projectRoot, request.targetRef);
    if (targetRevision !== request.expectedTargetRevision) {
      throw new GitIntegrationWorkspaceError(
        `Target ${request.targetRef} changed during candidate preparation.`,
        'target-ref-race',
        {
          details: {
            targetRef: request.targetRef,
            expectedTargetRevision: request.expectedTargetRevision,
            targetRevision,
            workspacePath: context.workspacePath
          }
        }
      );
    }
    const rootAfter = await this.#snapshotRoot(context.projectRoot);
    if (rootAfter.headRef !== context.rootBefore.headRef
      || rootAfter.headRevision !== context.rootBefore.headRevision
      || !sameChanges(rootAfter.changes, context.rootBefore.changes)) {
      throw new GitIntegrationWorkspaceError(
        'The project root changed during candidate preparation.',
        'project-root-state-changed',
        { details: { before: context.rootBefore, after: rootAfter } }
      );
    }
  }

  async #ensureIntegrationDirectories(integrationId) {
    const projectRoot = await this.#assertProjectRoot();
    await ensureRealDirectory(this.stateDirectory, projectRoot, 'FWA state directory');
    await ensureRealDirectory(
      this.integrationsDirectory,
      this.stateDirectory,
      'FWA integrations directory'
    );
    const operationDirectory = this.#operationDirectory(integrationId);
    await assertPathDoesNotExist(operationDirectory, 'integration-workspace-already-exists');
    await ensureRealDirectory(
      operationDirectory,
      this.integrationsDirectory,
      'FWA integration operation directory'
    );
  }

  async #removeEmptyOperationDirectory(integrationId) {
    const operationDirectory = this.#operationDirectory(integrationId);
    try {
      const metadata = await lstat(operationDirectory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new GitIntegrationWorkspaceError(
          'The integration operation path is not a real directory.',
          'invalid-integration-directory',
          { details: { integrationId, operationDirectory } }
        );
      }
      const canonicalIntegrations = await canonicalRealDirectory(this.integrationsDirectory, {
        code: 'invalid-integrations-directory',
        label: 'FWA integrations directory'
      });
      const canonicalOperation = await canonicalRealDirectory(operationDirectory, {
        code: 'invalid-integration-directory',
        label: 'FWA integration operation directory'
      });
      if (!isDirectChild(canonicalIntegrations, canonicalOperation)) {
        throw new GitIntegrationWorkspaceError(
          'The integration operation path is outside its owned directory.',
          'invalid-integration-directory'
        );
      }
      await rmdir(canonicalOperation);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error instanceof GitIntegrationWorkspaceError) throw error;
      throw new GitIntegrationWorkspaceError(
        'The integration operation directory is not empty after worktree cleanup.',
        'integration-directory-not-empty',
        { cause: error, details: { integrationId, operationDirectory } }
      );
    }
  }

  #operationDirectory(integrationId) {
    return path.join(this.integrationsDirectory, requirePortableId(integrationId, 'integrationId'));
  }

  #workspacePath(integrationId) {
    return path.join(this.#operationDirectory(integrationId), 'worktree');
  }

  async #captureRemovalIdentity(integrationId, workspacePath) {
    const expectedWorkspacePath = path.resolve(this.#workspacePath(integrationId));
    const requestedWorkspacePath = path.resolve(workspacePath);
    if (!samePath(requestedWorkspacePath, expectedWorkspacePath)) {
      throw new GitIntegrationWorkspaceError(
        'The integration worktree is not the exact owned path selected for removal.',
        'integration-workspace-path-outside-owner',
        { details: { expectedWorkspacePath, workspacePath: requestedWorkspacePath } }
      );
    }
    const operation = await this.#captureRealDirectoryIdentity(
      this.#operationDirectory(integrationId),
      {
        code: 'invalid-integration-directory',
        label: 'FWA integration operation directory'
      }
    );
    const workspace = await this.#captureRealDirectoryIdentity(requestedWorkspacePath, {
      code: 'invalid-integration-workspace-path',
      label: 'integration worktree'
    });
    if (!samePath(workspace.path, expectedWorkspacePath)
      || !isDirectChild(operation.path, workspace.path)) {
      throw new GitIntegrationWorkspaceError(
        'The integration worktree is not the exact direct child owned by its operation.',
        'integration-workspace-path-outside-owner',
        {
          details: {
            expectedWorkspacePath,
            operationDirectory: operation.path,
            workspacePath: workspace.path
          }
        }
      );
    }
    return { operation, workspace, expectedWorkspacePath };
  }

  async #captureRealDirectoryIdentity(candidate, { code, label }) {
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      throw new GitIntegrationWorkspaceError(
        `${label} does not exist: ${candidate}`,
        code,
        { cause: error }
      );
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new GitIntegrationWorkspaceError(`${label} must be a real directory.`, code, {
        details: { path: candidate }
      });
    }
    let canonicalPath;
    try {
      canonicalPath = path.resolve(await realpath(candidate));
    } catch (error) {
      throw new GitIntegrationWorkspaceError(`Cannot resolve ${label}.`, code, {
        cause: error,
        details: { path: candidate }
      });
    }
    return {
      path: canonicalPath,
      device: metadata.dev,
      inode: metadata.ino
    };
  }

  async #removeFilesystemResidual(projectRoot, integrationId, identity) {
    const observed = await this.#captureRemovalIdentity(
      integrationId,
      identity.workspace.path
    );
    if (observed.operation.device !== identity.operation.device
      || observed.operation.inode !== identity.operation.inode
      || observed.workspace.device !== identity.workspace.device
      || observed.workspace.inode !== identity.workspace.inode) {
      throw new GitIntegrationWorkspaceError(
        'The integration worktree or its operation directory changed identity during Git removal.',
        'integration-worktree-filesystem-identity-changed',
        {
          details: {
            expectedOperation: identity.operation,
            actualOperation: observed.operation,
            expectedWorkspace: identity.workspace,
            actualWorkspace: observed.workspace
          }
        }
      );
    }
    if (await this.#isRegisteredWorktree(projectRoot, observed.workspace.path)) {
      throw new GitIntegrationWorkspaceError(
        'Git still registers the integration worktree; refusing filesystem fallback.',
        'integration-worktree-remove-incomplete',
        { details: { integrationId, workspacePath: observed.workspace.path } }
      );
    }
    try {
      await rm(observed.workspace.path, FILESYSTEM_REMOVE_OPTIONS);
    } catch (error) {
      throw new GitIntegrationWorkspaceError(
        'Failed to remove the residual integration worktree after Git unregistered it.',
        'integration-worktree-filesystem-remove-failed',
        { cause: error, details: { integrationId, workspacePath: observed.workspace.path } }
      );
    }
  }

  async #assertOwnedWorkspace({ projectRoot, integrationId, workspacePath }) {
    const expectedPath = this.#workspacePath(integrationId);
    const requestedPath = path.resolve(workspacePath);
    if (!samePath(expectedPath, requestedPath)) {
      throw new GitIntegrationWorkspaceError(
        'The integration workspace path is outside its owner.',
        'integration-workspace-path-outside-owner'
      );
    }
    const canonicalOperation = await canonicalRealDirectory(this.#operationDirectory(integrationId), {
      code: 'invalid-integration-directory',
      label: 'FWA integration operation directory'
    });
    const canonicalWorkspace = await canonicalRealDirectory(requestedPath, {
      code: 'invalid-integration-workspace-path',
      label: 'integration worktree'
    });
    if (!isDirectChild(canonicalOperation, canonicalWorkspace)) {
      throw new GitIntegrationWorkspaceError(
        'The resolved integration worktree is outside its owned operation directory.',
        'integration-workspace-path-outside-owner'
      );
    }

    const topLevelResult = await this.#git(
      ['rev-parse', '--show-toplevel'],
      { cwd: canonicalWorkspace }
    );
    const topLevel = await canonicalRealDirectory(
      path.resolve(canonicalWorkspace, requireSingleLine(topLevelResult.stdout, 'Git top-level')),
      { code: 'invalid-integration-workspace-path', label: 'integration Git top-level' }
    );
    if (!samePath(topLevel, canonicalWorkspace)) {
      throw new GitIntegrationWorkspaceError(
        'The integration workspace path is not its Git top-level.',
        'integration-workspace-not-top-level'
      );
    }
    const [projectCommonDirectory, workspaceCommonDirectory] = await Promise.all([
      this.#commonGitDirectory(projectRoot),
      this.#commonGitDirectory(canonicalWorkspace)
    ]);
    if (!samePath(projectCommonDirectory, workspaceCommonDirectory)) {
      throw new GitIntegrationWorkspaceError(
        'The integration worktree belongs to another Git repository.',
        'integration-workspace-repository-mismatch'
      );
    }

    const [branchResult, headRevision] = await Promise.all([
      this.#git(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        { cwd: canonicalWorkspace, allowedExitCodes: [0, 1] }
      ),
      this.#resolveExactCommit(canonicalWorkspace, 'HEAD', 'workspace HEAD')
    ]);
    return {
      workspacePath: canonicalWorkspace,
      headRevision,
      detached: branchResult.status !== 0,
      branch: branchResult.status === 0 ? branchResult.stdout.trimEnd() : null
    };
  }

  async #assertProjectRoot() {
    const inputRoot = await canonicalRealDirectory(this.projectRoot, {
      code: 'invalid-project-root',
      label: 'projectRoot'
    });
    let topLevel;
    try {
      const result = await this.#git(['rev-parse', '--show-toplevel'], { cwd: inputRoot });
      topLevel = requireSingleLine(result.stdout, 'Git top-level');
    } catch (error) {
      if (error instanceof GitIntegrationWorkspaceError
        && error.code === 'invalid-git-output') throw error;
      throw operationError(
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
      throw new GitIntegrationWorkspaceError(
        'projectRoot must be the Git worktree top-level.',
        'project-root-not-top-level',
        { details: { projectRoot: inputRoot, topLevel: canonicalTopLevel } }
      );
    }
    return canonicalTopLevel;
  }

  async #assertStateDirectoryIsUntrackedAndIgnored(cwd) {
    const tracked = await this.#git(['ls-files', '-z', '--', '.fwa'], { cwd });
    const trackedPaths = splitNul(tracked.stdout).map(assertSafeGitPath);
    if (trackedPaths.length > 0) {
      throw new GitIntegrationWorkspaceError(
        'FWA runtime state must never be tracked by the host repository.',
        'fwa-state-tracked',
        { details: { paths: trackedPaths } }
      );
    }
    const ignored = await this.#git(
      ['check-ignore', '--quiet', '--no-index', '--', '.fwa/probe'],
      { cwd, allowedExitCodes: [0, 1] }
    );
    if (ignored.status !== 0) {
      throw new GitIntegrationWorkspaceError(
        'The host repository must ignore FWA runtime state at .fwa/**.',
        'fwa-state-not-ignored'
      );
    }
  }

  async #snapshotRoot(projectRoot) {
    const [headRefResult, headRevision, changes] = await Promise.all([
      this.#git(
        ['symbolic-ref', '--quiet', 'HEAD'],
        { cwd: projectRoot, allowedExitCodes: [0, 1] }
      ),
      this.#resolveExactCommit(projectRoot, 'HEAD', 'HEAD'),
      this.#readPorcelainStatus(projectRoot)
    ]);
    return {
      headRef: headRefResult.status === 0
        ? requireSingleLine(headRefResult.stdout, 'symbolic-ref HEAD')
        : null,
      headRevision,
      changes
    };
  }

  async #readPorcelainStatus(cwd, { includeIgnored = false } = {}) {
    const arguments_ = [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none'
    ];
    if (includeIgnored) arguments_.push('--ignored=matching');
    const result = await this.#git(arguments_, { cwd });
    return parsePorcelainStatus(result.stdout);
  }

  async #collectConflicts(cwd) {
    const result = await this.#git(['ls-files', '-u', '-z'], { cwd });
    return parseUnmergedIndex(result.stdout);
  }

  async #writeTree(cwd) {
    const result = await this.#git(['write-tree'], { cwd });
    return requireObjectId(requireSingleLine(result.stdout, 'write-tree'), 'candidateTree');
  }

  async #parents(cwd, revision) {
    const result = await this.#git(
      ['rev-list', '--parents', '-n', '1', revision],
      { cwd }
    );
    const tokens = requireSingleLine(result.stdout, 'rev-list --parents').split(' ');
    if (tokens[0] !== revision || tokens.some((item) => !OBJECT_ID_PATTERN.test(item))) {
      throw new GitIntegrationWorkspaceError(
        'Git returned malformed commit parent data.',
        'invalid-git-output'
      );
    }
    return tokens.slice(1);
  }

  async #resolveTree(cwd, revision) {
    const result = await this.#git(
      ['rev-parse', '--verify', `${revision}^{tree}`],
      { cwd }
    );
    return requireObjectId(requireSingleLine(result.stdout, 'rev-parse tree'), 'tree');
  }

  async #resolvePseudoRef(cwd, ref, label) {
    const result = await this.#git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd });
    return requireObjectId(requireSingleLine(result.stdout, `rev-parse ${label}`), label);
  }

  async #resolveExactCommit(cwd, revision, label) {
    if (revision !== 'HEAD') requireObjectId(revision, label);
    let result;
    try {
      result = await this.#git(
        ['rev-parse', '--verify', `${revision}^{commit}`],
        { cwd }
      );
    } catch (error) {
      throw operationError(
        `${label} does not resolve to a commit.`,
        'revision-not-found',
        error,
        { revision }
      );
    }
    const resolved = requireObjectId(
      requireSingleLine(result.stdout, 'rev-parse commit'),
      label
    );
    if (revision !== 'HEAD' && resolved !== revision) {
      throw new GitIntegrationWorkspaceError(
        `${label} must be an exact commit object id.`,
        'object-id-mismatch',
        { details: { revision, resolved } }
      );
    }
    return resolved;
  }

  async #resolveTarget(projectRoot, targetRef) {
    const record = await this.#exactRefRecord(projectRoot, targetRef, {
      allowMissing: false,
      kind: 'target'
    });
    if (record.symbolicRef !== null) {
      throw new GitIntegrationWorkspaceError(
        'Symbolic target refs are not supported.',
        'symbolic-target-ref'
      );
    }
    return this.#resolveExactCommit(projectRoot, record.revision, 'target revision');
  }

  async #resolveCandidateRef(projectRoot, integrationId, { allowMissing = false } = {}) {
    const candidateRef = candidateRefFor(integrationId);
    const record = await this.#exactRefRecord(projectRoot, candidateRef, {
      allowMissing,
      kind: 'candidate'
    });
    if (record === null) return null;
    if (record.symbolicRef !== null) {
      throw new GitIntegrationWorkspaceError(
        'Symbolic candidate refs are not supported.',
        'symbolic-candidate-ref'
      );
    }
    return this.#resolveExactCommit(projectRoot, record.revision, 'candidate revision');
  }

  async #assertTargetRef(projectRoot, targetRef) {
    const checked = await this.#git(
      ['check-ref-format', targetRef],
      { cwd: projectRoot, allowedExitCodes: [0, 1] }
    );
    if (checked.status !== 0) {
      throw new GitIntegrationWorkspaceError(
        `targetRef is not a valid local branch ref: ${targetRef}`,
        'invalid-target-ref'
      );
    }
    await this.#exactRefRecord(projectRoot, targetRef, {
      allowMissing: false,
      kind: 'target'
    });
  }

  async #exactRefRecord(projectRoot, requestedRef, { allowMissing, kind }) {
    const result = await this.#git([
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(symref)'
    ], { cwd: projectRoot });
    const records = parseRefRecords(result.stdout);
    const folded = requestedRef.toLowerCase();
    const aliases = records.filter((record) => record.ref.toLowerCase() === folded);
    if (aliases.length > 1) {
      throw new GitIntegrationWorkspaceError(
        `Git contains case-conflicting refs for ${requestedRef}.`,
        `${kind}-ref-case-conflict`,
        { details: { requestedRef, refs: aliases.map((record) => record.ref) } }
      );
    }
    if (aliases.length === 1 && aliases[0].ref !== requestedRef) {
      throw new GitIntegrationWorkspaceError(
        `Ref spelling must exactly match ${aliases[0].ref}.`,
        `${kind}-ref-case-mismatch`,
        { details: { requestedRef, actualRef: aliases[0].ref } }
      );
    }
    const record = aliases[0] ?? null;
    if (record === null && !allowMissing) {
      throw new GitIntegrationWorkspaceError(
        `Ref does not exist: ${requestedRef}`,
        `${kind}-ref-not-found`
      );
    }
    return record;
  }

  async #isAncestor(cwd, ancestor, descendant) {
    const result = await this.#git(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      { cwd, allowedExitCodes: [0, 1] }
    );
    return result.status === 0;
  }

  async #hasMergeBase(cwd, left, right) {
    const result = await this.#git(
      ['merge-base', left, right],
      { cwd, allowedExitCodes: [0, 1] }
    );
    if (result.status === 1) return false;
    requireObjectId(requireSingleLine(result.stdout, 'merge-base'), 'mergeBase');
    return true;
  }

  async #commonGitDirectory(cwd) {
    const result = await this.#git(['rev-parse', '--git-common-dir'], { cwd });
    const output = requireSingleLine(result.stdout, 'Git common directory');
    return canonicalRealDirectory(path.resolve(cwd, output), {
      code: 'invalid-git-common-directory',
      label: 'Git common directory'
    });
  }

  async #isRegisteredWorktree(projectRoot, workspacePath) {
    return (await this.#registeredWorktreePaths(projectRoot))
      .some((candidate) => samePath(candidate, workspacePath));
  }

  async #registeredWorktreePaths(projectRoot) {
    const result = await this.#git(
      ['worktree', 'list', '--porcelain', '-z'],
      { cwd: projectRoot }
    );
    return parseWorktreePaths(result.stdout);
  }

  async #managedResidueEntry(projectRoot, registeredPath) {
    const managedRoot = path.join(projectRoot, '.fwa', 'integrations');
    const workspacePath = path.resolve(registeredPath);
    const relative = path.relative(managedRoot, workspacePath);
    const parts = relative.split(path.sep);
    if (path.isAbsolute(relative)
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)) {
      return null;
    }
    if (relative === ''
      || parts.length !== 2
      || parts[0] === ''
      || parts[1] !== 'worktree') {
      throw new GitIntegrationWorkspaceError(
        'A registered worktree under .fwa/integrations has an invalid managed path.',
        'invalid-integration-worktree-registration',
        { details: { registeredPath: workspacePath, relative } }
      );
    }
    let integrationId;
    try {
      integrationId = requirePortableId(parts[0], 'registered integrationId');
    } catch (error) {
      throw new GitIntegrationWorkspaceError(
        'A registered worktree under .fwa/integrations has an invalid integration id.',
        'invalid-integration-worktree-registration',
        { cause: error, details: { registeredPath: workspacePath, relative } }
      );
    }

    const exists = await pathExists(workspacePath);
    const stateDirectory = path.join(projectRoot, '.fwa');
    const operationDirectory = path.dirname(workspacePath);
    let canonicalParent = projectRoot;
    for (const [candidate, label] of [
      [stateDirectory, 'FWA state directory'],
      [managedRoot, 'FWA integrations directory'],
      [operationDirectory, 'FWA integration operation directory']
    ]) {
      if (!await pathExists(candidate)) break;
      const canonical = await canonicalRealDirectory(candidate, {
        code: 'invalid-integration-directory',
        label
      });
      if (!isDirectChild(canonicalParent, canonical)) {
        throw new GitIntegrationWorkspaceError(
          `${label} resolves outside the managed integration root.`,
          'invalid-integration-directory',
          { details: { registeredPath: workspacePath, candidate, canonical } }
        );
      }
      canonicalParent = canonical;
    }
    if (exists) {
      const canonicalWorkspace = await canonicalRealDirectory(workspacePath, {
        code: 'invalid-integration-workspace-path',
        label: 'integration worktree'
      });
      if (!isDirectChild(canonicalParent, canonicalWorkspace)) {
        throw new GitIntegrationWorkspaceError(
          'The registered integration worktree resolves outside its managed operation directory.',
          'integration-workspace-path-outside-owner',
          { details: { registeredPath: workspacePath, canonicalWorkspace } }
        );
      }
      return {
        integrationId,
        workspacePath: canonicalWorkspace,
        registered: true,
        exists: true
      };
    }
    return { integrationId, workspacePath, registered: true, exists: false };
  }

  inspectProcessFence() {
    return this.gitProcessGuard.inspect();
  }

  recoverProcessFence(options = {}) {
    return this.gitProcessGuard.recover(options);
  }

  #git(arguments_, options = {}) {
    const { env, ...processOptions } = options;
    return this.gitProcessGuard.run(this.gitRunner, this.gitPath, arguments_, {
      ...processOptions,
      timeoutMs: this.gitProcessOptions.gitTimeoutMs,
      terminationGraceMs: this.gitProcessOptions.gitTerminationGraceMs,
      env: createGitEnvironment(env)
    });
  }
}

function normalizeMergeRequest(value) {
  const request = normalizeCommonRequest(value);
  return {
    ...request,
    sourceRevision: requireObjectId(value.sourceRevision, 'sourceRevision')
  };
}

function normalizeRevertRequest(value) {
  const request = normalizeCommonRequest(value);
  return {
    ...request,
    revertedRevision: requireObjectId(value.revertedRevision, 'revertedRevision')
  };
}

function normalizeCommonRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitIntegrationWorkspaceError(
      'integration request must be an object.',
      'invalid-integration-request'
    );
  }
  return {
    integrationId: requirePortableId(value.integrationId, 'integrationId'),
    targetRef: requireTargetRef(value.targetRef),
    expectedTargetRevision: requireObjectId(
      value.expectedTargetRevision,
      'expectedTargetRevision'
    )
  };
}

function normalizeCleanupRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitIntegrationWorkspaceError(
      'cleanup request must be an object.',
      'invalid-cleanup-request'
    );
  }
  if (value.workspacePath !== undefined
    && (typeof value.workspacePath !== 'string'
      || value.workspacePath.trim() === ''
      || value.workspacePath.includes('\0'))) {
    throw new GitIntegrationWorkspaceError(
      'workspacePath must be a non-empty path string when supplied.',
      'invalid-workspace-path'
    );
  }
  if (value.force !== undefined && typeof value.force !== 'boolean') {
    throw new GitIntegrationWorkspaceError('force must be a boolean.', 'invalid-force');
  }
  return {
    integrationId: requirePortableId(value.integrationId, 'integrationId'),
    workspacePath: value.workspacePath,
    force: value.force ?? false
  };
}

function normalizeCandidateRefPruneRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitIntegrationWorkspaceError(
      'candidate ref prune request must be an object.',
      'invalid-candidate-ref-prune-request'
    );
  }
  return {
    integrationId: requirePortableId(value.integrationId, 'integrationId'),
    expectedRevision: requireObjectId(value.expectedRevision, 'expectedRevision')
  };
}

function requirePortableId(value, label) {
  if (typeof value !== 'string'
    || !PORTABLE_ID_PATTERN.test(value)
    || WINDOWS_DEVICE_NAME_PATTERN.test(value)) {
    throw new GitIntegrationWorkspaceError(
      `${label} must be a portable 1-128 character ASCII identifier.`,
      `invalid-${label.replace(/[A-Z]/gu, (match) => `-${match.toLowerCase()}`)}`
    );
  }
  return value;
}

function requireTargetRef(value) {
  if (typeof value !== 'string'
    || value !== value.trim()
    || !value.startsWith('refs/heads/')
    || value === 'refs/heads/'
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new GitIntegrationWorkspaceError(
      'targetRef must be a fully-qualified refs/heads/* ref.',
      'invalid-target-ref'
    );
  }
  return value;
}

function requireObjectId(value, label) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw new GitIntegrationWorkspaceError(
      `${label} must be a full lowercase Git object id.`,
      'invalid-object-id',
      { details: { label, value } }
    );
  }
  return value;
}

function candidateRefFor(integrationId) {
  return `${CANDIDATE_REF_ROOT}/${requirePortableId(integrationId, 'integrationId')}/candidate`;
}

function integrationIdFromCandidateRef(candidateRef) {
  const prefix = `${CANDIDATE_REF_ROOT}/`;
  if (!candidateRef.startsWith(prefix)) return null;
  const parts = candidateRef.slice(prefix.length).split('/');
  if (parts.length !== 2 || parts[1] !== 'candidate') return null;
  try {
    const integrationId = requirePortableId(parts[0], 'integrationId');
    return candidateRefFor(integrationId) === candidateRef ? integrationId : null;
  } catch {
    return null;
  }
}

function conflictResult(kind, context, request, conflicts) {
  return {
    disposition: 'conflicted',
    kind,
    integrationId: request.integrationId,
    targetRef: request.targetRef,
    expectedTargetRevision: request.expectedTargetRevision,
    ...(kind === 'merge'
      ? { sourceRevision: request.sourceRevision }
      : { revertedRevision: request.revertedRevision }),
    workspacePath: context.workspacePath,
    candidateRef: context.candidateRef,
    candidateRevision: null,
    candidateTree: null,
    parents: [],
    conflicts
  };
}

function publicContext(context, request) {
  return {
    ...commonPublicRequest(request),
    workspacePath: context.workspacePath,
    candidateRef: context.candidateRef
  };
}

function commonPublicRequest(request) {
  return {
    integrationId: request.integrationId,
    targetRef: request.targetRef,
    expectedTargetRevision: request.expectedTargetRevision,
    ...(request.sourceRevision === undefined
      ? { revertedRevision: request.revertedRevision }
      : { sourceRevision: request.sourceRevision })
  };
}

function parseUnmergedIndex(output) {
  const grouped = new Map();
  for (const record of splitNul(output)) {
    const tab = record.indexOf('\t');
    if (tab < 0) {
      throw new GitIntegrationWorkspaceError(
        'Git returned malformed unmerged index data.',
        'invalid-git-output'
      );
    }
    const metadata = record.slice(0, tab).split(' ');
    if (metadata.length !== 3
      || !/^[0-7]{6}$/u.test(metadata[0])
      || !OBJECT_ID_PATTERN.test(metadata[1])
      || !/^[123]$/u.test(metadata[2])) {
      throw new GitIntegrationWorkspaceError(
        'Git returned malformed unmerged index metadata.',
        'invalid-git-output',
        { details: { record } }
      );
    }
    const filePath = assertSafeGitPath(record.slice(tab + 1));
    const stage = Number(metadata[2]);
    const stages = grouped.get(filePath) ?? [];
    if (stages.some((item) => item.stage === stage)) {
      throw new GitIntegrationWorkspaceError(
        'Git returned a duplicate unmerged index stage.',
        'invalid-git-output',
        { details: { path: filePath, stage } }
      );
    }
    stages.push({
      stage,
      mode: metadata[0],
      blobOid: metadata[1]
    });
    grouped.set(filePath, stages);
  }
  return [...grouped]
    .map(([filePath, stages]) => ({
      path: filePath,
      stages: stages.sort((left, right) => left.stage - right.stage)
    }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function parsePorcelainStatus(output) {
  const tokens = splitNul(output);
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    const record = tokens[index];
    index += 1;
    if (record.length < 4 || record[2] !== ' ') {
      throw new GitIntegrationWorkspaceError(
        `Git returned malformed status record ${JSON.stringify(record)}.`,
        'invalid-git-output'
      );
    }
    const entry = {
      code: record.slice(0, 2),
      path: assertSafeGitPath(record.slice(3))
    };
    if (entry.code.includes('R') || entry.code.includes('C')) {
      if (index >= tokens.length) {
        throw new GitIntegrationWorkspaceError(
          'Git status omitted the source path for a rename or copy.',
          'invalid-git-output'
        );
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
        throw new GitIntegrationWorkspaceError(
          'Git name-status data is missing its path.',
          'invalid-git-output'
        );
      }
      firstPath = tokens[index];
      index += 1;
    }
    if (!/^[A-Z][0-9]*$/u.test(code)) {
      throw new GitIntegrationWorkspaceError(
        `Git returned malformed name-status code ${JSON.stringify(code)}.`,
        'invalid-git-output'
      );
    }

    if (code.startsWith('R') || code.startsWith('C')) {
      if (index >= tokens.length) {
        throw new GitIntegrationWorkspaceError(
          'Git name-status data is missing a rename/copy destination.',
          'invalid-git-output'
        );
      }
      const previousPath = assertSafeGitPath(firstPath);
      const destinationPath = assertSafeGitPath(tokens[index]);
      index += 1;
      if (code.startsWith('R')) {
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

function parseRefRecords(output) {
  if (output === '') return [];
  const lines = output.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => {
    const fields = line.split('\t');
    if (fields.length !== 3 || fields[0] === '') {
      throw new GitIntegrationWorkspaceError(
        'Git returned malformed ref data.',
        'invalid-git-output'
      );
    }
    return {
      ref: fields[0],
      revision: requireObjectId(fields[1], 'ref revision'),
      symbolicRef: fields[2] === '' ? null : fields[2]
    };
  });
}

function assertSafeGitPath(value) {
  if (typeof value !== 'string'
    || value === ''
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.split('/').includes('..')) {
    throw new GitIntegrationWorkspaceError(
      `Git returned an unsafe repository-relative path ${JSON.stringify(value)}.`,
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

function parseWorktreePaths(value) {
  const paths = [];
  for (const token of splitNul(value)) {
    if (!token.startsWith('worktree ')) continue;
    const workspacePath = token.slice('worktree '.length);
    if (workspacePath === '' || workspacePath.includes('\0')) {
      throw new GitIntegrationWorkspaceError(
        'Git returned a malformed worktree path.',
        'invalid-git-output'
      );
    }
    const resolved = path.resolve(workspacePath);
    if (paths.some((candidate) => samePath(candidate, resolved))) {
      throw new GitIntegrationWorkspaceError(
        'Git returned a duplicate worktree registration.',
        'invalid-git-output',
        { details: { workspacePath: resolved } }
      );
    }
    paths.push(resolved);
  }
  return paths;
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new GitIntegrationWorkspaceError(
      'clock must return a valid date.',
      'invalid-clock-value'
    );
  }
  return date.toISOString();
}

async function canonicalRealDirectory(candidate, { code, label }) {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    throw new GitIntegrationWorkspaceError(
      `${label} does not exist: ${candidate}`,
      code,
      { cause: error }
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new GitIntegrationWorkspaceError(`${label} must be a real directory: ${candidate}`, code);
  }
  try {
    return path.resolve(await realpath(candidate));
  } catch (error) {
    throw new GitIntegrationWorkspaceError(
      `Cannot resolve ${label}: ${candidate}`,
      code,
      { cause: error }
    );
  }
}

async function ensureRealDirectory(candidate, parent, label) {
  const canonicalParent = await canonicalRealDirectory(parent, {
    code: 'invalid-integration-directory',
    label: `${label} parent`
  });
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw new GitIntegrationWorkspaceError(
        `Cannot create ${label}: ${candidate}`,
        'integration-workspace-state-create-failed',
        { cause: error }
      );
    }
  }
  const canonicalCandidate = await canonicalRealDirectory(candidate, {
    code: 'invalid-integration-directory',
    label
  });
  if (!isDirectChild(canonicalParent, canonicalCandidate)) {
    throw new GitIntegrationWorkspaceError(
      `${label} must resolve directly below its expected parent.`,
      'invalid-integration-directory'
    );
  }
  return canonicalCandidate;
}

async function assertPathDoesNotExist(candidate, code) {
  try {
    await lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new GitIntegrationWorkspaceError(
      `Cannot inspect integration path ${candidate}.`,
      code,
      { cause: error }
    );
  }
  throw new GitIntegrationWorkspaceError(`Integration path already exists: ${candidate}`, code);
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
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDirectChild(parent, candidate) {
  return samePath(path.dirname(candidate), parent);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameChanges(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareChanges(left, right) {
  const byPath = left.path.localeCompare(right.path, 'en');
  if (byPath !== 0) return byPath;
  return (left.previousPath ?? '').localeCompare(right.previousPath ?? '', 'en');
}

function requireSingleLine(output, label) {
  const normalized = output.replace(/\r?\n$/u, '');
  if (normalized === '' || normalized.includes('\r') || normalized.includes('\n')) {
    throw new GitIntegrationWorkspaceError(
      `${label} returned malformed output.`,
      'invalid-git-output'
    );
  }
  return normalized;
}

function operationError(message, code, cause, details) {
  if (cause instanceof GitIntegrationWorkspaceError
    && cause.code !== 'git-command-failed') return cause;
  return new GitIntegrationWorkspaceError(message, code, { cause, details });
}

function runProcess(executable, arguments_, options = {}) {
  return runGitProcess(executable, arguments_, { ...options, ErrorType: GitIntegrationWorkspaceError });
}
