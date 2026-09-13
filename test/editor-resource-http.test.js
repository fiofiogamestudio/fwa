import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FwaApplication } from '../src/application/fwa-application.js';
import { INTERACTION_FIELDS, INTERACTION_LIMITS } from '../src/core/interaction-contract.js';
import { objectResourceName } from '../src/editor/object-resources.js';
import { startEditor } from '../src/editor/server.js';

const fwePath = path.resolve(process.env.FWA_TEST_FWE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fwe'));
const integration = { skip: !existsSync(path.join(fwePath, 'src/server.js')) && 'Explicit sibling FWE required.' };
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-resource-http-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Resource Test']); git(root, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'baseline');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'test: baseline']);
  const application = new FwaApplication(root); await application.init();
  const goals = [];
  for (const suffix of ['a', 'b']) {
    const goal = (await application.createGoal({ title: `Goal ${suffix}`, commandId: `goal-${suffix}` })).goal;
    await application.loadPlan({ goalId: goal.id, commandId: `plan-${suffix}`, plan: {
      schemaVersion: 1, groups: [{ id: 'shared-group', title: 'Goal-local group' }],
      nodes: [{ id: `node-${suffix}`, title: `Node ${suffix}`, parentId: 'shared-group', dependsOn: [], reads: ['seed.txt'], writes: [`${suffix}.txt`],
        capabilities: ['file_operations'], acceptance: { checks: ['test'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 } }]
    } });
    goals.push(goal);
  }
  const refId = 'ref://document/docs/brief.md';
  await application.registerRef({ commandId: 'reference', ref: { id: refId, kind: 'document', uri: 'docs/brief.md', version: '1', hash: `sha256:${'0'.repeat(64)}`, metadata: {} } });
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0, allowWrite: true, workflow: { planner: null, executor: null } });
  t.after(() => editor.close());
  const get = async route => { const response = await fetch(editor.url + route); return { status: response.status, body: await response.json() }; };
  const session = (await get('/api/fwa/session')).body;
  const post = async (type, payload) => {
    const response = await fetch(editor.url + '/api/fwa/commands', { method: 'POST',
      headers: { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWA-CSRF': session.csrfToken, 'X-FWA-Fingerprint': session.fingerprint },
      body: JSON.stringify({ type, payload, commandId: `test-${type.replaceAll('.', '-')}` }) });
    return { status: response.status, body: await response.json() };
  };
  return { root, application, goals, refId, editor, session, get, post };
}

test('guarded FWE host exposes derived fields/configs and object resources without weakening mutations', integration, async t => {
  const fixtureData = await fixture(t), { root, application, goals, refId, editor, session, get, post } = fixtureData;
  const baseline = await application.getStatus();
  const app = (await get('/api/app')).body;
  assert.deepEqual(session.commands, ['goal.create', 'plan.load', 'node.retry']);
  const domain = app.domains.find(domain => domain.id === 'fwa-projection');
  assert.equal(domain.model.fields['commands.feedback'].maxLength, INTERACTION_FIELDS.feedback.maxLength);
  assert.deepEqual(domain.model.fields['commands.permission'].options, INTERACTION_FIELDS.permission.options);
  assert.equal(domain.model.fields['commands.request'].required, false);
  assert.equal(domain.model.fields['commands.goalRequest'].required, true);
  assert.ok(domain.inspector.forms.commands.groups[0].fields.length > 10);
  for (const name of ['console', 'content', 'workflow']) {
    const actual = app.labels.fwaConsole.uiConfigs[name];
    const expected = JSON.parse(await readFile(new URL(`../src/editor/app/${name}.ui.json`, import.meta.url), 'utf8'));
    assert.deepEqual(actual, expected);
    assert.ok(Object.keys(actual.templates).length);
  }
  assert.ok(app.labels.fwaConsole.importLimits.maxUploadBytes > 0);
  assert.deepEqual(app.labels.fwaConsole.interactionLimits, INTERACTION_LIMITS);
  assert.equal(domain.actions.save, false);
  assert.equal(domain.actions.undo, false);
  const files = (await get('/api/domains/fwa-projection/files')).body.files;
  const names = files.map(file => file.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('projection.json'));
  for (const [type, id, goalId] of [['nodes', 'node-a', goals[0].id], ['refs', refId],
    ['groups', 'shared-group', goals[0].id], ['groups', 'shared-group', goals[1].id]]) {
    const name = objectResourceName(type, id, { goalId });
    assert.ok(names.includes(name), name);
    const response = await get(`/api/domains/fwa-projection/files/${encodeURIComponent(name)}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data._fwaSelection.type, type);
    assert.equal(response.body.data._fwaSelection.id, id);
    if (goalId) assert.equal(response.body.data._fwaSelection.goalId, goalId);
    assert.equal(response.body.data.eventCount, baseline.eventCount);
    assert.deepEqual(response.body.data.nodes, baseline.nodes);
  }
  for (const name of ['objects/nodes/missing.json', 'objects/groups/shared-group.json', 'objects/refs/%ZZ.json']) {
    assert.equal((await get(`/api/domains/fwa-projection/files/${encodeURIComponent(name)}`)).status, 404);
  }
  assert.equal((await post('goal.create', { title: 'x'.repeat(INTERACTION_FIELDS.title.maxLength + 1) })).status, 400);
  assert.equal((await post('node.feedback', { nodeId: 'node-a', text: 'x'.repeat(INTERACTION_FIELDS.feedback.maxLength + 1) })).status, 400);
  assert.equal((await post('workflow.plan', { libraryIds: [], request: 'Request', mode: 'unknown' })).status, 400);
  const mutation = await fetch(editor.url + `/api/domains/fwa-projection/files/${encodeURIComponent(objectResourceName('nodes', 'node-a'))}`, { method: 'PUT' });
  assert.equal(mutation.status, 405);
  assert.equal((await application.getStatus()).eventCount, baseline.eventCount);
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('resource identity retains a superseded physical leaf while current projection and revision advance', integration, async t => {
  const { application, goals, get, root } = await fixture(t);
  const previous = await application.getStatus();
  const revision = previous.workflow.revisions.find(item => item.goalId === goals[0].id);
  const plan = structuredClone(revision.plan);
  plan.nodes[0].instruction = 'Implement the revised requirement.';
  const result = await application.revisePlan({ goalId: goals[0].id, expectedRevision: 1, plan,
    reason: 'Fixture operator revision', commandId: 'resource-revision' });
  const current = await application.getStatus();
  const oldName = objectResourceName('nodes', 'node-a');
  const newName = objectResourceName('nodes', 'node-a@revision-2');
  const files = (await get('/api/domains/fwa-projection/files')).body.files.map(file => file.name);
  assert.ok(files.includes(oldName)); assert.ok(files.includes(newName));
  for (const [name, id] of [[oldName, 'node-a'], [newName, 'node-a@revision-2']]) {
    const response = await get(`/api/domains/fwa-projection/files/${encodeURIComponent(name)}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data._fwaSelection.id, id);
    assert.equal(response.body.data._fwaSelection.goalId, goals[0].id);
    assert.deepEqual(response.body.data.nodes, current.nodes);
    assert.ok(response.body.data.lastSequence > previous.lastSequence);
  }
  assert.equal(current.nodes.find(node => node.id === 'node-a').supersededByRevision, result.revision.id);
  assert.equal(current.nodes.find(node => node.id === 'node-a@revision-2').instruction, 'Implement the revised requirement.');
  assert.equal(current.runs.length, 0);
  assert.equal((await application.verify()).ok, true);
  assert.equal(git(root, ['status', '--porcelain']), '');
});
