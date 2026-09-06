function issue(code, path, message, details = undefined) {
  const result = { code, path, message };
  if (details !== undefined) {
    result.details = details;
  }
  return Object.freeze(result);
}

function normalizeCapabilities(capabilities, path, errors) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    errors.push(issue(
      'INVALID_CAPABILITIES',
      path,
      'Expected a non-empty array of capability identifiers.'
    ));
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index];
    if (typeof capability !== 'string'
      || capability.length === 0
      || capability !== capability.trim()) {
      errors.push(issue(
        'INVALID_CAPABILITY',
        `${path}[${index}]`,
        'Expected a non-empty, trimmed capability identifier.'
      ));
    } else if (seen.has(capability)) {
      errors.push(issue(
        'DUPLICATE_CAPABILITY',
        `${path}[${index}]`,
        `Duplicate capability "${capability}".`
      ));
    } else {
      seen.add(capability);
      normalized.push(capability);
    }
  }
  return normalized;
}

export const EXECUTOR_SCHEMA_VERSION = 1;

export class ExecutorContractError extends Error {
  constructor(errors) {
    super(`Executor contract validation failed with ${errors.length} error(s).`);
    this.name = 'ExecutorContractError';
    this.code = 'FWA_INVALID_EXECUTOR';
    this.errors = Object.freeze([...errors]);
  }
}

export class ExecutorSelectionError extends Error {
  constructor(requiredCapabilities, candidates) {
    super(`No executor provides all required capabilities: ${requiredCapabilities.join(', ')}.`);
    this.name = 'ExecutorSelectionError';
    this.code = 'FWA_EXECUTOR_NOT_FOUND';
    this.requiredCapabilities = Object.freeze([...requiredCapabilities]);
    this.candidates = Object.freeze(candidates.map((candidate) => Object.freeze({
      id: candidate.id,
      capabilities: Object.freeze([...candidate.capabilities])
    })));
  }
}

export function validateExecutor(executor) {
  const errors = [];
  if (executor === null || typeof executor !== 'object' || Array.isArray(executor)) {
    errors.push(issue('INVALID_EXECUTOR', '$', 'Expected an executor object.'));
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }
  if (executor.schemaVersion !== EXECUTOR_SCHEMA_VERSION) {
    errors.push(issue(
      'UNSUPPORTED_EXECUTOR_SCHEMA',
      'schemaVersion',
      `Expected executor schema version ${EXECUTOR_SCHEMA_VERSION}.`
    ));
  }
  if (typeof executor.id !== 'string'
    || executor.id.length === 0
    || executor.id !== executor.id.trim()) {
    errors.push(issue('INVALID_EXECUTOR_ID', 'id', 'Expected a non-empty, trimmed id.'));
  }
  if (typeof executor.version !== 'string'
    || executor.version.length === 0
    || executor.version !== executor.version.trim()) {
    errors.push(issue(
      'INVALID_EXECUTOR_VERSION',
      'version',
      'Expected a non-empty, trimmed executor version.'
    ));
  }
  normalizeCapabilities(executor.capabilities, 'capabilities', errors);
  if (typeof executor.execute !== 'function') {
    errors.push(issue('MISSING_EXECUTE', 'execute', 'Expected an execute function.'));
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors)
  });
}

export function assertExecutor(executor) {
  const result = validateExecutor(executor);
  if (!result.ok) {
    throw new ExecutorContractError(result.errors);
  }
  return executor;
}

export function normalizeRequiredCapabilities(requiredCapabilities) {
  const errors = [];
  const result = normalizeCapabilities(
    requiredCapabilities,
    'requiredCapabilities',
    errors
  );
  if (errors.length > 0) {
    throw new ExecutorContractError(errors);
  }
  return Object.freeze(result);
}

export function executorProvidesCapabilities(executor, requiredCapabilities) {
  assertExecutor(executor);
  const required = normalizeRequiredCapabilities(requiredCapabilities);
  const available = new Set(executor.capabilities);
  return required.every((capability) => available.has(capability));
}

export function selectExecutor(executors, requiredCapabilities) {
  if (!Array.isArray(executors)) {
    throw new TypeError('executors must be an array.');
  }
  const required = normalizeRequiredCapabilities(requiredCapabilities);
  const candidates = executors.map((executor) => assertExecutor(executor));
  const selected = candidates.find((executor) => (
    executorProvidesCapabilities(executor, required)
  ));
  if (!selected) {
    throw new ExecutorSelectionError(required, candidates);
  }
  return selected;
}
