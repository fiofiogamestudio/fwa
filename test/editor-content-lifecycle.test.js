import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEditorModel } from '../src/editor/editor-model.js';

const fwePath = path.resolve(process.env.FWA_TEST_FWE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fwe'));
const integration = { skip: !existsSync(path.join(fwePath, 'public/surface.js')) && 'Explicit sibling FWE Surface required.' };

// A small DOM with real parent/detachment semantics is enough to exercise the
// async content renderer. No server, application command or browser is started.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.ownText = '';
    this.connectedRoot = false;
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.name = '';
    this.value = '';
    this.listeners = new Map();
    this.classList = { add: (...names) => { this.className += ` ${names.join(' ')}`; } };
  }
  get isConnected() { return this.connectedRoot || Boolean(this.parentNode?.isConnected); }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value) {
    this.replaceChildren();
    this.ownText = String(value);
  }
  append(...children) {
    for (const child of children) {
      if (child.parentNode) {
        const previous = child.parentNode.children;
        previous.splice(previous.indexOf(child), 1);
      }
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = '';
    this.append(...children);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
  }
  removeAttribute(name) { delete this.attributes[name]; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  addEventListener(name, handler) { this.listeners.set(name, [...(this.listeners.get(name) || []), handler]); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== handler)); }
  dispatch(name) { for (const handler of this.listeners.get(name) || []) handler({ target: this, type: name, preventDefault() {} }); }
  querySelectorAll() { return descendants(this).filter(node => node.tagName === 'INPUT' && ['file', 'password'].includes(node.type)); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function createContent(api, status = { refs: [], nodes: [] }, select = () => {}, options = {}) {
  const window = {
    location: { origin: 'http://127.0.0.1:3220' },
    FwaWorkbenchModel: null
  };
  const context = vm.createContext({ window, URL, document: { createElement: tag => new Element(tag) } });
  vm.runInContext(await readFile(path.join(fwePath, 'public/inspector.js'), 'utf8'), context);
  vm.runInContext(await readFile(path.join(fwePath, 'public/surface.js'), 'utf8'), context);
  vm.runInContext(await readFile(new URL('../src/editor/app/workbench-model.js', import.meta.url), 'utf8'), context);
  const config = JSON.parse(await readFile(new URL('../src/editor/app/content.ui.json', import.meta.url), 'utf8'));
  window.FwaSurface = {
    create(name, bindings) { assert.equal(name, 'content'); return window.createFweSurface(config, { ...bindings, resolveField: key => createEditorModel().fields[key] }); },
    resourceLink(type, id, label, options) {
      const link = new Element('a'); link.textContent = label;
      link.dataset.resourceType = type; link.dataset.resourceId = id;
      link.addEventListener('click', () => options?.onSelect?.());
      return link;
    }
  };
  vm.runInContext(await readFile(new URL('../src/editor/app/workbench-content.js', import.meta.url), 'utf8'), context);
  return window.FwaWorkbenchContent.create({ api, getStatus: () => status, select, ...options });
}

test('finish binds the observed candidate token, requires passing evidence capability and needs no manual note', integration, async () => {
  const state = { nodes: [{ id: 'node-1', title: 'One behavior' }], changeSets: [{ id: 'change-1', nodeId: 'node-1', changedFiles: ['feature.js'] }], evidence: [] };
  const review = { reviewToken: 'a'.repeat(64), profiles: [{ id: 'real-checks' }], actions: { validate: true, finish: false, revert: false }, jobs: [], blockers: [], impact: { nodes: [] } };
  const calls = [];
  const content = await createContent(async () => review, state, () => {}, { command: async (...args) => calls.push(args), getSession: () => ({ allowWrite: true }) });
  const host = new Element('aside'); host.connectedRoot = true;
  const render = async () => { host.replaceChildren(); content.changeSet(host, 'change-1'); await new Promise(resolve => setImmediate(resolve)); };
  await render();
  let finish = descendants(host).find(item => item.dataset.action === 'finish');
  assert.equal(finish.hidden, true); assert.equal(finish.disabled, true);
  assert.equal(descendants(host).some(item => item.name === 'acceptanceNote'), false);
  review.evidenceId = 'passing-evidence'; await render();
  finish = descendants(host).find(item => item.dataset.action === 'finish'); assert.equal(finish.disabled, true);
  finish.dispatch('click'); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 0);
  review.actions.finish = true; await render();
  finish = descendants(host).find(item => item.dataset.action === 'finish'); assert.equal(finish.disabled, false); assert.equal(finish.hidden, false);
  finish.dispatch('click'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['workflow.finish', { changeSetId: 'change-1', reviewToken: 'a'.repeat(64) }]]);
  assert.equal(descendants(host).some(item => item.name === 'profileId' || item.dataset.action === 'validate'), false);
  review.completionMode = 'automatic'; review.autoFinishAllowed = false; await render();
  finish = descendants(host).find(item => item.dataset.action === 'finish'); assert.equal(finish.hidden, true);
  assert.match(host.textContent, /工作台顶部“继续”/);
  finish.dispatch('click'); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1);
  review.completionMode = 'manual'; review.autoFinishAllowed = true; await render();
  assert.equal(descendants(host).find(item => item.dataset.action === 'finish').hidden, false, 'The policy, not instantaneous admission, controls the human gate.');
  review.integrated = true; review.actions.finish = false; await render();
  assert.equal(descendants(host).find(item => item.dataset.action === 'finish').hidden, true);
  const note = descendants(host).find(item => item.name === 'revertNote'); note.value = 'Observed regression'; note.dispatch('input');
  const impact = descendants(host).find(item => item.tagName === 'DETAILS' && item.textContent.includes('撤销此项：查看依赖影响')); impact.open = true;
  await render();
  assert.equal(descendants(host).find(item => item.name === 'revertNote').value, 'Observed regression');
  assert.equal(descendants(host).find(item => item.tagName === 'DETAILS' && item.textContent.includes('撤销此项：查看依赖影响')).open, true);
  content.dispose();
});

test('review failure remains visible without opening technical operation history', integration, async () => {
  const state = { nodes: [{ id: 'n', title: 'Counter' }], changeSets: [{ id: 'c', nodeId: 'n', changedFiles: ['counter.js'] }], evidence: [] };
  const review = { reviewToken: 'a'.repeat(64), profiles: [], actions: {}, current: true,
    jobs: [{ type: 'change.validate', state: 'failed', error: { message: 'Counter output was incorrect' } }], blockers: [], impact: { nodes: [] } };
  const content = await createContent(async () => review, state, () => {}, { command: async () => {}, getSession: () => ({ allowWrite: true }) });
  const host = new Element('aside'); host.connectedRoot = true;
  content.changeSet(host, 'c'); await new Promise(resolve => setImmediate(resolve));
  const failure = descendants(host).find(item => item.tagName === 'DIV' && item.textContent === 'Counter output was incorrect');
  assert.ok(failure); assert.equal(failure.hidden, false); assert.equal(failure.parentNode.tagName, 'FIELDSET');
  assert.doesNotMatch(host.textContent, /运行项目配置中的检查，结果会绑定/); content.dispose();
});

test('candidate diff loads only on expansion, stays inside the selected node and preserves expansion across refresh', integration, async () => {
  const digest = 'd'.repeat(64), patch = '--- a/counter.js\n+++ b/counter.js\n-module.exports = 0;\n+module.exports = 1;\n';
  const state = { nodes: [{ id: 'n', title: 'Counter', changeSetIds: ['c'] }], changeSets: [{ id: 'c', nodeId: 'n', changedFiles: ['counter.js'], patchArtifact: { digest, size: patch.length } }], evidence: [] };
  const reads = [], selections = [];
  const content = await createContent(async url => { reads.push(url); return { digest, size: patch.length, text: patch, format: 'text' }; }, state, (...args) => selections.push(args));
  const host = new Element('aside'); host.connectedRoot = true;
  content.node(host, 'n'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 0);
  const disclosure = descendants(host).find(item => item.dataset.testid === 'fwa-candidate-diff');
  disclosure.open = true; disclosure.dispatch('toggle'); await new Promise(resolve => setImmediate(resolve));
  const diff = descendants(host).find(item => item.dataset.testid === 'fwa-diff');
  assert.ok(diff); assert.ok(diff.children.some(line => line.className === 'fwa-diff-add'));
  assert.equal(reads.length, 1); assert.equal(selections.length, 0);
  host.replaceChildren(); content.node(host, 'n');
  const refreshed = descendants(host).find(item => item.dataset.testid === 'fwa-candidate-diff');
  assert.equal(refreshed.open, true); assert.equal(descendants(host).find(item => item.dataset.testid === 'fwa-diff'), diff);
  assert.equal(reads.length, 1);
  refreshed.open = false; refreshed.dispatch('toggle'); host.replaceChildren(); content.node(host, 'n');
  assert.equal(descendants(host).find(item => item.dataset.testid === 'fwa-candidate-diff').open, false);
  host.replaceChildren(); content.changeSet(host, 'c');
  assert.equal(reads.length, 1, 'The compatible independent resource view is also lazy.');
  assert.match(host.textContent, /文件差异/); content.dispose();
});

for (const outcome of ['failure', 'success']) {
  test(`a detached Ref preview cannot append old records after a late ${outcome}`, integration, async () => {
    const oldRequest = deferred();
    const refs = [
      { id: 'ref://doc/old', uri: 'brief/old.md', kind: 'doc', version: 'old-version', metadata: {} },
      { id: 'ref://doc/current', uri: 'brief/current.md', kind: 'doc', version: 'current-version', metadata: {} }
    ];
    const requested = [];
    const content = await createContent(async url => {
      requested.push(url);
      return url.includes(encodeURIComponent(refs[0].id)) ? oldRequest.promise
        : { kind: 'text', text: '# Current input\nKeep this content.', versionLabel: 'Current workspace bytes.' };
    }, { refs, nodes: [] });
    const inspector = new Element('aside'); inspector.connectedRoot = true;
    const oldRender = content.ref(inspector, refs[0].id);
    const oldPreview = descendants(inspector).find(item => item.dataset.testid === 'fwa-ref-preview');
    assert.equal(oldPreview.isConnected, true);

    // This is the shell's actual selection lifecycle: reuse the inspector, but
    // detach its previous children before rendering the newly selected object.
    inspector.replaceChildren();
    assert.equal(oldPreview.isConnected, false);
    await content.ref(inspector, refs[1].id);
    const currentText = inspector.textContent;
    assert.match(currentText, /Current input/);
    assert.match(currentText, /current-version/);
    assert.doesNotMatch(currentText, /old-version/);

    if (outcome === 'failure') oldRequest.reject(new Error('Old resource failed after selection changed.'));
    else oldRequest.resolve({ kind: 'text', text: 'Old response must not appear.', versionLabel: 'old-version' });
    await oldRender;

    assert.equal(inspector.textContent, currentText);
    assert.equal(descendants(inspector).filter(item => item.dataset.testid === 'fwa-record').length, 1);
    assert.equal(requested.length, 2);
  });
}

test('execution-envelope result.process.stderr is highlighted as well as retained in the full artifact', integration, async () => {
  const stderr = 'CreateProcessWithLogonW failed: 1385';
  const envelope = { schemaVersion: 1, result: { ok: true, process: { exitCode: 0, stderr } } };
  const digest = 'a'.repeat(64);
  const text = JSON.stringify(envelope);
  const requested = [];
  const content = await createContent(async url => {
    requested.push(url);
    return { digest, size: Buffer.byteLength(text), text, format: 'json', truncated: false };
  });
  const viewer = new Element('section'); viewer.connectedRoot = true;
  await content.showArtifact(viewer, { digest, size: Buffer.byteLength(text) }, 'executionArtifact');

  assert.deepEqual(requested, [`/api/fwa/artifacts?digest=${digest}`]);
  const error = descendants(viewer).find(item => item.dataset.testid === 'fwa-error-output');
  assert.ok(error, 'the nested process stderr must have its own error presentation');
  assert.equal(error.textContent, stderr);
  const full = descendants(viewer).find(item => item.dataset.testid === 'fwa-artifact-text');
  assert.deepEqual(JSON.parse(full.textContent), envelope);
  assert.doesNotMatch(viewer.textContent, /任务成功/);
});

test('disposing content prevents an outstanding artifact request from rendering into a still-mounted host', integration, async () => {
  const request = deferred(), digest = 'b'.repeat(64);
  const content = await createContent(() => request.promise);
  const viewer = new Element('section'); viewer.connectedRoot = true;
  const pending = content.showArtifact(viewer, { digest, size: 4 });
  content.dispose();
  assert.equal(viewer.textContent, '');
  request.resolve({ digest, size: 4, text: 'late', format: 'text' });
  await pending;
  assert.equal(viewer.textContent, '');
  content.dispose();
});

test('superseded artifact requests cannot replace the selected immutable artifact', integration, async () => {
  const previous = deferred();
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const content = await createContent(url => url.includes(a) ? previous.promise : { digest: b, size: 7, text: 'current', format: 'text' });
  const viewer = new Element('section'); viewer.connectedRoot = true;
  const old = content.showArtifact(viewer, { digest: a, size: 3 }, 'old');
  await content.showArtifact(viewer, { digest: b, size: 7 }, 'current');
  const selected = viewer.textContent;
  previous.resolve({ digest: a, size: 3, text: 'old', format: 'text' });
  await old;
  assert.equal(viewer.textContent, selected);
  assert.match(selected, /current/);
});

test('a reused event host rejects a detached page and preserves the new cursor', integration, async () => {
  const previous = deferred(), requested = [];
  const content = await createContent(url => {
    requested.push(url);
    if (url.includes('nodeId=old')) return previous.promise;
    return { events: [{ sequence: 8, type: 'Current.Event', timestamp: '2026-09-08T00:00:00Z' }], nextSequence: 8, hasMore: false };
  });
  const host = new Element('section'); host.connectedRoot = true;
  const old = content.events(host, 'old');
  const current = await content.events(host, 'new');
  const selected = host.textContent;
  previous.resolve({ events: [{ sequence: 1, type: 'Old.Event' }], nextSequence: 1, hasMore: true });
  await old;
  assert.equal(host.textContent, selected);
  assert.doesNotMatch(host.textContent, /Old.Event/);
  await current.refresh();
  assert.equal(requested.at(-1), '/api/fwa/events?after=8&limit=100&nodeId=new');
});

test('artifact metadata mismatch and an unbound media URL are rejected before media display', integration, async () => {
  const digest = 'c'.repeat(64);
  for (const response of [
    { digest: 'd'.repeat(64), size: 4, text: 'evil', format: 'text' },
    { digest, size: 5, text: 'evil', format: 'text' },
    { digest, size: 4, format: 'image', url: 'https://external.invalid/track.png' },
    { digest, size: 4, format: 'video', url: '/api/fwa/artifacts?digest=' + 'd'.repeat(64) + '&raw=1' }
  ]) {
    const content = await createContent(() => response);
    const host = new Element('section'); host.connectedRoot = true;
    await content.showArtifact(host, { digest, size: 4 });
    assert.ok(descendants(host).some(item => item.dataset.testid === 'fwa-error-output'));
    assert.equal(descendants(host).some(item => ['IMG', 'VIDEO'].includes(item.tagName)), false);
    content.dispose();
  }
});

test('configured evidence rows preserve criterion actions and use the shared object resource helper', integration, async () => {
  const selected = [], calls = [], digest = 'e'.repeat(64);
  const content = await createContent(url => {
    calls.push(url); return { digest, size: 7, text: 'failure', format: 'text' };
  }, { evidence: [{ id: 'ev-1', result: 'failed', kind: 'checks', changeSetId: 'change-1', criteria: [
    { id: 'compile', result: 'failed', durationMs: 50, stderrArtifact: { algorithm: 'sha256', digest, size: 7 } }
  ] }] }, (...args) => selected.push(args));
  const host = new Element('aside'); host.connectedRoot = true;
  content.evidence(host, 'ev-1');
  const table = descendants(host).find(item => item.dataset.testid === 'fwa-criteria');
  assert.equal(table.attributes.role, 'table');
  const rows = descendants(table).filter(item => item.attributes.role === 'row' && item.attributes['data-criterion']);
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /compile/);
  const error = descendants(rows[0]).find(item => item.tagName === 'BUTTON' && item.textContent === '错误');
  error.dispatch('click'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['/api/fwa/artifacts?digest=' + digest]);
  assert.ok(descendants(host).some(item => item.dataset.testid === 'fwa-artifact-text' && item.textContent === 'failure'));
  const resource = descendants(host).find(item => item.dataset.resourceType === 'changeSets');
  assert.equal(resource.dataset.resourceId, 'change-1'); resource.dispatch('click');
  assert.deepEqual(selected, [['changeSets', 'change-1']]);
});

test('document rendering preserves untrusted markup as inert text', integration, async () => {
  const content = await createContent(() => assert.fail('document preview must not fetch'));
  const doc = content.documentText('# Reference\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```html\n<iframe src=x>\n```');
  assert.match(doc.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(descendants(doc).some(item => ['SCRIPT', 'IFRAME', 'IMG'].includes(item.tagName)), false);
});

test('Node, Run and ChangeSet compositions render through the current FWE Surface without legacy controls', integration, async () => {
  const state = {
    goals: [{ id: 'goal-1', title: 'A goal', status: 'active' }],
    nodes: [{ id: 'node-1', goalId: 'goal-1', title: 'A running node', instruction: 'Full technical implementation instructions',
      acceptance: { commands: ['compile'], checks: ['feature-check-id'] }, status: 'running', validity: 'valid',
      reads: ['ref-1'], writes: [], dependsOn: [], budget: { maxRetries: 2 } }],
    refs: [{ id: 'ref-1', uri: 'brief.md', kind: 'doc', version: 'v1' }],
    runs: [{ id: 'run-1', nodeId: 'node-1', status: 'failed', summary: 'Execution failed', failure: { code: 'EXEC', message: 'Failed', details: { process: { stderr: 'sandbox unavailable' } } } }],
    changeSets: [{ id: 'change-1', nodeId: 'node-1', runId: 'run-1', changedFiles: [] }],
    evidence: []
  };
  const content = await createContent(() => assert.fail('compositions should not load without an artifact'), state);
  const host = new Element('aside'); host.connectedRoot = true;
  content.node(host, 'node-1');
  assert.match(host.textContent, /A running node/);
  assert.equal(descendants(host).filter(item => item.tagName === 'H3' && item.textContent === 'A running node').length, 1);
  assert.doesNotMatch(host.textContent, /当前为只读模式|旧计划未单列结果说明/);
  const acceptance = descendants(host).find(item => item.dataset.testid === 'fwa-node-acceptance');
  assert.equal(acceptance.open, false); assert.match(acceptance.textContent, /验收标准（2）/);
  assert.match(acceptance.textContent, /compile/); assert.match(acceptance.textContent, /feature-check-id/);
  assert.ok(descendants(host).filter(item => item.tagName === 'BUTTON' && /执行此节点|继续验证此节点/.test(item.textContent)).every(item => item.hidden));
  assert.ok(descendants(host).some(item => item.dataset.tone === 'info'));
  assert.ok(descendants(host).some(item => item.dataset.resourceId === 'ref-1'));
  host.replaceChildren(); content.run(host, 'run-1');
  assert.match(host.textContent, /sandbox unavailable/);
  assert.ok(descendants(host).some(item => item.dataset.resourceId === 'node-1'));
  host.replaceChildren(); content.changeSet(host, 'change-1');
  assert.match(host.textContent, /没有文件变化/);
  assert.equal(descendants(host).some(item => ['TABLE', 'DL', 'INPUT', 'SELECT', 'TEXTAREA'].includes(item.tagName)), false);
  content.dispose();
});
