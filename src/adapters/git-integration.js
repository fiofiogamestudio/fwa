import { createHash } from 'node:crypto';
import {
  lstat,
  realpath
} from 'node:fs/promises';
import path from 'node:path';

import { createGitEnvironment } from './git-environment.js';
import {
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_GIT_TERMINATION_GRACE_MS,
  GitProcessGuard,
  runGitProcess,
  validateGitProcessOptions
} from './git-process.js';
import { GitWorktreeAdapter } from './git-worktree.js';
import { stableStringify } from '../core/events.js';

const CANDIDATE_REF_ROOT = 'refs/fwa/integrations';
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export class GitIntegrationError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'GitIntegrationError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * Git adapter for the deliberately narrow C2a integration strategy.
 *
 * The adapter never rebases, resets, force-updates, or performs a three-way
 * merge. It creates one explicit candidate commit whose sole parent is the
 * expected target commit and whose tree is the accepted ChangeSet head tree.
 * Promotion is either a checked-out-root fast-forward or a compare-and-swap
 * update of an otherwise un-checked-out local branch ref.
 */
export class GitIntegrationAdapter {
  constructor(projectRoot, {
    gitPath = 'git',
    clock = () => new Date(),
    gitRunner = runProcess,
    gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    gitTerminationGraceMs = DEFAULT_GIT_TERMINATION_GRACE_MS
  } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new GitIntegrationError(
        'projectRoot must be a non-empty string.',
        'invalid-project-root'
      );
    }
    if (typeof gitPath !== 'string' || gitPath.trim() === '' || gitPath.includes('\0')) {
      throw new GitIntegrationError('gitPath must be a non-empty executable path.', 'invalid-git-path');
    }
    if (typeof clock !== 'function') {
      throw new GitIntegrationError('clock must be a function.', 'invalid-clock');
    }
    if (typeof gitRunner !== 'function') {
      throw new GitIntegrationError('gitRunner must be a function.', 'invalid-git-runner');
    }

    this.projectRoot = path.resolve(projectRoot);
    this.gitPath = gitPath;
    this.clock = clock;
    this.gitRunner = gitRunner;
    this.gitProcessOptions = validateGitProcessOptions({
      gitTimeoutMs, gitTerminationGraceMs
    }, GitIntegrationError);
    this.gitProcessGuard = new GitProcessGuard(this.projectRoot, GitIntegrationError);
    this.changeSetVerifier = new GitWorktreeAdapter(projectRoot, {
      gitPath, clock, gitTimeoutMs, gitTerminationGraceMs
    });
  }

  async verifyChangeSet(changeSet) {
    await this.gitProcessGuard.assertAvailable();
    return this.changeSetVerifier.verifyChangeSet(changeSet);
  }

  async prepare(input = {}) {
    const request = normalizeRequest(input, { requireCandidate: false });
    const projectRoot = await this.#assertProjectRoot();
    await this.#assertTargetRef(projectRoot, request.targetRef);

    const rootBefore = await this.#snapshotRoot(projectRoot);
    const targetRevision = await this.#resolveTarget(projectRoot, request.targetRef);
    if (targetRevision !== request.expectedTargetRevision) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} is not at the recorded integration base.`,
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
    const checkouts = await this.#targetCheckouts(projectRoot, request.targetRef);
    const foreignCheckouts = checkouts.filter((item) => !samePath(item.path, projectRoot));
    if (foreignCheckouts.length > 0 || checkouts.length > 1) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} is checked out outside the project root.`,
        'target-checked-out-elsewhere',
        {
          details: {
            targetRef: request.targetRef,
            worktrees: foreignCheckouts.map((item) => item.path)
          }
        }
      );
    }
    if (checkouts.length === 1
      && (rootBefore.headRef !== request.targetRef
        || rootBefore.headRevision !== request.expectedTargetRevision
        || rootBefore.status !== '')) {
      throw new GitIntegrationError(
        'The checked-out target must be the clean project root at the exact base.',
        rootBefore.status === '' ? 'root-target-mismatch' : 'dirty-target-worktree',
        {
          details: {
            targetRef: request.targetRef,
            expectedTargetRevision: request.expectedTargetRevision,
            headRef: rootBefore.headRef,
            headRevision: rootBefore.headRevision,
            clean: rootBefore.status === ''
          }
        }
      );
    }

    await Promise.all([
      this.#resolveExactCommit(projectRoot, request.expectedTargetRevision, 'expectedTargetRevision'),
      this.#resolveExactCommit(projectRoot, request.changeSetHeadRevision, 'changeSetHeadRevision')
    ]);
    if (!await this.#isAncestor(
      projectRoot,
      request.expectedTargetRevision,
      request.changeSetHeadRevision
    )) {
      throw new GitIntegrationError(
        'The ChangeSet head is not descended from the exact target base.',
        'changeset-base-mismatch',
        { details: request }
      );
    }

    const [baseTree, headTree] = await Promise.all([
      this.#resolveTree(projectRoot, request.expectedTargetRevision),
      this.#resolveTree(projectRoot, request.changeSetHeadRevision)
    ]);
    if (baseTree === headTree) {
      throw new GitIntegrationError(
        'The ChangeSet has the same tree as the exact target base.',
        'empty-integration-tree',
        {
          details: {
            expectedTargetRevision: request.expectedTargetRevision,
            changeSetHeadRevision: request.changeSetHeadRevision,
            tree: headTree
          }
        }
      );
    }

    const message = candidateMessage(request);
    const timestamp = normalizeTimestamp(this.clock());
    let candidateRevision;
    try {
      const result = await this.#git([
        'commit-tree',
        headTree,
        '-p',
        request.expectedTargetRevision,
        '-m',
        message
      ], {
        cwd: projectRoot,
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
        `Failed to create the candidate commit for integration ${request.integrationId}.`,
        'candidate-create-failed',
        error,
        request
      );
    }

    const candidateRef = candidateRefFor(request.integrationId);
    try {
      await this.#git([
        'update-ref',
        '-m',
        `fwa prepare ${request.integrationId}`,
        candidateRef,
        candidateRevision,
        ''
      ], { cwd: projectRoot });
    } catch (error) {
      const published = await this.#resolveCandidateRef(
        projectRoot,
        request.integrationId,
        { allowMissing: true }
      );
      if (published === null) {
        throw operationError(
          `Failed to publish the candidate ref for integration ${request.integrationId}.`,
          'candidate-ref-publish-failed',
          error,
          { integrationId: request.integrationId, candidateRef, candidateRevision }
        );
      }
      candidateRevision = published;
    }

    const prepared = {
      ...request,
      candidateRevision,
      candidateTree: headTree
    };
    await this.#assertCandidateContract(projectRoot, prepared);

    const targetAfter = await this.#resolveTarget(projectRoot, request.targetRef);
    if (targetAfter !== request.expectedTargetRevision) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} changed while its candidate was being prepared.`,
        'target-ref-race',
        {
          details: {
            targetRef: request.targetRef,
            expectedTargetRevision: request.expectedTargetRevision,
            targetRevision: targetAfter,
            candidateRevision
          }
        }
      );
    }
    await this.#assertRootSnapshot(projectRoot, rootBefore, 'prepare');

    return prepared;
  }

  async promote(input = {}) {
    const request = normalizeRequest(input, { requireCandidate: true });
    const projectRoot = await this.#assertProjectRoot();
    await this.#assertTargetRef(projectRoot, request.targetRef);
    await this.#assertCandidateContract(projectRoot, request);

    const observed = await this.#resolveTarget(projectRoot, request.targetRef);
    if (observed !== request.expectedTargetRevision) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} changed before candidate promotion.`,
        'target-revision-mismatch',
        {
          details: {
            targetRef: request.targetRef,
            expectedTargetRevision: request.expectedTargetRevision,
            targetRevision: observed,
            candidateRevision: request.candidateRevision
          }
        }
      );
    }

    const checkouts = await this.#targetCheckouts(projectRoot, request.targetRef);
    const foreignCheckouts = checkouts.filter((item) => !samePath(item.path, projectRoot));
    if (foreignCheckouts.length > 0) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} is checked out outside the project root.`,
        'target-checked-out-elsewhere',
        {
          details: {
            targetRef: request.targetRef,
            worktrees: foreignCheckouts.map((item) => item.path)
          }
        }
      );
    }

    if (checkouts.length === 1) {
      return this.#promoteCheckedOutRoot(projectRoot, request);
    }
    if (checkouts.length !== 0) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} has an ambiguous worktree checkout.`,
        'target-checkout-inconsistent',
        { details: { targetRef: request.targetRef, checkouts } }
      );
    }
    return this.#promoteUncontainedRef(projectRoot, request);
  }

  /** Promote a merge/revert candidate prepared by GitIntegrationWorkspaceAdapter. */
  async promotePrepared(input = {}) {
    const request = normalizePreparedRequest(input);
    const projectRoot = await this.#assertProjectRoot();
    await this.#assertTargetRef(projectRoot, request.targetRef);
    await this.#assertPreparedCandidateContract(projectRoot, request);
    const candidateEffects = await this.#capturePreparedEffects(
      projectRoot,
      request.expectedTargetRevision,
      request.candidateRevision
    );
    assertPreparedEffects(request, candidateEffects);

    const observed = await this.#resolveTarget(projectRoot, request.targetRef);
    if (observed !== request.expectedTargetRevision) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} changed before candidate promotion.`,
        'target-revision-mismatch',
        { details: { ...request, targetRevision: observed } }
      );
    }
    const checkouts = await this.#targetCheckouts(projectRoot, request.targetRef);
    const foreignCheckouts = checkouts.filter((item) => !samePath(item.path, projectRoot));
    if (foreignCheckouts.length > 0) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} is checked out outside the project root.`,
        'target-checked-out-elsewhere',
        { details: { targetRef: request.targetRef, worktrees: foreignCheckouts } }
      );
    }
    if (checkouts.length === 1) return this.#promoteCheckedOutRoot(projectRoot, request);
    if (checkouts.length !== 0) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} has an ambiguous worktree checkout.`,
        'target-checkout-inconsistent',
        { details: { targetRef: request.targetRef, checkouts } }
      );
    }
    return this.#promoteUncontainedRef(projectRoot, request);
  }

  async inspectPrepared(input = {}) {
    const request = normalizePreparedRequest(input);
    const projectRoot = await this.#assertProjectRoot();
    await this.#assertTargetRef(projectRoot, request.targetRef);
    await this.#assertPreparedCandidateContract(projectRoot, request);
    const candidateEffects = await this.#capturePreparedEffects(
      projectRoot,
      request.expectedTargetRevision,
      request.candidateRevision
    );
    assertPreparedEffects(request, candidateEffects);
    const targetRevision = await this.#resolveTarget(
      projectRoot,
      request.targetRef,
      { allowMissing: true }
    );
    const checkouts = await this.#targetCheckouts(projectRoot, request.targetRef);
    const rootCheckoutOnly = checkouts.length === 1
      && samePath(checkouts[0].path, projectRoot);
    let checkoutConsistent = checkouts.length === 0;
    let root = null;
    if (rootCheckoutOnly) {
      root = await this.#snapshotRoot(projectRoot);
      checkoutConsistent = root.headRef === request.targetRef
        && root.headRevision === targetRevision
        && root.status === '';
    }
    let disposition;
    if (targetRevision === null || !checkoutConsistent) disposition = 'inconsistent';
    else if (targetRevision === request.expectedTargetRevision) disposition = 'not-applied';
    else if (targetRevision === request.candidateRevision) disposition = 'applied';
    else if (await this.#isAncestor(projectRoot, request.candidateRevision, targetRevision)) {
      disposition = 'advanced';
    } else if (await this.#isAncestor(
      projectRoot,
      request.expectedTargetRevision,
      targetRevision
    )) disposition = 'diverged';
    else disposition = 'inconsistent';
    return {
      ...request,
      disposition,
      targetRevision,
      observedTargetRevision: targetRevision,
      checkouts,
      checkoutConsistent,
      root: root === null ? null : {
        headRef: root.headRef,
        headRevision: root.headRevision,
        clean: root.status === ''
      },
      containsCandidate: disposition === 'applied' || disposition === 'advanced',
      ...candidateEffects
    };
  }

  async inspect(input = {}) {
    const request = normalizeRequest(input, { requireCandidate: true });
    const projectRoot = await this.#assertProjectRoot();
    await this.#assertTargetRef(projectRoot, request.targetRef);
    await this.#assertCandidateContract(projectRoot, request);

    const targetRevision = await this.#resolveTarget(
      projectRoot,
      request.targetRef,
      { allowMissing: true }
    );
    const checkouts = await this.#targetCheckouts(projectRoot, request.targetRef);
    const rootCheckoutOnly = checkouts.length === 1
      && samePath(checkouts[0].path, projectRoot);
    let checkoutConsistent = checkouts.length === 0;
    let root = null;
    if (rootCheckoutOnly) {
      root = await this.#snapshotRoot(projectRoot);
      checkoutConsistent = root.headRef === request.targetRef
        && root.headRevision === targetRevision
        && root.status === '';
    }

    let disposition;
    if (targetRevision === null || !checkoutConsistent) {
      disposition = 'inconsistent';
    } else if (targetRevision === request.expectedTargetRevision) {
      disposition = 'not-applied';
    } else if (targetRevision === request.candidateRevision) {
      disposition = 'applied';
    } else if (await this.#isAncestor(projectRoot, request.candidateRevision, targetRevision)) {
      disposition = 'advanced';
    } else if (await this.#isAncestor(
      projectRoot,
      request.expectedTargetRevision,
      targetRevision
    )) {
      disposition = 'diverged';
    } else {
      disposition = 'inconsistent';
    }

    return {
      disposition,
      targetRevision,
      observedTargetRevision: targetRevision,
      targetRef: request.targetRef,
      expectedTargetRevision: request.expectedTargetRevision,
      changeSetHeadRevision: request.changeSetHeadRevision,
      candidateRevision: request.candidateRevision,
      candidateTree: request.candidateTree,
      checkouts,
      checkoutConsistent,
      root: root === null ? null : {
        headRef: root.headRef,
        headRevision: root.headRevision,
        clean: root.status === ''
      },
      containsCandidate: disposition === 'applied' || disposition === 'advanced'
    };
  }

  async verify(integration) {
    if (integration === null || typeof integration !== 'object' || Array.isArray(integration)) {
      throw new GitIntegrationError('integration must be an object.', 'invalid-integration');
    }
    const request = normalizeRequest({
      integrationId: integration.integrationId ?? integration.id,
      changeSetId: integration.changeSetId,
      targetRef: integration.targetRef,
      expectedTargetRevision: integration.expectedTargetRevision,
      changeSetHeadRevision: integration.changeSetHeadRevision ?? integration.headRevision,
      candidateRevision: integration.candidateRevision,
      candidateTree: integration.candidateTree
    }, { requireCandidate: true });
    if (integration.integratedRevision !== undefined
      && integration.integratedRevision !== null
      && integration.integratedRevision !== request.candidateRevision) {
      throw new GitIntegrationError(
        'The recorded integrated revision differs from its candidate.',
        'integration-contract-mismatch'
      );
    }
    if (integration.previousRevision !== undefined
      && integration.previousRevision !== null
      && integration.previousRevision !== request.expectedTargetRevision) {
      throw new GitIntegrationError(
        'The recorded previous revision differs from the expected target revision.',
        'integration-contract-mismatch'
      );
    }

    const projectRoot = await this.#assertProjectRoot();
    await this.#assertTargetRef(projectRoot, request.targetRef);
    await this.#assertCandidateContract(projectRoot, request);
    const targetRevision = await this.#resolveTarget(
      projectRoot,
      request.targetRef,
      { allowMissing: true }
    );
    const containsCandidate = targetRevision !== null
      && await this.#isAncestor(projectRoot, request.candidateRevision, targetRevision);
    if (!containsCandidate) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} does not contain candidate ${request.candidateRevision}.`,
        'integration-not-contained',
        {
          details: {
            targetRef: request.targetRef,
            targetRevision,
            expectedTargetRevision: request.expectedTargetRevision,
            candidateRevision: request.candidateRevision
          }
        }
      );
    }
    return {
      ok: true,
      disposition: targetRevision === request.candidateRevision ? 'applied' : 'advanced',
      targetRevision,
      observedTargetRevision: targetRevision,
      targetRef: request.targetRef,
      expectedTargetRevision: request.expectedTargetRevision,
      changeSetHeadRevision: request.changeSetHeadRevision,
      candidateRevision: request.candidateRevision,
      candidateTree: request.candidateTree,
      containsCandidate: true
    };
  }

  async #promoteCheckedOutRoot(projectRoot, request) {
    const before = await this.#snapshotRoot(projectRoot);
    if (before.headRef !== request.targetRef
      || before.headRevision !== request.expectedTargetRevision) {
      throw new GitIntegrationError(
        'The project root no longer has the exact target base checked out.',
        'root-target-mismatch',
        {
          details: {
            targetRef: request.targetRef,
            expectedTargetRevision: request.expectedTargetRevision,
            headRef: before.headRef,
            headRevision: before.headRevision
          }
        }
      );
    }
    if (before.status !== '') {
      throw new GitIntegrationError(
        'The checked-out target worktree must be clean before fast-forward promotion.',
        'dirty-target-worktree'
      );
    }

    const observed = await this.#resolveTarget(projectRoot, request.targetRef);
    if (observed !== request.expectedTargetRevision) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} changed before its checked-out fast-forward.`,
        'target-ref-race',
        { details: { expectedTargetRevision: request.expectedTargetRevision, targetRevision: observed } }
      );
    }
    try {
      await this.#git(
        ['merge', '--ff-only', request.candidateRevision],
        { cwd: projectRoot }
      );
    } catch (error) {
      const targetRevision = await this.#resolveTarget(
        projectRoot,
        request.targetRef,
        { allowMissing: true }
      );
      throw operationError(
        `Failed to fast-forward checked-out target ${request.targetRef}.`,
        targetRevision === request.expectedTargetRevision
          ? 'root-fast-forward-failed'
          : 'target-ref-race',
        error,
        {
          expectedTargetRevision: request.expectedTargetRevision,
          targetRevision,
          candidateRevision: request.candidateRevision
        }
      );
    }

    const [after, targetRevision] = await Promise.all([
      this.#snapshotRoot(projectRoot),
      this.#resolveTarget(projectRoot, request.targetRef, { allowMissing: true })
    ]);
    if (targetRevision !== request.candidateRevision
      || after.headRef !== request.targetRef
      || after.headRevision !== request.candidateRevision
      || after.status !== '') {
      throw new GitIntegrationError(
        'Checked-out target promotion could not be proven complete and clean.',
        'promotion-unconfirmed',
        {
          details: {
            targetRef: request.targetRef,
            targetRevision,
            headRef: after.headRef,
            headRevision: after.headRevision,
            clean: after.status === ''
          }
        }
      );
    }
    return {
      promoted: true,
      mode: 'root-fast-forward',
      targetRef: request.targetRef,
      previousRevision: request.expectedTargetRevision,
      targetRevision: request.candidateRevision,
      candidateRevision: request.candidateRevision
    };
  }

  async #promoteUncontainedRef(projectRoot, request) {
    const rootBefore = await this.#snapshotRoot(projectRoot);
    const observed = await this.#resolveTarget(projectRoot, request.targetRef);
    if (observed !== request.expectedTargetRevision) {
      throw new GitIntegrationError(
        `Target ${request.targetRef} changed before its atomic ref update.`,
        'target-ref-race',
        { details: { expectedTargetRevision: request.expectedTargetRevision, targetRevision: observed } }
      );
    }

    try {
      await this.#git([
        'update-ref',
        '-m',
        `fwa integrate ${request.integrationId}`,
        request.targetRef,
        request.candidateRevision,
        request.expectedTargetRevision
      ], { cwd: projectRoot });
    } catch (error) {
      const targetRevision = await this.#resolveTarget(
        projectRoot,
        request.targetRef,
        { allowMissing: true }
      );
      throw operationError(
        `Failed to atomically update target ${request.targetRef}.`,
        targetRevision === request.expectedTargetRevision
          ? 'target-ref-update-failed'
          : 'target-ref-race',
        error,
        {
          expectedTargetRevision: request.expectedTargetRevision,
          targetRevision,
          candidateRevision: request.candidateRevision
        }
      );
    }

    const targetRevision = await this.#resolveTarget(
      projectRoot,
      request.targetRef,
      { allowMissing: true }
    );
    if (targetRevision !== request.candidateRevision) {
      throw new GitIntegrationError(
        'Atomic ref promotion returned without the candidate at the target.',
        'promotion-unconfirmed',
        { details: { targetRevision, candidateRevision: request.candidateRevision } }
      );
    }
    await this.#assertRootSnapshot(projectRoot, rootBefore, 'ref-promotion');
    const newCheckouts = await this.#targetCheckouts(projectRoot, request.targetRef);
    if (newCheckouts.length > 0) {
      throw new GitIntegrationError(
        'The target became checked out concurrently with its ref promotion.',
        'promotion-unconfirmed',
        { details: { targetRef: request.targetRef, checkouts: newCheckouts } }
      );
    }
    return {
      promoted: true,
      mode: 'ref-cas',
      targetRef: request.targetRef,
      previousRevision: request.expectedTargetRevision,
      targetRevision: request.candidateRevision,
      candidateRevision: request.candidateRevision
    };
  }

  async #assertCandidateContract(projectRoot, request) {
    const pinnedCandidate = await this.#resolveCandidateRef(
      projectRoot,
      request.integrationId,
      { allowMissing: true }
    );
    if (pinnedCandidate !== request.candidateRevision) {
      throw new GitIntegrationError(
        'The durable candidate ref does not match the recorded candidate revision.',
        'candidate-ref-mismatch',
        {
          details: {
            integrationId: request.integrationId,
            candidateRef: candidateRefFor(request.integrationId),
            expectedCandidateRevision: request.candidateRevision,
            candidateRevision: pinnedCandidate
          }
        }
      );
    }
    await Promise.all([
      this.#resolveExactCommit(projectRoot, request.expectedTargetRevision, 'expectedTargetRevision'),
      this.#resolveExactCommit(projectRoot, request.changeSetHeadRevision, 'changeSetHeadRevision'),
      this.#resolveExactCommit(projectRoot, request.candidateRevision, 'candidateRevision')
    ]);
    if (request.candidateRevision === request.expectedTargetRevision
      || request.candidateRevision === request.changeSetHeadRevision) {
      throw new GitIntegrationError(
        'Integration must use a distinct explicit candidate commit.',
        'candidate-contract-mismatch'
      );
    }
    if (!await this.#isAncestor(
      projectRoot,
      request.expectedTargetRevision,
      request.changeSetHeadRevision
    )) {
      throw new GitIntegrationError(
        'The ChangeSet head is not descended from the exact target base.',
        'changeset-base-mismatch'
      );
    }

    const [baseTree, headTree, candidateTree, parents, subject] = await Promise.all([
      this.#resolveTree(projectRoot, request.expectedTargetRevision),
      this.#resolveTree(projectRoot, request.changeSetHeadRevision),
      this.#resolveTree(projectRoot, request.candidateRevision),
      this.#parents(projectRoot, request.candidateRevision),
      this.#subject(projectRoot, request.candidateRevision)
    ]);
    if (baseTree === headTree
      || request.candidateTree !== headTree
      || candidateTree !== request.candidateTree
      || parents.length !== 1
      || parents[0] !== request.expectedTargetRevision
      || subject !== candidateMessage(request)) {
      throw new GitIntegrationError(
        'The candidate commit does not match its exact-base single-commit contract.',
        'candidate-contract-mismatch',
        {
          details: {
            baseTree,
            headTree,
            recordedCandidateTree: request.candidateTree,
            candidateTree,
            expectedParents: [request.expectedTargetRevision],
            parents,
            expectedSubject: candidateMessage(request),
            subject
          }
        }
      );
    }
    return { baseTree, headTree, candidateTree, parents };
  }

  async #assertPreparedCandidateContract(projectRoot, request) {
    const pinnedCandidate = await this.#resolveCandidateRef(
      projectRoot,
      request.integrationId,
      { allowMissing: true }
    );
    if (pinnedCandidate !== request.candidateRevision) {
      throw new GitIntegrationError(
        'The durable candidate ref does not match the recorded candidate revision.',
        'candidate-ref-mismatch',
        { details: { ...request, candidateRevision: pinnedCandidate } }
      );
    }
    await Promise.all([
      this.#resolveExactCommit(projectRoot, request.expectedTargetRevision, 'expectedTargetRevision'),
      this.#resolveExactCommit(projectRoot, request.candidateRevision, 'candidateRevision'),
      ...request.parents.map((parent, index) => this.#resolveExactCommit(
        projectRoot,
        parent,
        `parents[${index}]`
      ))
    ]);
    const [candidateTree, parents] = await Promise.all([
      this.#resolveTree(projectRoot, request.candidateRevision),
      this.#parents(projectRoot, request.candidateRevision)
    ]);
    if (request.candidateRevision === request.expectedTargetRevision
      || request.parents.length === 0
      || request.parents[0] !== request.expectedTargetRevision
      || candidateTree !== request.candidateTree
      || parents.length !== request.parents.length
      || parents.some((parent, index) => parent !== request.parents[index])) {
      throw new GitIntegrationError(
        'The candidate commit does not match its prepared parent/tree contract.',
        'candidate-contract-mismatch',
        { details: { ...request, candidateTree, parents } }
      );
    }
    return { candidateTree, parents };
  }

  async #parents(projectRoot, revision) {
    const result = await this.#git(
      ['rev-list', '--parents', '-n', '1', revision],
      { cwd: projectRoot }
    );
    const tokens = requireSingleLine(result.stdout, 'rev-list --parents').split(' ');
    if (tokens[0] !== revision || tokens.some((item) => !OBJECT_ID_PATTERN.test(item))) {
      throw new GitIntegrationError(
        'Git returned malformed candidate parent data.',
        'invalid-git-output'
      );
    }
    return tokens.slice(1);
  }

  async #subject(projectRoot, revision) {
    const result = await this.#git(
      ['show', '--no-patch', '--format=%s', revision],
      { cwd: projectRoot }
    );
    return requireSingleLine(result.stdout, 'git show subject');
  }

  async #snapshotRoot(projectRoot) {
    const [headResult, headRevision, status] = await Promise.all([
      this.#git(
        ['symbolic-ref', '--quiet', 'HEAD'],
        { cwd: projectRoot, allowedExitCodes: [0, 1] }
      ),
      this.#resolveExactCommit(projectRoot, 'HEAD', 'HEAD'),
      this.#git([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none'
      ], { cwd: projectRoot })
    ]);
    return {
      headRef: headResult.status === 0
        ? requireSingleLine(headResult.stdout, 'symbolic-ref HEAD')
        : null,
      headRevision,
      status: status.stdout
    };
  }

  async #assertRootSnapshot(projectRoot, expected, phase) {
    const actual = await this.#snapshotRoot(projectRoot);
    if (actual.headRef !== expected.headRef
      || actual.headRevision !== expected.headRevision
      || actual.status !== expected.status) {
      throw new GitIntegrationError(
        `The project root changed during integration ${phase}.`,
        'root-state-changed',
        { details: { phase, expected, actual } }
      );
    }
  }

  async #targetCheckouts(projectRoot, targetRef) {
    const result = await this.#git(
      ['worktree', 'list', '--porcelain', '-z'],
      { cwd: projectRoot }
    );
    return parseWorktreeList(result.stdout)
      .filter((item) => item.branch === targetRef)
      .map((item) => ({ ...item, path: path.resolve(item.path) }));
  }

  async #assertTargetRef(projectRoot, targetRef) {
    const checked = await this.#git(
      ['check-ref-format', targetRef],
      { cwd: projectRoot, allowedExitCodes: [0, 1] }
    );
    if (checked.status !== 0) {
      throw new GitIntegrationError(
        `targetRef is not a valid local branch ref: ${targetRef}`,
        'invalid-target-ref'
      );
    }
    const record = await this.#exactRefRecord(projectRoot, targetRef, {
      allowMissing: true,
      kind: 'target'
    });
    if (record?.symbolicRef) {
      throw new GitIntegrationError(
        'Symbolic target branch refs are not supported.',
        'symbolic-target-ref'
      );
    }
  }

  async #resolveTarget(projectRoot, targetRef, { allowMissing = false } = {}) {
    const record = await this.#exactRefRecord(projectRoot, targetRef, {
      allowMissing: true,
      kind: 'target'
    });
    if (record === null) {
      if (allowMissing) return null;
      throw new GitIntegrationError(
        `Target branch does not exist: ${targetRef}`,
        'target-ref-not-found'
      );
    }
    if (record.symbolicRef) {
      throw new GitIntegrationError(
        'Symbolic target branch refs are not supported.',
        'symbolic-target-ref'
      );
    }
    return this.#resolveExactCommit(projectRoot, record.revision, 'target revision');
  }

  async #resolveCandidateRef(projectRoot, integrationId, { allowMissing = false } = {}) {
    const candidateRef = candidateRefFor(integrationId);
    const record = await this.#exactRefRecord(projectRoot, candidateRef, {
      allowMissing: true,
      kind: 'candidate'
    });
    if (record === null) {
      if (allowMissing) return null;
      throw new GitIntegrationError(
        `Candidate ref does not exist: ${candidateRef}`,
        'candidate-ref-not-found'
      );
    }
    if (record.symbolicRef) {
      throw new GitIntegrationError(
        'Symbolic candidate refs are not supported.',
        'candidate-ref-mismatch',
        { details: { integrationId, candidateRef, symbolicRef: record.symbolicRef } }
      );
    }
    requireObjectId(record.revision, 'candidate ref revision');
    return record.revision;
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
      throw new GitIntegrationError(
        `Git contains case-conflicting refs for ${requestedRef}.`,
        `${kind}-ref-case-conflict`,
        { details: { requestedRef, refs: aliases.map((record) => record.ref) } }
      );
    }
    if (aliases.length === 1 && aliases[0].ref !== requestedRef) {
      throw new GitIntegrationError(
        `Ref spelling must exactly match ${aliases[0].ref}.`,
        `${kind}-ref-case-mismatch`,
        { details: { requestedRef, actualRef: aliases[0].ref } }
      );
    }
    const record = aliases[0] ?? null;
    if (record === null && !allowMissing) {
      throw new GitIntegrationError(`Ref does not exist: ${requestedRef}`, `${kind}-ref-not-found`);
    }
    return record;
  }

  async #resolveExactCommit(projectRoot, revision, label) {
    if (revision !== 'HEAD') requireObjectId(revision, label);
    let result;
    try {
      result = await this.#git(
        ['rev-parse', '--verify', `${revision}^{commit}`],
        { cwd: projectRoot }
      );
    } catch (error) {
      throw operationError(
        `${label} does not resolve to a commit.`,
        'revision-not-found',
        error,
        { revision }
      );
    }
    const resolved = requireSingleLine(result.stdout, 'rev-parse');
    requireObjectId(resolved, label);
    if (revision !== 'HEAD' && resolved !== revision) {
      throw new GitIntegrationError(
        `${label} must be an exact commit object id.`,
        'object-id-mismatch',
        { details: { revision, resolved } }
      );
    }
    return resolved;
  }

  async #resolveTree(projectRoot, revision) {
    const result = await this.#git(
      ['rev-parse', '--verify', `${revision}^{tree}`],
      { cwd: projectRoot }
    );
    const tree = requireSingleLine(result.stdout, 'rev-parse tree');
    return requireObjectId(tree, 'tree');
  }

  async #isAncestor(projectRoot, ancestor, descendant) {
    const result = await this.#git(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      { cwd: projectRoot, allowedExitCodes: [0, 1] }
    );
    return result.status === 0;
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
      topLevel = requireSingleLine(result.stdout, 'git top-level');
    } catch (error) {
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
      throw new GitIntegrationError(
        'projectRoot must be the Git worktree top-level.',
        'project-root-not-top-level',
        { details: { projectRoot: inputRoot, topLevel: canonicalTopLevel } }
      );
    }
    return canonicalTopLevel;
  }

  async #capturePreparedEffects(projectRoot, baseRevision, candidateRevision) {
    const [nameStatus, patchResult] = await Promise.all([
      this.#git([
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        '--no-ext-diff',
        baseRevision,
        candidateRevision,
        '--'
      ], { cwd: projectRoot }),
      this.#git([
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        baseRevision,
        candidateRevision,
        '--'
      ], { cwd: projectRoot })
    ]);
    const changes = parseNameStatus(nameStatus.stdout).sort(compareChanges);
    const changedFiles = [...new Set(changes.flatMap((change) => [
      change.path,
      ...(change.previousPath === undefined ? [] : [change.previousPath])
    ]))].sort((left, right) => left.localeCompare(right, 'en'));
    return {
      changedFiles,
      changes,
      patchDigest: createHash('sha256').update(patchResult.stdout, 'utf8').digest('hex')
    };
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

function normalizeRequest(value, { requireCandidate }) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitIntegrationError('integration request must be an object.', 'invalid-integration-request');
  }
  const request = {
    integrationId: requirePortableId(value.integrationId, 'integrationId'),
    changeSetId: requirePortableId(value.changeSetId, 'changeSetId'),
    targetRef: requireTargetRef(value.targetRef),
    expectedTargetRevision: requireObjectId(
      value.expectedTargetRevision,
      'expectedTargetRevision'
    ),
    changeSetHeadRevision: requireObjectId(
      value.changeSetHeadRevision,
      'changeSetHeadRevision'
    )
  };
  if (requireCandidate) {
    request.candidateRevision = requireObjectId(value.candidateRevision, 'candidateRevision');
    request.candidateTree = requireObjectId(value.candidateTree, 'candidateTree');
  }
  return request;
}

function normalizePreparedRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitIntegrationError(
      'prepared candidate request must be an object.',
      'invalid-integration-request'
    );
  }
  const integrationId = requirePortableId(
    value.integrationId ?? value.operationId,
    'integrationId'
  );
  const request = {
    integrationId,
    targetRef: requireTargetRef(value.targetRef),
    expectedTargetRevision: requireObjectId(
      value.expectedTargetRevision,
      'expectedTargetRevision'
    ),
    candidateRevision: requireObjectId(value.candidateRevision, 'candidateRevision'),
    candidateTree: requireObjectId(value.candidateTree, 'candidateTree')
  };
  if (!Array.isArray(value.parents)
    || value.parents.length < 1
    || value.parents.length > 2) {
    throw new GitIntegrationError(
      'parents must contain one or two full Git object ids.',
      'invalid-integration-request'
    );
  }
  request.parents = value.parents.map((parent, index) => (
    requireObjectId(parent, `parents[${index}]`)
  ));
  if (new Set(request.parents).size !== request.parents.length) {
    throw new GitIntegrationError(
      'parents must not contain duplicates.',
      'invalid-integration-request'
    );
  }
  request.patchDigest = requireDigest(value.patchDigest, 'patchDigest');
  if (!Array.isArray(value.changedFiles) || value.changedFiles.length === 0) {
    throw new GitIntegrationError(
      'changedFiles must contain the prepared candidate paths.',
      'invalid-integration-request'
    );
  }
  request.changedFiles = value.changedFiles.map((file) => assertSafeGitPath(file));
  if (new Set(request.changedFiles).size !== request.changedFiles.length
    || JSON.stringify(request.changedFiles) !== JSON.stringify(
      [...request.changedFiles].sort((left, right) => left.localeCompare(right, 'en'))
    )) {
    throw new GitIntegrationError(
      'changedFiles must be unique and sorted.',
      'invalid-integration-request'
    );
  }
  if (!Array.isArray(value.changes) || value.changes.length === 0
    || value.changes.some((change) => change === null
      || typeof change !== 'object'
      || Array.isArray(change)
      || typeof change.path !== 'string')) {
    throw new GitIntegrationError(
      'changes must contain structured prepared candidate effects.',
      'invalid-integration-request'
    );
  }
  try {
    request.changes = JSON.parse(JSON.stringify(value.changes));
  } catch (error) {
    throw new GitIntegrationError(
      'changes must be JSON serializable.',
      'invalid-integration-request',
      { cause: error }
    );
  }
  return request;
}

function requirePortableId(value, label) {
  if (typeof value !== 'string'
    || !PORTABLE_ID_PATTERN.test(value)
    || WINDOWS_DEVICE_NAME_PATTERN.test(value)) {
    throw new GitIntegrationError(
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
    throw new GitIntegrationError(
      'targetRef must be a fully-qualified refs/heads/* ref.',
      'invalid-target-ref'
    );
  }
  return value;
}

function requireObjectId(value, label) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw new GitIntegrationError(
      `${label} must be a full lowercase Git object id.`,
      'invalid-object-id',
      { details: { label, value } }
    );
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new GitIntegrationError(
      `${label} must be a lowercase SHA-256 digest.`,
      'invalid-integration-request'
    );
  }
  return value;
}

function assertPreparedEffects(expected, actual) {
  if (actual.patchDigest !== expected.patchDigest
    || stableStringify(actual.changedFiles) !== stableStringify(expected.changedFiles)
    || stableStringify(actual.changes) !== stableStringify(expected.changes)) {
    throw new GitIntegrationError(
      'The Git candidate effects do not match the durable patch contract.',
      'candidate-effects-mismatch',
      {
        details: {
          expected: {
            patchDigest: expected.patchDigest,
            changedFiles: expected.changedFiles,
            changes: expected.changes
          },
          actual
        }
      }
    );
  }
}

function candidateMessage(request) {
  return `fwa(${request.integrationId}): integrate ${request.changeSetId}`;
}

function candidateRefFor(integrationId) {
  return `${CANDIDATE_REF_ROOT}/${integrationId}/candidate`;
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new GitIntegrationError('clock must return a valid date.', 'invalid-clock-value');
  }
  return date.toISOString();
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
        throw new GitIntegrationError(
          'Git name-status data is missing its path.',
          'invalid-git-output'
        );
      }
      firstPath = tokens[index];
      index += 1;
    }
    if (!/^[A-Z][0-9]*$/u.test(code)) {
      throw new GitIntegrationError(
        `Git returned malformed name-status code ${JSON.stringify(code)}.`,
        'invalid-git-output'
      );
    }
    if (code.startsWith('R') || code.startsWith('C')) {
      if (index >= tokens.length) {
        throw new GitIntegrationError(
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

function assertSafeGitPath(value) {
  if (typeof value !== 'string'
    || value === ''
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.split('/').includes('..')) {
    throw new GitIntegrationError(
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

function compareChanges(left, right) {
  const byPath = left.path.localeCompare(right.path, 'en');
  if (byPath !== 0) return byPath;
  return (left.previousPath ?? '').localeCompare(right.previousPath ?? '', 'en');
}

function parseWorktreeList(output) {
  const records = [];
  let current = null;
  for (const token of output.split('\0')) {
    if (token === '') {
      if (current !== null) records.push(current);
      current = null;
      continue;
    }
    const separator = token.indexOf(' ');
    const key = separator < 0 ? token : token.slice(0, separator);
    const value = separator < 0 ? true : token.slice(separator + 1);
    if (key === 'worktree') {
      if (current !== null) records.push(current);
      current = { path: value, branch: null };
    } else if (current !== null && key === 'branch') {
      current.branch = value;
    }
  }
  if (current !== null) records.push(current);
  return records;
}

function parseRefRecords(output) {
  if (output === '') return [];
  const lines = output.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => {
    const fields = line.split('\t');
    if (fields.length !== 3 || fields[0] === '') {
      throw new GitIntegrationError(
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

async function canonicalRealDirectory(candidate, { code, label }) {
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    throw new GitIntegrationError(`${label} does not exist: ${candidate}`, code, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new GitIntegrationError(`${label} must be a real directory: ${candidate}`, code);
  }
  try {
    return path.resolve(await realpath(candidate));
  } catch (error) {
    throw new GitIntegrationError(`Cannot resolve ${label}: ${candidate}`, code, { cause: error });
  }
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function requireSingleLine(output, label) {
  const normalized = output.replace(/\r?\n$/u, '');
  if (normalized === '' || normalized.includes('\n') || normalized.includes('\r')) {
    throw new GitIntegrationError(`${label} returned malformed output.`, 'invalid-git-output');
  }
  return normalized;
}

function operationError(message, code, cause, details) {
  if (cause instanceof GitIntegrationError && cause.code !== 'git-command-failed') return cause;
  return new GitIntegrationError(message, code, { cause, details });
}

function runProcess(executable, arguments_, options = {}) {
  return runGitProcess(executable, arguments_, { ...options, ErrorType: GitIntegrationError });
}
