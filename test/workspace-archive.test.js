import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FwaApplication } from '../src/application/fwa-application.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FILE_OPERATIONS_CAPABILITY } from '../src/adapters/file-operations-executor.js';
import { stableStringify } from '../src/core/events.js';
import { WorkspaceArchiveStore } from '../src/storage/workspace-archive.js';
import { hashCanonicalValue } from '../src/storage/file-event-store.js';

const execFile = promisify(execFileCallback);

async function git(cwd, args) {
  return execFile('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

async function exists(target) {
  try { await access(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-archive-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Archive Test']);
  await git(root, ['config', 'user.email', 'fwa-archive@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n.local/\n');
  await writeFile(path.join(root, 'seed.txt'), 'seed\n');
  await git(root, ['add', '.gitignore', 'seed.txt']);
  await git(root, ['commit', '-m', 'test: archive base']);

  const app = new FwaApplication(root);
  await app.init();
  const goal = await app.createGoal({
    title: 'Archive failed workspace',
    request: 'Retain a failed isolated workspace.',
    commandId: 'archive-fixture-goal'
  });
  await app.loadPlan({
    goalId: goal.goal.id,
    plan: {
      schemaVersion: 1,
      id: 'archive-plan',
      nodes: [{
        id: 'write-and-fail',
        title: 'Write and fail',
        dependsOn: [],
        reads: ['seed.txt'],
        writes: ['.local/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['captured-change-set-is-valid'] },
        budget: { maxRetries: 2, maxFiles: 4, maxDiffLines: 100 }
      }]
    },
    commandId: 'archive-fixture-plan'
  });
  return { root, app, workspace: new GitWorktreeAdapter(root) };
}

function failingExecutor() {
  return {
    schemaVersion: 1,
    id: 'archive-failure-executor',
    version: '1',
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    async execute({ workspaceRoot }) {
      await mkdir(path.join(workspaceRoot, '.local', 'validation', 'evidence'), { recursive: true });
      await writeFile(path.join(workspaceRoot, '.local', 'validation', 'evidence', 'failure.log'), 'preserve me\n');
      const error = new Error('intentional archive fixture failure');
      error.code = 'ARCHIVE_FIXTURE_FAILURE';
      throw error;
    }
  };
}

test('archives a preserved failed Git worktree, keeps its Run ref, and replays idempotently', async (t) => {
  const { root, app, workspace } = await fixture(t);
  const failed = await app.runNext({
    workspace,
    executor: failingExecutor(),
    input: { schemaVersion: 1, operation: 'archive-fixture' },
    commandId: 'archive-fixture-run'
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.run.workspaceStatus, 'preserved');
  assert.equal(await exists(failed.run.workspacePath), true);

  const first = await app.archiveRunWorkspace({
    workspace,
    runId: failed.run.id,
    commandId: 'archive-fixture-command'
  });
  assert.equal(first.ok, true);
  assert.equal(first.appended, true);
  assert.equal(first.run.workspaceStatus, 'removed');
  assert.equal(await exists(failed.run.workspacePath), false);
  assert.equal(await exists(first.archive.archivePath), true);
  assert.equal((await git(root, ['show-ref', '--verify', `refs/heads/fwa/runs/${failed.run.id}`])).stdout.includes(failed.run.id), true);
  const manifest = JSON.parse(await readFile(path.join(first.archive.archivePath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.history.run.id, failed.run.id);
  assert.ok(manifest.source.entries.some((entry) => entry.path === '.local/validation/evidence/failure.log'));

  const replay = await app.archiveRunWorkspace({
    workspace,
    runId: failed.run.id,
    commandId: 'archive-fixture-command'
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.appended, false);
  const verification = await app.verify({ workspace });
  assert.equal(verification.operationallyClean, true);
  assert.deepEqual(verification.unreferencedWorkspaceArchives, []);
});

test('preserves a same-intent staging transaction for retry and rejects a collision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-archive-store-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  await mkdir(path.join(root, '.fwa', 'worktrees', 'run-resume'), { recursive: true });
  await writeFile(path.join(root, '.fwa', 'worktrees', 'run-resume', 'a.txt'), 'a\n');
  const store = new WorkspaceArchiveStore(root, { clock: () => new Date('2026-09-18T00:00:00.000Z') });
  await store.init();
  const identity = { path: path.join(root, '.fwa', 'worktrees', 'run-resume'), device: 1, inode: 2 };
  const history = { run: { id: 'run-resume', status: 'failed' }, failure: { code: 'fixture' } };
  await mkdir(path.join(root, '.fwa', 'workspace-archives', 'runs', '.archive-run-resume.tmp'), { recursive: true });
  await writeFile(path.join(root, '.fwa', 'workspace-archives', 'runs', '.archive-run-resume.tmp', 'intent.json'), '{"kind":"wrong"}\n');
  await assert.rejects(
    store.create({ runId: 'run-resume', workspacePath: path.join(root, '.fwa', 'worktrees', 'run-resume'), sourceIdentity: identity, history }),
    (error) => error.code === 'workspace-archive-temp-conflict'
  );
  await rm(path.join(root, '.fwa', 'workspace-archives', 'runs', '.archive-run-resume.tmp'), { recursive: true, force: true });

  // A copy failure leaves the owned staging directory in place. A retry with
  // the same stable intent can rebuild its payload and finish atomically.
  const source = path.join(root, '.fwa', 'worktrees', 'run-resume');
  const staging = path.join(root, '.fwa', 'workspace-archives', 'runs', '.archive-run-resume.tmp');
  await mkdir(path.join(staging, 'payload'), { recursive: true });
  const intent = {
    schemaVersion: 1,
    kind: 'fwa-run-workspace-archive-intent',
    runId: 'run-resume',
    workspacePath: source,
    sourceIdentityDigest: hashCanonicalValue(identity),
    historyDigest: hashCanonicalValue(history)
  };
  await writeFile(path.join(staging, 'intent.json'), `${stableStringify(intent)}\n`);
  await writeFile(path.join(staging, 'payload', 'stale.txt'), 'stale\n');
  const archive = await store.create({ runId: 'run-resume', workspacePath: source, sourceIdentity: identity, history });
  assert.equal(archive.reused, false);
  assert.equal(await exists(path.join(root, '.fwa', 'workspace-archives', 'runs', 'run-resume')), true);
  assert.deepEqual((await store.inspectAll()).map((item) => item.manifest.runId), ['run-resume']);
});

test('resumes a matching partial archive, keeps corruption visible, and retries after an append crash', async (t) => {
  const { root, app, workspace } = await fixture(t);
  const failed = await app.runNext({ workspace, executor: failingExecutor(), input: { schemaVersion: 1 }, commandId: 'archive-crash-run' });
  assert.equal(failed.run.workspaceStatus, 'preserved');

  const originalAppendBatch = app.store.appendBatch.bind(app.store);
  let injected = true;
  app.store.appendBatch = async (...args) => {
    if (injected && args[1]?.some((event) => event.type === 'RunWorkspaceArchived')) {
      injected = false;
      throw Object.assign(new Error('simulated crash after archive/remove'), { code: 'SIMULATED_ARCHIVE_APPEND_CRASH' });
    }
    return originalAppendBatch(...args);
  };
  await assert.rejects(
    app.archiveRunWorkspace({ workspace, runId: failed.run.id, commandId: 'archive-crash-command' }),
    (error) => error.code === 'SIMULATED_ARCHIVE_APPEND_CRASH'
  );
  assert.equal(await exists(failed.run.workspacePath), false);
  const archivePath = path.join(root, '.fwa', 'workspace-archives', 'runs', failed.run.id);
  assert.equal(await exists(archivePath), true);
  assert.equal((await app.verify({ workspace })).operationallyClean, false);

  app.store.appendBatch = originalAppendBatch;
  const retried = await app.archiveRunWorkspace({ workspace, runId: failed.run.id, commandId: 'archive-crash-command' });
  assert.equal(retried.ok, true);
  assert.equal(retried.appended, true);
  assert.equal((await app.verify({ workspace })).operationallyClean, true);

  const payloadFile = path.join(archivePath, 'payload', '.local', 'validation', 'evidence', 'failure.log');
  await writeFile(payloadFile, 'tampered\n');
  const corrupted = await app.verify({ workspace });
  assert.equal(corrupted.operationallyClean, false);
  assert.ok(corrupted.workspaceArchiveErrors.length > 0);
});

test('active Run fence is checked before archive lease acquisition', async (t) => {
  const { app, workspace } = await fixture(t);
  const failed = await app.runNext({ workspace, executor: failingExecutor(), input: { schemaVersion: 1 }, commandId: 'archive-active-failed' });
  const secondGoal = await app.createGoal({ title: 'Active archive fence', commandId: 'archive-active-goal' });
  await app.loadPlan({
    goalId: secondGoal.goal.id,
    plan: {
      schemaVersion: 1,
      id: 'active-archive-plan',
      nodes: [{
        id: 'active-node', title: 'Active node', dependsOn: [], reads: ['seed.txt'], writes: ['generated/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['captured-change-set-is-valid'] },
        budget: { maxRetries: 1, maxFiles: 4, maxDiffLines: 100 }
      }]
    },
    commandId: 'archive-active-plan'
  });
  let releaseExecution;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  let markExecutionEntered;
  const executionEntered = new Promise((resolve) => { markExecutionEntered = resolve; });
  const running = app.runNext({
    workspace,
    executor: {
      schemaVersion: 1,
      id: 'archive-active-executor',
      version: '1',
      capabilities: [FILE_OPERATIONS_CAPABILITY],
      async execute() { markExecutionEntered(); await executionGate; return { ok: true }; }
    },
    input: { schemaVersion: 1 },
    commandId: 'archive-active-run',
    nodeId: 'active-node',
    goalId: secondGoal.goal.id
  });
  // Entering the executor proves RunCreated/RunStarted are durable, regardless
  // of filesystem/Git speed. Always release the fixture even if its assertion fails.
  try {
    await Promise.race([executionEntered, running.then(() => { throw new Error('Run ended before entering its executor.'); })]);
    await assert.rejects(
      app.archiveRunWorkspace({ workspace, runId: failed.run.id, commandId: 'archive-active-command' }),
      (error) => error.code === 'active-run-exists'
    );
  } finally {
    releaseExecution();
    await running;
  }
});

test('archive heartbeats a short lease through a slow copy and fences scheduling', async (t) => {
  const { app, workspace } = await fixture(t);
  const failed = await app.runNext({ workspace, executor: failingExecutor(), input: { schemaVersion: 1 }, commandId: 'archive-heartbeat-failed' });
  const originalCreate = app.workspaceArchives.create.bind(app.workspaceArchives);
  let markCopyEntered, releaseCopy, markTwoRenewals, releaseHeartbeat;
  const copyEntered = new Promise(resolve => { markCopyEntered = resolve; });
  const copyGate = new Promise(resolve => { releaseCopy = resolve; });
  const twoRenewals = new Promise(resolve => { markTwoRenewals = resolve; });
  const heartbeatGate = new Promise(resolve => { releaseHeartbeat = resolve; });
  app.workspaceArchives.create = async (...args) => {
    markCopyEntered();
    await copyGate;
    return originalCreate(...args);
  };
  const originalHeartbeat = app.lease.heartbeat.bind(app.lease);
  let heartbeatCount = 0;
  app.lease.heartbeat = async (...args) => {
    // Once two real renewals have completed, keep subsequent attempts outside
    // the lease guard while the scheduling assertion observes the held lease.
    // Guard contention itself has separate controlled coverage in lease tests.
    if (heartbeatCount >= 2) await heartbeatGate;
    const renewed = await originalHeartbeat(...args);
    heartbeatCount += 1;
    if (heartbeatCount === 2) markTwoRenewals();
    return renewed;
  };
  const archiving = app.archiveRunWorkspace({
    workspace,
    runId: failed.run.id,
    commandId: 'archive-heartbeat-command',
    leaseTtlMs: 100
  });
  let result;
  try {
    await Promise.race([Promise.all([copyEntered, twoRenewals]),
      archiving.then(() => { throw new Error('Archive completed before its copy/heartbeat checkpoint.'); })]);
    await assert.rejects(
      app.runNext({ workspace, executor: failingExecutor(), input: { schemaVersion: 1 }, commandId: 'archive-heartbeat-scheduling' }),
      (error) => error.code === 'workspace-lease-held'
    );
  } finally {
    releaseCopy();
    releaseHeartbeat();
    result = await archiving;
  }
  assert.equal(result.ok, true);
  assert.ok(heartbeatCount >= 2, `expected at least two lease renewals, got ${heartbeatCount}`);
});

test('lease and active operation fences reject archive without changing the preserved source', async (t) => {
  const { app, workspace } = await fixture(t);
  const failed = await app.runNext({ workspace, executor: failingExecutor(), input: { schemaVersion: 1 }, commandId: 'archive-fence-run' });
  assert.equal(failed.run.workspaceStatus, 'preserved');
  const held = await app.lease.acquire({ ownerKind: 'run', ownerId: 'archive-fence-test' });
  await assert.rejects(
    app.archiveRunWorkspace({ workspace, runId: failed.run.id, commandId: 'archive-fence-held' }),
    (error) => error.code === 'workspace-lease-held'
  );
  await app.lease.release({ leaseId: held.lease.leaseId, ownerToken: held.ownerToken });
  assert.equal(await exists(failed.run.workspacePath), true);
});
