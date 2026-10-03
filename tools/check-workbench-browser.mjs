import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startEditor } from '../src/editor/server.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { objectResourceName } from '../src/editor/object-resources.js';

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
async function openObject(type, id) {
  // Follow the URL emitted by the native navigation contract, including its
  // encoded resource identity. Removed section tabs are not recreated here.
  const href = await page.evaluate(({ type, id }) => window.FwaNavigation.href(type, id), { type, id });
  await page.goto(href);
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.fwe.navigation.current().fileName)).toBe(objectResourceName(type, id));
}
async function showAllNodes() {
  await page.getByLabel('当前目标', { exact: true }).selectOption('');
  const full = page.getByRole('button', { name: '查看全图', exact: true });
  if (await full.count()) await full.click();
}
try {
  browser = await chromium.launch({ executablePath: args.get('--browser'), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); });
  await page.goto(instance.url);
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  await showAllNodes();
  await expect(page.getByTestId('fwa-dag')).toBeVisible();
  const activeNodes = before.nodes.filter(node => node.supersededByRevision == null);
  const activeIds = new Set(activeNodes.map(node => node.id));
  await expect(page.getByTestId('fwa-dag').locator('[data-node-id]')).toHaveCount(activeNodes.length);
  await expect(page.getByTestId('fwa-dag').locator('[data-edge-id]')).toHaveCount(activeNodes.reduce((count, node) => count + new Set(node.dependsOn.filter(id => activeIds.has(id))).size, 0));
  await page.screenshot({ path: path.join(output, '01-dag.png'), fullPage: true });
  passed('real DAG node/edge counts and initial rendering');
  const dependent = activeNodes.find(node => node.dependsOn.length) || activeNodes[0];
  if (dependent) {
    await page.getByTestId('fwa-dag').locator(attr('data-node-id', dependent.id)).click();
    await expect(page.getByTestId('fwa-node-detail').getByRole('heading', { name: dependent.outcome?.trim() || dependent.title, exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(output, '02-node-detail.png'), fullPage: true });
    passed('DAG selection updates the real Node inspector');
  }
  const imageRef = before.refs.find(ref => /\.png$/i.test(ref.uri));
  if (imageRef) {
    await openObject('refs', imageRef.id);
    const image = page.getByTestId('fwa-ref-preview').locator('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
    await expect(image).toHaveAttribute('src', /[?&]hash=[a-f0-9]{64}/);
    await page.screenshot({ path: path.join(output, '03-reference-image.png'), fullPage: true });
    passed('registered PNG preview loads with digest-bound URL');
  }
  const svgRef = before.refs.find(ref => /\.svg$/i.test(ref.uri));
  if (svgRef) {
    await openObject('refs', svgRef.id);
    const image = page.getByTestId('fwa-ref-preview').locator('img');
    await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(output, '04-reference-interaction.png'), fullPage: true });
    passed('registered SVG interaction preview renders as isolated image');
  }
  const textRef = before.refs.find(ref => /\.md$/i.test(ref.uri));
  if (textRef) {
    await openObject('refs', textRef.id);
    await expect(page.getByTestId('fwa-ref-preview').locator('.fwa-document')).toBeVisible();
    passed('registered Markdown is readable without active HTML');
  }
  const relationRef = textRef || before.refs[0];
  if (relationRef) {
    await openObject('refs', relationRef.id);
    for (const node of before.nodes) {
      const count = ['reads', 'writes'].filter(key => node[key]?.includes(relationRef.id)).length;
      const resource = encodeURIComponent(objectResourceName('nodes', node.id));
      await expect(page.getByTestId('fwa-inspector').locator(`a.fwe-resource-link[href*=${JSON.stringify(resource)}]`)).toHaveCount(count);
    }
    await page.screenshot({ path: path.join(output, '05-reference-relations.png'), fullPage: true });
    passed('native Ref detail exposes exactly its declared consumer and writer links');
  }
  if (before.runs.length) {
    for (const run of before.runs) {
      await openObject('runs', run.id);
      await expect(page.getByTestId('fwa-inspector')).toContainText(run.id);
    }
    const failedRun = before.runs.find(run => run.failure);
    if (failedRun) {
      await openObject('runs', failedRun.id);
      await expect(page.getByTestId('fwa-inspector')).toContainText(failedRun.failure.message);
    }
    const executedChange = before.changeSets.find(change => change.executionArtifact);
    if (executedChange) {
      await openObject('runs', executedChange.runId);
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
    await openObject('evidence', evidence.id);
    await expect(page.getByTestId('fwa-criteria').locator('[role=row][data-criterion]')).toHaveCount(evidence.criteria.length);
    const failed = evidence.criteria.find(item => item.result === 'fail' && item.stderrArtifact);
    if (failed) {
      await page.getByTestId('fwa-criteria').locator(attr('data-criterion', failed.id)).getByRole('button', { name: '错误', exact: true }).click();
      await expect(page.getByTestId('fwa-artifact-text')).toBeVisible();
    }
    await page.screenshot({ path: path.join(output, '06-evidence.png'), fullPage: true });
    passed(failed ? 'acceptance matrix and linked immutable failure output' : 'acceptance matrix matches the recorded Evidence criteria');
  }
  if (before.changeSets.length) {
    const patch = before.changeSets.find(item => item.patchArtifact?.size > 0) || before.changeSets.at(-1);
    await openObject('changeSets', patch.id);
    if (patch.patchArtifact?.size > 0) {
      await page.getByTestId('fwa-candidate-diff').locator(':scope > summary').click();
      await expect(page.getByTestId('fwa-diff')).toBeVisible();
    }
    else await expect(page.getByTestId('fwa-inspector')).toContainText('没有文件变化');
    passed('ChangeSet diff or explicit zero-file result');
  }
  const eventResponse = await page.request.get(`${instance.url}/api/fwa/events?after=0&limit=100`);
  assert.equal(eventResponse.status(), 200);
  const events = await eventResponse.json();
  assert.deepEqual(events.events, (await application.listEvents()).slice(0, 100));
  await writeFile(path.join(output, '07-events-http.json'), JSON.stringify(events, null, 2));
  passed('real HTTP query returns durable events; retired event-tab UI is not asserted');
  const intake = page.getByTestId('fwa-console').locator('details').filter({ has: page.getByTestId('fwa-workflow-intake') });
  if (!await intake.evaluate(element => element.open)) await intake.locator(':scope > summary').click();
  const requestInput = page.getByLabel('需求描述', { exact: true });
  const draft = 'UNSUBMITTED browser regression draft. Do not execute.';
  await requestInput.fill(draft);
  await page.getByTestId('fwa-refresh').click();
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  await expect(requestInput).toHaveValue(draft);
  await showAllNodes();
  if (dependent) await page.getByTestId('fwa-dag').locator(attr('data-node-id', dependent.id)).click();
  await expect(requestInput).toHaveValue(draft);
  passed('refresh and navigation preserve unsubmitted form drafts');
  await page.setViewportSize({ width: 960, height: 1000 });
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
