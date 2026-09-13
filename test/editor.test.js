import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import { FileOperationsExecutor, FILE_OPERATIONS_CAPABILITY } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { recordGitProcessFence } from '../src/adapters/git-process-fence.js';
import { GitProcessError } from '../src/adapters/git-process.js';
import { runCli } from '../src/cli.js';
import { CONSOLE_PROTOCOL, startEditor } from '../src/editor/server.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Optional adapter integration: a standalone FWA checkout still runs its core suite.
const fwePath = path.resolve(process.env.FWA_TEST_FWE_PATH || path.join(repositoryRoot, '..', 'fwe'));
const integration = { skip: !existsSync(path.join(fwePath, 'src', 'server.js')) && 'Sibling FWE unavailable; set FWA_TEST_FWE_PATH for real HTTP integration.' };

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-editor-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function project(t) {
  const root = await temporary(t);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'FWA Editor Test']);
  git(root, ['config', 'user.email', 'editor@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'unchanged\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'test: console fixture']);
  const application = new FwaApplication(root);
  await application.init();
  return { root, application };
}
async function editor(t, root, allowWrite = false) {
  const result = await startEditor({ projectRoot: root, fwePath, allowWrite, port: 0 });
  t.after(() => result.close());
  return result;
}
async function request(editor, route, options = {}) {
  const response = await fetch(editor.url + route, { signal: AbortSignal.timeout(10000), ...options });
  const text = await response.text();
  return { status: response.status, body: text.startsWith('{') ? JSON.parse(text) : text, headers: response.headers };
}
async function credentials(editor) {
  const session = (await request(editor, '/api/fwa/session')).body;
  return { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWA-CSRF': session.csrfToken,
    'X-FWA-Fingerprint': session.fingerprint };
}
function rawGet(editor, route, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(editor.url + route, { headers }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.setTimeout(10000, () => req.destroy(new Error('HTTP test timeout.')));
    req.on('error', reject);
  });
}
async function command(editor, headers, body) {
  return request(editor, '/api/fwa/commands', { method: 'POST', headers, body: JSON.stringify(body) });
}
function plan() {
  const node = (id, dependsOn) => ({ id, title: id, dependsOn, reads: ['seed.txt'], writes: [`${id}.txt`],
    capabilities: [FILE_OPERATIONS_CAPABILITY], acceptance: { checks: ['test'] },
    budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 30 } });
  return { schemaVersion: 1, nodes: [node('first', []), node('second', ['first'])] };
}
async function snapshot(root) {
  const output = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else output[path.relative(root, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await visit(root);
  return output;
}

test('editor requires an explicit compatible FWE and never initializes an uninitialized project', async (t) => {
  const root = await temporary(t);
  await assert.rejects(startEditor({ projectRoot: root, fwePath: 'relative' }), { code: 'editor-incompatible-fwe' });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fwe', version: '999.0.0' }));
  await assert.rejects(startEditor({ projectRoot: root, fwePath: root }), { code: 'editor-incompatible-fwe' });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fwe', version: '0.2.0' }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'server.js'), 'module.exports = {};');
  await assert.rejects(startEditor({ projectRoot: root, fwePath: root }), { code: 'editor-incompatible-fwe' });
  assert.equal(existsSync(path.join(root, '.fwa')), false);
});

test('editor read-only virtual source returns the real projection and generic CRUD cannot mutate it', integration, async (t) => {
  const { root, application } = await project(t);
  const goal = (await application.createGoal({ title: '<img src=x onerror=alert(1)>', commandId: 'seed-goal' })).goal;
  const before = await snapshot(path.join(root, '.fwa'));
  const instance = await editor(t, root);
  const publicApp = (await request(instance, '/api/app')).body;
  assert.equal(publicApp.domains[0].source.type, 'fwa-projection');
  assert.deepEqual(publicApp.domains[0].actions.toolbar, []);
  assert.equal(publicApp.domains[0].view[0].view, 'fwa-console');
  const session = (await request(instance, '/api/fwa/session')).body;
  assert.equal(session.protocol, CONSOLE_PROTOCOL);
  assert.equal(session.allowWrite, false);
  assert.deepEqual(session.commands, []);
  assert.equal(publicApp.labels.fwaConsole.fingerprint, session.fingerprint);
  assert.equal(session.fingerprint, instance.fingerprint);
  assert.match(session.launchRevision, /^fwe-launch-v1:[a-f0-9]{64}$/);
  const list = await request(instance, '/api/domains/fwa-projection/files');
  assert.deepEqual(list.body.files.map((item) => item.name), ['projection.json', `objects/goals/${encodeURIComponent(goal.id)}.json`]);
  const resource = await request(instance, '/api/domains/fwa-projection/files/projection.json');
  assert.deepEqual(resource.body.data, await application.getStatus());
  const status = await request(instance, '/api/fwa/status');
  for (const key of ['goals', 'nodes', 'runs', 'evidence', 'changeSets', 'refs', 'integrations', 'reversions']) assert.ok(Array.isArray(status.body[key]));
  assert.equal(status.body.operational.gitProcessFence.held, false);
  assert.equal((await request(instance, publicApp.clientExtensions[0].url)).status, 200);
  for (const [method, route] of [['POST', '/api/domains/fwa-projection/files'], ['PUT', '/api/domains/fwa-projection/files/projection.json'], ['DELETE', '/api/domains/fwa-projection/files/projection.json'], ['POST', '/api/app/stop']]) {
    assert.equal((await request(instance, route, { method, headers: { 'X-FWE-App': 'fwa-console' } })).status, 405);
  }
  assert.equal((await command(instance, await credentials(instance), { type: 'goal.create', commandId: 'forbidden', payload: { title: 'Not created' } })).status, 403);
  assert.deepEqual(await snapshot(path.join(root, '.fwa')), before);
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('editor rejects hostile Host, Origin, CSRF, stale fingerprints and arbitrary commands/paths', integration, async (t) => {
  const { root, application } = await project(t);
  const instance = await editor(t, root, true);
  for (const headers of [{ Host: 'attacker.invalid' }, { Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    // Fetch implementations can normalize forbidden headers; send exact wire values.
    assert.equal(await rawGet(instance, '/api/fwa/session', headers), 403, JSON.stringify(headers));
    assert.equal(await rawGet(instance, '/', headers), 403, JSON.stringify(headers));
  }
  const headers = await credentials(instance);
  const body = { type: 'goal.create', commandId: 'secure-create', payload: { title: 'Should remain absent' } };
  for (const change of [{ Origin: '' }, { Origin: 'null' }, { 'X-FWA-CSRF': '' }, { 'X-FWA-CSRF': 'bad' }]) {
    assert.equal((await command(instance, { ...headers, ...change }, body)).status, 403);
  }
  assert.equal((await command(instance, { ...headers, 'X-FWA-Fingerprint': 'stale' }, body)).status, 409);
  assert.equal((await command(instance, { ...headers, 'Content-Type': 'text/plain' }, body)).status, 415);
  for (const changed of [{ ...body, type: 'run.next' }, { ...body, type: 'git.recover' },
    { ...body, payload: { title: 'unsafe', projectRoot: '../outside' } }, { ...body, commandId: '../id' },
    { type: 'plan.load', commandId: 'bad-plan', payload: { goalId: 'goal', planPath: '../input.json' } }]) {
    assert.equal((await command(instance, headers, changed)).status, 400);
  }
  assert.equal((await request(instance, '/api/fwa/commands', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await request(instance, '/api/fwa/commands', { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(129 * 1024) }) })).status, 413);
  assert.equal((await application.getStatus()).eventCount, 0);
});

test('goal and plan commands are validated and durably idempotent across console restarts', integration, async (t) => {
  const { root, application } = await project(t);
  const instance = await editor(t, root, true);
  const headers = await credentials(instance);
  const create = { type: 'goal.create', commandId: 'create-once', payload: { title: 'From HTTP', request: 'Traceable request' } };
  const results = await Promise.all([command(instance, headers, create), command(instance, headers, create)]);
  assert.deepEqual(results.map((value) => value.status), [200, 200]);
  assert.equal((await application.getStatus()).goals.length, 1);
  assert.equal(results[0].body.result.goal.id, results[1].body.result.goal.id);
  const goalId = results[0].body.result.goal.id;
  const load = { type: 'plan.load', commandId: 'plan-once', payload: { goalId, plan: plan() } };
  assert.equal((await command(instance, headers, load)).status, 200);
  const count = (await application.getStatus()).eventCount;
  assert.equal((await command(instance, headers, load)).body.result.appended, false);
  assert.equal((await command(instance, headers, { ...create, payload: { title: 'Different intent' } })).body.code, 'idempotency-conflict');
  const invalidPlan = plan(); invalidPlan.nodes[0].dependsOn = ['second'];
  assert.equal((await command(instance, headers, { ...load, commandId: 'cycle', payload: { goalId, plan: invalidPlan } })).status, 409);
  assert.equal((await application.getStatus()).eventCount, count);
  await instance.close();
  const reopened = await editor(t, root, true);
  assert.equal((await command(reopened, await credentials(reopened), create)).body.result.appended, false);
  assert.equal((await application.getStatus()).goals.length, 1);
  assert.equal((await command(reopened, headers, create)).status, 403, 'Old process token must not survive restart.');
});

test('real Git rejected Run retries via HTTP without replacing evidence, and fences cannot be cleared', integration, async (t) => {
  const { root, application } = await project(t);
  const instance = await editor(t, root, true);
  const headers = await credentials(instance);
  const goal = (await command(instance, headers, { type: 'goal.create', commandId: 'goal', payload: { title: 'Retry' } })).body.result.goal;
  await command(instance, headers, { type: 'plan.load', commandId: 'plan', payload: { goalId: goal.id, plan: plan() } });
  const workspace = new GitWorktreeAdapter(root);
  const produced = await application.runNext({ nodeId: 'first', commandId: 'run', executor: new FileOperationsExecutor(), workspace,
    input: { schemaVersion: 1, operations: [{ type: 'write', path: 'first.txt', content: 'candidate\n' }] } });
  assert.equal(produced.ok, true);
  const rejected = await application.evaluateChangeSet({ changeSetId: produced.changeSet.id, commandId: 'reject', workspace,
    evaluator: new CommandEvaluator(), profile: { schemaVersion: 1, id: 'console-rejection', checks: [{
      id: 'test', kind: 'test', command: process.execPath, args: ['-e', 'process.exit(7)'], timeoutMs: 10000, expectedExitCodes: [0]
    }] } });
  assert.equal(rejected.node.status, 'rejected');
  const before = await application.getStatus();
  const held = await application.lease.acquire({ runId: 'another-operator', ttlMs: 30000 });
  const retry = { type: 'node.retry', commandId: 'retry-once', payload: { nodeId: 'first', reason: 'Fix rejected output' } };
  assert.equal((await command(instance, headers, retry)).body.code, 'workspace-lease-held');
  assert.equal((await application.lease.inspect()).held, true);
  await application.lease.release({ leaseId: held.lease.leaseId, ownerToken: held.ownerToken });
  assert.equal((await command(instance, headers, retry)).body.result.node.status, 'ready');
  assert.equal((await command(instance, headers, retry)).body.result.appended, false);
  assert.deepEqual((await application.getStatus()).evidence, before.evidence);
  const fenced = await recordGitProcessFence(root, { details: { pid: 123456789, cwd: root, arguments: ['status'], reason: 'test-unconfirmed', timeoutMs: 10, terminationGraceMs: 10 } }, GitProcessError);
  const afterFence = await snapshot(path.join(root, '.fwa'));
  assert.equal((await command(instance, headers, { type: 'goal.create', commandId: 'fenced-create', payload: { title: 'Blocked' } })).body.code, 'editor-git-fenced');
  assert.equal((await command(instance, headers, { type: 'git.recover', commandId: 'fenced-recover', payload: { expectedFenceId: fenced.fence.id, confirmProcessesStopped: true } })).status, 400);
  const status = (await request(instance, '/api/fwa/status')).body;
  assert.equal(status.operational.gitProcessFence.fence.id, fenced.fence.id);
  assert.deepEqual(await snapshot(path.join(root, '.fwa')), afterFence);
});

test('editor CLI validates options and holds its guarded server until abort', integration, async (t) => {
  const { root } = await project(t);
  const errors = [];
  for (const args of [['editor'], ['editor', '--fwe-path', 'relative'], ['editor', '--fwe-path', fwePath, '--port', '0'], ['status', '--allow-write']]) {
    assert.equal(await runCli(args, { cwd: root, stderr: { write: (text) => errors.push(text) } }), 2);
  }
  // Programmatic launcher provides ephemeral ports for tests; CLI intentionally does not.
  const controller = new AbortController();
  const instance = await startEditor({ projectRoot: root, fwePath, port: 0, signal: controller.signal });
  assert.equal((await request(instance, '/api/fwa/status')).status, 200);
  controller.abort(); await instance.closed;
  await assert.rejects(fetch(instance.url + '/api/app'));
});

for (const changedFile of ['fwa/src/editor/app/console.js', 'fwa/src/core/dag.js', 'fwe/public/app.js']) {
  test(`source drift fails closed before assets/session/commands: ${changedFile}`, integration, async (t) => {
    const { root, application } = await project(t);
    const copyRoot = await temporary(t);
    for (const [name, source, directories] of [['fwa', repositoryRoot, ['bin', 'src']], ['fwe', fwePath, ['bin', 'src', 'public', 'templates']]]) {
      const destination = path.join(copyRoot, name);
      await mkdir(destination);
      await cp(path.join(source, 'package.json'), path.join(destination, 'package.json'));
      for (const directory of directories) await cp(path.join(source, directory), path.join(destination, directory), { recursive: true });
    }
    const copiedModule = await import(pathToFileURL(path.join(copyRoot, 'fwa', 'src', 'editor', 'server.js')).href);
    const instance = await copiedModule.startEditor({ projectRoot: root, fwePath: path.join(copyRoot, 'fwe'), allowWrite: true, port: 0 });
    t.after(() => instance.close());
    const headers = await credentials(instance);
    const app = (await request(instance, '/api/app')).body;
    const file = path.join(copyRoot, changedFile);
    const original = await readFile(file, 'utf8');
    await writeFile(file, `${original}\n// changed after guarded server launch\n`);
    for (const route of ['/', '/api/app', '/api/fwa/session', app.clientExtensions[0].url]) assert.equal((await request(instance, route)).status, 503);
    assert.equal((await command(instance, headers, { type: 'goal.create', commandId: 'drift-blocked', payload: { title: 'Must not commit' } })).status, 503);
    assert.equal((await application.getStatus()).eventCount, 0);
    await writeFile(file, original);
    assert.equal((await request(instance, '/api/fwa/session')).status, 503, 'Detected source drift remains blocked even after restoring bytes.');
  });
}
