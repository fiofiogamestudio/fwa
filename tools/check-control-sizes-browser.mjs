import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FwaApplication } from '../src/application/fwa-application.js';
import { FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { startEditor } from '../src/editor/server.js';

// Short, fixed-viewport presentation check. Uses an isolated real candidate;
// never evaluates or adopts it, invokes a model, or opens a user project.
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(['--fwe', '--browser', '--playwright', '--output'].includes(process.argv[index]) && process.argv[index + 1], 'Required: --fwe ROOT --browser EXE --playwright MODULE --output DIRECTORY');
  args.set(process.argv[index], path.resolve(process.argv[index + 1]));
}
for (const key of ['--fwe', '--browser', '--playwright', '--output']) assert.ok(args.has(key), `Missing ${key}`);
const output = args.get('--output'); await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'fwa-control-sizes-'));
const git = arguments_ => {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...arguments_], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
await writeFile(path.join(root, 'counter.cjs'), 'module.exports = 0;\n');
git(['init', '-b', 'main']); git(['config', 'user.name', 'FWA Browser Fixture']); git(['config', 'user.email', 'fixture@local.invalid']);
git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['commit', '-m', 'Create control size browser fixture']);
const baseline = git(['rev-parse', 'HEAD']);
const app = new FwaApplication(root); await app.init();
const goal = (await app.createGoal({ title: '计数器初始值由 0 改为 1' })).goal;
await app.loadPlan({ goalId: goal.id, plan: { schemaVersion: 1, nodes: [{
  id: 'counter-increment', title: '计数器初始值由 0 改为 1', instruction: '只调整计数器初始值，并验证导出值确实为 1。可独立验收和撤销。',
  dependsOn: [], reads: ['counter.cjs'], writes: ['counter.cjs'], capabilities: ['file_operations'],
  acceptance: { checks: ['counter-value'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 }
}] } });
const produced = await app.runNext({ executor: new FileOperationsExecutor(), workspace: new GitWorktreeAdapter(root),
  input: { schemaVersion: 1, operations: [{ type: 'write', path: 'counter.cjs', content: 'module.exports = 1;\n' }] } });
assert.equal(produced.ok, true);
const check = (id, kind, arguments_) => ({ id, kind, command: process.execPath, args: arguments_, timeoutMs: 10000 });
const reviewConfig = { schemaVersion: 1, targetRef: 'main', validationProfiles: [{ schemaVersion: 1, id: 'counter-acceptance', checks: [
  check('counter-value', 'test', ['-e', "require('node:assert/strict').equal(require('./counter.cjs'),1)"])
] }], regressionProfile: { schemaVersion: 1, id: 'counter-regression', checks: [
  check('compile', 'compile', ['--check', 'counter.cjs']),
  check('tests', 'test', ['-e', "require('node:assert/strict').ok([0,1].includes(require('./counter.cjs')))"])
] } };
const { chromium } = await import(pathToFileURL(args.get('--playwright')).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(args.get('--playwright')), 'test.mjs')).href);
const report = { scope: '1280x800 UI dimensions on an isolated candidate; no model invocation or content acceptance.', root, baseline,
  viewport: { width: 1280, height: 800 }, checks: [], measurements: {}, screenshots: [], errors: [] };
let editor, browser, page;
const passed = name => { report.checks.push(name); process.stdout.write(`PASS ${name}\n`); };
const measure = async name => {
  report.measurements[name] = await page.locator('button, select, input, textarea, summary, .field__label').evaluateAll(elements => elements.filter(element => {
    const box = element.getBoundingClientRect(); const css = getComputedStyle(element);
    return box.width && box.height && css.visibility !== 'hidden' && !element.closest('[hidden]') &&
      ![...element.closest('body').querySelectorAll('details:not([open])')].some(details => details.contains(element) && details.querySelector(':scope > summary') !== element);
  }).map(element => {
    const box = element.getBoundingClientRect(); const css = getComputedStyle(element);
    return { tag: element.tagName.toLowerCase(), label: element.getAttribute('aria-label') || element.textContent.trim().replace(/\s+/g, ' ').slice(0, 100),
      testId: element.getAttribute('data-testid'), section: element.getAttribute('data-section'),
      type: element.getAttribute('type'), className: element.className, width: box.width, height: box.height, top: box.top, bottom: box.bottom,
      fontSize: css.fontSize, lineHeight: css.lineHeight, padding: css.padding, rows: element.rows || null };
  }));
};
const shot = async name => {
  const file = `${name}-1280x800.png`; await page.screenshot({ path: path.join(output, file), fullPage: false }); report.screenshots.push(file);
};
const checkControls = name => {
  const controls = report.measurements[name].filter(item => ['button', 'select', 'input'].includes(item.tag) && !['checkbox', 'radio', 'file', 'range', 'color'].includes(item.type));
  assert.ok(controls.length > 0);
  for (const item of controls) { assert.equal(item.height, 36, `${name}: ${item.label} height`); assert.equal(item.fontSize, '14px', `${name}: ${item.label} font`); }
  for (const item of report.measurements[name].filter(item => item.className === 'field__label')) {
    assert.equal(item.fontSize, '12px', `${name}: ${item.label} label font`); assert.equal(item.lineHeight, '16px', `${name}: ${item.label} label line height`);
  }
};
try {
  editor = await startEditor({ projectRoot: root, fwePath: args.get('--fwe'), port: 0, allowWrite: true, reviewConfig });
  browser = await chromium.launch({ executablePath: args.get('--browser'), headless: true });
  page = await browser.newPage({ viewport: report.viewport, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(editor.url);
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled({ timeout: 20000 });
  await expect(page.getByTestId('fwa-workflow-intake')).toBeVisible();
  await expect(page.getByLabel('需求描述', { exact: true })).toHaveAttribute('rows', '4');
  await expect(page.getByRole('button', { name: '需求', exact: true })).toHaveAttribute('data-tone', 'primary');
  await measure('default'); await shot('01-default'); checkControls('default');
  const prompt = report.measurements.default.find(item => item.tag === 'textarea');
  assert.equal(prompt.fontSize, '14px'); assert.equal(prompt.lineHeight, '20px'); assert.equal(prompt.height, 98);
  const nav = report.measurements.default.filter(item => ['intake', 'changeSets', 'progress'].includes(item.section) || item.tag === 'summary' && item.label === '高级');
  assert.equal(nav.length, 4); assert.ok(Math.max(...nav.map(item => item.bottom)) - Math.min(...nav.map(item => item.bottom)) < 1);
  passed('requirement controls use shared 36px / 14px dimensions, a 4-row prompt, and aligned navigation');
  const mode = page.getByLabel('规划模式', { exact: true });
  const modeDetails = mode.locator('xpath=ancestor::details[1]');
  await modeDetails.locator(':scope > summary').click(); await expect(mode).toBeVisible();
  await measure('settings'); checkControls('settings');
  passed('expanded execution settings retain the same select and button dimensions');
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await expect(page.getByLabel('查看修改', { exact: true })).toHaveValue(produced.changeSet.id);
  await expect(page.locator('.fwa-diff')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('button', { name: '验证这项修改', exact: true })).toBeEnabled();
  await measure('changes'); await shot('02-changes'); checkControls('changes');
  passed('candidate details render a real diff and validation control at the same dimensions');
  assert.equal(git(['rev-parse', 'HEAD']), baseline); assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) {
  report.ok = false; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  if (page) { await shot('failure').catch(() => {}); await writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').ariaSnapshot().catch(() => 'Snapshot unavailable')); }
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await editor?.close();
  process.stdout.write(JSON.stringify({ ok: report.ok, output, checks: report.checks.length, failure: report.failure?.message }) + '\n');
}
