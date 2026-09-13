import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/editor/app/workbench-model.js', import.meta.url), 'utf8');
function load(context = { window: {} }) {
  vm.runInNewContext(source, context, { filename: 'workbench-model.js' });
  return context.window?.FwaWorkbenchModel ?? context.module?.exports ?? context.FwaWorkbenchModel;
}
const model = load();
const plain = value => JSON.parse(JSON.stringify(value));
const node = (id, fields = {}) => ({ id, title: `节点 ${id}`, goalId: 'goal', status: 'planned', validity: 'valid',
  integrationStatus: null, dependsOn: [], reads: [], writes: [], ...fields });
const ref = (id, fields = {}) => ({ id: `ref://design/${id}`, kind: 'design', uri: `brief/${id}.md`, version: 'v1', ...fields });
function state(nodes = [], fields = {}) {
  return { goals: [{ id: 'goal', status: 'active', integrationTargetRef: 'main' }], nodes,
    refs: [], runs: [], changeSets: [], evaluations: [], evidence: [], integrations: [], reversions: [], ...fields };
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

test('UMD supports a browser global, CommonJS-like vm and globalThis without dependencies', () => {
  for (const context of [{ window: {} }, { module: { exports: {} } }, {}]) {
    assert.equal(typeof load(context).buildDag, 'function');
  }
  assert.deepEqual(Object.keys(model).sort(), ['buildDag', 'buildRefs', 'nodeDetails', 'statusLabel', 'tone'].sort());
});

test('unknown states are retained, missing state is not a fabricated metric or success', () => {
  // A historical Run stays produced after its separate Evidence is evaluated.
  assert.equal(model.statusLabel('produced'), '已产出');
  assert.equal(model.statusLabel('accepted'), '已验收');
  assert.equal(model.statusLabel('integrated'), '已集成');
  assert.equal(model.statusLabel('new-state'), 'new-state');
  assert.equal(model.statusLabel('__proto__'), '__proto__');
  assert.equal(model.statusLabel(null), '未记录');
  assert.equal(model.tone('produced'), 'warning');
  assert.equal(model.tone('valid'), 'neutral');
  assert.equal(model.tone(undefined), 'neutral');
});

test('empty and unknown-goal projections have no dangling graph entries', () => {
  assert.deepEqual(plain(model.buildDag()), { nodes: [], edges: [] });
  assert.deepEqual(plain(model.buildRefs()), { nodes: [], edges: [] });
  assert.equal(model.nodeDetails({}, 'absent'), null);
  const input = state([node('one')], { refs: [ref('orphan')] });
  assert.deepEqual(plain(model.buildRefs(input, 'absent')), { nodes: [], edges: [] });
});

test('DAG preserves a split and multi-predecessor merge with prerequisite-to-dependent direction', () => {
  const input = state([node('merge', { dependsOn: ['left', 'right'] }), node('root'),
    node('right', { dependsOn: ['root'] }), node('left', { dependsOn: ['root'] })]);
  const graph = model.buildDag(input);
  assert.deepEqual(graph.nodes.map(item => item.id).join(','), 'left,merge,right,root');
  assert.deepEqual(plain(graph.edges.map(item => [item.source, item.target]).sort()),
    [['left', 'merge'], ['right', 'merge'], ['root', 'left'], ['root', 'right']]);
});

test('hierarchical DAG keeps containment separate from dependencies and hides superseded leaves', () => {
  const input = state([node('old', { supersededByRevision: 2 }), node('source'), node('current', { dependsOn: ['source'] })], {
    workflow: { goals: [{ id: 'goal', children: [{ id: 'bundle', type: 'group', title: '分组', phase: 'ready', flags: {},
      children: [{ id: 'source', type: 'node' }, { id: 'current', type: 'node' }] }] }] }
  });
  const graph = model.buildDag(input, 'goal');
  assert.deepEqual(plain(graph.nodes.map(item => item.id)), ['bundle', 'current', 'source']);
  assert.deepEqual(plain(graph.edges.filter(item => item.kind === 'containment').map(item => [item.source, item.target, item.label])),
    [['bundle', 'current', '包含'], ['bundle', 'source', '包含']]);
  assert.deepEqual(plain(graph.edges.filter(item => item.kind === 'dependency').map(item => [item.source, item.target, item.label])),
    [['source', 'current', '前置依赖']]);
});

test('all-goals DAG namespaces equal group IDs without mixing containment or navigation identity', () => {
  const input = state([node('a'), node('b', { goalId: 'other' })], { workflow: { goals: ['goal', 'other'].map((id, index) => ({
    id, children: [{ type: 'group', id: 'shared', title: id, phase: 'plan', children: [{ type: 'node', id: index ? 'b' : 'a' }] }]
  })) } });
  const graph = model.buildDag(input);
  const groups = graph.nodes.filter(item => item.objectType === 'groups');
  assert.equal(groups.length, 2);
  assert.equal(new Set(graph.nodes.map(item => item.id)).size, graph.nodes.length);
  for (const group of groups) {
    assert.equal(group.objectId, 'shared');
    assert.ok(graph.edges.some(edge => edge.source === group.id && edge.target === (group.goalId === 'goal' ? 'a' : 'b')));
  }
});

test('goal filtering, duplicate declarations and missing prerequisites cannot create dangling edges', () => {
  const input = state([node('first'), node('second', { dependsOn: ['first', 'first', 'foreign', 'absent'] }),
    node('foreign', { goalId: 'other' })]);
  const graph = model.buildDag(input, 'goal');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].source, 'first');
  const details = model.nodeDetails(input, 'second');
  assert.ok(details.blockers.some(value => value.includes('absent') && value.includes('未记录')));
});

test('DAG exposes three independent state dimensions and never promotes planned or produced status', () => {
  const input = state([node('rejected', { status: 'rejected' }),
    node('pending', { dependsOn: ['rejected'] }), node('candidate', { status: 'produced' }),
    node('accepted', { status: 'accepted' }),
    node('stale', { status: 'accepted', validity: 'stale', integrationStatus: 'integrated' }),
    node('complete', { status: 'accepted', validity: 'valid', integrationStatus: 'integrated' })]);
  const graph = model.buildDag(input);
  const cards = new Map(graph.nodes.map(item => [item.id, item]));
  assert.equal(cards.get('candidate').tone, 'warning');
  assert.equal(cards.get('accepted').tone, 'neutral');
  assert.equal(cards.get('stale').tone, 'warning');
  assert.equal(cards.get('complete').tone, 'success');
  assert.deepEqual(plain(cards.get('stale').badges), ['状态：已验收', '有效性：已过期', '集成：已集成']);
  const pending = model.nodeDetails(input, 'pending');
  assert.equal(pending.node.status, 'planned');
  assert.ok(pending.blockers.some(value => value.includes('已拒绝')));
});

test('Refs graph contains declared logical reads/writes only, with explicit direction and meaning', () => {
  const input = state([node('work', { reads: ['ref://design/input', 'brief/physical.md', 'ref://design/unknown'],
    writes: ['ref://design/output', 'ref://design/output'] })], { refs: [ref('input'), ref('output'), ref('unused')],
    runs: [{ id: 'run', nodeId: 'work', effects: { consumedRefs: [{ id: 'ref://design/unused' }] } }] });
  const graph = model.buildRefs(input);
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 2);
  assert.deepEqual(plain(graph.edges.map(item => [item.source, item.target, item.label]).sort()), [
    ['node:work', 'ref://design/output', '声明写入'], ['ref://design/input', 'node:work', '声明读取']
  ]);
  assert.equal(graph.nodes.find(item => item.id === 'ref://design/input').tone, 'neutral');
});

test('filtered Refs graph retains shared inputs but excludes unrelated references and other goal Nodes', () => {
  const input = state([node('own', { reads: ['ref://design/shared'] }),
    node('other', { goalId: 'other', reads: ['ref://design/shared'], writes: ['ref://design/private'] })],
  { refs: [ref('shared'), ref('private'), ref('unused')] });
  const graph = model.buildRefs(input, 'goal');
  assert.deepEqual(plain(graph.nodes.map(item => item.id)), ['node:own', 'ref://design/shared']);
  assert.equal(graph.edges.length, 1);
  assert.ok(graph.edges.every(item => graph.nodes.some(candidate => candidate.id === item.source)
    && graph.nodes.some(candidate => candidate.id === item.target)));
});

test('bidirectional Ref declarations and punctuation IDs have distinct stable edge identities', () => {
  const input = state([node('one:two', { reads: ['ref://design/same'], writes: ['ref://design/same'] })], { refs: [ref('same')] });
  const graph = model.buildRefs(input);
  assert.equal(new Set(graph.edges.map(item => item.id)).size, 2);
  assert.deepEqual(plain(graph), plain(model.buildRefs(input)));
});

test('details retain all historical attempts, evidence and revert links without importing another Node', () => {
  const input = state([node('work', { reads: ['ref://design/current'], runIds: ['r1', 'r2'] })], {
    refs: [ref('current'), ref('old'), ref('unrelated')],
    runs: [{ id: 'r1', nodeId: 'work', status: 'failed', effects: { consumedRefs: [{ id: 'ref://design/old' }] } },
      { id: 'r2', nodeId: 'work', status: 'produced' }, { id: 'r3', nodeId: 'other' }],
    changeSets: [{ id: 'c1', runId: 'r1' }, { id: 'c2', nodeId: 'work', runId: 'r2' }, { id: 'foreign', nodeId: 'other', runId: 'r2' }],
    evaluations: [{ id: 'eval1', changeSetId: 'c1' }, { id: 'eval2', nodeId: 'work', changeSetId: 'c2' }],
    evidence: [{ id: 'ev1', evaluationId: 'eval1' }, { id: 'ev2', nodeId: 'work', changeSetId: 'c2' }],
    integrations: [{ id: 'i1', changeSetId: 'c2' }],
    reversions: [{ id: 'rev1', sourceChangeSetId: 'c2', integrationId: 'i1' }]
  });
  const details = model.nodeDetails(input, 'work');
  for (const key of ['runs', 'changeSets', 'evaluations', 'evidence', 'refs']) assert.equal(details[key].length, 2, key);
  assert.equal(details.integrations.length, 1);
  assert.equal(details.reversions.length, 1);
  assert.equal(details.goal.id, 'goal');
  assert.ok(!details.changeSets.some(item => item.id === 'foreign'));
});

test('dependency eligibility checks accepted/valid/integrated and matching ChangeSet/target bindings', () => {
  const prerequisite = node('before', { status: 'accepted', integrationStatus: 'integrated',
    acceptedChangeSetId: 'c', integratedChangeSetId: 'c', integratedTargetRef: 'main' });
  const input = state([prerequisite, node('after', { status: 'ready', dependsOn: ['before'] })]);
  assert.equal(model.nodeDetails(input, 'after').blockers.length, 0);
  prerequisite.integratedTargetRef = 'other';
  prerequisite.integratedChangeSetId = 'old';
  const details = model.nodeDetails(input, 'after');
  assert.ok(details.blockers.some(value => value.includes('目标分支不一致')));
  assert.ok(details.blockers.some(value => value.includes('变更集绑定不一致')));
});

test('unknown goal, absent validity, real fences and exhausted attempt budgets are explained without guessing', () => {
  const input = state([node('work', { goalId: 'missing', validity: null, runIds: ['r1', 'r2'], budget: { maxRetries: 1 } })],
    { operational: { gitProcessFence: { held: true }, workspaceLease: { held: true } } });
  const details = model.nodeDetails(input, 'work');
  assert.equal(details.goal, null);
  assert.ok(details.blockers.some(value => value.includes('未记录')));
  assert.ok(details.blockers.some(value => value.includes('预算已用尽')));
  assert.ok(details.blockers.some(value => value.includes('Git 安全阻断')));
  assert.ok(details.blockers.some(value => value.includes('租约被占用')));
  assert.equal(model.nodeDetails(state([node('normal')]), 'normal').blockers.length, 0);
});

test('own rejection and unaccepted production are visible even without a dependency blocker', () => {
  const input = state([node('rejected', { status: 'rejected' }), node('candidate', { status: 'produced' }),
    node('accepted', { status: 'accepted' }), node('failed', { status: 'failed' })]);
  assert.ok(model.nodeDetails(input, 'rejected').blockers.some(value => value.includes('明确申请重试')));
  assert.ok(model.nodeDetails(input, 'candidate').blockers.some(value => value.includes('尚未独立验收')));
  assert.ok(model.nodeDetails(input, 'accepted').blockers.some(value => value.includes('尚未集成')));
  assert.ok(model.nodeDetails(input, 'failed').blockers.some(value => value.includes('当前失败')));
});

test('projections never mutate frozen input and details do not hand out mutable source references', () => {
  const input = deepFreeze(state([node('work', { reads: ['ref://design/one'] })], { refs: [ref('one')] }));
  const before = JSON.stringify(input);
  model.buildDag(input); model.buildRefs(input);
  const details = model.nodeDetails(input, 'work');
  details.node.title = 'local edit'; details.refs[0].version = 'local version';
  assert.equal(JSON.stringify(input), before);
});
