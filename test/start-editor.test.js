import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { checkLaunch, launchEditor, prepareDemo, selectLaunch } from '../tools/start-editor.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const fwePath = path.resolve(process.env.FWA_TEST_FWE_PATH || path.join(packageRoot, '..', 'fwe'));
const integration = { skip: !existsSync(path.join(fwePath, 'src', 'server.js')) && 'Sibling FWE unavailable.' };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-launcher-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

test('launcher selects persistent demo and keeps explicit projects read-only', () => {
  const demo = selectLaunch([], { packageRoot });
  assert.equal(demo.projectRoot, path.join(packageRoot, '.local', 'demo'));
  assert.equal(demo.allowWrite, true);
  assert.equal(demo.port, 0);
  assert.equal(demo.open, true);
  const supplied = selectLaunch(['--project', 'game', '--port', '1234', '--no-open'], { packageRoot });
  assert.equal(supplied.allowWrite, false);
  assert.equal(supplied.open, false);
  assert.equal(supplied.port, 1234);
  assert.equal(selectLaunch(['--project', 'game', '--allow-write']).allowWrite, true);
  for (const args of [['--port', '-1'], ['--port', '65536'], ['--project'], ['--check', '--check'], ['--unknown']]) {
    assert.throws(() => selectLaunch(args));
  }
});

test('check creates no demo or server; explicit uninitialized project remains untouched', integration, async t => {
  const root = await fixture(t);
  const result = await launchEditor(['--check', '--fwe-path', fwePath], { packageRoot: root });
  assert.equal(result.createDemo, true);
  assert.deepEqual(await readdir(root), []);
  await mkdir(path.join(root, 'game'));
  const explicit = selectLaunch(['--project', path.join(root, 'game'), '--fwe-path', fwePath], { packageRoot: root });
  await assert.rejects(checkLaunch(explicit), /not initialized/);
  await assert.rejects(prepareDemo(explicit), /Only the bundled demo/);
  assert.deepEqual(await readdir(explicit.projectRoot), []);
});

test('first launch serves HTTP and second launch retains demo files, identity and goals', integration, async t => {
  const root = await fixture(t);
  const args = ['--fwe-path', fwePath, '--no-open'];
  const first = await launchEditor(args, { packageRoot: root });
  t.after(() => first.close());
  assert.equal(first.allowWrite, true);
  assert.equal((await fetch(first.url)).status, 200);
  const application = new FwaApplication(first.projectRoot);
  await application.createGoal({ title: 'Keep this demo goal' });
  await writeFile(path.join(first.projectRoot, 'notes.txt'), 'preserved');
  const before = await application.getStatus();
  const gitHead = await readFile(path.join(first.projectRoot, '.git', 'HEAD'), 'utf8');
  await first.close();

  const second = await launchEditor(args, { packageRoot: root });
  t.after(() => second.close());
  assert.equal((await fetch(`${second.url}/api/fwa/session`)).status, 200);
  const after = await application.getStatus();
  assert.equal(after.projectId, before.projectId);
  assert.deepEqual(after.goals, before.goals);
  assert.equal(await readFile(path.join(second.projectRoot, 'notes.txt'), 'utf8'), 'preserved');
  assert.equal(await readFile(path.join(second.projectRoot, '.git', 'HEAD'), 'utf8'), gitHead);
  assert.equal(existsSync(path.join(root, '.fwa')), false);
  await second.close();

  const explicit = await launchEditor(['--project', first.projectRoot, ...args], { packageRoot: root });
  t.after(() => explicit.close());
  assert.equal(explicit.allowWrite, false);
  assert.equal((await fetch(explicit.url)).status, 200);
});

test('an incomplete existing demo is kept and reported instead of reinitialized', integration, async t => {
  const root = await fixture(t);
  const selection = selectLaunch(['--fwe-path', fwePath], { packageRoot: root });
  await mkdir(selection.projectRoot, { recursive: true });
  await writeFile(path.join(selection.projectRoot, 'keep.txt'), 'untouched');
  await assert.rejects(prepareDemo(selection), /not initialized/);
  assert.deepEqual(await readdir(selection.projectRoot), ['keep.txt']);
});
