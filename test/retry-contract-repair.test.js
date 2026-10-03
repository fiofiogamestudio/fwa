import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { diagnoseNodeRetry } from '../src/core/retry-diagnostics.js';

const exec = promisify(execFile);
const git = (cwd, args) => exec('git', args, { cwd, windowsHide: true, timeout: 30000 });
const fields = [
  { field: 'maxFiles', code: 'MAX_FILES_EXCEEDED', unrelated: 'maxDiffLines' },
  { field: 'maxDiffLines', code: 'MAX_DIFF_LINES_EXCEEDED', unrelated: 'maxFiles' }
];

async function fixture(t, field, maxRetries = 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-contract-repair-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Contract Repair Test']);
  await git(root, ['config', 'user.email', 'contract-repair@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'contract repair baseline']);
  const app = new FwaApplication(root);
  await app.init();
  const { goal } = await app.createGoal({ title: 'Produce both requested files', commandId: 'goal' });
  const plan = { schemaVersion: 1, nodes: [{
    id: 'result', title: 'Both output files', instruction: 'Produce both explicitly requested output files.',
    dependsOn: [], reads: ['seed.txt'], writes: ['one.txt', 'two.txt'],
    capabilities: ['file_operations'], acceptance: { checks: ['both-files'] },
    budget: { maxRetries, maxFiles: 10, maxDiffLines: 20, [field]: 1 }
  }] };
  await app.loadPlan({ goalId: goal.id, plan, commandId: 'plan' });
  const workspace = new GitWorktreeAdapter(root), delegate = new FileOperationsExecutor();
  let executions = 0, nodeId = 'result', revision = 1;
  const executor = { schemaVersion: 1, id: 'contract-repair', version: '1', capabilities: delegate.capabilities,
    execute(context) { executions++; return delegate.execute(context); } };
  const input = { schemaVersion: 1, operations: [
    { type: 'write', path: 'one.txt', content: 'one\n' },
    { type: 'write', path: 'two.txt', content: 'two\n' }
  ] };
  const run = commandId => app.runNext({ nodeId, commandId, input, executor, workspace });
  const revise = async (edit, commandId) => {
    edit(plan.nodes[0]);
    const result = await app.revisePlan({ goalId: goal.id, plan, expectedRevision: revision,
      commandId, reason: 'Explicitly repair the declared output contract.' });
    revision++;
    nodeId = result.nodeBindings.find(item => item.logicalId === 'result').nodeId;
    return nodeId;
  };
  return { app, run, revise, executions: () => executions, nodeId: () => nodeId };
}

for (const { field, code, unrelated } of fields) {
  test(`real Git: repairing observed ${field} admits the identical patch; unrelated revisions do not`, { timeout: 120000 }, async t => {
    const f = await fixture(t, field);
    const first = await f.run('first'), second = await f.run('second');
    for (const result of [first, second]) {
      assert.equal(result.ok, false);
      assert.deepEqual(result.changeSet.violations.map(item => item.code), [code]);
      assert.deepEqual(result.changeSet.violations[0].details, { actual: 2, limit: 1 });
    }
    assert.equal(first.changeSet.patchArtifact.digest, second.changeSet.patchArtifact.digest);
    await f.revise(node => { node.title = 'Clearer wording'; node.budget[unrelated] += 10; }, 'unrelated-revision');
    const beforeBlocked = await f.app.getStatus();
    await assert.rejects(f.run('unrelated-attempt'), { code: 'retry-no-progress' });
    const afterBlocked = await f.app.getStatus();
    assert.equal(afterBlocked.eventCount, beforeBlocked.eventCount);
    assert.equal(afterBlocked.runs.length, 2);
    assert.equal(f.executions(), 2);

    await f.revise(node => { node.budget[field] = 2; }, 'correct-observed-limit');
    const beforeRepair = await f.app.getStatus();
    const diagnostic = beforeRepair.retryDiagnostics.find(item => item.nodeId === f.nodeId());
    assert.equal(diagnostic.blocked, false);
    assert.equal(diagnostic.attemptsSinceIntegration, 2, 'A contract repair does not reset the logical budget.');
    assert.equal(diagnostic.repeatedFailureCount, 2, 'Historical repeated output remains visible.');
    assert.equal(diagnostic.lastProgressAt, null, 'A revised limit alone is not a produced result.');
    const repaired = await f.run('repaired-attempt');
    assert.equal(repaired.ok, true);
    assert.equal(repaired.changeSet.valid, true);
    assert.deepEqual(repaired.changeSet.violations, []);
    assert.equal(repaired.changeSet.patchArtifact.digest, first.changeSet.patchArtifact.digest);
    assert.equal(repaired.run.inputHash, first.run.inputHash);
    assert.deepEqual(repaired.run.executor, first.run.executor);
    assert.equal(f.executions(), 3);
    const final = await f.app.getStatus();
    assert.equal(final.retryDiagnostics.find(item => item.nodeId === f.nodeId()).attemptsSinceIntegration, 3);
  });
}

test('real Git: a repaired capture limit cannot reopen an exhausted cross-revision attempt budget', { timeout: 120000 }, async t => {
  const f = await fixture(t, 'maxFiles', 1);
  await f.run('first'); await f.run('second');
  await f.revise(node => { node.budget.maxFiles = 2; }, 'repair-without-more-attempts');
  const before = await f.app.getStatus();
  await assert.rejects(f.run('exhausted-attempt'), { code: 'logical-node-retry-budget-exhausted' });
  const after = await f.app.getStatus();
  assert.equal(after.eventCount, before.eventCount);
  assert.equal(after.runs.length, 2);
  assert.equal(f.executions(), 2);
});

function failedProjection() {
  const old = { id: 'result', logicalId: 'result', goalId: 'goal', budget: { maxRetries: 3, maxFiles: 1, maxDiffLines: 1 } };
  const node = { ...old, id: 'result@revision-2', budget: { ...old.budget, maxFiles: 2, maxDiffLines: 2 } };
  const runs = [1, 2].map(i => ({ id: 'r' + i, nodeId: old.id, createdSequence: i,
    changeSetId: 'c' + i, baseRevision: 'base', inputHash: 'input', executor: { id: 'test', version: '1' },
    failure: { code: 'CHANGESET_INVALID', message: 'Captured output violates its declared budget.' } }));
  const violations = fields.map(({ field, code }) => ({ code, path: 'budget.' + field, details: { actual: 2, limit: 1 } }));
  const changeSets = [1, 2].map(i => ({ id: 'c' + i, runId: 'r' + i, baseRevision: 'base',
    valid: false, patchArtifact: { digest: 'same', size: 10 }, violations: structuredClone(violations) }));
  return { node, projection: { nodes: [old, node], runs, changeSets } };
}

test('all observed capture violations must be repaired; unknown or incomplete legacy evidence stays blocked', () => {
  const original = failedProjection();
  assert.equal(diagnoseNodeRetry(original.node, original.projection).blocked, false);
  for (const mutate of [
    ({ node }) => { node.budget.maxDiffLines = 1; },
    ({ node }) => { node.budget.maxFiles = 1; node.budget.maxRetries = 20; node.title = 'New title'; },
    ({ projection }) => { projection.changeSets.at(-1).violations.push({ code: 'UNDECLARED_WRITE' }); },
    ({ projection }) => { delete projection.changeSets.at(-1).violations[0].details; },
    ({ projection }) => { projection.changeSets.at(-1).violations[0].details.actual = 3; },
    ({ projection }) => { projection.changeSets.at(-1).violations = []; },
    ({ projection }) => { projection.runs.at(-1).failure.code = 'FWA_CODEX_OUTPUT_LIMIT_EXCEEDED'; }
  ]) {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.equal(diagnoseNodeRetry(candidate.node, candidate.projection).blocked, true);
  }
});
