(function () {
  'use strict';
  const PROTOCOL = 'fwa-console-v1';
  const sections = [
    ['project', '项目'], ['goals', '目标 Goals'], ['nodes', '依赖节点 DAG'], ['runs', '执行 Runs'],
    ['evidence', '验收证据'], ['changeSets', '变更集'], ['refs', '引用 Refs'],
    ['integrations', '集成记录'], ['reversions', '回滚记录'], ['operational', '安全阻断']
  ];
  const mounted = new WeakMap();
  // The pending identity belongs to the project+intent, not a disposable form.
  // sessionStorage survives view redraws and page reloads in this browser tab.
  function createCommandJournal(storage, projectId, makeId = () => `console-${crypto.randomUUID()}`) {
    const keyFor = (type, payload) => `fwa.console.pending.v1:${projectId}:${type}:${JSON.stringify(payload)}`;
    return {
      begin(type, payload) {
        const key = keyFor(type, payload);
        const recorded = storage.getItem(key);
        if (recorded !== null) {
          const value = JSON.parse(recorded);
          if (typeof value.commandId !== 'string' || !/^console-[A-Za-z0-9-]+$/.test(value.commandId)) throw new Error('待确认命令 ID 记录损坏，请先通过 CLI 核对事件。');
          return value.commandId;
        }
        const commandId = makeId();
        // Storage errors abort before sending, so a lost response cannot lose its id.
        storage.setItem(key, JSON.stringify({ commandId }));
        return commandId;
      },
      acknowledge(type, payload, commandId) {
        const key = keyFor(type, payload);
        const recorded = storage.getItem(key);
        if (recorded !== null && JSON.parse(recorded).commandId === commandId) storage.removeItem(key);
      }
    };
  }
  // Small pure state contract also exercised without a browser/network in tests.
  window.FwaConsoleCommandJournal = createCommandJournal;
  function element(tag, text, className) {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = String(text);
    if (className) value.className = className;
    return value;
  }
  function details(value, title = '查看记录') {
    const root = element('details', undefined, 'fwa-record');
    root.append(element('summary', title), element('pre', JSON.stringify(value, null, 2)));
    return root;
  }
  async function json(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options,
      headers: window.fwe.session.headers(options.headers || {}) });
    const body = await response.json();
    if (!response.ok) throw new Error(`${body.code || response.status}: ${body.error || response.statusText}`);
    return body;
  }
  function installStyle() {
    if (document.getElementById('fwa-console-style')) return;
    const style = element('style');
    style.id = 'fwa-console-style';
    style.textContent = `
      .fwa-console { color:var(--text,#243549); padding:12px; max-width:1500px; margin:auto; width:100%; box-sizing:border-box; }
      .fwa-console * { box-sizing:border-box; } .fwa-console h1 { margin:0;font-size:25px;letter-spacing:-.6px; }
      .fwa-console h2 { margin:0 0 12px; font-size:19px; } .fwa-console p { line-height:1.6; }
      .fwa-top,.fwa-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; justify-content:space-between; }
      .fwa-kicker { font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#557783; margin-bottom:6px; }
      .fwa-mode { background:#e3f0ec;color:#245648;border:1px solid #aacfc2;padding:6px 10px;border-radius:20px;font-size:12px; }
      .fwa-path { font-family:monospace;word-break:break-all; font-size:12px;color:#607287; }
      .fwa-notice { padding:12px 14px;border-left:3px solid #688f94;background:#edf3f4;font-size:13px; }
      .fwa-stats { display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:18px 0; }
      .fwa-stat { border:1px solid #ccd6de;border-radius:7px;padding:14px;background:var(--panel,#fff); }
      .fwa-stat strong { display:block;font-size:25px; }.fwa-stat span { font-size:12px;color:#607287; }
      .fwa-tabs { display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #cbd4dc;padding-bottom:12px;margin-bottom:18px; }
      .fwa-console button { cursor:pointer; padding:7px 12px; border:1px solid #b8c6d1;border-radius:5px;background:var(--panel,#fff);color:inherit; }
      .fwa-console button:disabled { opacity:.5;cursor:default; }.fwa-tabs button[aria-selected=true] { background:#244f58;border-color:#244f58;color:white; }
      .fwa-status { padding:9px 0;min-height:36px;font-size:13px; }.fwa-status[data-error=true] { color:#a43333; }
      .fwa-table-wrap { overflow:auto; }.fwa-console table { border-collapse:collapse;width:100%;font-size:12px; }
      .fwa-console th,.fwa-console td { padding:11px 9px;border-bottom:1px solid #d6dfe6;text-align:left;vertical-align:top;word-break:break-word;min-width:110px; }
      .fwa-console th { background:#edf2f5;color:#587082;font-weight:600; }
      .fwa-console td code { font-size:11px; }.fwa-record { margin:10px 0; }.fwa-record summary { cursor:pointer; }
      .fwa-console pre { font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;background:#edf2f5;padding:14px;border-radius:5px;max-height:440px;overflow:auto; }
      .fwa-form { display:grid;gap:10px;max-width:850px;padding:17px;border:1px solid #c5d2dc;border-radius:7px;margin-top:18px; }
      .fwa-form label { display:grid;gap:5px;font-size:13px; }.fwa-form input,.fwa-form textarea,.fwa-form select { width:100%;padding:9px;border:1px solid #b6c7d1;border-radius:4px;background:var(--panel,#fff);color:inherit;font:inherit; }
      .fwa-form textarea { min-height:90px; }.fwa-form button { justify-self:start; }.fwa-empty { padding:28px 0;color:#617287; }
    `;
    document.head.append(style);
  }
  function mount(host, ctx) {
    installStyle();
    host.replaceChildren();
    const root = element('section', undefined, 'fwa-console');
    root.dataset.testid = 'fwa-console';
    const top = element('div', undefined, 'fwa-top');
    const heading = element('div');
    heading.append(element('div', 'Agentic development / FWA', 'fwa-kicker'), element('h1', '项目控制台'));
    const mode = element('span', '连接中…', 'fwa-mode');
    mode.dataset.testid = 'fwa-mode';
    top.append(heading, mode);
    const projectPath = element('p', '', 'fwa-path');
    const notice = element('p', '投影只读。执行、验收、集成、回滚及恢复操作仍通过 CLI 明确发起；控制台不会清除任何安全阻断。', 'fwa-notice');
    const stats = element('div', undefined, 'fwa-stats');
    const toolbar = element('div', undefined, 'fwa-toolbar');
    const tabs = element('nav', undefined, 'fwa-tabs');
    tabs.setAttribute('aria-label', 'FWA 项目分区');
    const refresh = element('button', '刷新');
    refresh.dataset.testid = 'fwa-refresh';
    toolbar.append(tabs, refresh);
    const message = element('div', '', 'fwa-status');
    message.setAttribute('role', 'status');
    message.dataset.testid = 'fwa-status';
    const content = element('div');
    content.dataset.testid = 'fwa-content';
    root.append(top, projectPath, notice, stats, toolbar, message, content);
    host.append(root);
    const state = { section: 'project', data: ctx.data, session: null, generation: 0 };
    let journal;
    function status(text, error = false) { message.textContent = text; message.dataset.error = String(error); }
    function showRecords(key) {
      const items = state.data[key] || [];
      if (!items.length) { content.append(element('p', '暂无记录。可先通过目标命令建立任务，再加载计划。', 'fwa-empty')); return; }
      const columns = key === 'nodes'
        ? ['id', 'title', 'status', 'validity', 'dependsOn', 'integrationStatus']
        : key === 'goals' ? ['id', 'title', 'status', 'request']
          : ['id', 'nodeId', 'status', 'changeSetId'];
      const table = element('table');
      const header = element('tr');
      const labels = { id: '标识 ID', title: '名称', status: '状态', validity: '有效性', dependsOn: '前置依赖 → 本节点', integrationStatus: '集成状态', request: '请求', nodeId: '节点 ID', changeSetId: '变更集 ID' };
      columns.forEach((column) => header.append(element('th', labels[column] || column)));
      const head = element('thead'); head.append(header); table.append(head);
      const body = element('tbody');
      for (const item of items) {
        const row = element('tr');
        for (const column of columns) {
          const value = item[column];
          row.append(element('td', Array.isArray(value) ? value.join(', ') || '根节点（无前置依赖）' : value ?? '—'));
        }
        body.append(row);
      }
      table.append(body);
      const wrap = element('div', undefined, 'fwa-table-wrap'); wrap.append(table); content.append(wrap);
      for (const item of items) content.append(details(item, `${item.id || item.artifactRef || key} · 完整记录`));
    }
    function commandForm(type, title, fields, getPayload) {
      const form = element('form', undefined, 'fwa-form');
      form.dataset.testid = `fwa-${type}`;
      form.append(element('h2', title));
      const inputs = {};
      for (const [name, label, kind] of fields) {
        const control = element(kind === 'textarea' ? 'textarea' : 'input');
        if (kind !== 'textarea') control.type = 'text';
        control.name = name; control.required = true; control.setAttribute('aria-label', label);
        const wrapper = element('label', label); wrapper.append(control); form.append(wrapper); inputs[name] = control;
      }
      const submit = element('button', '提交命令'); submit.type = 'submit'; form.append(submit);
      const hint = element('small', '只提交当前命令；请求未变时再次提交会复用同一 command ID。'); form.append(hint);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        try {
          const payload = getPayload(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])));
          if (!journal) journal = createCommandJournal(window.sessionStorage, state.session.projectId);
          const commandId = journal.begin(type, payload);
          submit.disabled = true;
          status(`正在提交 ${type} · ${commandId}`);
          const result = await json('/api/fwa/commands', { method: 'POST', signal: AbortSignal.timeout(15000), headers: {
            'Content-Type': 'application/json', 'X-FWA-CSRF': state.session.csrfToken,
            'X-FWA-Fingerprint': state.session.fingerprint
          }, body: JSON.stringify({ type, commandId, payload }) });
          status(`${type} 已记录 · ${result.commandId}${result.result.appended === false ? '（幂等重放）' : ''}`);
          journal.acknowledge(type, payload, commandId);
          await refreshData(false);
        } catch (error) { status(`${error.message} 若响应丢失，请求仍可能已完成；保持内容不变重试可复用 command ID。`, true); }
        finally { submit.disabled = false; }
      });
      content.append(form);
    }
    function draw() {
      content.replaceChildren(); stats.replaceChildren();
      for (const [key, label] of sections.slice(1, 6)) {
        const card = element('div', undefined, 'fwa-stat');
        card.append(element('strong', (state.data[key] || []).length), element('span', label)); stats.append(card);
      }
      for (const button of tabs.children) button.setAttribute('aria-selected', String(button.dataset.section === state.section));
      content.append(element('h2', sections.find(([key]) => key === state.section)[1]));
      if (state.section === 'project') {
        content.append(element('p', `事件序号 ${state.data.lastSequence} · ${state.data.eventCount} 条事件 · ${state.data.batchCount} 个已提交批次`));
        content.append(details({ projectId: state.data.projectId, projectRoot: state.data.projectRoot,
          protocol: state.session?.protocol, fingerprint: state.session?.fingerprint, fweVersion: state.session?.fweVersion,
          commands: state.session?.commands, projectRevisions: state.data.projectRevisions }, '项目身份与兼容性指纹'));
      } else if (state.section === 'operational') {
        const operational = state.data.operational;
        content.append(element('p', operational?.gitProcessFence?.held || operational?.workspaceLease?.held
          ? '存在安全阻断或占用中的 workspace lease。请检查记录，恢复必须通过 CLI 明确决定。'
          : '当前快照没有持久 Git 进程阻断，也没有占用中的 workspace lease。这不等同于完整的 integrity 验证。'));
        content.append(details(operational || {}, 'Fence 与 lease 快照'));
      } else {
        if (state.section === 'nodes') content.append(element('p', '依赖方向：表中每个前置节点 → 本节点。缓存的 ready 状态不代表执行许可；FWA 会复查依赖及集成状态。'));
        showRecords(state.section);
      }
      if (!state.session?.allowWrite) return;
      if (state.section === 'goals') commandForm('goal.create', '创建目标', [['title', '目标名称'], ['request', '具体请求', 'textarea']], (value) => value);
      if (state.section === 'nodes') {
        commandForm('plan.load', '加载计划（提交前校验）', [['goalId', '已有目标 ID'], ['plan', '计划 JSON', 'textarea']], (value) => ({ goalId: value.goalId, plan: JSON.parse(value.plan) }));
        commandForm('node.retry', '申请节点重试', [['nodeId', '已有节点 ID'], ['reason', '重试原因']], (value) => value);
      }
    }
    async function refreshData(announce = true) {
      const generation = ++state.generation;
      refresh.disabled = true;
      try {
        if (!state.session) {
          const session = await json('/api/fwa/session');
          const advertised = ctx.app.labels?.fwaConsole;
          if (session.protocol !== PROTOCOL || advertised?.protocol !== PROTOCOL || session.fingerprint !== advertised?.fingerprint) {
            throw new Error('控制台不兼容或指纹已过期，请重启并重新加载所选 FWE/FWA。');
          }
          state.session = session;
        }
        const data = await json('/api/fwa/status');
        if (generation !== state.generation) return;
        if (data.projectId !== state.session.projectId || data.projectRoot !== state.session.projectRoot) throw new Error('项目身份已变更，请重启控制台。');
        state.data = data;
        mode.textContent = state.session.allowWrite ? '受控写入 · 3 项命令' : '只读模式';
        projectPath.textContent = state.session.projectRoot;
        draw();
        if (announce) status(`快照已刷新 · 事件序号 ${data.lastSequence}`);
      } catch (error) { status(error.message, true); }
      finally { if (generation === state.generation) refresh.disabled = false; }
    }
    for (const [key, label] of sections) {
      const button = element('button', label); button.dataset.section = key;
      button.addEventListener('click', () => { state.section = key; draw(); }); tabs.append(button);
    }
    refresh.addEventListener('click', () => refreshData());
    void refreshData();
    return root;
  }
  window.fwe.registerView('fwa-console', {
    noInspector: () => true,
    render(ctx) {
      ctx.showView('document');
      const host = ctx.hosts.documentTree;
      if (!mounted.has(host) || !mounted.get(host).isConnected) mounted.set(host, mount(host, ctx));
    }
  });
})();
