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
      host.textContent = '可视化组件尚未加载。请使用包含 graph-component 的 FWE，重启服务并刷新页面。';
      return null;
    }
    window.FwaSurface.configure(ctx);
    const sections = window.FwaSurface.config('console').sections;
    const state = { section: 'intake', data: ctx.data, session: null, goalId: null, selected: null,
      refsMode: 'cards', nodeMode: 'graph', search: '', drafts: {}, pendingCommands: new Set(), fresh: false, disposed: false, jobsRevision: '', workbenchJobs: [] };
    let graph, journal, eventsView, refreshing = false, currentPanel = '', panelGeneration = 0, timer;
    let navigationKey = JSON.stringify(ctx.data?._fwaSelection || null), pendingSelection = ctx.data?._fwaSelection;
    let navigationBusy = false, nextNavigation = null, navigationSequence = ctx.data?.lastSequence;
    let inspectorView = null, inspectorKey = '';
    const C = window.FwaWorkbenchContent.create({ api, select: selectObject, getStatus: () => state.data,
      command: workflowCommand, getSession: () => state.session, refresh: () => refreshData(true),
      retry(id) { state.drafts['node.retry'] = { ...(state.drafts['node.retry'] || {}), nodeId: id }; showSection('commands'); } });
    const { metadata, record } = C;
    const W = window.FwaWorkflowPanel?.create({ api, command: workflowCommand, C,
      getStatus: () => state.data, getSession: () => state.session,
      selectNode: id => selectObject('nodes', id),
      openGoal(id) { state.goalId = id; goalSelect.value = id; renderSummary(); showSection('progress'); },
      refresh: () => refreshData(true) });
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
        journal.acknowledge(type, intent, commandId);
        return response.result;
      } finally { state.pendingCommands.delete(type); }
    }
    const ui = window.FwaSurface.create('console', { data: { section: state.section, title: '项目工作台' }, actions: {
      refresh: () => refreshData(true), section: ({ element }) => { if (state.session) showSection(element.dataset.section); },
      events: () => showSection('events'), noop() {},
      object: ({ element }) => selectObject(element.dataset.objectType, element.dataset.objectId),
      changeSelected: ({ value }) => { if (value) selectObject('changeSets', value); },
      progressChange: ({ element }) => selectObject('changeSets', element.dataset.changeId),
      progressNode: ({ element }) => selectObject('nodes', element.dataset.nodeId, true),
      search: ({ value, data }) => { state.search = value; if (!data.isGraph) renderCards(); },
      locate: ({ event, value, data }) => locate(event, value, data.isGraph),
      toggle: () => {
        if (state.section === 'refs') state.refsMode = state.refsMode === 'graph' ? 'cards' : 'graph';
        else state.nodeMode = state.nodeMode === 'graph' ? 'list' : 'graph';
        renderPanel(true);
      }, fit: () => graph?.fit(), work: ({ element }) => startWork(element),
      draft: ({ element, data }) => { state.drafts[data.commandType][element.name] = element.value; },
      command: ({ element, data, refs }) => submitCommand(element, data, refs)
    } });
    const t = (key, vars) => ui.text(key, vars);
    const root = ui.root, { goalToolbar, goalSelect, mode, refresh, tabs, advanced, message, body, panelTitle, panelActions, main, detail, history, historyContent } = root.refs;
    host.replaceChildren(root);
    function notify(text, error = false) { message.textContent = text; message.hidden = !text; message.dataset.tone = error ? 'danger' : 'muted'; message.dataset.error = String(error); }
    function notice(text, tone = 'muted') { return ui.render('notice', { text, tone }); }
    function tone(value) { return ({ active: 'info', neutral: 'default' })[M.tone(value)] || M.tone(value); }
    function goalRows(key) {
      const rows = state.data[key] || [];
      if (!state.goalId) return rows;
      const ids = new Set(state.data.nodes.filter(item => item.goalId === state.goalId).map(item => item.id));
      return rows.filter(item => item.goalId === state.goalId || ids.has(item.nodeId));
    }
    function visibleRefs() {
      if (!state.goalId) return state.data.refs;
      const ids = new Set(M.buildRefs(state.data, state.goalId).nodes.filter(n => n.id.startsWith('ref://')).map(n => n.id));
      return state.data.refs.filter(item => ids.has(item.id));
    }
    function defaultNode() {
      const rows = goalRows('nodes');
      return rows.find(item => ['rejected', 'failed', 'blocked'].includes(item.status)) || rows.find(item => item.status === 'running') || rows[0];
    }
    function renderSummary() {
      goalToolbar.hidden = !state.data.goals.length || state.section === 'intake';
      mode.hidden = state.session?.allowWrite !== false;
    }
    function syncAddress() {
      const selection = state.selected;
      const objectSection = selection?.type === 'groups' ? 'nodes' : ['goals', 'integrations', 'reversions', 'evaluations'].includes(selection?.type) ? 'project' : selection?.type;
      nextNavigation = selection && (state.section === objectSection || state.section === 'refs' && selection.type === 'nodes')
        ? window.FwaNavigation.target(selection.type, selection.id, { goalId: selection.goalId || state.goalId })
        : { domainId: 'fwa-projection', fileName: 'projection.json' };
      void syncNavigation();
    }
    async function syncNavigation() {
      if (navigationBusy || state.disposed) return;
      navigationBusy = true;
      // Match FWE's inert resource-loading boundary with a native disabled
      // fieldset: controls must not appear editable before the resource opens.
      root.disabled = true; root.setAttribute('aria-busy', 'true');
      try {
        while (nextNavigation && !state.disposed) {
          const target = nextNavigation; nextNavigation = null;
          if (navigationSequence !== state.data.lastSequence) {
            await window.fwe.resources.refresh(); navigationSequence = state.data.lastSequence;
          }
          if (state.disposed) return;
          const selected = await window.fwe.navigation.navigate(target, { updateUrl: true });
          if (!selected) throw new Error('FWE 对象资源尚不可用，请刷新后重试。');
        }
      } catch (error) { if (!state.disposed) notify(error.message, true); }
      finally { navigationBusy = false; root.disabled = false; root.setAttribute('aria-busy', 'false'); }
    }
    function selectObject(type, id, keepSection = false, goalId = null) {
      const item = state.data[type]?.find(entry => entry.id === id);
      const ownerGoal = goalId || (type === 'goals' ? id : item?.goalId) || state.data.nodes.find(node => node.id === item?.nodeId)?.goalId;
      const scopeChanged = !!(state.goalId && ownerGoal && state.goalId !== ownerGoal);
      if (scopeChanged) { state.goalId = ownerGoal; goalSelect.value = ownerGoal; renderSummary(); }
      state.selected = { type, id, goalId: ownerGoal || null };
      // Native navigation updates FWE resource identity without replacing this
      // controller; command and feedback drafts remain owned by their surfaces.
      const section = type === 'groups' ? 'nodes' : ['goals', 'integrations', 'reversions', 'evaluations'].includes(type) ? 'project' : type;
      if ((!keepSection && sections.some(([key]) => key === section) && state.section !== section) || scopeChanged) {
        if (!keepSection) state.section = section;
        state.search = ''; renderPanel(true);
      } else {
        const graphId = type === 'groups' ? M.buildDag(state.data, state.goalId).nodes.find(item => item.objectId === id && item.goalId === (goalId || state.goalId))?.id : state.section === 'refs' && type === 'nodes' ? `node:${id}` : id;
        graph?.select(graphId);
        for (const card of main.querySelectorAll('[data-object-id]')) card.setAttribute('aria-pressed', String(card.dataset.objectId === id));
        renderDetail(); renderHistory();
      }
      syncAddress();
    }
    function showSection(section) {
      state.section = section; state.search = '';
      if (section === 'progress') state.selected = null;
      if (section === 'nodes' && state.selected?.type !== 'nodes') state.selected = defaultNode() ? { type: 'nodes', id: defaultNode().id } : null;
      if (section === 'refs' && state.selected?.type !== 'refs') state.selected = visibleRefs()[0] ? { type: 'refs', id: visibleRefs()[0].id } : null;
      if (['runs', 'changeSets', 'evidence'].includes(section) && state.selected?.type !== section) {
        const first = goalRows(section).at(-1); state.selected = first ? { type: section, id: first.id } : null;
      }
      renderPanel(true);
      syncAddress();
    }
    function renderDetail() {
      if (state.section === 'intake') return;
      detail.hidden = state.section === 'progress' && state.selected?.type !== 'nodes' || state.section === 'changeSets' && !state.selected;
      if (detail.hidden) return;
      if (state.section === 'commands') {
        detail.replaceChildren(ui.render('boundaries'));
        return;
      }
      if (!state.selected) { detail.replaceChildren(notice(t('emptySelection'))); return; }
      const { type, id } = state.selected;
      const key = JSON.stringify(state.selected);
      if (key !== inspectorKey || !inspectorView?.isConnected) {
        inspectorKey = key; inspectorView = ui.render('inspector');
        detail.replaceChildren(inspectorView); detail.scrollTop = 0;
      }
      const { facts, feedback, links } = inspectorView.refs;
      facts.replaceChildren(); links.replaceChildren();
      const renderers = { nodes: C.node, refs: C.ref, runs: C.run, changeSets: C.changeSet, evidence: C.evidence };
      if (renderers[type]) { void renderers[type](facts, id); if (type === 'nodes') W?.nodeFeedback(feedback, id); }
      else if (type === 'groups') W?.renderGroup(facts, id, state.selected.goalId || state.goalId);
      else if (type === 'goals') {
        const goal = state.data.goals.find(item => item.id === id);
        if (goal) { const view = ui.render('goal', { ...goal, status: M.statusLabel(goal.status) }); view.refs.record.append(record(goal)); facts.append(view); }
      }
      else {
        const item = state.data[type]?.find(entry => entry.id === id);
        if (item) { const info = ui.render('integration', { title: type === 'evaluations' ? '验收执行记录' : '集成 / 回退记录' }); info.refs.facts.append(C.badge(item.status || item.result), metadata({ '目标': item.targetRef, '版本': item.candidateRevision }), record(item)); facts.append(info); C.artifactLinks(facts, item); }
      }
      links.append(window.FwaSurface.resourceLink(type, id, '新窗口查看', { goalId: state.selected.goalId || state.goalId }));
    }
    function renderHistory() {
      history.hidden = ['intake', 'changeSets', 'progress'].includes(state.section);
      historyContent.replaceChildren();
      if (history.hidden) return;
      const selected = state.selected;
      const nodeId = selected?.type === 'nodes' ? selected.id : state.data[selected?.type]?.find(item => item.id === selected?.id)?.nodeId;
      const runs = nodeId ? state.data.runs.filter(item => item.nodeId === nodeId) : goalRows('runs');
      const rows = runs.map((run, index) => {
        const node = state.data.nodes.find(item => item.id === run.nodeId);
        return { id: run.id, attempt: `ATTEMPT ${index + 1} · ${run.executor?.id || '未记录'}`, title: node?.title || run.nodeId,
          statusLabel: M.statusLabel(run.status), tone: tone(run.status), summary: run.failure?.message || run.summary || '尚无终态结果' };
      });
      historyContent.append(ui.render('history', { scope: nodeId || '当前目标', runs: rows, emptyText: '此范围尚无执行记录。' }));
    }
    function createCard(type, item) {
      const data = { type, id: item.id, selected: state.selected?.id === item.id };
      if (type === 'refs') {
        Object.assign(data, { title: item.uri, uri: item.uri, extra: item.kind,
          image: /\.(png|jpe?g|webp|gif|svg)$/i.test(item.uri) && !/[?*]/.test(item.uri)
            ? `/api/fwa/refs/content?id=${encodeURIComponent(item.id)}&raw=1` : undefined,
          cover: /\.md$/i.test(item.uri) ? 'DOC' : item.kind.toUpperCase() });
      } else {
        const node = state.data.nodes.find(entry => entry.id === (type === 'nodes' ? item.id : item.nodeId));
        const status = type === 'evidence' ? item.result : item.status;
        Object.assign(data, { title: node?.title || item.title || item.kind || type,
          extra: type === 'changeSets' ? `${item.changedFiles?.length ?? 0} 个文件 · ${item.stats?.diffLines ?? '未记录'} 行差异` : '',
          statusLabel: type === 'changeSets' ? '' : M.statusLabel(status), tone: tone(status), isNode: type === 'nodes',
          validity: M.statusLabel(item.validity), integration: M.statusLabel(item.integrationStatus), failure: item.failure?.message });
        if (type === 'changeSets') {
          const reviewed = state.workbenchJobs.some(job => job.type === 'change.accept' && job.state === 'succeeded'
            && job.result?.changeSetId === item.id && job.result?.headRevision === item.headRevision
            && job.result?.configFingerprint === state.session?.review?.fingerprint
            && node?.acceptanceEvidenceIds?.includes(job.result?.evidenceId));
          data.statusLabel = item.kind === 'revert' ? '撤销记录' : item.revertedByReversionId ? '已撤销'
            : !item.changedFiles?.length ? '无变化 · 需检查' : !item.valid ? '范围检查未通过'
              : node?.changeSetIds?.at(-1) !== item.id || node?.validity !== 'valid' ? '历史 / 已过期候选'
                : node.integratedChangeSetId === item.id && node.integrationStatus === 'integrated' ? '已采用'
                  : reviewed ? '人工验收已记录 · 待采用' : node.acceptedChangeSetId === item.id ? '验证通过 · 待人工验收' : '候选 · 待验证';
          data.tone = item.valid === false ? 'danger' : node?.integratedChangeSetId === item.id ? 'success' : 'muted';
        }
      }
      return data;
    }
    function renderCards() {
      const rows = state.section === 'refs' ? visibleRefs() : goalRows(state.section), query = state.search.toLowerCase();
      const items = rows.filter(entry => !query || JSON.stringify([entry.id, entry.title, entry.uri, entry.nodeId]).toLowerCase().includes(query))
        .map(item => createCard(state.section, item));
      main.replaceChildren(ui.render('cards', { items, collection: state.section, emptyText: t(rows.length ? 'noMatch' : 'empty') }));
    }
    function renderChanges() {
      const expanded = main.querySelector('details')?.open || false;
      const items = [...goalRows('changeSets')].reverse().map(item => createCard('changeSets', item));
      const view = ui.render('changePicker', { items, empty: !items.length });
      main.replaceChildren(view);
      ui.setOptions(view.refs.changeSelect, items.map(item => ({ value: item.id, label: `${item.title} · ${item.statusLabel}` })), state.selected?.id || '');
      view.refs.changeSelect.disabled = !items.length;
      view.refs.allChanges.open = expanded;
    }
    function renderProgress() {
      const items = goalRows('nodes').filter(item => item.supersededByRevision == null).map(item => {
        const changeId = item.changeSetIds?.at(-1), change = state.data.changeSets.find(value => value.id === changeId);
        const latestRun = state.data.runs.find(value => value.id === item.runIds?.at(-1));
        return { ...createCard('nodes', item), changeId,
          statusLabel: change ? createCard('changeSets', change).statusLabel : M.statusLabel(item.status),
          failure: latestRun?.failure?.message || item.failure?.message };
      });
      main.replaceChildren(ui.render('progress', { items }));
    }
    function renderGraph() {
      const refGraph = state.section === 'refs';
      const data = refGraph ? M.buildRefs(state.data, state.goalId) : M.buildDag(state.data, state.goalId);
      const selectedId = state.selected?.type === 'groups'
        ? data.nodes.find(item => item.objectId === state.selected.id && item.goalId === (state.selected.goalId || state.goalId))?.id
        : refGraph && state.selected?.type === 'nodes' ? `node:${state.selected.id}` : state.selected?.id;
      if (graph) { graph.update({ ...data, selectedId }); return; }
      const fragment = ui.render('graph', { graphTestId: refGraph ? 'fwa-refs-graph' : 'fwa-dag', note: t(refGraph ? 'refsNote' : 'graphNote') });
      main.replaceChildren(fragment);
      const { graphHost } = fragment.refs;
      graph = window.fwe.ui.createGraph({ host: graphHost, ...data, selectedId, layout: refGraph ? 'relations' : 'dag', onSelect(id) {
        if (!id) { state.selected = null; renderDetail(); syncAddress(); return; }
        if (refGraph) selectObject(id.startsWith('node:') ? 'nodes' : 'refs', id.startsWith('node:') ? id.slice(5) : id, true);
        else {
          const item = M.buildDag(state.data, state.goalId).nodes.find(node => node.id === id);
          selectObject(item?.objectType === 'groups' ? 'groups' : 'nodes', item?.objectId || id, true, item?.goalId);
        }
      } });
    }
    function renderProject() {
      main.replaceChildren();
      main.append(metadata({ '项目目录': state.data.projectRoot, '项目标识': state.data.projectId, '事件序号': state.data.lastSequence, 'FWE': state.session.fweVersion }));
      for (const goal of state.data.goals.filter(item => !state.goalId || item.id === state.goalId)) {
        const view = ui.render('goal', { ...goal, status: M.statusLabel(goal.status) }); view.refs.record.append(record(goal, '目标记录')); main.append(view);
      }
      const operational = state.data.operational;
      const safety = ui.render('safety', { message: t(operational?.gitProcessFence?.held || operational?.workspaceLease?.held ? 'blocked' : 'safe') });
      safety.refs.record.append(record(operational, 'Fence / Lease 详情')); main.append(safety);
      for (const [key, label] of [['integrations', '集成历史'], ['reversions', '回滚历史']]) {
        const view = ui.render('objectHistory', { title: `${label} · ${goalRows(key).length}` });
        for (const item of goalRows(key)) view.refs.links.append(window.FwaSurface.resourceLink(key, item.id, `${M.statusLabel(item.status)} · ${item.id}`,
          { onSelect: () => selectObject(key, item.id, true) }));
        main.append(view);
      }
    }
    async function submitCommand(form, data, { submit, result }) {
      const type = data.commandType;
      if (submit.disabled || !state.fresh || state.pendingCommands.has(type)) return;
      try {
          const payload = Object.fromEntries([...form.querySelectorAll('input[name],textarea[name]')].map(input => [input.name, input.value.trim()]));
          if (type === 'plan.load') payload.plan = JSON.parse(payload.plan);
          journal ||= createCommandJournal(window.sessionStorage, state.session.projectId);
          const commandId = journal.begin(type, payload); state.pendingCommands.add(type); syncCommandInputs(); result.textContent = t('submitting', { commandId });
          const response = await api('/api/fwa/commands', { method: 'POST', headers: { 'Content-Type': 'application/json',
            'X-FWA-CSRF': state.session.csrfToken, 'X-FWA-Fingerprint': state.session.fingerprint }, body: JSON.stringify({ type, commandId, payload }) });
          journal.acknowledge(type, payload, commandId);
          result.textContent = t('success', { label: form.querySelector('h3').textContent, replay: response.result.appended === false ? '（幂等重放）' : '', commandId: response.commandId });
          await refreshData(true);
      } catch (error) { result.textContent = t('retryError', { message: error.message }); }
      finally { state.pendingCommands.delete(type); syncCommandInputs(); }
    }
    function syncCommandInputs() {
      for (const form of main.querySelectorAll('form[data-command-type]')) {
        const pending = state.pendingCommands.has(form.dataset.commandType);
        for (const field of form.querySelectorAll('input,textarea')) field.disabled = pending;
        form.querySelector('button[type=submit]').disabled = pending || !state.session?.allowWrite || !state.fresh;
      }
    }
    function renderCommands() {
      main.replaceChildren();
      if (!state.session.allowWrite) { main.append(notice(t('readonly'), 'info')); return; }
      main.append(notice(t('commandNotice'), 'info'));
      state.drafts['plan.load'] ||= { goalId: state.goalId || '' };
      for (const type of ['goal.create', 'plan.load', 'node.retry']) {
        const draft = state.drafts[type] ||= {};
        main.append(ui.render(type, { ...draft, commandType: type, disabled: !state.session.allowWrite || !state.fresh }));
      }
      syncCommandInputs();
    }
    function locate(event, query, isGraph) {
      if (event.key !== 'Enter' || !isGraph) return;
      const data = state.section === 'refs' ? M.buildRefs(state.data, state.goalId) : M.buildDag(state.data, state.goalId);
      const match = data.nodes.find(item => `${item.title} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
      if (match) {
        const type = match.id.startsWith('ref://') ? 'refs' : state.data.nodes.some(item => item.id === match.id || `node:${item.id}` === match.id) ? 'nodes' : 'groups';
        selectObject(type, match.objectId || (match.id.startsWith('node:') ? match.id.slice(5) : match.id), true, match.goalId); graph.fit();
      } else notify(t('noMatch'));
    }
    async function startWork(button) {
      button.disabled = true;
      try { await workflowCommand('workflow.work', { goalId: state.goalId }); notify(t('workAccepted')); await refreshData(true); }
      catch (error) { notify(error.message, true); }
      finally { if (button.isConnected) button.disabled = !state.fresh || !state.session?.workflow?.work; }
    }
    function renderPanel(force = false) {
      const kind = `${state.section}:${state.refsMode}:${state.nodeMode}`;
      if (force || currentPanel !== kind) { graph?.destroy(); graph = null; eventsView = null; panelGeneration++; currentPanel = kind; }
      ui.update({ section: state.section }, tabs);
      const simple = ['intake', 'changeSets', 'progress'].includes(state.section);
      if (!simple) advanced.open = true;
      renderSummary();
      body.dataset.columns = simple ? '1' : '2';
      if (state.section !== 'intake') detail.hidden = false;
      panelTitle.textContent = sections.find(([key]) => key === state.section)[1]; panelActions.replaceChildren();
      panelTitle.hidden = simple;
      const isGraph = (state.section === 'nodes' && state.nodeMode === 'graph') || (state.section === 'refs' && state.refsMode === 'graph');
      body.dataset.layout = isGraph ? 'graph' : 'browser';
      panelActions.append(ui.render('panelActions', { search: state.search, isGraph,
        searchable: ['nodes', 'refs', 'runs', 'evidence'].includes(state.section),
        searchPlaceholder: isGraph ? '输入名称，按 Enter 定位' : '筛选名称 / ID',
        toggleVisible: ['nodes', 'refs'].includes(state.section), toggleLabel: isGraph ? (state.section === 'refs' ? '资源卡片' : '列表') : '关系图',
        workVisible: ['nodes', 'progress'].includes(state.section) && state.goalId && state.session?.allowWrite,
        workDisabled: !state.fresh || !state.session?.workflow?.work }));
      if (isGraph) renderGraph();
      else if (state.section === 'intake') { if (force || !main.querySelector('[data-fwa-intake]')) W?.renderIntake(main, detail); }
      else if (state.section === 'changeSets') renderChanges();
      else if (state.section === 'progress') renderProgress();
      else if (state.section === 'project') renderProject();
      else if (state.section === 'commands') { if (force || !main.querySelector('form')) renderCommands(); }
      else if (state.section === 'events') {
        if (force) {
          const generation = panelGeneration;
          void C.events(main).then(view => { if (state.section === 'events' && panelGeneration === generation) eventsView = view; });
        }
        else void eventsView?.refresh();
      } else renderCards();
      renderDetail(); renderHistory();
    }
    async function refreshData(announce = false) {
      if (refreshing || state.disposed) return; refreshing = true; refresh.disabled = true;
      try {
        if (!state.session) {
          const session = await api('/api/fwa/session'), advertised = ctx.app.labels?.fwaConsole;
          if (session.protocol !== PROTOCOL || advertised?.protocol !== PROTOCOL || session.fingerprint !== advertised.fingerprint) throw new Error('组件指纹不一致，请重启服务并刷新页面。');
          state.session = session;
        }
        const data = await api('/api/fwa/status');
        if (state.disposed) return;
        if (data.projectId !== state.session.projectId || data.projectRoot !== state.session.projectRoot) throw new Error('项目身份已变化，请重启控制台。');
        const first = !state.fresh && !currentPanel;
        const workbench = await api('/api/fwa/workbench');
        const jobsRevision = JSON.stringify(workbench.jobs);
        const changed = data.lastSequence !== state.data.lastSequence || JSON.stringify(data.operational) !== JSON.stringify(state.data.operational) || jobsRevision !== state.jobsRevision;
        state.jobsRevision = jobsRevision;
        state.workbenchJobs = workbench.jobs;
        state.data = data; state.fresh = true;
        if (W) W.refresh(workbench);
        if (state.disposed) return;
        const goalsChanged = [...goalSelect.options].map(item => item.value).join('|') !== [''].concat(data.goals.map(item => item.id)).join('|');
        if (goalsChanged) {
          ui.setOptions(goalSelect, [{ label: t('allGoals'), value: '' }, ...data.goals.map(goal => ({ label: goal.title, value: goal.id }))], state.goalId || '');
          if (first && data.goals.length === 1) state.goalId = data.goals[0].id;
          if (state.goalId && !data.goals.some(goal => goal.id === state.goalId)) state.goalId = null;
          goalSelect.value = state.goalId || '';
        }
        if (first) state.selected = defaultNode() ? { type: 'nodes', id: defaultNode().id } : null;
        if (pendingSelection) {
          const selection = pendingSelection; pendingSelection = null;
          state.goalId = selection.goalId || null; goalSelect.value = state.goalId || '';
          state.selected = { type: selection.type, id: selection.id, goalId: selection.goalId };
          state.section = sections.some(([key]) => key === selection.type) ? selection.type : selection.type === 'groups' ? 'nodes' : 'project';
          renderPanel(true);
        }
        renderSummary(); if (first || changed || announce) renderPanel(first);
        syncCommandInputs();
        notify('');
      } catch (error) {
        state.fresh = false; syncCommandInputs();
        notify(`${error.message} 当前显示的是上次快照。`, true);
      } finally { refreshing = false; refresh.disabled = false; }
    }
    goalSelect.addEventListener('change', () => {
      state.goalId = goalSelect.value || null; state.selected = defaultNode() ? { type: 'nodes', id: defaultNode().id } : null;
      renderSummary(); showSection(state.section);
    });
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
      if (!pendingSelection) { state.selected = null; showSection('intake'); }
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
