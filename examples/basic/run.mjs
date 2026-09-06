import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CommandEvaluator,
  FileOperationsExecutor,
  FwaApplication,
  GitIntegrationAdapter,
  GitIntegrationWorkspaceAdapter,
  GitWorktreeAdapter
} from '../../src/index.js';

const mode = process.argv[2] ?? '--api';
if (process.argv.length > 3 || !['--api', '--cli', '--prepare'].includes(mode)) {
  throw new Error('Usage: node examples/basic/run.mjs [--api|--cli|--prepare]');
}
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = await mkdtemp(path.join(tmpdir(), 'fwa-basic-'));
const projectRoot = path.join(root, 'project');
const inputsRoot = path.join(root, 'inputs');
await mkdir(projectRoot);
await mkdir(inputsRoot);
process.stderr.write(`FWA example (${mode}): ${root}\n`);

function processOutput(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? (result.stderr || result.stdout)}`);
  }
  return result.stdout;
}
function git(...args) {
  return processOutput('git', ['-c', 'core.fsmonitor=false', ...args], projectRoot).trim();
}
function cli(...args) {
  const output = processOutput(process.execPath, [
    path.join(packageRoot, 'bin/fwa.js'), ...args, '--project', projectRoot, '--json'
  ], packageRoot);
  return JSON.parse(output);
}
async function saveJson(name, value) {
  const destination = path.join(inputsRoot, name);
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return destination;
}
function succeeded(result, phase) {
  assert.equal(result.ok, true, `${phase}: ${JSON.stringify(result)}`);
  return result;
}

// Only this newly created temporary repository receives identity and Git settings.
const baseline = 'export const value = 0;\n';
await writeFile(path.join(projectRoot, '.gitignore'), '/.fwa/\n');
await writeFile(path.join(projectRoot, 'counter.mjs'), baseline);
await writeFile(path.join(projectRoot, 'counter.test.mjs'), [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { value } from './counter.mjs';",
  "test('counter remains a nonnegative integer', () => {",
  '  assert.ok(Number.isInteger(value) && value >= 0);',
  '});', ''
].join('\n'));
git('init', '-b', 'main');
git('config', 'user.name', 'FWA Local Example');
git('config', 'user.email', 'fwa-example@example.invalid');
git('config', 'core.fsmonitor', 'false');
git('config', 'core.autocrlf', 'false');
git('add', '.gitignore', 'counter.mjs', 'counter.test.mjs');
git('commit', '--no-gpg-sign', '-m', 'Initialize standalone FWA example');
const baseRevision = git('rev-parse', 'HEAD');

const ref = {
  id: 'ref://code/counter', kind: 'code', uri: 'counter.mjs',
  version: `git:${baseRevision}`,
  hash: `sha256:${createHash('sha256').update(baseline).digest('hex')}`,
  metadata: { initialHashSource: 'counter.mjs bytes at initial Git revision' }
};
const plan = {
  schemaVersion: 1,
  nodes: [{
    id: 'increment-counter', dependsOn: [],
    reads: [ref.id], writes: [ref.id], capabilities: ['file_operations'],
    acceptance: { checks: ['compile', 'tests', 'feature'] },
    budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 }
  }]
};
const operations = {
  schemaVersion: 1,
  operations: [{ type: 'write', path: 'counter.mjs', content: 'export const value = 1;\n' }]
};
const regression = {
  schemaVersion: 1, id: 'basic-regression',
  checks: [
    { id: 'compile', kind: 'compile', command: process.execPath,
      args: ['--check', 'counter.mjs'], timeoutMs: 10_000 },
    { id: 'tests', kind: 'test', command: process.execPath,
      args: ['--test', 'counter.test.mjs'], timeoutMs: 10_000 }
  ]
};
const acceptance = {
  ...regression, id: 'basic-acceptance',
  checks: [...regression.checks, {
    id: 'feature', kind: 'test', command: process.execPath,
    args: ['--input-type=module', '-e',
      "import assert from 'node:assert/strict'; import {value} from './counter.mjs'; assert.equal(value, 1);"],
    timeoutMs: 10_000
  }]
};
const files = {};
for (const [name, value] of Object.entries({ ref, plan, operations, acceptance, regression })) {
  files[name] = await saveJson(`${name}.json`, value);
}

if (mode === '--prepare') {
  process.stdout.write(`${JSON.stringify({ root, projectRoot, inputsRoot, baseRevision, files }, null, 2)}\n`);
} else {
  const app = new FwaApplication(projectRoot);
  const workspace = new GitWorktreeAdapter(projectRoot);
  const evaluator = new CommandEvaluator();
  const promotion = new GitIntegrationAdapter(projectRoot);
  const candidateWorkspace = new GitIntegrationWorkspaceAdapter(projectRoot);
  const gate = { candidateWorkspace, promotion, evaluator, evaluationWorkspace: workspace,
    targetRef: 'main', profile: regression };
  const viaCli = mode === '--cli';
  const phase = (label) => process.stderr.write(`${label}\n`);
  phase('initialize, register Ref, create Goal, load plan');
  if (viaCli) cli('init'); else await app.init();
  if (viaCli) cli('ref', 'register', files.ref); else await app.registerRef({ ref });
  const created = viaCli
    ? cli('goal', 'create', 'Increment a standalone counter')
    : await app.createGoal({ title: 'Increment a standalone counter' });
  if (viaCli) cli('plan', 'load', created.goal.id, files.plan);
  else await app.loadPlan({ goalId: created.goal.id, plan });
  phase('execute bounded edit and evaluate acceptance');
  const produced = succeeded(viaCli
    ? cli('run', 'next', files.operations, '--executor', 'file-operations')
    : await app.runNext({ executor: new FileOperationsExecutor(), workspace, input: operations }), 'run');
  const changeSetId = produced.changeSet.id;
  succeeded(viaCli
    ? cli('evaluate', 'run', changeSetId, files.acceptance)
    : await app.evaluateChangeSet({ changeSetId, evaluator, workspace, profile: acceptance }), 'evaluate');
  phase('regression-gated integration');
  succeeded(viaCli
    ? cli('integrate', 'gated', changeSetId, files.regression, '--target', 'main')
    : await app.integrateChangeSetGated({ ...gate, changeSetId }), 'integrate');
  assert.equal(await readFile(path.join(projectRoot, 'counter.mjs'), 'utf8'), operations.operations[0].content);
  phase('regression-gated revert and integrity verification');
  succeeded(viaCli
    ? cli('revert', 'run', changeSetId, files.regression, '--target', 'main')
    : await app.revertChangeSet({ ...gate, changeSetId }), 'revert');
  assert.equal(await readFile(path.join(projectRoot, 'counter.mjs'), 'utf8'), baseline);
  const verification = succeeded(viaCli ? cli('verify')
    : await app.verify({ workspace, integration: promotion, candidateWorkspace }), 'verify');
  assert.equal(verification.operationallyClean, true);
  assert.equal(git('status', '--porcelain'), '');
  const status = viaCli ? cli('status') : await app.getStatus();
  const summary = { ok: true, mode, root, projectRoot, inputsRoot, files,
    goalId: created.goal.id, changeSetId, baseRevision, finalRevision: git('rev-parse', 'HEAD'),
    operationallyClean: verification.operationallyClean,
    node: status.nodes.find((node) => node.id === 'increment-counter') };
  await saveJson('summary.json', summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
