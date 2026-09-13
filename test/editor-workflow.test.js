import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { FwaApplication } from '../src/application/fwa-application.js';
import { startEditor } from '../src/editor/server.js';
import { parsePlannerResponse } from '../src/adapters/codex-planner.js';
const fwePath = path.resolve(process.env.FWA_TEST_FWE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fwe'));
const integration = { skip: !existsSync(path.join(fwePath, 'src/server.js')) && 'Explicit sibling FWE required.' };
const git = (root, args) => {
  const r = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
async function fixture(t, allowWrite = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-workflow-http-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Test']); git(root, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n'); await writeFile(path.join(root, 'seed.txt'), 'baseline');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']);
  const application = new FwaApplication(root); await application.init();
  let planCalls = 0;
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0, allowWrite, workflow: {
    planner: { async plan(input) {
      planCalls++;
      return parsePlannerResponse({ title: 'HTTP test plan', questions: [], groups: [{ id: 'group', title: 'Feature', parentId: '' }], nodes: [
        { id: 'leaf', title: 'Leaf', parentId: 'group', instruction: 'Create output.txt', dependsOn: [], reads: ['seed.txt'], writes: ['output.txt'], checks: ['output exists'], maxFiles: 1, maxDiffLines: 30 }
      ] }, { prefix: input.prefix, referenceInputs: input.references.map(r => r.binding) });
    } }, executor: null
  } });
  t.after(() => editor.close());
  const session = await (await fetch(editor.url + '/api/fwa/session')).json();
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWA-CSRF': session.csrfToken, 'X-FWA-Fingerprint': session.fingerprint };
  const get = async route => { const r = await fetch(editor.url + route); return { status: r.status, body: await r.json() }; };
  const post = async (type, payload, commandId, route = '/api/fwa/commands', overrides = {}) => {
    const r = await fetch(editor.url + route, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify({ type, payload, commandId }) });
    return { status: r.status, body: await r.json() };
  };
  return { root, application, editor, session, get, post, planCalls: () => planCalls };
}
test('guarded HTTP import/preview/permission/plan/feedback chain preserves clean host and never executes in Plan', integration, async t => {
  const f = await fixture(t);
  const payload = { label: 'Brief', files: [{ path: 'docs/brief.md', base64: Buffer.from('A fixture requirement.').toString('base64') }] };
  const denied = await f.post('library.import', payload, 'import-denied', '/api/fwa/import', { 'X-FWA-CSRF': 'wrong' }); assert.equal(denied.status, 403);
  const imported = await f.post('library.import', payload, 'import-ok', '/api/fwa/import'); assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const libraryId = imported.body.result.libraryId;
  assert.equal((await f.get('/api/fwa/workbench')).body.libraries.length, 1);
  const tree = await f.get(`/api/fwa/library/tree?libraryId=${libraryId}`); assert.equal(tree.body.tree.children[0].type, 'directory');
  const contentUrl = `/api/fwa/library/content?libraryId=${libraryId}&path=docs%2Fbrief.md`;
  assert.equal((await f.get(contentUrl)).body.text, 'A fixture requirement.');
  assert.equal((await f.post('library.permission', { libraryId, path: 'docs', access: 'deny' }, 'deny')).status, 200);
  assert.equal((await f.get(contentUrl)).body.code, 'library-read-denied');
  await f.post('library.permission', { libraryId, path: 'docs/brief.md', access: 'read' }, 'allow-child');
  assert.equal((await f.get(contentUrl)).status, 200);
  const planned = await f.post('workflow.plan', { request: '', libraryIds: [libraryId], mode: 'plan' }, 'plan'); assert.equal(planned.status, 200, JSON.stringify(planned.body));
  let jobs;
  for (let attempt = 0; attempt < 80; attempt++) {
    jobs = (await f.get('/api/fwa/workbench')).body.jobs;
    if (jobs[0]?.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(jobs[0].state, 'succeeded', JSON.stringify(jobs[0]));
  const status = (await f.get('/api/fwa/status')).body;
  assert.equal(status.runs.length, 0); assert.equal(status.workflow.goals[0].phase, 'ready');
  assert.equal((await f.post('node.feedback', { nodeId: status.nodes[0].id, text: 'Use blue.' }, 'feedback')).body.result.feedback.status, 'pending');
  assert.equal((await f.post('workflow.work', { goalId: status.goals[0].id }, 'work')).body.code, 'workbench-executor-unavailable');
  assert.equal(git(f.root, ['status', '--porcelain']), ''); assert.equal(f.planCalls(), 1);
  assert.equal((await f.application.verify()).ok, true);
});
test('read-only launch denies import and does not initialize library/jobs during queries', integration, async t => {
  const f = await fixture(t, false);
  assert.equal((await f.get('/api/fwa/workbench')).status, 200);
  assert.ok(!existsSync(path.join(f.root, '.fwa/library'))); assert.ok(!existsSync(path.join(f.root, '.fwa/workbench-jobs')));
  assert.equal((await f.post('library.import', { label: 'Denied', files: [] }, 'denied', '/api/fwa/import')).status, 403);
  assert.equal(f.session.workflowCommands.length, 0);
});
