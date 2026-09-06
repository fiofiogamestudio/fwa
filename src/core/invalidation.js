import { isRefId } from './refs.js';

function assertNodes(nodes) {
  if (!Array.isArray(nodes)) throw new TypeError('nodes must be an array.');
  const byId = new Map();
  for (const node of nodes) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw new TypeError('nodes must contain objects.');
    }
    if (typeof node.id !== 'string' || node.id.trim() === '' || byId.has(node.id)) {
      throw new TypeError('nodes must have unique, non-empty ids.');
    }
    if (!Array.isArray(node.dependsOn) || !Array.isArray(node.reads)) {
      throw new TypeError(`node ${node.id} must have dependsOn and reads arrays.`);
    }
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dependencyId of node.dependsOn) {
      if (!byId.has(dependencyId)) {
        throw new RangeError(`node ${node.id} depends on unknown node ${dependencyId}.`);
      }
    }
  }
  return byId;
}

function assertChangedRefs(changedRefIds) {
  if (typeof changedRefIds === 'string'
    || changedRefIds?.[Symbol.iterator] === undefined) {
    throw new TypeError('changedRefIds must be an iterable of Ref ids.');
  }
  const result = new Set();
  for (const refId of changedRefIds) {
    if (!isRefId(refId)) throw new TypeError(`Invalid changed Ref id: ${String(refId)}.`);
    result.add(refId);
  }
  return result;
}

/**
 * Return the smallest conservative invalidation closure for a set of changed
 * logical Refs: direct consumers plus their transitive DAG dependants.
 */
export function computeInvalidation(nodes, changedRefIds, options = {}) {
  const byId = assertNodes(nodes);
  const changed = assertChangedRefs(changedRefIds);
  const excluded = new Set(options.excludeNodeIds ?? []);
  for (const nodeId of excluded) {
    if (!byId.has(nodeId)) throw new RangeError(`Unknown excluded node ${nodeId}.`);
  }

  const direct = nodes
    .filter((node) => !excluded.has(node.id))
    .filter((node) => node.reads.some((refId) => isRefId(refId) && changed.has(refId)))
    .map((node) => node.id);
  const affected = new Set(direct);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of nodes) {
      if (excluded.has(node.id) || affected.has(node.id)) continue;
      if (node.dependsOn.some((dependencyId) => affected.has(dependencyId))) {
        affected.add(node.id);
        progressed = true;
      }
    }
  }

  const roots = direct.filter((nodeId) => {
    const node = byId.get(nodeId);
    return !node.dependsOn.some((dependencyId) => affected.has(dependencyId));
  });
  return Object.freeze({
    changedRefIds: Object.freeze([...changed].sort()),
    directConsumerNodeIds: Object.freeze([...direct].sort()),
    affectedNodeIds: Object.freeze([...affected].sort()),
    recomputeRootNodeIds: Object.freeze([...new Set(roots)].sort())
  });
}

/** Conservative fallback used by revert when a legacy plan has no logical Refs. */
export function computeDependencyInvalidation(nodes, sourceNodeIds) {
  const byId = assertNodes(nodes);
  if (typeof sourceNodeIds === 'string'
    || sourceNodeIds?.[Symbol.iterator] === undefined) {
    throw new TypeError('sourceNodeIds must be an iterable of node ids.');
  }
  const sources = new Set(sourceNodeIds);
  for (const nodeId of sources) {
    if (!byId.has(nodeId)) throw new RangeError(`Unknown source node ${nodeId}.`);
  }
  const affected = new Set();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of nodes) {
      if (sources.has(node.id) || affected.has(node.id)) continue;
      if (node.dependsOn.some((dependencyId) => (
        sources.has(dependencyId) || affected.has(dependencyId)
      ))) {
        affected.add(node.id);
        progressed = true;
      }
    }
  }
  return Object.freeze({
    sourceNodeIds: Object.freeze([...sources].sort()),
    affectedNodeIds: Object.freeze([...affected].sort()),
    recomputeRootNodeIds: Object.freeze(nodes
      .filter((node) => affected.has(node.id))
      .filter((node) => !node.dependsOn.some((dependencyId) => affected.has(dependencyId)))
      .map((node) => node.id)
      .sort())
  });
}
