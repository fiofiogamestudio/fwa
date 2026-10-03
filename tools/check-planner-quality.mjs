import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Explicit, bounded live-model planning evaluation. It never dispatches Work.
// Fixture expectations are recorded for reviewers and are never sent to the planner.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--output', '--source', '--case'].includes(process.argv[i]) && process.argv[i + 1], 'Use --output DIR [--source FWA_ROOT] [--case ID]');
  args.set(process.argv[i], process.argv[i + 1]);
}
assert.ok(args.has('--output'), 'An explicit output directory is required.');
const source = path.resolve(args.get('--source') || fileURLToPath(new URL('..', import.meta.url)));
const output = path.resolve(args.get('--output')); await mkdir(output, { recursive: true });
const fromSource = relative => import(pathToFileURL(path.join(source, relative)).href);
const { FwaApplication } = await fromSource('src/application/fwa-application.js');
const { WorkbenchController } = await fromSource('src/application/workbench-controller.js');
const { CodexPlanner } = await fromSource('src/adapters/codex-planner.js');
const { diagnosePlan } = await fromSource('src/core/plan-diagnostics.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceHashes = {};
for (const name of ['src/adapters/codex-planner.js', 'src/adapters/planner-output.schema.json', 'src/application/workbench-controller.js', 'src/core/workflow.js']) {
  sourceHashes[name] = sha(await readFile(path.join(source, name)));
}
const all = JSON.parse(await readFile(new URL('./fixtures/planner-quality-cases.json', import.meta.url), 'utf8'));
const cases = all.filter(item => !args.has('--case') || item.id === args.get('--case'));
assert.ok(cases.length > 0 && cases.length <= 6, 'Select one to six cases.');
const git = (root, values) => {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...values], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const results = [];
async function run(item) {
  const caseOutput = path.join(output, item.id); await mkdir(caseOutput, { recursive: true });
  const root = await mkdtemp(path.join(tmpdir(), `fwa-plan-${item.id}-`));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Planning Evaluation']);
  git(root, ['config', 'user.email', 'planning@local.invalid']); git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  for (const [relative, content] of Object.entries(item.projectFiles)) {
    const target = path.resolve(root, relative);
    assert.ok(target.startsWith(root + path.sep) && !relative.includes('..'));
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
  }
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Synthetic planning fixture']);
  const baselineRevision = git(root, ['rev-parse', 'HEAD']);
  const application = new FwaApplication(root); await application.init();
  const profiles = structuredClone(item.validationProfiles);
  for (const profile of profiles) for (const check of profile.checks) if (check.command === 'node') check.command = process.execPath;
  const planner = new CodexPlanner({ timeoutMs: 180000, idleTimeoutMs: 90000 });
  let observed, capturedInput;
  const controller = new WorkbenchController(application, { executor: null, validationProfiles: profiles, planner: {
    async plan(input) {
      capturedInput = input;
      await writeFile(path.join(caseOutput, 'input.json'), JSON.stringify(input, null, 2));
      observed = await planner.plan(input); return observed;
    }
  } });
  const started = Date.now();
  try {
    const libraryIds = [];
    if (item.background) {
      await controller.library.init();
      const library = await controller.library.importFiles({ commandId: `${item.id}-brief`, label: 'Project facts', files: [
        { path: 'project-facts.md', base64: Buffer.from(item.background).toString('base64') }
      ] });
      libraryIds.push(library.libraryId);
    }
    await controller.plan({ commandId: `${item.id}-plan`, request: item.request, libraryIds, mode: 'plan' });
    await controller.jobs.settle();
    const job = (await controller.jobs.list()).find(job => job.type === 'workflow.plan');
    const state = await application.getStatus();
    const events = observed?.evidence?.jsonl?.events || [];
    const plan = observed?.plan;
    const result = { id: item.id, request: item.request, expected: item.expected, source, sourceHashes, fixtureRoot: root,
      inputHash: sha(JSON.stringify(capturedInput)), baselineRevision, durationMs: Date.now() - started,
      state: job?.state, error: job?.error, questions: observed?.questions || [], plan: plan || null,
      modelToolItems: events.filter(event => event.type === 'item.completed' && event.item?.type !== 'agent_message').map(event => event.item?.type),
      runCount: state.runs.length, clean: git(root, ['status', '--porcelain']) === '',
      unchangedHead: git(root, ['rev-parse', 'HEAD']) === baselineRevision,
      diagnostics: plan ? diagnosePlan(plan) : null,
      semanticReview: 'Required: structure checks do not prove requirement coverage or correct dependency meaning.' };
    if (observed?.evidence) await writeFile(path.join(caseOutput, 'evidence.json'), JSON.stringify(observed.evidence, null, 2));
    await writeFile(path.join(caseOutput, 'result.json'), JSON.stringify(result, null, 2));
    assert.equal(result.runCount, 0); assert.equal(result.clean, true); assert.equal(result.unchangedHead, true);
    results.push(result);
    console.log(JSON.stringify({ id: item.id, state: result.state, error: result.error, nodes: plan?.nodes.length || 0,
      edges: plan?.nodes.reduce((sum,node)=>sum+node.dependsOn.length,0) || 0, questions: result.questions,
      durationMs: result.durationMs, runCount: result.runCount, clean: result.clean }));
  } finally { await controller.close(); }
}
let next = 0;
await Promise.all(Array.from({ length: Math.min(2, cases.length) }, async () => {
  while (next < cases.length) { const item = cases[next++]; await run(item); }
}));
await writeFile(path.join(output, 'summary.json'), JSON.stringify({ source, sourceHashes, modelRequests: cases.length,
  automaticRetries: 0, results: results.map(({ id,state,error,questions,plan,runCount,clean,unchangedHead,durationMs,modelToolItems }) =>
    ({ id,state,error,questions,plan,runCount,clean,unchangedHead,durationMs,modelToolItems })) }, null, 2));
if (results.some(item => item.state !== 'succeeded')) process.exitCode = 1;
