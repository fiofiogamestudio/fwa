import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { FwaApplication, canonicalizePlan } from '../src/application/fwa-application.js';
import { projectEvents } from '../src/application/projection.js';
import { validatePlan, topologicalSort } from '../src/core/dag.js';
import { buildWorkflow } from '../src/core/workflow.js';
import { createEvent } from '../src/core/events.js';
import { FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { CommandEvaluator } from '../src/adapters/command-evaluator.js';

const execute = promisify(execFile);
const git = (cwd, args) => execute('git', args, { cwd, windowsHide: true, timeout: 30000 });
const leaf = (id, extra = {}) => ({ id, title: id, dependsOn: [], reads: ['seed.txt'], writes: [`${id}.txt`],
  capabilities: ['file_operations'], acceptance: { checks: ['test'] },
  budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 50 }, ...extra });
const hierarchical = () => ({ schemaVersion: 1, groups: [
  { id: 'feature', title: 'Feature' }, { id: 'rules', title: 'Rules', parentId: 'feature' }
], nodes: [leaf('source', { parentId: 'rules', instruction: 'Implement the source.' }),
  leaf('consumer', { parentId: 'feature', dependsOn: ['source'] }), leaf('independent')] });

async function fixture(t, plan = hierarchical(), realGit = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  if (realGit) {
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.name', 'FWA Workflow Test']);
    await git(root, ['config', 'user.email', 'workflow@example.invalid']);
    await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
    await writeFile(path.join(root, 'seed.txt'), 'base\n');
    await git(root, ['add', '.']); await git(root, ['commit', '-m', 'test: baseline']);
  }
  const app = new FwaApplication(root); await app.init();
  const goal = (await app.createGoal({ title: 'Hierarchical workflow', commandId: 'goal' })).goal;
  await app.loadPlan({ goalId: goal.id, plan, commandId: 'plan' });
  return { root, app, goal };
}

test('groups form a decomposition forest independent of the executable dependency DAG', () => {
  const plan = hierarchical();
  assert.equal(validatePlan(plan).ok, true);
  assert.deepEqual(topologicalSort(plan), ['source', 'consumer', 'independent']);
  for (const invalid of [
    { ...plan, groups: [{ id: 'source', title: 'Collision' }] },
    { ...plan, groups: [{ id: 'feature', title: 'Self', parentId: 'feature' }] },
    { ...plan, groups: [{ id: 'feature', title: 'A', parentId: 'rules' }, { id: 'rules', title: 'B', parentId: 'feature' }] },
    { ...plan, groups: [...plan.groups, { id: 'empty', title: 'Empty' }] },
    { ...plan, nodes: [leaf('source', { parentId: 'independent' }), leaf('independent')] },
    { ...plan, nodes: [leaf('source', { dependsOn: ['feature'] })] }
  ]) assert.equal(validatePlan(invalid).ok, false);
});

test('instruction, resource claims and virtual reference snapshots are strict authored fields', () => {
  const node = leaf('source', { instruction: 'Read the frozen design.', resources: ['godot-editor'],
    referenceInputs: [{ libraryId: 'design', versionId: 'v1', manifestHash: `sha256:${'1'.repeat(64)}` }] });
  const plan = canonicalizePlan({ nodes: [node] });
  assert.deepEqual(plan.nodes[0].referenceInputs, node.referenceInputs);
  assert.deepEqual(plan.nodes[0].reads, ['seed.txt']);
  for (const patch of [{ instruction: ' ' }, { resources: ['one', 'one'] },
    { referenceInputs: [{ ...node.referenceInputs[0], extra: true }] },
    { referenceInputs: [...node.referenceInputs, ...node.referenceInputs] },
    { referenceInputs: [{ ...node.referenceInputs[0], manifestHash: 'unverified' }] }
  ]) assert.equal(validatePlan({ nodes: [{ ...node, ...patch }] }).ok, false);
});

test('recursive phases keep failure/pause/feedback flags separate and require accepted valid integrated output for done', () => {
  const goal = { id: 'goal', title: 'Goal', planId: 'plan', nodeIds: ['a', 'b'], runIds: [],
    groups: [{ id: 'group', title: 'Group' }], integrationTargetRef: 'refs/heads/main' };
  const node = (id, status = 'planned', extra = {}) => ({ ...leaf(id), goalId: goal.id, parentId: 'group', status,
    validity: 'valid', runIds: [], integrationStatus: null, ...extra });
  const done = id => node(id, 'accepted', { runIds: [`run-${id}`], integrationStatus: 'integrated',
    acceptedChangeSetId: `cs-${id}`, integratedChangeSetId: `cs-${id}`, integratedTargetRef: goal.integrationTargetRef });
  const phases = entries => buildWorkflow({ goals: [goal], nodes: entries }).goals[0];
  assert.equal(phases([node('a'), node('b')]).phase, 'plan');
  assert.equal(phases([node('a', 'ready'), node('b')]).phase, 'ready');
  assert.equal(phases([done('a'), node('b')]).phase, 'work');
  assert.equal(phases([done('a'), done('b')]).phase, 'done');
  assert.equal(phases([done('a'), { ...done('b'), validity: 'stale' }]).phase, 'work');
  assert.equal(phases([done('a'), node('b', 'accepted')]).phase, 'work');
  const state = buildWorkflow({ goals: [goal], nodes: [node('a', 'failed', { runIds: ['r'] }), node('b')],
    runs: [{ id: 'r', nodeId: 'a', status: 'paused' }],
    nodeFeedback: [{ id: 'fb', nodeId: 'a', logicalId: 'a', goalId: 'goal', status: 'pending' }] }).goals[0];
  assert.equal(state.phase, 'work');
  assert.equal(state.children[0].phase, 'work');
  assert.deepEqual(state.flags, { failed: true, paused: true, pendingFeedback: true, stale: false, blocked: false });
});

test('an explicit revision replaces only affected physical leaves, applies bound feedback and preserves flat compatibility', async t => {
  const { app, goal } = await fixture(t);
  const initial = await app.getStatus();
  assert.equal(initial.nodes.length, 3);
  assert.equal(initial.workflow.goals[0].children[0].type, 'group');
  const feedback = await app.submitNodeFeedback({ nodeId: 'source', text: 'Change source behavior.', commandId: 'feedback' });
  assert.equal(feedback.feedback.status, 'pending');
  assert.equal(feedback.deferred, false);
  assert.equal((await app.submitNodeFeedback({ nodeId: 'source', text: 'Change source behavior.', commandId: 'feedback' })).appended, false);
  const plan = structuredClone(initial.workflow.revisions.at(-1).plan);
  plan.nodes[0].instruction = 'Implement the revised source.';
  const secondFeedback = await app.submitNodeFeedback({ nodeId: 'source', text: 'Preserve the intended input shape.', commandId: 'feedback-two' });
  const command = { goalId: goal.id, expectedRevision: 1, plan, reason: 'Operator revision',
    feedbackIds: [feedback.feedback.id, secondFeedback.feedback.id], commandId: 'revision' };
  await assert.rejects(app.revisePlan({ ...command, commandId: 'incomplete-feedback', feedbackIds: [feedback.feedback.id] }),
    { code: 'feedback-revision-incomplete' });
  assert.ok((await app.getStatus()).workflow.feedback.every(item => item.status === 'pending'));
  const revised = await app.revisePlan(command);
  assert.equal(revised.revision.revision, 2);
  assert.deepEqual(revised.nodeBindings.map(item => item.nodeId), ['source@revision-2', 'consumer@revision-2', 'independent']);
  assert.equal(revised.nodes.find(item => item.id === 'source@revision-2').definitionRevision, 2);
  assert.equal(revised.nodes.find(item => item.id === 'source@revision-2').status, 'ready');
  assert.equal(revised.feedback[0].status, 'applied');
  assert.equal((await app.revisePlan(command)).appended, false);
  await assert.rejects(app.revisePlan({ ...command, commandId: 'old-revision' }), { code: 'plan-revision-conflict' });
  await assert.rejects(app.submitNodeFeedback({ nodeId: 'source', text: 'Old definition', commandId: 'old-feedback' }), { code: 'node-not-current' });
  const status = await app.getStatus();
  assert.equal(status.nodes.length, 5);
  assert.equal(status.nodes.find(item => item.id === 'source').instruction, 'Implement the source.');
  assert.equal(status.nodes.find(item => item.id === 'source').supersededByRevision, revised.revision.id);
  assert.equal(status.workflow.revisions.length, 2);
  assert.equal((await app.verify()).ok, true);
  const events = await app.listEvents();
  const revisionEvent = events.find(event => event.type === 'PlanRevised');
  const forged = events.map(event => event === revisionEvent ? createEvent({ ...event,
    payload: { ...event.payload, bindings: event.payload.bindings.slice(1) } }, { idFactory: () => event.eventId }) : event);
  assert.throws(() => projectEvents(forged), { code: 'plan-revision-binding-mismatch' });
  const stranded = events.map(event => event === revisionEvent ? createEvent({ ...event,
    payload: { ...event.payload, feedbackIds: [feedback.feedback.id] } }, { idFactory: () => event.eventId }) : event);
  assert.throws(() => projectEvents(stranded), { code: 'feedback-revision-incomplete' });
});

test('legacy flat plans without a stored authored snapshot expose a reconstructable revision one', async t => {
  const { app } = await fixture(t, { nodes: [leaf('source')] });
  const events = (await app.listEvents()).map(event => {
    if (event.type !== 'PlanLoaded') return event;
    const payload = { ...event.payload }; delete payload.plan;
    return createEvent({ ...event, payload }, { idFactory: () => event.eventId });
  });
  const workflow = buildWorkflow(projectEvents(events));
  assert.equal(workflow.revisions[0].plan.nodes[0].id, 'source');
  assert.equal(workflow.goals[0].children[0].type, 'node');
});

test('batch replay rejects conflicting manifests, incomplete registration and a mismatched member lease', async t => {
  const append = (events, type, streamId, payload) => [...events, createEvent({ type, streamId, payload,
    sequence: events.length + 1, metadata: { streamVersion: events.filter(item => item.streamId === streamId).length + 1 } })];
  const f = await fixture(t, { nodes: [leaf('a'), leaf('b')] });
  const status = await f.app.getStatus(), base = await f.app.listEvents();
  const baseRevision = 'a'.repeat(40), inputHash = `sha256:${'1'.repeat(64)}`;
  const members = ['a', 'b'].map(id => ({ nodeId: id, runId: `run-${id}`,
    executor: { id: 'fixture', version: '1' }, inputHash, resources: [] }));
  const manifest = { batchId: 'batch', leaseId: 'lease', baseRevision, coreIgnoreCase: false, members };
  const started = append(base, 'RunBatchStarted', 'run-batch:batch', manifest);
  assert.throws(() => projectEvents(started), { code: 'incomplete-run-batch' });
  let complete = started;
  for (const member of members) {
    const node = status.nodes.find(item => item.id === member.nodeId);
    complete = append(complete, 'RunCreated', `run:${member.runId}`, { runId: member.runId, nodeId: node.id,
      goalId: node.goalId, planId: node.planId, batchId: 'batch', executor: member.executor,
      inputHash, baseRevision, requestedBaseRevision: 'HEAD', workspaceRelativePath: `.fwa/worktrees/${member.runId}`,
      effects: { logicalReads: node.reads, logicalWrites: node.writes, resolvedReads: node.reads,
        resolvedWrites: node.writes, consumedRefs: [], producedRefs: [] } });
  }
  assert.equal(projectEvents(complete).runBatches[0].status, 'running');
  assert.throws(() => projectEvents(append(complete, 'RunBatchFinished', 'run-batch:batch', {
    batchId: 'batch', outcome: 'completed', reason: null
  })), { code: 'run-batch-not-settled' });
  complete = append(complete, 'GoalActivated', `goal:${f.goal.id}`, { goalId: f.goal.id, nodeId: 'a', runId: 'run-a' });
  complete = append(complete, 'NodeStarted', 'node:a', { nodeId: 'a', runId: 'run-a' });
  assert.throws(() => projectEvents(append(complete, 'RunStarted', 'run:run-a', {
    runId: 'run-a', nodeId: 'a', workspacePath: '/fixture/worktree', leaseId: 'wrong-lease'
  })), { code: 'run-batch-lease-mismatch' });
  const conflicting = await fixture(t, { nodes: [leaf('a'), leaf('b', { writes: ['a.txt'] })] });
  const conflictEvents = await conflicting.app.listEvents();
  assert.throws(() => projectEvents(append(conflictEvents, 'RunBatchStarted', 'run-batch:batch', manifest)),
    { code: 'run-batch-conflict' });
  await f.app.submitNodeFeedback({ nodeId: 'a', text: 'Revise before further work.', commandId: 'before-batch' });
  const pendingEvents = await f.app.listEvents();
  assert.throws(() => projectEvents(append(pendingEvents, 'RunBatchStarted', 'run-batch:batch', manifest)),
    { code: 'pending-node-feedback' });
  const created = complete.find(event => event.type === 'RunCreated');
  const serialPayload = { ...created.payload }; delete serialPayload.batchId;
  assert.throws(() => projectEvents(append(pendingEvents, 'RunCreated', 'run:run-a', serialPayload)),
    { code: 'pending-node-feedback' });
});

test('pending feedback blocks both serial admission and the final batch snapshot without executing a leaf', async t => {
  const { root, app } = await fixture(t, { nodes: [leaf('source')] }, true);
  const delegate = new FileOperationsExecutor(), workspace = new GitWorktreeAdapter(root);
  let executes = 0;
  const executor = { schemaVersion: 1, id: 'pending-fixture', version: '1', capabilities: delegate.capabilities,
    async execute(input) { executes++; return delegate.execute(input); } };
  const input = { schemaVersion: 1, operations: [{ type: 'write', path: 'source.txt', content: 'never' }] };
  const inspect = workspace.inspect.bind(workspace);
  workspace.inspect = async options => {
    const result = await inspect(options);
    await app.submitNodeFeedback({ nodeId: 'source', text: 'Persisted during batch preflight.', commandId: 'late-feedback' });
    return result;
  };
  await assert.rejects(app.runReadyBatch({ executions: [{ nodeId: 'source', input }], executor, workspace, commandId: 'batch' }),
    error => error.code === 'no-ready-nodes' && error.details.deferred[0].code === 'pending-node-feedback');
  await assert.rejects(app.runNext({ nodeId: 'source', input, executor, workspace, commandId: 'serial' }), { code: 'pending-node-feedback' });
  assert.equal(executes, 0);
  const status = await app.getStatus();
  assert.equal(status.runs.length, 0); assert.equal(status.runBatches.length, 0);
  assert.equal((await app.lease.inspect()).held, false);
});

test('feedback during a real Run stays pending; a completed leaf revision creates a new Run without erasing accepted history', async t => {
  const { root, app, goal } = await fixture(t, { nodes: [leaf('source', { instruction: 'Version one' })] }, true);
  const workspace = new GitWorktreeAdapter(root), promotion = new GitIntegrationAdapter(root);
  const delegate = new FileOperationsExecutor();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const executor = { schemaVersion: 1, id: 'feedback-fixture', version: '1', capabilities: delegate.capabilities,
    async execute(input) { started(); await gate; return delegate.execute(input); } };
  const input = content => ({ schemaVersion: 1, operations: [{ type: 'write', path: 'source.txt', content }] });
  const running = app.runNext({ nodeId: 'source', executor, workspace, input: input('one\n'), commandId: 'run-one' });
  await entered;
  let feedback;
  try {
    feedback = await app.submitNodeFeedback({ nodeId: 'source', text: 'Use version two.', commandId: 'during-run' });
    assert.equal(feedback.deferred, true);
    assert.equal(feedback.feedback.status, 'pending');
    const plan = (await app.getStatus()).workflow.revisions.at(-1).plan;
    await assert.rejects(app.revisePlan({ goalId: goal.id, expectedRevision: 1, plan, reason: 'Not yet', commandId: 'busy-revision' }), { code: 'plan-revision-deferred' });
  } finally { release(); }
  const first = await running; assert.equal(first.ok, true);
  const profile = { schemaVersion: 1, id: 'workflow-test', checks: [{ id: 'test', kind: 'test',
    command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 10000 }] };
  await app.evaluateChangeSet({ changeSetId: first.changeSet.id, profile, evaluator: new CommandEvaluator(), workspace, commandId: 'accept-one' });
  await app.integrateChangeSet({ changeSetId: first.changeSet.id, targetRef: 'main', workspace: promotion, commandId: 'integrate-one' });
  const complete = await app.getStatus();
  assert.equal(complete.workflow.goals[0].phase, 'done');
  const plan = structuredClone(complete.workflow.revisions.at(-1).plan); plan.nodes[0].instruction = 'Version two';
  const revised = await app.revisePlan({ goalId: goal.id, expectedRevision: 1, plan,
    reason: 'Apply operator feedback', feedbackIds: [feedback.feedback.id], commandId: 'revision-two' });
  const replacement = revised.nodeBindings[0].nodeId;
  assert.notEqual(replacement, 'source');
  assert.equal(revised.goal.status, 'active');
  const before = await app.getStatus();
  assert.deepEqual(before.runs[0], complete.runs[0]);
  assert.deepEqual(before.evidence, complete.evidence);
  await assert.rejects(app.runNext({ nodeId: 'source', executor: delegate, workspace, input: input('forbidden'), commandId: 'run-old' }), { code: 'node-not-ready' });
  const second = await app.runNext({ nodeId: replacement, executor: delegate, workspace, input: input('two\n'), commandId: 'run-two' });
  assert.equal(second.ok, true);
  assert.notEqual(second.run.id, first.run.id);
  assert.notEqual(second.changeSet.headRevision, first.changeSet.headRevision);
  assert.equal((await app.getStatus()).workflow.goals[0].phase, 'work');
  assert.equal((await app.verify({ workspace, integration: promotion })).ok, true);
});
