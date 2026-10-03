import { spawn } from 'node:child_process';

import { createGitEnvironment } from './git-environment.js';
import {
  inspectGitProcessFence,
  recordGitProcessFence,
  recoverGitProcessFence
} from './git-process-fence.js';

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
export const MAX_GIT_TIMEOUT_MS = 3_600_000;
export const DEFAULT_GIT_TERMINATION_GRACE_MS = 5_000;
export const MAX_GIT_TERMINATION_GRACE_MS = 60_000;
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export class GitProcessError extends Error {
  constructor(message, code, { cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitProcessError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function validateGitProcessOptions({
  gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  gitTerminationGraceMs = DEFAULT_GIT_TERMINATION_GRACE_MS
} = {}, ErrorType = GitProcessError) {
  for (const [name, value, maximum] of [
    ['gitTimeoutMs', gitTimeoutMs, MAX_GIT_TIMEOUT_MS],
    ['gitTerminationGraceMs', gitTerminationGraceMs, MAX_GIT_TERMINATION_GRACE_MS]
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new ErrorType(
        `${name} must be an integer from 1 through ${maximum}.`,
        'invalid-git-process-options',
        { details: { option: name, maximum } }
      );
    }
  }
  return { gitTimeoutMs, gitTerminationGraceMs };
}

/** Do not perform further Git reads or cleanup after an unconfirmed child. */
export class GitProcessGuard {
  #failure = null;

  constructor(projectRoot, ErrorType = GitProcessError) {
    this.projectRoot = projectRoot;
    this.ErrorType = ErrorType;
  }

  async inspect() {
    const inspection = await inspectGitProcessFence(this.projectRoot, this.ErrorType);
    if (!inspection.held && this.#failure) {
      return { ...inspection, held: true, inMemoryOnly: true, failure: this.#failure.details };
    }
    return inspection;
  }

  async recover(options) {
    const recovered = await recoverGitProcessFence(this.projectRoot, options, this.ErrorType);
    this.#failure = null;
    return recovered;
  }

  async assertAvailable() {
    if (this.#failure) {
      throw new this.ErrorType(
        'This Git adapter is fenced because a previous process may still be running.',
        'git-process-termination-unconfirmed',
        { cause: this.#failure, details: { ...this.#failure.details, adapterFenced: true } }
      );
    }
    const inspection = await this.inspect();
    if (inspection.held) {
      throw new this.ErrorType(
        'The project has an unconfirmed Git process; explicit operator recovery is required.',
        'git-process-termination-unconfirmed',
        { details: {
          ...inspection.fence, fenceId: inspection.fence.id,
          fencePath: inspection.path, terminationConfirmed: false, adapterFenced: true
        } }
      );
    }
  }

  async run(runner, executable, arguments_, options) {
    await this.assertAvailable();
    try {
      return await runner(executable, arguments_, options);
    } catch (error) {
      if (error?.code === 'git-process-termination-unconfirmed') {
        this.#failure = error;
        try {
          const inspection = await recordGitProcessFence(this.projectRoot, error, this.ErrorType);
          const fenced = new this.ErrorType(error.message, error.code, {
            cause: error, details: {
              ...error.details, fenceId: inspection.fence.id,
              fencePath: inspection.path, fencePersisted: true
            }
          });
          this.#failure = fenced;
          throw fenced;
        } catch (persistenceError) {
          if (persistenceError === this.#failure) throw persistenceError;
          const fenced = new this.ErrorType(error.message, error.code, {
            cause: error, details: {
              ...error.details, fencePersisted: false,
              fenceFailure: { code: persistenceError.code ?? null, message: persistenceError.message }
            }
          });
          this.#failure = fenced;
          throw fenced;
        }
      }
      throw error;
    }
  }
}

async function taskkill(pid, timeoutMs) {
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    let killer;
    try {
      killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore'
      });
    } catch {
      finish();
      return;
    }
    killer.once('error', finish);
    killer.once('close', finish);
    timer = setTimeout(() => {
      try { killer.kill('SIGKILL'); } catch { /* The helper may have exited. */ }
      killer.unref?.();
      finish();
    }, timeoutMs);
  });
}

async function terminateTree(child, platform, isClosed, graceMs) {
  if (platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    // The helper shares the outer grace: leave time for the managed-child
    // fallback and its close event instead of spending the entire deadline.
    await taskkill(child.pid, Math.min(2_000, Math.max(1, Math.floor(graceMs / 2))));
    if (isClosed()) return;
  } else if (Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch { /* Fall back to the managed child if its process group is absent. */ }
  }
  try { child.kill('SIGKILL'); } catch { /* Close is still required as proof. */ }
}

/**
 * Execute one local Git command with a bound independent of its caller's phase.
 * A stopped command rejects only after ChildProcess.close, or with an explicit
 * unconfirmed-termination error. Close confirms the managed child; process-tree
 * termination is attempted and is not represented as proof of unrelated or
 * deliberately detached descendants being gone.
 */
export function runGitProcess(executable, arguments_, {
  cwd,
  env = createGitEnvironment(),
  allowedExitCodes = [0],
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_GIT_TERMINATION_GRACE_MS,
  signal,
  ErrorType = GitProcessError,
  spawnImpl = spawn,
  terminateImpl = terminateTree,
  platform = process.platform
} = {}) {
  validateGitProcessOptions({
    gitTimeoutMs: timeoutMs, gitTerminationGraceMs: terminationGraceMs
  }, ErrorType);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new ErrorType('maxOutputBytes must be a positive integer.', 'invalid-git-process-options');
  }
  if (signal !== undefined && (typeof signal?.addEventListener !== 'function'
    || typeof signal?.removeEventListener !== 'function'
    || typeof signal?.aborted !== 'boolean')) {
    throw new ErrorType('signal must be an AbortSignal.', 'invalid-git-process-options');
  }
  const command = { arguments: [...arguments_], cwd, timeoutMs, terminationGraceMs };
  if (signal?.aborted) {
    return Promise.reject(new ErrorType('Git command was aborted before spawning.', 'git-command-aborted', {
      details: { ...command, terminationConfirmed: true, processTreeTerminationAttempted: false, pid: null }
    }));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, arguments_, {
        cwd, env, shell: false, windowsHide: true,
        detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (cause) {
      reject(new ErrorType(`Unable to execute ${executable}.`, 'git-command-failed', {
        cause, details: { ...command, terminationConfirmed: true, pid: null }
      }));
      return;
    }
    let settled = false;
    let closed = false;
    let spawnError = null;
    let stopReason = null;
    let timeout;
    let terminationDeadline;
    let termination = null;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    const cleanTimers = () => {
      clearTimeout(timeout);
      clearTimeout(terminationDeadline);
      signal?.removeEventListener('abort', onAbort);
    };
    const requestStop = (code, message) => {
      if (stopReason || settled || closed) return;
      stopReason = { code, message };
      termination = Promise.resolve().then(() => terminateImpl(
        child, platform, () => closed, terminationGraceMs
      )).catch(() => {});
      terminationDeadline = setTimeout(() => {
        if (settled || closed) return;
        settled = true;
        cleanTimers();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        reject(new ErrorType(
          'Git process termination could not be confirmed; retain the workspace for recovery.',
          'git-process-termination-unconfirmed',
          { details: {
            ...command, pid: child.pid ?? null, reason: stopReason.code,
            terminationConfirmed: false, processTreeTerminationAttempted: true
          } }
        ));
      }, terminationGraceMs);
    };
    const onAbort = () => requestStop('git-command-aborted', 'Git command was aborted.');
    const capture = (bucket, chunk) => {
      if (settled || stopReason) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) {
        requestStop('git-output-limit', 'Git command output exceeded the adapter limit.');
        return;
      }
      bucket.push(bytes);
    };
    child.stdout.on('data', (chunk) => capture(stdout, chunk));
    child.stderr.on('data', (chunk) => capture(stderr, chunk));
    child.stdout.on('error', () => requestStop('git-output-failed', 'Git stdout could not be read.'));
    child.stderr.on('error', () => requestStop('git-output-failed', 'Git stderr could not be read.'));
    child.once('error', (error) => { spawnError = error; });
    child.once('close', async (status, closeSignal) => {
      closed = true;
      if (settled) return;
      settled = true;
      cleanTimers();
      if (termination) await termination;
      const result = {
        status, signal: closeSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (stopReason || spawnError || !allowedExitCodes.includes(status)) {
        reject(new ErrorType(
          stopReason?.message ?? (spawnError
            ? `Unable to execute ${executable}.`
            : `Git command failed with status ${String(status)}.`),
          stopReason?.code ?? 'git-command-failed',
          { cause: spawnError ?? undefined, details: {
            ...command, status, signal: closeSignal, pid: child.pid ?? null,
            stderr: result.stderr.trimEnd(), maxOutputBytes,
            terminationConfirmed: true, processTreeTerminationAttempted: stopReason !== null
          } }
        ));
        return;
      }
      resolve(result);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => requestStop(
      'git-command-timeout', `Git command exceeded its ${timeoutMs} ms timeout.`
    ), timeoutMs);
    if (signal?.aborted) onAbort();
  });
}
