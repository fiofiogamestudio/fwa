(function (root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.FwaWorkbenchModel = model;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const labels = Object.freeze({
    draft: '草稿', planned: '已计划', ready: '待执行', active: '进行中',
    pending: '等待中', requested: '已请求', running: '运行中', paused: '已暂停',
    produced: '已产出', evaluating: '验收中', accepted: '已验收',
    rejected: '已拒绝', blocked: '已阻断', failed: '失败', cancelled: '已取消',
    completed: '已完成', valid: '有效', stale: '已过期', invalid: '无效',
    integrated: '已集成', integrating: '集成中', reverting: '回退中', reverted: '已回退',
    conflicted: '存在冲突', interrupted: '已中断', 'recovery-required': '需要恢复',
    passed: '通过', pass: '通过', fail: '未通过', succeeded: '成功',
    present: '保留中', preserved: '已保留', removed: '已移除'
  });
  function statusLabel(value) {
    if (value === undefined || value === null || value === '') return '未记录';
    return Object.hasOwn(labels, value) ? labels[value] : String(value);
  }
  function tone(value) {
    if (['failed', 'fail', 'rejected', 'conflicted', 'recovery-required'].includes(value)) return 'danger';
    if (['produced', 'stale', 'invalid', 'blocked', 'paused', 'interrupted', 'reverted'].includes(value)) return 'warning';
    if (['running', 'active', 'evaluating', 'integrating', 'reverting'].includes(value)) return 'active';
    if (['accepted', 'integrated', 'passed', 'pass', 'succeeded', 'completed'].includes(value)) return 'success';
    return 'neutral';
  }
  const list = value => Array.isArray(value) ? value : [];
  const rows = (status, key) => list(status?.[key]).filter(item => item && typeof item === 'object');
  const hasId = item => typeof item.id === 'string' && item.id.length > 0;
  const compare = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const title = node => typeof node.title === 'string' && node.title.trim() ? node.title : node.id;
  function unique(items) {
    const byId = new Map();
    for (const item of items) if (hasId(item) && !byId.has(item.id)) byId.set(item.id, item);
    return [...byId.values()];
  }
  function selectedNodes(status, goalId) {
    return unique(rows(status, 'nodes')).filter(node => node.supersededByRevision == null && (goalId == null || node.goalId === goalId)).sort(compare);
  }
  function nodeTone(node) {
    const values = [tone(node.status), tone(node.validity), tone(node.integrationStatus)];
    for (const severity of ['danger', 'warning', 'active']) if (values.includes(severity)) return severity;
    // Green summarizes the whole Node only when all three dimensions agree.
    return node.status === 'accepted' && node.validity === 'valid' && node.integrationStatus === 'integrated'
      ? 'success' : 'neutral';
  }
  function nodeCard(node, id = node.id) {
    return {
      id, title: title(node), subtitle: node.id, tone: nodeTone(node),
      badges: [`状态：${statusLabel(node.status)}`, `有效性：${statusLabel(node.validity)}`,
        `集成：${statusLabel(node.integrationStatus)}`]
    };
  }
  function edge(kind, source, target, label) {
    return { id: `${kind}:${encodeURIComponent(source)}:${encodeURIComponent(target)}`, source, target, label, kind };
  }
  function buildDag(status, goalId) {
    const selected = selectedNodes(status, goalId);
    const ids = new Set(selected.map(node => node.id));
    const edges = [];
    for (const node of selected) for (const prerequisite of list(node.dependsOn)) {
      if (ids.has(prerequisite)) edges.push(edge('dependency', prerequisite, node.id, '前置依赖'));
    }
    const groups = [];
    const visit = (item, parent, ownerGoalId) => {
      if (item.type === 'group') {
        const graphId = goalId == null ? `group:${encodeURIComponent(ownerGoalId)}/${encodeURIComponent(item.id)}` : item.id;
        groups.push({ id: graphId, objectId: item.id, goalId: ownerGoalId, objectType: 'groups', title: item.title, subtitle: `分组 · ${item.phase}`, tone: item.phase === 'done' ? 'success' : item.phase === 'work' ? 'active' : 'neutral',
          badges: Object.entries(item.flags || {}).filter(([, value]) => value === true).map(([key]) => key) });
        if (parent) edges.push(edge('containment', parent, graphId, '包含'));
        for (const child of list(item.children)) visit(child, graphId, ownerGoalId);
      } else if (parent && ids.has(item.id)) edges.push(edge('containment', parent, item.id, '包含'));
    };
    for (const goal of list(status?.workflow?.goals).filter(goal => goalId == null || goal.id === goalId)) for (const item of list(goal.children)) visit(item, null, goal.id);
    return { nodes: [...groups, ...selected.map(node => nodeCard(node))], edges: unique(edges).sort(compare) };
  }
  function buildRefs(status, goalId) {
    const selected = selectedNodes(status, goalId);
    const registered = unique(rows(status, 'refs'));
    const refsById = new Map(registered.map(ref => [ref.id, ref]));
    const touched = new Set();
    const edges = [];
    for (const node of selected) for (const [field, kind, label] of [
      ['reads', 'read', '声明读取'], ['writes', 'write', '声明写入']
    ]) for (const refId of list(node[field])) {
      if (typeof refId !== 'string' || !refId.startsWith('ref://') || !refsById.has(refId)) continue;
      touched.add(refId);
      const nodeId = `node:${node.id}`;
      edges.push(kind === 'read' ? edge(kind, refId, nodeId, label) : edge(kind, nodeId, refId, label));
    }
    const refs = registered.filter(ref => goalId == null || touched.has(ref.id)).map(ref => ({
      id: ref.id, title: ref.id, subtitle: typeof ref.uri === 'string' ? ref.uri : '未记录路径', tone: 'neutral',
      badges: [`类型：${ref.kind ?? '未记录'}`, `版本：${ref.version ?? '未记录'}`]
    }));
    return { nodes: [...selected.map(node => nodeCard(node, `node:${node.id}`)), ...refs].sort(compare),
      edges: unique(edges).sort(compare) };
  }
  function copy(value) {
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    return value;
  }
  function nodeDetails(status, nodeId) {
    const node = rows(status, 'nodes').find(item => item.id === nodeId);
    if (!node) return null;
    const goal = rows(status, 'goals').find(item => item.id === node.goalId) ?? null;
    // Explicit contradictory bindings are never pulled into another Node's inspector.
    const belongs = (item, related) => (item.nodeId == null || item.nodeId === nodeId)
      && (item.nodeId === nodeId || related(item));
    const ids = items => new Set(items.map(item => item.id));
    const runs = unique(rows(status, 'runs').filter(item => belongs(item, record => list(node.runIds).includes(record.id))));
    const runIds = ids(runs);
    const changeSets = unique(rows(status, 'changeSets').filter(item => belongs(item, record =>
      list(node.changeSetIds).includes(record.id) || list(node.revertChangeSetIds).includes(record.id) || runIds.has(record.runId))));
    const changeIds = ids(changeSets);
    const evaluations = unique(rows(status, 'evaluations').filter(item => belongs(item, record =>
      list(node.evaluationIds).includes(record.id) || runIds.has(record.runId) || changeIds.has(record.changeSetId))));
    const evaluationIds = ids(evaluations);
    const evidence = unique(rows(status, 'evidence').filter(item => belongs(item, record =>
      list(node.acceptanceEvidenceIds).includes(record.id) || runIds.has(record.runId)
      || changeIds.has(record.changeSetId) || evaluationIds.has(record.evaluationId))));
    const integrations = unique(rows(status, 'integrations').filter(item => belongs(item, record =>
      list(node.integrationIds).includes(record.id) || changeIds.has(record.changeSetId))));
    const integrationIds = ids(integrations);
    const reversions = unique(rows(status, 'reversions').filter(item => belongs(item, record =>
      changeIds.has(record.sourceChangeSetId) || changeIds.has(record.revertChangeSetId)
      || integrationIds.has(record.integrationId) || integrationIds.has(record.sourceIntegrationId))));
    const declaredRefIds = new Set([...list(node.reads), ...list(node.writes)]);
    for (const run of runs) for (const ref of [...list(run.effects?.consumedRefs), ...list(run.effects?.producedRefs)]) {
      declaredRefIds.add(ref.id);
    }
    const refs = unique(rows(status, 'refs').filter(ref => declaredRefIds.has(ref.id)));
    const blockers = [];
    if (!goal) blockers.push('所属目标未记录，无法核对执行条件。');
    else if (!['planned', 'active'].includes(goal.status)) blockers.push(`目标状态为「${statusLabel(goal.status)}」，不能直接排入执行。`);
    if (node.validity !== 'valid') blockers.push(`节点有效性为「${statusLabel(node.validity)}」，不能视为当前有效结果。`);
    const byId = new Map(rows(status, 'nodes').map(item => [item.id, item]));
    for (const prerequisite of new Set(list(node.dependsOn))) {
      const dependency = byId.get(prerequisite);
      if (!dependency) { blockers.push(`前置节点「${prerequisite}」未记录。`); continue; }
      const reasons = [];
      if (dependency.status !== 'accepted') reasons.push(`尚未验收通过（${statusLabel(dependency.status)}）`);
      if (dependency.validity !== 'valid') reasons.push(`有效性为${statusLabel(dependency.validity)}`);
      if (dependency.integrationStatus !== 'integrated') reasons.push(`尚未集成（${statusLabel(dependency.integrationStatus)}）`);
      if (dependency.status === 'accepted' && dependency.integrationStatus === 'integrated') {
        if (typeof dependency.acceptedChangeSetId !== 'string' || !dependency.acceptedChangeSetId
          || dependency.integratedChangeSetId !== dependency.acceptedChangeSetId) reasons.push('验收与集成的变更集绑定不一致或未记录');
        if (goal?.integrationTargetRef == null || dependency.integratedTargetRef !== goal.integrationTargetRef) {
          reasons.push('集成目标分支不一致或未记录');
        }
      }
      if (reasons.length) blockers.push(`前置节点「${title(dependency)}」：${reasons.join('；')}。`);
    }
    if (node.status === 'produced') blockers.push('已产生候选改动，但尚未独立验收；产出不代表验收通过或已集成。');
    if (node.status === 'rejected') blockers.push('当前候选改动已被拒绝；需检查验收证据，并明确申请重试后才能再次执行。');
    if (node.status === 'failed') blockers.push('节点当前失败；需先检查失败原因与恢复记录，不能把失败当作已完成。');
    if (node.status === 'blocked') blockers.push('节点当前被阻断；需先检查前置条件与操作记录。');
    if (node.status === 'accepted' && node.integrationStatus !== 'integrated') blockers.push('节点已验收，但尚未集成；下游执行仍需检查集成前置条件。');
    const attemptIds = new Set([...list(node.runIds), ...runIds]);
    if (Number.isSafeInteger(node.budget?.maxRetries) && node.budget.maxRetries >= 0
      && attemptIds.size > node.budget.maxRetries) blockers.push('执行尝试预算已用尽；重试不会重置预算。');
    if (status?.operational?.gitProcessFence?.held === true) blockers.push('项目存在持久 Git 安全阻断，需要明确检查与恢复。');
    if (status?.operational?.workspaceLease?.held === true) blockers.push('项目工作区租约被占用；不能据缓存状态另行启动写操作。');
    return copy({ node, goal, blockers, runs, changeSets, evaluations, evidence, refs, integrations, reversions });
  }
  return Object.freeze({ buildDag, buildRefs, nodeDetails, statusLabel, tone });
});
