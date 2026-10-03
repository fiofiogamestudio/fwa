import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildWorkflow } from '../src/core/workflow.js';

const context = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../src/editor/app/workbench-model.js', import.meta.url), 'utf8'), context);
const model = context.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const goal = { id: 'goal', title: '交付目标', integrationTargetRef: 'refs/heads/main', status: 'active', groups: [] };
const leaf = (id, fields = {}) => ({ id, logicalId: id, goalId: goal.id, title: id, status: 'planned', validity: 'valid',
  integrationStatus: null, dependsOn: [], runIds: [], changeSetIds: [], ...fields });
const delivery = id => leaf(id, { status: 'accepted', integrationStatus: 'integrated', acceptedChangeSetId: `cs-${id}`,
  integratedChangeSetId: `cs-${id}`, integratedTargetRef: goal.integrationTargetRef });
const snapshot = (nodes, extra = {}) => {
  const state = { nodes, goals: [{ ...goal, nodeIds: nodes.filter(item => item.supersededByRevision == null).map(item => item.id) }],
    runs: [], evaluations: [], integrations: [], ...extra };
  state.workflow = buildWorkflow(state);
  return state;
};
const current = state => state.workflow.goals[0];

test('a stopped failed attempt retains legacy work phase while progress explicitly says failed', () => {
  const state = snapshot([leaf('task', { status: 'failed', runIds: ['run'] })], {
    runs: [{ id: 'run', nodeId: 'task', status: 'failed', failedAt: '2026-09-18T01:00:00.000Z', failure: { message: 'compiler failed' } }] });
  assert.equal(current(state).phase, 'work');
  assert.equal(current(state).activity.state, 'failed');
  assert.equal(current(state).children[0].activity.reason, 'compiler failed');
  assert.equal(current(state).summary.lastProgressAt, null, 'failure is not successful progress');
  assert.equal(model.buildProgress(state, goal.id).current.state, 'failed');
});

test('unfinished dependencies are blocked, and an actually running sibling remains the current action', () => {
  const state = snapshot([leaf('prerequisite', { status: 'running' }), leaf('later', { dependsOn: ['prerequisite'] })], {
    runs: [{ id: 'run', nodeId: 'prerequisite', status: 'running', startedAt: '2026-09-18T01:00:00.000Z' }] });
  assert.equal(current(state).activity.state, 'running');
  assert.equal(current(state).children[1].activity.state, 'blocked');
  assert.match(current(state).children[1].activity.reason, /prerequisite/);
  assert.deepEqual(current(state).summary.counts, { running: 1, blocked: 1 });
});

test('active repair labels follow the previous attempt and its latest evaluation without adding a scheduling state', () => {
  const make = (priorStatus, evaluationStates = []) => snapshot([leaf('task', { status: 'running',
    runIds: ['z-prior', 'a-current'], evaluationIds: evaluationStates.map((_, index) => `eval-${index}`) })], {
    runs: [{ id: 'a-current', nodeId: 'task', status: 'running' }, { id: 'z-prior', nodeId: 'task', status: priorStatus }],
    evaluations: evaluationStates.map((status, index) => ({ id: `eval-${index}`, nodeId: 'task', runId: 'z-prior', status })).reverse()
  });
  for (const state of [make('failed'), make('produced', ['rejected'])]) {
    const item = current(state).children[0];
    assert.equal(item.activity.state, 'running');
    assert.equal(item.activity.label, '正在修复');
    assert.equal(item.attempts, 2);
    assert.equal(state.nodes[0].status, 'running');
    assert.equal(model.buildProgress(state, goal.id).current.label, '正在修复');
  }
  for (const state of [make('produced'), make('produced', ['passed']), make('produced', ['rejected', 'passed'])]) {
    assert.equal(current(state).children[0].activity.label, '制作中');
  }
});

test('old failures, foreign evaluations and stopped attempts cannot falsely display an active repair', () => {
  const state = snapshot([leaf('task', { status: 'running', runIds: ['old-failed', 'successful', 'current'], evaluationIds: ['foreign'] })], {
    runs: [{ id: 'old-failed', nodeId: 'task', status: 'failed' }, { id: 'successful', nodeId: 'task', status: 'produced' },
      { id: 'current', nodeId: 'task', status: 'running' }],
    evaluations: [{ id: 'foreign', nodeId: 'other', runId: 'successful', status: 'rejected' }] });
  assert.equal(current(state).children[0].activity.label, '制作中');
  state.nodes[0].status = 'failed';
  state.runs[2].status = 'failed';
  state.workflow = buildWorkflow(state);
  assert.equal(current(state).children[0].activity.state, 'failed');
  assert.notEqual(current(state).children[0].activity.label, '正在修复');
});

test('accepted, stale, mismatched candidate or another target cannot inflate delivered count', () => {
  const state = snapshot([delivery('good'), leaf('accepted', { status: 'accepted' }),
    { ...delivery('stale'), validity: 'stale' }, { ...delivery('wrong-candidate'), integratedChangeSetId: 'other' },
    { ...delivery('wrong-target'), integratedTargetRef: 'refs/heads/other' }]);
  assert.equal(current(state).summary.delivered, 1);
  const progress = model.buildProgress(state, goal.id);
  assert.equal(progress.delivered, 1);
  assert.equal(progress.total, 5);
  assert.equal(progress.groups[0].items.find(item => item.id === 'accepted').state, 'awaiting-integration');
});

test('attempts survive plan revisions and successful-progress timestamps ignore later failure and polling', () => {
  const producedAt = '2026-09-18T01:00:00.000Z';
  const nodes = [leaf('old', { logicalId: 'feature', supersededByRevision: 2, runIds: ['r1'] }),
    leaf('feature@revision-2', { logicalId: 'feature', definitionRevision: 2, status: 'failed', runIds: ['r2'] }),
    leaf('foreign', { goalId: 'elsewhere', logicalId: 'feature', supersededByRevision: 3, runIds: ['foreign-run'] })];
  const state = snapshot(nodes, { runs: [{ id: 'r1', nodeId: 'old', status: 'produced', producedAt },
    { id: 'r2', nodeId: 'feature@revision-2', status: 'failed', failedAt: '2026-09-18T02:00:00.000Z' },
    { id: 'foreign-run', nodeId: 'foreign', status: 'produced', producedAt: '2026-09-18T03:00:00.000Z' }] });
  assert.equal(current(state).children[0].attempts, 2);
  assert.equal(current(state).children[0].lastProgressAt, producedAt);
  const progress = model.buildProgress(state, goal.id);
  assert.equal(progress.total, 1);
  assert.match(progress.attemptsText, /2 次/);
  assert.equal(progress.lastProgressAt, producedAt);
  assert.deepEqual(plain(model.buildProgress(state, goal.id)), plain(progress));
});

test('review-required evidence waits for review and does not contaminate a newer candidate', () => {
  const state = snapshot([leaf('visual', { status: 'rejected', changeSetIds: ['cs-old'] })], {
    evaluations: [{ id: 'e1', nodeId: 'visual', changeSetId: 'cs-old', status: 'rejected', evidenceId: 'ev' }],
    evidence: [{ id: 'ev', criteria: [{ code: 'REVIEW_REQUIRED', message: 'independent review required' }] }] });
  assert.equal(current(state).children[0].activity.state, 'awaiting-review');
  state.nodes[0].changeSetIds.push('cs-new');
  state.nodes[0].status = 'produced';
  state.workflow = buildWorkflow(state);
  assert.equal(current(state).children[0].activity.state, 'awaiting-verification');
});

test('nested authored groups retain their names and count each current leaf once', () => {
  const nodes = [delivery('done'), leaf('next', { parentId: 'child', status: 'ready' })];
  nodes[0].parentId = 'parent';
  const state = snapshot(nodes, { goals: [{ ...goal, nodeIds: ['done', 'next'], groups: [
    { id: 'parent', title: '规则' }, { id: 'child', parentId: 'parent', title: '存档' }] }] });
  assert.equal(current(state).summary.total, 2);
  assert.equal(current(state).children[0].summary.total, 2);
  const progress = model.buildProgress(state, goal.id);
  assert.deepEqual(plain(progress.groups.map(item => item.title)), ['规则', '规则 / 存档']);
  assert.equal(progress.delivered, 1);
});

test('retry admission diagnostics explain the stopped task without hiding active work or delivery', () => {
  const state = snapshot([delivery('done'), leaf('active', { status: 'running' }), leaf('retry', { status: 'ready' })], {
    runs: [{ id: 'running', nodeId: 'active', status: 'running' }] });
  state.retryDiagnostics = state.nodes.map(node => ({ nodeId: node.id, blocked: true, attempts: 7,
    code: 'retry-no-progress', message: '相同失败重复发生。', nextAction: '修复失败根因后继续。' }));
  const items = model.buildProgress(state, goal.id).groups.flatMap(item => item.items);
  assert.equal(items.find(item => item.id === 'done').state, 'delivered');
  assert.equal(items.find(item => item.id === 'active').state, 'running');
  const stopped = items.find(item => item.id === 'retry');
  assert.equal(stopped.state, 'blocked');
  assert.equal(stopped.attempts, 7);
  assert.match(stopped.reason, /相同的改动和结果/);
});

test('empty and legacy flat status remain useful without diagnostics or projected activities', () => {
  assert.equal(model.buildProgress().total, 0);
  const state = { goals: [goal], nodes: [leaf('task', { status: 'accepted' })] };
  const progress = model.buildProgress(state, goal.id);
  assert.equal(progress.groups.length, 1);
  assert.equal(progress.groups[0].title, '任务');
  assert.equal(progress.delivered, 0);
  assert.equal(progress.current.state, 'awaiting-integration');
});

test('authored group order and durable diagnostics remain authoritative over display sorting and candidate timestamps', () => {
  const state = snapshot([leaf('a-later', { parentId: 'later' }), leaf('z-first', { parentId: 'first', runIds: ['run'] })], {
    goals: [{ ...goal, nodeIds: ['z-first', 'a-later'], groups: [{ id: 'first', title: '第一阶段' }, { id: 'later', title: '第二阶段' }] }],
    runs: [{ id: 'run', nodeId: 'z-first', producedAt: '2026-09-18T01:00:00.000Z' }],
    retryDiagnostics: [{ nodeId: 'z-first', attempts: 1, lastProgressAt: null, blocked: false }],
    planDiagnostics: [{ goalId: goal.id, metrics: { longestDependencyChainLength: 9, checkReferenceCount: 12, uniqueCheckCount: 7 },
      findings: [{ code: 'LONG_DEPENDENCY_CHAIN', severity: 'warning', message: 'long chain' }] }] });
  const progress = model.buildProgress(state, goal.id);
  assert.deepEqual(plain(progress.groups.map(item => item.title)), ['第一阶段', '第二阶段']);
  assert.equal(progress.lastProgressAt, null, 'rejected repeated output cannot advance the authoritative progress clock');
  assert.equal(progress.hasPlanDiagnostics, true);
  assert.match(progress.planDiagnostics[0].summary, /9 项/);
});

test('workflow API and group activity honor retry admission guards without changing scheduling phase', () => {
  const state = snapshot([leaf('retry', { parentId: 'group', status: 'ready', runIds: ['old-run'] })], {
    goals: [{ ...goal, nodeIds: ['retry'], groups: [{ id: 'group', title: '交付分组' }] }],
    runs: [{ id: 'old-run', nodeId: 'retry', status: 'failed' }],
    retryDiagnostics: [{ nodeId: 'retry', attempts: 7, blocked: true, code: 'logical-node-retry-budget-exhausted',
      message: 'Attempt budget exhausted.', nextAction: 'Inspect the failure.', lastProgressAt: null }] });
  const group = current(state).children[0], item = group.children[0];
  assert.equal(item.phase, 'work');
  assert.equal(state.nodes[0].status, 'ready', 'presentation does not change scheduling state');
  assert.equal(item.activity.state, 'blocked');
  assert.equal(item.flags.blocked, true);
  assert.equal(group.activity.state, 'blocked');
  assert.equal(current(state).activity.state, 'blocked');
  assert.equal(current(state).summary.attempts, 7);
  assert.equal(model.buildProgress(state, goal.id).current.state, 'blocked');
});

test('workflow progress uses authoritative diagnostic time including null instead of newer repeated production', () => {
  const firstProgress = '2026-09-18T01:00:00.000Z';
  const state = snapshot([leaf('task', { status: 'produced', runIds: ['run'] })], {
    runs: [{ id: 'run', nodeId: 'task', status: 'produced', producedAt: '2026-09-18T03:00:00.000Z' }],
    retryDiagnostics: [{ nodeId: 'task', attempts: 1, blocked: false, lastProgressAt: firstProgress }] });
  assert.equal(current(state).children[0].lastProgressAt, firstProgress);
  assert.equal(current(state).summary.lastProgressAt, firstProgress);
  state.retryDiagnostics[0].lastProgressAt = null;
  state.workflow = buildWorkflow(state);
  assert.equal(current(state).children[0].lastProgressAt, null);
  assert.equal(current(state).summary.lastProgressAt, null);
  assert.equal(model.buildProgress(state, goal.id).lastProgressAt, null);
});

test('workflow and main progress preserve admitted operations and existing candidates ahead of retry guards', () => {
  const nodes = [delivery('done'), leaf('running', { status: 'running' }), leaf('evaluating', { status: 'evaluating' }),
    leaf('integrating', { status: 'accepted' }), leaf('candidate', { status: 'produced' }),
    leaf('accepted', { status: 'accepted' }), leaf('review', { status: 'rejected' }), leaf('queued', { status: 'running' })];
  const state = snapshot(nodes, {
    runs: [{ id: 'run', nodeId: 'running', status: 'running' }, { id: 'pending', nodeId: 'queued', status: 'pending' }],
    evaluations: [{ id: 'eval', nodeId: 'evaluating', status: 'running' },
      { id: 'review-eval', nodeId: 'review', status: 'rejected', failure: { code: 'REVIEW_REQUIRED' } }],
    integrations: [{ id: 'integration', nodeId: 'integrating', status: 'running' }],
    retryDiagnostics: nodes.map(node => ({ nodeId: node.id, attempts: 7, blocked: true,
      code: 'logical-node-retry-budget-exhausted', message: 'budget exhausted', lastProgressAt: null })) });
  const expected = { done: 'delivered', running: 'running', evaluating: 'evaluating', integrating: 'integrating',
    candidate: 'awaiting-verification', accepted: 'awaiting-integration', review: 'awaiting-review', queued: 'queued' };
  for (const item of current(state).children) {
    assert.equal(item.activity.state, expected[item.id], item.id);
    assert.equal(item.flags.blocked, false, `${item.id}: admission guard does not block an existing result or operation`);
  }
  for (const item of model.buildProgress(state, goal.id).groups.flatMap(group => group.items)) {
    assert.equal(item.state, expected[item.id], `main progress: ${item.id}`);
  }
});

test('a confirmed dead owner marks only its active Run as recovery-required without rewriting durable state', () => {
  const state = snapshot([leaf('lost', { status: 'running' })], {
    runs: [{ id: 'lost-run', nodeId: 'lost', status: 'running' }],
    operational: { workspaceLease: { held: true, status: 'stale', reason: 'owner-dead', ownerAlive: false,
      lease: { ownerKind: 'run', ownerId: 'lost-run', runId: 'lost-run' } } },
    retryDiagnostics: [{ nodeId: 'lost', attempts: 7, blocked: true, code: 'logical-node-retry-budget-exhausted',
      message: 'budget exhausted', lastProgressAt: null }] });
  const item = current(state).children[0];
  assert.equal(item.activity.state, 'blocked');
  assert.equal(item.activity.label, '需恢复');
  assert.equal(item.activity.recoveryRequired, true);
  assert.match(item.activity.reason, /执行进程已退出/);
  assert.equal(item.flags.blocked, true);
  assert.equal(state.runs[0].status, 'running');
  assert.equal(state.nodes[0].status, 'running');
  assert.equal(model.buildProgress(state, goal.id).current.reason, item.activity.reason);
  for (const graph of [model.buildDag(state, goal.id), model.buildRefs(state, goal.id)]) {
    assert.equal(graph.nodes[0].tone, 'warning');
    assert.ok(graph.nodes[0].badges.some(label => label === '需恢复' || label === '当前：需恢复'));
    assert.equal(model.nodeDetails(state, 'lost').node.status, 'running');
  }
});

test('a live, unmatched or insufficiently confirmed lease owner never invents a lost Run', () => {
  const dead = { held: true, status: 'stale', reason: 'owner-dead', ownerAlive: false,
    lease: { ownerKind: 'run', ownerId: 'active-run', runId: 'active-run' } };
  const states = [{ ...dead, ownerAlive: true }, { ...dead, ownerAlive: null }, { ...dead, held: false },
    { ...dead, status: 'active' }, { ...dead, reason: 'lease-expired' },
    { ...dead, lease: { ownerKind: 'run', ownerId: 'different-run', runId: 'different-run' } },
    { ...dead, lease: { ownerKind: 'run', ownerId: 'active-run', runId: 'different-run' } }];
  for (const workspaceLease of states) {
    const state = snapshot([leaf('active', { status: 'running' })], {
      runs: [{ id: 'active-run', nodeId: 'active', status: 'running' }], operational: { workspaceLease } });
    assert.equal(current(state).children[0].activity.state, 'running', JSON.stringify(workspaceLease));
    assert.equal(current(state).children[0].activity.recoveryRequired, undefined);
  }
});

test('a dead batch owner covers its active member Runs and leaves another batch untouched', () => {
  const state = snapshot(['one', 'two', 'other'].map(id => leaf(id, { status: 'running' })), {
    runs: [{ id: 'r1', nodeId: 'one', batchId: 'lost-batch', status: 'running' },
      { id: 'r2', nodeId: 'two', batchId: 'lost-batch', status: 'pending' },
      { id: 'r3', nodeId: 'other', batchId: 'live-batch', status: 'running' }],
    operational: { workspaceLease: { held: true, status: 'stale', reason: 'owner-dead', ownerAlive: false,
      lease: { ownerKind: 'run-batch', ownerId: 'lost-batch' } } } });
  const items = new Map(current(state).children.map(item => [item.id, item]));
  assert.equal(items.get('one').activity.recoveryRequired, true);
  assert.equal(items.get('two').activity.recoveryRequired, true);
  assert.equal(items.get('other').activity.state, 'running');
  assert.equal(items.get('other').activity.recoveryRequired, undefined);
});
