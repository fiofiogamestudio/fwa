import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FwaApplication } from '../src/application/fwa-application.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { CodexExecutor } from '../src/adapters/codex-executor.js';
import { boundedDiagnosticText, classifyFailure, summarizeFailure } from '../src/core/failure-diagnostics.js';
import { stableStringify } from '../src/core/events.js';

const executeFile = promisify(execFile);
const git = (cwd, args) => executeFile('git', args, { cwd, windowsHide: true });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-bounded-failure-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Failure Test']);
  await git(root, ['config', 'user.email', 'failure@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'fixture']);
  const baseRevision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const app = new FwaApplication(root);
  await app.init();
  const { goal } = await app.createGoal({ title: 'Bound failure evidence', request: 'Retain complete diagnostics.' });
  await app.loadPlan({ goalId: goal.id, plan: {
    schemaVersion: 1, id: 'failure-plan', nodes: [{ id: 'failure-node', title: 'Fail after edits',
      dependsOn: [], reads: ['seed.txt'], writes: ['output.txt'], capabilities: ['code_edit'],
      acceptance: { checks: ['real-output'] }, budget: { maxRetries: 2, maxFiles: 2, maxDiffLines: 20 } }]
  } });
  return { root, app, baseRevision, workspace: new GitWorktreeAdapter(root) };
}

test('multi-megabyte executor diagnostics stay in verified artifacts, not events or retry feedback', async t => {
  const { root, app, baseRevision, workspace } = await fixture(t);
  const stdout = '真实日志 😀\0'.repeat(220000);
  const stderr = '終端错误\n'.repeat(20000);
  const failure = Object.assign(new Error('Codex execution was aborted.\0' + '😀'.repeat(2000)), {
    code: 'FWA_CODEX_ABORTED', details: { process: { stdout, stderr, terminationConfirmed: true,
      exitCode: null, signal: 'SIGTERM', aborted: true }, invocation: { cwd: 'D:\\private\\run_123' } }
  });
  const executor = { schemaVersion: 1, id: 'large-failure', version: '1', capabilities: ['code_edit'],
    async execute({ workspaceRoot }) {
      await writeFile(path.join(workspaceRoot, 'output.txt'), 'recoverable edit\n');
      throw failure;
    } };
  const result = await app.runNext({ nodeId: 'failure-node', executor, workspace, baseRevision, input: {} });
  assert.equal(result.ok, false);
  assert.equal(result.run.failure.code, failure.code);
  assert.equal(result.run.failure.details.process.terminationConfirmed, true);
  const reference = result.run.failure.details.artifactRef;
  assert.ok(reference);
  assert.equal((await app.artifacts.verify(reference)).ok, true);
  const stored = JSON.parse((await app.artifacts.get(reference)).toString('utf8'));
  assert.equal(stored.failure.details.process.stdout, stdout);
  assert.equal(stored.failure.details.process.stderr, stderr);
  assert.equal(stored.failure.message, failure.message);
  const violation = result.changeSet.violations.find(item => item.code === 'EXECUTION_FAILED');
  assert.deepEqual(violation.details.failure.details.artifactRef, reference);
  const execution = JSON.parse((await app.artifacts.get(result.changeSet.executionArtifact)).toString('utf8'));
  assert.deepEqual(execution.failure.details.artifactRef, reference);
  const feedback = JSON.stringify({ runFailure: result.run.failure, changeSetViolations: result.changeSet.violations });
  assert.ok(Buffer.byteLength(feedback) < 16000);
  assert.equal(feedback.includes('\0'), false);
  const codex = new CodexExecutor({ spawnImpl: () => assert.fail('validation must never spawn') });
  assert.equal(codex.validateInput({ schemaVersion: 1, prompt: feedback }).ok, true);
  assert.deepEqual((await app.verify()).unreferencedArtifacts, []);
  for (const file of await readdir(path.join(root, '.fwa', 'events'))) {
    if (!file.endsWith('.json')) continue;
    assert.ok((await readFile(path.join(root, '.fwa', 'events', file))).length < 60000, file);
  }
});

test('pure Codex input validation counts UTF-8 bytes and rejects NUL and malformed prompts before spawn', () => {
  const executor = new CodexExecutor({ spawnImpl: () => assert.fail('validation must never spawn') });
  const validate = prompt => executor.validateInput({ schemaVersion: 1, prompt });
  assert.deepEqual(validate('😀'.repeat(262144)), { ok: true, promptBytes: 1048576 });
  for (const [prompt, reason] of [[null, 'prompt-type'], ['', 'prompt-empty'], [' bad', 'prompt-whitespace'],
    ['bad\0input', 'prompt-nul'], ['😀'.repeat(262145), 'prompt-too-large']]) {
    assert.throws(() => validate(prompt), error => error.code === 'FWA_INVALID_CODEX_EXECUTOR_INPUT'
      && error.details.reason === reason && classifyFailure(error).retryDisposition === 'repair-input');
  }
});

test('capture failure retains the earlier complete execution evidence reference', async t => {
  const { app, baseRevision, workspace } = await fixture(t);
  const stdout = 'retained diagnostic\n'.repeat(90000);
  const executor = { schemaVersion: 1, id: 'capture-failure', version: '1', capabilities: ['code_edit'],
    async execute() { throw Object.assign(new Error('Executor failed.'), { code: 'TEST_EXECUTOR_FAILED',
      details: { process: { stdout, terminationConfirmed: true } } }); } };
  workspace.capture = async () => { throw Object.assign(new Error('Capture unavailable.'), { code: 'TEST_CAPTURE_FAILED' }); };
  const result = await app.runNext({ nodeId: 'failure-node', executor, workspace, baseRevision, input: {} });
  assert.equal(result.run.failure.code, 'TEST_CAPTURE_FAILED');
  const ref = result.run.failure.details.executionFailure.details.artifactRef;
  const retained = JSON.parse((await app.artifacts.get(ref)).toString('utf8'));
  assert.equal(retained.failure.details.process.stdout, stdout);
  assert.ok(Buffer.byteLength(JSON.stringify(result.run.failure)) < 16000);
  assert.deepEqual((await app.verify()).unreferencedArtifacts, []);
  const originalGet = app.artifacts.get.bind(app.artifacts);
  let replacement;
  t.mock.method(app.artifacts, 'get', async requested => requested.digest === ref.digest
    ? Buffer.from(stableStringify(replacement) + '\n') : originalGet(requested));
  for (const change of [{ runId: 'another-run' }, { executor: { id: 'another-executor', version: '1' } },
    { failure: { code: 'DIFFERENT_FAILURE', message: 'Different cause.', details: null } }]) {
    replacement = { ...retained, ...change };
    await assert.rejects(app.verify(), { code: 'failure-artifact-binding-mismatch' });
  }
});

test('artifact retention failure preserves unconfirmed-termination safety flags and the workspace', async t => {
  const { app, baseRevision, workspace } = await fixture(t);
  const executor = { schemaVersion: 1, id: 'retention-failure', version: '1', capabilities: ['code_edit'],
    async execute() { throw Object.assign(new Error('Termination unconfirmed.'), {
      code: 'FWA_CODEX_PROCESS_TERMINATION_UNCONFIRMED',
      details: { process: { terminationConfirmed: false, stdout: 'large'.repeat(300000) } } }); } };
  t.mock.method(app.artifacts, 'put', async () => {
    throw Object.assign(new Error('Storage unavailable.'), { code: 'TEST_ARTIFACT_WRITE_FAILED' });
  });
  const result = await app.runNext({ nodeId: 'failure-node', executor, workspace, baseRevision, input: {} });
  assert.equal(result.run.failure.details.process.terminationConfirmed, false);
  assert.equal(result.run.failure.details.retentionFailure.code, 'TEST_ARTIFACT_WRITE_FAILED');
  assert.equal(result.run.workspaceStatus, 'preserved');
  assert.equal(classifyFailure(result.run.failure).retryDisposition, 'inspect');
  assert.ok(Buffer.byteLength(JSON.stringify(result.run.failure)) < 16000);
});

test('classification unwraps retained violations and ignores volatile diagnostics', () => {
  const base = { code: 'FWA_CODEX_OUTPUT_LIMIT_EXCEEDED', message: 'Limit at D:\\runs\\run_123 at 2026-09-18T01:00:00Z',
    details: { process: { stdout: 'first long log' } } };
  const changed = { ...base, message: 'Limit at E:\\other\\run_999 at 2026-10-20T02:00:00Z',
    details: { process: { stdout: 'different long log' } } };
  assert.deepEqual(classifyFailure(base), classifyFailure({ code: 'EXECUTION_FAILED', details: {
    failure: { code: 'EXECUTION_FAILED', details: { failure: changed } } } }));
  assert.equal(classifyFailure(base).retryDisposition, 'repair-input');
  const wrapped = { code: 'EXECUTION_FAILED', details: { failure: base } };
  assert.deepEqual(classifyFailure(summarizeFailure(wrapped)), classifyFailure(base));
  assert.deepEqual(classifyFailure(null), { category: 'none', retryDisposition: 'inspect', fingerprint: null });
  assert.deepEqual(classifyFailure(undefined), classifyFailure(null));
  const withSafety = { ...base, details: { process: { terminationConfirmed: false }, fencePersisted: false } };
  const summary = summarizeFailure(withSafety);
  assert.equal(summary.details.process.terminationConfirmed, false);
  assert.equal(summary.details.fencePersisted, false);
  assert.equal(classifyFailure(summary).retryDisposition, 'inspect');
});

test('bounded summaries preserve immutable references and complete Unicode characters without NUL', () => {
  const ref = { schemaVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64), size: 9000000 };
  const summary = summarizeFailure({ code: 'FAIL', message: '😀\0'.repeat(5000),
    details: { artifactRef: ref, process: { stdout: 'irrelevant'.repeat(100000) } } });
  assert.ok(Buffer.byteLength(summary.message) <= 2048);
  assert.equal(summary.message.includes('\0'), false);
  assert.equal(summary.message.includes('\ufffd'), false);
  assert.deepEqual(summary.details.artifactRef, ref);
  assert.equal(JSON.stringify(summary).includes('irrelevant'), false);
  assert.equal(boundedDiagnosticText('😀😀', 7), '😀');
});
