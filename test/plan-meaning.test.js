import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePlan } from '../src/core/dag.js';
import { currentLogicalPlan, preparePlanRevision } from '../src/core/workflow.js';
import { parsePlannerResponse } from '../src/adapters/codex-planner.js';
import { FwaApplication, canonicalizePlan } from '../src/application/fwa-application.js';
import { createEvent } from '../src/core/events.js';
import { hashCanonicalValue } from '../src/storage/file-event-store.js';

const leaf = (id, extra = {}) => ({ id, title: id, outcome: `User can use ${id}.`, dependencyReasons: [],
  dependsOn: [], reads: [], writes: [`${id}.txt`], capabilities: ['code_edit'], acceptance: { checks: [`check-${id}`] },
  budget: { maxRetries: 2, maxFiles: 5, maxDiffLines: 100 }, ...extra });
const needs = (id, reason = `Consumes the result of ${id}.`) => ({ dependsOn: [id], dependencyReasons: [{ nodeId: id, reason }] });
const raw = node => ({ id: node.id, title: node.title, parentId: '', instruction: `Deliver ${node.id}.`,
  outcome: node.outcome, dependencyReasons: node.dependencyReasons, derivedFrom: node.derivedFrom ?? null,
  resources: node.resources ?? [], dependsOn: node.dependsOn, reads: node.reads, writes: node.writes,
  checks: node.acceptance.checks, maxFiles: node.budget.maxFiles, maxDiffLines: node.budget.maxDiffLines });
const response = nodes => ({ title: 'Result graph', questions: [], groups: [], nodes: nodes.map(raw) });
const goal = ids => ({ id: 'g', planId: 'p', status: 'planned', planRevision: 1, nodeIds: ids });
const definition = nodes => canonicalizePlan({ schemaVersion: 1, nodes });
const split = () => [leaf('a', { derivedFrom: 'source', acceptance: { checks: ['check-source'] } }),
  leaf('b', { derivedFrom: 'source' }), leaf('consumer', needs('a'))];
const initial = () => [leaf('source'), leaf('consumer', needs('source'))];
const prepare = (nodes, proposed) => preparePlanRevision(goal(nodes.map(node => node.id)), nodes, definition(proposed), 1);

test('node meaning is optional for legacy plans but complete and bounded when declared', () => {
  const legacy = leaf('legacy'); delete legacy.outcome; delete legacy.dependencyReasons;
  assert.equal(validatePlan({ nodes: [legacy] }).ok, true);
  assert.equal(validatePlan({ nodes: [leaf('a'), leaf('b', needs('a'))] }).ok, true);
  for (const extra of [
    { outcome: undefined }, { outcome: ' ' }, { outcome: '猫'.repeat(667) },
    { dependencyReasons: null }, { dependencyReasons: [{ nodeId: 'a', reason: ' ' }] },
    { dependencyReasons: [{ nodeId: 'a', reason: 'Consumes a.', unknown: true }] },
    { dependencyReasons: [] }, { dependencyReasons: [{ nodeId: 'wrong', reason: 'Wrong edge.' }] },
    { dependencyReasons: [{ nodeId: 'a', reason: 'Consumes a.' }, { nodeId: 'a', reason: 'Duplicate.' }] }
  ]) assert.equal(validatePlan({ nodes: [leaf('a'), leaf('b', { ...needs('a'), ...extra })] }).ok, false, JSON.stringify(extra));
  const half = leaf('half'); delete half.dependencyReasons;
  assert.equal(validatePlan({ nodes: [half] }).ok, false);
});

test('planner requires explained results and expresses resource contention without inventing an edge', () => {
  const plan = parsePlannerResponse(response([leaf('a', { resources: ['editor'] }), leaf('b', { resources: ['editor'] })]), { prefix: 'p' }).plan;
  assert.deepEqual(plan.nodes.map(node => node.dependsOn), [[], []]);
  assert.deepEqual(plan.nodes.map(node => node.resources), [['editor'], ['editor']]);
  const withEdge = parsePlannerResponse(response([leaf('a'), leaf('b', needs('a'))]), { prefix: 'p' }).plan;
  assert.deepEqual(withEdge.nodes[1].dependencyReasons, [{ nodeId: 'p-a', reason: 'Consumes the result of a.' }]);
  const missing = response([leaf('a')]); delete missing.nodes[0].outcome;
  assert.throws(() => parsePlannerResponse(missing, { prefix: 'p' }), /schema/);
  const empty = response([leaf('a')]); empty.nodes[0].outcome = null; empty.nodes[0].dependencyReasons = null;
  assert.throws(() => parsePlannerResponse(empty, { prefix: 'p' }), /New leaves require/);
});

test('planner retains absent legacy meaning and rejects unrelated additions and unexplained removal', () => {
  const old = leaf('old'); delete old.outcome; delete old.dependencyReasons;
  const existingPlan = definition([old]);
  const original = response([leaf('old')]);
  Object.assign(original.nodes[0], { outcome: null, dependencyReasons: null, resources: null });
  const next = parsePlannerResponse(original, { prefix: 'p', existingPlan }).plan.nodes[0];
  assert.equal(Object.hasOwn(next, 'outcome'), false);
  assert.equal(Object.hasOwn(next, 'dependencyReasons'), false);
  assert.equal(Object.hasOwn(next, 'resources'), false);
  assert.throws(() => parsePlannerResponse(response([leaf('old'), leaf('unrelated')]), { prefix: 'p', existingPlan }), /Every added leaf/);
  assert.throws(() => parsePlannerResponse(response([leaf('renamed')]), { prefix: 'p', existingPlan }), /retain every existing/);
  const children = [leaf('a', { derivedFrom: 'old' }), leaf('b', { derivedFrom: 'old' })];
  assert.deepEqual(parsePlannerResponse(response(children), { prefix: 'p', existingPlan }).plan.nodes.map(node => node.derivedFrom), ['old', 'old']);
});

test('split revision preserves acceptance, rewires consumers, and maps edge explanations with physical bindings', () => {
  const nodes = initial();
  const revision = prepare(nodes, split());
  const consumer = revision.createdNodes.find(item => item.node.id.startsWith('consumer@')).node;
  assert.equal(consumer.dependsOn[0], 'a@revision-2');
  assert.equal(consumer.dependencyReasons[0].nodeId, 'a@revision-2');
  assert.equal(revision.retiredNodes.find(item => item.nodeId === 'source').replacementNodeId, null);
  const projected = revision.createdNodes.map(item => ({ ...item.node, logicalId: item.definition.logicalId }));
  assert.deepEqual(currentLogicalPlan({ ...goal(revision.nodeIds), groups: [] }, projected).nodes.map(node => node.dependencyReasons),
    split().map(node => node.dependencyReasons));
  assert.deepEqual(projected.filter(node => node.derivedFrom).map(node => node.derivedFrom), ['source', 'source']);
});

test('derivation refuses lost checks, named contract partitioning, duplicate outcomes and disconnected consumers', () => {
  const nodes = initial();
  let proposed = split(); proposed[0].acceptance.checks = ['other'];
  assert.throws(() => prepare(nodes, proposed), { code: 'derivation-acceptance-loss' });
  proposed = split(); proposed[1].outcome = `  ${proposed[0].outcome}  `.trim().toUpperCase();
  assert.throws(() => prepare(nodes, proposed), { code: 'derivation-duplicate-outcome' });
  proposed = split(); proposed[2] = leaf('consumer');
  assert.throws(() => prepare(nodes, proposed), { code: 'derivation-consumer-disconnected' });
  const named = initial(); named[0].acceptance = 'trusted-contract';
  assert.throws(() => prepare(named, split()), { code: 'derivation-acceptance-loss' });
  proposed = split(); proposed[0].derivedFrom = 'not-current';
  assert.throws(() => prepare(nodes, proposed), { code: 'derivation-source-not-current' });
  proposed = split().filter(node => node.id !== 'b');
  assert.throws(() => prepare(nodes, proposed), { code: 'derivation-child-limit' });
});

test('adding prerequisite results retains the source and cannot become an unrelated work expansion', () => {
  const source = leaf('source');
  const child = leaf('tool', { derivedFrom: 'source' });
  assert.throws(() => prepare([source], [source, child]), { code: 'derivation-disconnected-child' });
  assert.equal(prepare([source], [{ ...source, ...needs('tool') }, child]).createdNodes.length, 2);
  const children = Array.from({ length: 9 }, (_, index) => leaf(`child-${index}`, { derivedFrom: 'source' }));
  assert.throws(() => prepare([source], [{ ...source, dependsOn: children.map(node => node.id),
    dependencyReasons: children.map(node => ({ nodeId: node.id, reason: 'Consumes this independent output.' })) }, ...children]), { code: 'derivation-child-limit' });
});

test('derivation cannot discard an upstream prerequisite when replacing or retaining its source', () => {
  const upstream = leaf('upstream'), source = leaf('source', needs('upstream'));
  const replacement = split().filter(node => node.id !== 'consumer');
  assert.throws(() => prepare([upstream, source], [upstream, ...replacement]), { code: 'derivation-prerequisite-loss' });
  const child = leaf('tool', { derivedFrom: 'source' });
  assert.throws(() => prepare([upstream, source], [upstream, { ...source, ...needs('tool') }, child]),
    { code: 'derivation-prerequisite-loss' });
});

test('derivation preserves upstream reachability directly or through another child without forcing every child to depend on it', () => {
  const upstream = leaf('upstream'), source = leaf('source', needs('upstream'));
  const replacement = split().filter(node => node.id !== 'consumer');
  replacement[0] = { ...replacement[0], ...needs('upstream') };
  let revision = prepare([upstream, source], [upstream, ...replacement]);
  assert.deepEqual(revision.plan.nodes.find(node => node.id === 'b').dependsOn, [], 'Independent child retains no invented prerequisite.');
  replacement[1] = { ...replacement[1], ...needs('a') };
  revision = prepare([upstream, source], [upstream, ...replacement]);
  assert.deepEqual(revision.plan.nodes.find(node => node.id === 'b').dependsOn, ['a']);
  const child = leaf('tool', { derivedFrom: 'source', ...needs('upstream') });
  assert.equal(prepare([upstream, source], [upstream, { ...source, ...needs('tool') }, child]).revision, 2);
  const independent = leaf('tool', { derivedFrom: 'source' });
  const retained = { ...source, dependsOn: ['upstream', 'tool'], dependencyReasons: [
    { nodeId: 'upstream', reason: 'Consumes the original input.' }, { nodeId: 'tool', reason: 'Consumes the derived tool.' }
  ] };
  assert.equal(prepare([upstream, source], [upstream, retained, independent]).revision, 2);
});

test('derivation preserves every prerequisite across physical revisions and cannot reset attempted budgets', () => {
  const upstream = { ...leaf('upstream@revision-2'), logicalId: 'upstream' };
  const another = leaf('another');
  const source = { ...leaf('source@revision-2'), logicalId: 'source', dependsOn: [upstream.id, 'another'],
    dependencyReasons: [{ nodeId: upstream.id, reason: 'Consumes upstream.' }, { nodeId: 'another', reason: 'Consumes another.' }] };
  const state = [upstream, another, source], requested = { ...goal(state.map(node => node.id)), planRevision: 2 };
  const replacement = split().filter(node => node.id !== 'consumer');
  replacement[0] = { ...replacement[0], ...needs('upstream'), acceptance: source.acceptance };
  const proposed = [leaf('upstream'), another, ...replacement];
  assert.throws(() => preparePlanRevision(requested, state, definition(proposed), 2), { code: 'derivation-prerequisite-loss' });
  replacement[1] = { ...replacement[1], ...needs('another') };
  const complete = [leaf('upstream'), another, ...replacement];
  assert.equal(preparePlanRevision(requested, state, definition(complete), 2).revision, 3);
  const history = [...state, { ...leaf('source'), status: 'failed', runIds: ['prior-attempt'] }];
  assert.throws(() => preparePlanRevision(requested, history, definition(complete), 2), { code: 'derivation-source-started' });
  assert.throws(() => preparePlanRevision(requested, history, definition(complete), 2,
    { enforceDerivationPrerequisites: false }), { code: 'derivation-source-started' });
  const missingChecks = structuredClone(complete); missingChecks.find(node => node.id === 'a').acceptance.checks = ['other'];
  assert.throws(() => preparePlanRevision(requested, state, definition(missingChecks), 2,
    { enforceDerivationPrerequisites: false }), { code: 'derivation-acceptance-loss' });
});

test('new submissions reject lost prerequisites without appending events while saved legacy revisions replay unchanged', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-prerequisite-history-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const app = new FwaApplication(root); await app.init();
  const created = (await app.createGoal({ title: 'Legacy split', commandId: 'goal' })).goal;
  const upstream = leaf('upstream'), source = leaf('source', needs('upstream'));
  await app.loadPlan({ goalId: created.id, plan: definition([upstream, source]), commandId: 'initial' });
  const before = await app.getStatus();
  const proposed = definition([upstream, ...split().filter(node => node.id !== 'consumer')]);
  await assert.rejects(app.revisePlan({ goalId: created.id, plan: proposed, expectedRevision: 1,
    reason: 'Split without preserving the input.', feedbackIds: [], commandId: 'new-invalid-split' }),
  { code: 'derivation-prerequisite-loss' });
  assert.equal((await app.getStatus()).lastSequence, before.lastSequence);
  // Build the exact immutable event batch the former admission rule accepted.
  // This is a historical-format fixture, not a new application submission.
  const oldGoal = before.goals.find(item => item.id === created.id);
  const prepared = preparePlanRevision(oldGoal, before.nodes, proposed, 1, { enforceDerivationPrerequisites: false });
  const revisionId = `${oldGoal.planId}:revision:2`, events = [], commandId = 'legacy-split';
  const add = (type, streamId, streamVersion, payload) => events.push(createEvent({ type, streamId,
    sequence: before.lastSequence + events.length + 1, correlationId: commandId, metadata: { streamVersion }, payload }));
  add('PlanRevised', `goal:${created.id}`, oldGoal.version + 1, { goalId: created.id, planId: oldGoal.planId,
    revisionId, expectedRevision: 1, revision: 2, plan: prepared.plan, bindings: prepared.bindings,
    retiredNodes: prepared.retiredNodes, reason: 'Saved by the former planner.', feedbackIds: [] });
  for (const retired of prepared.retiredNodes) add('NodeSuperseded', `node:${retired.nodeId}`,
    before.nodes.find(node => node.id === retired.nodeId).version + 1, { ...retired, goalId: created.id, revisionId });
  for (const entry of prepared.createdNodes) {
    add('NodePlanned', `node:${entry.node.id}`, 1, { goalId: created.id, planId: oldGoal.planId, ...entry });
    assert.deepEqual(entry.node.dependsOn, []);
    add('NodeReady', `node:${entry.node.id}`, 2, { goalId: created.id, planId: oldGoal.planId,
      nodeId: entry.node.id, reason: 'dependencies-satisfied' });
  }
  await app.store.appendBatch(commandId, events, { expectedLastSequence: before.lastSequence, intentHash: hashCanonicalValue(prepared.plan) });
  const reopened = new FwaApplication(root), status = await reopened.getStatus();
  assert.equal(status.goals.find(item => item.id === created.id).planRevision, 2);
  assert.deepEqual(status.nodes.find(node => node.id === 'source').dependsOn, ['upstream']);
  assert.deepEqual(status.nodes.find(node => node.id === 'a@revision-2').dependsOn, []);
  assert.deepEqual(status.workflow.revisions.at(-1).plan, prepared.plan);
  assert.equal((await reopened.verify()).ok, true);
  assert.equal((await reopened.store.readAll()).lastSequence, before.lastSequence + events.length, 'Reading old history never migrates or rewrites it.');
});

test('derivation preserves evaluator and command obligations and counts prior children across revisions', () => {
  const nodes = initial(); nodes[0].acceptance.commands = ['trusted-command']; nodes[0].acceptance.evaluators = ['independent-review'];
  assert.throws(() => prepare(nodes, split()), { code: 'derivation-acceptance-loss' });
  const proposed = split(); Object.assign(proposed[1].acceptance, { commands: ['trusted-command'], evaluators: ['independent-review'] });
  assert.equal(prepare(nodes, proposed).revision, 2);
  const source = leaf('source'), previous = leaf('old-child', { derivedFrom: 'source' });
  const duplicate = leaf('new-child', { derivedFrom: 'source', outcome: previous.outcome });
  assert.throws(() => preparePlanRevision(goal(['source']), [source, previous], definition([
    { ...source, ...needs('new-child') }, duplicate
  ]), 1), { code: 'derivation-duplicate-outcome' });
  const children = Array.from({ length: 8 }, (_, index) => leaf(`old-${index}`, { derivedFrom: 'source' }));
  assert.throws(() => preparePlanRevision(goal(['source']), [source, ...children], definition([
    { ...source, ...needs('new-child') }, duplicate
  ]), 1), { code: 'derivation-child-limit' });
});

test('derivation cannot reset attempted work budgets across physical revisions; legacy authored revision remains supported', () => {
  const nodes = initial(); nodes[0].runIds = ['run-1']; nodes[0].status = 'failed';
  assert.throws(() => prepare(nodes, split()), { code: 'derivation-source-started' });
  const currentSource = { ...leaf('source@revision-2'), logicalId: 'source', runIds: [] };
  const consumer = leaf('consumer', needs('source@revision-2'));
  const history = [currentSource, consumer, { ...leaf('source'), runIds: ['earlier-run'] }];
  assert.throws(() => preparePlanRevision({ ...goal([currentSource.id, 'consumer']), planRevision: 2 }, history, definition(split()), 2), { code: 'derivation-source-started' });
  const authored = split().map(node => { const copy = { ...node }; delete copy.derivedFrom; return copy; });
  assert.equal(prepare(nodes, authored).revision, 2);
});

test('meaning and derivation survive application persistence and event replay without changing legacy history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-meaning-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const app = new FwaApplication(root); await app.init();
  const created = (await app.createGoal({ title: 'Split a result', commandId: 'goal' })).goal;
  await app.loadPlan({ goalId: created.id, plan: definition(initial()), commandId: 'initial' });
  await app.revisePlan({ goalId: created.id, plan: definition(split()), expectedRevision: 1, reason: 'Separate independent outputs before work starts.', feedbackIds: [], commandId: 'split' });
  const reopened = new FwaApplication(root), status = await reopened.getStatus();
  assert.equal(status.nodes.find(node => node.id === 'source').outcome, 'User can use source.');
  const consumer = status.nodes.find(node => node.logicalId === 'consumer' && node.id !== 'consumer');
  assert.equal(consumer.dependencyReasons[0].nodeId, 'a@revision-2');
  assert.equal(status.nodes.find(node => node.id === 'a@revision-2').derivedFrom, 'source');
  assert.equal((await reopened.verify()).ok, true);
});
