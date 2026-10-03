(function () {
  'use strict';
  const PROTOCOL = 'fwa-console-v1';
  const mounted = new WeakMap();
  function createCommandJournal(storage, projectId, makeId = () => `console-${crypto.randomUUID()}`) {
    const keyFor = (type, payload) => `fwa.console.pending.v1:${projectId}:${type}:${JSON.stringify(payload)}`;
    return {
      begin(type, payload) {
        const key = keyFor(type, payload), recorded = storage.getItem(key);
        if (recorded !== null) {
          const value = JSON.parse(recorded);
          if (typeof value.commandId !== 'string' || !/^console-[A-Za-z0-9-]+$/.test(value.commandId)) throw new Error('待确认命令 ID 记录损坏，请先通过 CLI 核对事件。');
          return value.commandId;
        }
        const commandId = makeId(); storage.setItem(key, JSON.stringify({ commandId })); return commandId;
      },
      acknowledge(type, payload, commandId) {
        const key = keyFor(type, payload), recorded = storage.getItem(key);
        if (recorded !== null && JSON.parse(recorded).commandId === commandId) storage.removeItem(key);
      }
    };
  }
  window.FwaConsoleCommandJournal = createCommandJournal;
  async function api(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...options,
      headers: window.fwe.session.headers(options.headers || {}) });
    const body = await response.json();
    if (!response.ok) throw new Error(`${body.code || response.status}: ${body.error || response.statusText}`);
    return body;
  }
  function mount(host, ctx) {
    const M = window.FwaWorkbenchModel;
    if (!M || !window.FwaWorkbenchContent || !window.fwe.ui.createGraph || !window.FwaSurface) {
      host.textContent = '可视化组件尚未加载，请重启服务并刷新页面。'; return null;
    }
    window.FwaSurface.configure(ctx);
    const state = { data: ctx.data, session: null, goalId: null, selected: null, contextNodeId: null, graphScope: 'focus',
      pendingCommands: new Set(), fresh: false, disposed: false, jobsRevision: '', intakeInitialized: false, attentionKey: '' };
    let graph, graphRevision, journal, refreshing = false, initialized = false, timer, inspectorView, inspectorKey = '';
    let navigationKey = JSON.stringify(ctx.data?._fwaSelection || null), pendingSelection = ctx.data?._fwaSelection;
    let navigationBusy = false, nextNavigation = null, navigationSequence = ctx.data?.lastSequence;
    const C = window.FwaWorkbenchContent.create({ api, select: selectObject, getStatus: () => state.data,
      command: workflowCommand, getSession: () => state.fresh ? state.session : { ...state.session, allowWrite: false },
      refresh: () => refreshData(true),
      getWorkAvailability: id => availability(id) });
    const W = window.FwaWorkflowPanel?.create({ api, command: workflowCommand, C, getStatus: () => state.data,
      getSession: () => state.fresh ? state.session : { ...state.session, allowWrite: false },
      selectNode: id => selectObject('nodes', id), openGoal: id => selectGoal(id), refresh: () => refreshData(true) });
    async function workflowCommand(type, payload, options = {}) {
      if (!state.session?.allowWrite || !state.fresh) throw new Error('只读或快照失联，不能提交操作。');
      if (state.pendingCommands.has(type)) throw new Error('同类操作正在提交，请等待响应。');
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      const intent = { sha256: digest };
      journal ||= createCommandJournal(window.sessionStorage, state.session.projectId);
      const commandId = journal.begin(type, intent); state.pendingCommands.add(type);
      try {
        const response = await api(options.upload ? '/api/fwa/import' : '/api/fwa/commands', { method: 'POST',
          signal: AbortSignal.timeout(options.upload ? 120000 : 15000),
          headers: { 'Content-Type': 'application/json', 'X-FWA-CSRF': state.session.csrfToken, 'X-FWA-Fingerprint': state.session.fingerprint },
          body: JSON.stringify({ type, commandId, payload }) });
        journal.acknowledge(type, intent, commandId); return response.result;
      } finally { state.pendingCommands.delete(type); }
    }
    const ui = window.FwaSurface.create('console', { actions: {
      refresh: () => refreshData(true), work: () => primaryAction(),
      graphScope: () => { state.graphScope = state.graphScope === 'focus' ? 'all' : 'focus'; renderGraph(); graph?.fit(); },
      back: () => state.contextNodeId && selectObject('nodes', state.contextNodeId),
      locate: ({ event, value }) => {
        if (event.key !== 'Enter' || !value.trim()) return;
        const match = M.buildDag(state.data, state.goalId).nodes.find(item => (item.title + ' ' + item.id).toLowerCase().includes(value.trim().toLowerCase()));
        if (match) { selectObject(match.objectType || 'nodes', match.objectId || match.id, false, match.goalId); graph?.fit(); }
        else notify('没有匹配的节点。');
      }
    } });
    const root = ui.root, { goalSelect, mode, refresh, message, request, libraryPreview, graphHost, detail, progress, work } = root.refs;
    host.replaceChildren(root);
    W?.renderIntake(request, libraryPreview);
    function syncIntake() {
      const intake = W?.intakeState?.() || {};
      const disclosure = root.refs.requestDisclosure;
      if (!state.intakeInitialized) {
        disclosure.open = !(state.data.goals || []).length;
        state.intakeInitialized = true;
      }
      if (intake.needsAttention && intake.attentionKey !== state.attentionKey) {
        disclosure.open = true; state.attentionKey = intake.attentionKey;
      }
      root.refs.requestSummary.textContent = intake.hasDraft ? '新建任务 · 有未提交内容' : '新建任务';
    }
    request.addEventListener('input', syncIntake);
    request.addEventListener('change', syncIntake);
    function notify(text, error = false) { message.textContent = text; message.hidden = !text; message.dataset.tone = error ? 'danger' : 'muted'; message.dataset.error = String(error); }
    function defaultNode() {
      if (!state.goalId) return null;
      const progress = M.buildProgress(state.data, state.goalId);
      return progress.current?.id || state.data.nodes?.find(item => item.supersededByRevision == null && (!state.goalId || item.goalId === state.goalId))?.id;
    }
    function contextNode(type, id) {
      if (type === 'nodes') return id;
      const item = state.data[type]?.find(entry => entry.id === id);
      if (item?.nodeId) return item.nodeId;
      const changeId = item?.changeSetId || item?.sourceChangeSetId;
      return state.data.changeSets?.find(entry => entry.id === changeId)?.nodeId || null;
    }
    function syncAddress() {
      nextNavigation = state.selected ? window.FwaNavigation.target(state.selected.type, state.selected.id, { goalId: state.selected.goalId || state.goalId })
        : { domainId: 'fwa-projection', fileName: 'projection.json' };
      void syncNavigation();
    }
    async function syncNavigation() {
      if (navigationBusy || state.disposed) return; navigationBusy = true;
      root.disabled = true; root.setAttribute('aria-busy', 'true');
      try {
        while (nextNavigation && !state.disposed) {
          const target = nextNavigation; nextNavigation = null;
          if (navigationSequence !== state.data.lastSequence) { await window.fwe.resources.refresh(); navigationSequence = state.data.lastSequence; }
          if (state.disposed) return;
          if (!await window.fwe.navigation.navigate(target, { updateUrl: true })) throw new Error('对象资源尚不可用，请刷新后重试。');
        }
      } catch (error) { if (!state.disposed) notify(error.message, true); }
      finally { navigationBusy = false; root.disabled = false; root.setAttribute('aria-busy', 'false'); }
    }
    function selectObject(type, id, _compat = false, goalId = null) {
      const nodeId = contextNode(type, id), item = state.data[type]?.find(entry => entry.id === id);
      const ownerGoal = goalId || (type === 'goals' ? id : item?.goalId) || state.data.nodes?.find(node => node.id === nodeId)?.goalId;
      if (ownerGoal && state.goalId !== ownerGoal) { state.goalId = ownerGoal; goalSelect.value = ownerGoal; }
      state.selected = { type, id, goalId: ownerGoal || state.goalId };
      if (nodeId) state.contextNodeId = nodeId;
      renderWorkspace(); syncAddress();
    }
    function selectGoal(id) {
      state.goalId = id || null; goalSelect.value = id || '';
      const nodeId = defaultNode(); state.contextNodeId = nodeId || null;
      state.selected = nodeId ? { type: 'nodes', id: nodeId, goalId: state.goalId } : null;
      renderWorkspace(); graph?.fit(); syncAddress();
    }
    function followRevisedSelection(previous, current) {
      if (state.selected?.type !== 'nodes') return false;
      const selected = previous.nodes?.find(node => node.id === state.selected.id);
      // Only follow a result that was current when selected. Opening an explicit
      // historical record must continue to show that record across refreshes.
      if (!selected || selected.supersededByRevision != null) return false;
      const retained = current.nodes?.find(node => node.id === selected.id);
      if (retained && retained.supersededByRevision == null) return false;
      if (!current.goals.some(goal => goal.id === selected.goalId)) return false;
      const successor = current.nodes.find(node => node.goalId === selected.goalId && node.supersededByRevision == null
        && (node.logicalId || node.id) === (selected.logicalId || selected.id));
      state.goalId = selected.goalId;
      if (successor) {
        state.selected = { type: 'nodes', id: successor.id, goalId: state.goalId };
        state.contextNodeId = successor.id;
      } else {
        // A derived replacement can have several valid results. Show the goal's
        // current graph and let the user choose, rather than picking a child.
        state.selected = { type: 'goals', id: state.goalId, goalId: state.goalId };
        state.contextNodeId = null; state.graphScope = 'all';
      }
      return true;
    }
    function renderDetail() {
      if (!state.selected) { detail.replaceChildren(ui.render('emptySelection')); inspectorView = null; inspectorKey = ''; return; }
      const { type, id } = state.selected, key = JSON.stringify(state.selected);
      if (inspectorKey !== key || !inspectorView?.isConnected) {
        inspectorKey = key; inspectorView = ui.render('inspector'); detail.replaceChildren(inspectorView); detail.scrollTop = 0;
      }
      const { facts, feedback, links, back } = inspectorView.refs;
      back.hidden = type === 'nodes' || !state.contextNodeId;
      // Feedback owns its input and remains mounted across live snapshots.
      const expanded = new Set([...facts.querySelectorAll('details')].filter(item => item.open && !item.dataset.fwaCandidateId).map(item => item.querySelector('summary')?.textContent));
      facts.replaceChildren(); links.replaceChildren(); feedback.hidden = type !== 'nodes';
      const renderer = { nodes: C.node, refs: C.ref, runs: C.run, changeSets: C.changeSet, evidence: C.evidence }[type];
      if (renderer) { void renderer(facts, id); if (type === 'nodes') W?.nodeFeedback(feedback, id); }
      else if (type === 'groups') W?.renderGroup(facts, id, state.selected.goalId || state.goalId);
      else if (type === 'goals') {
        const goal = state.data.goals.find(item => item.id === id);
        facts.append(ui.render('recordTitle', { title: goal?.title || id }),
          ui.render('notice', { text: '当前结果显示在任务图中；选择一个节点，查看目标、完成条件和前置原因。', tone: 'muted' }));
      }
      else {
        const item = state.data[type]?.find(entry => entry.id === id);
        facts.append(ui.render('recordTitle', { title: item?.title || id }));
        if (item) { facts.append(C.metadata({ '状态': M.statusLabel(item.status || item.result) }), C.record(item)); C.artifactLinks(facts, item); }
      }
      links.append(window.FwaSurface.resourceLink(type, id, '单独打开此记录', { goalId: state.selected.goalId || state.goalId }));
      for (const item of facts.querySelectorAll('details')) if (!item.dataset.fwaCandidateId && expanded.has(item.querySelector('summary')?.textContent)) item.open = true;
    }
    function renderGraph() {
      const full = M.buildDag(state.data, state.goalId);
      const selectedId = full.nodes.some(node => node.id === state.contextNodeId) ? state.contextNodeId : null;
      let data = full;
      if (state.graphScope === 'focus' && selectedId) {
        const visible = new Set([selectedId]);
        for (const edge of full.edges) {
          if (edge.target === selectedId) visible.add(edge.source);
          if (edge.source === selectedId) visible.add(edge.target);
        }
        data = { nodes: full.nodes.filter(node => visible.has(node.id)),
          edges: full.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target)) };
      }
      root.refs.graphScope.disabled = !selectedId;
      root.refs.graphScope.textContent = !selectedId ? '全部任务' : state.graphScope === 'focus' ? '查看全图' : '聚焦当前节点';
      root.refs.graphScopeNote.textContent = state.graphScope === 'focus' && selectedId
        ? '当前节点与直接依赖 · ' + data.nodes.length + ' / ' + full.nodes.length
        : '全部 ' + full.nodes.length + ' 项 · 箭头表示前置依赖';
      const revision = JSON.stringify(data);
      if (graph) {
        if (revision !== graphRevision) graph.update({ ...data, selectedId });
        else graph.select(selectedId || null);
      } else graph = window.fwe.ui.createGraph({ host: graphHost, ...data, selectedId, layout: 'dag', onSelect(id) {
        if (!id) return;
        const item = M.buildDag(state.data, state.goalId).nodes.find(node => node.id === id);
        selectObject(item?.objectType || 'nodes', item?.objectId || id, false, item?.goalId);
      } });
      graphRevision = revision;
    }
    function renderWorkspace() {
      const overview = M.buildOverview(state.data, state.session, state.goalId, state.workbench?.jobs);
      progress.textContent = overview.progressText;
      mode.hidden = state.session?.allowWrite !== false;
      work.hidden = !overview.actionKind || overview.actionKind === 'focus' && state.selected?.type === 'nodes' && overview.focusId === state.contextNodeId;
      work.disabled = !state.fresh || overview.actionKind === 'work' && !availability().allowed;
      work.textContent = overview.actionKind === 'work' ? '继续' : overview.actionLabel || '继续';
      root.refs.workReason.textContent = overview.nextText;
      syncIntake();
      renderGraph(); renderDetail();
    }
    function primaryAction() {
      const overview = M.buildOverview(state.data, state.session, state.goalId, state.workbench?.jobs);
      if (overview.actionKind === 'work') return startWork();
      if (overview.actionKind === 'focus' && overview.focusId) selectObject('nodes', overview.focusId);
    }
    function availability(nodeId) {
      if (!state.fresh) return { allowed: false, reason: '快照失联，请刷新后再继续。' };
      if (state.pendingCommands.size) return { allowed: false, reason: '操作正在提交。' };
      const goalId = nodeId ? state.data.nodes.find(item => item.id === nodeId)?.goalId : state.goalId;
      return M.workAvailability(state.data, state.session, goalId, nodeId, state.workbench?.jobs);
    }
    async function startWork() {
      const action = availability(); if (!action.allowed) { notify(action.reason, true); return; }
      work.disabled = true;
      try {
        const goalId = state.goalId;
        if (!goalId) throw new Error('请先选择一个目标。');
        await workflowCommand('workflow.work', { goalId });
        notify('已继续当前目标，检查与后续任务将自动推进。'); await refreshData(true);
      } catch (error) { notify(error.message, true); }
      finally { if (!state.disposed) work.disabled = !availability().allowed; }
    }
    async function refreshData(announce = false) {
      if (refreshing || state.disposed) return; refreshing = true; refresh.disabled = true;
      try {
        if (!state.session) {
          const session = await api('/api/fwa/session'), advertised = ctx.app.labels?.fwaConsole;
          if (session.protocol !== PROTOCOL || advertised?.protocol !== PROTOCOL || session.fingerprint !== advertised.fingerprint) throw new Error('组件指纹不一致，请重启服务并刷新页面。');
          state.session = session;
        }
        const data = await api('/api/fwa/status?view=summary');
        if (state.disposed) return;
        if (data.projectId !== state.session.projectId || data.projectRoot !== state.session.projectRoot) throw new Error('项目身份已变化，请重启控制台。');
        const workbench = await api('/api/fwa/workbench'); if (state.disposed) return;
        const jobsRevision = JSON.stringify(workbench.jobs);
        const changed = data.lastSequence !== state.data.lastSequence || JSON.stringify(data.operational) !== JSON.stringify(state.data.operational)
          || JSON.stringify(data.retryDiagnostics) !== JSON.stringify(state.data.retryDiagnostics) || jobsRevision !== state.jobsRevision;
        const followedRevision = !pendingSelection && followRevisedSelection(state.data, data);
        state.jobsRevision = jobsRevision; state.workbench = workbench; state.data = data; state.fresh = true;
        W?.refresh(workbench);
        if (!initialized && data.goals.length === 1) state.goalId = data.goals[0].id;
        if (state.goalId && !data.goals.some(goal => goal.id === state.goalId)) state.goalId = null;
        ui.setOptions(goalSelect, [{ label: '全部目标', value: '' }, ...data.goals.map(goal => ({ label: goal.title, value: goal.id }))], state.goalId || '');
        if (!initialized || !state.selected) {
          const id = defaultNode(); state.selected = id ? { type: 'nodes', id, goalId: state.goalId } : null; state.contextNodeId = id || null;
        }
        if (pendingSelection) {
          state.selected = pendingSelection; pendingSelection = null;
          state.contextNodeId = contextNode(state.selected.type, state.selected.id);
          state.goalId = state.selected.goalId || data.nodes.find(item => item.id === state.contextNodeId)?.goalId || state.goalId;
          goalSelect.value = state.goalId || '';
        }
        if (!initialized || changed || announce) renderWorkspace(); initialized = true;
        if (followedRevision) { graph?.fit(); syncAddress(); }
      } catch (error) {
        state.fresh = false; W?.refresh(state.workbench); work.disabled = true;
        notify(error.message + ' 当前显示的是上次快照。', true);
      } finally { refreshing = false; refresh.disabled = false; }
    }
    goalSelect.addEventListener('change', () => selectGoal(goalSelect.value));
    const dispose = () => {
      if (state.disposed) return; state.disposed = true; clearInterval(timer); graph?.destroy(); W?.dispose(); C.dispose?.(); ui.dispose();
      window.removeEventListener('pagehide', dispose);
    };
    timer = setInterval(() => { if (!root.isConnected) dispose(); else if (!document.hidden) void refreshData(); }, 5000);
    window.addEventListener('pagehide', dispose, { once: true });
    void refreshData(); return { root, dispose, update(next) {
      const key = JSON.stringify(next.data?._fwaSelection || null);
      if (navigationBusy) { navigationKey = key; return; }
      if (key === navigationKey) return;
      navigationKey = key; pendingSelection = next.data?._fwaSelection;
      if (!pendingSelection) { state.selected = null; state.contextNodeId = null; }
      void refreshData(true);
    } };
  }
  window.fwe.registerView('fwa-console', {
    noInspector: () => true,
    render(ctx) {
      ctx.showView('document'); const host = ctx.hosts.documentTree;
      const existing = mounted.get(host);
      if (!existing?.root?.isConnected) { existing?.dispose(); mounted.set(host, mount(host, ctx)); }
      else existing.update(ctx);
    }
  });
}());
