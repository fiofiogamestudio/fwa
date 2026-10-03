import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runGitProcess } from '../src/adapters/git-process.js';

function managedChild() {
  const child = new EventEmitter();
  child.pid = 123456789;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  return child;
}

async function withStalledTaskkill(t, operation) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (executable, arguments_, options) => {
    assert.equal(executable, 'taskkill.exe');
    assert.deepEqual(arguments_, ['/PID', '123456789', '/T', '/F']);
    assert.equal(options.shell, false);
    calls.push('taskkill-start');
    const helper = new EventEmitter();
    helper.unref = () => {};
    helper.kill = (signal) => { assert.equal(signal, 'SIGKILL'); calls.push('taskkill-stop'); };
    return helper;
  };
  syncBuiltinESMExports();
  try { await operation(calls); }
  finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
}

async function tick(t, milliseconds) {
  t.mock.timers.tick(milliseconds);
  // Dispatch termination, its helper promise, and the managed close continuation.
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test('Windows Git termination reserves time to confirm fallback after a stalled tree helper', async (t) => {
  await withStalledTaskkill(t, async (calls) => {
    const child = managedChild();
    child.kill = () => { calls.push('child-stop'); child.emit('close', null, 'SIGKILL'); return true; };
    const result = runGitProcess('git', [], { platform: 'win32', timeoutMs: 10,
      terminationGraceMs: 2_000, spawnImpl: () => child }).catch(error => error);
    try {
      await tick(t, 10);
      assert.deepEqual(calls, ['taskkill-start']);
      await tick(t, 1_000);
      assert.deepEqual(calls, ['taskkill-start', 'taskkill-stop', 'child-stop']);
      const error = await result;
      assert.equal(error.code, 'git-command-timeout');
      assert.equal(error.details.terminationConfirmed, true);
      assert.equal(error.details.processTreeTerminationAttempted, true);
    } finally {
      child.emit('close', null, 'SIGKILL');
      await tick(t, 2_000);
      await result;
    }
  });
});

test('Windows Git fallback retains the original total grace and unconfirmed termination boundary', async (t) => {
  await withStalledTaskkill(t, async (calls) => {
    const child = managedChild();
    child.kill = () => { calls.push('child-stop'); return true; };
    let settled = false;
    const result = runGitProcess('git', [], { platform: 'win32', timeoutMs: 10,
      terminationGraceMs: 100, spawnImpl: () => child }).catch(error => { settled = true; return error; });
    try {
      await tick(t, 10);
      await tick(t, 50);
      assert.deepEqual(calls, ['taskkill-start', 'taskkill-stop', 'child-stop']);
      assert.equal(settled, false);
      await tick(t, 49);
      assert.equal(settled, false);
      await tick(t, 1);
      const error = await result;
      assert.equal(error.code, 'git-process-termination-unconfirmed');
      assert.equal(error.details.terminationConfirmed, false);
      assert.equal(error.details.reason, 'git-command-timeout');
      assert.equal(error.details.terminationGraceMs, 100);
      assert.equal(child.stdout.destroyed, true);
      assert.equal(child.stderr.destroyed, true);
    } finally {
      await tick(t, 100);
      child.emit('close', null, 'SIGKILL');
      await result;
    }
  });
});

test('Windows Git default grace preserves the existing two second tree attempt', async (t) => {
  await withStalledTaskkill(t, async (calls) => {
    const child = managedChild();
    child.kill = () => { calls.push('child-stop'); child.emit('close', null, 'SIGKILL'); return true; };
    const result = runGitProcess('git', [], { platform: 'win32', timeoutMs: 10,
      spawnImpl: () => child }).catch(error => error);
    try {
      await tick(t, 10);
      await tick(t, 1_999);
      assert.deepEqual(calls, ['taskkill-start']);
      await tick(t, 1);
      assert.deepEqual(calls, ['taskkill-start', 'taskkill-stop', 'child-stop']);
      const error = await result;
      assert.equal(error.code, 'git-command-timeout');
      assert.equal(error.details.terminationConfirmed, true);
      assert.equal(error.details.terminationGraceMs, 5_000);
    } finally {
      child.emit('close', null, 'SIGKILL');
      await tick(t, 5_000);
      await result;
    }
  });
});
