import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FwaApplication } from '../src/application/fwa-application.js';
import { ReviewController, REVIEW_COMMANDS } from '../src/application/review-controller.js';
import { normalizeReviewConfig } from '../src/application/review-config.js';
import { hashCanonicalValue } from '../src/storage/file-event-store.js';
import { WorkbenchJobs } from '../src/storage/workbench-jobs.js';
import { FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const check = (id, kind, source) => ({ id, kind, command: process.execPath, args: ['-e', source], timeoutMs: 10000 });
async function fixture(t, { regressionFailure = false, content = 'after', completionPolicy } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fwa-finish-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }));
  const root = path.join(directory, 'project');
  git(directory, ['init', '-b', 'main', root]);
  git(root, ['config', 'user.name', 'FWA Test']); git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'feature.cjs'), "module.exports = 'before';\n");
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Finish fixture']);
  const app = new FwaApplication(root); await app.init();
  const goal = (await app.createGoal({ title: 'Finish an exact candidate' })).goal;
  const leaf = (id, dependsOn = []) => ({ id, dependsOn, reads: [], writes: [`${id}.cjs`],
    capabilities: ['file_operations'], acceptance: { checks: ['feature'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 } });
  await app.loadPlan({ goalId: goal.id, plan: { schemaVersion: 1, nodes: [leaf('feature'), leaf('consumer', ['feature'])] } });
  const produced = await app.runNext({ nodeId: 'feature', executor: new FileOperationsExecutor(), workspace: new GitWorktreeAdapter(root),
    input: { schemaVersion: 1, operations: [{ type: 'write', path: 'feature.cjs', content: `module.exports = '${content}';\n` }] } });
  assert.equal(produced.ok, true, JSON.stringify(produced));
  const marker = path.join(directory, 'regression-ready');
  const config = normalizeReviewConfig({ schemaVersion: 1, targetRef: 'main',
    ...(completionPolicy === undefined ? {} : { completionPolicy }), validationProfiles: [{ schemaVersion: 1, id: 'feature',
    checks: [check('feature', 'test', "require('node:assert/strict').equal(require('./feature.cjs'),'after')")] }],
    regressionProfile: { schemaVersion: 1, id: 'regression', checks: [
      { id: 'compile', kind: 'compile', command: process.execPath, args: ['--check', 'feature.cjs'], timeoutMs: 10000 },
      check('tests', 'test', regressionFailure ? `require('node:assert/strict').ok(require('node:fs').existsSync(${JSON.stringify(marker)}))`
        : "require('node:assert/strict').equal(require('./feature.cjs'),'after')")
    ] } });
  const jobs = new WorkbenchJobs(root), review = new ReviewController(app, { config, jobs });
  const id = produced.changeSet.id;
  const wait = async commandId => {
    const rows = await jobs.list(), row = rows.find(item => item.commandId === commandId);
    const active = row && jobs.active.get(row.id);
    if (active) await active;
    return (await jobs.list()).find(item => item.commandId === commandId);
  };
  const finish = async (commandId, extras = {}) => {
    const inspected = await review.inspect(id);
    await review.dispatch('change.finish', { commandId, changeSetId: id, reviewToken: inspected.reviewToken, ...extras });
    return wait(commandId);
  };
  return { root, app, jobs, review, config, id, marker, wait, finish };
}

test('finish binds real validation and acceptance, refreshes token, integrates once and unlocks consumers', async t => {
  const f = await fixture(t), before = git(f.root, ['rev-parse', 'HEAD']);
  // Simulate competing status reads before an individual lease action starts.
  // Never retry an evaluator or integration task to recover this guard contention.
  const lease = f.app.lease, injected = new Set(), ownerByLeaseId = new Map();
  let phase = 'evaluation';
  const busyOnce = key => {
    if (injected.has(key)) return;
    injected.add(key);
    throw Object.assign(new Error('Injected unstarted lease guard contention.'), { code: 'workspace-lease-busy' });
  };
  const init = lease.init.bind(lease), acquire = lease.acquire.bind(lease), release = lease.release.bind(lease);
  lease.init = async (...args) => { busyOnce(`init:${phase}`); return init(...args); };
  lease.acquire = async options => {
    busyOnce(`acquire:${options.ownerKind}`);
    const capability = await acquire(options);
    ownerByLeaseId.set(capability.lease.leaseId, options.ownerKind);
    return capability;
  };
  lease.release = async options => {
    const owner = ownerByLeaseId.get(options.leaseId);
    assert.ok(owner, 'Release must belong to the one actually acquired lease.');
    busyOnce(`release:${owner}`);
    return release(options);
  };
  await f.jobs.start({ commandId: 'parent-work', type: 'workflow.work', payload: { nodeId: 'feature' } },
    () => f.review.validateCandidate({ changeSetId: f.id, commandId: 'auto-validate' }));
  const validated = (await f.wait('parent-work')).result;
  assert.equal(validated.ok, true, JSON.stringify(validated));
  assert.ok(validated.evidenceId);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), before);
  const inspected = await f.review.inspect(f.id);
  assert.equal(inspected.actions.finish, true);
  assert.equal(inspected.accepted, false);
  phase = 'integration';
  const request = { commandId: 'finish-once', changeSetId: f.id, reviewToken: inspected.reviewToken };
  await f.review.dispatch('change.finish', request);
  const finished = await f.wait(request.commandId);
  assert.equal(finished.state, 'succeeded', JSON.stringify(finished));
  assert.equal(finished.result.ok, true, JSON.stringify(finished));
  const rows = await f.jobs.list(), acceptance = rows.filter(job => job.type === 'change.accept');
  assert.equal(acceptance.length, 1);
  assert.equal(acceptance[0].result.note, '用户确认当前候选及验证证据并请求收束');
  assert.equal(acceptance[0].result.evidenceId, validated.evidenceId);
  assert.equal(acceptance[0].result.configFingerprint, f.config.fingerprint);
  assert.equal(finished.result.acceptanceCommandId, acceptance[0].commandId);
  const adopted = git(f.root, ['rev-parse', 'HEAD']); assert.notEqual(adopted, before);
  assert.equal((await f.review.dispatch('change.finish', request)).appended, false);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), adopted);
  await assert.rejects(f.review.dispatch('change.finish', { ...request, note: 'A different intent' }), { code: 'command-id-conflict' });
  assert.deepEqual(await f.review.validateCandidate({ changeSetId: f.id, commandId: 'auto-validate' }), validated);
  assert.equal((await f.review.validateCandidate({ changeSetId: f.id, commandId: 'observe-validation' })).phase, 'already-validated');
  const status = await f.app.getStatus();
  assert.equal(status.nodes.find(node => node.id === 'consumer').status, 'ready');
  assert.equal(status.runs.length, 1, 'Validation and finish must reuse the existing candidate.');
  assert.equal(status.evaluations.length, 1);
  assert.equal(status.integrations.length, 1);
  assert.equal(status.integrations[0].status, 'integrated');
  const events = (await f.app.store.readAll()).events;
  assert.equal(events.filter(event => event.type === 'EvaluationRequested').length, 1);
  assert.equal(events.filter(event => event.type === 'IntegrationRequested').length, 1);
  assert.deepEqual([...injected].sort(), ['init:evaluation', 'acquire:evaluation', 'release:evaluation',
    'init:integration', 'acquire:integration', 'release:integration'].sort());
  assert.equal(await readFile(path.join(f.root, 'feature.cjs'), 'utf8'), "module.exports = 'after';\n");
  const verification = await f.app.verify({ workspace: new GitWorktreeAdapter(f.root), integration: new GitIntegrationAdapter(f.root),
    candidateWorkspace: new GitIntegrationWorkspaceAdapter(f.root) });
  assert.equal(verification.ok, true, JSON.stringify(verification));
});

test('finish rejects unvalidated and stale evidence snapshots without recording acceptance', async t => {
  const f = await fixture(t), original = await f.review.inspect(f.id);
  assert.equal(original.actions.finish, false);
  assert.equal((await f.finish('unvalidated')).error.code, 'review-not-validated');
  assert.equal((await f.review.validateCandidate({ changeSetId: f.id, commandId: 'validate' })).ok, true);
  const stale = await f.finish('stale', { reviewToken: original.reviewToken });
  assert.equal(stale.error.code, 'review-stale');
  assert.equal((await f.jobs.list()).filter(job => job.type === 'change.accept').length, 0);
  assert.equal(await readFile(path.join(f.root, 'feature.cjs'), 'utf8'), "module.exports = 'before';\n");
});

test('finish retry preserves real acceptance after regression failure and retries only integration', async t => {
  const f = await fixture(t, { regressionFailure: true }), before = git(f.root, ['rev-parse', 'HEAD']);
  assert.equal((await f.review.validateCandidate({ changeSetId: f.id, commandId: 'validate' })).ok, true);
  const failed = await f.finish('finish-fails');
  assert.equal(failed.state, 'succeeded', JSON.stringify(failed));
  assert.equal(failed.result.ok, false);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), before);
  assert.equal((await f.review.inspect(f.id)).accepted, true);
  await writeFile(f.marker, 'ready');
  const restartedJobs = new WorkbenchJobs(f.root), restarted = new ReviewController(f.app, { config: f.config, jobs: restartedJobs });
  const request = await restarted.dispatch('change.finish', { commandId: 'finish-retry', changeSetId: f.id,
    reviewToken: (await restarted.inspect(f.id)).reviewToken });
  await restartedJobs.active.get(request.id);
  const succeeded = (await restartedJobs.list()).find(job => job.commandId === 'finish-retry');
  assert.equal(succeeded.result.ok, true, JSON.stringify(succeeded));
  assert.equal(succeeded.result.acceptanceCommandId, failed.result.acceptanceCommandId);
  assert.equal((await f.jobs.list()).filter(job => job.type === 'change.accept').length, 1);
  assert.notEqual(git(f.root, ['rev-parse', 'HEAD']), before);
});

test('finish blocks a competing operation while its integration is active', async t => {
  const f = await fixture(t);
  await f.review.validateCandidate({ changeSetId: f.id, commandId: 'validate' });
  let signalEntered, release;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const integrate = f.app.integrateChangeSetGated.bind(f.app);
  f.app.integrateChangeSetGated = async args => { signalEntered(); await paused; return integrate(args); };
  const inspected = await f.review.inspect(f.id);
  await f.review.dispatch('change.finish', { commandId: 'first', changeSetId: f.id, reviewToken: inspected.reviewToken });
  let timer;
  try {
    await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Integration never started')), 10000); })]);
    assert.equal((await f.review.inspect(f.id)).actions.finish, false);
    const competitor = await f.finish('second');
    assert.equal(competitor.error.code, 'review-operation-active', JSON.stringify(competitor));
  } finally { clearTimeout(timer); release(); }
  assert.equal((await f.wait('first')).result.ok, true);
  assert.equal((await f.jobs.list()).filter(job => job.type === 'change.accept').length, 1);
});

test('automatic validation reports missing or ambiguous trusted profiles and never accepts failed checks', async t => {
  const f = await fixture(t, { content: 'wrong' });
  f.review.config = null;
  assert.equal((await f.review.validateCandidate({ changeSetId: f.id, commandId: 'missing-config' })).phase, 'needs-review-config');
  f.review.config = { ...f.config, validationProfiles: [] };
  assert.equal((await f.review.validateCandidate({ changeSetId: f.id, commandId: 'missing-profile' })).phase, 'needs-validation-profile');
  f.review.config = { ...f.config, validationProfiles: [f.config.validationProfiles[0], { ...f.config.validationProfiles[0], id: 'other' }] };
  assert.equal((await f.review.validateCandidate({ changeSetId: f.id, commandId: 'ambiguous' })).phase, 'needs-profile-selection');
  assert.equal((await f.jobs.list()).length, 0);
  f.review.config = f.config;
  const failed = await f.review.validateCandidate({ changeSetId: f.id, commandId: 'fails' });
  assert.equal(failed.ok, false);
  assert.equal(failed.phase, 'validation-failed');
  assert.equal((await f.review.inspect(f.id)).actions.finish, false);
  assert.equal((await f.finish('no-override')).state, 'failed');
  assert.equal((await f.jobs.list()).filter(job => job.type === 'change.accept').length, 0);
  assert.equal((await f.app.getStatus()).runs.length, 1, 'Missing profiles and failing validation must not produce another Run.');
});

test('completion policy preserves legacy fingerprints and validates trusted manual exclusions', () => {
  const raw = { schemaVersion: 1, targetRef: 'main', validationProfiles: [{ schemaVersion: 1, id: 'feature',
    checks: [check('feature', 'test', '')] }], regressionProfile: { schemaVersion: 1, id: 'regression',
    checks: [check('compile', 'compile', ''), check('test', 'test', '')] } };
  const legacy = normalizeReviewConfig(raw), { fingerprint, ...oldContract } = legacy;
  assert.equal(Object.hasOwn(legacy, 'completionPolicy'), false);
  assert.equal(fingerprint, hashCanonicalValue(oldContract));
  assert.equal(new ReviewController({}, { config: legacy }).capabilities().completionMode, 'manual');
  for (const completionPolicy of [null, [], {}, { mode: 'auto', manualProfiles: [] }, { mode: 'automatic' },
    { mode: 'automatic', manualProfiles: ['missing'] }, { mode: 'automatic', manualProfiles: ['feature', 'feature'] },
    { mode: 'automatic', manualProfiles: [], allowAll: true }]) {
    assert.throws(() => normalizeReviewConfig({ ...raw, completionPolicy }), { code: 'review-config-invalid' });
  }
  const automatic = normalizeReviewConfig({ ...raw, completionPolicy: { mode: 'automatic', manualProfiles: ['feature'] } });
  assert.deepEqual(automatic.completionPolicy, { mode: 'automatic', manualProfiles: ['feature'] });
  assert.notEqual(automatic.fingerprint, fingerprint);
});

test('completion policy exposes the effective node mode without treating waiting or active work as manual', async () => {
  const profile = { schemaVersion: 1, id: 'feature', checks: [check('feature', 'test', '')] };
  const config = normalizeReviewConfig({ schemaVersion: 1, targetRef: 'main', validationProfiles: [profile],
    completionPolicy: { mode: 'automatic', manualProfiles: [] }, regressionProfile: { schemaVersion: 1, id: 'regression',
      checks: [check('compile', 'compile', ''), check('test', 'test', '')] } });
  const node = { id: 'node', goalId: 'goal', status: 'produced', validity: 'valid', dependsOn: [], reads: [], runIds: ['run'],
    changeSetIds: ['candidate'], acceptanceEvidenceIds: [], acceptance: { checks: ['feature'] } };
  const state = { lastSequence: 1, nodes: [node], integrations: [], evidence: [], changeSets: [{ id: 'candidate', nodeId: 'node',
    headRevision: 'head', kind: 'execution', valid: true, changedFiles: ['feature.cjs'] }] };
  let held = false;
  const review = new ReviewController({ getStatus: async () => state, lease: { inspect: async () => ({ held }) } },
    { config, jobs: { list: async () => [] } });
  assert.equal((await review.inspect('candidate')).completionMode, 'automatic');
  held = true;
  assert.equal((await review.inspect('candidate')).completionMode, 'automatic');
  assert.equal((await review.inspect('candidate')).autoFinishAllowed, false);
  held = false;
  node.status = 'accepted'; node.acceptanceEvidenceIds = ['evidence'];
  state.evidence.push({ id: 'evidence', changeSetId: 'candidate', headRevision: 'head', result: 'pass',
    kind: 'command-evaluation', profileArtifact: { digest: hashCanonicalValue(config.validationProfiles[0]) } });
  assert.equal((await review.inspect('candidate')).autoFinishAllowed, true);
  review.config = { ...config, completionPolicy: { mode: 'automatic', manualProfiles: ['feature'] } };
  assert.deepEqual(review.capabilities().manualProfiles, ['feature']);
  assert.equal((await review.inspect('candidate')).completionMode, 'manual');
  review.config = { ...config, validationProfiles: [...config.validationProfiles, { ...config.validationProfiles[0], id: 'other' }] };
  assert.equal((await review.inspect('candidate')).completionMode, 'manual');
  review.config = config; state.evidence[0].profileArtifact.digest = 'different';
  assert.equal((await review.inspect('candidate')).completionMode, 'manual');
});

test('automatic finish requires exact trusted evidence, records policy provenance and integrates only once', async t => {
  const f = await fixture(t, { completionPolicy: { mode: 'automatic', manualProfiles: [] } });
  const before = git(f.root, ['rev-parse', 'HEAD']);
  assert.equal(f.review.capabilities().completionMode, 'automatic');
  assert.equal((await f.review.finishCandidate({ changeSetId: f.id, commandId: 'unvalidated' })).phase, 'needs-validation');
  const validated = await f.review.validateCandidate({ changeSetId: f.id, commandId: 'validate' });
  assert.equal(validated.ok, true);
  const { fingerprint, ...configValue } = f.config;
  const cases = [
    [{ ...configValue, completionPolicy: { mode: 'manual', manualProfiles: [] } }, 'review-manual-policy'],
    [{ ...configValue, completionPolicy: { mode: 'automatic', manualProfiles: ['feature'] } }, 'review-profile-manual'],
    [{ ...configValue, validationProfiles: [...configValue.validationProfiles, { ...configValue.validationProfiles[0], id: 'other' }] }, 'review-profile-ambiguous'],
    [{ ...configValue, validationProfiles: [{ ...configValue.validationProfiles[0],
      checks: [check('feature', 'test', 'throw Error("Different trusted contract")')] }] }, 'review-policy-evidence-mismatch']
  ];
  for (const [raw, reason] of cases) {
    f.review.config = normalizeReviewConfig(raw);
    assert.equal((await f.review.inspect(f.id)).autoFinishAllowed, false);
    assert.deepEqual(await f.review.finishCandidate({ changeSetId: f.id, commandId: `blocked-${reason}` }), {
      ok: true, finished: false, changeSetId: f.id, phase: 'awaiting-human-acceptance', reason
    });
  }
  f.review.config = f.config;
  assert.equal((await f.review.inspect(f.id)).autoFinishAllowed, true);
  assert.equal((await f.jobs.list()).length, 1, 'Disallowed automation must not create acceptance or execution jobs.');
  for (const type of ['change.auto-finish', 'change.policy-accept']) {
    assert.equal(REVIEW_COMMANDS.includes(type), false);
    await assert.rejects(f.review.dispatch(type, { commandId: 'public-auto', changeSetId: f.id,
      reviewToken: (await f.review.inspect(f.id)).reviewToken }), { code: 'review-invalid-request' });
  }
  let signalEntered, release;
  const entered = new Promise(resolve => { signalEntered = resolve; }), paused = new Promise(resolve => { release = resolve; });
  const integrate = f.app.integrateChangeSetGated.bind(f.app);
  f.app.integrateChangeSetGated = async args => { signalEntered(); await paused; return integrate(args); };
  const finishing = f.review.finishCandidate({ changeSetId: f.id, commandId: 'auto-finish' });
  let timer;
  try {
    await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Policy integration never started')), 10000); })]);
    const accepted = await f.review.inspect(f.id);
    assert.equal(accepted.acceptedByPolicy, true);
    assert.equal(accepted.acceptanceRecord.kind, 'policy');
    assert.equal(accepted.acceptanceRecord.evidenceId, validated.evidenceId);
    assert.equal(accepted.acceptanceRecord.headRevision, validated.headRevision);
    assert.equal(accepted.acceptanceRecord.configFingerprint, f.config.fingerprint);
    assert.deepEqual(accepted.acceptanceRecord.policy, { mode: 'automatic', profileId: 'feature',
      profileHash: `sha256:${hashCanonicalValue(f.config.validationProfiles[0])}` });
    assert.equal(Object.hasOwn(accepted.acceptanceRecord, 'note'), false, 'Policy must never claim a human confirmation.');
    assert.equal(accepted.autoFinishAllowed, false);
    assert.equal((await f.review.finishCandidate({ changeSetId: f.id, commandId: 'competing-auto' })).code, 'review-operation-active');
  } finally { clearTimeout(timer); release(); }
  const finished = await finishing;
  assert.equal(finished.ok, true, JSON.stringify(finished));
  assert.equal(finished.finished, true);
  assert.equal(finished.acceptedByPolicy, true);
  assert.notEqual(git(f.root, ['rev-parse', 'HEAD']), before);
  const restarted = new ReviewController(f.app, { config: f.config, jobs: new WorkbenchJobs(f.root) });
  assert.deepEqual(await restarted.finishCandidate({ changeSetId: f.id, commandId: 'auto-finish' }), finished);
  await assert.rejects(restarted.finishCandidate({ changeSetId: 'another', commandId: 'auto-finish' }), { code: 'command-id-conflict' });
  const rows = await f.jobs.list();
  assert.equal(rows.filter(job => job.type === 'change.accept').length, 0);
  assert.equal(rows.filter(job => job.type === 'change.policy-accept').length, 1);
  assert.equal(rows.filter(job => job.type === 'change.integrate').length, 1);
  const state = await f.app.getStatus();
  assert.equal(state.runs.length, 1);
  assert.equal(state.evaluations.length, 1);
  assert.equal(state.integrations.length, 1);
  assert.equal(state.nodes.find(node => node.id === 'consumer').status, 'ready');
  const verification = await f.app.verify({ workspace: new GitWorktreeAdapter(f.root), integration: new GitIntegrationAdapter(f.root),
    candidateWorkspace: new GitIntegrationWorkspaceAdapter(f.root) });
  assert.equal(verification.ok, true, JSON.stringify(verification));
});

test('automatic finish reuses exact policy acceptance after regression failure without replaying execution', async t => {
  const f = await fixture(t, { regressionFailure: true, completionPolicy: { mode: 'automatic', manualProfiles: [] } });
  await f.review.validateCandidate({ changeSetId: f.id, commandId: 'validate' });
  const failed = await f.review.finishCandidate({ changeSetId: f.id, commandId: 'auto-fails' });
  assert.equal(failed.ok, false); assert.equal(failed.finished, false);
  assert.equal((await f.review.inspect(f.id)).acceptedByPolicy, true);
  const { fingerprint, ...configValue } = f.config;
  const changed = new ReviewController(f.app, { config: normalizeReviewConfig({ ...configValue,
    completionPolicy: { mode: 'manual', manualProfiles: [] } }), jobs: new WorkbenchJobs(f.root) });
  assert.equal((await changed.inspect(f.id)).accepted, false, 'Policy acceptance is invalid under a different trusted config.');
  await writeFile(f.marker, 'ready');
  const restarted = new ReviewController(f.app, { config: f.config, jobs: new WorkbenchJobs(f.root) });
  const succeeded = await restarted.finishCandidate({ changeSetId: f.id, commandId: 'auto-retry' });
  assert.equal(succeeded.ok, true, JSON.stringify(succeeded)); assert.equal(succeeded.finished, true);
  assert.equal(succeeded.acceptanceCommandId, failed.acceptanceCommandId);
  const rows = await f.jobs.list();
  assert.equal(rows.filter(job => job.type === 'change.policy-accept').length, 1);
  assert.equal(rows.filter(job => job.type === 'change.accept').length, 0);
  const state = await f.app.getStatus();
  assert.equal(state.runs.length, 1); assert.equal(state.evaluations.length, 1);
  assert.equal(state.integrations.length, 2);
});
