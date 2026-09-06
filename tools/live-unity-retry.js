import { assertEvaluator } from '../src/core/evaluator.js';

export const MAX_LIVE_UNITY_ATTEMPTS = 3;
export const DEFAULT_LIVE_UNITY_BACKOFF_MS = Object.freeze([5_000, 15_000]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function requireOptions(value) {
  if (!isPlainObject(value)) {
    throw new TypeError('Live Unity retry options must be a plain object.');
  }
  const allowed = new Set(['maxAttempts', 'backoffMs', 'writeAttempt']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown Live Unity retry option "${key}".`);
  }
  return value;
}

function requireMaxAttempts(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIVE_UNITY_ATTEMPTS) {
    throw new TypeError(
      `maxAttempts must be an integer from 1 through ${MAX_LIVE_UNITY_ATTEMPTS}.`
    );
  }
  return value;
}

function requireBackoff(value, maxAttempts) {
  if (!Array.isArray(value)
    || value.length < maxAttempts - 1
    || value.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 60_000)) {
    throw new TypeError(
      'backoffMs must provide a 0 through 60000 ms integer for every possible retry.'
    );
  }
  return Object.freeze(value.slice(0, Math.max(0, maxAttempts - 1)));
}

function safeError(error) {
  let details = null;
  if (error?.details !== undefined) {
    try {
      details = JSON.parse(JSON.stringify(error.details));
    } catch {
      details = null;
    }
  }
  return Object.freeze({
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : null,
    message: typeof error?.message === 'string' ? error.message : String(error),
    details,
    stack: typeof error?.stack === 'string' ? error.stack : null
  });
}

function exactCheck(check, { id, kind }) {
  return isPlainObject(check) && check.id === id && check.kind === kind;
}

/**
 * Recognize only the settled Unity teardown-timeout shape emitted by the
 * V0.1 three-check profile. NUnit output is deliberately not consulted here:
 * it can justify another attempt, but can never turn a timed-out process into
 * a passing evaluation.
 */
export function isRetryableUnityTeardownTimeout(result) {
  if (!isPlainObject(result)
    || result.schemaVersion !== 1
    || result.passed !== false
    || !isPlainObject(result.evaluator)
    || typeof result.evaluator.id !== 'string'
    || typeof result.evaluator.version !== 'string'
    || !isPlainObject(result.manifest)
    || typeof result.manifest.id !== 'string'
    || result.manifest.schemaVersion !== 1
    || !Array.isArray(result.checks)
    || result.checks.length !== 3) {
    return false;
  }

  const [compile, editMode, report] = result.checks;
  const compilePassed = exactCheck(compile, { id: 'unity-compile', kind: 'compile' })
    && compile.status === 'passed'
    && compile.passed === true
    && compile.exitCode === 0
    && compile.signal === null
    && compile.timedOut === false
    && compile.aborted === false
    && compile.terminationConfirmed === true
    && compile.failure === null
    && Array.isArray(compile.expectedExitCodes)
    && compile.expectedExitCodes.includes(0);
  const editModeTimedOut = exactCheck(editMode, {
    id: 'unity-editmode-tests',
    kind: 'test'
  })
    && editMode.status === 'failed'
    && editMode.passed === false
    && editMode.timedOut === true
    && editMode.aborted === false
    && editMode.terminationConfirmed === true
    && isPlainObject(editMode.failure)
    && editMode.failure.code === 'COMMAND_TIMEOUT'
    && isPlainObject(editMode.failure.details)
    && Number.isSafeInteger(editMode.failure.details.timeoutMs)
    && editMode.failure.details.timeoutMs > 0
    && Array.isArray(editMode.expectedExitCodes)
    && editMode.expectedExitCodes.includes(0);
  const reportSkipped = exactCheck(report, {
    id: 'unity-editmode-results',
    kind: 'test-report'
  })
    && report.status === 'skipped'
    && report.passed === false
    && report.exitCode === null
    && report.signal === null
    && report.timedOut === false
    && report.aborted === false
    && report.terminationConfirmed === null
    && isPlainObject(report.failure)
    && report.failure.code === 'FAIL_FAST'
    && isPlainObject(report.failure.details)
    && report.failure.details.failedCheckId === 'unity-editmode-tests';

  return compilePassed && editModeTimedOut && reportSkipped;
}

async function waitForBackoff(delayMs, signal) {
  if (signal?.aborted) return false;
  if (delayMs === 0) {
    await Promise.resolve();
    return signal?.aborted !== true;
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      finish(false);
      return;
    }
    timer = setTimeout(() => finish(true), delayMs);
  });
}

export class LiveUnityRetryEvaluator {
  #backoffMs;
  #delegate;
  #maxAttempts;
  #writeAttempt;

  constructor(delegate, options = {}) {
    assertEvaluator(delegate);
    const normalized = requireOptions(options);
    const maxAttempts = requireMaxAttempts(
      normalized.maxAttempts ?? MAX_LIVE_UNITY_ATTEMPTS
    );
    if (typeof normalized.writeAttempt !== 'function') {
      throw new TypeError('writeAttempt must be a function.');
    }

    this.#delegate = delegate;
    this.#maxAttempts = maxAttempts;
    this.#backoffMs = requireBackoff(
      normalized.backoffMs ?? DEFAULT_LIVE_UNITY_BACKOFF_MS,
      maxAttempts
    );
    this.#writeAttempt = normalized.writeAttempt;
    Object.defineProperties(this, {
      schemaVersion: { value: delegate.schemaVersion, enumerable: true },
      id: { value: delegate.id, enumerable: true },
      version: { value: delegate.version, enumerable: true }
    });
    assertEvaluator(this);
  }

  normalizeProfile(profile) {
    return this.#delegate.normalizeProfile(profile);
  }

  async evaluate(request = {}) {
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const startedAt = new Date();
      let result;
      try {
        result = await this.#delegate.evaluate(request);
      } catch (error) {
        const finishedAt = new Date();
        await this.#writeAttempt(Object.freeze({
          schemaVersion: 1,
          attempt,
          maxAttempts: this.#maxAttempts,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          outcome: 'error',
          retryEligible: false,
          retryPermitted: false,
          nextBackoffMs: null,
          error: safeError(error),
          result: null
        }));
        throw error;
      }

      const finishedAt = new Date();
      const retryEligible = isRetryableUnityTeardownTimeout(result);
      const retryPermitted = retryEligible
        && attempt < this.#maxAttempts
        && request?.signal?.aborted !== true;
      const nextBackoffMs = retryPermitted ? this.#backoffMs[attempt - 1] : null;
      await this.#writeAttempt(Object.freeze({
        schemaVersion: 1,
        attempt,
        maxAttempts: this.#maxAttempts,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        outcome: 'result',
        retryEligible,
        retryPermitted,
        nextBackoffMs,
        error: null,
        result
      }));

      if (!retryPermitted) return result;
      if (!await waitForBackoff(nextBackoffMs, request?.signal)) return result;
    }

    throw new Error('Unreachable Live Unity retry state.');
  }
}
