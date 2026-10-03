(function () {
  'use strict';
  const short = value => value ? String(value).slice(0, 12) : '未记录';
  const date = value => value ? new Date(value).toLocaleString() : '未记录';
  // Inert document/diff/media rendering is domain-specific. Ordinary controls
  // and compositions are configured in content.ui.json and rendered by FWE.
  function documentElement(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function documentText(text) {
    const root = documentElement('article', undefined, 'fwa-document');
    let code = null;
    for (const line of text.split(/\r?\n/)) {
      if (/^\x60\x60\x60/.test(line)) {
        if (code) { root.append(code); code = null; } else code = documentElement('pre', '');
      } else if (code) code.textContent += line + '\n';
      else if (/^#{1,4} /.test(line)) {
        const length = line.indexOf(' ');
        root.append(documentElement('h' + Math.min(4, length + 1), line.slice(length + 1)));
      } else if (/^\s*[-*] /.test(line)) root.append(documentElement('p', '• ' + line.replace(/^\s*[-*] /, '')));
      else if (line.trim()) root.append(documentElement('p', line));
    }
    if (code) root.append(code);
    return root;
  }
  function artifacts(value) {
    const found = new Map();
    function visit(item, name, depth) {
      if (!item || typeof item !== 'object' || depth > 16) return;
      if (item.algorithm === 'sha256' && /^[a-f0-9]{64}$/.test(item.digest) && Number.isSafeInteger(item.size)) {
        if (!found.has(item.digest)) found.set(item.digest, { ref: item, name });
        return;
      }
      for (const [key, child] of Object.entries(item)) visit(child, name ? name + '.' + key : key, depth + 1);
    }
    visit(value, '', 0);
    return [...found.values()];
  }
  function create({ api, select, getStatus, getWorkAvailability, command, getSession, refresh }) {
    const model = window.FwaWorkbenchModel;
    let disposed = false;
    const reviewDrafts = new Map(), reviewPending = new Set();
    const reviewPanels = new Map();
    const experimentPanels = new Map();
    const experimentDrafts = new Map();
    const diffPanels = new Map();
    const surface = window.FwaSurface.create('content', { actions: {
      invoke: ({ data, event }) => data.action?.(event),
      artifact: ({ data }) => showArtifact(data.viewer, data.artifact, data.label),
      reviewDraft: ({ data, element }) => { data.draft[element.name] = element.value; },
      reviewAction: ({ data, element }) => data.invoke(element.dataset.action),
      loadEvents: ({ data }) => data.load?.()
    } });
    const render = (name, data = {}) => surface.render(name, data);
    const tone = value => ({ neutral: 'muted', error: 'danger', running: 'info', active: 'info' })[model.tone(value)] || model.tone(value) || 'muted';
    const status = value => ({ label: model.statusLabel(value), tone: tone(value) });
    const reviewPhase = value => ({ 'awaiting-human-acceptance': '验证通过，待人工验收', 'validation-failed': '候选验证未通过',
      accepted: '确认已记录', integrated: '已采用', reverted: '已撤销', rejected: '回归未通过', failed: '失败',
      conflict: '存在冲突', integrating: '正在采用', reverting: '正在撤销' })[value] || model.statusLabel(value) || value;
    // Compatibility for controllers requesting one small element. New ordinary
    // compositions should use named templates rather than this compatibility shim.
    function el(tag, text, className = '') {
      if (['video', 'audio'].includes(tag)) return documentElement(tag, text, 'fwa-artifact-media');
      const templates = { div: 'stack', section: 'card', article: 'card', header: 'stack', aside: 'card', nav: 'row',
        p: 'text', small: 'text', strong: 'text', time: 'text', span: 'badge', h1: 'heading', h2: 'heading', h3: 'heading',
        h4: 'heading', pre: 'pre', details: 'details', summary: 'summary', a: 'link', img: 'image', label: 'label',
        ul: 'list', ol: 'list', li: 'listItem', option: 'option', button: 'button' };
      if (!templates[tag]) throw new Error('Ordinary ' + tag + ' controls require a configured FWE Surface field.');
      const emphasis = /error/.test(className) ? 'danger' : /warning/.test(className) ? 'warning' : /notice/.test(className) ? 'info' : /muted|kicker/.test(className) ? 'muted' : '';
      return render(templates[tag], { text, tone: emphasis });
    }
    const button = (label, action) => render('button', { text: label, action });
    const badge = value => render('status', status(value));
    const record = (value, title = surface.text('recordTitle')) => render('record', { title, json: JSON.stringify(value, null, 2) });
    const metadata = values => render('metadata', { rows: Object.entries(values).map(([label, value]) => ({ label, value: value ?? surface.text('unrecorded') })) });
    const resource = (type, id, label) => window.FwaSurface.resourceLink(type, id, label, { onSelect: () => select(type, id) });
    function links(host, title, items, type, label) {
      const section = render('relations', { title, count: items.length, empty: !items.length });
      for (const item of items) section.refs.items.append(resource(type, item.id, label?.(item) || item.title || item.uri || item.id));
      host.append(section);
    }
    function artifactLinks(host, value) {
      const items = artifacts(value);
      if (!items.length) return;
      const view = render('artifactLinks');
      for (const { ref, name } of items) view.refs.actions.append(render('artifactButton', {
        text: name + ' · ' + ref.size.toLocaleString() + ' B', viewer: view.refs.viewer, artifact: ref, label: name
      }));
      host.append(view);
    }
    async function showArtifact(host, ref, name = surface.text('artifactTitle'), formatHint) {
      if (disposed) return;
      const ticket = String(Number(host.dataset.ticket || 0) + 1); host.dataset.ticket = ticket;
      const current = () => !disposed && host.isConnected && host.dataset.ticket === ticket;
      host.replaceChildren(render('artifactLoading'));
      try {
        const result = await api('/api/fwa/artifacts?digest=' + encodeURIComponent(ref.digest));
        if (!current()) return;
        if (result.digest !== ref.digest || result.size !== ref.size) throw new Error(surface.text('artifactMismatch'));
        const view = render('artifact', { name, digest: result.digest, size: result.size, truncated: result.truncated });
        host.replaceChildren(view);
        if (['image', 'video'].includes(result.format)) {
          const target = new URL(result.url, window.location.origin);
          if (target.origin !== window.location.origin || target.pathname !== '/api/fwa/artifacts'
            || target.searchParams.get('digest') !== ref.digest || target.searchParams.get('raw') !== '1') throw new Error(surface.text('artifactUrlMismatch'));
          const media = result.format === 'image' ? render('artifactImage', { url: target.href, name }) : documentElement('video', undefined, 'fwa-artifact-media');
          if (result.format === 'video') { media.dataset.testid = 'fwa-artifact-media'; media.controls = true; media.preload = 'metadata'; media.src = target.href; }
          view.refs.body.append(media, render('historicalMediaNotice'));
          return;
        }
        if (!result.text) { view.refs.body.append(render('emptyArtifact')); return; }
        if (formatHint === 'diff' || /patch|diff/i.test(name)) {
          const diff = documentElement('pre', undefined, 'fwa-diff'); diff.dataset.testid = 'fwa-diff';
          for (const line of result.text.split('\n')) {
            const lineTone = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : line.startsWith('@@') ? 'hunk' : '';
            diff.append(documentElement('span', line + '\n', 'fwa-diff-' + lineTone));
          }
          view.refs.body.append(diff);
        } else {
          let parsed;
          try { parsed = JSON.parse(result.text); } catch { /* Text and JSONL logs remain readable as text. */ }
          if (parsed) {
            artifactLinks(view.refs.body, parsed);
            const process = parsed.process || parsed.result?.process || parsed.execution?.process;
            if (process?.stderr) view.refs.body.append(render('errorOutput', { text: process.stderr }));
          }
          view.refs.body.append(render('artifactText', { text: parsed ? JSON.stringify(parsed, null, 2) : result.text }));
        }
      } catch (error) { if (current()) host.replaceChildren(render('errorOutput', { text: error.message })); }
    }
    function candidateDiff(host, change, owner) {
      if (!change?.patchArtifact) return;
      const key = `${owner}/${change.id}/${change.patchArtifact.digest}`;
      const entry = diffPanels.get(key) || { open: false, loaded: false, loading: false, viewer: render('stack') };
      if (entry.disclosure) {
        entry.open = entry.disclosure.open;
        entry.disclosure.removeEventListener('toggle', entry.listener);
      }
      const view = render('candidateDiff', { candidateId: key,
        files: (change.changedFiles || []).map(file => typeof file === 'string' ? file : JSON.stringify(file)) });
      host.append(view); view.refs.body.append(entry.viewer); view.open = entry.open;
      const load = async () => {
        if (disposed || !view.isConnected || !view.open || entry.loaded || entry.loading) return;
        entry.loading = true;
        try {
          await showArtifact(entry.viewer, change.patchArtifact, surface.text('patchTitle'), 'diff');
          entry.loaded = entry.viewer.isConnected;
        } finally { entry.loading = false; }
      };
      entry.listener = () => { if (view.isConnected) { entry.open = view.open; if (view.open) void load(); } };
      entry.disclosure = view; diffPanels.set(key, entry);
      view.addEventListener('toggle', entry.listener);
      if (entry.open) void load();
    }
    function node(host, id) {
      const data = model.nodeWorkbench(getStatus(), id);
      if (!data) { host.append(render('missingNode')); return; }
      const item = data.node, session = getSession?.(), current = data.activity;
      const availability = getWorkAvailability?.(id) || model.workAvailability(getStatus(), session, item.goalId, id);
      const executionBlocker = session?.allowWrite && !availability.allowed && !['delivered', 'historical'].includes(current.state)
        && availability.reason !== current.reason ? availability.reason : '';
      const outcome = item.outcome?.trim(), headline = outcome || item.title || id;
      const completionCount = typeof item.acceptance === 'string' ? 1 : Array.isArray(item.acceptance) ? item.acceptance.length
        : (item.acceptance?.commands?.length || 0) + (item.acceptance?.checks?.length || 0);
      const view = render('node', { ...item, ...data, title: item.title, id, headline,
        activity: { ...current, tone: ({ active: 'info', neutral: 'muted' })[current.tone] || current.tone },
        nextAction: current.nextAction && current.nextAction !== current.reason && current.nextAction !== executionBlocker
          && !['查看任务详情。', '查看交付证据。'].includes(current.nextAction) ? current.nextAction : '',
        acceptanceTitle: `验收标准（${completionCount}）`, dependencyTitle: `依赖（${data.dependencies.length}）`,
        hasDependencies: data.dependencies.length > 0, hasResult: !!data.change,
        executionBlocker });
      host.append(view);
      if (data.change) {
        candidateDiff(view.refs.resultDiff, data.change, `node/${id}`);
        if (command) void reviewChange(view.refs.review, data.change.id);
        view.refs.records.append(resource('changeSets', data.change.id, '查看独立结果记录'));
      }
      for (const dependency of data.dependencies) {
        const dependencyView = render('dependency', { reason: dependency.reason === '依赖原因未记录' ? '原因未记录' : dependency.reason });
        dependencyView.refs.link.append(resource('nodes', dependency.id, dependency.title));
        view.refs.dependencies.append(dependencyView);
      }
      links(view.refs.references, surface.text('references'), data.refs, 'refs');
      links(view.refs.runs, surface.text('runs'), data.runs, 'runs', run => model.statusLabel(run.status) + ' · ' + date(run.startedAt || run.createdAt));
      links(view.refs.changes, surface.text('changes'), data.changeSets, 'changeSets', change => (change.changedFiles?.length ?? 0) + ' 个文件 · ' + short(change.id));
      links(view.refs.evidence, surface.text('evidence'), data.evidence, 'evidence', evidence => model.statusLabel(evidence.result) + ' · ' + short(evidence.id));
      view.refs.records.append(record({ acceptance: item.acceptance, reads: item.reads, writes: item.writes }, surface.text('acceptanceRecord')), record(item));
    }
    async function ref(host, id) {
      const item = getStatus().refs.find(entry => entry.id === id);
      if (!item || disposed) return;
      const view = render('ref', { ...item, provenance: item.metadata?.provenance || surface.text('undeclared') });
      host.append(view);
      const preview = view.refs.preview;
      const current = () => !disposed && preview.isConnected;
      const consumers = getStatus().nodes.filter(entry => entry.reads?.includes(id));
      const writers = getStatus().nodes.filter(entry => entry.writes?.includes(id));
      links(view.refs.consumers, surface.text('consumers'), consumers, 'nodes'); links(view.refs.writers, surface.text('writers'), writers, 'nodes');
      view.refs.records.append(record(item, surface.text('refRecord')));
      try {
        const result = await api('/api/fwa/refs/content?id=' + encodeURIComponent(id));
        if (!current()) return;
        const content = render('refPreview', { versionLabel: result.versionLabel || surface.text('workspaceNotice'), hashChanged: result.matchesRegisteredHash === false });
        preview.replaceChildren(content);
        if (result.kind === 'image') {
          const url = new URL(result.url, window.location.origin);
          if (url.origin !== window.location.origin || url.pathname !== '/api/fwa/refs/content'
            || url.searchParams.get('id') !== id || url.searchParams.get('raw') !== '1') throw new Error(surface.text('refUrlMismatch'));
          const image = render('refImage', { url: url.href, name: item.uri });
          image.refs.image.addEventListener('error', () => { if (current()) content.refs.body.append(render('imageError')); }, { once: true });
          content.refs.body.append(image);
        } else if (result.kind === 'text') content.refs.body.append(documentText(result.text || surface.text('emptyFile')));
        else content.refs.body.append(render('text', { text: result.reason || surface.text('unsupportedPreview'), tone: 'muted' }));
      } catch (error) { if (current()) preview.replaceChildren(render('errorOutput', { text: error.message })); }
    }
    function run(host, id) {
      const state = getStatus(), item = state.runs.find(entry => entry.id === id);
      if (!item) return;
      const view = render('run', { ...item, title: state.nodes.find(entry => entry.id === item.nodeId)?.title || item.nodeId,
        statusView: status(item.status), executorLabel: (item.executor?.id || surface.text('unrecorded')) + ' · ' + (item.executor?.version || ''),
        started: date(item.startedAt || item.createdAt), ended: date(item.producedAt || item.failedAt), hasFailure: !!item.failure,
        failureText: item.failure ? item.failure.code + ': ' + item.failure.message : '', stderr: item.failure?.details?.process?.stderr || '' });
      host.append(view);
      const changes = state.changeSets.filter(entry => entry.runId === id);
      links(view.refs.changes, surface.text('changes'), changes, 'changeSets', entry => (entry.changedFiles?.length ?? 0) + ' 个文件 · ' + short(entry.id));
      for (const change of changes) artifactLinks(view.refs.artifacts, { executionArtifact: change.executionArtifact });
      links(view.refs.evidence, surface.text('acceptanceResults'), state.evidence.filter(entry => entry.runId === id), 'evidence', entry => model.statusLabel(entry.result) + ' · ' + entry.kind);
      view.refs.nodeLink.append(resource('nodes', item.nodeId, surface.text('locateNode')));
      if (item.effects?.consumedRefs?.length) view.refs.records.append(record(item.effects.consumedRefs, surface.text('consumedRefs')));
      view.refs.records.append(record(item));
    }
    function changeSet(host, id) {
      for (const [element, draft] of reviewPanels) if (!element.isConnected) {
        for (const key of ['impact', 'settings', 'jobs']) draft[key + 'Open'] = element.refs[key].open;
        reviewPanels.delete(element);
      }
      const state = getStatus(), item = state.changeSets.find(entry => entry.id === id);
      if (!item) return;
      const files = (item.changedFiles || []).map(file => typeof file === 'string' ? file : JSON.stringify(file));
      const node = state.nodes.find(entry => entry.id === item.nodeId);
      const view = render('changeSet', { ...item, title: node?.title || item.id, instruction: node?.instruction || node?.title,
        files, count: files.length, diffLines: item.stats?.diffLines, captured: date(item.capturedAt) });
      host.append(view);
      if (command && view.refs.review) void reviewChange(view.refs.review, id);
      for (const [element, entry] of experimentPanels) if (!element.isConnected) {
        experimentDrafts.set(entry.changeSetId, entry.panel.snapshot()); entry.panel.dispose(); experimentPanels.delete(element);
      }
      if (command && view.refs.experiment && window.FwaExperimentPanel) {
        experimentPanels.set(view.refs.experiment, { changeSetId: id, panel: window.FwaExperimentPanel.mount(view.refs.experiment,
          { changeSetId: id, api, command, getSession, state: experimentDrafts.get(id) }) });
      }
      const related = state.evidence.filter(entry => entry.changeSetId === id);
      if (related.length) links(view.refs.evidence, surface.text('relatedEvidence'), related, 'evidence', entry => `${model.statusLabel(entry.result)} · ${(entry.criteria || []).map(check => check.id).join('、') || entry.kind}`);
      artifactLinks(view.refs.artifacts, item);
      candidateDiff(view.refs.diff, item, 'change');
      view.refs.records.append(record(item));
    }
    async function reviewChange(host, id) {
      for (const [element, draft] of reviewPanels) if (!element.isConnected) {
        for (const key of ['impact', 'settings', 'jobs']) draft[key + 'Open'] = element.refs[key].open;
        reviewPanels.delete(element);
      }
      const current = () => !disposed && host.isConnected;
      try {
        const review = await api('/api/fwa/review?changeSetId=' + encodeURIComponent(id));
        if (!current()) return;
        const draft = reviewDrafts.get(id) || { revertNote: '' };
        reviewDrafts.set(id, draft);
        const writable = Boolean(getSession?.()?.allowWrite && !reviewPending.has(id));
        const autoCompletion = (review.completionMode ?? getSession?.()?.review?.completionMode) === 'automatic';
        const jobs = review.jobs.map(job => ({ text: (({ 'workflow.finish': '确认并继续', 'change.finish': '完成确认', 'change.auto-finish': '自动收束', 'change.policy-accept': '按规则确认', 'change.validate': '验证', 'change.accept': '人工验收', 'change.integrate': '采用', 'change.revert': '撤销' })[job.type] || '操作')
          + ' · ' + (job.state === 'running' ? '执行中' : job.state === 'succeeded' ? job.result?.ok === false ? '未通过：' + reviewPhase(job.result.phase) : '完成：' + reviewPhase(job.result.phase) : reviewPhase(job.state))
          + (job.error ? ' · ' + job.error.message : '') }));
        let view;
        const message = text => { if (current() && view) { view.refs.message.textContent = text; view.refs.message.hidden = !text; } };
        const invoke = async action => {
          if (!writable || reviewPending.has(id) || !['finish', 'revert'].includes(action) || !review.actions[action]
            || action === 'finish' && autoCompletion) return;
          const payload = { changeSetId: id, reviewToken: review.reviewToken };
          if (action === 'revert') {
            payload.note = draft.revertNote.trim();
            if (!payload.note) { message('请填写撤销原因。'); return; }
          }
          reviewPending.add(id); view.disabled = true;
          try {
            await command(action === 'finish' ? 'workflow.finish' : 'change.revert', payload);
            message('正在执行…');
            await refresh?.();
          } catch (error) { message(error.message); }
          finally { reviewPending.delete(id); if (current()) view.disabled = false; }
        };
        const active = review.current !== false && !review.integrated && !review.reverted && review.kind !== 'revert';
        const showFinish = active && !!review.evidenceId && !autoCompletion && getSession?.()?.allowWrite === true;
        const latest = review.jobs.at(-1);
        const failureText = latest?.state === 'failed' ? latest.error?.message || '操作失败，请查看操作记录。'
          : latest?.result?.ok === false ? reviewPhase(latest.result.phase) : '';
        view = render('review', { ...review, draft, invoke, jobs, blockers: review.blockers.map(text => ({ text })),
          failureText,
          showFinish, autoContinue: active && autoCompletion, showRevert: !!review.integrated && !review.reverted,
          phase: review.kind === 'revert' ? '撤销记录' : review.reverted ? '已撤销' : review.current === false ? '历史候选 · 当前不可采用'
            : review.integrated ? '已完成并集成' : review.evidenceId ? autoCompletion ? '验证通过，等待自动完成' : '等待确认并继续' : '等待自动验证',
          profileText: review.profiles.length ? review.profiles.map(profile => profile.id).join('、') : '未匹配到验证配置',
          finishDisabled: !writable || !review.actions.finish, revertDisabled: !writable || !review.actions.revert,
          impactText: review.impact.nodes.length ? review.impact.nodes.map(node => node.title + (node.willBecomeStale ? '（现有结果将失效）' : '（声明依赖）')).join('；') : '无声明依赖。',
          acceptedText: review.acceptanceRecord?.note || '' });
        host.replaceChildren(view);
        view.refs.message.hidden = true;
        reviewPanels.set(view, draft);
      } catch (error) { if (current()) host.replaceChildren(render('errorOutput', { text: error.message })); }
    }
    function evidence(host, id) {
      const item = getStatus().evidence.find(entry => entry.id === id);
      if (!item) return;
      const view = render('evidence', { ...item, statusView: status(item.result), recorded: date(item.recordedAt) });
      host.append(view);
      const rows = (item.criteria || []).map(criterion => ({ ...criterion, resultView: status(criterion.result),
        duration: criterion.durationMs === undefined ? surface.text('unrecorded') : criterion.durationMs + ' ms',
        logs: [['stdoutArtifact', surface.text('stdout')], ['stderrArtifact', surface.text('stderr')]].filter(([field]) => criterion[field])
          .map(([field, label]) => ({ text: label, artifact: criterion[field], label: criterion.id + ' / ' + label, viewer: view.refs.viewer })) }));
      view.refs.criteria.append(render('criteriaRows', { rows }));
      for (const criterion of item.criteria || []) if (criterion.failure) view.refs.failures.append(render('errorOutput', { text: criterion.id + ': ' + criterion.failure.message }));
      artifactLinks(view.refs.artifacts, { resultArtifact: item.resultArtifact, profileArtifact: item.profileArtifact });
      view.refs.changeLink.append(resource('changeSets', item.changeSetId, surface.text('locateChange')));
      view.refs.records.append(record(item));
    }
    async function events(host, nodeId) {
      let after = 0, loading = false;
      const view = render('events', { load });
      const { list, more, status: progress } = view.refs;
      host.replaceChildren(view);
      const current = () => !disposed && view.isConnected;
      async function load() {
        if (loading || !current()) return; loading = true; more.disabled = true;
        try {
          const page = await api('/api/fwa/events?after=' + after + '&limit=100' + (nodeId ? '&nodeId=' + encodeURIComponent(nodeId) : ''));
          if (!current()) return;
          for (const event of page.events) list.append(render('event', {
            ...event, timestampLabel: date(event.timestamp || event.occurredAt), json: JSON.stringify(event, null, 2)
          }));
          after = page.nextSequence; more.hidden = !page.hasMore;
          progress.textContent = surface.text('eventCount', { count: list.children.length, associated: nodeId ? '关联' : '' });
        } catch (error) { if (current()) progress.textContent = error.message; }
        finally { loading = false; if (current()) more.disabled = false; }
      }
      await load();
      return { refresh: load };
    }
    function dispose() { if (disposed) return; disposed = true; for (const entry of experimentPanels.values()) entry.panel.dispose(); experimentPanels.clear(); reviewPanels.clear();
      for (const entry of diffPanels.values()) entry.disclosure.removeEventListener('toggle', entry.listener); diffPanels.clear(); surface.dispose(); }
    return { el, button, badge, record, metadata, documentText, node, ref, run, changeSet, evidence, events, artifactLinks, showArtifact, dispose };
  }
  window.FwaWorkbenchContent = { create };
}());
