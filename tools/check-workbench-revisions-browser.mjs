import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FwaApplication } from '../src/application/fwa-application.js';
import { startEditor } from '../src/editor/server.js';

// Isolated browser acceptance using the real HTTP editor, Git and durable revisions.
// The trusted fixture planner never invokes a model; the executor must never run.
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(['--fwe', '--playwright', '--output'].includes(process.argv[index]), `Unknown option ${process.argv[index]}`);
  assert.ok(process.argv[index + 1], `Missing value for ${process.argv[index]}`);
  args.set(process.argv[index], path.resolve(process.argv[index + 1]));
}
for (const key of ['--fwe', '--playwright', '--output']) assert.ok(args.has(key), `Missing ${key}`);
const output = args.get('--output'); await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(args.get('--playwright')).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(args.get('--playwright')), 'test.mjs')).href);
const startedAt = Date.now();
const report = { scope: 'Real Edge + HTTP + Git; two goals, feedback revisions and explicit history; no user project or business Run.',
  checks: [], screenshots: [], commands: [], plannerCalls: [], errors: [], httpTimeline: [] };
const responseCaptures = new Set(), requestRecords = new WeakMap();
const redact = value => Array.isArray(value) ? value.map(redact)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, /csrf|token|authorization|cookie|secret/i.test(key) ? '[redacted]' : redact(child)])) : value;
const passed = text => { report.checks.push(text); process.stdout.write(`PASS ${text}\n`); };
const git = (root, values) => {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...values], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const feedbackTexts = ['基础数据增加格式说明，保留原有验收条件。', '将基础数据拆成格式说明和数值范围两个独立结果，汇总同时使用两者。'];
const sourceChecks = ['source-format', 'source-range'];
const leaf = (id, title, outcome, writes, checks, dependsOn = [], extra = {}) => ({ id, title, outcome,
  instruction: `Create the requested fixture result: ${outcome}`, dependsOn,
  dependencyReasons: dependsOn.map(nodeId => ({ nodeId, reason: '汇总内容需要此前置结果中的实际数据。' })),
  reads: ['seed.txt'], writes, capabilities: ['file_operations'], acceptance: { checks },
  budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 40 }, ...extra });
const profileCheck = (id, kind = 'test') => ({ id, kind, command: process.execPath,
  args: ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('seed.txt','utf8'),'fixture baseline\\n')"], timeoutMs: 10000 });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-revisions-browser-'));
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Browser Fixture']);
  git(root, ['config', 'user.email', 'browser@local.invalid']); git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n'); await writeFile(path.join(root, 'seed.txt'), 'fixture baseline\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Browser revision baseline']);
  const app = new FwaApplication(root); await app.init();
  const goal = (await app.createGoal({ title: '基础数据与汇总', request: '准备格式与范围数据，再用两者生成汇总。', commandId: 'create-main-goal' })).goal;
  const otherGoal = (await app.createGoal({ title: '独立说明', commandId: 'create-other-goal' })).goal;
  await app.loadPlan({ goalId: goal.id, commandId: 'load-main-plan', plan: { schemaVersion: 1, nodes: [
    leaf('source', '基础数据', '格式与范围数据可供汇总使用。', ['source-format.txt', 'source-range.txt'], sourceChecks),
    leaf('consumer', '数据汇总', '汇总包含格式说明与数值范围。', ['summary.txt'], ['consumer-summary'], ['source'],
      { reads: ['source-format.txt', 'source-range.txt'] })
  ] } });
  await app.loadPlan({ goalId: otherGoal.id, commandId: 'load-other-plan', plan: { schemaVersion: 1, nodes: [
    leaf('independent', '独立说明', '提供与数据汇总无依赖的说明文件。', ['independent.txt'], ['independent-description'])
  ] } });
  let dispatches = 0;
  const executor = { schemaVersion: 1, id: 'must-not-execute', version: '1', capabilities: ['file_operations'], async execute() {
    dispatches++; throw new Error('Revision browser acceptance must not start a business Run.');
  } };
  const planner = { async plan(input) {
    const ordinal = report.plannerCalls.length, plan = structuredClone(input.existingPlan);
    assert.ok(ordinal < 2, 'No extra planner call is allowed.');
    assert.equal(plan.goalId, goal.id); assert.equal(input.feedback.length, 1);
    assert.equal(input.feedback[0].text, feedbackTexts[ordinal]);
    const source = plan.nodes.find(node => node.id === 'source'); assert.ok(source);
    report.plannerCalls.push({ ordinal: ordinal + 1, feedback: input.feedback.map(item => ({ id: item.id, text: item.text })),
      logicalNodeIds: plan.nodes.map(node => node.id) });
    if (ordinal === 0) {
      source.title = '基础数据（格式明确）'; source.outcome = '基础数据包含明确的格式说明与数值范围。';
      source.instruction = 'Create source-format.txt with an explicit format description and source-range.txt with the numeric range.';
    } else {
      const consumer = plan.nodes.find(node => node.id === 'consumer'); assert.ok(consumer);
      const format = leaf('source-format', '格式说明', '可供汇总直接引用的独立格式说明。', ['source-format.txt'], ['source-format'], [], { derivedFrom: 'source' });
      const range = leaf('source-range', '数值范围', '可供汇总直接引用的独立数值范围。', ['source-range.txt'], ['source-range'], [], { derivedFrom: 'source' });
      consumer.dependsOn = [format.id, range.id];
      consumer.dependencyReasons = [{ nodeId: format.id, reason: '汇总需要引用已确定的格式说明。' },
        { nodeId: range.id, reason: '汇总需要引用已确定的数值范围。' }];
      plan.nodes = [format, range, consumer];
    }
    return { title: '基础数据与汇总', questions: [], plan, evidence: { adapter: 'browser-revision-fixture', ordinal: ordinal + 1 } };
  } };
  const contracts = [sourceChecks, ['source-format'], ['source-range'], ['consumer-summary'], ['independent-description']];
  const reviewConfig = { schemaVersion: 1, targetRef: 'main',
    validationProfiles: contracts.map((checks, index) => ({ schemaVersion: 1, id: `fixture-profile-${index}`, checks: checks.map(id => profileCheck(id)) })),
    regressionProfile: { schemaVersion: 1, id: 'fixture-regression', checks: [profileCheck('compile', 'compile'), profileCheck('test')] } };
  return { root, app, goal, otherGoal, planner, executor, reviewConfig, baseline: git(root, ['rev-parse', 'HEAD']),
    initialEvents: await app.listEvents(), get dispatches() { return dispatches; } };
}
let browser, editor, page, f;
const graph = () => page.getByTestId('fwa-dag');
const graphNode = id => graph().locator(`[data-node-id="${id}"]`);
const inspector = () => page.getByTestId('fwa-inspector');
const goalSelect = () => page.getByTestId('fwa-console').locator('select').first();
async function jobsIdle() {
  await expect.poll(async () => {
    const response = await fetch(`${editor.url}/api/fwa/workbench`); assert.ok(response.ok);
    const { jobs } = await response.json();
    const failed = jobs.find(job => job.state === 'failed'); assert.ok(!failed, JSON.stringify(failed));
    return jobs.some(job => job.state === 'running');
  }, { timeout: 30000 }).toBe(false);
}
async function refresh() {
  await expect(page.getByTestId('fwa-console')).toBeEnabled({ timeout: 20000 });
  await page.getByTestId('fwa-refresh').click();
  await expect(page.getByTestId('fwa-refresh')).toBeEnabled({ timeout: 20000 });
  await expect(page.getByTestId('fwa-console')).toBeEnabled({ timeout: 20000 });
}
async function shot(name) {
  await jobsIdle(); await expect(page.getByTestId('fwa-console')).toBeEnabled();
  for (const width of [1600, 1000]) {
    await page.setViewportSize({ width, height: 1120 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const file = `${name}-${width}.png`; await page.screenshot({ path: path.join(output, file), fullPage: true }); report.screenshots.push(file);
  }
  await page.setViewportSize({ width: 1600, height: 1120 });
  await writeFile(path.join(output, `${name}-aria.txt`), await page.locator('body').ariaSnapshot());
}
async function revise(text, expectedRevision) {
  const feedback = page.getByTestId('fwa-node-feedback');
  if (await feedback.getAttribute('open') === null) await feedback.locator('summary').click();
  await page.getByLabel('节点修改建议', { exact: true }).fill(text);
  const button = page.getByRole('button', { name: '按补充要求调整图', exact: true });
  await expect(button).toBeEnabled(); await button.click();
  await expect.poll(async () => (await f.app.getStatus()).goals.find(goal => goal.id === f.goal.id).planRevision,
    { timeout: 30000 }).toBe(expectedRevision);
  await jobsIdle(); await refresh();
}
try {
  f = await fixture(); report.root = f.root; report.baseline = f.baseline; report.goalId = f.goal.id; report.otherGoalId = f.otherGoal.id;
  report.initialVerification = await f.app.verify(); assert.equal(report.initialVerification.ok, true);
  editor = await startEditor({ projectRoot: f.root, fwePath: args.get('--fwe'), port: 0, allowWrite: true,
    reviewConfig: f.reviewConfig, workflow: { planner: f.planner, executor: f.executor } });
  report.url = editor.url; browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1120 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.errors.push({ kind: 'pageerror', message: error.message }));
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      const record = { id: report.httpTimeline.length + 1, method: request.method(), url: request.url(), startedMs: Date.now() - startedAt };
      if (request.method() === 'POST' && request.url().endsWith('/api/fwa/commands')) record.commandType = request.postDataJSON().type;
      report.httpTimeline.push(record); requestRecords.set(request, record);
    }
    if (request.method() === 'POST' && request.url().endsWith('/api/fwa/commands')) report.commands.push(request.postDataJSON());
  });
  page.on('response', response => {
    const requestRecord = requestRecords.get(response.request());
    if (requestRecord) Object.assign(requestRecord, { status: response.status(), responseMs: Date.now() - startedAt });
    if (response.status() < 400) return;
    const error = { kind: 'http', status: response.status(), url: response.url(), requestId: requestRecord?.id, responseMs: Date.now() - startedAt };
    report.errors.push(error);
    const capture = (async () => {
      try {
        const body = await response.json(); error.code = body?.code ?? null; error.body = redact(body);
      } catch (failure) { error.bodyReadError = failure.message; }
    })();
    responseCaptures.add(capture); void capture.finally(() => responseCaptures.delete(capture));
  });
  await page.goto(editor.url); await expect(page.getByTestId('fwa-refresh')).toBeEnabled({ timeout: 20000 });
  await expect(goalSelect()).toHaveValue(''); await expect(page.getByTestId('fwa-graph-scope')).toBeDisabled();
  await expect(graph().locator('[data-node-id]')).toHaveCount(3);
  await expect(graph().locator('[data-node-id][aria-pressed="true"]')).toHaveCount(0);
  await expect(graphNode('source')).toBeVisible();
  await graphNode('source').click();
  await expect(goalSelect()).toHaveValue(f.goal.id); await expect(graphNode('source')).toHaveAttribute('aria-pressed', 'true');
  await expect(graphNode('independent')).toHaveCount(0);
  const topContinue = page.getByRole('button', { name: '继续', exact: true });
  await expect(topContinue).toHaveCount(1); await expect(topContinue).toBeEnabled();
  await inspector().locator('summary').filter({ hasText: /^对象链接$/ }).click();
  const oldHref = await inspector().getByRole('link', { name: '单独打开此记录', exact: true }).getAttribute('href'); assert.ok(oldHref);
  report.historicalHref = new URL(oldHref, editor.url).href;
  await inspector().locator('summary').filter({ hasText: /^对象链接$/ }).click();
  await shot('00-selected-from-all-goals');
  passed('All goals node click selects its owner goal, filters the DAG and enables the unique goal-level Continue without starting work');

  // Exercise the default focus mode that formerly became empty after a revision.
  await expect(page.getByTestId('fwa-graph-scope')).toHaveText('查看全图');
  await revise(feedbackTexts[0], 2);
  await expect(graphNode('source@revision-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(graphNode('consumer@revision-2')).toBeVisible(); await expect(graphNode('source')).toHaveCount(0);
  await expect(page.getByTestId('fwa-node-detail').getByRole('heading', { name: '基础数据包含明确的格式说明与数值范围。', exact: true })).toBeVisible();
  await expect(page.getByTestId('fwa-node-detail')).not.toContainText('历史版本');
  const revisedUrl = page.url(); assert.notEqual(revisedUrl, report.historicalHref);
  await refresh(); await expect(graphNode('source@revision-2')).toHaveAttribute('aria-pressed', 'true'); assert.equal(page.url(), revisedUrl);
  await shot('01-revised-current-node');
  passed('UI feedback creates revision 2 and follows the same logical result to its new physical node across refresh');

  await page.goto(report.historicalHref); await expect(page.getByTestId('fwa-refresh')).toBeEnabled({ timeout: 20000 });
  await expect(page.getByTestId('fwa-node-detail')).toContainText('历史版本');
  await expect(page.getByTestId('fwa-node-detail').getByRole('heading', { name: '格式与范围数据可供汇总使用。', exact: true })).toBeVisible();
  await expect(graphNode('source@revision-2')).toBeVisible(); await expect(graph().locator('[data-node-id]')).toHaveCount(2);
  await expect(graph().locator('[data-node-id][aria-pressed="true"]')).toHaveCount(0);
  await refresh(); await expect(page.getByTestId('fwa-node-detail')).toContainText('历史版本');
  assert.equal(page.url(), report.historicalHref); await expect(goalSelect()).toHaveValue(f.goal.id);
  await shot('02-explicit-historical-record');
  passed('A saved original record URL remains historical across refresh while the current goal DAG stays visible');

  await graphNode('source@revision-2').click(); await expect(graphNode('source@revision-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('fwa-node-detail')).not.toContainText('历史版本');
  await revise(feedbackTexts[1], 3);
  await expect(graphNode('source-format@revision-3')).toBeVisible(); await expect(graphNode('source-range@revision-3')).toBeVisible();
  await expect(graphNode('consumer@revision-3')).toBeVisible(); await expect(graph().locator('[data-node-id]')).toHaveCount(3);
  await expect(graph().locator('[data-node-id][aria-pressed="true"]')).toHaveCount(0);
  await expect(inspector().getByRole('heading', { name: '基础数据与汇总', exact: true })).toBeVisible();
  await expect(inspector()).toContainText('当前结果显示在任务图中'); await expect(goalSelect()).toHaveValue(f.goal.id);
  await expect(page.getByTestId('fwa-graph-scope')).toHaveText('全部任务'); await expect(topContinue).toBeEnabled();
  const splitUrl = page.url(); await refresh(); assert.equal(page.url(), splitUrl);
  await expect(graph().locator('[data-node-id][aria-pressed="true"]')).toHaveCount(0);
  await shot('03-derived-goal-overview');
  passed('UI feedback splits the source into two distinct results, shows the goal overview and never chooses an arbitrary child');

  const status = await f.app.getStatus(), current = status.nodes.filter(node => node.goalId === f.goal.id && node.supersededByRevision == null);
  const children = current.filter(node => node.derivedFrom === 'source'), consumer = current.find(node => node.logicalId === 'consumer');
  assert.equal(children.length, 2); assert.deepEqual(children.flatMap(node => node.acceptance.checks).sort(), [...sourceChecks].sort());
  assert.deepEqual(consumer.dependsOn.slice().sort(), children.map(node => node.id).sort());
  assert.deepEqual(consumer.dependencyReasons.map(item => item.nodeId).sort(), consumer.dependsOn.slice().sort());
  assert.ok(consumer.dependencyReasons.every(item => item.reason.trim()));
  assert.equal(status.workflow.feedback.length, 2); assert.ok(status.workflow.feedback.every(item => item.status === 'applied'));
  assert.equal(status.nodes.find(node => node.id === 'independent').supersededByRevision, null);
  assert.deepEqual(report.commands.map(command => command.type), ['node.feedback', 'workflow.revise', 'node.feedback', 'workflow.revise']);
  assert.deepEqual(report.commands.filter(command => command.type === 'workflow.revise').map(command => command.payload.expectedRevision), [1, 2]);
  assert.equal(f.dispatches, 0); assert.equal(status.runs.length, 0); assert.equal(status.changeSets.length, 0);
  assert.equal(status.evaluations.length, 0); assert.equal(status.integrations.length, 0);
  const events = await f.app.listEvents(); assert.deepEqual(events.slice(0, f.initialEvents.length), f.initialEvents);
  assert.equal(events.filter(event => event.type === 'PlanRevised').length, 2);
  report.verification = await f.app.verify(); assert.equal(report.verification.ok, true, JSON.stringify(report.verification));
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.baseline); assert.equal(git(f.root, ['status', '--porcelain']), '');
  report.final = { revision: status.goals.find(goal => goal.id === f.goal.id).planRevision, currentNodes: current,
    preservedInitialEvents: f.initialEvents.length, eventCount: events.length, runs: status.runs.length, executorDispatches: f.dispatches };
  await writeFile(path.join(output, 'final-status.json'), JSON.stringify(status, null, 2));
  passed('Two real revisions preserve acceptance, dependency reasons, old events and the untouched other goal; zero Runs; verify passes');
  await Promise.all([...responseCaptures]);
  assert.deepEqual(report.errors, []); passed('No JavaScript errors or failed HTTP responses'); report.ok = true;
} catch (error) {
  report.ok = false; report.failure = error.stack; process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(output, 'failure-aria.txt'), await page.locator('body').ariaSnapshot()).catch(() => {});
  }
  process.stderr.write(error.stack + '\n');
} finally {
  await Promise.all([...responseCaptures]);
  if (page) await page.close(); if (browser) await browser.close(); if (editor) await editor.close();
  report.durationMs = Date.now() - startedAt; await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`Report: ${path.join(output, 'report.json')}\n`);
}
