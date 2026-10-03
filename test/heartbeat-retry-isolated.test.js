import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FILE_OPERATIONS_CAPABILITY,
  FileOperationsExecutor
} from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { startLeaseHeartbeat } from '../src/application/lease-operations.js';
import { WorkspaceLease } from '../src/storage/workspace-lease.js';

async function command(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve(Buffer.concat(stdout).toString('utf8'))
      : reject(new Error(`${executable} ${args.join(' ')} exited ${code}: ${Buffer.concat(stderr)}`)));
  });
}

async function fixture(t, heartbeatMode) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-heartbeat-retry-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  await command('git', ['init', '-b', 'main'], root);
  await command('git', ['config', 'user.name', 'FWA Heartbeat Retry Test'], root);
  await command('git', ['config', 'user.email', 'heartbeat-retry@example.invalid'], root);
  await command('git', ['config', 'core.autocrlf', 'false'], root);
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  await command('git', ['add', '-A', '--', '.'], root);
  await command('git', ['commit', '--no-gpg-sign', '-m', 'test: heartbeat base'], root);

  const realLease = new WorkspaceLease(root);
  let heartbeatCalls = 0;
  const lease = Object.fromEntries([
    'init', 'inspect', 'acquire', 'release', 'archiveStale', 'releaseOwnedGuard'
  ].map(method => [method, (...args) => realLease[method](...args)]));
  lease.heartbeat = async (...args) => {
    heartbeatCalls += 1;
    if (heartbeatMode === 'busy-once' || heartbeatMode === 'always-busy') {
      if (heartbeatMode === 'always-busy' || heartbeatCalls === 1) {
        const error = new Error('injected pre-operation guard contention');
        error.code = 'workspace-lease-busy';
        throw error;
      }
    }
    if (heartbeatMode === 'non-busy') {
      const error = new Error('injected non-retryable heartbeat failure');
      error.code = 'lease-io-failed';
      throw error;
    }
    return realLease.heartbeat(...args);
  };

  const app = new FwaApplication(root, { lease });
  await app.init();
  const goal = await app.createGoal({ title: 'Heartbeat retry', commandId: `goal-${heartbeatMode}` });
  await app.loadPlan({ goalId: goal.goal.id, commandId: `plan-${heartbeatMode}`, plan: {
    schemaVersion: 1,
    nodes: [{ id: 'produce', dependsOn: [], reads: ['seed.txt'], writes: ['generated/**'],
      capabilities: [FILE_OPERATIONS_CAPABILITY], acceptance: { checks: ['complete'] },
      budget: { maxRetries: 0, maxFiles: 2, maxDiffLines: 20 } }]
  }});
  return { root, app, lease, workspace: new GitWorktreeAdapter(root), heartbeatCalls: () => heartbeatCalls };
}

function input() {
  return { schemaVersion: 1, operations: [{ type: 'write', path: 'generated/out.txt', content: 'ok\n' }] };
}

function delayedExecutor(delayMs) {
  const delegate = new FileOperationsExecutor();
  return { ...delegate, id: delegate.id, version: delegate.version, capabilities: [...delegate.capabilities],
    async execute(request) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return delegate.execute(request);
    } };
}

test('a pre-operation lease guard busy heartbeat retries through the real Run and completes', async t => {
  const f = await fixture(t, 'busy-once');
  const result = await f.app.runNext({ executor: delayedExecutor(450), workspace: f.workspace,
    input: input(), commandId: 'run-busy-once', leaseTtlMs: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.run.status, 'produced');
  assert.ok(f.heartbeatCalls() >= 2, `expected retry plus real heartbeat, got ${f.heartbeatCalls()}`);
});

test('a non-busy heartbeat failure still aborts the Run without a new total deadline', async t => {
  const f = await fixture(t, 'non-busy');
  const result = await f.app.runNext({ executor: delayedExecutor(450), workspace: f.workspace,
    input: input(), commandId: 'run-non-busy', leaseTtlMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.failure.code, 'FWA_EXECUTION_ABORTED');
  assert.ok(f.heartbeatCalls() >= 1);
});

test('an exhausted busy-heartbeat retry remains an honest aborted Run', async t => {
  const f = await fixture(t, 'always-busy');
  const result = await f.app.runNext({ executor: delayedExecutor(1500), workspace: f.workspace,
    input: input(), commandId: 'run-always-busy', leaseTtlMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.failure.code, 'FWA_EXECUTION_ABORTED');
  assert.ok(f.heartbeatCalls() >= 9, `expected retry exhaustion, got ${f.heartbeatCalls()}`);
});

test('the shared evaluation/integration heartbeat also retries one pre-operation busy', async t => {
  const f = await fixture(t, 'busy-once');
  const capability = await f.lease.acquire({ ownerKind: 'evaluation', ownerId: 'shared-heartbeat', ttlMs: 300 });
  const heartbeat = startLeaseHeartbeat(f.lease, capability, 300);
  await new Promise(resolve => setTimeout(resolve, 450));
  await heartbeat.stop();
  assert.equal(heartbeat.signal.aborted, false);
  assert.ok(f.heartbeatCalls() >= 2, `expected shared heartbeat retry, got ${f.heartbeatCalls()}`);
  await f.lease.release({ leaseId: capability.lease.leaseId, ownerToken: capability.ownerToken });
});
