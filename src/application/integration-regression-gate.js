import { timingSafeEqual } from 'node:crypto';

import { assertEvaluator } from '../core/evaluator.js';
import { stableStringify } from '../core/events.js';

const ARTIFACT_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const FULL_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const INTEGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

export class IntegrationRegressionGateError extends Error {
  constructor(message, code = 'integration-regression-gate-failed', options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'IntegrationRegressionGateError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
    if (options.cleanup !== undefined) this.cleanup = options.cleanup;
  }
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function cloneJson(value, name, code = 'invalid-integration-regression-input') {
  try {
    return JSON.parse(stableStringify(value));
  } catch (error) {
    throw new IntegrationRegressionGateError(
      `${name} must be a canonical JSON value: ${error.message}`,
      code,
      { cause: error, details: { name } }
    );
  }
}

function optionalJson(value) {
  try {
    return cloneJson(value, 'value');
  } catch {
    return null;
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function immutableJson(value, name) {
  return deepFreeze(cloneJson(value, name));
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /(?:authorization|cookie|credential|password|secret|token)/iu.test(key)
      ? '[REDACTED]'
      : redactSecrets(child)
  ]));
}

function failureFrom(error, fallbackCode) {
  const details = error?.details !== undefined
    ? optionalJson(redactSecrets(error.details))
    : error?.errors !== undefined
      ? { errors: optionalJson(redactSecrets(error.errors)) }
      : null;
  return {
    code: typeof error?.code === 'string' ? error.code : fallbackCode,
    message: typeof error?.message === 'string' ? error.message : String(error),
    details
  };
}

function assertPort(port, name, methods) {
  if (port === null || typeof port !== 'object' || Array.isArray(port)) {
    throw new IntegrationRegressionGateError(
      `${name} must be an adapter object.`,
      'invalid-integration-regression-port',
      { details: { port: name } }
    );
  }
  const missing = methods.filter((method) => typeof port[method] !== 'function');
  if (missing.length > 0) {
    throw new IntegrationRegressionGateError(
      `${name} is missing method(s): ${missing.join(', ')}.`,
      'invalid-integration-regression-port',
      { details: { port: name, missing } }
    );
  }
}

function requireIntegrationId(value) {
  if (typeof value !== 'string'
    || !INTEGRATION_ID_PATTERN.test(value)
    || WINDOWS_DEVICE_NAME_PATTERN.test(value)) {
    throw new IntegrationRegressionGateError(
      'integrationId must be a portable 1-64 character identifier using ASCII letters, digits, underscores, or hyphens.',
      'invalid-integration-id'
    );
  }
  return value;
}

function requireCandidateRevision(value) {
  if (typeof value !== 'string' || !FULL_OBJECT_ID_PATTERN.test(value)) {
    throw new IntegrationRegressionGateError(
      'candidateRevision must be a full lowercase Git object id.',
      'invalid-candidate-revision'
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
    throw new IntegrationRegressionGateError(
      'signal must be an AbortSignal when supplied.',
      'invalid-abort-signal'
    );
  }
}

function assertNormalizedProfile(profile) {
  if (!isPlainObject(profile)
    || typeof profile.id !== 'string'
    || profile.id.length === 0
    || profile.id !== profile.id.trim()
    || !Number.isSafeInteger(profile.schemaVersion)
    || profile.schemaVersion < 1
    || !Array.isArray(profile.checks)
    || profile.checks.length === 0) {
    throw new IntegrationRegressionGateError(
      'Evaluator returned an invalid normalized profile.',
      'invalid-normalized-profile'
    );
  }

  for (const [index, check] of profile.checks.entries()) {
    const valid = isPlainObject(check)
      && typeof check.id === 'string'
      && check.id.length > 0
      && typeof check.kind === 'string'
      && check.kind.length > 0
      && typeof check.command === 'string'
      && check.command.length > 0
      && Array.isArray(check.args)
      && check.args.every((argument) => typeof argument === 'string')
      && Number.isSafeInteger(check.timeoutMs)
      && check.timeoutMs > 0
      && Array.isArray(check.expectedExitCodes)
      && check.expectedExitCodes.every((code) => Number.isSafeInteger(code) && code >= 0)
      && (check.cwd === null || typeof check.cwd === 'string')
      && Array.isArray(check.expectedArtifacts);
    if (!valid) {
      throw new IntegrationRegressionGateError(
        `Normalized profile check at index ${index} is invalid.`,
        'invalid-normalized-profile',
        { details: { checkIndex: index } }
      );
    }
    for (const [artifactIndex, artifact] of check.expectedArtifacts.entries()) {
      if (!isPlainObject(artifact)
        || typeof artifact.path !== 'string'
        || artifact.path.length === 0
        || !(artifact.size === null
          || (Number.isSafeInteger(artifact.size) && artifact.size >= 0))
        || !(artifact.sha256 === null
          || (typeof artifact.sha256 === 'string'
            && ARTIFACT_DIGEST_PATTERN.test(artifact.sha256)))) {
        throw new IntegrationRegressionGateError(
          `Normalized expected artifact at check ${index}, index ${artifactIndex} is invalid.`,
          'invalid-normalized-profile',
          { details: { checkIndex: index, artifactIndex } }
        );
      }
    }
  }
  return profile;
}

function normalizeArtifactRef(value, name) {
  if (!isPlainObject(value)
    || !sameJson(
      Object.keys(value).sort(),
      ['algorithm', 'digest', 'schemaVersion', 'size']
    )
    || value.schemaVersion !== 1
    || value.algorithm !== 'sha256'
    || typeof value.digest !== 'string'
    || !ARTIFACT_DIGEST_PATTERN.test(value.digest)
    || !Number.isSafeInteger(value.size)
    || value.size < 0) {
    throw new IntegrationRegressionGateError(
      `${name} is not a valid SHA-256 ArtifactRef.`,
      'invalid-artifact-ref',
      { details: { name } }
    );
  }
  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    digest: value.digest,
    size: value.size
  };
}

async function putVerified(artifacts, bytes, name) {
  const ref = normalizeArtifactRef(await artifacts.put(bytes), name);
  await artifacts.verify(ref);
  return ref;
}

function sameJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function sameDigest(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

function normalizeFailureRecord(value, name) {
  if (value === null) return null;
  if (!isPlainObject(value)
    || typeof value.code !== 'string'
    || value.code.length === 0
    || typeof value.message !== 'string'
    || value.message.length === 0) {
    throw new IntegrationRegressionGateError(
      `${name} is not a valid failure record.`,
      'invalid-evaluator-result'
    );
  }
  return {
    code: value.code,
    message: value.message,
    details: Object.hasOwn(value, 'details')
      ? cloneJson(value.details, `${name}.details`, 'invalid-evaluator-result')
      : null
  };
}

function validateEnvironmentFingerprint(value) {
  if (!isPlainObject(value)
    || typeof value.platform !== 'string'
    || value.platform.length === 0
    || typeof value.arch !== 'string'
    || value.arch.length === 0
    || !isPlainObject(value.runtime)
    || typeof value.runtime.name !== 'string'
    || value.runtime.name.length === 0
    || typeof value.runtime.version !== 'string'
    || value.runtime.version.length === 0
    || typeof value.environmentSha256 !== 'string'
    || !ARTIFACT_DIGEST_PATTERN.test(value.environmentSha256)) {
    throw new IntegrationRegressionGateError(
      'Evaluator returned an invalid environment fingerprint.',
      'invalid-evaluator-result'
    );
  }
  return {
    platform: value.platform,
    arch: value.arch,
    runtime: cloneJson(value.runtime, 'environment runtime', 'invalid-evaluator-result'),
    environmentSha256: `sha256:${value.environmentSha256}`
  };
}

function decodeArtifactBytes(value, context) {
  if (typeof value !== 'string') {
    throw new IntegrationRegressionGateError(
      `${context} bytesBase64 must be a string.`,
      'invalid-evaluator-result'
    );
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new IntegrationRegressionGateError(
      `${context} bytesBase64 is not canonical base64.`,
      'invalid-evaluator-result'
    );
  }
  return bytes;
}

function validateWorkspace(value, expected, phase) {
  if (!isPlainObject(value)
    || value.evaluationId !== expected.evaluationId
    || typeof value.workspacePath !== 'string'
    || value.workspacePath.length === 0
    || value.workspacePath !== value.workspacePath.trim()
    || value.headRevision !== expected.candidateRevision
    || value.detached !== true
    || (expected.workspacePath !== undefined
      && value.workspacePath !== expected.workspacePath)) {
    throw new IntegrationRegressionGateError(
      `Workspace adapter did not prove an exact detached candidate during ${phase}.`,
      'invalid-evaluation-workspace-result',
      {
        details: {
          phase,
          expectedEvaluationId: expected.evaluationId,
          expectedRevision: expected.candidateRevision
        }
      }
    );
  }
  return value;
}

function validateWorkspaceInspection(value, expected) {
  const inspection = validateWorkspace(value, expected, 'inspection');
  if (!Array.isArray(inspection.changes) || !Array.isArray(inspection.trackedChanges)) {
    throw new IntegrationRegressionGateError(
      'Workspace inspection must report changes and trackedChanges arrays.',
      'invalid-evaluation-workspace-result'
    );
  }
  for (const [index, change] of inspection.trackedChanges.entries()) {
    if (!isPlainObject(change)
      || typeof change.code !== 'string'
      || change.code.length === 0
      || typeof change.path !== 'string'
      || change.path.length === 0) {
      throw new IntegrationRegressionGateError(
        `Tracked workspace change at index ${index} is invalid.`,
        'invalid-evaluation-workspace-result',
        { details: { changeIndex: index } }
      );
    }
  }
  return inspection;
}

function assertEvaluatorResultSettled(rawResult, evaluator, profile) {
  let result;
  try {
    result = cloneJson(rawResult, 'evaluator result', 'invalid-evaluator-result');
  } catch (error) {
    throw error;
  }
  const identityMatches = isPlainObject(result)
    && result.schemaVersion === 1
    && isPlainObject(result.evaluator)
    && result.evaluator.id === evaluator.id
    && result.evaluator.version === evaluator.version
    && isPlainObject(result.manifest)
    && result.manifest.id === profile.id
    && result.manifest.schemaVersion === profile.schemaVersion
    && Array.isArray(result.checks)
    && result.checks.length === profile.checks.length;
  if (!identityMatches) {
    throw new IntegrationRegressionGateError(
      'Evaluator result does not match its evaluator, profile, or complete check set.',
      'invalid-evaluator-result'
    );
  }

  for (const check of result.checks) {
    const settled = isPlainObject(check)
      && (check.status === 'skipped'
        ? check.terminationConfirmed === null
        : ['passed', 'failed'].includes(check.status)
          && check.terminationConfirmed === true);
    if (!settled) {
      throw new IntegrationRegressionGateError(
        'Evaluator did not prove that every started process terminated.',
        'FWA_PROCESS_TERMINATION_UNCONFIRMED'
      );
    }
  }
  return result;
}

async function materializeResult({
  artifacts,
  evaluatorIdentity,
  integrationId,
  candidateRevision,
  profile,
  profileArtifact,
  rawResult,
  workspaceInspection
}) {
  const result = cloneJson(rawResult, 'evaluator result', 'invalid-evaluator-result');
  const environmentFingerprint = validateEnvironmentFingerprint(result.environmentFingerprint);
  const criteria = [];
  let derivedPass = true;

  for (let index = 0; index < profile.checks.length; index += 1) {
    const expected = profile.checks[index];
    const actual = result.checks[index];
    if (!isPlainObject(actual)
      || actual.id !== expected.id
      || actual.kind !== expected.kind
      || actual.command !== expected.command
      || !sameJson(actual.args, expected.args)
      || actual.timeoutMs !== expected.timeoutMs
      || !sameJson(actual.expectedExitCodes, expected.expectedExitCodes)
      || !Array.isArray(actual.expectedArtifacts)
      || actual.expectedArtifacts.length !== expected.expectedArtifacts.length
      || !Number.isSafeInteger(actual.durationMs)
      || actual.durationMs < 0
      || typeof actual.stdout !== 'string'
      || typeof actual.stderr !== 'string') {
      throw new IntegrationRegressionGateError(
        `Evaluator returned a malformed or mismatched result for criterion ${expected.id}.`,
        'invalid-evaluator-result',
        { details: { criterionId: expected.id } }
      );
    }

    const stdoutArtifact = await putVerified(
      artifacts,
      Buffer.from(actual.stdout, 'utf8'),
      `criterion ${expected.id} stdout artifact`
    );
    const stderrArtifact = await putVerified(
      artifacts,
      Buffer.from(actual.stderr, 'utf8'),
      `criterion ${expected.id} stderr artifact`
    );
    const expectedArtifacts = [];

    for (let artifactIndex = 0;
      artifactIndex < expected.expectedArtifacts.length;
      artifactIndex += 1) {
      const expectedSpec = expected.expectedArtifacts[artifactIndex];
      const observed = actual.expectedArtifacts[artifactIndex];
      if (!isPlainObject(observed) || observed.path !== expectedSpec.path) {
        throw new IntegrationRegressionGateError(
          `Evaluator returned a mismatched artifact for criterion ${expected.id}.`,
          'invalid-evaluator-result'
        );
      }

      let artifact = null;
      let digest = null;
      let size = null;
      if (observed.bytesBase64 !== null) {
        const bytes = decodeArtifactBytes(
          observed.bytesBase64,
          `criterion ${expected.id} artifact ${expectedSpec.path}`
        );
        if (!Number.isSafeInteger(observed.size)
          || observed.size !== bytes.byteLength
          || typeof observed.digest !== 'string'
          || !ARTIFACT_DIGEST_PATTERN.test(observed.digest)) {
          throw new IntegrationRegressionGateError(
            `Evaluator artifact metadata is invalid for ${expectedSpec.path}.`,
            'invalid-evaluator-result'
          );
        }
        artifact = await putVerified(
          artifacts,
          bytes,
          `criterion ${expected.id} expected artifact ${expectedSpec.path}`
        );
        if (!sameDigest(artifact.digest, observed.digest)) {
          throw new IntegrationRegressionGateError(
            `Evaluator artifact digest is false for ${expectedSpec.path}.`,
            'invalid-evaluator-result'
          );
        }
        digest = observed.digest;
        size = observed.size;
      } else if (observed.digest !== null || observed.size !== null) {
        throw new IntegrationRegressionGateError(
          `Evaluator returned a partial artifact binding for ${expectedSpec.path}.`,
          'invalid-evaluator-result'
        );
      }

      let artifactFailure = normalizeFailureRecord(
        observed.failure,
        'expected artifact failure'
      );
      if (artifactFailure === null && expectedSpec.size !== null && size !== expectedSpec.size) {
        artifactFailure = {
          code: 'EXPECTED_ARTIFACT_SIZE_MISMATCH',
          message: `Expected artifact size differs for ${expectedSpec.path}.`,
          details: { expected: expectedSpec.size, actual: size }
        };
      }
      if (artifactFailure === null
        && expectedSpec.sha256 !== null
        && digest !== expectedSpec.sha256) {
        artifactFailure = {
          code: 'EXPECTED_ARTIFACT_DIGEST_MISMATCH',
          message: `Expected artifact digest differs for ${expectedSpec.path}.`,
          details: { expected: expectedSpec.sha256, actual: digest }
        };
      }
      if (artifact === null && artifactFailure === null) {
        artifactFailure = {
          code: 'EXPECTED_ARTIFACT_UNOBSERVED',
          message: `Evaluator did not provide bytes or a failure for ${expectedSpec.path}.`,
          details: null
        };
      }
      const independentlyPassed = artifact !== null && artifactFailure === null;
      if (observed.passed !== independentlyPassed && artifactFailure === null) {
        artifactFailure = {
          code: 'EVALUATOR_ARTIFACT_VERDICT_MISMATCH',
          message: `Evaluator artifact verdict differs from the observed bytes for ${expectedSpec.path}.`,
          details: {
            reported: typeof observed.passed === 'boolean' ? observed.passed : null,
            derived: independentlyPassed
          }
        };
      }
      const artifactPassed = independentlyPassed
        && observed.passed === true
        && artifactFailure === null;
      if (!artifactPassed) derivedPass = false;
      expectedArtifacts.push({
        path: expectedSpec.path,
        size,
        digest,
        artifact,
        failure: artifactFailure
      });
    }

    const statusPass = actual.passed === true
      && actual.status === 'passed'
      && actual.failure === null
      && actual.timedOut === false
      && actual.aborted === false
      && actual.stdoutTruncated === false
      && actual.stderrTruncated === false
      && actual.terminationConfirmed === true
      && Number.isSafeInteger(actual.exitCode)
      && expected.expectedExitCodes.includes(actual.exitCode)
      && actual.signal === null
      && expectedArtifacts.every((artifact) => artifact.failure === null);
    if (!statusPass) derivedPass = false;
    criteria.push({
      id: expected.id,
      kind: expected.kind,
      result: statusPass ? 'pass' : 'fail',
      command: {
        command: expected.command,
        args: [...expected.args],
        cwd: expected.cwd ?? '.'
      },
      exitCode: Number.isSafeInteger(actual.exitCode) ? actual.exitCode : null,
      signal: typeof actual.signal === 'string' ? actual.signal : null,
      timedOut: actual.timedOut === true,
      aborted: actual.aborted === true,
      terminationConfirmed: actual.terminationConfirmed === true,
      durationMs: actual.durationMs,
      stdoutArtifact,
      stderrArtifact,
      expectedArtifacts,
      failure: normalizeFailureRecord(actual.failure, 'criterion failure')
    });
  }

  const policyViolations = workspaceInspection.trackedChanges.map((change) => ({
    code: 'EVALUATION_MUTATED_TRACKED_FILE',
    message: `Evaluation changed tracked path ${change.path}.`,
    details: cloneJson(change, 'workspace change', 'invalid-evaluation-workspace-result')
  }));
  if (typeof result.passed !== 'boolean' || result.passed !== derivedPass) {
    policyViolations.push({
      code: 'EVALUATOR_VERDICT_MISMATCH',
      message: 'Evaluator summary verdict differs from the independently derived check verdict.',
      details: {
        reported: typeof result.passed === 'boolean' ? result.passed : null,
        derived: derivedPass
      }
    });
  }

  const regressionResult = derivedPass && policyViolations.length === 0 ? 'pass' : 'fail';
  const profileBinding = {
    id: profile.id,
    schemaVersion: profile.schemaVersion,
    sha256: `sha256:${profileArtifact.digest}`
  };
  const resultEnvelope = {
    schemaVersion: 1,
    kind: 'integration-regression-result',
    integrationId,
    candidateRevision,
    evaluator: evaluatorIdentity,
    profile: profileBinding,
    environmentFingerprint,
    result: regressionResult,
    criteria,
    policyViolations
  };
  const resultArtifact = await putVerified(
    artifacts,
    Buffer.from(stableStringify(resultEnvelope), 'utf8'),
    'canonical evaluator result artifact'
  );

  return {
    regressionResult,
    evaluator: evaluatorIdentity,
    profile: profileBinding,
    resultArtifact,
    environmentFingerprint,
    criteria,
    policyViolations
  };
}

function cleanupNotRequired() {
  return {
    attempted: false,
    status: 'not-required',
    removed: false,
    alreadyAbsent: false,
    failure: null
  };
}

function cleanupRetained(reason) {
  return {
    attempted: false,
    status: 'retained',
    removed: false,
    alreadyAbsent: false,
    failure: {
      code: 'EVALUATION_WORKTREE_RETAINED',
      message: reason,
      details: null
    }
  };
}

async function cleanupWorkspace(workspace, context) {
  try {
    const request = {
      evaluationId: context.evaluationId,
      force: true
    };
    if (context.workspacePath !== undefined) {
      request.workspacePath = context.workspacePath;
    }
    const removal = await workspace.removeEvaluation(request);
    if (removal?.removed === true || removal?.alreadyAbsent === true) {
      return {
        attempted: true,
        status: 'succeeded',
        removed: removal.removed === true,
        alreadyAbsent: removal.alreadyAbsent === true,
        failure: null
      };
    }
    return {
      attempted: true,
      status: 'failed',
      removed: false,
      alreadyAbsent: false,
      failure: {
        code: 'INVALID_EVALUATION_WORKTREE_REMOVAL_RESULT',
        message: 'Workspace adapter did not prove removal or prior absence.',
        details: optionalJson(removal)
      }
    };
  } catch (error) {
    return {
      attempted: true,
      status: 'failed',
      removed: false,
      alreadyAbsent: false,
      failure: failureFrom(error, 'EVALUATION_WORKTREE_CLEANUP_FAILED')
    };
  }
}

function gateFailure(error, phase, cleanup) {
  const immutableCleanup = immutableJson(cleanup, 'cleanup result');
  if (error instanceof IntegrationRegressionGateError) {
    if (error.cleanup === undefined) error.cleanup = immutableCleanup;
    if (error.details === undefined) error.details = { phase };
    return error;
  }
  return new IntegrationRegressionGateError(
    `Integration regression gate failed during ${phase}: ${error?.message ?? String(error)}`,
    'integration-regression-gate-failed',
    {
      cause: error,
      cleanup: immutableCleanup,
      details: {
        phase,
        failure: failureFrom(error, 'INTEGRATION_REGRESSION_INFRASTRUCTURE_FAILED')
      }
    }
  );
}

/**
 * Evaluate one prepared integration candidate without reading or writing event
 * state and without moving a target ref. The supplied Evaluator owns timeout
 * and AbortSignal handling; the supplied workspace owns detached-worktree
 * safety. A terminal evaluator pass or fail always returns immutable Evidence.
 * This component executes the caller's complete normalized profile; an outer
 * policy decides whether that profile contains the required compile/test set.
 * Evaluator commands are trusted adapters: an outer integration coordinator
 * must separately prove target-ref stability if commands may invoke Git.
 */
export async function runIntegrationRegressionGate(options = {}) {
  if (!isPlainObject(options)) {
    throw new IntegrationRegressionGateError(
      'Integration regression gate options must be a plain object.',
      'invalid-integration-regression-input'
    );
  }
  const {
    integrationId: requestedIntegrationId,
    candidateRevision: requestedCandidateRevision,
    profile,
    evaluator,
    workspace,
    artifacts,
    signal
  } = options;
  const integrationId = requireIntegrationId(requestedIntegrationId);
  const candidateRevision = requireCandidateRevision(requestedCandidateRevision);
  assertEvaluator(evaluator);
  assertPort(workspace, 'workspace', [
    'createEvaluation',
    'inspectEvaluation',
    'removeEvaluation'
  ]);
  assertPort(artifacts, 'artifacts', ['init', 'put', 'verify']);
  assertSignal(signal);
  const evaluatorIdentity = immutableJson({
    id: evaluator.id,
    version: evaluator.version
  }, 'evaluator identity');

  let phase = 'normalize-profile';
  let cleanupContext = null;
  let cleanupAllowed = false;
  let executionStarted = false;
  let resultParts = null;
  let profileArtifact = null;
  let workspaceResult = null;
  let primaryError = null;

  try {
    const normalizedProfile = immutableJson(assertNormalizedProfile(cloneJson(
      evaluator.normalizeProfile(profile),
      'normalized evaluation profile',
      'invalid-normalized-profile'
    )), 'normalized evaluation profile');

    phase = 'artifact-store-init';
    await artifacts.init();
    phase = 'profile-artifact';
    profileArtifact = await putVerified(
      artifacts,
      Buffer.from(stableStringify(normalizedProfile), 'utf8'),
      'canonical profile artifact'
    );

    phase = 'workspace-create';
    // GitWorktreeAdapter can fail after `git worktree add`. Establish the
    // deterministic owner before calling it so a partial setup is never
    // mislabeled as cleanup-not-required.
    cleanupContext = { evaluationId: integrationId, workspacePath: undefined };
    cleanupAllowed = true;
    const created = await workspace.createEvaluation({
      evaluationId: integrationId,
      revision: candidateRevision
    });
    workspaceResult = validateWorkspace(created, {
      evaluationId: integrationId,
      candidateRevision
    }, 'creation');
    cleanupContext = {
      evaluationId: integrationId,
      workspacePath: workspaceResult.workspacePath
    };

    phase = 'evaluation';
    executionStarted = true;
    cleanupAllowed = false;
    const rawResult = await evaluator.evaluate({
      workspaceRoot: workspaceResult.workspacePath,
      manifest: normalizedProfile,
      signal
    });
    const settledResult = assertEvaluatorResultSettled(
      rawResult,
      evaluatorIdentity,
      normalizedProfile
    );
    cleanupAllowed = true;

    phase = 'workspace-inspection';
    const workspaceInspection = validateWorkspaceInspection(
      await workspace.inspectEvaluation({
        evaluationId: integrationId,
        workspacePath: workspaceResult.workspacePath,
        revision: candidateRevision
      }),
      {
        evaluationId: integrationId,
        candidateRevision,
        workspacePath: workspaceResult.workspacePath
      }
    );

    phase = 'result-materialization';
    resultParts = await materializeResult({
      artifacts,
      evaluatorIdentity,
      integrationId,
      candidateRevision,
      profile: normalizedProfile,
      profileArtifact,
      rawResult: settledResult,
      workspaceInspection
    });
  } catch (error) {
    primaryError = error;
  }

  let cleanup;
  if (cleanupContext === null) {
    cleanup = cleanupNotRequired();
  } else if (!cleanupAllowed) {
    cleanup = cleanupRetained(executionStarted
      ? 'Evaluation worktree retained because the evaluator did not return a fully settled result.'
      : 'Evaluation worktree retained because its exact detached identity was not proven.');
  } else {
    cleanup = await cleanupWorkspace(workspace, cleanupContext);
  }

  if (primaryError !== null) throw gateFailure(primaryError, phase, cleanup);

  const finalResult = resultParts.regressionResult === 'pass'
    && cleanup.status === 'succeeded'
    ? 'pass'
    : 'fail';
  return immutableJson({
    schemaVersion: 1,
    kind: 'integration-regression-gate',
    integrationId,
    candidateRevision,
    result: finalResult,
    regressionResult: resultParts.regressionResult,
    evaluator: resultParts.evaluator,
    profile: resultParts.profile,
    profileArtifact,
    resultArtifact: resultParts.resultArtifact,
    environmentFingerprint: resultParts.environmentFingerprint,
    workspace: {
      evaluationId: integrationId,
      headRevision: candidateRevision,
      detached: true
    },
    criteria: resultParts.criteria,
    policyViolations: resultParts.policyViolations,
    cleanup
  }, 'integration regression gate Evidence');
}
