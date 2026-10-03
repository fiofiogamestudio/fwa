import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FwaApplication } from '../src/application/fwa-application.js';
import { FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';
import { startEditor } from '../src/editor/server.js';

// Isolated deterministic browser acceptance: real HTTP, Git, verification and integration.
// No model, user game or production worktree is opened or changed.
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], path.resolve(process.argv[index + 1]));
for (const key of ['--fwe', '--playwright', '--output']) assert.ok(args.has(key), `Missing ${key}`);
const output = args.get('--output'); await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(args.get('--playwright')).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(args.get('--playwright')), 'test.mjs')).href);
const startedAt = Date.now();
const report = { scope: 'Real Edge UI + HTTP + Git; deterministic dependent work; no user project.', checks: [], screenshots: [], scenarios: [], errors: [] };
const passed = text => { report.checks.push(text); process.stdout.write(`PASS ${text}\n`); };
const git = (root, values) => {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...values], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const check = (id, kind, source) => ({ id, kind, command: process.execPath, args: ['-e', source], timeoutMs: 10000 });
async function fixture(manualProfiles) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-auto-flow-browser-'));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Browser Fixture']); git(root, ['config', 'user.email', 'browser@local.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  for (const id of ['first', 'second']) await writeFile(path.join(root, `${id}.cjs`), 'module.exports = 0;\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Browser automatic flow baseline']);
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const app = new FwaApplication(root); await app.init();
  const goal = (await app.createGoal({ title: '基础数值传递给后续计算', commandId: 'create-browser-goal' })).goal;
  const node = (id, dependsOn) => ({ id, title: id === 'first' ? '基础数值' : '后续计算',
    outcome: id === 'first' ? '基础数值为 2。' : '读取基础数值并得到三倍结果 6。',
    instruction: `Produce ${id}.cjs and preserve integrated upstream results.`, dependsOn,
    dependencyReasons: dependsOn.map(nodeId => ({ nodeId, reason: '后续计算需要已完成的基础数值。' })),
    reads: dependsOn.length ? ['first.cjs', 'second.cjs'] : ['first.cjs'], writes: [`${id}.cjs`],
    capabilities: ['file_operations'], acceptance: { checks: [`${id}-value`] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 } });
  await app.loadPlan({ goalId: goal.id, plan: { schemaVersion: 1, nodes: [node('first', []), node('second', ['first'])] }, commandId: 'load-browser-plan' });
  const reviewConfig = { schemaVersion: 1, targetRef: 'main', completionPolicy: { mode: 'automatic', manualProfiles },
    validationProfiles: ['first', 'second'].map((id, index) => ({ schemaVersion: 1, id: `${id}-profile`, checks: [
      check(`${id}-value`, 'test', `require('node:assert/strict').equal(require('./${id}.cjs'),${index === 0 ? 2 : 6})`)
    ] })), regressionProfile: { schemaVersion: 1, id: 'chain-regression', checks: [
      check('compile', 'compile', "const vm=require('node:vm'),fs=require('node:fs');for(const file of ['first.cjs','second.cjs'])new vm.Script(fs.readFileSync(file,'utf8'),{filename:file});"),
      check('tests', 'test', "const a=require('node:assert/strict'),first=require('./first.cjs'),second=require('./second.cjs');a.equal(first,2);a.ok([0,6].includes(second));if(second!==0)a.equal(second,first*3);")
    ] } };
  const starts = [], delegate = new FileOperationsExecutor();
  const executor = { schemaVersion: 1, id: 'browser-auto-flow', version: '1', capabilities: ['file_operations'], async execute(input) {
    const id = input.node.id; assert.ok(['first', 'second'].includes(id)); starts.push(id);
    if (id === 'second') {
      assert.equal((await app.getStatus()).nodes.find(item => item.id === 'first').integrationStatus, 'integrated');
      assert.equal(await readFile(path.join(input.workspaceRoot, 'first.cjs'), 'utf8'), 'module.exports = 2;\n');
    }
    return delegate.execute({ ...input, input: { schemaVersion: 1, operations: [{ type: 'write', path: `${id}.cjs`, content: `module.exports = ${id === 'first' ? 2 : 6};\n` }] } });
  } };
  return { root, app, goal, baseline, starts, reviewConfig, executor };
}
let browser, editor, page;
const shot = async name => {
  for (const width of [1600, 1000]) {
    await page.setViewportSize({ width, height: 1120 });
    const file = `${name}-${width}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file);
  }
  await page.setViewportSize({ width: 1600, height: 1120 });
};
async function scenario(manual) {
  const name = manual ? 'manual-then-automatic' : 'fully-automatic', f = await fixture(manual ? ['first-profile'] : []);
  const entry = { name, root: f.root, baseline: f.baseline, commands: [], artifactRequests: [] }; report.scenarios.push(entry);
  editor = await startEditor({ projectRoot: f.root, fwePath: args.get('--fwe'), port: 0, allowWrite: true,
    reviewConfig: f.reviewConfig, workflow: { planner: null, executor: f.executor } });
  entry.url = editor.url;
  page = await browser.newPage({ viewport: { width: 1600, height: 1120 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.errors.push({ name, message: error.message }));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/fwa/commands')) entry.commands.push(request.postDataJSON());
    if (request.url().includes('/api/fwa/artifacts?')) entry.artifactRequests.push(request.url());
  });
  page.on('response', response => { if (response.status() >= 400) report.errors.push({ name, status: response.status(), url: response.url() }); });
  await page.goto(editor.url);
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled({ timeout: 20000 });
  await expect(page.getByTestId('fwa-dag').locator('[data-node-id="first"]')).toBeVisible();
  await writeFile(path.join(output, `${name}-initial-aria.txt`), await page.locator('body').ariaSnapshot());
  const topContinue = page.getByRole('button', { name: '继续', exact: true });
  await expect(topContinue).toHaveCount(1); await expect(topContinue).toBeEnabled();
  await expect(page.getByRole('button', { name: '执行此节点', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续验证此节点', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('项目验证配置', { exact: true })).toHaveCount(0);
  await shot(`${name}-00-ready`);
  await topContinue.click();
  await expect.poll(() => entry.commands.filter(item => item.type === 'workflow.work').length).toBe(1);
  assert.equal(entry.commands[0].payload.nodeId, undefined, 'Continue addresses the entire goal, not an extra node executor.');
  await expect(topContinue).toBeDisabled({ timeout: 10000 });
  passed(`${name}: one goal-level Continue, no duplicate node execution or profile picker`);
  if (manual) {
    const finish = page.getByRole('button', { name: '确认并继续', exact: true });
    await expect(finish).toBeEnabled({ timeout: 90000 });
    const status = await f.app.getStatus(), first = status.nodes.find(item => item.id === 'first');
    assert.equal(status.runs.length, 1); assert.equal(status.evaluations.length, 1); assert.equal(status.integrations.length, 0);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.baseline); assert.equal(status.nodes.find(item => item.id === 'second').status, 'planned');
    entry.manualChangeSetId = first.changeSetIds.at(-1);
    const change = status.changeSets.find(item => item.id === entry.manualChangeSetId), digest = change.patchArtifact.digest;
    const requestsForDiff = () => entry.artifactRequests.filter(url => url.includes(digest));
    assert.equal(requestsForDiff().length, 0, 'Diff bytes are not loaded before disclosure.');
    const detail = page.getByTestId('fwa-node-detail'), diff = detail.getByTestId('fwa-candidate-diff');
    await diff.locator('summary').click();
    await expect(diff.locator('.fwa-diff')).toContainText('+module.exports = 2;', { timeout: 10000 });
    assert.equal(requestsForDiff().length, 1);
    await page.getByTestId('fwa-node-feedback').locator('summary').click();
    const feedback = page.getByLabel('节点修改建议', { exact: true });
    await feedback.fill('浏览器验收草稿：保留当前节点上下文。');
    const url = page.url(); await page.getByTestId('fwa-refresh').click();
    await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
    await expect(diff).toHaveAttribute('open', '');
    await expect(diff.locator('.fwa-diff')).toContainText('+module.exports = 2;');
    await expect(feedback).toHaveValue('浏览器验收草稿：保留当前节点上下文。');
    assert.equal(page.url(), url); assert.equal(requestsForDiff().length, 1);
    await shot(`${name}-01-inline-diff-gate`);
    passed('manual gate: exact candidate verified once, inline diff lazy-loaded once, disclosure and feedback draft survive refresh');
    await finish.click();
    await expect.poll(() => entry.commands.filter(item => item.type === 'workflow.finish').length).toBe(1);
    const sent = entry.commands.find(item => item.type === 'workflow.finish');
    assert.equal(sent.payload.changeSetId, entry.manualChangeSetId); assert.ok(sent.payload.reviewToken); assert.equal(sent.payload.note, undefined);
  }
  await expect.poll(async () => (await f.app.getStatus()).nodes.filter(item => item.integrationStatus === 'integrated').length,
    { timeout: 180000, intervals: [750, 1500, 3000] }).toBe(2);
  await expect.poll(async () => (await (await fetch(editor.url + '/api/fwa/workbench')).json()).jobs.some(job => job.state === 'running'),
    { timeout: 30000 }).toBe(false);
  await page.getByTestId('fwa-refresh').click(); await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  await expect(page.getByTestId('fwa-progress-summary')).toContainText(/2\s*\/\s*2/);
  const status = await f.app.getStatus();
  assert.deepEqual(f.starts, ['first', 'second']); assert.equal(status.runs.length, 2); assert.equal(status.evaluations.length, 2); assert.equal(status.integrations.length, 2);
  assert.ok(status.evaluations.every(item => item.status === 'passed')); assert.ok(status.nodes.every(item => item.validity === 'valid' && item.integrationStatus === 'integrated'));
  assert.equal(await readFile(path.join(f.root, 'first.cjs'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(await readFile(path.join(f.root, 'second.cjs'), 'utf8'), 'module.exports = 6;\n');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  const jobs = (await (await fetch(editor.url + '/api/fwa/workbench')).json()).jobs;
  entry.jobs = jobs.map(job => ({ type: job.type, state: job.state, result: job.result }));
  assert.equal(jobs.filter(job => job.type === 'workflow.work').length, 1);
  assert.equal(jobs.filter(job => job.type === 'change.accept').length, manual ? 1 : 0);
  assert.equal(jobs.filter(job => job.type === 'change.policy-accept').length, manual ? 1 : 2);
  assert.equal(entry.commands.filter(command => command.type === 'workflow.finish').length, manual ? 1 : 0);
  await page.getByTestId('fwa-dag').locator('[data-node-id="second"]').click();
  await expect(page.getByTestId('fwa-change-review').getByRole('heading', { name: '已完成并集成', exact: true })).toBeVisible();
  await expect(page.getByTestId('fwa-console')).toBeEnabled();
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  await expect(page.getByRole('button', { name: '确认并继续', exact: true })).toBeHidden();
  await shot(`${name}-02-complete`);
  entry.verification = await f.app.verify({ workspace: new GitWorktreeAdapter(f.root), integration: new GitIntegrationAdapter(f.root), candidateWorkspace: new GitIntegrationWorkspaceAdapter(f.root) });
  assert.equal(entry.verification.ok, true, JSON.stringify(entry.verification));
  entry.finalRevision = git(f.root, ['rev-parse', 'HEAD']); entry.runs = status.runs.length; entry.integrations = status.integrations.length;
  passed(`${name}: two real integrated results, upstream commit consumed, exactly two Runs, final verify passed`);
  await writeFile(path.join(output, `${name}-final-aria.txt`), await page.locator('body').ariaSnapshot());
  await page.close(); page = null; await editor.close(); editor = null;
}
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  await scenario(true); await scenario(false);
  assert.deepEqual(report.errors, []); passed('no page errors or failed HTTP responses'); report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.stack; process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(output, 'failure-aria.txt'), await page.locator('body').ariaSnapshot()).catch(() => {});
  }
  process.stderr.write(error.stack + '\n');
} finally {
  if (page) await page.close(); if (browser) await browser.close(); if (editor) await editor.close();
  report.durationMs = Date.now() - startedAt; await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`Report: ${path.join(output, 'report.json')}\n`);
}
