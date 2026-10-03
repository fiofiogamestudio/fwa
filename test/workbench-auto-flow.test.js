import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FwaApplication } from '../src/application/fwa-application.js';
import { WorkbenchController } from '../src/application/workbench-controller.js';
import { ReviewController } from '../src/application/review-controller.js';
import { normalizeReviewConfig } from '../src/application/review-config.js';
import { FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';

const git = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const check = (id, kind, source) => ({ id, kind, command: process.execPath, args: ['-e', source], timeoutMs: 10000 });

async function fixture(t, manualProfiles = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-auto-flow-')), controllers = [];
  t.after(async () => {
    for (const controller of controllers) await controller.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'FWA Auto Flow Test']); git(root, ['config', 'user.email', 'auto-flow@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  for (const name of ['first', 'second']) await writeFile(path.join(root, `${name}.cjs`), 'module.exports = 0;\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Automatic flow baseline']);
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const app = new FwaApplication(root); await app.init();
  const goal = (await app.createGoal({ title: 'First result feeds second result', commandId: 'create-goal' })).goal;
  const node = (id, dependencies) => ({ id, title: `${id} result`, outcome: `${id} result has its required value.`,
    instruction: `Produce ${id}.cjs and preserve upstream outputs.`, dependsOn: dependencies,
    dependencyReasons: dependencies.map(nodeId => ({ nodeId, reason: 'Consumes the adopted first result to compute the second result.' })),
    reads: dependencies.length ? ['first.cjs', 'second.cjs'] : ['first.cjs'], writes: [`${id}.cjs`],
    capabilities: ['file_operations'], acceptance: { checks: [`${id}-value`] },
    budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 } });
  await app.loadPlan({ goalId: goal.id, plan: { schemaVersion: 1, nodes: [node('first', []), node('second', ['first'])] }, commandId: 'load-plan' });
  const config = normalizeReviewConfig({ schemaVersion: 1, targetRef: 'main', completionPolicy: { mode: 'automatic', manualProfiles },
    validationProfiles: ['first', 'second'].map((id, index) => ({ schemaVersion: 1, id: `${id}-profile`, checks: [
      check(`${id}-value`, 'test', `require('node:assert/strict').equal(require('./${id}.cjs'),${index === 0 ? 2 : 6})`)
    ] })), regressionProfile: { schemaVersion: 1, id: 'chain-regression', checks: [
      check('compile', 'compile', "const vm=require('node:vm'),fs=require('node:fs');for(const file of ['first.cjs','second.cjs'])new vm.Script(fs.readFileSync(file,'utf8'),{filename:file});"),
      check('tests', 'test', "const a=require('node:assert/strict'),first=require('./first.cjs'),second=require('./second.cjs');a.equal(first,2);a.ok([0,6].includes(second));if(second!==0)a.equal(second,first*3);")
    ] } });
  const starts = [], delegate = new FileOperationsExecutor();
  const executor = { schemaVersion: 1, id: 'auto-flow-fixture', version: '1', capabilities: ['file_operations'], async execute(input) {
    const id = input.node.id;
    assert.ok(['first', 'second'].includes(id));
    starts.push(id);
    let value = 2;
    if (id === 'second') {
      const status = await app.getStatus(), predecessor = status.nodes.find(item => item.id === 'first');
      assert.equal(predecessor.integrationStatus, 'integrated', 'A dependent Run starts only after real upstream integration.');
      assert.equal(await readFile(path.join(input.workspaceRoot, 'first.cjs'), 'utf8'), 'module.exports = 2;\n', 'Dependent worktree contains the adopted upstream commit.');
      value = 6;
    }
    return delegate.execute({ ...input, input: { schemaVersion: 1, operations: [{ type: 'write', path: `${id}.cjs`, content: `module.exports = ${value};\n` }] } });
  } };
  const createController = () => {
    const controller = new WorkbenchController(app, { planner: null, executor, validationProfiles: config.validationProfiles });
    controller.review = new ReviewController(app, { config, jobs: controller.jobs, signal: controller.abortController.signal });
    controllers.push(controller); return controller;
  };
  const controller = createController();
  const wait = async (controller, request) => {
    const active = controller.jobs.active.get(request.id); if (active) await active;
    const job = (await controller.jobs.list()).find(item => item.id === request.id);
    assert.equal(job.state, 'succeeded', JSON.stringify(job)); return job;
  };
  return { root, app, config, baseline, goal, starts, controller, createController, wait };
}

async function assertDelivered(f) {
  const status = await f.app.getStatus();
  assert.deepEqual(f.starts, ['first', 'second']);
  assert.equal(status.runs.length, 2); assert.equal(status.evaluations.length, 2); assert.equal(status.integrations.length, 2);
  assert.ok(status.evaluations.every(item => item.status === 'passed'));
  assert.ok(status.integrations.every(item => item.status === 'integrated'));
  for (const node of status.nodes) {
    assert.equal(node.status, 'accepted'); assert.equal(node.validity, 'valid'); assert.equal(node.integrationStatus, 'integrated');
    assert.equal(node.acceptedChangeSetId, node.integratedChangeSetId);
    assert.equal(node.integratedTargetRef, 'refs/heads/main');
  }
  assert.equal(status.workflow.goals.find(item => item.id === f.goal.id).phase, 'done');
  assert.equal(await readFile(path.join(f.root, 'first.cjs'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(await readFile(path.join(f.root, 'second.cjs'), 'utf8'), 'module.exports = 6;\n');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  const verification = await f.app.verify({ workspace: new GitWorktreeAdapter(f.root), integration: new GitIntegrationAdapter(f.root),
    candidateWorkspace: new GitIntegrationWorkspaceAdapter(f.root) });
  assert.equal(verification.ok, true, JSON.stringify(verification));
  return status;
}

test('one work request validates and integrates a real dependent chain under automatic completion', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const job = await f.wait(f.controller, await f.controller.work({ commandId: 'automatic-chain', goalId: f.goal.id }));
  assert.equal(job.result.stopReason, 'goal-completed', JSON.stringify(job.result));
  await assertDelivered(f);
  assert.notEqual(git(f.root, ['rev-parse', 'HEAD']), f.baseline);
  const jobs = await f.controller.jobs.list();
  assert.equal(jobs.filter(item => item.type === 'workflow.work').length, 1);
  const acceptance = jobs.filter(item => item.type === 'change.policy-accept');
  assert.equal(acceptance.length, 2);
  assert.ok(acceptance.every(item => item.result.acceptanceKind === 'policy' && item.result.acceptedByPolicy === true));
  assert.equal(jobs.filter(item => item.type === 'change.accept').length, 0, 'Automatic policy records must not impersonate human confirmation.');
});

test('manual first result pauses the chain; one durable finish continues automatic downstream work exactly once', { timeout: 180000 }, async t => {
  const f = await fixture(t, ['first-profile']);
  const paused = await f.wait(f.controller, await f.controller.work({ commandId: 'manual-gate', goalId: f.goal.id }));
  assert.equal(paused.result.stopReason, 'awaiting-acceptance', JSON.stringify(paused.result));
  let status = await f.app.getStatus();
  assert.deepEqual(f.starts, ['first']); assert.equal(status.runs.length, 1); assert.equal(status.evaluations.length, 1); assert.equal(status.integrations.length, 0);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.baseline);
  const changeSetId = status.nodes.find(item => item.id === 'first').changeSetIds.at(-1);
  const review = await f.controller.review.inspect(changeSetId);
  assert.equal(review.autoFinishAllowed, false); assert.equal(review.autoFinishReason, 'review-profile-manual'); assert.equal(review.actions.finish, true);
  const command = { commandId: 'confirm-and-continue', changeSetId, reviewToken: review.reviewToken, note: 'Reviewed the exact first result and validation evidence.' };
  const finished = await f.wait(f.controller, await f.controller.finish(command));
  assert.equal(finished.type, 'workflow.finish');
  assert.equal(finished.result.goalId, f.goal.id); assert.equal(finished.result.changeSetId, changeSetId);
  assert.equal(finished.result.finish.ok, true); assert.equal(finished.result.finish.finished, true);
  assert.equal(finished.result.work.stopReason, 'goal-completed', JSON.stringify(finished.result));
  status = await assertDelivered(f);
  const jobs = await f.controller.jobs.list();
  const human = jobs.filter(item => item.type === 'change.accept'), automatic = jobs.filter(item => item.type === 'change.policy-accept');
  assert.equal(human.length, 1); assert.equal(human[0].result.note, command.note); assert.equal(human[0].result.changeSetId, changeSetId);
  assert.equal(automatic.length, 1); assert.equal(automatic[0].result.policy.profileId, 'second-profile');
  const adopted = git(f.root, ['rev-parse', 'HEAD']), sequence = status.lastSequence, count = jobs.length;
  // Reopen the coordinator to prove persisted command replay, not an in-memory guard.
  const restarted = f.createController(), replay = await restarted.finish(command);
  assert.equal(replay.appended, false);
  const replayed = await f.wait(restarted, replay);
  assert.deepEqual(replayed.result, finished.result);
  const after = await f.app.getStatus();
  assert.equal(after.lastSequence, sequence); assert.equal(after.runs.length, 2); assert.deepEqual(f.starts, ['first', 'second']);
  assert.equal(after.integrations.length, 2); assert.equal((await restarted.jobs.list()).length, count);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), adopted);
});
