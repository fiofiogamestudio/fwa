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
import { FwaApplication } from '../src/application/fwa-application.js';
import { projectEvents } from '../src/application/projection.js';
import { createEvent } from '../src/core/events.js';

const INTEGRATED_REVISION = 'a'.repeat(40);
const INTEGRATED_TREE = 'b'.repeat(40);
const REVERT_REVISION = 'd'.repeat(40);
const REVERT_TREE = 'e'.repeat(40);
const ZERO_HASH = `sha256:${'0'.repeat(64)}`;

async function run(executable, arguments_, { cwd } = {}) {
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
      if (status !== 0) {
        reject(new Error(
          `${executable} ${arguments_.join(' ')} exited ${status}: ${result.stderr}`
        ));
        return;
      }
      resolve(result);
    });
  });
}

const git = (cwd, arguments_) => run('git', arguments_, { cwd });

function passingProfile() {
  return {
    schemaVersion: 1,
    id: 'reversion-compile-and-test',
    checks: [{
      id: 'compile',
      kind: 'compile',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 10_000,
      expectedExitCodes: [0]
    }, {
      id: 'unit-tests',
      kind: 'test',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 10_000,
      expectedExitCodes: [0]
    }]
  };
}

function failingProfile() {
  const profile = passingProfile();
  profile.id = 'reversion-regression-fails';
  profile.checks[0].args = ['-e', 'process.exit(9)'];
  return profile;
}

async function fixture(t, {
  logicalRefs = false,
  singleNode = false,
  caseInsensitiveRefs = false
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-reversion-'));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25
  }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Reversion Test']);
  await git(root, ['config', 'user.email', 'fwa-reversion@example.invalid']);
  await git(root, ['config', 'core.ignorecase', caseInsensitiveRefs ? 'true' : 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  await git(root, ['add', '.gitignore', 'seed.txt']);
  await git(root, ['commit', '-m', 'test: establish base']);

  const app = new FwaApplication(root);
  const gitWorkspace = new GitWorktreeAdapter(root);
  await app.init();
  if (logicalRefs) {
    await app.registerRef({
      commandId: 'register-output-ref',
      ref: {
        id: 'ref://code/output',
        kind: 'code',
        uri: caseInsensitiveRefs ? 'Generated/Output.txt' : 'generated/output.txt',
        version: 'initial',
        hash: ZERO_HASH,
        metadata: {}
      }
    });
    await app.registerRef({
      commandId: 'register-other-ref',
      ref: {
        id: 'ref://code/other',
        kind: 'code',
        uri: caseInsensitiveRefs ? 'Generated/Other.txt' : 'generated/other.txt',
        version: 'initial',
        hash: ZERO_HASH,
        metadata: {}
      }
    });
  }
  const goal = await app.createGoal({
    title: 'Revert one accepted change',
    commandId: 'create-reversion-goal'
  });
  const sourceNode = {
    id: 'source',
    dependsOn: [],
    reads: ['seed.txt'],
    writes: logicalRefs
      ? ['ref://code/output', 'ref://code/other']
      : ['generated/**'],
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    acceptance: { checks: ['source-check'] },
    budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 }
  };
  const dependentNodes = singleNode
    ? []
    : logicalRefs
    ? [{
        id: 'consumer-y',
        dependsOn: ['source'],
        reads: ['ref://code/other'],
        writes: ['consumer-y/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['consumer-y-check'] },
        budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 }
      }, {
        id: 'consumer-x',
        dependsOn: ['source'],
        reads: ['ref://code/output'],
        writes: ['consumer-x/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['consumer-x-check'] },
        budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 }
      }, {
        id: 'downstream-x',
        dependsOn: ['consumer-x'],
        reads: ['consumer-x/**'],
        writes: ['downstream-x/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['downstream-x-check'] },
        budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 }
      }]
    : [{
        id: 'consumer',
        dependsOn: ['source'],
        reads: ['generated/**'],
        writes: ['consumer/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['consumer-check'] },
        budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 }
      }];
  await app.loadPlan({
    goalId: goal.goal.id,
    commandId: 'load-reversion-plan',
    plan: {
      schemaVersion: 1,
      nodes: [sourceNode, ...dependentNodes]
    }
  });
  const produced = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: gitWorkspace,
    input: {
      schemaVersion: 1,
      operations: [{ type: 'write', path: 'generated/output.txt', content: 'ok\n' }]
    },
    commandId: 'produce-source'
  });
  assert.equal(produced.ok, true, JSON.stringify(produced.run ?? produced, null, 2));
  const evaluator = new CommandEvaluator({ env: {} });
  const evaluated = await app.evaluateChangeSet({
    changeSetId: produced.changeSet.id,
    profile: {
      schemaVersion: 1,
      id: 'source-evaluation',
      checks: [{
        id: 'source-check',
        kind: 'test',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 10_000,
        expectedExitCodes: [0]
      }]
    },
    evaluator,
    workspace: gitWorkspace,
    commandId: 'evaluate-source'
  });
  assert.equal(evaluated.ok, true);

  const exactWorkspace = {
    verifyChangeSet: (changeSet) => gitWorkspace.verifyChangeSet(changeSet),
    async prepare(request) {
      return {
        ...request,
        candidateRevision: INTEGRATED_REVISION,
        candidateTree: INTEGRATED_TREE
      };
    },
    async promote(request) {
      return { ...request, targetRevision: request.candidateRevision };
    },
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
    changeSetId: produced.changeSet.id,
    targetRef: 'main',
    workspace: exactWorkspace,
    commandId: 'integrate-source'
  });
  assert.equal(integrated.ok, true);
  return { root, app, gitWorkspace, evaluator, sourceChangeSet: produced.changeSet };
}

function reversionPorts(root, gitWorkspace) {
  const candidateWorkspace = {
    prepareCalls: 0,
    cleanupCalls: 0,
    async prepareRevert(request) {
      this.prepareCalls += 1;
      return {
        disposition: 'prepared',
        kind: 'revert',
        integrationId: request.integrationId,
        targetRef: request.targetRef,
        expectedTargetRevision: request.expectedTargetRevision,
        revertedRevision: request.revertedRevision,
        mainline: null,
        workspacePath: path.join(root, '.fwa', 'integrations', request.integrationId),
        candidateRef: `refs/fwa/integrations/${request.integrationId}/candidate`,
        candidateRevision: REVERT_REVISION,
        candidateTree: REVERT_TREE,
        parents: [request.expectedTargetRevision],
        conflicts: [],
        changedFiles: ['generated/output.txt'],
        changes: [{ status: 'deleted', code: 'D', path: 'generated/output.txt' }],
        patch: 'diff --git a/generated/output.txt b/generated/output.txt\n'
      };
    },
    async cleanup() {
      this.cleanupCalls += 1;
      return { removed: true, alreadyAbsent: false };
    }
  };
  const promotion = {
    promoteCalls: 0,
    inspectCalls: 0,
    verifyChangeSet: (changeSet) => gitWorkspace.verifyChangeSet(changeSet),
    async promotePrepared() {
      this.promoteCalls += 1;
    },
    async inspectPrepared(request) {
      this.inspectCalls += 1;
      return {
        disposition: 'applied',
        ...request,
        targetRevision: request.candidateRevision,
        observedTargetRevision: request.candidateRevision,
        containsCandidate: true
      };
    }
  };
  const evaluationWorkspace = {
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
    async removeEvaluation() {
      return { removed: true, alreadyAbsent: false };
    }
  };
  return { candidateWorkspace, promotion, evaluationWorkspace };
}

test('revert preserves history without staling dependants that never ran', async (t) => {
  const { root, app, gitWorkspace, evaluator, sourceChangeSet } = await fixture(t);
  const ports = reversionPorts(root, gitWorkspace);
  const before = await app.getStatus();
  const result = await app.revertChangeSet({
    changeSetId: sourceChangeSet.id,
    targetRef: 'main',
    candidateWorkspace: ports.candidateWorkspace,
    promotion: ports.promotion,
    evaluator,
    profile: passingProfile(),
    evaluationWorkspace: ports.evaluationWorkspace,
    commandId: 'revert-source'
  });

  assert.equal(result.ok, true, JSON.stringify(result.reversion, null, 2));
  assert.equal(result.reversion.status, 'reverted');
  assert.equal(result.revertChangeSet.kind, 'revert');
  assert.equal(result.revertChangeSet.revertsChangeSetId, sourceChangeSet.id);
  assert.equal(result.revertChangeSet.headRevision, REVERT_REVISION);
  assert.deepEqual(result.reversion.affectedNodeIds, []);
  assert.deepEqual(result.reversion.recomputeRootNodeIds, []);
  assert.equal(result.cleanup.leaseReleased, true);
  assert.equal(result.cleanup.candidateWorkspaceRemoved, true);

  const status = await app.getStatus();
  const source = status.nodes.find((node) => node.id === 'source');
  const consumer = status.nodes.find((node) => node.id === 'consumer');
  assert.equal(source.status, 'accepted');
  assert.equal(source.validity, 'invalid');
  assert.equal(source.integrationStatus, 'reverted');
  assert.equal(consumer.status, 'ready');
  assert.equal(consumer.validity, 'valid');
  assert.equal(status.runs.length, before.runs.length);
  assert.equal(status.evidence.length, before.evidence.length);
  assert.equal(status.changeSets.length, before.changeSets.length + 1);
  assert.equal(status.projectRevisions.length, 2);
  assert.equal(
    status.changeSets.find((changeSet) => changeSet.id === sourceChangeSet.id)
      .revertedByChangeSetId,
    result.revertChangeSet.id
  );

  const replay = await app.revertChangeSet({
    changeSetId: sourceChangeSet.id,
    targetRef: 'main',
    candidateWorkspace: ports.candidateWorkspace,
    promotion: ports.promotion,
    evaluator,
    profile: passingProfile(),
    evaluationWorkspace: ports.evaluationWorkspace,
    commandId: 'revert-source'
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.appended, false);
  assert.equal(ports.candidateWorkspace.prepareCalls, 1);
  assert.equal(ports.promotion.promoteCalls, 1);
});

test('a failed Reversion remains historical after a later retry succeeds', async (t) => {
  const { root, app, gitWorkspace, evaluator, sourceChangeSet } = await fixture(t, {
    singleNode: true
  });
  const ports = reversionPorts(root, gitWorkspace);
  const failed = await app.revertChangeSet({
    changeSetId: sourceChangeSet.id,
    targetRef: 'main',
    candidateWorkspace: ports.candidateWorkspace,
    promotion: ports.promotion,
    evaluator,
    profile: failingProfile(),
    evaluationWorkspace: ports.evaluationWorkspace,
    commandId: 'revert-source-fails-regression'
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reversion.status, 'failed');

  const retried = await app.revertChangeSet({
    changeSetId: sourceChangeSet.id,
    targetRef: 'main',
    candidateWorkspace: ports.candidateWorkspace,
    promotion: ports.promotion,
    evaluator,
    profile: passingProfile(),
    evaluationWorkspace: ports.evaluationWorkspace,
    commandId: 'revert-source-retry-succeeds'
  });
  assert.equal(retried.ok, true, JSON.stringify(retried.reversion, null, 2));
  assert.equal(retried.reversion.status, 'reverted');
  assert.notEqual(retried.reversion.id, failed.reversion.id);

  const status = await app.getStatus();
  assert.equal(status.reversions.length, 2);
  assert.equal(status.reversions.find((item) => item.id === failed.reversion.id).status, 'failed');
  assert.equal(
    status.reversions.find((item) => item.id === retried.reversion.id).status,
    'reverted'
  );
  assert.equal(status.integrations[0].revertedByReversionId, retried.reversion.id);
});

test('legacy revert conservatively stales an already-materialized DAG dependant', async (t) => {
  const { root, app, gitWorkspace, evaluator, sourceChangeSet } = await fixture(t);
  const producedConsumer = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: gitWorkspace,
    input: {
      schemaVersion: 1,
      operations: [{ type: 'write', path: 'consumer/output.txt', content: 'observed\n' }]
    },
    commandId: 'produce-legacy-consumer'
  });
  assert.equal(producedConsumer.ok, true, JSON.stringify(producedConsumer, null, 2));
  assert.equal(producedConsumer.node.id, 'consumer');
  const acceptedConsumer = await app.evaluateChangeSet({
    changeSetId: producedConsumer.changeSet.id,
    profile: {
      schemaVersion: 1,
      id: 'legacy-consumer-evaluation',
      checks: [{
        id: 'consumer-check',
        kind: 'test',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 10_000,
        expectedExitCodes: [0]
      }]
    },
    evaluator,
    workspace: gitWorkspace,
    commandId: 'evaluate-legacy-consumer'
  });
  assert.equal(acceptedConsumer.ok, true, JSON.stringify(acceptedConsumer, null, 2));

  const ports = reversionPorts(root, gitWorkspace);
  const result = await app.revertChangeSet({
    changeSetId: sourceChangeSet.id,
    targetRef: 'main',
    candidateWorkspace: ports.candidateWorkspace,
    promotion: ports.promotion,
    evaluator,
    profile: passingProfile(),
    evaluationWorkspace: ports.evaluationWorkspace,
    commandId: 'revert-source-with-legacy-consumer'
  });

  assert.equal(result.ok, true, JSON.stringify(result.reversion, null, 2));
  assert.deepEqual(result.reversion.affectedNodeIds, ['consumer']);
  assert.deepEqual(result.reversion.recomputeRootNodeIds, ['consumer']);
  const status = await app.getStatus();
  const consumer = status.nodes.find((node) => node.id === 'consumer');
  assert.equal(consumer.status, 'accepted');
  assert.equal(consumer.validity, 'stale');
  assert.deepEqual(consumer.staleByReversionIds, [result.reversion.id]);
});

test('logical Ref versions advance and revert invalidates only its consumers', async (t) => {
  const { root, app, gitWorkspace, evaluator, sourceChangeSet } = await fixture(t, {
    logicalRefs: true
  });
  assert.deepEqual(sourceChangeSet.changedRefIds, ['ref://code/output']);
  const afterIntegration = await app.getStatus();
  assert.equal(
    afterIntegration.refs.find((ref) => ref.id === 'ref://code/output').version,
    INTEGRATED_REVISION
  );
  assert.equal(
    afterIntegration.refs.find((ref) => ref.id === 'ref://code/other').version,
    'initial'
  );

  const ports = reversionPorts(root, gitWorkspace);
  const result = await app.revertChangeSet({
    changeSetId: sourceChangeSet.id,
    targetRef: 'main',
    candidateWorkspace: ports.candidateWorkspace,
    promotion: ports.promotion,
    evaluator,
    profile: passingProfile(),
    evaluationWorkspace: ports.evaluationWorkspace,
    commandId: 'revert-logical-source'
  });
  assert.equal(result.ok, true, JSON.stringify(result.reversion, null, 2));
  assert.deepEqual(result.reversion.affectedNodeIds, []);
  assert.deepEqual(result.reversion.recomputeRootNodeIds, []);

  const status = await app.getStatus();
  assert.equal(status.nodes.find((node) => node.id === 'consumer-y').validity, 'valid');
  assert.equal(status.nodes.find((node) => node.id === 'consumer-x').validity, 'valid');
  assert.equal(status.nodes.find((node) => node.id === 'downstream-x').validity, 'valid');
  const outputRef = status.refs.find((ref) => ref.id === 'ref://code/output');
  assert.equal(outputRef.version, REVERT_REVISION);
  assert.equal(outputRef.lastReversionId, result.reversion.id);
  assert.equal(status.refs.find((ref) => ref.id === 'ref://code/other').version, 'initial');
});

test('case-insensitive Git policy binds Ref effects through Integration and Reversion', async (t) => {
  const { root, app, gitWorkspace, evaluator, sourceChangeSet } = await fixture(t, {
    logicalRefs: true,
    caseInsensitiveRefs: true
  });
  assert.equal(sourceChangeSet.coreIgnoreCase, true);
  assert.deepEqual(sourceChangeSet.changedRefIds, ['ref://code/output']);
  const afterIntegration = await app.getStatus();
  assert.equal(
    afterIntegration.refs.find((ref) => ref.id === 'ref://code/output').version,
    INTEGRATED_REVISION
  );

  const ports = reversionPorts(root, gitWorkspace);
  const reverted = await app.revertChangeSet({
    changeSetId: sourceChangeSet.id,
    targetRef: 'main',
    candidateWorkspace: ports.candidateWorkspace,
    promotion: ports.promotion,
    evaluator,
    profile: passingProfile(),
    evaluationWorkspace: ports.evaluationWorkspace,
    commandId: 'revert-case-insensitive-ref'
  });
  assert.equal(reverted.ok, true, JSON.stringify(reverted.reversion, null, 2));
  assert.deepEqual(reverted.reversion.changedRefIds, ['ref://code/output']);
  assert.deepEqual(reverted.revertChangeSet.changedRefIds, ['ref://code/output']);
  const status = await app.getStatus();
  assert.equal(
    status.refs.find((ref) => ref.id === 'ref://code/output').version,
    REVERT_REVISION
  );
});

test('derived Ref and stale events require the physical apply chain and exact digest contract', async (t) => {
  const { root, app, gitWorkspace, evaluator, sourceChangeSet } = await fixture(t, {
    logicalRefs: true
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = (await app.getStatus()).nodes.find((node) => node.status === 'ready');
    assert.ok(next);
    const produced = await app.runNext({
      executor: new FileOperationsExecutor(),
      workspace: gitWorkspace,
      input: {
        schemaVersion: 1,
        operations: [{
          type: 'write',
          path: `${next.id}/output.txt`,
          content: `${next.id}\n`
        }]
      },
      commandId: `materialize-${next.id}`
    });
    assert.equal(produced.ok, true, JSON.stringify(produced, null, 2));
    if (next.id === 'consumer-x') break;
  }
  assert.equal(
    (await app.getStatus()).nodes.find((node) => node.id === 'consumer-x').status,
    'produced'
  );

  const ports = reversionPorts(root, gitWorkspace);
  const reverted = await app.revertChangeSet({
    changeSetId: sourceChangeSet.id,
    targetRef: 'main',
    candidateWorkspace: ports.candidateWorkspace,
    promotion: ports.promotion,
    evaluator,
    profile: passingProfile(),
    evaluationWorkspace: ports.evaluationWorkspace,
    commandId: 'revert-source-for-derived-event-tamper'
  });
  assert.equal(reverted.ok, true, JSON.stringify(reverted.reversion, null, 2));
  assert.deepEqual(reverted.reversion.affectedNodeIds, ['consumer-x']);

  const events = (await app.store.readAll()).events;
  assert.doesNotThrow(() => projectEvents(events));
  const advanced = events.find((item) => item.type === 'RefVersionAdvanced');
  const refReverted = events.find((item) => item.type === 'RefVersionReverted');
  const stale = events.find((item) => item.type === 'NodeMarkedStale');
  const integrationEffects = events.find((item) => item.type === 'IntegrationEffectsApplied');
  const reversionApplied = events.find((item) => item.type === 'ReversionApplied');
  assert.ok(advanced);
  assert.ok(refReverted);
  assert.ok(stale);
  assert.ok(integrationEffects);
  assert.ok(reversionApplied);

  const replacePayload = (source, payload) => createEvent({
    ...source,
    payload
  }, { idFactory: () => source.eventId });
  const resequence = (source, sequence) => createEvent({
    ...source,
    sequence
  }, { idFactory: () => source.eventId });
  const replaceEvent = (source, replacement) => events.map((item) => (
    item.eventId === source.eventId ? replacement : item
  ));

  assert.throws(
    () => projectEvents(events.slice(0, events.indexOf(integrationEffects))),
    (error) => error.code === 'incomplete-integration-projection'
  );
  assert.throws(
    () => projectEvents(events.slice(0, events.indexOf(reversionApplied))),
    (error) => error.code === 'incomplete-reversion-projection'
  );

  for (const [source, payload] of [
    [advanced, { ...advanced.payload, version: 'forged-version' }],
    [advanced, { ...advanced.payload, hash: `sha256:${'f'.repeat(64)}` }],
    [advanced, { ...advanced.payload, changedFiles: [] }],
    [refReverted, { ...refReverted.payload, version: 'forged-version' }],
    [refReverted, { ...refReverted.payload, hash: `sha256:${'f'.repeat(64)}` }],
    [refReverted, { ...refReverted.payload, changedFiles: [] }]
  ]) {
    assert.throws(
      () => projectEvents(replaceEvent(source, replacePayload(source, payload))),
      (error) => error.code === 'ref-version-binding-mismatch'
    );
  }

  const integrationApplyIndex = events.findIndex((item) => (
    item.type === 'ProjectRevisionAdvanced'
  ));
  const beforeIntegrationApply = events.slice(0, integrationApplyIndex);
  assert.throws(
    () => projectEvents([
      ...beforeIntegrationApply,
      resequence(advanced, beforeIntegrationApply.length + 1)
    ]),
    (error) => error.code === 'ref-version-binding-mismatch'
  );

  const reversionApplyIndex = events.findIndex((item) => (
    item.type === 'ProjectRevisionReverted'
  ));
  const beforeReversionApply = events.slice(0, reversionApplyIndex);
  for (const derived of [refReverted, stale]) {
    assert.throws(
      () => projectEvents([
        ...beforeReversionApply,
        resequence(derived, beforeReversionApply.length + 1)
      ]),
      (error) => [
        'ref-version-binding-mismatch',
        'reversion-binding-mismatch'
      ].includes(error.code)
    );
  }

  for (const derived of [advanced, refReverted, stale]) {
    const currentStreamVersion = events
      .filter((item) => item.streamId === derived.streamId)
      .at(-1).metadata.streamVersion;
    const delayed = createEvent({
      ...derived,
      sequence: events.length + 1,
      metadata: {
        ...derived.metadata,
        streamVersion: currentStreamVersion + 1
      }
    }, { idFactory: () => `delayed-${derived.eventId}` });
    assert.throws(
      () => projectEvents([...events, delayed]),
      (error) => [
        'ref-version-binding-mismatch',
        'reversion-binding-mismatch',
        'integration-invalidation-binding-mismatch'
      ].includes(error.code)
    );
  }
});

test('reverting a completed Goal reopens it without deleting accepted history', async (t) => {
  const { root, app, gitWorkspace, evaluator, sourceChangeSet } = await fixture(t, {
    singleNode: true
  });
  assert.equal((await app.getStatus()).goals[0].status, 'completed');
  const ports = reversionPorts(root, gitWorkspace);
  const result = await app.revertChangeSet({
    changeSetId: sourceChangeSet.id,
    targetRef: 'main',
    candidateWorkspace: ports.candidateWorkspace,
    promotion: ports.promotion,
    evaluator,
    profile: passingProfile(),
    evaluationWorkspace: ports.evaluationWorkspace,
    commandId: 'revert-completed-goal'
  });
  assert.equal(result.ok, true, JSON.stringify(result.reversion, null, 2));
  assert.deepEqual(result.reversion.affectedNodeIds, []);
  const status = await app.getStatus();
  assert.equal(status.goals[0].status, 'active');
  assert.equal(status.nodes[0].status, 'accepted');
  assert.equal(status.nodes[0].validity, 'invalid');
  assert.equal(status.evidence.length, 1);
  assert.ok((await app.listEvents()).some((event) => event.type === 'GoalReopened'));
});
