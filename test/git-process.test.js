import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  DEFAULT_GIT_TIMEOUT_MS,
  GitProcessError,
  GitProcessGuard,
  runGitProcess
} from '../src/adapters/git-process.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';
import { recordGitProcessFence } from '../src/adapters/git-process-fence.js';

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-git-process-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('fwa-git-process-'));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123456789;
  child.kill = () => true;
  child.unref = () => {};
  return child;
}

function unconfirmed(root) {
  return new GitProcessError('Synthetic unconfirmed Git child.', 'git-process-termination-unconfirmed', {
    details: {
      terminationConfirmed: false, processTreeTerminationAttempted: true,
      pid: 123456789, cwd: root, arguments: ['worktree', 'add'],
      reason: 'git-command-timeout', timeoutMs: 50, terminationGraceMs: 20
    }
  });
}

async function seedFence(root) {
  const guard = new GitProcessGuard(root);
  await assert.rejects(guard.run(async () => { throw unconfirmed(root); }, 'git', [], {}),
    (error) => error.code === 'git-process-termination-unconfirmed' && error.details.fencePersisted === true);
  return guard.inspect();
}

test('Git subprocess preserves normal output and allowed exit statuses', async () => {
  const result = await runGitProcess(process.execPath, ['-e', "process.stdout.write('ok'); process.stderr.write('note'); process.exit(3)"], {
    allowedExitCodes: [3], timeoutMs: 5_000
  });
  assert.deepEqual(result, { status: 3, signal: null, stdout: 'ok', stderr: 'note' });
});

test('Git timeout terminates the real child and rejects instead of accepting its eventual output', async () => {
  const started = Date.now();
  await assert.rejects(runGitProcess(process.execPath, ['-e', "setTimeout(()=>process.stdout.write('too-late'), 3000)"], {
    timeoutMs: 150, terminationGraceMs: 2_000
  }), (error) => error.code === 'git-command-timeout'
    && error.details.terminationConfirmed === true
    && error.details.processTreeTerminationAttempted === true);
  assert.ok(Date.now() - started < 3_000);
});

test('Git abort before launch creates no child', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(runGitProcess('git', [], {
    signal: controller.signal, spawnImpl() { calls += 1; }
  }), (error) => error.code === 'git-command-aborted' && error.details.terminationConfirmed === true);
  assert.equal(calls, 0);
});

test('Git abort after launch waits for a real child close', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await assert.rejects(runGitProcess(process.execPath, ['-e', 'setTimeout(()=>{},3000)'], {
      timeoutMs: 5_000, terminationGraceMs: 2_000, signal: controller.signal
    }), (error) => error.code === 'git-command-aborted' && error.details.terminationConfirmed === true);
  } finally { clearTimeout(timer); }
});

test('combined Git stdout/stderr limit stops the child and does not return truncated success', async () => {
  await assert.rejects(runGitProcess(process.execPath, ['-e', "process.stdout.write('a'.repeat(1000)); process.stderr.write('b'.repeat(1000)); setTimeout(()=>{},3000)"], {
    maxOutputBytes: 1_500, timeoutMs: 5_000, terminationGraceMs: 2_000
  }), (error) => error.code === 'git-output-limit' && error.details.terminationConfirmed === true);
});

test('Git timeout remains failed even if the child closes with exit zero', async () => {
  const child = fakeChild();
  let terminationCalls = 0;
  await assert.rejects(runGitProcess('git', [], {
    timeoutMs: 10, terminationGraceMs: 100,
    spawnImpl: () => child,
    terminateImpl: async () => {
      terminationCalls += 1;
      child.emit('close', 0, null);
    }
  }), (error) => error.code === 'git-command-timeout' && error.details.status === 0);
  assert.equal(terminationCalls, 1);
});

test('Git unconfirmed close is bounded and cannot be interpreted as a normal timeout', async () => {
  const child = fakeChild();
  await assert.rejects(runGitProcess('git', ['status'], {
    timeoutMs: 10, terminationGraceMs: 20,
    spawnImpl: () => child, terminateImpl: async () => {}
  }), (error) => error.code === 'git-process-termination-unconfirmed'
    && error.details.terminationConfirmed === false
    && error.details.reason === 'git-command-timeout');
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  child.emit('close', 0, null);
});

test('all Git adapters validate bounds and forward configured command budgets', async (t) => {
  const root = await tempRoot(t);
  const abort = new Error('stop after inspecting forwarded options');
  for (const Adapter of [GitWorktreeAdapter, GitIntegrationAdapter, GitIntegrationWorkspaceAdapter]) {
    assert.throws(() => new Adapter(root, { gitTimeoutMs: 0 }), { code: 'invalid-git-process-options' });
    assert.throws(() => new Adapter(root, { gitTerminationGraceMs: 60_001 }), { code: 'invalid-git-process-options' });
    const subject = new Adapter(root, {
      gitTimeoutMs: 321, gitTerminationGraceMs: 123,
      gitRunner: async (_executable, _args, options) => {
        assert.equal(options.timeoutMs, 321);
        assert.equal(options.terminationGraceMs, 123);
        assert.equal(options.env.GIT_CONFIG_KEY_0, 'core.fsmonitor');
        assert.equal(options.env.GIT_CONFIG_VALUE_0, 'false');
        throw abort;
      }
    });
    const operation = Adapter === GitWorktreeAdapter
      ? () => subject.inspect()
      : Adapter === GitIntegrationAdapter
        ? () => subject.prepare({
          integrationId: 'budget1', changeSetId: 'changeset1', targetRef: 'refs/heads/main',
          expectedTargetRevision: 'a'.repeat(40), changeSetHeadRevision: 'b'.repeat(40)
        })
        : () => subject.listCandidateRefs();
    await assert.rejects(operation(), (error) => error === abort || error.cause === abort);
    assert.equal(new Adapter(root).gitProcessOptions.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS);
  }
});

test('unconfirmed Git failure fences the same adapter before cleanup invokes Git', async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const subject = new GitWorktreeAdapter(root, {
    gitRunner: async () => { calls += 1; throw unconfirmed(root); }
  });
  await assert.rejects(subject.inspect(), { code: 'git-process-termination-unconfirmed' });
  assert.equal(calls, 1);
  await assert.rejects(subject.remove({ runId: 'run1', force: true }), { code: 'git-process-termination-unconfirmed' });
  await assert.rejects(subject.removeEvaluation({ evaluationId: 'eval1' }), { code: 'git-process-termination-unconfirmed' });
  assert.equal(calls, 1);
  assert.equal((await subject.inspectProcessFence()).held, true);
});

test('durable Git fence blocks new adapter instances and preserves managed directories', async (t) => {
  const root = await tempRoot(t);
  await seedFence(root);
  const owned = path.join(root, '.fwa', 'integrations', 'integration1');
  await mkdir(owned, { recursive: true });
  await writeFile(path.join(owned, 'evidence.txt'), 'preserve');
  let calls = 0;
  const options = { gitRunner: async () => { calls += 1; } };
  await assert.rejects(new GitWorktreeAdapter(root, options).inspect(), { code: 'git-process-termination-unconfirmed' });
  await assert.rejects(new GitIntegrationAdapter(root, options).verifyChangeSet({}), { code: 'git-process-termination-unconfirmed' });
  await assert.rejects(new GitIntegrationWorkspaceAdapter(root, options).cleanup({ integrationId: 'integration1' }), {
    code: 'git-process-termination-unconfirmed'
  });
  assert.equal(calls, 0);
  assert.equal(await readFile(path.join(owned, 'evidence.txt'), 'utf8'), 'preserve');
});

test('explicit matching Git fence recovery archives exact bytes with a hash-bound assertion', async (t) => {
  const root = await tempRoot(t);
  const inspection = await seedFence(root);
  const subject = new GitWorktreeAdapter(root);
  await assert.rejects(subject.recoverProcessFence({ expectedFenceId: inspection.fence.id }), {
    code: 'git-process-recovery-confirmation-required'
  });
  await assert.rejects(subject.recoverProcessFence({ expectedFenceId: `git-fence_${'a'.repeat(36)}`, confirmProcessesStopped: true }), {
    code: 'git-process-fence-mismatch'
  });
  const bytes = await readFile(inspection.path);
  const recovery = await subject.recoverProcessFence({
    expectedFenceId: inspection.fence.id, confirmProcessesStopped: true
  });
  assert.equal(recovery.recovered, true);
  assert.deepEqual(await readFile(recovery.archivedFencePath), bytes);
  const receipt = JSON.parse(await readFile(recovery.receiptPath, 'utf8'));
  assert.equal(receipt.fenceDigest, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(receipt.confirmProcessesStopped, true);
  assert.equal((await new GitWorktreeAdapter(root).inspectProcessFence()).held, false);
});

test('concurrent recovery permits at most one successful release and retains the original record', async (t) => {
  const root = await tempRoot(t);
  const inspection = await seedFence(root);
  const options = { expectedFenceId: inspection.fence.id, confirmProcessesStopped: true };
  const results = await Promise.allSettled([
    new GitWorktreeAdapter(root).recoverProcessFence(options),
    new GitIntegrationWorkspaceAdapter(root).recoverProcessFence(options)
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const files = await readdir(path.join(root, '.fwa', 'git-process-recoveries'));
  assert.equal(files.filter((file) => file.endsWith('.fence.json')).length, 1);
  assert.equal((await new GitWorktreeAdapter(root).inspectProcessFence()).held, false);
});

test('recovery guard blocks a fresh adapter throughout a marker replacement/rename race', async (t) => {
  const root = await tempRoot(t);
  const inspection = await seedFence(root);
  const originalRename = fsPromises.rename;
  let intercepted = false;
  let runnerCalls = 0;
  fsPromises.rename = async (source, destination) => {
    if (!intercepted && source === inspection.path) {
      intercepted = true;
      await originalRename(source, path.join(root, '.fwa', 'other-recovery-original.json'));
      // Simulate an outstanding failure publishing a different valid blocker
      // exactly after the recovering caller's final identity comparison.
      await writeFile(source, JSON.stringify({ ...inspection.fence, id: `git-fence_${randomUUID()}` }));
      await originalRename(source, destination);
      await assert.rejects(new GitProcessGuard(root).run(async () => {
        runnerCalls += 1;
        return { status: 0, signal: null, stdout: '', stderr: '' };
      }, 'git', ['status'], { cwd: root }), { code: 'git-process-termination-unconfirmed' });
      const held = await new GitWorktreeAdapter(root).inspectProcessFence();
      assert.equal(held.held, true);
      assert.equal(held.recoveryActive, true);
      return;
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(new GitWorktreeAdapter(root).recoverProcessFence({
      expectedFenceId: inspection.fence.id, confirmProcessesStopped: true
    }), { code: 'git-process-fence-invalid' });
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(intercepted, true);
  assert.equal(runnerCalls, 0);
  // The suspicious replacement remains blocked for review, including its
  // second hardlink in the archive; it is not treated as a successful recovery.
  await assert.rejects(new GitWorktreeAdapter(root).inspect(), { code: 'git-process-fence-invalid' });
});

test('an already-running Git failure during another recovery keeps its own durable blocker', async (t) => {
  const root = await tempRoot(t);
  let rejectPending;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new GitProcessGuard(root).run(() => {
    entered();
    return new Promise((_resolve, reject) => { rejectPending = reject; });
  }, 'git', ['status'], { cwd: root }).then(() => assert.fail('pending Git must fail'), (error) => error);
  await started;
  const first = await seedFence(root);
  const originalRename = fsPromises.rename;
  let secondFailure;
  fsPromises.rename = async (source, destination) => {
    if (source === first.path && secondFailure === undefined) {
      const failure = unconfirmed(root);
      failure.details.pid = 202;
      rejectPending(failure);
      secondFailure = await pending;
      assert.equal(secondFailure.details.fencePersisted, true);
      assert.notEqual(secondFailure.details.fenceId, first.fence.id);
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await new GitWorktreeAdapter(root).recoverProcessFence({
      expectedFenceId: first.fence.id, confirmProcessesStopped: true
    });
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
    if (secondFailure === undefined) { rejectPending(unconfirmed(root)); await pending; }
  }
  assert.equal(result.recovered, true);
  assert.equal(result.held, true);
  assert.equal(result.remainingFenceId, secondFailure.details.fenceId);
  const remaining = await new GitWorktreeAdapter(root).inspectProcessFence();
  assert.equal(remaining.fence.pid, 202);
  let calls = 0;
  await assert.rejects(new GitProcessGuard(root).run(async () => { calls += 1; }, 'git', ['status'], { cwd: root }), {
    code: 'git-process-termination-unconfirmed'
  });
  assert.equal(calls, 0);
  await new GitWorktreeAdapter(root).recoverProcessFence({
    expectedFenceId: remaining.fence.id, confirmProcessesStopped: true
  });
  assert.equal((await new GitWorktreeAdapter(root).inspectProcessFence()).held, false);
});

test('multiple unconfirmed Git commands retain separate identities and PIDs until each is recovered', async (t) => {
  const root = await tempRoot(t);
  const records = [];
  for (const pid of [101, 202, 303]) {
    const failure = unconfirmed(root);
    failure.details.pid = pid;
    records.push(await recordGitProcessFence(root, failure, GitProcessError));
  }
  assert.equal(new Set(records.map((record) => record.fence.id)).size, 3);
  const observed = [];
  const subject = new GitWorktreeAdapter(root);
  for (let index = 0; index < 3; index += 1) {
    const active = await subject.inspectProcessFence();
    observed.push(active.fence.pid);
    const result = await subject.recoverProcessFence({
      expectedFenceId: active.fence.id, confirmProcessesStopped: true
    });
    assert.equal(result.held, index < 2);
  }
  assert.deepEqual(observed.sort((left, right) => left - right), [101, 202, 303]);
  assert.equal((await subject.inspectProcessFence()).held, false);
});

test('malformed and foreign-project fence records block recovery and Git', async (t) => {
  const root = await tempRoot(t);
  const inspection = await seedFence(root);
  const subject = new GitWorktreeAdapter(root);
  await writeFile(inspection.path, JSON.stringify({ ...inspection.fence, projectRoot: path.join(root, 'foreign') }));
  await assert.rejects(subject.inspect(), { code: 'git-process-fence-invalid' });
  await assert.rejects(subject.recoverProcessFence({
    expectedFenceId: inspection.fence.id, confirmProcessesStopped: true
  }), { code: 'git-process-fence-invalid' });
  await writeFile(inspection.path, '{partial');
  await assert.rejects(subject.inspectProcessFence(), { code: 'git-process-fence-invalid' });
});

test('linked receipt directory cannot redirect recovery outside .fwa', async (t) => {
  const root = await tempRoot(t);
  const inspection = await seedFence(root);
  const foreign = path.join(root, 'foreign');
  await mkdir(foreign);
  await symlink(foreign, path.join(root, '.fwa', 'git-process-recoveries'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new GitWorktreeAdapter(root).recoverProcessFence({
    expectedFenceId: inspection.fence.id, confirmProcessesStopped: true
  }), { code: 'git-process-fence-invalid' });
  assert.deepEqual(await readdir(foreign), []);
  assert.equal((await new GitWorktreeAdapter(root).inspectProcessFence()).held, true);
});

test('fence persistence failure retains an explicit in-memory blocker', async (t) => {
  const root = await tempRoot(t);
  await writeFile(path.join(root, '.fwa'), 'not a directory');
  const guard = new GitProcessGuard(root);
  let calls = 0;
  const runner = async () => { calls += 1; throw unconfirmed(root); };
  await assert.rejects(guard.run(runner, 'git', [], {}), (error) => (
    error.code === 'git-process-termination-unconfirmed' && error.details.fencePersisted === false
  ));
  await assert.rejects(guard.run(runner, 'git', [], {}), { code: 'git-process-termination-unconfirmed' });
  assert.equal(calls, 1);
});

test('real checkout hook timeout is bounded, preserves its worktree, then allows confirmed cleanup', async (t) => {
  const root = await tempRoot(t);
  const git = (args) => runGitProcess('git', args, { cwd: root, timeoutMs: 10_000 });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'FWA Git Process Test']);
  await git(['config', 'user.email', 'fwa-git-process@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'seed\n');
  await git(['add', '.gitignore', 'seed.txt']);
  await git(['commit', '-m', 'test: initial']);
  const hook = path.join(root, '.git', 'hooks', 'post-checkout');
  await writeFile(hook, '#!/bin/sh\nsleep 3\n');
  if (process.platform !== 'win32') await chmod(hook, 0o755);
  const subject = new GitWorktreeAdapter(root, { gitTimeoutMs: 500, gitTerminationGraceMs: 5_000 });
  await assert.rejects(subject.create({ runId: 'hook_timeout' }), (error) => (
    error.code === 'git-command-timeout'
    && error.details.arguments[0] === 'worktree'
    && error.details.arguments[1] === 'add'
    && error.details.terminationConfirmed === true
  ));
  assert.equal((await subject.inspectProcessFence()).held, false);
  assert.equal((await lstat(path.join(root, '.fwa', 'worktrees', 'hook_timeout'))).isDirectory(), true);
  const cleanup = await new GitWorktreeAdapter(root).remove({ runId: 'hook_timeout', force: true });
  assert.equal(cleanup.removed, true);
});
