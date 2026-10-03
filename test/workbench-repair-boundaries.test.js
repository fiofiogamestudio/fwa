import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { WorkbenchController } from '../src/application/workbench-controller.js';
import { buildRetryDiagnostics } from '../src/core/retry-diagnostics.js';
import { isNodeSchedulable, nodeRetryEligibility } from '../src/core/scheduling.js';

const artifact = text => ({ schemaVersion: 1, algorithm: 'sha256',
  digest: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) });
const profile = { schemaVersion: 1, id: 'behavior-profile', checks: [{ id: 'behavior', kind: 'test',
  command: process.execPath, args: ['-e', 'require("node:assert/strict").equal(1, 1)'], timeoutMs: 1000 }] };

// The fixture supplies durable observations and execution outcomes. Scheduling,
// repair-context construction and continuation remain the real controller's job.
function fixture({ ids = ['repair'], maxRetries = 5, outcome = () => ({ pass: true }) } = {}) {
  const state = { goals: [{ id: 'goal', status: 'active', request: 'Finish every independent result',
    integrationTargetRef: 'refs/heads/main' }], refs: [], workflow: { feedback: [] }, nodeFeedback: [],
    nodes: ids.map(id => ({ id, logicalId: id, goalId: 'goal', title: id, status: 'ready', validity: 'valid',
      dependsOn: [], reads: [], writes: [`src/${id}.js`], acceptance: { checks: ['behavior'] },
      runIds: [], changeSetIds: [], budget: { maxRetries } })),
    runs: [], changeSets: [], evaluations: [], evidence: [], integrations: [], reversions: [], runBatches: [] };
  const calls = { execute: [], validate: [], retry: [], finish: [] }, results = new Map();
  let sequence = 0;
  const nodeById = id => state.nodes.find(node => node.id === id);
  function produce(node, result) {
    const index = ++sequence, runId = `run_${index}`, changeSetId = `change_${index}`;
    const binding = { runId, nodeId: node.id, goalId: node.goalId, changeSetId };
    const run = { id: runId, ...binding, createdSequence: index, status: result.executionFailure ? 'failed' : 'produced',
      baseRevision: 'stable-base', inputHash: `input-${index}`, workspaceStatus: 'removed',
      ...(result.executionFailure ? { failure: result.executionFailure } : {}) };
    const change = { id: changeSetId, ...binding, kind: 'execution', valid: !result.executionFailure,
      changedFiles: [...(result.changedFiles ?? node.writes)], commits: [`candidate-${index}`], baseRevision: run.baseRevision,
      headRevision: `candidate-${index}`, patchArtifact: artifact(result.patch ?? 'same incomplete implementation'),
      executionArtifact: artifact(`execution evidence ${index}`), violations: [] };
    state.runs.push(run); state.changeSets.push(change); results.set(change.id, result);
    node.runIds.push(run.id); node.changeSetIds.push(change.id);
    node.status = result.executionFailure ? (node.runIds.length <= node.budget.maxRetries ? 'ready' : 'failed') : 'produced';
    return { nodeId: node.id, runId: run.id, ok: !result.executionFailure, changeSet: change };
  }
  function evaluate(changeSetId) {
    const change = state.changeSets.find(item => item.id === changeSetId), node = nodeById(change.nodeId);
    const result = results.get(changeSetId), index = state.evaluations.length + 1;
    const binding = { runId: change.runId, nodeId: node.id, goalId: node.goalId, changeSetId };
    const evaluation = { id: `evaluation_${index}`, ...binding, evidenceId: `evidence_${index}`,
      status: result.pass ? 'passed' : 'rejected', workspaceStatus: 'removed' };
    const failure = result.pass ? null : { code: 'CHECK_FAILED',
      message: `Wrong result for ${change.runId} at 2026-09-22T12:00:${String(index).padStart(2, '0')}Z` };
    state.evaluations.push(evaluation);
    state.evidence.push({ id: evaluation.evidenceId, ...binding, kind: 'command-evaluation', result: result.pass ? 'pass' : 'fail',
      profileArtifact: artifact('validation profile'), resultArtifact: artifact(`validation result ${index}`),
      criteria: [{ id: 'behavior', kind: 'test', result: result.pass ? 'pass' : 'fail', exitCode: result.pass ? 0 : 1,
        terminationConfirmed: true, failure, stdoutArtifact: artifact(`new log ${index}`), stderrArtifact: artifact(''),
        ...(result.criterion ?? {}) }] });
    node.status = result.pass ? 'accepted' : 'rejected';
    if (result.pass) node.acceptedChangeSetId = changeSetId;
    return { ok: result.pass === true, changeSetId, evidenceId: evaluation.evidenceId,
      phase: result.pass ? 'awaiting-human-acceptance' : 'validation-failed' };
  }
  function integrate(changeSetId) {
    const change = state.changeSets.find(item => item.id === changeSetId), node = nodeById(change.nodeId);
    Object.assign(node, { status: 'accepted', acceptedChangeSetId: changeSetId,
      integratedChangeSetId: changeSetId, integrationStatus: 'integrated', integratedTargetRef: 'refs/heads/main' });
    state.integrations.push({ id: `integration_${state.integrations.length + 1}`, nodeId: node.id,
      changeSetId, status: 'integrated' });
    return { ok: true, finished: true, phase: 'integrated' };
  }
  const application = { projectRoot: process.cwd(),
    getStatus: async () => structuredClone({ ...state, retryDiagnostics: buildRetryDiagnostics(state) }),
    retryNode: async input => {
      calls.retry.push(structuredClone(input));
      const node = nodeById(input.nodeId), eligibility = nodeRetryEligibility(node, state.nodes, state.goals[0]);
      assert.equal(eligibility.ok, true, JSON.stringify(eligibility));
      node.status = 'ready';
      return { appended: true, mode: eligibility.mode, node: structuredClone(node) };
    },
    runReadyBatch: async ({ executions }) => {
      const members = executions.map(execution => {
        const node = nodeById(execution.nodeId);
        assert.equal(isNodeSchedulable(node, state.nodes, state.goals[0]), true, `${node.id} must be ready`);
        const attempt = node.runIds.length + 1;
        const context = JSON.parse(execution.input.prompt.split('\n').at(-1));
        calls.execute.push({ nodeId: node.id, attempt, context });
        return produce(node, outcome(node.id, attempt));
      });
      return { ok: members.every(member => member.ok), batch: { id: `batch_${sequence}` }, deferred: [], members };
    } };
  const controller = new WorkbenchController(application, { planner: null, executor: { execute() {} }, validationProfiles: [profile] });
  controller.referenceContext = async () => ({ references: [], images: [] });
  controller.review = { config: { completionPolicy: { mode: 'automatic', manualProfiles: [] }, validationProfiles: [profile] },
    async validateCandidate({ changeSetId }) { calls.validate.push(changeSetId); return evaluate(changeSetId); },
    async finishCandidate({ changeSetId }) { calls.finish.push(changeSetId); return integrate(changeSetId); } };
  return { controller, state, calls, nodeById,
    seed(id, result) { const member = produce(nodeById(id), result); if (!result.executionFailure) evaluate(member.changeSet.id); return member; },
    integrate };
}

test('two identical failures stop even when repair inputs contain new record and log references; an independent result completes', async () => {
  const f = fixture({ ids: ['repair', 'independent'], maxRetries: 9,
    outcome: id => ({ pass: id === 'independent' }) });
  const result = await f.controller.runGoal({ commandId: 'repeated-failure', goalId: 'goal' });
  assert.deepEqual(f.calls.execute.map(call => call.nodeId), ['repair', 'independent', 'repair']);
  assert.match(result.stopReason, /no-progress/);
  assert.equal(f.nodeById('independent').integrationStatus, 'integrated');
  assert.equal(f.state.changeSets.filter(change => change.nodeId === 'repair').length, 2);
  const repair = f.calls.execute.at(-1).context.repair;
  assert.equal(repair.references.runId, f.nodeById('repair').runIds[0]);
  assert.equal(repair.repeatedFailureCount, 1);
  assert.notEqual(f.state.evidence[0].criteria[0].stdoutArtifact.digest, f.state.evidence.at(-1).criteria[0].stdoutArtifact.digest);
});

test('different failed outputs consume the declared attempt budget without an extra execution', async () => {
  const f = fixture({ maxRetries: 2, outcome: (_, attempt) => ({ pass: false, patch: `changed attempt ${attempt}` }) });
  const result = await f.controller.runGoal({ commandId: 'attempt-budget', goalId: 'goal' });
  assert.deepEqual(f.calls.execute.map(call => call.attempt), [1, 2, 3]);
  assert.match(result.stopReason, /budget/);
  assert.equal(f.state.evaluations.length, 3);
  assert.equal(f.state.integrations.length, 0);
  assert.equal(f.calls.retry.length, 2);
});

test('a successful repair with no changed files reports its current review boundary instead of the previous failure', async () => {
  const f = fixture({ outcome: (_, attempt) => attempt === 1 ? { pass: false }
    : { pass: true, changedFiles: [], patch: '' } });
  const result = await f.controller.runGoal({ commandId: 'empty-repair-result', goalId: 'goal' });
  assert.equal(result.stopReason, 'no-changes-awaiting-review');
  assert.deepEqual(f.calls.execute.map(call => call.attempt), [1, 2]);
  assert.equal(f.calls.validate.length, 1, 'An empty replacement candidate is not automatically validated.');
  assert.equal(f.calls.finish.length, 0);
  assert.equal(result.noChanges.length, 1);
  assert.equal(result.noChanges[0].changeSetId, f.nodeById('repair').changeSetIds.at(-1));
  assert.equal(f.state.evidence[0].result, 'fail', 'The original failure remains available as history.');
});

test('a core admission refusal after requeuing retained work stays blocked for this request and permits an independent node', async t => {
  for (const mode of ['no-ready-nodes', 'deferred-member']) await t.test(mode, async () => {
    const ids = mode === 'no-ready-nodes' ? ['repair', 'blocked-1', 'blocked-2', 'blocked-3', 'independent']
      : ['repair', 'independent'];
    const f = fixture({ ids }), retained = f.seed('repair', { pass: false }), batches = [];
    const runBatch = f.controller.application.runReadyBatch;
    f.controller.application.runReadyBatch = async input => {
      batches.push(input.executions.map(item => item.nodeId));
      assert.ok(batches.length <= 3, 'An admission refusal must not start a repeated dispatch loop.');
      const executions = input.executions.filter(item => item.nodeId === 'independent');
      const deferred = input.executions.filter(item => item.nodeId !== 'independent')
        .map(item => ({ nodeId: item.nodeId, code: 'executor-capability-mismatch' }));
      if (!executions.length) throw Object.assign(new Error('No admitted nodes'), { code: 'no-ready-nodes', details: { deferred } });
      return { ...await runBatch({ ...input, executions }), deferred };
    };
    const result = await f.controller.runGoal({ commandId: `refused-retained-repair-${mode}`, goalId: 'goal' });
    assert.equal(result.stopReason, 'executor-capability-mismatch');
    assert.deepEqual(batches, mode === 'no-ready-nodes'
      ? [['repair', 'blocked-1', 'blocked-2', 'blocked-3'], ['independent']] : [['repair', 'independent']]);
    assert.deepEqual(f.calls.execute.map(call => call.nodeId), ['independent']);
    assert.equal(f.calls.retry.length, 1);
    assert.equal(f.nodeById('independent').integrationStatus, 'integrated');
    assert.deepEqual(f.nodeById('repair').runIds, [retained.runId]);
    assert.equal(f.state.evidence[0].result, 'fail');
  });
});

test('feedback received with a failed evaluation preserves its candidate and prevents a repair dispatch', async () => {
  const f = fixture({ outcome: () => ({ pass: false }) });
  const validate = f.controller.review.validateCandidate;
  f.controller.review.validateCandidate = async input => {
    const result = await validate(input);
    f.state.workflow.feedback.push({ id: 'feedback', goalId: 'goal', status: 'pending', text: 'Change the requested behavior' });
    return result;
  };
  const result = await f.controller.runGoal({ commandId: 'feedback-after-failure', goalId: 'goal' });
  assert.equal(result.stopReason, 'awaiting-feedback-revision');
  assert.equal(f.calls.execute.length, 1);
  assert.equal(f.calls.retry.length, 0);
  assert.equal(f.state.changeSets.length, 1);
  assert.equal(f.state.evidence[0].result, 'fail');
});

test('feedback arriving while a repair input is prepared closes the dispatch race', async () => {
  const f = fixture({ outcome: () => ({ pass: false }) });
  let preparations = 0;
  f.controller.referenceContext = async () => {
    if (++preparations === 2) f.state.workflow.feedback.push({ id: 'feedback', goalId: 'goal', status: 'pending' });
    return { references: [], images: [] };
  };
  const result = await f.controller.runGoal({ commandId: 'feedback-before-repair-dispatch', goalId: 'goal' });
  assert.equal(preparations, 2);
  assert.equal(result.stopReason, 'awaiting-feedback-revision');
  assert.equal(f.calls.execute.length, 1);
  assert.equal(f.state.changeSets.length, 1);
});

test('resuming a rejected candidate repairs it using retained evidence without redoing an integrated peer', async () => {
  const f = fixture({ ids: ['repair', 'delivered'] });
  const failed = f.seed('repair', { pass: false }), delivered = f.seed('delivered', { pass: true });
  f.integrate(delivered.changeSet.id);
  const retained = structuredClone({ change: failed.changeSet, evidence: f.state.evidence[0] });
  const result = await f.controller.runGoal({ commandId: 'resume-repair', goalId: 'goal' });
  assert.equal(result.stopReason, 'goal-completed');
  assert.deepEqual(f.calls.execute.map(call => call.nodeId), ['repair']);
  assert.deepEqual(f.calls.finish, [f.nodeById('repair').integratedChangeSetId]);
  assert.equal(f.nodeById('delivered').integratedChangeSetId, delivered.changeSet.id);
  const context = f.calls.execute[0].context;
  assert.equal(context.repair.references.changeSetId, failed.changeSet.id);
  assert.equal(context.repair.references.candidateRevision, failed.changeSet.headRevision);
  assert.equal(context.repair.summary.failedChecks[0].id, 'behavior');
  assert.deepEqual(context.validationChecks, profile.checks);
  assert.deepEqual(f.state.changeSets.find(change => change.id === failed.changeSet.id), retained.change);
  assert.deepEqual(f.state.evidence[0], retained.evidence);
});

test('selected-node work repairs that node to completion without expanding execution to its peers', async () => {
  const f = fixture({ ids: ['repair', 'unselected'], outcome: (_, attempt) => ({ pass: attempt > 1 }) });
  const result = await f.controller.runGoal({ commandId: 'selected-repair', goalId: 'goal', nodeId: 'repair' });
  assert.equal(result.stopReason, 'selected-leaf-processed');
  assert.deepEqual(f.calls.execute.map(call => call.nodeId), ['repair', 'repair']);
  assert.equal(f.nodeById('repair').integrationStatus, 'integrated');
  assert.deepEqual(f.nodeById('unselected').runIds, []);
});

test('confirmed executor timeout or cancellation stops repair while independent work completes', async t => {
  for (const executionFailure of [
    { code: 'FWA_CODEX_TIMEOUT', message: 'Executor deadline reached', details: { process: { terminationConfirmed: true, timedOut: true } } },
    { code: 'FWA_CODEX_ABORTED', message: 'Execution was cancelled', details: { process: { terminationConfirmed: true, aborted: true } } }
  ]) await t.test(executionFailure.code, async () => {
    const f = fixture({ ids: ['repair', 'independent'], outcome: id => id === 'repair' ? { executionFailure } : { pass: true } });
    const result = await f.controller.runGoal({ commandId: `inspect-${executionFailure.code}`, goalId: 'goal' });
    assert.deepEqual(f.calls.execute.map(call => call.nodeId), ['repair', 'independent']);
    assert.equal(f.calls.retry.length, 0);
    assert.notEqual(result.stopReason, 'goal-completed');
    assert.equal(f.nodeById('independent').integrationStatus, 'integrated');
    assert.equal(f.state.runs.find(run => run.nodeId === 'repair').failure.code, executionFailure.code);
  });
});

test('uncertain process termination is retained and never authorizes another execution', async () => {
  const executionFailure = { code: 'executor-termination-unconfirmed', message: 'The child process may still run',
    details: { process: { terminationConfirmed: false } } };
  const f = fixture({ outcome: () => ({ executionFailure }) });
  const result = await f.controller.runGoal({ commandId: 'uncertain-process', goalId: 'goal' });
  assert.equal(f.calls.execute.length, 1);
  assert.equal(f.calls.retry.length, 0);
  assert.equal(f.calls.finish.length, 0);
  assert.notEqual(result.stopReason, 'goal-completed');
  assert.deepEqual(f.state.runs[0].failure, executionFailure);
});
