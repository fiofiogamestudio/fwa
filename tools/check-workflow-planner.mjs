import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { WorkbenchController } from '../src/application/workbench-controller.js';
import { CodexPlanner } from '../src/adapters/codex-planner.js';

// Explicit live-adapter smoke, deliberately excluded from npm test. Uses only a
// generated non-personal brief, never the real game project or its references.
function workProofPassed(proof) {
  return proof.job?.state === 'succeeded' && proof.job.result?.stopReason === 'awaiting-acceptance'
    && proof.runs.length === 1 && proof.runs[0].status === 'produced' && proof.changeSets.some(change => change.changedFiles.length > 0)
    && proof.integrations === 0 && proof.clean && proof.verify.ok;
}
// Read-only replay of retained proof, without spending another model request or
// attempting to repeat an already-recorded Run after a harness assertion error.
if (process.argv[2] === '--verify-work') {
  const proofPath = path.resolve(process.argv[3]);
  const proof = JSON.parse(await readFile(proofPath, 'utf8'));
  const ok = workProofPassed(proof);
  const verification = { ok, realAdapter: proof.realAdapter, fixtureRoot: proof.fixtureRoot,
    runCount: proof.runs.length, changedFiles: proof.changeSets.map(change => change.changedFiles),
    stopReason: proof.job.result.stopReason, integrations: proof.integrations, clean: proof.clean,
    semanticAcceptanceRun: proof.semanticAcceptanceRun, proofPath };
  await writeFile(path.join(path.dirname(proofPath), 'live-work-validation.json'), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify(verification));
  process.exit(ok ? 0 : 1);
}
const output = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../.local/reports/workflow-planner', import.meta.url));
const runWork = process.argv[4] === '--work';
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'fwa-live-plan-'));
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
git(['init', '-b', 'main']); git(['config', 'user.name', 'FWA Planner Smoke']); git(['config', 'user.email', 'fixture@example.invalid']);
await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
await writeFile(path.join(root, 'README.md'), 'Synthetic planning fixture. No game or implementation is present.\n');
git(['add', '.']); git(['commit', '-m', 'Synthetic fixture']);
const application = new FwaApplication(root); await application.init();
const codexOptions = { timeoutMs: 180000, ...(process.argv[3] ? { executable: path.resolve(process.argv[3]) } : {}) };
const controller = new WorkbenchController(application, { planner: new CodexPlanner(codexOptions), codexOptions,
  ...(runWork ? {} : { executor: null }) });
await controller.library.init();
const library = await controller.library.importFiles({ commandId: 'synthetic-import', label: 'Synthetic requirement', files: [{ path: 'brief.md', base64: Buffer.from(
  runWork
    ? 'Synthetic implementation requirement: create a tiny calculator module in src/calculator.js with tests in test/calculator.test.js. It must add two finite numbers and reject non-numbers, NaN and infinities. Deliver this behavior and its tests as one independently reviewable result node, without extra phase nodes. During Plan only produce the plan; during Work implement only the assigned result. No visuals are required for this pure function.'
    : 'This is a synthetic planning-only test. Plan a tiny calculator module in src/calculator.js with tests in test/calculator.test.js. It must add two finite numbers and reject non-numbers. Keep this one independently reviewable behavior and its tests in one result node; do not add phase nodes. Do not implement anything. No visuals are required for this pure function.'
).toString('base64') }] });
await controller.plan({ commandId: 'live-planner-check', request: '', libraryIds: [library.libraryId], mode: 'plan' });
await controller.jobs.settle();
const jobs = await controller.jobs.list(), status = await application.getStatus();
const result = { fixtureRoot: root, realAdapter: true, job: jobs[0], nodes: status.nodes, runs: status.runs.length, clean: git(['status', '--porcelain']) === '' };
await writeFile(path.join(output, 'live-planner.json'), JSON.stringify(result, null, 2));
if (jobs[0].result?.evidence) await writeFile(path.join(output, 'live-planner-evidence.json'), await application.artifacts.get(jobs[0].result.evidence));
console.log(JSON.stringify({ state: jobs[0].state, error: jobs[0].error, nodeCount: status.nodes.length, runs: result.runs, clean: result.clean, output, fixtureRoot: root }));
process.exitCode = jobs[0].state === 'succeeded' && status.nodes.length > 0 && result.runs === 0 && result.clean ? 0 : 1;
if (runWork && process.exitCode === 0) {
  await controller.work({ commandId: 'live-work-check', goalId: jobs[0].result.goalId });
  await controller.jobs.settle();
  const work = (await controller.jobs.list()).find(item => item.type === 'workflow.work');
  const current = await application.getStatus();
  const changes = current.changeSets;
  const proof = { fixtureRoot: root, realAdapter: true, job: work, runs: current.runs,
    changeSets: changes, integrations: current.integrations.length, clean: git(['status', '--porcelain']) === '',
    verify: await application.verify(), semanticAcceptanceRun: false };
  await writeFile(path.join(output, 'live-work.json'), JSON.stringify(proof, null, 2));
  for (const change of changes) if (change.executionArtifact) {
    await writeFile(path.join(output, `${change.id}-execution.json`), await application.artifacts.get(change.executionArtifact));
  }
  const ok = workProofPassed(proof);
  console.log(JSON.stringify({ ok, workState: work?.state, stopReason: work?.result?.stopReason,
    runs: current.runs.length, changedFiles: changes.map(change => change.changedFiles), clean: proof.clean, output }));
  process.exitCode = ok ? 0 : 1;
}
await controller.close();
