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

test('automatic continuation resumes a validated candidate while manual contracts still await confirmation', () => {
  const data = state([node('candidate', { status: 'accepted', changeSetIds: ['change'],
    acceptedChangeSetId: 'change', acceptance: { checks: ['feature-check'] } })], {
    changeSets: [{ id: 'change', nodeId: 'candidate', valid: true, kind: 'execution', changedFiles: ['feature.js'] }]
  });
  const session = { allowWrite: true, workflow: { work: true }, review: { configured: true, completionMode: 'automatic',
    manualProfiles: [], validationProfiles: [{ id: 'feature', checks: [{ id: 'feature-check' }] }] } };
  assert.equal(model.workAvailability(data, session, 'goal').allowed, true);
  session.review.manualProfiles = ['feature'];
  assert.equal(model.workAvailability(data, session, 'goal').allowed, false);
  assert.equal(model.workAvailability(data, session, 'goal').reason, '已有结果待确认并收束。');
  session.review.manualProfiles = []; session.review.completionMode = 'manual';
  assert.equal(model.workAvailability(data, session, 'goal').allowed, false);
  session.review.completionMode = 'automatic'; data.changeSets[0].valid = false;
  assert.equal(model.workAvailability(data, session, 'goal').allowed, false);
});

test('overview keeps recovery visible in read-only mode and never calls uncertain occupancy running', () => {
  const data = state([node('lost', { status: 'running' })], {
    operational: { workspaceLease: { held: true, ownerAlive: false } }
  });
  const overview = model.buildOverview(data, { allowWrite: false }, 'goal');
  assert.match(overview.nextText, /中断.*恢复/);
  assert.equal(overview.actionKind, 'focus');
  data.nodes[0].status = 'planned';
  data.operational.workspaceLease.ownerAlive = null;
  assert.equal(model.buildOverview(data, { allowWrite: false }, 'goal').nextText, '工作区占用状态待核查。');
});

test('overview prioritizes admitted independent work and only offers viewing for unverified or empty candidates', () => {
  const session = { allowWrite: true, workflow: { work: true } };
  const data = state([node('failed', { status: 'failed' }), node('ready', { status: 'ready' })]);
  const overview = model.buildOverview(data, session, 'goal');
  assert.equal(overview.actionKind, 'work');
  assert.match(overview.nextText, /1 项可推进/);
  data.nodes = [node('candidate', { status: 'produced', changeSetIds: ['change'] })];
  data.changeSets = [{ id: 'change', nodeId: 'candidate', changedFiles: [] }];
  const empty = model.buildOverview(data, session, 'goal');
  assert.equal(empty.actionKind, 'focus');
  assert.match(empty.nextText, /未产生文件改动/);
  assert.doesNotMatch(empty.nextText, /确认.*完成/);
  assert.match(model.nodeWorkbench(data, 'candidate').resultSummary, /未产生文件改动/);
});

test('overview avoids duplicate completion counts, cross-goal execution and false completion', () => {
  const data = state([node('done', { status: 'accepted', integrationStatus: 'integrated',
    acceptedChangeSetId: 'change', integratedChangeSetId: 'change', integratedTargetRef: 'main' })]);
  const done = model.buildOverview(data, { allowWrite: false }, 'goal');
  assert.equal(done.progressText, '已完成 1 / 1');
  assert.equal(done.nextText, '全部结果已确认并集成。');
  assert.equal(done.actionKind, '');
  data.nodes[0].integratedChangeSetId = 'other';
  assert.equal(model.buildOverview(data, { allowWrite: false }, 'goal').progressText, '已完成 0 / 1');
  const all = model.buildOverview(data, { allowWrite: true, workflow: { work: true } }, null);
  assert.equal(all.actionKind, '');
  assert.match(all.nextText, /选择一个任务/);
});

test('UMD supports a browser global, CommonJS-like vm and globalThis without dependencies', () => {
  for (const context of [{ window: {} }, { module: { exports: {} } }, {}]) {
    assert.equal(typeof load(context).buildDag, 'function');
  }
  assert.deepEqual(Object.keys(model).sort(), ['buildDag', 'buildRefs', 'buildProgress', 'buildOverview', 'nodeDetails', 'nodeWorkbench', 'workAvailability', 'statusLabel', 'tone'].sort());
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

test('the executable DAG contains only real outcome nodes and dependency edges, even with nested groups', () => {
  const input = state([node('old', { supersededByRevision: 2 }), node('source'), node('current', { dependsOn: ['source'] })], {
    workflow: { goals: [{ id: 'goal', children: [{ id: 'bundle', type: 'group', title: 'Feature', flags: { blocked: true }, children: [
      { id: 'nested', type: 'group', children: [{ id: 'source', type: 'node' }, { id: 'current', type: 'node' }] }
    ] }] }] }
  });
  const graph = model.buildDag(input, 'goal');
  assert.deepEqual(plain(graph.nodes.map(item => item.id)), ['current', 'source']);
  assert.equal(graph.edges.length, 1); assert.equal(graph.edges[0].kind, 'dependency');
  assert.equal(graph.nodes.some(item => item.objectType === 'groups'), false);
  assert.equal(graph.edges.some(item => item.kind === 'containment'), false);
});

test('all-goals DAG has no group placeholder nodes or containment arrows', () => {
  const input = state([node('a'), node('b', { goalId: 'other' })], { workflow: { goals: ['goal', 'other'].map((id, index) => ({
    id, children: [{ type: 'group', id: 'shared', title: id, children: [{ type: 'node', id: index ? 'b' : 'a' }] }]
  })) } });
  assert.deepEqual(plain(model.buildDag(input).nodes.map(item => item.id)), ['a', 'b']);
  assert.equal(model.buildDag(input).edges.length, 0);
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

test('DAG shows one understandable current state while details preserve independent technical facts', () => {
  const input = state([node('rejected', { status: 'rejected' }),
    node('pending', { dependsOn: ['rejected'] }), node('candidate', { status: 'produced' }),
    node('accepted', { status: 'accepted' }),
    node('stale', { status: 'accepted', validity: 'stale', integrationStatus: 'integrated' }),
    node('complete', { status: 'accepted', validity: 'valid', integrationStatus: 'integrated' })]);
  const graph = model.buildDag(input);
  const cards = new Map(graph.nodes.map(item => [item.id, item]));
  assert.equal(cards.get('candidate').tone, 'neutral');
  assert.equal(cards.get('accepted').tone, 'neutral');
  assert.equal(cards.get('stale').tone, 'warning');
  assert.equal(cards.get('complete').tone, 'neutral');
  assert.deepEqual(plain(cards.get('stale').badges), ['受阻']);
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


test('node workbench exposes outcome, authored completion checks and per-edge reasons without fabricating old reasons', () => {
  const input = state([node('source'), node('target', { outcome: 'A usable report', instruction: 'Implement report export', dependsOn: ['source'],
    dependencyReasons: [{ nodeId: 'source', reason: 'Needs the normalized input schema' }], derivedFrom: 'original', acceptance: { checks: ['Export opens', { id: 'lint', description: 'Lint passes' }] } })]);
  const detail = model.nodeWorkbench(input, 'target');
  assert.equal(detail.outcome, 'A usable report'); assert.equal(detail.dependencies[0].reason, 'Needs the normalized input schema');
  assert.deepEqual(plain(detail.completion), [{ text: 'Export opens' }, { text: 'Lint passes' }]);
  assert.match(detail.derivedText, /original/); assert.match(detail.resultSummary, /尚无/);
  delete input.nodes[1].dependencyReasons;
  assert.equal(model.nodeWorkbench(input, 'target').dependencies[0].reason, '依赖原因未记录');
  assert.equal(model.buildDag(input).edges[0].reason, '依赖原因未记录');
});

test('work admission blocks duplicate jobs, lease/fence, pending feedback and hard budgets but permits explicit repaired input checks', () => {
  const session = { allowWrite: true, workflow: { work: true }, review: { configured: true } };
  const input = state([node('ready', { status: 'ready' })]);
  const check = (jobs = []) => model.workAvailability(input, session, 'goal', 'ready', jobs);
  assert.equal(check().allowed, true);
  assert.equal(check([{ state: 'running' }]).allowed, false);
  input.operational = { workspaceLease: { held: true, ownerAlive: false } }; assert.match(check().reason, /恢复/);
  input.operational = { gitProcessFence: { held: true } }; assert.equal(check().allowed, false);
  delete input.operational;
  input.workflow = { feedback: [{ goalId: 'goal', status: 'pending' }] }; assert.match(check().reason, /补充要求/);
  input.workflow.feedback = [];
  input.retryDiagnostics = [{ nodeId: 'ready', blocked: true, code: 'logical-node-retry-budget-exhausted' }]; assert.equal(check().allowed, false);
  for (const code of ['retry-input-repair-required', 'retry-no-progress']) {
    input.retryDiagnostics[0].code = code; assert.equal(check().allowed, true); assert.equal(check().repairRequired, true);
  }
  session.allowWrite = false; assert.match(check().reason, /只读/);
  session.allowWrite = true; session.review.configured = false; assert.match(check().reason, /检查配置/);
});

test('continuing an existing candidate requires current valid nonempty output and never enables accepted delivery for new work', () => {
  const session = { allowWrite: true, workflow: { work: true }, review: { configured: true } };
  const input = state([node('candidate', { status: 'produced', changeSetIds: ['c'] })], { changeSets: [{ id: 'c', nodeId: 'candidate', valid: true, kind: 'execution', changedFiles: ['report.md'] }] });
  const check = () => model.workAvailability(input, session, 'goal', 'candidate');
  assert.equal(check().allowed, true);
  input.changeSets[0].changedFiles = []; assert.equal(check().allowed, false);
  input.changeSets[0].changedFiles = ['report.md']; input.nodes[0].status = 'accepted'; assert.equal(check().allowed, false);
});
