import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FwaApplication } from '../src/application/fwa-application.js';
import { WorkbenchController } from '../src/application/workbench-controller.js';

const file = (name, content) => ({ path: name, base64: Buffer.from(content).toString('base64') });
const git = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-reference-retry-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Test']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'base\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']);
  const app = new FwaApplication(root); await app.init();
  const inputs = [];
  const executor = { schemaVersion: 1, id: 'unchanged-failure', version: '1', capabilities: ['code_edit'],
    async execute({ input }) {
      inputs.push(structuredClone(input));
      throw Object.assign(new Error('The same fixture compilation failure.'), { code: 'fixture-compile-failed' });
    } };
  const controller = new WorkbenchController(app, { executor, planner: null });
  await controller.library.init();
  const imported = await controller.library.importFiles({ commandId: 'import', libraryId: 'brief', label: 'Brief',
    files: [file('brief.md', 'Use the specified layout.'), file('image.png', 'fixture image bytes')] });
  const binding = { libraryId: imported.libraryId, versionId: imported.versionId, manifestHash: imported.hash };
  const goal = (await app.createGoal({ title: 'Reference repair', request: 'Implement the imported brief', commandId: 'goal' })).goal;
  await app.loadPlan({ goalId: goal.id, commandId: 'plan', plan: { schemaVersion: 1, nodes: [{
    id: 'task', title: 'Implement the brief', outcome: 'The requested layout works.', instruction: 'Implement the imported brief.',
    dependsOn: [], dependencyReasons: [], reads: ['seed.txt'], writes: ['result.txt'], capabilities: ['code_edit'],
    acceptance: { checks: ['layout'] }, referenceInputs: [binding], budget: { maxRetries: 4, maxFiles: 1, maxDiffLines: 20 }
  }] } });
  return { root, app, controller, executor, inputs, binding, goal };
}

test('reference execution input stays identical across requests, controller restart and unrelated library events', async t => {
  const f = await fixture(t), captured = [];
  f.app.runReadyBatch = async ({ executions }) => {
    captured.push(executions[0].input);
    return { ok: false, members: [{ nodeId: 'task', ok: false }], deferred: [] };
  };
  await f.controller.runGoal({ goalId: f.goal.id, commandId: 'first' });
  await f.controller.library.importFiles({ commandId: 'unrelated', libraryId: 'other', label: 'Other', files: [file('other.md', 'Unrelated')] });
  const restarted = new WorkbenchController(f.app, { executor: f.executor, planner: null });
  await restarted.runGoal({ goalId: f.goal.id, commandId: 'second' });
  assert.deepEqual(captured[1], captured[0], 'snapshot location and unrelated journal events are not repaired input');
  assert.equal(await readFile(captured[1].images[0], 'utf8'), 'fixture image bytes');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
});

test('two identical failures with imported references block a third Run; changed permission is a new input', async t => {
  const f = await fixture(t);
  for (const commandId of ['first', 'second']) {
    assert.equal((await f.controller.runGoal({ goalId: f.goal.id, commandId })).stopReason, 'execution-failed');
  }
  const before = await f.app.getStatus();
  assert.equal(before.retryDiagnostics[0].code, 'retry-no-progress');
  const blocked = await f.controller.runGoal({ goalId: f.goal.id, commandId: 'third' });
  assert.equal(blocked.stopReason, 'retry-no-progress');
  assert.equal(f.inputs.length, 2);
  const after = await f.app.getStatus();
  assert.equal(after.runs.length, 2); assert.equal(after.eventCount, before.eventCount);
  await f.controller.library.setPermission({ commandId: 'deny-image', libraryId: 'brief', path: 'image.png', access: 'deny' });
  assert.equal((await f.controller.runGoal({ goalId: f.goal.id, commandId: 'changed-reference-access' })).stopReason, 'execution-failed');
  assert.equal(f.inputs.length, 3); assert.deepEqual(f.inputs[2].images, []);
  assert.notDeepEqual(f.inputs[2], f.inputs[1]);
  assert.equal((await f.app.verify()).ok, true);
});

test('reused reference bytes are verified and a corrupt snapshot never reaches execution', async t => {
  const f = await fixture(t);
  const first = await f.controller.referenceContext([f.binding]);
  await writeFile(first.images[0], 'tampered');
  await assert.rejects(f.controller.runGoal({ goalId: f.goal.id, commandId: 'corrupt' }), /snapshot|content|hash/i);
  assert.equal(f.inputs.length, 0); assert.equal((await f.app.getStatus()).runs.length, 0);
  assert.equal(await readFile(first.images[0], 'utf8'), 'tampered', 'validation must not silently replace the suspect snapshot');
});
