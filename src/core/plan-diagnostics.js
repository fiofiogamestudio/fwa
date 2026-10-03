import { validatePlan } from './dag.js';
import { normalizeEffectPattern } from './effects.js';
import { findParallelConflicts } from './scheduling.js';

const MAX_EFFECTS_PER_KIND = 32;
const clip = value => String(value).slice(0, 240);
const list = value => Array.isArray(value) ? value : [];
const dependencies = node => node.dependsOn ?? node.depends_on;
const acceptance = node => node.acceptance ?? node.acceptanceContract ?? node.acceptance_contract;

function boundedInteger(value, fallback, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return result;
}

// A broad declaration is not automatically wrong. Also flag a deeper recursive
// subtree when multiple leaves claim it, as with a shared tests/** write set.
function isBroadWrite(pattern, ownerCount) {
  const prefix = pattern.split(/[*?]/u, 1)[0].replace(/\/$/u, '');
  return pattern.includes('**') && (ownerCount > 1 || prefix.split('/').filter(Boolean).length <= 1);
}

/**
 * Read-only, bounded planning advice. Dependency waves assume instantaneous
 * success and ignore executor availability, Ref resolution and runtime state.
 * Warnings never authorize parallel execution or invalidate a legal plan.
 */
export function diagnosePlan(plan, options = {}) {
  const maxExamples = boundedInteger(options.maxExamples, 12, 32, 'maxExamples');
  const maxConflictPairs = boundedInteger(options.maxConflictPairs, 1000, 5000, 'maxConflictPairs');
  const longChainThreshold = boundedInteger(options.longChainThreshold, 8, 1000, 'longChainThreshold');
  const validation = validatePlan(plan);
  const nodes = list(plan?.nodes);
  const findings = [];
  const report = {
    schemaVersion: 1,
    advisory: true,
    valid: validation.ok,
    scope: 'Static authored-plan advice; dependency waves are not permission or a promise to run in parallel.',
    validation: {
      errorCount: validation.errors.length,
      errors: validation.errors.slice(0, maxExamples).map(error => ({
        code: error.code, path: clip(error.path), message: clip(error.message)
      })),
      omittedErrorCount: Math.max(0, validation.errors.length - maxExamples)
    },
    metrics: {
      nodeCount: nodes.length,
      groupCount: list(plan?.groups).length,
      dependencyCount: nodes.reduce((sum, node) => sum + list(node && dependencies(node)).length, 0),
      checkReferenceCount: 0,
      uniqueCheckCount: 0,
      acceptanceReferenceCount: 0,
      uniqueAcceptanceReferenceCount: 0,
      externalAcceptanceContractCount: 0,
      missingAcceptanceNodeCount: 0
    },
    longestDependencyChain: null,
    theoreticalReadyBatches: null,
    conflicts: null,
    findings
  };
  const checkIds = new Set();
  const acceptanceIds = new Set();
  for (const node of nodes) {
    const contract = node && acceptance(node);
    if (typeof contract === 'string' && contract.trim()) {
      report.metrics.externalAcceptanceContractCount += 1;
      report.metrics.acceptanceReferenceCount += 1;
      acceptanceIds.add(`contract:${contract}`);
      continue;
    }
    let references = 0;
    for (const kind of ['checks', 'commands', 'evaluators']) {
      for (const id of list(contract?.[kind]).filter(item => typeof item === 'string' && item.trim())) {
        references += 1;
        report.metrics.acceptanceReferenceCount += 1;
        acceptanceIds.add(`${kind}:${id}`);
        if (kind === 'checks') {
          report.metrics.checkReferenceCount += 1;
          checkIds.add(id);
        }
      }
    }
    if (references === 0) report.metrics.missingAcceptanceNodeCount += 1;
  }
  report.metrics.uniqueCheckCount = checkIds.size;
  report.metrics.uniqueAcceptanceReferenceCount = acceptanceIds.size;
  if (!validation.ok) {
    findings.push({ code: 'INVALID_PLAN', severity: 'error',
      message: 'The existing plan schema rejected this plan. Fix the listed errors before interpreting dependency or conflict metrics.' });
    return report;
  }

  const byId = new Map(nodes.map(node => [node.id, node]));
  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const remaining = new Map(nodes.map(node => [node.id, dependencies(node).length]));
  const dependents = new Map(nodes.map(node => [node.id, []]));
  for (const node of nodes) for (const id of dependencies(node)) dependents.get(id).push(node.id);
  const depth = new Map();
  const predecessor = new Map();
  const waves = [];
  let frontier = nodes.filter(node => remaining.get(node.id) === 0).map(node => node.id);
  while (frontier.length) {
    waves.push(frontier);
    const next = [];
    for (const id of frontier) {
      let previous = null;
      for (const dependencyId of dependencies(byId.get(id))) {
        if (previous === null || depth.get(dependencyId) > depth.get(previous)) previous = dependencyId;
      }
      predecessor.set(id, previous);
      depth.set(id, previous === null ? 1 : depth.get(previous) + 1);
      for (const child of dependents.get(id)) {
        remaining.set(child, remaining.get(child) - 1);
        if (remaining.get(child) === 0) next.push(child);
      }
    }
    frontier = next.sort((left, right) => index.get(left) - index.get(right));
  }
  let last = nodes[0].id;
  for (const node of nodes) if (depth.get(node.id) > depth.get(last)) last = node.id;
  const chain = [];
  for (let id = last; id !== null; id = predecessor.get(id)) chain.push(id);
  chain.reverse();
  report.metrics.longestDependencyChainLength = chain.length;
  report.metrics.theoreticalBatchCount = waves.length;
  report.metrics.maxTheoreticalBatchWidth = Math.max(...waves.map(wave => wave.length));
  report.longestDependencyChain = {
    nodeIds: chain.slice(0, maxExamples).map(clip),
    omittedNodeCount: Math.max(0, chain.length - maxExamples)
  };
  report.theoreticalReadyBatches = {
    batches: waves.slice(0, maxExamples).map((wave, batchIndex) => ({
      index: batchIndex + 1, nodeCount: wave.length,
      nodeIds: wave.slice(0, maxExamples).map(clip),
      omittedNodeCount: Math.max(0, wave.length - maxExamples)
    })),
    omittedBatchCount: Math.max(0, waves.length - maxExamples)
  };
  if (chain.length >= longChainThreshold) findings.push({ code: 'LONG_DEPENDENCY_CHAIN', severity: 'warning',
    message: `${chain.length} leaves lie on the longest dependency chain. Review whether every dependency needs an integrated predecessor; legitimate sequential plans remain valid.` });

  const broadWrites = [];
  let broadWriteCount = 0;
  let unresolvedEffectCount = 0;
  let omittedEffectCount = 0;
  const candidates = nodes.map(node => {
    const candidate = { nodeId: node.id };
    for (const kind of ['reads', 'writes', 'resources']) {
      const values = list(node[kind]);
      omittedEffectCount += Math.max(0, values.length - MAX_EFFECTS_PER_KIND);
      candidate[kind] = [];
      for (const value of values.slice(0, MAX_EFFECTS_PER_KIND)) {
        try {
          const normalized = kind === 'resources' ? value : normalizeEffectPattern(value);
          candidate[kind].push(normalized);
        } catch {
          // Logical Refs need an adapter mapping, and malformed workspace paths
          // need effects validation. Neither can safely be called conflict-free.
          unresolvedEffectCount += 1;
        }
      }
    }
    return candidate;
  });
  const writeOwners = new Map();
  const patternKey = pattern => options.ignoreCase === true ? pattern.toLowerCase() : pattern;
  for (const candidate of candidates) for (const pattern of new Set(candidate.writes.map(patternKey))) {
    writeOwners.set(pattern, (writeOwners.get(pattern) ?? 0) + 1);
  }
  for (const candidate of candidates) for (const pattern of candidate.writes) {
    const ownerCount = writeOwners.get(patternKey(pattern));
    if (isBroadWrite(pattern, ownerCount)) {
      broadWriteCount += 1;
      if (broadWrites.length < maxExamples) broadWrites.push({
        nodeId: clip(candidate.nodeId), pattern: clip(pattern), ownerCount
      });
    }
  }
  const dependsTransitively = (nodeId, prerequisiteId) => {
    const pending = [...dependencies(byId.get(nodeId))];
    const visited = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === prerequisiteId) return true;
      if (!visited.has(id)) {
        visited.add(id);
        pending.push(...dependencies(byId.get(id)));
      }
    }
    return false;
  };
  const conflicts = {
    scope: 'Declared workspace paths and resources; conservative findParallelConflicts semantics, before runtime Ref resolution.',
    totalPairCount: nodes.length * (nodes.length - 1) / 2,
    checkedPairCount: 0,
    conflictPairCount: 0,
    potentialParallelConflictPairCount: 0,
    resourceConflictPairCount: 0,
    unresolvedEffectCount,
    omittedEffectCount,
    broadWriteCount,
    broadWriteExamples: broadWrites,
    omittedBroadWriteCount: Math.max(0, broadWriteCount - broadWrites.length),
    examples: []
  };
  for (let leftIndex = 0; leftIndex < candidates.length && conflicts.checkedPairCount < maxConflictPairs; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length && conflicts.checkedPairCount < maxConflictPairs; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      conflicts.checkedPairCount += 1;
      const matches = findParallelConflicts([left, right], { ignoreCase: options.ignoreCase === true });
      if (!matches.length) continue;
      conflicts.conflictPairCount += 1;
      const dependencyOrdered = dependsTransitively(left.nodeId, right.nodeId) || dependsTransitively(right.nodeId, left.nodeId);
      if (!dependencyOrdered) conflicts.potentialParallelConflictPairCount += 1;
      if (matches.some(match => match.kind === 'resource')) conflicts.resourceConflictPairCount += 1;
      if (conflicts.examples.length < maxExamples) conflicts.examples.push({
        leftNodeId: clip(left.nodeId), rightNodeId: clip(right.nodeId), dependencyOrdered,
        kinds: [...new Set(matches.map(match => match.kind))],
        sample: { kind: matches[0].kind, left: clip(matches[0].left), right: clip(matches[0].right) }
      });
    }
  }
  conflicts.omittedPairCount = conflicts.totalPairCount - conflicts.checkedPairCount;
  conflicts.omittedExampleCount = Math.max(0, conflicts.conflictPairCount - conflicts.examples.length);
  conflicts.complete = conflicts.omittedPairCount === 0 && unresolvedEffectCount === 0 && omittedEffectCount === 0;
  report.conflicts = conflicts;
  if (conflicts.conflictPairCount) findings.push({ code: 'DECLARED_EFFECT_CONFLICTS', severity: 'warning',
    message: `${conflicts.conflictPairCount} inspected leaf pairs share conflicting effects; ${conflicts.potentialParallelConflictPairCount} of these pairs have no dependency ordering. These counts are planning advice, not runtime scheduling decisions.` });
  if (broadWriteCount) findings.push({ code: 'BROAD_WRITE_DECLARATIONS', severity: 'warning',
    message: `${broadWriteCount} inspected write declarations recursively cover the workspace, a top-level subtree or a subtree claimed by multiple leaves. Review ownership before expanding concurrency.` });
  if (!conflicts.complete) findings.push({ code: 'CONFLICT_ANALYSIS_INCOMPLETE', severity: 'info',
    message: 'Conflict analysis is bounded or contains unresolved effects. Reported conflicts are a lower bound; omitted pairs, effects or Ref mappings may add conflicts.' });
  findings.push({ code: 'ACCEPTANCE_DECLARATIONS_ONLY', severity: 'info',
    message: `The schema requires an acceptance declaration for every leaf. ${report.metrics.checkReferenceCount} check references name ${checkIds.size} unique checks; these counts do not prove that checks exist, ran or passed.` });
  return report;
}
