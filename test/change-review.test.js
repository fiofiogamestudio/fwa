import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';
import { startEditor } from '../src/editor/server.js';
import { normalizeReviewConfig } from '../src/application/review-config.js';
const fwePath = path.resolve(process.env.FWA_TEST_FWE_PATH || fileURLToPath(new URL('../../fwe', import.meta.url)));
const integration = { skip: !existsSync(path.join(fwePath, 'src/server.js')) && 'Explicit sibling FWE required.' };
const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const check = (id, kind, args) => ({ id, kind, command: process.execPath, args, timeoutMs: 10000 });
function config({ failure = false, experiment = false } = {}) {
  return { schemaVersion: 1, targetRef: 'main', ...(experiment ? { experiment: {
    conditions: { scene: 'counter-fixture', input: 'none', seed: 1 },
    profile: { schemaVersion: 1, id: 'comparison-runner', checks: [check('capture', 'test', ['-e', "console.log(require('./feature.cjs'))"])] }
  } } : {}), validationProfiles: [{ schemaVersion: 1, id: 'feature-validation', checks: [
    check('feature', 'test', ['-e', "require('node:assert/strict').equal(require('./feature.cjs'), 'after')"])
  ] }, { schemaVersion: 1, id: 'side-validation', checks: [
    check('side', 'test', ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('side.txt','utf8'), 'later')"])
  ] }], regressionProfile: { schemaVersion: 1, id: 'regression', checks: [
    check('compile', 'compile', ['--check', 'feature.cjs']),
    check('tests', 'test', ['-e', failure ? "throw Error('Intentional regression failure')" : "require('node:assert/strict').ok(['before','after'].includes(require('./feature.cjs')))"])
  ] } };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-review-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Test']); git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'feature.cjs'), "module.exports = 'before';\n"); await writeFile(path.join(root, 'side.txt'), 'before');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Review fixture baseline']);
  const app = new FwaApplication(root); await app.init();
  const goal = (await app.createGoal({ title: 'One visible behavior change' })).goal;
  const leaf = (id, writes, checks, dependsOn = []) => ({ id, title: id, dependsOn, reads: [], writes,
    capabilities: ['file_operations'], acceptance: { checks }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 } });
  await app.loadPlan({ goalId: goal.id, plan: { schemaVersion: 1, nodes: [
    leaf('feature', ['feature.cjs'], ['feature']), leaf('side', ['side.txt'], ['side']),
    leaf('consumer', ['consumer.txt'], ['consumer'], ['feature'])
  ] } });
  const produce = async (nodeId, file, content) => {
    const result = await app.runNext({ nodeId, executor: new FileOperationsExecutor(), workspace: new GitWorktreeAdapter(root),
      input: { schemaVersion: 1, operations: [{ type: 'write', path: file, content }] } });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.changeSet.id;
  };
  const editor = await startEditor({ projectRoot: root, fwePath, port: 0, allowWrite: options.allowWrite ?? true,
    workflow: { planner: null, executor: null }, ...(options.unconfigured ? {} : { reviewConfig: config(options) }) });
  t.after(() => editor.close());
  const session = await (await fetch(editor.url + '/api/fwa/session')).json();
  const headers = { Origin: editor.url, 'Content-Type': 'application/json', 'X-FWA-CSRF': session.csrfToken, 'X-FWA-Fingerprint': session.fingerprint };
  const review = async id => (await fetch(editor.url + '/api/fwa/review?changeSetId=' + id)).json();
  const post = async (type, payload, commandId) => {
    const response = await fetch(editor.url + '/api/fwa/commands', { method: 'POST', headers, body: JSON.stringify({ type, payload, commandId }) });
    return { status: response.status, body: await response.json() };
  };
  let serial = 0;
  const waitJob = async commandId => {
    let job;
    for (let attempt = 0; attempt < 600; attempt++) {
      const response = await fetch(editor.url + '/api/fwa/workbench'), body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      const jobs = body.jobs;
      job = jobs.find(item => item.commandId === commandId);
      if (job?.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(job && job.state !== 'running', 'Review operation did not settle.');
    return job;
  };
  const action = async (id, type, extras = {}, token) => {
    const observed = await review(id), commandId = `review-${++serial}`;
    const sent = await post('change.' + type, { changeSetId: id, reviewToken: token ?? observed.reviewToken, ...extras }, commandId);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    return waitJob(commandId);
  };
  return { root, app, editor, session, produce, review, post, action, waitJob };
}

test('HTTP review validates exact candidate, records human acceptance, gates adoption and reverts only that change', integration, async t => {
  const f = await fixture(t, { experiment: true }), base = git(f.root, ['rev-parse', 'HEAD']);
  const id = await f.produce('feature', 'feature.cjs', "module.exports = 'after';\n");
  let review = await f.review(id); assert.equal(review.actions.validate, true); assert.equal(review.accepted, false);
  assert.deepEqual(review.impact.nodes.map(node => node.id), ['consumer']);
  assert.equal((await f.action(id, 'integrate')).error.code, 'review-not-accepted');
  const validated = await f.action(id, 'validate', { profileId: 'feature-validation' });
  assert.equal(validated.state, 'succeeded', JSON.stringify(validated)); assert.equal(validated.result.ok, true, JSON.stringify(validated));
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), base);
  review = await f.review(id); assert.equal(review.actions.accept, true); assert.equal(review.actions.integrate, false);
  const accepted = await f.action(id, 'accept', { note: 'Compared the exact candidate behavior with the requirement.' });
  assert.equal(accepted.result.phase, 'accepted', JSON.stringify(accepted));
  assert.equal((await f.action(id, 'integrate')).result.ok, true);
  assert.equal(await readFile(path.join(f.root, 'feature.cjs'), 'utf8'), "module.exports = 'after';\n");
  const firstRevision = git(f.root, ['rev-parse', 'HEAD']);
  const comparison = await (await fetch(f.editor.url + '/api/fwa/experiments?changeSetId=' + id)).json();
  assert.equal(comparison.inspection.available, true, JSON.stringify(comparison));
  const experimentPayload = { changeSetId: id, reviewToken: comparison.inspection.reviewToken };
  assert.equal((await f.post('experiment.run', { ...experimentPayload, command: 'untrusted' }, 'experiment-inject')).status, 400);
  assert.equal((await f.post('experiment.run', experimentPayload, 'experiment-fixture')).status, 200);
  const experiment = await f.waitJob('experiment-fixture');
  assert.equal(experiment.state, 'succeeded', JSON.stringify(experiment));
  assert.equal(experiment.result.comparison, 'ready', JSON.stringify(experiment));
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), firstRevision);
  const side = await f.produce('side', 'side.txt', 'later');
  assert.equal((await f.action(side, 'validate', { profileId: 'side-validation' })).result.ok, true);
  assert.equal((await f.action(side, 'accept', { note: 'Verified the unrelated side change.' })).result.ok, true);
  assert.equal((await f.action(side, 'integrate')).result.ok, true);
  const reverted = await f.action(id, 'revert', { note: 'Undo only the feature and retain the later side change.' });
  assert.equal(reverted.result.ok, true, JSON.stringify(reverted));
  review = await f.review(id);
  assert.equal(review.reverted, true); assert.equal(review.current, false); assert.equal(review.integrated, false);
  assert.ok(Object.values(review.actions).every(value => value === false));
  assert.equal(await readFile(path.join(f.root, 'feature.cjs'), 'utf8'), "module.exports = 'before';\n");
  assert.equal(await readFile(path.join(f.root, 'side.txt'), 'utf8'), 'later');
  assert.equal(git(f.root, ['merge-base', '--is-ancestor', firstRevision, 'HEAD']), '');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  const verification = await f.app.verify({ workspace: new GitWorktreeAdapter(f.root), integration: new GitIntegrationAdapter(f.root), candidateWorkspace: new GitIntegrationWorkspaceAdapter(f.root) });
  assert.equal(verification.ok, true, JSON.stringify(verification));
});

test('review refuses shell injection, mismatched criteria, stale snapshots and replayed intent changes', integration, async t => {
  const f = await fixture(t), id = await f.produce('feature', 'feature.cjs', "module.exports = 'after';\n");
  const original = await f.review(id);
  assert.equal((await f.post('change.validate', { changeSetId: id, reviewToken: original.reviewToken, profileId: 'feature-validation', command: 'untrusted' }, 'inject')).status, 400);
  assert.equal((await f.action(id, 'validate', { profileId: 'side-validation' })).error.code, 'review-profile-mismatch');
  await f.app.createGoal({ title: 'Change the reviewed snapshot' });
  assert.equal((await f.action(id, 'validate', { profileId: 'feature-validation' }, original.reviewToken)).error.code, 'review-stale');
  const result = await f.action(id, 'validate', { profileId: 'feature-validation' });
  assert.equal(result.result.ok, true);
  const replay = await f.post(result.type, result.payload, result.commandId); assert.equal(replay.body.result.appended, false);
  assert.equal((await f.post(result.type, { ...result.payload, profileId: 'side-validation' }, result.commandId)).body.code, 'command-id-conflict');
});

test('failed integration regression never promotes the target', integration, async t => {
  const f = await fixture(t, { failure: true }), base = git(f.root, ['rev-parse', 'HEAD']);
  const id = await f.produce('feature', 'feature.cjs', "module.exports = 'after';\n");
  assert.equal((await f.action(id, 'validate', { profileId: 'feature-validation' })).result.ok, true);
  assert.equal((await f.action(id, 'accept', { note: 'Candidate meets the selected feature check.' })).result.ok, true);
  const result = await f.action(id, 'integrate');
  assert.equal(result.result.ok, false); assert.equal(git(f.root, ['rev-parse', 'HEAD']), base);
  assert.equal(await readFile(path.join(f.root, 'feature.cjs'), 'utf8'), "module.exports = 'before';\n");
});

test('failed candidate validation records failing evidence and cannot be accepted', integration, async t => {
  const f = await fixture(t), base = git(f.root, ['rev-parse', 'HEAD']);
  const id = await f.produce('feature', 'feature.cjs', "module.exports = 'wrong';\n");
  const result = await f.action(id, 'validate', { profileId: 'feature-validation' });
  assert.equal(result.result.ok, false, JSON.stringify(result));
  const review = await f.review(id); assert.equal(review.actions.accept, false); assert.equal(review.actions.integrate, false);
  assert.equal((await f.action(id, 'accept', { note: 'Cannot override a failing check.' })).state, 'failed');
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), base);
  assert.equal((await f.app.getStatus()).evidence.at(-1).result, 'fail');
});

test('read-only and unconfigured editor exposes requirements without authorizing review mutations', integration, async t => {
  for (const options of [{ allowWrite: false }, { unconfigured: true }]) {
    const f = await fixture(t, options), id = await f.produce('feature', 'feature.cjs', "module.exports = 'after';\n");
    const review = await f.review(id);
    const response = await f.post('change.validate', { changeSetId: id, reviewToken: review.reviewToken, profileId: 'feature-validation' }, 'disabled');
    if (options.allowWrite === false) assert.equal(response.status, 403);
    else { assert.equal(review.actions.validate, false); assert.equal(response.body.code, 'review-not-configured'); }
  }
});

test('review configuration requires complete real regression checks and distinct validation contracts', () => {
  const valid = config(); assert.equal(normalizeReviewConfig(valid).targetRef, 'refs/heads/main');
  assert.throws(() => normalizeReviewConfig({ ...valid, regressionProfile: valid.validationProfiles[0] }), /compile and test/);
  assert.throws(() => normalizeReviewConfig({ ...valid, validationProfiles: [valid.validationProfiles[0], valid.validationProfiles[0]] }), /unique/);
});
