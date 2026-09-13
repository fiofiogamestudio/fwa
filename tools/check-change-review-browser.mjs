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
  dependsOn: [], reads: ['counter.cjs'], writes: ['counter.cjs'], capabilities: ['file_operations'],
  acceptance: { checks: ['counter-value'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 }
}, {
  id: 'counter-view', title: '后续显示依赖计数器初始值', instruction: '在计数器变化后单独实现显示。此项尚未执行。',
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
    if (name.includes('with-without')) {
      await expect(page.getByTestId('fwa-experiment').getByRole('heading', { name: '对照已就绪', exact: true })).toBeVisible();
      await expect(page.getByText('Counter initial value: 1', { exact: true })).toBeVisible();
      await expect(page.getByText('Counter initial value: 0', { exact: true })).toBeVisible();
      const comparison = page.getByTestId('fwa-experiment').locator('.fwe-surface--comparison');
      assert.ok((await comparison.boundingBox()).width > width - 350, `${width}px comparison must use the main width`);
    }
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
  editor = await startEditor({ projectRoot: root, fwePath: args.get('--fwe'), port: 0, allowWrite: true, reviewConfig, workflow: {
    executor: null, planner: { async plan(input) {
      assert.equal(input.request, '将计数器初始值改为 1，其余行为保持不变。');
      return parsePlannerResponse({ title: '浏览器提交的计数器需求', questions: [], groups: [], nodes: [{
        id: 'requested-counter', parentId: '', title: '修改计数器初始值', instruction: '只将计数器初始值改为 1。此项可独立检查导出值和撤销。',
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
  await expect(intake).toBeVisible();
  await expect(page.getByLabel('需求描述', { exact: true })).toBeInViewport();
  await expect(page.getByLabel('选择文件', { exact: true })).toBeHidden();
  await expect(page.getByLabel('规划模式', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '任务 DAG', exact: true })).toBeHidden();
  await expect(page.getByTestId('fwa-inspector')).toBeHidden();
  await expect(page.getByRole('button', { name: '需求', exact: true })).toHaveAttribute('data-tone', 'primary');
  await expect(page.getByRole('button', { name: '需求', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('当前目标', { exact: true })).toBeHidden();
  await expect(page.getByTestId('fwa-mode')).toBeHidden();
  await expect(page.getByRole('heading', { name: '需求', exact: true })).toHaveCount(0);
  await expect(page.getByText('先生成可逐项检查的修改计划，再决定何时执行。', { exact: true })).toHaveCount(0);
  await shot('00-default-requirement.png', intake);
  passed('existing goals still open a focused requirement entry with optional imports and settings closed');
  await page.getByLabel('需求描述', { exact: true }).fill('将计数器初始值改为 1，其余行为保持不变。');
  await page.getByRole('button', { name: '生成修改计划', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看计划', exact: true })).toBeVisible({ timeout: 30000 });
  assert.equal((await app.getStatus()).runs.length, 1, 'Plan must not create any additional Run');
  assert.equal(git(['rev-parse', 'HEAD']), baseline);
  await page.getByRole('button', { name: '查看计划', exact: true }).click();
  await expect(page.getByRole('button', { name: '进度', exact: true })).toHaveAttribute('data-tone', 'primary');
  await expect(page.getByRole('button', { name: '需求', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: '任务详情', exact: true })).toBeVisible();
  await expect(page.getByTestId('fwa-dag')).toHaveCount(0);
  await shot('00-planned-progress.png', page.getByTestId('fwa-content'));
  passed('natural-language Plan reaches progress without starting execution or changing the target');
  await page.getByLabel('当前目标', { exact: true }).selectOption(goal.id);
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await expect(page.getByRole('button', { name: '修改', exact: true })).toHaveAttribute('data-tone', 'primary');
  await expect(page.getByRole('button', { name: '进度', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('查看修改', { exact: true })).toHaveValue(changeSetId);
  const review = page.getByTestId('fwa-change-review');
  const validate = review.getByRole('button', { name: '验证这项修改', exact: true });
  const accept = review.getByRole('button', { name: '记录人工验收', exact: true });
  const adopt = review.getByRole('button', { name: '回归通过后采用', exact: true });
  await expect(validate).toBeEnabled(); await expect(accept).toBeHidden(); await expect(adopt).toBeHidden();
  await expect(page.getByLabel('项目验证配置', { exact: true })).toBeHidden();
  const diff = page.locator('.fwa-diff'); await expect(diff).toBeVisible();
  assert.ok((await diff.boundingBox()).y < (await review.boundingBox()).y, 'actual diff precedes review actions');
  await shot('01-candidate-review.png', page.getByTestId('fwa-inspector'));
  passed('candidate shows actual diff before one current action and folds technical controls');
  await validate.click();
  await expect(accept).toBeEnabled({ timeout: 60000 }); assert.equal(git(['rev-parse', 'HEAD']), baseline);
  passed('exact candidate validation passes without modifying target');
  await expect(validate).toBeHidden(); await expect(adopt).toBeHidden();
  await review.getByLabel('验收结论', { exact: false }).fill('已核对候选导出值为 1，改动范围只包含计数器初始值。');
  await page.getByTestId('fwa-refresh').click();
  await expect(review.getByLabel('验收结论', { exact: false })).toHaveValue('已核对候选导出值为 1，改动范围只包含计数器初始值。');
  await accept.click(); await expect(adopt).toBeEnabled({ timeout: 20000 });
  await shot('02-human-acceptance.png', review); passed('human acceptance records candidate-bound observation and preserves draft through refresh');
  await adopt.click(); await expect(review.getByRole('heading', { name: '已采用', exact: true })).toBeVisible({ timeout: 60000 });
  assert.equal(await readFile(path.join(root, 'counter.cjs'), 'utf8'), 'module.exports = 1;\n');
  const adoptedRevision = git(['rev-parse', 'HEAD']); passed('adoption changes target only after actual regression checks');
  const experiment = page.getByTestId('fwa-experiment');
  await experiment.getByText('对比效果：保留 / 排除此项', { exact: true }).click();
  await expect(page.getByTestId('fwa-experiment-run')).toBeEnabled();
  await page.getByTestId('fwa-experiment-run').click();
  await expect(experiment.getByRole('heading', { name: '对照已就绪', exact: true })).toBeVisible({ timeout: 60000 });
  await expect(experiment.getByRole('heading', { name: '包含该变化', exact: true })).toBeVisible();
  await expect(experiment.getByRole('heading', { name: '排除该变化', exact: true })).toBeVisible();
  await expect(experiment.getByText('Counter initial value: 1', { exact: true })).toBeVisible();
  await expect(experiment.getByText('Counter initial value: 0', { exact: true })).toBeVisible();
  await expect(experiment.getByText('完整输出', { exact: true }).first()).toBeVisible();
  const comparison = experiment.locator('.fwe-surface--comparison');
  assert.ok((await comparison.boundingBox()).width > 900, 'A/B uses the full change-detail width');
  assert.equal(git(['rev-parse', 'HEAD']), adoptedRevision);
  await page.getByTestId('fwa-refresh').click();
  await expect(experiment.getByRole('heading', { name: '对照已就绪', exact: true })).toBeVisible();
  await shot('03-with-without-comparison.png', experiment);
  passed('real two-column experiment shows 1 vs 0 at the same conditions without moving target and survives refresh');
  await review.getByText('撤销此项：查看依赖影响', { exact: true }).click();
  await page.getByTestId('fwa-refresh').click();
  await expect(review.getByRole('button', { name: '已查看影响，验证后撤销此项', exact: true })).toBeVisible();
  await expect(review.getByText('后续显示依赖计数器初始值（声明依赖）', { exact: true })).toBeVisible();
  await expect(review.getByLabel('撤销原因', { exact: false })).toHaveValue('');
  await review.getByLabel('撤销原因', { exact: false }).fill('本次只撤销计数器初始值变化。已查看依赖影响。');
  await shot('04-dependency-impact.png', review);
  await review.getByRole('button', { name: '已查看影响，验证后撤销此项', exact: true }).click();
  await expect.poll(async () => (await app.getStatus()).reversions.at(-1)?.status, { timeout: 60000 }).toBe('reverted');
  await expect(review.getByRole('heading', { name: '已撤销', exact: true })).toBeVisible({ timeout: 20000 });
  await review.getByText('操作记录', { exact: true }).click();
  await expect(review.getByText('撤销 · 完成：已撤销', { exact: true })).toBeVisible({ timeout: 20000 });
  await review.scrollIntoViewIfNeeded();
  assert.equal(await readFile(path.join(root, 'counter.cjs'), 'utf8'), 'module.exports = 0;\n');
  assert.equal(git(['merge-base', '--is-ancestor', adoptedRevision, 'HEAD']), '');
  assert.equal(git(['status', '--porcelain']), '');
  await shot('05-reverted-with-history.png', review); passed('gated reversion restores behavior and retains adopted history');
  await page.reload();
  await expect(page.getByLabel('查看修改', { exact: true })).toHaveValue(changeSetId, { timeout: 20000 });
  await expect(review.getByRole('heading', { name: '已撤销', exact: true })).toBeVisible({ timeout: 20000 });
  passed('canonical object deep link restores the selected change after reload');
  report.verification = await app.verify({ workspace: new GitWorktreeAdapter(root), integration: new GitIntegrationAdapter(root), candidateWorkspace: new GitIntegrationWorkspaceAdapter(root) });
  assert.equal(report.verification.ok, true, JSON.stringify(report.verification));
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { message: error.message, stack: error.stack };
  if (page) { await shot('failure.png').catch(() => {}); await writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').ariaSnapshot().catch(() => 'Snapshot unavailable')); }
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await editor?.close();
  process.stdout.write(JSON.stringify({ ok: report.ok, root, output, checks: report.checks.length, failure: report.failure?.message }) + '\n');
}
