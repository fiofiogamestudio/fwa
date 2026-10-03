import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { FileOperationsExecutor, FILE_OPERATIONS_CAPABILITY } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import { startEditor } from '../src/editor/server.js';

// Positive browser integration against a newly owned OS-temp Git repository.
// Only fixture setup and intentional external-update checks call the application.
// Browser actions use real clicks; evaluate() only observes rendered DOM state.
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!['--fwe', '--browser', '--playwright', '--output'].includes(key) || !process.argv[index + 1]) {
    throw new Error('Required: --fwe ROOT --browser EXE --playwright MODULE --output DIR');
  }
  args.set(key, path.resolve(process.argv[index + 1]));
}
for (const key of ['--fwe', '--browser', '--playwright', '--output']) if (!args.has(key)) throw new Error(`Missing ${key}`);
const output = args.get('--output');
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(args.get('--playwright')).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(args.get('--playwright')), 'test.mjs')).href);
const temporaryParent = realpathSync.native(tmpdir());
const prefix = 'fwa-workbench-fixture-';
const root = realpathSync.native(await mkdtemp(path.join(temporaryParent, prefix)));
const report = { ok: false, fixtureRoot: root, fixtureRemoved: false, checks: [], errors: [] };
let browser, page, instance;
const passed = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const attr = (name, value) => `[${name}=${JSON.stringify(value)}]`;
function git(command) {
  const result = spawnSync('git', command, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
async function removeOwnedFixture() {
  const actual = realpathSync.native(root);
  const relative = path.relative(temporaryParent, actual);
  assert.equal(actual, root, 'Fixture identity must remain unchanged before deletion.');
  assert.ok(relative.startsWith(prefix) && !relative.includes(path.sep) && !path.isAbsolute(relative), 'Delete only the exact mkdtemp child.');
  assert.equal((await lstat(root)).isSymbolicLink(), false);
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.fixtureRemoved = true;
}
try {
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'FWA Browser Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  await mkdir(path.join(root, 'empty-hooks'));
  git(['config', 'core.hooksPath', path.join(root, 'empty-hooks')]);
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n/empty-hooks/\n');
  await writeFile(path.join(root, 'seed.txt'), 'ORIGINAL_LINE_TO_REMOVE\nkeep this context\n');
  await writeFile(path.join(root, 'obsolete.txt'), 'OBSOLETE_FILE_CONTENT\n');
  git(['add', '--', '.gitignore', 'seed.txt', 'obsolete.txt']);
  git(['commit', '-m', 'test: isolated browser fixture baseline']);
  const baseline = git(['rev-parse', 'HEAD']);
  const application = new FwaApplication(root);
  await application.init();
  const { goal } = await application.createGoal({ title: 'Nonempty change and evidence fixture', commandId: 'fixture-goal' });
  const node = (id, title, dependsOn, writes) => ({ id, title, dependsOn, reads: ['seed.txt'], writes,
    capabilities: [FILE_OPERATIONS_CAPABILITY], acceptance: { checks: ['fixture-content'] },
    budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 } });
  await application.loadPlan({ goalId: goal.id, commandId: 'fixture-plan', plan: { schemaVersion: 1, nodes: [
    node('prepare', 'Prepare candidate / 真实变更', [], ['seed.txt', 'result.txt', 'obsolete.txt']),
    node('code', 'Code branch / 分叉 A', ['prepare'], ['code.txt']),
    node('art', 'Art branch / 分叉 B', ['prepare'], ['art.txt']),
    node('join', 'Integration join / 双前驱汇合', ['code', 'art'], ['joined.txt'])
  ] } });
  const workspace = new GitWorktreeAdapter(root);
  const produced = await application.runNext({ nodeId: 'prepare', commandId: 'fixture-run', workspace,
    executor: new FileOperationsExecutor(), input: { schemaVersion: 1, operations: [
      { type: 'write', path: 'seed.txt', content: 'VERIFIED_LINE_ADDED\nkeep this context\n' },
      { type: 'write', path: 'result.txt', content: 'candidate result from real executor\n' },
      { type: 'delete', path: 'obsolete.txt' }
    ] } });
  assert.equal(produced.ok, true, JSON.stringify(produced));
  await application.evaluateChangeSet({ changeSetId: produced.changeSet.id, commandId: 'fixture-evaluate', workspace,
    evaluator: new CommandEvaluator(), profile: { schemaVersion: 1, id: 'fixture-verification', checks: [{
      id: 'fixture-content', kind: 'test', command: process.execPath, timeoutMs: 10000, expectedExitCodes: [0],
      args: ['-e', 'const fs=require("node:fs"),assert=require("node:assert/strict");assert.equal(fs.readFileSync("seed.txt","utf8"),"VERIFIED_LINE_ADDED\\nkeep this context\\n");assert.equal(fs.readFileSync("result.txt","utf8"),"candidate result from real executor\\n");assert.equal(fs.existsSync("obsolete.txt"),false);console.log("FIXTURE_PATCH_VERIFIED");']
    }] } });
  let expected = await application.getStatus();
  const change = expected.changeSets.find(item => item.id === produced.changeSet.id);
  const run = expected.runs.find(item => item.id === change.runId);
  const evidence = expected.evidence.find(item => item.changeSetId === change.id);
  assert.equal(change.changedFiles.length, 3);
  assert.ok(change.patchArtifact.size > 0);
  assert.equal(evidence.result, 'pass');
  assert.equal(expected.nodes.find(item => item.id === 'prepare').status, 'accepted');
  assert.equal(expected.integrations.length, 0, 'This test does not integrate the candidate.');
  assert.equal(await readFile(path.join(root, 'seed.txt'), 'utf8'), 'ORIGINAL_LINE_TO_REMOVE\nkeep this context\n');
  const artifactPath = reference => path.join(root, '.fwa', 'artifacts', 'sha256', reference.digest.slice(0, 2), reference.digest);
  const patch = await readFile(artifactPath(change.patchArtifact), 'utf8');
  assert.match(patch, /^-ORIGINAL_LINE_TO_REMOVE$/m);
  assert.match(patch, /^\+VERIFIED_LINE_ADDED$/m);
  assert.match(patch, /^-OBSOLETE_FILE_CONTENT$/m);
  await writeFile(path.join(output, 'candidate.patch'), patch);
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(output, 'evaluation-stdout.txt'), await readFile(artifactPath(evidence.criteria[0].stdoutArtifact)));
  passed('real Git worktree execution captures 3 changed files; real command evaluator passes; host remains unintegrated');

  // Durable commands, not hand-authored events: ensure the timeline has >1 page.
  for (let index = 0; index < 105; index += 1) {
    await application.createGoal({ title: `Pagination fixture ${String(index + 1).padStart(3, '0')}`, commandId: `pagination-goal-${index}` });
  }
  expected = await application.getStatus();
  assert.ok(expected.eventCount > 100);
  instance = await startEditor({ projectRoot: root, fwePath: args.get('--fwe'), port: 0 });
  browser = await chromium.launch({ executablePath: args.get('--browser'), headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1150 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error') report.errors.push(event.text()); });
  await page.goto(instance.url);
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  await expect(page.getByText('只读预览', { exact: true })).toBeVisible();
  const graph = page.getByTestId('fwa-dag');
  await expect(graph.locator('[data-node-id]')).toHaveCount(4);
  await expect(graph.locator('[data-edge-id]')).toHaveCount(4);
  await writeFile(path.join(output, 'initial-dom.txt'), await page.getByTestId('fwa-console').ariaSnapshot());
  const positions = await graph.locator('[data-node-id]').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.nodeId, left: parseFloat(node.style.left), top: parseFloat(node.style.top) })));
  const left = id => positions.find(node => node.id === id).left;
  assert.ok(left('prepare') < left('code') && left('prepare') < left('art'));
  assert.ok(left('join') > left('code') && left('join') > left('art'));
  await graph.locator('[data-node-id="join"]').click();
  await expect(page.getByTestId('fwa-inspector').getByRole('heading', { name: 'Integration join / 双前驱汇合', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, '01-dag-join.png'), fullPage: true });
  passed('actual workbench renders the four-edge diamond; join follows both predecessors and selects its inspector');

  await expect.poll(() => page.evaluate(() => window.fwe.navigation.current().fileName)).toBe('objects/nodes/join.json');
  await page.getByTestId('fwa-inspector').locator('summary').filter({ hasText: /^对象链接$/ }).click();
  const selfLink = page.getByTestId('fwa-inspector').getByRole('link', { name: '单独打开此记录', exact: true });
  await expect(selfLink).toBeVisible();
  const [objectPage] = await Promise.all([page.waitForEvent('popup'), selfLink.click()]);
  await expect(objectPage.getByTestId('fwa-inspector').getByRole('heading', { name: 'Integration join / 双前驱汇合', exact: true })).toBeVisible();
  await objectPage.reload();
  await expect(objectPage.getByTestId('fwa-inspector').getByRole('heading', { name: 'Integration join / 双前驱汇合', exact: true })).toBeVisible();
  assert.equal(await objectPage.evaluate(() => window.fwe.resources.current().file.name), 'objects/nodes/join.json');
  await objectPage.close();
  passed('native FWE resource selection, new-tab links and reload all restore the same Node');

  await graph.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const viewport = await graph.locator('.fg-viewport').boundingBox();
  assert.ok(viewport);
  await page.mouse.move(viewport.x + 12, viewport.y + 12);
  await page.mouse.down();
  await page.mouse.move(viewport.x + 47, viewport.y + 35, { steps: 4 });
  await page.mouse.up();
  const transform = await graph.locator('.fg-world').evaluate(node => node.style.transform);
  await application.createGoal({ title: 'External refresh while inspecting graph', commandId: 'graph-refresh' });
  expected = await application.getStatus();
  const refreshedStatus = page.waitForResponse(response => response.url().includes('/api/fwa/status?view=summary') && response.ok());
  await page.getByTestId('fwa-refresh').click();
  assert.equal((await (await refreshedStatus).json()).lastSequence, expected.lastSequence);
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  await expect(graph.locator('[data-node-id="join"]')).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await graph.locator('.fg-world').evaluate(node => node.style.transform), transform);
  passed('real external event update preserves graph selection and manually adjusted pan/zoom');

  async function openRun() {
    const back = page.getByTestId('fwa-inspector').getByRole('button', { name: '← 返回任务节点', exact: true });
    if (await back.isVisible()) await back.click();
    const prepare = graph.locator('[data-node-id="prepare"]');
    if (!await prepare.count()) await page.getByRole('button', { name: '查看全图', exact: true }).click();
    await prepare.click();
    const technical = page.getByTestId('fwa-node-detail').locator('[data-fwa-node-technical]');
    if (!await technical.evaluate(element => element.open)) await technical.locator(':scope > summary').click();
    const runPath = encodeURIComponent(`objects/runs/${encodeURIComponent(run.id)}.json`);
    const link = technical.locator(`a.fwe-resource-link[href*=${JSON.stringify(runPath)}]`);
    await expect(link).toHaveCount(1); await link.click();
    await expect.poll(() => page.evaluate(() => window.fwe.navigation.current().fileName)).toBe(`objects/runs/${encodeURIComponent(run.id)}.json`);
  }
  await openRun();
  await expect(page.getByTestId('fwa-inspector')).toContainText('file-operations');
  await page.getByTestId('fwa-inspector').getByRole('link', { name: `3 个文件 · ${change.id.slice(0, 12)}`, exact: true }).click();
  await page.getByTestId('fwa-candidate-diff').locator(':scope > summary').click();
  const diff = page.getByTestId('fwa-diff');
  await expect(diff).toBeVisible();
  assert.equal(await diff.textContent(), patch.endsWith('\n') ? patch + '\n' : patch);
  await expect(diff.locator('.fwa-diff-add').filter({ hasText: '+VERIFIED_LINE_ADDED' })).toHaveCount(1);
  await expect(diff.locator('.fwa-diff-remove').filter({ hasText: '-ORIGINAL_LINE_TO_REMOVE' })).toHaveCount(1);
  await expect(diff.locator('.fwa-diff-remove').filter({ hasText: '-OBSOLETE_FILE_CONTENT' })).toHaveCount(1);
  await expect(page.getByTestId('fwa-inspector')).toContainText(change.id);
  await page.screenshot({ path: path.join(output, '02-nonempty-diff.png'), fullPage: true });
  await diff.locator('.fwa-diff-add').filter({ hasText: '+VERIFIED_LINE_ADDED' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, '02b-patch-added-removed-lines.png'), fullPage: true });
  await writeFile(path.join(output, 'diff-dom.txt'), await page.getByTestId('fwa-inspector').ariaSnapshot());
  passed('Run links to its exact ChangeSet; browser displays real added/deleted lines and the complete immutable patch');

  await openRun();
  await page.getByTestId('fwa-inspector').getByRole('link', { name: `通过 · ${evidence.kind}`, exact: true }).click();
  const criterion = page.getByTestId('fwa-criteria').locator('[data-criterion="fixture-content"]');
  await expect(criterion).toContainText('通过');
  await criterion.getByRole('button', { name: '输出', exact: true }).click();
  await expect(page.getByTestId('fwa-artifact-text')).toContainText('FIXTURE_PATCH_VERIFIED');
  await page.screenshot({ path: path.join(output, '03-evidence-output.png'), fullPage: true });
  await page.getByTestId('fwa-inspector').getByRole('link', { name: '定位变更集', exact: true }).click();
  const returnedDiff = page.getByTestId('fwa-candidate-diff');
  if (!await returnedDiff.evaluate(element => element.open)) await returnedDiff.locator(':scope > summary').click();
  await expect(page.getByTestId('fwa-diff')).toContainText('+VERIFIED_LINE_ADDED');
  passed('Run links to its actual passing Evidence; output log loads; Evidence returns to the same ChangeSet');

  // The single-page workbench no longer has an event tab. Keep the durable
  // pagination contract through its real HTTP query without inventing a UI route.
  async function eventPage(after = 0) {
    const response = await page.request.get(`${instance.url}/api/fwa/events?after=${after}&limit=100`);
    assert.equal(response.status(), 200); return response.json();
  }
  const firstEvents = await eventPage(); assert.equal(firstEvents.events.length, 100); assert.equal(firstEvents.hasMore, true);
  const nextEvents = await eventPage(firstEvents.nextSequence);
  let sequences = [...firstEvents.events, ...nextEvents.events].map(event => event.sequence);
  assert.equal(new Set(sequences).size, expected.eventCount);
  assert.deepEqual(sequences, (await application.listEvents()).map(event => event.sequence));
  await application.createGoal({ title: 'Timeline appended after second page', commandId: 'timeline-refresh' });
  expected = await application.getStatus();
  const appendedEvents = await eventPage(nextEvents.nextSequence);
  sequences.push(...appendedEvents.events.map(event => event.sequence));
  assert.deepEqual(sequences, (await application.listEvents()).map(event => event.sequence));
  await writeFile(path.join(output, '04-events-http.json'), JSON.stringify({ firstEvents, nextEvents, appendedEvents }, null, 2));
  passed('HTTP event query loads two durable pages and appends a real new event without duplicates; retired event-tab UI is not asserted');

  assert.deepEqual(report.errors, []);
  assert.deepEqual(await application.getStatus(), expected, 'Browser inspection must not mutate FWA project state.');
  assert.equal(git(['rev-parse', 'HEAD']), baseline);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(await readFile(path.join(root, 'seed.txt'), 'utf8'), 'ORIGINAL_LINE_TO_REMOVE\nkeep this context\n');
  passed('zero browser exceptions, read-only inspection, unchanged host baseline and clean fixture Git checkout');
  report.ok = true;
  report.projectId = expected.projectId;
  report.changeSetId = change.id;
  report.evidenceId = evidence.id;
  report.patchBytes = change.patchArtifact.size;
  report.changedFiles = change.changedFiles;
  report.eventCount = expected.eventCount;
  await writeFile(path.join(output, 'final-status.json'), JSON.stringify(expected, null, 2));
} catch (error) {
  report.error = error.stack;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await instance?.close();
  // Keep a failing fixture for diagnosis; remove only our verified exact temp root on success.
  if (report.ok) await removeOwnedFixture();
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
