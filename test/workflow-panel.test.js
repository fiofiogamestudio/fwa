import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { hasActiveProjectOperation } from '../src/core/scheduling.js';
import { REFERENCE_LIBRARY_LIMITS } from '../src/storage/library-files.js';
import { INTERACTION_LIMITS, INTERACTION_FIELDS } from '../src/core/interaction-contract.js';

const source = await readFile(new URL('../src/editor/app/workflow-panel.js', import.meta.url), 'utf8');
const config = JSON.parse(await readFile(new URL('../src/editor/app/workflow.ui.json', import.meta.url), 'utf8'));
const surfaceSource = await readFile(new URL('../../fwe/public/surface.js', import.meta.url), 'utf8');
const inspectorSource = await readFile(new URL('../../fwe/public/inspector.js', import.meta.url), 'utf8');
function load({ ui = false, interactionLimits = INTERACTION_LIMITS } = {}) {
  const context = { module: { exports: {} }, console, Uint8Array, btoa: value => Buffer.from(value, 'binary').toString('base64') };
  context.FwaSurface = { importLimits: () => ({ ...REFERENCE_LIBRARY_LIMITS, maxUploadBytes: REFERENCE_LIBRARY_LIMITS.maxArchiveBytes, maxLabelLength: INTERACTION_FIELDS.libraryLabel.maxLength }),
    interactionLimits: () => interactionLimits };
  if (ui) {
    context.window = context;
    context.document = { createElement: tag => new Element(tag), createTextNode: value => new Element('#text', value) };
    vm.runInNewContext(inspectorSource, context);
    vm.runInNewContext(surfaceSource, context);
    context.FwaSurface.create = (name, bindings) => {
      assert.equal(name, 'workflow');
      const fields = { 'commands.request': { type: 'textarea', required: false, maxLength: 16384 },
        'commands.feedback': { type: 'textarea', required: true, maxLength: 16384 },
        'commands.mode': { type: 'select', required: true, options: ['plan', 'work'] },
        'commands.permission': { type: 'select', required: false, options: ['read', 'write', 'deny', null] } };
      return context.createFweSurface(config, { ...bindings, resolveField: path => fields[path] });
    };
  }
  vm.runInNewContext(source, context); return context.module.exports;
}
const file = (name, text = name, extra = {}) => ({ name, size: Buffer.byteLength(text), arrayBuffer: async () => Uint8Array.from(Buffer.from(text)).buffer, ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('directory drag reads every asynchronous batch and preserves empty directories', async () => {
  const { collectDroppedFiles } = load();
  const entry = name => ({ name, isFile: true, file: resolve => resolve(file(name)) });
  let reads = 0;
  const directory = { name: 'Folder', isDirectory: true, createReader: () => ({ readEntries(resolve) {
    const batches = [[entry('a.txt')], [{ name: 'Empty', isDirectory: true, createReader: () => ({ readEntries: callback => callback([]) }) }], [entry('b.txt')], []];
    resolve(batches[reads++]);
  } }) };
  const result = await collectDroppedFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => directory, getAsFile: () => null }], files: [] });
  assert.equal(reads, 4);
  assert.deepEqual(Array.from(result.files, item => item.path), ['Folder/a.txt', 'Folder/b.txt']);
  assert.deepEqual(Array.from(result.directories), ['Folder', 'Folder/Empty']);
});

test('frontend import preserves bytes, limits payloads and only extracts standalone ZIP', async () => {
  const { prepareImport } = load();
  const result = await prepareImport({ files: [{ path: 'Folder/a.txt', file: file('a.txt', '<script>not HTML</script>') }], directories: ['Folder'] });
  assert.equal(result.files[0].path, 'Folder/a.txt'); assert.equal(Buffer.from(result.files[0].base64, 'base64').toString(), '<script>not HTML</script>');
  const archive = await prepareImport({ files: [{ path: 'brief.zip', file: file('brief.zip', 'zip bytes') }] }); assert.equal(archive.format, 'zip');
  await assert.rejects(prepareImport({ files: [{ path: 'brief.rar', file: file('brief.rar') }] }), /ZIP/);
  await assert.rejects(prepareImport({ files: [{ path: 'big', file: file('big', '', { size: 16 * 1024 * 1024 + 1 }) }] }), /16 MiB/);
  const large = file('large', '', { size: 12 * 1024 * 1024 });
  await assert.rejects(prepareImport({ files: [1, 2, 3].map(id => ({ path: String(id), file: large })) }), /32 MiB/);
});

class Element {
  constructor(tag, text, className) {
    this.tagName = tag.toUpperCase(); this.textContent = text === undefined ? '' : String(text); this.className = className || '';
    this.children = []; this.parentElement = null; this.attributes = {}; this.dataset = {}; this.events = new Map();
    this.value = ''; this.disabled = false; this.open = false; this.hidden = false; this.type = ''; this.classList = { add: name => { this.className += ` ${name}`; } };
    this._webkitdirectory = false;
  }
  get webkitdirectory() { return this._webkitdirectory; }
  set webkitdirectory(value) { this._webkitdirectory = Boolean(value); }
  get isConnected() { return this.attached || this.parentElement?.isConnected || false; }
  append(...values) { for (const value of values) { value.parentElement = this; this.children.push(value); } }
  replaceChildren(...values) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...values); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
  }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { const listeners = this.events.get(name) || []; listeners.push(listener); this.events.set(name, listeners); }
  removeEventListener(name, listener) { this.events.set(name, (this.events.get(name) || []).filter(value => value !== listener)); }
  contains(child) { return this === child || this.children.some(value => value.contains(child)); }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } }
  querySelectorAll(selector) {
    assert.equal(selector, 'input[type="password"], input[type="file"]');
    return descendants(this).slice(1).filter(node => node.tagName === 'INPUT' && ['password', 'file'].includes(node.type));
  }
  emit(name, extras = {}) { for (const listener of this.events.get(name) || []) listener({ preventDefault() {}, target: this, ...extras }); }
  set innerHTML(_) { throw new Error('Untrusted HTML insertion is forbidden.'); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const find = (node, predicate) => { const matches = descendants(node).filter(predicate); assert.equal(matches.length, 1); return matches[0]; };
const text = node => node.hidden ? '' : [node.textContent, ...node.children.map(text)].join(' ');
function ui({ allowWrite = true, readApi, interactionLimits, review } = {}) {
  const { create } = load({ ui: true, interactionLimits }), commands = [];
  const status = { goals: [{ id: 'g', nodeIds: ['n'] }], nodes: [{ id: 'n', goalId: 'g', title: 'Node', status: 'ready' }],
    runs: [], evaluations: [], integrations: [], reversions: [], runBatches: [],
    workflow: { feedback: [], revisions: [{ goalId: 'g', revision: 1 }], goals: [] } };
  const main = new Element('main'), detail = new Element('aside'); main.attached = true; detail.attached = true;
  const api = readApi || (async () => ({ versionId: 'v1', tree: { name: 'Library', path: '', type: 'directory', access: 'read', children: [] } }));
  const panel = create({ api, command: async (type, payload) => { commands.push({ type, payload }); return { id: 'job-one' }; },
    C: { el: (tag, value, className) => new Element(tag, value, className), record: value => new Element('pre', JSON.stringify(value)) },
    getStatus: () => status, getSession: () => ({ allowWrite, review }), refresh: async () => {} });
  return { panel, main, detail, commands, status };
}

test('intake keeps drafts and current-library selection across polling and remounts', async () => {
  const { panel, main, detail, commands } = ui();
  const data = { libraries: [{ id: 'lib', label: '<img>Library', currentVersionId: 'v1', versions: ['v1'], permissions: [] }], jobs: [], capabilities: { plan: true } };
  panel.refresh(data); panel.renderIntake(main, detail);
  assert.ok(descendants(main).some(node => Object.hasOwn(node.dataset, 'fwaIntake')));
  assert.equal(detail.hidden, true, 'no empty preview should compete with the requirement entry');
  assert.ok(descendants(main).filter(node => node.tagName === 'DETAILS').every(node => node.open === false));
  const requirement = find(main, node => node.attributes['aria-label'] === '需求描述'); requirement.value = 'Unsubmitted request'; requirement.emit('input');
  const select = find(main, node => node.tagName === 'INPUT' && node.type === 'checkbox'); select.checked = true; select.emit('change');
  panel.refresh({ ...data, jobs: [{ id: 'pending-job', type: 'workflow.plan', state: 'running' }] });
  assert.equal(requirement.value, 'Unsubmitted request');
  panel.renderIntake(main, detail);
  assert.equal(find(main, node => node.attributes['aria-label'] === '需求描述').value, 'Unsubmitted request');
  assert.equal(find(main, node => node.tagName === 'INPUT' && node.type === 'checkbox').checked, true);
  find(main, node => node.tagName === 'FORM').emit('submit'); await flush();
  assert.equal(commands.length, 1); assert.equal(commands[0].type, 'workflow.plan'); assert.equal(commands[0].payload.request, 'Unsubmitted request');
  assert.deepEqual(Array.from(commands[0].payload.libraryIds), ['lib']); assert.equal(commands[0].payload.mode, 'plan');
  assert.equal(find(main, node => node.dataset.testid === 'fwa-workflow-jobs').parentElement.open, true, 'submitted request feedback becomes visible');
  assert.match(text(main), /已提交/); assert.doesNotMatch(text(main), /工程已完成！/);
  panel.dispose();
});

test('the optional Work setting remains explicit and changes only the requested execution mode', async () => {
  const { panel, main, detail, commands } = ui();
  panel.refresh({ libraries: [], jobs: [], capabilities: { plan: true } }); panel.renderIntake(main, detail);
  const request = find(main, node => node.attributes['aria-label'] === '需求描述'); request.value = 'One independent change'; request.emit('input');
  const mode = find(main, node => node.attributes['aria-label'] === '规划模式'); mode.value = 'work'; mode.emit('change');
  assert.equal(find(main, node => node.textContent === '生成计划并开始执行').disabled, false);
  find(main, node => node.tagName === 'FORM').emit('submit'); await flush();
  assert.equal(commands[0].payload.mode, 'work'); assert.equal(commands[0].payload.request, request.value);
  panel.dispose();
});

test('missing planner and project checks remain explicit after removing idle help text', () => {
  const { panel, main, detail } = ui({ review: { configured: false } });
  panel.refresh({ libraries: [], jobs: [], capabilities: { plan: false } }); panel.renderIntake(main, detail);
  assert.match(text(main), /尚未配置需求规划器/); assert.match(text(main), /未配置项目检查/);
  assert.equal(find(main, node => node.textContent === '生成修改计划').disabled, true);
  panel.refresh({ libraries: [], jobs: [], capabilities: { plan: true } });
  assert.doesNotMatch(text(main), /尚未配置需求规划器/); assert.match(text(main), /未配置项目检查/);
  assert.equal(find(main, node => node.dataset.testid === 'fwa-workflow-jobs').parentElement.hidden, true);
  assert.doesNotMatch(text(main), /先生成可逐项检查|作业结束不等于/); panel.dispose();
});

test('feedback is pending, draft survives remount, and active work blocks revision not feedback', async () => {
  const { panel, detail, commands, status } = ui();
  status.nodes[0].status = 'running'; status.runs.push({ id: 'run', nodeId: 'n', status: 'running' });
  status.workflow.feedback.push({ id: 'f', nodeId: 'n', goalId: 'g', text: 'Pending change', status: 'pending' });
  panel.nodeFeedback(detail, 'n');
  const input = find(detail, node => node.attributes['aria-label'] === '节点修改建议'); input.value = 'Make a new version'; input.emit('input');
  assert.equal(find(detail, node => node.tagName === 'BUTTON' && node.textContent === '按待处理反馈修订计划').disabled, true);
  assert.equal(find(detail, node => node.tagName === 'BUTTON' && node.textContent === '提交待处理反馈').disabled, false);
  assert.match(text(detail), /待处理 · 尚未生效/);
  find(detail, node => node.tagName === 'BUTTON' && node.textContent === '提交待处理反馈').emit('click'); await flush();
  assert.equal(commands[0].type, 'node.feedback'); assert.equal(commands[0].payload.text, 'Make a new version');
  detail.replaceChildren(); panel.nodeFeedback(detail, 'n');
  assert.equal(find(detail, node => node.attributes['aria-label'] === '节点修改建议').value, 'Make a new version');
  status.nodes[0].status = 'accepted'; status.runs[0].status = 'produced'; panel.refresh({ libraries: [], jobs: [], capabilities: {} });
  const revise = find(detail, node => node.tagName === 'BUTTON' && node.textContent === '按待处理反馈修订计划'); assert.equal(revise.disabled, false);
  revise.emit('click'); await flush();
  assert.equal(commands[1].type, 'workflow.revise'); assert.equal(commands[1].payload.expectedRevision, 1);
  assert.deepEqual(Array.from(commands[1].payload.feedbackIds), ['f']); panel.dispose();
});

test('readonly mode disables writes and true job failures/questions remain explicit', () => {
  const { panel, main, detail, commands } = ui({ allowWrite: false });
  panel.refresh({ libraries: [], capabilities: {}, jobs: [{ id: 'j', type: 'workflow.plan', state: 'succeeded', result: { questions: ['Which goal?'] } },
    { id: 'k', type: 'workflow.work', state: 'failed', error: { code: 'executor-error', message: 'Real failure' } },
    { id: 'l', type: 'workflow.work', state: 'succeeded', result: { stopReason: 'needs-acceptance' } }] });
  panel.renderIntake(main, detail); panel.nodeFeedback(detail, 'n');
  assert.ok(descendants(main).filter(node => node.type === 'file').every(node => node.disabled));
  assert.equal(find(main, node => node.tagName === 'BUTTON' && node.textContent === '生成修改计划').disabled, true);
  assert.match(text(main), /需要补充信息/); assert.match(text(main), /Real failure/); assert.match(text(main), /等待验收/);
  assert.equal(find(detail, node => node.tagName === 'BUTTON' && node.textContent === '提交待处理反馈').disabled, true);
  assert.equal(commands.length, 0); panel.dispose();
});

test('background library refresh never replaces a Node inspector after leaving intake', async () => {
  const { panel, main, detail } = ui();
  const library = { id: 'lib', label: 'Library', currentVersionId: 'v1', versions: ['v1'], permissions: [] };
  panel.refresh({ libraries: [library], jobs: [] }); panel.renderIntake(main, detail);
  find(main, node => node.dataset.libraryId === 'lib').emit('click'); await flush();
  main.replaceChildren(new Element('section', 'DAG')); detail.replaceChildren(new Element('h2', 'Current Node inspector'));
  panel.refresh({ libraries: [{ ...library, currentVersionId: 'v2', versions: ['v1', 'v2'] }], jobs: [] }); await flush();
  assert.equal(text(detail).trim(), 'Current Node inspector'); panel.dispose();
});

test('zero-change warnings use exact historical ChangeSets without rewriting immutable jobs or guessing missing files', () => {
  const { panel, main, detail, status } = ui();
  status.changeSets = [{ id: 'zero', runId: 'run-zero', changedFiles: [] },
    { id: 'changed', runId: 'run-changed', changedFiles: ['output.txt'] }, { id: 'unknown', runId: 'run-unknown' }];
  const jobs = [{ id: 'old', type: 'workflow.work', state: 'succeeded', result: { stopReason: 'awaiting-acceptance',
    rounds: [{ members: [{ runId: 'run-zero', changeSetId: 'zero' }, { runId: 'run-changed', changeSetId: 'changed' }] }] } }];
  const before = JSON.stringify(jobs);
  panel.refresh({ libraries: [], jobs }); panel.renderIntake(main, detail);
  assert.match(text(main), /未产生文件改动，需核对执行日志/);
  assert.match(text(main), /零改动 Run：run-zero/); assert.doesNotMatch(text(main), /零改动 Run：run-changed/);
  assert.equal(JSON.stringify(jobs), before);
  panel.refresh({ libraries: [], jobs: [{ id: 'unknown', type: 'workflow.work', state: 'succeeded', result: {
    rounds: [{ members: [{ runId: 'run-unknown', changeSetId: 'unknown' }, { runId: 'wrong-run', changeSetId: 'zero' }] }]
  } }] });
  assert.doesNotMatch(text(main), /未产生文件改动，需核对执行日志/);
  panel.refresh({ libraries: [], jobs: [{ id: 'new', type: 'workflow.plan', state: 'succeeded', result: {
    work: { stopReason: 'no-changes-awaiting-review', rounds: [] }
  } }] });
  assert.match(text(main), /未产生文件改动，需核对执行日志/);
  panel.dispose();
});

test('revision UI fence matches project-wide scheduler operations and historical nodes cannot submit', async () => {
  const { hasActiveOperation } = load();
  const { panel, detail, commands, status } = ui();
  status.workflow.feedback.push({ id: 'f', nodeId: 'n', goalId: 'g', text: 'Pending', status: 'pending' });
  panel.nodeFeedback(detail, 'n');
  const submit = find(detail, node => node.tagName === 'BUTTON' && node.textContent === '提交待处理反馈');
  const revise = find(detail, node => node.tagName === 'BUTTON' && node.textContent === '按待处理反馈修订计划');
  const cases = { runs: ['pending', 'running', 'paused', 'produced', 'failed'], evaluations: ['requested', 'running', 'recovery-required', 'passed'],
    integrations: ['pending', 'running', 'recovery-required', 'succeeded'], reversions: ['pending', 'running', 'recovery-required', 'succeeded'], runBatches: ['running', 'completed'] };
  for (const [collection, states] of Object.entries(cases)) for (const operationStatus of states) {
    // Another goal's operations also hold the project-wide revision fence.
    status[collection] = [{ goalId: 'another-goal', status: operationStatus }];
    assert.equal(hasActiveOperation(status), hasActiveProjectOperation(status), `${collection}:${operationStatus}`);
    panel.refresh({ libraries: [], jobs: [] }); assert.equal(revise.disabled, hasActiveProjectOperation(status)); assert.equal(submit.disabled, false);
    status[collection] = [];
  }
  status.runs = [{ status: 'failed', failure: { code: 'git-process-termination-unconfirmed', details: { fencePersisted: false } } }];
  assert.equal(hasActiveOperation(status), hasActiveProjectOperation(status)); panel.refresh({ libraries: [], jobs: [] }); assert.equal(revise.disabled, true);
  status.runs = []; status.nodes[0].supersededByRevision = 'revision-2'; panel.refresh({ libraries: [], jobs: [] });
  assert.equal(submit.disabled, true); assert.equal(revise.disabled, true); assert.match(text(detail), /历史或已移出/);
  const input = find(detail, node => node.attributes['aria-label'] === '节点修改建议'); input.value = 'Historical draft'; input.emit('input');
  submit.emit('click'); revise.emit('click'); await flush(); assert.equal(commands.length, 0);
  delete status.nodes[0].supersededByRevision; status.goals[0].nodeIds = []; panel.refresh({ libraries: [], jobs: [] }); assert.equal(submit.disabled, true);
  panel.dispose();
});

test('late tree and content responses cannot mutate detached intake views', async () => {
  const pending = [];
  const { panel, main, detail } = ui({ readApi: url => new Promise(resolve => pending.push({ url, resolve })) });
  const library = { id: 'lib', label: 'Library', currentVersionId: 'v1', versions: ['v1'], permissions: [] };
  panel.refresh({ libraries: [library], jobs: [] }); panel.renderIntake(main, detail);
  find(main, node => node.dataset.libraryId === 'lib').emit('click');
  main.replaceChildren(new Element('section', 'DAG')); detail.replaceChildren(new Element('h2', 'Current Node inspector'));
  pending.shift().resolve({ versionId: 'v1', tree: { name: 'Library', path: '', type: 'directory', access: 'read', children: [] } }); await flush();
  assert.equal(text(detail).trim(), 'Current Node inspector');
  panel.renderIntake(main, detail);
  pending.shift().resolve({ versionId: 'v1', tree: { name: 'Library', path: '', type: 'directory', access: 'read', children: [
    { name: 'a.txt', path: 'a.txt', type: 'file', access: 'read' }
  ] } }); await flush();
  find(detail, node => node.dataset.libraryPath === 'a.txt').emit('click');
  const oldPreview = find(detail, node => node.dataset.testid === 'fwa-library-preview');
  // Even if a reused host stays connected, leaving the owning intake revokes updates.
  main.replaceChildren(new Element('section', 'DAG'));
  pending.shift().resolve({ size: 4, hash: 'sha256:hash', contentType: 'text/plain', text: 'Late data' }); await flush();
  assert.doesNotMatch(text(oldPreview), /Late data/); panel.dispose();
});

test('configured workflow uses native fields and inherited permission maps to a null command without changing the pinned version', async () => {
  const reads = [];
  const { panel, main, detail, commands } = ui({ readApi: async url => {
    reads.push(url);
    return { versionId: new URL(`http://localhost${url}`).searchParams.get('versionId'),
      tree: { name: 'Library', path: '', type: 'directory', access: 'deny', explicit: true, children: [] } };
  } });
  panel.refresh({ libraries: [{ id: 'lib', label: 'Library', currentVersionId: 'v2', versions: ['v1', 'v2'], permissions: [] }], jobs: [] });
  panel.renderIntake(main, detail);
  const request = find(main, node => node.attributes['aria-label'] === '需求描述');
  assert.equal(request.tagName, 'TEXTAREA'); assert.equal(request.maxLength, '16384'); assert.equal(request.required, false);
  const directory = find(main, node => node.attributes['aria-label'] === '选择文件夹');
  assert.equal(directory.webkitdirectory, true, 'The reflected native boolean property must not receive an empty string.');
  const mode = find(main, node => node.attributes['aria-label'] === '规划模式');
  assert.equal(mode.tagName, 'SELECT'); assert.deepEqual(mode.children.map(option => option.value), ['plan', 'work']);
  find(main, node => node.dataset.libraryId === 'lib').emit('click'); await flush();
  const versions = find(detail, node => node.attributes['aria-label'] === '预览资料版本'); versions.value = 'v1'; versions.emit('change'); await flush();
  assert.match(reads.at(-1), /versionId=v1/);
  const permission = find(detail, node => node.attributes['aria-label'] === '资料权限');
  assert.equal(permission.tagName, 'SELECT'); assert.deepEqual(permission.children.map(option => option.value), ['read', 'write', 'deny', '']);
  assert.equal(permission.value, 'deny'); permission.value = '';
  find(detail, node => node.textContent === '应用权限').emit('click'); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(commands[0])), { type: 'library.permission', payload: { libraryId: 'lib', path: '', access: null } });
  assert.match(reads.at(-1), /versionId=v1/);
  assert.equal(find(detail, node => node.attributes['aria-label'] === '预览资料版本').value, 'v1'); panel.dispose();
});

test('remount and disposal release owned drop listeners and transient native file controls', async () => {
  const { panel, main, detail, commands } = ui(); panel.renderIntake(main, detail);
  const drop = find(main, node => node.dataset.testid === 'fwa-reference-drop');
  const picker = find(main, node => node.attributes['aria-label'] === '选择文件'); picker.value = 'transient-file';
  main.replaceChildren(new Element('section', 'DAG')); panel.renderIntake(main, detail);
  assert.equal(picker.value, ''); assert.equal(drop.events.get('drop').length, 0);
  drop.emit('drop', { dataTransfer: { files: [file('stale.txt')], items: [] } }); await flush(); assert.equal(commands.length, 0);
  const current = find(main, node => node.dataset.testid === 'fwa-reference-drop'); panel.dispose();
  assert.equal(current.events.get('drop').length, 0);
});

test('group inspection is scoped to its goal and ambiguous IDs never select another goal implicitly', () => {
  const { panel, detail, status } = ui();
  status.workflow.goals = ['g1', 'g2'].map(goal => ({ id: goal, children: [{ id: 'group', title: `Group ${goal}`, phase: 'ready', children: [
    { id: `${goal}-leaf`, type: 'node', title: `Leaf ${goal}`, phase: 'ready' }
  ] }] }));
  panel.renderGroup(detail, 'group', 'g2'); assert.match(text(detail), /Leaf g2/); assert.doesNotMatch(text(detail), /Leaf g1/);
  detail.replaceChildren(); panel.renderGroup(detail, 'group'); assert.match(text(detail), /当前计划中没有此分组/);
  panel.dispose();
});

test('ordinary workflow layout is JSON-only and does not duplicate model constraints or inject a stylesheet', () => {
  assert.doesNotMatch(source, /C\.(?:el|button)\b|\.maxLength\s*=|createElement\(['"](?:style|button|input|select|textarea)['"]\)/);
  const nodes = [config];
  while (nodes.length) {
    const value = nodes.pop();
    if (!value || typeof value !== 'object') continue;
    assert.equal(Object.hasOwn(value.attrs || {}, 'style'), false);
    assert.equal(Object.hasOwn(value.attrs || {}, 'class'), false);
    if (value.schemaPath) for (const constraint of ['options', 'maxLength', 'required', 'minLength']) assert.equal(Object.hasOwn(value, constraint), false, `${value.schemaPath}.${constraint}`);
    nodes.push(...Object.values(value));
  }
});

test('planning and revision admission guards use the host-provided shared limits', () => {
  const { panel, main, detail, status } = ui({ interactionLimits: { maxReferenceLibraries: 1, maxRevisionFeedback: 1 } });
  const libraries = ['a', 'b'].map(id => ({ id, label: id, currentVersionId: 'v1', versions: ['v1'], permissions: [] }));
  panel.refresh({ libraries, jobs: [] });
  panel.renderIntake(main, detail); assert.match(text(main), /最多 1 个/);
  const inputs = descendants(main).filter(node => node.type === 'checkbox');
  const plan = find(main, node => node.textContent === '生成修改计划');
  inputs[0].checked = true; inputs[0].emit('change'); assert.equal(plan.disabled, false);
  inputs[1].checked = true; inputs[1].emit('change'); assert.equal(plan.disabled, true);
  status.workflow.feedback = [{ id: 'f1', nodeId: 'n', goalId: 'g', text: 'One', status: 'pending' }];
  panel.nodeFeedback(detail, 'n');
  const revise = find(detail, node => node.textContent === '按待处理反馈修订计划'); assert.equal(revise.disabled, false);
  status.workflow.feedback.push({ id: 'f2', nodeId: 'n', goalId: 'g', text: 'Two', status: 'pending' });
  panel.refresh({ libraries, jobs: [] }); assert.equal(revise.disabled, true); panel.dispose();
});
