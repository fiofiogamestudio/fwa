import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ChangeExperiments, inspectExperimentChange, normalizeExperimentConfig } from '../src/application/change-experiments.js';
import { WorkspaceLease } from '../src/storage/workspace-lease.js';
import { WorkbenchJobs } from '../src/storage/workbench-jobs.js';

const execute = promisify(execFile);
const git = async (root, ...args) => (await execute('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], { windowsHide: true })).stdout.trim();
const targetRef = 'refs/heads/main';
const nodeRecord = (id, changeSetId, revision, dependencies = []) => ({ id, title: id, dependsOn: dependencies, reads: [], writes: [],
  status: 'accepted', validity: 'valid', integrationStatus: 'integrated', integrationIds: [`integration-${id}`],
  integratedChangeSetId: changeSetId, integratedTargetRef: targetRef, integratedRevision: revision, activeIntegrationId: null });
const stateFor = (revision, later = []) => ({ nodes: [nodeRecord('shake', 'change-shake', revision), ...later],
  changeSets: [{ id: 'change-shake', kind: 'execution', nodeId: 'shake', revertedByReversionId: null }],
  integrations: [{ id: 'integration-shake', status: 'integrated', activeReversionId: null, changeSetId: 'change-shake', targetRef, integratedRevision: revision }] });

async function fixture(t, script = "console.log(JSON.stringify({ shake: JSON.parse(require('fs').readFileSync('settings.json')).shake, conditions: JSON.parse(process.env.FWA_EXPERIMENT_CONDITIONS) }));") {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-experiment-'));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Experiment test');
  await git(root, 'config', 'user.email', 'experiment@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, '.gitignore'), '.fwa/\nresult.png\n');
  await writeFile(path.join(root, 'settings.json'), '{"shake":false}\n');
  await writeFile(path.join(root, 'run.cjs'), script);
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'baseline');
  await writeFile(path.join(root, 'settings.json'), '{"shake":true}\n');
  await git(root, 'add', 'settings.json'); await git(root, 'commit', '-m', 'add camera shake');
  const excludedRevision = await git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'unrelated.txt'), 'later independent work\n');
  await git(root, 'add', 'unrelated.txt'); await git(root, 'commit', '-m', 'later change');
  const baselineRevision = await git(root, 'rev-parse', 'HEAD');
  const state = stateFor(excludedRevision);
  const lease = new WorkspaceLease(root); await lease.init();
  const jobs = new WorkbenchJobs(root);
  const application = { projectRoot: root, lease, getStatus: async () => structuredClone(state) };
  const config = { conditions: { scene: 'arena', seed: 42, camera: 'fixed' }, profile: {
    schemaVersion: 1, id: 'paired-run', checks: [{ id: 'run', kind: 'runtime', command: process.execPath,
      args: ['run.cjs'], timeoutMs: 10000, expectedExitCodes: [0] }] } };
  const experiments = new ChangeExperiments(application, { targetRef, config, jobs });
  return { root, state, jobs, application, config, experiments, baselineRevision, excludedRevision };
}

test('a real pair excludes only the selected change, retains later work and the user checkout, and persists results', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'unrelated.txt'), 'user unsaved edit\n');
  const inspection = await f.experiments.inspect('change-shake');
  assert.equal(inspection.available, true);
  await f.experiments.dispatch({ changeSetId: 'change-shake', reviewToken: inspection.reviewToken, commandId: 'compare-one' });
  await f.jobs.settle();
  const [job] = await f.experiments.list();
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  const result = job.result;
  assert.equal(result.comparison, 'ready');
  assert.equal(JSON.parse(result.a.evaluation.checks[0].stdout).shake, true);
  assert.equal(JSON.parse(result.b.evaluation.checks[0].stdout).shake, false);
  assert.deepEqual(JSON.parse(result.b.evaluation.checks[0].stdout).conditions, f.config.conditions);
  assert.deepEqual(result.changedFiles, ['settings.json']);
  for (const side of [result.a, result.b]) assert.equal(await readFile(path.join(side.workspacePath, 'unrelated.txt'), 'utf8'), 'later independent work\n');
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), f.baselineRevision);
  assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'user unsaved edit\n');
  assert.equal((await f.application.lease.inspect()).held, false);
  const restored = new ChangeExperiments(f.application, { targetRef, config: f.config, jobs: new WorkbenchJobs(f.root) });
  assert.equal((await restored.list())[0].result.b.revision, result.b.revision);
  assert.equal((await restored.dispatch({ changeSetId: 'change-shake', reviewToken: inspection.reviewToken, commandId: 'compare-one' })).appended, false);
});

test('integrated dependent changes block single-variable experiments before Git creates worktrees', async t => {
  const f = await fixture(t);
  f.state.nodes.push(nodeRecord('dependent', 'change-dependent', f.baselineRevision, ['shake']));
  const inspection = await f.experiments.inspect('change-shake');
  assert.equal(inspection.available, false);
  assert.equal(inspection.blockers[0].nodeId, 'dependent');
  await f.experiments.dispatch({ changeSetId: 'change-shake', reviewToken: inspection.reviewToken, commandId: 'blocked' });
  await f.jobs.settle();
  assert.equal((await f.experiments.list())[0].error.code, 'experiment-not-isolated');
  assert.equal((await git(f.root, 'worktree', 'list', '--porcelain')).match(/worktree /g).length, 1);
});

test('a stale baseline fails and does not silently compare a different target', async t => {
  const f = await fixture(t);
  const old = await f.experiments.inspect('change-shake');
  await writeFile(path.join(f.root, 'new.txt'), 'new target');
  await git(f.root, 'add', 'new.txt'); await git(f.root, 'commit', '-m', 'advance');
  await f.experiments.dispatch({ changeSetId: 'change-shake', reviewToken: old.reviewToken, commandId: 'stale' });
  await f.jobs.settle();
  assert.equal((await f.experiments.list())[0].error.code, 'experiment-stale');
});

test('runtime failure and tracked source mutation cannot become valid comparisons', async t => {
  for (const script of ["process.exit(JSON.parse(require('fs').readFileSync('settings.json')).shake ? 0 : 2)",
    "require('fs').writeFileSync('settings.json', '{}')"]) {
    const f = await fixture(t, script);
    const current = await f.experiments.inspect('change-shake');
    await f.experiments.dispatch({ changeSetId: 'change-shake', reviewToken: current.reviewToken, commandId: 'invalid-run' });
    await f.jobs.settle();
    const [job] = await f.experiments.list();
    assert.ok(job.result?.comparison === 'failed' || job.error?.code === 'experiment-source-changed', JSON.stringify(job));
    assert.equal(await git(f.root, 'rev-parse', 'HEAD'), f.baselineRevision);
  }
});

test('image evidence is bound to each exact runner output and survives reopening', async t => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const f = await fixture(t, `require('fs').writeFileSync('result.png', Buffer.from('${png}','base64'));`);
  f.config.profile.checks[0].expectedArtifacts = [{ path: 'result.png' }];
  const instance = new ChangeExperiments(f.application, { targetRef, config: f.config, jobs: f.jobs });
  const current = await instance.inspect('change-shake');
  await instance.dispatch({ changeSetId: 'change-shake', reviewToken: current.reviewToken, commandId: 'images' });
  await f.jobs.settle();
  const [job] = await instance.list();
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.result.a.media[0].base64, png);
  assert.equal(job.result.b.media[0].sha256, job.result.b.evaluation.checks[0].expectedArtifacts[0].digest);
  assert.equal(job.result.a.evaluation.checks[0].expectedArtifacts[0].bytesBase64, undefined);
});

test('logical consumers are conservative blockers and invalid configuration is rejected', () => {
  const state = stateFor('a'.repeat(40), [nodeRecord('consumer', 'consumer-change', 'b'.repeat(40))]);
  state.nodes[0].writes = ['ref://code/camera']; state.nodes[1].reads = ['ref://code/camera'];
  assert.equal(inspectExperimentChange(state, 'change-shake', targetRef).blockers[0].nodeId, 'consumer');
  state.nodes[0].validity = 'stale';
  assert.throws(() => inspectExperimentChange(state, 'change-shake', targetRef), { code: 'experiment-change-unavailable' });
  assert.throws(() => normalizeExperimentConfig({ conditions: {}, profile: {} }));
});

test('an unconfirmed experiment runner keeps the workspace lease and records a failed durable job', async t => {
  const f = await fixture(t);
  const { CommandEvaluator } = await import('../src/adapters/command-evaluator.js');
  t.mock.method(CommandEvaluator.prototype, 'evaluate', async () => {
    throw Object.assign(new Error('termination unknown'), { code: 'FWA_PROCESS_TERMINATION_UNCONFIRMED' });
  });
  const current = await f.experiments.inspect('change-shake');
  await f.experiments.dispatch({ changeSetId: 'change-shake', reviewToken: current.reviewToken, commandId: 'unknown-runner' });
  await f.jobs.settle();
  const [job] = await f.experiments.list();
  assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'FWA_PROCESS_TERMINATION_UNCONFIRMED');
  assert.equal((await f.application.lease.inspect()).held, true);
  await assert.rejects(f.application.lease.acquire({ ownerKind: 'evaluation', ownerId: 'another-experiment', ttlMs: 30000 }));
  assert.equal(await git(f.root, 'rev-parse', 'HEAD'), f.baselineRevision);
});

test('ordinary path effects remain usable and declared path readers block exclusion', () => {
  const state = stateFor('a'.repeat(40));
  state.nodes[0].writes = ['src/camera.js'];
  state.changeSets[0].changedFiles = ['src/camera.js'];
  assert.equal(inspectExperimentChange(state, 'change-shake', targetRef).blockers.length, 0);
  const consumer = nodeRecord('consumer', 'consumer-change', 'b'.repeat(40));
  consumer.reads = ['src/**']; state.nodes.push(consumer);
  assert.equal(inspectExperimentChange(state, 'change-shake', targetRef).blockers[0].nodeId, 'consumer');
});
