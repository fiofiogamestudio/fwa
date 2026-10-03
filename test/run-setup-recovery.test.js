import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FwaApplication } from '../src/application/fwa-application.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FILE_OPERATIONS_CAPABILITY } from '../src/adapters/file-operations-executor.js';
import { projectEvents } from '../src/application/projection.js';
import { hashEvent } from '../src/core/events.js';

const execFile = promisify(execFileCallback);
const git = (cwd, args) => execFile('git', args, { cwd, windowsHide: true });

async function crashedSetup(t, stage = 'after') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-setup-recovery-'));
  assert(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Setup Recovery Test']);
  await git(root, ['config', 'user.email', 'fwa-setup@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n.local/\n');
  await writeFile(path.join(root, 'seed.txt'), 'base\n');
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', 'isolated setup recovery base']);
  const app = new FwaApplication(root);
  await app.init();
  const goal = await app.createGoal({ title: 'Recover interrupted setup', commandId: 'goal' });
  await app.loadPlan({ goalId: goal.goal.id, commandId: 'plan', plan: { schemaVersion: 1, id: 'setup-plan', nodes: [{
    id: 'setup-node', title: 'Setup node', dependsOn: [], reads: ['seed.txt'], writes: ['output.txt'],
    capabilities: [FILE_OPERATIONS_CAPABILITY], acceptance: { checks: ['feature'] },
    budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 10 }
  }] } });
  const script = `
    import { FwaApplication } from ${JSON.stringify(new URL('../src/application/fwa-application.js', import.meta.url).href)};
    import { GitWorktreeAdapter } from ${JSON.stringify(new URL('../src/adapters/git-worktree.js', import.meta.url).href)};
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const app = new FwaApplication(${JSON.stringify(root)});
    const workspace = new GitWorktreeAdapter(${JSON.stringify(root)});
    const original = workspace.create.bind(workspace);
    workspace.create = async request => {
      if (${JSON.stringify(stage)} === 'before') process.exit(71);
      const created = await original(request);
      await mkdir(path.join(created.workspacePath, '.local'), {recursive:true});
      await writeFile(path.join(created.workspacePath, '.local', 'setup-note.txt'), 'keep setup bytes\\n');
      process.exit(71);
    };
    await app.runNext({ workspace, commandId: 'crashing-setup', input: {}, executor: {
      schemaVersion: 1, id: 'never-executed', version: '1', capabilities: [${JSON.stringify(FILE_OPERATIONS_CAPABILITY)}],
      async execute() { throw new Error('Executor must never be reached.'); }
    }});
  `;
  await assert.rejects(execFile(process.execPath, ['--input-type=module', '--eval', script],
    { cwd: root, windowsHide: true, timeout: 30000 }), error => error.code === 71);
  const pending = (await app.getStatus()).runs[0];
  assert.equal(pending.status, 'pending');
  assert.equal(pending.workspacePath, null);
  const workspace = new GitWorktreeAdapter(root);
  const reconciled = await app.reconcileRun({ workspace });
  assert.equal(reconciled.reason, 'abandoned-run-failed');
  assert.equal(reconciled.run.workspaceStatus, 'setup-unknown');
  assert.equal(reconciled.run.failure.code, 'RUN_OWNER_LOST');
  assert.equal((await app.lease.inspect()).held, false);
  return { root, app, workspace, run: reconciled.run,
    workspacePath: path.join(root, '.fwa', 'worktrees', pending.id) };
}

const recover = (item, options = {}) => item.app.recoverRunSetupWorkspace({
  workspace: item.workspace, runId: item.run.id, commandId: 'recover-setup', confirmProcessesStopped: true, ...options
});

test('real owner exit after Git setup can be observed, preserved and archived without inventing RunStarted', async t => {
  const item = await crashedSetup(t);
  const { app, workspace, run, workspacePath } = item;
  const beforeEvents = await app.listEvents();
  const observed = await app.inspectRunSetupWorkspace({ workspace, runId: run.id });
  assert.equal(observed.disposition, 'preserved');
  assert.equal(observed.headRevision, run.baseRevision);
  const actualIdentity = await lstat(workspacePath, { bigint: true });
  assert.equal(observed.identity.device, actualIdentity.dev.toString());
  assert.equal(observed.identity.inode, actualIdentity.ino.toString());
  assert.equal((await app.listEvents()).length, beforeEvents.length);
  await assert.rejects(recover(item, { confirmProcessesStopped: false }), e => e.code === 'process-stop-confirmation-required');
  const recovered = await recover(item);
  assert.equal(recovered.run.workspaceStatus, 'preserved');
  for (const field of ['workspacePath', 'startedAt', 'leaseId', 'changeSetId']) assert.equal(recovered.run[field], null);
  assert.deepEqual(recovered.run.failure, run.failure);
  assert.equal(recovered.run.workspaceSetupRecovery.workspacePath, workspacePath);
  assert.equal((await recover(item)).appended, false);
  const events = await app.listEvents();
  assert.deepEqual(events.slice(0, beforeEvents.length), beforeEvents);
  assert.equal(events.filter(e => e.type === 'RunWorkspaceSetupRecovered').length, 1);
  assert.equal(events.filter(e => e.type === 'RunStarted').length, 0);
  assert.equal((await app.verify({ workspace })).operationallyClean, false);
  const archived = await app.archiveRunWorkspace({ workspace, runId: run.id, commandId: 'archive-recovered' });
  assert.equal(archived.ok, true);
  assert.equal(archived.run.workspacePath, null);
  assert.equal(archived.run.workspaceStatus, 'removed');
  assert.equal(await readFile(path.join(archived.archive.archivePath, 'payload/.local/setup-note.txt'), 'utf8'), 'keep setup bytes\n');
  const manifest = JSON.parse(await readFile(path.join(archived.archive.archivePath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.history.run.workspaceSetupRecovery.baseRevision, run.baseRevision);
  assert.equal((await app.verify({ workspace })).operationallyClean, true);
});

test('owner exit before setup resolves complete physical and Git absence without an empty archive', async t => {
  const item = await crashedSetup(t, 'before');
  const observed = await item.app.inspectRunSetupWorkspace({ workspace: item.workspace, runId: item.run.id });
  assert.equal(observed.disposition, 'absent');
  const recovered = await recover(item);
  assert.equal(recovered.run.workspaceStatus, 'removed');
  assert.equal(recovered.run.workspaceArchive, null);
  assert.equal(recovered.run.workspacePath, null);
  assert.equal(recovered.run.startedAt, null);
  assert.equal((await item.app.verify({ workspace: item.workspace })).operationallyClean, true);
});

test('live lease, unconfirmed descendants and changed setup HEAD fail closed', async t => {
  const item = await crashedSetup(t);
  const initialEvents = (await item.app.listEvents()).length;
  const held = await item.app.lease.acquire({ runId: 'live-owner' });
  await assert.rejects(recover(item), e => e.code === 'workspace-lease-held');
  await item.app.lease.release({ leaseId: held.lease.leaseId, ownerToken: held.ownerToken });
  await assert.rejects(recover(item, { confirmProcessesStopped: undefined }), e => e.code === 'process-stop-confirmation-required');
  await git(item.workspacePath, ['commit', '--allow-empty', '-m', 'unexplained setup HEAD advance']);
  await assert.rejects(recover(item), e => e.code === 'workspace-setup-base-mismatch');
  assert.equal((await item.app.listEvents()).length, initialEvents);
  assert.equal((await item.app.getStatus()).runs[0].workspaceStatus, 'setup-unknown');
});

test('missing physical setup with surviving Git registration or Run ref is never marked clean', async t => {
  const item = await crashedSetup(t);
  await rm(item.workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await assert.rejects(recover(item), e => e.code === 'workspace-setup-partial');
  await git(item.root, ['worktree', 'prune']);
  await assert.rejects(recover(item), e => e.code === 'workspace-setup-partial');
  assert.equal((await item.app.getStatus()).runs[0].workspaceStatus, 'setup-unknown');
});

test('recovery rejects a foreign repository and linked replacement without touching either', async t => {
  const item = await crashedSetup(t);
  const retained = path.join(item.root, '.fwa', 'retained-setup');
  await rename(item.workspacePath, retained);
  await mkdir(item.workspacePath);
  await git(item.workspacePath, ['init', '-b', 'main']);
  await assert.rejects(recover(item), e => e.code === 'workspace-repository-mismatch');
  await rm(item.workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await symlink(retained, item.workspacePath, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(recover(item), e => e.code === 'invalid-workspace-path');
  assert.equal(await readFile(path.join(retained, '.local/setup-note.txt'), 'utf8'), 'keep setup bytes\n');
  assert.equal((await item.app.getStatus()).runs[0].workspaceStatus, 'setup-unknown');
});

test('identity changes between inspections are rejected and recovery event replay validates its evidence', async t => {
  const item = await crashedSetup(t);
  const original = item.workspace.inspectRunSetupWorkspace.bind(item.workspace);
  let calls = 0;
  item.workspace.inspectRunSetupWorkspace = async request => {
    const result = await original(request);
    if (++calls === 2) result.identity.inode = (BigInt(result.identity.inode) + 1n).toString();
    return result;
  };
  await assert.rejects(recover(item), e => e.code === 'workspace-setup-identity-changed');
  item.workspace.inspectRunSetupWorkspace = original;
  await recover(item);
  const events = await item.app.listEvents();
  const forged = structuredClone(events);
  const event = forged.find(e => e.type === 'RunWorkspaceSetupRecovered');
  event.payload.observation.headRevision = '0'.repeat(40);
  event.hash = hashEvent(event);
  assert.throws(() => projectEvents(forged), e => e.code === 'run-setup-recovery-mismatch');
  const numericIdentity = structuredClone(events);
  const numericEvent = numericIdentity.find(e => e.type === 'RunWorkspaceSetupRecovered');
  numericEvent.payload.observation.identity.inode = Number(numericEvent.payload.observation.identity.inode);
  numericEvent.hash = hashEvent(numericEvent);
  assert.throws(() => projectEvents(numericIdentity), e => e.code === 'run-setup-recovery-mismatch');
});

test('ordinary setup errors and a detached setup branch cannot use owner-lost recovery', async t => {
  const item = await crashedSetup(t);
  await git(item.workspacePath, ['switch', '--detach']);
  await assert.rejects(recover(item), e => e.code === 'workspace-branch-mismatch');
  await git(item.workspacePath, ['switch', `fwa/runs/${item.run.id}`]);
  await recover(item);
  await item.app.archiveRunWorkspace({ workspace: item.workspace, runId: item.run.id, commandId: 'archive-first' });
  const create = item.workspace.create.bind(item.workspace);
  item.workspace.create = async () => { throw Object.assign(new Error('ordinary setup failure'), { code: 'FIXTURE_SETUP_FAILURE' }); };
  const failed = await item.app.runNext({ workspace: item.workspace, commandId: 'ordinary-setup-failure', input: {}, executor: {
    schemaVersion: 1, id: 'unused', version: '1', capabilities: [FILE_OPERATIONS_CAPABILITY],
    async execute() { throw new Error('must not execute'); }
  } });
  item.workspace.create = create;
  assert.equal(failed.run.workspaceStatus, 'setup-unknown');
  assert.equal(failed.run.failure.code, 'FIXTURE_SETUP_FAILURE');
  await assert.rejects(recover(item, { runId: failed.run.id, commandId: 'ordinary-recovery' }), e => e.code === 'run-setup-not-recoverable');
});
