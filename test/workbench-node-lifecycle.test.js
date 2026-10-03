import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkbenchController } from '../src/application/workbench-controller.js';

const profile = { id: 'feature', checks: [{ id: 'feature-test', kind: 'test' }] };
function fixture(states = ['ready']) {
  const state = { goals: [{ id: 'goal', status: 'active', request: 'User outcome', integrationTargetRef: 'refs/heads/main' }],
    nodes: states.map((status, index) => ({ id: `node-${index}`, goalId: 'goal', status, validity: 'valid',
      dependsOn: [], reads: [], writes: [`src/${index}.txt`], acceptance: { checks: ['feature-test'] },
      runIds: [], changeSetIds: [], budget: { maxRetries: 2 } })), refs: [], changeSets: [], workflow: { feedback: [] }, retryDiagnostics: [] };
  const calls = { batch: [], validate: [] };
  function produce(node) {
    node.status = 'produced'; node.changeSetIds = [`change-${node.id}`];
    const change = { id: node.changeSetIds[0], nodeId: node.id, valid: true, kind: 'execution', changedFiles: node.writes, commits: ['revision'] };
    state.changeSets.push(change); return change;
  }
  for (const node of state.nodes.filter(item => item.status === 'produced')) produce(node);
  const application = { projectRoot: process.cwd(), getStatus: async () => structuredClone(state),
    runReadyBatch: async ({ executions }) => {
      calls.batch.push(executions.map(item => item.nodeId));
      return { ok: true, batch: { id: `batch-${calls.batch.length}` }, deferred: [], members: executions.map(item => {
        const node = state.nodes.find(node => node.id === item.nodeId);
        return { nodeId: node.id, runId: `run-${node.id}`, ok: true, changeSet: produce(node) };
      }) };
    } };
  const controller = new WorkbenchController(application, { planner: null, executor: { execute() {} }, validationProfiles: [profile] });
  controller.referenceContext = async () => ({ references: [], images: [] });
  controller.review = { config: { validationProfiles: [profile] }, async validateCandidate({ changeSetId }) {
    calls.validate.push(changeSetId);
    const node = state.nodes.find(item => item.changeSetIds.at(-1) === changeSetId);
    node.status = 'accepted'; node.acceptedChangeSetId = changeSetId;
    return { ok: true, phase: 'awaiting-human-acceptance', evidenceId: `evidence-${changeSetId}` };
  } };
  return { state, calls, controller };
}

test('continuing a produced node validates the saved candidate without a second execution', async () => {
  const f = fixture(['produced']);
  const result = await f.controller.runGoal({ commandId: 'resume', goalId: 'goal', nodeId: 'node-0' });
  assert.deepEqual(f.calls.batch, []);
  assert.deepEqual(f.calls.validate, ['change-node-0']);
  assert.equal(result.stopReason, 'awaiting-acceptance');
  assert.equal(result.candidates[0].evidenceId, 'evidence-change-node-0');
});

test('continuing a retained empty candidate reports its exact boundary without execution or acceptance', async () => {
  const f = fixture(['produced']); f.state.changeSets[0].changedFiles = [];
  const result = await f.controller.runGoal({ commandId: 'resume-empty', goalId: 'goal' });
  assert.equal(result.stopReason, 'no-changes-awaiting-review');
  assert.equal(result.noChanges[0].changeSetId, 'change-node-0');
  assert.deepEqual(f.calls.batch, []); assert.deepEqual(f.calls.validate, []);
});

test('one work command executes and validates all independent ready nodes once, without inventing completion', async () => {
  const f = fixture(Array(6).fill('ready'));
  const result = await f.controller.runGoal({ commandId: 'all-ready', goalId: 'goal' });
  assert.deepEqual(f.calls.batch.map(items => items.length), [4, 2]);
  assert.equal(new Set(f.calls.validate).size, 6);
  assert.equal(result.stopReason, 'awaiting-acceptance');
  assert.equal(result.rounds.length, 2);
  assert.ok(f.state.nodes.every(item => item.integratedChangeSetId === undefined));
});

test('missing validation setup stops before consuming an execution attempt', async () => {
  const f = fixture(); f.controller.review.config = null;
  assert.equal((await f.controller.runGoal({ commandId: 'unconfigured', goalId: 'goal' })).stopReason, 'needs-review-config');
  assert.deepEqual(f.calls.batch, []);
});

test('blocked retry admission skips that node and permits independent work', async () => {
  const f = fixture(['ready', 'ready']); f.state.retryDiagnostics = [{ nodeId: 'node-0', blocked: true }];
  await f.controller.runGoal({ commandId: 'skip-blocked', goalId: 'goal' });
  assert.deepEqual(f.calls.batch, [['node-1']]);
});

test('input-sensitive retry hints reach core admission after input has been repaired', async () => {
  const f = fixture(); f.state.retryDiagnostics = [{ nodeId: 'node-0', blocked: true, code: 'retry-input-repair-required' }];
  await f.controller.runGoal({ commandId: 'repaired-input', goalId: 'goal' });
  assert.deepEqual(f.calls.batch, [['node-0']]);
});

test('core rejection of the first ready window does not starve later independent nodes', async () => {
  const f = fixture(Array(5).fill('ready'));
  const runBatch = f.controller.application.runReadyBatch;
  f.controller.application.runReadyBatch = async input => {
    if (input.executions.some(item => item.nodeId === 'node-0')) throw Object.assign(new Error('No admitted nodes'), {
      code: 'no-ready-nodes', details: { deferred: input.executions.map(item => ({ nodeId: item.nodeId, code: 'executor-capability-mismatch' })) }
    });
    return runBatch(input);
  };
  const result = await f.controller.runGoal({ commandId: 'skip-window', goalId: 'goal' });
  assert.deepEqual(f.calls.batch, [['node-4']]);
  assert.equal(result.stopReason, 'executor-capability-mismatch');
  assert.equal(result.candidates.filter(item => item.ok === false).length, 4);
});

test('an empty peer keeps its evidence while a nonempty peer is still verified', async () => {
  const f = fixture(['ready', 'ready']);
  const runBatch = f.controller.application.runReadyBatch;
  f.controller.application.runReadyBatch = async input => {
    const batch = await runBatch(input); batch.members[0].changeSet.changedFiles = []; return batch;
  };
  const result = await f.controller.runGoal({ commandId: 'mixed-results', goalId: 'goal' });
  assert.deepEqual(f.calls.validate, ['change-node-1']);
  assert.equal(result.stopReason, 'no-changes-awaiting-review');
  assert.equal(result.noChanges.length, 1); assert.equal(f.state.changeSets.length, 2);
});

test('failed validation without durable failure evidence preserves the candidate and stops', async () => {
  const f = fixture(); f.controller.review.validateCandidate = async () => ({ ok: false, phase: 'validation-failed' });
  const result = await f.controller.runGoal({ commandId: 'check-failed', goalId: 'goal' });
  assert.equal(result.stopReason, 'validation-failed');
  assert.equal(f.calls.batch.length, 1); assert.equal(f.state.changeSets.length, 1);
});

test('an existing failed candidate or missing profile cannot starve an independent ready result', async () => {
  const f = fixture(['produced', 'ready', 'ready']);
  f.state.nodes[1].acceptance = { checks: ['missing-runner'] };
  const validate = f.controller.review.validateCandidate;
  f.controller.review.validateCandidate = async input => input.changeSetId === 'change-node-0'
    ? { ok: false, phase: 'validation-failed' } : validate(input);
  const result = await f.controller.runGoal({ commandId: 'independent-progress', goalId: 'goal' });
  assert.deepEqual(f.calls.batch, [['node-2']]);
  assert.deepEqual(f.calls.validate, ['change-node-2']);
  assert.equal(result.stopReason, 'validation-failed');
});

test('automatic acceptance must actually integrate and must not swallow a false return', async () => {
  for (const response of [undefined, { ok: false, phase: 'regression-failed' }]) {
    const f = fixture(); f.controller.acceptAndIntegrate = async () => response;
    const result = await f.controller.runGoal({ commandId: 'callback', goalId: 'goal' });
    assert.equal(result.stopReason, response?.phase || 'acceptance-incomplete');
    assert.equal(f.calls.batch.length, 1);
  }
});

test('completion requires matching accepted and integrated candidates on the goal target', async () => {
  const f = fixture();
  f.controller.acceptAndIntegrate = async ({ changeSet }) => {
    Object.assign(f.state.nodes[0], { status: 'accepted', acceptedChangeSetId: changeSet.id,
      integratedChangeSetId: changeSet.id, integrationStatus: 'integrated', integratedTargetRef: 'refs/heads/main' });
    return { ok: true };
  };
  assert.equal((await f.controller.runGoal({ commandId: 'complete', goalId: 'goal' })).stopReason, 'goal-completed');
});

test('policy completion must actually integrate and a refusal never retries the producer', async () => {
  for (const response of [{ ok: true, finished: true }, { ok: false, finished: false, phase: 'regression-failed' }]) {
    const f = fixture(); let closures = 0;
    f.controller.review.finishCandidate = async () => { closures++; return response; };
    const result = await f.controller.runGoal({ commandId: 'policy-failed', goalId: 'goal' });
    assert.equal(result.stopReason, response.phase || 'integration-incomplete');
    assert.equal(closures, 1); assert.equal(f.calls.batch.length, 1);
    assert.equal(f.state.changeSets.length, 1);
  }
});

test('manual policy returns control with saved validation instead of invoking another run', async () => {
  const f = fixture(); let closures = 0;
  f.controller.review.finishCandidate = async () => {
    closures++; return { ok: true, finished: false, phase: 'awaiting-human-acceptance' };
  };
  const result = await f.controller.runGoal({ commandId: 'manual-policy', goalId: 'goal' });
  assert.equal(result.stopReason, 'awaiting-acceptance');
  assert.equal(closures, 1); assert.equal(f.calls.batch.length, 1);
  assert.equal(result.candidates[0].evidenceId, 'evidence-change-node-0');
});
