import { createHash } from 'node:crypto';

export const FAILURE_MESSAGE_LIMIT_BYTES = 2048;

// Do not spread arbitrary details into event payloads or retry prompts. The full
// failure belongs in immutable artifact storage; summaries contain selected data.
export function boundedDiagnosticText(value, maximumBytes = FAILURE_MESSAGE_LIMIT_BYTES) {
  const source = typeof value === 'string' ? value : String(value ?? '');
  let result = '', bytes = 0;
  for (const character of source) {
    const safe = character === '\0' ? '\\0' : Buffer.from(character).toString('utf8');
    const size = Buffer.byteLength(safe);
    if (bytes + size > maximumBytes) break;
    result += safe;
    bytes += size;
  }
  return result;
}

function unwrapFailure(failure) {
  let current = failure;
  const seen = new Set();
  for (let depth = 0; depth < 16 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current.code !== 'EXECUTION_FAILED' || !current.details?.failure
      || typeof current.details.failure !== 'object') break;
    current = current.details.failure;
  }
  return current ?? {};
}

function stableMessage(message) {
  return boundedDiagnosticText(message)
    .replace(/\b\d{4}-\d\d-\d\dT[^\s]+/gu, '<time>')
    .replace(/\b(?:run|evaluation|changeset|command|goal)_[\w-]+/gu, '<id>')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/giu, '<id>')
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/gu, '<path>')
    .replace(/\b\d+\b/gu, '#')
    .replace(/\s+/gu, ' ').trim();
}

export function classifyFailure(failure) {
  if (failure === null || failure === undefined) {
    return { category: 'none', retryDisposition: 'inspect', fingerprint: null };
  }
  const current = unwrapFailure(failure);
  const code = boundedDiagnosticText(current.code || 'UNKNOWN_FAILURE', 160);
  const details = current.details ?? {};
  let category = 'execution', retryDisposition = 'retry', reason = code;
  if (details.process?.terminationConfirmed === false
    || /termination[-_]unconfirmed/iu.test(code)) {
    category = 'process-termination'; retryDisposition = 'inspect';
  } else if (code === 'FWA_INVALID_CODEX_EXECUTOR_INPUT') {
    category = 'executor-input'; retryDisposition = 'repair-input';
    // Reasons are authored by the adapter, never parsed from executor output.
    reason = ['prompt-type', 'prompt-empty', 'prompt-whitespace', 'prompt-nul', 'prompt-too-large']
      .includes(details.reason) ? details.reason : 'invalid-input';
  } else if (code === 'FWA_CODEX_OUTPUT_LIMIT_EXCEEDED') {
    category = 'executor-output-limit'; retryDisposition = 'repair-input';
  } else if (['FWA_INVALID_CODEX_EXECUTOR_OPTIONS', 'FWA_CODEX_SPAWN_FAILED'].includes(code)) {
    category = 'executor-environment'; retryDisposition = 'repair-environment';
  } else if (code === 'FWA_CODEX_IDLE_TIMEOUT') {
    category = 'executor-idle'; retryDisposition = 'inspect';
  } else if (['FWA_CODEX_TIMEOUT', 'execution-deadline-exceeded'].includes(code)) {
    category = 'execution-timeout'; retryDisposition = 'inspect';
  } else if (['FWA_CODEX_ABORTED', 'EXECUTION_ABORTED'].includes(code)) {
    category = 'execution-aborted'; retryDisposition = 'inspect';
  } else {
    reason = stableMessage(current.message) || code;
  }
  return {
    category, retryDisposition,
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify([code, category, reason])).digest('hex')}`
  };
}

export function summarizeFailure(failure, { artifactRef } = {}) {
  const source = failure ?? {};
  const details = source.details ?? {};
  const process = details.process ?? unwrapFailure(source).details?.process;
  const summary = {
    code: boundedDiagnosticText(source.code || 'UNKNOWN_FAILURE', 160),
    message: boundedDiagnosticText(source.message || source.code || 'Unknown failure'),
    details: { diagnostics: classifyFailure(source) }
  };
  const ref = artifactRef ?? details.artifactRef;
  if (ref && ref.schemaVersion === 1 && ref.algorithm === 'sha256' && /^[a-f0-9]{64}$/u.test(ref.digest ?? '')
    && Number.isSafeInteger(ref.size) && ref.size >= 0) {
    summary.details.artifactRef = { schemaVersion: 1, algorithm: 'sha256', digest: ref.digest, size: ref.size };
  }
  for (const field of ['reason', 'promptBytes', 'limitBytes', 'outputLimitBytes', 'timeoutMs', 'idleTimeoutMs',
    'fencePersisted', 'terminationConfirmed']) {
    const value = details[field];
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) summary.details[field] = value;
    else if (typeof value === 'string') summary.details[field] = boundedDiagnosticText(value, 160);
  }
  if (process && typeof process === 'object') {
    summary.details.process = {};
    for (const field of ['exitCode', 'signal', 'terminationConfirmed', 'timedOut', 'idleTimedOut', 'aborted']) {
      const value = process[field];
      if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
        summary.details.process[field] = value;
      } else if (typeof value === 'string') summary.details.process[field] = boundedDiagnosticText(value, 80);
    }
  }
  const effective = unwrapFailure(source);
  if (source.code === 'EXECUTION_FAILED' && effective !== source
    && effective.code !== 'EXECUTION_FAILED') {
    summary.details.failure = summarizeFailure(effective);
  }
  return summary;
}
