import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import {
  FILE_OPERATIONS_CAPABILITY,
  FileOperationsExecutor
} from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { stableStringify } from '../src/core/events.js';
import { hashCanonicalValue } from '../src/storage/file-event-store.js';

const TARGET_REVISION = 'a'.repeat(40);
const TARGET_TREE = 'b'.repeat(40);
const MERGE_REVISION = 'c'.repeat(40);
const MERGE_TREE = 'd'.repeat(40);
const REVERT_REVISION = 'e'.repeat(40);
const REVERT_TREE = 'f'.repeat(40);
const ADVANCED_REVISION = '9'.repeat(40);

async function run(executable, arguments_, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) {
        reject(new Error(
          `${executable} ${arguments_.join(' ')} exited ${status}: ${Buffer.concat(stderr)}`
        ));
        return;
      }
      resolve();
    });
  });
}

function profile(id) {
  return {
    schemaVersion: 1,
    id,
    checks: [{
      id: `${id}-compile`,
      kind: 'compile',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 10_000,
      expectedExitCodes: [0]
    }, {
      id: `${id}-test`,
      kind: 'test',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 10_000,
      expectedExitCodes: [0]
    }]
  };
}

function acceptanceProfile(nodeId) {
  return {
    schemaVersion: 1,
    id: `${nodeId}-acceptance`,
    checks: [{
      id: `${nodeId}-accepted`,
      kind: 'command',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 10_000,
      expectedExitCodes: [0]
    }]
  };
}

function evaluationWorkspace(root) {
  return {
    removeCalls: [],
    async createEvaluation(request) {
      return {
        evaluationId: request.evaluationId,
        workspacePath: root,
        headRevision: request.revision,
        detached: true
      };
    },
    async inspectEvaluation(request) {
      return {
        evaluationId: request.evaluationId,
        workspacePath: request.workspacePath,
        headRevision: request.revision,
        detached: true,
        changes: [],
        trackedChanges: []
      };
    },
    async removeEvaluation(request) {
      this.removeCalls.push(request);
      return { removed: true, alreadyAbsent: false };
    }
  };
}

function preparedInspection(request, disposition) {
  const targetRevision = disposition === 'applied'
    ? request.candidateRevision
    : disposition === 'not-applied'
      ? request.expectedTargetRevision
      : ADVANCED_REVISION;
  return {
    disposition,
    ...request,
    targetRevision,
    observedTargetRevision: targetRevision,
    containsCandidate: ['applied', 'advanced'].includes(disposition)
  };
}

function preparedPromotion(disposition = 'applied') {
  return {
    preparedInspectCalls: 0,
    promotePreparedCalls: 0,
    async verifyChangeSet() {},
    async promotePrepared() {
      this.promotePreparedCalls += 1;
    },
    async inspectPrepared(request) {
      this.preparedInspectCalls += 1;
      return preparedInspection(request, disposition);
    },
    async promote() {},
    async inspect() {
      throw new Error('The exact integration inspection path was not expected.');
    }
  };
}

function completeCandidateWorkspace(root) {
  return {
    cleanupCalls: [],
    async prepareMerge(request) {
      return {
        disposition: 'prepared',
        kind: 'merge',
        integrationId: request.integrationId,
        targetRef: request.targetRef,
        expectedTargetRevision: request.expectedTargetRevision,
        sourceRevision: request.sourceRevision,
        workspacePath: path.join(root, '.fwa', 'owned', request.integrationId),
        candidateRef: `refs/fwa/integrations/${request.integrationId}/candidate`,
        candidateRevision: MERGE_REVISION,
        candidateTree: MERGE_TREE,
        parents: [request.expectedTargetRevision, request.sourceRevision],
        conflicts: [],
        changedFiles: ['source.txt'],
        changes: [{ status: 'added', code: 'A', path: 'source.txt' }],
        patch: 'diff --git a/source.txt b/source.txt\n'
      };
    },
    async prepareRevert(request) {
      return {
        disposition: 'prepared',
        kind: 'revert',
        integrationId: request.integrationId,
        targetRef: request.targetRef,
        expectedTargetRevision: request.expectedTargetRevision,
        revertedRevision: request.revertedRevision,
        workspacePath: path.join(root, '.fwa', 'owned', request.integrationId),
        candidateRef: `refs/fwa/integrations/${request.integrationId}/candidate`,
        candidateRevision: REVERT_REVISION,
        candidateTree: REVERT_TREE,
        parents: [request.expectedTargetRevision],
        conflicts: [],
        changedFiles: ['source.txt'],
        changes: [{ status: 'deleted', code: 'D', path: 'source.txt' }],
        patch: 'diff --git a/source.txt b/source.txt\n'
      };
    },
    async cleanup(request) {
      this.cleanupCalls.push(request);
      return { removed: true, alreadyAbsent: false };
    },
    async pruneCandidateRef() {
      return { removed: false, alreadyAbsent: true };
    },
    async inspectResidue() {
      return {
        ok: true,
        entries: [],
        count: 0,
        candidateRefs: [],
        candidateRefCount: 0
      };
    }
  };
}

function retryableCleanupCandidateWorkspace(root) {
  const delegate = completeCandidateWorkspace(root);
  const state = {
    cleanupCalls: 0,
    failNextCleanup: true,
    integrationId: null,
    workspacePath: null,
    residue: false
  };
  const remember = (prepared) => {
    state.integrationId = prepared.integrationId;
    state.workspacePath = prepared.workspacePath;
    state.residue = true;
    return prepared;
  };
  return {
    state,
    async prepareMerge(request) {
      return remember(await delegate.prepareMerge(request));
    },
    async prepareRevert(request) {
      return remember(await delegate.prepareRevert(request));
    },
    async cleanup(request) {
      state.cleanupCalls += 1;
      assert.equal(request.integrationId, state.integrationId);
      if (state.failNextCleanup) {
        state.failNextCleanup = false;
        throw new Error('Simulated candidate cleanup interruption.');
      }
      state.residue = false;
      return { removed: true, alreadyAbsent: false };
    },
    async inspectResidue() {
      const entries = state.residue
        ? [{
            integrationId: state.integrationId,
            workspacePath: state.workspacePath,
            registered: true,
            exists: true
          }]
        : [];
      return {
        ok: entries.length === 0,
        entries,
        count: entries.length,
        candidateRefs: [],
        candidateRefCount: 0
      };
    },
    async pruneCandidateRef() {
      return { removed: false, alreadyAbsent: true };
    },
    armCleanupFailure() {
      state.residue = true;
      state.failNextCleanup = true;
    }
  };
}

function noCandidateWorkspace() {
  return {
    async cleanup() {
      return { removed: false, alreadyAbsent: true };
    },
    async pruneCandidateRef() {
      return { removed: false, alreadyAbsent: true };
    },
    async inspectResidue() {
      return {
        ok: true,
        entries: [],
        count: 0,
        candidateRefs: [],
        candidateRefCount: 0
      };
    }
  };
}

function failingCleanupCandidateWorkspace(code) {
  const cleanupCalls = [];
  return {
    cleanupCalls,
    async cleanup(request) {
      cleanupCalls.push(request);
      const error = new Error('Simulated candidate cleanup failure after a reconcile race.');
      error.code = code;
      throw error;
    },
    async pruneCandidateRef() {
      return { removed: false, alreadyAbsent: true };
    },
    async inspectResidue() {
      return {
        ok: true,
        entries: [],
        count: 0,
        candidateRefs: [],
        candidateRefCount: 0
      };
    }
  };
}

function racedReconcileLease(expectedOwnerKind) {
  let reportAcquire;
  let allowAcquire;
  const acquireEntered = new Promise((resolve) => { reportAcquire = resolve; });
  const acquireGate = new Promise((resolve) => { allowAcquire = resolve; });
  const leaseId = expectedOwnerKind === 'integration'
    ? '11111111-1111-4111-8111-111111111111'
    : '22222222-2222-4222-8222-222222222222';
  let acquiredOwnerId = null;
  let releaseCalls = 0;
  return {
    acquireEntered,
    allowAcquire,
    get releaseCalls() {
      return releaseCalls;
    },
    lease: {
      async init() {
        return { held: false, lease: null };
      },
      async inspect() {
        return { held: false, stale: false, lease: null };
      },
      async acquire({ ownerKind, ownerId }) {
        assert.equal(ownerKind, expectedOwnerKind);
        acquiredOwnerId = ownerId;
        reportAcquire();
        await acquireGate;
        return {
          acquired: true,
          lease: { leaseId, ownerKind, ownerId },
          ownerToken: `${expectedOwnerKind}-race-owner-token`
        };
      },
      async heartbeat() {
        throw new Error('A reconcile race must not start a heartbeat.');
      },
      async release({ leaseId: requestedLeaseId, ownerToken }) {
        assert.equal(requestedLeaseId, leaseId);
        assert.equal(ownerToken, `${expectedOwnerKind}-race-owner-token`);
        releaseCalls += 1;
        return {
          released: true,
          lease: { leaseId, ownerKind: expectedOwnerKind, ownerId: acquiredOwnerId }
        };
      },
      async archiveStale() {
        throw new Error('A reconcile race must not archive a lease.');
      }
    }
  };
}

async function acceptedFixture(t, { includeTarget = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-recovery-safety-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  await run('git', ['init', '-b', 'main'], { cwd: root });
  await run('git', ['config', 'user.name', 'FWA Recovery Safety Test'], { cwd: root });
  await run('git', ['config', 'user.email', 'fwa-recovery@example.invalid'], { cwd: root });
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  await run('git', ['add', '-A', '--', '.'], { cwd: root });
  await run('git', ['commit', '--no-gpg-sign', '-m', 'test: recovery base'], { cwd: root });

  const app = new FwaApplication(root);
  const workspace = new GitWorktreeAdapter(root);
  const evaluator = new CommandEvaluator({ env: {} });
  await app.init();
  const goal = await app.createGoal({ title: 'Recovery safety', commandId: 'create-goal' });
  const nodes = [{
    id: 'source',
    dependsOn: [],
    reads: ['seed.txt'],
    writes: ['source.txt'],
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    acceptance: { checks: ['source-accepted'] },
    budget: { maxRetries: 2, maxFiles: 2, maxDiffLines: 50 }
  }];
  if (includeTarget) {
    nodes.push({
      id: 'target',
      dependsOn: [],
      reads: ['seed.txt'],
      writes: ['target.txt'],
      capabilities: [FILE_OPERATIONS_CAPABILITY],
      acceptance: { checks: ['target-accepted'] },
      budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 50 }
    });
  }
  await app.loadPlan({
    goalId: goal.goal.id,
    commandId: 'load-plan',
    plan: { schemaVersion: 1, nodes }
  });

  const accepted = {};
  for (const node of nodes) {
    const produced = await app.runNext({
      executor: new FileOperationsExecutor(),
      workspace,
      input: {
        schemaVersion: 1,
        operations: [{ type: 'write', path: `${node.id}.txt`, content: `${node.id}\n` }]
      },
      commandId: `produce-${node.id}`
    });
    assert.equal(produced.ok, true, JSON.stringify(produced, null, 2));
    const evaluated = await app.evaluateChangeSet({
      changeSetId: produced.changeSet.id,
      profile: acceptanceProfile(node.id),
      evaluator,
      workspace,
      commandId: `evaluate-${node.id}`
    });
    assert.equal(evaluated.ok, true, JSON.stringify(evaluated, null, 2));
    accepted[node.id] = produced.changeSet;
  }

  if (includeTarget) {
    const exactTarget = {
      async verifyChangeSet() {},
      async prepare(request) {
        return { ...request, candidateRevision: TARGET_REVISION, candidateTree: TARGET_TREE };
      },
      async promote() {},
      async inspect(request) {
        return {
          disposition: 'applied',
          ...request,
          targetRevision: request.candidateRevision,
          observedTargetRevision: request.candidateRevision,
          containsCandidate: true
        };
      }
    };
    const integrated = await app.integrateChangeSet({
      changeSetId: accepted.target.id,
      targetRef: 'main',
      workspace: exactTarget,
      commandId: 'integrate-target'
    });
    assert.equal(integrated.ok, true, JSON.stringify(integrated, null, 2));
  }

  return {
    root,
    app,
    workspace,
    evaluator,
    evaluationWorkspace: evaluationWorkspace(root),
    source: accepted.source
  };
}

async function integrateSource(fixture, {
  candidateWorkspace = completeCandidateWorkspace(fixture.root),
  promotion = preparedPromotion('applied'),
  regressionGate,
  regressionProfile = profile('merge-regression'),
  commandId = 'integrate-source'
} = {}) {
  return fixture.app.integrateChangeSetGated({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace,
    promotion,
    evaluator: fixture.evaluator,
    profile: regressionProfile,
    evaluationWorkspace: fixture.evaluationWorkspace,
    ...(regressionGate === undefined ? {} : { regressionGate }),
    commandId
  });
}

async function integratedFixture(t) {
  const fixture = await acceptedFixture(t);
  const candidateWorkspace = completeCandidateWorkspace(fixture.root);
  const promotion = preparedPromotion('applied');
  const result = await integrateSource(fixture, { candidateWorkspace, promotion });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  return { ...fixture, candidateWorkspace, promotion };
}

function retainedGateError() {
  const error = new Error('Evaluator termination was not confirmed.');
  error.cleanup = { status: 'retained' };
  return error;
}

test('partial merge and revert preparation always transfer cleanup ownership', async (t) => {
  const fixture = await acceptedFixture(t);
  const mergeOwnership = { created: false, cleanupCalls: [] };
  const partialMerge = {
    async prepareMerge() {
      mergeOwnership.created = true;
      throw new Error('failed after worktree creation');
    },
    async cleanup(request) {
      mergeOwnership.cleanupCalls.push(request);
      assert.equal(mergeOwnership.created, true);
      mergeOwnership.created = false;
      return { removed: true, alreadyAbsent: false };
    }
  };
  const failedMerge = await integrateSource(fixture, {
    candidateWorkspace: partialMerge,
    promotion: preparedPromotion('applied'),
    commandId: 'partial-merge'
  });
  assert.equal(failedMerge.integration.status, 'failed');
  assert.equal(failedMerge.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(mergeOwnership.created, false);
  assert.equal(mergeOwnership.cleanupCalls.length, 1);
  assert.equal(mergeOwnership.cleanupCalls[0].workspacePath, undefined);
  assert.equal(mergeOwnership.cleanupCalls[0].force, true);

  const integrated = await integrateSource(fixture, { commandId: 'merge-after-cleanup' });
  assert.equal(integrated.ok, true, JSON.stringify(integrated, null, 2));
  const revertOwnership = { created: false, cleanupCalls: [] };
  const partialRevert = {
    async prepareRevert() {
      revertOwnership.created = true;
      throw new Error('failed after revert worktree creation');
    },
    async cleanup(request) {
      revertOwnership.cleanupCalls.push(request);
      assert.equal(revertOwnership.created, true);
      revertOwnership.created = false;
      return { removed: true, alreadyAbsent: false };
    }
  };
  const failedRevert = await fixture.app.revertChangeSet({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace: partialRevert,
    promotion: preparedPromotion('applied'),
    evaluator: fixture.evaluator,
    profile: profile('revert-regression'),
    evaluationWorkspace: fixture.evaluationWorkspace,
    commandId: 'partial-revert'
  });
  assert.equal(failedRevert.reversion.status, 'failed');
  assert.equal(failedRevert.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(revertOwnership.created, false);
  assert.equal(revertOwnership.cleanupCalls.length, 1);
  assert.equal(revertOwnership.cleanupCalls[0].workspacePath, undefined);
  assert.equal(revertOwnership.cleanupCalls[0].force, true);
});

test('advanced exact integration stays recovery-required through settlement and reconcile', async (t) => {
  const fixture = await acceptedFixture(t, { includeTarget: false });
  const exact = {
    inspectCalls: 0,
    async verifyChangeSet() {},
    async prepare(request) {
      return { ...request, candidateRevision: TARGET_REVISION, candidateTree: TARGET_TREE };
    },
    async promote() {},
    async inspect(request) {
      this.inspectCalls += 1;
      return {
        disposition: 'advanced',
        ...request,
        targetRevision: ADVANCED_REVISION,
        observedTargetRevision: ADVANCED_REVISION,
        containsCandidate: true
      };
    }
  };
  const result = await fixture.app.integrateChangeSet({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    workspace: exact,
    commandId: 'advanced-exact'
  });
  assert.equal(result.integration.status, 'recovery-required');
  assert.equal(result.integration.integratedRevision, null);
  assert.ok(exact.inspectCalls >= 2);
  const reconciled = await fixture.app.reconcileIntegration({
    workspace: exact,
    candidateWorkspace: noCandidateWorkspace(),
    correlationId: 'reconcile-advanced-exact'
  });
  assert.equal(reconciled.integration.status, 'recovery-required');
  assert.equal(reconciled.integration.integratedRevision, null);
  assert.equal((await fixture.app.getStatus()).projectRevisions.length, 0);
});

test('advanced gated candidate stays recovery-required in catch and reconcile paths', async (t) => {
  const fixture = await acceptedFixture(t);
  const promotion = preparedPromotion('advanced');
  const candidateWorkspace = completeCandidateWorkspace(fixture.root);
  const result = await integrateSource(fixture, {
    candidateWorkspace,
    promotion,
    commandId: 'advanced-gated'
  });
  assert.equal(result.integration.status, 'recovery-required');
  assert.equal(result.integration.integratedRevision, null);
  const reconciled = await fixture.app.reconcileIntegration({
    workspace: promotion,
    candidateWorkspace,
    correlationId: 'reconcile-advanced-gated'
  });
  assert.equal(reconciled.integration.status, 'recovery-required');
  assert.equal(reconciled.integration.integratedRevision, null);
  assert.equal((await fixture.app.getStatus()).projectRevisions.length, 1);
  assert.equal((await fixture.app.listEvents()).some(
    (event) => event.type === 'IntegrationApplied'
      && event.payload.integrationId === result.integration.id
  ), false);
});

test('advanced revert candidate stays recovery-required in catch and reconcile paths', async (t) => {
  const fixture = await integratedFixture(t);
  const promotion = preparedPromotion('advanced');
  const candidateWorkspace = completeCandidateWorkspace(fixture.root);
  const result = await fixture.app.revertChangeSet({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace,
    promotion,
    evaluator: fixture.evaluator,
    profile: profile('advanced-revert-regression'),
    evaluationWorkspace: fixture.evaluationWorkspace,
    commandId: 'advanced-revert'
  });
  assert.equal(result.reversion.status, 'recovery-required');
  assert.equal(result.reversion.revertChangeSetId, null);
  const reconciled = await fixture.app.reconcileReversion({
    promotion,
    candidateWorkspace,
    correlationId: 'reconcile-advanced-revert'
  });
  assert.equal(reconciled.reversion.status, 'recovery-required');
  assert.equal(reconciled.reversion.revertChangeSetId, null);
  assert.equal((await fixture.app.getStatus()).projectRevisions.length, 2);
  assert.equal((await fixture.app.listEvents()).some(
    (event) => event.type === 'ReversionApplied'
      && event.payload.reversionId === result.reversion.id
  ), false);
});

test('retained gated candidate without durable pass remains fenced after reconcile', async (t) => {
  const fixture = await acceptedFixture(t);
  const promotion = preparedPromotion('applied');
  const candidateWorkspace = completeCandidateWorkspace(fixture.root);
  const regressionProfile = profile('merge-regression');
  const normalizedProfile = fixture.evaluator.normalizeProfile(regressionProfile);
  const profileArtifact = await fixture.app.artifacts.put(stableStringify(normalizedProfile));
  assert.equal(hashCanonicalValue(normalizedProfile), profileArtifact.digest);
  const result = await integrateSource(fixture, {
    candidateWorkspace,
    promotion,
    regressionProfile,
    regressionGate: async () => { throw retainedGateError(); },
    commandId: 'retained-gated'
  });
  assert.equal(result.integration.status, 'recovery-required');
  assert.equal(result.integration.regressionEvidence, null);
  const reconciled = await fixture.app.reconcileIntegration({
    workspace: promotion,
    candidateWorkspace,
    correlationId: 'reconcile-retained-gated'
  });
  assert.equal(reconciled.integration.status, 'recovery-required');
  assert.equal(reconciled.integration.regressionEvidence, null);
  assert.equal(promotion.preparedInspectCalls, 0);
  assert.equal((await fixture.app.listEvents()).some(
    (event) => event.type === 'IntegrationFailed'
      && event.payload.integrationId === result.integration.id
  ), false);

  const removalCallCount = fixture.evaluationWorkspace.removeCalls.length;
  const aborted = await fixture.app.reconcileIntegration({
    workspace: promotion,
    candidateWorkspace,
    evaluationWorkspace: fixture.evaluationWorkspace,
    confirmProcessesStopped: true,
    correlationId: 'abort-retained-gated-after-process-confirmation'
  });
  assert.equal(aborted.integration.status, 'failed');
  assert.equal(aborted.integration.phase, 'regression-recovery-abort');
  assert.equal(
    aborted.integration.failure.code,
    'INTEGRATION_REGRESSION_ABORTED_AFTER_PROCESS_CONFIRMATION'
  );
  assert.equal(aborted.cleanup.leaseReleased, true);
  assert.equal(aborted.cleanup.candidateWorkspaceRemoved, true);
  assert.deepEqual(
    fixture.evaluationWorkspace.removeCalls.slice(removalCallCount),
    [{
      evaluationId: result.integration.id,
      revision: result.integration.candidateRevision,
      force: true
    }]
  );
  assert.deepEqual((await fixture.app.verify()).unreferencedArtifacts, []);
});

test('retained revert candidate without durable pass remains fenced after reconcile', async (t) => {
  const fixture = await integratedFixture(t);
  const promotion = preparedPromotion('applied');
  const candidateWorkspace = completeCandidateWorkspace(fixture.root);
  const regressionProfile = profile('retained-revert-regression');
  const normalizedProfile = fixture.evaluator.normalizeProfile(regressionProfile);
  await fixture.app.artifacts.put(stableStringify(normalizedProfile));
  const result = await fixture.app.revertChangeSet({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace,
    promotion,
    evaluator: fixture.evaluator,
    profile: regressionProfile,
    evaluationWorkspace: fixture.evaluationWorkspace,
    regressionGate: async () => { throw retainedGateError(); },
    commandId: 'retained-revert'
  });
  assert.equal(result.reversion.status, 'recovery-required');
  assert.equal(result.reversion.regressionEvidence, null);
  const reconciled = await fixture.app.reconcileReversion({
    promotion,
    candidateWorkspace,
    correlationId: 'reconcile-retained-revert'
  });
  assert.equal(reconciled.reversion.status, 'recovery-required');
  assert.equal(reconciled.reversion.regressionEvidence, null);
  assert.equal(promotion.preparedInspectCalls, 0);
  assert.equal((await fixture.app.listEvents()).some(
    (event) => event.type === 'ReversionFailed'
      && event.payload.reversionId === result.reversion.id
  ), false);

  const removalCallCount = fixture.evaluationWorkspace.removeCalls.length;
  const aborted = await fixture.app.reconcileReversion({
    promotion,
    candidateWorkspace,
    evaluationWorkspace: fixture.evaluationWorkspace,
    confirmProcessesStopped: true,
    correlationId: 'abort-retained-revert-after-process-confirmation'
  });
  assert.equal(aborted.reversion.status, 'failed');
  assert.equal(aborted.reversion.phase, 'regression-recovery-abort');
  assert.equal(
    aborted.reversion.failure.code,
    'REVERSION_REGRESSION_ABORTED_AFTER_PROCESS_CONFIRMATION'
  );
  assert.equal(aborted.cleanup.leaseReleased, true);
  assert.equal(aborted.cleanup.candidateWorkspaceRemoved, true);
  assert.deepEqual(
    fixture.evaluationWorkspace.removeCalls.slice(removalCallCount),
    [{
      evaluationId: result.reversion.id,
      revision: result.reversion.candidateRevision,
      force: true
    }]
  );
  assert.deepEqual((await fixture.app.verify()).unreferencedArtifacts, []);
});

test('Integration replay retries cleanup and terminal reconcile removes known residue', async (t) => {
  const fixture = await acceptedFixture(t);
  const candidateWorkspace = retryableCleanupCandidateWorkspace(fixture.root);
  const promotion = preparedPromotion('applied');
  const run = () => integrateSource(fixture, {
    candidateWorkspace,
    promotion,
    commandId: 'integration-cleanup-replay'
  });

  const integrated = await run();
  assert.equal(integrated.integration.status, 'integrated');
  assert.equal(integrated.cleanup.candidateWorkspaceRemoved, false);
  assert.equal(candidateWorkspace.state.residue, true);

  const replayed = await run();
  assert.equal(replayed.appended, false);
  assert.equal(replayed.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(candidateWorkspace.state.residue, false);

  candidateWorkspace.armCleanupFailure();
  const interruptedReplay = await run();
  assert.equal(interruptedReplay.cleanup.candidateWorkspaceRemoved, false);
  assert.equal(candidateWorkspace.state.residue, true);

  const reconciled = await fixture.app.reconcileIntegration({
    workspace: promotion,
    candidateWorkspace,
    correlationId: 'reconcile-terminal-integration-residue'
  });
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.reason, 'candidate-workspace-residue-removed');
  assert.equal(reconciled.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(candidateWorkspace.state.residue, false);
  assert.deepEqual(await candidateWorkspace.inspectResidue(), {
    ok: true,
    entries: [],
    count: 0,
    candidateRefs: [],
    candidateRefCount: 0
  });
});

test('Reversion replay retries cleanup and terminal reconcile removes known residue', async (t) => {
  const fixture = await integratedFixture(t);
  const candidateWorkspace = retryableCleanupCandidateWorkspace(fixture.root);
  const promotion = preparedPromotion('applied');
  const run = () => fixture.app.revertChangeSet({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace,
    promotion,
    evaluator: fixture.evaluator,
    profile: profile('cleanup-replay-revert-regression'),
    evaluationWorkspace: fixture.evaluationWorkspace,
    commandId: 'reversion-cleanup-replay'
  });

  const reverted = await run();
  assert.equal(reverted.reversion.status, 'reverted');
  assert.equal(reverted.cleanup.candidateWorkspaceRemoved, false);
  assert.equal(candidateWorkspace.state.residue, true);

  const replayed = await run();
  assert.equal(replayed.appended, false);
  assert.equal(replayed.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(candidateWorkspace.state.residue, false);

  candidateWorkspace.armCleanupFailure();
  const interruptedReplay = await run();
  assert.equal(interruptedReplay.cleanup.candidateWorkspaceRemoved, false);
  assert.equal(candidateWorkspace.state.residue, true);

  const reconciled = await fixture.app.reconcileReversion({
    promotion,
    candidateWorkspace,
    correlationId: 'reconcile-terminal-reversion-residue'
  });
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.reason, 'candidate-workspace-residue-removed');
  assert.equal(reconciled.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(candidateWorkspace.state.residue, false);
  assert.deepEqual(await candidateWorkspace.inspectResidue(), {
    ok: true,
    entries: [],
    count: 0,
    candidateRefs: [],
    candidateRefCount: 0
  });
});

test('Integration reconcile state-change race still reports candidate cleanup failure', async (t) => {
  const fixture = await acceptedFixture(t);
  const interrupted = await integrateSource(fixture, {
    candidateWorkspace: completeCandidateWorkspace(fixture.root),
    promotion: preparedPromotion('advanced'),
    commandId: 'integration-before-state-change-race'
  });
  assert.equal(interrupted.integration.status, 'recovery-required');

  const race = racedReconcileLease('integration');
  const failedCleanup = failingCleanupCandidateWorkspace(
    'SIMULATED_INTEGRATION_RACE_CLEANUP_FAILURE'
  );
  const racedPromise = fixture.app.reconcileIntegration({
    workspace: preparedPromotion('applied'),
    candidateWorkspace: failedCleanup,
    lease: race.lease,
    correlationId: 'integration-state-change-race-loser'
  });
  await race.acquireEntered;
  try {
    const winner = await fixture.app.reconcileIntegration({
      workspace: preparedPromotion('applied'),
      candidateWorkspace: noCandidateWorkspace(),
      correlationId: 'integration-state-change-race-winner'
    });
    assert.equal(winner.integration.status, 'integrated');
  } finally {
    race.allowAcquire();
  }

  const raced = await racedPromise;
  assert.equal(raced.ok, true);
  assert.equal(raced.reconciled, false);
  assert.equal(raced.reason, 'integration-state-changed');
  assert.equal(raced.cleanup.leaseReleased, true);
  assert.equal(raced.cleanup.candidateWorkspaceRemoved, false);
  assert.equal(raced.cleanup.warnings.length, 1);
  assert.equal(raced.cleanup.warnings[0].phase, 'candidate-workspace-cleanup');
  assert.equal(
    raced.cleanup.warnings[0].failure.code,
    'SIMULATED_INTEGRATION_RACE_CLEANUP_FAILURE'
  );
  assert.equal(failedCleanup.cleanupCalls.length, 1);
  assert.equal(failedCleanup.cleanupCalls[0].integrationId, interrupted.integration.id);
  assert.equal(race.releaseCalls, 1);
});

test('Reversion reconcile state-change race still reports candidate cleanup failure', async (t) => {
  const fixture = await integratedFixture(t);
  const interrupted = await fixture.app.revertChangeSet({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace: completeCandidateWorkspace(fixture.root),
    promotion: preparedPromotion('advanced'),
    evaluator: fixture.evaluator,
    profile: profile('reversion-before-state-change-race'),
    evaluationWorkspace: fixture.evaluationWorkspace,
    commandId: 'reversion-before-state-change-race'
  });
  assert.equal(interrupted.reversion.status, 'recovery-required');

  const race = racedReconcileLease('reversion');
  const failedCleanup = failingCleanupCandidateWorkspace(
    'SIMULATED_REVERSION_RACE_CLEANUP_FAILURE'
  );
  const racedPromise = fixture.app.reconcileReversion({
    promotion: preparedPromotion('applied'),
    candidateWorkspace: failedCleanup,
    lease: race.lease,
    correlationId: 'reversion-state-change-race-loser'
  });
  await race.acquireEntered;
  try {
    const winner = await fixture.app.reconcileReversion({
      promotion: preparedPromotion('applied'),
      candidateWorkspace: noCandidateWorkspace(),
      correlationId: 'reversion-state-change-race-winner'
    });
    assert.equal(winner.reversion.status, 'reverted');
  } finally {
    race.allowAcquire();
  }

  const raced = await racedPromise;
  assert.equal(raced.ok, true);
  assert.equal(raced.reconciled, false);
  assert.equal(raced.reason, 'reversion-state-changed');
  assert.equal(raced.cleanup.leaseReleased, true);
  assert.equal(raced.cleanup.candidateWorkspaceRemoved, false);
  assert.equal(raced.cleanup.warnings.length, 1);
  assert.equal(raced.cleanup.warnings[0].phase, 'candidate-workspace-cleanup');
  assert.equal(
    raced.cleanup.warnings[0].failure.code,
    'SIMULATED_REVERSION_RACE_CLEANUP_FAILURE'
  );
  assert.equal(failedCleanup.cleanupCalls.length, 1);
  assert.equal(failedCleanup.cleanupCalls[0].integrationId, interrupted.reversion.id);
  assert.equal(race.releaseCalls, 1);
});
