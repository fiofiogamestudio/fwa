import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { objectResourceName } from '../src/editor/object-resources.js';
import { startEditor } from '../src/editor/server.js';

// Real FWE UI, native resource navigation and Git-backed FWA state. No planner or
// executor is configured. The only writable browser controls used are local drafts.
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!['--fwe', '--browser', '--playwright', '--output'].includes(key) || !process.argv[index + 1] || args.has(key)) {
    throw new Error('Required: --fwe ROOT --browser EXE --playwright MODULE --output DIR');
  }
  args.set(key, path.resolve(process.argv[index + 1]));
}
for (const key of ['--fwe', '--browser', '--playwright', '--output']) assert.ok(args.has(key), `Missing ${key}`);
const output = args.get('--output'); await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(args.get('--playwright')).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(args.get('--playwright')), 'test.mjs')).href);
const temporaryParent = realpathSync.native(tmpdir()), prefix = 'fwa-navigation-fixture-';
const root = realpathSync.native(await mkdtemp(path.join(temporaryParent, prefix)));
const report = { ok: false, fixtureRoot: root, fixtureRemoved: false, checks: [], screenshots: [], errors: [],
  boundary: 'Real installed Chromium browser/FWE/Git; no AI adapter, game execution, integration or submitted browser draft.' };
const passed = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const git = command => {
  const result = spawnSync('git', command, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout.trim();
};
let editor, readOnlyEditor, browser, context, page;
async function capture(name, target = page) {
  await target.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  await writeFile(path.join(output, `${name}.dom.txt`), await target.getByTestId('fwa-console').ariaSnapshot());
  report.screenshots.push(`${name}.png`);
}
async function nativeResource(target, fileName) {
  await expect.poll(() => target.evaluate(() => window.fwe.navigation.current().fileName)).toBe(fileName);
  await expect.poll(() => target.evaluate(() => window.fwe.resources.current().file.name)).toBe(fileName);
}
async function clickOne(locator) { await expect(locator).toHaveCount(1); await locator.click(); }
async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}
async function removeOwnedFixture() {
  const actual = realpathSync.native(root), relative = path.relative(temporaryParent, actual);
  assert.equal(actual, root);
  assert.ok(relative.startsWith(prefix) && !relative.includes(path.sep) && !path.isAbsolute(relative));
  assert.equal((await lstat(root)).isSymbolicLink(), false);
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.fixtureRemoved = true;
}
try {
  git(['init', '-b', 'main']); git(['config', 'user.name', 'FWA Navigation Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  await mkdir(path.join(root, 'empty-hooks')); git(['config', 'core.hooksPath', path.join(root, 'empty-hooks')]);
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n/empty-hooks/\n');
  const referenceText = '# Shared design reference\nAlpha and Beta read the same retained source.\n';
  await writeFile(path.join(root, 'docs', 'shared.md'), referenceText);
  git(['add', '--', '.gitignore', 'docs/shared.md']); git(['commit', '-m', 'test: navigation fixture baseline']);
  const baseline = git(['rev-parse', 'HEAD']);
  const application = new FwaApplication(root); await application.init();
  const refId = 'ref://document/docs/shared.md';
  await application.registerRef({ commandId: 'shared-reference', ref: { id: refId, kind: 'document', uri: 'docs/shared.md', version: '1',
    hash: `sha256:${createHash('sha256').update(referenceText).digest('hex')}`, metadata: {} } });
  const goals = [];
  for (const [suffix, title] of [['alpha', 'Alpha'], ['beta', 'Beta']]) {
    const goal = (await application.createGoal({ title: `${title} goal`, commandId: `goal-${suffix}` })).goal;
    await application.loadPlan({ goalId: goal.id, commandId: `plan-${suffix}`, plan: { schemaVersion: 1,
      groups: [{ id: 'shared-group', title: `${title} group` }],
      nodes: [{ id: `${suffix}-reader`, title: `${title} reader`, parentId: 'shared-group', dependsOn: [], reads: [refId], writes: [`${suffix}.txt`],
        capabilities: ['file_operations'], acceptance: { checks: [`${suffix}-check`] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 } }]
    } }); goals.push(goal);
  }
  const expected = await application.getStatus();
  editor = await startEditor({ projectRoot: root, fwePath: args.get('--fwe'), port: 0, allowWrite: true, workflow: { planner: null, executor: null } });
  report.fingerprint = editor.fingerprint; report.projectId = expected.projectId; report.goals = goals.map(goal => goal.id);
  browser = await chromium.launch({ executablePath: args.get('--browser'), headless: true });
  context = await browser.newContext({ viewport: { width: 1512, height: 1080 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    // Test-only observation: delegate every original action unchanged. No app
    // state is patched and no waits are introduced into event handling.
    window.__fwaNavigationProbe = [];
    const describe = element => element ? { tag: element.tagName, name: element.name,
      value: element.value, connected: element.isConnected } : null;
    const record = value => window.__fwaNavigationProbe.push({ ...value, time: performance.now(), active: describe(document.activeElement) });
    for (const type of ['focusin', 'focusout', 'input']) document.addEventListener(type, event => {
      if (event.target.closest?.('[data-testid="fwa-console"]')) record({ event: type, target: describe(event.target) });
    }, true);
    let configured;
    Object.defineProperty(window, 'createFweSurface', { configurable: true, get: () => configured, set(factory) {
      configured = function (config, bindings = {}) {
        const name = config.templates?.inspector && config.templates?.emptySelection ? 'console' : config.id || 'other';
        record({ event: 'surface-create', name });
        if (name === 'console' && bindings.actions?.draft) {
          const originalDraft = bindings.actions.draft;
          bindings.actions.draft = function (input) {
            record({ event: 'draft-action', name: input.element.name,
              value: input.element.value, commandType: input.data.commandType });
            return originalDraft(input);
          };
        }
        const surface = factory.call(this, config, bindings), originalDispose = surface.dispose, originalRender = surface.render;
        surface.dispose = function () { record({ event: 'surface-dispose', name }); return originalDispose.call(this); };
        surface.render = function (type, data, ...rest) {
          if (name === 'console') record({ event: 'surface-render', type, commandType: data?.commandType, title: data?.title, request: data?.request });
          return originalRender.call(this, type, data, ...rest);
        };
        return surface;
      };
    } });
  });
  context.on('page', target => target.on('pageerror', error => report.errors.push(error.message)));
  page = await context.newPage(); await page.goto(editor.url);
  report.resourceRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/domains/fwa-projection/files/')) report.resourceRequests.push({ method: request.method(), path: decodeURIComponent(url.pathname) });
  });
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  const goalSelect = page.getByLabel('当前目标', { exact: true }), graph = page.getByTestId('fwa-dag');
  await expect(goalSelect).toHaveValue('');
  await expect(graph.locator('[data-node-id]')).toHaveCount(2);
  await expect(graph.locator('[data-node-id="alpha-reader"]')).toHaveCount(1);
  await expect(graph.locator('[data-node-id="beta-reader"]')).toHaveCount(1);
  await capture('01-all-goals-task-nodes');
  for (let index = 0; index < goals.length; index++) {
    const name = index === 0 ? 'Alpha' : 'Beta';
    // Groups remain native resources; the current task graph intentionally
    // displays executable nodes rather than retired group cards.
    const href = await page.evaluate(goalId => window.FwaNavigation.href('groups', 'shared-group', { goalId }), goals[index].id);
    await page.goto(href);
    await expect(page.getByTestId('fwa-inspector').getByRole('heading', { name: `${name} group`, exact: true })).toBeVisible();
    await expect(page.getByTestId('fwa-inspector')).toContainText(`${name} reader`);
    await expect(page.getByTestId('fwa-inspector')).not.toContainText(`${index === 0 ? 'Beta' : 'Alpha'} reader`);
    await nativeResource(page, objectResourceName('groups', 'shared-group', { goalId: goals[index].id }));
  }
  passed('all-goals task graph contains both readers; native group resources isolate identical IDs by goal');

  await expect(goalSelect).toHaveValue(goals[1].id);
  await expect(graph.locator('[data-node-id]')).toHaveCount(1);
  const groupName = objectResourceName('groups', 'shared-group', { goalId: goals[1].id });
  await nativeResource(page, groupName);
  await page.getByTestId('fwa-inspector').locator('summary').filter({ hasText: /^对象链接$/ }).click();
  const selfLink = page.getByTestId('fwa-inspector').getByRole('link', { name: '单独打开此记录', exact: true });
  await expect(selfLink).toBeVisible();
  const [popup] = await Promise.all([page.waitForEvent('popup'), selfLink.click()]);
  await expect(popup.getByTestId('fwa-inspector').getByRole('heading', { name: 'Beta group', exact: true })).toBeVisible();
  await expect(popup.getByLabel('当前目标', { exact: true })).toHaveValue(goals[1].id);
  await nativeResource(popup, groupName);
  await popup.reload();
  await expect(popup.getByTestId('fwa-inspector').getByRole('heading', { name: 'Beta group', exact: true })).toBeVisible();
  await expect(popup.getByTestId('fwa-inspector')).toContainText('Beta reader');
  await expect(popup.getByTestId('fwa-inspector')).not.toContainText('Alpha reader');
  await expect(popup.getByLabel('当前目标', { exact: true })).toHaveValue(goals[1].id);
  await nativeResource(popup, groupName);
  await capture('02-group-new-tab-reload', popup); await popup.close();
  passed('scoped group native resource opens in a new tab and reload restores the same goal and group');

  await goalSelect.selectOption(goals[0].id);
  await clickOne(graph.locator('[data-node-id="alpha-reader"]'));
  const technical = page.getByTestId('fwa-node-detail').locator('[data-fwa-node-technical]');
  if (!await technical.evaluate(element => element.open)) await technical.locator(':scope > summary').click();
  const referencePath = encodeURIComponent(objectResourceName('refs', refId));
  await clickOne(technical.locator(`a.fwe-resource-link[href*=${JSON.stringify(referencePath)}]`));
  await expect(page.getByTestId('fwa-ref-preview')).toContainText('Shared design reference');
  await expect(page.getByTestId('fwa-inspector').getByRole('link', { name: 'Alpha reader', exact: true })).toHaveCount(1);
  await expect(page.getByTestId('fwa-inspector').getByRole('link', { name: 'Beta reader', exact: true })).toHaveCount(1);
  await nativeResource(page, objectResourceName('refs', refId));
  await capture('03-shared-ref-cross-goal-readers');
  await clickOne(page.getByTestId('fwa-inspector').getByRole('link', { name: 'Beta reader', exact: true }));
  await expect(goalSelect).toHaveValue(goals[1].id);
  await expect(graph).toBeVisible();
  await expect(graph.locator('[data-node-id="beta-reader"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(graph.locator('[data-node-id="alpha-reader"]')).toHaveCount(0);
  await expect(page.getByTestId('fwa-inspector').getByRole('heading', { name: 'Beta reader', exact: true })).toBeVisible();
  await nativeResource(page, objectResourceName('nodes', 'beta-reader'));
  await capture('04-cross-goal-reader-dag');
  passed('shared Ref exposes both readers and selecting the other goal switches filter, DAG selection and native resource');

  let loadingRoute;
  const loadingObserved = new Promise(resolve => { loadingRoute = resolve; });
  const interceptLoading = route => loadingRoute(route);
  const requestDisclosure = page.getByTestId('fwa-console').locator('details').filter({ has: page.getByTestId('fwa-workflow-intake') });
  if (!await requestDisclosure.evaluate(element => element.open)) await requestDisclosure.locator(':scope > summary').click();
  const requestInput = page.getByLabel('需求描述', { exact: true });
  await expect(requestInput).toBeVisible();
  const betaTechnical = page.getByTestId('fwa-node-detail').locator('[data-fwa-node-technical]');
  if (!await betaTechnical.evaluate(element => element.open)) await betaTechnical.locator(':scope > summary').click();
  const betaRef = betaTechnical.locator(`a.fwe-resource-link[href*=${JSON.stringify(referencePath)}]`);
  await page.route('**/api/domains/fwa-projection/files/**', interceptLoading);
  await clickOne(betaRef);
  const heldNavigation = await bounded(loadingObserved, 'the native projection resource request');
  const draft = 'DO NOT SUBMIT · native navigation must retain this local draft';
  const rootIdentity = await page.getByTestId('fwa-console').elementHandle();
  // A held real resource read proves the loading contract deterministically,
  // without sleeps or patched app state. Descendant fields must be disabled,
  // not merely editable-looking controls inside an inert FWE workspace.
  await expect(page.getByTestId('fwa-console')).toHaveAttribute('aria-busy', 'true');
  await expect(requestInput).toBeDisabled();
  await capture('05-native-navigation-loading');
  await heldNavigation.continue();
  await page.unroute('**/api/domains/fwa-projection/files/**', interceptLoading);
  passed('native resource loading exposes busy state and disables descendant command fields until the read completes');
  await expect(requestInput).toBeEnabled(); await requestInput.fill(draft);
  await expect(requestInput).toHaveValue(draft);
  report.draftBeforeLeaving = { request: await requestInput.inputValue(), rootConnected: await rootIdentity.evaluate(root => root.isConnected) };
  await clickOne(page.getByTestId('fwa-inspector').getByRole('link', { name: 'Beta reader', exact: true }));
  await nativeResource(page, objectResourceName('nodes', 'beta-reader'));
  await page.getByTestId('fwa-refresh').click(); await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  report.draftAfterReturning = { request: await requestInput.inputValue(), sameRootConnected: await rootIdentity.evaluate(root => root.isConnected) };
  await expect(requestInput).toHaveValue(draft);
  assert.equal(report.draftAfterReturning.sameRootConnected, true);
  await capture('05-command-draft-retained');
  passed('current requirement draft survives native object navigation and refresh without remounting or submission');

  readOnlyEditor = await startEditor({ projectRoot: root, fwePath: args.get('--fwe'), port: 0, allowWrite: false, workflow: { planner: null, executor: null } });
  const readOnlyPage = await context.newPage(); await readOnlyPage.goto(readOnlyEditor.url);
  await expect(readOnlyPage.getByText('只读预览', { exact: true })).toBeVisible();
  const session = await (await fetch(readOnlyEditor.url + '/api/fwa/session')).json();
  const command = await fetch(readOnlyEditor.url + '/api/fwa/commands', { method: 'POST',
    headers: { Origin: readOnlyEditor.url, 'Content-Type': 'application/json', 'X-FWA-CSRF': session.csrfToken, 'X-FWA-Fingerprint': session.fingerprint },
    body: JSON.stringify({ type: 'goal.create', commandId: 'readonly-must-not-write', payload: { title: 'Forbidden' } }) });
  assert.equal(command.status, 403);
  const mutation = await fetch(readOnlyEditor.url + '/api/domains/fwa-projection/files/projection.json', { method: 'PUT' });
  assert.equal(mutation.status, 405);
  await capture('06-read-only-denial', readOnlyPage); await readOnlyPage.close();
  assert.deepEqual(await application.getStatus(), expected);
  assert.equal(git(['rev-parse', 'HEAD']), baseline); assert.equal(git(['status', '--porcelain']), '');
  assert.equal(await readFile(path.join(root, 'docs', 'shared.md'), 'utf8'), referenceText);
  assert.deepEqual(report.errors, []);
  passed('read-only commands and generic mutations are denied; zero browser exceptions, no events or Git changes');
  report.ok = true; report.eventCount = expected.eventCount; report.finalUrl = page.url();
  await writeFile(path.join(output, 'final-status.json'), JSON.stringify(expected, null, 2));
} catch (error) {
  report.error = error.stack; process.exitCode = 1; console.error(error);
  if (page) await capture('failure').catch(() => {});
} finally {
  if (page && !page.isClosed()) report.surfaceProbe = await page.evaluate(() => window.__fwaNavigationProbe).catch(() => []);
  await browser?.close(); await readOnlyEditor?.close(); await editor?.close();
  if (report.ok) await removeOwnedFixture();
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, surfaceProbe: `${report.surfaceProbe?.length || 0} records; see summary.json` }, null, 2));
}
