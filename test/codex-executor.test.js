import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  CODEX_EXECUTOR_INPUT_SCHEMA_VERSION,
  CodexExecutor,
  CodexExecutorError
} from '../src/adapters/codex-executor.js';
import { assertExecutor } from '../src/core/executor.js';

const temporaryRoots = new Set();

async function temporaryWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-codex-executor-'));
  temporaryRoots.add(root);
  return root;
}

test.afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => {
    await rm(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }));
});

function projectionNode() {
  return {
    id: 'N-codex',
    capabilities: ['code_edit', 'shell']
  };
}

function codexInput(overrides = {}) {
  return {
    schemaVersion: CODEX_EXECUTOR_INPUT_SCHEMA_VERSION,
    prompt: 'Implement the requested change.',
    model: 'gpt-test',
    ...overrides
  };
}

function createSpawnFake(script, { closeOnKill = true } = {}) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.unref = () => {};

    let closed = false;
    const call = {
      executable,
      args,
      options,
      kills: [],
      stdin: []
    };
    const close = (exitCode, signal = null) => {
      if (closed) return;
      closed = true;
      child.emit('close', exitCode, signal);
    };
    child.kill = (signal) => {
      call.kills.push(signal);
      if (closeOnKill) queueMicrotask(() => close(null, signal));
      return true;
    };
    child.stdin.on('data', (chunk) => call.stdin.push(Buffer.from(chunk)));
    calls.push(call);
    queueMicrotask(() => script({ child, call, close }));
    return child;
  };
  return { calls, spawnImpl };
}

test('is a core-compatible executor and invokes non-interactive Codex with fixed cwd', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(({ child, close }) => {
    child.stdout.end([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5 }
      }),
      ''
    ].join('\n'));
    child.stderr.end('diagnostic warning\n');
    close(0);
  });
  const executor = new CodexExecutor({
    id: 'codex-local',
    version: '1.2.3',
    executable: 'fake-codex',
    env: { PATH: 'test-path', FWA_TEST: 'yes' },
    platform: 'linux',
    spawnImpl: fake.spawnImpl
  });

  assert.doesNotThrow(() => assertExecutor(executor));
  const result = await executor.execute({
    workspaceRoot,
    node: projectionNode(),
    input: codexInput()
  });

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.executable, 'fake-codex');
  assert.deepEqual(call.args, [
    'exec',
    '--json',
    '--color',
    'never',
    '--ephemeral',
    '--full-auto',
    '--cd',
    path.resolve(workspaceRoot),
    '--model',
    'gpt-test',
    '-'
  ]);
  assert.equal(call.options.cwd, path.resolve(workspaceRoot));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(Buffer.concat(call.stdin).toString('utf8'), codexInput().prompt);

  assert.equal(result.ok, true);
  assert.deepEqual(result.executor, { id: 'codex-local', version: '1.2.3' });
  assert.equal(result.nodeId, 'N-codex');
  assert.equal(result.codex.cwd, path.resolve(workspaceRoot));
  assert.equal(result.codex.shell, false);
  assert.equal(result.codex.nonInteractive, true);
  assert.equal(result.codex.ephemeral, true);
  assert.equal(result.codex.ignoreUserConfig, false);
  assert.equal(result.codex.windowsSandboxOverride, null);
  assert.equal(result.codex.model, 'gpt-test');
  assert.match(result.codex.promptSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.codex.environmentSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.usage, {
    reported: true,
    tokens: 15,
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 3
  });
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.process.signal, null);
  assert.equal(result.process.stderr, 'diagnostic warning\n');
  assert.equal(result.process.terminationConfirmed, true);
  assert.equal(result.jsonl.eventCount, 2);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('only ignores user configuration when the input explicitly opts in', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(({ child, close }) => {
    child.stdout.end(`${JSON.stringify({ type: 'turn.completed' })}\n`);
    child.stderr.end();
    close(0);
  });
  const executor = new CodexExecutor({
    executable: 'fake-codex',
    env: {},
    platform: 'linux',
    spawnImpl: fake.spawnImpl
  });

  const result = await executor.execute({
    workspaceRoot,
    node: projectionNode(),
    input: codexInput({ ignoreUserConfig: true })
  });

  assert.deepEqual(fake.calls[0].args, [
    'exec',
    '--json',
    '--color',
    'never',
    '--ephemeral',
    '--ignore-user-config',
    '--full-auto',
    '--cd',
    path.resolve(workspaceRoot),
    '--model',
    'gpt-test',
    '-'
  ]);
  assert.equal(result.codex.ignoreUserConfig, true);
  assert.equal(result.codex.windowsSandboxOverride, null);
  assert.equal(result.codex.sandbox, 'workspace-write-requested');
  assert.equal(result.codex.model, 'gpt-test');
});

test('adds only the fixed elevated Windows sandbox override after explicit opt-in', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(({ child, close }) => {
    child.stdout.end(`${JSON.stringify({ type: 'turn.completed' })}\n`);
    child.stderr.end();
    close(0);
  });
  const executor = new CodexExecutor({
    executable: 'C:\\tools\\codex.exe',
    env: {},
    platform: 'win32',
    spawnImpl: fake.spawnImpl
  });

  const result = await executor.execute({
    workspaceRoot,
    node: projectionNode(),
    input: codexInput({
      ignoreUserConfig: true,
      windowsSandboxOverride: 'elevated'
    })
  });

  assert.deepEqual(fake.calls[0].args, [
    'exec',
    '--json',
    '--color',
    'never',
    '--ephemeral',
    '--ignore-user-config',
    '-c',
    "windows.sandbox='elevated'",
    '--full-auto',
    '--cd',
    path.resolve(workspaceRoot),
    '--model',
    'gpt-test',
    '-'
  ]);
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(result.codex.windowsSandboxOverride, 'elevated');
  assert.equal(result.codex.sandbox, 'windows-elevated');
});

test('rejects arbitrary Windows sandbox config injection before spawning Codex', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(() => {});
  const executor = new CodexExecutor({
    executable: 'C:\\tools\\codex.exe',
    env: {},
    platform: 'win32',
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput({
        windowsSandboxOverride: "elevated' -c model='attacker"
      })
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_INVALID_CODEX_EXECUTOR_INPUT'
      && error.message
        === 'input.windowsSandboxOverride must be exactly "elevated" when supplied.'
  );
  assert.equal(fake.calls.length, 0);
});

test('rejects the Windows sandbox override on non-Windows platforms', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(() => {});
  const executor = new CodexExecutor({
    executable: 'fake-codex',
    env: {},
    platform: 'linux',
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput({ windowsSandboxOverride: 'elevated' })
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_INVALID_CODEX_EXECUTOR_INPUT'
      && error.message
        === 'input.windowsSandboxOverride is only supported when platform is win32.'
  );
  assert.equal(fake.calls.length, 0);
});

test('rejects a non-boolean ignoreUserConfig value before spawning Codex', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(() => {});
  const executor = new CodexExecutor({
    executable: 'fake-codex',
    env: {},
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput({ ignoreUserConfig: 'true' })
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_INVALID_CODEX_EXECUTOR_INPUT'
      && error.message === 'input.ignoreUserConfig must be a boolean when supplied.'
  );
  assert.equal(fake.calls.length, 0);
});

test('reports a non-zero Codex exit with invocation and bounded process evidence', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(({ child, close }) => {
    child.stdout.end(`${JSON.stringify({ type: 'turn.failed' })}\n`);
    child.stderr.end('model unavailable\n');
    close(7);
  });
  const executor = new CodexExecutor({
    executable: 'fake-codex',
    env: {},
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput()
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_CODEX_EXIT_FAILED'
      && error.details.invocation.shell === false
      && error.details.process.exitCode === 7
      && error.details.process.stderr === 'model unavailable\n'
      && error.details.process.terminationConfirmed === true
  );
});

test('terminates the direct child and waits for close after a timeout', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(() => {});
  const executor = new CodexExecutor({
    executable: 'fake-codex',
    env: {},
    timeoutMs: 10,
    terminationGraceMs: 200,
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput()
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_CODEX_TIMEOUT'
      && error.details.process.timedOut === true
      && error.details.process.terminationConfirmed === true
      && error.details.process.signal === 'SIGKILL'
  );
  assert.deepEqual(fake.calls[0].kills, ['SIGKILL']);
});

test('terminates the direct child and waits for close after AbortSignal cancellation', async () => {
  const workspaceRoot = await temporaryWorkspace();
  let started;
  const spawned = new Promise((resolve) => {
    started = resolve;
  });
  const fake = createSpawnFake(() => started());
  const controller = new AbortController();
  const executor = new CodexExecutor({
    executable: 'fake-codex',
    env: {},
    terminationGraceMs: 200,
    spawnImpl: fake.spawnImpl
  });

  const execution = executor.execute({
    workspaceRoot,
    node: projectionNode(),
    input: codexInput(),
    signal: controller.signal
  });
  await spawned;
  controller.abort();

  await assert.rejects(
    execution,
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_CODEX_ABORTED'
      && error.details.process.aborted === true
      && error.details.process.terminationConfirmed === true
  );
  assert.deepEqual(fake.calls[0].kills, ['SIGKILL']);
});

test('bounds stdout and terminates Codex when the capture limit is exceeded', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(({ child }) => {
    child.stdout.write(Buffer.alloc(80, 'x'));
  });
  const executor = new CodexExecutor({
    executable: 'fake-codex',
    env: {},
    outputLimitBytes: 32,
    terminationGraceMs: 200,
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput()
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_CODEX_OUTPUT_LIMIT_EXCEEDED'
      && error.details.stream === 'stdout'
      && error.details.process.stdoutBytes === 32
      && error.details.process.stdoutObservedBytes === 80
      && error.details.process.stdoutTruncated === true
      && error.details.process.terminationConfirmed === true
  );
  assert.deepEqual(fake.calls[0].kills, ['SIGKILL']);
});

test('rejects malformed JSONL after a successful process exit', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(({ child, close }) => {
    child.stdout.end('{"type":"turn.started"}\nnot-json\n');
    close(0);
  });
  const executor = new CodexExecutor({
    executable: 'fake-codex',
    env: {},
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput()
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_CODEX_INVALID_JSONL'
      && error.details.jsonl.line === 2
      && error.details.process.exitCode === 0
  );
});

test('rejects malformed reported token usage instead of inventing a budget value', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(({ child, close }) => {
    child.stdout.end(`${JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 'unknown', output_tokens: 2 }
    })}\n`);
    close(0);
  });
  const executor = new CodexExecutor({
    executable: 'fake-codex',
    env: {},
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput()
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_CODEX_INVALID_TOKEN_USAGE'
      && error.details.jsonl.field === 'input_tokens'
      && error.details.process.exitCode === 0
  );
});

test('prioritizes the npm-managed native codex.exe on Windows without using a command shell', {
  skip: process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)
}, async () => {
  const workspaceRoot = await temporaryWorkspace();
  const npmBin = path.join(workspaceRoot, 'npm-bin');
  const earlierStandaloneBin = path.join(workspaceRoot, 'earlier-standalone-bin');
  const architecture = process.arch === 'arm64'
    ? {
        packageName: 'codex-win32-arm64',
        targetTriple: 'aarch64-pc-windows-msvc'
      }
    : {
        packageName: 'codex-win32-x64',
        targetTriple: 'x86_64-pc-windows-msvc'
      };
  const codexPackage = path.join(npmBin, 'node_modules', '@openai', 'codex');
  const platformPackage = path.join(
    codexPackage,
    'node_modules',
    '@openai',
    architecture.packageName
  );
  const nativeExecutable = path.join(
    platformPackage,
    'vendor',
    architecture.targetTriple,
    'codex',
    'codex.exe'
  );
  const managedPath = path.join(
    platformPackage,
    'vendor',
    architecture.targetTriple,
    'path'
  );
  await mkdir(path.dirname(nativeExecutable), { recursive: true });
  await mkdir(earlierStandaloneBin, { recursive: true });
  await mkdir(managedPath, { recursive: true });
  await writeFile(
    path.join(earlierStandaloneBin, 'codex.exe'),
    'unusable app execution alias',
    'utf8'
  );
  await writeFile(path.join(npmBin, 'codex.cmd'), '@echo off\r\n', 'utf8');
  await writeFile(path.join(codexPackage, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    version: 'test'
  }), 'utf8');
  await writeFile(path.join(platformPackage, 'package.json'), JSON.stringify({
    name: `@openai/${architecture.packageName}`,
    version: 'test'
  }), 'utf8');
  await writeFile(nativeExecutable, 'fake native executable', 'utf8');

  const fake = createSpawnFake(({ child, close }) => {
    child.stdout.end(`${JSON.stringify({ type: 'turn.completed' })}\n`);
    child.stderr.end();
    close(0);
  });
  const executor = new CodexExecutor({
    env: { Path: `${earlierStandaloneBin};${npmBin}`, FWA_TEST: 'yes' },
    platform: 'win32',
    spawnImpl: fake.spawnImpl
  });
  const result = await executor.execute({
    workspaceRoot,
    node: projectionNode(),
    input: {
      schemaVersion: CODEX_EXECUTOR_INPUT_SCHEMA_VERSION,
      prompt: 'Use the inherited CLI model.'
    }
  });

  const expectedExecutable = await realpath(nativeExecutable);
  const expectedManagedPath = await realpath(managedPath);
  assert.equal(fake.calls[0].executable, expectedExecutable);
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.detached, false);
  assert.equal(fake.calls[0].options.env.CODEX_MANAGED_BY_NPM, '1');
  assert.equal(
    fake.calls[0].options.env.Path.split(';')[0].toLocaleLowerCase('en-US'),
    expectedManagedPath.toLocaleLowerCase('en-US')
  );
  assert.equal(fake.calls[0].args.includes('--model'), false);
  assert.equal(fake.calls[0].args.includes('--ignore-user-config'), false);
  assert.equal(fake.calls[0].args.includes('-c'), false);
  assert.equal(result.codex.executable, expectedExecutable);
  assert.equal(result.codex.model, null);
  assert.equal(result.codex.ignoreUserConfig, false);
  assert.equal(result.codex.windowsSandboxOverride, null);
  assert.equal(result.codex.shell, false);
});

test('rejects an explicit Windows command-script launcher instead of enabling shell mode', {
  skip: process.platform !== 'win32'
}, async () => {
  const workspaceRoot = await temporaryWorkspace();
  const fake = createSpawnFake(() => {});
  const executor = new CodexExecutor({
    executable: 'C:\\npm\\codex.cmd',
    env: {},
    platform: 'win32',
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput()
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_CODEX_WINDOWS_SCRIPT_UNSUPPORTED'
  );
  assert.equal(fake.calls.length, 0);
});

test('reports an actionable error when no native Windows Codex installation is resolvable', {
  skip: process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)
}, async () => {
  const workspaceRoot = await temporaryWorkspace();
  const emptyPath = path.join(workspaceRoot, 'empty-path');
  await mkdir(emptyPath);
  const fake = createSpawnFake(() => {});
  const executor = new CodexExecutor({
    env: { PATH: emptyPath },
    platform: 'win32',
    spawnImpl: fake.spawnImpl
  });

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: projectionNode(),
      input: codexInput()
    }),
    (error) => error instanceof CodexExecutorError
      && error.code === 'FWA_CODEX_NATIVE_NOT_FOUND'
      && error.details.pathDirectoryCount === 1
  );
  assert.equal(fake.calls.length, 0);
});
