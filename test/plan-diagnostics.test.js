import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { diagnosePlan } from '../src/core/plan-diagnostics.js';

const leaf = (id, fields = {}) => ({
  id, dependsOn: [], reads: [], writes: [`${id}/result.txt`], capabilities: ['code-edit'],
  acceptance: { checks: ['compile', `${id}-behavior`] },
  budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 }, ...fields
});

test('dependency waves and the longest chain describe topology without changing a legal plan', () => {
  const plan = { nodes: [leaf('finish', { dependsOn: ['left', 'right'] }), leaf('right', { dependsOn: ['start'] }),
    leaf('start'), leaf('left', { dependsOn: ['start'] })] };
  const before = JSON.stringify(plan);
  const report = diagnosePlan(plan, { longChainThreshold: 3 });
  assert.equal(report.valid, true);
  assert.equal(report.advisory, true);
  assert.equal(report.metrics.longestDependencyChainLength, 3);
  assert.equal(report.metrics.theoreticalBatchCount, 3);
  assert.equal(report.metrics.maxTheoreticalBatchWidth, 2);
  assert.deepEqual(report.theoreticalReadyBatches.batches.map(batch => batch.nodeIds), [['start'], ['right', 'left'], ['finish']]);
  assert.deepEqual(report.longestDependencyChain.nodeIds, ['start', 'left', 'finish']);
  assert.equal(report.metrics.checkReferenceCount, 8);
  assert.equal(report.metrics.uniqueCheckCount, 5);
  assert.ok(report.findings.some(finding => finding.code === 'LONG_DEPENDENCY_CHAIN'));
  assert.match(report.scope, /not permission/u);
  assert.equal(JSON.stringify(plan), before);
});

test('conflicts distinguish ordered shared writes from potentially parallel resource and path collisions', () => {
  const plan = { nodes: [leaf('source', { writes: ['src/**'], resources: ['Godot'] }),
    leaf('dependent', { dependsOn: ['source'], writes: ['src/result.gd'] }),
    leaf('independent', { reads: ['SRC/input.gd'], resources: ['godot'] })] };
  const report = diagnosePlan(plan, { ignoreCase: true });
  assert.equal(report.conflicts.complete, true);
  assert.equal(report.conflicts.conflictPairCount, 2);
  assert.equal(report.conflicts.potentialParallelConflictPairCount, 1);
  assert.equal(report.conflicts.resourceConflictPairCount, 1);
  assert.equal(report.conflicts.broadWriteCount, 1);
  assert.equal(report.conflicts.examples.find(pair => pair.rightNodeId === 'dependent').dependencyOrdered, true);
  const independent = report.conflicts.examples.find(pair => pair.rightNodeId === 'independent');
  assert.deepEqual(independent.kinds, ['write-read', 'resource']);
  const sharedTests = diagnosePlan({ nodes: [leaf('a', { writes: ['src/tests/v2/**'] }),
    leaf('b', { writes: ['src/tests/v2/**'] })] });
  assert.equal(sharedTests.conflicts.broadWriteCount, 2);
  assert.equal(sharedTests.conflicts.broadWriteExamples[0].ownerCount, 2);
});

test('existing schema rejects missing acceptance and cycles; external contracts remain declarations', () => {
  const missing = diagnosePlan({ nodes: [leaf('broken', { acceptance: {} })] });
  assert.equal(missing.valid, false);
  assert.equal(missing.metrics.missingAcceptanceNodeCount, 1);
  assert.equal(missing.longestDependencyChain, null);
  assert.ok(missing.validation.errors.some(error => error.code === 'INVALID_ACCEPTANCE'));
  const cycle = diagnosePlan({ nodes: [leaf('a', { dependsOn: ['b'] }), leaf('b', { dependsOn: ['a'] })] });
  assert.equal(cycle.valid, false);
  assert.ok(cycle.validation.errors.some(error => error.code === 'CYCLE_DETECTED'));
  const alias = leaf('old', { acceptance: undefined, dependsOn: undefined });
  delete alias.acceptance;
  delete alias.dependsOn;
  alias.depends_on = [];
  alias.acceptance_contract = 'registered-contract';
  const external = diagnosePlan({ nodes: [alias] });
  assert.equal(external.valid, true);
  assert.equal(external.metrics.externalAcceptanceContractCount, 1);
  assert.equal(external.metrics.acceptanceReferenceCount, 1);
  assert.equal(external.metrics.checkReferenceCount, 0);
});

test('unresolved Refs are not advertised as conflict-free and large reports have explicit bounds', () => {
  const refs = diagnosePlan({ nodes: [leaf('a', { writes: ['ref://code/shared'] }), leaf('b', { reads: ['ref://code/shared'] })] });
  assert.equal(refs.valid, true);
  assert.equal(refs.conflicts.complete, false);
  assert.equal(refs.conflicts.unresolvedEffectCount, 2);
  assert.ok(refs.findings.some(finding => finding.code === 'CONFLICT_ANALYSIS_INCOMPLETE'));
  const nodes = Array.from({ length: 100 }, (_, i) => leaf(`n${i}`, { writes: ['src/**'] }));
  const report = diagnosePlan({ nodes }, { maxExamples: 3, maxConflictPairs: 5 });
  assert.equal(report.metrics.maxTheoreticalBatchWidth, 100);
  assert.equal(report.conflicts.totalPairCount, 4950);
  assert.equal(report.conflicts.checkedPairCount, 5);
  assert.equal(report.conflicts.omittedPairCount, 4945);
  assert.equal(report.conflicts.examples.length, 3);
  assert.equal(report.conflicts.complete, false);
  assert.equal(report.theoreticalReadyBatches.batches[0].omittedNodeCount, 97);
  assert.ok(JSON.stringify(report).length < 8000);
  const effects = diagnosePlan({ nodes: [leaf('many', { writes: Array.from({ length: 40 }, (_, i) => `d${i}/**`) })] });
  assert.equal(effects.conflicts.omittedEffectCount, 8);
  assert.equal(effects.conflicts.complete, false);
});

// Optional local read-only regression. No host paths or plan contents are copied
// into the package; regular portable test runs use the fixtures above.
test('real authored plan can be inspected without modification', { skip: !process.env.FWA_DIAGNOSTICS_PLAN }, async () => {
  const source = await readFile(process.env.FWA_DIAGNOSTICS_PLAN, 'utf8');
  const plan = JSON.parse(source);
  const report = diagnosePlan(plan, { ignoreCase: true });
  assert.equal(report.valid, true);
  assert.equal(report.metrics.nodeCount, plan.nodes.length);
  assert.ok(report.metrics.longestDependencyChainLength > 0);
  assert.ok(report.metrics.checkReferenceCount >= report.metrics.uniqueCheckCount);
  assert.equal(await readFile(process.env.FWA_DIAGNOSTICS_PLAN, 'utf8'), source);
});
