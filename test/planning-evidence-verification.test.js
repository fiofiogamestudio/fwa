import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FwaApplication } from '../src/application/fwa-application.js';
import { WorkbenchController } from '../src/application/workbench-controller.js';
import { WorkbenchJobs } from '../src/storage/workbench-jobs.js';
import { hashCanonicalValue } from '../src/storage/file-event-store.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-planning-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await writeFile(path.join(root, 'seed.txt'), 'existing input\n');
  const app = new FwaApplication(root); await app.init();
  const jobs = new WorkbenchJobs(root);
  return { root, app, jobs };
}
const artifactPath = (root, ref) => path.join(root, '.fwa/artifacts/sha256', ref.digest.slice(0, 2), ref.digest);
const resultPath = (jobs, job) => path.join(jobs.root, `${job.id}.result.json`);
const envelope = extra => ({ schemaVersion: 1, kind: 'planning-evidence', planner: { adapter: 'deterministic-test', output: {} }, ...extra });
async function jobResult(jobs, started) {
  await jobs.active.get(started.id);
  const job = (await jobs.list()).find(item => item.id === started.id);
  assert.equal(job.state, 'succeeded', JSON.stringify(job)); return job;
}
async function planningJob(f, ref, extra = {}) {
  return jobResult(f.jobs, await f.jobs.start({ commandId: 'planning', type: 'workflow.plan', payload: { request: 'Plan' } },
    async () => ({ evidence: ref, ...extra })));
}
async function rewriteJob(f, job, transform) {
  const file = resultPath(f.jobs, job), record = JSON.parse(await readFile(file, 'utf8'));
  transform(record);
  const { resultHash: ignored, ...body } = record;
  record.resultHash = hashCanonicalValue(body);
  await writeFile(file, JSON.stringify(record));
}
async function snapshot(directory) {
  const files = {};
  async function visit(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files[child] = (await readFile(path.join(directory, child))).toString('base64');
    }
  }
  await visit(''); return files;
}

test('durable planning and revision evidence is reachable, verified without mutation, and creates no business execution', async t => {
  const f = await fixture(t);
  const plan = { schemaVersion: 1, nodes: [{ id: 'result', title: 'Result', instruction: 'Produce the output.',
    dependsOn: [], reads: ['seed.txt'], writes: ['output.txt'], capabilities: ['code_edit'],
    acceptance: { checks: ['output-correct'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 } }] };
  const controller = new WorkbenchController(f.app, { executor: null, planner: { async plan(input) {
    const result = structuredClone(input.existingPlan ?? plan);
    if (input.existingPlan) result.nodes[0].instruction = 'Produce the requested updated output.';
    return { title: 'Planned output', questions: [], plan: result };
  } } });
  t.after(() => controller.close());
  const command = { commandId: 'initial', request: 'Produce one output.' };
  const first = await jobResult(controller.jobs, await controller.plan(command));
  const feedback = await f.app.submitNodeFeedback({ nodeId: 'result', text: 'Update the output.', commandId: 'feedback' });
  const second = await jobResult(controller.jobs, await controller.revise({ commandId: 'revision', goalId: first.result.goalId,
    expectedRevision: 1, feedbackIds: [feedback.feedback.id] }));
  const before = await snapshot(path.join(f.root, '.fwa'));
  const verification = await f.app.verify();
  assert.equal(verification.ok, true); assert.equal(verification.operationallyClean, true);
  assert.equal(verification.artifactCount, 2); assert.equal(verification.referencedArtifactCount, 2);
  assert.deepEqual(verification.unreferencedArtifacts, []);
  assert.deepEqual(await f.app.verify(), verification);
  assert.deepEqual(await snapshot(path.join(f.root, '.fwa')), before, 'verification only reads settled storage');
  for (const job of [first, second]) {
    assert.equal(JSON.parse((await f.app.artifacts.get(job.result.evidence)).toString('utf8')).kind, 'planning-evidence');
  }
  assert.equal((await controller.plan(command)).appended, false);
  const state = await f.app.getStatus();
  assert.equal(state.workflow.revisions.length, 2); assert.equal(state.runs.length, 0);
  assert.equal(state.changeSets.length, 0); assert.equal(state.evaluations.length, 0); assert.equal(state.integrations.length, 0);
});

test('missing planning evidence is detected even when no artifact file remains to inventory', async t => {
  const f = await fixture(t), ref = await f.app.artifacts.put(JSON.stringify(envelope()));
  await planningJob(f, ref); await unlink(artifactPath(f.root, ref));
  await assert.rejects(f.app.verify(), { code: 'artifact-not-found' });
});

test('planning evidence follows only the typed ref and validates its shape, size and target', async t => {
  const f = await fixture(t), ref = await f.app.artifacts.put(JSON.stringify(envelope()));
  const job = await planningJob(f, ref);
  for (const invalid of [undefined, null, ref.digest, { ...ref, digest: '../outside' }, { ...ref, algorithm: 'sha512' }]) {
    await rewriteJob(f, job, record => {
      if (invalid === undefined) delete record.result.evidence;
      else record.result.evidence = invalid;
    });
    await assert.rejects(f.app.verify(), { code: 'invalid-artifact-ref' });
  }
  await rewriteJob(f, job, record => { record.result.evidence = { ...ref, size: ref.size + 1 }; });
  await assert.rejects(f.app.verify(), error => error.code === 'artifact-corruption' && /size mismatch/.test(error.message));
  await rewriteJob(f, job, record => { record.result.evidence = { ...ref, digest: 'f'.repeat(64) }; });
  await assert.rejects(f.app.verify(), { code: 'artifact-not-found' });
});

test('valid content hashes cannot disguise malformed or non-planning evidence envelopes', async t => {
  const f = await fixture(t), valid = await f.app.artifacts.put(JSON.stringify(envelope()));
  const job = await planningJob(f, valid);
  const invalid = ['not JSON', JSON.stringify([]), JSON.stringify(envelope({ kind: 'business-evidence' })),
    JSON.stringify(envelope({ schemaVersion: 2 })), JSON.stringify(envelope({ planner: null })),
    JSON.stringify(envelope({ projectSnapshot: [] })), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])];
  for (const content of invalid) {
    const ref = await f.app.artifacts.put(content);
    await rewriteJob(f, job, record => { record.result.evidence = ref; });
    await assert.rejects(f.app.verify(), error => error.code === 'planning-evidence-artifact-invalid'
      && error.details.commandId === job.commandId && error.details.artifactDigest === ref.digest);
  }
});

test('unrelated job results and diagnostic hashes do not become artifact ownership or business facts', async t => {
  const f = await fixture(t), ref = await f.app.artifacts.put(JSON.stringify(envelope()));
  const unrelated = await f.app.artifacts.put('unrelated bytes');
  await planningJob(f, ref, { diagnostic: { evidence: unrelated }, accepted: true, integrated: true });
  await jobResult(f.jobs, await f.jobs.start({ commandId: 'unrelated', type: 'workflow.work', payload: {} },
    async () => ({ evidence: unrelated, goalId: 'invented', accepted: true, integrated: true })));
  await f.jobs.start({ commandId: 'failed', type: 'workflow.revise', payload: {} }, async () => { throw new Error('Planning never returned'); });
  await f.jobs.settle();
  const verification = await f.app.verify();
  assert.equal(verification.referencedArtifactCount, 1); assert.deepEqual(verification.unreferencedArtifacts, [unrelated.digest]);
  assert.equal(verification.operationallyClean, false);
  const state = await f.app.getStatus();
  assert.equal(state.goals.length, 0); assert.equal(state.nodes.length, 0); assert.equal(state.runs.length, 0);
  assert.equal(state.evidence.length, 0); assert.equal(state.integrations.length, 0);
});

test('invalid job integrity is diagnosed after existing event and artifact corruption', async t => {
  const f = await fixture(t), ref = await f.app.artifacts.put(JSON.stringify(envelope()));
  const job = await planningJob(f, ref);
  await f.app.createGoal({ title: 'A recorded goal', commandId: 'goal' });
  const jobFile = resultPath(f.jobs, job), savedJob = JSON.parse(await readFile(jobFile, 'utf8'));
  savedJob.resultHash = '0'.repeat(64); await writeFile(jobFile, JSON.stringify(savedJob));
  const eventFile = path.join(f.root, '.fwa/events', (await readdir(path.join(f.root, '.fwa/events'))).find(name => name.startsWith('batch-')));
  const originalEvent = await readFile(eventFile), corruptedEvent = JSON.parse(originalEvent);
  corruptedEvent.events[0].payload.title = 'tampered'; await writeFile(eventFile, JSON.stringify(corruptedEvent));
  await assert.rejects(f.app.verify(), { code: 'payload-hash-mismatch' });
  await writeFile(eventFile, originalEvent);
  const blob = artifactPath(f.root, ref), originalBlob = await readFile(blob);
  await writeFile(blob, 'tampered bytes');
  await assert.rejects(f.app.verify(), error => error.code === 'artifact-corruption' && /digest mismatch/.test(error.message));
  await writeFile(blob, originalBlob);
  await assert.rejects(f.app.verify(), error => error.code === 'workbench-job-invalid' && /integrity mismatch/.test(error.message));
});

test('a planning job published during artifact inventory cannot create an owner count larger than the inventory', async t => {
  const f = await fixture(t), inventory = f.app.artifacts.listRefs.bind(f.app.artifacts);
  let published = false;
  f.app.artifacts.listRefs = async () => {
    const refs = await inventory();
    if (!published) {
      published = true;
      const ref = await f.app.artifacts.put(JSON.stringify(envelope()));
      await planningJob(f, ref);
    }
    return refs;
  };
  const first = await f.app.verify();
  assert.equal(first.artifactCount, 0);
  assert.equal(first.referencedArtifactCount, 0, 'ownership uses jobs observed before this artifact inventory');
  const next = await f.app.verify();
  assert.equal(next.artifactCount, 1); assert.equal(next.referencedArtifactCount, 1);
  assert.equal(next.operationallyClean, true);
});
