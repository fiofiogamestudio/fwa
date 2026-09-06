import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PlanValidationError,
  assertValidPlan,
  getReadyNodeIds,
  topologicalSort,
  validatePlan
} from '../src/core/dag.js';

function node(id, overrides = {}) {
  return {
    id,
    dependsOn: [],
    reads: [],
    writes: [`ref://output/${id}`],
    capabilities: ['code_edit'],
    acceptance: { commands: ['npm test'] },
    budget: {
      maxRetries: 2,
      maxFiles: 8,
      maxDiffLines: 500
    },
    ...overrides
  };
}

test('validates and orders a manual DAG deterministically', () => {
  const plan = {
    id: 'P-1',
    nodes: [
      node('A'),
      node('B', { dependsOn: ['A'] }),
      node('C', { dependsOn: ['A'] }),
      node('D', { dependsOn: ['B', 'C'] })
    ]
  };

  assert.deepEqual(validatePlan(plan), { ok: true, errors: [] });
  assert.equal(assertValidPlan(plan), plan);
  assert.deepEqual(topologicalSort(plan), ['A', 'B', 'C', 'D']);
});

test('accepts architecture-document snake_case aliases', () => {
  const plan = {
    goal_id: 'G-001',
    nodes: [{
      id: 'N-104',
      depends_on: [],
      reads: ['ref://code/inventory-core'],
      writes: ['ref://code/inventory-ui'],
      requires: ['code_edit', 'shell'],
      acceptance_contract: 'AC-104',
      budget: {
        max_retries: 3,
        max_files: 8,
        max_diff_lines: 1000,
        wall_time_minutes: 20
      }
    }]
  };

  assert.equal(validatePlan(plan).ok, true);
  assert.deepEqual(topologicalSort(plan), ['N-104']);
});

test('rejects duplicate, missing, and self dependencies', () => {
  const plan = {
    nodes: [
      node('A', { dependsOn: ['A', 'missing'] }),
      node('A')
    ]
  };
  const result = validatePlan(plan);
  const codes = new Set(result.errors.map((error) => error.code));

  assert.equal(result.ok, false);
  assert.equal(codes.has('DUPLICATE_NODE_ID'), true);
  assert.equal(codes.has('SELF_DEPENDENCY'), true);
  assert.equal(codes.has('MISSING_DEPENDENCY'), true);
  assert.throws(() => assertValidPlan(plan), PlanValidationError);
});

test('rejects dependency cycles with the concrete cycle in evidence', () => {
  const plan = {
    nodes: [
      node('A', { dependsOn: ['C'] }),
      node('B', { dependsOn: ['A'] }),
      node('C', { dependsOn: ['B'] })
    ]
  };
  const result = validatePlan(plan);
  const cycleError = result.errors.find((error) => error.code === 'CYCLE_DETECTED');

  assert.equal(result.ok, false);
  assert.deepEqual(cycleError.details.cycle, ['A', 'C', 'B', 'A']);
});

test('validates effects, capabilities, acceptance, and budgets', () => {
  const plan = {
    nodes: [node('A', {
      reads: 'src/**',
      writes: ['', 'src/a.js', 'src/a.js'],
      capabilities: ['code_edit', 'network'],
      acceptance: {},
      budget: {
        maxRetries: -1,
        maxFiles: 0,
        maxDiffLines: 1.5,
        tokenBudget: 0
      }
    })]
  };
  const result = validatePlan(plan, {
    availableCapabilities: ['code_edit']
  });
  const codes = new Set(result.errors.map((error) => error.code));

  assert.equal(result.ok, false);
  assert.equal(codes.has('INVALID_LIST'), true);
  assert.equal(codes.has('INVALID_LIST_ITEM'), true);
  assert.equal(codes.has('DUPLICATE_LIST_ITEM'), true);
  assert.equal(codes.has('UNAVAILABLE_CAPABILITY'), true);
  assert.equal(codes.has('INVALID_ACCEPTANCE'), true);
  assert.equal(codes.has('INVALID_BUDGET_LIMIT'), true);
});

test('rejects ambiguous aliases instead of silently choosing one', () => {
  const plan = {
    goalId: 'G-1',
    goal_id: 'G-2',
    nodes: [node('A', {
      depends_on: [],
      requires: ['shell'],
      acceptance_contract: 'AC-1'
    })]
  };
  const result = validatePlan(plan);

  assert.equal(result.ok, false);
  assert.equal(
    result.errors.filter((error) => error.code === 'AMBIGUOUS_FIELD').length,
    4
  );
});

test('inline acceptance rejects empty and misspelled evaluator contracts', () => {
  const result = validatePlan({
    nodes: [node('A', { acceptance: { typo: ['looks-valid'] } })]
  });
  const codes = new Set(result.errors.map((error) => error.code));

  assert.equal(result.ok, false);
  assert.equal(codes.has('EMPTY_ACCEPTANCE'), true);
  assert.equal(codes.has('UNKNOWN_ACCEPTANCE_FIELD'), true);
});

test('budgets reject unsafe numbers and schema-v1 hard-limit bypasses', () => {
  const unsafe = validatePlan({
    nodes: [node('A', {
      budget: {
        maxRetries: 1e100,
        maxFiles: Number.MAX_SAFE_INTEGER + 1,
        maxDiffLines: 10_000_001,
        tokenBudget: 100_000_001
      }
    })]
  });
  const codes = unsafe.errors.map((error) => error.code);

  assert.equal(unsafe.ok, false);
  assert.equal(codes.filter((code) => code === 'INVALID_BUDGET_LIMIT').length, 2);
  assert.equal(codes.filter((code) => code === 'BUDGET_LIMIT_EXCEEDED').length, 2);
});

test('resolves ready nodes by completed and unavailable sets', () => {
  const plan = {
    nodes: [
      node('A'),
      node('B', { dependsOn: ['A'] }),
      node('C', { dependsOn: ['A'] }),
      node('D', { dependsOn: ['B', 'C'] })
    ]
  };

  assert.deepEqual(getReadyNodeIds(plan), ['A']);
  assert.deepEqual(getReadyNodeIds(plan, ['A']), ['B', 'C']);
  assert.deepEqual(getReadyNodeIds(plan, ['A'], ['B']), ['C']);
  assert.deepEqual(getReadyNodeIds(plan, ['A', 'B', 'C']), ['D']);
  assert.throws(() => getReadyNodeIds(plan, ['unknown']), RangeError);
});
