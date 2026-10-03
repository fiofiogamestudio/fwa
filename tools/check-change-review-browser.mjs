import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { parsePlannerResponse } from '../src/adapters/codex-planner.js';

// Real browser + HTTP + Git acceptance of a deterministic fixture. It does not
// invoke a model, open a user game, or claim game/visual content acceptance.
const args = new Map();
const startedAt = Date.now();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--fwe', '--browser', '--playwright', '--output'].includes(process.argv[index]) || !process.argv[index + 1]) throw new Error('Required: --fwe ROOT --browser EXE --playwright MODULE --output DIRECTORY');
  args.set(process.argv[index], path.resolve(process.argv[index + 1]));
}
for (const key of ['--fwe', '--browser', '--playwright', '--output']) assert.ok(args.has(key), `Missing ${key}`);
const output = args.get('--output'); await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'fwa-review-browser-'));
const git = args => {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
await writeFile(path.join(root, 'counter.cjs'), 'module.exports = 0;\n');
git(['init', '-b', 'main']); git(['config', 'user.name', 'FWA Browser Fixture']); git(['config', 'user.email', 'fixture@local.invalid']);
git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['commit', '-m', 'Create review browser fixture']);
const baseline = git(['rev-parse', 'HEAD']);
const app = new FwaApplication(root); await app.init();
const goal = (await app.createGoal({ title: '独立变化：计数器由 0 改为 1' })).goal;
await app.loadPlan({ goalId: goal.id, plan: { schemaVersion: 1, nodes: [{
  id: 'counter-increment', title: '计数器初始值由 0 改为 1', instruction: '只调整计数器初始值，并验证导出值确实为 1。可独立验收和撤销。',
  outcome: '计数器初始值为 1，其余行为保持不变。', dependencyReasons: [],
  dependsOn: [], reads: ['counter.cjs'], writes: ['counter.cjs'], capabilities: ['file_operations'],
  acceptance: { checks: ['counter-value'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 }
}, {
  id: 'counter-view', title: '后续显示依赖计数器初始值', instruction: '在计数器变化后单独实现显示。此项尚未执行。',
  outcome: '显示计数器当前初始值。', dependencyReasons: [{ nodeId: 'counter-increment', reason: '显示内容消费已经确认的计数器初始值。' }],
  dependsOn: ['counter-increment'], reads: ['counter.cjs'], writes: ['counter-view.txt'], capabilities: ['file_operations'],
  acceptance: { checks: ['counter-view-value'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 }
}] } });
const produced = await app.runNext({ executor: new FileOperationsExecutor(), workspace: new GitWorktreeAdapter(root),
  input: { schemaVersion: 1, operations: [{ type: 'write', path: 'counter.cjs', content: 'module.exports = 1;\n' }] } });
assert.equal(produced.ok, true);
const changeSetId = produced.changeSet.id;
const check = (id, kind, arguments_) => ({ id, kind, command: process.execPath, args: arguments_, timeoutMs: 10000 });
const regressionProfile = { schemaVersion: 1, id: 'counter-regression', checks: [
  check('compile', 'compile', ['--check', 'counter.cjs']),
  check('tests', 'test', ['-e', "require('node:assert/strict').ok([0,1].includes(require('./counter.cjs')))"])
] };
const reviewConfig = { schemaVersion: 1, targetRef: 'main', validationProfiles: [{ schemaVersion: 1, id: 'counter-acceptance', checks: [
  check('counter-value', 'test', ['-e', "const value=require('./counter.cjs');require('node:assert/strict').equal(value,1);console.log('Observed counter = '+value)"])
] }, { schemaVersion: 1, id: 'counter-view-acceptance', checks: [
  check('counter-view-value', 'test', ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('counter-view.txt','utf8'),'1')"])
] }], regressionProfile, experiment: { conditions: { scene: 'counter-fixture', seed: 1, input: 'none' }, profile: {
  schemaVersion: 1, id: 'counter-comparison', checks: [check('observe-counter', 'test', ['-e', "console.log('Counter initial value: '+require('./counter.cjs'));console.log('Fixed conditions: '+process.env.FWA_EXPERIMENT_CONDITIONS)"])]
} } };
await writeFile(path.join(output, 'review-config.json'), JSON.stringify(reviewConfig, null, 2));
const { chromium } = await import(pathToFileURL(args.get('--playwright')).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(args.get('--playwright')), 'test.mjs')).href);
const report = { scope: 'Real UI/HTTP/Git pipeline on a deterministic fixture; no model or game visual acceptance.', root, changeSetId, baseline, checks: [], screenshots: [], errors: [] };
let editor, browser, page;
const passed = name => { report.checks.push(name); process.stdout.write(`PASS ${name}\n`); };
const shot = async (name, focus) => {
  for (const width of [1600, 1000]) {
    await page.setViewportSize({ width, height: 1120 });
    await expect(page.getByText('正在校验并读取不可变产物…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('正在读取实验条件…', { exact: true })).toHaveCount(0);
    if (focus) {
      try { await focus.scrollIntoViewIfNeeded(); }
      catch (error) {
        // Periodic refresh can replace the presentation between ready and scroll.
        // Retry this read-only framing once; commands are never replayed here.
        if (!/not attached to the DOM/.test(error.message)) throw error;
        await expect(focus).toBeVisible(); await focus.scrollIntoViewIfNeeded();
      }
    }
    const file = name.replace('.png', `-${width}.png`);
    await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file);
  }
  await page.setViewportSize({ width: 1600, height: 1120 });
};
try {
  const delegate = new FileOperationsExecutor();
  editor = await startEditor({ projectRoot: root, fwePath: args.get('--fwe'), port: 0, allowWrite: true, reviewConfig, workflow: {
    executor: { schemaVersion: 1, id: 'review-browser-fixture', version: '1', capabilities: ['file_operations'], async execute(input) {
      assert.equal(input.node.id, 'counter-view', 'The retained source candidate must never be reproduced.');
      return delegate.execute({ ...input, input: { schemaVersion: 1,
        operations: [{ type: 'write', path: 'counter-view.txt', content: '1' }] } });
    } }, planner: { async plan(input) {
      assert.equal(input.request, '将计数器初始值改为 1，其余行为保持不变。');
      return parsePlannerResponse({ title: '浏览器提交的计数器需求', questions: [], groups: [], nodes: [{
        id: 'requested-counter', parentId: '', title: '修改计数器初始值', instruction: '只将计数器初始值改为 1。此项可独立检查导出值和撤销。',
        outcome: '计数器初始值为 1，其余行为保持不变。', dependencyReasons: [], derivedFrom: null, resources: [],
        dependsOn: [], reads: ['counter.cjs'], writes: ['counter.cjs'], checks: ['counter-value'], maxFiles: 1, maxDiffLines: 20
      }] }, { prefix: input.prefix, referenceInputs: [] });
    } }
  } });
  browser = await chromium.launch({ executablePath: args.get('--browser'), headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1120 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(editor.url);
  await expect(page.getByText('FWA · 开发工作台', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled({ timeout: 20000 });
  const intake = page.getByTestId('fwa-workflow-intake');
  const dag = page.getByTestId('fwa-dag');
  const inspector = page.getByTestId('fwa-inspector');
  const node = page.getByTestId('fwa-node-detail');
  const review = page.getByTestId('fwa-change-review');
  const graphNode = id => dag.locator(`[data-node-id="${id}"]`);
  await expect(intake).toBeHidden();
  await page.getByText('新建任务', { exact: true }).click();
  await expect(intake).toBeVisible();
  await expect(page.getByLabel('需求描述', { exact: true })).toBeInViewport();
  await expect(page.getByLabel('选择文件', { exact: true })).toBeHidden();
  await expect(dag).toBeVisible(); await expect(inspector).toBeVisible();
  await expect(graphNode('counter-increment')).toBeVisible();
  await expect(page.getByLabel('当前目标', { exact: true })).toBeVisible();
  for (const label of ['需求', '进度', '修改']) await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  for (const width of [1600, 1000]) {
    await page.setViewportSize({ width, height: 1120 });
    await expect(page.getByLabel('需求描述', { exact: true })).toBeInViewport();
    await expect(dag).toBeVisible(); await expect(inspector).toBeVisible();
    const graphBounds = await dag.boundingBox(), detailBounds = await inspector.boundingBox();
    assert.ok(width === 1600 ? detailBounds.x > graphBounds.x + graphBounds.width
      : detailBounds.y >= graphBounds.y + graphBounds.height, 'The narrow layout stacks detail below the graph.');
  }
  await shot('00-requirement-dag-node.png');
  passed('requirement, persistent DAG and selected-node detail share one workspace at 1600px and 1000px without phase tabs');
  await page.getByLabel('需求描述', { exact: true }).fill('将计数器初始值改为 1，其余行为保持不变。');
  await page.getByRole('button', { name: '生成任务图', exact: true }).click();
  await page.getByText('最近请求', { exact: true }).click();
  await expect(page.getByRole('button', { name: '查看计划', exact: true })).toBeVisible({ timeout: 30000 });
  assert.equal((await app.getStatus()).runs.length, 1, 'Plan must not create any additional Run');
  assert.equal(git(['rev-parse', 'HEAD']), baseline);
  await page.getByRole('button', { name: '查看计划', exact: true }).click();
  await expect(node.getByRole('heading', { name: '计数器初始值为 1，其余行为保持不变。', exact: true })).toBeVisible();
  await expect(dag).toBeVisible();
  await expect(node.getByTestId('fwa-node-acceptance')).toBeVisible();
  await shot('01-planned-dag.png', dag);
  passed('natural-language Plan selects its result in the same DAG without starting execution or changing the target');
  await page.getByLabel('当前目标', { exact: true }).selectOption(goal.id);
  await expect(graphNode('counter-increment')).toBeVisible();
  await graphNode('counter-increment').click();
  await expect(node.getByRole('heading', { name: '计数器初始值为 1，其余行为保持不变。', exact: true })).toBeVisible();
  await expect(node.getByTestId('fwa-candidate-diff')).toBeVisible();
  await expect(review.getByRole('heading', { name: '等待自动验证', exact: true })).toBeVisible();
  await expect(page.getByLabel('项目验证配置', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  const finish = review.getByRole('button', { name: '确认并继续', exact: true });
  await expect(finish).toBeEnabled({ timeout: 300000 });
  const validatedState = await app.getStatus();
  assert.equal(validatedState.runs.length, 1, 'Continuing a saved candidate must not rerun its producer');
  const evidence = validatedState.evidence.find(item => item.changeSetId === changeSetId && item.result === 'pass');
  assert.ok(evidence); assert.equal(evidence.headRevision, produced.changeSet.headRevision);
  assert.equal(git(['rev-parse', 'HEAD']), baseline);
  assert.equal(validatedState.nodes.find(item => item.id === 'counter-view').status, 'planned');
  await expect(review.getByLabel('验收结论', { exact: false })).toHaveCount(0);
  passed('continuing the existing result automatically validates its exact revision without a new Run, target change or early downstream unlock');
  await node.getByTestId('fwa-candidate-diff').locator(':scope > summary').click();
  const diff = page.locator('.fwa-diff'); await expect(diff).toBeVisible();
  await expect(diff).toContainText('+module.exports = 1;');
  await expect(dag).toBeVisible();
  await shot('02-candidate-result.png', inspector);
  await node.getByText('执行记录与技术细节', { exact: true }).click();
  await inspector.getByRole('link', { name: /^通过 · evidence_/ }).click();
  await expect(page.getByTestId('fwa-criteria')).toBeVisible();
  await page.getByTestId('fwa-criteria').getByRole('button', { name: '输出', exact: true }).click();
  await expect(page.getByTestId('fwa-artifact-text')).toContainText('Observed counter = 1');
  await expect(dag).toBeVisible();
  await shot('03-bound-evidence.png', inspector);
  await inspector.getByRole('button', { name: '← 返回任务节点', exact: true }).click();
  await expect(finish).toBeEnabled({ timeout: 30000 });
  passed('node result opens real diff and immutable check output while retaining the DAG and a direct return to the node');
  const finishRequest = page.waitForRequest(request => request.url() === editor.url + '/api/fwa/commands'
    && request.method() === 'POST' && request.postDataJSON()?.type === 'workflow.finish');
  await finish.click();
  const submittedFinish = (await finishRequest).postDataJSON();
  await expect(review.getByRole('heading', { name: '已完成并集成', exact: true })).toBeVisible({ timeout: 300000 });
  await expect.poll(async () => (await app.getStatus()).nodes.find(item => item.id === 'counter-view')?.status, { timeout: 300000 }).toBe('accepted');
  assert.equal(await readFile(path.join(root, 'counter.cjs'), 'utf8'), 'module.exports = 1;\n');
  const adoptedRevision = git(['rev-parse', 'HEAD']); assert.notEqual(adoptedRevision, baseline);
  const integratedState = await app.getStatus();
  assert.equal(integratedState.nodes.find(item => item.id === 'counter-view').status, 'accepted');
  assert.notEqual(integratedState.nodes.find(item => item.id === 'counter-view').integrationStatus, 'integrated');
  const session = await (await fetch(editor.url + '/api/fwa/session')).json();
  const jobs = (await (await fetch(editor.url + '/api/fwa/workbench')).json()).jobs;
  const accepted = jobs.filter(job => job.type === 'change.accept' && job.result?.changeSetId === changeSetId);
  assert.equal(accepted.length, 1); assert.equal(accepted[0].result.evidenceId, evidence.id);
  assert.equal(accepted[0].result.note, '用户确认当前候选及验证证据并请求收束');
  const replay = await fetch(editor.url + '/api/fwa/commands', { method: 'POST', headers: { Origin: editor.url,
    'Content-Type': 'application/json', 'X-FWA-CSRF': session.csrfToken, 'X-FWA-Fingerprint': session.fingerprint }, body: JSON.stringify(submittedFinish) });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).result.appended, false);
  assert.equal((await app.getStatus()).integrations.length, integratedState.integrations.length);
  assert.equal(git(['rev-parse', 'HEAD']), adoptedRevision);
  report.finish = { commandId: submittedFinish.commandId, evidenceId: evidence.id, acceptanceCommandId: accepted[0].commandId,
    adoptedRevision, duplicateAppended: false, downstreamStatus: 'accepted-awaiting-human-confirmation' };
  await graphNode('counter-view').click();
  await expect(node.getByRole('heading', { name: '显示计数器当前初始值。', exact: true })).toBeVisible();
  await expect(finish).toBeEnabled({ timeout: 30000 });
  await expect(node.getByRole('button', { name: '执行此节点', exact: true })).toHaveCount(0);
  await expect(node.getByText('显示内容消费已经确认的计数器初始值。', { exact: true })).toBeVisible();
  await shot('04-downstream-ready.png', inspector);
  passed('one confirmation integrates the source and continues the downstream candidate to its own manual gate; duplicate HTTP submission is idempotent');
  await graphNode('counter-increment').click();
  await expect(page.getByTestId('fwa-console')).toBeEnabled({ timeout: 30000 });
  const independentResult = node.getByRole('link', { name: '查看独立结果记录', exact: true });
  if (!(await independentResult.isVisible())) await node.getByText('执行记录与技术细节', { exact: true }).click();
  await independentResult.click();
  // Resource navigation updates the address asynchronously. Reload only after
  // the selected object and canonical URL agree, not immediately after click.
  await expect.poll(() => new URL(page.url()).searchParams.get('fweFile'))
    .toBe(`objects/changeSets/${changeSetId}.json`);
  await inspector.getByTestId('fwa-candidate-diff').locator(':scope > summary').click();
  await expect(diff).toBeVisible();
  await page.reload();
  await expect(inspector.getByTestId('fwa-candidate-diff')).toBeVisible({ timeout: 20000 });
  await inspector.getByTestId('fwa-candidate-diff').locator(':scope > summary').click();
  await expect(diff).toBeVisible({ timeout: 20000 });
  await expect(review.getByRole('heading', { name: '已完成并集成', exact: true })).toBeVisible({ timeout: 20000 });
  await expect(dag).toBeVisible();
  passed('canonical result deep link restores the selected candidate with requirement and DAG after reload');
  await page.getByTestId('fwa-refresh').click();
  await review.getByText('撤销此项：查看依赖影响', { exact: true }).click();
  await page.getByTestId('fwa-refresh').click();
  await expect(review.getByRole('button', { name: '已查看影响，验证后撤销此项', exact: true })).toBeVisible();
  await expect(review.getByText('后续显示依赖计数器初始值（现有结果将失效）', { exact: true })).toBeVisible();
  await expect(review.getByLabel('撤销原因', { exact: false })).toHaveValue('');
  await review.getByLabel('撤销原因', { exact: false }).fill('本次只撤销计数器初始值变化。已查看依赖影响。');
  await shot('05-dependency-impact.png', review);
  await review.getByRole('button', { name: '已查看影响，验证后撤销此项', exact: true }).click();
  await expect.poll(async () => (await app.getStatus()).reversions.at(-1)?.status, { timeout: 300000 }).toBe('reverted');
  await expect(review.getByRole('heading', { name: '已撤销', exact: true })).toBeVisible({ timeout: 20000 });
  await review.getByText('操作记录', { exact: true }).click();
  await expect(review.getByText('撤销 · 完成：已撤销', { exact: true })).toBeVisible({ timeout: 20000 });
  await review.scrollIntoViewIfNeeded();
  assert.equal(await readFile(path.join(root, 'counter.cjs'), 'utf8'), 'module.exports = 0;\n');
  assert.equal(git(['merge-base', '--is-ancestor', adoptedRevision, 'HEAD']), '');
  assert.equal(git(['status', '--porcelain']), '');
  const revertedState = await app.getStatus();
  assert.equal(revertedState.nodes.find(item => item.id === 'counter-view').validity, 'stale');
  assert.equal(revertedState.runs.length, 2, 'Reversion must retain both production attempts.');
  await shot('06-reverted-with-history.png', review); passed('gated reversion restores behavior and retains adopted history');
  report.verification = await app.verify({ workspace: new GitWorktreeAdapter(root), integration: new GitIntegrationAdapter(root), candidateWorkspace: new GitIntegrationWorkspaceAdapter(root) });
  assert.equal(report.verification.ok, true, JSON.stringify(report.verification));
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { message: error.message, stack: error.stack };
  if (page) { await shot('failure.png').catch(() => {}); await writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').ariaSnapshot().catch(() => 'Snapshot unavailable')); }
  process.exitCode = 1;
} finally {
  report.durationMs = Date.now() - startedAt;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await editor?.close();
  process.stdout.write(JSON.stringify({ ok: report.ok, root, output, checks: report.checks.length, failure: report.failure?.message }) + '\n');
}
