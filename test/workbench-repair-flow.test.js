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

const git = (root, args, input = undefined) => {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000, input });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const check = (id, kind, source) => ({ id, kind, command: process.execPath, args: ['-e', source], timeoutMs: 10000 });
const failedSource = 'module.exports = 1;\n// Preserve the captured implementation during repair.\n';
const repairedSource = failedSource.replace('exports = 1', 'exports = 2');
const completeLogMarker = 'FULL_ORIGINAL_FAILURE_LOG';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-repair-flow-')), controllers = [];
  t.after(async () => {
    for (const controller of controllers) await controller.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'FWA Repair Flow Test']);
  git(root, ['config', 'user.email', 'repair-flow@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  for (const name of ['first', 'second']) await writeFile(path.join(root, `${name}.cjs`), 'module.exports = 0;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Repair flow baseline']);
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const app = new FwaApplication(root);
  await app.init();
  const goal = (await app.createGoal({ title: 'Repair the first result before producing its dependent', commandId: 'create-goal' })).goal;
  const node = (id, dependencies) => ({ id, title: `${id} result`, outcome: `${id} has its required value.`,
    instruction: `Produce ${id}.cjs and preserve useful captured work when repairing.`, dependsOn: dependencies,
    dependencyReasons: dependencies.map(nodeId => ({ nodeId, reason: 'Uses the integrated first value to compute the second value.' })),
    reads: dependencies.length ? ['first.cjs', 'second.cjs'] : ['first.cjs'], writes: [`${id}.cjs`],
    capabilities: ['file_operations'], acceptance: { checks: [`${id}-value`] },
    budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 } });
  await app.loadPlan({ goalId: goal.id, plan: { schemaVersion: 1, nodes: [node('first', []), node('second', ['first'])] }, commandId: 'load-plan' });
  const config = normalizeReviewConfig({ schemaVersion: 1, targetRef: 'main', completionPolicy: { mode: 'automatic', manualProfiles: [] },
    validationProfiles: ['first', 'second'].map((id, index) => ({ schemaVersion: 1, id: `${id}-profile`, checks: [
      check(`${id}-value`, 'test', `const value=require('./${id}.cjs');if(value===1)console.log('${completeLogMarker}'+ 'x'.repeat(65536));require('node:assert/strict').equal(value,${index === 0 ? 2 : 6},'repair the incorrect exported value');`)
    ] })), regressionProfile: { schemaVersion: 1, id: 'chain-regression', checks: [
      check('compile', 'compile', "const vm=require('node:vm'),fs=require('node:fs');for(const file of ['first.cjs','second.cjs'])new vm.Script(fs.readFileSync(file,'utf8'),{filename:file});"),
      check('tests', 'test', "const a=require('node:assert/strict'),first=require('./first.cjs'),second=require('./second.cjs');a.equal(first,2);a.ok([0,6].includes(second));if(second!==0)a.equal(second,first*3);")
    ] } });
  const starts = [], observedRepairs = [], delegate = new FileOperationsExecutor();
  const executor = { schemaVersion: 1, id: 'repair-flow-fixture', version: '1', capabilities: ['file_operations'], async execute(request) {
    const id = request.node.id;
    assert.ok(['first', 'second'].includes(id));
    const attempt = starts.filter(item => item === id).length;
    starts.push(id);
    let content;
    if (id === 'first' && attempt === 0) {
      assert.equal(await readFile(path.join(request.workspaceRoot, 'first.cjs'), 'utf8'), 'module.exports = 0;\n');
      content = failedSource;
    } else if (id === 'first') {
      assert.equal(attempt, 1, 'A repaired candidate must not be dispatched again.');
      assert.equal(git(root, ['rev-parse', 'HEAD']), baseline, 'A failed candidate never advances the target.');
      assert.equal(await readFile(path.join(root, 'first.cjs'), 'utf8'), 'module.exports = 0;\n');
      assert.equal(await readFile(path.join(request.workspaceRoot, 'first.cjs'), 'utf8'), failedSource,
        'FWA restores the verified prior implementation before the executor starts.');
      assert.equal(git(request.workspaceRoot, ['rev-parse', 'HEAD']), baseline,
        'Restoration leaves the Run baseline unchanged so final capture includes old and new work.');
      assert.equal(request.repairRestoration?.status, 'restored');
      const context = JSON.parse(request.input.prompt.split('\n').at(-1));
      const repair = context.repair;
      assert.ok(repair?.summary, 'The executor receives a concrete explanation of the previous failure.');
      assert.match(JSON.stringify(repair.summary), /first-value|incorrect exported value/);
      assert.ok(Buffer.byteLength(JSON.stringify(repair)) < 32768, 'Full diagnostic logs must not grow the repair prompt.');
      assert.equal(repair.repeatedFailureCount, 1);
      assert.equal(typeof repair.signature, 'string');
      const references = repair.references;
      const status = await app.getStatus(), first = status.nodes.find(item => item.id === 'first');
      const failedRun = status.runs.find(item => item.id === first.runIds[0]);
      const failedChange = status.changeSets.find(item => item.id === failedRun.changeSetId);
      const rejected = status.evaluations.find(item => item.runId === failedRun.id && item.status === 'rejected');
      assert.equal(references.runId, failedRun.id);
      assert.equal(references.changeSetId, failedChange.id);
      assert.equal(references.evaluationId, rejected.id);
      assert.equal(references.baseRevision, baseline);
      assert.equal(references.candidateRevision, failedChange.headRevision);
      assert.deepEqual(references.patchArtifact, failedChange.patchArtifact);
      assert.match(JSON.stringify(context.validationChecks), /first-value/);
      assert.match(JSON.stringify(context.validationChecks), /repair the incorrect exported value/);
      const patch = git(request.workspaceRoot, ['diff', '--binary', '--full-index', references.baseRevision, references.candidateRevision]);
      assert.match(patch, /Preserve the captured implementation/);
      assert.equal(await readFile(path.join(request.workspaceRoot, 'first.cjs'), 'utf8'), failedSource,
        'The executor never needs to reapply the patch or access the old worktree.');
      observedRepairs.push(repair);
      content = (await readFile(path.join(request.workspaceRoot, 'first.cjs'), 'utf8')).replace('exports = 1', 'exports = 2');
    } else {
      const status = await app.getStatus(), predecessor = status.nodes.find(item => item.id === 'first');
      assert.equal(predecessor.integrationStatus, 'integrated', 'Dependent execution requires a real successful integration.');
      assert.equal(await readFile(path.join(request.workspaceRoot, 'first.cjs'), 'utf8'), repairedSource);
      content = 'module.exports = 6;\n';
    }
    const result = await delegate.execute({ ...request, input: { schemaVersion: 1,
      operations: [{ type: 'write', path: `${id}.cjs`, content }] } });
    return result;
  } };
  const createController = () => {
    const controller = new WorkbenchController(app, { planner: null, executor, validationProfiles: config.validationProfiles });
    controller.review = new ReviewController(app, { config, jobs: controller.jobs, signal: controller.abortController.signal });
    controllers.push(controller);
    return controller;
  };
  const controller = createController();
  const wait = async (instance, request) => {
    const active = instance.jobs.active.get(request.id);
    if (active) await active;
    const job = (await instance.jobs.list()).find(item => item.id === request.id);
    assert.equal(job.state, 'succeeded', JSON.stringify(job));
    return job;
  };
  return { root, app, baseline, goal, starts, observedRepairs, controller, createController, wait };
}

async function assertDeliveredAndRetained(f) {
  const status = await f.app.getStatus();
  assert.deepEqual(f.starts, ['first', 'first', 'second']);
  assert.equal(f.observedRepairs.length, 1);
  assert.equal(status.runs.length, 3);
  assert.equal(status.changeSets.length, 3);
  assert.equal(status.evaluations.length, 3);
  assert.equal(status.evaluations.filter(item => item.status === 'rejected').length, 1);
  assert.equal(status.evaluations.filter(item => item.status === 'passed').length, 2);
  assert.equal(status.integrations.length, 2);
  assert.ok(status.integrations.every(item => item.status === 'integrated'));
  for (const node of status.nodes) {
    assert.equal(node.status, 'accepted');
    assert.equal(node.validity, 'valid');
    assert.equal(node.integrationStatus, 'integrated');
    assert.equal(node.acceptedChangeSetId, node.integratedChangeSetId);
  }
  const first = status.nodes.find(item => item.id === 'first');
  const initialRun = status.runs.find(item => item.id === first.runIds[0]);
  const initialChange = status.changeSets.find(item => item.id === initialRun.changeSetId);
  const repairedChange = status.changeSets.find(item => item.id === first.integratedChangeSetId);
  const repairedExecution = JSON.parse((await f.app.artifacts.get(repairedChange.executionArtifact)).toString('utf8'));
  assert.equal(repairedExecution.result.repairRestoration.status, 'restored');
  assert.equal(repairedExecution.result.repairRestoration.changeSetId, initialChange.id);
  assert.equal(repairedChange.baseRevision, f.baseline);
  const repairedPatch = (await f.app.artifacts.get(repairedChange.patchArtifact)).toString('utf8');
  assert.match(repairedPatch, /Preserve the captured implementation/);
  assert.match(repairedPatch, /exports = 2/);
  assert.notEqual(initialChange.id, first.integratedChangeSetId);
  assert.equal(git(f.root, ['rev-parse', initialChange.ref]), initialChange.headRevision);
  assert.equal(git(f.root, ['show', `${initialChange.headRevision}:first.cjs`]), failedSource.trim());
  assert.equal((await f.app.artifacts.verify(initialChange.patchArtifact)).ok, true);
  assert.equal((await f.app.artifacts.verify(initialChange.executionArtifact)).ok, true);
  const rejected = status.evaluations.find(item => item.runId === initialRun.id && item.status === 'rejected');
  const evidence = status.evidence.find(item => item.id === rejected.evidenceId);
  const failedCheck = evidence.criteria.find(item => item.id === 'first-value');
  assert.equal(failedCheck.result, 'fail');
  const originalLog = await f.app.artifacts.get(failedCheck.stdoutArtifact);
  assert.ok(originalLog.length > 65536, 'Full original diagnostics remain in immutable evidence.');
  assert.match(originalLog.toString('utf8'), new RegExp(completeLogMarker));
  assert.equal(status.workflow.goals.find(item => item.id === f.goal.id).phase, 'done');
  assert.equal(await readFile(path.join(f.root, 'first.cjs'), 'utf8'), repairedSource);
  assert.equal(await readFile(path.join(f.root, 'second.cjs'), 'utf8'), 'module.exports = 6;\n');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  const verification = await f.app.verify({ workspace: new GitWorktreeAdapter(f.root), integration: new GitIntegrationAdapter(f.root),
    candidateWorkspace: new GitIntegrationWorkspaceAdapter(f.root) });
  assert.equal(verification.ok, true, JSON.stringify(verification));
  return status;
}

test('one work request repairs a captured failed candidate and completes the real dependent chain exactly once', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const command = { commandId: 'repair-and-continue', goalId: f.goal.id };
  const completed = await f.wait(f.controller, await f.controller.work(command));
  assert.equal(completed.result.stopReason, 'goal-completed', JSON.stringify(completed.result));
  const status = await assertDeliveredAndRetained(f);
  const adopted = git(f.root, ['rev-parse', 'HEAD']), sequence = status.lastSequence;
  const jobs = await f.controller.jobs.list();
  assert.equal(jobs.filter(item => item.type === 'workflow.work').length, 1);
  assert.equal(jobs.filter(item => item.type === 'change.policy-accept').length, 2);
  assert.equal(jobs.filter(item => item.type === 'change.accept').length, 0);
  await f.controller.close();
  const restarted = f.createController(), replay = await restarted.work(command);
  assert.equal(replay.appended, false);
  const replayed = await f.wait(restarted, replay);
  assert.deepEqual(replayed.result, completed.result);
  const after = await f.app.getStatus();
  assert.equal(after.lastSequence, sequence);
  assert.equal(after.runs.length, 3);
  assert.equal(after.integrations.length, 2);
  assert.deepEqual(f.starts, ['first', 'first', 'second']);
  assert.equal((await restarted.jobs.list()).length, jobs.length);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), adopted);
});
