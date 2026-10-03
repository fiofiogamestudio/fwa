import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { FwaApplication } from '../src/application/fwa-application.js';
import { WorkbenchController } from '../src/application/workbench-controller.js';
import { ReviewController } from '../src/application/review-controller.js';
import { normalizeReviewConfig } from '../src/application/review-config.js';
import { DEFAULT_CODEX_TIMEOUT_MS } from '../src/adapters/codex-executor.js';

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-workbench-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }));
  return root;
}
function fake() {
  let ready;
  const started = new Promise(resolve => { ready = resolve; }), kills = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    const close = (code = 0, signal = null) => {
      if (closed) return;
      closed = true; child.emit('close', code, signal);
    };
    child.kill = signal => { kills.push(signal); queueMicrotask(() => close(null, signal)); return true; };
    child.unref = () => {};
    queueMicrotask(() => ready({ child, close }));
    return child;
  };
  return { spawnImpl, started, kills };
}
const request = workspaceRoot => ({ workspaceRoot, node: { id: 'deadline-node' },
  input: { schemaVersion: 1, prompt: 'Produce the requested result.' } });

for (const [kind, timeoutMs] of [['planner', 3 * 60_000], ['executor', 30 * 60_000]]) {
  test(`workbench ${kind} has its own default total deadline despite ongoing output`, async t => {
    const root = await directory(t);
    t.mock.timers.enable();
    for (const options of [{}, { timeoutMs: undefined }]) {
      const port = fake();
      const controller = new WorkbenchController({ projectRoot: root }, {
        codexOptions: { executable: 'fake-codex', platform: 'linux', spawnImpl: port.spawnImpl, ...options }
      });
      const execute = kind === 'planner' ? controller.planner.executor : controller.executor;
      const outcome = execute.execute(request(root)).then(value => ({ value }), error => ({ error }));
      const controls = await port.started;
      try {
        for (let elapsed = 0; elapsed < timeoutMs - 60_000; elapsed += 60_000) {
          t.mock.timers.tick(60_000); controls.child.stdout.write('{"type":"working"}\n');
        }
        t.mock.timers.tick(59_999);
        assert.deepEqual(port.kills, []);
        t.mock.timers.tick(1);
        assert.deepEqual(port.kills, ['SIGKILL']);
        const { error } = await outcome;
        assert.equal(error.code, 'FWA_CODEX_TIMEOUT');
        assert.equal(error.details.timeoutMs, timeoutMs);
        assert.equal(error.details.process.terminationConfirmed, true);
        assert.equal(controller.abortController.signal.aborted, false);
        t.mock.timers.tick(timeoutMs * 2);
        assert.deepEqual(port.kills, ['SIGKILL'], 'settled execution clears all timers');
      } finally { controls.close(); await outcome; }
    }
  });
}

test('trusted common timeout explicitly overrides both defaults, including null and zero', async t => {
  const root = await directory(t);
  t.mock.timers.enable();
  assert.equal(DEFAULT_CODEX_TIMEOUT_MS, null, 'standalone adapter compatibility is unchanged');
  for (const timeoutMs of [null, 0, 75]) {
    for (const kind of ['planner', 'executor']) {
      const port = fake();
      const controller = new WorkbenchController({ projectRoot: root }, { codexOptions: {
        executable: 'fake-codex', platform: 'linux', spawnImpl: port.spawnImpl, timeoutMs, idleTimeoutMs: null
      } });
      const adapter = kind === 'planner' ? controller.planner.executor : controller.executor;
      const outcome = adapter.execute(request(root)).then(value => ({ value }), error => ({ error }));
      const controls = await port.started;
      try {
        t.mock.timers.tick(timeoutMs || 31 * 60_000);
        if (timeoutMs) {
          assert.deepEqual(port.kills, ['SIGKILL']);
          assert.equal((await outcome).error.details.timeoutMs, timeoutMs);
        } else {
          assert.deepEqual(port.kills, []);
          controls.child.stdout.write('{"type":"turn.completed"}\n'); controls.close();
          assert.equal((await outcome).value.ok, true);
        }
      } finally { controls.close(); await outcome; }
    }
  }
  const planner = { plan() {} }, executor = { execute() {} };
  const injected = new WorkbenchController({ projectRoot: root }, { planner, executor, codexOptions: { timeoutMs: 1 } });
  assert.equal(injected.planner, planner); assert.equal(injected.executor, executor);
});

test('invalid composition options retain adapter validation and unused options remain ignored', () => {
  const application = { projectRoot: process.cwd() }, planner = { plan() {} }, executor = { execute() {} };
  const invalid = [[], 'unexpected', null, 0, false, NaN, Infinity, 1n, Symbol('options'), () => {}, new Date()];
  for (const codexOptions of invalid) {
    for (const ports of [{}, { planner }]) {
      assert.throws(() => new WorkbenchController(application, { ...ports, codexOptions }), {
        code: 'FWA_INVALID_CODEX_EXECUTOR_OPTIONS', message: 'CodexExecutor options must be a plain object.'
      });
    }
    // The existing planner constructor copies its options. Preserve that
    // compatibility when the validating execution adapter was explicitly replaced.
    const plannerOnly = new WorkbenchController(application, { executor, codexOptions });
    assert.equal(plannerOnly.executor, executor); assert.equal(typeof plannerOnly.planner.plan, 'function');
    const injected = new WorkbenchController(application, { planner, executor, codexOptions });
    assert.equal(injected.planner, planner); assert.equal(injected.executor, executor);
    assert.doesNotThrow(() => new WorkbenchController(application, { planner: null, executor: null, codexOptions }));
  }
  assert.doesNotThrow(() => new WorkbenchController(application, { codexOptions: Object.create(null) }));
});

function realSpawn(t, script) {
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { children, spawnImpl(_executable, _args, options) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], options);
    child.closed = false; child.once('close', () => { child.closed = true; }); children.push(child); return child;
  } };
}
const chatter = 'process.stdin.resume(); console.log(JSON.stringify({type:"working"})); setInterval(() => console.log(JSON.stringify({type:"working"})), 20);';

test('total deadline stops a real child that keeps resetting the idle watchdog', { timeout: 15_000 }, async t => {
  const root = await directory(t), port = realSpawn(t, chatter);
  const controller = new WorkbenchController({ projectRoot: root }, { planner: null, codexOptions: {
    executable: process.execPath, spawnImpl: port.spawnImpl, timeoutMs: 700, idleTimeoutMs: 250, terminationGraceMs: 5000
  } });
  await assert.rejects(controller.executor.execute(request(root)), error => {
    assert.equal(error.code, 'FWA_CODEX_TIMEOUT');
    assert.equal(error.details.process.timedOut, true); assert.equal(error.details.process.idleTimedOut, false);
    assert.equal(error.details.process.terminationConfirmed, true);
    assert.ok(error.details.process.stdoutBytes > 0); assert.equal(port.children[0].closed, true);
    assert.throws(() => process.kill(port.children[0].pid, 0), { code: 'ESRCH' });
    return true;
  });
  assert.equal(controller.abortController.signal.aborted, false);
});

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
async function repository(t) {
  const root = await directory(t);
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'FWA Test']);
  git(root, ['config', 'user.email', 'test@example.invalid']); git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n'); await writeFile(path.join(root, 'seed.txt'), 'base\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']);
  const app = new FwaApplication(root); await app.init();
  return { root, app };
}

test('planning timeout fails one durable job without creating a Goal, Plan or Run', { timeout: 15_000 }, async t => {
  const { root, app } = await repository(t), port = realSpawn(t, chatter);
  // This case verifies durable planning state after the total deadline; idle resets are covered above.
  const controller = new WorkbenchController(app, { executor: null, codexOptions: {
    executable: process.execPath, spawnImpl: port.spawnImpl, timeoutMs: 700, idleTimeoutMs: null, terminationGraceMs: 5000
  } });
  t.after(() => controller.close());
  const command = { commandId: 'planning-timeout', request: 'Create one output file.' };
  const started = await controller.plan(command); await controller.jobs.active.get(started.id);
  const job = (await controller.jobs.list()).find(item => item.id === started.id);
  assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'FWA_CODEX_TIMEOUT');
  assert.equal(job.error.details.process.terminationConfirmed, true);
  assert.ok(job.error.details.process.stdoutBytes > 0);
  const state = await app.getStatus();
  assert.equal(state.goals.length, 0); assert.equal(state.nodes.length, 0); assert.equal(state.runs.length, 0);
  assert.equal((await app.lease.inspect()).held, false);
  assert.equal((await controller.plan(command)).appended, false); assert.equal(port.children.length, 1);
  assert.equal(controller.abortController.signal.aborted, false);
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('confirmed timeout preserves failed work and healthy candidate, releases lease and never runs its dependent', { timeout: 90_000 }, async t => {
  const { root, app } = await repository(t);
  const goal = (await app.createGoal({ title: 'Independent outcomes', commandId: 'goal' })).goal;
  const node = (id, dependsOn = []) => ({ id, title: id, instruction: `Create ${id}.txt.`, dependsOn,
    reads: ['seed.txt'], writes: [`${id}.txt`], capabilities: ['code_edit'], acceptance: { checks: ['content'] },
    budget: { maxRetries: 2, maxFiles: 1, maxDiffLines: 10 } });
  await app.loadPlan({ goalId: goal.id, commandId: 'plan', plan: { schemaVersion: 1,
    nodes: [node('chatty'), node('healthy'), node('dependent', ['chatty'])] } });
  const script = [
    'import { writeFileSync } from "node:fs";',
    'let prompt=""; for await (const chunk of process.stdin) prompt += chunk;',
    'const context=JSON.parse(prompt.trim().split("\\n").at(-1));',
    'writeFileSync(context.nodeId+".txt", context.nodeId+"\\n");',
    'if(context.nodeId==="chatty") { console.log(JSON.stringify({type:"working"})); setInterval(()=>console.log(JSON.stringify({type:"working"})),20); }',
    'else console.log(JSON.stringify({type:"turn.completed"}));'
  ].join('\n');
  const port = realSpawn(t, script);
  const config = normalizeReviewConfig({ schemaVersion: 1, targetRef: 'main', validationProfiles: [{
    schemaVersion: 1, id: 'output', checks: [{ id: 'content', kind: 'test', command: process.execPath,
      args: ['-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("healthy.txt","utf8"),"healthy\\n")'], timeoutMs: 5000 }]
  }], regressionProfile: { schemaVersion: 1, id: 'regression', checks: [
    { id: 'compile', kind: 'compile', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 },
    { id: 'test', kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }
  ] } });
  const controller = new WorkbenchController(app, { planner: null, validationProfiles: config.validationProfiles,
    codexOptions: { executable: process.execPath, spawnImpl: port.spawnImpl, timeoutMs: 700, idleTimeoutMs: 250, terminationGraceMs: 5000 } });
  controller.review = new ReviewController(app, { config, jobs: controller.jobs, signal: controller.abortController.signal });
  t.after(() => controller.close());
  const command = { goalId: goal.id, commandId: 'run' };
  const started = await controller.work(command); await controller.jobs.active.get(started.id);
  const job = (await controller.jobs.list()).find(item => item.id === started.id);
  assert.equal(job.state, 'succeeded');
  const result = job.result;
  assert.equal(result.stopReason, 'repair-needs-attention');
  assert.equal(result.candidates.at(-1).failureCategory, 'execution-timeout');
  const state = await app.getStatus(), failed = state.runs.find(item => item.nodeId === 'chatty');
  assert.equal(state.runs.length, 2); assert.equal(state.runBatches[0].status, 'finished');
  assert.equal(state.nodes.find(item => item.id === 'dependent').runIds.length, 0);
  const change = state.changeSets.find(item => item.nodeId === 'chatty');
  assert.equal(change.valid, false);
  const failure = change.violations.find(item => item.code === 'EXECUTION_FAILED').details.failure;
  assert.equal(failure.code, 'FWA_CODEX_TIMEOUT'); assert.equal(failure.details.process.terminationConfirmed, true);
  const retained = JSON.parse((await app.artifacts.get(failure.details.artifactRef)).toString('utf8'));
  assert.ok(retained.failure.details.process.stdoutBytes > 0);
  assert.equal(await readFile(path.join(root, failed.workspaceRelativePath, 'chatty.txt'), 'utf8'), 'chatty\n');
  const healthy = state.nodes.find(item => item.id === 'healthy');
  assert.equal(healthy.status, 'accepted'); assert.equal(healthy.validity, 'valid');
  assert.ok(state.changeSets.find(item => item.id === healthy.changeSetIds.at(-1)).valid);
  assert.equal(state.evaluations.length, 1); assert.equal(state.evaluations[0].status, 'passed');
  assert.equal(state.integrations.length, 0, 'manual completion remains a real review boundary');
  assert.equal((await app.lease.inspect()).held, false); assert.equal(controller.abortController.signal.aborted, false);
  assert.ok(port.children.every(child => child.closed));
  assert.equal((await controller.work(command)).appended, false);
  const resumed = await app.getStatus();
  assert.equal(resumed.runs.length, 2, 'one request never retries the timed-out member and command replay never repeats it');
  assert.equal(resumed.evaluations.length, 1);
  assert.equal((await app.verify()).ok, true); assert.equal(git(root, ['status', '--porcelain']), '');
});
