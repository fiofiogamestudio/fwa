import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { FwaApplication } from '../src/application/fwa-application.js';
import { WorkbenchController } from '../src/application/workbench-controller.js';
import { WorkbenchJobs } from '../src/storage/workbench-jobs.js';
import { parsePlannerResponse } from '../src/adapters/codex-planner.js';
import { assertProjectWorkScope } from '../src/application/workbench-policy.js';
function rawPlan() {
  return { title: 'Fixture feature', questions: [], groups: [{ id: 'feature', title: 'Feature', parentId: '' }], nodes: [
    { id: 'one', title: 'Implement one', parentId: 'feature', instruction: 'Create src/one.txt with the specified content.',
      outcome: 'The requested content is available in the output.', dependencyReasons: [], derivedFrom: null, resources: [],
      dependsOn: [], reads: ['seed.txt'], writes: ['src/one.txt'], checks: ['The output matches the brief'], maxFiles: 2, maxDiffLines: 100 }
  ] };
}
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-workbench-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Test']); git(root, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n'); await writeFile(path.join(root, 'seed.txt'), 'baseline\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']);
  const application = new FwaApplication(root); await application.init();
  return { root, application };
}
test('planner accepts hierarchy, refuses fake questions-plus-work and enforces framework scope', () => {
  const output = parsePlannerResponse(rawPlan(), { prefix: 'fixture' });
  assert.equal(output.plan.nodes[0].parentId, 'fixture-feature');
  assert.equal(Object.hasOwn(output.plan.nodes[0].budget, 'wallTimeMinutes'), false);
  assert.equal(output.plan.nodes[0].budget.maxRetries, 2);
  assert.equal(assertProjectWorkScope(output.plan.nodes[0]).writes[0], 'src/one.txt');
  for (const writes of [['fw/fwa/index.js'], ['FW/foo'], ['**'], ['*/file'], ['../outside'], ['.fwa/events/a']]) {
    assert.throws(() => assertProjectWorkScope({ reads: [], writes }));
  }
  assert.throws(() => parsePlannerResponse({ ...rawPlan(), questions: ['Which game?'] }, { prefix: 'fixture' }));
});
test('planner retains existing logical IDs across revisions', () => {
  const initial = parsePlannerResponse(rawPlan(), { prefix: 'long-existing-prefix' });
  const raw = rawPlan(); raw.groups[0].id = initial.plan.groups[0].id;
  raw.nodes[0].id = initial.plan.nodes[0].id; raw.nodes[0].parentId = raw.groups[0].id;
  raw.nodes[0].instruction = 'Changed request';
  const next = parsePlannerResponse(raw, { prefix: 'new-operation', existingPlan: initial.plan });
  assert.equal(next.plan.nodes[0].id, initial.plan.nodes[0].id);
  assert.throws(() => parsePlannerResponse(rawPlan(), { prefix: 'new-operation', existingPlan: initial.plan }), /retain every existing logical leaf/);
  initial.plan.nodes[0].resources = ['editor'];
  initial.plan.nodes[0].budget.wallTimeMinutes = 20;
  initial.plan.nodes[0].acceptance.commands = ['trusted-check'];
  initial.plan.nodes[0].acceptance.evaluators = ['trusted-evaluator'];
  raw.nodes[0].resources = null;
  const preserved = parsePlannerResponse(raw, { prefix: 'new-operation', existingPlan: initial.plan }).plan.nodes[0];
  assert.deepEqual(preserved.resources, ['editor']);
  assert.equal(preserved.budget.wallTimeMinutes, 20);
  assert.deepEqual(preserved.acceptance.commands, ['trusted-check']);
  assert.deepEqual(preserved.acceptance.evaluators, ['trusted-evaluator']);
  initial.plan.nodes[0].acceptance = 'trusted-contract';
  assert.throws(() => parsePlannerResponse(raw, { prefix: 'new-operation', existingPlan: initial.plan }), /named acceptance contract/);
  raw.nodes[0].checks = null;
  assert.equal(parsePlannerResponse(raw, { prefix: 'new-operation', existingPlan: initial.plan }).plan.nodes[0].acceptance, 'trusted-contract');
});

test('configured planning exposes trusted criteria and refuses an unverifiable plan before creating a goal', async t => {
  const { application } = await fixture(t);
  const validationProfiles = [{ id: 'project-checks', checks: [{ id: 'feature-test', kind: 'test', command: 'node', args: ['--test', 'feature.test.js'] }] }];
  let context;
  const controller = new WorkbenchController(application, { validationProfiles, planner: { async plan(input) {
    context = input.context;
    return parsePlannerResponse(rawPlan(), { prefix: input.prefix });
  } } });
  await controller.plan({ commandId: 'uncovered', request: 'A specific feature' }); await controller.jobs.settle();
  assert.deepEqual(context.validationProfiles, validationProfiles);
  assert.equal((await controller.jobs.list())[0].error.code, 'planner-unverifiable-plan');
  assert.equal((await application.getStatus()).goals.length, 0);
  controller.planner = { async plan(input) {
    const raw = rawPlan(); raw.nodes[0].checks = ['feature-test'];
    return parsePlannerResponse(raw, { prefix: input.prefix });
  } };
  await controller.plan({ commandId: 'covered', request: 'A feature with a real test runner' }); await controller.jobs.settle();
  assert.equal((await controller.jobs.list()).at(-1).state, 'succeeded');
  assert.deepEqual((await application.getStatus()).nodes[0].acceptance.checks, ['feature-test']);
});

test('trusted constructor options select both native adapters without accepting executable or sandbox from a request', async t => {
  const { root, application } = await fixture(t), calls = [];
  const spawnImpl = (executable, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    calls.push({ executable, args });
    queueMicrotask(() => {
      child.stdout.end(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(rawPlan()) } })}\n{"type":"turn.completed"}\n`);
      child.stderr.end(); child.emit('close', 0, null);
    });
    return child;
  };
  const controller = new WorkbenchController(application, { codexOptions: { executable: 'fixture-native', platform: 'linux', spawnImpl } });
  await controller.plan({ commandId: 'native-plan', request: 'Fixture', codexOptions: { executable: 'untrusted' }, executable: 'untrusted', sandbox: 'danger-full-access' });
  await controller.jobs.settle();
  assert.equal((await controller.jobs.list())[0].state, 'succeeded');
  await controller.executor.execute({ workspaceRoot: root, node: { id: 'fixture', capabilities: ['code_edit'] }, input: { schemaVersion: 1, prompt: 'Fixture' } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.executable), ['fixture-native', 'fixture-native']);
  assert.deepEqual(calls.map(call => call.args[call.args.indexOf('--sandbox') + 1]), ['read-only', 'workspace-write']);
  assert.ok(calls.every(call => !call.args.includes('--ignore-user-config') && !call.args.includes('--full-auto')));
});

test('feedback arriving during input snapshot preparation blocks dispatch and a revision job replays after success', async t => {
  const { application } = await fixture(t);
  const initial = parsePlannerResponse(rawPlan(), { prefix: 'fixture' }).plan;
  const goal = (await application.createGoal({ title: 'Fixture', request: 'Implement fixture', commandId: 'goal' })).goal;
  await application.loadPlan({ goalId: goal.id, plan: initial, commandId: 'plan' });
  let planned = 0, dispatches = 0;
  const controller = new WorkbenchController(application, { planner: { async plan(input) {
    planned++;
    const plan = structuredClone(input.existingPlan); plan.nodes[0].instruction = 'Changed by feedback';
    return { title: 'Revision', plan, questions: [] };
  } } });
  let feedback;
  controller.referenceContext = async () => {
    if (!feedback) feedback = await application.submitNodeFeedback({ nodeId: initial.nodes[0].id, text: 'Change the fixture', commandId: 'feedback' });
    return { references: [], images: [] };
  };
  application.runReadyBatch = async () => { dispatches++; throw new Error('Should not dispatch'); };
  const stopped = await controller.runGoal({ goalId: goal.id, commandId: 'work' });
  assert.equal(stopped.stopReason, 'awaiting-feedback-revision'); assert.equal(dispatches, 0);
  const command = { commandId: 'revision', goalId: goal.id, expectedRevision: 1, feedbackIds: [feedback.feedback.id] };
  await controller.revise(command); await controller.jobs.settle();
  const job = (await controller.jobs.list())[0]; assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  assert.equal((await application.getStatus()).workflow.revisions.at(-1).revision, 2);
  assert.equal((await controller.revise(command)).appended, false);
  await controller.jobs.settle(); assert.equal(planned, 1);
  assert.equal((await application.getStatus()).workflow.feedback[0].status, 'applied');
});
test('durable jobs replay once, reject changed intent and expose an interrupted coordinator honestly', async t => {
  const { root } = await fixture(t), jobs = new WorkbenchJobs(root);
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const request = { commandId: 'once', type: 'fixture', payload: { x: 1 } };
  await jobs.start(request, async () => { calls++; await gate; return { done: true }; });
  assert.equal((await jobs.list())[0].state, 'running');
  assert.equal((await new WorkbenchJobs(root).list())[0].state, 'interrupted');
  assert.equal((await jobs.start(request, () => { calls++; })).appended, false);
  await assert.rejects(jobs.start({ ...request, payload: { x: 2 } }, () => {}), { code: 'command-id-conflict' });
  release(); await jobs.settle();
  assert.equal(calls, 1); assert.equal((await new WorkbenchJobs(root).list())[0].state, 'succeeded');
});
test('imported copy feeds a pinned plan without changing the project checkout or dispatching work', async t => {
  const { root, application } = await fixture(t);
  let planned = 0, executed = 0;
  const controller = new WorkbenchController(application, { planner: { async plan(input) {
    planned++; assert.equal(input.references[0].files[0].text, 'Create the described fixture.');
    assert.match(input.references[0].binding.manifestHash, /^sha256:/);
    return parsePlannerResponse(rawPlan(), { prefix: input.prefix, referenceInputs: input.references.map(r => r.binding) });
  } }, executor: { execute() { executed++; } } });
  await controller.library.init();
  const imported = await controller.library.importFiles({ commandId: 'import', label: 'Brief', files: [{ path: 'brief.md', base64: Buffer.from('Create the described fixture.').toString('base64') }] });
  const request = { commandId: 'plan-request', request: '', libraryIds: [imported.libraryId], mode: 'plan' };
  await controller.plan(request); await controller.jobs.settle();
  const jobs = await controller.jobs.list();
  assert.equal(jobs[0].state, 'succeeded', JSON.stringify(jobs[0].error));
  const status = await application.getStatus();
  assert.equal(status.goals.length, 1); assert.equal(status.nodes[0].referenceInputs[0].versionId, imported.versionId);
  assert.equal(status.workflow.goals[0].children[0].type, 'group'); assert.equal(status.runs.length, 0);
  assert.equal(git(root, ['status', '--porcelain']), '');
  await controller.plan(request); await controller.jobs.settle(); assert.equal(planned, 1); assert.equal(executed, 0);
  assert.equal((await application.verify()).ok, true);
});
test('ambiguity creates questions rather than an invented Goal or Run', async t => {
  const { application } = await fixture(t);
  const controller = new WorkbenchController(application, { planner: { async plan() { return { title: 'Unclear', questions: ['Which feature?'], plan: null }; } } });
  await controller.plan({ commandId: 'unclear', request: 'Make it better', mode: 'plan' }); await controller.jobs.settle();
  assert.deepEqual((await controller.jobs.list())[0].result.questions, ['Which feature?']);
  assert.equal((await application.getStatus()).goals.length, 0);
});
test('planner failures persist without a synthetic fallback plan', async t => {
  const { application } = await fixture(t);
  const controller = new WorkbenchController(application, { planner: { async plan() { throw Object.assign(new Error('Sandbox process failed'), { code: 'fixture-blocked' }); } } });
  await controller.plan({ commandId: 'blocked', request: 'A feature' }); await controller.jobs.settle();
  const job = (await controller.jobs.list())[0]; assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'fixture-blocked');
  assert.equal((await application.getStatus()).nodes.length, 0);
});

// These fixtures isolate controller decisions from the core's existing
// zero-file RunProduced contract. No model invocation or acceptance is faked
// into application history: only the injected batch return is synthetic.
async function batchControllerFixture(t, fileCounts, { automaticAcceptance = true } = {}) {
  const { application } = await fixture(t);
  const raw = rawPlan();
  raw.nodes = fileCounts.map((_, index) => ({ ...raw.nodes[0], id: `leaf${index}`,
    writes: [`src/leaf${index}.txt`] }));
  const plan = parsePlannerResponse(raw, { prefix: 'batch-fixture' }).plan;
  const goal = (await application.createGoal({ title: 'Batch review', commandId: 'batch-goal' })).goal;
  await application.loadPlan({ goalId: goal.id, plan, commandId: 'batch-plan' });
  const batch = { ok: true, batch: { id: 'batch-fixture' }, deferred: [],
    members: plan.nodes.map((node, index) => ({ nodeId: node.id, runId: `run-${index}`, ok: true,
      changeSet: { id: `changeset-${index}`, nodeId: node.id, runId: `run-${index}`,
        changedFiles: Array.from({ length: fileCounts[index] }, (_, file) => `src/leaf${index}-${file}.txt`),
        commits: fileCounts[index] ? [String(index + 1).repeat(40)] : [],
        executionArtifact: { schemaVersion: 1, algorithm: 'sha256', digest: String(index + 1).repeat(64), size: 17 + index }
      } })) };
  const originalBatch = structuredClone(batch), getStatus = application.getStatus.bind(application);
  let dispatches = 0;
  application.getStatus = async () => {
    const status = await getStatus();
    // Once the supplied batch returns, it is no longer ready for a second
    // dispatch. This read-only projection does not alter persisted core facts.
    return dispatches ? { ...status, nodes: status.nodes.map(node => ({ ...node, status: 'produced' })) } : status;
  };
  application.runReadyBatch = async () => { dispatches++; return batch; };
  const accepted = [];
  const controller = new WorkbenchController(application, { planner: null, executor: { execute() {} },
    acceptAndIntegrate: automaticAcceptance ? async ({ changeSet }) => { accepted.push(changeSet.id); } : null });
  return { controller, goal, batch, originalBatch, accepted, dispatches: () => dispatches, getStatus };
}

test('zero-file Work returns review bindings rather than awaiting acceptance and replays its durable job', async t => {
  const f = await batchControllerFixture(t, [0], { automaticAcceptance: false });
  const request = { commandId: 'zero-work', goalId: f.goal.id };
  await f.controller.work(request); await f.controller.jobs.settle();
  const job = (await f.controller.jobs.list())[0];
  assert.equal(job.state, 'succeeded'); // Coordinator returned; not a verdict.
  assert.equal(job.result.stopReason, 'no-changes-awaiting-review');
  assert.deepEqual(job.result.noChanges, [{ nodeId: f.batch.members[0].nodeId, runId: 'run-0',
    changeSetId: 'changeset-0', fileCount: 0, commitCount: 0,
    executionArtifact: f.batch.members[0].changeSet.executionArtifact }]);
  assert.equal((await f.controller.work(request)).appended, false); await f.controller.jobs.settle();
  assert.deepEqual((await f.controller.jobs.list())[0], job);
  assert.equal(f.dispatches(), 1); assert.deepEqual(f.batch, f.originalBatch);
  assert.equal((await f.getStatus()).runs.length, 0);
});

test('all-zero Work stops before invoking any trusted acceptance callback', async t => {
  const f = await batchControllerFixture(t, [0, 0]);
  const result = await f.controller.runGoal({ commandId: 'zero-batch', goalId: f.goal.id });
  assert.equal(result.stopReason, 'no-changes-awaiting-review');
  assert.equal(result.noChanges.length, 2); assert.deepEqual(f.accepted, []);
  assert.equal(result.rounds[0].members.length, 2); assert.equal(f.dispatches(), 1);
  assert.deepEqual(f.batch, f.originalBatch);
});

test('a mixed batch retains every output but stops all automatic acceptance, including earlier nonempty members', async t => {
  const f = await batchControllerFixture(t, [1, 0]);
  const result = await f.controller.runGoal({ commandId: 'mixed-batch', goalId: f.goal.id });
  assert.equal(result.stopReason, 'no-changes-awaiting-review');
  assert.deepEqual(result.noChanges.map(member => member.changeSetId), ['changeset-1']);
  assert.deepEqual(result.rounds[0].members.map(member => member.changeSetId), ['changeset-0', 'changeset-1']);
  assert.deepEqual(f.accepted, []); assert.equal(f.dispatches(), 1);
  assert.deepEqual(f.batch, f.originalBatch);
});

test('a trusted callback without actual integration stops instead of claiming progress', async t => {
  const f = await batchControllerFixture(t, [1, 2]);
  const result = await f.controller.runGoal({ commandId: 'nonempty-batch', goalId: f.goal.id });
  assert.equal(result.stopReason, 'acceptance-incomplete');
  assert.equal(Object.hasOwn(result, 'noChanges'), false);
  assert.deepEqual(f.accepted, ['changeset-0', 'changeset-1']);
  assert.equal(f.dispatches(), 1); assert.deepEqual(f.batch, f.originalBatch);
});

test('a nonempty batch without a trusted adapter still awaits acceptance', async t => {
  const f = await batchControllerFixture(t, [1], { automaticAcceptance: false });
  const result = await f.controller.runGoal({ commandId: 'nonempty-default', goalId: f.goal.id });
  assert.equal(result.stopReason, 'awaiting-acceptance');
  assert.equal(Object.hasOwn(result, 'noChanges'), false); assert.deepEqual(f.accepted, []);
});
