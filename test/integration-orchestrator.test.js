import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import {
  FILE_OPERATIONS_CAPABILITY,
  FileOperationsExecutor
} from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import {
  IntegrationOrchestrationError,
  normalizeIntegrationTargetRef
} from '../src/application/integration-orchestrator.js';
import { createEvent } from '../src/core/events.js';

const CANDIDATE_REVISION = 'a'.repeat(40);
const CANDIDATE_TREE = 'b'.repeat(40);

function immediatePassingEvaluator() {
  const normalizer = new CommandEvaluator();
  const evaluator = {
    schemaVersion: 1,
    id: 'integration-test-evaluator',
    version: '1',
    normalizeProfile(profile) {
      return normalizer.normalizeProfile(profile);
    },
    async evaluate({ manifest }) {
      return {
        schemaVersion: 1,
        evaluator: { id: evaluator.id, version: evaluator.version },
        manifest: { id: manifest.id, schemaVersion: manifest.schemaVersion },
        durationMs: 1,
        environmentFingerprint: {
          platform: 'synthetic',
          arch: 'synthetic',
          runtime: { name: 'synthetic', version: '1' },
          environmentSha256: 'c'.repeat(64)
        },
        passed: true,
        checks: manifest.checks.map((expected) => ({
          id: expected.id,
          kind: expected.kind,
          status: 'passed',
          passed: true,
          command: expected.command,
          args: [...expected.args],
          timeoutMs: expected.timeoutMs,
          expectedExitCodes: [...expected.expectedExitCodes],
          exitCode: 0,
          signal: null,
          terminationConfirmed: true,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          expectedArtifacts: [],
          failure: null
        }))
      };
    }
  };
  return evaluator;
}

async function run(executable, arguments_, { cwd, allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      const result = {
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (!allowedExitCodes.includes(status)) {
        reject(new Error(
          `${executable} ${arguments_.join(' ')} exited ${status}: ${result.stderr}`
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function git(cwd, arguments_) {
  return run('git', arguments_, { cwd });
}

async function acceptedFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-integration-orchestrator-'));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25
  }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Integration Test']);
  await git(root, ['config', 'user.email', 'fwa-integration-test@example.invalid']);
  await git(root, ['config', 'core.ignorecase', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  await git(root, ['add', '.gitignore', 'seed.txt']);
  await git(root, ['commit', '-m', 'test: establish integration base']);

  const app = new FwaApplication(root);
  await app.init();
  const goal = await app.createGoal({
    title: 'Exercise C2a',
    request: 'Integrate one accepted exact-base ChangeSet.',
    commandId: 'fixture-create-goal'
  });
  await app.loadPlan({
    goalId: goal.goal.id,
    commandId: 'fixture-load-plan',
    plan: {
      schemaVersion: 1,
      nodes: [{
        id: 'produce',
        dependsOn: [],
        reads: ['seed.txt'],
        writes: ['generated/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['generated-exists'] },
        budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 }
      }, {
        id: 'follow-up',
        dependsOn: ['produce'],
        reads: ['generated/**'],
        writes: ['follow-up/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['follow-up-exists'] },
        budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 }
      }]
    }
  });
  const gitWorkspace = new GitWorktreeAdapter(root);
  const produced = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: gitWorkspace,
    input: {
      schemaVersion: 1,
      operations: [{ type: 'write', path: 'generated/output.txt', content: 'ok\n' }]
    },
    commandId: 'fixture-produce'
  });
  assert.equal(produced.ok, true);
  const evaluated = await app.evaluateChangeSet({
    changeSetId: produced.changeSet.id,
    profile: {
      schemaVersion: 1,
      id: 'fixture-evaluation',
      checks: [{
        id: 'generated-exists',
        kind: 'command',
        command: process.execPath,
        args: [
          '-e',
          "const fs=require('node:fs');process.exit(fs.readFileSync('generated/output.txt','utf8').trim()==='ok'?0:9)"
        ],
        timeoutMs: 10_000,
        expectedExitCodes: [0]
      }]
    },
    evaluator: immediatePassingEvaluator(),
    workspace: gitWorkspace,
    commandId: 'fixture-evaluate'
  });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.node.status, 'accepted');
  return { root, app, gitWorkspace, changeSet: produced.changeSet };
}

async function acceptFollowUp(app, gitWorkspace) {
  const produced = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: gitWorkspace,
    input: {
      schemaVersion: 1,
      operations: [{ type: 'write', path: 'follow-up/output.txt', content: 'ok\n' }]
    },
    commandId: 'fixture-produce-follow-up'
  });
  assert.equal(produced.ok, true);
  const evaluated = await app.evaluateChangeSet({
    changeSetId: produced.changeSet.id,
    profile: {
      schemaVersion: 1,
      id: 'fixture-follow-up-evaluation',
      checks: [{
        id: 'follow-up-exists',
        kind: 'command',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 10_000,
        expectedExitCodes: [0]
      }]
    },
    evaluator: immediatePassingEvaluator(),
    workspace: gitWorkspace,
    commandId: 'fixture-evaluate-follow-up'
  });
  assert.equal(evaluated.ok, true);
  return produced.changeSet;
}

function fakeIntegrationWorkspace(gitWorkspace, behavior = {}) {
  const state = { verifyCalls: 0, prepareCalls: 0, promoteCalls: 0, inspectCalls: 0 };
  return {
    state,
    workspace: {
      verifyChangeSet(changeSet) {
        state.verifyCalls += 1;
        return gitWorkspace.verifyChangeSet(changeSet);
      },
      async prepare(request) {
        state.prepareCalls += 1;
        if (behavior.prepareError) throw behavior.prepareError;
        return {
          ...request,
          candidateRevision: CANDIDATE_REVISION,
          candidateTree: CANDIDATE_TREE
        };
      },
      async promote(request) {
        state.promoteCalls += 1;
        if (behavior.promoteError) throw behavior.promoteError;
        return { ...request, targetRevision: request.candidateRevision };
      },
      async inspect(request) {
        state.inspectCalls += 1;
        if (behavior.inspectError) throw behavior.inspectError;
        const disposition = typeof behavior.disposition === 'function'
          ? behavior.disposition(request, state.inspectCalls)
          : behavior.disposition ?? 'applied';
        const defaultTargetRevision = disposition === 'not-applied'
          ? request.expectedTargetRevision
          : ['advanced', 'diverged'].includes(disposition)
            ? 'd'.repeat(40)
            : disposition === 'inconsistent'
              ? null
              : request.candidateRevision;
        const targetRevision = Object.hasOwn(behavior, 'targetRevision')
          ? typeof behavior.targetRevision === 'function'
            ? behavior.targetRevision(request)
            : behavior.targetRevision
          : defaultTargetRevision;
        const inspection = {
          disposition,
          targetRef: request.targetRef,
          expectedTargetRevision: request.expectedTargetRevision,
          changeSetHeadRevision: request.changeSetHeadRevision,
          candidateRevision: request.candidateRevision,
          candidateTree: request.candidateTree,
          targetRevision,
          observedTargetRevision: targetRevision,
          containsCandidate: behavior.containsCandidate
            ?? ['applied', 'advanced'].includes(disposition)
        };
        const overridden = { ...inspection, ...(behavior.inspectionOverrides ?? {}) };
        if (Object.hasOwn(behavior.inspectionOverrides ?? {}, 'targetRevision')
          && !Object.hasOwn(behavior.inspectionOverrides ?? {}, 'observedTargetRevision')) {
          overridden.observedTargetRevision = overridden.targetRevision;
        }
        return overridden;
      },
      async verify() {
        return { ok: true };
      }
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

test('normalizes only safe local branch refs', () => {
  assert.equal(normalizeIntegrationTargetRef('main'), 'refs/heads/main');
  assert.equal(
    normalizeIntegrationTargetRef('refs/heads/release/v1'),
    'refs/heads/release/v1'
  );
  for (const invalid of [
    'refs/tags/v1', '-main', 'a..b', 'a@{b', 'a b', 'a\\b', '.hidden', 'a.lock'
  ]) {
    assert.throws(
      () => normalizeIntegrationTargetRef(invalid),
      (error) => error instanceof IntegrationOrchestrationError
        && error.code === 'invalid-integration-target'
    );
  }
});

test('integrates one accepted ChangeSet, unlocks its dependent, and replays idempotently', async (t) => {
  const { app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const fake = fakeIntegrationWorkspace(gitWorkspace);
  const result = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: fake.workspace,
    commandId: 'integrate-once'
  });

  assert.equal(result.ok, true);
  assert.equal(result.integration.status, 'integrated');
  assert.equal(result.integration.targetRef, 'refs/heads/main');
  assert.equal(result.integration.candidateRevision, CANDIDATE_REVISION);
  assert.equal(result.node.status, 'accepted');
  assert.equal(result.node.integrationStatus, 'integrated');
  assert.equal(result.projectRevision.revision, CANDIDATE_REVISION);
  assert.equal(result.cleanup.leaseReleased, true);
  const status = await app.getStatus();
  assert.equal(status.nodes.find((node) => node.id === 'follow-up').status, 'ready');
  assert.equal(status.integrations.length, 1);
  assert.equal(status.projectRevisions.length, 1);
  assert.deepEqual(
    (await app.listEvents()).slice(-10).map((event) => event.type),
    [
      'IntegrationRequested',
      'NodeIntegrationRequested',
      'IntegrationExecutionStarted',
      'NodeIntegrationStarted',
      'IntegrationPrepared',
      'ProjectRevisionAdvanced',
      'IntegrationApplied',
      'NodeIntegrated',
      'NodeReady',
      'IntegrationEffectsApplied'
    ]
  );

  const replay = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'refs/heads/main',
    workspace: fake.workspace,
    commandId: 'integrate-once'
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.appended, false);
  assert.equal(fake.state.prepareCalls, 1);
  assert.equal(fake.state.promoteCalls, 1);
  await assert.rejects(
    app.integrateChangeSet({
      changeSetId: changeSet.id,
      targetRef: 'other',
      workspace: fake.workspace,
      commandId: 'integrate-once'
    }),
    (error) => error.code === 'command-id-conflict'
  );
});

test('records an exact-base preparation failure without revoking acceptance', async (t) => {
  const { app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const targetMoved = new Error('Target moved.');
  targetMoved.code = 'target-base-mismatch';
  targetMoved.details = { targetRef: 'refs/heads/main' };
  const failed = fakeIntegrationWorkspace(gitWorkspace, { prepareError: targetMoved });
  const result = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: failed.workspace,
    commandId: 'integrate-fails'
  });

  assert.equal(result.ok, false);
  assert.equal(result.integration.status, 'failed');
  assert.equal(result.integration.failure.code, 'target-base-mismatch');
  assert.equal(result.node.status, 'accepted');
  assert.equal(result.node.integrationStatus, 'failed');
  assert.equal(result.node.acceptedChangeSetId, changeSet.id);
  assert.equal((await app.getStatus()).nodes.find((node) => node.id === 'follow-up').status, 'planned');
  assert.equal(result.cleanup.leaseReleased, true);

  const retry = fakeIntegrationWorkspace(gitWorkspace);
  const recovered = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: retry.workspace,
    commandId: 'integrate-retry'
  });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.node.integrationIds, [result.integration.id, recovered.integration.id]);
});

test('marks an uncertain promotion for recovery and later reconciles proven Git state', async (t) => {
  const { app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const promotionError = new Error('Promotion response was lost.');
  promotionError.code = 'promotion-response-lost';
  const inspectionError = new Error('Target temporarily unreadable.');
  inspectionError.code = 'target-inspection-failed';
  const uncertain = fakeIntegrationWorkspace(gitWorkspace, {
    promoteError: promotionError,
    inspectError: inspectionError
  });
  const result = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: uncertain.workspace,
    commandId: 'integrate-uncertain'
  });

  assert.equal(result.ok, false);
  assert.equal(result.integration.status, 'recovery-required');
  assert.equal(result.node.status, 'accepted');
  assert.equal(result.node.integrationStatus, 'recovery-required');
  assert.equal((await app.verify()).operationallyClean, false);

  const proven = fakeIntegrationWorkspace(gitWorkspace, { disposition: 'applied' });
  const reconciled = await app.reconcileIntegration({
    workspace: proven.workspace,
    candidateWorkspace: noCandidateWorkspace(),
    correlationId: 'reconcile-integration'
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.integration.status, 'integrated');
  assert.equal(reconciled.cleanup.leaseReleased, true);
  assert.equal(proven.state.promoteCalls, 0);
  assert.equal((await app.getStatus()).nodes.find((node) => node.id === 'follow-up').status, 'ready');
});

test('reconciles the real Git boundary when promotion succeeded but its response was lost', async (t) => {
  const { root, app, changeSet } = await acceptedFixture(t);
  const delegate = new GitIntegrationAdapter(root);
  const lostResponse = {
    verifyChangeSet: (input) => delegate.verifyChangeSet(input),
    prepare: (input) => delegate.prepare(input),
    async promote(input) {
      await delegate.promote(input);
      const error = new Error('Simulated crash after Git promotion.');
      error.code = 'SIMULATED_POST_PROMOTION_CRASH';
      throw error;
    },
    async inspect() {
      const error = new Error('Simulated unavailable post-crash inspection.');
      error.code = 'SIMULATED_INSPECTION_OUTAGE';
      throw error;
    }
  };
  const interrupted = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: lostResponse,
    commandId: 'real-post-promotion-crash'
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.integration.status, 'recovery-required');
  assert.equal(
    (await git(root, ['rev-parse', 'main'])).stdout.trim(),
    interrupted.integration.candidateRevision
  );

  const reconciled = await app.reconcileIntegration({
    workspace: delegate,
    candidateWorkspace: noCandidateWorkspace(),
    correlationId: 'real-post-promotion-reconcile'
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.integration.status, 'integrated');
  assert.equal(reconciled.integration.integratedRevision, interrupted.integration.candidateRevision);
  assert.equal((await git(root, ['status', '--porcelain'])).stdout, '');
  const verification = await app.verify({ integration: delegate });
  assert.equal(verification.operationallyClean, true);
  assert.equal(verification.gitVerifiedIntegrationCount, 1);
});

test('refuses an unrecorded target advance or another Goal target before adapter mutation', async (t) => {
  const { app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const first = fakeIntegrationWorkspace(gitWorkspace);
  const integrated = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: first.workspace,
    commandId: 'establish-goal-target'
  });
  assert.equal(integrated.ok, true);
  assert.equal((await app.getStatus()).goals[0].integrationTargetRef, 'refs/heads/main');

  const followUp = await acceptFollowUp(app, gitWorkspace);
  const skippedRevision = fakeIntegrationWorkspace(gitWorkspace);
  await assert.rejects(
    app.integrateChangeSet({
      changeSetId: followUp.id,
      targetRef: 'main',
      workspace: skippedRevision.workspace,
      commandId: 'reject-unrecorded-target-advance'
    }),
    (error) => error.code === 'integration-project-revision-mismatch'
  );
  assert.equal(skippedRevision.state.verifyCalls, 0);
  assert.equal(skippedRevision.state.prepareCalls, 0);
  assert.equal(skippedRevision.state.promoteCalls, 0);

  const otherTarget = fakeIntegrationWorkspace(gitWorkspace);
  await assert.rejects(
    app.integrateChangeSet({
      changeSetId: followUp.id,
      targetRef: 'release',
      workspace: otherTarget.workspace,
      commandId: 'reject-another-goal-target'
    }),
    (error) => error.code === 'integration-goal-target-mismatch'
  );
  assert.equal(otherTarget.state.verifyCalls, 0);
  assert.equal(otherTarget.state.prepareCalls, 0);
  assert.equal(otherTarget.state.promoteCalls, 0);
});

test('a diverged target is a terminal failed attempt and preserves Node acceptance', async (t) => {
  const { app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const race = new Error('Another writer advanced the target first.');
  race.code = 'target-ref-race';
  const diverged = fakeIntegrationWorkspace(gitWorkspace, {
    promoteError: race,
    disposition: 'diverged'
  });
  const result = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: diverged.workspace,
    commandId: 'diverged-is-terminal'
  });

  assert.equal(result.ok, false);
  assert.equal(result.integration.status, 'failed');
  assert.equal(result.integration.failure.code, 'INTEGRATION_TARGET_DIVERGED');
  assert.equal(result.node.status, 'accepted');
  assert.equal(result.node.activeIntegrationId, null);
  assert.equal(result.projectRevision, null);
});

test('reconciliation resolves a proven divergent recovery state as failed', async (t) => {
  const { app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const unavailable = new Error('The promotion result is unavailable.');
  unavailable.code = 'promotion-result-unavailable';
  const inspectionUnavailable = new Error('The target cannot be inspected yet.');
  inspectionUnavailable.code = 'target-inspection-unavailable';
  const uncertain = fakeIntegrationWorkspace(gitWorkspace, {
    promoteError: unavailable,
    inspectError: inspectionUnavailable
  });
  const interrupted = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: uncertain.workspace,
    commandId: 'diverged-recovery-start'
  });
  assert.equal(interrupted.integration.status, 'recovery-required');

  const diverged = fakeIntegrationWorkspace(gitWorkspace, { disposition: 'diverged' });
  const reconciled = await app.reconcileIntegration({
    workspace: diverged.workspace,
    candidateWorkspace: noCandidateWorkspace(),
    correlationId: 'diverged-recovery-finish'
  });
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.integration.status, 'failed');
  assert.equal(reconciled.integration.failure.code, 'INTEGRATION_TARGET_DIVERGED');
  assert.equal(reconciled.node.status, 'accepted');
  assert.equal(diverged.state.promoteCalls, 0);
});

test('reconciliation re-inspects a failed promotion and terminates proven divergence', async (t) => {
  const { app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const projected = await app.getStatus();
  const node = projected.nodes.find(
    (candidate) => candidate.acceptedChangeSetId === changeSet.id
  );
  const run = projected.runs.find((candidate) => candidate.id === changeSet.runId);
  const evidence = projected.evidence.find(
    (candidate) => candidate.id === node.acceptanceEvidenceIds[0]
  );
  const evaluation = projected.evaluations.find(
    (candidate) => candidate.id === evidence.evaluationId
  );
  const store = await app.store.readAll();
  const integrationId = 'integration-reconcile-promotion-race';
  const correlationId = 'inject-prepared-integration';
  let sequence = store.lastSequence;
  const makeEvent = (type, streamId, streamVersion, payload) => createEvent({
    type,
    streamId,
    sequence: ++sequence,
    actor: 'test',
    correlationId,
    payload,
    metadata: { streamVersion }
  });
  const events = [
    makeEvent('IntegrationRequested', `integration:${integrationId}`, 1, {
      integrationId,
      nodeId: node.id,
      runId: run.id,
      changeSetId: changeSet.id,
      evaluationId: evaluation.id,
      evidenceId: evidence.id,
      baseRevision: changeSet.baseRevision,
      headRevision: changeSet.headRevision,
      targetRef: 'refs/heads/main',
      expectedTargetRevision: changeSet.baseRevision,
      strategy: 'exact-base-single-commit'
    }),
    makeEvent('NodeIntegrationRequested', `node:${node.id}`, node.version + 1, {
      integrationId,
      nodeId: node.id,
      changeSetId: changeSet.id
    }),
    makeEvent('IntegrationExecutionStarted', `integration:${integrationId}`, 2, {
      integrationId,
      leaseId: '77777777-7777-4777-8777-777777777777'
    }),
    makeEvent('NodeIntegrationStarted', `node:${node.id}`, node.version + 2, {
      integrationId,
      nodeId: node.id,
      changeSetId: changeSet.id
    }),
    makeEvent('IntegrationPrepared', `integration:${integrationId}`, 3, {
      integrationId,
      candidateRevision: CANDIDATE_REVISION,
      candidateTree: CANDIDATE_TREE
    })
  ];
  await app.store.appendBatch(correlationId, events, {
    expectedLastSequence: store.lastSequence,
    intentHash: 'e'.repeat(64)
  });
  assert.equal(
    (await app.getStatus()).integrations.find(
      (candidate) => candidate.id === integrationId
    ).status,
    'running'
  );

  const promotionRace = new Error('The target moved during reconciliation promotion.');
  promotionRace.code = 'target-ref-race';
  const raced = fakeIntegrationWorkspace(gitWorkspace, {
    promoteError: promotionRace,
    disposition: (_request, inspectCall) => inspectCall === 1 ? 'not-applied' : 'diverged'
  });
  const reconciled = await app.reconcileIntegration({
    workspace: raced.workspace,
    candidateWorkspace: noCandidateWorkspace(),
    correlationId: 'reconcile-promotion-race'
  });

  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.integration.status, 'failed');
  assert.equal(reconciled.integration.failure.code, 'INTEGRATION_TARGET_DIVERGED');
  assert.equal(reconciled.node.status, 'accepted');
  assert.equal(raced.state.promoteCalls, 1);
  assert.equal(raced.state.inspectCalls, 2);
});

test('reconcile fails an owner lost before preparation and prunes its unbound candidate ref', async (t) => {
  const { root, app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const projected = await app.getStatus();
  const node = projected.nodes.find(
    (candidate) => candidate.acceptedChangeSetId === changeSet.id
  );
  const run = projected.runs.find((candidate) => candidate.id === changeSet.runId);
  const evidence = projected.evidence.find(
    (candidate) => candidate.id === node.acceptanceEvidenceIds[0]
  );
  const evaluation = projected.evaluations.find(
    (candidate) => candidate.id === evidence.evaluationId
  );
  const store = await app.store.readAll();
  const integrationId = 'integration-owner-lost-before-preparation';
  const correlationId = 'inject-owner-lost-integration';
  let sequence = store.lastSequence;
  const makeEvent = (type, streamId, streamVersion, payload) => createEvent({
    type,
    streamId,
    sequence: ++sequence,
    actor: 'test',
    correlationId,
    payload,
    metadata: { streamVersion }
  });
  await app.store.appendBatch(correlationId, [
    makeEvent('IntegrationRequested', `integration:${integrationId}`, 1, {
      integrationId,
      nodeId: node.id,
      runId: run.id,
      changeSetId: changeSet.id,
      evaluationId: evaluation.id,
      evidenceId: evidence.id,
      baseRevision: changeSet.baseRevision,
      headRevision: changeSet.headRevision,
      targetRef: 'refs/heads/main',
      expectedTargetRevision: changeSet.baseRevision,
      strategy: 'merge-commit-regression-gated',
      regressionProfileHash: `sha256:${'1'.repeat(64)}`
    }),
    makeEvent('NodeIntegrationRequested', `node:${node.id}`, node.version + 1, {
      integrationId,
      nodeId: node.id,
      changeSetId: changeSet.id
    }),
    makeEvent('IntegrationExecutionStarted', `integration:${integrationId}`, 2, {
      integrationId,
      leaseId: '88888888-8888-4888-8888-888888888888'
    }),
    makeEvent('NodeIntegrationStarted', `node:${node.id}`, node.version + 2, {
      integrationId,
      nodeId: node.id,
      changeSetId: changeSet.id
    })
  ], {
    expectedLastSequence: store.lastSequence,
    intentHash: '8'.repeat(64)
  });

  const candidateWorkspace = new GitIntegrationWorkspaceAdapter(root);
  const candidateRef = `refs/fwa/integrations/${integrationId}/candidate`;
  await git(root, ['update-ref', candidateRef, changeSet.headRevision, '']);
  assert.equal((await candidateWorkspace.inspectResidue()).candidateRefCount, 1);

  const reconciled = await app.reconcileIntegration({
    workspace: fakeIntegrationWorkspace(gitWorkspace).workspace,
    candidateWorkspace,
    correlationId: 'reconcile-owner-lost-integration'
  });
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.reason, 'failed');
  assert.equal(reconciled.integration.status, 'failed');
  assert.equal(
    reconciled.integration.failure.code,
    'INTEGRATION_OWNER_LOST_BEFORE_PREPARATION'
  );
  assert.equal(reconciled.cleanup.candidateWorkspaceRemoved, true);
  assert.equal((await candidateWorkspace.inspectResidue()).candidateRefCount, 0);
  const verification = await app.verify({
    workspace: gitWorkspace,
    candidateWorkspace
  });
  assert.equal(verification.operationallyClean, true);
  assert.deepEqual(verification.orphanCandidateRefs, []);
});

test('a contradictory applied inspection cannot forge integrated state', async (t) => {
  const { app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const contradictory = fakeIntegrationWorkspace(gitWorkspace, {
    disposition: 'applied',
    targetRevision: (request) => request.expectedTargetRevision
  });
  const result = await app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: contradictory.workspace,
    commandId: 'reject-false-applied-inspection'
  });

  assert.equal(result.ok, false);
  assert.equal(result.integration.status, 'recovery-required');
  assert.equal(result.node.status, 'accepted');
  assert.equal(result.node.integrationStatus, 'recovery-required');
  assert.equal(result.projectRevision, null);
  assert.equal(
    (await app.listEvents()).some((event) => event.type === 'IntegrationApplied'),
    false
  );
});

test('a raced idempotent replay reports failure to release its acquired lease', async (t) => {
  const { app, gitWorkspace, changeSet } = await acceptedFixture(t);
  const fake = fakeIntegrationWorkspace(gitWorkspace);
  let acquiredOwnerId = null;
  let signalAcquire;
  let allowAcquire;
  const acquireEntered = new Promise((resolve) => { signalAcquire = resolve; });
  const acquireGate = new Promise((resolve) => { allowAcquire = resolve; });
  const lease = {
    async init() {
      return { held: false, lease: null };
    },
    async inspect() {
      return {
        held: true,
        stale: false,
        lease: {
          leaseId: '66666666-6666-4666-8666-666666666666',
          ownerKind: 'integration',
          ownerId: acquiredOwnerId
        }
      };
    },
    async acquire({ ownerId }) {
      acquiredOwnerId = ownerId;
      signalAcquire();
      await acquireGate;
      return {
        lease: {
          leaseId: '66666666-6666-4666-8666-666666666666',
          ownerKind: 'integration',
          ownerId
        },
        ownerToken: 'temporary-race-owner-token'
      };
    },
    async heartbeat() {
      throw new Error('The raced replay must not start a heartbeat.');
    },
    async release() {
      const error = new Error('Simulated raced lease release failure.');
      error.code = 'simulated-release-failure';
      throw error;
    },
    async archiveStale() {
      throw new Error('The raced replay must not archive a lease.');
    }
  };

  const racedPromise = app.integrateChangeSet({
    changeSetId: changeSet.id,
    targetRef: 'main',
    workspace: fake.workspace,
    lease,
    commandId: 'raced-idempotent-integration'
  });
  await acquireEntered;
  try {
    const winner = await app.integrateChangeSet({
      changeSetId: changeSet.id,
      targetRef: 'main',
      workspace: fake.workspace,
      commandId: 'raced-idempotent-integration'
    });
    assert.equal(winner.ok, true);
  } finally {
    allowAcquire();
  }

  const replay = await racedPromise;
  assert.equal(replay.ok, true);
  assert.equal(replay.appended, false);
  assert.equal(replay.cleanup.leaseReleased, false);
  assert.equal(replay.cleanup.warnings.length, 1);
  assert.equal(replay.cleanup.warnings[0].failure.code, 'simulated-release-failure');
  assert.equal(fake.state.prepareCalls, 1);
  assert.equal(fake.state.promoteCalls, 1);
});
