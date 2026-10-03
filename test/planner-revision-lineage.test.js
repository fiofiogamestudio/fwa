import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePlannerResponse } from '../src/adapters/codex-planner.js';
import { FwaApplication } from '../src/application/fwa-application.js';

const leaf = (id, extra = {}) => ({ id, title: id, parentId: '', instruction: `Implement ${id}.`,
  outcome: `The user can use ${id}.`, dependencyReasons: [], derivedFrom: null, resources: [], dependsOn: [],
  reads: [], writes: [`src/${id}.txt`], checks: ['feature-check'], maxFiles: 2, maxDiffLines: 100, ...extra });
const response = nodes => ({ title: 'Refine existing result children', questions: [], groups: [], nodes });
const raw = node => ({ ...leaf(node.id), title: node.title, parentId: node.parentId ?? '', instruction: node.instruction,
  outcome: node.outcome ?? null, dependencyReasons: node.dependencyReasons ?? null,
  derivedFrom: node.derivedFrom ?? null, resources: node.resources ?? null,
  dependsOn: node.dependsOn, reads: node.reads, writes: node.writes,
  checks: typeof node.acceptance === 'string' ? null : node.acceptance.checks,
  maxFiles: node.budget.maxFiles, maxDiffLines: node.budget.maxDiffLines });
function lineage(sourceId = 'source') {
  const initial = parsePlannerResponse(response([leaf(sourceId), leaf('independent')]), { prefix: 'first' }).plan;
  const source = initial.nodes[0].id;
  const split = parsePlannerResponse(response([
    leaf('parta', { derivedFrom: source }), leaf('partb', { derivedFrom: source }), raw(initial.nodes[1])
  ]), { prefix: 'split', existingPlan: initial }).plan;
  return { initial, source, split };
}

test('later planner revisions preserve short and long historical sources absent from the current graph', () => {
  for (const sourceId of ['source', 's'.repeat(64)]) {
    const { source, split } = lineage(sourceId);
    assert.equal(split.nodes.some(node => node.id === source), false);
    const nodes = split.nodes.map(raw); nodes[0].instruction += ' Apply the requested correction.';
    const next = parsePlannerResponse(response(nodes), { prefix: 'third', existingPlan: split }).plan;
    assert.deepEqual(next.nodes.filter(node => node.derivedFrom).map(node => node.derivedFrom), [source, source]);
    assert.equal(next.nodes[0].instruction, nodes[0].instruction);
    assert.equal(Object.hasOwn(next.nodes[2], 'derivedFrom'), false);
  }
});

test('null preserves existing lineage while changing an existing source is rejected', () => {
  const { source, split } = lineage();
  const kept = split.nodes.map(node => ({ ...raw(node), derivedFrom: null }));
  const preserved = parsePlannerResponse(response(kept), { prefix: 'third', existingPlan: split }).plan;
  assert.deepEqual(preserved.nodes.filter(node => node.derivedFrom).map(node => node.derivedFrom), [source, source]);
  const changed = split.nodes.map(raw); changed[0].derivedFrom = split.nodes[2].id;
  assert.throws(() => parsePlannerResponse(response(changed), { prefix: 'third', existingPlan: split }),
    { code: 'derivation-source-changed' });
  const added = split.nodes.map(raw); added[2].derivedFrom = split.nodes[0].id;
  assert.throws(() => parsePlannerResponse(response(added), { prefix: 'third', existingPlan: split }),
    { code: 'derivation-source-changed' });
});

test('new derived leaves map their current source once and cannot attach to a removed historical source', () => {
  const { source, split } = lineage();
  const currentSource = split.nodes[0].id;
  const next = parsePlannerResponse(response([
    leaf('detaila', { derivedFrom: currentSource }), leaf('detailb', { derivedFrom: currentSource }),
    ...split.nodes.slice(1).map(raw)
  ]), { prefix: 'third', existingPlan: split }).plan;
  assert.deepEqual(next.nodes.slice(0, 2).map(node => ({ id: node.id, source: node.derivedFrom })), [
    { id: 'third-detaila', source: currentSource }, { id: 'third-detailb', source: currentSource }
  ]);
  assert.throws(() => parsePlannerResponse(response([...split.nodes.map(raw), leaf('orphan', { derivedFrom: source })]),
    { prefix: 'third', existingPlan: split }), /Every added leaf/);
});

test('three real application plan versions preserve lineage and replay the correction without new execution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-lineage-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const app = new FwaApplication(root); await app.init();
  const goal = (await app.createGoal({ title: 'Refine a previously split result', commandId: 'goal' })).goal;
  const { initial, source, split } = lineage();
  await app.loadPlan({ goalId: goal.id, plan: initial, commandId: 'initial-plan' });
  await app.revisePlan({ goalId: goal.id, expectedRevision: 1, plan: split,
    reason: 'Separate independently deliverable results.', commandId: 'split-plan' });
  const before = await app.getStatus(), current = before.workflow.revisions.at(-1).plan;
  const nodes = current.nodes.map(raw); nodes[0].instruction += ' Apply the requested correction.';
  const corrected = parsePlannerResponse(response(nodes), { prefix: 'third', existingPlan: current }).plan;
  const request = { goalId: goal.id, expectedRevision: 2, plan: corrected,
    reason: 'Correct the first child while preserving its origin.', commandId: 'correct-child' };
  const revised = await app.revisePlan(request);
  assert.equal(revised.revision.revision, 3);
  assert.equal(revised.nodes.find(node => node.logicalId === 'split-parta').derivedFrom, source);
  assert.equal(revised.nodes.find(node => node.logicalId === 'split-partb').id,
    before.nodes.find(node => node.logicalId === 'split-partb').id, 'The unaffected child is not recreated.');
  const reopened = new FwaApplication(root), final = await reopened.getStatus();
  assert.deepEqual(final.workflow.revisions.map(item => item.revision), [1, 2, 3]);
  assert.equal(final.nodes.find(node => node.id === source).supersededByNodeId, null);
  assert.equal(final.nodes.filter(node => node.logicalId === 'split-parta').length, 2);
  assert.ok(final.nodes.filter(node => node.derivedFrom).every(node => node.derivedFrom === source));
  assert.equal(final.runs.length, 0);
  assert.equal((await reopened.revisePlan(request)).appended, false);
  assert.equal((await reopened.getStatus()).lastSequence, final.lastSequence);
  assert.equal((await reopened.verify()).ok, true);
});
