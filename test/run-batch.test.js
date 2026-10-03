import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { FwaApplication } from '../src/application/fwa-application.js';
import { FileOperationsExecutor, FILE_OPERATIONS_CAPABILITY } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { findParallelConflicts } from '../src/core/scheduling.js';

function command(cwd, executable, args, allowed = [0], timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!allowed.includes(code)) reject(new Error(`${executable} ${args.join(' ')}: ${code} (timedOut=${timedOut}, timeoutMs=${timeoutMs})\n${stderr}\n${stdout}`));
      else resolve({ stdout, stderr, code });
    });
  });
}
const git = (cwd, args) => command(cwd, 'git', args);
const input = (name) => ({ schemaVersion: 1,
  operations: [{ type: 'write', path: `${name}/result.txt`, content: `${name} independent input\n` }] });
const executable = (execute) => ({ schemaVersion: 1, id: 'batch-fixture', version: '1',
  capabilities: [FILE_OPERATIONS_CAPABILITY], execute });
const node = (id, overrides = {}) => ({ id, title: id, dependsOn: [], reads: ['seed.txt'],
  writes: [`${id}/**`], capabilities: [FILE_OPERATIONS_CAPABILITY],
  acceptance: { checks: ['file-created'] }, budget: { maxRetries: 0, maxFiles: 2, maxDiffLines: 30 }, ...overrides });

async function fixture(t, nodes = [node('left'), node('right')]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-parallel-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Batch Test']);
  await git(root, ['config', 'user.email', 'batch@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'shared read\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'test: batch base']);
  const app = new FwaApplication(root);
  await app.init();
  const { goal } = await app.createGoal({ title: 'Parallel leaves', request: 'Generate independent files', commandId: 'goal' });
  await app.loadPlan({ goalId: goal.id, commandId: 'plan', plan: { schemaVersion: 1, id: 'batch-plan', nodes } });
  return { root, app, workspace: new GitWorktreeAdapter(root) };
}

test('conflict analysis is conservative for glob paths, aliases, and exclusive resources', () => {
  const candidate = (nodeId, reads, writes, resources = []) => ({ nodeId, reads, writes, resources });
  assert.deepEqual(findParallelConflicts([candidate('a', ['seed'], ['left/**']), candidate('b', ['seed'], ['right/**'])]), []);
  for (const pair of [
    [candidate('a', [], ['data/**']), candidate('b', ['data/input.json'], [])],
    [candidate('a', [], ['DATA/file']), candidate('b', [], ['data/file'])],
    [candidate('a', [], ['dir']), candidate('b', [], ['dir/**'])],
    [candidate('a', [], [], ['engine']), candidate('b', [], [], ['Engine'])]
  ]) assert.ok(findParallelConflicts(pair, { ignoreCase: true }).length > 0);
});

test('same-project batch overlaps real isolated Runs, preserves independent inputs and replays without execution', async (t) => {
  const { root, app, workspace } = await fixture(t);
  const delegate = new FileOperationsExecutor();
  const starts = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const timeout = setTimeout(() => release(), 8000);
  t.after(() => clearTimeout(timeout));
  const worker = executable(async (context) => {
    starts.push({ root: context.workspaceRoot, nodeId: context.node.id });
    if (starts.length === 2) release();
    await barrier;
    assert.equal(starts.length, 2, 'both executors must start before either can finish');
    if (context.node.id === 'left') {
      const lease = await app.lease.inspect();
      assert.equal(lease.lease.ownerKind, 'run-batch');
    }
    await assert.rejects(app.runNext({ executor: delegate, workspace, input: input('left'), commandId: 'forbidden-serial' }),
      { code: 'run-batch-active' });
    return delegate.execute(context);
  });
  const options = { executions: [{ nodeId: 'left', input: input('left') }, { nodeId: 'right', input: input('right') }],
    executor: worker, workspace, commandId: 'parallel-success' };
  const result = await app.runReadyBatch(options);
  clearTimeout(timeout);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.batch.status, 'finished');
  assert.equal(result.cleanup.leaseReleased, true);
  assert.equal(new Set(starts.map((item) => item.root)).size, 2);
  assert.equal(result.members.length, 2);
  for (const member of result.members) {
    assert.equal(member.run.batchId, result.batch.id);
    assert.equal(member.run.leaseId, result.batch.leaseId);
    assert.equal(member.cleanup.worktreeRemoved, true);
    assert.deepEqual(member.changeSet.changedFiles, [`${member.nodeId}/result.txt`]);
    const bytes = await app.artifacts.get(member.changeSet.executionArtifact);
    const stored = JSON.parse(bytes.toString());
    assert.deepEqual(stored.input, input(member.nodeId));
  }
  assert.equal((await git(root, ['status', '--porcelain'])).stdout, '');
  assert.equal((await app.lease.inspect()).held, false);
  const replay = await app.runReadyBatch(options);
  assert.equal(replay.appended, false);
  assert.equal(replay.batch.id, result.batch.id);
  assert.equal(starts.length, 2);
  await assert.rejects(app.runReadyBatch({ ...options, maxConcurrency: 1 }), { code: 'idempotency-conflict' });
});

test('conflicting effects/resources and dependent leaves are deferred without invoking their executors', async (t) => {
  const { app, workspace } = await fixture(t, [
    node('left', { resources: ['build-cache'] }),
    node('overlap', { writes: ['left/result.txt'] }),
    node('resource', { resources: ['build-cache'] }),
    node('dependent', { dependsOn: ['left'] })
  ]);
  const calls = [];
  const delegate = new FileOperationsExecutor();
  const result = await app.runReadyBatch({
    executions: ['left', 'overlap', 'resource', 'dependent'].map((nodeId) => ({ nodeId, input: input(nodeId) })),
    executor: executable(async (context) => { calls.push(context.node.id); return delegate.execute(context); }),
    workspace, commandId: 'conflicts'
  });
  assert.deepEqual(calls, ['left']);
  assert.deepEqual(result.deferred.filter((item) => item.code === 'parallel-effect-conflict').map((item) => item.nodeId).sort(), ['overlap', 'resource']);
  assert.equal(result.deferred.find((item) => item.nodeId === 'dependent').code, 'node-not-ready');
  assert.equal((await app.getStatus()).nodes.find((item) => item.id === 'overlap').runIds.length, 0);
});

test('unconfirmed executor termination preserves worktrees, batch and lease, and forbids normal recovery', async (t) => {
  const { app, workspace } = await fixture(t, [node('left')]);
  let captures = 0; let removes = 0;
  const port = { inspect: (...args) => workspace.inspect(...args), create: (...args) => workspace.create(...args),
    capture: (...args) => { captures += 1; return workspace.capture(...args); },
    remove: (...args) => { removes += 1; return workspace.remove(...args); } };
  const result = await app.runReadyBatch({ executions: [{ nodeId: 'left', input: input('left') }],
    executor: executable(async () => { throw Object.assign(new Error('controlled unconfirmed child'), {
      code: 'executor-timeout', details: { process: { terminationConfirmed: false } }
    }); }), workspace: port, commandId: 'unconfirmed' });
  assert.equal(result.ok, false);
  assert.equal(result.batch.status, 'running');
  assert.equal(captures, 0); assert.equal(removes, 0);
  assert.equal((await app.lease.inspect()).held, true);
  assert.equal((await app.reconcileRun({ workspace })).reason, 'run-batch-reconciliation-required');
  assert.equal((await app.reconcileRunBatch({ confirmProcessesStopped: true })).reason, 'batch-owner-not-dead');
  await access(result.members[0].run.workspacePath);
});

test('dead batch coordinator requires explicit process confirmation, then preserves both real worktrees during recovery', async (t) => {
  const { root, app } = await fixture(t);
  const appUrl = pathToFileURL(path.resolve('src/application/fwa-application.js')).href;
  const workspaceUrl = pathToFileURL(path.resolve('src/adapters/git-worktree.js')).href;
  const script = `import {FwaApplication} from ${JSON.stringify(appUrl)};
    import {GitWorktreeAdapter} from ${JSON.stringify(workspaceUrl)};
    const root=${JSON.stringify(root)}; const app=new FwaApplication(root); let count=0;
    const executor={schemaVersion:1,id:'crashing-fixture',version:'1',capabilities:[${JSON.stringify(FILE_OPERATIONS_CAPABILITY)}],
      async execute(){count++;if(count===2)process.exit(17);await new Promise(()=>{});}};
    await app.runReadyBatch({executions:[{nodeId:'left',input:{}},{nodeId:'right',input:{}}],executor,
      workspace:new GitWorktreeAdapter(root),commandId:'crashed-batch'});`;
  // This child prepares two real Git worktrees before intentionally exiting.
  await command(root, process.execPath, ['--input-type=module', '--eval', script], [17], 120_000);
  const status = await app.getStatus();
  assert.equal(status.runs.filter((run) => run.status === 'running').length, 2);
  assert.equal((await app.reconcileRunBatch()).reason, 'process-stop-confirmation-required');
  const result = await app.reconcileRunBatch({ confirmProcessesStopped: true });
  assert.equal(result.reconciled, true);
  assert.equal(result.batch.outcome, 'reconciled');
  for (const run of status.runs) await access(run.workspacePath);
  assert.equal((await app.lease.inspect()).held, false);
  assert.equal((await app.getStatus()).runs.every((run) => run.status === 'failed'), true);
  assert.equal((await git(root, ['status', '--porcelain'])).stdout, '');
});

test('coordinator heartbeat covers preparation and overlapping member execution', async (t) => {
  const { app, workspace } = await fixture(t);
  let beats = 0;
  const lease = Object.fromEntries(['init', 'inspect', 'acquire', 'release', 'archiveStale']
    .map((method) => [method, (...args) => app.lease[method](...args)]));
  lease.heartbeat = (...args) => { beats += 1; return app.lease.heartbeat(...args); };
  const delegate = new FileOperationsExecutor();
  const result = await app.runReadyBatch({
    executions: ['left', 'right'].map((nodeId) => ({ nodeId, input: input(nodeId) })),
    executor: executable(async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return delegate.execute(context);
    }), workspace, lease, leaseTtlMs: 600, commandId: 'heartbeat'
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(beats >= 2);
  assert.equal(result.cleanup.leaseReleased, true);
  assert.equal((await app.lease.inspect()).held, false);
});

test('a coordinator crash before publishing its manifest leaves an explicitly recoverable lease', async (t) => {
  const { root, app } = await fixture(t);
  const leaseUrl = pathToFileURL(path.resolve('src/storage/workspace-lease.js')).href;
  const script = `import {WorkspaceLease} from ${JSON.stringify(leaseUrl)};
    const lease=new WorkspaceLease(${JSON.stringify(root)});await lease.init();
    await lease.acquire({ownerKind:'run-batch',ownerId:'orphan-batch'});process.exit(17);`;
  await command(root, process.execPath, ['--input-type=module', '--eval', script], [17]);
  assert.equal((await app.reconcileRunBatch()).reason, 'process-stop-confirmation-required');
  const result = await app.reconcileRunBatch({ confirmProcessesStopped: true });
  assert.equal(result.reason, 'orphan-batch-lease-archived');
  assert.equal((await app.lease.inspect()).held, false);
  assert.equal((await app.getStatus()).runs.length, 0);
});

test('an ok result cannot hide explicitly unconfirmed process termination', async (t) => {
  const { app, workspace } = await fixture(t, [node('left')]);
  let captures = 0;
  const result = await app.runReadyBatch({ executions: [{ nodeId: 'left', input: {} }],
    executor: executable(async () => ({ ok: true, process: { terminationConfirmed: false } })),
    workspace: { inspect: (...args) => workspace.inspect(...args), create: (...args) => workspace.create(...args),
      capture: (...args) => { captures += 1; return workspace.capture(...args); },
      remove: (...args) => workspace.remove(...args) }, commandId: 'unconfirmed-result' });
  assert.equal(result.ok, false);
  assert.equal(result.batch.status, 'running');
  assert.equal(result.members[0].run.failure.code, 'executor-termination-unconfirmed');
  assert.equal(captures, 0);
  assert.equal((await app.lease.inspect()).held, true);
});
