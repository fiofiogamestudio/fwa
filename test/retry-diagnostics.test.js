import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseNodeRetry } from '../src/core/retry-diagnostics.js';

const node = (id = 'feature', extra = {}) => ({ id, logicalId: 'feature', goalId: 'goal',
  budget: { maxRetries: 2 }, ...extra });
const run = (id, nodeId = 'feature', extra = {}) => ({ id, nodeId, goalId: 'goal',
  createdSequence: Number(id.slice(1)), createdAt: '2026-09-18T00:00:00Z',
  baseRevision: 'base', inputHash: 'input', executor: { id: 'test', version: '1' },
  status: 'failed', failedAt: '2026-09-18T01:00:00Z',
  failure: { code: 'TEST_FAILURE', message: 'Failure in /work/run_123/a.txt' }, ...extra });

test('revisions retain a logical attempt budget; other goals do not consume it', () => {
  const current = node('feature@revision-4');
  const projection = { nodes: [node(), node('feature@revision-2'), node('feature@revision-3'), current,
    node('other', { goalId: 'other-goal' })],
  runs: [run('r1'), run('r2', 'feature@revision-2'), run('r3', 'feature@revision-3'), run('r4', 'other')] };
  const result = diagnoseNodeRetry(current, projection, { inputHash: 'new' });
  assert.equal(result.code, 'logical-node-retry-budget-exhausted');
  assert.equal(result.attempts, 3);
  assert.equal(result.attemptsSinceIntegration, 3);
});

test('actual integrated output resets the consecutive budget, while history stays visible', () => {
  const current = node('feature@revision-3');
  const projection = { nodes: [node(), current], runs: [run('r1'), run('r2'), run('r3', current.id)],
    changeSets: [{ id: 'cs', runId: 'r2' }],
    integrations: [{ nodeId: 'feature', changeSetId: 'cs', status: 'integrated', integratedAt: '2026-09-18T01:00:00Z' }] };
  const result = diagnoseNodeRetry(current, projection);
  assert.equal(result.attempts, 3);
  assert.equal(result.attemptsSinceIntegration, 1);
  assert.equal(result.blocked, false);
});

test('same captured patch with fresh commits is no progress; changed repair input permits a bounded attempt', () => {
  const n = node(), projection = { nodes: [n],
    runs: [run('r1', n.id, { changeSetId: 'c1' }), run('r2', n.id, { changeSetId: 'c2' })],
    changeSets: ['c1', 'c2'].map((id, i) => ({ id, runId: 'r' + (i + 1), baseRevision: 'base',
      headRevision: 'different-' + id, patchArtifact: { digest: 'same', size: 15 } })) };
  assert.equal(diagnoseNodeRetry(n, projection).code, 'retry-no-progress');
  assert.equal(diagnoseNodeRetry(n, projection, { inputHash: 'input' }).code, 'retry-no-progress');
  assert.equal(diagnoseNodeRetry(n, projection, { inputHash: 'fixed' }).blocked, false);
  projection.changeSets[1].patchArtifact.digest = 'new-code';
  assert.equal(diagnoseNodeRetry(n, projection).blocked, false);
});

test('input errors demand a correction immediately, without erasing the failure', () => {
  const n = node(), projection = { nodes: [n], runs: [run('r1', n.id, { failure: {
    code: 'FWA_INVALID_CODEX_EXECUTOR_INPUT', message: 'Too large', details: { reason: 'prompt-too-large' }
  } })] };
  assert.equal(diagnoseNodeRetry(n, projection).code, 'retry-input-repair-required');
  assert.equal(diagnoseNodeRetry(n, projection, { inputHash: 'small' }).blocked, false);
  assert.equal(projection.runs.length, 1);
});

test('pending feedback stays a distinct actionable gate rather than execution progress', () => {
  const n = node();
  const result = diagnoseNodeRetry(n, { nodes: [n], runs: [], nodeFeedback: [
    { goalId: 'goal', status: 'pending' }
  ] });
  assert.equal(result.code, 'pending-node-feedback');
  assert.equal(result.lastProgressAt, null);
  assert.equal(result.attempts, 0);
});

test('different failing checks are distinguished; repeated rejected empty patches stop', () => {
  const n = node(), projection = { nodes: [n], runs: [1, 2].map(i => run('r' + i, n.id,
    { failure: null, status: 'produced', changeSetId: 'c' + i })),
  changeSets: [1, 2].map(i => ({ id: 'c' + i, patchArtifact: { digest: 'empty', size: 0 }, baseRevision: 'base' })),
  evaluations: [1, 2].map(i => ({ runId: 'r' + i, status: 'rejected', evidenceId: 'e' + i })),
  evidence: [1, 2].map(i => ({ id: 'e' + i, criteria: [{ id: 'behavior', result: 'fail' }] })) };
  assert.equal(diagnoseNodeRetry(n, projection).code, 'retry-no-progress');
  projection.evidence[1].criteria[0].id = 'different-behavior';
  assert.equal(diagnoseNodeRetry(n, projection).blocked, false);
});
