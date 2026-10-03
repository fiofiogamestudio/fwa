import { assertValidPlan, PLAN_SEMANTIC_LIMITS } from './dag.js';
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
  for (const field of ['title', 'parentId', 'resources', 'instruction', 'referenceInputs', 'outcome', 'derivedFrom']) {
    if (Object.hasOwn(node, field)) result[field] = copy(node[field]);
  }
  if (Object.hasOwn(node, 'dependencyReasons')) result.dependencyReasons = node.dependencyReasons.map(item => ({
    ...item, nodeId: logical ? byId.get(item.nodeId)?.logicalId ?? item.nodeId : item.nodeId
  }));
  return result;
}

const normalizedOutcome = text => text?.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');

/** Structural derivation checks do not prove that an outcome or edge is semantically necessary. */
function validateDerivations(current, desired, history, enforcePrerequisites) {
  const logicalByPhysical = new Map(history.map(node => [node.id, node.logicalId ?? node.id]));
  const childrenBySource = new Map();
  for (const [id, node] of desired) {
    if (current.has(id)) {
      if (node.derivedFrom !== current.get(id).derivedFrom) fail('An existing leaf cannot change its derivation source.', 'derivation-source-changed');
      continue;
    }
    if (node.derivedFrom === undefined) continue; // Legacy explicit authored revisions remain supported.
    const source = current.get(node.derivedFrom);
    if (!source) fail('A new derived leaf must name a current logical source.', 'derivation-source-not-current');
    const sourceHistory = history.filter(item => (item.logicalId ?? item.id) === node.derivedFrom);
    if (sourceHistory.some(item => item.runIds?.length || ['running', 'produced', 'evaluating', 'accepted', 'rejected', 'failed'].includes(item.status))) {
      fail('An attempted result must retain its logical ID and retry budget; revise that leaf instead of deriving new work.', 'derivation-source-started');
    }
    const children = childrenBySource.get(node.derivedFrom) ?? [];
    children.push(node); childrenBySource.set(node.derivedFrom, children);
  }
  const reaches = (id, targets, seen = new Set()) => {
    if (targets.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (desired.get(id)?.dependsOn ?? []).some(dep => reaches(dep, targets, seen));
  };
  for (const [sourceId, children] of childrenBySource) {
    const source = current.get(sourceId), retained = desired.get(sourceId);
    const historicalChildren = new Set(history.filter(item => item.derivedFrom === sourceId).map(item => item.logicalId ?? item.id));
    for (const child of children) historicalChildren.add(child.id);
    if (historicalChildren.size > PLAN_SEMANTIC_LIMITS.derivedChildren || (!retained && children.length < 2)) {
      fail(`A replacement needs 2 to ${PLAN_SEMANTIC_LIMITS.derivedChildren} children; each source has that lifetime child limit.`, 'derivation-child-limit');
    }
    const outcomes = new Set(history.filter(item => item.derivedFrom === sourceId)
      .map(item => normalizedOutcome(item.outcome)).filter(Boolean));
    for (const child of children) {
      const outcome = normalizedOutcome(child.outcome);
      if (!outcome || outcome === normalizedOutcome(source.outcome) || outcomes.has(outcome)) {
        fail('Derived leaves need distinct non-empty outcomes rather than renamed copies of the source.', 'derivation-duplicate-outcome');
      }
      outcomes.add(outcome);
    }
    const replacements = retained ? [retained, ...children] : children;
    if (enforcePrerequisites) {
      for (const dependencyId of source.dependsOn) {
        const logicalId = logicalByPhysical.get(dependencyId) ?? dependencyId;
        const targets = new Set(desired.has(logicalId) ? [logicalId]
          : (childrenBySource.get(logicalId) ?? []).map(child => child.id));
        // Preserve the source's input boundary across the replacement as a whole.
        // A child may consume an input through another child; unrelated children
        // need no synthetic edge to every original prerequisite.
        if (!targets.size || !replacements.some(node => reaches(node.id, targets))) {
          fail('A derivation must preserve a dependency path to every original prerequisite.', 'derivation-prerequisite-loss');
        }
      }
    }
    if (typeof source.acceptance === 'string') {
      if (!retained || retained.acceptance !== source.acceptance) fail('A named acceptance contract cannot be partitioned automatically.', 'derivation-acceptance-loss');
    } else {
      for (const field of ['checks', 'commands', 'evaluators']) {
        const covered = new Set(replacements.flatMap(node => typeof node.acceptance === 'object' ? node.acceptance[field] ?? [] : []));
        if ((source.acceptance[field] ?? []).some(item => !covered.has(item))) fail('A derivation must preserve every source acceptance obligation.', 'derivation-acceptance-loss');
      }
    }
    if (retained) {
      if (children.some(child => !reaches(sourceId, new Set([child.id])))) fail('Each added leaf must feed its retained source result.', 'derivation-disconnected-child');
    } else {
      const childIds = new Set(children.map(child => child.id));
      for (const consumer of current.values()) {
        if (!consumer.dependsOn.some(id => id === source.id)) continue;
        const logicalId = consumer.logicalId ?? consumer.id;
        const consumers = desired.has(logicalId) ? [desired.get(logicalId)] : childrenBySource.get(logicalId) ?? [];
        if (!consumers.length || consumers.some(node => !reaches(node.id, childIds))) {
          fail('Every previous consumer must explicitly depend on a specific replacement result.', 'derivation-consumer-disconnected');
        }
      }
    }
  }
}

export function currentLogicalPlan(goal, nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const result = { schemaVersion: 1, id: goal.planId, goalId: goal.id,
    nodes: goal.nodeIds.map(id => nodeDefinition(byId.get(id), byId, true)) };
  if (goal.groups?.length) result.groups = copy(goal.groups);
  return result;
}

/** Deterministic, conservative revision preparation; no Git or event writes. */
export function preparePlanRevision(goal, nodes, plan, expectedRevision, { enforceDerivationPrerequisites = true } = {}) {
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
  validateDerivations(current, desired, nodes, enforceDerivationPrerequisites);
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
      dependsOn: desired.get(binding.logicalId).dependsOn.map(id => mapped.get(id)),
      ...(desired.get(binding.logicalId).dependencyReasons ? { dependencyReasons: desired.get(binding.logicalId).dependencyReasons
        .map(item => ({ ...item, nodeId: mapped.get(item.nodeId) })) } : {}) },
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

const activityNames = {
  delivered: '已交付', running: '制作中', evaluating: '验证中', integrating: '集成中',
  queued: '等待启动', ready: '待执行', planned: '未开始', failed: '失败', blocked: '受阻',
  paused: '已暂停', 'awaiting-review': '待评审', 'awaiting-verification': '待验证',
  'awaiting-integration': '待集成', 'awaiting-feedback': '待处理反馈'
};
const activity = (state, reason, nextAction) => ({ state, label: activityNames[state], reason, nextAction });
const currentDelivery = (node, goal) => node?.status === 'accepted' && node.validity === 'valid'
  && node.integrationStatus === 'integrated' && node.acceptedChangeSetId != null
  && node.integratedChangeSetId === node.acceptedChangeSetId && goal.integrationTargetRef != null
  && node.integratedTargetRef === goal.integrationTargetRef;
const latestTime = values => values.filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))
  .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

function withRetryDiagnostic(current, diagnostic) {
  // Admission guards prevent a new attempt; they do not cancel an admitted
  // operation or prevent verification/adoption of an existing candidate.
  if (current.recoveryRequired || !diagnostic?.blocked || ['running', 'evaluating', 'integrating', 'queued', 'delivered',
    'awaiting-review', 'awaiting-verification', 'awaiting-integration'].includes(current.state)) return current;
  const wording = {
    'pending-node-feedback': ['有反馈尚未纳入计划。', '检查反馈并修订对应计划，保留已有候选。'],
    'logical-node-retry-budget-exhausted': ['同一任务跨计划修订的尝试次数已用尽。', '先定位失败原因，再明确调整修复范围和预算。'],
    'retry-input-repair-required': ['上次执行受到输入或输出限制阻塞。', '修复执行输入或适配器配置并检查后继续。'],
    'retry-no-progress': ['重复失败产生了相同的改动和结果。', '根据失败证据修正输入、基线或执行器后继续。']
  }[diagnostic.code];
  const state = /review|required-review/i.test(diagnostic.code ?? '') ? 'awaiting-review'
    : /feedback/i.test(diagnostic.code ?? '') ? 'awaiting-feedback' : 'blocked';
  return activity(state, wording?.[0] || diagnostic.message || current.reason,
    wording?.[1] || diagnostic.nextAction || current.nextAction);
}

function nodeActivity(node, goal, byId, projection, pendingFeedback) {
  const currentRuns = (projection.runs ?? []).filter(item => item.nodeId === node.id);
  const leaseState = projection.operational?.workspaceLease;
  const owner = leaseState?.lease;
  const deadOwner = leaseState?.held === true && leaseState.status === 'stale'
    && leaseState.reason === 'owner-dead' && leaseState.ownerAlive === false;
  const ownsActiveRun = deadOwner && currentRuns.some(run => ['pending', 'running', 'paused'].includes(run.status)
    && (owner?.ownerKind === 'run' && owner.ownerId === run.id && (owner.runId === undefined || owner.runId === run.id)
      || owner?.ownerKind === 'run-batch' && typeof run.batchId === 'string' && run.batchId === owner.ownerId));
  if (ownsActiveRun) return { ...activity('blocked', '执行进程已退出，但任务仍留有未完成记录。',
    '检查已保留的修改并恢复任务，确认结果后再继续执行。'), label: '需恢复', recoveryRequired: true };
  const currentChangeSet = node.changeSetIds?.at(-1);
  const matchesCandidate = item => item.nodeId === node.id && (!currentChangeSet || item.changeSetId === currentChangeSet);
  const evaluations = (projection.evaluations ?? []).filter(matchesCandidate);
  const integrations = (projection.integrations ?? []).filter(matchesCandidate);
  const latestRun = currentRuns.at(-1), latestEvaluation = evaluations.at(-1), latestIntegration = integrations.at(-1);
  const failure = latestIntegration?.failure ?? latestEvaluation?.failure ?? latestRun?.failure ?? node.failure;
  if (integrations.some(item => item.status === 'recovery-required')) return activity('blocked', '集成状态需要恢复核对。', '核对已记录的集成操作并恢复。');
  if (integrations.some(item => item.status === 'running')) return activity('integrating', '正在验证并集成候选。', '等待本次集成结果。');
  if (evaluations.some(item => item.status === 'running')) return activity('evaluating', '正在独立验证当前候选。', '等待本次验证结果。');
  const running = currentRuns.find(item => item.status === 'running');
  if (running) {
    // Node ID lists retain execution order; projection collections may be sorted
    // by random IDs. Only the immediately preceding attempt proves a repair.
    const priorRunId = node.runIds?.[node.runIds.indexOf(running.id) - 1];
    const priorRun = currentRuns.find(item => item.id === priorRunId);
    const priorEvaluation = (node.evaluationIds ?? []).map(id => (projection.evaluations ?? []).find(item => item.id === id))
      .filter(item => priorRun && item?.nodeId === node.id && item.runId === priorRun.id).at(-1);
    if (priorRun?.status === 'failed' || priorEvaluation?.status === 'rejected') {
      return { ...activity('running', '执行器正在根据上次失败结果修复当前候选。', '等待本次修复结果。'), label: '正在修复' };
    }
    return activity('running', '执行器正在制作当前候选。', '等待本次产出。');
  }
  if (currentDelivery(node, goal)) return activity('delivered', '当前有效结果已验收并集成到目标分支。', '查看交付修改与证据。');
  if (goal.status === 'paused' || currentRuns.some(item => item.status === 'paused')) return activity('paused', '执行已暂停。', '检查暂停原因后继续。');
  if (pendingFeedback) return activity('awaiting-feedback', '有尚未纳入计划的反馈。', '明确修订计划后再执行。');
  const reviewRequired = [failure?.code, failure?.message, latestEvaluation?.reason,
    ...(projection.evidence ?? []).filter(item => item.id === latestEvaluation?.evidenceId)
      .flatMap(item => (item.criteria ?? []).flatMap(check => [check.code, check.message, check.summary]))]
    .some(value => typeof value === 'string' && /REVIEW_REQUIRED|review-required/.test(value));
  if (reviewRequired) return activity('awaiting-review', '候选需要独立评审，继续制作不能补齐评审。', '查看候选证据并记录评审结论。');
  if (['failed', 'rejected'].includes(node.status) || ['failed', 'conflicted'].includes(latestIntegration?.status)) {
    return activity('failed', failure?.message || '当前尝试未通过；执行已停止。', '检查失败证据，修复原因后重试。');
  }
  if (['stale', 'invalid'].includes(node.validity)) return activity('blocked', '已有结果不再对应当前输入。', '检查变更影响并重新验证或制作。');
  if (node.status === 'accepted') return activity('awaiting-integration', '候选验证已通过，尚未完成当前目标分支的集成。', '检查候选并完成集成。');
  if (node.status === 'produced' || node.status === 'evaluating') return activity('awaiting-verification', '已有候选，当前没有正在运行的验证。', '验证当前候选。');
  if (currentRuns.some(item => item.status === 'pending')) return activity('queued', '执行请求已记录，尚未启动。', '等待执行器启动；检查长时间等待的请求。');
  const unmet = (node.dependsOn ?? []).map(id => byId.get(id) ?? { id }).filter(item => !currentDelivery(item, goal));
  if (unmet.length) return activity('blocked', `等待前置任务：${unmet.map(item => item.title ?? item.id).join('、')}。`, '先完成上述前置任务的验证和集成。');
  if (node.status === 'blocked') return activity('blocked', failure?.message || '执行条件尚未满足。', '检查任务详情中的阻塞原因。');
  return node.status === 'ready' ? activity('ready', '前置任务已满足，尚未启动。', '执行此任务。')
    : activity('planned', '计划已记录，尚未开始执行。', '检查就绪条件后执行。');
}

function progressSummary(children) {
  const collect = item => item.type === 'node' ? [item] : (item.children ?? []).flatMap(collect);
  const leaves = children.flatMap(collect);
  const counts = {};
  for (const leaf of leaves) counts[leaf.activity.state] = (counts[leaf.activity.state] ?? 0) + 1;
  const priority = ['running', 'evaluating', 'integrating', 'awaiting-review', 'failed', 'awaiting-feedback',
    'paused', 'awaiting-verification', 'awaiting-integration', 'ready', 'queued', 'blocked', 'planned'];
  const current = priority.flatMap(state => leaves.filter(item => item.activity.state === state))[0];
  return { summary: { total: leaves.length, delivered: counts.delivered ?? 0, counts,
    attempts: leaves.reduce((sum, item) => sum + item.attempts, 0),
    lastProgressAt: latestTime(leaves.map(item => item.lastProgressAt)) },
  activity: current ? { ...current.activity, nodeId: current.id, title: current.title }
    : activity(leaves.length ? 'delivered' : 'planned', leaves.length ? '全部当前任务已集成。' : '尚未载入可执行任务。', leaves.length ? '查看交付修改与证据。' : '提交需求并生成计划。') };
}

/** A presentation projection over the same Node/Run facts, never a scheduler. */
export function buildWorkflow(projection) {
  const { goals = [], nodes = [], runs = [], nodeFeedback = [] } = projection;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const retryDiagnostics = new Map((projection.retryDiagnostics ?? []).map(item => [item.nodeId, item]));
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
      const done = currentDelivery(node, goal);
      const started = node.runIds?.length > 0 || ['running', 'produced', 'evaluating', 'accepted', 'rejected', 'failed'].includes(node.status);
      const phase = done ? 'done' : started ? 'work' : node.status === 'ready' && node.validity === 'valid' ? 'ready' : 'plan';
      const logicalId = node.logicalId ?? node.id;
      const retryDiagnostic = retryDiagnostics.get(node.id);
      const historyIds = new Set(nodes.filter(item => item.goalId === goal.id && (item.logicalId ?? item.id) === logicalId).map(item => item.id));
      const historyRuns = runs.filter(item => historyIds.has(item.nodeId));
      const attempts = retryDiagnostic?.attempts ?? new Set([...nodes.filter(item => historyIds.has(item.id)).flatMap(item => item.runIds ?? []), ...historyRuns.map(item => item.id)]).size;
      const pendingFeedback = nodeFeedback.some(item => item.goalId === goal.id && item.logicalId === logicalId && item.status === 'pending');
      // Diagnostics exclude repeated patches. Their explicit null is authoritative;
      // older callers without diagnostics retain the durable-event fallback.
      const lastProgressAt = retryDiagnostic && Object.hasOwn(retryDiagnostic, 'lastProgressAt')
        ? retryDiagnostic.lastProgressAt : latestTime([...historyRuns.map(item => item.producedAt),
        ...(projection.evaluations ?? []).filter(item => historyIds.has(item.nodeId) && item.status === 'passed').map(item => item.finishedAt),
        ...(projection.integrations ?? []).filter(item => historyIds.has(item.nodeId) && item.status === 'integrated').map(item => item.integratedAt)]);
      const currentActivity = withRetryDiagnostic(nodeActivity(node, goal, byId, projection, pendingFeedback), retryDiagnostic);
      add(node.parentId, { id: node.id, logicalId, definitionRevision: node.definitionRevision ?? 1,
        type: 'node', goalId: goal.id, parentId: node.parentId ?? null, title: node.title ?? logicalId,
        attempts, lastProgressAt, activity: currentActivity,
        phase, flags: { failed: ['failed', 'rejected'].includes(node.status),
          paused: goal.status === 'paused' || runs.some(run => run.nodeId === node.id && run.status === 'paused'),
          pendingFeedback,
          stale: ['stale', 'invalid'].includes(node.validity),
          blocked: node.status === 'blocked' || currentActivity.recoveryRequired === true
            || (retryDiagnostic?.blocked === true && currentActivity.state === 'blocked') }, children: [] });
    }
    const visit = item => {
      if (item.type === 'node') return item;
      const children = (childrenByParent.get(item.id) ?? []).map(visit);
      return { ...item, children, phase: combine(children), flags: mergeFlags(children), ...progressSummary(children) };
    };
    const children = (childrenByParent.get(null) ?? []).map(visit);
    return { id: goal.id, title: goal.title, revision: goal.planRevision ?? (goal.planId ? 1 : 0),
      ...progressSummary(children), phase: combine(children), flags: { ...mergeFlags(children),
        paused: goal.status === 'paused' || children.some(item => item.flags.paused) }, children };
  });
  return { schemaVersion: 1, goals: trees,
    revisions: copy(goals.flatMap(goal => (goal.planHistory ?? []).map(record => ({ goalId: goal.id, ...record,
      plan: record.plan ?? currentLogicalPlan(goal, nodes) })))),
    feedback: copy(nodeFeedback) };
}
