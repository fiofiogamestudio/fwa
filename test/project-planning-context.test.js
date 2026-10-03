import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectPlanningContext, PROJECT_PATH_LIMITS } from '../src/application/project-planning-context.js';
import { hashCanonicalValue } from '../src/storage/file-event-store.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { WorkbenchController } from '../src/application/workbench-controller.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-planning-paths-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
}
async function file(root, relative, text = 'private file body must not enter planning context') {
  const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text);
}
const paths = result => result.snapshot.entries.map(entry => entry.path);
const checkHash = result => assert.equal(result.hash, `sha256:${hashCanonicalValue(result.snapshot)}`);

test('project inventory is stable, relative and body-free while exposing real unconventional paths', async t => {
  const root = await fixture(t);
  await file(root, 'zeta/玩家规则.gd'); await file(root, 'game.entry'); await file(root, 'alpha/source.weird');
  for (const relative of ['.git/config', '.fwa/private.json', 'fw/fwa/index.js', 'node_modules/dep/index.js', 'alpha/.cache/private.txt']) await file(root, relative);
  const first = await projectPlanningContext(root), second = await projectPlanningContext(root);
  assert.deepEqual(paths(first), ['alpha', 'alpha/source.weird', 'game.entry', 'zeta', 'zeta/玩家规则.gd']);
  assert.deepEqual(first, second); checkHash(first);
  assert.equal(first.snapshot.complete, true); assert.equal(first.snapshot.truncated, false);
  assert.equal(first.snapshot.skipped.excludedDirectories, 5);
  assert.equal(JSON.stringify(first).includes('private file body'), false);
  assert.equal(JSON.stringify(first).includes(root), false);
  await writeFile(path.join(root, 'game.entry'), 'changed body of a different length');
  assert.deepEqual(await projectPlanningContext(root), first, 'Inventory hashes must not claim to be content hashes.');
  await file(root, 'alpha/new.input');
  assert.notEqual((await projectPlanningContext(root)).hash, first.hash);
});

test('junctions are omitted without traversing outside the project, and linked roots are rejected', async t => {
  const base = await fixture(t), root = path.join(base, 'project'), outside = path.join(base, 'outside');
  await mkdir(root); await file(outside, 'not-project.txt');
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(root, path.join(base, 'linked-root'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await projectPlanningContext(root);
  assert.deepEqual(paths(result), []); assert.equal(result.snapshot.skipped.links, 1);
  assert.equal(result.snapshot.complete, false); assert.equal(result.snapshot.issues[0].code, 'link-not-followed');
  await assert.rejects(projectPlanningContext(path.join(base, 'linked-root')), { code: 'planning-project-unsafe-root' });
  await assert.rejects(projectPlanningContext(path.join(base, 'missing')), { code: 'planning-project-unavailable' });
  await assert.rejects(projectPlanningContext(path.join(outside, 'not-project.txt')), { code: 'planning-project-unsafe-root' });
  assert.equal(await readFile(path.join(outside, 'not-project.txt'), 'utf8'), 'private file body must not enter planning context');
});

test('path, directory, entry and depth limits report incomplete coverage rather than a fabricated complete tree', async t => {
  const root = await fixture(t);
  for (const name of ['a', 'b', 'c']) await file(root, `${name}/deep/leaf.txt`);
  for (const [limits, code] of [
    [{ maxPaths: 2 }, 'path-limit'], [{ maxDirectories: 1 }, 'directory-limit'],
    [{ maxEntries: 2 }, 'entry-limit'], [{ maxEntriesPerDirectory: 2 }, 'directory-entry-limit'],
    [{ maxDepth: 1 }, 'depth-limit']
  ]) {
    const result = await projectPlanningContext(root, { limits });
    assert.equal(result.snapshot.complete, false, code); assert.equal(result.snapshot.truncated, true, code);
    assert.ok(result.snapshot.issues.some(issue => issue.code === code), code); checkHash(result);
    assert.ok(result.snapshot.entries.length <= (limits.maxPaths || PROJECT_PATH_LIMITS.maxPaths));
    assert.ok(result.snapshot.stats.directories <= (limits.maxDirectories || PROJECT_PATH_LIMITS.maxDirectories));
    assert.ok(result.snapshot.stats.entriesInspected <= (limits.maxEntries || PROJECT_PATH_LIMITS.maxEntries));
    if (limits.maxEntries || limits.maxEntriesPerDirectory) assert.deepEqual(paths(result), [], 'Never expose a filesystem-order-dependent partial directory.');
  }
  const issues = await projectPlanningContext(root, { limits: { maxDepth: 1, maxIssues: 1 } });
  assert.equal(issues.snapshot.issues.length, 1); assert.equal(issues.snapshot.omittedIssues, 2);
});

test('UTF-8 byte limit covers the full snapshot and preserves explicit truncation', async t => {
  const root = await fixture(t);
  for (let index = 0; index < 24; index++) await file(root, `${String(index).padStart(2, '0')}-${'字'.repeat(25)}.txt`);
  const result = await projectPlanningContext(root, { limits: { maxBytes: 2048 } });
  assert.ok(Buffer.byteLength(JSON.stringify(result.snapshot), 'utf8') <= 2048);
  assert.equal(result.snapshot.truncated, true); assert.equal(result.snapshot.complete, false);
  assert.ok(result.snapshot.issues.some(issue => issue.code === 'snapshot-byte-limit')); checkHash(result);
  assert.deepEqual(result, await projectPlanningContext(root, { limits: { maxBytes: 2048 } }));
  await assert.rejects(projectPlanningContext(root, { limits: { maxEntries: 0 } }), TypeError);
  await assert.rejects(projectPlanningContext(root, { limits: { maxEntries: PROJECT_PATH_LIMITS.maxEntries + 1 } }), TypeError);
  await assert.rejects(projectPlanningContext(root, { limits: { scanPath: '..' } }), TypeError);
});

test('planning and revision receive independently captured inventories and persist the exact hash-bound input as evidence', async t => {
  const root = await fixture(t); await file(root, 'unusual/source.rule');
  const application = new FwaApplication(root); await application.init();
  const captured = [], controller = new WorkbenchController(application, { executor: null, planner: { async plan(input) {
    captured.push(structuredClone(input.context.projectSnapshot));
    const plan = input.existingPlan ? structuredClone(input.existingPlan) : { schemaVersion: 1, nodes: [{
      id: 'real-result', title: 'Requested result', outcome: 'The output reflects the supplied source.',
      instruction: 'Produce the requested output from unusual/source.rule.', dependsOn: [], dependencyReasons: [],
      reads: ['unusual/source.rule'], writes: ['unusual/output.rule'], capabilities: ['code_edit'],
      acceptance: { checks: ['output-value'] }, budget: { maxFiles: 1, maxDiffLines: 20, maxRetries: 1 }
    }] };
    if (input.existingPlan) plan.nodes[0].instruction += ' Apply the recorded correction.';
    // Custom trusted planners cannot accidentally mutate the inventory retained as evidence.
    input.context.projectSnapshot.snapshot.entries.length = 0;
    return { title: 'Requested result', questions: [], plan, evidence: { adapter: 'fixture', invocation: captured.length } };
  } } });
  t.after(() => controller.close());
  await controller.plan({ commandId: 'plan-context', request: 'Produce output', projectRoot: '/untrusted/browser/path' });
  await controller.jobs.settle();
  let jobs = await controller.jobs.list(); assert.equal(jobs[0].state, 'succeeded', JSON.stringify(jobs[0].error));
  const firstEvidence = JSON.parse((await application.artifacts.get(jobs[0].result.evidence)).toString('utf8'));
  assert.equal(firstEvidence.kind, 'planning-evidence'); assert.deepEqual(firstEvidence.projectSnapshot, captured[0]);
  assert.deepEqual(firstEvidence.planner, { adapter: 'fixture', invocation: 1 }); checkHash(firstEvidence.projectSnapshot);
  assert.ok(paths(captured[0]).includes('unusual/source.rule'));
  const goalId = jobs[0].result.goalId;
  await file(root, 'unusual/additional.rule');
  const feedback = await application.submitNodeFeedback({ nodeId: 'real-result', text: 'Apply a correction.', commandId: 'feedback-context' });
  await controller.revise({ commandId: 'revise-context', goalId, expectedRevision: 1, feedbackIds: [feedback.feedback.id] });
  await controller.jobs.settle(); jobs = await controller.jobs.list();
  const revision = jobs.find(job => job.type === 'workflow.revise'); assert.equal(revision.state, 'succeeded', JSON.stringify(revision.error));
  const nextEvidence = JSON.parse((await application.artifacts.get(revision.result.evidence)).toString('utf8'));
  assert.deepEqual(nextEvidence.projectSnapshot, captured[1]); checkHash(nextEvidence.projectSnapshot);
  assert.ok(paths(captured[1]).includes('unusual/additional.rule')); assert.notEqual(captured[1].hash, captured[0].hash);
  assert.equal((await application.getStatus()).runs.length, 0);
});

test('synchronous planning context preserves optional trusted check location and artifacts without changing legacy profile shapes', () => {
  const profiles = [{ id: 'plain', checks: [{ id: 'plain-check', kind: 'test', command: 'node', args: ['check.js'] }] },
    { id: 'scoped', checks: [{ id: 'scoped-check', kind: 'test', command: 'node', args: ['check.js'], cwd: 'tools', expectedArtifacts: [{ path: 'result.json', size: null, sha256: null }] }] }];
  const controller = new WorkbenchController({ projectRoot: tmpdir() }, { planner: null, executor: null, validationProfiles: profiles });
  const context = controller.planningContext({ projectRoot: tmpdir(), refs: [] });
  assert.deepEqual(context.validationProfiles, profiles); assert.equal(Object.hasOwn(context, 'projectSnapshot'), false);
});
