import { GoalStatus, IntegrationStatus, NodeStatus, Validity } from './state-machines.js';

// Readiness is a cached notification, never permission to ignore current dependencies.
export function areNodeDependenciesSatisfied(node, nodes, goal) {
  const byId = nodes instanceof Map ? nodes : new Map(nodes.map((item) => [item.id, item]));
  return Array.isArray(node.dependsOn) && node.dependsOn.every((id) => {
    const dependency = byId.get(id);
    return dependency?.status === NodeStatus.ACCEPTED
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

export function hasActiveProjectOperation({ runs, evaluations, integrations, reversions }) {
  return [...runs].some((item) => ['pending', 'running', 'paused'].includes(item.status)
      || isUnfencedGitProcessFailure(item.failure))
    || [...evaluations].some((item) => ['requested', 'running', 'recovery-required'].includes(item.status))
    || [...integrations].some((item) => ['pending', 'running', 'recovery-required'].includes(item.status))
    || [...reversions].some((item) => ['pending', 'running', 'recovery-required'].includes(item.status));
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
