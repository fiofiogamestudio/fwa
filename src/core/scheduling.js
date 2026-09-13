import { GoalStatus, IntegrationStatus, NodeStatus, Validity } from './state-machines.js';
import { normalizeEffectPattern } from './effects.js';

// Readiness is a cached notification, never permission to ignore current dependencies.
export function areNodeDependenciesSatisfied(node, nodes, goal) {
  if (node.supersededByRevision != null) return false;
  const byId = nodes instanceof Map ? nodes : new Map(nodes.map((item) => [item.id, item]));
  return Array.isArray(node.dependsOn) && node.dependsOn.every((id) => {
    const dependency = byId.get(id);
    return dependency?.supersededByRevision == null && dependency?.status === NodeStatus.ACCEPTED
      && dependency.validity === Validity.VALID
      && dependency.integrationStatus === IntegrationStatus.INTEGRATED
      && typeof dependency.acceptedChangeSetId === 'string'
      && dependency.acceptedChangeSetId.length > 0
      && dependency.integratedChangeSetId === dependency.acceptedChangeSetId
      && goal?.integrationTargetRef != null
      && dependency.integratedTargetRef === goal.integrationTargetRef;
  });
}

export function isNodeSchedulable(node, nodes, goal) {
  return node.status === NodeStatus.READY
    && node.validity === Validity.VALID
    && [GoalStatus.PLANNED, GoalStatus.ACTIVE].includes(goal?.status)
    && areNodeDependenciesSatisfied(node, nodes, goal);
}

export function nodeRetryEligibility(node, nodes, goal) {
  if (!node) return { ok: false, code: 'node-not-found' };
  if (node.supersededByRevision != null) return { ok: false, code: 'node-superseded' };
  if (![GoalStatus.PLANNED, GoalStatus.ACTIVE].includes(goal?.status)) {
    return { ok: false, code: 'goal-not-runnable' };
  }
  const recompute = [Validity.STALE, Validity.INVALID].includes(node.validity)
    && [NodeStatus.PRODUCED, NodeStatus.ACCEPTED].includes(node.status);
  const retry = node.status === NodeStatus.REJECTED && node.validity === Validity.VALID;
  if (!recompute && !retry) return { ok: false, code: 'node-not-retryable' };
  if (node.runIds.length === 0 || node.runIds.length > node.budget.maxRetries) {
    return { ok: false, code: 'node-retry-budget-exhausted' };
  }
  if (!areNodeDependenciesSatisfied(node, nodes, goal)) {
    return { ok: false, code: 'node-dependencies-unsatisfied' };
  }
  return { ok: true, mode: recompute ? 'recompute' : 'retry' };
}

export function hasActiveProjectOperation({ runs, evaluations, integrations, reversions, runBatches = [] }) {
  return [...runBatches].some((item) => item.status === 'running')
    || [...runs].some((item) => ['pending', 'running', 'paused'].includes(item.status)
      || isUnfencedGitProcessFailure(item.failure))
    || [...evaluations].some((item) => ['requested', 'running', 'recovery-required'].includes(item.status))
    || [...integrations].some((item) => ['pending', 'running', 'recovery-required'].includes(item.status))
    || [...reversions].some((item) => ['pending', 'running', 'recovery-required'].includes(item.status));
}

// Conservative by design: intersecting literal prefixes of globs are deferred,
// even if a more expensive glob solver might prove them disjoint. Declarations
// describe trusted executor effects; this is not an OS process sandbox.
function patternsMayOverlap(left, right, ignoreCase) {
  const normalize = (value) => {
    const normalized = normalizeEffectPattern(value);
    return ignoreCase ? normalized.toLowerCase() : normalized;
  };
  const a = normalize(left);
  const b = normalize(right);
  const prefix = (value) => value.split(/[*?]/u, 1)[0];
  if (/[*?]/u.test(a) || /[*?]/u.test(b)) {
    const x = prefix(a);
    const y = prefix(b);
    return x.startsWith(y) || y.startsWith(x)
      || x.replace(/\/$/u, '') === y.replace(/\/$/u, '');
  }
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function findParallelConflicts(candidates, { ignoreCase = false } = {}) {
  const conflicts = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      const add = (kind, left, right) => conflicts.push({
        leftNodeId: a.nodeId, rightNodeId: b.nodeId, kind, left, right
      });
      for (const [lefts, rights, kind] of [
        [a.writes, b.writes, 'write-write'],
        [a.writes, b.reads, 'write-read'],
        [a.reads, b.writes, 'read-write']
      ]) {
        for (const left of lefts ?? []) for (const right of rights ?? []) {
          if (patternsMayOverlap(left, right, ignoreCase)) add(kind, left, right);
        }
      }
      for (const left of a.resources ?? []) for (const right of b.resources ?? []) {
        if (left.toLowerCase() === right.toLowerCase()) add('resource', left, right);
      }
    }
  }
  return conflicts;
}

export function isUnfencedGitProcessFailure(failure) {
  return failure?.code === 'git-process-termination-unconfirmed'
    && failure.details?.fencePersisted === false;
}

export function nodeHasUnsettledWorkspace(node, { runs, evaluations, integrations, reversions }) {
  return [...runs].some((item) => item.nodeId === node.id && item.status === 'produced'
      && item.workspaceStatus !== 'removed')
    || [...evaluations].some((item) => item.nodeId === node.id && item.workspaceStatus !== 'removed')
    || [...integrations, ...reversions].some((item) => item.nodeId === node.id
      && item.regressionEvidence != null
      && item.regressionEvidence.cleanup.status !== 'succeeded');
}
