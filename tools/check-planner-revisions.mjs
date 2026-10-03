import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

// Explicit live planning evaluation: at most five model requests, two cases in
// parallel, 180 seconds per request, no retries and no business Run dispatch.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--initial-only') {
    args.set('--initial-only', true);
    continue;
  }
  assert.ok(['--output', '--source', '--case', '--mode'].includes(process.argv[i]) && process.argv[i + 1],
    'Use --output DIR [--source FWA_ROOT] [--case ID] [--mode live|fixtures] [--initial-only]');
  args.set(process.argv[i], process.argv[i + 1]);
  i += 1;
}
assert.ok(args.has('--output'), 'An explicit evidence output directory is required.');
const mode = args.get('--mode') ?? 'live';
assert.ok(['live', 'fixtures'].includes(mode));
const source = path.resolve(args.get('--source') || fileURLToPath(new URL('..', import.meta.url)));
const output = path.resolve(args.get('--output'));
await mkdir(output, { recursive: true });
const fromSource = relative => import(pathToFileURL(path.join(source, relative)).href);
const { FwaApplication } = await fromSource('src/application/fwa-application.js');
const { WorkbenchController } = await fromSource('src/application/workbench-controller.js');
const { CodexPlanner } = await fromSource('src/adapters/codex-planner.js');
const { diagnosePlan } = await fromSource('src/core/plan-diagnostics.js');
const { stableStringify } = await fromSource('src/core/events.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['src/adapters/codex-planner.js', 'src/adapters/planner-output.schema.json',
  'src/application/workbench-controller.js', 'src/core/workflow.js', 'src/application/project-planning-context.js'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, sha(await readFile(path.join(source, name)))])));
const all = JSON.parse(await readFile(new URL('./fixtures/planner-revision-cases.json', import.meta.url), 'utf8'));
const cases = all.filter(item => !args.has('--case') || item.id === args.get('--case'));
const initialOnly = args.has('--initial-only');
const stagesFor = item => [{ id: 'initial', checkIds: item.initialCheckIds }, ...(initialOnly ? [] : item.rounds)];
const maximumCalls = cases.reduce((sum, item) => sum + stagesFor(item).length, 0);
assert.ok(cases.length && maximumCalls <= 5, 'This evaluation permits at most five model calls.');
const results = [];
let modelRequests = 0;
const git = (root, values) => {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...values], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const save = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const checkIds = node => typeof node.acceptance === 'object' ? node.acceptance.checks ?? [] : [];
const nodesFor = (plan, id) => plan?.nodes.filter(node => checkIds(node).includes(id)) ?? [];
function reaches(plan, consumer, producer, seen = new Set()) {
  if (consumer === producer) return true;
  if (seen.has(consumer)) return false;
  seen.add(consumer);
  return (plan.nodes.find(node => node.id === consumer)?.dependsOn ?? []).some(id => reaches(plan, id, producer, seen));
}
function machineReview(item, stage, before, after, plan, feedbackTarget) {
  const checks = [];
  const add = (name, pass, details) => checks.push({ name, pass, ...(details === undefined ? {} : { details }) });
  const required = stage.expected?.requiredChecks ?? item.initialCheckIds;
  const available = new Set(plan?.nodes.flatMap(checkIds) ?? []);
  for (const id of required) add('required-check:' + id, available.has(id));
  if (!plan) return checks;
  for (const relation of [...item.expected.dependencies, ...(stage.expected?.newDependencies ?? [])]) {
    const producers = nodesFor(plan, relation.producer), consumers = nodesFor(plan, relation.consumer);
    add('artifact-dependency:' + relation.producer + '->' + relation.consumer,
      producers.length === 1 && consumers.length === 1 ? reaches(plan, consumers[0].id, producers[0].id) : null,
      { producers: producers.map(node => node.id), consumers: consumers.map(node => node.id),
        combined: producers[0]?.id === consumers[0]?.id });
  }
  for (const id of item.expected.independentChecks) {
    const owners = nodesFor(plan, id);
    if (owners.length !== 1 || checkIds(owners[0]).length !== 1) {
      add('independent-branch:' + id, null, 'The result is combined with other checks; independence requires semantic review.');
      continue;
    }
    const own = owners[0];
    const edges = plan.nodes.filter(node => node.id !== own.id &&
      (reaches(plan, own.id, node.id) || reaches(plan, node.id, own.id))).map(node => node.id);
    add('independent-branch:' + id, edges.length === 0, { connectedNodeIds: edges });
  }
  if (before) {
    const priorPlan = before.workflow.revisions.at(-1).plan;
    for (const id of stage.expected.preserveUnrelatedChecks ?? []) {
      const previous = nodesFor(priorPlan, id), current = nodesFor(plan, id);
      if (previous.length !== 1 || previous[0].id === feedbackTarget?.logicalId || checkIds(previous[0]).length !== 1) {
        add('unrelated-definition-preserved:' + id, null, 'No separate unrelated result is available for an exact comparison.');
        continue;
      }
      const unchanged = current.length === 1 && stableStringify(previous[0]) === stableStringify(current[0]);
      add('unrelated-definition-preserved:' + id, unchanged,
        { beforeId: previous[0].id, afterId: current[0]?.id ?? null });
      const oldPhysical = before.nodes.find(node => (node.logicalId ?? node.id) === previous[0].id && !node.supersededByRevision);
      const newPhysical = after.nodes.find(node => (node.logicalId ?? node.id) === previous[0].id && !node.supersededByRevision);
      add('unrelated-physical-node-preserved:' + id, oldPhysical?.id === newPhysical?.id,
        { beforeId: oldPhysical?.id, afterId: newPhysical?.id });
    }
    const currentById = new Map(plan.nodes.map(node => [node.id, node]));
    const provenanceChanges = priorPlan.nodes.filter(node => node.derivedFrom && currentById.has(node.id)
      && currentById.get(node.id).derivedFrom !== node.derivedFrom).map(node => node.id);
    add('retained-derivation-provenance', provenanceChanges.length === 0, provenanceChanges);
    if (stage.expected.derivationRequired) {
      const oldIds = new Set(priorPlan.nodes.map(node => node.id));
      const derived = plan.nodes.filter(node => !oldIds.has(node.id) && node.derivedFrom === feedbackTarget?.logicalId);
      add('requested-result-derivation', derived.length > 0, derived.map(node => ({ id: node.id, derivedFrom: node.derivedFrom })));
      add('original-acceptance-preserved', priorPlan.nodes.flatMap(checkIds).every(id => available.has(id)));
    }
  }
  return checks;
}
async function run(item) {
  const caseOutput = path.join(output, item.id);
  await mkdir(caseOutput, { recursive: true });
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-plan-revisions-' + item.id + '-'));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Revision Evaluation']);
  git(root, ['config', 'user.email', 'revisions@local.invalid']); git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  for (const [relative, content] of Object.entries(item.projectFiles)) {
    const target = path.resolve(root, relative);
    assert.ok(target.startsWith(root + path.sep) && !relative.includes('..'));
    if (relative.endsWith('.cjs')) new vm.Script(content, { filename: relative });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const uniqueChecks = new Map(item.validationProfiles.flatMap(profile => profile.checks).map(check => [check.id, check]));
  const fixtureChecks = [];
  for (const check of uniqueChecks.values()) {
    assert.ok(Object.hasOwn(item.projectFiles, check.args.at(-1)), 'Check command must name an actual fixture file.');
    const result = spawnSync(process.execPath, check.args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: check.timeoutMs });
    fixtureChecks.push({ id: check.id, status: result.status, signal: result.signal, expectedInitialFailure: true,
      stdout: result.stdout?.slice(-12000), stderr: result.stderr?.slice(-4000), error: result.error?.message });
    assert.equal(result.status, 1, 'Unimplemented fixture must fail real behavior assertions: ' + check.id);
  }
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Bounded revision planning fixture']);
  const baselineRevision = git(root, ['rev-parse', 'HEAD']);
  await save(path.join(caseOutput, 'fixture-checks.json'), { fixtureRoot: root, baselineRevision, checks: fixtureChecks });
  if (mode === 'fixtures') {
    results.push({ id: item.id, fixtureRoot: root, fixtureChecks: fixtureChecks.length, modelRequests: 0, stages: [] });
    return;
  }
  const application = new FwaApplication(root);
  await application.init();
  const profilesFor = ids => {
    const selected = new Set(ids);
    return structuredClone(item.validationProfiles.filter(profile => profile.checks.every(check => selected.has(check.id))))
      .map(profile => ({ ...profile, checks: profile.checks.map(check => ({ ...check, command: check.command === 'node' ? process.execPath : check.command })) }));
  };
  const planner = new CodexPlanner({ timeoutMs: 180000, idleTimeoutMs: null });
  let stageDirectory, observed, capturedInput, callError;
  const controller = new WorkbenchController(application, { executor: null, validationProfiles: profilesFor(item.initialCheckIds), planner: {
    async plan(input) {
      assert.ok(modelRequests < maximumCalls, 'Model-call budget exhausted.');
      modelRequests++;
      capturedInput = input;
      await save(path.join(stageDirectory, 'input.json'), input);
      try {
        observed = await planner.plan(input);
        await save(path.join(stageDirectory, 'planner-output.json'), observed);
        if (observed.evidence) await save(path.join(stageDirectory, 'evidence.json'), observed.evidence);
        return observed;
      } catch (error) {
        callError = { code: error.code, message: error.message, details: error.details };
        await save(path.join(stageDirectory, 'model-error.json'), callError);
        throw error;
      }
    }
  } });
  const caseResult = { id: item.id, request: item.request, expected: item.expected, source, sourceHashes,
    fixtureRoot: root, baselineRevision, stages: [] };
  try {
    await controller.library.init();
    const library = await controller.library.importFiles({ commandId: item.id + '-brief', label: 'Project facts', files: [
      { path: 'project-facts.md', base64: Buffer.from(item.background).toString('base64') }
    ] });
    let goalId;
    const stages = stagesFor(item);
    for (const [index, stage] of stages.entries()) {
      stageDirectory = path.join(caseOutput, String(index) + '-' + stage.id);
      await mkdir(stageDirectory, { recursive: true });
      observed = undefined; capturedInput = undefined; callError = undefined;
      const before = index ? await application.getStatus() : undefined;
      let feedbackTarget, feedbackId;
      controller.validationProfiles = profilesFor(stage.checkIds);
      const commandId = item.id + '-' + stage.id;
      const started = Date.now();
      let dispatchError;
      try {
        if (!index) {
          await controller.plan({ commandId, request: item.request, libraryIds: [library.libraryId], mode: 'plan' });
        } else {
          const revision = before.workflow.revisions.filter(row => row.goalId === goalId).at(-1);
          const targets = nodesFor(revision.plan, stage.targetCheck);
          assert.equal(targets.length, 1, 'Feedback target must be observable from a unique acceptance owner.');
          feedbackTarget = before.nodes.find(node => (node.logicalId ?? node.id) === targets[0].id && !node.supersededByRevision);
          assert.ok(feedbackTarget);
          const feedback = await application.submitNodeFeedback({ nodeId: feedbackTarget.id, text: stage.feedback, commandId: commandId + '-feedback' });
          feedbackId = feedback.feedback.id;
          await save(path.join(stageDirectory, 'submitted-feedback.json'), feedback);
          await controller.revise({ commandId, goalId, expectedRevision: revision.revision, feedbackIds: [feedbackId] });
        }
        await controller.jobs.settle();
      } catch (error) {
        dispatchError = { code: error.code, message: error.message };
      }
      const job = (await controller.jobs.list()).find(job => job.commandId === commandId);
      const status = await application.getStatus();
      if (!index) goalId = job?.result?.goalId;
      const plan = status.workflow.revisions.filter(row => row.goalId === goalId).at(-1)?.plan ?? null;
      const producedPlan = observed?.plan ?? null;
      const checks = machineReview(item, stage, before, status, producedPlan, feedbackTarget);
      checks.push({ name: 'job-succeeded', pass: job?.state === 'succeeded' && !dispatchError });
      checks.push({ name: 'no-unresolved-questions', pass: observed?.questions?.length === 0 });
      checks.push({ name: 'persisted-plan-equals-planner-output', pass: producedPlan !== null
        && stableStringify(plan?.nodes) === stableStringify(producedPlan.nodes) });
      checks.push({ name: 'no-business-runs', pass: status.runs.length === 0 });
      checks.push({ name: 'fixture-head-unchanged', pass: git(root, ['rev-parse', 'HEAD']) === baselineRevision });
      checks.push({ name: 'fixture-clean', pass: git(root, ['status', '--porcelain']) === '' });
      checks.push({ name: 'expectations-not-in-model-input', pass: capturedInput && !Object.hasOwn(capturedInput, 'expected')
        && !Object.hasOwn(capturedInput.context ?? {}, 'expected') });
      if (index) {
        checks.push({ name: 'feedback-applied', pass: status.workflow.feedback.find(row => row.id === feedbackId)?.status === 'applied' });
        checks.push({ name: 'one-durable-revision', pass: status.workflow.revisions.length === before.workflow.revisions.length + 1 });
      }
      const verification = await application.verify();
      checks.push({ name: 'event-history-verifies', pass: verification.ok === true });
      const events = observed?.evidence?.jsonl?.events ?? [];
      const result = { id: stage.id, request: index ? stage.feedback : item.request, expected: stage.expected ?? item.expected,
        durationMs: Date.now() - started, state: job?.state ?? 'failed', error: dispatchError ?? job?.error ?? callError,
        questions: observed?.questions ?? [], plan: producedPlan, persistedRevision: status.workflow.revisions.at(-1)?.revision ?? null,
        inputHash: capturedInput ? sha(JSON.stringify(capturedInput)) : null, feedbackTarget: feedbackTarget?.logicalId ?? feedbackTarget?.id ?? null,
        modelToolItems: events.filter(event => event.type === 'item.completed' && event.item?.type !== 'agent_message').map(event => event.item?.type),
        runCount: status.runs.length, machineChecks: checks, machinePassed: checks.every(check => check.pass !== false),
        diagnostics: producedPlan ? diagnosePlan(producedPlan) : null,
        semanticReview: 'Required: check IDs, graph metrics and persistence cannot prove requirement coverage or correct dependencies.' };
      await save(path.join(stageDirectory, 'result.json'), result);
      await save(path.join(stageDirectory, 'status.json'), status);
      await save(path.join(stageDirectory, 'events.json'), await application.listEvents());
      await save(path.join(stageDirectory, 'verification.json'), verification);
      caseResult.stages.push(result);
      await save(path.join(caseOutput, 'result.json'), caseResult);
      console.log(JSON.stringify({ case: item.id, stage: stage.id, state: result.state, machinePassed: result.machinePassed,
        failedChecks: checks.filter(check => check.pass === false).map(check => check.name),
        nodes: producedPlan?.nodes.length ?? 0, durationMs: result.durationMs, modelRequests }));
      if (!result.machinePassed) break;
    }
  } finally {
    await controller.close();
    results.push(caseResult);
  }
}
let next = 0;
const settled = await Promise.allSettled(Array.from({ length: Math.min(2, cases.length) }, async () => {
  while (next < cases.length) await run(cases[next++]);
}));
const errors = settled.filter(item => item.status === 'rejected').map(item => ({ message: item.reason.message, stack: item.reason.stack }));
const endingHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, sha(await readFile(path.join(source, name)))])));
const summary = { source, sourceHashes, sourceUnchanged: stableStringify(sourceHashes) === stableStringify(endingHashes),
  mode, initialOnly, maximumCalls, modelRequests, automaticRetries: 0, errors,
  results: results.map(({ id, fixtureRoot, fixtureChecks, stages }) => ({ id, fixtureRoot, fixtureChecks,
    stages: stages.map(({ id, state, error, machinePassed, questions, plan, durationMs }) => ({ id, state, error, machinePassed, questions,
      nodeCount: plan?.nodes.length ?? 0, durationMs })) })) };
await save(path.join(output, 'summary.json'), summary);
if (errors.length || !summary.sourceUnchanged || results.some(item => item.stages.some(stage => !stage.machinePassed))) process.exitCode = 1;
