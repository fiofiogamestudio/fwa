import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import { FileOperationsExecutor, FILE_OPERATIONS_CAPABILITY } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';

const exec = promisify(execFile);
const git = (cwd, args) => exec('git', args, { cwd, windowsHide: true, timeout: 30_000 });
const input = content => ({ schemaVersion: 1, operations: [{ type: 'write', path: 'result.txt', content }] });

async function fixture(t, maxRetries) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-retry-admission-review-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Retry Admission Review']);
  await git(root, ['config', 'user.email', 'retry-review@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'test: retry admission base']);
  const app = new FwaApplication(root);
  await app.init();
  const goal = (await app.createGoal({ title: 'Repair a rejected candidate', commandId: 'goal' })).goal;
  await app.loadPlan({ goalId: goal.id, commandId: 'plan', plan: { schemaVersion: 1, nodes: [{
    id: 'repair', instruction: 'Produce result.txt from seed.txt.', dependsOn: [], reads: ['seed.txt'], writes: ['result.txt'],
    capabilities: [FILE_OPERATIONS_CAPABILITY], acceptance: { checks: ['behavior'] },
    budget: { maxRetries, maxFiles: 1, maxDiffLines: 20 }
  }] } });
  const workspace = new GitWorktreeAdapter(root);
  const delegate = new FileOperationsExecutor();
  let executions = 0;
  const executor = { schemaVersion: 1, id: 'retry-admission-review', version: '1', capabilities: delegate.capabilities,
    async execute(context) { executions += 1; return delegate.execute(context); } };
  const run = (commandId, content = 'unchanged candidate\n', nodeId = 'repair') => app.runNext({
    commandId, nodeId, input: input(content), executor, workspace
  });
  const reject = (changeSetId, commandId) => app.evaluateChangeSet({ changeSetId, commandId, workspace,
    evaluator: new CommandEvaluator(), profile: { schemaVersion: 1, id: 'reject-same-behavior', checks: [{
      id: 'behavior', kind: 'test', command: process.execPath, args: ['-e', 'process.exit(7)'],
      timeoutMs: 10_000, expectedExitCodes: [0]
    }] } });
  return { app, goal, run, reject, executions: () => executions };
}

test('same patch and failed checks stop a third identical Run before execution; a repair input can proceed', async t => {
  const f = await fixture(t, 3);
  const first = await f.run('first');
  assert.equal(first.ok, true);
  assert.equal((await f.reject(first.changeSet.id, 'reject-first')).ok, false);
  await f.app.retryNode({ nodeId: 'repair', commandId: 'retry-second' });
  const second = await f.run('second');
  assert.equal(second.ok, true);
  assert.equal(second.changeSet.patchArtifact.digest, first.changeSet.patchArtifact.digest);
  assert.equal((await f.reject(second.changeSet.id, 'reject-second')).ok, false);
  await f.app.retryNode({ nodeId: 'repair', commandId: 'retry-third' });
  const before = await f.app.getStatus();
  const diagnostics = before.retryDiagnostics.find(item => item.nodeId === 'repair');
  assert.equal(diagnostics.repeatedFailureCount, 2);
  assert.equal(diagnostics.code, 'retry-no-progress');
  await assert.rejects(f.run('third-identical'), { code: 'retry-no-progress' });
  const after = await f.app.getStatus();
  assert.equal(f.executions(), 2);
  assert.equal(after.runs.length, 2);
  assert.equal(after.eventCount, before.eventCount);
  const repaired = await f.run('third-repaired', 'corrected candidate\n');
  assert.equal(repaired.ok, true);
  assert.equal(f.executions(), 3);
  assert.notEqual(repaired.changeSet.patchArtifact.digest, first.changeSet.patchArtifact.digest);
});

test('new plan revisions preserve the logical attempt budget after rejected candidates', async t => {
  const f = await fixture(t, 1);
  const first = await f.run('first');
  await f.reject(first.changeSet.id, 'reject-first');
  await f.app.retryNode({ nodeId: 'repair', commandId: 'retry-second' });
  const second = await f.run('second', 'second candidate\n');
  await f.reject(second.changeSet.id, 'reject-second');
  const status = await f.app.getStatus();
  const plan = structuredClone(status.workflow.revisions.at(-1).plan);
  plan.nodes[0].instruction = 'Repair the diagnosed issue while preserving the original acceptance.';
  const revised = await f.app.revisePlan({ goalId: f.goal.id, plan, expectedRevision: 1,
    reason: 'Scoped repair instruction', commandId: 'revise' });
  const currentId = revised.nodeBindings.find(binding => binding.logicalId === 'repair').nodeId;
  assert.notEqual(currentId, 'repair');
  const before = await f.app.getStatus();
  const current = before.nodes.find(node => node.id === currentId);
  assert.equal(current.runIds.length, 0);
  const diagnostic = before.retryDiagnostics.find(item => item.nodeId === currentId);
  assert.equal(diagnostic.attemptsSinceIntegration, 2);
  assert.equal(diagnostic.code, 'logical-node-retry-budget-exhausted');
  await assert.rejects(f.run('new-revision-attempt', 'changed input does not refresh budget\n', currentId),
    { code: 'logical-node-retry-budget-exhausted' });
  assert.equal(f.executions(), 2);
  assert.equal((await f.app.getStatus()).eventCount, before.eventCount);
  const expandedPlan = structuredClone(before.workflow.revisions.at(-1).plan);
  expandedPlan.nodes[0].budget.maxRetries = 2;
  const expanded = await f.app.revisePlan({ goalId: f.goal.id, plan: expandedPlan, expectedRevision: 2,
    reason: 'Explicitly allow one additional diagnosed repair attempt.', commandId: 'expand-budget' });
  const expandedId = expanded.nodeBindings.find(binding => binding.logicalId === 'repair').nodeId;
  const repair = await f.run('budgeted-repair', 'explicitly budgeted repair\n', expandedId);
  assert.equal(repair.ok, true);
  assert.equal(f.executions(), 3);
});

test('pending feedback blocks retry admission without changing the rejected node or its history', async t => {
  const f = await fixture(t, 3);
  const first = await f.run('first');
  await f.reject(first.changeSet.id, 'reject-first');
  await f.app.submitNodeFeedback({ nodeId: 'repair', text: 'Resolve the acceptance mismatch before another attempt.', commandId: 'feedback' });
  const before = await f.app.getStatus();
  await assert.rejects(f.app.retryNode({ nodeId: 'repair', commandId: 'blocked-retry' }), { code: 'pending-node-feedback' });
  const after = await f.app.getStatus();
  assert.equal(after.eventCount, before.eventCount);
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.runs, before.runs);
  assert.equal(after.nodes[0].status, 'rejected');
  assert.equal(after.workflow.feedback[0].status, 'pending');
});
