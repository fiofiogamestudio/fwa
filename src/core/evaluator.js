function issue(code, path, message) {
  return Object.freeze({ code, path, message });
}

export const EVALUATOR_SCHEMA_VERSION = 1;

export class EvaluatorContractError extends Error {
  constructor(errors) {
    super(`Evaluator contract validation failed with ${errors.length} error(s).`);
    this.name = 'EvaluatorContractError';
    this.code = 'FWA_INVALID_EVALUATOR';
    this.errors = Object.freeze([...errors]);
  }
}

export class EvidenceProfileMismatchError extends Error {
  constructor(errors) {
    super(`Evidence/profile validation failed with ${errors.length} error(s).`);
    this.name = 'EvidenceProfileMismatchError';
    this.code = 'FWA_EVIDENCE_PROFILE_MISMATCH';
    this.errors = Object.freeze([...errors]);
  }
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => (
      typeof value === 'string' && value === right[index]
    ));
}

function bindingIssue(code, path, message) {
  return Object.freeze({ code, path, message });
}

function compareStaticCriterion(check, criterion, index, errors) {
  const criterionPath = `evidence.criteria[${index}]`;
  if (!isPlainObject(check)) {
    errors.push(bindingIssue(
      'INVALID_PROFILE_CHECK',
      `profile.checks[${index}]`,
      'Expected a normalized profile check object.'
    ));
    return;
  }
  if (!isPlainObject(criterion)) {
    errors.push(bindingIssue(
      'INVALID_EVIDENCE_CRITERION',
      criterionPath,
      'Expected a projected Evidence criterion object.'
    ));
    return;
  }

  if (criterion.id !== check.id) {
    errors.push(bindingIssue(
      'CRITERION_ID_MISMATCH',
      `${criterionPath}.id`,
      `Expected criterion id ${JSON.stringify(check.id)} at index ${index}.`
    ));
  }
  if (criterion.kind !== check.kind) {
    errors.push(bindingIssue(
      'CRITERION_KIND_MISMATCH',
      `${criterionPath}.kind`,
      `Expected criterion kind ${JSON.stringify(check.kind)}.`
    ));
  }

  if (!isPlainObject(criterion.command)) {
    errors.push(bindingIssue(
      'INVALID_EVIDENCE_COMMAND',
      `${criterionPath}.command`,
      'Expected a projected Evidence command object.'
    ));
  } else {
    if (criterion.command.command !== check.command) {
      errors.push(bindingIssue(
        'CRITERION_COMMAND_MISMATCH',
        `${criterionPath}.command.command`,
        `Expected command ${JSON.stringify(check.command)}.`
      ));
    }
    if (!sameStringArray(criterion.command.args, check.args)) {
      errors.push(bindingIssue(
        'CRITERION_ARGUMENTS_MISMATCH',
        `${criterionPath}.command.args`,
        'Evidence arguments do not match the normalized profile in order.'
      ));
    }
    const expectedCwd = check.cwd ?? '.';
    if (criterion.command.cwd !== expectedCwd) {
      errors.push(bindingIssue(
        'CRITERION_CWD_MISMATCH',
        `${criterionPath}.command.cwd`,
        `Expected working directory ${JSON.stringify(expectedCwd)}.`
      ));
    }
  }

  if (!Array.isArray(check.expectedArtifacts)) {
    errors.push(bindingIssue(
      'INVALID_PROFILE_EXPECTED_ARTIFACTS',
      `profile.checks[${index}].expectedArtifacts`,
      'Expected a normalized expectedArtifacts array.'
    ));
    return;
  }
  if (!Array.isArray(criterion.expectedArtifacts)) {
    errors.push(bindingIssue(
      'INVALID_EVIDENCE_EXPECTED_ARTIFACTS',
      `${criterionPath}.expectedArtifacts`,
      'Expected a projected Evidence expectedArtifacts array.'
    ));
    return;
  }
  if (criterion.expectedArtifacts.length !== check.expectedArtifacts.length) {
    errors.push(bindingIssue(
      'EXPECTED_ARTIFACT_COUNT_MISMATCH',
      `${criterionPath}.expectedArtifacts`,
      `Expected ${check.expectedArtifacts.length} artifact result(s).`
    ));
  }
  const artifactCount = Math.min(
    check.expectedArtifacts.length,
    criterion.expectedArtifacts.length
  );
  for (let artifactIndex = 0; artifactIndex < artifactCount; artifactIndex += 1) {
    const expected = check.expectedArtifacts[artifactIndex];
    const observed = criterion.expectedArtifacts[artifactIndex];
    if (!isPlainObject(expected)) {
      errors.push(bindingIssue(
        'INVALID_PROFILE_EXPECTED_ARTIFACT',
        `profile.checks[${index}].expectedArtifacts[${artifactIndex}]`,
        'Expected a normalized expected artifact object.'
      ));
      continue;
    }
    if (!isPlainObject(observed)) {
      errors.push(bindingIssue(
        'INVALID_EVIDENCE_EXPECTED_ARTIFACT',
        `${criterionPath}.expectedArtifacts[${artifactIndex}]`,
        'Expected a projected Evidence artifact result object.'
      ));
      continue;
    }
    if (observed.path !== expected.path) {
      errors.push(bindingIssue(
        'EXPECTED_ARTIFACT_PATH_MISMATCH',
        `${criterionPath}.expectedArtifacts[${artifactIndex}].path`,
        `Expected artifact path ${JSON.stringify(expected.path)}.`
      ));
    }
  }
}

function validatePassingCriterion(check, criterion, index, errors) {
  if (!isPlainObject(check) || !isPlainObject(criterion) || criterion.result !== 'pass') {
    return;
  }
  const criterionPath = `evidence.criteria[${index}]`;
  if (!Array.isArray(check.expectedExitCodes)
    || !check.expectedExitCodes.includes(criterion.exitCode)) {
    errors.push(bindingIssue(
      'PASS_EXIT_CODE_NOT_ALLOWED',
      `${criterionPath}.exitCode`,
      'A passing criterion must use an exit code allowed by its normalized profile.'
    ));
  }
  if (criterion.signal !== null) {
    errors.push(bindingIssue(
      'PASS_SIGNAL_PRESENT',
      `${criterionPath}.signal`,
      'A passing criterion cannot report a signal.'
    ));
  }
  if (criterion.timedOut !== false) {
    errors.push(bindingIssue(
      'PASS_TIMED_OUT',
      `${criterionPath}.timedOut`,
      'A passing criterion must explicitly report that it did not time out.'
    ));
  }
  if (criterion.terminationConfirmed !== true) {
    errors.push(bindingIssue(
      'PASS_TERMINATION_UNCONFIRMED',
      `${criterionPath}.terminationConfirmed`,
      'A passing criterion must confirm process termination.'
    ));
  }
  if (criterion.failure !== null) {
    errors.push(bindingIssue(
      'PASS_FAILURE_PRESENT',
      `${criterionPath}.failure`,
      'A passing criterion cannot contain a failure.'
    ));
  }

  if (!Array.isArray(check.expectedArtifacts)
    || !Array.isArray(criterion.expectedArtifacts)) {
    return;
  }
  const artifactCount = Math.min(
    check.expectedArtifacts.length,
    criterion.expectedArtifacts.length
  );
  for (let artifactIndex = 0; artifactIndex < artifactCount; artifactIndex += 1) {
    const expected = check.expectedArtifacts[artifactIndex];
    const observed = criterion.expectedArtifacts[artifactIndex];
    if (!isPlainObject(expected) || !isPlainObject(observed)) continue;
    const artifactPath = `${criterionPath}.expectedArtifacts[${artifactIndex}]`;
    if (!isPlainObject(observed.artifact)) {
      errors.push(bindingIssue(
        'PASS_EXPECTED_ARTIFACT_MISSING',
        `${artifactPath}.artifact`,
        'A passing criterion must bind every expected artifact.'
      ));
    }
    if (observed.failure !== null) {
      errors.push(bindingIssue(
        'PASS_EXPECTED_ARTIFACT_FAILURE',
        `${artifactPath}.failure`,
        'A passing criterion cannot contain an expected artifact failure.'
      ));
    }
    if (expected.size !== null && observed.size !== expected.size) {
      errors.push(bindingIssue(
        'PASS_EXPECTED_ARTIFACT_SIZE_MISMATCH',
        `${artifactPath}.size`,
        `Expected artifact size ${String(expected.size)}.`
      ));
    }
    if (expected.sha256 !== null && observed.digest !== expected.sha256) {
      errors.push(bindingIssue(
        'PASS_EXPECTED_ARTIFACT_DIGEST_MISMATCH',
        `${artifactPath}.digest`,
        `Expected artifact digest ${JSON.stringify(expected.sha256)}.`
      ));
    }
  }
}

/**
 * Compare an evaluator-normalized profile with projected immutable Evidence.
 *
 * This is deliberately a pure core operation: evaluator adapters own profile
 * normalization and execution, while durable verification can reuse the
 * normalized JSON value without loading or invoking an adapter.
 */
export function validateEvidenceAgainstProfile(profile, evidence) {
  const errors = [];
  if (!isPlainObject(profile)) {
    errors.push(bindingIssue(
      'INVALID_NORMALIZED_PROFILE',
      'profile',
      'Expected a normalized profile object.'
    ));
  }
  if (!isPlainObject(evidence)) {
    errors.push(bindingIssue(
      'INVALID_PROJECTED_EVIDENCE',
      'evidence',
      'Expected a projected Evidence object.'
    ));
  }
  if (errors.length > 0) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }
  if (!Array.isArray(profile.checks)) {
    errors.push(bindingIssue(
      'INVALID_PROFILE_CHECKS',
      'profile.checks',
      'Expected a normalized checks array.'
    ));
  }
  if (!Array.isArray(evidence.criteria)) {
    errors.push(bindingIssue(
      'INVALID_EVIDENCE_CRITERIA',
      'evidence.criteria',
      'Expected a projected criteria array.'
    ));
  }
  if (!Array.isArray(profile.checks) || !Array.isArray(evidence.criteria)) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }
  if (evidence.criteria.length !== profile.checks.length) {
    errors.push(bindingIssue(
      'CRITERIA_COUNT_MISMATCH',
      'evidence.criteria',
      `Expected ${profile.checks.length} criterion result(s).`
    ));
  }

  const criterionCount = Math.min(profile.checks.length, evidence.criteria.length);
  for (let index = 0; index < criterionCount; index += 1) {
    const check = profile.checks[index];
    const criterion = evidence.criteria[index];
    compareStaticCriterion(check, criterion, index, errors);
    if (isPlainObject(criterion) && !['pass', 'fail'].includes(criterion.result)) {
      errors.push(bindingIssue(
        'INVALID_CRITERION_RESULT',
        `evidence.criteria[${index}].result`,
        'Expected criterion result to be pass or fail.'
      ));
    }
    validatePassingCriterion(check, criterion, index, errors);
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors)
  });
}

export function assertEvidenceMatchesProfile(profile, evidence) {
  const result = validateEvidenceAgainstProfile(profile, evidence);
  if (!result.ok) throw new EvidenceProfileMismatchError(result.errors);
  return evidence;
}

export function validateEvaluator(evaluator) {
  const errors = [];
  if (evaluator === null || typeof evaluator !== 'object' || Array.isArray(evaluator)) {
    errors.push(issue('INVALID_EVALUATOR', '$', 'Expected an evaluator object.'));
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }
  if (evaluator.schemaVersion !== EVALUATOR_SCHEMA_VERSION) {
    errors.push(issue(
      'UNSUPPORTED_EVALUATOR_SCHEMA',
      'schemaVersion',
      `Expected evaluator schema version ${EVALUATOR_SCHEMA_VERSION}.`
    ));
  }
  if (typeof evaluator.id !== 'string'
    || evaluator.id.length === 0
    || evaluator.id !== evaluator.id.trim()) {
    errors.push(issue('INVALID_EVALUATOR_ID', 'id', 'Expected a non-empty, trimmed id.'));
  }
  if (typeof evaluator.version !== 'string'
    || evaluator.version.length === 0
    || evaluator.version !== evaluator.version.trim()) {
    errors.push(issue(
      'INVALID_EVALUATOR_VERSION',
      'version',
      'Expected a non-empty, trimmed evaluator version.'
    ));
  }
  if (typeof evaluator.evaluate !== 'function') {
    errors.push(issue('MISSING_EVALUATE', 'evaluate', 'Expected an evaluate function.'));
  }
  if (typeof evaluator.normalizeProfile !== 'function') {
    errors.push(issue(
      'MISSING_NORMALIZE_PROFILE',
      'normalizeProfile',
      'Expected a normalizeProfile function.'
    ));
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors)
  });
}

export function assertEvaluator(evaluator) {
  const result = validateEvaluator(evaluator);
  if (!result.ok) throw new EvaluatorContractError(result.errors);
  return evaluator;
}
