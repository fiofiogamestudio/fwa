import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkbenchRepairExecutor } from '../src/application/workbench-candidate-restore.js';
import { buildWorkbenchRepairContext } from '../src/application/workbench-repair-context.js';

const objectId = digit => digit.repeat(40);
const artifact = value => ({ schemaVersion: 1, algorithm: 'sha256',
  digest: createHash('sha256').update(value).digest('hex'), size: Buffer.byteLength(value) });

function fixture() {
  const patch = Buffer.from('diff --git a/src/result.js b/src/result.js\n--- a/src/result.js\n+++ b/src/result.js\n@@ -1 +1 @@\n-module.exports = 0;\n+module.exports = 1;\n');
  const execution = Buffer.from('{"ok":true}');
  const effects = { logicalReads: [], logicalWrites: ['src/**'], resolvedReads: [], resolvedWrites: ['src/**'],
    consumedRefs: [], producedRefs: [] };
  const goal = { id: 'goal', status: 'active', request: 'Finish the existing implementation' };
  const node = { id: 'leaf', logicalId: 'logical-leaf', goalId: goal.id, planId: 'plan', status: 'running',
    validity: 'valid', reads: [], writes: ['src/**'], resources: [], dependsOn: [],
    runIds: ['old-run', 'current-run'], changeSetIds: ['old-change'],
    budget: { maxRetries: 3, maxFiles: 10, maxDiffLines: 200 } };
  const old = { id: 'old-run', nodeId: node.id, goalId: goal.id, planId: node.planId,
    createdSequence: 1, status: 'produced', baseRevision: objectId('a'), changeSetId: 'old-change',
    workspaceStatus: 'removed', effects: structuredClone(effects) };
  const current = { id: 'current-run', nodeId: node.id, goalId: goal.id, planId: node.planId,
    createdSequence: 10, status: 'running', baseRevision: old.baseRevision,
    workspacePath: path.resolve('.local/restore-unit-project/.fwa/worktrees/current-run'),
    workspaceRelativePath: '.fwa/worktrees/current-run', workspaceStatus: 'active', effects: structuredClone(effects) };
  const binding = { nodeId: node.id, goalId: goal.id, runId: old.id, changeSetId: old.changeSetId };
  const change = { id: old.changeSetId, ...binding, kind: 'execution', valid: true,
    baseRevision: old.baseRevision, headRevision: objectId('b'), commits: [objectId('b')],
    branch: 'fwa/runs/old-run', ref: 'refs/heads/fwa/runs/old-run',
    changes: [{ status: 'modified', code: 'M', path: 'src/result.js' }], changedFiles: ['src/result.js'],
    patchArtifact: artifact(patch), executionArtifact: artifact(execution), violations: [] };
  const evaluation = { id: 'old-evaluation', ...binding, status: 'rejected', evidenceId: 'old-evidence', workspaceStatus: 'removed' };
  const evidence = { id: evaluation.evidenceId, ...binding, result: 'fail', criteria: [{ id: 'behavior', kind: 'test',
    result: 'fail', exitCode: 1, terminationConfirmed: true, failure: { code: 'CHECK_FAILED', message: 'Expected 2, received 1' } }] };
  const state = { goals: [goal], nodes: [node], refs: [], runs: [old, current], changeSets: [change],
    evaluations: [evaluation], evidence: [evidence], integrations: [], reversions: [], runBatches: [],
    nodeFeedback: [], workflow: { feedback: [] } };
  const calls = { statuses: 0, artifacts: [], restores: [], execute: [], validate: [] };
  const controller = new AbortController();
  const f = { patch, execution, effects, goal, node, old, current, change, evaluation, evidence, state, calls, controller,
    beforeStatus: null, beforeArtifact: null, onRestore: null, onExecute: null };
  const application = { projectRoot: path.resolve('.local/restore-unit-project'),
    async getStatus() { calls.statuses++; await f.beforeStatus?.(calls.statuses); return structuredClone(state); },
    artifacts: { async verify(ref) {
      await f.beforeArtifact?.(ref);
      assert.deepEqual(ref, change.executionArtifact);
      return { ok: true };
    }, async get(ref) {
      calls.artifacts.push(structuredClone(ref)); await f.beforeArtifact?.(ref);
      if (ref.digest === change.patchArtifact.digest) return Buffer.from(patch);
      if (ref.digest === change.executionArtifact.digest) return Buffer.from(execution);
      throw new Error('Unexpected artifact');
    } } };
  const workspace = { async restoreCandidate(input) {
    calls.restores.push(input); await f.onRestore?.(input);
    return { status: input.baseRevision === input.changeSet.baseRevision ? 'restored' : 'baseline-changed',
      runId: input.runId, changeSetId: input.changeSet.id, baseRevision: input.baseRevision,
      candidateRevision: input.changeSet.headRevision };
  } };
  const delegate = { id: 'fixture-executor', version: '1', capabilities: ['code'],
    validateInput(input) { assert.equal(this, delegate); calls.validate.push(input); return 'validated'; },
    async execute(request) { assert.equal(this, delegate); calls.execute.push(request); await f.onExecute?.(request);
      return { ok: true, summary: 'repaired', artifacts: [{ kind: 'fixture', id: 'retained' }], usage: { tokens: 17 } }; } };
  const request = { workspaceRoot: current.workspacePath, baseRevision: current.baseRevision,
    node: { ...structuredClone(node), effects: structuredClone(effects) }, goal: structuredClone(goal),
    input: { prompt: 'Original repair instructions\n{"validationChecks":["behavior"]}', images: ['reference.png'] },
    signal: controller.signal };
  const wrapper = createWorkbenchRepairExecutor(delegate, { application, workspace, changeSetId: change.id });
  return Object.assign(f, { application, workspace, delegate, request, wrapper });
}

const restorationError = error => error?.code === 'FWA_WORKSPACE_RESTORATION_FAILED';
async function refusesBeforeDelegate(f) {
  await assert.rejects(() => f.wrapper.execute(f.request), restorationError);
  assert.equal(f.calls.execute.length, 0);
}

function failedExecution(f) {
  f.old.status = 'failed';
  f.old.failure = { code: 'EXECUTION_FAILED', phase: 'verification', message: 'Implementation failed',
    details: { failure: { code: 'IMPLEMENTATION_FAILED', message: 'Wrong returned value' } } };
  f.change.valid = false;
  f.change.violations = [{ code: 'EXECUTION_FAILED', message: 'Implementation failed' }];
  f.state.evaluations = []; f.state.evidence = [];
}

test('restoration wrapper preserves executor identity and pure, bound input validation', () => {
  const f = fixture();
  assert.equal(f.wrapper.id, f.delegate.id);
  assert.equal(f.wrapper.version, f.delegate.version);
  assert.deepEqual(f.wrapper.capabilities, f.delegate.capabilities);
  assert.equal(f.wrapper.validateInput(f.request.input), 'validated');
  assert.deepEqual(f.calls.validate, [f.request.input]);
  assert.equal(f.calls.statuses, 0);
  assert.equal(f.calls.artifacts.length + f.calls.restores.length + f.calls.execute.length, 0);
});

test('same-baseline repair restores the full durable candidate before delegation and retains execution evidence', async () => {
  const f = fixture(), stateBefore = structuredClone(f.state), inputBefore = structuredClone(f.request.input);
  f.onExecute = request => {
    assert.equal(f.calls.restores.length, 1);
    assert.equal(request.repairRestoration.status, 'restored');
    assert.equal(request.workspaceRoot, f.request.workspaceRoot);
    assert.equal(request.baseRevision, f.current.baseRevision);
    assert.equal(request.signal, f.controller.signal);
    assert.deepEqual(request.node, f.request.node);
    assert.deepEqual(request.goal, f.request.goal);
    assert.deepEqual(request.input.images, f.request.input.images);
    assert.ok(request.input.prompt.endsWith(f.request.input.prompt));
  };
  const result = await f.wrapper.execute(f.request), restored = f.calls.restores[0];
  assert.deepEqual(restored.changeSet, f.change);
  assert.deepEqual(Buffer.from(restored.patch), f.patch);
  assert.deepEqual(restored.writes, f.current.effects.resolvedWrites);
  assert.equal(restored.runId, f.current.id);
  assert.equal(restored.workspacePath, f.current.workspacePath);
  assert.equal(restored.baseRevision, f.current.baseRevision);
  assert.equal(result.repairRestoration.status, 'restored');
  assert.deepEqual(result.artifacts, [{ kind: 'fixture', id: 'retained' }]);
  assert.deepEqual(result.usage, { tokens: 17 });
  assert.deepEqual(f.request.input, inputBefore);
  assert.deepEqual(f.state, stateBefore);
});

test('changed baseline is explicit to the executor and output; the current base is preserved', async () => {
  const f = fixture();
  f.current.baseRevision = objectId('c'); f.request.baseRevision = f.current.baseRevision;
  const result = await f.wrapper.execute(f.request);
  assert.equal(result.repairRestoration.status, 'baseline-changed');
  assert.equal(f.calls.execute[0].repairRestoration.status, 'baseline-changed');
  assert.equal(f.calls.execute[0].baseRevision, objectId('c'));
});

test('an ordinary executor failure with fully captured output remains eligible for restoration', async () => {
  const f = fixture(); failedExecution(f);
  // Core retains invalid captured workspaces for inspection. Restoration reads
  // immutable Git/artefacts and must not require deleting that retained copy.
  f.old.workspaceStatus = 'preserved';
  f.old.failure.details.failure.details = { process: { terminationConfirmed: true } };
  const result = await f.wrapper.execute(f.request);
  assert.equal(result.repairRestoration.status, 'restored');
  assert.equal(f.calls.restores.length, 1);
  assert.equal(f.calls.execute.length, 1);
});

test('logical revision recovery uses the prior candidate while preserving the current node contract', async () => {
  const f = fixture(), previous = { ...structuredClone(f.node), id: 'leaf-previous', status: 'rejected', supersededByRevision: 'revision-2' };
  f.state.nodes.push(previous);
  for (const record of [f.old, f.change, f.evaluation, f.evidence]) record.nodeId = previous.id;
  const result = await f.wrapper.execute(f.request);
  assert.equal(result.repairRestoration.status, 'restored');
  assert.equal(f.calls.restores[0].changeSet.nodeId, previous.id);
  assert.equal(f.calls.execute[0].node.id, f.node.id);
});

test('restoration binds the running workspace, goal, node and base to the durable Run', async t => {
  for (const [name, mutate] of [
    ['workspace', f => { f.request.workspaceRoot = path.resolve('.local/unrelated-worktree'); }],
    ['node', f => { f.request.node.id = 'other-node'; }],
    ['goal', f => { f.request.goal.id = 'other-goal'; }],
    ['base', f => { f.request.baseRevision = objectId('f'); }],
    ['terminal-run', f => { f.current.status = 'produced'; }],
    ['ambiguous-run', f => { f.state.runs.push({ ...f.current, id: 'second-current' }); }]
  ]) await t.test(name, async () => {
    const f = fixture(); mutate(f); await refusesBeforeDelegate(f);
    assert.equal(f.calls.restores.length, 0);
  });
});

test('old or foreign candidate identifiers cannot replace the latest failed candidate', async t => {
  for (const [name, mutate] of [
    ['different-family', f => {
      f.state.nodes.push({ ...f.node, id: 'other-node', logicalId: 'other-logical' });
      f.old.nodeId = 'other-node'; f.change.nodeId = 'other-node';
      f.evaluation.nodeId = 'other-node'; f.evidence.nodeId = 'other-node';
    }],
    ['latest-attempt-changed', f => {
      f.state.runs.push({ ...f.old, id: 'newer-failed', createdSequence: 5, changeSetId: 'newer-change',
        status: 'failed', failure: { phase: 'verification', code: 'EXECUTION_FAILED', message: 'Another result failed' } });
      f.state.changeSets.push({ ...f.change, id: 'newer-change', runId: 'newer-failed' });
    }]
  ]) await t.test(name, async () => {
    const f = fixture(); mutate(f); await refusesBeforeDelegate(f);
    assert.equal(f.calls.restores.length, 0);
  });
});

test('accepted, integrated and unsettled candidates are not restored', async t => {
  for (const [name, mutate] of [
    ['passed', f => { f.evaluation.status = 'passed'; f.evidence.result = 'pass'; f.evidence.criteria[0].result = 'pass'; }],
    ['accepted', f => { f.node.acceptedChangeSetId = f.change.id; }],
    ['integrated', f => { f.state.integrations.push({ id: 'integrated', nodeId: f.node.id,
      changeSetId: f.change.id, status: 'integrated', workspaceStatus: 'removed' }); }],
    ['run-workspace', f => { f.old.workspaceStatus = 'preserved'; }],
    ['evaluation-workspace', f => { f.evaluation.workspaceStatus = 'cleanup-failed'; }],
    ['previous-revision-workspace', f => {
      const previous = { ...structuredClone(f.node), id: 'leaf-previous', status: 'rejected', supersededByRevision: 'revision-2' };
      f.state.nodes.push(previous);
      for (const record of [f.old, f.change, f.evaluation, f.evidence]) record.nodeId = previous.id;
      f.evaluation.workspaceStatus = 'cleanup-failed';
    }]
  ]) await t.test(name, async () => {
    const f = fixture(); mutate(f); await refusesBeforeDelegate(f);
    assert.equal(f.calls.restores.length, 0);
  });
});

test('a changed current write contract cannot be hidden by stale executor request effects', async t => {
  for (const [name, mutate] of [
    ['request-writes', f => { f.request.node.writes = ['other/**']; }],
    ['current-node-writes', f => { f.node.writes = ['other/**']; }],
    ['run-effects', f => { f.current.effects.resolvedWrites = ['other/**']; }]
  ]) await t.test(name, async () => {
    const f = fixture(); mutate(f); await refusesBeforeDelegate(f);
    assert.equal(f.calls.restores.length, 0);
  });
});

test('policy, independent-review and infrastructure failures cannot enter automatic restoration', async t => {
  for (const [name, mutate] of [
    ['policy', f => { f.change.valid = false; f.change.violations = [{ code: 'WRITE_OUT_OF_SCOPE', message: 'Wrong path' }]; }],
    ['independent-review', f => { f.evidence.criteria[0].failure.code = 'REVIEW_REQUIRED'; }],
    ['check-timeout', f => { f.evidence.criteria[0].timedOut = true; }],
    ['unconfirmed-process', f => { f.evidence.criteria[0].terminationConfirmed = false; }],
    ['evaluation-infrastructure', f => { f.evaluation.failure = { code: 'EVALUATION_SETUP_FAILED', message: 'Worktree unavailable' }; }],
    ['preserved-capture-failure', f => { failedExecution(f); f.old.workspaceStatus = 'preserved'; f.old.failure.phase = 'capture'; }],
    ['preserved-setup-failure', f => { failedExecution(f); f.old.workspaceStatus = 'preserved'; f.old.failure.phase = 'setup'; }],
    ['preserved-unconfirmed-process', f => {
      failedExecution(f); f.old.workspaceStatus = 'preserved';
      f.old.failure.details.failure.details = { process: { terminationConfirmed: false } };
    }]
  ]) await t.test(name, async () => {
    const f = fixture(); mutate(f); await refusesBeforeDelegate(f);
    assert.equal(f.calls.restores.length, 0);
  });
});

test('abort before restoration prevents artifact, workspace and executor work', async () => {
  const f = fixture(); f.controller.abort(new Error('User stopped this run'));
  await refusesBeforeDelegate(f);
  assert.equal(f.calls.artifacts.length, 0);
  assert.equal(f.calls.restores.length, 0);
});

test('abort after restoration prevents the executor from starting', async () => {
  const f = fixture(); f.onRestore = () => f.controller.abort(new Error('Deadline exceeded during restore'));
  await refusesBeforeDelegate(f);
  assert.equal(f.calls.restores.length, 1);
});

test('pending feedback before or during restoration prevents delegation', async t => {
  for (const arrival of ['before', 'during']) await t.test(arrival, async () => {
    const f = fixture(), feedback = { id: 'feedback', goalId: f.goal.id, status: 'pending' };
    const append = () => { f.state.nodeFeedback.push(feedback); f.state.workflow.feedback.push(feedback); };
    if (arrival === 'before') append(); else f.onRestore = append;
    await refusesBeforeDelegate(f);
    assert.equal(f.calls.restores.length, arrival === 'before' ? 0 : 1);
  });
});

test('a verified artifact read failure prevents workspace restoration and delegation', async () => {
  const f = fixture();
  f.beforeArtifact = () => { throw Object.assign(new Error('Artifact hash mismatch'), { code: 'artifact-corrupt' }); };
  await refusesBeforeDelegate(f);
  assert.equal(f.calls.restores.length, 0);
});

test('workspace restore failure blocks delegation and preserves unconfirmed process termination evidence', async () => {
  const f = fixture();
  f.onRestore = () => { throw Object.assign(new Error('Git process did not confirm termination'), {
    code: 'git-termination-unconfirmed', details: { terminationConfirmed: false, process: { terminationConfirmed: false } } }); };
  await assert.rejects(() => f.wrapper.execute(f.request), error => {
    assert.equal(restorationError(error), true);
    assert.match(JSON.stringify(error.details), /"terminationConfirmed":false/);
    return true;
  });
  assert.equal(f.calls.execute.length, 0);
});

test('delegate failure remains the original implementation failure after a successful restoration', async () => {
  const f = fixture(), failure = Object.assign(new Error('Implementation still failed'), { code: 'FIXTURE_EXECUTION_FAILED' });
  f.onExecute = () => { throw failure; };
  await assert.rejects(() => f.wrapper.execute(f.request), error => error === failure);
  assert.equal(f.calls.restores.length, 1);
});

test('captured restoration infrastructure failure requires inspection while ordinary implementation failure remains retryable', async () => {
  const f = fixture();
  f.onRestore = () => { throw Object.assign(new Error('Candidate changed after capture'), { code: 'changeset-ref-mismatch' }); };
  let restorationFailure;
  await assert.rejects(() => f.wrapper.execute(f.request), error => { restorationFailure = error; return restorationError(error); });
  failedExecution(f);
  f.state.runs = [f.old];
  const ordinary = buildWorkbenchRepairContext(f.state, f.node);
  assert.equal(ordinary.summary.retryDisposition, 'retry');
  f.old.failure.details.failure = { code: restorationFailure.code, message: restorationFailure.message, details: restorationFailure.details };
  const restoration = buildWorkbenchRepairContext(f.state, f.node);
  assert.equal(restoration.summary.retryDisposition, 'inspect');
  assert.equal(restoration.summary.category, 'execution-infrastructure');
});
