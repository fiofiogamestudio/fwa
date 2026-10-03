import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FwaApplication } from '../src/application/fwa-application.js';
import {
  FILE_OPERATIONS_CAPABILITY,
  FileOperationsExecutor
} from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { createEvent } from '../src/core/events.js';
import { hashCanonicalValue } from '../src/storage/file-event-store.js';

async function run(executable, arguments_, { cwd, allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      const result = {
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (!allowedExitCodes.includes(status)) {
        reject(new Error(
          `${executable} ${arguments_.join(' ')} exited ${status}: ${result.stderr}`
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function git(cwd, arguments_, options) {
  return run('git', arguments_, { cwd, ...options });
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function fileOperationsInput(pathname = 'generated/output.txt', content = 'generated\n') {
  return {
    schemaVersion: 1,
    operations: [{ type: 'write', path: pathname, content }]
  };
}

function executionPlan({
  writes = ['generated/**'],
  maxRetries = 1,
  maxFiles = 4,
  maxDiffLines = 100,
  additionalNodes = []
} = {}) {
  return {
    schemaVersion: 1,
    id: 'execution-plan',
    nodes: [{
      id: 'produce-files',
      title: 'Produce declared files',
      dependsOn: [],
      reads: ['seed.txt'],
      writes,
      capabilities: [FILE_OPERATIONS_CAPABILITY],
      acceptance: { checks: ['captured-change-set-is-valid'] },
      budget: { maxRetries, maxFiles, maxDiffLines }
    }, ...additionalNodes]
  };
}

async function fixture(t, planOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-run-orchestrator-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));

  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Test']);
  await git(root, ['config', 'user.email', 'fwa-test@example.invalid']);
  await git(root, ['config', 'core.ignorecase', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base seed\n', 'utf8');
  await git(root, ['add', '.gitignore', 'seed.txt']);
  await git(root, ['commit', '-m', 'test: establish run base']);
  const baseRevision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  const app = new FwaApplication(root);
  await app.init();
  const created = await app.createGoal({
    title: 'Exercise Slice B',
    request: 'Produce an isolated, captured change set.',
    commandId: 'fixture-create-goal'
  });
  await app.loadPlan({
    goalId: created.goal.id,
    plan: executionPlan(planOptions),
    commandId: 'fixture-load-plan'
  });

  return {
    root,
    app,
    baseRevision,
    workspace: new GitWorktreeAdapter(root)
  };
}

function countingExecutor(delegate = new FileOperationsExecutor()) {
  const state = { calls: 0 };
  return {
    state,
    executor: {
      schemaVersion: delegate.schemaVersion,
      id: delegate.id,
      version: delegate.version,
      capabilities: delegate.capabilities,
      async execute(context) {
        state.calls += 1;
        return delegate.execute(context);
      }
    }
  };
}

test('runNext captures a valid isolated commit and verifies its artifacts', async (t) => {
  const { root, app, baseRevision, workspace } = await fixture(t);
  const input = fileOperationsInput();
  let alternateArtifactCalls = 0;
  const alternateArtifacts = {
    async init() { alternateArtifactCalls += 1; },
    async put() { alternateArtifactCalls += 1; },
    async verify() { alternateArtifactCalls += 1; }
  };
  const result = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace,
    artifacts: alternateArtifacts,
    input,
    baseRevision: 'HEAD',
    commandId: 'run-success'
  });

  assert.equal(result.ok, true);
  assert.equal(result.appended, true);
  assert.equal(result.goal.status, 'active');
  assert.equal(result.node.status, 'produced');
  assert.equal(result.run.status, 'produced');
  assert.equal(result.changeSet.valid, true);
  assert.deepEqual(result.changeSet.changedFiles, ['generated/output.txt']);
  assert.equal(result.changeSet.changes[0].path, 'generated/output.txt');
  assert.equal(result.changeSet.changes[0].status, 'added');
  assert.deepEqual(result.changeSet.violations, []);
  assert.equal(result.changeSet.baseRevision, baseRevision);
  assert.equal(result.changeSet.commits.length, 1);
  assert.equal(result.changeSet.commits[0], result.changeSet.headRevision);
  assert.equal(result.changeSet.ref, `refs/heads/fwa/runs/${result.run.id}`);
  assert.equal(result.changeSet.branch, `fwa/runs/${result.run.id}`);
  assert.equal(result.cleanup.worktreeRemoved, true);
  assert.equal(result.cleanup.leaseReleased, true);
  assert.equal(result.run.workspaceStatus, 'removed');
  assert.equal(alternateArtifactCalls, 0);
  assert.equal(await pathExists(result.run.workspacePath), false);

  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), baseRevision);
  assert.equal(
    (await git(root, ['rev-parse', result.changeSet.ref])).stdout.trim(),
    result.changeSet.headRevision
  );
  await git(root, ['cat-file', '-e', `${result.changeSet.headRevision}^{commit}`]);
  assert.equal(await readFile(path.join(root, 'seed.txt'), 'utf8'), 'base seed\n');
  assert.equal(await pathExists(path.join(root, 'generated', 'output.txt')), false);
  assert.equal((await git(root, ['status', '--porcelain'])).stdout, '');

  const patch = (await app.artifacts.get(result.changeSet.patchArtifact)).toString('utf8');
  assert.match(patch, /diff --git a\/generated\/output\.txt b\/generated\/output\.txt/u);
  assert.match(patch, /\+generated/u);
  assert.equal((await app.artifacts.verify(result.changeSet.patchArtifact)).ok, true);
  assert.equal((await app.artifacts.verify(result.changeSet.executionArtifact)).ok, true);

  const status = await app.getStatus();
  assert.equal(status.goals[0].status, 'active');
  assert.equal(status.nodes[0].status, 'produced');
  assert.equal(status.runs[0].status, 'produced');
  assert.equal(status.runs[0].workspaceStatus, 'removed');
  assert.equal(status.changeSets[0].valid, true);
  assert.deepEqual(
    (await app.listEvents())
      .filter((event) => event.payload.runId === result.run.id)
      .slice(-4)
      .map((event) => event.type),
    ['ChangeSetCaptured', 'RunProduced', 'NodeProduced', 'RunWorkspaceRemoved']
  );
  const verification = await app.verify({ workspace });
  assert.equal(verification.ok, true);
  assert.equal(verification.operationallyClean, true);
  assert.equal(verification.runCount, 1);
  assert.equal(verification.changeSetCount, 1);
  assert.equal(verification.gitVerifiedChangeSetCount, 1);
  assert.equal(verification.artifactCount, 2);

  await git(root, ['update-ref', result.changeSet.ref, baseRevision, result.changeSet.headRevision]);
  await assert.rejects(
    app.verify({ workspace }),
    (error) => error.code === 'changeset-ref-mismatch'
  );
  await git(root, ['update-ref', result.changeSet.ref, result.changeSet.headRevision, baseRevision]);
});

test('partial executor failure records an invalid ChangeSet and leaves a retry-ready node', async (t) => {
  const { root, app, baseRevision, workspace } = await fixture(t);
  const executor = {
    schemaVersion: 1,
    id: 'partial-file-operations',
    version: '1',
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    async execute({ workspaceRoot }) {
      await mkdir(path.join(workspaceRoot, 'generated'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'generated', 'partial.txt'), 'allowed\n');
      await writeFile(path.join(workspaceRoot, 'undeclared.txt'), 'outside write set\n');
      const failure = new Error('Simulated failure after partial filesystem effects.');
      failure.code = 'SIMULATED_PARTIAL_FAILURE';
      failure.details = { completed: ['generated/partial.txt', 'undeclared.txt'] };
      throw failure;
    }
  };

  const result = await app.runNext({
    executor,
    workspace,
    input: { schemaVersion: 1, operation: 'partial-test' },
    baseRevision: 'HEAD',
    commandId: 'run-partial-failure'
  });

  assert.equal(result.ok, false);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.failure.code, 'SIMULATED_PARTIAL_FAILURE');
  assert.equal(result.run.failure.phase, 'verification');
  assert.equal(result.node.status, 'ready');
  assert.equal(result.node.runIds.length, 1);
  assert.equal(result.changeSet.valid, false);
  assert.deepEqual(
    result.changeSet.changedFiles,
    ['generated/partial.txt', 'undeclared.txt']
  );
  assert.equal(
    result.changeSet.changes.find((change) => change.path === 'undeclared.txt').status,
    'added'
  );
  assert.ok(result.changeSet.violations.some((item) => item.code === 'WRITE_OUT_OF_SCOPE'));
  assert.ok(result.changeSet.violations.some((item) => item.code === 'EXECUTION_FAILED'));
  assert.equal(result.changeSet.baseRevision, baseRevision);
  assert.equal(result.changeSet.commits.length, 1);
  assert.equal(result.cleanup.worktreeRemoved, false);
  assert.equal(result.cleanup.leaseReleased, true);
  assert.equal(result.cleanup.preservedWorkspace, result.run.workspacePath);
  assert.equal(result.run.workspaceStatus, 'preserved');
  assert.equal(await pathExists(result.run.workspacePath), true);
  assert.equal(
    await readFile(path.join(result.run.workspacePath, 'generated', 'partial.txt'), 'utf8'),
    'allowed\n'
  );
  assert.equal(
    (await git(root, ['rev-parse', result.changeSet.ref])).stdout.trim(),
    result.changeSet.headRevision
  );
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), baseRevision);
  assert.equal(await pathExists(path.join(root, 'undeclared.txt')), false);
  const verification = await app.verify();
  assert.equal(verification.artifactCount, 3);
  const failureRef = result.run.failure.details.artifactRef;
  assert.equal((await app.artifacts.verify(failureRef)).ok, true);
  const failureEvidence = JSON.parse((await app.artifacts.get(failureRef)).toString('utf8'));
  assert.deepEqual(failureEvidence.failure.details.completed, ['generated/partial.txt', 'undeclared.txt']);
  assert.equal(verification.operationallyClean, false);
  assert.deepEqual(verification.preservedWorkspaces, [result.run.id]);

  await workspace.remove({
    runId: result.run.id,
    workspacePath: result.run.workspacePath,
    force: true
  });
});

test('run reconciliation never archives live or stale Evaluation-owned leases', async (t) => {
  const { app } = await fixture(t);

  for (const stale of [false, true]) {
    const calls = { inspect: 0, acquire: 0, release: 0, archive: 0, remove: 0 };
    const leaseState = {
      initialized: true,
      held: true,
      stale,
      status: stale ? 'stale' : 'active',
      reason: stale ? 'owner-dead' : 'lease-unexpired',
      lease: {
        schemaVersion: 2,
        leaseId: `evaluation-lease-${stale ? 'stale' : 'live'}`,
        ownerKind: 'evaluation',
        ownerId: `evaluation-${stale ? 'stale' : 'live'}`
      }
    };
    const foreignLease = {
      async init() {
        return leaseState;
      },
      async inspect() {
        calls.inspect += 1;
        return leaseState;
      },
      async acquire() {
        calls.acquire += 1;
        throw new Error('Run reconciliation must not acquire an Evaluation lease.');
      },
      async release() {
        calls.release += 1;
        throw new Error('Run reconciliation must not release an Evaluation lease.');
      },
      async archiveStale() {
        calls.archive += 1;
        throw new Error('Run reconciliation must not archive an Evaluation lease.');
      }
    };
    const workspace = {
      async remove() {
        calls.remove += 1;
        throw new Error('Run reconciliation must not clean an Evaluation workspace.');
      }
    };

    const result = await app.reconcileRun({ lease: foreignLease, workspace });
    assert.equal(result.ok, true);
    assert.equal(result.reconciled, false);
    assert.equal(result.reason, 'another-operation-owns-lease');
    assert.equal(result.lease, leaseState);
    assert.deepEqual(calls, {
      inspect: 0,
      acquire: 0,
      release: 0,
      archive: 0,
      remove: 0
    });
  }
});

test('cleanup failure is durable, live leases block cleanup, and reconcile converges it', async (t) => {
  const { root, app, workspace } = await fixture(t);
  const cleanupFailure = new Error('simulated worktree removal failure');
  cleanupFailure.code = 'SIMULATED_CLEANUP_FAILURE';
  const failingWorkspace = {
    inspect: workspace.inspect.bind(workspace),
    create: workspace.create.bind(workspace),
    capture: workspace.capture.bind(workspace),
    async remove() {
      throw cleanupFailure;
    }
  };

  const result = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: failingWorkspace,
    input: fileOperationsInput('generated/reconcile.txt', 'reconcile me\n'),
    commandId: 'cleanup-failure-run'
  });

  assert.equal(result.ok, true);
  assert.equal(result.run.workspaceStatus, 'cleanup-failed');
  assert.equal(result.run.cleanupFailures.length, 1);
  assert.equal(result.cleanup.worktreeRemoved, false);
  assert.equal(result.cleanup.warnings[0].failure.code, 'SIMULATED_CLEANUP_FAILURE');
  assert.equal(await pathExists(result.run.workspacePath), true);
  const before = await app.verify();
  assert.equal(before.operationallyClean, false);
  assert.deepEqual(before.pendingWorkspaceCleanup, [result.run.id]);

  const blocker = await app.lease.acquire({ runId: 'manual_blocker' });
  const blocked = await app.reconcileRun({ workspace });
  assert.equal(blocked.reconciled, false);
  assert.equal(blocked.reason, 'lease-owner-not-dead');
  assert.equal(await pathExists(result.run.workspacePath), true);
  await app.lease.release({
    leaseId: blocker.lease.leaseId,
    ownerToken: blocker.ownerToken
  });

  const reconciled = await app.reconcileRun({ workspace });
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.reason, 'produced-workspace-cleanup');
  assert.equal(reconciled.cleanupResults[0].cleanup.worktreeRemoved, true);
  assert.equal(reconciled.cleanupResults[0].cleanup.leaseReleased, true);
  assert.equal(await pathExists(result.run.workspacePath), false);
  const after = await app.verify();
  assert.equal(after.operationallyClean, true);
  assert.deepEqual(after.pendingWorkspaceCleanup, []);
  assert.equal((await app.getStatus()).runs[0].workspaceStatus, 'removed');
});

test('cleanup fencing cannot turn a preflighted Run into a failed attempt', async (t) => {
  const followUpNode = {
    id: 'follow-up',
    title: 'Run while old cleanup is reconciled',
    dependsOn: [],
    reads: ['seed.txt'],
    writes: ['generated/follow-up.txt'],
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    acceptance: { checks: ['captured-change-set-is-valid'] },
    budget: { maxRetries: 0, maxFiles: 1, maxDiffLines: 10 }
  };
  const { root, app, workspace } = await fixture(t, {
    maxRetries: 0,
    additionalNodes: [followUpNode]
  });
  const failingWorkspace = {
    inspect: workspace.inspect.bind(workspace),
    create: workspace.create.bind(workspace),
    capture: workspace.capture.bind(workspace),
    async remove() {
      const error = new Error('leave the produced workspace pending for reconciliation');
      error.code = 'SIMULATED_CLEANUP_FAILURE';
      throw error;
    }
  };
  const first = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: failingWorkspace,
    nodeId: 'produce-files',
    input: fileOperationsInput('generated/first.txt', 'first\n'),
    commandId: 'cleanup-race-first-run'
  });
  assert.equal(first.run.workspaceStatus, 'cleanup-failed');

  let reportRunnerInspected;
  let releaseRunnerInspection;
  let reportCleanupRemove;
  let releaseCleanupRemove;
  const runnerInspected = new Promise((resolve) => { reportRunnerInspected = resolve; });
  const runnerInspectionGate = new Promise((resolve) => { releaseRunnerInspection = resolve; });
  const cleanupRemoveEntered = new Promise((resolve) => { reportCleanupRemove = resolve; });
  const cleanupRemoveGate = new Promise((resolve) => { releaseCleanupRemove = resolve; });
  const reconciliationApp = new FwaApplication(root);
  const runnerApp = new FwaApplication(root);
  const runnerWorkspace = {
    async inspect(options) {
      const result = await workspace.inspect(options);
      reportRunnerInspected();
      await runnerInspectionGate;
      return result;
    },
    create: workspace.create.bind(workspace),
    capture: workspace.capture.bind(workspace),
    remove: workspace.remove.bind(workspace)
  };
  const cleanupWorkspace = {
    async remove(options) {
      reportCleanupRemove();
      await cleanupRemoveGate;
      return workspace.remove(options);
    }
  };

  const runnerPromise = runnerApp.runNext({
    executor: new FileOperationsExecutor(),
    workspace: runnerWorkspace,
    nodeId: followUpNode.id,
    input: fileOperationsInput('generated/follow-up.txt', 'follow-up\n'),
    commandId: 'cleanup-race-follow-up'
  });
  await runnerInspected;
  const reconciliationPromise = reconciliationApp.reconcileRun({
    workspace: cleanupWorkspace,
    correlationId: 'cleanup-race-reconcile'
  });
  await cleanupRemoveEntered;
  releaseRunnerInspection();
  const blockedRunner = await runnerPromise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  );

  assert.equal(blockedRunner.status, 'rejected');
  assert.equal(blockedRunner.reason.code, 'workspace-lease-held');
  let status = await app.getStatus();
  assert.deepEqual(status.nodes.find((node) => node.id === followUpNode.id).runIds, []);
  assert.equal(status.runs.some((run) => run.nodeId === followUpNode.id), false);

  releaseCleanupRemove();
  const reconciliation = await reconciliationPromise;
  assert.equal(reconciliation.reason, 'produced-workspace-cleanup');
  assert.equal(reconciliation.cleanupResults[0].cleanup.worktreeRemoved, true);

  const retry = await runnerApp.runNext({
    executor: new FileOperationsExecutor(),
    workspace,
    nodeId: followUpNode.id,
    input: fileOperationsInput('generated/follow-up.txt', 'follow-up\n'),
    commandId: 'cleanup-race-follow-up'
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.node.id, followUpNode.id);
  assert.equal(retry.run.status, 'produced');
  status = await app.getStatus();
  assert.deepEqual(
    status.nodes.find((node) => node.id === followUpNode.id).runIds,
    [retry.run.id]
  );
  assert.equal((await app.lease.inspect()).held, false);
});

test('cleanup reconciliation rereads active Run state after acquiring its fence', async (t) => {
  const followUpNode = {
    id: 'legacy-follow-up',
    title: 'Appear while cleanup waits for its fence',
    dependsOn: [],
    reads: ['seed.txt'],
    writes: ['generated/legacy-follow-up.txt'],
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    acceptance: { checks: ['captured-change-set-is-valid'] },
    budget: { maxRetries: 0, maxFiles: 1, maxDiffLines: 10 }
  };
  const { app, baseRevision, workspace } = await fixture(t, {
    maxRetries: 0,
    additionalNodes: [followUpNode]
  });
  const failingWorkspace = {
    inspect: workspace.inspect.bind(workspace),
    create: workspace.create.bind(workspace),
    capture: workspace.capture.bind(workspace),
    async remove() {
      const error = new Error('leave cleanup pending for a fenced-state replay');
      error.code = 'SIMULATED_CLEANUP_FAILURE';
      throw error;
    }
  };
  const first = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: failingWorkspace,
    nodeId: 'produce-files',
    input: fileOperationsInput('generated/legacy-first.txt', 'first\n'),
    commandId: 'legacy-cleanup-first-run'
  });
  assert.equal(first.run.workspaceStatus, 'cleanup-failed');

  let reportCleanupAcquire;
  let releaseCleanupAcquire;
  const cleanupAcquireEntered = new Promise((resolve) => { reportCleanupAcquire = resolve; });
  const cleanupAcquireGate = new Promise((resolve) => { releaseCleanupAcquire = resolve; });
  const reconciliationApp = new FwaApplication(app.projectRoot);
  const cleanupLease = {
    init: reconciliationApp.lease.init.bind(reconciliationApp.lease),
    inspect: reconciliationApp.lease.inspect.bind(reconciliationApp.lease),
    release: reconciliationApp.lease.release.bind(reconciliationApp.lease),
    archiveStale: reconciliationApp.lease.archiveStale.bind(reconciliationApp.lease),
    releaseOwnedGuard: reconciliationApp.lease.releaseOwnedGuard.bind(reconciliationApp.lease),
    async acquire(options) {
      reportCleanupAcquire();
      await cleanupAcquireGate;
      return reconciliationApp.lease.acquire(options);
    }
  };
  let removeCalls = 0;
  const cleanupWorkspace = {
    async remove(options) {
      removeCalls += 1;
      return workspace.remove(options);
    }
  };
  const reconciliationPromise = reconciliationApp.reconcileRun({
    lease: cleanupLease,
    workspace: cleanupWorkspace,
    correlationId: 'legacy-cleanup-reconcile'
  });
  await cleanupAcquireEntered;

  const store = await app.store.readAll();
  const legacyRunId = 'run_legacy_cleanup_race';
  const legacyCommandId = 'legacy-concurrent-run';
  const event = createEvent({
    type: 'RunCreated',
    streamId: `run:${legacyRunId}`,
    sequence: store.lastSequence + 1,
    actor: 'test',
    correlationId: legacyCommandId,
    payload: {
      runId: legacyRunId,
      nodeId: followUpNode.id,
      goalId: first.goal.id,
      planId: first.node.planId,
      executor: { id: 'legacy-runner', version: '1' },
      requestedBaseRevision: 'HEAD',
      baseRevision,
      inputHash: `sha256:${hashCanonicalValue({ schemaVersion: 1 })}`,
      workspaceRelativePath: `.fwa/worktrees/${legacyRunId}`
    },
    metadata: { streamVersion: 1 }
  });
  await app.store.appendBatch(legacyCommandId, [event], {
    expectedLastSequence: store.lastSequence,
    intentHash: hashCanonicalValue({
      schemaVersion: 1,
      type: 'LegacyConcurrentRun',
      runId: legacyRunId
    })
  });
  releaseCleanupAcquire();

  const reconciliation = await reconciliationPromise;
  assert.equal(reconciliation.reconciled, false);
  assert.equal(reconciliation.reason, 'run-owner-claimed-before-cleanup');
  assert.equal(reconciliation.run.id, legacyRunId);
  assert.equal(reconciliation.cleanupResults[0].cleanup.leaseReleased, true);
  assert.equal(removeCalls, 0);
  assert.equal((await app.lease.inspect()).held, false);
  const status = await app.getStatus();
  assert.equal(status.runs.find((run) => run.id === legacyRunId).status, 'pending');
  assert.equal(status.runs.find((run) => run.id === first.run.id).workspaceStatus, 'cleanup-failed');
});

test('reconcile never marks a missing worktree removed while Git registration remains', async (t) => {
  const { root, app, workspace } = await fixture(t);
  const failingWorkspace = {
    inspect: workspace.inspect.bind(workspace),
    create: workspace.create.bind(workspace),
    capture: workspace.capture.bind(workspace),
    async remove() {
      const error = new Error('leave registration for crash snapshot');
      error.code = 'SIMULATED_CLEANUP_CRASH';
      throw error;
    }
  };
  const result = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: failingWorkspace,
    input: fileOperationsInput('generated/registration.txt', 'registered\n'),
    commandId: 'registered-cleanup-run'
  });
  assert.equal(result.run.workspaceStatus, 'cleanup-failed');
  await rm(result.run.workspacePath, { recursive: true, force: true });

  const reconciled = await app.reconcileRun({ workspace });
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.cleanupResults[0].cleanup.worktreeRemoved, false);
  assert.equal(
    reconciled.cleanupResults[0].cleanup.warnings[0].failure.code,
    'worktree-registration-remains'
  );
  const status = await app.getStatus();
  assert.equal(status.runs[0].workspaceStatus, 'cleanup-failed');
  assert.equal(status.runs[0].cleanupFailures.length, 2);
  assert.equal(
    (await app.listEvents()).some((event) => event.type === 'RunWorkspaceRemoved'),
    false
  );
  assert.equal((await app.verify()).operationallyClean, false);
  assert.match(
    (await git(root, ['worktree', 'list', '--porcelain'])).stdout,
    /prunable/u
  );
});

test('a terminal command replay does not execute again and rejects a different intent', async (t) => {
  const { app, workspace } = await fixture(t);
  const { executor, state } = countingExecutor();
  const input = fileOperationsInput('generated/replay.txt', 'once\n');

  const first = await app.runNext({
    executor,
    workspace,
    input,
    commandId: 'stable-run-command'
  });
  const replay = await app.runNext({
    executor,
    workspace,
    input,
    commandId: 'stable-run-command'
  });

  assert.equal(first.appended, true);
  assert.equal(replay.appended, false);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.run.status, 'produced');
  assert.equal(replay.cleanup.worktreeRemoved, true);
  assert.equal(replay.cleanup.leaseReleased, true);
  assert.deepEqual(replay.cleanup.warnings, []);
  assert.equal(state.calls, 1);

  await assert.rejects(
    app.runNext({
      executor,
      workspace,
      input: fileOperationsInput('generated/replay.txt', 'different\n'),
      commandId: 'stable-run-command'
    }),
    (error) => error.code === 'idempotency-conflict'
  );
  assert.equal(state.calls, 1);
  assert.equal((await app.getStatus()).runs.length, 1);
});

test('a terminal replay reports its own orphan Run lease as unreleased', async (t) => {
  const { app, workspace } = await fixture(t);
  const { executor, state } = countingExecutor();
  const input = fileOperationsInput('generated/orphan-replay.txt', 'once\n');
  const first = await app.runNext({
    executor,
    workspace,
    input,
    commandId: 'orphan-lease-replay'
  });
  assert.equal(first.ok, true);
  assert.equal(first.cleanup.worktreeRemoved, true);
  assert.equal(first.cleanup.leaseReleased, true);

  const orphan = await app.lease.acquire({ runId: first.run.id });
  try {
    const replay = await app.runNext({
      executor,
      workspace,
      input,
      commandId: 'orphan-lease-replay'
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.appended, false);
    assert.equal(replay.run.id, first.run.id);
    assert.equal(replay.cleanup.worktreeRemoved, true);
    assert.equal(replay.cleanup.leaseReleased, false);
    assert.deepEqual(replay.cleanup.warnings, []);
    assert.equal(state.calls, 1);
  } finally {
    await app.lease.release({
      leaseId: orphan.lease.leaseId,
      ownerToken: orphan.ownerToken
    });
  }
});

test('overlapping app instances with one command id invoke the executor only once', async (t) => {
  const { root, app: firstApp } = await fixture(t);
  const secondApp = new FwaApplication(root);
  const delegate = new FileOperationsExecutor();
  let calls = 0;
  let releaseExecution;
  let reportStarted;
  const executionStarted = new Promise((resolve) => {
    reportStarted = resolve;
  });
  const executionGate = new Promise((resolve) => {
    releaseExecution = resolve;
  });
  const executor = {
    schemaVersion: delegate.schemaVersion,
    id: delegate.id,
    version: delegate.version,
    capabilities: delegate.capabilities,
    async execute(context) {
      calls += 1;
      reportStarted();
      await executionGate;
      return delegate.execute(context);
    }
  };
  const input = fileOperationsInput('generated/concurrent.txt', 'single invocation\n');
  const firstPromise = firstApp.runNext({
    executor,
    workspace: new GitWorktreeAdapter(root),
    input,
    commandId: 'concurrent-run-command'
  });

  await Promise.race([
    executionStarted,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('executor did not start within 20 seconds')),
        20_000
      );
      timer.unref?.();
    })
  ]);
  const loser = await secondApp.runNext({
    executor,
    workspace: new GitWorktreeAdapter(root),
    input,
    commandId: 'concurrent-run-command'
  }).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  );
  releaseExecution();
  const winner = await firstPromise;

  assert.equal(loser.status, 'rejected');
  assert.equal(loser.reason.code, 'run-reconciliation-required');
  assert.equal(winner.ok, true);
  assert.equal(calls, 1);
  const status = await firstApp.getStatus();
  assert.equal(status.runs.length, 1);
  assert.equal(status.runs[0].status, 'produced');
  assert.equal(
    (await firstApp.listEvents()).filter((event) => event.type === 'RunCreated').length,
    1
  );
});

test('a raced terminal replay reports failure to release its temporary lease', async (t) => {
  const { root, app: winnerApp } = await fixture(t);
  const loserApp = new FwaApplication(root);
  const { executor, state: executions } = countingExecutor();
  const input = fileOperationsInput('generated/raced-replay.txt', 'winner only\n');
  const commandId = 'raced-terminal-replay';
  let reportAcquire;
  let releaseAcquire;
  const acquireEntered = new Promise((resolve) => { reportAcquire = resolve; });
  const acquireGate = new Promise((resolve) => { releaseAcquire = resolve; });
  let temporaryLease = null;
  const loserLease = {
    init: loserApp.lease.init.bind(loserApp.lease),
    inspect: loserApp.lease.inspect.bind(loserApp.lease),
    heartbeat: loserApp.lease.heartbeat.bind(loserApp.lease),
    archiveStale: loserApp.lease.archiveStale.bind(loserApp.lease),
    releaseOwnedGuard: loserApp.lease.releaseOwnedGuard.bind(loserApp.lease),
    async acquire(options) {
      reportAcquire();
      await acquireGate;
      temporaryLease = await loserApp.lease.acquire(options);
      return temporaryLease;
    },
    async release() {
      const error = new Error('simulated loser temporary lease release failure');
      error.code = 'SIMULATED_LOSER_RELEASE_FAILURE';
      throw error;
    }
  };
  const loserPromise = loserApp.runNext({
    executor,
    workspace: new GitWorktreeAdapter(root),
    lease: loserLease,
    input,
    commandId
  });
  await Promise.race([
    acquireEntered,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('loser did not reach lease acquisition within 20 seconds')),
        20_000
      );
      timer.unref?.();
    })
  ]);

  const winner = await winnerApp.runNext({
    executor,
    workspace: new GitWorktreeAdapter(root),
    input,
    commandId
  });
  assert.equal(winner.ok, true);
  assert.equal(winner.cleanup.worktreeRemoved, true);
  assert.equal(winner.cleanup.leaseReleased, true);
  releaseAcquire();

  let loser;
  try {
    loser = await loserPromise;
    assert.equal(loser.ok, true);
    assert.equal(loser.appended, false);
    assert.equal(loser.run.id, winner.run.id);
    assert.equal(loser.cleanup.worktreeRemoved, true);
    assert.equal(loser.cleanup.leaseReleased, false);
    assert.equal(
      loser.cleanup.warnings.some(
        (warning) => warning.phase === 'lease-release'
          && warning.failure.code === 'SIMULATED_LOSER_RELEASE_FAILURE'
      ),
      true
    );
    assert.equal(
      loser.cleanup.worktreeRemoved && loser.cleanup.leaseReleased,
      false
    );
    assert.equal(executions.calls, 1);
    assert.equal(
      (await winnerApp.listEvents()).filter((event) => event.type === 'RunCreated').length,
      1
    );
    const held = await loserApp.lease.inspect();
    assert.equal(held.held, true);
    assert.equal(held.lease.ownerKind, 'run');
    assert.equal(held.lease.ownerId, temporaryLease.lease.ownerId);
    assert.notEqual(held.lease.ownerId, winner.run.id);
  } finally {
    if (temporaryLease) {
      await loserApp.lease.release({
        leaseId: temporaryLease.lease.leaseId,
        ownerToken: temporaryLease.ownerToken
      });
    }
  }
});

test('a fenced append failure releases the scheduling lease without recording a Run', async (t) => {
  const { root, app, workspace } = await fixture(t);
  const injected = new Error('simulated RunCreated append failure');
  injected.code = 'SIMULATED_APPEND_FAILURE';
  const failingStore = {
    readAll: app.store.readAll.bind(app.store),
    async appendBatch(commandId, events, options) {
      if (commandId === 'fenced-append-failure') throw injected;
      return app.store.appendBatch(commandId, events, options);
    }
  };
  const failingApp = new FwaApplication(root, { store: failingStore });
  const { executor, state: executions } = countingExecutor();

  await assert.rejects(
    failingApp.runNext({
      executor,
      workspace,
      input: fileOperationsInput('generated/never-written.txt', 'never\n'),
      commandId: 'fenced-append-failure'
    }),
    (error) => error.code === 'SIMULATED_APPEND_FAILURE'
  );

  assert.equal(executions.calls, 0);
  assert.equal((await app.lease.inspect()).held, false);
  assert.equal((await app.getStatus()).runs.length, 0);
  assert.equal(
    (await app.store.readAll()).batches.some(
      (batch) => batch.commandId === 'fenced-append-failure'
    ),
    false
  );
});

test('lease-fenced scheduling revalidates a node selected before inspection', async (t) => {
  const { root, app, workspace } = await fixture(t);
  let reportInspected;
  let releaseInspection;
  const inspected = new Promise((resolve) => { reportInspected = resolve; });
  const inspectionGate = new Promise((resolve) => { releaseInspection = resolve; });
  const delayedWorkspace = {
    async inspect(options) {
      const result = await workspace.inspect(options);
      reportInspected();
      await inspectionGate;
      return result;
    },
    create: workspace.create.bind(workspace),
    capture: workspace.capture.bind(workspace),
    remove: workspace.remove.bind(workspace)
  };
  const { executor: staleExecutor, state: staleExecutions } = countingExecutor();
  const staleRunner = app.runNext({
    executor: staleExecutor,
    workspace: delayedWorkspace,
    input: fileOperationsInput('generated/stale.txt', 'stale\n'),
    commandId: 'stale-preflight-selection'
  });
  await inspected;

  const winner = await new FwaApplication(root).runNext({
    executor: new FileOperationsExecutor(),
    workspace: new GitWorktreeAdapter(root),
    input: fileOperationsInput('generated/winner.txt', 'winner\n'),
    commandId: 'selection-winner'
  });
  assert.equal(winner.ok, true);
  releaseInspection();

  await assert.rejects(
    staleRunner,
    (error) => error.code === 'node-not-ready'
  );
  assert.equal(staleExecutions.calls, 0);
  assert.equal((await app.lease.inspect()).held, false);
  const status = await app.getStatus();
  assert.equal(status.runs.length, 1);
  assert.equal(status.runs[0].id, winner.run.id);
  assert.equal(
    (await app.store.readAll()).batches.some(
      (batch) => batch.commandId === 'stale-preflight-selection'
    ),
    false
  );
});

test('a live lease fences the pre-RunCreated crash window', async (t) => {
  const { root, app, workspace } = await fixture(t);
  let reportAcquire;
  let releaseAcquire;
  const acquireEntered = new Promise((resolve) => {
    reportAcquire = resolve;
  });
  const acquireGate = new Promise((resolve) => {
    releaseAcquire = resolve;
  });
  const delayedLease = {
    init: app.lease.init.bind(app.lease),
    inspect: app.lease.inspect.bind(app.lease),
    heartbeat: app.lease.heartbeat.bind(app.lease),
    release: app.lease.release.bind(app.lease),
    archiveStale: app.lease.archiveStale.bind(app.lease),
    releaseOwnedGuard: app.lease.releaseOwnedGuard.bind(app.lease),
    async acquire(options) {
      const acquired = await app.lease.acquire(options);
      reportAcquire();
      await acquireGate;
      return acquired;
    }
  };
  const { executor, state: executions } = countingExecutor();
  const runner = app.runNext({
    executor,
    workspace,
    lease: delayedLease,
    input: fileOperationsInput('generated/race.txt', 'run after fence\n'),
    commandId: 'lease-before-run-created'
  });
  await Promise.race([
    acquireEntered,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('lease acquire was not reached within 20 seconds')),
        20_000
      );
      timer.unref?.();
    })
  ]);

  const reconciled = await app.reconcileRun({ workspace, orphanGraceMs: 1 });
  assert.equal(reconciled.reconciled, false);
  assert.equal(reconciled.reason, 'lease-owner-not-dead');
  assert.equal(executions.calls, 0);
  assert.equal(
    (await app.listEvents()).some((event) => event.type === 'RunCreated'),
    false
  );
  releaseAcquire();
  const runnerResult = await runner;
  assert.equal(runnerResult.ok, true);
  assert.equal(runnerResult.run.status, 'produced');
  assert.equal(executions.calls, 1);
  assert.equal((await app.lease.inspect()).held, false);
});

test('runNext rejects every active Evaluation state even after its lease is released', async (t) => {
  const followUpNode = {
    id: 'post-evaluation-work',
    title: 'Remain ready while another node is evaluated',
    dependsOn: [],
    reads: ['seed.txt'],
    writes: ['generated/post-evaluation.txt'],
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    acceptance: { checks: ['captured-change-set-is-valid'] },
    budget: { maxRetries: 0, maxFiles: 1, maxDiffLines: 10 }
  };
  const { app, workspace } = await fixture(t, { additionalNodes: [followUpNode] });
  const runWorkspace = {
    inspect: workspace.inspect.bind(workspace),
    create: workspace.create.bind(workspace),
    capture: workspace.capture.bind(workspace),
    async remove() {
      const error = new Error('preserve a Produced Run workspace for reconciliation');
      error.code = 'SIMULATED_CLEANUP_FAILURE';
      throw error;
    }
  };
  const produced = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: runWorkspace,
    nodeId: 'produce-files',
    input: fileOperationsInput('generated/evaluation-source.txt', 'evaluate\n'),
    commandId: 'evaluation-source-run'
  });
  assert.equal(produced.ok, true);
  assert.equal(produced.node.status, 'produced');
  assert.equal(produced.run.workspaceStatus, 'cleanup-failed');
  assert.equal((await app.lease.inspect()).held, false);

  const evaluationId = 'evaluation_blocks_run_scheduling';
  const workspacePath = path.join(
    app.projectRoot,
    '.fwa',
    'evaluations',
    evaluationId
  );
  const profileArtifact = {
    schemaVersion: 1,
    algorithm: 'sha256',
    digest: 'e'.repeat(64),
    size: 0
  };
  const appendEvents = async (commandId, specs) => {
    const store = await app.store.readAll();
    const events = specs.map((spec, index) => createEvent({
      type: spec.type,
      streamId: spec.streamId,
      sequence: store.lastSequence + index + 1,
      actor: 'test',
      correlationId: commandId,
      payload: spec.payload,
      metadata: { streamVersion: spec.streamVersion }
    }));
    await app.store.appendBatch(commandId, events, {
      expectedLastSequence: store.lastSequence,
      intentHash: hashCanonicalValue({ schemaVersion: 1, commandId })
    });
  };
  const { executor, state: executions } = countingExecutor();
  const assertSchedulingBlocked = async (status) => {
    await assert.rejects(
      app.runNext({
        executor,
        workspace,
        nodeId: followUpNode.id,
        input: fileOperationsInput('generated/post-evaluation.txt', `${status}\n`),
        commandId: `blocked-by-evaluation-${status}`
      }),
      (error) => error.code === 'project-operation-active'
        && error.details.evaluationIds.includes(evaluationId)
    );
    assert.equal(executions.calls, 0);
    assert.equal((await app.lease.inspect()).held, false);
  };

  await appendEvents('seed-requested-evaluation', [{
    type: 'EvaluationRequested',
    streamId: `evaluation:${evaluationId}`,
    streamVersion: 1,
    payload: {
      evaluationId,
      nodeId: produced.node.id,
      runId: produced.run.id,
      changeSetId: produced.changeSet.id,
      headRevision: produced.changeSet.headRevision,
      evaluator: { id: 'test-evaluator', version: '1' },
      profileHash: `sha256:${profileArtifact.digest}`,
      profileArtifact,
      contractId: null,
      requiredCriteria: ['captured-change-set-is-valid'],
      workspaceRelativePath: `.fwa/evaluations/${evaluationId}`
    }
  }]);
  await assertSchedulingBlocked('requested');

  await appendEvents('seed-running-evaluation', [{
    type: 'EvaluationExecutionStarted',
    streamId: `evaluation:${evaluationId}`,
    streamVersion: 2,
    payload: {
      evaluationId,
      workspacePath,
      leaseId: 'test-evaluation-lease',
      headRevision: produced.changeSet.headRevision
    }
  }, {
    type: 'NodeEvaluationStarted',
    streamId: `node:${produced.node.id}`,
    streamVersion: produced.node.version + 1,
    payload: {
      nodeId: produced.node.id,
      evaluationId,
      runId: produced.run.id,
      changeSetId: produced.changeSet.id
    }
  }]);
  await assertSchedulingBlocked('running');

  await appendEvents('seed-recovery-evaluation', [{
    type: 'EvaluationRecoveryRequired',
    streamId: `evaluation:${evaluationId}`,
    streamVersion: 3,
    payload: {
      evaluationId,
      nodeId: produced.node.id,
      runId: produced.run.id,
      changeSetId: produced.changeSet.id,
      phase: 'lease-release',
      failure: {
        code: 'LEASE_RELEASE_FAILED',
        message: 'Lease ownership is uncertain.',
        details: null
      },
      workspacePath
    }
  }]);
  await assertSchedulingBlocked('recovery-required');

  const status = await app.getStatus();
  assert.equal(status.evaluations[0].status, 'recovery-required');
  assert.deepEqual(status.nodes.find((node) => node.id === followUpNode.id).runIds, []);
  assert.equal(status.runs.length, 1);
  let cleanupCalls = 0;
  const reconciliation = await app.reconcileRun({
    workspace: {
      async remove(options) {
        cleanupCalls += 1;
        return workspace.remove(options);
      }
    }
  });
  assert.equal(reconciliation.ok, true);
  assert.equal(reconciliation.reconciled, false);
  assert.equal(reconciliation.reason, 'evaluation-operation-active');
  assert.equal(reconciliation.evaluation.id, evaluationId);
  assert.equal(reconciliation.lease.held, false);
  assert.equal(cleanupCalls, 0);
  assert.equal((await app.getStatus()).runs[0].workspaceStatus, 'cleanup-failed');
  assert.equal(await pathExists(produced.run.workspacePath), true);
});

test('dirty project preflight records no Run or ChangeSet events', async (t) => {
  const { root, app, workspace } = await fixture(t);
  const before = await app.getStatus();
  await writeFile(path.join(root, 'seed.txt'), 'dirty main worktree\n', 'utf8');

  await assert.rejects(
    app.runNext({
      executor: new FileOperationsExecutor(),
      workspace,
      input: fileOperationsInput(),
      commandId: 'dirty-preflight'
    }),
    (error) => error.code === 'dirty-project-root'
      && error.details.changes.some((change) => change.path === 'seed.txt')
  );

  const after = await app.getStatus();
  assert.equal(after.eventCount, before.eventCount);
  assert.equal(after.batchCount, before.batchCount);
  assert.deepEqual(after.runs, []);
  assert.deepEqual(after.changeSets, []);
  assert.equal(
    (await app.listEvents()).some((event) => event.type.startsWith('Run')),
    false
  );
  assert.equal(
    (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/fwa/runs'])).stdout,
    ''
  );
});

test('dirty nested submodule content can never become a Produced Run', async (t) => {
  const { root, app, workspace } = await fixture(t, {
    writes: ['vendor/sub', 'vendor/sub/**']
  });
  const submoduleRoot = await mkdtemp(path.join(os.tmpdir(), 'fwa-run-submodule-'));
  t.after(() => rm(submoduleRoot, { recursive: true, force: true, maxRetries: 5 }));
  await git(submoduleRoot, ['init', '-b', 'main']);
  await git(submoduleRoot, ['config', 'user.name', 'FWA Test']);
  await git(submoduleRoot, ['config', 'user.email', 'fwa-test@example.invalid']);
  await writeFile(path.join(submoduleRoot, 'nested.txt'), 'submodule base\n', 'utf8');
  await git(submoduleRoot, ['add', 'nested.txt']);
  await git(submoduleRoot, ['commit', '-m', 'submodule base']);
  await git(root, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    submoduleRoot,
    'vendor/sub'
  ]);
  await git(root, ['commit', '-am', 'add submodule']);
  const baseRevision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  const executor = {
    schemaVersion: 1,
    id: 'dirty-submodule-executor',
    version: '1',
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    async execute({ workspaceRoot }) {
      await git(workspaceRoot, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '--recursive'
      ]);
      await writeFile(
        path.join(workspaceRoot, 'vendor', 'sub', 'nested.txt'),
        'uncaptured nested mutation\n',
        'utf8'
      );
      return { ok: true };
    }
  };

  const result = await app.runNext({
    executor,
    workspace,
    input: { schemaVersion: 1, action: 'mutate-submodule' },
    commandId: 'dirty-submodule-run'
  });
  assert.equal(result.ok, false);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.failure.code, 'uncapturable-worktree-effects');
  assert.equal(result.run.failure.phase, 'capture');
  assert.equal(result.run.workspaceStatus, 'preserved');
  assert.equal(result.changeSet, null);
  assert.equal((await app.getStatus()).changeSets.length, 0);
  assert.equal((await git(root, ['rev-parse', result.run.ref ?? `refs/heads/fwa/runs/${result.run.id}`])).stdout.trim(), baseRevision);
  assert.equal(
    await readFile(path.join(result.run.workspacePath, 'vendor', 'sub', 'nested.txt'), 'utf8'),
    'uncaptured nested mutation\n'
  );
});
