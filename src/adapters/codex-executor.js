import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { EXECUTOR_SCHEMA_VERSION, assertExecutor } from '../core/executor.js';

export const CODEX_EXECUTOR_INPUT_SCHEMA_VERSION = 1;
export const CODEX_CODE_EDIT_CAPABILITY = 'code_edit';
export const CODEX_SHELL_CAPABILITY = 'shell';
export const DEFAULT_CODEX_TIMEOUT_MS = null;
export const DEFAULT_CODEX_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// Node timers use a signed 32-bit delay; larger values otherwise fire after 1 ms.
export const MAX_CODEX_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_CODEX_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
export const MAX_CODEX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CODEX_TERMINATION_GRACE_MS = 5_000;
export const MAX_CODEX_TERMINATION_GRACE_MS = 60_000;
export const MAX_CODEX_PROMPT_BYTES = 1024 * 1024;

const DEFAULT_CAPABILITIES = Object.freeze([
  CODEX_CODE_EDIT_CAPABILITY,
  CODEX_SHELL_CAPABILITY
]);

const TOKEN_FIELDS = Object.freeze({
  inputTokens: ['input_tokens', 'inputTokens'],
  outputTokens: ['output_tokens', 'outputTokens'],
  cachedInputTokens: ['cached_input_tokens', 'cachedInputTokens'],
  totalTokens: ['total_tokens', 'totalTokens', 'tokens']
});

const WINDOWS_NPM_TARGET = Object.freeze({
  x64: Object.freeze({
    packageName: '@openai/codex-win32-x64',
    targetTriple: 'x86_64-pc-windows-msvc'
  }),
  arm64: Object.freeze({
    packageName: '@openai/codex-win32-arm64',
    targetTriple: 'aarch64-pc-windows-msvc'
  })
});
const WINDOWS_ELEVATED_SANDBOX_OVERRIDE = "windows.sandbox='elevated'";

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireString(value, name, code = 'FWA_INVALID_CODEX_EXECUTOR_INPUT') {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.includes('\0')) {
    throw new CodexExecutorError(
      code,
      `${name} must be a non-empty, trimmed string without NUL bytes.`
    );
  }
  return value;
}

function requireDuration(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
      `${name} must be an integer from 1 through ${maximum}.`
    );
  }
  return value;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function normalizeAdditionalWritableRoots(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
      'additionalWritableRoots must be an array of absolute directory paths.'
    );
  }
  const seen = new Set();
  const roots = value.map((item, index) => {
    const name = `additionalWritableRoots[${index}]`;
    const root = requireString(item, name, 'FWA_INVALID_CODEX_EXECUTOR_OPTIONS');
    if (!path.isAbsolute(root)) {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        `${name} must be an absolute directory path.`
      );
    }
    const resolved = path.resolve(root);
    const key = process.platform === 'win32'
      ? resolved.toLocaleLowerCase('en-US')
      : resolved;
    if (seen.has(key)) {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        `${name} duplicates another additional writable root.`
      );
    }
    seen.add(key);
    return resolved;
  });
  return Object.freeze(roots);
}

async function resolveAdditionalWritableRoots(roots, workspaceRoot) {
  const resolved = [];
  for (const [index, root] of roots.entries()) {
    let information;
    try {
      information = await lstat(root);
    } catch (error) {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        `additionalWritableRoots[${index}] does not exist: ${root}.`,
        { path: root, error: safeError(error) }
      );
    }
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        `additionalWritableRoots[${index}] must be an existing ordinary directory, not a link or file.`,
        { path: root }
      );
    }
    let canonical;
    try {
      canonical = await realpath(root);
      const canonicalInformation = await stat(canonical);
      if (!canonicalInformation.isDirectory() || !samePath(canonical, root)) {
        throw new Error('directory is not a canonical ordinary directory');
      }
    } catch (error) {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        `additionalWritableRoots[${index}] must resolve to the same existing ordinary directory without links: ${root}.`,
        { path: root, error: safeError(error) }
      );
    }
    if (pathContains(workspaceRoot, canonical) || pathContains(canonical, workspaceRoot)) {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        `additionalWritableRoots[${index}] must be disjoint from the Codex workspace.`,
        { path: canonical, workspaceRoot }
      );
    }
    resolved.push(canonical);
  }
  return Object.freeze(resolved);
}

function normalizeTimeout(value, name = 'timeoutMs') {
  if (value === null || value === 0) return null;
  return requireDuration(value, name, MAX_CODEX_TIMEOUT_MS);
}

function requireOutputLimit(value) {
  if (!Number.isSafeInteger(value)
    || value < 1
    || value > MAX_CODEX_OUTPUT_LIMIT_BYTES) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
      `outputLimitBytes must be an integer from 1 through ${MAX_CODEX_OUTPUT_LIMIT_BYTES}.`
    );
  }
  return value;
}

function assertSignal(signal) {
  if (signal === undefined) return;
  if (signal === null
    || typeof signal !== 'object'
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function') {
    throw new CodexExecutorError(
      'FWA_INVALID_ABORT_SIGNAL',
      'signal must be an AbortSignal when supplied.'
    );
  }
}

function normalizeEnvironment(value) {
  if (!isPlainObject(value)) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
      'env must be a plain object containing string values.'
    );
  }
  const normalized = Object.create(null);
  const caseInsensitive = process.platform === 'win32' ? new Map() : null;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (key.length === 0 || key.includes('\0') || key.includes('=')) {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        `Environment key ${JSON.stringify(key)} is invalid.`
      );
    }
    if (typeof item !== 'string' || item.includes('\0')) {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        `Environment value for ${JSON.stringify(key)} must be a string without NUL bytes.`
      );
    }
    if (caseInsensitive) {
      const folded = key.toLocaleLowerCase('en-US');
      const previous = caseInsensitive.get(folded);
      if (previous !== undefined && previous !== key) {
        throw new CodexExecutorError(
          'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
          `Environment keys ${JSON.stringify(previous)} and ${JSON.stringify(key)} collide on Windows.`
        );
      }
      caseInsensitive.set(folded, key);
    }
    normalized[key] = item;
  }
  return Object.freeze(normalized);
}

function environmentSha256(environment) {
  const serialized = JSON.stringify(
    Object.keys(environment).sort(compareStrings).map((key) => [key, environment[key]])
  );
  return createHash('sha256').update(serialized).digest('hex');
}

function environmentEntry(environment, requestedName) {
  const expected = requestedName.toLocaleLowerCase('en-US');
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLocaleLowerCase('en-US') === expected
  );
  return key === undefined ? { key: requestedName, value: null } : {
    key,
    value: environment[key]
  };
}

async function canonicalRegularFile(targetPath) {
  try {
    const canonical = await realpath(targetPath);
    const information = await stat(canonical);
    return information.isFile() ? canonical : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return null;
    throw new CodexExecutorError(
      'FWA_CODEX_EXECUTABLE_RESOLUTION_FAILED',
      `Failed to inspect a Codex executable candidate: ${targetPath}.`,
      { path: targetPath, error: safeError(error) }
    );
  }
}

async function canonicalDirectory(targetPath) {
  try {
    const canonical = await realpath(targetPath);
    const information = await stat(canonical);
    return information.isDirectory() ? canonical : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return null;
    throw new CodexExecutorError(
      'FWA_CODEX_EXECUTABLE_RESOLUTION_FAILED',
      `Failed to inspect a Codex package directory: ${targetPath}.`,
      { path: targetPath, error: safeError(error) }
    );
  }
}

async function pathEntryExists(targetPath) {
  try {
    const information = await lstat(targetPath);
    return information.isFile() || information.isSymbolicLink();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return false;
    throw new CodexExecutorError(
      'FWA_CODEX_EXECUTABLE_RESOLUTION_FAILED',
      `Failed to inspect Codex launcher ${targetPath}.`,
      { path: targetPath, error: safeError(error) }
    );
  }
}

function windowsPathDirectories(environment) {
  const pathEntry = environmentEntry(environment, 'PATH');
  if (pathEntry.value === null || pathEntry.value.length === 0) return [];
  const seen = new Set();
  const directories = [];
  for (const rawEntry of pathEntry.value.split(';')) {
    let entry = rawEntry.trim();
    if (entry.startsWith('"') && entry.endsWith('"') && entry.length >= 2) {
      entry = entry.slice(1, -1);
    }
    if (entry.length === 0 || !path.win32.isAbsolute(entry)) continue;
    const normalized = path.win32.normalize(entry);
    const key = normalized.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(normalized);
  }
  return directories;
}

function managedNpmEnvironment(environment, managedPath) {
  const pathEntry = environmentEntry(environment, 'PATH');
  const existing = pathEntry.value ?? '';
  const pathParts = existing.split(';').filter((entry) => entry.length > 0);
  const alreadyPresent = pathParts.some((entry) => (
    path.win32.normalize(entry.replace(/^"|"$/gu, ''))
      .toLocaleLowerCase('en-US')
      === path.win32.normalize(managedPath).toLocaleLowerCase('en-US')
  ));
  const updated = {
    ...environment,
    [pathEntry.key]: alreadyPresent
      ? existing
      : [managedPath, ...pathParts].join(';'),
    CODEX_MANAGED_BY_NPM: '1'
  };
  return normalizeEnvironment(updated);
}

function resolvePackageJson(resolver, packageName) {
  try {
    return resolver.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
}

async function resolveNpmNativeFrom(directory, environment, target) {
  const launcherNames = ['codex.cmd', 'codex'];
  const hasLauncher = (await Promise.all(launcherNames.map((name) => (
    pathEntryExists(path.win32.join(directory, name))
  )))).some(Boolean);
  if (!hasLauncher) return null;

  const resolver = createRequire(path.win32.join(directory, 'fwa-codex-resolver.cjs'));
  const codexPackageJson = resolvePackageJson(resolver, '@openai/codex');
  if (codexPackageJson === null) return null;
  const packageResolver = createRequire(codexPackageJson);
  const platformPackageJson = resolvePackageJson(packageResolver, target.packageName);
  const codexRoot = path.win32.dirname(codexPackageJson);
  const platformPackageName = target.packageName.slice('@openai/'.length);
  const platformRoots = platformPackageJson === null
    ? [
        path.win32.join(codexRoot, 'node_modules', '@openai', platformPackageName),
        path.win32.join(path.win32.dirname(codexRoot), platformPackageName)
      ]
    : [path.win32.dirname(platformPackageJson)];

  for (const platformRoot of platformRoots) {
    const vendorRoot = path.win32.join(platformRoot, 'vendor', target.targetTriple);
    const executable = await canonicalRegularFile(
      path.win32.join(vendorRoot, 'codex', 'codex.exe')
    );
    if (executable === null) continue;
    const managedPath = await canonicalDirectory(path.win32.join(vendorRoot, 'path'));
    return {
      executable,
      environment: managedPath === null
        ? normalizeEnvironment({ ...environment, CODEX_MANAGED_BY_NPM: '1' })
        : managedNpmEnvironment(environment, managedPath)
    };
  }
  return null;
}

async function resolveCodexLaunch({ requestedExecutable, platform, environment }) {
  if (requestedExecutable !== null) {
    if (platform === 'win32' && /\.(?:bat|cmd)$/iu.test(requestedExecutable)) {
      throw new CodexExecutorError(
        'FWA_CODEX_WINDOWS_SCRIPT_UNSUPPORTED',
        'Windows .cmd/.bat Codex launchers cannot be executed with shell:false; use the native codex.exe.',
        { executable: requestedExecutable }
      );
    }
    return { executable: requestedExecutable, environment };
  }
  if (platform !== 'win32') return { executable: 'codex', environment };

  const target = WINDOWS_NPM_TARGET[process.arch];
  if (target === undefined) {
    throw new CodexExecutorError(
      'FWA_CODEX_WINDOWS_ARCH_UNSUPPORTED',
      `No native Codex package mapping exists for Windows ${process.arch}.`,
      { arch: process.arch }
    );
  }
  const directories = windowsPathDirectories(environment);
  for (const directory of directories) {
    const npmNative = await resolveNpmNativeFrom(directory, environment, target);
    if (npmNative !== null) return npmNative;
  }
  for (const directory of directories) {
    const standalone = await canonicalRegularFile(path.win32.join(directory, 'codex.exe'));
    if (standalone !== null) return { executable: standalone, environment };
  }
  throw new CodexExecutorError(
    'FWA_CODEX_NATIVE_NOT_FOUND',
    'Could not resolve a native codex.exe from PATH. Install @openai/codex or pass an explicit native executable.',
    { arch: process.arch, pathDirectoryCount: directories.length }
  );
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
      'capabilities must be a non-empty array.'
    );
  }
  return Object.freeze(value.map((capability, index) => (
    requireString(
      capability,
      `capabilities[${index}]`,
      'FWA_INVALID_CODEX_EXECUTOR_OPTIONS'
    )
  )));
}

function normalizeInput(input, defaultModel) {
  if (!isPlainObject(input)) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_INPUT',
      'Codex executor input must be a plain object.'
    );
  }
  const allowed = new Set([
    'schemaVersion',
    'prompt',
    'model',
    'ignoreUserConfig',
    'windowsSandboxOverride',
    'images'
  ]);
  const unknown = Object.keys(input).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_INPUT',
      `Unknown Codex executor input field(s): ${unknown.join(', ')}.`,
      { fields: unknown }
    );
  }
  if (input.schemaVersion !== CODEX_EXECUTOR_INPUT_SCHEMA_VERSION) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_INPUT',
      `Expected Codex executor input schema version ${CODEX_EXECUTOR_INPUT_SCHEMA_VERSION}.`
    );
  }
  const prompt = input.prompt;
  const promptReason = typeof prompt !== 'string' ? 'prompt-type'
    : !prompt.length ? 'prompt-empty'
      : prompt.includes('\0') ? 'prompt-nul'
        : prompt !== prompt.trim() ? 'prompt-whitespace' : null;
  if (promptReason !== null) {
    throw new CodexExecutorError('FWA_INVALID_CODEX_EXECUTOR_INPUT',
      'input.prompt must be a non-empty, trimmed string without NUL bytes.',
      { field: 'prompt', reason: promptReason });
  }
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > MAX_CODEX_PROMPT_BYTES) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_INPUT',
      `input.prompt exceeds the ${MAX_CODEX_PROMPT_BYTES}-byte limit.`,
      { field: 'prompt', reason: 'prompt-too-large', promptBytes, limitBytes: MAX_CODEX_PROMPT_BYTES }
    );
  }
  const model = input.model === undefined
    ? defaultModel
    : requireString(input.model, 'input.model');
  const ignoreUserConfig = input.ignoreUserConfig ?? false;
  if (typeof ignoreUserConfig !== 'boolean') {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_INPUT',
      'input.ignoreUserConfig must be a boolean when supplied.'
    );
  }
  if (input.windowsSandboxOverride !== undefined
    && input.windowsSandboxOverride !== 'elevated') {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_EXECUTOR_INPUT',
      'input.windowsSandboxOverride must be exactly "elevated" when supplied.'
    );
  }
  const windowsSandboxOverride = input.windowsSandboxOverride ?? null;
  const images = input.images ?? [];
  if (!Array.isArray(images) || images.length > 16 || images.some(item => typeof item !== 'string' || !path.isAbsolute(item) || item.includes('\0'))) {
    throw new CodexExecutorError('FWA_INVALID_CODEX_EXECUTOR_INPUT', 'images must contain at most 16 explicit absolute image paths.');
  }
  return {
    prompt,
    promptBytes,
    model,
    ignoreUserConfig,
    windowsSandboxOverride,
    images: [...images]
  };
}

async function resolveWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string'
    || workspaceRoot.length === 0
    || workspaceRoot !== workspaceRoot.trim()) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_WORKSPACE',
      'workspaceRoot must be a non-empty, trimmed path.'
    );
  }
  const root = path.resolve(workspaceRoot);
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_WORKSPACE',
      `Codex workspace does not exist: ${root}.`,
      { error: safeError(error) }
    );
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_WORKSPACE',
      'Codex workspace must be an existing, non-symlink directory.',
      { workspaceRoot: root }
    );
  }
  return root;
}

function safeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    message: typeof error?.message === 'string' ? error.message : String(error)
  };
}

function outputCollector(stream, limitBytes, requestStop) {
  const chunks = [];
  let capturedBytes = 0;
  let observedBytes = 0;
  let truncated = false;
  let streamError = null;
  return {
    onData(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observedBytes += bytes.byteLength;
      const remaining = Math.max(0, limitBytes - capturedBytes);
      if (remaining > 0) {
        const captured = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.byteLength;
      }
      if (observedBytes > limitBytes && !truncated) {
        truncated = true;
        requestStop({
          code: 'FWA_CODEX_OUTPUT_LIMIT_EXCEEDED',
          message: `Codex ${stream} exceeded the ${limitBytes}-byte capture limit.`,
          details: { stream, limitBytes }
        });
      }
    },
    onError(error) {
      streamError = safeError(error);
      requestStop({
        code: 'FWA_CODEX_OUTPUT_STREAM_FAILED',
        message: `Failed while reading Codex ${stream}.`,
        details: { stream, error: streamError }
      });
    },
    result() {
      return {
        text: Buffer.concat(chunks, capturedBytes).toString('utf8'),
        capturedBytes,
        observedBytes,
        truncated,
        streamError
      };
    }
  };
}

async function runTaskkill(pid, timeoutMs) {
  await new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    let killer;
    try {
      killer = nodeSpawn(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { shell: false, windowsHide: true, stdio: 'ignore' }
      );
    } catch {
      finish();
      return;
    }
    killer.once('error', finish);
    killer.once('close', finish);
    timeout = setTimeout(() => {
      try {
        killer.kill('SIGKILL');
      } catch {
        // The taskkill helper may already have exited.
      }
      finish();
    }, timeoutMs);
  });
}

async function terminateProcessTree(child, platform, isClosed, terminationGraceMs) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    try {
      child.kill('SIGKILL');
    } catch {
      // A process that never started has no tree to terminate.
    }
    return;
  }
  if (platform === 'win32') {
    await runTaskkill(child.pid, Math.min(2_000, terminationGraceMs));
    if (!isClosed()) {
      try {
        child.kill('SIGKILL');
      } catch {
        // taskkill may already have reaped the process.
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may have exited between kill attempts.
      }
    }
  }
}

function processSnapshot(raw) {
  return {
    exitCode: raw.exitCode,
    signal: raw.signal,
    terminationConfirmed: true,
    timedOut: raw.stopReason?.code === 'FWA_CODEX_TIMEOUT',
    idleTimedOut: raw.stopReason?.code === 'FWA_CODEX_IDLE_TIMEOUT',
    aborted: raw.stopReason?.code === 'FWA_CODEX_ABORTED',
    durationMs: raw.durationMs,
    stdout: raw.stdout.text,
    stderr: raw.stderr.text,
    stdoutBytes: raw.stdout.capturedBytes,
    stderrBytes: raw.stderr.capturedBytes,
    stdoutObservedBytes: raw.stdout.observedBytes,
    stderrObservedBytes: raw.stderr.observedBytes,
    stdoutTruncated: raw.stdout.truncated,
    stderrTruncated: raw.stderr.truncated
  };
}

async function runCodex({
  executable,
  args,
  cwd,
  environment,
  prompt,
  outputLimitBytes,
  timeoutMs,
  idleTimeoutMs,
  terminationGraceMs,
  signal,
  spawnImpl,
  platform,
  invocation
}) {
  const startedAt = Date.now();
  let child;
  try {
    child = spawnImpl(executable, [...args], {
      cwd,
      // child_process may add instrumentation variables (for example under
      // Node's coverage runner). Preserve the immutable normalized snapshot
      // and expose only a mutable per-spawn copy.
      env: { ...environment },
      shell: false,
      windowsHide: true,
      detached: platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    throw new CodexExecutorError(
      'FWA_CODEX_SPAWN_FAILED',
      'Failed to spawn Codex.',
      { invocation, error: safeError(error) }
    );
  }
  if (!child
    || typeof child.once !== 'function'
    || !child.stdin
    || typeof child.stdin.end !== 'function'
    || !child.stdout
    || typeof child.stdout.on !== 'function'
    || !child.stderr
    || typeof child.stderr.on !== 'function'
    || typeof child.kill !== 'function') {
    try {
      child?.kill?.('SIGKILL');
    } catch {
      // A malformed spawn port may not expose a working kill method.
    }
    throw new CodexExecutorError(
      'FWA_INVALID_CODEX_SPAWN_PORT',
      'spawnImpl must return a ChildProcess with piped stdin, stdout, and stderr.'
    );
  }

  return new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    let stopReason = null;
    let processError = null;
    let termination = null;
    let timeout;
    let idleTimeout;
    let terminationDeadline;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(idleTimeout);
      clearTimeout(terminationDeadline);
      signal?.removeEventListener('abort', onAbort);
    };
    const stdout = outputCollector('stdout', outputLimitBytes, requestStop);
    const stderr = outputCollector('stderr', outputLimitBytes, requestStop);

    function rejectUnconfirmed() {
      if (settled || closed) return;
      settled = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy?.();
      child.unref?.();
      reject(new CodexExecutorError(
        'FWA_CODEX_PROCESS_TERMINATION_UNCONFIRMED',
        'Codex termination could not be confirmed by a ChildProcess close event.',
        {
          invocation,
          terminationGraceMs,
          reason: stopReason,
          process: {
            exitCode: null,
            signal: null,
            terminationConfirmed: false,
            timedOut: stopReason?.code === 'FWA_CODEX_TIMEOUT',
            idleTimedOut: stopReason?.code === 'FWA_CODEX_IDLE_TIMEOUT',
            aborted: stopReason?.code === 'FWA_CODEX_ABORTED',
            durationMs: Math.max(0, Date.now() - startedAt),
            stdout: stdout.result().text,
            stderr: stderr.result().text,
            stdoutBytes: stdout.result().capturedBytes,
            stderrBytes: stderr.result().capturedBytes,
            stdoutObservedBytes: stdout.result().observedBytes,
            stderrObservedBytes: stderr.result().observedBytes,
            stdoutTruncated: stdout.result().truncated,
            stderrTruncated: stderr.result().truncated
          }
        }
      ));
    }

    function requestStop(reason) {
      if (stopReason !== null || closed) return;
      stopReason = reason;
      clearTimeout(idleTimeout);
      termination = terminateProcessTree(
        child,
        platform,
        () => closed,
        terminationGraceMs
      ).catch(() => {});
      terminationDeadline = setTimeout(rejectUnconfirmed, terminationGraceMs);
    }

    function onAbort() {
      requestStop({
        code: 'FWA_CODEX_ABORTED',
        message: 'Codex execution was aborted.'
      });
    }

    function resetIdleTimeout() {
      clearTimeout(idleTimeout);
      if (idleTimeoutMs === null || settled || closed || stopReason !== null) return;
      idleTimeout = setTimeout(() => requestStop({
        code: 'FWA_CODEX_IDLE_TIMEOUT',
        message: `Codex produced no stdout or stderr bytes for ${idleTimeoutMs} ms.`,
        details: { idleTimeoutMs }
      }), idleTimeoutMs);
    }
    const receive = collector => chunk => {
      if (Buffer.byteLength(chunk) > 0) resetIdleTimeout();
      collector.onData(chunk);
    };
    child.stdout.on('data', receive(stdout));
    child.stdout.on('error', stdout.onError);
    child.stderr.on('data', receive(stderr));
    child.stderr.on('error', stderr.onError);
    child.stdin.on?.('error', (error) => requestStop({
      code: 'FWA_CODEX_INPUT_STREAM_FAILED',
      message: 'Failed while writing the Codex prompt.',
      details: { error: safeError(error) }
    }));
    child.once('error', (error) => {
      processError = safeError(error);
      requestStop({
        code: 'FWA_CODEX_SPAWN_FAILED',
        message: 'The Codex process emitted an error.',
        details: { error: processError }
      });
    });
    child.once('close', async (exitCode, closeSignal) => {
      closed = true;
      if (settled) return;
      settled = true;
      cleanup();
      if (termination) await termination;
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: typeof closeSignal === 'string' ? closeSignal : null,
        stopReason,
        processError,
        stdout: stdout.result(),
        stderr: stderr.result(),
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    resetIdleTimeout();
    if (timeoutMs !== null) {
      timeout = setTimeout(() => requestStop({
        code: 'FWA_CODEX_TIMEOUT',
        message: `Codex execution exceeded its ${timeoutMs} ms timeout.`,
        details: { timeoutMs }
      }), timeoutMs);
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      child.stdin.end(prompt);
    } catch (error) {
      requestStop({
        code: 'FWA_CODEX_INPUT_STREAM_FAILED',
        message: 'Failed while writing the Codex prompt.',
        details: { error: safeError(error) }
      });
    }
  });
}

function parseJsonLines(stdout) {
  const events = [];
  const lines = stdout.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (index === 0 && line.startsWith('\uFEFF')) line = line.slice(1);
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new CodexExecutorError(
        'FWA_CODEX_INVALID_JSONL',
        `Codex stdout line ${index + 1} is not valid JSON.`,
        { line: index + 1, error: safeError(error) }
      );
    }
    if (!isPlainObject(event)) {
      throw new CodexExecutorError(
        'FWA_CODEX_INVALID_JSONL',
        `Codex stdout line ${index + 1} must contain a JSON object.`,
        { line: index + 1 }
      );
    }
    events.push(event);
  }
  if (events.length === 0) {
    throw new CodexExecutorError(
      'FWA_CODEX_INVALID_JSONL',
      'Codex produced no JSONL events.'
    );
  }
  return events;
}

function aliasedTokenValue(object, aliases) {
  for (const alias of aliases) {
    if (!Object.hasOwn(object, alias)) continue;
    const value = object[alias];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CodexExecutorError(
        'FWA_CODEX_INVALID_TOKEN_USAGE',
        `Codex reported invalid token usage in ${alias}.`,
        { field: alias, value }
      );
    }
    return value;
  }
  return null;
}

function usageCandidate(object) {
  if (!isPlainObject(object)) return null;
  const hasTokenField = Object.values(TOKEN_FIELDS).some((aliases) => (
    aliases.some((alias) => Object.hasOwn(object, alias))
  ));
  if (!hasTokenField) return null;
  const inputTokens = aliasedTokenValue(object, TOKEN_FIELDS.inputTokens);
  const outputTokens = aliasedTokenValue(object, TOKEN_FIELDS.outputTokens);
  const cachedInputTokens = aliasedTokenValue(object, TOKEN_FIELDS.cachedInputTokens);
  const explicitTotal = aliasedTokenValue(object, TOKEN_FIELDS.totalTokens);
  const tokens = explicitTotal ?? (
    inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null
  );
  if (!Number.isSafeInteger(tokens) || tokens < 0) return null;
  return { tokens, inputTokens, outputTokens, cachedInputTokens };
}

function extractUsage(events) {
  const candidates = [];
  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isPlainObject(value)) return;
    const candidate = usageCandidate(value);
    if (candidate) candidates.push(candidate);
    for (const child of Object.values(value)) visit(child);
  }
  for (const event of events) visit(event);
  const selected = candidates.reduce((best, candidate) => (
    best === null || candidate.tokens >= best.tokens ? candidate : best
  ), null);
  return selected === null
    ? {
        reported: false,
        tokens: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null
      }
    : { reported: true, ...selected };
}

export class CodexExecutorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CodexExecutorError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class CodexExecutor {
  #defaultModel;
  #environment;
  #executable;
  #outputLimitBytes;
  #platform;
  #spawn;
  #terminationGraceMs;
  #timeoutMs;
  #idleTimeoutMs;
  #sandbox;
  #outputSchema;
  #additionalWritableRoots;

  constructor(options = {}) {
    if (!isPlainObject(options)) {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        'CodexExecutor options must be a plain object.'
      );
    }
    this.schemaVersion = EXECUTOR_SCHEMA_VERSION;
    this.id = options.id ?? 'codex';
    this.version = options.version ?? '1';
    this.capabilities = normalizeCapabilities(options.capabilities ?? DEFAULT_CAPABILITIES);
    this.#platform = options.platform ?? process.platform;
    if (typeof this.#platform !== 'string' || this.#platform.trim() === '') {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        'platform must be a non-empty string.'
      );
    }
    this.#executable = options.executable === undefined
      ? null
      : requireString(
          options.executable,
          'executable',
          'FWA_INVALID_CODEX_EXECUTOR_OPTIONS'
        );
    this.#defaultModel = options.model === undefined
      ? null
      : requireString(options.model, 'model', 'FWA_INVALID_CODEX_EXECUTOR_OPTIONS');
    this.#sandbox = options.sandbox ?? 'workspace-write';
    if (!['read-only', 'workspace-write'].includes(this.#sandbox)) {
      throw new CodexExecutorError('FWA_INVALID_CODEX_EXECUTOR_OPTIONS', 'sandbox must be read-only or workspace-write.');
    }
    this.#additionalWritableRoots = normalizeAdditionalWritableRoots(options.additionalWritableRoots);
    if (this.#additionalWritableRoots.length > 0 && this.#sandbox !== 'workspace-write') {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_OPTIONS',
        'additionalWritableRoots require the workspace-write sandbox.'
      );
    }
    this.#outputSchema = options.outputSchema ?? null;
    if (this.#outputSchema !== null && (typeof this.#outputSchema !== 'string' || !path.isAbsolute(this.#outputSchema))) {
      throw new CodexExecutorError('FWA_INVALID_CODEX_EXECUTOR_OPTIONS', 'outputSchema must be an absolute, server-selected file path.');
    }
    this.#timeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS);
    this.#idleTimeoutMs = normalizeTimeout(options.idleTimeoutMs === undefined
      ? DEFAULT_CODEX_IDLE_TIMEOUT_MS : options.idleTimeoutMs, 'idleTimeoutMs');
    this.#outputLimitBytes = requireOutputLimit(
      options.outputLimitBytes ?? DEFAULT_CODEX_OUTPUT_LIMIT_BYTES
    );
    this.#terminationGraceMs = requireDuration(
      options.terminationGraceMs ?? DEFAULT_CODEX_TERMINATION_GRACE_MS,
      'terminationGraceMs',
      MAX_CODEX_TERMINATION_GRACE_MS
    );
    this.#environment = normalizeEnvironment(
      options.env === undefined ? { ...process.env } : options.env
    );
    this.#spawn = options.spawnImpl ?? nodeSpawn;
    if (typeof this.#spawn !== 'function') {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_SPAWN_PORT',
        'spawnImpl must be a function.'
      );
    }
    assertExecutor(this);
  }

  validateInput(input) {
    const normalized = normalizeInput(input, this.#defaultModel);
    return { ok: true, promptBytes: normalized.promptBytes };
  }

  async execute({ workspaceRoot, node, input, signal } = {}) {
    assertSignal(signal);
    const root = await resolveWorkspaceRoot(workspaceRoot);
    if (!isPlainObject(node)
      || typeof node.id !== 'string'
      || node.id.trim() === '') {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_NODE',
        'node must be a plain object with a non-empty id.'
      );
    }
    const normalized = normalizeInput(input, this.#defaultModel);
    const additionalWritableRoots = await resolveAdditionalWritableRoots(
      this.#additionalWritableRoots,
      root
    );
    for (const imagePath of normalized.images) {
      const info = await lstat(imagePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) {
        throw new CodexExecutorError('FWA_INVALID_CODEX_EXECUTOR_INPUT', 'Image inputs must be bounded regular files, not links.');
      }
    }
    if (this.#sandbox === 'read-only' && normalized.windowsSandboxOverride !== null) {
      throw new CodexExecutorError('FWA_INVALID_CODEX_EXECUTOR_INPUT', 'Read-only planning cannot override the Windows sandbox.');
    }
    if (normalized.windowsSandboxOverride !== null && this.#platform !== 'win32') {
      throw new CodexExecutorError(
        'FWA_INVALID_CODEX_EXECUTOR_INPUT',
        'input.windowsSandboxOverride is only supported when platform is win32.'
      );
    }
    const launch = await resolveCodexLaunch({
      requestedExecutable: this.#executable,
      platform: this.#platform,
      environment: this.#environment
    });
    const args = [
      'exec',
      '--json',
      '--color',
      'never',
      '--ephemeral',
      ...(normalized.ignoreUserConfig ? ['--ignore-user-config'] : []),
      ...(normalized.windowsSandboxOverride === 'elevated'
        ? ['-c', WINDOWS_ELEVATED_SANDBOX_OVERRIDE]
        : []),
      '--sandbox', this.#sandbox,
      ...(this.#outputSchema === null ? [] : ['--output-schema', this.#outputSchema]),
      ...normalized.images.flatMap(imagePath => ['--image', imagePath]),
      '--cd',
      root,
      ...additionalWritableRoots.flatMap((writableRoot) => ['--add-dir', writableRoot]),
      ...(normalized.model === null ? [] : ['--model', normalized.model]),
      '-'
    ];
    const invocation = {
      executable: launch.executable,
      args: [...args],
      cwd: root,
      shell: false,
      outputFormat: 'jsonl',
      nonInteractive: true,
      ephemeral: true,
      ignoreUserConfig: normalized.ignoreUserConfig,
      windowsSandboxOverride: normalized.windowsSandboxOverride,
      additionalWritableRoots: [...additionalWritableRoots],
      sandbox: normalized.windowsSandboxOverride === 'elevated'
        ? 'windows-elevated'
        : `${this.#sandbox}-requested`,
      model: normalized.model,
      promptBytes: normalized.promptBytes,
      promptSha256: createHash('sha256').update(normalized.prompt).digest('hex'),
      environmentSha256: environmentSha256(launch.environment)
    };
    if (signal?.aborted) {
      throw new CodexExecutorError(
        'FWA_CODEX_ABORTED',
        'Codex execution was aborted before spawn.',
        {
          invocation,
          process: {
            exitCode: null,
            signal: null,
            terminationConfirmed: true,
            timedOut: false,
            aborted: true,
            durationMs: 0
          }
        }
      );
    }

    const raw = await runCodex({
      executable: launch.executable,
      args,
      cwd: root,
      environment: launch.environment,
      prompt: normalized.prompt,
      outputLimitBytes: this.#outputLimitBytes,
      timeoutMs: this.#timeoutMs,
      idleTimeoutMs: this.#idleTimeoutMs,
      terminationGraceMs: this.#terminationGraceMs,
      signal,
      spawnImpl: this.#spawn,
      platform: this.#platform,
      invocation
    });
    const processResult = processSnapshot(raw);
    const failureDetails = { invocation, process: processResult };
    if (raw.stopReason !== null) {
      throw new CodexExecutorError(
        raw.stopReason.code,
        raw.stopReason.message,
        { ...failureDetails, ...(raw.stopReason.details ?? {}) }
      );
    }
    if (raw.processError !== null) {
      throw new CodexExecutorError(
        'FWA_CODEX_SPAWN_FAILED',
        'The Codex process failed after spawn.',
        { ...failureDetails, error: raw.processError }
      );
    }
    if (raw.signal !== null) {
      throw new CodexExecutorError(
        'FWA_CODEX_SIGNALLED',
        `Codex exited because of signal ${raw.signal}.`,
        failureDetails
      );
    }
    if (raw.exitCode !== 0) {
      throw new CodexExecutorError(
        'FWA_CODEX_EXIT_FAILED',
        `Codex exited with code ${String(raw.exitCode)}.`,
        failureDetails
      );
    }

    let events;
    let usage;
    try {
      events = parseJsonLines(raw.stdout.text);
      usage = extractUsage(events);
    } catch (error) {
      if (!(error instanceof CodexExecutorError)) throw error;
      throw new CodexExecutorError(
        error.code,
        error.message,
        { ...failureDetails, jsonl: error.details ?? null }
      );
    }
    return {
      schemaVersion: CODEX_EXECUTOR_INPUT_SCHEMA_VERSION,
      ok: true,
      executor: { id: this.id, version: this.version },
      nodeId: node.id,
      codex: invocation,
      process: processResult,
      usage,
      jsonl: { eventCount: events.length, events }
    };
  }
}
