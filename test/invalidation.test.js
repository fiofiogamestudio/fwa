import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeDependencyInvalidation,
  computeInvalidation
} from '../src/core/invalidation.js';

const nodes = [
  { id: 'A', dependsOn: [], reads: [] },
  { id: 'B', dependsOn: ['A'], reads: ['ref://code/y'] },
  { id: 'C', dependsOn: ['A'], reads: ['ref://code/x'] },
  { id: 'D', dependsOn: ['C'], reads: [] },
  { id: 'E', dependsOn: [], reads: ['ref://code/z'] }
];

test('Ref invalidation reaches only direct consumers and their dependants', () => {
  assert.deepEqual(computeInvalidation(nodes, ['ref://code/x']), {
    changedRefIds: ['ref://code/x'],
    directConsumerNodeIds: ['C'],
    affectedNodeIds: ['C', 'D'],
    recomputeRootNodeIds: ['C']
  });
  assert.deepEqual(computeInvalidation(nodes, ['ref://code/y']), {
    changedRefIds: ['ref://code/y'],
    directConsumerNodeIds: ['B'],
    affectedNodeIds: ['B'],
    recomputeRootNodeIds: ['B']
  });
});

test('dependency fallback is conservative and leaves independent branches untouched', () => {
  assert.deepEqual(computeDependencyInvalidation(nodes, ['A']), {
    sourceNodeIds: ['A'],
    affectedNodeIds: ['B', 'C', 'D'],
    recomputeRootNodeIds: ['B', 'C']
  });
});
