(function () {
  'use strict';
  /** The host owns lifecycle; asynchronous responses never replace a later selection. */
  function mount(host, { changeSetId, api, command, getSession, state = {} }) {
    let disposed = false, requestNumber = 0, inspection, selectedId = state.selectedId, busy = false;
    const surface = window.FwaSurface.create('experiment', { actions: {
      run: () => run(), refresh: () => load(), select: ({ data }) => { selectedId = data.id; return load(); }
    } });
    const root = surface.render('experiment', { disabled: true, reason: '正在读取实验条件…', history: [] });
    host.append(root);
    root.open = state.open === true;
    const statusLabels = { ready: '对照已就绪', failed: '运行检查未通过', blocked: '无法形成对照' };
    function showResult(job) {
      [...root.refs.result.children].forEach(child => surface.release(child));
      root.refs.result.replaceChildren();
      if (!job) return;
      root.refs.message.textContent = job.state === 'running' ? '正在准备版本并运行，请稍后刷新。'
        : job.state === 'interrupted' ? '执行中断，结果尚未确认。保留的实验工作区可供检查。'
          : job.error ? job.error.message : '';
      if (!job.result) return;
      const result = job.result;
      const view = surface.render('result', { title: statusLabels[result.comparison] || result.comparison,
        summary: result.reason, showReason: result.comparison !== 'ready' && !!result.reason,
        files: (result.changedFiles || result.conflicts || []).length ? '修改文件：' + (result.changedFiles || result.conflicts).join('、') : '',
        patch: (result.patch || '') + (result.patchTruncated ? '\n（差异过长，完整版本保留在实验工作区。）' : '') });
      root.refs.result.append(view);
      for (const key of ['a', 'b']) {
        const side = result[key];
        if (!side) continue;
        view.refs[key].append(surface.render('side', { label: side.label, revision: side.revision || '有冲突，未形成版本',
          location: side.workspacePath, checks: (side.evaluation?.checks || []).map(check => ({
            label: `${check.passed ? '通过' : '失败'} · ${check.id}`,
            summary: String(check.failure?.message || check.stdout || check.stderr || '无文本输出').trim().split(/\r?\n/).find(line => line.trim())?.slice(0, 240) || '无文本输出',
            output: [check.stdout, check.stderr, check.failure?.message].filter(Boolean).join('\n') || '无文本输出'
          })), media: (side.media || []).filter(item => /^image\/(png|jpeg|webp)$/.test(item.mime)
            && typeof item.base64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(item.base64))
            .map(item => ({ path: item.path, src: `data:${item.mime};base64,${item.base64}` })) }));
      }
    }
    async function load() {
      const request = ++requestNumber;
      try {
        const data = await api('/api/fwa/experiments?changeSetId=' + encodeURIComponent(changeSetId)
          + (selectedId ? '&jobId=' + encodeURIComponent(selectedId) : ''));
        if (disposed || request !== requestNumber) return;
        inspection = data.inspection;
        surface.update({ disabled: busy || !getSession()?.allowWrite || !inspection.available,
          reason: inspection.reason || '',
          conditionsText: inspection.conditions ? '固定条件：' + Object.entries(inspection.conditions).map(([name, value]) => `${name}=${value}`).join(' · ') : '',
          blockersText: inspection.blockers?.length ? '受影响的已采用变化：' + inspection.blockers.map(item => item.title).join('、') : '',
        }, root);
        [...root.refs.history.children].forEach(child => surface.release(child));
        root.refs.history.replaceChildren(...data.history.map(job => surface.render('history', {
          ...job, label: `${new Date(job.createdAt).toLocaleString()} · ${job.state} · ${statusLabels[job.comparison] || ''}` })));
        showResult(data.selected);
      } catch (error) { if (!disposed && request === requestNumber) root.refs.message.textContent = error.message; }
    }
    async function run() {
      if (busy || !inspection?.available) return;
      busy = true; surface.update({ disabled: true }, root); root.refs.message.textContent = '正在提交对照任务…';
      try {
        await command('experiment.run', { changeSetId, reviewToken: inspection.reviewToken });
        selectedId = undefined;
      } catch (error) { if (!disposed) root.refs.message.textContent = error.message; }
      finally { busy = false; if (!disposed) await load(); }
    }
    load();
    return { refresh: load, snapshot: () => ({ open: root.open, selectedId }),
      dispose() { disposed = true; requestNumber++; surface.dispose(); } };
  }
  window.FwaExperimentPanel = { mount };
}());
