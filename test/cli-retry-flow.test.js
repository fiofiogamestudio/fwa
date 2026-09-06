import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/fwa.js', import.meta.url));

test('installed CLI repairs a rejected Node within budget and integrates only the new accepted attempt', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fwa-cli-retry-flow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  const inputs = path.join(directory, 'inputs');
  await mkdir(project);
  await mkdir(inputs);
  function git(...args) {
    const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  }
  function command(args, expectedExit = 0) {
    const result = spawnSync(process.execPath, [cli, ...args, '--project', project, '--json'], {
      cwd: inputs, encoding: 'utf8', windowsHide: true, timeout: 120_000
    });
    assert.equal(result.status, expectedExit, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout || result.stderr);
  }
  async function json(name, value) {
    await writeFile(path.join(inputs, name), JSON.stringify(value));
    return name;
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'FWA Retry Test');
  git('config', 'user.email', 'fwa-retry@example.invalid');
  await writeFile(path.join(project, '.gitignore'), '/.fwa/\n');
  git('add', '.gitignore');
  git('commit', '--no-gpg-sign', '-m', 'test: initialize retry fixture');
  command(['init']);
  const created = command(['goal', 'create', 'Retry acceptance safely']);
  const plan = await json('plan.json', {
    schemaVersion: 1, goalId: created.goal.id,
    nodes: [{
      id: 'calculate', dependsOn: [], reads: [], writes: ['generated/value.cjs'],
      capabilities: ['file_operations'], acceptance: { checks: ['output-is-3'] },
      budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 20 }
    }]
  });
  command(['plan', 'load', created.goal.id, plan]);
  const profile = await json('acceptance.json', {
    schemaVersion: 1, id: 'retry-output', checks: [{
      id: 'output-is-3', kind: 'test', command: process.execPath,
      args: ['-e', "if(require('./generated/value.cjs')!==3)process.exit(7)"],
      timeoutMs: 10_000
    }]
  });
  const wrong = await json('wrong.json', {
    schemaVersion: 1, operations: [{ type: 'write', path: 'generated/value.cjs', content: 'module.exports = 2;\n' }]
  });
  const first = command(['run', 'next', wrong, '--node', 'calculate']);
  const rejected = command(['evaluate', 'run', first.changeSet.id, profile], 1);
  assert.equal(rejected.evaluation?.status, 'rejected', JSON.stringify(rejected));
  const retry = command(['node', 'retry', 'calculate', '--reason', 'Return the expected value', '--command-id', 'repair-calculation']);
  assert.equal(retry.appended, true);
  assert.equal(retry.mode, 'retry');
  const replay = command(['node', 'retry', 'calculate', '--reason', 'Return the expected value', '--command-id', 'repair-calculation']);
  assert.equal(replay.appended, false);
  const correct = await json('correct.json', {
    schemaVersion: 1, operations: [{ type: 'write', path: 'generated/value.cjs', content: 'module.exports = 3;\n' }]
  });
  const second = command(['run', 'next', correct, '--node', 'calculate']);
  assert.notEqual(second.run.id, first.run.id);
  const accepted = command(['evaluate', 'run', second.changeSet.id, profile]);
  assert.equal(accepted.evaluation.status, 'passed');
  const integrated = command(['integrate', 'apply', second.changeSet.id, '--target', 'main']);
  assert.equal(integrated.integration.status, 'integrated');
  const status = command(['status']);
  assert.equal(status.nodes[0].runIds.length, 2);
  assert.equal(status.nodes[0].acceptedChangeSetId, second.changeSet.id);
  assert.equal(status.evaluations.find((item) => item.id === rejected.evaluation.id).status, 'rejected');
  assert.equal(git('show', 'main:generated/value.cjs'), 'module.exports = 3;');
  assert.equal(command(['verify']).operationallyClean, true);
});
