import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { FwaApplication } from '../src/application/fwa-application.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';

const exec = promisify(execFile);
const git = (cwd, args) => exec('git', args, { cwd, windowsHide: true, timeout: 30000 });

async function fixture(t, { failureCode = 'FWA_CODEX_OUTPUT_LIMIT_EXCEEDED', maxRetries = 3 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-implicit-retry-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Implicit Retry Test']);
  await git(root, ['config', 'user.email', 'implicit-retry@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'fixture']);
  const app = new FwaApplication(root);
  await app.init();
  const { goal } = await app.createGoal({ title: 'Skip blocked independent work' });
  const node = id => ({ id, instruction: `Produce ${id}.txt.`, dependsOn: [], reads: ['seed.txt'], writes: [`${id}.txt`],
    capabilities: ['code_edit'], acceptance: { checks: ['behavior'] },
    budget: { maxRetries, maxFiles: 2, maxDiffLines: 20 } });
  await app.loadPlan({ goalId: goal.id, plan: { schemaVersion: 1, nodes: [node('A')] } });
  let calls = 0;
  const executor = { schemaVersion: 1, id: 'implicit-selection', version: '1', capabilities: ['code_edit'],
    async execute({ node: current, workspaceRoot, input }) {
      calls += 1;
      const id = current.logicalId ?? current.id;
      await writeFile(path.join(workspaceRoot, `${id}.txt`), 'candidate\n');
      if (id === 'A' && !input.repaired) throw Object.assign(new Error('Deterministic fixture failure.'), { code: failureCode });
      return { schemaVersion: 1, ok: true };
    } };
  const workspace = new GitWorktreeAdapter(root);
  const run = (commandId, nodeId, input = { repaired: false }) => app.runNext({
    commandId, ...(nodeId === undefined ? {} : { nodeId }), input, executor, workspace, baseRevision: 'HEAD'
  });
  const addIndependentNode = async ({ reviseA = false } = {}) => {
    const plan = { schemaVersion: 1, nodes: [node('A'), node('B')] };
    if (reviseA) plan.nodes[0].instruction += ' Repair within the unchanged budget.';
    await app.revisePlan({ goalId: goal.id, plan, expectedRevision: 1, reason: 'Add an independent deliverable.' });
    const state = await app.getStatus();
    const ready = state.nodes.filter(item => item.status === 'ready' && !item.supersededByRevision)
      .sort((a, b) => a.readySequence - b.readySequence || a.id.localeCompare(b.id));
    assert.equal(ready[0].logicalId ?? ready[0].id, 'A', 'the blocked node must actually be first');
    return ready[0].id;
  };
  return { app, run, addIndependentNode, calls: () => calls };
}

test('implicit selection skips first ready input failure and dispatches independent B using the resolved HEAD', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('fail-A', 'A')).run.status, 'failed');
  const firstId = await f.addIndependentNode();
  await assert.rejects(f.run('explicit-A', firstId), { code: 'retry-input-repair-required' });
  const result = await f.run('implicit-B');
  assert.equal(result.ok, true);
  assert.equal(result.node.logicalId ?? result.node.id, 'B');
  assert.equal(f.calls(), 2);
});

test('corrected input admits first ready A before independent B', async t => {
  const f = await fixture(t);
  await f.run('fail-A', 'A');
  await f.addIndependentNode();
  const result = await f.run('repaired-A', undefined, { repaired: true });
  assert.equal(result.ok, true);
  assert.equal(result.node.logicalId ?? result.node.id, 'A');
  assert.equal(f.calls(), 2);
});

test('all blocked ready nodes return bounded deferred reasons without creating a Run or executing', async t => {
  const f = await fixture(t);
  await f.run('fail-A', 'A');
  const before = await f.app.getStatus();
  await assert.rejects(f.run('all-blocked'), error => {
    assert.equal(error.code, 'no-ready-node');
    assert.equal(error.details.deferredCount, 1);
    assert.equal(error.details.deferredTruncated, false);
    assert.deepEqual(error.details.deferred.map(item => [item.nodeId, item.code]), [['A', 'retry-input-repair-required']]);
    assert.ok(JSON.stringify(error.details).length < 2048);
    return true;
  });
  const after = await f.app.getStatus();
  assert.equal(after.runs.length, before.runs.length);
  assert.equal(after.eventCount, before.eventCount);
  assert.equal(f.calls(), 1);
});

test('implicit selection skips a logical budget exhausted by an earlier plan revision', async t => {
  const f = await fixture(t, { maxRetries: 0 });
  await f.run('fail-A', 'A');
  const revisedA = await f.addIndependentNode({ reviseA: true });
  await assert.rejects(f.run('explicit-budget-A', revisedA), { code: 'logical-node-retry-budget-exhausted' });
  const result = await f.run('budget-independent-B');
  assert.equal(result.ok, true);
  assert.equal(result.node.logicalId ?? result.node.id, 'B');
  assert.equal(f.calls(), 2);
});

test('implicit selection skips repeated identical failure without starving independent B', async t => {
  const f = await fixture(t, { failureCode: 'TEST_REPEAT_FAILURE' });
  await f.run('fail-A-first', 'A');
  await f.run('fail-A-second', 'A');
  const firstId = await f.addIndependentNode();
  await assert.rejects(f.run('explicit-repeated-A', firstId), { code: 'retry-no-progress' });
  const result = await f.run('repeat-independent-B');
  assert.equal(result.ok, true);
  assert.equal(result.node.logicalId ?? result.node.id, 'B');
  assert.equal(f.calls(), 3);
});
