import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  COMMAND_EVALUATION_MANIFEST_SCHEMA_VERSION,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_LIMIT_BYTES,
  CommandEvaluator,
  CommandEvaluatorError,
  normalizeCommandEvaluationManifest
} from '../src/adapters/command-evaluator.js';
import {
  EVALUATOR_SCHEMA_VERSION,
  EvaluatorContractError,
  assertEvaluator,
  validateEvaluator
} from '../src/core/evaluator.js';

const temporaryRoots = new Set();

async function temporaryWorkspace(prefix = 'fwa-command-evaluator-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

test.afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => {
    await rm(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }));
});

function check(overrides = {}) {
  return {
    id: 'check-1',
    kind: 'test',
    command: process.execPath,
    args: ['-e', ''],
    timeoutMs: 5_000,
    ...overrides
  };
}

function manifest(checks) {
  return {
    schemaVersion: COMMAND_EVALUATION_MANIFEST_SCHEMA_VERSION,
    id: 'manifest-1',
    checks
  };
}

function environmentDigest(environment) {
  const serialized = JSON.stringify(
    Object.keys(environment)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [key, environment[key]])
  );
  return createHash('sha256').update(serialized).digest('hex');
}

test('defines and validates the pure evaluator descriptor contract', () => {
  const evaluator = new CommandEvaluator();
  assert.equal(evaluator.schemaVersion, EVALUATOR_SCHEMA_VERSION);
  assert.equal(assertEvaluator(evaluator), evaluator);
  assert.deepEqual(validateEvaluator(evaluator), { ok: true, errors: [] });

  assert.throws(
    () => assertEvaluator({ schemaVersion: 2, id: '', version: '', evaluate: null }),
    (error) => error instanceof EvaluatorContractError
      && error.code === 'FWA_INVALID_EVALUATOR'
      && error.errors.length === 5
  );
  assert.throws(
    () => new CommandEvaluator({ outputLimitBytes: MAX_OUTPUT_LIMIT_BYTES + 1 }),
    (error) => error instanceof CommandEvaluatorError
      && error.code === 'FWA_INVALID_OUTPUT_LIMIT'
  );
  const normalized = normalizeCommandEvaluationManifest(manifest([check()]));
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.checks), true);
  assert.equal(Object.isFrozen(normalized.checks[0]), true);
  assert.equal(Object.hasOwn(normalized.checks[0], 'captureOutput'), false);
  assert.deepEqual(evaluator.normalizeProfile(manifest([check()])), normalized);
  assert.deepEqual(evaluator.normalizeProfile(normalized), normalized);

  const withArtifact = evaluator.normalizeProfile(manifest([check({
    cwd: '.',
    expectedArtifacts: [{ path: 'result.txt' }]
  })]));
  assert.deepEqual(evaluator.normalizeProfile(withArtifact), withArtifact);

  const withoutOutputCapture = evaluator.normalizeProfile(manifest([check({
    captureOutput: false,
    expectedArtifacts: [{ path: 'result.txt' }]
  })]));
  assert.equal(withoutOutputCapture.checks[0].captureOutput, false);
  assert.deepEqual(evaluator.normalizeProfile(withoutOutputCapture), withoutOutputCapture);

  const explicitDefault = evaluator.normalizeProfile(manifest([check({ captureOutput: true })]));
  assert.equal(Object.hasOwn(explicitDefault.checks[0], 'captureOutput'), false);
});

test('runs argv directly, captures output, and returns verified artifact bytes', async () => {
  const workspaceRoot = await temporaryWorkspace();
  await mkdir(path.join(workspaceRoot, 'build'));
  const artifactBytes = Buffer.from([0, 255, 1, 128, 10]);
  const sha256 = createHash('sha256').update(artifactBytes).digest('hex');
  const calls = [];
  const evaluator = new CommandEvaluator({
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return spawn(command, args, options);
    }
  });
  const script = [
    "const fs = require('node:fs');",
    `fs.writeFileSync('result.bin', Buffer.from('${artifactBytes.toString('base64')}', 'base64'));`,
    "process.stdout.write('stdout-value');",
    "process.stderr.write('stderr-value');"
  ].join('');

  const result = await evaluator.evaluate({
    workspaceRoot,
    manifest: manifest([check({
      kind: 'compile',
      cwd: 'build',
      args: ['-e', script, 'literal && never-a-shell'],
      expectedArtifacts: [{ path: 'build/result.bin', size: artifactBytes.length, sha256 }]
    })])
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.evaluator, { id: 'command-evaluator', version: '1' });
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].status, 'passed');
  assert.equal(result.checks[0].stdout, 'stdout-value');
  assert.equal(result.checks[0].stderr, 'stderr-value');
  assert.equal(result.checks[0].exitCode, 0);
  assert.equal(result.checks[0].signal, null);
  assert.equal(result.checks[0].terminationConfirmed, true);
  assert.deepEqual(result.checks[0].args, ['-e', script, 'literal && never-a-shell']);
  assert.equal(result.checks[0].expectedArtifacts[0].digest, sha256);
  assert.equal(result.checks[0].expectedArtifacts[0].size, artifactBytes.length);
  assert.deepEqual(result.checks[0].expectedArtifacts[0].before, {
    existed: false,
    size: null,
    digest: null
  });
  assert.deepEqual(
    Buffer.from(result.checks[0].expectedArtifacts[0].bytesBase64, 'base64'),
    artifactBytes
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ['-e', script, 'literal && never-a-shell']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, path.join(workspaceRoot, 'build'));
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('can disable output capture only when an artifact carries the command evidence', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const calls = [];
  const evaluator = new CommandEvaluator({
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return spawn(command, args, options);
    }
  });
  const script = [
    "require('node:fs').writeFileSync('result.txt', 'artifact-value');",
    "process.stdout.write('discarded-stdout');",
    "process.stderr.write('discarded-stderr');"
  ].join('');
  const requestedManifest = manifest([check({
    args: ['-e', script],
    captureOutput: false,
    expectedArtifacts: [{ path: 'result.txt' }]
  })]);
  const normalized = evaluator.normalizeProfile(requestedManifest);

  assert.equal(normalized.checks[0].captureOutput, false);
  const result = await evaluator.evaluate({ workspaceRoot, manifest: normalized });

  assert.equal(result.passed, true);
  assert.equal(result.checks[0].stdout, '');
  assert.equal(result.checks[0].stderr, '');
  assert.equal(result.checks[0].stdoutBytes, 0);
  assert.equal(result.checks[0].stderrBytes, 0);
  assert.equal(result.checks[0].stdoutObservedBytes, 0);
  assert.equal(result.checks[0].stderrObservedBytes, 0);
  assert.equal(result.checks[0].stdoutTruncated, false);
  assert.equal(result.checks[0].stderrTruncated, false);
  assert.equal(result.checks[0].expectedArtifacts[0].passed, true);
  assert.equal(
    Buffer.from(result.checks[0].expectedArtifacts[0].bytesBase64, 'base64').toString('utf8'),
    'artifact-value'
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'ignore', 'ignore']);
});

test('rejects invalid or evidence-free captureOutput settings during normalization', () => {
  assert.throws(
    () => normalizeCommandEvaluationManifest(manifest([check({ captureOutput: 'false' })])),
    (error) => error instanceof CommandEvaluatorError
      && error.code === 'FWA_INVALID_EVALUATION_MANIFEST'
      && error.details.errors.some((item) => item.code === 'INVALID_CAPTURE_OUTPUT')
  );
  assert.throws(
    () => normalizeCommandEvaluationManifest(manifest([check({ captureOutput: false })])),
    (error) => error instanceof CommandEvaluatorError
      && error.code === 'FWA_INVALID_EVALUATION_MANIFEST'
      && error.details.errors.some((item) => (
        item.code === 'CAPTURE_OUTPUT_REQUIRES_EXPECTED_ARTIFACT'
      ))
  );
});

test('returns a failed result for nonzero exit and skips every later check', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const sentinel = path.join(workspaceRoot, 'must-not-run.txt');
  const result = await new CommandEvaluator().evaluate({
    workspaceRoot,
    manifest: manifest([
      check({
        id: 'failing',
        args: ['-e', "process.stderr.write('bad'); process.exit(7)"]
      }),
      check({
        id: 'later',
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`],
        expectedArtifacts: [{ path: 'must-not-run.txt' }]
      })
    ])
  });

  assert.equal(result.passed, false);
  assert.equal(result.checks[0].passed, false);
  assert.equal(result.checks[0].exitCode, 7);
  assert.equal(result.checks[0].failure.code, 'UNEXPECTED_EXIT_CODE');
  assert.equal(result.checks[1].status, 'skipped');
  assert.equal(result.checks[1].failure.code, 'FAIL_FAST');
  assert.equal(result.checks[1].expectedArtifacts.length, 1);
  assert.equal(
    result.checks[1].expectedArtifacts[0].failure.code,
    'EXPECTED_ARTIFACT_NOT_EVALUATED'
  );
  assert.equal(result.checks[1].expectedArtifacts[0].bytesBase64, null);
  assert.equal(await pathExists(sentinel), false);
});

test('missing and mismatched expected artifacts are evidence failures, not thrown verdicts', async () => {
  const cases = [
    {
      id: 'missing',
      script: '',
      expected: { path: 'missing.txt' },
      code: 'EXPECTED_ARTIFACT_MISSING'
    },
    {
      id: 'size',
      script: "require('node:fs').writeFileSync('size.txt', 'abc')",
      expected: { path: 'size.txt', size: 4 },
      code: 'EXPECTED_ARTIFACT_SIZE_MISMATCH'
    },
    {
      id: 'digest',
      script: "require('node:fs').writeFileSync('digest.txt', 'abc')",
      expected: { path: 'digest.txt', sha256: '0'.repeat(64) },
      code: 'EXPECTED_ARTIFACT_DIGEST_MISMATCH'
    }
  ];

  for (const example of cases) {
    const workspaceRoot = await temporaryWorkspace(`fwa-command-${example.id}-`);
    const result = await new CommandEvaluator().evaluate({
      workspaceRoot,
      manifest: manifest([check({
        id: example.id,
        args: ['-e', example.script],
        expectedArtifacts: [example.expected]
      })])
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks[0].failure.code, example.code);
    assert.equal(result.checks[0].expectedArtifacts[0].passed, false);
    assert.doesNotThrow(() => JSON.stringify(result));
  }
});

test('requires an expected artifact to be created or changed by its check', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const artifactPath = path.join(workspaceRoot, 'result.txt');
  await writeFile(artifactPath, 'stale');

  const unchanged = await new CommandEvaluator().evaluate({
    workspaceRoot,
    manifest: manifest([check({ expectedArtifacts: [{ path: 'result.txt' }] })])
  });
  assert.equal(unchanged.passed, false);
  assert.equal(unchanged.checks[0].failure.code, 'EXPECTED_ARTIFACT_NOT_UPDATED');
  assert.equal(unchanged.checks[0].expectedArtifacts[0].before.existed, true);
  assert.equal(
    unchanged.checks[0].expectedArtifacts[0].before.digest,
    unchanged.checks[0].expectedArtifacts[0].digest
  );

  const changed = await new CommandEvaluator().evaluate({
    workspaceRoot,
    manifest: manifest([check({
      args: ['-e', "require('node:fs').writeFileSync('result.txt', 'fresh')"],
      expectedArtifacts: [{ path: 'result.txt' }]
    })])
  });
  assert.equal(changed.passed, true);
  assert.notEqual(
    changed.checks[0].expectedArtifacts[0].before.digest,
    changed.checks[0].expectedArtifacts[0].digest
  );
  assert.equal(await readFile(artifactPath, 'utf8'), 'fresh');
});

test('timeout confirms grandchild termination before returning and prevents post-return writes', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const startedPath = path.join(workspaceRoot, 'grandchild-started.json');
  const requestPath = path.join(workspaceRoot, 'after-return.request');
  const responsePath = path.join(workspaceRoot, 'after-return.response');
  const grandchildScript = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid }));`,
    'setInterval(() => {',
    `if (fs.existsSync(${JSON.stringify(requestPath)})) {`,
    `fs.writeFileSync(${JSON.stringify(responsePath)}, fs.readFileSync(${JSON.stringify(requestPath)}));`,
    '}',
    '}, 25);',
    // A failing test must not leave a permanently running fixture process.
    'setTimeout(() => process.exit(0), 10_000);'
  ].join('');
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
    'process.stdout.write(JSON.stringify({ grandchildPid: child.pid }));',
    'setTimeout(() => process.exit(0), 10_000);'
  ].join('');
  let managedChild;
  let grandchildPid;
  const isAlive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const evaluator = new CommandEvaluator({
    spawnImpl: (command, args, options) => {
      managedChild = spawn(command, args, options);
      return managedChild;
    }
  });
  try {
    const result = await evaluator.evaluate({
      workspaceRoot,
      manifest: manifest([check({
        id: 'timeout-tree',
        args: ['-e', parentScript],
        // Allow fixture startup; this is not a promise that OS tree termination
        // completes within a fixed interval after the timeout is requested.
        timeoutMs: 1_000
      })])
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks[0].timedOut, true);
    assert.equal(result.checks[0].failure.code, 'COMMAND_TIMEOUT');
    assert.equal(result.checks[0].terminationConfirmed, true);
    const started = JSON.parse(await readFile(startedPath, 'utf8'));
    grandchildPid = started.pid;
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
    assert.equal(JSON.parse(result.checks[0].stdout).grandchildPid, grandchildPid);
    assert.equal(isAlive(grandchildPid), false, 'Grandchild must be gone when evaluation returns.');

    await writeFile(requestPath, `challenge-after-return-${Date.now()}`, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await pathExists(responsePath), false);
    assert.equal(isAlive(grandchildPid), false);
  } finally {
    if (grandchildPid === undefined && await pathExists(startedPath)) {
      grandchildPid = JSON.parse(await readFile(startedPath, 'utf8')).pid;
    }
    // Cleanup precedes the suite's temporary-directory removal and targets only
    // the two PIDs created and reported by this fixture.
    for (const pid of new Set([managedChild?.pid, grandchildPid])) {
      if (!isAlive(pid)) continue;
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            shell: false, windowsHide: true, stdio: 'ignore'
          });
          const timer = setTimeout(() => {
            try { killer.kill('SIGKILL'); } catch { /* The helper may have exited. */ }
            killer.unref();
            resolve();
          }, 5_000);
          const finish = () => { clearTimeout(timer); resolve(); };
          killer.once('error', finish);
          killer.once('close', finish);
        });
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(isAlive(pid), false, `Fixture process ${pid} survived cleanup.`);
    }
  }
});

test('kills a command and returns bounded evidence when either output stream exceeds its limit', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const evaluator = new CommandEvaluator({ outputLimitBytes: 1024 });
  const result = await evaluator.evaluate({
    workspaceRoot,
    manifest: manifest([check({
      id: 'too-loud',
      args: [
        '-e',
        "process.stdout.write('x'.repeat(128 * 1024)); setInterval(() => {}, 1000)"
      ]
    })])
  });

  assert.equal(result.passed, false);
  assert.equal(result.checks[0].failure.code, 'OUTPUT_LIMIT_EXCEEDED');
  assert.equal(result.checks[0].failure.details.stream, 'stdout');
  assert.equal(result.checks[0].stdoutTruncated, true);
  assert.equal(result.checks[0].stdoutBytes, 1024);
  assert.ok(Buffer.byteLength(result.checks[0].stdout) <= 1024);
});

test('validates every manifest entry and portable path before spawning anything', async () => {
  const workspaceRoot = await temporaryWorkspace();
  let spawnCount = 0;
  const evaluator = new CommandEvaluator({
    spawnImpl() {
      spawnCount += 1;
      throw new Error('must not spawn');
    }
  });
  const invalid = manifest([
    check({ id: 'would-run' }),
    check({
      id: 'invalid-later',
      cwd: '../outside',
      expectedArtifacts: [{ path: 'reports\\result.xml' }]
    })
  ]);

  await assert.rejects(
    evaluator.evaluate({ workspaceRoot, manifest: invalid }),
    (error) => error instanceof CommandEvaluatorError
      && error.code === 'FWA_INVALID_EVALUATION_MANIFEST'
      && error.details.errors.some((item) => item.code === 'PARENT_TRAVERSAL')
      && error.details.errors.some((item) => item.code === 'BACKSLASH_IN_PATH')
  );
  assert.equal(spawnCount, 0);

  await assert.rejects(
    evaluator.evaluate({
      workspaceRoot,
      manifest: manifest([check({ id: 'duplicate' }), check({ id: 'duplicate' })])
    }),
    (error) => error.code === 'FWA_INVALID_EVALUATION_MANIFEST'
      && error.details.errors.some((item) => item.code === 'DUPLICATE_CHECK_ID')
  );
  assert.equal(spawnCount, 0);
});

test('rejects a symlinked expected-artifact chain during preflight without spawning', async (t) => {
  const workspaceRoot = await temporaryWorkspace();
  const outsideRoot = await temporaryWorkspace('fwa-command-outside-');
  const linked = path.join(workspaceRoot, 'linked');
  try {
    await symlink(outsideRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`symbolic links are unavailable in this environment: ${error.code}`);
      return;
    }
    throw error;
  }
  let spawnCount = 0;
  const evaluator = new CommandEvaluator({
    spawnImpl() {
      spawnCount += 1;
      throw new Error('must not spawn');
    }
  });

  await assert.rejects(
    evaluator.evaluate({
      workspaceRoot,
      manifest: manifest([check({ expectedArtifacts: [{ path: 'linked/result.txt' }] })])
    }),
    (error) => error.code === 'FWA_SYMLINK_EVALUATION_PATH'
  );
  assert.equal(spawnCount, 0);
  assert.equal(await pathExists(path.join(outsideRoot, 'result.txt')), false);
});

test('rechecks each cwd after earlier checks mutate the workspace', async (t) => {
  const workspaceRoot = await temporaryWorkspace();
  const futureCwd = path.join(workspaceRoot, 'future');
  const target = path.join(workspaceRoot, 'target');
  const probe = path.join(workspaceRoot, 'probe');
  await mkdir(futureCwd);
  await mkdir(target);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await symlink(target, probe, linkType);
    await rm(probe, { force: true });
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`symbolic links are unavailable in this environment: ${error.code}`);
      return;
    }
    throw error;
  }

  let spawnCount = 0;
  const evaluator = new CommandEvaluator({
    spawnImpl(command, args, options) {
      spawnCount += 1;
      return spawn(command, args, options);
    }
  });
  const script = [
    "const fs = require('node:fs');",
    "fs.rmSync('future', { recursive: true, force: true });",
    `fs.symlinkSync(${JSON.stringify(target)}, 'future', ${JSON.stringify(linkType)});`
  ].join('');

  await assert.rejects(
    evaluator.evaluate({
      workspaceRoot,
      manifest: manifest([
        check({ id: 'mutate', args: ['-e', script] }),
        check({ id: 'must-not-spawn', cwd: 'future' })
      ])
    }),
    (error) => error.code === 'FWA_SYMLINK_EVALUATION_PATH'
  );
  assert.equal(spawnCount, 1);
});

test('hashes the complete child environment without returning environment values', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const firstSecret = 'secret-value-that-must-not-appear';
  const secondSecret = 'different-secret-that-must-not-appear';
  const firstEnvironment = { ...process.env, FWA_COMMAND_EVALUATOR_SECRET: firstSecret };
  const secondEnvironment = { ...process.env, FWA_COMMAND_EVALUATOR_SECRET: secondSecret };

  const first = await new CommandEvaluator({ env: firstEnvironment }).evaluate({
    workspaceRoot,
    manifest: manifest([check()])
  });
  const second = await new CommandEvaluator({ env: secondEnvironment }).evaluate({
    workspaceRoot,
    manifest: manifest([check()])
  });

  assert.equal(first.environmentFingerprint.platform, process.platform);
  assert.equal(first.environmentFingerprint.arch, process.arch);
  assert.deepEqual(first.environmentFingerprint.runtime, {
    name: 'node',
    version: process.version
  });
  assert.equal(
    first.environmentFingerprint.environmentSha256,
    environmentDigest(firstEnvironment)
  );
  assert.notEqual(
    first.environmentFingerprint.environmentSha256,
    second.environmentFingerprint.environmentSha256
  );
  assert.equal(JSON.stringify(first).includes(firstSecret), false);
  assert.equal(JSON.stringify(second).includes(secondSecret), false);
});

test('supports pre-aborted and in-flight AbortSignals without accepting the check', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const preAborted = new AbortController();
  preAborted.abort();
  let spawnCount = 0;
  const evaluator = new CommandEvaluator({
    spawnImpl(command, args, options) {
      spawnCount += 1;
      return spawn(command, args, options);
    }
  });
  const before = await evaluator.evaluate({
    workspaceRoot,
    manifest: manifest([check({ expectedArtifacts: [{ path: 'never-created.txt' }] })]),
    signal: preAborted.signal
  });
  assert.equal(before.passed, false);
  assert.equal(before.checks[0].aborted, true);
  assert.equal(before.checks[0].failure.code, 'COMMAND_ABORTED');
  assert.equal(before.checks[0].expectedArtifacts.length, 1);
  assert.equal(before.checks[0].expectedArtifacts[0].bytesBase64, null);
  assert.equal(
    before.checks[0].expectedArtifacts[0].failure.code,
    'EXPECTED_ARTIFACT_NOT_EVALUATED'
  );
  assert.equal(spawnCount, 0);

  const controller = new AbortController();
  const running = evaluator.evaluate({
    workspaceRoot,
    manifest: manifest([check({
      id: 'abort-running',
      args: ['-e', 'setInterval(() => {}, 1000)']
    })]),
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 100);
  const after = await running;
  assert.equal(after.passed, false);
  assert.equal(after.checks[0].aborted, true);
  assert.equal(after.checks[0].failure.code, 'COMMAND_ABORTED');
  assert.equal(spawnCount, 1);
});

test('returns a complete failed check when the spawn port throws synchronously', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const evaluator = new CommandEvaluator({
    spawnImpl() {
      const error = new Error('synthetic spawn failure');
      error.code = 'SYNTHETIC';
      throw error;
    }
  });

  const result = await evaluator.evaluate({
    workspaceRoot,
    manifest: manifest([check({ expectedArtifacts: [{ path: 'never-created.txt' }] })])
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].failure.code, 'COMMAND_SPAWN_FAILED');
  assert.equal(result.checks[0].expectedArtifacts.length, 1);
  assert.equal(result.checks[0].expectedArtifacts[0].bytesBase64, null);
  assert.equal(result.checks[0].expectedArtifacts[0].size, null);
  assert.equal(result.checks[0].expectedArtifacts[0].digest, null);
  assert.equal(
    result.checks[0].expectedArtifacts[0].failure.code,
    'EXPECTED_ARTIFACT_NOT_EVALUATED'
  );
});

test('does not lose an abort fired synchronously by the spawn port', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const controller = new AbortController();
  const evaluator = new CommandEvaluator({
    spawnImpl(command, args, options) {
      const child = spawn(command, args, options);
      controller.abort();
      return child;
    }
  });

  const result = await evaluator.evaluate({
    workspaceRoot,
    manifest: manifest([check({
      args: ['-e', 'setInterval(() => {}, 1000)']
    })]),
    signal: controller.signal
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].aborted, true);
  assert.equal(result.checks[0].failure.code, 'COMMAND_ABORTED');
  assert.equal(result.checks[0].terminationConfirmed, true);
});

test('throws when a requested termination cannot be confirmed within the grace period', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const evaluator = new CommandEvaluator({
    terminationGraceMs: 25,
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.unref = () => {};
      return child;
    }
  });

  await assert.rejects(
    evaluator.evaluate({
      workspaceRoot,
      manifest: manifest([check({ timeoutMs: 10 })])
    }),
    (error) => error instanceof CommandEvaluatorError
      && error.code === 'FWA_PROCESS_TERMINATION_UNCONFIRMED'
      && error.details.checkId === 'check-1'
  );
});

test('rejects case-colliding environment keys on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.throws(
    () => new CommandEvaluator({ env: { PATH: 'first', Path: 'second' } }),
    (error) => error.code === 'FWA_INVALID_EVALUATION_ENVIRONMENT'
  );
});

test('enforces the documented maximum timeout during whole-manifest prevalidation', async () => {
  const workspaceRoot = await temporaryWorkspace();
  let spawnCount = 0;
  const evaluator = new CommandEvaluator({
    spawnImpl() {
      spawnCount += 1;
      throw new Error('must not spawn');
    }
  });
  await assert.rejects(
    evaluator.evaluate({
      workspaceRoot,
      manifest: manifest([check({ timeoutMs: MAX_COMMAND_TIMEOUT_MS + 1 })])
    }),
    (error) => error.code === 'FWA_INVALID_EVALUATION_MANIFEST'
      && error.details.errors.some((item) => item.code === 'INVALID_TIMEOUT')
  );
  assert.equal(spawnCount, 0);
});
