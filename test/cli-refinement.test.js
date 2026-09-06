import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { runCli } from '../src/cli.js';

function capturedIo() {
  return {
    stdout: { value: '', write(chunk) { this.value += chunk; } },
    stderr: { value: '', write(chunk) { this.value += chunk; } }
  };
}

test('human evaluator errors preserve the same field diagnostics as JSON', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fwa-profile-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, 'invalid.json');
  await writeFile(profilePath, JSON.stringify({ schemaVersion: 1, id: 'bad', checks: [{}] }));
  t.mock.method(FwaApplication.prototype, 'evaluateChangeSet', async ({ evaluator, profile }) => {
    evaluator.normalizeProfile(profile);
    assert.fail('the invalid profile must fail before an evaluation is started');
  });
  let expected;
  try {
    new CommandEvaluator().normalizeProfile({ schemaVersion: 1, id: 'bad', checks: [{}] });
  } catch (error) {
    expected = error.details.errors;
  }
  assert.ok(expected.length > 0);
  const human = capturedIo();
  assert.equal(await runCli(['evaluate', 'run', 'unused', profilePath], human), 1);
  for (const detail of expected) {
    assert.ok(human.stderr.value.includes(`${detail.path}: ${detail.message} (${detail.code})`));
  }
  const json = capturedIo();
  assert.equal(await runCli(['evaluate', 'run', 'unused', profilePath, '--json'], json), 1);
  assert.deepEqual(JSON.parse(json.stderr.value).error.details.errors, expected);
  assert.equal(human.stdout.value, '');
});

test('node retry forwards the explicit request without starting an executor', async (t) => {
  const requests = [];
  t.mock.method(FwaApplication.prototype, 'retryNode', async (request) => {
    requests.push(request);
    return { appended: true, commandId: request.commandId, mode: 'retry', node: { id: request.nodeId } };
  });
  t.mock.method(FwaApplication.prototype, 'runNext', async () => assert.fail('retry must not execute'));
  const io = capturedIo();
  assert.equal(await runCli([
    'node', 'retry', 'fix-counter', '--reason', 'Correct the failed assertion',
    '--command-id', 'retry-counter', '--json'
  ], io), 0, io.stderr.value);
  assert.deepEqual(requests, [{
    nodeId: 'fix-counter', reason: 'Correct the failed assertion', commandId: 'retry-counter'
  }]);
  assert.equal(JSON.parse(io.stdout.value).mode, 'retry');
  const human = capturedIo();
  assert.equal(await runCli(['node', 'retry', 'fix-counter'], human), 0);
  assert.match(human.stdout.value, /no executor was started/u);
});

test('node retry rejects malformed commands before calling the application', async () => {
  for (const args of [
    ['node', 'retry'],
    ['node', 'retry', 'one', 'two'],
    ['node', 'retry', 'one', '--executor', 'codex'],
    ['node', 'retry', 'one', '--reason'],
    ['status', '--reason', 'not applicable']
  ]) {
    const io = capturedIo();
    assert.equal(await runCli([...args, '--json'], io), 2);
    assert.equal(JSON.parse(io.stderr.value).error.code, 'invalid-usage');
  }
});

test('Git fence recovery requires an explicit operator assertion and forwards the expected identity', async (t) => {
  const requests = [];
  t.mock.method(GitWorktreeAdapter.prototype, 'recoverProcessFence', async (request) => {
    requests.push(request);
    return { recovered: true, fenceId: request.expectedFenceId, receiptPath: 'retained-receipt' };
  });
  for (const args of [
    ['git', 'recover'],
    ['git', 'recover', '--fence-id', 'one'],
    ['git', 'recover', '--confirm-processes-stopped'],
    ['git', 'recover', '--fence-id', 'one', '--confirm-processes-stopped', '--command-id', 'invalid']
  ]) {
    const io = capturedIo();
    assert.equal(await runCli(args, io), 2);
  }
  assert.equal(requests.length, 0);
  const io = capturedIo();
  assert.equal(await runCli([
    'git', 'recover', '--fence-id', 'git-fence-test', '--confirm-processes-stopped', '--json'
  ], io), 0, io.stderr.value);
  assert.deepEqual(requests, [{ expectedFenceId: 'git-fence-test', confirmProcessesStopped: true }]);
  assert.equal(JSON.parse(io.stdout.value).recovered, true);
});

test('Git fence inspection reports a blocker without making a recovery assertion', async (t) => {
  let held = true;
  t.mock.method(GitWorktreeAdapter.prototype, 'inspectProcessFence', async () => ({
    held, path: 'fence.json', fence: held ? { id: 'git-fence-test' } : null
  }));
  const blocked = capturedIo();
  assert.equal(await runCli(['git', 'fence', '--json'], blocked), 1);
  assert.equal(JSON.parse(blocked.stdout.value).held, true);
  held = false;
  const clear = capturedIo();
  assert.equal(await runCli(['git', 'fence'], clear), 0);
  assert.match(clear.stdout.value, /does not verify the whole project/u);
});

test('recovering one Git fence does not report success while another failure still blocks work', async (t) => {
  t.mock.method(GitWorktreeAdapter.prototype, 'recoverProcessFence', async () => ({
    recovered: true, fenceId: 'old', receiptPath: 'receipt', held: true, remainingFenceId: 'new'
  }));
  const io = capturedIo();
  assert.equal(await runCli([
    'git', 'recover', '--fence-id', 'old', '--confirm-processes-stopped'
  ], io), 1);
  assert.match(io.stdout.value, /remain blocked by new/u);
});
