import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexExecutor } from '../src/adapters/codex-executor.js';
import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { runCli } from '../src/cli.js';
import {
  FileEventStore,
  hashCanonicalValue
} from '../src/storage/file-event-store.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repositoryRoot, 'bin', 'fwa.js');

function run(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true
  });
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

async function temporaryDirectory(t, prefix = 'fwa-cli-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function capturedIo() {
  return {
    stdout: { value: '', write(chunk) { this.value += chunk; } },
    stderr: { value: '', write(chunk) { this.value += chunk; } }
  };
}

test('the installed entry point runs the full phase-one command chain', async (t) => {
  const project = await temporaryDirectory(t);
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'user.name', 'FWA CLI Test');
  git(project, 'config', 'user.email', 'fwa-cli@example.invalid');
  await writeFile(path.join(project, '.gitignore'), '/.fwa/\n', 'utf8');
  git(project, 'add', '--', '.gitignore');
  git(project, 'commit', '--no-gpg-sign', '-m', 'test: initialize CLI fixture');
  const initialized = parseSuccess(run('init', '--project', project, '--json'));
  assert.equal(initialized.initialized, true);

  const created = parseSuccess(run(
    'goal', 'create', 'CLI goal',
    '--request', 'Exercise the durable command path.',
    '--command-id', 'cli-create',
    '--project', project,
    '--json'
  ));
  const planPath = path.join(project, 'plan.json');
  await writeFile(planPath, `\uFEFF${JSON.stringify({
    schemaVersion: 1,
    goalId: created.goal.id,
    nodes: [{
      id: 'only-node',
      dependsOn: [],
      reads: ['src/**'],
      writes: ['out/**'],
      capabilities: ['script'],
      acceptance: { commands: ['node --test'] },
      budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 100 }
    }]
  }, null, 2)}\n`, 'utf8');

  const loaded = parseSuccess(run(
    'plan', 'load', created.goal.id, planPath,
    '--command-id', 'cli-plan',
    '--project', project,
    '--json'
  ));
  assert.equal(loaded.nodes[0].status, 'ready');

  const status = parseSuccess(run('status', '--project', project, '--json'));
  assert.equal(status.eventCount, 4);
  assert.equal(status.goals[0].status, 'planned');
  assert.equal(status.nodes[0].status, 'ready');
  assert.deepEqual(status.integrations, []);
  assert.deepEqual(status.projectRevisions, []);

  const events = parseSuccess(run('events', '--project', project, '--json'));
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);

  const verification = parseSuccess(run('verify', '--project', project, '--json'));
  assert.equal(verification.ok, true);
  assert.equal(verification.eventCount, 4);
  assert.equal(verification.integrationCount, 0);
  assert.equal(verification.projectRevisionCount, 0);
  assert.equal(verification.gitVerifiedIntegrationCount, 0);

  const reconciliation = parseSuccess(run(
    'run', 'reconcile',
    '--correlation-id', 'cli-reconcile-attempt',
    '--project', project,
    '--json'
  ));
  assert.equal(reconciliation.reconciled, false);
  assert.equal(reconciliation.reason, 'workspace-free');

  const falseIdempotency = run(
    'run', 'reconcile',
    '--command-id', 'not-an-idempotency-key',
    '--project', project,
    '--json'
  );
  assert.equal(falseIdempotency.status, 2);
  assert.equal(JSON.parse(falseIdempotency.stderr).error.code, 'invalid-usage');
});

test('installed CLI runs Slices B, C1, and C2a end to end for a Git project path with spaces', async (t) => {
  const project = await temporaryDirectory(t, 'fwa cli git project ');
  const inputs = await temporaryDirectory(t, 'fwa cli inputs ');
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'user.name', 'FWA CLI Test');
  git(project, 'config', 'user.email', 'fwa-cli@example.invalid');
  git(project, 'config', 'core.ignorecase', 'false');
  await writeFile(path.join(project, '.gitignore'), '/.fwa/\n', 'utf8');
  await writeFile(path.join(project, 'seed.txt'), 'seed\n', 'utf8');
  git(project, 'add', '.gitignore', 'seed.txt');
  git(project, 'commit', '--no-gpg-sign', '-m', 'establish CLI base');
  const baseRevision = git(project, 'rev-parse', 'HEAD').stdout.trim();

  parseSuccess(run('init', '--project', project, '--json'));
  const created = parseSuccess(run(
    'goal', 'create', 'CLI Slice B goal',
    '--command-id', 'cli-slice-b-goal',
    '--project', project,
    '--json'
  ));
  const planPath = path.join(inputs, 'plan with spaces.json');
  await writeFile(planPath, `${JSON.stringify({
    schemaVersion: 1,
    goalId: created.goal.id,
    nodes: [{
      id: 'write-output',
      dependsOn: [],
      reads: ['seed.txt'],
      writes: ['generated/**'],
      capabilities: ['file_operations'],
      acceptance: { checks: ['captured'] },
      budget: { maxRetries: 0, maxFiles: 2, maxDiffLines: 20 }
    }]
  }, null, 2)}\n`, 'utf8');
  parseSuccess(run(
    'plan', 'load', created.goal.id, planPath,
    '--command-id', 'cli-slice-b-plan',
    '--project', project,
    '--json'
  ));
  const operationsPath = path.join(inputs, 'operations with spaces.json');
  await writeFile(operationsPath, `\uFEFF${JSON.stringify({
    schemaVersion: 1,
    operations: [{
      type: 'write',
      path: 'generated/output.txt',
      content: '你好，FWA。\n'
    }]
  }, null, 2)}\n`, 'utf8');

  const produced = parseSuccess(run(
    'run', 'next', operationsPath,
    '--command-id', 'cli-slice-b-run',
    '--project', project,
    '--json'
  ));
  assert.equal(produced.ok, true);
  assert.equal(produced.run.workspaceStatus, 'removed');
  assert.equal(produced.changeSet.baseRevision, baseRevision);
  assert.deepEqual(produced.changeSet.changedFiles, ['generated/output.txt']);
  assert.equal(
    git(project, 'rev-parse', produced.changeSet.ref).stdout.trim(),
    produced.changeSet.headRevision
  );
  assert.equal(git(project, 'status', '--porcelain').stdout, '');

  const evaluationProfilePath = path.join(inputs, 'evaluation profile.json');
  await writeFile(evaluationProfilePath, `${JSON.stringify({
    schemaVersion: 1,
    id: 'cli-slice-c1',
    checks: [{
      id: 'captured',
      kind: 'test',
      command: process.execPath,
      args: [
        '-e',
        "const fs=require('node:fs');if(!fs.readFileSync('generated/output.txt','utf8').length)process.exit(7)"
      ],
      timeoutMs: 5_000
    }]
  }, null, 2)}\n`, 'utf8');
  const evaluationRun = run(
    'evaluate', 'run', produced.changeSet.id, evaluationProfilePath,
    '--command-id', 'cli-slice-c1-evaluation',
    '--project', project,
    '--json'
  );
  assert.equal(
    evaluationRun.status,
    0,
    `stdout:\n${evaluationRun.stdout}\nstderr:\n${evaluationRun.stderr}`
  );
  const evaluated = JSON.parse(evaluationRun.stdout);
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.evaluation.status, 'passed');
  assert.equal(evaluated.evaluation.workspaceStatus, 'removed');
  assert.equal(evaluated.node.status, 'accepted');
  assert.equal(evaluated.node.integrationStatus, null);
  assert.equal(evaluated.evidence.result, 'pass');
  assert.equal(evaluated.evidence.changeSetId, produced.changeSet.id);
  assert.equal(git(project, 'status', '--porcelain').stdout, '');

  const integrationRun = run(
    'integrate', 'apply', produced.changeSet.id,
    '--target', 'main',
    '--command-id', 'cli-slice-c2a-integration',
    '--project', project,
    '--json'
  );
  assert.equal(
    integrationRun.status,
    0,
    `stdout:\n${integrationRun.stdout}\nstderr:\n${integrationRun.stderr}`
  );
  const integrated = JSON.parse(integrationRun.stdout);
  assert.equal(integrated.ok, true);
  assert.equal(integrated.integration.status, 'integrated');
  assert.equal(integrated.integration.targetRef, 'refs/heads/main');
  assert.equal(integrated.node.status, 'accepted');
  assert.equal(integrated.node.integrationStatus, 'integrated');
  assert.equal(integrated.cleanup.leaseReleased, true);
  assert.equal(
    git(project, 'rev-parse', 'main').stdout.trim(),
    integrated.integration.integratedRevision
  );
  assert.notEqual(
    integrated.integration.integratedRevision,
    produced.changeSet.headRevision
  );
  assert.equal(
    git(project, 'rev-parse', `${integrated.integration.integratedRevision}^`).stdout.trim(),
    baseRevision
  );
  assert.equal(
    git(project, 'rev-parse', `${integrated.integration.integratedRevision}^{tree}`).stdout.trim(),
    git(project, 'rev-parse', `${produced.changeSet.headRevision}^{tree}`).stdout.trim()
  );
  assert.equal(git(project, 'status', '--porcelain').stdout, '');

  const integrationReplay = parseSuccess(run(
    'integrate', 'apply', produced.changeSet.id,
    '--target', 'refs/heads/main',
    '--command-id', 'cli-slice-c2a-integration',
    '--project', project,
    '--json'
  ));
  assert.equal(integrationReplay.appended, false);
  assert.equal(integrationReplay.integration.id, integrated.integration.id);

  const humanStatus = run('status', '--project', project);
  assert.equal(humanStatus.status, 0, humanStatus.stderr);
  assert.match(humanStatus.stdout, /workspace=removed; cleanup-failures=0/u);
  assert.match(humanStatus.stdout, /Integrations: 1/u);
  assert.match(humanStatus.stdout, /Project revisions: 1/u);
  const humanVerification = run('verify', '--project', project);
  assert.equal(humanVerification.status, 0, humanVerification.stderr);
  assert.match(humanVerification.stdout, /FWA integrity OK/u);
  assert.match(humanVerification.stdout, /1 evaluation\(s\), 1 evidence item\(s\)/u);
  assert.match(
    humanVerification.stdout,
    /1 integration\(s\), 0 reversion\(s\), 1 project revision\(s\)/u
  );
});

test('CLI verify rejects a batch-valid but domain-invalid event', async (t) => {
  const project = await temporaryDirectory(t, 'fwa-cli-invalid-');
  const application = new FwaApplication(project);
  await application.init();
  const store = new FileEventStore(project);
  await store.appendBatch('invalid-domain-event', [{
    sequence: 1,
    hash: 'not-an-event-envelope'
  }], {
    expectedLastSequence: 0,
    intentHash: hashCanonicalValue({ command: 'invalid-domain-event' })
  });

  const result = run('verify', '--project', project, '--json');
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'event-envelope-invalid');
});

test('CLI reports malformed usage without a stack trace', () => {
  const result = run('goal', 'create', '--json');
  assert.equal(result.status, 2);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.code, 'invalid-usage');
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('CLI help advertises the bounded integration commands', () => {
  const result = run('help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /fwa integrate apply <changeset-id> --target <branch>/u
  );
  assert.match(
    result.stdout,
    /fwa integrate reconcile \[--confirm-processes-stopped\]/u
  );
  assert.match(result.stdout, /fwa integrate gated <changeset-id> <profile\.json>/u);
  assert.match(result.stdout, /fwa revert run <changeset-id> <profile\.json>/u);
  assert.match(
    result.stdout,
    /fwa revert reconcile \[--confirm-processes-stopped\]/u
  );
  assert.match(result.stdout, /exact-base local target branch/u);
  assert.doesNotMatch(result.stdout, /integration only fast-forwards/u);
});

test('integrate apply exits successfully only after lease release is confirmed', async (t) => {
  const original = FwaApplication.prototype.integrateChangeSet;
  t.after(() => {
    FwaApplication.prototype.integrateChangeSet = original;
  });
  const invoke = async (cleanup) => {
    FwaApplication.prototype.integrateChangeSet = async () => ({
      ok: true,
      appended: true,
      changeSet: { id: 'changeset_test' },
      integration: {
        id: 'integration_test',
        status: 'integrated',
        targetRef: 'refs/heads/main'
      },
      node: { id: 'node_test', status: 'accepted' },
      cleanup
    });
    const stdout = { value: '', write(chunk) { this.value += chunk; } };
    const stderr = { value: '', write(chunk) { this.value += chunk; } };
    const code = await runCli([
      'integrate', 'apply', 'changeset_test',
      '--target', 'main',
      '--project', repositoryRoot,
      '--json'
    ], { cwd: repositoryRoot, stdout, stderr });
    assert.equal(stderr.value, '');
    return code;
  };

  assert.equal(await invoke({ warnings: [] }), 1);
  assert.equal(await invoke({ leaseReleased: false, warnings: [] }), 1);
  assert.equal(await invoke({ leaseReleased: true, warnings: [] }), 0);
});

test('integrate apply requires exactly one explicit target before touching state', () => {
  const missing = path.join(repositoryRoot, 'definitely-missing-integration-project');
  const absent = run(
    'integrate', 'apply', 'changeset_missing',
    '--project', missing,
    '--json'
  );
  assert.equal(absent.status, 2);
  assert.match(JSON.parse(absent.stderr).error.message, /--target is required/u);

  const duplicate = run(
    'integrate', 'apply', 'changeset_missing',
    '--target', 'main',
    '--target', 'release',
    '--project', missing,
    '--json'
  );
  assert.equal(duplicate.status, 2);
  assert.match(JSON.parse(duplicate.stderr).error.message, /--target may be provided only once/u);
});

test('a missing option value cannot consume the next option or mutate state', async (t) => {
  const project = await temporaryDirectory(t, 'fwa-cli-option-');
  parseSuccess(run('init', '--project', project, '--json'));

  const result = run(
    'goal', 'create', 'Must not persist',
    '--request', '--json',
    '--project', project
  );
  assert.equal(result.status, 2);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.code, 'invalid-usage');
  assert.match(failure.error.message, /--request requires a value/);

  const status = parseSuccess(run('status', '--project', project, '--json'));
  assert.equal(status.eventCount, 0);
});

test('CLI validates an unknown command before touching its project path', () => {
  const missing = path.join(repositoryRoot, 'definitely-missing-fwa-project');
  const result = run('unknown', '--project', missing, '--json');
  assert.equal(result.status, 2);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.code, 'invalid-usage');
  assert.match(failure.error.message, /Unknown command/);
});

test('runCli contains invalid programmatic argv inside its error contract', async () => {
  const output = { value: '', write(chunk) { this.value += chunk; } };
  const errors = { value: '', write(chunk) { this.value += chunk; } };
  const code = await runCli([null], {
    cwd: repositoryRoot,
    stdout: output,
    stderr: errors
  });

  assert.equal(code, 1);
  assert.equal(output.value, '');
  assert.match(errors.value, /argv must be an array of strings/);
});

test('CLI registers, lists, and shows logical Refs through durable state', async (t) => {
  const project = await temporaryDirectory(t, 'fwa-cli-refs-');
  const inputs = await temporaryDirectory(t, 'fwa-cli-ref-inputs-');
  parseSuccess(run('init', '--project', project, '--json'));
  const refPath = path.join(inputs, 'player ref.json');
  const ref = {
    id: 'ref://code/player-controller',
    kind: 'code',
    uri: 'Assets/Scripts/PlayerController.cs',
    version: 'initial',
    hash: `sha256:${'0'.repeat(64)}`,
    metadata: { owner: 'gameplay' }
  };
  await writeFile(refPath, `${JSON.stringify(ref, null, 2)}\n`, 'utf8');

  const registered = parseSuccess(run(
    'ref', 'register', refPath,
    '--command-id', 'cli-register-player-ref',
    '--project', project,
    '--json'
  ));
  assert.equal(registered.appended, true);
  assert.equal(registered.ref.id, ref.id);

  const listed = parseSuccess(run('ref', 'list', '--project', project, '--json'));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, ref.id);
  assert.equal(listed[0].uri, ref.uri);

  const shown = parseSuccess(run(
    'ref', 'show', ref.id,
    '--project', project,
    '--json'
  ));
  assert.deepEqual(shown, listed[0]);

  const missing = run(
    'ref', 'show', 'ref://code/missing',
    '--project', project,
    '--json'
  );
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stderr).error.code, 'ref-not-found');
});

test('run --executor codex constructs the Codex adapter and forwards its input', async (t) => {
  const inputs = await temporaryDirectory(t, 'fwa-cli-codex-inputs-');
  const inputPath = path.join(inputs, 'codex input.json');
  const input = {
    schemaVersion: 1,
    prompt: 'Implement the selected ready node.'
  };
  await writeFile(inputPath, `${JSON.stringify(input)}\n`, 'utf8');
  const original = FwaApplication.prototype.runNext;
  let received;
  t.after(() => {
    FwaApplication.prototype.runNext = original;
  });
  FwaApplication.prototype.runNext = async (options) => {
    received = options;
    return {
      ok: true,
      run: { id: 'run_codex_cli' },
      node: { id: 'node_codex_cli' },
      changeSet: { id: 'changeset_codex_cli', ref: 'refs/fwa/runs/run_codex_cli' },
      cleanup: { worktreeRemoved: true, leaseReleased: true, warnings: [] }
    };
  };
  const stdout = { value: '', write(chunk) { this.value += chunk; } };
  const stderr = { value: '', write(chunk) { this.value += chunk; } };

  const code = await runCli([
    'run', 'next', inputPath,
    '--executor', 'codex',
    '--project', repositoryRoot,
    '--json'
  ], { cwd: repositoryRoot, stdout, stderr });

  assert.equal(code, 0, stderr.value);
  assert.equal(stderr.value, '');
  assert.ok(received.executor instanceof CodexExecutor);
  assert.deepEqual(received.input, input);
  assert.equal(received.workspace.projectRoot, repositoryRoot);
  assert.equal(JSON.parse(stdout.value).changeSet.id, 'changeset_codex_cli');
});

test('evaluate run rejects missing or surplus positional arguments before project access', () => {
  const missingProject = path.join(repositoryRoot, 'definitely-missing-evaluation-project');
  const tooFew = run(
    'evaluate', 'run', 'changeset_missing',
    '--project', missingProject,
    '--json'
  );
  assert.equal(tooFew.status, 2);
  assert.match(JSON.parse(tooFew.stderr).error.message, /Expected: fwa evaluate run/u);

  const tooMany = run(
    'evaluate', 'run', 'changeset_missing', 'profile.json', 'surplus',
    '--project', missingProject,
    '--json'
  );
  assert.equal(tooMany.status, 2);
  assert.match(JSON.parse(tooMany.stderr).error.message, /Expected: fwa evaluate run/u);
});

test('public entry points expose optional Codex, Unity, and integration components', async () => {
  const applicationApi = await import('fwa');
  const codexApi = await import('fwa/adapters/codex-executor');
  const unityApi = await import('fwa/adapters/unity-evaluator-profile');
  const workspaceApi = await import('fwa/adapters/git-integration-workspace');
  const regressionApi = await import('fwa/application/integration-regression-gate');

  assert.equal(applicationApi.CodexExecutor, codexApi.CodexExecutor);
  assert.equal(applicationApi.createUnityEvaluatorProfile, unityApi.createUnityEvaluatorProfile);
  assert.equal(
    applicationApi.GitIntegrationWorkspaceAdapter,
    workspaceApi.GitIntegrationWorkspaceAdapter
  );
  assert.equal(
    applicationApi.runIntegrationRegressionGate,
    regressionApi.runIntegrationRegressionGate
  );
});

test('integrate gated wires the candidate, regression, evaluation, and promotion adapters', async (t) => {
  const inputs = await temporaryDirectory(t, 'fwa-cli-gated-inputs-');
  const profilePath = path.join(inputs, 'regression profile.json');
  const profile = {
    schemaVersion: 1,
    id: 'cli-regression',
    checks: [
      { id: 'compile', kind: 'compile', command: 'compile', args: [], timeoutMs: 1000 },
      { id: 'test', kind: 'test', command: 'test', args: [], timeoutMs: 1000 }
    ]
  };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`, 'utf8');
  const original = FwaApplication.prototype.integrateChangeSetGated;
  let received;
  t.after(() => {
    FwaApplication.prototype.integrateChangeSetGated = original;
  });
  FwaApplication.prototype.integrateChangeSetGated = async (options) => {
    received = options;
    return {
      ok: true,
      appended: true,
      changeSet: { id: 'changeset_gated' },
      integration: {
        id: 'integration_gated',
        status: 'integrated',
        targetRef: 'refs/heads/main'
      },
      cleanup: { candidateWorkspaceRemoved: true, leaseReleased: true, warnings: [] }
    };
  };
  const io = capturedIo();

  const code = await runCli([
    'integrate', 'gated', 'changeset_gated', profilePath,
    '--target', 'main',
    '--command-id', 'cli-gated',
    '--project', repositoryRoot,
    '--json'
  ], { cwd: repositoryRoot, ...io });

  assert.equal(code, 0, io.stderr.value);
  assert.equal(io.stderr.value, '');
  assert.ok(received.candidateWorkspace instanceof GitIntegrationWorkspaceAdapter);
  assert.ok(received.promotion instanceof GitIntegrationAdapter);
  assert.ok(received.evaluator instanceof CommandEvaluator);
  assert.ok(received.evaluationWorkspace instanceof GitWorktreeAdapter);
  assert.deepEqual(received.profile, profile);
  assert.equal(received.targetRef, 'main');
  assert.equal(received.commandId, 'cli-gated');
  assert.equal(JSON.parse(io.stdout.value).integration.status, 'integrated');
});

test('revert run wires isolated candidate and regression adapters', async (t) => {
  const inputs = await temporaryDirectory(t, 'fwa-cli-revert-inputs-');
  const profilePath = path.join(inputs, 'reversion profile.json');
  const profile = {
    schemaVersion: 1,
    id: 'cli-reversion',
    checks: [
      { id: 'compile', kind: 'compile', command: 'compile', args: [], timeoutMs: 1000 },
      { id: 'test', kind: 'test', command: 'test', args: [], timeoutMs: 1000 }
    ]
  };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`, 'utf8');
  const original = FwaApplication.prototype.revertChangeSet;
  let received;
  t.after(() => {
    FwaApplication.prototype.revertChangeSet = original;
  });
  FwaApplication.prototype.revertChangeSet = async (options) => {
    received = options;
    return {
      ok: true,
      appended: true,
      reversion: {
        id: 'reversion_cli',
        status: 'reverted',
        sourceChangeSetId: 'changeset_integrated',
        targetRef: 'refs/heads/main',
        affectedNodeIds: ['dependent']
      },
      revertChangeSet: { id: 'changeset_revert' },
      cleanup: { candidateWorkspaceRemoved: true, leaseReleased: true, warnings: [] }
    };
  };
  const io = capturedIo();

  const code = await runCli([
    'revert', 'run', 'changeset_integrated', profilePath,
    '--target', 'main',
    '--command-id', 'cli-revert',
    '--project', repositoryRoot,
    '--json'
  ], { cwd: repositoryRoot, ...io });

  assert.equal(code, 0, io.stderr.value);
  assert.equal(io.stderr.value, '');
  assert.ok(received.candidateWorkspace instanceof GitIntegrationWorkspaceAdapter);
  assert.ok(received.promotion instanceof GitIntegrationAdapter);
  assert.ok(received.evaluator instanceof CommandEvaluator);
  assert.ok(received.evaluationWorkspace instanceof GitWorktreeAdapter);
  assert.deepEqual(received.profile, profile);
  assert.equal(received.targetRef, 'main');
  assert.equal(received.commandId, 'cli-revert');
  assert.equal(JSON.parse(io.stdout.value).reversion.status, 'reverted');
});

test('revert reconcile uses the promotion adapter and preserves no-op success', async (t) => {
  const original = FwaApplication.prototype.reconcileReversion;
  let received;
  t.after(() => {
    FwaApplication.prototype.reconcileReversion = original;
  });
  FwaApplication.prototype.reconcileReversion = async (options) => {
    received = options;
    return {
      ok: true,
      reconciled: false,
      reason: 'workspace-free',
      cleanup: { warnings: [] }
    };
  };
  const io = capturedIo();

  const code = await runCli([
    'revert', 'reconcile',
    '--correlation-id', 'cli-revert-reconcile',
    '--project', repositoryRoot,
    '--json'
  ], { cwd: repositoryRoot, ...io });

  assert.equal(code, 0, io.stderr.value);
  assert.equal(io.stderr.value, '');
  assert.equal(received.correlationId, 'cli-revert-reconcile');
  assert.ok(received.promotion instanceof GitIntegrationAdapter);
  assert.equal(JSON.parse(io.stdout.value).reason, 'workspace-free');
});

test('reconcile commands forward explicit process-stop confirmation', async (t) => {
  const originalIntegration = FwaApplication.prototype.reconcileIntegration;
  const originalReversion = FwaApplication.prototype.reconcileReversion;
  const received = {};
  t.after(() => {
    FwaApplication.prototype.reconcileIntegration = originalIntegration;
    FwaApplication.prototype.reconcileReversion = originalReversion;
  });
  const noOp = {
    ok: true,
    reconciled: false,
    reason: 'nothing-to-reconcile',
    cleanup: { warnings: [] }
  };
  FwaApplication.prototype.reconcileIntegration = async (options) => {
    received.integration = options;
    return noOp;
  };
  FwaApplication.prototype.reconcileReversion = async (options) => {
    received.reversion = options;
    return noOp;
  };

  for (const command of [['integrate', 'reconcile'], ['revert', 'reconcile']]) {
    const io = capturedIo();
    const code = await runCli([
      ...command,
      '--confirm-processes-stopped',
      '--project', repositoryRoot,
      '--json'
    ], { cwd: repositoryRoot, ...io });
    assert.equal(code, 0, io.stderr.value);
  }

  assert.equal(received.integration.confirmProcessesStopped, true);
  assert.equal(typeof received.integration.evaluationWorkspace.removeEvaluation, 'function');
  assert.ok(received.integration.workspace instanceof GitIntegrationAdapter);
  assert.equal(received.reversion.confirmProcessesStopped, true);
  assert.equal(typeof received.reversion.evaluationWorkspace.removeEvaluation, 'function');
  assert.ok(received.reversion.promotion instanceof GitIntegrationAdapter);
});

test('reconcile commands exit non-zero when candidate cleanup is not proven', async (t) => {
  const originalIntegration = FwaApplication.prototype.reconcileIntegration;
  const originalReversion = FwaApplication.prototype.reconcileReversion;
  t.after(() => {
    FwaApplication.prototype.reconcileIntegration = originalIntegration;
    FwaApplication.prototype.reconcileReversion = originalReversion;
  });
  const result = {
    ok: true,
    reconciled: false,
    reason: 'state-changed',
    cleanup: {
      candidateWorkspaceRemoved: false,
      leaseReleased: true,
      warnings: [{
        phase: 'candidate-workspace-cleanup',
        failure: {
          code: 'SIMULATED_RECONCILE_CLEANUP_FAILURE',
          message: 'candidate cleanup was not confirmed',
          details: null
        }
      }]
    }
  };
  FwaApplication.prototype.reconcileIntegration = async () => result;
  FwaApplication.prototype.reconcileReversion = async () => result;

  for (const command of [['integrate', 'reconcile'], ['revert', 'reconcile']]) {
    const io = capturedIo();
    const code = await runCli([
      ...command,
      '--project', repositoryRoot,
      '--json'
    ], { cwd: repositoryRoot, ...io });
    assert.equal(code, 1);
    assert.equal(JSON.parse(io.stdout.value).cleanup.candidateWorkspaceRemoved, false);
    assert.match(io.stderr.value, /\[cleanup-warning\].*candidate cleanup was not confirmed/u);
  }
});

test('human status and verify output expose stale and Reversion recovery residue', async (t) => {
  const originalStatus = FwaApplication.prototype.getStatus;
  const originalVerify = FwaApplication.prototype.verify;
  t.after(() => {
    FwaApplication.prototype.getStatus = originalStatus;
    FwaApplication.prototype.verify = originalVerify;
  });
  FwaApplication.prototype.getStatus = async () => ({
    projectRoot: repositoryRoot,
    lastSequence: 10,
    batchCount: 5,
    eventCount: 10,
    goals: [],
    refs: [],
    nodes: [{
      id: 'dependent',
      title: 'Dependent node',
      status: 'ready',
      validity: 'stale',
      integrationStatus: null,
      staleByReversionIds: ['reversion_recovery']
    }],
    runs: [],
    changeSets: [],
    evaluations: [],
    evidence: [],
    integrations: [],
    reversions: [{
      id: 'reversion_recovery',
      status: 'recovery-required',
      sourceChangeSetId: 'changeset_source',
      targetRef: 'refs/heads/main',
      affectedNodeIds: ['dependent']
    }],
    projectRevisions: []
  });
  let io = capturedIo();
  let code = await runCli(['status', '--project', repositoryRoot], {
    cwd: repositoryRoot,
    ...io
  });
  assert.equal(code, 0, io.stderr.value);
  assert.match(io.stdout.value, /Stale nodes: 1/u);
  assert.match(
    io.stdout.value,
    /dependent  integrations=-  reversions=reversion_recovery/u
  );
  assert.match(io.stdout.value, /Reversions: 1/u);
  assert.match(io.stdout.value, /\[recovery-required\]/u);
  assert.match(io.stdout.value, /Recovery required: evaluations=0, integrations=0, reversions=1/u);

  FwaApplication.prototype.verify = async () => ({
    operationallyClean: false,
    batchCount: 5,
    eventCount: 10,
    goalCount: 1,
    nodeCount: 1,
    runCount: 1,
    evaluationCount: 1,
    evidenceCount: 1,
    integrationCount: 1,
    reversionCount: 1,
    projectRevisionCount: 2,
    artifactCount: 2,
    activeRuns: [],
    activeEvaluations: [],
    evaluationRecoveryRequired: [],
    activeIntegrations: [],
    integrationRecoveryRequired: [],
    activeReversions: ['reversion_active'],
    reversionRecoveryRequired: ['reversion_recovery'],
    lease: { held: true },
    pendingWorkspaceCleanup: [],
    pendingEvaluationCleanup: [],
    preservedWorkspaces: [],
    preservedEvaluationWorkspaces: [],
    unknownWorkspaces: [],
    unknownEvaluationWorkspaces: [],
    unreferencedArtifacts: []
  });
  io = capturedIo();
  code = await runCli(['verify', '--project', repositoryRoot], {
    cwd: repositoryRoot,
    ...io
  });
  assert.equal(code, 1);
  assert.match(io.stdout.value, /1 reversion\(s\)/u);
  assert.match(io.stderr.value, /active-reversions=1/u);
  assert.match(io.stderr.value, /reversion-recovery-required=1/u);
});
