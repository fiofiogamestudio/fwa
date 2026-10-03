import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkbenchController } from '../src/application/workbench-controller.js';
import { resolveNodeEffects } from '../src/core/refs.js';
import { findParallelConflicts, isNodeSchedulable } from '../src/core/scheduling.js';

const profile = { schemaVersion: 1, id: 'complete-profile', checks: [{ id: 'complete', kind: 'test',
  command: process.execPath, args: ['-e', ''], timeoutMs: 1000 }] };
const refContract = ({ id, kind, uri, version, hash, metadata }) => ({ id, kind, uri, version, hash, metadata });
const ref = (id, uri) => ({ id: `ref://code/${id}`, kind: 'code', uri, version: '1',
  hash: `sha256:${'a'.repeat(64)}`, metadata: {} });

// The fake application keeps durable outcomes in memory and applies the real
// core's conflict rules at admission. The controller still chooses submissions,
// prepares their input and continues through validation/integration itself.
function fixture(nodes, { refs = [], beforeBatch, onReference } = {}) {
  const state = { goals: [{ id: 'goal', status: 'active', request: 'Complete every result',
    integrationTargetRef: 'refs/heads/main' }], refs, workflow: { feedback: [] },
    nodes: nodes.map((node, index) => ({ goalId: 'goal', title: node.id, status: 'ready', validity: 'valid',
      dependsOn: [], reads: [], writes: [`src/${node.id}.js`], resources: [], readySequence: index,
      acceptance: { checks: ['complete'] }, runIds: [], changeSetIds: [], budget: { maxRetries: 1 },
      referenceInputs: [{ libraryId: node.id }], ...node })),
    runs: [], changeSets: [], evaluations: [], evidence: [], integrations: [], reversions: [], runBatches: [] };
  const submitted = [], batches = [], prepared = [];
  const application = { projectRoot: process.cwd(), getStatus: async () => structuredClone(state),
    async runReadyBatch({ executions, maxConcurrency, baseRevision }) {
      assert.equal(maxConcurrency, 4);
      assert.equal(baseRevision, 'HEAD');
      assert.ok(executions.length <= 4, 'Only the selected members may receive prepared prompts.');
      submitted.push(executions.map(item => item.nodeId));
      beforeBatch?.(state, submitted.length);
      const selected = [], deferred = [];
      const sorted = [...executions].sort((a, b) => {
        const left = state.nodes.find(node => node.id === a.nodeId), right = state.nodes.find(node => node.id === b.nodeId);
        return left.readySequence - right.readySequence || left.id.localeCompare(right.id);
      });
      for (const execution of sorted) {
        const node = state.nodes.find(item => item.id === execution.nodeId);
        assert.equal(isNodeSchedulable(node, state.nodes, state.goals[0]), true);
        const effects = resolveNodeEffects(node, state.refs.map(refContract));
        const candidate = { nodeId: node.id, reads: effects.reads, writes: effects.writes, resources: node.resources };
        if (findParallelConflicts([...selected.map(item => item.candidate), candidate], { ignoreCase: false }).length) {
          deferred.push({ nodeId: node.id, code: 'parallel-effect-conflict' });
        } else selected.push({ node, candidate });
      }
      assert.ok(selected.length > 0);
      batches.push(selected.map(item => item.node.id));
      const members = selected.map(({ node, candidate }) => {
        const runId = `run-${node.id}`, changeSetId = `change-${node.id}`;
        const run = { id: runId, nodeId: node.id, goalId: 'goal', status: 'produced', workspaceStatus: 'removed', changeSetId };
        const changeSet = { id: changeSetId, nodeId: node.id, goalId: 'goal', runId, kind: 'execution', valid: true,
          changedFiles: candidate.writes, commits: [`commit-${node.id}`] };
        state.runs.push(run); state.changeSets.push(changeSet);
        node.runIds.push(runId); node.changeSetIds.push(changeSetId); node.status = 'produced';
        return { nodeId: node.id, runId, ok: true, changeSet };
      });
      return { ok: true, batch: { id: `batch-${batches.length}` }, members, deferred };
    } };
  const controller = new WorkbenchController(application, { planner: null, executor: { execute() {} }, validationProfiles: [profile] });
  controller.referenceContext = async bindings => {
    prepared.push(bindings[0].libraryId);
    onReference?.(state, prepared.length);
    return { references: [], images: [] };
  };
  controller.review = { config: { completionPolicy: { mode: 'automatic' } },
    async validateCandidate() { return { ok: true }; },
    async finishCandidate({ changeSetId }) {
      const change = state.changeSets.find(item => item.id === changeSetId), node = state.nodes.find(item => item.id === change.nodeId);
      Object.assign(node, { status: 'accepted', acceptedChangeSetId: changeSetId, integratedChangeSetId: changeSetId,
        integrationStatus: 'integrated', integratedTargetRef: 'refs/heads/main' });
      return { ok: true, finished: true, phase: 'integrated' };
    } };
  return { state, submitted, batches, prepared, controller,
    run: nodeId => controller.runGoal({ commandId: 'select-batches', goalId: 'goal', ...(nodeId ? { nodeId } : {}) }) };
}

test('six ready nodes use two batches when A conflicts with B/C/D and E/F are independent', async t => {
  const f = fixture([{ id: 'A', writes: ['src/b.js', 'src/c.js', 'src/d.js'] },
    { id: 'B', writes: ['src/b.js'] }, { id: 'C', writes: ['src/c.js'] }, { id: 'D', writes: ['src/d.js'] },
    { id: 'E' }, { id: 'F' }]);
  const result = await f.run();
  t.diagnostic(JSON.stringify({ submitted: f.submitted, batches: f.batches, prepared: f.prepared }));
  assert.equal(result.stopReason, 'goal-completed');
  assert.equal(f.batches.length, 2, 'Conflict-free later work must fill the first batch instead of waiting for a third batch.');
  assert.deepEqual(f.batches, [['A', 'E', 'F'], ['B', 'C', 'D']]);
  assert.deepEqual(f.submitted, f.batches);
  assert.deepEqual(f.prepared, ['A', 'E', 'F', 'B', 'C', 'D'], 'Deferred nodes must not repeatedly materialize reference inputs.');
});

for (const scenario of [
  { name: 'different logical Refs resolving to the same URI', refs: [ref('left', 'src/shared.js'), ref('right', 'src/shared.js')],
    left: { writes: ['ref://code/left'] }, right: { writes: ['ref://code/right'] } },
  { name: 'a logical Ref resolving onto a literal path', refs: [ref('left', 'src/shared.js')],
    left: { writes: ['ref://code/left'] }, right: { writes: ['src/shared.js'] } },
  { name: 'a shared resource regardless of case', left: { resources: ['Unity.Editor'] }, right: { resources: ['unity.editor'] } },
  { name: 'writes overlapping later reads', left: { writes: ['src/shared.js'] }, right: { reads: ['src/shared.js'] } },
  { name: 'reads overlapping later writes', left: { reads: ['src/shared.js'] }, right: { writes: ['src/shared.js'] } },
  { name: 'case-insensitive path overlap during conservative preselection', left: { writes: ['src/Shared.js'] }, right: { writes: ['src/shared.js'] } }
]) test(`preselection defers ${scenario.name} and prepares only admitted inputs`, async () => {
  const f = fixture([{ id: 'A', ...scenario.left }, { id: 'B', ...scenario.right }, { id: 'C' }], { refs: scenario.refs });
  assert.equal((await f.run()).stopReason, 'goal-completed');
  assert.deepEqual(f.submitted, [['A', 'C'], ['B']]);
  assert.deepEqual(f.batches, f.submitted);
  assert.deepEqual(f.prepared, ['A', 'C', 'B']);
});

test('preselection retains ready order and the four-member limit', async () => {
  const ids = ['z', 'y', 'x', 'w', 'v', 'u', 't', 's', 'r'];
  const f = fixture(ids.map(id => ({ id })));
  assert.equal((await f.run()).stopReason, 'goal-completed');
  assert.deepEqual(f.submitted, [ids.slice(0, 4), ids.slice(4, 8), ids.slice(8)]);
  assert.deepEqual(f.prepared, ids);
});

test('explicit node selection and missing validation profiles retain their existing boundaries', async () => {
  const nodes = [{ id: 'A', acceptance: { checks: ['unconfigured'] } }, { id: 'B' }, { id: 'C' }];
  const selected = fixture(nodes);
  assert.equal((await selected.run('C')).stopReason, 'selected-leaf-processed');
  assert.deepEqual(selected.submitted, [['C']]);
  assert.deepEqual(selected.prepared, ['C']);
  const all = fixture(nodes), result = await all.run();
  assert.equal(result.stopReason, 'needs-validation-profile');
  assert.deepEqual(result.nodeIds, ['A']);
  assert.deepEqual(all.submitted, [['B', 'C']]);
});

test('feedback received while selected inputs materialize still prevents dispatch', async () => {
  const f = fixture([{ id: 'A' }, { id: 'B' }], { onReference(state) {
    state.workflow.feedback = [{ id: 'feedback', goalId: 'goal', status: 'pending' }];
  } });
  assert.equal((await f.run()).stopReason, 'awaiting-feedback-revision');
  assert.deepEqual(f.submitted, []);
});

test('atomic admission may still defer a preselected node when its effects change', async () => {
  const f = fixture([{ id: 'A' }, { id: 'B' }, { id: 'C' }], { beforeBatch(state, batch) {
    if (batch === 1) state.nodes.find(node => node.id === 'B').writes = ['src/A.js'];
  } });
  assert.equal((await f.run()).stopReason, 'goal-completed');
  assert.deepEqual(f.submitted, [['A', 'B', 'C'], ['B']]);
  assert.deepEqual(f.batches, [['A', 'C'], ['B']]);
});
