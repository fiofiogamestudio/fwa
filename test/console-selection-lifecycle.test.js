import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const consoleSource = await readFile(new URL('../src/editor/app/console.js', import.meta.url), 'utf8');
const modelSource = await readFile(new URL('../src/editor/app/workbench-model.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(text = '') { this.ownText = text; this.children = []; this.parentNode = null; this.listeners = new Map(); this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; }
  get isConnected() { return this.attached || Boolean(this.parentNode?.isConnected); }
  get textContent() { return this.ownText + this.children.map(item => item.textContent).join(' '); }
  set textContent(text) { this.replaceChildren(); this.ownText = String(text); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.ownText = ''; this.append(...children); }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
  emit(name) { for (const callback of this.listeners.get(name) || []) callback({ target: this }); }
  setAttribute() {}
  querySelectorAll() { return []; }
}
const node = (id, extra = {}) => ({ id, logicalId: id, goalId: 'goal', title: id, status: 'ready', validity: 'valid',
  dependsOn: [], reads: [], writes: ['output.txt'], acceptance: { checks: ['output-value'] }, ...extra });
function status(nodes = [node('source')], extra = {}) {
  return { projectId: 'project', projectRoot: 'fixture', lastSequence: 1,
    goals: [{ id: 'goal', title: 'Requested outcome', status: 'planned', nodeIds: nodes.filter(item => !item.supersededByRevision).map(item => item.id) }],
    nodes, refs: [], runs: [], changeSets: [], evidence: [], evaluations: [], integrations: [], reversions: [], ...extra };
}
async function consoleFixture(initial) {
  let snapshot = structuredClone(initial), view, ui, content, graph, createCount = 0, fitCount = 0;
  const navigation = [], commands = [], storage = new Map(), host = new Element(); host.attached = true;
  const session = { projectId: 'project', projectRoot: 'fixture', protocol: 'fwa-console-v1', fingerprint: 'fixture', csrfToken: 'fixture',
    allowWrite: true, workflow: { work: true }, review: { configured: true } };
  const window = { addEventListener() {}, removeEventListener() {},
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    FwaNavigation: { target: (type, id, options) => ({ type, id, ...options }) },
    fwe: { session: { headers: values => values }, registerView(_name, registered) { view = registered; },
      resources: { async refresh() {} }, navigation: { async navigate(target) { navigation.push(plain(target)); return true; } },
      ui: { createGraph(options) {
        createCount++; graph = { data: { nodes: options.nodes, edges: options.edges, selectedId: options.selectedId },
          click: options.onSelect, update(data) { this.data = data; }, select(id) { this.data.selectedId = id; },
          fit() { fitCount++; }, destroy() {} }; return graph;
      } } },
    FwaSurface: { configure() {}, resourceLink: (_type, id) => new Element(id), create(_name, bindings) {
      const root = new Element(); root.refs = {};
      for (const name of ['goalSelect', 'mode', 'refresh', 'message', 'request', 'libraryPreview', 'graphHost', 'detail', 'progress', 'work',
        'requestDisclosure', 'requestSummary', 'workReason', 'graphScope', 'graphScopeNote']) { root.refs[name] = new Element(); root.append(root.refs[name]); }
      ui = { root, actions: bindings.actions, dispose() {}, setOptions(element, _options, value) { element.value = value; }, render(template, data = {}) {
        const result = new Element(data.title || data.text || ''); result.refs = {};
        if (template === 'inspector') for (const name of ['facts', 'feedback', 'links', 'back']) { result.refs[name] = new Element(); result.append(result.refs[name]); }
        if (template === 'goal') { result.refs.record = new Element(); result.append(result.refs.record); }
        return result;
      } }; return ui;
    } },
    FwaWorkbenchContent: { create(options) {
      content = options;
      return { node(target, id) { const data = window.FwaWorkbenchModel.nodeWorkbench(options.getStatus(), id); target.append(new Element(`${id} ${data?.activity.label || ''}`)); },
        metadata: () => new Element(), record: value => new Element(JSON.stringify(value)), artifactLinks() {}, dispose() {} };
    } }
  };
  const context = { window, document: { hidden: false }, AbortSignal, crypto: webcrypto, TextEncoder, Uint8Array,
    setInterval: () => 1, clearInterval() {}, fetch: async (url, options) => {
      let body;
      if (url === '/api/fwa/session') body = session;
      else if (url.startsWith('/api/fwa/status')) body = structuredClone(snapshot);
      else if (url === '/api/fwa/workbench') body = { jobs: [] };
      else if (url === '/api/fwa/commands') { commands.push(JSON.parse(options.body)); body = { result: { id: 'job' } }; }
      else throw new Error(`Unexpected URL ${url}`);
      return { ok: true, json: async () => body };
    } };
  vm.runInNewContext(modelSource, context); vm.runInNewContext(consoleSource, context);
  view.render({ data: snapshot, app: { labels: { fwaConsole: { protocol: 'fwa-console-v1', fingerprint: 'fixture' } } },
    hosts: { documentTree: host }, showView() {} });
  await settle();
  return { get ui() { return ui; }, get graph() { return graph; }, navigation, commands,
    get createCount() { return createCount; }, get fitCount() { return fitCount; },
    async refresh(next = snapshot) { snapshot = structuredClone(next); await ui.actions.refresh(); await settle(); },
    async select(type, id) { content.select(type, id); await settle(); },
    async click(id) { graph.click(id); await settle(); },
    async work() { await ui.actions.work(); await settle(); },
    get detail() { return ui.root.refs.detail.textContent; } };
}

test('a live plan revision moves the selected logical result to its current physical node', async () => {
  const f = await consoleFixture(status()); assert.equal(f.graph.data.selectedId, 'source');
  await f.refresh(status([node('source', { supersededByRevision: 'revision-2' }), node('source@revision-2', { logicalId: 'source' })], { lastSequence: 2 }));
  assert.equal(f.graph.data.selectedId, 'source@revision-2');
  assert.deepEqual(plain(f.graph.data.nodes.map(item => item.id)), ['source@revision-2']);
  assert.match(f.detail, /source@revision-2/); assert.doesNotMatch(f.detail, /历史版本/);
  assert.equal(f.navigation.at(-1)?.id, 'source@revision-2');
  const selected = f.graph, fits = f.fitCount; await f.refresh();
  assert.equal(f.graph, selected); assert.equal(f.createCount, 1); assert.equal(f.fitCount, fits, 'Ordinary polling must preserve the graph view.');
});

test('splitting the selected result opens its goal graph without arbitrarily selecting a derived child', async () => {
  const f = await consoleFixture(status());
  await f.refresh(status([node('source', { supersededByRevision: 'revision-2' }),
    node('child-a', { derivedFrom: 'source' }), node('child-b', { derivedFrom: 'source' })], { lastSequence: 2 }));
  assert.deepEqual(plain(f.graph.data.nodes.map(item => item.id)), ['child-a', 'child-b']);
  assert.equal(f.graph.data.selectedId, null); assert.match(f.detail, /Requested outcome/);
  assert.doesNotMatch(f.detail, /历史版本/); assert.equal(f.navigation.at(-1)?.type, 'goals');
  assert.equal(f.navigation.at(-1)?.id, 'goal');
  await f.refresh(); assert.equal(f.graph.data.selectedId, null, 'Polling must not select the first child later.');
});

test('an explicitly opened historical node remains selected while the current goal graph stays visible', async () => {
  const revised = status([node('source', { supersededByRevision: 'revision-2' }), node('source@revision-2', { logicalId: 'source' })]);
  const f = await consoleFixture(revised); await f.select('nodes', 'source');
  assert.match(f.detail, /source 历史版本/);
  await f.refresh({ ...revised, lastSequence: 2 });
  assert.match(f.detail, /source 历史版本/); assert.equal(f.navigation.at(-1)?.id, 'source');
  assert.deepEqual(plain(f.graph.data.nodes.map(item => item.id)), ['source@revision-2']);
});

test('clicking a node in All goals activates its owner and the single Continue command targets that goal', async () => {
  const data = status([node('first'), node('second', { goalId: 'other-goal' })], {
    goals: [{ id: 'goal', title: 'First goal', status: 'planned', nodeIds: ['first'] },
      { id: 'other-goal', title: 'Other goal', status: 'planned', nodeIds: ['second'] }] });
  const f = await consoleFixture(data); assert.equal(f.ui.root.refs.goalSelect.value, '');
  assert.equal(f.graph.data.selectedId, null, 'All goals must not silently select a node whose owner is inactive.');
  assert.deepEqual(plain(f.graph.data.nodes.map(item => item.id)).sort(), ['first', 'second']);
  await f.refresh(); assert.equal(f.graph.data.selectedId, null);
  await f.click('first'); assert.equal(f.ui.root.refs.goalSelect.value, 'goal');
  assert.equal(f.ui.root.refs.work.hidden, false); assert.equal(f.ui.root.refs.work.disabled, false);
  assert.doesNotMatch(f.ui.root.refs.workReason.textContent, /选择一个任务/);
  await f.work(); assert.equal(f.commands.length, 1); assert.equal(f.commands[0].type, 'workflow.work');
  assert.deepEqual(f.commands[0].payload, { goalId: 'goal' });
  f.ui.root.refs.goalSelect.value = ''; f.ui.root.refs.goalSelect.emit('change'); await settle();
  assert.equal(f.graph.data.selectedId, null, 'Returning to All goals clears the old node selection.');
  assert.deepEqual(plain(f.graph.data.nodes.map(item => item.id)).sort(), ['first', 'second']);
});
