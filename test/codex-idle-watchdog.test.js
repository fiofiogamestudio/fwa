import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexExecutor, DEFAULT_CODEX_IDLE_TIMEOUT_MS, DEFAULT_CODEX_TIMEOUT_MS } from '../src/adapters/codex-executor.js';
import { classifyFailure } from '../src/core/failure-diagnostics.js';

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-idle-watchdog-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function fake() {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const kills = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    const close = (code = 0, signal = null) => {
      if (closed) return;
      closed = true; child.emit('close', code, signal);
    };
    child.kill = signal => { kills.push(signal); queueMicrotask(() => close(null, signal)); return true; };
    child.unref = () => {};
    queueMicrotask(() => ready({ child, close }));
    return child;
  };
  return { spawnImpl, started, kills };
}
const request = workspaceRoot => ({ workspaceRoot, node: { id: 'idle-node', capabilities: ['code_edit', 'shell'] },
  input: { schemaVersion: 1, prompt: 'Perform one change.' } });

test('default inactivity watchdog stops silence with confirmed termination while total duration remains unlimited', async t => {
  const root = await directory(t), port = fake();
  t.mock.timers.enable();
  assert.equal(DEFAULT_CODEX_TIMEOUT_MS, null);
  assert.equal(DEFAULT_CODEX_IDLE_TIMEOUT_MS, 15 * 60 * 1000);
  const executor = new CodexExecutor({ executable: 'fake-codex', spawnImpl: port.spawnImpl });
  const outcome = executor.execute(request(root)).then(value => ({ value }), error => ({ error }));
  await port.started;
  t.mock.timers.tick(DEFAULT_CODEX_IDLE_TIMEOUT_MS - 1);
  assert.deepEqual(port.kills, []);
  t.mock.timers.tick(1);
  const { error } = await outcome;
  assert.equal(error.code, 'FWA_CODEX_IDLE_TIMEOUT');
  assert.equal(error.details.process.terminationConfirmed, true);
  assert.equal(error.details.process.idleTimedOut, true);
  assert.equal(error.details.process.timedOut, false);
  assert.equal(classifyFailure(error).retryDisposition, 'inspect');
  t.mock.timers.tick(DEFAULT_CODEX_IDLE_TIMEOUT_MS * 2);
  assert.deepEqual(port.kills, ['SIGKILL']);
});

test('stdout and stderr bytes reset inactivity and completion clears the watchdog', async t => {
  const root = await directory(t), port = fake();
  t.mock.timers.enable();
  const executor = new CodexExecutor({ executable: 'fake-codex', spawnImpl: port.spawnImpl,
    timeoutMs: null, idleTimeoutMs: 100 });
  const execution = executor.execute(request(root));
  const { child, close } = await port.started;
  t.mock.timers.tick(80); child.stdout.write('{"type":"working"}\n');
  t.mock.timers.tick(80); child.stderr.write('continuing\n');
  t.mock.timers.tick(80); child.stdout.write('{"type":"turn.completed"}\n');
  assert.deepEqual(port.kills, []);
  close();
  assert.equal((await execution).ok, true);
  t.mock.timers.tick(1000);
  assert.deepEqual(port.kills, []);
});

test('empty data does not reset inactivity and null or zero disables it explicitly', async t => {
  const root = await directory(t);
  t.mock.timers.enable();
  const port = fake(), executor = new CodexExecutor({ executable: 'fake-codex', spawnImpl: port.spawnImpl, idleTimeoutMs: 100 });
  const outcome = executor.execute(request(root)).then(value => ({ value }), error => ({ error }));
  const { child } = await port.started;
  t.mock.timers.tick(90); child.stdout.emit('data', Buffer.alloc(0));
  t.mock.timers.tick(10);
  assert.equal((await outcome).error.code, 'FWA_CODEX_IDLE_TIMEOUT');
  for (const idleTimeoutMs of [null, 0]) {
    const disabled = fake(), run = new CodexExecutor({ executable: 'fake-codex', spawnImpl: disabled.spawnImpl, idleTimeoutMs });
    const execution = run.execute(request(root)), controls = await disabled.started;
    t.mock.timers.tick(60 * 60 * 1000);
    assert.deepEqual(disabled.kills, []);
    controls.child.stdout.write('{"type":"turn.completed"}\n'); controls.close();
    assert.equal((await execution).ok, true);
  }
  for (const value of [-1, 1.5, Infinity, '100', 2147483648]) {
    assert.throws(() => new CodexExecutor({ idleTimeoutMs: value }), /idleTimeoutMs/);
  }
});

test('inactivity watchdog stops a real silent child and waits for its close event', async t => {
  const root = await directory(t);
  const executor = new CodexExecutor({ executable: process.execPath, idleTimeoutMs: 50, timeoutMs: null,
    terminationGraceMs: 5000,
    spawnImpl: (_executable, _args, options) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options) });
  await assert.rejects(executor.execute(request(root)), error => error.code === 'FWA_CODEX_IDLE_TIMEOUT'
    && error.details.process.terminationConfirmed === true && error.details.process.stdoutBytes === 0);
});
