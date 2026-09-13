import { assertValidPlan } from './dag.js';
import { stableStringify } from './events.js';
import { isRefId } from './refs.js';

const copy = value => JSON.parse(stableStringify(value));
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };

/** Authored fields only: execution history is never copied into a definition. */
export function nodeDefinition(node, byId = new Map(), logical = false) {
  const result = {
    id: logical ? node.logicalId ?? node.id : node.id,
    dependsOn: node.dependsOn.map(id => logical ? byId.get(id)?.logicalId ?? id : id),
    reads: copy(node.reads), writes: copy(node.writes), capabilities: copy(node.capabilities),
    acceptance: copy(node.acceptance), budget: copy(node.budget)
  };
  for (const field of ['title', 'parentId', 'resources', 'instruction', 'referenceInputs']) {
    if (Object.hasOwn(node, field)) result[field] = copy(node[field]);
  }
  return result;
}

export function currentLogicalPlan(goal, nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const result = { schemaVersion: 1, id: goal.planId, goalId: goal.id,
    nodes: goal.nodeIds.map(id => nodeDefinition(byId.get(id), byId, true)) };
  if (goal.groups?.length) result.groups = copy(goal.groups);
  return result;
}

/** Deterministic, conservative revision preparation; no Git or event writes. */
export function preparePlanRevision(goal, nodes, plan, expectedRevision) {
  if (!goal || goal.planId === null) fail('Load a plan before revising it.', 'plan-not-loaded');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (goal.planRevision ?? 1)) {
    fail('The plan revision changed; refresh before revising.', 'plan-revision-conflict');
  }
  if (!['planned', 'active', 'completed'].includes(goal.status)) fail('This goal cannot be revised.', 'goal-not-revisable');
  assertValidPlan(plan);
  if (plan.schemaVersion !== 1 || Object.hasOwn(plan, 'goal_id')) {
    fail('Revisions must contain a canonical plan snapshot.', 'invalid-plan-revision');
  }
  if ((plan.id !== undefined && plan.id !== goal.planId)
    || (plan.goalId !== undefined && plan.goalId !== goal.id)) fail('Revision targets another plan or goal.', 'plan-goal-mismatch');
  const byId = new Map(nodes.map(node => [node.id, node]));
  const current = new Map(goal.nodeIds.map(id => {
    const node = byId.get(id);
    return [node.logicalId ?? id, node];
  }));
  const desired = new Map(plan.nodes.map(node => [node.id, node]));
  const changed = new Set();
  for (const [id, node] of desired) {
    if (!current.has(id) || stableStringify(nodeDefinition(current.get(id), byId, true)) !== stableStringify(node)) changed.add(id);
  }
  for (const id of current.keys()) if (!desired.has(id)) changed.add(id);
  // Consumers of changed logical outputs are affected even without a DAG edge.
  // This is declaration-based invalidation, not a claim of intercepted reads.
  let progress = true;
  while (progress) {
    progress = false;
    const changedRefs = new Set([...changed].flatMap(id => [
      ...(desired.get(id)?.writes ?? []), ...(current.get(id)?.writes ?? [])
    ]).filter(isRefId));
    for (const [id, node] of desired) {
      if (!changed.has(id) && (node.dependsOn.some(dep => changed.has(dep))
        || node.reads.some(ref => changedRefs.has(ref)))) {
        changed.add(id); progress = true;
      }
    }
  }
  const revision = expectedRevision + 1;
  const bindings = plan.nodes.map(node => {
    const previous = current.get(node.id);
    const created = changed.has(node.id);
    const nodeId = created ? `${node.id}@revision-${revision}` : previous.id;
    if (created && byId.has(nodeId)) fail(`Revision node id already exists: ${nodeId}`, 'node-already-exists');
    return { logicalId: node.id, nodeId, created,
      definitionRevision: created ? (previous?.definitionRevision ?? 0) + 1 : previous.definitionRevision ?? 1,
      supersedesNodeId: created ? previous?.id ?? null : null };
  });
  const mapped = new Map(bindings.map(binding => [binding.logicalId, binding.nodeId]));
  const createdNodes = bindings.filter(binding => binding.created).map(binding => ({
    node: { ...copy(desired.get(binding.logicalId)), id: binding.nodeId,
      dependsOn: desired.get(binding.logicalId).dependsOn.map(id => mapped.get(id)) },
    definition: binding
  }));
  const retiredNodes = [...current].filter(([id]) => !desired.has(id) || changed.has(id))
    .map(([id, node]) => ({ nodeId: node.id, replacementNodeId: mapped.get(id) ?? null }));
  return { revision, bindings, createdNodes, retiredNodes, nodeIds: bindings.map(item => item.nodeId),
    plan: { ...copy(plan), id: goal.planId, goalId: goal.id }, groups: copy(plan.groups ?? []) };
}

function combine(children, started = false) {
  if (children.length && children.every(child => child.phase === 'done')) return 'done';
  if (started || children.some(child => ['work', 'done'].includes(child.phase))) return 'work';
  return children.some(child => child.phase === 'ready') ? 'ready' : 'plan';
}
function mergeFlags(children) {
  return Object.fromEntries(['failed', 'paused', 'pendingFeedback', 'stale', 'blocked']
    .map(key => [key, children.some(child => child.flags[key])]));
}

/** A presentation projection over the same Node/Run facts, never a scheduler. */
export function buildWorkflow(projection) {
  const { goals = [], nodes = [], runs = [], nodeFeedback = [] } = projection;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const trees = goals.map(goal => {
    const childrenByParent = new Map();
    const add = (parentId, item) => {
      const key = parentId ?? null;
      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key).push(item);
    };
    for (const group of goal.groups ?? []) add(group.parentId, { ...copy(group), type: 'group', goalId: goal.id });
    for (const id of goal.nodeIds) {
      const node = byId.get(id);
      if (!node) continue;
      const done = node.status === 'accepted' && node.validity === 'valid'
        && node.integrationStatus === 'integrated' && node.acceptedChangeSetId != null
        && node.integratedChangeSetId === node.acceptedChangeSetId
        && goal.integrationTargetRef != null && node.integratedTargetRef === goal.integrationTargetRef;
      const started = node.runIds?.length > 0 || ['running', 'produced', 'evaluating', 'accepted', 'rejected', 'failed'].includes(node.status);
      const phase = done ? 'done' : started ? 'work' : node.status === 'ready' && node.validity === 'valid' ? 'ready' : 'plan';
      const logicalId = node.logicalId ?? node.id;
      add(node.parentId, { id: node.id, logicalId, definitionRevision: node.definitionRevision ?? 1,
        type: 'node', goalId: goal.id, parentId: node.parentId ?? null, title: node.title ?? logicalId,
        phase, flags: { failed: ['failed', 'rejected'].includes(node.status),
          paused: goal.status === 'paused' || runs.some(run => run.nodeId === node.id && run.status === 'paused'),
          pendingFeedback: nodeFeedback.some(item => item.goalId === goal.id && item.logicalId === logicalId && item.status === 'pending'),
          stale: ['stale', 'invalid'].includes(node.validity), blocked: node.status === 'blocked' }, children: [] });
    }
    const visit = item => {
      if (item.type === 'node') return item;
      const children = (childrenByParent.get(item.id) ?? []).map(visit);
      return { ...item, children, phase: combine(children), flags: mergeFlags(children) };
    };
    const children = (childrenByParent.get(null) ?? []).map(visit);
    return { id: goal.id, title: goal.title, revision: goal.planRevision ?? (goal.planId ? 1 : 0),
      phase: combine(children), flags: { ...mergeFlags(children),
        paused: goal.status === 'paused' || children.some(item => item.flags.paused) }, children };
  });
  return { schemaVersion: 1, goals: trees,
    revisions: copy(goals.flatMap(goal => (goal.planHistory ?? []).map(record => ({ goalId: goal.id, ...record,
      plan: record.plan ?? currentLogicalPlan(goal, nodes) })))),
    feedback: copy(nodeFeedback) };
}
