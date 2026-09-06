import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import { FILE_OPERATIONS_CAPABILITY, FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { projectEvents } from '../src/application/projection.js';
import { createEvent } from '../src/core/events.js';
import { areNodeDependenciesSatisfied, isNodeSchedulable, nodeRetryEligibility } from '../src/core/scheduling.js';

const execute = promisify(execFile);
const git = (cwd, args) => execute('git', args, { cwd, windowsHide: true, timeout: 30_000 });
const profile = (fail = false, regression = false) => ({
  schemaVersion: 1, id: 'retry-checks', checks: (regression ? ['compile', 'test'] : ['test']).map((kind) => ({
    id: kind, kind, command: process.execPath, args: ['-e', `process.exit(${fail ? 7 : 0})`],
    timeoutMs: 10_000, expectedExitCodes: [0]
  }))
});

async function fixture(t, { maxRetries = 1, child = false, refs = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-node-retry-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Retry Test']);
  await git(root, ['config', 'user.email', 'retry@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'test: initial']);
  const app = new FwaApplication(root);
  await app.init();
  if (refs) await app.registerRef({ commandId: 'register-ref', ref: {
    id: 'ref://code/source', kind: 'code', uri: 'source.txt', version: 'initial',
    hash: `sha256:${'0'.repeat(64)}`, metadata: {}
  } });
  const goal = (await app.createGoal({ title: 'Retry and recompute', commandId: 'goal' })).goal;
  const node = (id, dependsOn) => ({
    id, dependsOn, reads: id === 'child' && refs ? ['ref://code/source'] : ['seed.txt'],
    writes: id === 'source' && refs ? ['ref://code/source'] : [`${id}.txt`],
    capabilities: [FILE_OPERATIONS_CAPABILITY], acceptance: { checks: ['test'] },
    budget: { maxRetries, maxFiles: 2, maxDiffLines: 50 }
  });
  await app.loadPlan({ goalId: goal.id, commandId: 'plan',
    plan: { schemaVersion: 1, nodes: [node('source', []), ...(child ? [node('child', ['source'])] : [])] } });
  const workspace = new GitWorktreeAdapter(root);
  const promotion = new GitIntegrationAdapter(root);
  const candidateWorkspace = new GitIntegrationWorkspaceAdapter(root);
  const evaluator = new CommandEvaluator();
  const produce = async (nodeId, content, commandId) => app.runNext({
    nodeId, executor: new FileOperationsExecutor(), workspace, commandId,
    input: { schemaVersion: 1, operations: [{ type: 'write', path: `${nodeId}.txt`, content }] }
  });
  const evaluate = (changeSetId, commandId, fail = false) => app.evaluateChangeSet({
    changeSetId, commandId, profile: profile(fail), evaluator, workspace
  });
  const integrate = (changeSetId, commandId) => app.integrateChangeSet({
    changeSetId, commandId, targetRef: 'main', workspace: promotion
  });
  const revert = (changeSetId, commandId) => app.revertChangeSet({
    changeSetId, commandId, targetRef: 'main', candidateWorkspace, promotion,
    evaluator, profile: profile(false, true), evaluationWorkspace: workspace
  });
  return { root, app, workspace, promotion, candidateWorkspace, goal, produce, evaluate, integrate, revert };
}

function appendEvent(events, type, node, payload, streamId = `node:${node.id}`) {
  const version = events.filter((event) => event.streamId === streamId).length + 1;
  return [...events, createEvent({ type, streamId, sequence: events.length + 1,
    occurredAt: '2026-09-06T00:00:00.000Z', correlationId: 'forged', payload,
    metadata: { streamVersion: version } })];
}

test('rejected output retries as a new Run while preserving evidence and enforcing idempotency, lease and budget', async (t) => {
  const f = await fixture(t);
  const first = await f.produce('source', 'first\n', 'run-first');
  assert.equal(first.ok, true);
  const rejection = await f.evaluate(first.changeSet.id, 'reject-first', true);
  assert.equal(rejection.node.status, 'rejected');
  const original = await f.app.getStatus();
  const rejectedEvents = await f.app.listEvents();
  const node = original.nodes[0];
  const retryPayload = { nodeId: node.id, goalId: node.goalId, planId: node.planId,
    previousRunId: node.runIds.at(-1), mode: 'retry', reason: 'Correct rejected output' };
  assert.throws(() => projectEvents(appendEvent(rejectedEvents, 'NodeRetryRequested', node,
    { ...retryPayload, previousRunId: 'wrong-run' })), { code: 'node-retry-binding-mismatch' });
  assert.throws(() => projectEvents(appendEvent(rejectedEvents, 'NodeReady', node,
    { nodeId: node.id, goalId: node.goalId, planId: node.planId, reason: 'retry' })), { code: 'node-not-ready' });
  await assert.rejects(f.app.retryNode({ nodeId: 'missing' }), { code: 'node-not-found' });
  await assert.rejects(f.app.retryNode({ nodeId: node.id, reason: '' }), { code: 'invalid-command' });
  await assert.rejects(f.app.retryNode({ nodeId: node.id, commandId: '@fwa/reserved' }), { code: 'reserved-command-id' });
  const held = await f.app.lease.acquire({ runId: 'another-reservation', ttlMs: 30_000 });
  await assert.rejects(f.app.retryNode({ nodeId: node.id }), { code: 'workspace-lease-held' });
  await f.app.lease.release({ leaseId: held.lease.leaseId, ownerToken: held.ownerToken });
  const command = { nodeId: node.id, commandId: 'retry-source', reason: retryPayload.reason };
  const appendBatch = f.app.store.appendBatch.bind(f.app.store);
  let concurrentWrite = false;
  f.app.store.appendBatch = async (...args) => {
    if (args[0] === command.commandId && !concurrentWrite) {
      concurrentWrite = true;
      await f.app.createGoal({ title: 'Concurrent metadata', commandId: 'concurrent-goal' });
    }
    return appendBatch(...args);
  };
  const queued = await f.app.retryNode(command);
  f.app.store.appendBatch = appendBatch;
  assert.equal(concurrentWrite, true);
  assert.equal(queued.mode, 'retry');
  assert.equal(queued.node.status, 'ready');
  assert.equal(queued.node.acceptedChangeSetId, null);
  assert.equal(queued.node.runIds.length, 1);
  assert.equal((await f.app.retryNode(command)).appended, false);
  await assert.rejects(f.app.retryNode({ ...command, reason: 'Different intent' }), { code: 'idempotency-conflict' });
  await assert.rejects(f.app.retryNode({ nodeId: node.id }), { code: 'node-not-retryable' });
  assert.deepEqual((await f.app.getStatus()).evidence, original.evidence);
  const second = await f.produce('source', 'corrected\n', 'run-corrected');
  assert.equal(second.ok, true);
  assert.notEqual(second.run.id, first.run.id);
  assert.equal((await f.evaluate(second.changeSet.id, 'accept-corrected')).ok, true);
  assert.equal((await f.app.retryNode(command)).appended, false);
  await assert.rejects(f.app.evaluateChangeSet({ changeSetId: first.changeSet.id,
    commandId: 'reevaluate-old', profile: profile(), evaluator: new CommandEvaluator(), workspace: f.workspace }),
  { code: 'changeset-not-evaluable' });
  assert.equal((await f.integrate(second.changeSet.id, 'integrate-corrected')).ok, true);
  assert.equal((await f.revert(second.changeSet.id, 'revert-corrected')).ok, true);
  await assert.rejects(f.app.retryNode({ nodeId: 'source' }), { code: 'node-retry-budget-exhausted' });
  const status = await f.app.getStatus();
  const exhausted = status.nodes.find((item) => item.id === 'source');
  const exhaustedEvents = await f.app.listEvents();
  assert.throws(() => projectEvents(appendEvent(exhaustedEvents, 'NodeRetryRequested', exhausted,
    { ...retryPayload, previousRunId: exhausted.runIds.at(-1), mode: 'recompute' })), { code: 'node-retry-budget-exhausted' });
  assert.equal(status.runs.length, 2);
  assert.deepEqual(status.evidence.find((record) => record.id === rejection.evidence.id), original.evidence[0]);
  assert.equal((await f.app.verify({ workspace: f.workspace, integration: f.promotion,
    candidateWorkspace: f.candidateWorkspace })).operationallyClean, true);
});

test('reverting a parent blocks requested and automatic child dispatch and forged RunCreated replay', async (t) => {
  const f = await fixture(t, { child: true });
  const source = await f.produce('source', 'initial\n', 'source-run');
  assert.equal((await f.evaluate(source.changeSet.id, 'source-accept')).ok, true);
  assert.equal((await f.integrate(source.changeSet.id, 'source-integrate')).ok, true);
  assert.equal((await f.revert(source.changeSet.id, 'source-revert')).ok, true);
  const before = await f.app.getStatus();
  const child = before.nodes.find((item) => item.id === 'child');
  assert.equal(child.status, 'ready');
  assert.equal(child.validity, 'valid');
  await assert.rejects(f.produce('child', 'bad\n', 'blocked-child'), { code: 'node-not-ready' });
  await assert.rejects(f.app.runNext({ executor: new FileOperationsExecutor(), workspace: f.workspace,
    commandId: 'blocked-auto', input: { schemaVersion: 1, operations: [] } }), { code: 'no-ready-node' });
  const events = await f.app.listEvents();
  const runPayload = events.find((event) => event.type === 'RunCreated').payload;
  assert.throws(() => projectEvents(appendEvent(events, 'RunCreated', child,
    { ...runPayload, nodeId: child.id, runId: 'forged-run' }, 'run:forged-run')), { code: 'node-not-ready' });
  assert.equal((await f.app.getStatus()).eventCount, before.eventCount);
  const retry = await f.app.retryNode({ nodeId: 'source', commandId: 'recompute-source' });
  assert.equal(retry.mode, 'recompute');
  assert.equal(retry.node.acceptedChangeSetId, null);
  assert.equal(retry.node.integratedChangeSetId, null);
  const newSource = await f.produce('source', 'recomputed\n', 'new-source-run');
  assert.equal(newSource.ok, true);
  assert.equal((await f.evaluate(newSource.changeSet.id, 'new-source-accept')).ok, true);
  assert.equal((await f.integrate(newSource.changeSet.id, 'new-source-integrate')).ok, true);
  const producedChild = await f.produce('child', 'allowed\n', 'allowed-child');
  assert.equal(producedChild.ok, true);
  assert.equal((await f.app.verify({ workspace: f.workspace, integration: f.promotion,
    candidateWorkspace: f.candidateWorkspace })).operationallyClean, true);
});

for (const integrateChild of [false, true]) {
  test(`Ref-aware recompute replaces ${integrateChild ? 'integrated' : 'produced'} stale output without reviving old acceptance`, async (t) => {
    const f = await fixture(t, { child: true, refs: true });
    const source = await f.produce('source', 'v1\n', 'source-v1');
    assert.equal((await f.evaluate(source.changeSet.id, 'source-v1-accept')).ok, true);
    assert.equal((await f.integrate(source.changeSet.id, 'source-v1-integrate')).ok, true);
    const child = await f.produce('child', 'derived-v1\n', 'child-v1');
    if (integrateChild) {
      assert.equal((await f.evaluate(child.changeSet.id, 'child-v1-accept')).ok, true);
      assert.equal((await f.integrate(child.changeSet.id, 'child-v1-integrate')).ok, true);
      assert.equal((await f.app.getStatus()).goals[0].status, 'completed');
    }
    assert.equal((await f.revert(source.changeSet.id, 'source-v1-revert')).ok, true);
    assert.equal((await f.app.getStatus()).goals[0].status, 'active');
    assert.equal((await f.app.getStatus()).nodes.find((item) => item.id === 'child').validity, 'stale');
    await assert.rejects(f.app.retryNode({ nodeId: 'child' }), { code: 'node-dependencies-unsatisfied' });
    await f.app.retryNode({ nodeId: 'source', commandId: 'source-recompute' });
    const sourceV2 = await f.produce('source', 'v2\n', 'source-v2');
    assert.equal((await f.evaluate(sourceV2.changeSet.id, 'source-v2-accept')).ok, true);
    assert.equal((await f.integrate(sourceV2.changeSet.id, 'source-v2-integrate')).ok, true);
    const queued = await f.app.retryNode({ nodeId: 'child', commandId: 'child-recompute' });
    assert.equal(queued.mode, 'recompute');
    assert.equal(queued.node.acceptedChangeSetId, null);
    assert.equal(queued.node.integrationStatus, null);
    const latestRef = (await f.app.getStatus()).refs[0];
    const childV2 = await f.produce('child', 'derived-v2\n', 'child-v2');
    assert.equal(childV2.ok, true);
    assert.equal(childV2.run.effects.consumedRefs[0].version, latestRef.version);
    assert.notEqual(childV2.run.effects.consumedRefs[0].version, child.run.effects.consumedRefs[0].version);
    assert.equal((await f.evaluate(childV2.changeSet.id, 'child-v2-accept')).ok, true);
    assert.equal((await f.integrate(childV2.changeSet.id, 'child-v2-integrate')).ok, true);
    const status = await f.app.getStatus();
    assert.equal(status.goals[0].status, 'completed');
    assert.equal(status.runs.length, 4);
    assert.equal(status.nodes.find((item) => item.id === 'child').acceptedChangeSetId, childV2.changeSet.id);
    assert.equal((await f.app.verify({ workspace: f.workspace, integration: f.promotion,
      candidateWorkspace: f.candidateWorkspace })).operationallyClean, true);
  });
}

test('shared scheduling requires current accepted, valid, same-target integrated dependencies', () => {
  const goal = { status: 'active', integrationTargetRef: 'refs/heads/main' };
  const parent = { id: 'p', status: 'accepted', validity: 'valid', integrationStatus: 'integrated',
    acceptedChangeSetId: 'cs', integratedChangeSetId: 'cs', integratedTargetRef: goal.integrationTargetRef };
  const node = { id: 'n', dependsOn: ['p'], status: 'ready', validity: 'valid' };
  assert.equal(isNodeSchedulable(node, [parent], goal), true);
  for (const mutation of [{ status: 'produced' }, { validity: 'invalid' }, { validity: 'stale' },
    { integrationStatus: 'reverted' }, { integratedChangeSetId: 'other' },
    { integratedTargetRef: 'refs/heads/release' }]) {
    assert.equal(areNodeDependenciesSatisfied(node, [{ ...parent, ...mutation }], goal), false);
  }
  assert.equal(isNodeSchedulable(node, [parent], { ...goal, status: 'completed' }), false);
  const rejected = { ...node, status: 'rejected', runIds: ['r1'], budget: { maxRetries: 0 } };
  assert.deepEqual(nodeRetryEligibility(rejected, [parent], goal), { ok: false, code: 'node-retry-budget-exhausted' });
});

test('retry refuses unfinished evaluation cleanup until reconciliation settles it', async (t) => {
  const f = await fixture(t);
  const output = await f.produce('source', 'candidate\n', 'run-source');
  const cleanupFailure = {
    verifyChangeSet: (...args) => f.workspace.verifyChangeSet(...args),
    createEvaluation: (...args) => f.workspace.createEvaluation(...args),
    inspectEvaluation: (...args) => f.workspace.inspectEvaluation(...args),
    async removeEvaluation() { throw Object.assign(new Error('Injected cleanup failure'), { code: 'TEST_CLEANUP_FAILED' }); }
  };
  const rejected = await f.app.evaluateChangeSet({ changeSetId: output.changeSet.id,
    commandId: 'reject-cleanup-failure', profile: profile(true), evaluator: new CommandEvaluator(), workspace: cleanupFailure });
  assert.equal(rejected.node.status, 'rejected');
  await assert.rejects(f.app.retryNode({ nodeId: 'source', commandId: 'retry-unsettled' }),
    { code: 'node-workspace-not-settled' });
  const status = await f.app.getStatus();
  const node = status.nodes.find((item) => item.id === 'source');
  const events = await f.app.listEvents();
  assert.throws(() => projectEvents(appendEvent(events, 'NodeRetryRequested', node,
    { nodeId: node.id, goalId: node.goalId, planId: node.planId, previousRunId: node.runIds.at(-1),
      mode: 'retry', reason: null })), { code: 'node-workspace-not-settled' });
  await f.app.reconcileEvaluation({ workspace: f.workspace });
  assert.equal((await f.app.retryNode({ nodeId: 'source', commandId: 'retry-settled' })).appended, true);
});

for (const failurePhase of ['create', 'capture']) {
  test(`unconfirmed Git ${failurePhase} plus failed fence persistence blocks dispatch and run reconciliation`, async (t) => {
    const f = await fixture(t);
    let removalCalls = 0;
    const failure = Object.assign(new Error('Injected unconfirmed process and fence-write failure'), {
      code: 'git-process-termination-unconfirmed', details: { terminationConfirmed: false, fencePersisted: false, pid: 999999 }
    });
    const workspace = {
      inspect: (...args) => f.workspace.inspect(...args),
      create: (...args) => failurePhase === 'create' ? Promise.reject(failure) : f.workspace.create(...args),
      capture: (...args) => failurePhase === 'capture' ? Promise.reject(failure) : f.workspace.capture(...args),
      async remove(...args) { removalCalls += 1; return f.workspace.remove(...args); }
    };
    const result = await f.app.runNext({ executor: new FileOperationsExecutor(), workspace,
      commandId: 'unconfirmed-git', input: { schemaVersion: 1,
        operations: [{ type: 'write', path: 'source.txt', content: 'output\n' }] } });
    assert.equal(result.ok, false);
    assert.equal(result.run.failure.code, failure.code);
    if (failurePhase === 'capture') assert.equal(result.node.status, 'failed');
    await assert.rejects(f.produce('source', 'unsafe\n', 'unsafe-next'), { code: 'git-process-manual-recovery-required' });
    const recovery = await new FwaApplication(f.root).reconcileRun({ workspace });
    assert.equal(recovery.ok, false);
    assert.equal(recovery.reason, 'git-process-manual-recovery-required');
    assert.equal(removalCalls, 0);
  });
}
