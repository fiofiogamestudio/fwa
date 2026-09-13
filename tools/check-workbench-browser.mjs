import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startEditor } from '../src/editor/server.js';
import { FwaApplication } from '../src/application/fwa-application.js';

// Optional visual regression: uses an explicitly selected, installed browser and
// Playwright module. It does not install dependencies or submit project commands.
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!['--project', '--fwe', '--browser', '--playwright', '--output'].includes(key) || !process.argv[index + 1]) {
    throw new Error('Required: --project ROOT --fwe ROOT --browser EXE --playwright MODULE --output DIR');
  }
  args.set(key, path.resolve(process.argv[index + 1]));
}
for (const key of ['--project', '--fwe', '--browser', '--playwright', '--output']) if (!args.has(key)) throw new Error(`Missing ${key}`);
const output = args.get('--output');
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(args.get('--playwright')).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(args.get('--playwright')), 'test.mjs')).href);
const application = new FwaApplication(args.get('--project'));
const before = await application.getStatus();
const instance = await startEditor({ projectRoot: args.get('--project'), fwePath: args.get('--fwe'), allowWrite: true, port: 0 });
let browser, page;
const errors = [], checks = [];
const passed = name => { checks.push(name); console.log(`PASS ${name}`); };
const attr = (name, value) => `[${name}=${JSON.stringify(value)}]`;
try {
  browser = await chromium.launch({ executablePath: args.get('--browser'), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); });
  await page.goto(instance.url);
  await expect(page.getByTestId('fwa-status')).toContainText('已连接');
  await expect(page.getByTestId('fwa-dag')).toBeVisible();
  await expect(page.getByTestId('fwa-dag').locator('[data-node-id]')).toHaveCount(before.nodes.length);
  await expect(page.getByTestId('fwa-dag').locator('[data-edge-id]')).toHaveCount(before.nodes.reduce((count, node) => count + node.dependsOn.length, 0));
  await page.screenshot({ path: path.join(output, '01-dag.png'), fullPage: true });
  passed('real DAG node/edge counts and initial rendering');
  const dependent = before.nodes.find(node => node.dependsOn.length) || before.nodes[0];
  if (dependent) {
    await page.getByTestId('fwa-dag').locator(attr('data-node-id', dependent.id)).click();
    await expect(page.getByTestId('fwa-inspector').getByRole('heading', { name: dependent.title, exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(output, '02-node-detail.png'), fullPage: true });
    passed('DAG selection updates the real Node inspector');
  }
  await page.locator('[data-section="refs"]').click();
  await expect(page.getByTestId('fwa-content').locator('[data-object-id]')).toHaveCount(before.refs.length);
  const imageRef = before.refs.find(ref => /\.png$/i.test(ref.uri));
  if (imageRef) {
    await page.getByTestId('fwa-content').locator(attr('data-object-id', imageRef.id)).click();
    const image = page.getByTestId('fwa-ref-preview').locator('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
    await expect(image).toHaveAttribute('src', /[?&]hash=[a-f0-9]{64}/);
    await page.screenshot({ path: path.join(output, '03-reference-image.png'), fullPage: true });
    passed('registered PNG preview loads with digest-bound URL');
  }
  const svgRef = before.refs.find(ref => /\.svg$/i.test(ref.uri));
  if (svgRef) {
    await page.getByTestId('fwa-content').locator(attr('data-object-id', svgRef.id)).click();
    const image = page.getByTestId('fwa-ref-preview').locator('img');
    await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(output, '04-reference-interaction.png'), fullPage: true });
    passed('registered SVG interaction preview renders as isolated image');
  }
  const textRef = before.refs.find(ref => /\.md$/i.test(ref.uri));
  if (textRef) {
    await page.getByTestId('fwa-content').locator(attr('data-object-id', textRef.id)).click();
    await expect(page.getByTestId('fwa-ref-preview').locator('.fwa-document')).toBeVisible();
    passed('registered Markdown is readable without active HTML');
  }
  await page.getByRole('button', { name: '关系图', exact: true }).click();
  await expect(page.getByTestId('fwa-refs-graph')).toBeVisible();
  const logicalEdges = before.nodes.reduce((count, node) => count + ['reads', 'writes'].reduce((sum, key) => sum + node[key].filter(id => before.refs.some(ref => ref.id === id)).length, 0), 0);
  await expect(page.getByTestId('fwa-refs-graph').locator('[data-edge-id]')).toHaveCount(logicalEdges);
  if (textRef) await expect(page.getByTestId('fwa-ref-preview').locator('.fwa-document')).toBeVisible();
  await page.screenshot({ path: path.join(output, '05-reference-graph.png'), fullPage: true });
  passed('Refs graph contains declared logical links, not invented knowledge edges');
  if (before.runs.length) {
    await page.locator('[data-section="runs"]').click();
    await expect(page.getByTestId('fwa-content').locator('[data-object-id]')).toHaveCount(before.runs.length);
    const failedRun = before.runs.find(run => run.failure);
    if (failedRun) {
      await page.getByTestId('fwa-content').locator(attr('data-object-id', failedRun.id)).click();
      await expect(page.getByTestId('fwa-inspector')).toContainText(failedRun.failure.message);
    }
    const executedChange = before.changeSets.find(change => change.executionArtifact);
    if (executedChange) {
      await page.getByTestId('fwa-content').locator(attr('data-object-id', executedChange.runId)).click();
      await page.getByTestId('fwa-inspector').getByRole('button', { name: /^executionArtifact ·/ }).click();
      await expect(page.getByTestId('fwa-artifact-text')).toBeVisible();
      const artifact = await (await fetch(`${instance.url}/api/fwa/artifacts?digest=${executedChange.executionArtifact.digest}`)).json();
      const parsed = JSON.parse(artifact.text);
      const stderr = parsed.process?.stderr || parsed.result?.process?.stderr;
      if (stderr) await expect(page.getByTestId('fwa-inspector').getByTestId('fwa-error-output')).toHaveText(stderr);
      await page.screenshot({ path: path.join(output, '09-run-output.png'), fullPage: true });
    }
    passed('all Run attempts remain available with their own failure and execution output');
  }
  const evidence = before.evidence.find(item => item.result === 'fail') || before.evidence[0];
  if (evidence) {
    await page.locator('[data-section="evidence"]').click();
    await page.getByTestId('fwa-content').locator(attr('data-object-id', evidence.id)).click();
    await expect(page.getByTestId('fwa-criteria').locator('[role=row][data-criterion]')).toHaveCount(evidence.criteria.length);
    const failed = evidence.criteria.find(item => item.result === 'fail' && item.stderrArtifact);
    if (failed) {
      await page.getByTestId('fwa-criteria').locator(attr('data-criterion', failed.id)).getByRole('button', { name: '错误', exact: true }).click();
      await expect(page.getByTestId('fwa-artifact-text')).toBeVisible();
    }
    await page.screenshot({ path: path.join(output, '06-evidence.png'), fullPage: true });
    passed('acceptance matrix and linked immutable failure output');
  }
  if (before.changeSets.length) {
    await page.locator('[data-section="changeSets"]').click();
    const patch = before.changeSets.find(item => item.patchArtifact?.size > 0) || before.changeSets.at(-1);
    await page.getByTestId('fwa-content').locator(attr('data-object-id', patch.id)).click();
    if (patch.patchArtifact?.size > 0) await expect(page.getByTestId('fwa-diff')).toBeVisible();
    else await expect(page.getByTestId('fwa-inspector')).toContainText('没有文件变化');
    passed('ChangeSet diff or explicit zero-file result');
  }
  await page.locator('[data-section="events"]').click();
  await expect(page.getByTestId('fwa-events').locator(':scope > [role=listitem]')).toHaveCount(Math.min(before.eventCount, 100));
  await page.screenshot({ path: path.join(output, '07-events.png'), fullPage: true });
  passed('durable event timeline, not a current-status reconstruction');
  await page.locator('[data-section="commands"]').click();
  const goalForm = page.getByTestId('fwa-goal.create');
  await goalForm.getByLabel('目标名称', { exact: true }).fill('UNSUBMITTED browser regression draft');
  await goalForm.getByLabel('具体请求', { exact: true }).fill('Do not execute this draft.');
  await page.getByTestId('fwa-refresh').click();
  await expect(goalForm.getByLabel('目标名称', { exact: true })).toHaveValue('UNSUBMITTED browser regression draft');
  await page.locator('[data-section="nodes"]').click();
  await page.locator('[data-section="commands"]').click();
  await expect(goalForm.getByLabel('目标名称', { exact: true })).toHaveValue('UNSUBMITTED browser regression draft');
  passed('refresh and navigation preserve unsubmitted form drafts');
  await page.setViewportSize({ width: 960, height: 1000 });
  await page.locator('[data-section="nodes"]').click();
  await expect(page.getByTestId('fwa-dag')).toBeVisible();
  assert.equal(await page.getByTestId('fwa-console').evaluate(node => node.scrollWidth <= node.clientWidth + 2), true);
  await page.screenshot({ path: path.join(output, '08-narrow.png'), fullPage: true });
  passed('narrow workbench retains graph and has no local horizontal overflow');
  assert.deepEqual(errors, []);
  assert.deepEqual(await application.getStatus(), before, 'Visual inspection must not change project state.');
  passed('no page exceptions and no project-state changes');
  await writeFile(path.join(output, 'summary.json'), JSON.stringify({ ok: true, projectId: before.projectId, checks, errors }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, 'summary.json'), JSON.stringify({ ok: false, checks, errors, error: error.stack }, null, 2));
  throw error;
} finally {
  await browser?.close(); await instance.close();
}
