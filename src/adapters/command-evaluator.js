import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { normalizeWorkspacePath } from '../core/effects.js';
import {
  EVALUATOR_SCHEMA_VERSION,
  assertEvaluator
} from '../core/evaluator.js';

export const COMMAND_EVALUATION_MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TERMINATION_GRACE_MS = 5_000;
export const MAX_TERMINATION_GRACE_MS = 60_000;

const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/iu;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function issue(code, valuePath, message, details = undefined) {
  const result = { code, path: valuePath, message };
  if (details !== undefined) result.details = details;
  return result;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertKnownFields(value, allowed, valuePath, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(issue('UNKNOWN_FIELD', `${valuePath}.${key}`, `Unknown field "${key}".`));
    }
  }
}

function validateIdentifier(value, valuePath, errors) {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || !IDENTIFIER_PATTERN.test(value)) {
    errors.push(issue(
      'INVALID_IDENTIFIER',
      valuePath,
      'Expected a non-empty portable identifier using letters, digits, dot, colon, underscore, or hyphen.'
    ));
    return null;
  }
  return value;
}

function normalizePortablePath(value, valuePath, errors, { allowRoot = false } = {}) {
  if (allowRoot && (value === '.' || value === './')) return null;
  try {
    return normalizeWorkspacePath(value, { path: valuePath });
  } catch (error) {
    if (Array.isArray(error?.errors)) {
      errors.push(...error.errors.map((entry) => ({ ...entry })));
      return null;
    }
    throw error;
  }
}

function validateExpectedArtifact(value, valuePath, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue('INVALID_EXPECTED_ARTIFACT', valuePath, 'Expected a plain object.'));
    return null;
  }
  assertKnownFields(value, ['path', 'size', 'sha256'], valuePath, errors);
  const normalizedPath = normalizePortablePath(value.path, `${valuePath}.path`, errors);

  let size = null;
  if (Object.hasOwn(value, 'size') && value.size !== null) {
    if (!Number.isSafeInteger(value.size) || value.size < 0) {
      errors.push(issue(
        'INVALID_EXPECTED_ARTIFACT_SIZE',
        `${valuePath}.size`,
        'Expected size must be a non-negative safe integer.'
      ));
    } else {
      size = value.size;
    }
  }

  let sha256 = null;
  if (Object.hasOwn(value, 'sha256') && value.sha256 !== null) {
    const match = typeof value.sha256 === 'string' ? SHA256_PATTERN.exec(value.sha256) : null;
    if (!match) {
      errors.push(issue(
        'INVALID_EXPECTED_ARTIFACT_SHA256',
        `${valuePath}.sha256`,
        'Expected sha256 must be a 64-character hexadecimal digest.'
      ));
    } else {
      sha256 = match[1].toLowerCase();
    }
  }

  if (normalizedPath === null) return null;
  return Object.freeze({ path: normalizedPath, size, sha256 });
}

function validateCheck(value, index, errors) {
  const valuePath = `manifest.checks[${index}]`;
  if (!isPlainObject(value)) {
    errors.push(issue('INVALID_CHECK', valuePath, 'Expected a plain object.'));
    return null;
  }
  assertKnownFields(value, [
    'id',
    'kind',
    'command',
    'args',
    'timeoutMs',
    'expectedExitCodes',
    'cwd',
    'captureOutput',
    'expectedArtifacts'
  ], valuePath, errors);

  const id = validateIdentifier(value.id, `${valuePath}.id`, errors);
  const kind = validateIdentifier(value.kind, `${valuePath}.kind`, errors);
  let command = null;
  if (typeof value.command !== 'string'
    || value.command.length === 0
    || value.command !== value.command.trim()
    || value.command.includes('\0')) {
    errors.push(issue(
      'INVALID_COMMAND',
      `${valuePath}.command`,
      'Expected command to be a non-empty, trimmed string without NUL bytes.'
    ));
  } else {
    command = value.command;
  }

  const args = [];
  if (!Array.isArray(value.args)) {
    errors.push(issue('INVALID_ARGUMENTS', `${valuePath}.args`, 'Expected an array of strings.'));
  } else {
    for (let argumentIndex = 0; argumentIndex < value.args.length; argumentIndex += 1) {
      const argument = value.args[argumentIndex];
      if (typeof argument !== 'string' || argument.includes('\0')) {
        errors.push(issue(
          'INVALID_ARGUMENT',
          `${valuePath}.args[${argumentIndex}]`,
          'Command arguments must be strings without NUL bytes.'
        ));
      } else {
        args.push(argument);
      }
    }
  }

  let timeoutMs = null;
  if (!Number.isSafeInteger(value.timeoutMs)
    || value.timeoutMs < 1
    || value.timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    errors.push(issue(
      'INVALID_TIMEOUT',
      `${valuePath}.timeoutMs`,
      `timeoutMs must be an integer from 1 through ${MAX_COMMAND_TIMEOUT_MS}.`
    ));
  } else {
    timeoutMs = value.timeoutMs;
  }

  const expectedExitCodes = [];
  const exitCodes = value.expectedExitCodes ?? [0];
  if (!Array.isArray(exitCodes) || exitCodes.length === 0) {
    errors.push(issue(
      'INVALID_EXPECTED_EXIT_CODES',
      `${valuePath}.expectedExitCodes`,
      'Expected a non-empty array of non-negative safe integers.'
    ));
  } else {
    const seenExitCodes = new Set();
    for (let exitIndex = 0; exitIndex < exitCodes.length; exitIndex += 1) {
      const exitCode = exitCodes[exitIndex];
      if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
        errors.push(issue(
          'INVALID_EXPECTED_EXIT_CODE',
          `${valuePath}.expectedExitCodes[${exitIndex}]`,
          'Expected exit codes must be non-negative safe integers.'
        ));
      } else if (seenExitCodes.has(exitCode)) {
        errors.push(issue(
          'DUPLICATE_EXPECTED_EXIT_CODE',
          `${valuePath}.expectedExitCodes[${exitIndex}]`,
          `Duplicate expected exit code ${exitCode}.`
        ));
      } else {
        seenExitCodes.add(exitCode);
        expectedExitCodes.push(exitCode);
      }
    }
  }

  let cwd = null;
  if (value.cwd !== undefined && value.cwd !== null) {
    cwd = normalizePortablePath(value.cwd, `${valuePath}.cwd`, errors, { allowRoot: true });
  }

  let captureOutput = true;
  if (value.captureOutput !== undefined) {
    if (typeof value.captureOutput !== 'boolean') {
      errors.push(issue(
        'INVALID_CAPTURE_OUTPUT',
        `${valuePath}.captureOutput`,
        'captureOutput must be a boolean when present.'
      ));
    } else {
      captureOutput = value.captureOutput;
    }
  }

  const expectedArtifacts = [];
  if (value.expectedArtifacts !== undefined) {
    if (!Array.isArray(value.expectedArtifacts)) {
      errors.push(issue(
        'INVALID_EXPECTED_ARTIFACTS',
        `${valuePath}.expectedArtifacts`,
        'Expected an array when expectedArtifacts is present.'
      ));
    } else {
      for (let artifactIndex = 0;
        artifactIndex < value.expectedArtifacts.length;
        artifactIndex += 1) {
        const artifact = validateExpectedArtifact(
          value.expectedArtifacts[artifactIndex],
          `${valuePath}.expectedArtifacts[${artifactIndex}]`,
          errors
        );
        if (artifact) expectedArtifacts.push(artifact);
      }
    }
  }

  const pathKeys = new Set();
  for (let artifactIndex = 0; artifactIndex < expectedArtifacts.length; artifactIndex += 1) {
    const key = process.platform === 'win32'
      ? expectedArtifacts[artifactIndex].path.toLocaleLowerCase('en-US')
      : expectedArtifacts[artifactIndex].path;
    if (pathKeys.has(key)) {
      errors.push(issue(
        'DUPLICATE_EXPECTED_ARTIFACT',
        `${valuePath}.expectedArtifacts[${artifactIndex}].path`,
        `Duplicate expected artifact path "${expectedArtifacts[artifactIndex].path}".`
      ));
    }
    pathKeys.add(key);
  }

  if (captureOutput === false && expectedArtifacts.length === 0) {
    errors.push(issue(
      'CAPTURE_OUTPUT_REQUIRES_EXPECTED_ARTIFACT',
      `${valuePath}.expectedArtifacts`,
      'A check with captureOutput false must declare at least one valid expected artifact.'
    ));
  }

  if (id === null || kind === null || command === null || timeoutMs === null) return null;
  if (!Array.isArray(value.args) || args.length !== value.args.length) return null;
  if (expectedExitCodes.length !== exitCodes.length) return null;
  return Object.freeze({
    id,
    kind,
    command,
    args: Object.freeze(args),
    timeoutMs,
    expectedExitCodes: Object.freeze(expectedExitCodes),
    cwd,
    ...(captureOutput === false ? { captureOutput: false } : {}),
    expectedArtifacts: Object.freeze(expectedArtifacts)
  });
}

export function normalizeCommandEvaluationManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    throw new CommandEvaluatorError(
      'FWA_INVALID_EVALUATION_MANIFEST',
      'Evaluation manifest must be a plain object.',
      { errors: [issue('INVALID_MANIFEST', 'manifest', 'Expected a plain object.')] }
    );
  }
  assertKnownFields(manifest, ['schemaVersion', 'id', 'checks'], 'manifest', errors);
  if (manifest.schemaVersion !== COMMAND_EVALUATION_MANIFEST_SCHEMA_VERSION) {
    errors.push(issue(
      'UNSUPPORTED_SCHEMA',
      'manifest.schemaVersion',
      `Expected evaluation manifest schema version ${COMMAND_EVALUATION_MANIFEST_SCHEMA_VERSION}.`
    ));
  }
  const id = validateIdentifier(manifest.id, 'manifest.id', errors);
  if (!Array.isArray(manifest.checks) || manifest.checks.length === 0) {
    errors.push(issue(
      'INVALID_CHECKS',
      'manifest.checks',
      'Expected a non-empty checks array.'
    ));
  }

  const checks = [];
  const ids = new Set();
  if (Array.isArray(manifest.checks)) {
    for (let index = 0; index < manifest.checks.length; index += 1) {
      const check = validateCheck(manifest.checks[index], index, errors);
      if (!check) continue;
      if (ids.has(check.id)) {
        errors.push(issue(
          'DUPLICATE_CHECK_ID',
          `manifest.checks[${index}].id`,
          `Duplicate check id "${check.id}".`
        ));
      }
      ids.add(check.id);
      checks.push(check);
    }
  }

  if (errors.length > 0 || id === null || checks.length !== manifest.checks.length) {
    throw new CommandEvaluatorError(
      'FWA_INVALID_EVALUATION_MANIFEST',
      `Evaluation manifest validation failed with ${errors.length} error(s).`,
      { errors }
    );
  }
  return Object.freeze({
    schemaVersion: COMMAND_EVALUATION_MANIFEST_SCHEMA_VERSION,
    id,
    checks: Object.freeze(checks)
  });
}

function normalizeEnvironment(value) {
  if (!isPlainObject(value)) {
    throw new CommandEvaluatorError(
      'FWA_INVALID_EVALUATION_ENVIRONMENT',
      'env must be a plain object containing string values.'
    );
  }
  const result = Object.create(null);
  const caseInsensitiveKeys = process.platform === 'win32' ? new Map() : null;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (key.length === 0 || key.includes('\0') || key.includes('=')) {
      throw new CommandEvaluatorError(
        'FWA_INVALID_EVALUATION_ENVIRONMENT',
        `Environment key ${JSON.stringify(key)} is invalid.`
      );
    }
    if (typeof item !== 'string' || item.includes('\0')) {
      throw new CommandEvaluatorError(
        'FWA_INVALID_EVALUATION_ENVIRONMENT',
        `Environment value for ${JSON.stringify(key)} must be a string without NUL bytes.`
      );
    }
    if (caseInsensitiveKeys) {
      const foldedKey = key.toLocaleLowerCase('en-US');
      const previousKey = caseInsensitiveKeys.get(foldedKey);
      if (previousKey !== undefined && previousKey !== key) {
        throw new CommandEvaluatorError(
          'FWA_INVALID_EVALUATION_ENVIRONMENT',
          `Environment keys ${JSON.stringify(previousKey)} and ${JSON.stringify(key)} collide on Windows.`
        );
      }
      caseInsensitiveKeys.set(foldedKey, key);
    }
    result[key] = item;
  }
  return Object.freeze(result);
}

function environmentFingerprint(environment) {
  const serialized = JSON.stringify(
    Object.keys(environment).sort(compareStrings).map((key) => [key, environment[key]])
  );
  return Object.freeze({
    platform: process.platform,
    arch: process.arch,
    runtime: Object.freeze({ name: 'node', version: process.version }),
    environmentSha256: createHash('sha256').update(serialized).digest('hex')
  });
}

function assertOutputLimit(value) {
  if (!Number.isSafeInteger(value)
    || value < 1
    || value > MAX_OUTPUT_LIMIT_BYTES) {
    throw new CommandEvaluatorError(
      'FWA_INVALID_OUTPUT_LIMIT',
      `outputLimitBytes must be an integer from 1 through ${MAX_OUTPUT_LIMIT_BYTES}.`
    );
  }
  return value;
}

function assertTerminationGrace(value) {
  if (!Number.isSafeInteger(value)
    || value < 1
    || value > MAX_TERMINATION_GRACE_MS) {
    throw new CommandEvaluatorError(
      'FWA_INVALID_TERMINATION_GRACE',
      `terminationGraceMs must be an integer from 1 through ${MAX_TERMINATION_GRACE_MS}.`
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
    throw new CommandEvaluatorError(
      'FWA_INVALID_ABORT_SIGNAL',
      'signal must be an AbortSignal when supplied.'
    );
  }
}

async function lstatIfPresent(targetPath, options = undefined) {
  try {
    return await lstat(targetPath, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isContained(workspaceRoot, targetPath) {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative.length === 0
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function targetFor(workspaceRoot, portablePath) {
  if (portablePath === null) return workspaceRoot;
  const targetPath = path.resolve(workspaceRoot, ...portablePath.split('/'));
  if (!isContained(workspaceRoot, targetPath)) {
    throw new CommandEvaluatorError(
      'FWA_EVALUATION_PATH_ESCAPE',
      `Evaluation path "${portablePath}" escapes the workspace.`
    );
  }
  return targetPath;
}

async function inspectSafePath(workspaceRoot, targetPath) {
  if (!isContained(workspaceRoot, targetPath)) {
    throw new CommandEvaluatorError(
      'FWA_EVALUATION_PATH_ESCAPE',
      `Evaluation path escapes workspace ${workspaceRoot}.`
    );
  }
  const relative = path.relative(workspaceRoot, targetPath);
  const segments = relative.length === 0 ? [] : relative.split(path.sep);
  let current = workspaceRoot;
  let stats = await lstatIfPresent(current);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CommandEvaluatorError(
      'FWA_UNSAFE_EVALUATION_WORKSPACE',
      'workspaceRoot must be an existing, non-symlink directory.'
    );
  }
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    stats = await lstatIfPresent(current);
    if (!stats) return null;
    if (stats.isSymbolicLink()) {
      throw new CommandEvaluatorError(
        'FWA_SYMLINK_EVALUATION_PATH',
        `Evaluation path component is a symbolic link: ${current}.`
      );
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new CommandEvaluatorError(
        'FWA_NON_DIRECTORY_EVALUATION_ANCESTOR',
        `Evaluation path ancestor is not a directory: ${current}.`
      );
    }
  }
  return stats;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino !== 0n
    && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readBoundedFile(file, limitBytes) {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= limitBytes) {
    const remaining = (limitBytes + 1) - totalBytes;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  return Buffer.concat(chunks, totalBytes);
}

async function readSafeArtifact(workspaceRoot, targetPath, portablePath) {
  const initialPathStats = await inspectSafePath(workspaceRoot, targetPath);
  if (!initialPathStats) return null;
  if (!initialPathStats.isFile() || initialPathStats.isSymbolicLink()) {
    throw new CommandEvaluatorError(
      'FWA_EXPECTED_ARTIFACT_NOT_A_FILE',
      `Expected artifact is not a regular file: ${portablePath}.`
    );
  }

  const beforeOpenStats = await lstatIfPresent(targetPath, { bigint: true });
  if (!beforeOpenStats || !beforeOpenStats.isFile() || beforeOpenStats.isSymbolicLink()) {
    throw new CommandEvaluatorError(
      'FWA_EXPECTED_ARTIFACT_CHANGED_DURING_READ',
      `Expected artifact changed before it could be opened: ${portablePath}.`
    );
  }

  let file;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    file = await open(targetPath, fsConstants.O_RDONLY | noFollow);
    const openedStats = await file.stat({ bigint: true });
    if (!openedStats.isFile()) {
      throw new CommandEvaluatorError(
        'FWA_EXPECTED_ARTIFACT_NOT_A_FILE',
        `Expected artifact is not a regular file: ${portablePath}.`
      );
    }
    if (!sameFileIdentity(beforeOpenStats, openedStats)) {
      throw new CommandEvaluatorError(
        'FWA_EXPECTED_ARTIFACT_CHANGED_DURING_READ',
        `Expected artifact was replaced while being opened: ${portablePath}.`
      );
    }
    if (openedStats.size > BigInt(MAX_OUTPUT_LIMIT_BYTES)) {
      throw new CommandEvaluatorError(
        'FWA_EXPECTED_ARTIFACT_TOO_LARGE',
        `Expected artifact exceeds the ${MAX_OUTPUT_LIMIT_BYTES}-byte evidence limit.`,
        { size: Number(openedStats.size), limitBytes: MAX_OUTPUT_LIMIT_BYTES }
      );
    }

    const bytes = await readBoundedFile(file, MAX_OUTPUT_LIMIT_BYTES);
    if (bytes.byteLength > MAX_OUTPUT_LIMIT_BYTES) {
      throw new CommandEvaluatorError(
        'FWA_EXPECTED_ARTIFACT_TOO_LARGE',
        `Expected artifact exceeds the ${MAX_OUTPUT_LIMIT_BYTES}-byte evidence limit.`,
        { size: bytes.byteLength, limitBytes: MAX_OUTPUT_LIMIT_BYTES }
      );
    }

    const afterReadStats = await file.stat({ bigint: true });
    const currentPathStats = await lstatIfPresent(targetPath, { bigint: true });
    if (!currentPathStats
      || currentPathStats.isSymbolicLink()
      || !sameFileSnapshot(openedStats, afterReadStats)
      || !sameFileSnapshot(afterReadStats, currentPathStats)
      || BigInt(bytes.byteLength) !== afterReadStats.size) {
      throw new CommandEvaluatorError(
        'FWA_EXPECTED_ARTIFACT_CHANGED_DURING_READ',
        `Expected artifact changed while it was being read: ${portablePath}.`
      );
    }
    await inspectSafePath(workspaceRoot, targetPath);
    return { bytes, stats: afterReadStats };
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

async function captureArtifactBaseline(workspaceRoot, expected) {
  const targetPath = targetFor(workspaceRoot, expected.path);
  let read;
  try {
    read = await readSafeArtifact(workspaceRoot, targetPath, expected.path);
  } catch (error) {
    if (error?.code === 'FWA_EXPECTED_ARTIFACT_TOO_LARGE') {
      return Object.freeze({
        existed: true,
        size: error.details?.size ?? null,
        digest: null
      });
    }
    throw error;
  }
  if (!read) {
    return Object.freeze({ existed: false, size: null, digest: null });
  }
  return Object.freeze({
    existed: true,
    size: read.bytes.byteLength,
    digest: createHash('sha256').update(read.bytes).digest('hex')
  });
}

async function preflightCheckPaths(workspaceRoot, check, captureBaselines = false) {
  const cwd = targetFor(workspaceRoot, check.cwd);
  const cwdStats = await inspectSafePath(workspaceRoot, cwd);
  if (!cwdStats || !cwdStats.isDirectory()) {
    throw new CommandEvaluatorError(
      'FWA_INVALID_EVALUATION_CWD',
      `Evaluation cwd must be an existing directory: ${check.cwd ?? '.'}.`,
      { checkId: check.id, cwd: check.cwd }
    );
  }

  const artifactBaselines = [];
  for (const expected of check.expectedArtifacts) {
    const expectedPath = targetFor(workspaceRoot, expected.path);
    const stats = await inspectSafePath(workspaceRoot, expectedPath);
    if (stats && !stats.isFile()) {
      throw new CommandEvaluatorError(
        'FWA_INVALID_EXPECTED_ARTIFACT_PATH',
        `Expected artifact path is not a regular file: ${expected.path}.`,
        { checkId: check.id, path: expected.path }
      );
    }
    if (captureBaselines) {
      artifactBaselines.push(await captureArtifactBaseline(workspaceRoot, expected));
    }
  }
  return { cwd, artifactBaselines };
}

async function preflightPaths(workspaceRoot, manifest) {
  await inspectSafePath(workspaceRoot, workspaceRoot);
  for (const check of manifest.checks) {
    await preflightCheckPaths(workspaceRoot, check);
  }
}

function failure(code, message, details = undefined) {
  const result = { code, message };
  if (details !== undefined) result.details = details;
  return result;
}

function safeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    message: typeof error?.message === 'string' ? error.message : String(error)
  };
}

function outputCollector(name, limitBytes, requestStop) {
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
        requestStop(failure(
          'OUTPUT_LIMIT_EXCEEDED',
          `${name} exceeded the ${limitBytes}-byte capture limit.`,
          { stream: name, limitBytes }
        ));
      }
    },
    onError(error) {
      streamError = safeError(error);
      requestStop(failure(
        'OUTPUT_STREAM_FAILED',
        `Failed while reading child ${name}.`,
        { stream: name, error: streamError }
      ));
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

function emptyOutputResult() {
  return {
    text: '',
    capturedBytes: 0,
    observedBytes: 0,
    truncated: false,
    streamError: null
  };
}

async function runTaskkill(pid, timeoutMs) {
  await new Promise((resolve) => {
    let settled = false;
    let timeout;
    const done = () => {
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
      done();
      return;
    }
    killer.once('error', done);
    killer.once('close', done);
    timeout = setTimeout(() => {
      try {
        killer.kill('SIGKILL');
      } catch {
        // The helper may already have exited.
      }
      done();
    }, timeoutMs);
  });
}

async function terminateProcessTree(child, platform, isClosed, terminationGraceMs) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    try {
      child.kill('SIGKILL');
    } catch {
      // A process that never spawned has no tree to terminate.
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
        // The process may have exited between the two kill attempts.
      }
    }
  }
}

function skippedCheck(check, failedCheckId) {
  return {
    id: check.id,
    kind: check.kind,
    status: 'skipped',
    passed: false,
    command: check.command,
    args: [...check.args],
    cwd: null,
    timeoutMs: check.timeoutMs,
    expectedExitCodes: [...check.expectedExitCodes],
    exitCode: null,
    signal: null,
    terminationConfirmed: null,
    timedOut: false,
    aborted: false,
    durationMs: 0,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutObservedBytes: 0,
    stderrObservedBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    expectedArtifacts: check.expectedArtifacts.map((expected) => artifactNotEvaluated(
      expected,
      'FAIL_FAST',
      `Expected artifact was not evaluated after ${failedCheckId} failed.`,
      { failedCheckId }
    )),
    failure: failure(
      'FAIL_FAST',
      `Check was skipped after ${failedCheckId} failed.`,
      { failedCheckId }
    )
  };
}

function artifactNotEvaluated(expected, reasonCode, message, details = undefined, baseline = null) {
  return {
    path: expected.path,
    expectedSize: expected.size,
    expectedSha256: expected.sha256,
    before: baseline === null
      ? { existed: null, size: null, digest: null }
      : { existed: baseline.existed, size: baseline.size, digest: baseline.digest },
    size: null,
    algorithm: 'sha256',
    digest: null,
    bytesBase64: null,
    passed: false,
    failure: failure('EXPECTED_ARTIFACT_NOT_EVALUATED', message, {
      reason: reasonCode,
      ...(details ?? {})
    })
  };
}

async function inspectExpectedArtifact(workspaceRoot, expected, baseline) {
  const targetPath = targetFor(workspaceRoot, expected.path);
  const base = {
    path: expected.path,
    expectedSize: expected.size,
    expectedSha256: expected.sha256,
    before: {
      existed: baseline.existed,
      size: baseline.size,
      digest: baseline.digest
    },
    size: null,
    algorithm: 'sha256',
    digest: null,
    bytesBase64: null
  };
  let read;
  try {
    read = await readSafeArtifact(workspaceRoot, targetPath, expected.path);
  } catch (error) {
    const artifactFailureCode = error?.code === 'FWA_EXPECTED_ARTIFACT_TOO_LARGE'
      ? 'EXPECTED_ARTIFACT_TOO_LARGE'
      : error?.code === 'FWA_EXPECTED_ARTIFACT_NOT_A_FILE'
        ? 'EXPECTED_ARTIFACT_NOT_A_FILE'
        : error?.code === 'FWA_EXPECTED_ARTIFACT_CHANGED_DURING_READ'
          ? 'EXPECTED_ARTIFACT_CHANGED_DURING_READ'
          : error?.code === 'ELOOP'
            || error?.code === 'FWA_SYMLINK_EVALUATION_PATH'
            || error?.code === 'FWA_EVALUATION_PATH_ESCAPE'
            || error?.code === 'FWA_UNSAFE_EVALUATION_WORKSPACE'
            || error?.code === 'FWA_NON_DIRECTORY_EVALUATION_ANCESTOR'
            ? 'EXPECTED_ARTIFACT_UNSAFE'
            : 'EXPECTED_ARTIFACT_READ_FAILED';
    return {
      ...base,
      passed: false,
      failure: failure(
        artifactFailureCode,
        `Failed to collect expected artifact: ${expected.path}.`,
        { error: safeError(error) }
      )
    };
  }
  if (!read) {
    return {
      ...base,
      passed: false,
      failure: failure(
        'EXPECTED_ARTIFACT_MISSING',
        `Expected artifact is missing: ${expected.path}.`
      )
    };
  }
  const { bytes } = read;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const result = {
    ...base,
    size: bytes.byteLength,
    digest,
    bytesBase64: bytes.toString('base64')
  };
  if (expected.size !== null && bytes.byteLength !== expected.size) {
    return {
      ...result,
      passed: false,
      failure: failure(
        'EXPECTED_ARTIFACT_SIZE_MISMATCH',
        `Expected artifact size differs for ${expected.path}.`,
        { expected: expected.size, actual: bytes.byteLength }
      )
    };
  }
  if (expected.sha256 !== null && digest !== expected.sha256) {
    return {
      ...result,
      passed: false,
      failure: failure(
        'EXPECTED_ARTIFACT_DIGEST_MISMATCH',
        `Expected artifact digest differs for ${expected.path}.`,
        { expected: expected.sha256, actual: digest }
      )
    };
  }
  if (baseline.existed
    && baseline.size === bytes.byteLength
    && baseline.digest === digest) {
    return {
      ...result,
      passed: false,
      failure: failure(
        'EXPECTED_ARTIFACT_NOT_UPDATED',
        `Expected artifact was not created or changed by check: ${expected.path}.`
      )
    };
  }
  return { ...result, passed: true, failure: null };
}

function preAbortedCheck(check, workspaceRoot) {
  return {
    id: check.id,
    kind: check.kind,
    status: 'failed',
    passed: false,
    command: check.command,
    args: [...check.args],
    cwd: targetFor(workspaceRoot, check.cwd),
    timeoutMs: check.timeoutMs,
    expectedExitCodes: [...check.expectedExitCodes],
    exitCode: null,
    signal: null,
    terminationConfirmed: true,
    timedOut: false,
    aborted: true,
    durationMs: 0,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutObservedBytes: 0,
    stderrObservedBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    expectedArtifacts: check.expectedArtifacts.map((expected) => artifactNotEvaluated(
      expected,
      'COMMAND_ABORTED',
      'Expected artifact was not evaluated because the command was aborted before start.'
    )),
    failure: failure('COMMAND_ABORTED', 'Evaluation was aborted before the command started.')
  };
}

async function runCheck({
  check,
  workspaceRoot,
  cwd,
  artifactBaselines,
  environment,
  outputLimitBytes,
  signal,
  spawnImpl,
  platform,
  terminationGraceMs
}) {
  const startedAt = Date.now();
  const captureOutput = check.captureOutput !== false;
  let child;
  try {
    child = spawnImpl(check.command, [...check.args], {
      cwd,
      // Node's coverage runner adds NODE_V8_COVERAGE during spawn. Keep the
      // evaluator's normalized snapshot immutable, but hand child_process its
      // own mutable copy so instrumentation cannot mutate durable inputs.
      env: { ...environment },
      shell: false,
      windowsHide: true,
      detached: platform !== 'win32',
      stdio: captureOutput
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'ignore', 'ignore']
    });
  } catch (error) {
    const spawnFailure = safeError(error);
    return {
      id: check.id,
      kind: check.kind,
      status: 'failed',
      passed: false,
      command: check.command,
      args: [...check.args],
      cwd,
      timeoutMs: check.timeoutMs,
      expectedExitCodes: [...check.expectedExitCodes],
      exitCode: null,
      signal: null,
      terminationConfirmed: true,
      timedOut: false,
      aborted: false,
      durationMs: Math.max(0, Date.now() - startedAt),
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutObservedBytes: 0,
      stderrObservedBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      expectedArtifacts: check.expectedArtifacts.map((expected, index) => artifactNotEvaluated(
        expected,
        'COMMAND_SPAWN_FAILED',
        'Expected artifact was not evaluated because the command could not be spawned.',
        undefined,
        artifactBaselines[index]
      )),
      failure: failure(
        'COMMAND_SPAWN_FAILED',
        `Failed to spawn command for check ${check.id}.`,
        { error: spawnFailure }
      )
    };
  }
  if (!child || typeof child.once !== 'function'
    || (captureOutput && (
      !child.stdout || typeof child.stdout.on !== 'function'
      || !child.stderr || typeof child.stderr.on !== 'function'
    ))) {
    throw new CommandEvaluatorError(
      'FWA_INVALID_SPAWN_PORT',
      'spawnImpl must return a ChildProcess, with piped stdout and stderr when captureOutput is enabled.'
    );
  }

  const raw = await new Promise((resolve, reject) => {
    let closed = false;
    let settled = false;
    let stopReason = null;
    let spawnError = null;
    let termination = null;
    let terminationDeadline;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(terminationDeadline);
      signal?.removeEventListener('abort', onAbort);
    };
    const requestStop = (reason) => {
      if (stopReason !== null || closed) return;
      stopReason = reason;
      termination = terminateProcessTree(
        child,
        platform,
        () => closed,
        terminationGraceMs
      ).catch(() => {});
      terminationDeadline = setTimeout(() => {
        if (settled || closed) return;
        settled = true;
        cleanup();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        reject(new CommandEvaluatorError(
          'FWA_PROCESS_TERMINATION_UNCONFIRMED',
          `Process termination could not be confirmed for check ${check.id}.`,
          {
            checkId: check.id,
            terminationGraceMs,
            reason: stopReason
          }
        ));
      }, terminationGraceMs);
    };
    const stdout = captureOutput
      ? outputCollector('stdout', outputLimitBytes, requestStop)
      : null;
    const stderr = captureOutput
      ? outputCollector('stderr', outputLimitBytes, requestStop)
      : null;
    const onAbort = () => requestStop(failure(
      'COMMAND_ABORTED',
      `Check ${check.id} was aborted.`
    ));

    if (captureOutput) {
      child.stdout.on('data', stdout.onData);
      child.stdout.on('error', stdout.onError);
      child.stderr.on('data', stderr.onData);
      child.stderr.on('error', stderr.onError);
    }
    child.once('error', (error) => {
      spawnError = safeError(error);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => requestStop(failure(
      'COMMAND_TIMEOUT',
      `Check ${check.id} exceeded its ${check.timeoutMs} ms timeout.`,
      { timeoutMs: check.timeoutMs }
    )), check.timeoutMs);
    if (signal?.aborted) onAbort();

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
        spawnError,
        stdout: captureOutput ? stdout.result() : emptyOutputResult(),
        stderr: captureOutput ? stderr.result() : emptyOutputResult()
      });
    });
  });

  const expectedArtifacts = [];
  for (let index = 0; index < check.expectedArtifacts.length; index += 1) {
    expectedArtifacts.push(await inspectExpectedArtifact(
      workspaceRoot,
      check.expectedArtifacts[index],
      artifactBaselines[index]
    ));
  }

  let checkFailure = raw.stopReason;
  if (checkFailure === null && raw.spawnError !== null) {
    checkFailure = failure(
      'COMMAND_SPAWN_FAILED',
      `Failed to spawn command for check ${check.id}.`,
      { error: raw.spawnError }
    );
  }
  if (checkFailure === null && raw.stdout.streamError !== null) {
    checkFailure = failure(
      'OUTPUT_STREAM_FAILED',
      'Failed while reading child stdout.',
      { stream: 'stdout', error: raw.stdout.streamError }
    );
  }
  if (checkFailure === null && raw.stderr.streamError !== null) {
    checkFailure = failure(
      'OUTPUT_STREAM_FAILED',
      'Failed while reading child stderr.',
      { stream: 'stderr', error: raw.stderr.streamError }
    );
  }
  if (checkFailure === null && raw.signal !== null) {
    checkFailure = failure(
      'COMMAND_SIGNALLED',
      `Check ${check.id} exited because of signal ${raw.signal}.`,
      { signal: raw.signal }
    );
  }
  if (checkFailure === null && !check.expectedExitCodes.includes(raw.exitCode)) {
    checkFailure = failure(
      'UNEXPECTED_EXIT_CODE',
      `Check ${check.id} exited with unexpected code ${String(raw.exitCode)}.`,
      { expected: [...check.expectedExitCodes], actual: raw.exitCode }
    );
  }
  if (checkFailure === null) {
    const failedArtifact = expectedArtifacts.find((artifact) => !artifact.passed);
    if (failedArtifact) checkFailure = failedArtifact.failure;
  }

  return {
    id: check.id,
    kind: check.kind,
    status: checkFailure === null ? 'passed' : 'failed',
    passed: checkFailure === null,
    command: check.command,
    args: [...check.args],
    cwd,
    timeoutMs: check.timeoutMs,
    expectedExitCodes: [...check.expectedExitCodes],
    exitCode: raw.exitCode,
    signal: raw.signal,
    // This confirms that the managed direct ChildProcess emitted close. A
    // normal command is trusted not to detach background descendants.
    terminationConfirmed: true,
    timedOut: raw.stopReason?.code === 'COMMAND_TIMEOUT',
    aborted: raw.stopReason?.code === 'COMMAND_ABORTED',
    durationMs: Math.max(0, Date.now() - startedAt),
    stdout: raw.stdout.text,
    stderr: raw.stderr.text,
    stdoutBytes: raw.stdout.capturedBytes,
    stderrBytes: raw.stderr.capturedBytes,
    stdoutObservedBytes: raw.stdout.observedBytes,
    stderrObservedBytes: raw.stderr.observedBytes,
    stdoutTruncated: raw.stdout.truncated,
    stderrTruncated: raw.stderr.truncated,
    expectedArtifacts,
    failure: checkFailure
  };
}

export class CommandEvaluatorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CommandEvaluatorError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class CommandEvaluator {
  #environment;
  #fingerprint;
  #outputLimitBytes;
  #platform;
  #spawn;
  #terminationGraceMs;

  constructor(options = {}) {
    if (!isPlainObject(options)) {
      throw new CommandEvaluatorError(
        'FWA_INVALID_COMMAND_EVALUATOR_OPTIONS',
        'CommandEvaluator options must be a plain object.'
      );
    }
    this.schemaVersion = EVALUATOR_SCHEMA_VERSION;
    this.id = options.id ?? 'command-evaluator';
    this.version = options.version ?? '1';
    this.#environment = normalizeEnvironment(
      options.env === undefined ? { ...process.env } : options.env
    );
    this.#fingerprint = environmentFingerprint(this.#environment);
    this.#outputLimitBytes = assertOutputLimit(
      options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES
    );
    this.#spawn = options.spawnImpl ?? nodeSpawn;
    this.#platform = options.platform ?? process.platform;
    this.#terminationGraceMs = assertTerminationGrace(
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS
    );
    if (typeof this.#spawn !== 'function') {
      throw new CommandEvaluatorError(
        'FWA_INVALID_SPAWN_PORT',
        'spawnImpl must be a function.'
      );
    }
    if (typeof this.#platform !== 'string'
      || this.#platform.length === 0
      || this.#platform !== this.#platform.trim()) {
      throw new CommandEvaluatorError(
        'FWA_INVALID_PLATFORM',
        'platform must be a string.'
      );
    }
    assertEvaluator(this);
  }

  normalizeProfile(profile) {
    return normalizeCommandEvaluationManifest(profile);
  }

  async evaluate({ workspaceRoot, manifest, signal } = {}) {
    assertSignal(signal);
    if (typeof workspaceRoot !== 'string'
      || workspaceRoot.length === 0
      || workspaceRoot !== workspaceRoot.trim()) {
      throw new CommandEvaluatorError(
        'FWA_INVALID_EVALUATION_WORKSPACE',
        'workspaceRoot must be a non-empty, trimmed path.'
      );
    }
    const root = path.resolve(workspaceRoot);
    const normalizedManifest = this.normalizeProfile(manifest);

    // Every schema and filesystem path is checked before the first subprocess
    // starts. Execution never partially begins because a later check is invalid.
    await preflightPaths(root, normalizedManifest);

    const startedAt = Date.now();
    const checks = [];
    let failedCheckId = null;
    for (const check of normalizedManifest.checks) {
      if (failedCheckId !== null) {
        checks.push(skippedCheck(check, failedCheckId));
        continue;
      }
      let result;
      if (signal?.aborted) {
        result = preAbortedCheck(check, root);
      } else {
        // Earlier checks can mutate the workspace. Recheck this check's cwd and
        // artifact paths immediately before spawning, then bind artifact verdicts
        // to the bytes observed at that point.
        const prepared = await preflightCheckPaths(root, check, true);
        result = signal?.aborted
          ? preAbortedCheck(check, root)
          : await runCheck({
            check,
            workspaceRoot: root,
            cwd: prepared.cwd,
            artifactBaselines: prepared.artifactBaselines,
            environment: this.#environment,
            outputLimitBytes: this.#outputLimitBytes,
            signal,
            spawnImpl: this.#spawn,
            platform: this.#platform,
            terminationGraceMs: this.#terminationGraceMs
          });
      }
      checks.push(result);
      if (!result.passed) failedCheckId = check.id;
    }

    return {
      schemaVersion: COMMAND_EVALUATION_MANIFEST_SCHEMA_VERSION,
      evaluator: { id: this.id, version: this.version },
      manifest: { id: normalizedManifest.id, schemaVersion: normalizedManifest.schemaVersion },
      passed: failedCheckId === null,
      environmentFingerprint: {
        platform: this.#fingerprint.platform,
        arch: this.#fingerprint.arch,
        runtime: { ...this.#fingerprint.runtime },
        environmentSha256: this.#fingerprint.environmentSha256
      },
      durationMs: Math.max(0, Date.now() - startedAt),
      checks
    };
  }
}
