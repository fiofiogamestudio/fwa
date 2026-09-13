(function (root) {
  'use strict';
  const importLimits = () => {
    const limits = root.FwaSurface?.importLimits?.();
    if (!limits) throw new Error('FWA reference import contract is required.');
    return limits;
  };
  const mib = bytes => bytes / (1024 * 1024);
  const short = value => String(value || '').slice(0, 12);
  // Advisory UI fence matching core/scheduling.hasActiveProjectOperation. The
  // command handler independently checks the current project under its lease.
  function hasActiveOperation(status) {
    return (status.runBatches || []).some(item => item.status === 'running')
      || (status.runs || []).some(item => ['pending', 'running', 'paused'].includes(item.status)
        || (item.failure?.code === 'git-process-termination-unconfirmed' && item.failure.details?.fencePersisted === false))
      || (status.evaluations || []).some(item => ['requested', 'running', 'recovery-required'].includes(item.status))
      || [...(status.integrations || []), ...(status.reversions || [])].some(item => ['pending', 'running', 'recovery-required'].includes(item.status));
  }
  function validateSelection(files, directories = []) {
    const limits = importLimits();
    if (files.length + directories.length > limits.maxFiles) throw new Error(`最多导入 ${limits.maxFiles} 个文件和目录。`);
    let total = 0;
    for (const item of files) {
      if (!Number.isSafeInteger(item.file.size) || item.file.size < 0 || item.file.size > limits.maxFileBytes) throw new Error(`单文件上限 ${mib(limits.maxFileBytes)} MiB：${item.path}`);
      if ((total += item.file.size) > limits.maxUploadBytes) throw new Error(`本次导入总量上限 ${mib(limits.maxUploadBytes)} MiB，请分批导入。`);
    }
  }
  async function collectDroppedFiles(transfer) {
    const limits = importLimits();
    // Capture DataTransfer entries before the first await; the browser may clear
    // the protected drag data store when the drop event returns.
    const items = Array.from(transfer.items || []).filter(item => item.kind === 'file');
    const roots = items.map(item => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile?.() }));
    const fallback = Array.from(transfer.files || []);
    const files = [], directories = [];
    async function visit(entry, parent = '', depth = 0) {
      if (depth >= limits.maxDepth) throw new Error(`目录深度上限为 ${limits.maxDepth} 层。`);
      const relative = parent ? `${parent}/${entry.name}` : entry.name;
      if (files.length + directories.length >= limits.maxFiles) throw new Error(`最多导入 ${limits.maxFiles} 个文件和目录。`);
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        files.push({ path: relative, file }); validateSelection(files, directories);
      } else if (entry.isDirectory) {
        directories.push(relative);
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await visit(child, relative, depth + 1);
        }
      } else throw new Error(`无法读取此拖入项目：${relative}`);
    }
    if (roots.some(item => item.entry)) {
      for (const item of roots) {
        if (item.entry) await visit(item.entry);
        else if (item.file) files.push({ path: item.file.webkitRelativePath || item.file.name, file: item.file });
      }
    } else for (const file of fallback) files.push({ path: file.webkitRelativePath || file.name, file });
    validateSelection(files, directories); return { files, directories };
  }
  async function prepareImport(selection) {
    const limits = importLimits();
    const { files, directories = [] } = selection;
    validateSelection(files, directories);
    if (!files.length && !directories.length) throw new Error('没有可导入的文件或目录。');
    const standalone = !directories.length && files.every(item => !item.path.includes('/'));
    const archive = files.filter(item => /\.(zip|rar|7z|tar|gz|bz2|xz)$/i.test(item.path));
    if (standalone && archive.length && (files.length !== 1 || !/\.zip$/i.test(files[0].path))) throw new Error('压缩包仅支持单个 ZIP（store/deflate）；RAR、7z、tar 等格式暂不支持。');
    async function encode(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length !== file.size || bytes.length > limits.maxFileBytes) throw new Error('读取期间文件大小发生变化，请重新选择。');
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return root.btoa(binary);
    }
    const label = (directories[0] || files[0]?.path.split('/')[0] || 'Imported references').slice(0, limits.maxLabelLength);
    if (standalone && files.length === 1 && /\.zip$/i.test(files[0].path)) return { label, format: 'zip', base64: await encode(files[0].file) };
    const encoded = [];
    for (const item of files) encoded.push({ path: item.path, base64: await encode(item.file) });
    return { label, files: encoded, directories };
  }
  function create({ api, command, C, getStatus, getSession, selectNode, openGoal, refresh: refreshHost }) {
    if (typeof root.FwaSurface?.create !== 'function') throw new Error('FWA configured surface host is required.');
    const interactionLimits = root.FwaSurface.interactionLimits?.();
    if (!interactionLimits) throw new Error('FWA interaction admission contract is required.');
    const state = { data: { libraries: [], jobs: [], capabilities: {} }, selected: new Set(), request: '', mode: 'plan',
      activeLibrary: null, version: null, path: '', busy: new Set(), drafts: new Map(), feedbackMessages: new Map(),
      opened: new Set(), disclosures: {}, disposed: false, treeTicket: 0, previewTicket: 0, message: '', error: false };
    let intake, detailHost, libraryList, jobsHost, planButton, permissionHost;
    const feedbackHosts = new Map();
    const fragments = new Set(), nativeListeners = new Set();
    const writable = () => getSession?.()?.allowWrite === true && !state.disposed;
    const errorText = error => error?.message || String(error);
    const surface = root.FwaSurface.create('workflow', { actions: {
      importFiles({ element }) {
        const files = Array.from(element.files || []).map(file => ({ path: file.webkitRelativePath || file.name, file }));
        element.value = ''; void importSelection({ files, directories: [] });
      },
      requestChanged({ value }) { state.request = value || ''; syncDisabled(); },
      modeChanged({ value }) { state.mode = value; syncDisabled(); },
      librarySelected({ value, data }) { if (value) state.selected.add(data.id); else state.selected.delete(data.id); syncDisabled(); },
      browseLibrary({ data }) { state.activeLibrary = data.id; state.version = data.currentVersionId; state.path = ''; intake.refs.references.open = true; void showLibrary(); },
      versionChanged({ value }) { state.version = value; state.path = ''; void showLibrary(); },
      previewEntry({ data }) { state.path = data.entry.path; void preview(data.contentHost, data.entry, data.libraryId, data.versionId); },
      openGoal({ data }) { openGoal?.(data.goalId); },
      selectNode({ data }) { selectNode?.(data.id); },
      plan() {
        if (planButton.disabled) return;
        void action('plan', async () => {
          const result = await command('workflow.plan', { request: state.request.trim(), libraryIds: [...state.selected], mode: state.mode });
          state.disclosures.recent = true; if (intake?.refs.recent) intake.refs.recent.open = true;
          message(surface.text('planned', { job: result?.id ? ` · ${short(result.id)}` : '' })); await refreshHost?.();
        });
      },
      applyPermission({ data, refs }) {
        if (refs.permissionApply.disabled) return;
        const access = refs.permission.value === '' ? null : refs.permission.value;
        void action('permission', async () => {
          await command('library.permission', { libraryId: data.libraryId, path: data.path, access });
          message(surface.text('permissionSaved')); await refreshHost?.(); await showLibrary();
        });
      },
      feedbackChanged({ value, data }) { state.drafts.set(data.nodeId, value || ''); },
      submitFeedback({ data, refs }) {
        const item = feedbackHosts.get(data.nodeId); item?.update();
        if (refs.submit.disabled || !refs.feedback.value.trim()) return;
        void action(`feedback:${data.nodeId}`, async () => {
          await command('node.feedback', { nodeId: data.nodeId, text: refs.feedback.value.trim() });
          state.feedbackMessages.set(data.nodeId, surface.text('feedbackSaved')); await refreshHost?.(); item?.update();
        });
      },
      revise({ data, refs }) {
        const item = feedbackHosts.get(data.nodeId); item?.update(); if (refs.revise.disabled) return;
        void action(`revise:${data.nodeId}`, async () => {
          const status = getStatus(), node = status.nodes.find(value => value.id === data.nodeId);
          const revision = status.workflow?.revisions?.filter(value => value.goalId === node?.goalId).at(-1);
          const feedbackIds = (status.workflow?.feedback || []).filter(value => value.goalId === node?.goalId && value.status === 'pending').map(value => value.id);
          if (!revision || !feedbackIds.length || feedbackIds.length > interactionLimits.maxRevisionFeedback) throw new Error(surface.text('revisionNeedsFeedback', interactionLimits));
          await command('workflow.revise', { goalId: node.goalId, expectedRevision: revision.revision, feedbackIds });
          state.feedbackMessages.set(data.nodeId, surface.text('revisionSaved')); await refreshHost?.(); item?.update();
        });
      }
    } });
    const render = (template, data) => { const fragment = surface.render(template, data); fragments.add(fragment); return fragment; };
    const labelAccess = value => ({ read: 'accessRead', write: 'accessWrite', deny: 'accessDeny' })[value]
      ? surface.text({ read: 'accessRead', write: 'accessWrite', deny: 'accessDeny' }[value]) : value;
    function listen(element, name, callback, options) {
      element.addEventListener(name, callback, options); nativeListeners.add({ element, name, callback, options });
    }
    // Surface owns ordinary control listeners; this controller owns only events
    // absent from Surface (directory drop, tree expansion and media decoding).
    function releaseOwned(host) {
      for (const listener of nativeListeners) if (listener.element === host || host.contains(listener.element)) {
        listener.element.removeEventListener(listener.name, listener.callback, listener.options); nativeListeners.delete(listener);
      }
      for (const fragment of fragments) if (host === fragment || host.contains(fragment)) { surface.release(fragment); fragments.delete(fragment); }
    }
    function replace(host, ...children) { releaseOwned(host); host.replaceChildren(...children); }
    function message(text, error = false) {
      state.message = text; state.error = error;
      if (intake?.isConnected) surface.update({ message: text, error }, intake);
    }
    function syncDisabled() {
      if (intake?.isConnected) surface.update({ planLabel: state.mode === 'work' ? '生成计划并开始执行' : '生成修改计划', uploadDisabled: !writable() || state.busy.has('import'),
        hasJobs: !!state.data.jobs?.length, needsReviewSetup: getSession?.()?.review?.configured === false,
        planningBlocker: state.data.capabilities?.plan === false ? '尚未配置需求规划器，不能生成计划。' : '',
        planDisabled: !writable() || state.busy.has('plan') || state.data.capabilities?.plan === false
          || (!state.request.trim() && !state.selected.size) || state.selected.size > interactionLimits.maxReferenceLibraries }, intake);
      if (permissionHost?.isConnected) surface.update({ permissionDisabled: !writable() || state.busy.has('permission') }, permissionHost);
    }
    async function action(key, operation) {
      if (!writable() || state.busy.has(key)) return;
      state.busy.add(key); syncDisabled();
      for (const item of feedbackHosts.values()) item.update();
      try { await operation(); }
      catch (error) {
        message(errorText(error), true);
        if (key.startsWith('feedback:') || key.startsWith('revise:')) state.feedbackMessages.set(key.slice(key.indexOf(':') + 1), surface.text('requestFailed', { error: errorText(error) }));
      }
      finally { state.busy.delete(key); syncDisabled(); for (const item of feedbackHosts.values()) item.update(); }
    }
    async function importSelection(selection) {
      await action('import', async () => {
        message(surface.text('importReading'));
        const payload = await prepareImport(selection);
        const result = await command('library.import', payload, { upload: true });
        if (!result?.libraryId) throw new Error(surface.text('importUnconfirmed'));
        state.selected.add(result.libraryId); state.activeLibrary = result.libraryId; state.version = result.versionId; state.path = '';
        if (intake?.refs.references) intake.refs.references.open = true;
        message(surface.text('imported'));
        await refreshHost?.(); await showLibrary();
      });
    }
    function renderLibraries() {
      if (!libraryList?.isConnected) return;
      replace(libraryList, render('libraries', { libraries: (state.data.libraries || []).map(library => ({ ...library,
        selected: state.selected.has(library.id), shortVersion: short(library.currentVersionId) })) }));
    }
    function renderJobs() {
      if (!jobsHost?.isConnected) return;
      const jobs = [...(state.data.jobs || [])].reverse().map(job => {
        const question = job.result?.questions?.length;
        const labels = { running: 'jobRunning', failed: 'jobFailed', interrupted: 'jobInterrupted', succeeded: 'jobSucceeded' };
        const work = job.result?.work || job.result;
        const stopReason = work?.stopReason;
        // Derive warnings for older immutable jobs as well, without rewriting
        // their recorded result or interpreting the model's natural language.
        const changes = getStatus?.()?.changeSets || [];
        const zeroChanges = (work?.rounds || []).flatMap(round => round.members || []).filter(member => {
          const change = changes.find(item => item.id === member.changeSetId && item.runId === member.runId);
          return Array.isArray(change?.changedFiles) && change.changedFiles.length === 0;
        });
        const kind = ({ 'workflow.plan': '需求规划', 'workflow.work': '执行任务', 'workflow.revise': '修订计划', 'change.validate': '验证修改', 'change.accept': '人工验收', 'change.integrate': '采用修改', 'change.revert': '撤销修改', 'experiment.run': '效果对照' })[job.type] || job.type;
        const stateLabel = question ? surface.text('jobQuestions') : job.state === 'succeeded' && job.result?.phase === 'plan' ? '计划已生成'
          : job.state === 'queued' ? '排队中' : labels[job.state] ? surface.text(labels[job.state]) : job.state;
        const stopLabel = ({ 'awaiting-feedback-revision': '等待修订计划', 'no-ready-leaves': '没有可执行任务，请检查依赖或待验收修改',
          'execution-failed': '执行失败', 'no-changes-awaiting-review': '没有文件修改，需检查结果', 'awaiting-acceptance': '等待验收',
          'needs-acceptance': '等待验收', 'selected-leaf-processed': '所选任务已处理', 'round-limit': '已到本次执行轮数上限' })[stopReason] || stopReason;
        return { id: job.id, heading: `${kind} · ${stateLabel}`,
          shortId: short(job.id), errorText: job.error ? `${job.error.code || ''} ${job.error.message || job.error}` : '',
          questions: (job.result?.questions || []).map(value => typeof value === 'string' ? value : JSON.stringify(value)),
          stopReason, stopLabel, zeroChanges: stopReason === 'no-changes-awaiting-review' || zeroChanges.length > 0,
          zeroRuns: zeroChanges, goalId: job.result?.goalId, running: job.state === 'running', record: JSON.stringify(job, null, 2) };
      });
      replace(jobsHost, render('jobs', { jobs }));
      if (intake?.isConnected) surface.update({ hasJobs: jobs.length > 0 }, intake);
    }
    async function preview(host, entry, libraryId, versionId) {
      if (!intake?.isConnected || !host.isConnected || state.disposed) return;
      const owner = intake;
      const ticket = ++state.previewTicket;
      const current = () => !state.disposed && owner === intake && owner.isConnected && host.isConnected && ticket === state.previewTicket;
      const view = render('preview', { libraryId, versionId, path: entry.path,
        permissionStatus: surface.text('permissionStatus', { access: labelAccess(entry.access), source: entry.explicit ? surface.text('permissionExplicit')
          : surface.text('permissionInherited', { source: entry.inheritedFrom || surface.text('defaultRead') }) }),
        permission: entry.explicit ? entry.access : '', permissionDisabled: !writable(), isFile: entry.type === 'file', denied: entry.access === 'deny' });
      replace(host, view); permissionHost = view;
      if (entry.type !== 'file' || entry.access === 'deny') return;
      const target = view.refs.preview; target.append(render('message', { message: surface.text('readContent') }));
      const query = `libraryId=${encodeURIComponent(libraryId)}&versionId=${encodeURIComponent(versionId)}&path=${encodeURIComponent(entry.path)}`;
      try {
        const data = await api(`/api/fwa/library/content?${query}`);
        if (!current()) return;
        const type = data.contentType || '', raw = `/api/fwa/library/content?${query}&raw=1`;
        const content = render('content', { identity: `${data.size} B · ${data.hash}`, raw, pdf: type === 'application/pdf' });
        replace(target, content); const body = content.refs.body;
        let media;
        if (type.startsWith('image/')) { media = document.createElement('img'); media.alt = entry.path; }
        else if (type.startsWith('video/')) { media = document.createElement('video'); media.controls = true; media.preload = 'metadata'; }
        else if (type.startsWith('audio/')) { media = document.createElement('audio'); media.controls = true; media.preload = 'metadata'; }
        if (media) {
          media.className = 'fwa-library-media'; media.src = raw;
          listen(media, 'error', () => { if (current()) body.append(render('message', { message: surface.text('mediaError'), tone: 'warning' })); }, { once: true }); body.append(media);
        } else if (typeof data.text === 'string') body.append(typeof C.documentText === 'function' ? C.documentText(data.text) : render('textContent', { text: data.text }));
        else body.append(render('message', { message: surface.text('mediaUnsupported') }));
      } catch (error) { if (current()) replace(target, render('message', { message: errorText(error), tone: 'danger' })); }
    }
    async function showLibrary() {
      if (!intake?.isConnected || !detailHost?.isConnected || state.disposed) return;
      const owner = intake;
      const ticket = ++state.treeTicket; state.previewTicket++;
      const library = state.data.libraries?.find(item => item.id === state.activeLibrary);
      replace(detailHost);
      detailHost.hidden = !library || !intake.refs.references.open;
      if (!library) return;
      state.version ||= library.currentVersionId;
      const view = render('libraryDetail', { label: library.label, versionId: state.version }); detailHost.append(view);
      surface.setOptions(view.refs.version, [...library.versions].reverse().map(version => ({ value: version,
        label: surface.text(version === library.currentVersionId ? 'versionCurrent' : 'versionHistory', { version: short(version) }) })), state.version);
      const treeView = view.refs.tree, content = view.refs.content;
      const current = () => !state.disposed && ticket === state.treeTicket && owner === intake && owner.isConnected && treeView.isConnected;
      treeView.append(render('message', { message: surface.text('readTree') }));
      try {
        const result = await api(`/api/fwa/library/tree?libraryId=${encodeURIComponent(library.id)}&versionId=${encodeURIComponent(state.version)}`);
        if (!current()) return;
        replace(treeView);
        const tree = result.tree; let chosen = tree;
        function renderEntry(entry, host) {
          if (entry.path === state.path) chosen = entry;
          const entryData = { entry, entryLabel: entry.name || library.label, accessLabel: labelAccess(entry.access), contentHost: content, libraryId: library.id, versionId: result.versionId };
          if (entry.type === 'directory') {
            const key = `${library.id}@${result.versionId}:${entry.path}`;
            const folder = render('folder', { ...entryData, open: !entry.path || state.opened.has(key) });
            listen(folder, 'toggle', () => { if (folder.open) state.opened.add(key); else state.opened.delete(key); });
            for (const child of entry.children || []) renderEntry(child, folder.refs.children); host.append(folder);
          } else host.append(render('entry', entryData));
        }
        renderEntry(tree, treeView); void preview(content, chosen, library.id, result.versionId);
      } catch (error) { if (current()) replace(treeView, render('message', { message: errorText(error), tone: 'danger' })); }
    }
    function renderIntake(main, detail) {
      if (state.disposed) return;
      detailHost = detail;
      const previous = intake;
      if (previous) for (const key of ['references', 'settings', 'recent']) state.disclosures[key] = previous.refs[key]?.open || false;
      intake = render('intake', { request: state.request, mode: state.mode, message: state.message, error: state.error,
        referencesOpen: state.disclosures.references, settingsOpen: state.disclosures.settings, recentOpen: state.disclosures.recent,
        planLabel: state.mode === 'work' ? '生成计划并开始执行' : '生成修改计划',
        maxFileMiB: mib(importLimits().maxFileBytes), maxUploadMiB: mib(importLimits().maxUploadBytes),
        maxReferenceLibraries: interactionLimits.maxReferenceLibraries, uploadDisabled: true, planDisabled: true });
      if (previous && previous !== intake) releaseOwned(previous);
      replace(main, intake);
      listen(intake.refs.references, 'toggle', () => { if (intake.isConnected && detailHost?.isConnected) detailHost.hidden = !intake.refs.references.open || !state.activeLibrary; });
      const drop = intake.refs.drop;
      listen(drop, 'dragover', event => { event.preventDefault(); drop.dataset.drag = 'true'; if (event.dataTransfer) event.dataTransfer.dropEffect = writable() ? 'copy' : 'none'; });
      listen(drop, 'dragleave', () => { drop.dataset.drag = 'false'; });
      listen(drop, 'drop', event => { event.preventDefault(); drop.dataset.drag = 'false'; if (!writable() || state.busy.has('import')) return;
        void collectDroppedFiles(event.dataTransfer).then(importSelection).catch(error => message(errorText(error), true)); });
      libraryList = intake.refs.libraries; jobsHost = intake.refs.jobs; planButton = intake.refs.planButton;
      renderLibraries(); renderJobs(); syncDisabled(); void showLibrary();
    }
    function nodeFeedback(host, nodeId) {
      if (state.disposed) return;
      const previous = feedbackHosts.get(nodeId); if (previous?.host === host && previous.root.isConnected) { previous.update(); return; }
      if (previous) releaseOwned(previous.root);
      const section = render('feedback', { nodeId, draft: state.drafts.get(nodeId) || '' }); host.append(section);
      const list = section.refs.feedbackList;
      function update() {
        if (!section.isConnected) return;
        const status = getStatus(), node = status.nodes.find(item => item.id === nodeId), feedback = status.workflow?.feedback || [];
        const pending = feedback.filter(item => item.goalId === node?.goalId && item.status === 'pending');
        const active = hasActiveOperation(status);
        const current = node?.supersededByRevision == null && (status.goals || []).some(goal => goal.id === node?.goalId && goal.nodeIds?.includes(nodeId));
        const revision = status.workflow?.revisions?.filter(item => item.goalId === node?.goalId).at(-1);
        surface.update({ submitDisabled: !writable() || !current || state.busy.has(`feedback:${nodeId}`),
          reviseDisabled: !writable() || !current || !revision || active || !pending.length || pending.length > interactionLimits.maxRevisionFeedback || state.busy.has(`revise:${nodeId}`),
          result: [state.feedbackMessages.get(nodeId), surface.text(!current ? 'historicalNode' : active ? 'activeOperation' : 'feedbackBoundary')].filter(Boolean).join(' ') }, section);
        replace(list, render('feedbackList', { items: feedback.filter(item => item.nodeId === nodeId || (item.goalId === node?.goalId && item.logicalId === (node?.logicalId || nodeId)))
          .map(item => ({ text: item.text, statusLabel: item.status === 'pending' ? surface.text('feedbackPending')
            : surface.text('feedbackState', { status: item.status, revision: item.appliedRevisionId || surface.text('seeRevision') }) })) }));
      }
      feedbackHosts.set(nodeId, { host, root: section, update }); update();
    }
    function renderGroup(host, id, goalId) {
      if (state.disposed) return;
      const goals = getStatus().workflow?.goals || [];
      const stack = [...goals.filter(goal => !goalId || goal.id === goalId || goal.goalId === goalId)]; const matches = [];
      while (stack.length) { const item = stack.pop(); if (item.id === id) matches.push(item); stack.push(...(item.children || [])); }
      const found = matches.length === 1 ? matches[0] : null;
      if (!found) { host.append(render('groupMissing')); return; }
      const pending = [...(found.children || [])], leaves = [];
      while (pending.length) { const item = pending.shift(); if (item.type === 'node') leaves.push({ id: item.id, label: `${item.title} · ${item.phase}` }); else pending.push(...(item.children || [])); }
      host.append(render('group', { title: found.title || found.id, phase: found.phase, leaves, record: JSON.stringify(found, null, 2) }));
    }
    function refresh(data) {
      if (state.disposed) return;
      const before = JSON.stringify(state.data.libraries || []), jobsBefore = JSON.stringify(state.data.jobs || []);
      state.data = data || { libraries: [], jobs: [], capabilities: {} };
      const ids = new Set((state.data.libraries || []).map(item => item.id));
      for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
      if (before !== JSON.stringify(state.data.libraries || [])) { renderLibraries(); if (intake?.isConnected && detailHost?.isConnected) void showLibrary(); }
      if (jobsBefore !== JSON.stringify(state.data.jobs || [])) renderJobs();
      for (const [id, item] of feedbackHosts) { if (item.root.isConnected) item.update(); else { releaseOwned(item.root); feedbackHosts.delete(id); } }
      syncDisabled();
    }
    return { renderIntake, refresh, nodeFeedback, renderGroup, dispose() {
      state.disposed = true; state.treeTicket++; state.previewTicket++; feedbackHosts.clear();
      for (const { element, name, callback, options } of nativeListeners) element.removeEventListener(name, callback, options);
      nativeListeners.clear(); fragments.clear(); surface.dispose();
    } };
  }
  root.FwaWorkflowPanel = { create };
  if (typeof module === 'object' && module.exports) module.exports = { create, collectDroppedFiles, prepareImport, validateSelection, hasActiveOperation };
}(typeof window === 'undefined' ? globalThis : window));
