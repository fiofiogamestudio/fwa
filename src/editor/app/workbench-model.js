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
  function nodeCard(node, id = node.id, currentActivity) {
    return {
      id, title: title(node), subtitle: node.id, tone: currentActivity ? activityTone(currentActivity.state) : nodeTone(node),
      badges: [...(currentActivity ? [`当前：${currentActivity.label}`] : []),
        `${currentActivity ? '执行记录' : '状态'}：${statusLabel(node.status)}`, `有效性：${statusLabel(node.validity)}`,
        `集成：${statusLabel(node.integrationStatus)}`]
    };
  }
  function workflowActivities(status) {
    const activities = new Map();
    const visit = item => {
      if (item.type === 'node' && item.activity) activities.set(item.id, item.activity);
      for (const child of list(item.children)) visit(child);
    };
    for (const goal of list(status?.workflow?.goals)) visit(goal);
    return activities;
  }
  function edge(kind, source, target, label) {
    return { id: `${kind}:${encodeURIComponent(source)}:${encodeURIComponent(target)}`, source, target, label, kind };
  }
  function buildDag(status, goalId) {
    const selected = selectedNodes(status, goalId);
    const activities = new Map(buildProgress(status, goalId).groups.flatMap(group => group.items).map(item => [item.id, item]));
    const ids = new Set(selected.map(node => node.id));
    const edges = [];
    for (const node of selected) for (const prerequisite of list(node.dependsOn)) {
      if (ids.has(prerequisite)) edges.push({ ...edge('dependency', prerequisite, node.id, '前置依赖'),
        reason: list(node.dependencyReasons).find(item => item.nodeId === prerequisite)?.reason || '依赖原因未记录' });
    }
    return { nodes: selected.map(node => ({ id: node.id, title: title(node),
      subtitle: node.outcome || '', tone: activityTone(activities.get(node.id)?.state),
      badges: [activities.get(node.id)?.label || '未开始'] })), edges: unique(edges).sort(compare) };
  }
  function buildRefs(status, goalId) {
    const selected = selectedNodes(status, goalId);
    const activities = workflowActivities(status);
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
    return { nodes: [...selected.map(node => nodeCard(node, `node:${node.id}`, activities.get(node.id))), ...refs].sort(compare),
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
  function activityTone(state) {
    if (state === 'delivered') return 'success';
    if (['running', 'evaluating', 'integrating'].includes(state)) return 'active';
    if (state === 'failed') return 'danger';
    if (['blocked', 'paused', 'awaiting-review', 'awaiting-feedback'].includes(state)) return 'warning';
    return 'neutral';
  }
  function nodeWorkbench(status, nodeId) {
    const detail = nodeDetails(status, nodeId);
    if (!detail) return null;
    const node = detail.node;
    const activity = buildProgress(status, node.goalId).groups.flatMap(group => group.items).find(item => item.id === nodeId)
      || { state: 'historical', label: '历史版本', reason: '此节点已被新的任务图版本替代。', tone: 'muted' };
    const checks = typeof node.acceptance === 'string' ? [node.acceptance] : Array.isArray(node.acceptance) ? node.acceptance
      : [...list(node.acceptance?.commands), ...list(node.acceptance?.checks)];
    const completion = checks.map(item => ({ text: typeof item === 'string' ? item : item.description || item.title || item.id || JSON.stringify(item) }));
    const dependencies = list(node.dependsOn).map(id => ({ id, title: rows(status, 'nodes').find(item => item.id === id)?.title || id,
      reason: list(node.dependencyReasons).find(item => item.nodeId === id)?.reason || '依赖原因未记录' }));
    const change = detail.changeSets.find(item => item.id === list(node.changeSetIds).at(-1));
    return { ...detail, activity, outcome: node.outcome?.trim() || (title(node) + '（旧计划未单列结果说明）'),
      completion: completion.length ? completion : [{ text: '完成条件未记录' }], dependencies, change,
      derivedText: node.derivedFrom ? '派生自：' + node.derivedFrom : '',
      resultSummary: activity.state === 'delivered' ? '结果已确认并集成。'
        : Array.isArray(change?.changedFiles) && !change.changedFiles.length ? '未产生文件改动，需要核对执行记录。'
        : change ? '已有候选结果 · ' + (change.changedFiles?.length || 0) + ' 个文件，确认并集成后才计为完成。'
          : '尚无候选结果。' };
  }
  function workAvailability(status, session, goalId, nodeId, jobs = []) {
    const denied = reason => ({ allowed: false, reason });
    if (!session?.allowWrite) return denied('当前为只读模式。');
    if (!goalId) return denied('请先选择一个目标。');
    const goal = rows(status, 'goals').find(item => item.id === goalId);
    if (!goal || !['planned', 'active'].includes(goal.status)) return denied('当前目标尚不可执行。');
    if (!session.workflow?.work) return denied('当前未配置可用执行器。');
    if (session.review?.configured === false) return denied('缺少项目检查配置，执行受阻。');
    if (jobs.some(job => ['queued', 'running'].includes(job.state))) return denied('当前操作正在处理，请等待结果。');
    if (status.operational?.gitProcessFence?.held) return denied('项目需要检查并恢复 Git 操作。');
    if (status.operational?.workspaceLease?.held) return denied(status.operational.workspaceLease.ownerAlive === false ? '执行进程已退出，需要恢复工作区。' : '工作区正在被使用，请等待当前操作结束。');
    if (rows(status, 'runBatches').some(item => item.status === 'running')
      || rows(status, 'runs').some(item => ['pending', 'running', 'paused'].includes(item.status))
      || ['evaluations', 'integrations', 'reversions'].some(key => rows(status, key).some(item => ['requested', 'pending', 'running', 'recovery-required'].includes(item.status)))) return denied('当前操作尚未结束或需要恢复。');
    if (list(status.workflow?.feedback).some(item => item.goalId === goalId && item.status === 'pending')) return denied('先将补充要求纳入任务图，再继续执行。');
    const items = buildProgress(status, goalId).groups.flatMap(group => group.items).filter(item => !nodeId || item.id === nodeId);
    const repairable = new Set(rows(status, 'retryDiagnostics').filter(item => ['retry-input-repair-required', 'retry-no-progress'].includes(item.code)).map(item => item.nodeId));
    let eligible = items.filter(item => {
      const node = rows(status, 'nodes').find(node => node.id === item.id);
      if (repairable.has(item.id) && node?.status === 'ready') return true;
      if (item.state === 'ready') return true;
      if (item.state !== 'awaiting-verification'
        && !(session.review?.completionMode === 'automatic' && ['awaiting-review', 'awaiting-integration'].includes(item.state))) return false;
      const change = rows(status, 'changeSets').find(change => change.id === list(node?.changeSetIds).at(-1));
      return change?.valid === true && change.kind === 'execution' && change.changedFiles?.length > 0;
    });
    if (eligible.length && Array.isArray(session.review?.validationProfiles)) {
      const profiles = session.review.validationProfiles;
      eligible = eligible.filter(item => {
        const node = rows(status, 'nodes').find(node => node.id === item.id);
        const matches = profiles.filter(profile => {
          if (typeof node.acceptance === 'string') return node.acceptance === profile.id;
          const required = [...list(node.acceptance?.commands), ...list(node.acceptance?.checks)];
          const available = list(profile.checks).map(check => check.id);
          return required.length > 0 && required.length === available.length && required.every(id => available.includes(id))
            && (!node.acceptance?.evaluators?.length || node.acceptance.evaluators.includes('command-evaluator'));
        });
        if (matches.length !== 1) return false;
        item.manualConfirmation = list(session.review.manualProfiles).includes(matches[0].id);
        return true;
      });
      if (!eligible.length) return denied('此节点缺少唯一且完整覆盖完成条件的验证配置，执行受阻。');
      eligible = eligible.filter(item => !item.manualConfirmation || item.state === 'ready' || item.state === 'awaiting-verification');
    }
    if (!eligible.length) return denied(items.find(item => ['blocked', 'failed', 'paused'].includes(item.state))?.reason
      || (items.some(item => ['awaiting-review', 'awaiting-integration'].includes(item.state)) ? '已有结果待确认并收束。' : '当前没有可推进的节点，请查看前置条件。'));
    return { allowed: true, reason: '', repairRequired: eligible.some(item => repairable.has(item.id)), nodeIds: eligible.map(item => item.id) };
  }
  function buildProgress(status = {}, goalId) {
    const workflow = new Map(), groupPaths = new Map();
    const nodeOrder = new Map(rows(status, 'goals').flatMap(goal => list(goal.nodeIds)).map((id, index) => [id, index]));
    const groupOrder = new Map();
    const walk = (item, path, owner) => {
      if (item.type === 'node') { workflow.set(item.id, item); return; }
      const next = [...path, item.title || item.id];
      groupPaths.set(`${owner}/${item.id}`, next.join(' / '));
      groupOrder.set(`${owner}/${item.id}`, groupOrder.size);
      for (const child of list(item.children)) walk(child, next, owner);
    };
    for (const goal of list(status.workflow?.goals)) for (const child of list(goal.children)) walk(child, [], goal.id);
    const diagnostics = new Map(list(status.retryDiagnostics).map(item => [item.nodeId, item]));
    const diagnosticCopy = {
      'pending-node-feedback': ['有反馈尚未纳入计划。', '检查反馈并修订对应计划，保留已有候选。'],
      'logical-node-retry-budget-exhausted': ['同一任务跨计划修订的尝试次数已用尽。', '先定位失败原因，再明确调整修复范围和预算。'],
      'retry-input-repair-required': ['上次执行受到输入或输出限制阻塞。', '修复执行输入或适配器配置并检查后继续。'],
      'retry-no-progress': ['重复失败产生了相同的改动和结果。', '根据失败证据修正输入、基线或执行器后继续。']
    };
    const byGoal = new Map(rows(status, 'goals').map(item => [item.id, item]));
    for (const goal of byGoal.values()) for (const group of list(goal.groups)) {
      const key = `${goal.id}/${group.id}`;
      if (!groupOrder.has(key)) groupOrder.set(key, groupOrder.size);
    }
    const delivered = (node, goal) => node.status === 'accepted' && node.validity === 'valid'
      && node.integrationStatus === 'integrated' && node.acceptedChangeSetId != null
      && node.integratedChangeSetId === node.acceptedChangeSetId && goal?.integrationTargetRef != null
      && node.integratedTargetRef === goal.integrationTargetRef;
    const timeText = value => value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无已记录进展';
    const fallback = (node, goal) => {
      if (delivered(node, goal)) return { state: 'delivered', label: '已交付', reason: '当前结果已验收并集成。', nextAction: '查看交付证据。' };
      const mapped = { running: ['running', '制作中'], evaluating: ['awaiting-verification', '待验证'],
        failed: ['failed', '失败'], rejected: ['failed', '失败'], produced: ['awaiting-verification', '待验证'],
        accepted: ['awaiting-integration', '待集成'], ready: ['ready', '待执行'], blocked: ['blocked', '受阻'], paused: ['paused', '已暂停'] };
      const [state, label] = ['stale', 'invalid'].includes(node.validity) ? ['blocked', '受阻'] : mapped[node.status] ?? ['planned', '未开始'];
      return { state, label, reason: nodeDetails(status, node.id)?.blockers[0] || '尚未记录完整交付。', nextAction: '查看任务详情。' };
    };
    const items = selectedNodes(status, goalId).sort((a, b) => (nodeOrder.get(a.id) ?? Infinity) - (nodeOrder.get(b.id) ?? Infinity)).map(node => {
      const goal = byGoal.get(node.goalId), projected = workflow.get(node.id), diagnostic = diagnostics.get(node.id);
      let current = projected?.activity ?? fallback(node, goal);
      if (diagnostic?.blocked && !current.recoveryRequired && !['running', 'evaluating', 'integrating', 'queued', 'delivered',
        'awaiting-review', 'awaiting-verification', 'awaiting-integration'].includes(current.state)) {
        const waiting = /review|required-review/i.test(diagnostic.code || '') ? ['awaiting-review', '待评审']
          : /feedback/i.test(diagnostic.code || '') ? ['awaiting-feedback', '待处理反馈'] : ['blocked', '受阻'];
        const translated = diagnosticCopy[diagnostic.code];
        current = { state: waiting[0], label: waiting[1], reason: translated?.[0] || diagnostic.message || current.reason,
          nextAction: translated?.[1] || diagnostic.nextAction || current.nextAction };
      }
      const history = rows(status, 'nodes').filter(item => item.goalId === node.goalId && (item.logicalId ?? item.id) === (node.logicalId ?? node.id));
      const historyIds = new Set(history.map(item => item.id));
      const attempts = diagnostic?.attempts ?? projected?.attempts ?? new Set([...history.flatMap(item => list(item.runIds)),
        ...rows(status, 'runs').filter(item => historyIds.has(item.nodeId)).map(item => item.id)]).size;
      const lastProgressAt = diagnostic && Object.hasOwn(diagnostic, 'lastProgressAt') ? diagnostic.lastProgressAt : projected?.lastProgressAt ?? null;
      return { id: node.id, title: title(node), goalId: node.goalId, parentId: node.parentId ?? null,
        changeId: list(node.changeSetIds).at(-1), ...current, tone: activityTone(current.state), attempts, lastProgressAt,
        attemptsText: `累计尝试 ${attempts} 次（含历史修订）${diagnostic?.repeatedFailureCount > 1 ? ` · 相同失败 ${diagnostic.repeatedFailureCount} 次` : ''}`,
        lastProgressText: `最近有效进展：${timeText(lastProgressAt)}`,
        identity: `${node.logicalId ?? node.id} · 定义版本 ${node.definitionRevision ?? 1}` };
    });
    const groups = new Map();
    for (const item of items) {
      const goal = byGoal.get(item.goalId), key = `${item.goalId}/${item.parentId ?? 'ungrouped'}`;
      if (!groups.has(key)) {
        const name = groupPaths.get(key) ?? list(goal?.groups).find(group => group.id === item.parentId)?.title ?? (item.parentId || '任务');
        groups.set(key, { key, title: goalId == null ? `${goal?.title ?? item.goalId} / ${name}` : name, items: [] });
      }
      groups.get(key).items.push(item);
    }
    const counts = {};
    for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
    const priority = ['running', 'evaluating', 'integrating', 'awaiting-review', 'failed', 'awaiting-feedback', 'paused',
      'awaiting-verification', 'awaiting-integration', 'ready', 'queued', 'blocked', 'planned'];
    const current = priority.flatMap(state => items.filter(item => item.state === state))[0];
    const describeCounts = entries => {
      const labels = new Map(entries.map(item => [item.state, item.label]));
      return [...labels].map(([state, label]) => `${label} ${entries.filter(item => item.state === state).length}`).join(' · ');
    };
    const lastProgressAt = items.map(item => item.lastProgressAt).filter(value => value && Number.isFinite(Date.parse(value)))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const planDiagnostics = list(status.planDiagnostics).filter(item => goalId == null || item.goalId === goalId).map(item => ({
      key: `plan:${item.goalId}`, title: byGoal.get(item.goalId)?.title ?? item.goalId,
      summary: `最长依赖链 ${item.metrics?.longestDependencyChainLength ?? '未记录'} 项 · 检查引用 ${item.metrics?.checkReferenceCount ?? '未记录'} 次 / ${item.metrics?.uniqueCheckCount ?? '未记录'} 个检查`,
      findings: list(item.findings).filter(finding => finding.severity !== 'info').map(finding => ({ message: ({
        LONG_DEPENDENCY_CHAIN: '依赖链较长：检查是否每个前置都必须先完成集成，保留真实的数据依赖。',
        DECLARED_EFFECT_CONFLICTS: '部分任务共享写入范围或独占资源；图中并列不代表可以同时执行。',
        BROAD_WRITE_DECLARATIONS: '部分写入范围过宽或被多个任务共用；并行前需明确文件归属。',
        INVALID_PLAN: '计划未通过结构检查，需先修复计划。'
      })[finding.code] ?? finding.message })), details: JSON.stringify(item, null, 2)
    }));
    return { total: items.length, delivered: counts.delivered ?? 0, counts, planDiagnostics, hasPlanDiagnostics: planDiagnostics.length > 0,
    groups: [...groups.values()].sort((a, b) => (groupOrder.get(a.key) ?? Infinity) - (groupOrder.get(b.key) ?? Infinity)).map(group => ({ ...group,
      summary: `已集成 ${group.items.filter(item => item.state === 'delivered').length} / ${group.items.length} · ${describeCounts(group.items)}` })),
    progressText: `已集成 ${counts.delivered ?? 0} / ${items.length} 项`, countsText: describeCounts(items),
    attemptsText: `累计尝试 ${items.reduce((sum, item) => sum + item.attempts, 0)} 次（含历史修订）`,
    current, actionText: current ? `${current.label}：${current.title}` : items.length ? '全部当前任务已交付' : '尚无可执行计划',
    reason: current?.reason || '', nextAction: current?.nextAction || '',
    lastProgressAt, lastProgressText: `最近有效进展：${timeText(lastProgressAt)}` };
  }
  function buildOverview(status = {}, session, goalId, jobs = []) {
    const progress = buildProgress(status, goalId), items = progress.groups.flatMap(group => group.items);
    const action = workAvailability(status, session, goalId, null, jobs);
    const result = { progressText: `已完成 ${progress.delivered} / ${progress.total}`, nextText: '',
      actionKind: '', actionLabel: '', focusId: null };
    const focus = (item, text, label = '查看任务') => ({ ...result, nextText: text,
      actionKind: item ? 'focus' : '', actionLabel: label, focusId: item?.id || null });
    if (!progress.total) return { ...result, progressText: '', nextText: '输入需求，生成任务图后开始。' };
    if (!goalId) return { ...result, nextText: '选择一个任务，查看进度并继续。' };
    if (progress.delivered === progress.total) return { ...result, nextText: '全部结果已确认并集成。' };
    const recovery = items.find(item => item.recoveryRequired);
    const lease = status.operational?.workspaceLease;
    if (status.operational?.gitProcessFence?.held || recovery || lease?.held && lease.ownerAlive === false) {
      return focus(recovery || progress.current, '执行已中断，需要先检查并恢复。', '查看中断任务');
    }
    const active = items.find(item => ['running', 'evaluating', 'integrating'].includes(item.state));
    if (active) return focus(active, `${({ running: '正在执行', evaluating: '正在验证', integrating: '正在收束' })[active.state]}：${active.title}`, '查看当前任务');
    if (jobs.some(job => ['queued', 'running'].includes(job.state)) || lease?.held) {
      return { ...result, nextText: lease?.held && lease.ownerAlive == null ? '工作区占用状态待核查。' : '正在处理当前请求。' };
    }
    if (action.allowed) return { ...result, actionKind: 'work', actionLabel: action.repairRequired ? '检查并继续' : '继续执行',
      nextText: `${action.nodeIds.length} 项可推进${items.some(item => ['failed', 'blocked'].includes(item.state)) ? '，其余任务等待处理' : ''}。` };
    const candidate = items.find(item => ['awaiting-review', 'awaiting-integration', 'awaiting-verification'].includes(item.state));
    if (candidate) {
      const change = rows(status, 'changeSets').find(change => change.id === candidate.changeId);
      const empty = Array.isArray(change?.changedFiles) && change.changedFiles.length === 0;
      return focus(candidate, empty ? '未产生文件改动，需要核对执行记录。'
        : candidate.state === 'awaiting-verification' ? '已有结果，等待验证。' : '已有结果，需要查看检查状态后收束。', empty ? '查看执行记录' : '查看结果');
    }
    const queued = items.find(item => item.state === 'queued');
    if (queued) return focus(queued, `等待启动：${queued.title}`);
    if (!session?.allowWrite) return { ...result, nextText: '选择节点查看进度和结果。' };
    return focus(progress.current, action.reason, '查看待处理任务');
  }
  return Object.freeze({ buildDag, buildRefs, buildProgress, buildOverview, nodeDetails, nodeWorkbench, workAvailability, statusLabel, tone });
});
