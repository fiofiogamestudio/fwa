import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { parsePlannerResponse } from '../src/adapters/codex-planner.js';
import { startEditor } from '../src/editor/server.js';
import { hasActiveProjectOperation } from '../src/core/scheduling.js';

// Explicit deterministic adapter fixture. Browser actions operate the real FWE
// UI/API/Git pipeline; this is not represented as a live AI or game acceptance.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], path.resolve(process.argv[i + 1]));
for (const key of ['--fwe', '--browser', '--playwright', '--output']) assert.ok(args.has(key), `Missing ${key}`);
const output = args.get('--output'); await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(args.get('--playwright')).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(args.get('--playwright')), 'test.mjs')).href);
const parent = realpathSync.native(tmpdir()), prefix = 'fwa-interactive-';
const root = realpathSync.native(await mkdtemp(path.join(parent, prefix)));
const report = { ok: false, fixtureRoot: root, simulatedAdapters: true, checks: [], screenshots: [] };
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const git = command => {
  const result = spawnSync('git', command, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
let browser, context, editor, release, page;
try {
  git(['init', '-b', 'main']); git(['config', 'user.name', 'FWA Browser Test']); git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n'); await writeFile(path.join(root, 'seed.txt'), 'original');
  await writeFile(path.join(root, 'seed.cjs'), "module.exports = 'original';\n");
  git(['add', '.']); git(['commit', '-m', 'fixture']);
  const source = path.join(root, '.fwa', 'upload-fixture');
  const application = new FwaApplication(root); await application.init();
  await mkdir(path.join(source, 'docs'), { recursive: true });
  await writeFile(path.join(source, 'docs', 'brief.md'), '# Synthetic UI test\nTwo independent leaves produce left.txt and right.txt.');
  const original = await readFile(path.join(source, 'docs', 'brief.md'), 'utf8');
  const starts = [];
  const barrier = new Promise(resolve => { release = resolve; });
  const executor = { schemaVersion: 1, id: 'deterministic-ui-fixture', version: '1', capabilities: ['code_edit'], async execute(input) {
    starts.push({ nodeId: input.node.id, workspaceRoot: input.workspaceRoot });
    await barrier;
    return new FileOperationsExecutor().execute({ ...input, node: { ...input.node, capabilities: ['file_operations'] },
      input: { schemaVersion: 1, operations: [{ type: 'write', path: input.node.writes[0], content: `${input.node.id}\n` }] } });
  } };
  const check = (id, kind, commandArgs) => ({ id, kind, command: process.execPath, args: commandArgs, timeoutMs: 10000 });
  const reviewConfig = { schemaVersion: 1, targetRef: 'main',
    validationProfiles: ['left', 'right'].map(id => ({ schemaVersion: 1, id: `${id}-acceptance`, checks: [
      check(`${id}-output`, 'test', ['-e', `const value=require('node:fs').readFileSync('${id}.txt','utf8');require('node:assert/strict').match(value,/^[A-Za-z0-9-]+-${id}\\n$/);`])
    ] })), regressionProfile: { schemaVersion: 1, id: 'fixture-regression', checks: [
      check('compile', 'compile', ['--check', 'seed.cjs']),
      check('tests', 'test', ['-e', "const a=require('node:assert/strict'),f=require('node:fs');a.equal(require('./seed.cjs'),'original');a.equal(f.readFileSync('seed.txt','utf8'),'original');for(const id of ['left','right'])if(f.existsSync(id+'.txt'))a.ok(f.readFileSync(id+'.txt','utf8').endsWith('-'+id+'\\n'));"])
    ] } };
  editor = await startEditor({ projectRoot: root, fwePath: args.get('--fwe'), port: 0, allowWrite: true, reviewConfig, workflow: {
    executor, planner: { async plan(input) {
      if (input.existingPlan) {
        const logical = input.feedback[0].logicalId;
        return { title: 'Interactive fixture', questions: [], plan: { ...input.existingPlan,
          nodes: input.existingPlan.nodes.map(node => node.id === logical ? { ...node, instruction: `${node.instruction} ${input.feedback[0].text}` } : node) } };
      }
      assert.equal(input.references[0].files.find(file => file.path.endsWith('brief.md')).text, original);
      return parsePlannerResponse({ title: 'Interactive fixture', questions: [], groups: [{ id: 'feature', title: 'Feature group', parentId: '' }], nodes: ['left', 'right'].map(id => ({
        id, title: `${id} leaf`, parentId: 'feature', instruction: `Create ${id}.txt`,
        outcome: `The requested ${id} content is available.`, dependencyReasons: [], derivedFrom: null, resources: [],
        dependsOn: [], reads: ['seed.txt'], writes: [`${id}.txt`], checks: [`${id}-output`], maxFiles: 1, maxDiffLines: 30
      })) }, { prefix: input.prefix, referenceInputs: input.references.map(item => item.binding) });
    } }
  } });
  browser = await chromium.launch({ executablePath: args.get('--browser'), headless: true });
  context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, recordVideo: { dir: path.join(output, 'video'), size: { width: 1512, height: 1050 } } });
  page = await context.newPage(); const errors = [];
  report.commandTypes = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/fwa/commands')) report.commandTypes.push(request.postDataJSON().type); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(editor.url); await expect(page.getByTestId('fwa-workflow-intake')).toBeVisible({ timeout: 30000 });
  await page.getByText('添加参考资料（可选）', { exact: true }).click();
  await page.getByLabel('选择文件夹', { exact: true }).setInputFiles(source);
  await expect(page.getByTestId('fwa-library-list').getByRole('checkbox')).toBeChecked({ timeout: 20000 });
  await expect(page.locator('[data-library-path="upload-fixture/docs/brief.md"]')).toHaveCount(1);
  pass('directory picker imports an in-project copy with hierarchy and selects the current version');
  await page.locator('summary').filter({ has: page.locator('[data-library-path="upload-fixture"]') }).press('Enter');
  await page.locator('summary').filter({ has: page.locator('[data-library-path="upload-fixture/docs"]') }).press('Enter');
  await page.locator('[data-library-path="upload-fixture/docs"]').click();
  await page.getByLabel('资料权限', { exact: true }).selectOption('deny');
  await page.getByRole('button', { name: '应用权限', exact: true }).click();
  await expect(page.getByText('有效权限：禁止读取', { exact: false })).toBeVisible();
  await page.locator('[data-library-path="upload-fixture/docs/brief.md"]').click();
  await page.getByLabel('资料权限', { exact: true }).selectOption('read');
  await page.getByRole('button', { name: '应用权限', exact: true }).click();
  await expect(page.getByText('Synthetic UI test', { exact: true })).toBeVisible();
  pass('child read permission overrides a denied parent and the UI previews the retained copy');
  const requirement = page.getByTestId('fwa-planning-form').getByRole('textbox');
  await expect(page.getByTestId('fwa-planning-form').getByText('新任务需求', { exact: true })).toBeVisible();
  await requirement.fill('Keep this requirement draft through refresh.');
  await page.getByTestId('fwa-refresh').click();
  await expect(requirement).toHaveValue('Keep this requirement draft through refresh.');
  await requirement.fill('');
  await page.getByRole('button', { name: '生成任务图', exact: true }).click();
  await expect(page.getByTestId('fwa-dag').locator('[data-node-id]')).toHaveCount(2, { timeout: 20000 });
  assert.equal((await application.getStatus()).runs.length, 0); pass('Plan uses supplied documents and does not dispatch any Run');
  await page.getByTestId('fwa-reference-drop').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('fwa-reference-drop')).toBeInViewport();
  await page.screenshot({ path: path.join(output, '01-library-plan.png'), fullPage: true }); report.screenshots.push('01-library-plan.png');
  await expect(page.getByTestId('fwa-dag')).toBeVisible();
  await expect(page.getByTestId('fwa-dag').locator('[data-node-id]')).toHaveCount(2);
  await expect(page.getByTestId('fwa-dag').locator('[data-edge-id]')).toHaveCount(0);
  pass('the same-screen DAG shows two real independent results without group nodes or containment arrows');
  await page.getByLabel('当前目标', { exact: true }).selectOption({ label: 'Interactive fixture' });
  await page.getByTestId('fwa-refresh').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, '02-result-dag.png'), fullPage: true }); report.screenshots.push('02-result-dag.png');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect.poll(() => starts.length, { timeout: 180000 }).toBe(2);
  await page.getByTestId('fwa-refresh').click();
  assert.equal(new Set(starts.map(item => item.workspaceRoot)).size, 2);
  const first = starts[0].nodeId;
  await page.getByRole('button', { name: '查看全图', exact: true }).click();
  await page.getByTestId('fwa-dag').locator(`[data-node-id=${JSON.stringify(first)}]`).click();
  await page.getByTestId('fwa-node-feedback').locator(':scope > summary').click();
  const supplement = page.getByTestId('fwa-node-feedback').getByRole('textbox');
  await expect(supplement).toHaveAccessibleName('节点修改建议');
  await expect(supplement).toBeVisible();
  await supplement.fill('Change this leaf in a new revision.');
  await expect(supplement).toHaveValue('Change this leaf in a new revision.');
  const feedbackControl = await supplement.elementHandle();
  await page.getByTestId('fwa-refresh').click();
  await expect(supplement).toHaveValue('Change this leaf in a new revision.');
  assert.equal(await feedbackControl.evaluate(control => control.isConnected), true, 'Refreshing facts must not detach the feedback editor.');
  await page.getByRole('button', { name: '暂存补充要求', exact: true }).click();
  await expect(page.getByText('待处理 · 尚未生效', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '按补充要求调整图', exact: true })).toBeDisabled();
  await page.getByText('待处理 · 尚未生效', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByText('待处理 · 尚未生效', { exact: true })).toBeInViewport();
  await page.screenshot({ path: path.join(output, '03-running-feedback.png'), fullPage: true }); report.screenshots.push('03-running-feedback.png');
  pass('two real worktrees overlap while node feedback stays pending and active revision is blocked');
  release();
  await expect.poll(async () => (await application.getStatus()).runs.filter(run => run.status === 'produced').length, { timeout: 180000 }).toBe(2);
  // Produced leaves precede the batch terminal event/lease release. Revision
  // must wait for the real project-wide operation fence, not a partial result.
  await expect.poll(async () => hasActiveProjectOperation(await application.getStatus()), { timeout: 180000 }).toBe(false);
  await expect.poll(async () => {
    const response = await fetch(`${editor.url}/api/fwa/workbench`); assert.equal(response.status, 200);
    return (await response.json()).jobs.every(job => !['queued', 'running'].includes(job.state));
  }, { timeout: 180000 }).toBe(true);
  const pending = await application.getStatus();
  assert.equal(pending.evaluations.length, 0); assert.equal(pending.integrations.length, 0);
  assert.ok(pending.nodes.every(node => node.status !== 'accepted'));
  pass('pending supplemental requirements preserve both produced candidates and block automatic validation or adoption');
  await page.getByTestId('fwa-refresh').click();
  await expect(page.getByRole('button', { name: '按补充要求调整图', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '按补充要求调整图', exact: true }).click();
  await expect.poll(async () => (await application.getStatus()).workflow.goals[0].revision, { timeout: 60000 }).toBe(2);
  await page.getByTestId('fwa-refresh').click();
  const final = await application.getStatus();
  assert.equal(final.runs.length, 2); assert.equal(final.nodes.length, 3);
  assert.equal(final.workflow.feedback[0].status, 'applied'); assert.equal(final.workflow.goals[0].phase, 'work');
  assert.equal(final.nodes.filter(node => node.supersededByRevision != null).length, 1);
  assert.equal(final.evaluations.length, 0); assert.equal(final.integrations.length, 0);
  assert.ok(final.runs.every(run => final.changeSets.some(change => change.runId === run.id)));
  assert.equal(await readFile(path.join(source, 'docs', 'brief.md'), 'utf8'), original);
  assert.equal(git(['status', '--porcelain']), '');
  await expect.poll(async () => {
    const response = await fetch(`${editor.url}/api/fwa/workbench`); assert.equal(response.status, 200);
    return (await response.json()).jobs.every(job => !['queued', 'running'].includes(job.state));
  }, { timeout: 180000 }).toBe(true);
  assert.equal((await application.verify()).ok, true);
  for (const type of ['workflow.plan', 'workflow.work', 'node.feedback', 'workflow.revise']) assert.ok(report.commandTypes.includes(type), `Expected real API command ${type}`);
  assert.ok(report.commandTypes.every(type => !['change.accept', 'change.integrate', 'change.finish'].includes(type)));
  pass('feedback revises only the affected leaf, preserves both old Runs/commits and never pretends unintegrated work is done');
  const revised = final.nodes.find(node => node.id.includes('@revision-2'));
  assert.ok(revised, 'Expected a new physical node revision');
  const revisedCard = page.getByTestId('fwa-dag').locator(`[data-node-id=${JSON.stringify(revised.id)}]`);
  await expect(revisedCard).toHaveCount(1, { timeout: 20000 });
  await revisedCard.click();
  const appliedFeedback = page.getByTestId('fwa-node-feedback').getByText(/^状态：applied · /);
  if (!(await appliedFeedback.isVisible())) await page.getByTestId('fwa-node-feedback').locator(':scope > summary').click();
  await expect(appliedFeedback).toBeVisible();
  await appliedFeedback.scrollIntoViewIfNeeded();
  await expect(appliedFeedback).toBeInViewport();
  await expect(page.getByText('待处理 · 尚未生效', { exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []); pass('no browser JavaScript errors');
  await page.screenshot({ path: path.join(output, '04-revised-history.png'), fullPage: true }); report.screenshots.push('04-revised-history.png');
  report.ok = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText()).catch(() => {});
  }
}
finally {
  release?.(); await context?.close(); await browser?.close(); await editor?.close();
  if (page?.video()) report.recording = path.relative(output, await page.video().path()).split(path.sep).join('/');
  const actual = realpathSync.native(root), relative = path.relative(parent, actual);
  assert.ok(actual === root && relative.startsWith(prefix) && !relative.includes(path.sep) && !(await lstat(root)).isSymbolicLink());
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.fixtureRemoved = true;
  await writeFile(path.join(output, 'interactive-workflow.json'), JSON.stringify(report, null, 2));
}
