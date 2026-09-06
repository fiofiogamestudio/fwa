import { assertValidPlan, PLAN_SCHEMA_VERSION } from '../core/dag.js';
import { matchesEffectPattern, normalizeWorkspacePath } from '../core/effects.js';
import { assertValidEventEnvelope } from '../core/events.js';
import {
  areNodeDependenciesSatisfied,
  hasActiveProjectOperation,
  isNodeSchedulable,
  isUnfencedGitProcessFailure,
  nodeHasUnsettledWorkspace,
  nodeRetryEligibility
} from '../core/scheduling.js';
import {
  computeDependencyInvalidation,
  computeInvalidation
} from '../core/invalidation.js';
import {
  changedRefsForFiles,
  isRefId,
  normalizeRef,
  refVersionDigest
} from '../core/refs.js';
import {
  GoalStatus,
  EvaluationStatus,
  IntegrationStatus,
  NodeStatus,
  ReversionStatus,
  RunStatus,
  Validity,
  transitionEvaluation,
  transitionGoal,
  transitionIntegration,
  transitionNode,
  transitionReversion,
  transitionValidity,
  transitionRun
} from '../core/state-machines.js';

export class ProjectionError extends Error {
  constructor(message, code = 'projection-error', event = undefined) {
    super(message);
    this.name = 'ProjectionError';
    this.code = code;
    this.eventId = event?.eventId;
    this.sequence = event?.sequence;
  }
}

function requireString(value, name, event) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return value;
}

function requireArray(value, name, event) {
  if (!Array.isArray(value)) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return value;
}

function requireExactFields(value, expected, name, event) {
  const object = requireObject(value, name, event);
  const actual = Object.keys(object).sort();
  const fields = [...expected].sort();
  if (actual.length !== fields.length
    || actual.some((field, index) => field !== fields[index])) {
    throw new ProjectionError(
      `${event.type} has invalid ${name} fields.`,
      'invalid-event-payload',
      event
    );
  }
  return object;
}

function requireStringArray(value, name, event) {
  return requireArray(value, name, event).map((item, index) => (
    requireString(item, `${name}[${index}]`, event)
  ));
}

function requireUniqueStringArray(value, name, event) {
  const items = requireArray(value, name, event);
  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const item = requireString(items[index], `${name}[${index}]`, event);
    if (seen.has(item)) {
      throw new ProjectionError(
        `${event.type} has a duplicate ${name} entry: ${item}.`,
        'invalid-event-payload',
        event
      );
    }
    seen.add(item);
  }
  return [...items];
}

function requireBoolean(value, name, event) {
  if (typeof value !== 'boolean') {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return value;
}

function requireNonNegativeInteger(value, name, event) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return value;
}

function requireNullableString(value, name, event) {
  return value === null ? null : requireString(value, name, event);
}

function requireNullableExitCode(value, name, event) {
  return value === null ? null : requireNonNegativeInteger(value, name, event);
}

function requireObject(value, name, event) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return value;
}

function requireSha256(value, name, event) {
  const hash = requireString(value, name, event);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return hash;
}

function requireArtifactDigest(value, name, event) {
  const digest = requireString(value, name, event);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return digest;
}

function requireArtifactRef(value, name, event) {
  const ref = requireObject(value, name, event);
  const expected = ['algorithm', 'digest', 'schemaVersion', 'size'];
  const actual = Object.keys(ref).sort();
  if (actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
    || ref.schemaVersion !== 1
    || ref.algorithm !== 'sha256'
    || !/^[a-f0-9]{64}$/.test(ref.digest)
    || !Number.isSafeInteger(ref.size)
    || ref.size < 0) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return { ...ref };
}

function requireGitObjectId(value, name, event) {
  const objectId = requireString(value, name, event);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(objectId)) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return objectId;
}

function requireTargetRef(value, name, event) {
  const targetRef = requireString(value, name, event);
  if (!targetRef.startsWith('refs/heads/')
    || targetRef === 'refs/heads/'
    || targetRef.endsWith('/')
    || targetRef.endsWith('.')
    || targetRef.endsWith('.lock')
    || targetRef.includes('..')
    || targetRef.includes('//')
    || targetRef.includes('@{')
    || /[\u0000-\u0020\u007f~^:?*[\\]/u.test(targetRef)) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return targetRef;
}

function requireFailure(value, name, event) {
  const failure = requireExactFields(value, ['code', 'details', 'message'], name, event);
  return {
    code: requireString(failure.code, `${name}.code`, event),
    message: requireString(failure.message, `${name}.message`, event),
    details: failure.details ?? null
  };
}

function requireNullableFailure(value, name, event) {
  return value === null ? null : requireFailure(value, name, event);
}

function requireEvaluator(value, name, event) {
  const evaluator = requireExactFields(value, ['id', 'version'], name, event);
  return {
    id: requireString(evaluator.id, `${name}.id`, event),
    version: requireString(evaluator.version, `${name}.version`, event)
  };
}

function requireRefSnapshot(value, name, event) {
  const snapshot = requireExactFields(
    value,
    ['hash', 'id', 'kind', 'uri', 'version'],
    name,
    event
  );
  const normalized = normalizeRef({ ...snapshot, metadata: {} }, { path: name });
  return {
    id: normalized.id,
    kind: normalized.kind,
    uri: normalized.uri,
    version: normalized.version,
    hash: normalized.hash
  };
}

function requireRunEffects(value, node, refs, event) {
  if (value === undefined) {
    return {
      logicalReads: [...node.reads],
      logicalWrites: [...node.writes],
      resolvedReads: [...node.reads],
      resolvedWrites: [...node.writes],
      consumedRefs: [],
      producedRefs: []
    };
  }
  const effects = requireExactFields(value, [
    'consumedRefs',
    'logicalReads',
    'logicalWrites',
    'producedRefs',
    'resolvedReads',
    'resolvedWrites'
  ], 'effects', event);
  const logicalReads = requireUniqueStringArray(
    effects.logicalReads,
    'effects.logicalReads',
    event
  );
  const logicalWrites = requireUniqueStringArray(
    effects.logicalWrites,
    'effects.logicalWrites',
    event
  );
  if (JSON.stringify(logicalReads) !== JSON.stringify(node.reads)
    || JSON.stringify(logicalWrites) !== JSON.stringify(node.writes)) {
    throw new ProjectionError(
      `${event.type} effects do not match Node ${node.id}.`,
      'run-ref-binding-mismatch',
      event
    );
  }
  const consumedRefs = requireArray(
    effects.consumedRefs,
    'effects.consumedRefs',
    event
  ).map((ref, index) => requireRefSnapshot(
    ref,
    `effects.consumedRefs[${index}]`,
    event
  ));
  const producedRefs = requireArray(
    effects.producedRefs,
    'effects.producedRefs',
    event
  ).map((ref, index) => requireRefSnapshot(
    ref,
    `effects.producedRefs[${index}]`,
    event
  ));
  for (const [field, snapshots, logical] of [
    ['consumedRefs', consumedRefs, logicalReads],
    ['producedRefs', producedRefs, logicalWrites]
  ]) {
    const expectedIds = logical.filter(isRefId);
    if (JSON.stringify(snapshots.map((ref) => ref.id)) !== JSON.stringify(expectedIds)) {
      throw new ProjectionError(
        `${event.type} ${field} do not match its logical effects.`,
        'run-ref-binding-mismatch',
        event
      );
    }
    for (const snapshot of snapshots) {
      const current = refs.get(snapshot.id);
      if (!current
        || current.kind !== snapshot.kind
        || current.uri !== snapshot.uri
        || current.version !== snapshot.version
        || current.hash !== snapshot.hash) {
        throw new ProjectionError(
          `${event.type} did not freeze the current version of Ref ${snapshot.id}.`,
          'run-ref-binding-mismatch',
          event
        );
      }
    }
  }
  return {
    logicalReads,
    logicalWrites,
    resolvedReads: requireUniqueStringArray(
      effects.resolvedReads,
      'effects.resolvedReads',
      event
    ),
    resolvedWrites: requireUniqueStringArray(
      effects.resolvedWrites,
      'effects.resolvedWrites',
      event
    ),
    consumedRefs,
    producedRefs
  };
}

function requirePhysicalConflicts(value, name, event) {
  const conflicts = requireArray(value, name, event);
  if (conflicts.length === 0) {
    throw new ProjectionError(
      `${event.type} must record at least one physical conflict.`,
      'invalid-event-payload',
      event
    );
  }
  const paths = new Set();
  return conflicts.map((value, index) => {
    const conflict = requireExactFields(
      value,
      ['path', 'stages'],
      `${name}[${index}]`,
      event
    );
    const conflictPath = requireWorkspacePath(
      conflict.path,
      `${name}[${index}].path`,
      event
    );
    if (paths.has(conflictPath)) {
      throw new ProjectionError(
        `${event.type} repeats conflict path ${conflictPath}.`,
        'invalid-event-payload',
        event
      );
    }
    paths.add(conflictPath);
    const stages = requireArray(conflict.stages, `${name}[${index}].stages`, event)
      .map((value, stageIndex) => {
        const stage = requireExactFields(
          value,
          ['blobOid', 'mode', 'stage'],
          `${name}[${index}].stages[${stageIndex}]`,
          event
        );
        if (![1, 2, 3].includes(stage.stage)) {
          throw new ProjectionError(
            `${event.type} has an invalid conflict stage.`,
            'invalid-event-payload',
            event
          );
        }
        return {
          stage: stage.stage,
          mode: requireString(stage.mode, 'mode', event),
          blobOid: requireGitObjectId(stage.blobOid, 'blobOid', event)
        };
      });
    if (stages.length === 0) {
      throw new ProjectionError(
        `${event.type} has a conflict without index stages.`,
        'invalid-event-payload',
        event
      );
    }
    return { path: conflictPath, stages };
  });
}

function sameEvaluator(left, right) {
  return left.id === right.id && left.version === right.version;
}

function requireEnvironmentFingerprint(value, name, event) {
  const fingerprint = requireExactFields(
    value,
    ['arch', 'environmentSha256', 'platform', 'runtime'],
    name,
    event
  );
  const runtime = requireExactFields(
    fingerprint.runtime,
    ['name', 'version'],
    `${name}.runtime`,
    event
  );
  return {
    platform: requireString(fingerprint.platform, `${name}.platform`, event),
    arch: requireString(fingerprint.arch, `${name}.arch`, event),
    runtime: {
      name: requireString(runtime.name, `${name}.runtime.name`, event),
      version: requireString(runtime.version, `${name}.runtime.version`, event)
    },
    environmentSha256: requireSha256(
      fingerprint.environmentSha256,
      `${name}.environmentSha256`,
      event
    )
  };
}

function sameArtifactRef(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.algorithm === right.algorithm
    && left.digest === right.digest
    && left.size === right.size;
}

function requireWorkspaceLocation(value, name, event, { allowRoot = false } = {}) {
  const location = requireString(value, name, event);
  if (allowRoot && location === '.') return location;
  return requireWorkspacePath(location, name, event);
}

function requireEvaluationWorkspaceRelativePath(value, name, event) {
  const path = requireString(value, name, event);
  if (path.includes('\\')
    || path.startsWith('/')
    || path.startsWith('//')
    || /^[A-Za-z]:(?:\/|$)/.test(path)
    || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return path;
}

function requirePolicyViolation(value, name, event) {
  const violation = requireObject(value, name, event);
  const allowed = new Set(['code', 'details', 'message']);
  if (!Object.keys(violation).every((field) => allowed.has(field))
    || !Object.hasOwn(violation, 'code')
    || !Object.hasOwn(violation, 'message')) {
    throw new ProjectionError(
      `${event.type} has invalid ${name} fields.`,
      'invalid-event-payload',
      event
    );
  }
  const normalized = {
    code: requireString(violation.code, `${name}.code`, event),
    message: requireString(violation.message, `${name}.message`, event)
  };
  if (Object.hasOwn(violation, 'details')) {
    normalized.details = violation.details;
  }
  return normalized;
}

function requireExpectedArtifact(value, name, event) {
  const item = requireExactFields(
    value,
    ['artifact', 'digest', 'failure', 'path', 'size'],
    name,
    event
  );
  const failure = requireNullableFailure(item.failure, `${name}.failure`, event);
  const hasArtifact = item.artifact !== null || item.digest !== null || item.size !== null;
  if (failure === null && !hasArtifact) {
    throw new ProjectionError(
      `${event.type} ${name} must contain either an artifact or a failure.`,
      'invalid-event-payload',
      event
    );
  }
  if (hasArtifact
    && (item.artifact === null || item.digest === null || item.size === null)) {
    throw new ProjectionError(
      `${event.type} ${name} has a partial artifact binding.`,
      'invalid-event-payload',
      event
    );
  }
  const artifact = item.artifact === null
    ? null
    : requireArtifactRef(item.artifact, `${name}.artifact`, event);
  const digest = item.digest === null
    ? null
    : requireArtifactDigest(item.digest, `${name}.digest`, event);
  const size = item.size === null
    ? null
    : requireNonNegativeInteger(item.size, `${name}.size`, event);
  if (artifact !== null && (digest !== artifact.digest || size !== artifact.size)) {
    throw new ProjectionError(
      `${event.type} ${name} does not match its artifact reference.`,
      'invalid-event-payload',
      event
    );
  }
  return {
    path: requireWorkspaceLocation(item.path, `${name}.path`, event),
    size,
    digest,
    artifact,
    failure
  };
}

function requireCriterion(value, name, event) {
  const criterion = requireExactFields(value, [
    'command',
    'durationMs',
    'exitCode',
    'expectedArtifacts',
    'failure',
    'id',
    'kind',
    'result',
    'signal',
    'stderrArtifact',
    'stdoutArtifact',
    'terminationConfirmed',
    'timedOut'
  ], name, event);
  const command = requireExactFields(
    criterion.command,
    ['args', 'command', 'cwd'],
    `${name}.command`,
    event
  );
  const result = requireString(criterion.result, `${name}.result`, event);
  if (!['pass', 'fail'].includes(result)) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.result.`,
      'invalid-event-payload',
      event
    );
  }
  const exitCode = requireNullableExitCode(
    criterion.exitCode,
    `${name}.exitCode`,
    event
  );
  const signal = requireNullableString(criterion.signal, `${name}.signal`, event);
  if (exitCode !== null && signal !== null) {
    throw new ProjectionError(
      `${event.type} ${name} cannot contain both exitCode and signal.`,
      'invalid-event-payload',
      event
    );
  }
  const timedOut = requireBoolean(criterion.timedOut, `${name}.timedOut`, event);
  const terminationConfirmed = requireBoolean(
    criterion.terminationConfirmed,
    `${name}.terminationConfirmed`,
    event
  );
  const failure = requireNullableFailure(criterion.failure, `${name}.failure`, event);
  if (result === 'pass'
    && (exitCode === null || signal !== null || timedOut || !terminationConfirmed || failure !== null)) {
    throw new ProjectionError(
      `${event.type} ${name} pass result contradicts its process outcome.`,
      'invalid-event-payload',
      event
    );
  }

  const expectedArtifacts = requireArray(
    criterion.expectedArtifacts,
    `${name}.expectedArtifacts`,
    event
  ).map((artifact, index) => requireExpectedArtifact(
    artifact,
    `${name}.expectedArtifacts[${index}]`,
    event
  ));
  const artifactPaths = new Set();
  for (const artifact of expectedArtifacts) {
    if (artifactPaths.has(artifact.path)) {
      throw new ProjectionError(
        `${event.type} has duplicate expected artifact path ${artifact.path}.`,
        'invalid-event-payload',
        event
      );
    }
    artifactPaths.add(artifact.path);
  }
  if (result === 'pass' && expectedArtifacts.some((artifact) => artifact.failure !== null)) {
    throw new ProjectionError(
      `${event.type} ${name} pass result contradicts a missing expected artifact.`,
      'invalid-event-payload',
      event
    );
  }
  if (result === 'fail'
    && failure === null
    && signal === null
    && !timedOut
    && terminationConfirmed
    && expectedArtifacts.every((artifact) => (
      artifact.artifact !== null && artifact.failure === null
    ))) {
    throw new ProjectionError(
      `${event.type} ${name} fail result has no durable failure reason.`,
      'invalid-event-payload',
      event
    );
  }

  return {
    id: requireString(criterion.id, `${name}.id`, event),
    kind: requireString(criterion.kind, `${name}.kind`, event),
    result,
    command: {
      command: requireString(command.command, `${name}.command.command`, event),
      args: requireStringArray(command.args, `${name}.command.args`, event),
      cwd: requireWorkspaceLocation(command.cwd, `${name}.command.cwd`, event, {
        allowRoot: true
      })
    },
    exitCode,
    signal,
    timedOut,
    terminationConfirmed,
    durationMs: requireNonNegativeInteger(
      criterion.durationMs,
      `${name}.durationMs`,
      event
    ),
    stdoutArtifact: requireArtifactRef(
      criterion.stdoutArtifact,
      `${name}.stdoutArtifact`,
      event
    ),
    stderrArtifact: requireArtifactRef(
      criterion.stderrArtifact,
      `${name}.stderrArtifact`,
      event
    ),
    expectedArtifacts,
    failure
  };
}

function requireRegressionCriterion(value, name, event) {
  const record = requireExactFields(value, [
    'aborted',
    'command',
    'durationMs',
    'exitCode',
    'expectedArtifacts',
    'failure',
    'id',
    'kind',
    'result',
    'signal',
    'stderrArtifact',
    'stdoutArtifact',
    'terminationConfirmed',
    'timedOut'
  ], name, event);
  const { aborted: rawAborted, ...standard } = record;
  const criterion = requireCriterion(standard, name, event);
  const aborted = requireBoolean(rawAborted, `${name}.aborted`, event);
  if (criterion.result === 'pass' && aborted) {
    throw new ProjectionError(
      `${event.type} ${name} pass result contradicts an aborted process.`,
      'invalid-event-payload',
      event
    );
  }
  return { ...criterion, aborted };
}

function requireRegressionEvidence(value, name, event, {
  ownerId,
  candidateRevision,
  regressionProfileHash
}) {
  const record = requireExactFields(value, [
    'candidateRevision',
    'cleanup',
    'criteria',
    'environmentFingerprint',
    'evaluator',
    'integrationId',
    'kind',
    'policyViolations',
    'profile',
    'profileArtifact',
    'regressionResult',
    'result',
    'resultArtifact',
    'schemaVersion',
    'workspace'
  ], name, event);
  const profile = requireExactFields(
    record.profile,
    ['id', 'schemaVersion', 'sha256'],
    `${name}.profile`,
    event
  );
  const profileSchemaVersion = profile.schemaVersion;
  if (!Number.isSafeInteger(profileSchemaVersion) || profileSchemaVersion < 1) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}.profile.schemaVersion.`,
      'invalid-event-payload',
      event
    );
  }
  const workspace = requireExactFields(
    record.workspace,
    ['detached', 'evaluationId', 'headRevision'],
    `${name}.workspace`,
    event
  );
  const cleanup = requireExactFields(
    record.cleanup,
    ['alreadyAbsent', 'attempted', 'failure', 'removed', 'status'],
    `${name}.cleanup`,
    event
  );
  const cleanupStatus = requireString(cleanup.status, `${name}.cleanup.status`, event);
  const cleanupAttempted = requireBoolean(
    cleanup.attempted,
    `${name}.cleanup.attempted`,
    event
  );
  const cleanupRemoved = requireBoolean(cleanup.removed, `${name}.cleanup.removed`, event);
  const cleanupAlreadyAbsent = requireBoolean(
    cleanup.alreadyAbsent,
    `${name}.cleanup.alreadyAbsent`,
    event
  );
  const cleanupFailure = requireNullableFailure(
    cleanup.failure,
    `${name}.cleanup.failure`,
    event
  );
  const cleanupValid = cleanupStatus === 'succeeded'
    ? (cleanupAttempted
      && (cleanupRemoved || cleanupAlreadyAbsent)
      && cleanupFailure === null)
    : cleanupStatus === 'failed'
      ? (cleanupAttempted
        && !cleanupRemoved
        && !cleanupAlreadyAbsent
        && cleanupFailure !== null)
      : false;
  if (!cleanupValid) {
    throw new ProjectionError(
      `${event.type} has contradictory ${name}.cleanup evidence.`,
      'invalid-event-payload',
      event
    );
  }

  const criteria = requireArray(record.criteria, `${name}.criteria`, event).map(
    (criterion, index) => requireRegressionCriterion(
      criterion,
      `${name}.criteria[${index}]`,
      event
    )
  );
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const criterionKinds = new Set(criteria.map((criterion) => criterion.kind));
  if (criteria.length === 0
    || criterionIds.size !== criteria.length
    || !criterionKinds.has('compile')
    || !criterionKinds.has('test')) {
    throw new ProjectionError(
      `${event.type} ${name} must uniquely cover compile and test criteria.`,
      'invalid-event-payload',
      event
    );
  }
  const policyViolations = requireArray(
    record.policyViolations,
    `${name}.policyViolations`,
    event
  ).map((violation, index) => requirePolicyViolation(
    violation,
    `${name}.policyViolations[${index}]`,
    event
  ));
  const regressionResult = requireString(
    record.regressionResult,
    `${name}.regressionResult`,
    event
  );
  const result = requireString(record.result, `${name}.result`, event);
  const derivedRegressionResult = criteria.every((criterion) => criterion.result === 'pass')
    && policyViolations.length === 0
    ? 'pass'
    : 'fail';
  const derivedResult = derivedRegressionResult === 'pass' && cleanupStatus === 'succeeded'
    ? 'pass'
    : 'fail';
  if (record.schemaVersion !== 1
    || record.kind !== 'integration-regression-gate'
    || record.integrationId !== ownerId
    || record.candidateRevision !== candidateRevision
    || profile.sha256 !== regressionProfileHash
    || regressionResult !== derivedRegressionResult
    || result !== derivedResult
    || requireString(workspace.evaluationId, `${name}.workspace.evaluationId`, event) !== ownerId
    || requireGitObjectId(workspace.headRevision, `${name}.workspace.headRevision`, event)
      !== candidateRevision
    || requireBoolean(workspace.detached, `${name}.workspace.detached`, event) !== true) {
    throw new ProjectionError(
      `${event.type} has invalid or unbound ${name}.`,
      'invalid-event-payload',
      event
    );
  }
  return {
    schemaVersion: 1,
    kind: 'integration-regression-gate',
    integrationId: ownerId,
    candidateRevision,
    result,
    regressionResult,
    evaluator: requireEvaluator(record.evaluator, `${name}.evaluator`, event),
    profile: {
      id: requireString(profile.id, `${name}.profile.id`, event),
      schemaVersion: profileSchemaVersion,
      sha256: requireSha256(profile.sha256, `${name}.profile.sha256`, event)
    },
    profileArtifact: requireArtifactRef(
      record.profileArtifact,
      `${name}.profileArtifact`,
      event
    ),
    resultArtifact: requireArtifactRef(
      record.resultArtifact,
      `${name}.resultArtifact`,
      event
    ),
    environmentFingerprint: requireEnvironmentFingerprint(
      record.environmentFingerprint,
      `${name}.environmentFingerprint`,
      event
    ),
    workspace: {
      evaluationId: ownerId,
      headRevision: candidateRevision,
      detached: true
    },
    criteria,
    policyViolations,
    cleanup: {
      attempted: cleanupAttempted,
      status: cleanupStatus,
      removed: cleanupRemoved,
      alreadyAbsent: cleanupAlreadyAbsent,
      failure: cleanupFailure
    }
  };
}

function requireWorkspacePath(value, name, event) {
  try {
    return normalizeWorkspacePath(requireString(value, name, event), { path: name });
  } catch (error) {
    throw new ProjectionError(
      `${event.type} has an invalid ${name}: ${error.message}`,
      'invalid-event-payload',
      event
    );
  }
}

function candidateChangedRefIds(refs, changedFiles, options = {}) {
  return [...changedRefsForFiles(
    [...refs.values()].map((ref) => ({
      id: ref.id,
      kind: ref.kind,
      uri: ref.uri,
      version: ref.version,
      hash: ref.hash,
      metadata: ref.metadata
    })),
    changedFiles,
    { ignoreCase: options.ignoreCase === true }
  )].sort((left, right) => left.localeCompare(right, 'en'));
}

function refContract(ref) {
  return {
    id: ref.id,
    kind: ref.kind,
    uri: ref.uri,
    version: ref.version,
    hash: ref.hash,
    metadata: ref.metadata
  };
}

function expectedMaterializedInvalidation(nodes, {
  changedRefIds,
  sourceNodeId,
  originId,
  staleByField
}) {
  const candidates = [...nodes.values()];
  const impact = changedRefIds.length > 0
    ? computeInvalidation(candidates, changedRefIds, { excludeNodeIds: [sourceNodeId] })
    : computeDependencyInvalidation(candidates, [sourceNodeId]);
  const affectedNodeIds = impact.affectedNodeIds.filter((nodeId) => {
    const node = nodes.get(nodeId);
    return node?.runIds.length > 0
      && [NodeStatus.PRODUCED, NodeStatus.ACCEPTED].includes(node.status)
      && (node.validity === Validity.VALID
        || (node.validity === Validity.STALE && node[staleByField].includes(originId)));
  }).sort();
  return {
    affectedNodeIds,
    recomputeRootNodeIds: impact.recomputeRootNodeIds
      .filter((nodeId) => affectedNodeIds.includes(nodeId))
      .sort()
  };
}

function requireStream(event, expected) {
  if (event.streamId !== expected) {
    throw new ProjectionError(
      `${event.type} belongs to ${event.streamId}; expected ${expected}.`,
      'stream-mismatch',
      event
    );
  }
}

export function projectEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError('events must be an array.');
  }

  const goals = new Map();
  const refs = new Map();
  const nodes = new Map();
  const runs = new Map();
  const changeSets = new Map();
  const evaluations = new Map();
  const evidence = new Map();
  const integrations = new Map();
  const reversions = new Map();
  const projectRevisions = [];
  const planIds = new Set();
  const streamVersions = new Map();
  const eventIds = new Set();
  let lastSequence = 0;
  let goalCompletionWindow = null;

  for (const event of events) {
    try {
      assertValidEventEnvelope(event);
    } catch (error) {
      throw new ProjectionError(
        error.message,
        error.reason === 'event-hash-invalid'
          ? 'event-hash-invalid'
          : 'event-envelope-invalid',
        event
      );
    }
    if (eventIds.has(event.eventId)) {
      throw new ProjectionError(
        `Duplicate event id ${event.eventId}.`,
        'duplicate-event-id',
        event
      );
    }
    eventIds.add(event.eventId);

    if (event.sequence !== lastSequence + 1) {
      throw new ProjectionError(
        `Expected event sequence ${lastSequence + 1}, received ${event.sequence}.`,
        'event-sequence-gap',
        event
      );
    }
    lastSequence = event.sequence;

    const streamVersion = event.metadata?.streamVersion;
    const expectedStreamVersion = (streamVersions.get(event.streamId) ?? 0) + 1;
    if (!Number.isSafeInteger(streamVersion)
      || streamVersion < 1
      || streamVersion !== expectedStreamVersion) {
      throw new ProjectionError(
        `Expected ${event.streamId} version ${expectedStreamVersion}, received ${streamVersion}.`,
        'stream-version-conflict',
        event
      );
    }
    streamVersions.set(event.streamId, streamVersion);

    if (goalCompletionWindow
      && !['NodeReady', 'GoalCompleted'].includes(event.type)) {
      goalCompletionWindow = null;
    }

    switch (event.type) {
      case 'RefRegistered': {
        const payload = requireExactFields(event.payload, [
          'hash', 'id', 'kind', 'metadata', 'uri', 'version'
        ], 'payload', event);
        const ref = normalizeRef(payload, { path: 'payload' });
        requireStream(event, `ref:${ref.id}`);
        const activeOperationExists = [...runs.values()].some((candidate) => [
          RunStatus.PENDING,
          RunStatus.RUNNING,
          RunStatus.PAUSED
        ].includes(candidate.status))
          || [...evaluations.values()].some((candidate) => [
            EvaluationStatus.REQUESTED,
            EvaluationStatus.RUNNING,
            EvaluationStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))
          || [...integrations.values()].some((candidate) => [
            IntegrationStatus.PENDING,
            IntegrationStatus.RUNNING,
            IntegrationStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))
          || [...reversions.values()].some((candidate) => [
            ReversionStatus.PENDING,
            ReversionStatus.RUNNING,
            ReversionStatus.RECOVERY_REQUIRED
          ].includes(candidate.status));
        if (activeOperationExists) {
          throw new ProjectionError(
            `Ref ${ref.id} cannot be registered while a project operation is active.`,
            'active-project-operation-exists',
            event
          );
        }
        if (refs.has(ref.id)) {
          throw new ProjectionError(
            `Ref ${ref.id} already exists.`,
            'ref-already-exists',
            event
          );
        }
        refs.set(ref.id, {
          ...ref,
          registeredAt: event.occurredAt,
          updatedAt: event.occurredAt,
          streamVersion
        });
        break;
      }
      case 'RefVersionAdvanced': {
        const payload = requireExactFields(event.payload, [
          'changeSetId',
          'changedFiles',
          'hash',
          'integrationId',
          'previousHash',
          'previousVersion',
          'refId',
          'version'
        ], 'payload', event);
        const refId = requireString(payload.refId, 'refId', event);
        requireStream(event, `ref:${refId}`);
        const ref = refs.get(refId);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const integration = integrations.get(integrationId);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        const changeSet = changeSets.get(changeSetId);
        const coreIgnoreCase = changeSet?.coreIgnoreCase === true;
        const sourceNode = nodes.get(integration?.nodeId);
        const candidateEffects = integration?.strategy === 'merge-commit-regression-gated'
          ? integration
          : changeSet;
        const changedFiles = requireUniqueStringArray(
          payload.changedFiles,
          'changedFiles',
          event
        ).map((file, index) => requireWorkspacePath(
          file,
          `changedFiles[${index}]`,
          event
        ));
        const previousVersion = requireString(
          payload.previousVersion,
          'previousVersion',
          event
        );
        const previousHash = requireSha256(payload.previousHash, 'previousHash', event);
        const version = requireString(payload.version, 'version', event);
        const hash = requireSha256(payload.hash, 'hash', event);
        const expectedChangedFiles = !ref || !candidateEffects
          ? null
          : candidateEffects.changedFiles.filter((file) => (
              matchesEffectPattern(ref.uri, file, { ignoreCase: coreIgnoreCase })
            ));
        const expectedHash = !ref
          || !candidateEffects
          || !integration
          || typeof integration.candidateRevision !== 'string'
          ? null
          : refVersionDigest({
              ref: refContract(ref),
              revision: integration.candidateRevision,
              changedFiles: candidateEffects.changedFiles,
              changes: candidateEffects.changes,
              ignoreCase: coreIgnoreCase
            });
        if (!ref || !integration || !changeSet
          || !sourceNode
          || integration.status !== IntegrationStatus.INTEGRATED
          || integration.projectRevisionSequence === null
          || integration.appliedSequence === null
          || integration.nodeTerminalSequence === null
          || integration.effectsAppliedSequence !== null
          || sourceNode.integrationStatus !== IntegrationStatus.INTEGRATED
          || sourceNode.integratedChangeSetId !== changeSetId
          || sourceNode.integratedRevision !== integration.candidateRevision
          || integration.changeSetId !== changeSetId
          || changeSet.nodeId !== integration.nodeId
          || !candidateEffects?.changedRefIds.includes(refId)
          || ref.lastIntegrationId === integrationId
          || ref.version !== previousVersion
          || ref.hash !== previousHash
          || version !== integration.candidateRevision
          || JSON.stringify(changedFiles) !== JSON.stringify(expectedChangedFiles)
          || hash !== expectedHash) {
          throw new ProjectionError(
            `${event.type} does not match its Ref, Integration, and ChangeSet.`,
            'ref-version-binding-mismatch',
            event
          );
        }
        if (JSON.stringify(changedFiles) !== JSON.stringify(
          [...changedFiles].sort((left, right) => left.localeCompare(right, 'en'))
        )) {
          throw new ProjectionError(
            `${event.type} changedFiles must be sorted.`,
            'invalid-event-payload',
            event
          );
        }
        ref.version = version;
        ref.hash = hash;
        ref.updatedAt = event.occurredAt;
        ref.lastIntegrationId = integrationId;
        ref.lastChangeSetId = changeSetId;
        ref.streamVersion = streamVersion;
        integration.advancedRefIds.push(refId);
        break;
      }
      case 'IntegrationEffectsApplied': {
        const payload = requireExactFields(event.payload, [
          'advancedRefIds',
          'affectedNodeIds',
          'integrationId',
          'recomputeRootNodeIds',
          'reopenedGoalIds'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const sourceNode = nodes.get(integration?.nodeId);
        const changeSet = changeSets.get(integration?.changeSetId);
        const candidateEffects = integration?.strategy === 'merge-commit-regression-gated'
          ? integration
          : changeSet;
        const affectedNodeIds = requireUniqueStringArray(
          payload.affectedNodeIds,
          'affectedNodeIds',
          event
        );
        const recomputeRootNodeIds = requireUniqueStringArray(
          payload.recomputeRootNodeIds,
          'recomputeRootNodeIds',
          event
        );
        const reopenedGoalIds = requireUniqueStringArray(
          payload.reopenedGoalIds,
          'reopenedGoalIds',
          event
        );
        const advancedRefIds = requireUniqueStringArray(
          payload.advancedRefIds,
          'advancedRefIds',
          event
        );
        const expectedImpact = !integration || !candidateEffects
          ? null
          : expectedMaterializedInvalidation(nodes, {
              changedRefIds: candidateEffects.changedRefIds,
              sourceNodeId: integration.nodeId,
              originId: integrationId,
              staleByField: 'staleByIntegrationIds'
            });
        const impactedNodeIds = new Set(expectedImpact?.affectedNodeIds ?? []);
        const missingGoalReopen = [...goals.values()].some((goal) => (
          goal.status === GoalStatus.COMPLETED
          && goal.nodeIds.some((nodeId) => impactedNodeIds.has(nodeId))
        ));
        if (!integration
          || !sourceNode
          || !changeSet
          || !candidateEffects
          || integration.status !== IntegrationStatus.INTEGRATED
          || integration.projectRevisionSequence === null
          || integration.appliedSequence === null
          || integration.nodeTerminalSequence === null
          || integration.effectsAppliedSequence !== null
          || sourceNode.integrationStatus !== IntegrationStatus.INTEGRATED
          || sourceNode.integratedChangeSetId !== integration.changeSetId
          || sourceNode.integratedRevision !== integration.candidateRevision
          || JSON.stringify(affectedNodeIds) !== JSON.stringify(
            expectedImpact?.affectedNodeIds
          )
          || JSON.stringify(recomputeRootNodeIds) !== JSON.stringify(
            expectedImpact?.recomputeRootNodeIds
          )
          || JSON.stringify(affectedNodeIds) !== JSON.stringify(
            [...integration.affectedNodeIds].sort()
          )
          || JSON.stringify(recomputeRootNodeIds) !== JSON.stringify(
            [...integration.recomputeRootNodeIds].sort()
          )
          || JSON.stringify(advancedRefIds) !== JSON.stringify(
            [...candidateEffects.changedRefIds].sort((left, right) => (
              left.localeCompare(right, 'en')
            ))
          )
          || JSON.stringify(advancedRefIds) !== JSON.stringify(
            [...integration.advancedRefIds].sort()
          )
          || JSON.stringify(reopenedGoalIds) !== JSON.stringify(
            [...integration.reopenedGoalIds].sort()
          )
          || missingGoalReopen) {
          throw new ProjectionError(
            `Integration ${integrationId} has incomplete or contradictory derived effects.`,
            'integration-effects-binding-mismatch',
            event
          );
        }
        integration.affectedNodeIds = affectedNodeIds;
        integration.recomputeRootNodeIds = recomputeRootNodeIds;
        integration.reopenedGoalIds = reopenedGoalIds;
        integration.advancedRefIds = advancedRefIds;
        integration.effectsAppliedSequence = event.sequence;
        integration.version = streamVersion;
        break;
      }
      case 'GoalCreated': {
        const goalId = requireString(event.payload.goalId, 'goalId', event);
        requireStream(event, `goal:${goalId}`);
        if (goals.has(goalId)) {
          throw new ProjectionError(
            `Goal ${goalId} already exists.`,
            'goal-already-exists',
            event
          );
        }
        goals.set(goalId, {
          id: goalId,
          title: requireString(event.payload.title, 'title', event),
          request: requireString(event.payload.request, 'request', event),
          status: GoalStatus.DRAFT,
          planId: null,
          planHash: null,
          nodeIds: [],
          runIds: [],
          integrationTargetRef: null,
          version: streamVersion
        });
        break;
      }
      case 'PlanLoaded': {
        const goalId = requireString(event.payload.goalId, 'goalId', event);
        requireStream(event, `goal:${goalId}`);
        const goal = goals.get(goalId);
        if (!goal) {
          throw new ProjectionError(
            `Plan references unknown goal ${goalId}.`,
            'goal-not-found',
            event
          );
        }
        goal.status = transitionGoal(goal.status, GoalStatus.PLANNED);
        const planId = requireString(event.payload.planId, 'planId', event);
        if (planIds.has(planId)) {
          throw new ProjectionError(
            `Plan id ${planId} already exists.`,
            'plan-already-exists',
            event
          );
        }
        planIds.add(planId);
        goal.planId = planId;
        goal.planHash = requireString(event.payload.planHash, 'planHash', event);
        if (!/^sha256:[a-f0-9]{64}$/.test(goal.planHash)) {
          throw new ProjectionError(
            `${event.type} has an invalid planHash.`,
            'invalid-event-payload',
            event
          );
        }
        goal.nodeIds = requireUniqueStringArray(event.payload.nodeIds, 'nodeIds', event);
        if (goal.nodeIds.length === 0) {
          throw new ProjectionError(
            'PlanLoaded must contain at least one node id.',
            'invalid-event-payload',
            event
          );
        }
        goal.version = streamVersion;
        break;
      }
      case 'NodePlanned': {
        const node = event.payload.node;
        if (node === null || typeof node !== 'object' || Array.isArray(node)) {
          throw new ProjectionError(
            'NodePlanned has an invalid node.',
            'invalid-event-payload',
            event
          );
        }
        const nodeId = requireString(node.id, 'node.id', event);
        const goalId = requireString(event.payload.goalId, 'goalId', event);
        const planId = requireString(event.payload.planId, 'planId', event);
        requireStream(event, `node:${nodeId}`);
        if (nodes.has(nodeId)) {
          throw new ProjectionError(
            `Node ${nodeId} already exists.`,
            'node-already-exists',
            event
          );
        }
        const goal = goals.get(goalId);
        if (!goal || goal.planId !== planId || !goal.nodeIds.includes(nodeId)) {
          throw new ProjectionError(
            `Node ${nodeId} is not declared by plan ${planId} for goal ${goalId}.`,
            'node-plan-mismatch',
            event
          );
        }
        nodes.set(nodeId, {
          ...node,
          goalId,
          planId,
          status: NodeStatus.PLANNED,
          validity: Validity.VALID,
          integrationStatus: null,
          runIds: [],
          changeSetIds: [],
          revertChangeSetIds: [],
          evaluationIds: [],
          activeEvaluationId: null,
          acceptedChangeSetId: null,
          acceptanceEvidenceIds: [],
          integrationIds: [],
          activeIntegrationId: null,
          integratedChangeSetId: null,
          integratedRevision: null,
          integratedTargetRef: null,
          revertedByReversionId: null,
          staleByIntegrationIds: [],
          staleByReversionIds: [],
          version: streamVersion
        });
        break;
      }
      case 'NodeReady': {
        const nodeId = requireString(event.payload.nodeId, 'nodeId', event);
        const goalId = requireString(event.payload.goalId, 'goalId', event);
        const planId = requireString(event.payload.planId, 'planId', event);
        requireStream(event, `node:${nodeId}`);
        const node = nodes.get(nodeId);
        if (!node) {
          throw new ProjectionError(
            `Ready event references unknown node ${nodeId}.`,
            'node-not-found',
            event
          );
        }
        if (node.goalId !== goalId || node.planId !== planId) {
          throw new ProjectionError(
            `Ready event does not match node ${nodeId}'s goal and plan.`,
            'node-plan-mismatch',
            event
          );
        }
        const reason = event.payload.reason === undefined
          ? 'dependencies-satisfied'
          : requireString(event.payload.reason, 'reason', event);
        const goal = goals.get(node.goalId);
        const dependenciesSatisfied = areNodeDependenciesSatisfied(node, nodes, goal);
        if (!dependenciesSatisfied) {
          throw new ProjectionError(
            `Node ${nodeId} cannot become ready before its dependencies are accepted, valid, and integrated.`,
            'node-not-ready',
            event
          );
        }
        if (node.status !== NodeStatus.PLANNED
          && (reason !== 'retry' || node.status !== NodeStatus.FAILED
            || node.validity !== Validity.VALID
            || isUnfencedGitProcessFailure(runs.get(node.runIds.at(-1))?.failure)
            || node.runIds.length > node.budget.maxRetries)) {
          throw new ProjectionError(
            `Node ${nodeId} can only re-enter ready state for a retry.`,
            'node-not-ready',
            event
          );
        }
        node.status = transitionNode(node.status, NodeStatus.READY);
        node.readySequence = event.sequence;
        node.version = streamVersion;
        if (goalCompletionWindow
          && goalCompletionWindow.goalId === node.goalId
          && event.sequence === goalCompletionWindow.lastSequence + 1) {
          goalCompletionWindow.lastSequence = event.sequence;
        } else if (goalCompletionWindow) {
          goalCompletionWindow = null;
        }
        break;
      }
      case 'NodeRetryRequested': {
        const payload = requireExactFields(event.payload, [
          'goalId', 'mode', 'nodeId', 'planId', 'previousRunId', 'reason'
        ], 'payload', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        requireStream(event, `node:${nodeId}`);
        const node = nodes.get(nodeId);
        const goal = goals.get(node?.goalId);
        const eligibility = nodeRetryEligibility(node, nodes, goal);
        const operations = {
          runs: runs.values(), evaluations: evaluations.values(),
          integrations: integrations.values(), reversions: reversions.values()
        };
        if (hasActiveProjectOperation(operations)) {
          throw new ProjectionError('Retry requires a quiescent project.',
            'project-operation-active', event);
        }
        if (!eligibility.ok) {
          throw new ProjectionError(`Node ${nodeId} cannot retry.`, eligibility.code, event);
        }
        if (payload.goalId !== node.goalId || payload.planId !== node.planId
          || payload.previousRunId !== node.runIds.at(-1) || payload.mode !== eligibility.mode) {
          throw new ProjectionError('Retry does not bind the latest node attempt.',
            'node-retry-binding-mismatch', event);
        }
        if (nodeHasUnsettledWorkspace(node, {
          runs: runs.values(), evaluations: evaluations.values(),
          integrations: integrations.values(), reversions: reversions.values()
        })) {
          throw new ProjectionError('Retry requires settled workspaces.',
            'node-workspace-not-settled', event);
        }
        const reason = payload.reason === null ? null : requireString(payload.reason, 'reason', event);
        node.retryHistory ??= [];
        node.retryHistory.push({
          sequence: event.sequence, commandId: event.correlationId,
          mode: eligibility.mode, reason, previousRunId: payload.previousRunId,
          previousStatus: node.status, previousValidity: node.validity,
          acceptedChangeSetId: node.acceptedChangeSetId,
          integratedChangeSetId: node.integratedChangeSetId,
          integrationStatus: node.integrationStatus
        });
        node.retrySequence = event.sequence;
        node.status = transitionNode(node.status, NodeStatus.READY);
        node.validity = Validity.VALID;
        node.acceptedChangeSetId = null;
        node.acceptanceEvidenceIds = [];
        node.integrationStatus = null;
        node.activeIntegrationId = null;
        node.integratedChangeSetId = null;
        node.integratedRevision = null;
        node.integratedTargetRef = null;
        node.revertedByReversionId = null;
        node.readySequence = event.sequence;
        node.version = streamVersion;
        break;
      }
      case 'RunCreated': {
        if ([...runs.values()].some((run) => isUnfencedGitProcessFailure(run.failure))) {
          throw new ProjectionError('An unfenced Git process requires manual recovery.',
            'git-process-manual-recovery-required', event);
        }
        const runId = requireString(event.payload.runId, 'runId', event);
        const nodeId = requireString(event.payload.nodeId, 'nodeId', event);
        const goalId = requireString(event.payload.goalId, 'goalId', event);
        const planId = requireString(event.payload.planId, 'planId', event);
        requireStream(event, `run:${runId}`);
        if (runs.has(runId)) {
          throw new ProjectionError(
            `Run ${runId} already exists.`,
            'run-already-exists',
            event
          );
        }
        if ([...evaluations.values()].some((evaluation) => [
          EvaluationStatus.REQUESTED,
          EvaluationStatus.RUNNING,
          EvaluationStatus.RECOVERY_REQUIRED
        ].includes(evaluation.status))) {
          throw new ProjectionError(
            'A serial FWA project cannot start a Run while an Evaluation is active.',
            'active-evaluation-exists',
            event
          );
        }
        if ([...integrations.values()].some((integration) => [
          IntegrationStatus.PENDING,
          IntegrationStatus.RUNNING,
          IntegrationStatus.RECOVERY_REQUIRED
        ].includes(integration.status))) {
          throw new ProjectionError(
            'A serial FWA project cannot start a Run while an Integration is active.',
            'active-integration-exists',
            event
          );
        }
        if ([...reversions.values()].some((reversion) => [
          ReversionStatus.PENDING,
          ReversionStatus.RUNNING,
          ReversionStatus.RECOVERY_REQUIRED
        ].includes(reversion.status))) {
          throw new ProjectionError(
            'A serial FWA project cannot start a Run while a Reversion is active.',
            'active-reversion-exists',
            event
          );
        }
        if ([...runs.values()].some((run) => (
          run.status === RunStatus.PENDING
          || run.status === RunStatus.RUNNING
          || run.status === RunStatus.PAUSED
        ))) {
          throw new ProjectionError(
            'A serial FWA project cannot contain more than one active Run.',
            'active-run-exists',
            event
          );
        }
        const node = nodes.get(nodeId);
        const goal = goals.get(goalId);
        if (!node || !goal
          || node.goalId !== goalId
          || node.planId !== planId
          || goal.planId !== planId) {
          throw new ProjectionError(
            `Run ${runId} does not match node ${nodeId}'s goal and plan.`,
            'run-node-mismatch',
            event
          );
        }
        if (!isNodeSchedulable(node, nodes, goal)) {
          throw new ProjectionError(
            `Run ${runId} requires a ready, valid node ${nodeId}; it is ${node.status}/${node.validity}.`,
            'node-not-ready',
            event
          );
        }
        if (node.runIds.length > node.budget.maxRetries) {
          throw new ProjectionError(`Node ${nodeId} exhausted its retry budget.`,
            'node-retry-budget-exhausted', event);
        }
        if (goal.status !== GoalStatus.PLANNED && goal.status !== GoalStatus.ACTIVE) {
          throw new ProjectionError(
            `Run ${runId} cannot be created for ${goal.status} goal ${goalId}.`,
            'goal-not-runnable',
            event
          );
        }
        const executor = requireObject(event.payload.executor, 'executor', event);
        const normalizedExecutor = {
          id: requireString(executor.id, 'executor.id', event),
          version: requireString(executor.version, 'executor.version', event)
        };
        const effects = requireRunEffects(event.payload.effects, node, refs, event);
        const run = {
          id: runId,
          nodeId,
          goalId,
          planId,
          status: RunStatus.PENDING,
          executor: normalizedExecutor,
          requestedBaseRevision: requireString(
            event.payload.requestedBaseRevision,
            'requestedBaseRevision',
            event
          ),
          baseRevision: requireGitObjectId(event.payload.baseRevision, 'baseRevision', event),
          inputHash: requireSha256(event.payload.inputHash, 'inputHash', event),
          effects,
          workspaceRelativePath: requireString(
            event.payload.workspaceRelativePath,
            'workspaceRelativePath',
            event
          ),
          workspacePath: null,
          workspaceStatus: 'not-created',
          cleanupFailures: [],
          leaseId: null,
          changeSetId: null,
          failure: null,
          createdAt: event.occurredAt,
          createdSequence: event.sequence,
          startedAt: null,
          producedAt: null,
          failedAt: null,
          version: streamVersion
        };
        runs.set(runId, run);
        node.runIds.push(runId);
        goal.runIds.push(runId);
        break;
      }
      case 'GoalActivated': {
        const goalId = requireString(event.payload.goalId, 'goalId', event);
        const nodeId = requireString(event.payload.nodeId, 'nodeId', event);
        const runId = requireString(event.payload.runId, 'runId', event);
        requireStream(event, `goal:${goalId}`);
        const goal = goals.get(goalId);
        const node = nodes.get(nodeId);
        const run = runs.get(runId);
        if (!goal || !node || !run
          || node.goalId !== goalId
          || run.goalId !== goalId
          || run.nodeId !== nodeId) {
          throw new ProjectionError(
            `Goal activation does not match run ${runId} and node ${nodeId}.`,
            'run-node-mismatch',
            event
          );
        }
        if (run.status !== RunStatus.PENDING || node.status !== NodeStatus.READY) {
          throw new ProjectionError(
            `Goal ${goalId} cannot activate for a non-pending Run.`,
            'run-not-pending',
            event
          );
        }
        goal.status = transitionGoal(goal.status, GoalStatus.ACTIVE);
        goal.version = streamVersion;
        break;
      }
      case 'NodeStarted': {
        const nodeId = requireString(event.payload.nodeId, 'nodeId', event);
        const runId = requireString(event.payload.runId, 'runId', event);
        requireStream(event, `node:${nodeId}`);
        const node = nodes.get(nodeId);
        const run = runs.get(runId);
        const goal = goals.get(node?.goalId);
        if (!node || !run || !goal
          || run.nodeId !== nodeId
          || run.goalId !== node.goalId) {
          throw new ProjectionError(
            `Node start does not match run ${runId}.`,
            'run-node-mismatch',
            event
          );
        }
        if (run.status !== RunStatus.PENDING) {
          throw new ProjectionError(
            `Node ${nodeId} cannot start for ${run.status} run ${runId}.`,
            'run-not-pending',
            event
          );
        }
        if (goal.status !== GoalStatus.ACTIVE) {
          throw new ProjectionError(
            `Node ${nodeId} cannot start before goal ${goal.id} is active.`,
            'goal-not-active',
            event
          );
        }
        node.status = transitionNode(node.status, NodeStatus.RUNNING);
        node.version = streamVersion;
        break;
      }
      case 'RunStarted': {
        const runId = requireString(event.payload.runId, 'runId', event);
        const nodeId = requireString(event.payload.nodeId, 'nodeId', event);
        requireStream(event, `run:${runId}`);
        const run = runs.get(runId);
        const node = nodes.get(nodeId);
        const goal = goals.get(run?.goalId);
        if (!run || !node || !goal
          || run.nodeId !== nodeId
          || node.status !== NodeStatus.RUNNING
          || goal.status !== GoalStatus.ACTIVE) {
          throw new ProjectionError(
            `Run ${runId} cannot start without its running node ${nodeId}.`,
            'run-node-mismatch',
            event
          );
        }
        run.status = transitionRun(run.status, RunStatus.RUNNING);
        run.workspacePath = requireString(event.payload.workspacePath, 'workspacePath', event);
        run.workspaceStatus = 'present';
        run.leaseId = requireString(event.payload.leaseId, 'leaseId', event);
        run.startedAt = event.occurredAt;
        run.version = streamVersion;
        break;
      }
      case 'ChangeSetCaptured': {
        const changeSetId = requireString(
          event.payload.changeSetId,
          'changeSetId',
          event
        );
        const runId = requireString(event.payload.runId, 'runId', event);
        const nodeId = requireString(event.payload.nodeId, 'nodeId', event);
        requireStream(event, `changeset:${changeSetId}`);
        if (changeSets.has(changeSetId)) {
          throw new ProjectionError(
            `ChangeSet ${changeSetId} already exists.`,
            'changeset-already-exists',
            event
          );
        }
        const run = runs.get(runId);
        const node = nodes.get(nodeId);
        if (!run || !node
          || run.nodeId !== nodeId
          || run.status !== RunStatus.RUNNING
          || node.status !== NodeStatus.RUNNING
          || run.changeSetId !== null) {
          throw new ProjectionError(
            `ChangeSet ${changeSetId} does not match a running attempt.`,
            'changeset-run-mismatch',
            event
          );
        }
        const valid = requireBoolean(event.payload.valid, 'valid', event);
        const changedFiles = requireUniqueStringArray(
          event.payload.changedFiles,
          'changedFiles',
          event
        );
        const commits = requireUniqueStringArray(event.payload.commits, 'commits', event);
        const violations = requireArray(event.payload.violations, 'violations', event);
        const changes = requireArray(event.payload.changes, 'changes', event);
        const coreIgnoreCase = event.payload.coreIgnoreCase === undefined
          ? false
          : requireBoolean(event.payload.coreIgnoreCase, 'coreIgnoreCase', event);
        const changedRefIds = event.payload.changedRefIds === undefined
          ? []
          : requireUniqueStringArray(event.payload.changedRefIds, 'changedRefIds', event);
        for (const refId of changedRefIds) {
          if (!isRefId(refId) || !refs.has(refId) || !node.writes.includes(refId)) {
            throw new ProjectionError(
              `${event.type} references an unknown or undeclared changed Ref ${refId}.`,
              'changeset-ref-binding-mismatch',
              event
            );
          }
        }
        for (const [index, change] of changes.entries()) {
          const item = requireObject(change, `changes[${index}]`, event);
          requireString(item.status, `changes[${index}].status`, event);
          requireWorkspacePath(item.path, `changes[${index}].path`, event);
          if (item.previousPath !== undefined) {
            requireWorkspacePath(
              item.previousPath,
              `changes[${index}].previousPath`,
              event
            );
          }
        }
        if (valid !== (violations.length === 0)) {
          throw new ProjectionError(
            `${event.type} valid must be true exactly when violations is empty.`,
            'invalid-event-payload',
            event
          );
        }
        for (const [index, changedFile] of changedFiles.entries()) {
          changedFiles[index] = requireWorkspacePath(
            changedFile,
            `changedFiles[${index}]`,
            event
          );
        }
        for (const change of changes) {
          if (!changedFiles.includes(change.path)
            || (change.previousPath !== undefined
              && !changedFiles.includes(change.previousPath))) {
            throw new ProjectionError(
              `${event.type} changes and changedFiles disagree.`,
              'invalid-event-payload',
              event
            );
          }
        }
        const stats = requireObject(event.payload.stats, 'stats', event);
        for (const [name, value] of Object.entries(stats)) {
          if (!Number.isSafeInteger(value) || value < 0) {
            throw new ProjectionError(
              `${event.type} has an invalid stats.${name}.`,
              'invalid-event-payload',
              event
            );
          }
        }
        const patchArtifact = requireArtifactRef(
          event.payload.patchArtifact,
          'patchArtifact',
          event
        );
        const executionArtifact = requireArtifactRef(
          event.payload.executionArtifact,
          'executionArtifact',
          event
        );
        const changeSet = {
          id: changeSetId,
          kind: 'execution',
          runId,
          reversionId: null,
          nodeId,
          goalId: run.goalId,
          baseRevision: requireGitObjectId(event.payload.baseRevision, 'baseRevision', event),
          headRevision: requireGitObjectId(event.payload.headRevision, 'headRevision', event),
          commits: commits.map((commit, index) => (
            requireGitObjectId(commit, `commits[${index}]`, event)
          )),
          changedFiles,
          changes,
          changedRefIds,
          coreIgnoreCase,
          ref: requireString(event.payload.ref, 'ref', event),
          branch: requireString(event.payload.branch, 'branch', event),
          valid,
          violations,
          stats,
          patchArtifact,
          executionArtifact,
          revertsChangeSetId: null,
          revertedByChangeSetId: null,
          revertedByReversionId: null,
          revertedAt: null,
          capturedAt: event.occurredAt,
          version: streamVersion
        };
        const payloadGoalId = requireString(event.payload.goalId, 'goalId', event);
        if (changeSet.baseRevision !== run.baseRevision || payloadGoalId !== run.goalId) {
          throw new ProjectionError(
            `ChangeSet ${changeSetId} has a different base than run ${runId}.`,
            'changeset-run-mismatch',
            event
          );
        }
        changeSets.set(changeSetId, changeSet);
        run.changeSetId = changeSetId;
        node.changeSetIds.push(changeSetId);
        break;
      }
      case 'RunProduced': {
        const runId = requireString(event.payload.runId, 'runId', event);
        const changeSetId = requireString(
          event.payload.changeSetId,
          'changeSetId',
          event
        );
        requireStream(event, `run:${runId}`);
        const run = runs.get(runId);
        const changeSet = changeSets.get(changeSetId);
        if (!run || !changeSet
          || changeSet.runId !== runId
          || run.changeSetId !== changeSetId
          || !changeSet.valid) {
          throw new ProjectionError(
            `Run ${runId} cannot produce invalid or missing ChangeSet ${changeSetId}.`,
            'changeset-run-mismatch',
            event
          );
        }
        run.status = transitionRun(run.status, RunStatus.PRODUCED);
        run.workspaceStatus = 'cleanup-pending';
        run.summary = requireString(event.payload.summary, 'summary', event);
        run.producedAt = event.occurredAt;
        run.version = streamVersion;
        break;
      }
      case 'NodeProduced': {
        const nodeId = requireString(event.payload.nodeId, 'nodeId', event);
        const runId = requireString(event.payload.runId, 'runId', event);
        const changeSetId = requireString(
          event.payload.changeSetId,
          'changeSetId',
          event
        );
        requireStream(event, `node:${nodeId}`);
        const node = nodes.get(nodeId);
        const run = runs.get(runId);
        if (!node || !run
          || run.nodeId !== nodeId
          || run.status !== RunStatus.PRODUCED
          || run.changeSetId !== changeSetId
          || node.runIds.at(-1) !== runId) {
          throw new ProjectionError(
            `Node ${nodeId} cannot produce from run ${runId}.`,
            'run-node-mismatch',
            event
          );
        }
        node.status = transitionNode(node.status, NodeStatus.PRODUCED);
        node.version = streamVersion;
        break;
      }
      case 'EvaluationRequested': {
        const payload = requireExactFields(event.payload, [
          'changeSetId',
          'contractId',
          'evaluationId',
          'evaluator',
          'headRevision',
          'nodeId',
          'profileArtifact',
          'profileHash',
          'requiredCriteria',
          'runId',
          'workspaceRelativePath'
        ], 'payload', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const runId = requireString(payload.runId, 'runId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `evaluation:${evaluationId}`);
        if (evaluations.has(evaluationId)) {
          throw new ProjectionError(
            `Evaluation ${evaluationId} already exists.`,
            'evaluation-already-exists',
            event
          );
        }
        if ([...runs.values()].some((candidate) => [
          RunStatus.PENDING,
          RunStatus.RUNNING,
          RunStatus.PAUSED
        ].includes(candidate.status))
          || [...evaluations.values()].some((candidate) => [
            EvaluationStatus.REQUESTED,
            EvaluationStatus.RUNNING,
            EvaluationStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))
          || [...integrations.values()].some((candidate) => [
            IntegrationStatus.PENDING,
            IntegrationStatus.RUNNING,
            IntegrationStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))
          || [...reversions.values()].some((candidate) => [
            ReversionStatus.PENDING,
            ReversionStatus.RUNNING,
            ReversionStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))) {
          throw new ProjectionError(
            'A serial FWA project cannot start an Evaluation while another operation is active.',
            'active-project-operation-exists',
            event
          );
        }
        const node = nodes.get(nodeId);
        const run = runs.get(runId);
        const changeSet = changeSets.get(changeSetId);
        if (!node || !run || !changeSet
          || node.status !== NodeStatus.PRODUCED
          || node.activeEvaluationId !== null
          || run.status !== RunStatus.PRODUCED
          || run.nodeId !== nodeId
          || run.changeSetId !== changeSetId
          || changeSet.nodeId !== nodeId
          || changeSet.runId !== runId
          || node.runIds.at(-1) !== runId
          || node.changeSetIds.at(-1) !== changeSetId) {
          throw new ProjectionError(
            `Evaluation ${evaluationId} does not match the latest produced ChangeSet.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        const headRevision = requireGitObjectId(
          payload.headRevision,
          'headRevision',
          event
        );
        if (headRevision !== changeSet.headRevision) {
          throw new ProjectionError(
            `Evaluation ${evaluationId} refers to another head revision.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        const profileHash = requireSha256(payload.profileHash, 'profileHash', event);
        const profileArtifact = requireArtifactRef(
          payload.profileArtifact,
          'profileArtifact',
          event
        );
        if (profileHash !== `sha256:${profileArtifact.digest}`) {
          throw new ProjectionError(
            `Evaluation ${evaluationId} profile hash does not match its artifact.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        const evaluator = requireEvaluator(payload.evaluator, 'evaluator', event);
        const contractId = requireNullableString(payload.contractId, 'contractId', event);
        const requiredCriteria = requireUniqueStringArray(
          payload.requiredCriteria,
          'requiredCriteria',
          event
        );
        if (requiredCriteria.length === 0) {
          throw new ProjectionError(
            `${event.type} must bind at least one required criterion.`,
            'invalid-event-payload',
            event
          );
        }
        if (typeof node.acceptance === 'string') {
          if (contractId !== node.acceptance) {
            throw new ProjectionError(
              `Evaluation ${evaluationId} does not bind node ${nodeId}'s acceptance contract.`,
              'evaluation-binding-mismatch',
              event
            );
          }
        } else {
          const expectedCriteria = [
            ...(node.acceptance?.commands ?? []),
            ...(node.acceptance?.checks ?? [])
          ];
          const allowedEvaluators = node.acceptance?.evaluators ?? [];
          if (contractId !== null
            || expectedCriteria.length !== requiredCriteria.length
            || expectedCriteria.some((criterionId, index) => (
              criterionId !== requiredCriteria[index]
            ))
            || (allowedEvaluators.length > 0
              && !allowedEvaluators.includes(evaluator.id))) {
            throw new ProjectionError(
              `Evaluation ${evaluationId} does not bind node ${nodeId}'s inline acceptance.`,
              'evaluation-binding-mismatch',
              event
            );
          }
        }
        evaluations.set(evaluationId, {
          id: evaluationId,
          nodeId,
          runId,
          changeSetId,
          headRevision,
          evaluator,
          contractId,
          requiredCriteria,
          profileHash,
          profileArtifact,
          status: EvaluationStatus.REQUESTED,
          workspaceRelativePath: requireEvaluationWorkspaceRelativePath(
            payload.workspaceRelativePath,
            'workspaceRelativePath',
            event
          ),
          workspacePath: null,
          workspaceStatus: 'not-created',
          workspaceDisposition: null,
          cleanupFailures: [],
          leaseId: null,
          evidenceId: null,
          result: null,
          failure: null,
          phase: null,
          requestedAt: event.occurredAt,
          startedAt: null,
          finishedAt: null,
          workspaceRemovedAt: null,
          startedSequence: null,
          terminalSequence: null,
          version: streamVersion
        });
        node.evaluationIds.push(evaluationId);
        node.activeEvaluationId = evaluationId;
        break;
      }
      case 'EvaluationExecutionStarted': {
        const payload = requireExactFields(event.payload, [
          'evaluationId',
          'headRevision',
          'leaseId',
          'workspacePath'
        ], 'payload', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        requireStream(event, `evaluation:${evaluationId}`);
        const evaluation = evaluations.get(evaluationId);
        if (!evaluation
          || requireGitObjectId(payload.headRevision, 'headRevision', event)
            !== evaluation.headRevision) {
          throw new ProjectionError(
            `Evaluation start does not match requested evaluation ${evaluationId}.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        evaluation.status = transitionEvaluation(
          evaluation.status,
          EvaluationStatus.RUNNING
        );
        evaluation.workspacePath = requireString(
          payload.workspacePath,
          'workspacePath',
          event
        );
        evaluation.workspaceStatus = 'present';
        evaluation.leaseId = requireString(payload.leaseId, 'leaseId', event);
        evaluation.startedAt = event.occurredAt;
        evaluation.startedSequence = event.sequence;
        evaluation.version = streamVersion;
        break;
      }
      case 'NodeEvaluationStarted': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'evaluationId', 'nodeId', 'runId'
        ], 'payload', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        const runId = requireString(payload.runId, 'runId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `node:${nodeId}`);
        const node = nodes.get(nodeId);
        const evaluation = evaluations.get(evaluationId);
        if (!node || !evaluation
          || evaluation.status !== EvaluationStatus.RUNNING
          || evaluation.startedSequence !== event.sequence - 1
          || node.status !== NodeStatus.PRODUCED
          || node.activeEvaluationId !== evaluationId
          || evaluation.nodeId !== nodeId
          || evaluation.runId !== runId
          || evaluation.changeSetId !== changeSetId
          || node.changeSetIds.at(-1) !== changeSetId) {
          throw new ProjectionError(
            `Node ${nodeId} cannot start evaluation ${evaluationId}.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        node.status = transitionNode(node.status, NodeStatus.EVALUATING);
        node.version = streamVersion;
        break;
      }
      case 'EvidenceRecorded': {
        const payload = requireExactFields(event.payload, [
          'changeSetId',
          'criteria',
          'environmentFingerprint',
          'evaluationId',
          'evaluator',
          'evidenceId',
          'headRevision',
          'kind',
          'nodeId',
          'policyViolations',
          'profileArtifact',
          'result',
          'resultArtifact',
          'runId'
        ], 'payload', event);
        const evidenceId = requireString(payload.evidenceId, 'evidenceId', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const runId = requireString(payload.runId, 'runId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `evidence:${evidenceId}`);
        if (evidence.has(evidenceId)) {
          throw new ProjectionError(
            `Evidence ${evidenceId} already exists.`,
            'evidence-already-exists',
            event
          );
        }
        const evaluation = evaluations.get(evaluationId);
        const node = nodes.get(nodeId);
        if (!evaluation || !node
          || evaluation.status !== EvaluationStatus.RUNNING
          || evaluation.evidenceId !== null
          || node.status !== NodeStatus.EVALUATING
          || node.activeEvaluationId !== evaluationId
          || evaluation.nodeId !== nodeId
          || evaluation.runId !== runId
          || evaluation.changeSetId !== changeSetId
          || requireGitObjectId(payload.headRevision, 'headRevision', event)
            !== evaluation.headRevision) {
          throw new ProjectionError(
            `Evidence ${evidenceId} does not match active evaluation ${evaluationId}.`,
            'evidence-binding-mismatch',
            event
          );
        }
        if (payload.kind !== 'command-evaluation') {
          throw new ProjectionError(
            `${event.type} has an invalid kind.`,
            'invalid-event-payload',
            event
          );
        }
        const evaluator = requireEvaluator(payload.evaluator, 'evaluator', event);
        const profileArtifact = requireArtifactRef(
          payload.profileArtifact,
          'profileArtifact',
          event
        );
        if (!sameEvaluator(evaluator, evaluation.evaluator)
          || !sameArtifactRef(profileArtifact, evaluation.profileArtifact)) {
          throw new ProjectionError(
            `Evidence ${evidenceId} uses a different evaluator profile.`,
            'evidence-binding-mismatch',
            event
          );
        }
        const criteria = requireArray(payload.criteria, 'criteria', event).map(
          (criterion, index) => requireCriterion(
            criterion,
            `criteria[${index}]`,
            event
          )
        );
        if (criteria.length === 0) {
          throw new ProjectionError(
            `${event.type} must contain at least one criterion.`,
            'invalid-event-payload',
            event
          );
        }
        const criterionIds = new Set();
        for (const criterion of criteria) {
          if (criterionIds.has(criterion.id)) {
            throw new ProjectionError(
              `${event.type} has duplicate criterion ${criterion.id}.`,
              'invalid-event-payload',
              event
            );
          }
          criterionIds.add(criterion.id);
        }
        const policyViolations = requireArray(
          payload.policyViolations,
          'policyViolations',
          event
        ).map((violation, index) => requirePolicyViolation(
          violation,
          `policyViolations[${index}]`,
          event
        ));
        const result = requireString(payload.result, 'result', event);
        if (!['pass', 'fail'].includes(result)) {
          throw new ProjectionError(
            `${event.type} has an invalid result.`,
            'invalid-event-payload',
            event
          );
        }
        const derivedResult = criteria.every((criterion) => criterion.result === 'pass')
          && policyViolations.length === 0
          ? 'pass'
          : 'fail';
        if (result !== derivedResult) {
          throw new ProjectionError(
            `${event.type} result contradicts its criteria or policy violations.`,
            'invalid-event-payload',
            event
          );
        }
        const criterionIdSet = new Set(criteria.map((criterion) => criterion.id));
        if (criterionIdSet.size !== evaluation.requiredCriteria.length
          || evaluation.requiredCriteria.some((criterionId) => (
            !criterionIdSet.has(criterionId)
          ))) {
          throw new ProjectionError(
            `${event.type} evidence does not exactly cover its acceptance criteria.`,
            'evidence-binding-mismatch',
            event
          );
        }
        const record = {
          id: evidenceId,
          evaluationId,
          nodeId,
          runId,
          changeSetId,
          headRevision: evaluation.headRevision,
          kind: 'command-evaluation',
          result,
          evaluator,
          profileArtifact,
          resultArtifact: requireArtifactRef(
            payload.resultArtifact,
            'resultArtifact',
            event
          ),
          environmentFingerprint: requireEnvironmentFingerprint(
            payload.environmentFingerprint,
            'environmentFingerprint',
            event
          ),
          criteria,
          policyViolations,
          recordedAt: event.occurredAt,
          recordedSequence: event.sequence,
          version: streamVersion
        };
        evidence.set(evidenceId, record);
        evaluation.evidenceId = evidenceId;
        break;
      }
      case 'EvaluationPassed':
      case 'EvaluationRejected': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'evaluationId', 'evidenceId', 'nodeId', 'runId'
        ], 'payload', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        const evidenceId = requireString(payload.evidenceId, 'evidenceId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const runId = requireString(payload.runId, 'runId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `evaluation:${evaluationId}`);
        const evaluation = evaluations.get(evaluationId);
        const record = evidence.get(evidenceId);
        const expectedResult = event.type === 'EvaluationPassed' ? 'pass' : 'fail';
        const targetStatus = event.type === 'EvaluationPassed'
          ? EvaluationStatus.PASSED
          : EvaluationStatus.REJECTED;
        if (!evaluation || !record
          || evaluation.status !== EvaluationStatus.RUNNING
          || evaluation.evidenceId !== evidenceId
          || record.recordedSequence !== event.sequence - 1
          || record.result !== expectedResult
          || evaluation.nodeId !== nodeId
          || evaluation.runId !== runId
          || evaluation.changeSetId !== changeSetId
          || record.nodeId !== nodeId
          || record.runId !== runId
          || record.changeSetId !== changeSetId) {
          throw new ProjectionError(
            `${event.type} does not match evidence ${evidenceId}.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        evaluation.status = transitionEvaluation(evaluation.status, targetStatus);
        evaluation.result = expectedResult;
        evaluation.finishedAt = event.occurredAt;
        evaluation.workspaceStatus = 'cleanup-pending';
        evaluation.terminalSequence = event.sequence;
        evaluation.version = streamVersion;
        break;
      }
      case 'NodeAccepted':
      case 'NodeRejected': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'evaluationId', 'evidenceId', 'nodeId', 'runId'
        ], 'payload', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        const evidenceId = requireString(payload.evidenceId, 'evidenceId', event);
        const runId = requireString(payload.runId, 'runId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `node:${nodeId}`);
        const node = nodes.get(nodeId);
        const evaluation = evaluations.get(evaluationId);
        const record = evidence.get(evidenceId);
        const accepted = event.type === 'NodeAccepted';
        const expectedEvaluationStatus = accepted
          ? EvaluationStatus.PASSED
          : EvaluationStatus.REJECTED;
        const expectedEvidenceResult = accepted ? 'pass' : 'fail';
        if (!node || !evaluation || !record
          || node.status !== NodeStatus.EVALUATING
          || node.activeEvaluationId !== evaluationId
          || evaluation.status !== expectedEvaluationStatus
          || evaluation.terminalSequence !== event.sequence - 1
          || evaluation.evidenceId !== evidenceId
          || record.result !== expectedEvidenceResult
          || evaluation.nodeId !== nodeId
          || evaluation.runId !== runId
          || evaluation.changeSetId !== changeSetId
          || record.nodeId !== nodeId
          || record.runId !== runId
          || record.changeSetId !== changeSetId
          || node.changeSetIds.at(-1) !== changeSetId
          || (accepted && record.policyViolations.length !== 0)) {
          throw new ProjectionError(
            `${event.type} does not match terminal evaluation ${evaluationId}.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        node.status = transitionNode(
          node.status,
          accepted ? NodeStatus.ACCEPTED : NodeStatus.REJECTED
        );
        node.activeEvaluationId = null;
        node.acceptedChangeSetId = accepted ? changeSetId : null;
        node.acceptanceEvidenceIds = accepted ? [evidenceId] : [];
        node.version = streamVersion;
        break;
      }
      case 'IntegrationRequested': {
        const rawPayload = requireObject(event.payload, 'payload', event);
        const requestedStrategy = requireString(rawPayload.strategy, 'strategy', event);
        const payload = requireExactFields(event.payload, [
          'baseRevision',
          'changeSetId',
          'evaluationId',
          'evidenceId',
          'expectedTargetRevision',
          'headRevision',
          'integrationId',
          'nodeId',
          'runId',
          'strategy',
          'targetRef',
          ...(requestedStrategy === 'merge-commit-regression-gated'
            ? ['regressionProfileHash']
            : [])
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const runId = requireString(payload.runId, 'runId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        const evidenceId = requireString(payload.evidenceId, 'evidenceId', event);
        requireStream(event, `integration:${integrationId}`);
        if (integrations.has(integrationId)) {
          throw new ProjectionError(
            `Integration ${integrationId} already exists.`,
            'integration-already-exists',
            event
          );
        }
        if ([...runs.values()].some((candidate) => [
          RunStatus.PENDING,
          RunStatus.RUNNING,
          RunStatus.PAUSED
        ].includes(candidate.status))
          || [...evaluations.values()].some((candidate) => [
            EvaluationStatus.REQUESTED,
            EvaluationStatus.RUNNING,
            EvaluationStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))
          || [...integrations.values()].some((candidate) => [
            IntegrationStatus.PENDING,
            IntegrationStatus.RUNNING,
            IntegrationStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))
          || [...reversions.values()].some((candidate) => [
            ReversionStatus.PENDING,
            ReversionStatus.RUNNING,
            ReversionStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))) {
          throw new ProjectionError(
            'A serial FWA project cannot start an Integration while another operation is active.',
            'active-project-operation-exists',
            event
          );
        }

        const node = nodes.get(nodeId);
        const run = runs.get(runId);
        const changeSet = changeSets.get(changeSetId);
        const evaluation = evaluations.get(evaluationId);
        const record = evidence.get(evidenceId);
        const goal = goals.get(node?.goalId);
        if (!node || !run || !changeSet || !evaluation || !record || !goal
          || node.status !== NodeStatus.ACCEPTED
          || node.validity !== Validity.VALID
          || node.activeIntegrationId !== null
          || node.integratedChangeSetId !== null
          || ![
            null,
            IntegrationStatus.FAILED,
            IntegrationStatus.CONFLICTED
          ].includes(node.integrationStatus)
          || node.acceptedChangeSetId !== changeSetId
          || node.acceptanceEvidenceIds.length !== 1
          || node.acceptanceEvidenceIds[0] !== evidenceId
          || node.runIds.at(-1) !== runId
          || node.changeSetIds.at(-1) !== changeSetId
          || run.status !== RunStatus.PRODUCED
          || run.nodeId !== nodeId
          || run.changeSetId !== changeSetId
          || changeSet.nodeId !== nodeId
          || changeSet.runId !== runId
          || !changeSet.valid
          || evaluation.status !== EvaluationStatus.PASSED
          || evaluation.nodeId !== nodeId
          || evaluation.runId !== runId
          || evaluation.changeSetId !== changeSetId
          || evaluation.evidenceId !== evidenceId
          || record.result !== 'pass'
          || record.policyViolations.length !== 0
          || record.nodeId !== nodeId
          || record.runId !== runId
          || record.changeSetId !== changeSetId
          || record.evaluationId !== evaluationId
          || goal.status !== GoalStatus.ACTIVE) {
          throw new ProjectionError(
            `Integration ${integrationId} does not bind one accepted, valid ChangeSet.`,
            'integration-binding-mismatch',
            event
          );
        }
        const baseRevision = requireGitObjectId(
          payload.baseRevision,
          'baseRevision',
          event
        );
        const headRevision = requireGitObjectId(
          payload.headRevision,
          'headRevision',
          event
        );
        const expectedTargetRevision = requireGitObjectId(
          payload.expectedTargetRevision,
          'expectedTargetRevision',
          event
        );
        const targetRef = requireTargetRef(payload.targetRef, 'targetRef', event);
        const strategy = requireString(payload.strategy, 'strategy', event);
        const previousProjectRevision = projectRevisions.findLast(
          (candidate) => candidate.targetRef === targetRef
        );
        const regressionProfileHash = strategy === 'merge-commit-regression-gated'
          ? requireSha256(payload.regressionProfileHash, 'regressionProfileHash', event)
          : null;
        const strategyMatches = strategy === 'exact-base-single-commit'
          ? expectedTargetRevision === baseRevision
          : strategy === 'merge-commit-regression-gated'
            && expectedTargetRevision === (previousProjectRevision?.revision ?? baseRevision);
        if (!strategyMatches
          || baseRevision !== changeSet.baseRevision
          || headRevision !== changeSet.headRevision) {
          throw new ProjectionError(
            `Integration ${integrationId} has an invalid strategy or revision binding.`,
            'integration-binding-mismatch',
            event
          );
        }
        if (previousProjectRevision !== undefined
          && previousProjectRevision.revision !== expectedTargetRevision) {
          throw new ProjectionError(
            `Integration ${integrationId} skipped an unrecorded revision on ${targetRef}.`,
            'integration-project-revision-mismatch',
            event
          );
        }
        if (goal.integrationTargetRef !== null && goal.integrationTargetRef !== targetRef) {
          throw new ProjectionError(
            `Goal ${goal.id} is already bound to ${goal.integrationTargetRef}.`,
            'integration-goal-target-mismatch',
            event
          );
        }
        integrations.set(integrationId, {
          id: integrationId,
          nodeId,
          goalId: node.goalId,
          planId: node.planId,
          runId,
          changeSetId,
          evaluationId,
          evidenceId,
          baseRevision,
          headRevision,
          targetRef,
          expectedTargetRevision,
          strategy,
          regressionProfileHash,
          regressionEvidence: null,
          status: IntegrationStatus.PENDING,
          leaseId: null,
          candidateRevision: null,
          candidateTree: null,
          candidateParents: [],
          candidateRef: null,
          candidateWorkspacePath: null,
          changedFiles: [],
          changes: [],
          changedRefIds: [],
          patchArtifact: null,
          executionArtifact: null,
          conflicts: [],
          integratedRevision: null,
          failure: null,
          recoveryFailure: null,
          phase: null,
          requestedAt: event.occurredAt,
          startedAt: null,
          preparedAt: null,
          integratedAt: null,
          failedAt: null,
          requestedSequence: event.sequence,
          nodeRequestedSequence: null,
          startedSequence: null,
          nodeStartedSequence: null,
          preparedSequence: null,
          projectRevisionSequence: null,
          appliedSequence: null,
          nodeTerminalSequence: null,
          terminalFromStatus: null,
          affectedNodeIds: [],
          recomputeRootNodeIds: [],
          reopenedGoalIds: [],
          advancedRefIds: [],
          effectsAppliedSequence: null,
          reversionIds: [],
          activeReversionId: null,
          revertedByReversionId: null,
          revertedByChangeSetId: null,
          revertedAt: null,
          version: streamVersion
        });
        break;
      }
      case 'NodeIntegrationRequested': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'integrationId', 'nodeId'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `node:${nodeId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        if (!integration || !node
          || integration.status !== IntegrationStatus.PENDING
          || integration.requestedSequence !== event.sequence - 1
          || integration.nodeRequestedSequence !== null
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || node.status !== NodeStatus.ACCEPTED
          || node.validity !== Validity.VALID
          || node.activeIntegrationId !== null) {
          throw new ProjectionError(
            `${event.type} does not immediately pair with Integration ${integrationId}.`,
            'integration-binding-mismatch',
            event
          );
        }
        node.integrationIds.push(integrationId);
        node.activeIntegrationId = integrationId;
        node.integrationStatus = IntegrationStatus.PENDING;
        node.version = streamVersion;
        integration.nodeRequestedSequence = event.sequence;
        break;
      }
      case 'IntegrationExecutionStarted': {
        const payload = requireExactFields(event.payload, [
          'integrationId', 'leaseId'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(integration?.nodeId);
        if (!integration || !node
          || integration.status !== IntegrationStatus.PENDING
          || integration.nodeRequestedSequence === null
          || integration.startedSequence !== null
          || node.status !== NodeStatus.ACCEPTED
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== IntegrationStatus.PENDING) {
          throw new ProjectionError(
            `Integration ${integrationId} cannot start.`,
            'integration-not-pending',
            event
          );
        }
        integration.status = transitionIntegration(
          integration.status,
          IntegrationStatus.RUNNING
        );
        integration.leaseId = requireString(payload.leaseId, 'leaseId', event);
        integration.startedAt = event.occurredAt;
        integration.startedSequence = event.sequence;
        integration.version = streamVersion;
        break;
      }
      case 'NodeIntegrationStarted': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'integrationId', 'nodeId'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `node:${nodeId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        if (!integration || !node
          || integration.status !== IntegrationStatus.RUNNING
          || integration.startedSequence !== event.sequence - 1
          || integration.nodeStartedSequence !== null
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || node.status !== NodeStatus.ACCEPTED
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== IntegrationStatus.PENDING) {
          throw new ProjectionError(
            `${event.type} does not immediately pair with Integration ${integrationId}.`,
            'integration-binding-mismatch',
            event
          );
        }
        node.integrationStatus = IntegrationStatus.RUNNING;
        node.version = streamVersion;
        integration.nodeStartedSequence = event.sequence;
        break;
      }
      case 'IntegrationPrepared': {
        const payload = requireExactFields(event.payload, [
          'candidateRevision', 'candidateTree', 'integrationId'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(integration?.nodeId);
        const sourceChangeSet = changeSets.get(integration?.changeSetId);
        if (!integration || !node || !sourceChangeSet
          || integration.status !== IntegrationStatus.RUNNING
          || integration.nodeStartedSequence === null
          || integration.preparedSequence !== null
          || integration.candidateRevision !== null
          || integration.candidateTree !== null
          || node.status !== NodeStatus.ACCEPTED
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== IntegrationStatus.RUNNING) {
          throw new ProjectionError(
            `Integration ${integrationId} cannot record another candidate.`,
            'integration-not-running',
            event
          );
        }
        integration.candidateRevision = requireGitObjectId(
          payload.candidateRevision,
          'candidateRevision',
          event
        );
        integration.candidateTree = requireGitObjectId(
          payload.candidateTree,
          'candidateTree',
          event
        );
        integration.candidateParents = [integration.expectedTargetRevision];
        integration.candidateRef = `refs/fwa/integrations/${integrationId}/candidate`;
        integration.preparedAt = event.occurredAt;
        integration.preparedSequence = event.sequence;
        integration.version = streamVersion;
        break;
      }
      case 'IntegrationMergePrepared': {
        const payload = requireExactFields(event.payload, [
          'candidateRef',
          'candidateRevision',
          'candidateTree',
          'changedFiles',
          'changedRefIds',
          'changes',
          'executionArtifact',
          'integrationId',
          'parents',
          'patchArtifact',
          'workspacePath'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(integration?.nodeId);
        const sourceChangeSet = changeSets.get(integration?.changeSetId);
        const parents = requireUniqueStringArray(payload.parents, 'parents', event).map(
          (parent, index) => requireGitObjectId(parent, `parents[${index}]`, event)
        );
        if (!integration || !node || !sourceChangeSet
          || integration.status !== IntegrationStatus.RUNNING
          || integration.strategy !== 'merge-commit-regression-gated'
          || integration.nodeStartedSequence === null
          || integration.preparedSequence !== null
          || integration.candidateRevision !== null
          || parents.length !== 2
          || parents[0] !== integration.expectedTargetRevision
          || parents[1] !== integration.headRevision
          || node.status !== NodeStatus.ACCEPTED
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== IntegrationStatus.RUNNING) {
          throw new ProjectionError(
            `Integration ${integrationId} cannot record this merge candidate.`,
            'integration-not-running',
            event
          );
        }
        const changedFiles = requireUniqueStringArray(
          payload.changedFiles,
          'changedFiles',
          event
        ).map((file, index) => requireWorkspacePath(
          file,
          `changedFiles[${index}]`,
          event
        ));
        if (changedFiles.length === 0
          || JSON.stringify(changedFiles) !== JSON.stringify(
            [...changedFiles].sort((left, right) => left.localeCompare(right, 'en'))
          )) {
          throw new ProjectionError(
            `${event.type} changedFiles must be sorted.`,
            'invalid-event-payload',
            event
          );
        }
        const changes = requireArray(payload.changes, 'changes', event).map((value, index) => {
          const change = requireObject(value, `changes[${index}]`, event);
          const normalized = {
            ...change,
            status: requireString(change.status, `changes[${index}].status`, event),
            path: requireWorkspacePath(change.path, `changes[${index}].path`, event)
          };
          if (change.previousPath !== undefined) {
            normalized.previousPath = requireWorkspacePath(
              change.previousPath,
              `changes[${index}].previousPath`,
              event
            );
          }
          if (change.renamedTo !== undefined) {
            normalized.renamedTo = requireWorkspacePath(
              change.renamedTo,
              `changes[${index}].renamedTo`,
              event
            );
          }
          return normalized;
        });
        const filesFromChanges = [...new Set(changes.flatMap((change) => [
          change.path,
          ...(change.previousPath === undefined ? [] : [change.previousPath])
        ]))].sort((left, right) => left.localeCompare(right, 'en'));
        if (JSON.stringify(filesFromChanges) !== JSON.stringify(changedFiles)) {
          throw new ProjectionError(
            `${event.type} changes and changedFiles disagree.`,
            'invalid-event-payload',
            event
          );
        }
        const changedRefIds = requireUniqueStringArray(
          payload.changedRefIds,
          'changedRefIds',
          event
        );
        if (JSON.stringify(changedRefIds) !== JSON.stringify(
          candidateChangedRefIds(refs, changedFiles, {
            ignoreCase: sourceChangeSet.coreIgnoreCase
          })
        )) {
          throw new ProjectionError(
            `${event.type} changedRefIds do not match its candidate files.`,
            'integration-ref-binding-mismatch',
            event
          );
        }
        integration.candidateRevision = requireGitObjectId(
          payload.candidateRevision,
          'candidateRevision',
          event
        );
        integration.candidateTree = requireGitObjectId(
          payload.candidateTree,
          'candidateTree',
          event
        );
        integration.candidateParents = parents;
        integration.candidateRef = requireString(payload.candidateRef, 'candidateRef', event);
        integration.candidateWorkspacePath = requireString(
          payload.workspacePath,
          'workspacePath',
          event
        );
        integration.changedFiles = changedFiles;
        integration.changes = changes;
        integration.changedRefIds = changedRefIds;
        integration.patchArtifact = requireArtifactRef(
          payload.patchArtifact,
          'patchArtifact',
          event
        );
        integration.executionArtifact = requireArtifactRef(
          payload.executionArtifact,
          'executionArtifact',
          event
        );
        if (integration.patchArtifact.size === 0 || integration.executionArtifact.size === 0) {
          throw new ProjectionError(
            `${event.type} candidate artifacts must be non-empty.`,
            'invalid-event-payload',
            event
          );
        }
        integration.preparedAt = event.occurredAt;
        integration.preparedSequence = event.sequence;
        integration.version = streamVersion;
        break;
      }
      case 'IntegrationRegressionRecorded': {
        const payload = requireExactFields(
          event.payload,
          ['evidence', 'integrationId'],
          'payload',
          event
        );
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        if (!integration
          || integration.status !== IntegrationStatus.RUNNING
          || integration.strategy !== 'merge-commit-regression-gated'
          || integration.preparedSequence === null
          || integration.regressionEvidence !== null) {
          throw new ProjectionError(
            `Integration ${integrationId} has invalid regression Evidence.`,
            'integration-regression-binding-mismatch',
            event
          );
        }
        const evidence = requireRegressionEvidence(payload.evidence, 'evidence', event, {
          ownerId: integrationId,
          candidateRevision: integration.candidateRevision,
          regressionProfileHash: integration.regressionProfileHash
        });
        integration.regressionEvidence = evidence;
        integration.version = streamVersion;
        break;
      }
      case 'IntegrationConflicted': {
        const payload = requireExactFields(event.payload, [
          'candidateRef',
          'changeSetId',
          'conflicts',
          'integrationId',
          'nodeId',
          'workspacePath'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        if (!integration || !node
          || integration.status !== IntegrationStatus.RUNNING
          || integration.strategy !== 'merge-commit-regression-gated'
          || integration.candidateRevision !== null
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== IntegrationStatus.RUNNING) {
          throw new ProjectionError(
            `Integration ${integrationId} cannot enter conflicted state.`,
            'integration-binding-mismatch',
            event
          );
        }
        integration.terminalFromStatus = integration.status;
        integration.status = transitionIntegration(
          integration.status,
          IntegrationStatus.CONFLICTED
        );
        integration.phase = 'physical-conflict';
        integration.failure = {
          code: 'PHYSICAL_CONFLICT',
          message: 'Git reported physical merge conflicts.',
          details: null
        };
        integration.candidateRef = requireString(payload.candidateRef, 'candidateRef', event);
        integration.candidateWorkspacePath = requireString(
          payload.workspacePath,
          'workspacePath',
          event
        );
        integration.conflicts = requirePhysicalConflicts(
          payload.conflicts,
          'conflicts',
          event
        );
        integration.failedAt = event.occurredAt;
        integration.appliedSequence = event.sequence;
        integration.version = streamVersion;
        break;
      }
      case 'NodeIntegrationConflicted': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'integrationId', 'nodeId'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `node:${nodeId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        if (!integration || !node
          || integration.status !== IntegrationStatus.CONFLICTED
          || integration.appliedSequence !== event.sequence - 1
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== IntegrationStatus.RUNNING) {
          throw new ProjectionError(
            `${event.type} does not immediately pair with Integration ${integrationId}.`,
            'integration-binding-mismatch',
            event
          );
        }
        node.activeIntegrationId = null;
        node.integrationStatus = IntegrationStatus.CONFLICTED;
        node.version = streamVersion;
        integration.nodeTerminalSequence = event.sequence;
        break;
      }
      case 'ReversionRequested': {
        const payload = requireExactFields(event.payload, [
          'changeSetId',
          'expectedTargetRevision',
          'goalId',
          'integrationId',
          'nodeId',
          'regressionProfileHash',
          'revertedRevision',
          'reversionId',
          'targetRef'
        ], 'payload', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const goalId = requireString(payload.goalId, 'goalId', event);
        requireStream(event, `reversion:${reversionId}`);
        if ([...runs.values()].some((candidate) => [
          RunStatus.PENDING,
          RunStatus.RUNNING,
          RunStatus.PAUSED
        ].includes(candidate.status))
          || [...evaluations.values()].some((candidate) => [
            EvaluationStatus.REQUESTED,
            EvaluationStatus.RUNNING,
            EvaluationStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))
          || [...integrations.values()].some((candidate) => [
            IntegrationStatus.PENDING,
            IntegrationStatus.RUNNING,
            IntegrationStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))
          || [...reversions.values()].some((candidate) => [
            ReversionStatus.PENDING,
            ReversionStatus.RUNNING,
            ReversionStatus.RECOVERY_REQUIRED
          ].includes(candidate.status))) {
          throw new ProjectionError(
            'A serial FWA project cannot start a Reversion while another operation is active.',
            'active-project-operation-exists',
            event
          );
        }
        const integration = integrations.get(integrationId);
        const changeSet = changeSets.get(changeSetId);
        const node = nodes.get(nodeId);
        const goal = goals.get(goalId);
        const targetRef = requireTargetRef(payload.targetRef, 'targetRef', event);
        const expectedTargetRevision = requireGitObjectId(
          payload.expectedTargetRevision,
          'expectedTargetRevision',
          event
        );
        const revertedRevision = requireGitObjectId(
          payload.revertedRevision,
          'revertedRevision',
          event
        );
        const latestProjectRevision = projectRevisions.findLast(
          (candidate) => candidate.targetRef === targetRef
        );
        if (reversions.has(reversionId)
          || !integration
          || !changeSet
          || !node
          || !goal
          || integration.status !== IntegrationStatus.INTEGRATED
          || integration.activeReversionId !== null
          || integration.changeSetId !== changeSetId
          || integration.nodeId !== nodeId
          || integration.goalId !== goalId
          || integration.targetRef !== targetRef
          || integration.integratedRevision !== revertedRevision
          || changeSet.kind !== 'execution'
          || changeSet.revertedByReversionId !== null
          || node.integrationStatus !== IntegrationStatus.INTEGRATED
          || node.integratedChangeSetId !== changeSetId
          || node.integratedRevision !== revertedRevision
          || node.integratedTargetRef !== targetRef
          || node.validity !== Validity.VALID
          || latestProjectRevision?.revision !== expectedTargetRevision) {
          throw new ProjectionError(
            `Reversion ${reversionId} does not target the currently integrated ChangeSet.`,
            'reversion-binding-mismatch',
            event
          );
        }
        reversions.set(reversionId, {
          id: reversionId,
          integrationId,
          sourceChangeSetId: changeSetId,
          nodeId,
          goalId,
          targetRef,
          expectedTargetRevision,
          revertedRevision,
          regressionProfileHash: requireSha256(
            payload.regressionProfileHash,
            'regressionProfileHash',
            event
          ),
          regressionEvidence: null,
          status: ReversionStatus.PENDING,
          leaseId: null,
          candidateRevision: null,
          candidateTree: null,
          candidateParents: [],
          candidateRef: null,
          candidateWorkspacePath: null,
          changedFiles: [],
          changes: [],
          changedRefIds: [],
          affectedNodeIds: [],
          recomputeRootNodeIds: [],
          reopenedGoalIds: [],
          revertedRefIds: [],
          patchArtifact: null,
          executionArtifact: null,
          revertChangeSetId: null,
          conflicts: [],
          failure: null,
          phase: null,
          requestedAt: event.occurredAt,
          startedAt: null,
          preparedAt: null,
          revertedAt: null,
          requestedSequence: event.sequence,
          integrationRequestedSequence: null,
          startedSequence: null,
          preparedSequence: null,
          regressionSequence: null,
          changeSetSequence: null,
          projectRevisionSequence: null,
          terminalSequence: null,
          integrationReleaseSequence: null,
          version: streamVersion
        });
        break;
      }
      case 'IntegrationReversionRequested': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'integrationId', 'reversionId'
        ], 'payload', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `integration:${integrationId}`);
        const reversion = reversions.get(reversionId);
        const integration = integrations.get(integrationId);
        if (!reversion
          || !integration
          || reversion.requestedSequence !== event.sequence - 1
          || reversion.integrationRequestedSequence !== null
          || reversion.integrationId !== integrationId
          || reversion.sourceChangeSetId !== changeSetId
          || integration.status !== IntegrationStatus.INTEGRATED
          || integration.activeReversionId !== null) {
          throw new ProjectionError(
            `${event.type} does not immediately pair with Reversion ${reversionId}.`,
            'reversion-binding-mismatch',
            event
          );
        }
        integration.reversionIds.push(reversionId);
        integration.activeReversionId = reversionId;
        integration.version = streamVersion;
        reversion.integrationRequestedSequence = event.sequence;
        break;
      }
      case 'ReversionStarted': {
        const payload = requireExactFields(
          event.payload,
          ['leaseId', 'reversionId'],
          'payload',
          event
        );
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `reversion:${reversionId}`);
        const reversion = reversions.get(reversionId);
        if (!reversion
          || reversion.status !== ReversionStatus.PENDING
          || reversion.integrationRequestedSequence === null) {
          throw new ProjectionError(
            `Reversion ${reversionId} cannot start.`,
            'reversion-not-pending',
            event
          );
        }
        reversion.status = transitionReversion(
          reversion.status,
          ReversionStatus.RUNNING
        );
        reversion.leaseId = requireString(payload.leaseId, 'leaseId', event);
        reversion.startedAt = event.occurredAt;
        reversion.startedSequence = event.sequence;
        reversion.version = streamVersion;
        break;
      }
      case 'ReversionPrepared': {
        const payload = requireExactFields(event.payload, [
          'candidateRef',
          'candidateRevision',
          'candidateTree',
          'changedFiles',
          'changedRefIds',
          'changes',
          'executionArtifact',
          'parents',
          'patchArtifact',
          'reversionId',
          'workspacePath'
        ], 'payload', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `reversion:${reversionId}`);
        const reversion = reversions.get(reversionId);
        const sourceChangeSet = changeSets.get(reversion?.sourceChangeSetId);
        const parents = requireUniqueStringArray(payload.parents, 'parents', event).map(
          (parent, index) => requireGitObjectId(parent, `parents[${index}]`, event)
        );
        if (!reversion
          || !sourceChangeSet
          || reversion.status !== ReversionStatus.RUNNING
          || reversion.preparedSequence !== null
          || parents.length !== 1
          || parents[0] !== reversion.expectedTargetRevision) {
          throw new ProjectionError(
            `Reversion ${reversionId} cannot record this candidate.`,
            'reversion-not-running',
            event
          );
        }
        const changedFiles = requireUniqueStringArray(
          payload.changedFiles,
          'changedFiles',
          event
        ).map((file, index) => requireWorkspacePath(
          file,
          `changedFiles[${index}]`,
          event
        ));
        if (JSON.stringify(changedFiles) !== JSON.stringify(
          [...changedFiles].sort((left, right) => left.localeCompare(right, 'en'))
        )) {
          throw new ProjectionError(
            `${event.type} changedFiles must be sorted.`,
            'invalid-event-payload',
            event
          );
        }
        if (changedFiles.length === 0
          || JSON.stringify(changedFiles) !== JSON.stringify(
            [...changedFiles].sort((left, right) => left.localeCompare(right, 'en'))
          )) {
          throw new ProjectionError(
            `${event.type} changedFiles must be non-empty and sorted.`,
            'invalid-event-payload',
            event
          );
        }
        const changes = requireArray(payload.changes, 'changes', event).map((value, index) => {
          const change = requireObject(value, `changes[${index}]`, event);
          const normalized = {
            ...change,
            status: requireString(change.status, `changes[${index}].status`, event),
            path: requireWorkspacePath(change.path, `changes[${index}].path`, event)
          };
          if (change.previousPath !== undefined) {
            normalized.previousPath = requireWorkspacePath(
              change.previousPath,
              `changes[${index}].previousPath`,
              event
            );
          }
          if (change.renamedTo !== undefined) {
            normalized.renamedTo = requireWorkspacePath(
              change.renamedTo,
              `changes[${index}].renamedTo`,
              event
            );
          }
          return normalized;
        });
        const filesFromChanges = [...new Set(changes.flatMap((change) => [
          change.path,
          ...(change.previousPath === undefined ? [] : [change.previousPath])
        ]))].sort((left, right) => left.localeCompare(right, 'en'));
        if (JSON.stringify(filesFromChanges) !== JSON.stringify(changedFiles)) {
          throw new ProjectionError(
            `${event.type} changes and changedFiles disagree.`,
            'invalid-event-payload',
            event
          );
        }
        const changedRefIds = requireUniqueStringArray(
          payload.changedRefIds,
          'changedRefIds',
          event
        );
        if (JSON.stringify(changedRefIds) !== JSON.stringify(
          candidateChangedRefIds(refs, changedFiles, {
            ignoreCase: sourceChangeSet.coreIgnoreCase
          })
        )) {
          throw new ProjectionError(
            `${event.type} changedRefIds do not match its candidate files.`,
            'reversion-ref-binding-mismatch',
            event
          );
        }
        reversion.candidateRevision = requireGitObjectId(
          payload.candidateRevision,
          'candidateRevision',
          event
        );
        reversion.candidateTree = requireGitObjectId(
          payload.candidateTree,
          'candidateTree',
          event
        );
        reversion.candidateParents = parents;
        reversion.candidateRef = requireString(payload.candidateRef, 'candidateRef', event);
        reversion.candidateWorkspacePath = requireString(
          payload.workspacePath,
          'workspacePath',
          event
        );
        reversion.changedFiles = changedFiles;
        reversion.changes = changes;
        reversion.changedRefIds = changedRefIds;
        reversion.patchArtifact = requireArtifactRef(
          payload.patchArtifact,
          'patchArtifact',
          event
        );
        reversion.executionArtifact = requireArtifactRef(
          payload.executionArtifact,
          'executionArtifact',
          event
        );
        if (reversion.patchArtifact.size === 0 || reversion.executionArtifact.size === 0) {
          throw new ProjectionError(
            `${event.type} candidate artifacts must be non-empty.`,
            'invalid-event-payload',
            event
          );
        }
        reversion.preparedAt = event.occurredAt;
        reversion.preparedSequence = event.sequence;
        reversion.version = streamVersion;
        break;
      }
      case 'ReversionRegressionRecorded': {
        const payload = requireExactFields(
          event.payload,
          ['evidence', 'reversionId'],
          'payload',
          event
        );
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `reversion:${reversionId}`);
        const reversion = reversions.get(reversionId);
        if (!reversion
          || reversion.status !== ReversionStatus.RUNNING
          || reversion.preparedSequence === null
          || reversion.regressionEvidence !== null) {
          throw new ProjectionError(
            `Reversion ${reversionId} has invalid regression Evidence.`,
            'reversion-regression-binding-mismatch',
            event
          );
        }
        const evidence = requireRegressionEvidence(payload.evidence, 'evidence', event, {
          ownerId: reversionId,
          candidateRevision: reversion.candidateRevision,
          regressionProfileHash: reversion.regressionProfileHash
        });
        reversion.regressionEvidence = evidence;
        reversion.regressionSequence = event.sequence;
        reversion.version = streamVersion;
        break;
      }
      case 'ReversionConflicted': {
        const payload = requireExactFields(event.payload, [
          'candidateRef', 'conflicts', 'reversionId', 'workspacePath'
        ], 'payload', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `reversion:${reversionId}`);
        const reversion = reversions.get(reversionId);
        const integration = integrations.get(reversion?.integrationId);
        const candidateRef = requireString(payload.candidateRef, 'candidateRef', event);
        if (!reversion
          || !integration
          || reversion.status !== ReversionStatus.RUNNING
          || reversion.candidateRevision !== null
          || candidateRef !== `refs/fwa/integrations/${reversionId}/candidate`
          || integration.activeReversionId !== reversionId) {
          throw new ProjectionError(
            `Reversion ${reversionId} cannot enter conflicted state.`,
            'reversion-binding-mismatch',
            event
          );
        }
        reversion.status = transitionReversion(
          reversion.status,
          ReversionStatus.CONFLICTED
        );
        reversion.candidateRef = candidateRef;
        reversion.candidateWorkspacePath = requireString(
          payload.workspacePath,
          'workspacePath',
          event
        );
        reversion.conflicts = requirePhysicalConflicts(
          payload.conflicts,
          'conflicts',
          event
        );
        reversion.failure = {
          code: 'PHYSICAL_CONFLICT',
          message: 'Git reported physical revert conflicts.',
          details: null
        };
        reversion.phase = 'physical-conflict';
        reversion.terminalSequence = event.sequence;
        reversion.version = streamVersion;
        break;
      }
      case 'ReversionFailed': {
        const payload = requireExactFields(
          event.payload,
          ['failure', 'phase', 'reversionId'],
          'payload',
          event
        );
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `reversion:${reversionId}`);
        const reversion = reversions.get(reversionId);
        const integration = integrations.get(reversion?.integrationId);
        if (!reversion
          || !integration
          || ![ReversionStatus.PENDING, ReversionStatus.RUNNING,
            ReversionStatus.RECOVERY_REQUIRED].includes(reversion.status)
          || integration.activeReversionId !== reversionId) {
          throw new ProjectionError(
            `Reversion ${reversionId} cannot fail from its current state.`,
            'reversion-binding-mismatch',
            event
          );
        }
        reversion.status = transitionReversion(reversion.status, ReversionStatus.FAILED);
        reversion.failure = requireFailure(payload.failure, 'failure', event);
        reversion.phase = requireString(payload.phase, 'phase', event);
        reversion.terminalSequence = event.sequence;
        reversion.version = streamVersion;
        break;
      }
      case 'ReversionRecoveryRequired': {
        const payload = requireExactFields(
          event.payload,
          ['failure', 'phase', 'reversionId'],
          'payload',
          event
        );
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `reversion:${reversionId}`);
        const reversion = reversions.get(reversionId);
        if (!reversion
          || reversion.status !== ReversionStatus.RUNNING
          || reversion.preparedSequence === null) {
          throw new ProjectionError(
            `Reversion ${reversionId} cannot require recovery before preparation.`,
            'reversion-binding-mismatch',
            event
          );
        }
        reversion.status = transitionReversion(
          reversion.status,
          ReversionStatus.RECOVERY_REQUIRED
        );
        reversion.failure = requireFailure(payload.failure, 'failure', event);
        reversion.phase = requireString(payload.phase, 'phase', event);
        reversion.terminalSequence = event.sequence;
        reversion.version = streamVersion;
        break;
      }
      case 'IntegrationReversionReleased': {
        const payload = requireExactFields(event.payload, [
          'integrationId', 'reversionId', 'status'
        ], 'payload', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        requireStream(event, `integration:${integrationId}`);
        const reversion = reversions.get(reversionId);
        const integration = integrations.get(integrationId);
        const status = requireString(payload.status, 'status', event);
        if (!reversion
          || !integration
          || ![ReversionStatus.CONFLICTED, ReversionStatus.FAILED].includes(
            reversion.status
          )
          || status !== reversion.status
          || reversion.terminalSequence !== event.sequence - 1
          || reversion.integrationReleaseSequence !== null
          || reversion.integrationId !== integrationId
          || integration.activeReversionId !== reversionId) {
          throw new ProjectionError(
            `${event.type} does not release Reversion ${reversionId}.`,
            'reversion-binding-mismatch',
            event
          );
        }
        integration.activeReversionId = null;
        integration.version = streamVersion;
        reversion.integrationReleaseSequence = event.sequence;
        break;
      }
      case 'RevertChangeSetCaptured': {
        const payload = requireExactFields(event.payload, [
          'baseRevision',
          'changeSetId',
          'changedFiles',
          'changedRefIds',
          'changes',
          'commits',
          'executionArtifact',
          'goalId',
          'headRevision',
          'nodeId',
          'patchArtifact',
          'ref',
          'reversionId',
          'sourceChangeSetId',
          'stats',
          'valid',
          'violations'
        ], 'payload', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `changeset:${changeSetId}`);
        const reversion = reversions.get(reversionId);
        const sourceChangeSet = changeSets.get(reversion?.sourceChangeSetId);
        if (changeSets.has(changeSetId)
          || !reversion
          || !sourceChangeSet
          || ![ReversionStatus.RUNNING, ReversionStatus.RECOVERY_REQUIRED].includes(
            reversion.status
          )
          || reversion.preparedSequence === null
          || reversion.regressionEvidence?.result !== 'pass'
          || reversion.revertChangeSetId !== null
          || payload.sourceChangeSetId !== reversion.sourceChangeSetId
          || payload.nodeId !== reversion.nodeId
          || payload.goalId !== reversion.goalId
          || payload.baseRevision !== reversion.expectedTargetRevision
          || payload.headRevision !== reversion.candidateRevision
          || payload.ref !== reversion.candidateRef
          || payload.valid !== true
          || !Array.isArray(payload.violations)
          || payload.violations.length !== 0) {
          throw new ProjectionError(
            `Revert ChangeSet ${changeSetId} does not match Reversion ${reversionId}.`,
            'reversion-binding-mismatch',
            event
          );
        }
        const commits = requireUniqueStringArray(payload.commits, 'commits', event).map(
          (commit, index) => requireGitObjectId(commit, `commits[${index}]`, event)
        );
        if (commits.length !== 1 || commits[0] !== reversion.candidateRevision) {
          throw new ProjectionError(
            `${event.type} must identify its single revert commit.`,
            'reversion-binding-mismatch',
            event
          );
        }
        const changedFiles = requireUniqueStringArray(
          payload.changedFiles,
          'changedFiles',
          event
        ).map((file, index) => requireWorkspacePath(
          file,
          `changedFiles[${index}]`,
          event
        ));
        const changedRefIds = requireUniqueStringArray(
          payload.changedRefIds,
          'changedRefIds',
          event
        );
        if (JSON.stringify(changedFiles) !== JSON.stringify(reversion.changedFiles)
          || JSON.stringify(payload.changes) !== JSON.stringify(reversion.changes)
          || JSON.stringify(changedRefIds) !== JSON.stringify(reversion.changedRefIds)) {
          throw new ProjectionError(
            `${event.type} changed effects differ from its prepared Reversion.`,
            'reversion-binding-mismatch',
            event
          );
        }
        const patchArtifact = requireArtifactRef(
          payload.patchArtifact,
          'patchArtifact',
          event
        );
        const executionArtifact = requireArtifactRef(
          payload.executionArtifact,
          'executionArtifact',
          event
        );
        if (!sameArtifactRef(patchArtifact, reversion.patchArtifact)
          || !sameArtifactRef(executionArtifact, reversion.executionArtifact)) {
          throw new ProjectionError(
            `${event.type} artifacts differ from its prepared Reversion.`,
            'reversion-binding-mismatch',
            event
          );
        }
        const stats = requireObject(payload.stats, 'stats', event);
        for (const [name, value] of Object.entries(stats)) {
          if (!Number.isSafeInteger(value) || value < 0) {
            throw new ProjectionError(
              `${event.type} has an invalid stats.${name}.`,
              'invalid-event-payload',
              event
            );
          }
        }
        changeSets.set(changeSetId, {
          id: changeSetId,
          kind: 'revert',
          runId: null,
          reversionId,
          nodeId: reversion.nodeId,
          goalId: reversion.goalId,
          baseRevision: requireGitObjectId(payload.baseRevision, 'baseRevision', event),
          headRevision: requireGitObjectId(payload.headRevision, 'headRevision', event),
          commits,
          changedFiles,
          changes: JSON.parse(JSON.stringify(payload.changes)),
          changedRefIds,
          coreIgnoreCase: sourceChangeSet.coreIgnoreCase === true,
          ref: requireString(payload.ref, 'ref', event),
          branch: null,
          valid: true,
          violations: [],
          stats: { ...stats },
          patchArtifact,
          executionArtifact,
          revertsChangeSetId: reversion.sourceChangeSetId,
          revertedByChangeSetId: null,
          revertedByReversionId: null,
          revertedAt: null,
          capturedAt: event.occurredAt,
          version: streamVersion
        });
        reversion.revertChangeSetId = changeSetId;
        reversion.changeSetSequence = event.sequence;
        nodes.get(reversion.nodeId).revertChangeSetIds.push(changeSetId);
        break;
      }
      case 'ProjectRevisionReverted': {
        const payload = requireExactFields(event.payload, [
          'changeSetId',
          'previousRevision',
          'revision',
          'reversionId',
          'sourceIntegrationId',
          'targetRef'
        ], 'payload', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        const reversion = reversions.get(reversionId);
        const targetRef = requireTargetRef(payload.targetRef, 'targetRef', event);
        requireStream(event, `project-revision:${targetRef}`);
        const previousRevision = requireGitObjectId(
          payload.previousRevision,
          'previousRevision',
          event
        );
        const revision = requireGitObjectId(payload.revision, 'revision', event);
        const latestProjectRevision = projectRevisions.findLast(
          (candidate) => candidate.targetRef === targetRef
        );
        if (!reversion
          || ![ReversionStatus.RUNNING, ReversionStatus.RECOVERY_REQUIRED].includes(
            reversion.status
          )
          || reversion.changeSetSequence === null
          || reversion.projectRevisionSequence !== null
          || payload.changeSetId !== reversion.revertChangeSetId
          || payload.sourceIntegrationId !== reversion.integrationId
          || targetRef !== reversion.targetRef
          || previousRevision !== reversion.expectedTargetRevision
          || revision !== reversion.candidateRevision
          || latestProjectRevision?.revision !== previousRevision) {
          throw new ProjectionError(
            `${event.type} does not match prepared Reversion ${reversionId}.`,
            'reversion-binding-mismatch',
            event
          );
        }
        projectRevisions.push({
          kind: 'reversion',
          integrationId: null,
          reversionId,
          changeSetId: reversion.revertChangeSetId,
          sourceIntegrationId: reversion.integrationId,
          targetRef,
          previousRevision,
          revision,
          advancedAt: event.occurredAt,
          advancedSequence: event.sequence,
          version: streamVersion
        });
        reversion.projectRevisionSequence = event.sequence;
        break;
      }
      case 'ChangeSetReverted': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'reversionId', 'revertChangeSetId'
        ], 'payload', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `changeset:${changeSetId}`);
        const reversion = reversions.get(reversionId);
        const changeSet = changeSets.get(changeSetId);
        if (!reversion
          || !changeSet
          || reversion.projectRevisionSequence === null
          || reversion.sourceChangeSetId !== changeSetId
          || reversion.revertChangeSetId !== payload.revertChangeSetId
          || changeSet.revertedByReversionId !== null) {
          throw new ProjectionError(
            `${event.type} does not match Reversion ${reversionId}.`,
            'reversion-binding-mismatch',
            event
          );
        }
        changeSet.revertedByReversionId = reversionId;
        changeSet.revertedByChangeSetId = reversion.revertChangeSetId;
        changeSet.revertedAt = event.occurredAt;
        changeSet.version = streamVersion;
        break;
      }
      case 'IntegrationReverting': {
        const payload = requireExactFields(event.payload, [
          'integrationId', 'reversionId'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const reversion = reversions.get(reversionId);
        if (!integration
          || !reversion
          || integration.status !== IntegrationStatus.INTEGRATED
          || integration.activeReversionId !== reversionId
          || reversion.integrationId !== integrationId
          || reversion.projectRevisionSequence === null) {
          throw new ProjectionError(
            `Integration ${integrationId} cannot enter reverting state.`,
            'reversion-binding-mismatch',
            event
          );
        }
        integration.status = transitionIntegration(
          integration.status,
          IntegrationStatus.REVERTING
        );
        integration.version = streamVersion;
        break;
      }
      case 'IntegrationReverted': {
        const payload = requireExactFields(event.payload, [
          'integrationId', 'reversionId', 'revertChangeSetId'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const reversion = reversions.get(reversionId);
        if (!integration
          || !reversion
          || integration.status !== IntegrationStatus.REVERTING
          || integration.activeReversionId !== reversionId
          || reversion.integrationId !== integrationId
          || payload.revertChangeSetId !== reversion.revertChangeSetId) {
          throw new ProjectionError(
            `Integration ${integrationId} cannot finish Reversion ${reversionId}.`,
            'reversion-binding-mismatch',
            event
          );
        }
        integration.status = transitionIntegration(
          integration.status,
          IntegrationStatus.REVERTED
        );
        integration.activeReversionId = null;
        integration.revertedByReversionId = reversionId;
        integration.revertedByChangeSetId = reversion.revertChangeSetId;
        integration.revertedAt = event.occurredAt;
        integration.version = streamVersion;
        reversion.integrationReleaseSequence = event.sequence;
        break;
      }
      case 'NodeReverted': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'nodeId', 'reversionId', 'revertChangeSetId'
        ], 'payload', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `node:${nodeId}`);
        const reversion = reversions.get(reversionId);
        const integration = integrations.get(reversion?.integrationId);
        const node = nodes.get(nodeId);
        if (!reversion
          || !integration
          || !node
          || integration.status !== IntegrationStatus.REVERTED
          || integration.revertedByReversionId !== reversionId
          || reversion.nodeId !== nodeId
          || payload.changeSetId !== reversion.sourceChangeSetId
          || payload.revertChangeSetId !== reversion.revertChangeSetId
          || node.integrationStatus !== IntegrationStatus.INTEGRATED
          || node.integratedChangeSetId !== reversion.sourceChangeSetId
          || node.validity !== Validity.VALID) {
          throw new ProjectionError(
            `Node ${nodeId} cannot be invalidated by Reversion ${reversionId}.`,
            'reversion-binding-mismatch',
            event
          );
        }
        node.validity = transitionValidity(node.validity, Validity.INVALID);
        node.integrationStatus = IntegrationStatus.REVERTED;
        node.integratedChangeSetId = null;
        node.integratedRevision = null;
        node.integratedTargetRef = null;
        node.revertedByReversionId = reversionId;
        node.version = streamVersion;
        break;
      }
      case 'NodeMarkedStale': {
        const rawPayload = requireObject(event.payload, 'payload', event);
        const hasReversion = Object.hasOwn(rawPayload, 'reversionId');
        const hasIntegration = Object.hasOwn(rawPayload, 'integrationId');
        if (hasReversion === hasIntegration) {
          throw new ProjectionError(
            `${event.type} must name exactly one invalidation origin.`,
            'invalid-event-payload',
            event
          );
        }
        const payload = requireExactFields(rawPayload, hasReversion
          ? ['changedRefIds', 'nodeId', 'recomputeRoot', 'reversionId', 'sourceNodeId']
          : ['changedRefIds', 'integrationId', 'nodeId', 'recomputeRoot', 'sourceNodeId'],
        'payload', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        requireStream(event, `node:${nodeId}`);
        const node = nodes.get(nodeId);
        if (hasReversion) {
          const reversionId = requireString(payload.reversionId, 'reversionId', event);
          const reversion = reversions.get(reversionId);
          const integration = integrations.get(reversion?.integrationId);
          const sourceNode = nodes.get(reversion?.nodeId);
          const changedRefIds = requireUniqueStringArray(
            payload.changedRefIds,
            'changedRefIds',
            event
          );
          const impact = reversion === undefined
            ? null
            : changedRefIds.length > 0
              ? computeInvalidation([...nodes.values()], changedRefIds, {
                  excludeNodeIds: [reversion.nodeId]
                })
              : computeDependencyInvalidation([...nodes.values()], [reversion.nodeId]);
          const recomputeRoot = requireBoolean(
            payload.recomputeRoot,
            'recomputeRoot',
            event
          );
          if (!reversion
            || !integration
            || !sourceNode
            || !node
            || ![ReversionStatus.RUNNING, ReversionStatus.RECOVERY_REQUIRED].includes(
              reversion.status
            )
            || reversion.changeSetSequence === null
            || reversion.projectRevisionSequence === null
            || reversion.integrationReleaseSequence === null
            || integration.status !== IntegrationStatus.REVERTED
            || integration.revertedByReversionId !== reversionId
            || sourceNode.validity !== Validity.INVALID
            || sourceNode.integrationStatus !== IntegrationStatus.REVERTED
            || sourceNode.revertedByReversionId !== reversionId
            || nodeId === reversion.nodeId
            || payload.sourceNodeId !== reversion.nodeId
            || node.validity !== Validity.VALID
            || ![NodeStatus.PRODUCED, NodeStatus.ACCEPTED].includes(node.status)
            || node.runIds.length === 0
            || JSON.stringify(changedRefIds) !== JSON.stringify(reversion.changedRefIds)
            || !impact?.affectedNodeIds.includes(nodeId)
            || recomputeRoot !== impact.recomputeRootNodeIds.includes(nodeId)
            || reversion.affectedNodeIds.includes(nodeId)) {
            throw new ProjectionError(
              `Node ${nodeId} cannot be marked stale by Reversion ${reversionId}.`,
              'reversion-binding-mismatch',
              event
            );
          }
          node.validity = transitionValidity(node.validity, Validity.STALE);
          node.staleByReversionIds.push(reversionId);
          node.version = streamVersion;
          if (recomputeRoot) {
            reversion.recomputeRootNodeIds.push(nodeId);
          }
          reversion.affectedNodeIds.push(nodeId);
          break;
        }
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const integration = integrations.get(integrationId);
        const sourceNode = nodes.get(integration?.nodeId);
        const changeSet = changeSets.get(integration?.changeSetId);
        const candidateEffects = integration?.strategy === 'merge-commit-regression-gated'
          ? integration
          : changeSet;
        const changedRefIds = requireUniqueStringArray(
          payload.changedRefIds,
          'changedRefIds',
          event
        );
        const impact = candidateEffects === undefined || !integration
          ? null
          : changedRefIds.length > 0
            ? computeInvalidation([...nodes.values()], changedRefIds, {
                excludeNodeIds: [integration.nodeId]
              })
            : computeDependencyInvalidation([...nodes.values()], [integration.nodeId]);
        const recomputeRoot = requireBoolean(
          payload.recomputeRoot,
          'recomputeRoot',
          event
        );
        if (!integration
          || !sourceNode
          || !changeSet
          || integration.status !== IntegrationStatus.INTEGRATED
          || integration.projectRevisionSequence === null
          || integration.appliedSequence === null
          || integration.nodeTerminalSequence === null
          || integration.effectsAppliedSequence !== null
          || sourceNode.integrationStatus !== IntegrationStatus.INTEGRATED
          || sourceNode.integratedChangeSetId !== integration.changeSetId
          || sourceNode.integratedRevision !== integration.candidateRevision
          || nodeId === integration.nodeId
          || payload.sourceNodeId !== integration.nodeId
          || !node
          || node.validity !== Validity.VALID
          || ![NodeStatus.PRODUCED, NodeStatus.ACCEPTED].includes(node.status)
          || node.runIds.length === 0
          || JSON.stringify(changedRefIds) !== JSON.stringify(candidateEffects.changedRefIds)
          || !impact?.affectedNodeIds.includes(nodeId)
          || recomputeRoot !== impact.recomputeRootNodeIds.includes(nodeId)
          || integration.affectedNodeIds.includes(nodeId)) {
          throw new ProjectionError(
            `Node ${nodeId} cannot be marked stale by Integration ${integrationId}.`,
            'integration-invalidation-binding-mismatch',
            event
          );
        }
        node.validity = transitionValidity(node.validity, Validity.STALE);
        node.staleByIntegrationIds.push(integrationId);
        node.version = streamVersion;
        if (recomputeRoot) integration.recomputeRootNodeIds.push(nodeId);
        integration.affectedNodeIds.push(nodeId);
        break;
      }
      case 'RefVersionReverted': {
        const payload = requireExactFields(event.payload, [
          'changeSetId',
          'changedFiles',
          'hash',
          'previousHash',
          'previousVersion',
          'refId',
          'reversionId',
          'version'
        ], 'payload', event);
        const refId = requireString(payload.refId, 'refId', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `ref:${refId}`);
        const reversion = reversions.get(reversionId);
        const integration = integrations.get(reversion?.integrationId);
        const sourceNode = nodes.get(reversion?.nodeId);
        const sourceChangeSet = changeSets.get(reversion?.sourceChangeSetId);
        const revertChangeSet = changeSets.get(reversion?.revertChangeSetId);
        const coreIgnoreCase = sourceChangeSet?.coreIgnoreCase === true;
        const ref = refs.get(refId);
        const changedFiles = requireUniqueStringArray(
          payload.changedFiles,
          'changedFiles',
          event
        ).map((file, index) => requireWorkspacePath(
          file,
          `changedFiles[${index}]`,
          event
        ));
        const previousVersion = requireString(
          payload.previousVersion,
          'previousVersion',
          event
        );
        const previousHash = requireSha256(payload.previousHash, 'previousHash', event);
        const version = requireString(payload.version, 'version', event);
        const hash = requireSha256(payload.hash, 'hash', event);
        const expectedChangedFiles = !ref || !reversion
          ? null
          : reversion.changedFiles.filter((file) => (
              matchesEffectPattern(ref.uri, file, { ignoreCase: coreIgnoreCase })
            ));
        const expectedHash = !ref
          || !reversion
          || typeof reversion.candidateRevision !== 'string'
          ? null
          : refVersionDigest({
              ref: refContract(ref),
              revision: reversion.candidateRevision,
              changedFiles: reversion.changedFiles,
              changes: reversion.changes,
              ignoreCase: coreIgnoreCase
            });
        if (!reversion
          || !integration
          || !sourceNode
          || !sourceChangeSet
          || !revertChangeSet
          || !ref
          || ![ReversionStatus.RUNNING, ReversionStatus.RECOVERY_REQUIRED].includes(
            reversion.status
          )
          || reversion.changeSetSequence === null
          || reversion.projectRevisionSequence === null
          || reversion.integrationReleaseSequence === null
          || integration.status !== IntegrationStatus.REVERTED
          || integration.revertedByReversionId !== reversionId
          || sourceNode.validity !== Validity.INVALID
          || sourceNode.integrationStatus !== IntegrationStatus.REVERTED
          || sourceNode.revertedByReversionId !== reversionId
          || revertChangeSet.kind !== 'revert'
          || revertChangeSet.reversionId !== reversionId
          || payload.changeSetId !== reversion.revertChangeSetId
          || !reversion.changedRefIds.includes(refId)
          || ref.lastReversionId === reversionId
          || ref.version !== previousVersion
          || ref.hash !== previousHash
          || version !== reversion.candidateRevision
          || JSON.stringify(changedFiles) !== JSON.stringify(expectedChangedFiles)
          || hash !== expectedHash) {
          throw new ProjectionError(
            `${event.type} does not match Reversion ${reversionId} and Ref ${refId}.`,
            'ref-version-binding-mismatch',
            event
          );
        }
        if (JSON.stringify(changedFiles) !== JSON.stringify(
          [...changedFiles].sort((left, right) => left.localeCompare(right, 'en'))
        )) {
          throw new ProjectionError(
            `${event.type} changedFiles must be sorted.`,
            'invalid-event-payload',
            event
          );
        }
        ref.version = version;
        ref.hash = hash;
        ref.updatedAt = event.occurredAt;
        ref.lastIntegrationId = reversion.integrationId;
        ref.lastChangeSetId = reversion.revertChangeSetId;
        ref.lastReversionId = reversionId;
        ref.streamVersion = streamVersion;
        reversion.revertedRefIds.push(refId);
        break;
      }
      case 'GoalReopened': {
        const rawPayload = requireObject(event.payload, 'payload', event);
        const hasReversion = Object.hasOwn(rawPayload, 'reversionId');
        const hasIntegration = Object.hasOwn(rawPayload, 'integrationId');
        if (hasReversion === hasIntegration) {
          throw new ProjectionError(
            `${event.type} must name exactly one reopen origin.`,
            'invalid-event-payload',
            event
          );
        }
        const payload = requireExactFields(rawPayload, hasReversion
          ? ['goalId', 'reversionId']
          : ['goalId', 'integrationId'], 'payload', event);
        const goalId = requireString(payload.goalId, 'goalId', event);
        requireStream(event, `goal:${goalId}`);
        const goal = goals.get(goalId);
        if (hasReversion) {
          const reversionId = requireString(payload.reversionId, 'reversionId', event);
          const reversion = reversions.get(reversionId);
          const integration = integrations.get(reversion?.integrationId);
          const sourceNode = nodes.get(reversion?.nodeId);
          const affectedGoal = reversion !== undefined
            && goal?.nodeIds.some((nodeId) => (
              nodeId === reversion.nodeId || reversion.affectedNodeIds.includes(nodeId)
            ));
          if (!goal
            || !reversion
            || !integration
            || !sourceNode
            || ![ReversionStatus.RUNNING, ReversionStatus.RECOVERY_REQUIRED].includes(
              reversion.status
            )
            || (reversion.status === ReversionStatus.RUNNING
              ? reversion.terminalSequence !== null
              : !Number.isSafeInteger(reversion.terminalSequence))
            || reversion.projectRevisionSequence === null
            || reversion.integrationReleaseSequence === null
            || integration.status !== IntegrationStatus.REVERTED
            || integration.revertedByReversionId !== reversionId
            || sourceNode.integrationStatus !== IntegrationStatus.REVERTED
            || sourceNode.revertedByReversionId !== reversionId
            || !affectedGoal
            || goal.status !== GoalStatus.COMPLETED
            || reversion.reopenedGoalIds.includes(goalId)
            || (goalId === reversion.goalId
              ? sourceNode.validity !== Validity.INVALID
              : !goal.nodeIds.some((nodeId) => nodes.get(nodeId)?.validity === Validity.STALE))) {
            throw new ProjectionError(
              `Goal ${goalId} cannot reopen for Reversion ${reversionId}.`,
              'reversion-binding-mismatch',
              event
            );
          }
          goal.status = transitionGoal(goal.status, GoalStatus.ACTIVE);
          goal.version = streamVersion;
          reversion.reopenedGoalIds.push(goalId);
          break;
        }
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const integration = integrations.get(integrationId);
        const affectedGoal = goal?.nodeIds.some((nodeId) => (
          integration?.affectedNodeIds.includes(nodeId)
          && nodes.get(nodeId)?.validity === Validity.STALE
          && nodes.get(nodeId).staleByIntegrationIds.includes(integrationId)
        ));
        if (!goal
          || !integration
          || integration.status !== IntegrationStatus.INTEGRATED
          || integration.projectRevisionSequence === null
          || integration.appliedSequence === null
          || integration.nodeTerminalSequence === null
          || integration.effectsAppliedSequence !== null
          || !affectedGoal
          || goal.status !== GoalStatus.COMPLETED
          || integration.reopenedGoalIds.includes(goalId)) {
          throw new ProjectionError(
            `Goal ${goalId} cannot reopen for Integration ${integrationId}.`,
            'integration-invalidation-binding-mismatch',
            event
          );
        }
        goal.status = transitionGoal(goal.status, GoalStatus.ACTIVE);
        goal.version = streamVersion;
        integration.reopenedGoalIds.push(goalId);
        break;
      }
      case 'ReversionApplied': {
        const payload = requireExactFields(event.payload, [
          'affectedNodeIds',
          'recomputeRootNodeIds',
          'reopenedGoalIds',
          'reversionId',
          'revertChangeSetId',
          'revertedRefIds'
        ], 'payload', event);
        const reversionId = requireString(payload.reversionId, 'reversionId', event);
        requireStream(event, `reversion:${reversionId}`);
        const reversion = reversions.get(reversionId);
        const integration = integrations.get(reversion?.integrationId);
        const node = nodes.get(reversion?.nodeId);
        const affectedNodeIds = requireUniqueStringArray(
          payload.affectedNodeIds,
          'affectedNodeIds',
          event
        );
        const recomputeRootNodeIds = requireUniqueStringArray(
          payload.recomputeRootNodeIds,
          'recomputeRootNodeIds',
          event
        );
        const reopenedGoalIds = requireUniqueStringArray(
          payload.reopenedGoalIds,
          'reopenedGoalIds',
          event
        );
        const revertedRefIds = requireUniqueStringArray(
          payload.revertedRefIds,
          'revertedRefIds',
          event
        );
        const expectedImpact = reversion === undefined
          ? null
          : expectedMaterializedInvalidation(nodes, {
              changedRefIds: reversion.changedRefIds,
              sourceNodeId: reversion.nodeId,
              originId: reversionId,
              staleByField: 'staleByReversionIds'
            });
        const impactedNodeIds = new Set([
          reversion?.nodeId,
          ...(expectedImpact?.affectedNodeIds ?? [])
        ]);
        const missingGoalReopen = [...goals.values()].some((goal) => (
          goal.status === GoalStatus.COMPLETED
          && goal.nodeIds.some((nodeId) => impactedNodeIds.has(nodeId))
        ));
        if (!reversion
          || !integration
          || !node
          || ![ReversionStatus.RUNNING, ReversionStatus.RECOVERY_REQUIRED].includes(
            reversion.status
          )
          || payload.revertChangeSetId !== reversion.revertChangeSetId
          || reversion.projectRevisionSequence === null
          || integration.status !== IntegrationStatus.REVERTED
          || integration.revertedByReversionId !== reversionId
          || node.validity !== Validity.INVALID
          || node.revertedByReversionId !== reversionId
          || JSON.stringify(affectedNodeIds) !== JSON.stringify(
            expectedImpact?.affectedNodeIds
          )
          || JSON.stringify(recomputeRootNodeIds) !== JSON.stringify(
            expectedImpact?.recomputeRootNodeIds
          )
          || JSON.stringify(affectedNodeIds) !== JSON.stringify(
            [...reversion.affectedNodeIds].sort()
          )
          || JSON.stringify(recomputeRootNodeIds) !== JSON.stringify(
            [...reversion.recomputeRootNodeIds].sort()
          )
          || JSON.stringify(revertedRefIds) !== JSON.stringify(reversion.changedRefIds)
          || JSON.stringify(revertedRefIds) !== JSON.stringify(
            [...reversion.revertedRefIds].sort()
          )
          || JSON.stringify(reopenedGoalIds) !== JSON.stringify(
            [...reversion.reopenedGoalIds].sort()
          )
          || missingGoalReopen) {
          throw new ProjectionError(
            `Reversion ${reversionId} cannot be marked applied.`,
            'reversion-binding-mismatch',
            event
          );
        }
        reversion.status = transitionReversion(
          reversion.status,
          ReversionStatus.REVERTED
        );
        reversion.affectedNodeIds = affectedNodeIds;
        reversion.recomputeRootNodeIds = recomputeRootNodeIds;
        reversion.reopenedGoalIds = reopenedGoalIds;
        reversion.revertedRefIds = revertedRefIds;
        reversion.revertedAt = event.occurredAt;
        reversion.terminalSequence = event.sequence;
        reversion.version = streamVersion;
        break;
      }
      case 'ProjectRevisionAdvanced': {
        const payload = requireExactFields(event.payload, [
          'integrationId', 'previousRevision', 'revision', 'targetRef'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const integration = integrations.get(integrationId);
        const targetRef = requireTargetRef(payload.targetRef, 'targetRef', event);
        requireStream(event, `project-revision:${targetRef}`);
        const previousRevision = requireGitObjectId(
          payload.previousRevision,
          'previousRevision',
          event
        );
        const revision = requireGitObjectId(payload.revision, 'revision', event);
        const node = nodes.get(integration?.nodeId);
        const previousProjectRevision = projectRevisions.findLast(
          (candidate) => candidate.targetRef === targetRef
        );
        const goal = goals.get(node?.goalId);
        if (!integration || !node
          || !goal
          || ![
            IntegrationStatus.RUNNING,
            IntegrationStatus.RECOVERY_REQUIRED
          ].includes(integration.status)
          || integration.preparedSequence === null
          || integration.projectRevisionSequence !== null
          || integration.candidateRevision !== revision
          || integration.expectedTargetRevision !== previousRevision
          || (previousProjectRevision !== undefined
            && previousProjectRevision.revision !== previousRevision)
          || integration.targetRef !== targetRef
          || (goal.integrationTargetRef !== null
            && goal.integrationTargetRef !== targetRef)
          || node.status !== NodeStatus.ACCEPTED
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== integration.status) {
          throw new ProjectionError(
            `${event.type} does not match prepared Integration ${integrationId}.`,
            'integration-binding-mismatch',
            event
          );
        }
        const projectRevision = {
          integrationId,
          targetRef,
          previousRevision,
          revision,
          advancedAt: event.occurredAt,
          advancedSequence: event.sequence,
          version: streamVersion
        };
        projectRevisions.push(projectRevision);
        integration.projectRevisionSequence = event.sequence;
        break;
      }
      case 'IntegrationApplied': {
        const payload = requireExactFields(event.payload, [
          'candidateTree',
          'changeSetId',
          'integratedRevision',
          'integrationId',
          'nodeId',
          'previousRevision',
          'targetRef'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        const goal = goals.get(node?.goalId);
        const projectRevision = projectRevisions.find(
          (candidate) => candidate.integrationId === integrationId
        );
        const previousRevision = requireGitObjectId(
          payload.previousRevision,
          'previousRevision',
          event
        );
        const integratedRevision = requireGitObjectId(
          payload.integratedRevision,
          'integratedRevision',
          event
        );
        const candidateTree = requireGitObjectId(
          payload.candidateTree,
          'candidateTree',
          event
        );
        const targetRef = requireTargetRef(payload.targetRef, 'targetRef', event);
        if (!integration || !node || !goal || !projectRevision
          || ![
            IntegrationStatus.RUNNING,
            IntegrationStatus.RECOVERY_REQUIRED
          ].includes(integration.status)
          || integration.projectRevisionSequence !== event.sequence - 1
          || projectRevision.advancedSequence !== event.sequence - 1
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || integration.expectedTargetRevision !== previousRevision
          || integration.candidateRevision !== integratedRevision
          || integration.candidateTree !== candidateTree
          || integration.targetRef !== targetRef
          || projectRevision.targetRef !== targetRef
          || projectRevision.previousRevision !== previousRevision
          || projectRevision.revision !== integratedRevision
          || (goal.integrationTargetRef !== null
            && goal.integrationTargetRef !== targetRef)
          || node.status !== NodeStatus.ACCEPTED
          || node.validity !== Validity.VALID
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== integration.status) {
          throw new ProjectionError(
            `${event.type} does not match the immediately preceding Project revision.`,
            'integration-binding-mismatch',
            event
          );
        }
        integration.terminalFromStatus = integration.status;
        integration.status = transitionIntegration(
          integration.status,
          IntegrationStatus.INTEGRATED
        );
        integration.integratedRevision = integratedRevision;
        integration.integratedAt = event.occurredAt;
        integration.appliedSequence = event.sequence;
        integration.version = streamVersion;
        break;
      }
      case 'NodeIntegrated': {
        const payload = requireExactFields(event.payload, [
          'changeSetId',
          'integratedRevision',
          'integrationId',
          'nodeId',
          'targetRef'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        const integratedRevision = requireGitObjectId(
          payload.integratedRevision,
          'integratedRevision',
          event
        );
        const targetRef = requireTargetRef(payload.targetRef, 'targetRef', event);
        requireStream(event, `node:${nodeId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        const goal = goals.get(node?.goalId);
        if (!integration || !node || !goal
          || integration.status !== IntegrationStatus.INTEGRATED
          || integration.appliedSequence !== event.sequence - 1
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || integration.integratedRevision !== integratedRevision
          || integration.targetRef !== targetRef
          || (goal.integrationTargetRef !== null
            && goal.integrationTargetRef !== targetRef)
          || node.status !== NodeStatus.ACCEPTED
          || node.validity !== Validity.VALID
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== integration.terminalFromStatus) {
          throw new ProjectionError(
            `${event.type} does not immediately pair with Integration ${integrationId}.`,
            'integration-binding-mismatch',
            event
          );
        }
        node.activeIntegrationId = null;
        node.integrationStatus = IntegrationStatus.INTEGRATED;
        node.integratedChangeSetId = changeSetId;
        node.integratedRevision = integratedRevision;
        node.integratedTargetRef = targetRef;
        node.version = streamVersion;
        goal.integrationTargetRef ??= targetRef;
        integration.nodeTerminalSequence = event.sequence;
        goalCompletionWindow = {
          goalId: node.goalId,
          integrationId,
          lastSequence: event.sequence
        };
        break;
      }
      case 'IntegrationFailed': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'failure', 'integrationId', 'nodeId', 'phase'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        if (!integration || !node
          || ![
            IntegrationStatus.PENDING,
            IntegrationStatus.RUNNING,
            IntegrationStatus.RECOVERY_REQUIRED
          ].includes(integration.status)
          || integration.projectRevisionSequence !== null
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || node.status !== NodeStatus.ACCEPTED
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== integration.status) {
          throw new ProjectionError(
            `Integration ${integrationId} cannot fail from its current state.`,
            'integration-binding-mismatch',
            event
          );
        }
        integration.terminalFromStatus = integration.status;
        integration.status = transitionIntegration(
          integration.status,
          IntegrationStatus.FAILED
        );
        integration.failure = requireFailure(payload.failure, 'failure', event);
        integration.phase = requireString(payload.phase, 'phase', event);
        integration.failedAt = event.occurredAt;
        integration.appliedSequence = event.sequence;
        integration.version = streamVersion;
        break;
      }
      case 'NodeIntegrationFailed': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'integrationId', 'nodeId'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `node:${nodeId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        if (!integration || !node
          || integration.status !== IntegrationStatus.FAILED
          || integration.appliedSequence !== event.sequence - 1
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || node.status !== NodeStatus.ACCEPTED
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== integration.terminalFromStatus) {
          throw new ProjectionError(
            `${event.type} does not immediately pair with Integration ${integrationId}.`,
            'integration-binding-mismatch',
            event
          );
        }
        node.activeIntegrationId = null;
        node.integrationStatus = IntegrationStatus.FAILED;
        node.version = streamVersion;
        integration.nodeTerminalSequence = event.sequence;
        break;
      }
      case 'IntegrationRecoveryRequired': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'failure', 'integrationId', 'nodeId', 'phase'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `integration:${integrationId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        if (!integration || !node
          || integration.status !== IntegrationStatus.RUNNING
          || integration.preparedSequence === null
          || integration.projectRevisionSequence !== null
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || node.status !== NodeStatus.ACCEPTED
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== IntegrationStatus.RUNNING) {
          throw new ProjectionError(
            `Integration ${integrationId} cannot require recovery before preparation.`,
            'integration-binding-mismatch',
            event
          );
        }
        integration.status = transitionIntegration(
          integration.status,
          IntegrationStatus.RECOVERY_REQUIRED
        );
        integration.recoveryFailure = requireFailure(payload.failure, 'failure', event);
        integration.phase = requireString(payload.phase, 'phase', event);
        integration.appliedSequence = event.sequence;
        integration.version = streamVersion;
        break;
      }
      case 'NodeIntegrationRecoveryRequired': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'integrationId', 'nodeId'
        ], 'payload', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `node:${nodeId}`);
        const integration = integrations.get(integrationId);
        const node = nodes.get(nodeId);
        if (!integration || !node
          || integration.status !== IntegrationStatus.RECOVERY_REQUIRED
          || integration.appliedSequence !== event.sequence - 1
          || integration.nodeTerminalSequence !== null
          || integration.nodeId !== nodeId
          || integration.changeSetId !== changeSetId
          || node.status !== NodeStatus.ACCEPTED
          || node.activeIntegrationId !== integrationId
          || node.integrationStatus !== IntegrationStatus.RUNNING) {
          throw new ProjectionError(
            `${event.type} does not immediately pair with Integration ${integrationId}.`,
            'integration-binding-mismatch',
            event
          );
        }
        node.integrationStatus = IntegrationStatus.RECOVERY_REQUIRED;
        node.version = streamVersion;
        integration.nodeTerminalSequence = event.sequence;
        break;
      }
      case 'GoalCompleted': {
        const payload = requireExactFields(event.payload, [
          'goalId', 'integrationId', 'planId', 'revision', 'targetRef'
        ], 'payload', event);
        const goalId = requireString(payload.goalId, 'goalId', event);
        const planId = requireString(payload.planId, 'planId', event);
        const integrationId = requireString(payload.integrationId, 'integrationId', event);
        const revision = requireGitObjectId(payload.revision, 'revision', event);
        const targetRef = requireTargetRef(payload.targetRef, 'targetRef', event);
        requireStream(event, `goal:${goalId}`);
        const goal = goals.get(goalId);
        const integration = integrations.get(integrationId);
        const complete = goal?.nodeIds.every((nodeId) => {
          const node = nodes.get(nodeId);
          return node?.status === NodeStatus.ACCEPTED
            && node.validity === Validity.VALID
            && node.integrationStatus === IntegrationStatus.INTEGRATED
            && node.integratedChangeSetId === node.acceptedChangeSetId
            && node.integratedTargetRef === targetRef;
        });
        if (!goal || !integration
          || goal.status !== GoalStatus.ACTIVE
          || goal.planId !== planId
          || integration.goalId !== goalId
          || integration.status !== IntegrationStatus.INTEGRATED
          || goal.integrationTargetRef !== targetRef
          || integration.targetRef !== targetRef
          || integration.integratedRevision !== revision
          || !goalCompletionWindow
          || goalCompletionWindow.goalId !== goalId
          || goalCompletionWindow.integrationId !== integrationId
          || event.sequence !== goalCompletionWindow.lastSequence + 1
          || !complete) {
          throw new ProjectionError(
            `Goal ${goalId} cannot complete before every Node is accepted, valid, and integrated.`,
            'goal-not-complete',
            event
          );
        }
        goal.status = transitionGoal(goal.status, GoalStatus.COMPLETED);
        goal.completedAt = event.occurredAt;
        goal.completedRevision = revision;
        goal.completedTargetRef = targetRef;
        goal.version = streamVersion;
        goalCompletionWindow = null;
        break;
      }
      case 'EvaluationInterrupted': {
        const payload = requireExactFields(event.payload, [
          'changeSetId',
          'evaluationId',
          'failure',
          'nodeId',
          'phase',
          'runId',
          'workspaceDisposition'
        ], 'payload', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const runId = requireString(payload.runId, 'runId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `evaluation:${evaluationId}`);
        const evaluation = evaluations.get(evaluationId);
        const node = nodes.get(nodeId);
        if (!evaluation || !node
          || ![EvaluationStatus.REQUESTED, EvaluationStatus.RUNNING].includes(evaluation.status)
          || evaluation.nodeId !== nodeId
          || evaluation.runId !== runId
          || evaluation.changeSetId !== changeSetId
          || node.activeEvaluationId !== evaluationId) {
          throw new ProjectionError(
            `${event.type} does not match active evaluation ${evaluationId}.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        const wasRunning = evaluation.status === EvaluationStatus.RUNNING;
        if ((wasRunning && node.status !== NodeStatus.EVALUATING)
          || (!wasRunning && node.status !== NodeStatus.PRODUCED)) {
          throw new ProjectionError(
            `${event.type} contradicts node ${nodeId}'s state.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        const workspaceDisposition = requireString(
          payload.workspaceDisposition,
          'workspaceDisposition',
          event
        );
        if (!['removed', 'preserved', 'setup-unknown'].includes(workspaceDisposition)) {
          throw new ProjectionError(
            `${event.type} has an invalid workspaceDisposition.`,
            'invalid-event-payload',
            event
          );
        }
        evaluation.status = transitionEvaluation(
          evaluation.status,
          EvaluationStatus.INTERRUPTED
        );
        evaluation.failure = requireFailure(payload.failure, 'failure', event);
        evaluation.phase = requireString(payload.phase, 'phase', event);
        evaluation.workspaceDisposition = workspaceDisposition;
        evaluation.workspaceStatus = workspaceDisposition;
        if (workspaceDisposition === 'removed') {
          evaluation.workspaceRemovedAt = event.occurredAt;
        }
        evaluation.finishedAt = event.occurredAt;
        evaluation.terminalSequence = event.sequence;
        evaluation.version = streamVersion;
        if (!wasRunning) {
          node.activeEvaluationId = null;
        }
        break;
      }
      case 'NodeEvaluationDeferred': {
        const payload = requireExactFields(event.payload, [
          'changeSetId', 'evaluationId', 'nodeId', 'runId'
        ], 'payload', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        const runId = requireString(payload.runId, 'runId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `node:${nodeId}`);
        const node = nodes.get(nodeId);
        const evaluation = evaluations.get(evaluationId);
        if (!node || !evaluation
          || evaluation.status !== EvaluationStatus.INTERRUPTED
          || evaluation.startedAt === null
          || evaluation.terminalSequence !== event.sequence - 1
          || node.status !== NodeStatus.EVALUATING
          || node.activeEvaluationId !== evaluationId
          || evaluation.nodeId !== nodeId
          || evaluation.runId !== runId
          || evaluation.changeSetId !== changeSetId) {
          throw new ProjectionError(
            `Node ${nodeId} cannot defer evaluation ${evaluationId}.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        node.status = transitionNode(node.status, NodeStatus.PRODUCED);
        node.activeEvaluationId = null;
        node.version = streamVersion;
        break;
      }
      case 'EvaluationRecoveryRequired': {
        const payload = requireExactFields(event.payload, [
          'changeSetId',
          'evaluationId',
          'failure',
          'nodeId',
          'phase',
          'runId',
          'workspacePath'
        ], 'payload', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        const nodeId = requireString(payload.nodeId, 'nodeId', event);
        const runId = requireString(payload.runId, 'runId', event);
        const changeSetId = requireString(payload.changeSetId, 'changeSetId', event);
        requireStream(event, `evaluation:${evaluationId}`);
        const evaluation = evaluations.get(evaluationId);
        const node = nodes.get(nodeId);
        const workspacePath = requireString(payload.workspacePath, 'workspacePath', event);
        if (!evaluation || !node
          || evaluation.status !== EvaluationStatus.RUNNING
          || evaluation.workspacePath !== workspacePath
          || evaluation.nodeId !== nodeId
          || evaluation.runId !== runId
          || evaluation.changeSetId !== changeSetId
          || node.status !== NodeStatus.EVALUATING
          || node.activeEvaluationId !== evaluationId) {
          throw new ProjectionError(
            `${event.type} does not match active evaluation ${evaluationId}.`,
            'evaluation-binding-mismatch',
            event
          );
        }
        evaluation.status = transitionEvaluation(
          evaluation.status,
          EvaluationStatus.RECOVERY_REQUIRED
        );
        evaluation.failure = requireFailure(payload.failure, 'failure', event);
        evaluation.phase = requireString(payload.phase, 'phase', event);
        evaluation.workspaceDisposition = 'preserved';
        evaluation.workspaceStatus = 'preserved';
        evaluation.finishedAt = event.occurredAt;
        evaluation.terminalSequence = event.sequence;
        evaluation.version = streamVersion;
        break;
      }
      case 'EvaluationWorkspaceRemoved': {
        const payload = requireExactFields(event.payload, [
          'evaluationId', 'reason', 'workspacePath'
        ], 'payload', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        requireStream(event, `evaluation:${evaluationId}`);
        const evaluation = evaluations.get(evaluationId);
        const workspacePath = requireString(payload.workspacePath, 'workspacePath', event);
        if (!evaluation
          || ![
            EvaluationStatus.PASSED,
            EvaluationStatus.REJECTED,
            EvaluationStatus.INTERRUPTED
          ].includes(evaluation.status)
          || ![
            'cleanup-pending',
            'cleanup-failed',
            'preserved',
            'setup-unknown'
          ].includes(evaluation.workspaceStatus)
          || (evaluation.workspacePath !== null
            && evaluation.workspacePath !== workspacePath)) {
          throw new ProjectionError(
            `Evaluation ${evaluationId} has no removable workspace.`,
            'evaluation-cleanup-mismatch',
            event
          );
        }
        evaluation.workspacePath ??= workspacePath;
        evaluation.workspaceStatus = 'removed';
        evaluation.workspaceDisposition = 'removed';
        evaluation.workspaceRemovedAt = event.occurredAt;
        evaluation.cleanupReason = requireString(payload.reason, 'reason', event);
        evaluation.version = streamVersion;
        break;
      }
      case 'EvaluationWorkspaceCleanupFailed': {
        const payload = requireExactFields(event.payload, [
          'evaluationId', 'failure', 'workspacePath'
        ], 'payload', event);
        const evaluationId = requireString(payload.evaluationId, 'evaluationId', event);
        requireStream(event, `evaluation:${evaluationId}`);
        const evaluation = evaluations.get(evaluationId);
        const workspacePath = requireString(payload.workspacePath, 'workspacePath', event);
        if (!evaluation
          || ![
            EvaluationStatus.PASSED,
            EvaluationStatus.REJECTED,
            EvaluationStatus.INTERRUPTED
          ].includes(evaluation.status)
          || ![
            'cleanup-pending',
            'cleanup-failed',
            'preserved',
            'setup-unknown'
          ].includes(evaluation.workspaceStatus)
          || (evaluation.workspacePath !== null
            && evaluation.workspacePath !== workspacePath)) {
          throw new ProjectionError(
            `Evaluation ${evaluationId} has no workspace cleanup to fail.`,
            'evaluation-cleanup-mismatch',
            event
          );
        }
        evaluation.workspacePath ??= workspacePath;
        evaluation.cleanupFailures.push({
          ...requireFailure(payload.failure, 'failure', event),
          occurredAt: event.occurredAt
        });
        evaluation.workspaceStatus = 'cleanup-failed';
        evaluation.version = streamVersion;
        break;
      }
      case 'RunFailed': {
        const runId = requireString(event.payload.runId, 'runId', event);
        requireStream(event, `run:${runId}`);
        const run = runs.get(runId);
        if (!run) {
          throw new ProjectionError(
            `Failure references unknown run ${runId}.`,
            'run-not-found',
            event
          );
        }
        const failure = requireObject(event.payload.failure, 'failure', event);
        run.failure = {
          code: requireString(failure.code, 'failure.code', event),
          message: requireString(failure.message, 'failure.message', event),
          phase: requireString(event.payload.phase, 'phase', event),
          details: failure.details ?? null
        };
        run.status = transitionRun(run.status, RunStatus.FAILED);
        run.workspaceStatus = run.startedAt === null ? 'setup-unknown' : 'preserved';
        run.failedAt = event.occurredAt;
        run.version = streamVersion;
        break;
      }
      case 'NodeFailed': {
        const nodeId = requireString(event.payload.nodeId, 'nodeId', event);
        const runId = requireString(event.payload.runId, 'runId', event);
        requireStream(event, `node:${nodeId}`);
        const node = nodes.get(nodeId);
        const run = runs.get(runId);
        if (!node || !run
          || run.nodeId !== nodeId
          || run.status !== RunStatus.FAILED
          || node.runIds.at(-1) !== runId) {
          throw new ProjectionError(
            `Node ${nodeId} cannot fail from run ${runId}.`,
            'run-node-mismatch',
            event
          );
        }
        node.status = transitionNode(node.status, NodeStatus.FAILED);
        node.version = streamVersion;
        break;
      }
      case 'RunWorkspaceRemoved': {
        const runId = requireString(event.payload.runId, 'runId', event);
        requireStream(event, `run:${runId}`);
        const run = runs.get(runId);
        if (!run || run.status !== RunStatus.PRODUCED
          || !['cleanup-pending', 'cleanup-failed'].includes(run.workspaceStatus)) {
          throw new ProjectionError(
            `Run ${runId} has no removable produced workspace.`,
            'run-cleanup-mismatch',
            event
          );
        }
        if (run.workspacePath !== requireString(
          event.payload.workspacePath,
          'workspacePath',
          event
        )) {
          throw new ProjectionError(
            `Run ${runId} cleanup refers to another workspace.`,
            'run-cleanup-mismatch',
            event
          );
        }
        run.workspaceStatus = 'removed';
        run.workspaceRemovedAt = event.occurredAt;
        run.version = streamVersion;
        break;
      }
      case 'RunWorkspaceCleanupFailed': {
        const runId = requireString(event.payload.runId, 'runId', event);
        requireStream(event, `run:${runId}`);
        const run = runs.get(runId);
        if (!run || run.status !== RunStatus.PRODUCED
          || !['cleanup-pending', 'cleanup-failed'].includes(run.workspaceStatus)) {
          throw new ProjectionError(
            `Run ${runId} has no produced workspace cleanup to fail.`,
            'run-cleanup-mismatch',
            event
          );
        }
        const failure = requireObject(event.payload.failure, 'failure', event);
        run.cleanupFailures.push({
          code: requireString(failure.code, 'failure.code', event),
          message: requireString(failure.message, 'failure.message', event),
          details: failure.details ?? null,
          occurredAt: event.occurredAt
        });
        run.workspaceStatus = 'cleanup-failed';
        run.version = streamVersion;
        break;
      }
      default:
        throw new ProjectionError(
          `Unsupported event type ${event.type}.`,
          'event-type-unsupported',
          event
        );
    }
  }


  for (const goal of goals.values()) {
    if (goal.planId === null) continue;
    for (const nodeId of goal.nodeIds) {
      const node = nodes.get(nodeId);
      if (!node || node.goalId !== goal.id || node.planId !== goal.planId) {
        throw new ProjectionError(
          `Plan ${goal.planId} is missing declared node ${nodeId}.`,
          'incomplete-plan-projection'
        );
      }
    }
    const planNodes = goal.nodeIds.map((nodeId) => {
      const {
        goalId,
        planId,
        status,
        validity,
        integrationStatus,
        runIds,
        changeSetIds,
        revertChangeSetIds,
        evaluationIds,
        activeEvaluationId,
        acceptedChangeSetId,
        acceptanceEvidenceIds,
        integrationIds,
        activeIntegrationId,
        integratedChangeSetId,
        integratedRevision,
        integratedTargetRef,
        revertedByReversionId,
        staleByIntegrationIds,
        staleByReversionIds,
        retryHistory,
        retrySequence,
        readySequence,
        version,
        ...node
      } = nodes.get(nodeId);
      return node;
    });
    try {
      assertValidPlan({
        schemaVersion: PLAN_SCHEMA_VERSION,
        goalId: goal.id,
        nodes: planNodes
      });
    } catch (error) {
      throw new ProjectionError(
        `Plan ${goal.planId} failed replay validation: ${error.message}`,
        'invalid-plan-projection'
      );
    }
  }

  for (const node of nodes.values()) {
    for (const [field, values] of [['reads', node.reads], ['writes', node.writes]]) {
      for (const value of values) {
        if (isRefId(value) && !refs.has(value)) {
          throw new ProjectionError(
            `Node ${node.id} ${field} unknown Ref ${value}.`,
            'incomplete-ref-projection'
          );
        }
      }
    }
  }

  for (const run of runs.values()) {
    const node = nodes.get(run.nodeId);
    const isLatestAttempt = node?.runIds.at(-1) === run.id;
    if (!node || !isLatestAttempt) continue;
    if (run.status === RunStatus.PENDING && node.status !== NodeStatus.READY) {
      throw new ProjectionError(
        `Pending run ${run.id} requires ready node ${run.nodeId}.`,
        'incomplete-run-projection'
      );
    }
    if ((run.status === RunStatus.RUNNING || run.status === RunStatus.PAUSED)
      && node.status !== NodeStatus.RUNNING) {
      throw new ProjectionError(
        `Active run ${run.id} requires running node ${run.nodeId}.`,
        'incomplete-run-projection'
      );
    }
    if (run.status === RunStatus.PRODUCED && node.status === NodeStatus.RUNNING) {
      throw new ProjectionError(
        `Produced run ${run.id} did not advance node ${run.nodeId}.`,
        'incomplete-run-projection'
      );
    }
    if (run.status === RunStatus.FAILED
      && run.startedAt !== null
      && node.status === NodeStatus.RUNNING) {
      throw new ProjectionError(
        `Failed run ${run.id} did not fail node ${run.nodeId}.`,
        'incomplete-run-projection'
      );
    }
  }

  for (const evaluation of evaluations.values()) {
    const node = nodes.get(evaluation.nodeId);
    const run = runs.get(evaluation.runId);
    const changeSet = changeSets.get(evaluation.changeSetId);
    const superseded = run?.createdSequence < (node?.retrySequence ?? 0);
    if (!node || !run || !changeSet
      || run.nodeId !== node.id
      || run.changeSetId !== changeSet.id
      || changeSet.nodeId !== node.id
      || changeSet.runId !== run.id
      || changeSet.headRevision !== evaluation.headRevision
      || !node.evaluationIds.includes(evaluation.id)) {
      throw new ProjectionError(
        `Evaluation ${evaluation.id} has an incomplete aggregate binding.`,
        'incomplete-evaluation-projection'
      );
    }

    if (evaluation.status === EvaluationStatus.REQUESTED) {
      if (node.status !== NodeStatus.PRODUCED
        || node.activeEvaluationId !== evaluation.id
        || evaluation.workspaceStatus !== 'not-created') {
        throw new ProjectionError(
          `Requested evaluation ${evaluation.id} is not active on its produced node.`,
          'incomplete-evaluation-projection'
        );
      }
    } else if (evaluation.status === EvaluationStatus.RUNNING) {
      if (node.status !== NodeStatus.EVALUATING
        || node.activeEvaluationId !== evaluation.id
        || evaluation.workspaceStatus !== 'present'
        || evaluation.evidenceId !== null) {
        throw new ProjectionError(
          `Running evaluation ${evaluation.id} is not paired with its evaluating node.`,
          'incomplete-evaluation-projection'
        );
      }
    } else if (evaluation.status === EvaluationStatus.PASSED) {
      const record = evidence.get(evaluation.evidenceId);
      if (!record
        || record.result !== 'pass'
        || record.policyViolations.length !== 0
        || (!superseded && (node.status !== NodeStatus.ACCEPTED
        || node.activeEvaluationId !== null
        || node.acceptedChangeSetId !== evaluation.changeSetId
        || !node.acceptanceEvidenceIds.includes(record.id)))) {
        throw new ProjectionError(
          `Passed evaluation ${evaluation.id} did not accept its node.`,
          'incomplete-evaluation-projection'
        );
      }
    } else if (evaluation.status === EvaluationStatus.REJECTED) {
      const record = evidence.get(evaluation.evidenceId);
      if (!record
        || record.result !== 'fail'
        || (!superseded && (node.status !== NodeStatus.REJECTED
        || node.activeEvaluationId !== null
        || node.acceptedChangeSetId !== null
        || node.acceptanceEvidenceIds.length !== 0))) {
        throw new ProjectionError(
          `Rejected evaluation ${evaluation.id} did not reject its node.`,
          'incomplete-evaluation-projection'
        );
      }
    } else if (evaluation.status === EvaluationStatus.INTERRUPTED) {
      if ((!superseded && node.evaluationIds.at(-1) === evaluation.id
          && (node.status !== NodeStatus.PRODUCED || node.activeEvaluationId !== null))
        || !['removed', 'preserved', 'setup-unknown', 'cleanup-failed'].includes(
          evaluation.workspaceStatus
        )) {
        throw new ProjectionError(
          `Interrupted evaluation ${evaluation.id} did not defer its node safely.`,
          'incomplete-evaluation-projection'
        );
      }
    } else if (evaluation.status === EvaluationStatus.RECOVERY_REQUIRED) {
      if (node.status !== NodeStatus.EVALUATING
        || node.activeEvaluationId !== evaluation.id
        || evaluation.workspaceStatus !== 'preserved') {
        throw new ProjectionError(
          `Recovery-required evaluation ${evaluation.id} lost its owned workspace or node.`,
          'incomplete-evaluation-projection'
        );
      }
    }
  }

  for (const record of evidence.values()) {
    const evaluation = evaluations.get(record.evaluationId);
    if (!evaluation
      || evaluation.evidenceId !== record.id
      || ![EvaluationStatus.PASSED, EvaluationStatus.REJECTED].includes(
        evaluation.status
      )
      || evaluation.nodeId !== record.nodeId
      || evaluation.runId !== record.runId
      || evaluation.changeSetId !== record.changeSetId
      || evaluation.headRevision !== record.headRevision) {
      throw new ProjectionError(
        `Evidence ${record.id} is not bound to one terminal evaluation.`,
        'incomplete-evidence-projection'
      );
    }
  }

  for (const integration of integrations.values()) {
    const node = nodes.get(integration.nodeId);
    const run = runs.get(integration.runId);
    const changeSet = changeSets.get(integration.changeSetId);
    const evaluation = evaluations.get(integration.evaluationId);
    const record = evidence.get(integration.evidenceId);
    const superseded = integration.requestedSequence < (node?.retrySequence ?? 0);
    const isLatestAttempt = !superseded && node?.integrationIds.at(-1) === integration.id;
    const isExactStrategy = integration.strategy === 'exact-base-single-commit';
    const isGatedStrategy = integration.strategy === 'merge-commit-regression-gated';
    const priorProjectRevision = projectRevisions.filter((candidate) => (
      candidate.targetRef === integration.targetRef
      && candidate.advancedSequence < integration.requestedSequence
    )).at(-1);
    const strategyBindingComplete = isExactStrategy
      ? integration.expectedTargetRevision === integration.baseRevision
        && integration.regressionProfileHash === null
      : isGatedStrategy
        && typeof integration.regressionProfileHash === 'string'
        && integration.expectedTargetRevision === (
          priorProjectRevision?.revision ?? integration.baseRevision
        );
    if (!node || !run || !changeSet || !evaluation || !record
      || !node.integrationIds.includes(integration.id)
      || integration.nodeRequestedSequence !== integration.requestedSequence + 1
      || (!superseded && (node.status !== NodeStatus.ACCEPTED
      || node.acceptedChangeSetId !== integration.changeSetId
      || node.acceptanceEvidenceIds.length !== 1
      || node.acceptanceEvidenceIds[0] !== integration.evidenceId))
      || run.nodeId !== node.id
      || run.changeSetId !== changeSet.id
      || changeSet.nodeId !== node.id
      || changeSet.runId !== run.id
      || changeSet.baseRevision !== integration.baseRevision
      || changeSet.headRevision !== integration.headRevision
      || evaluation.status !== EvaluationStatus.PASSED
      || evaluation.nodeId !== node.id
      || evaluation.runId !== run.id
      || evaluation.changeSetId !== changeSet.id
      || evaluation.evidenceId !== record.id
      || record.result !== 'pass'
      || record.policyViolations.length !== 0
      || record.nodeId !== node.id
      || record.runId !== run.id
      || record.changeSetId !== changeSet.id
      || !strategyBindingComplete) {
      throw new ProjectionError(
        `Integration ${integration.id} has an incomplete accepted-ChangeSet binding.`,
        'incomplete-integration-projection'
      );
    }

    const candidateAbsent = integration.preparedSequence === null
      && integration.candidateRevision === null
      && integration.candidateTree === null
      && integration.candidateParents.length === 0
      && integration.candidateRef === null
      && integration.candidateWorkspacePath === null
      && integration.changedFiles.length === 0
      && integration.changes.length === 0
      && integration.changedRefIds.length === 0
      && integration.patchArtifact === null
      && integration.executionArtifact === null;
    const exactCandidateComplete = isExactStrategy
      && integration.preparedSequence !== null
      && integration.candidateRevision !== null
      && integration.candidateTree !== null
      && integration.candidateParents.length === 1
      && integration.candidateParents[0] === integration.expectedTargetRevision
      && integration.candidateRef === `refs/fwa/integrations/${integration.id}/candidate`
      && integration.candidateWorkspacePath === null
      && integration.changedFiles.length === 0
      && integration.changes.length === 0
      && integration.changedRefIds.length === 0
      && integration.patchArtifact === null
      && integration.executionArtifact === null
      && integration.regressionEvidence === null;
    const gatedCandidateComplete = isGatedStrategy
      && integration.preparedSequence !== null
      && integration.candidateRevision !== null
      && integration.candidateTree !== null
      && integration.candidateParents.length === 2
      && integration.candidateParents[0] === integration.expectedTargetRevision
      && integration.candidateParents[1] === integration.headRevision
      && integration.candidateRef === `refs/fwa/integrations/${integration.id}/candidate`
      && typeof integration.candidateWorkspacePath === 'string'
      && integration.patchArtifact !== null
      && integration.executionArtifact !== null;
    const candidateBindingComplete = candidateAbsent
      || exactCandidateComplete
      || gatedCandidateComplete;
    const regressionBindingComplete = isExactStrategy
      ? integration.regressionEvidence === null
      : integration.regressionEvidence === null
        || (integration.regressionEvidence.integrationId === integration.id
          && integration.regressionEvidence.candidateRevision === integration.candidateRevision
          && integration.regressionEvidence.profile.sha256
            === integration.regressionProfileHash);
    const derivedEffectsAbsent = integration.affectedNodeIds.length === 0
      && integration.recomputeRootNodeIds.length === 0
      && integration.reopenedGoalIds.length === 0
      && integration.advancedRefIds.length === 0
      && integration.effectsAppliedSequence === null;

    if (integration.status === IntegrationStatus.PENDING) {
      if (!isLatestAttempt
        || node.activeIntegrationId !== integration.id
        || node.integrationStatus !== IntegrationStatus.PENDING
        || integration.startedSequence !== null
        || !candidateAbsent
        || !regressionBindingComplete
        || !derivedEffectsAbsent
        || integration.projectRevisionSequence !== null
        || integration.appliedSequence !== null
        || integration.nodeTerminalSequence !== null) {
        throw new ProjectionError(
          `Pending Integration ${integration.id} is not active on its accepted Node.`,
          'incomplete-integration-projection'
        );
      }
    } else if (integration.status === IntegrationStatus.RUNNING) {
      if (!isLatestAttempt
        || node.activeIntegrationId !== integration.id
        || node.integrationStatus !== IntegrationStatus.RUNNING
        || integration.startedSequence === null
        || integration.nodeStartedSequence !== integration.startedSequence + 1
        || !candidateBindingComplete
        || !regressionBindingComplete
        || !derivedEffectsAbsent
        || integration.projectRevisionSequence !== null
        || integration.appliedSequence !== null
        || integration.nodeTerminalSequence !== null) {
        throw new ProjectionError(
          `Running Integration ${integration.id} is not paired with its accepted Node.`,
          'incomplete-integration-projection'
        );
      }
    } else if (integration.status === IntegrationStatus.RECOVERY_REQUIRED) {
      if (!isLatestAttempt
        || node.activeIntegrationId !== integration.id
        || node.integrationStatus !== IntegrationStatus.RECOVERY_REQUIRED
        || integration.preparedSequence === null
        || !(exactCandidateComplete || gatedCandidateComplete)
        || !regressionBindingComplete
        || !derivedEffectsAbsent
        || integration.projectRevisionSequence !== null
        || integration.recoveryFailure === null
        || integration.nodeTerminalSequence !== integration.appliedSequence + 1) {
        throw new ProjectionError(
          `Recovery-required Integration ${integration.id} lost its candidate or Node.`,
          'incomplete-integration-projection'
        );
      }
    } else if (integration.status === IntegrationStatus.INTEGRATED) {
      const projectRevision = projectRevisions.find(
        (candidate) => candidate.integrationId === integration.id
      );
      const goal = goals.get(integration.goalId);
      if ((!superseded && !isLatestAttempt)
        || !goal
        || !projectRevision
        || (!superseded && (node.activeIntegrationId !== null
        || node.integrationStatus !== IntegrationStatus.INTEGRATED
        || node.integratedChangeSetId !== integration.changeSetId
        || node.integratedRevision !== integration.integratedRevision
        || node.integratedTargetRef !== integration.targetRef))
        || goal.integrationTargetRef !== integration.targetRef
        || integration.preparedSequence === null
        || integration.candidateRevision === null
        || integration.candidateTree === null
        || integration.integratedRevision !== integration.candidateRevision
        || !(exactCandidateComplete || gatedCandidateComplete)
        || !regressionBindingComplete
        || (isGatedStrategy && integration.regressionEvidence?.result !== 'pass')
          || integration.projectRevisionSequence !== projectRevision.advancedSequence
          || integration.appliedSequence !== projectRevision.advancedSequence + 1
          || integration.nodeTerminalSequence !== integration.appliedSequence + 1
          || integration.effectsAppliedSequence === null
        || projectRevision.targetRef !== integration.targetRef
        || projectRevision.previousRevision !== integration.expectedTargetRevision
        || projectRevision.revision !== integration.integratedRevision) {
        throw new ProjectionError(
          `Integrated Integration ${integration.id} did not advance its exact target.`,
          'incomplete-integration-projection'
        );
      }
    } else if (integration.status === IntegrationStatus.REVERTED) {
      const projectRevision = projectRevisions.find((candidate) => (
        candidate.integrationId === integration.id
      ));
      const reversion = reversions.get(integration.revertedByReversionId);
      const sourceChangeSet = changeSets.get(integration.changeSetId);
      if ((!superseded && !isLatestAttempt)
        || !projectRevision
        || !reversion
        || !sourceChangeSet
        || reversion.status !== ReversionStatus.REVERTED
        || reversion.integrationId !== integration.id
        || reversion.sourceChangeSetId !== integration.changeSetId
        || reversion.revertChangeSetId !== integration.revertedByChangeSetId
        || sourceChangeSet.revertedByReversionId !== reversion.id
        || sourceChangeSet.revertedByChangeSetId !== reversion.revertChangeSetId
          || integration.activeReversionId !== null
          || integration.projectRevisionSequence !== projectRevision.advancedSequence
          || integration.effectsAppliedSequence === null
        || (!superseded && (node.activeIntegrationId !== null
        || node.integrationStatus !== IntegrationStatus.REVERTED
        || node.validity !== Validity.INVALID
        || node.revertedByReversionId !== reversion.id
        || node.integratedChangeSetId !== null
        || node.integratedRevision !== null
        || node.integratedTargetRef !== null))) {
        throw new ProjectionError(
          `Reverted Integration ${integration.id} lost its ChangeSet or Node history.`,
          'incomplete-reversion-projection'
        );
      }
    } else if (integration.status === IntegrationStatus.CONFLICTED) {
      if (integration.strategy !== 'merge-commit-regression-gated'
        || integration.failure?.code !== 'PHYSICAL_CONFLICT'
        || integration.phase !== 'physical-conflict'
        || integration.conflicts.length === 0
        || integration.candidateRevision !== null
        || integration.candidateTree !== null
        || integration.candidateParents.length !== 0
          || integration.candidateRef !== `refs/fwa/integrations/${integration.id}/candidate`
        || typeof integration.candidateWorkspacePath !== 'string'
        || integration.changedFiles.length !== 0
        || integration.changes.length !== 0
        || integration.changedRefIds.length !== 0
        || integration.patchArtifact !== null
        || integration.executionArtifact !== null
        || integration.regressionEvidence !== null
        || !derivedEffectsAbsent
        || integration.projectRevisionSequence !== null
        || integration.appliedSequence === null
        || integration.nodeTerminalSequence !== integration.appliedSequence + 1
        || (isLatestAttempt && (
          node.activeIntegrationId !== null
          || node.integrationStatus !== IntegrationStatus.CONFLICTED
          || node.integratedChangeSetId !== null
          || node.integratedRevision !== null
          || node.integratedTargetRef !== null
        ))) {
        throw new ProjectionError(
          `Conflicted Integration ${integration.id} did not preserve its physical conflict.`,
          'incomplete-integration-projection'
        );
      }
    } else if (integration.status === IntegrationStatus.FAILED) {
      if (integration.failure === null
        || !candidateBindingComplete
        || !regressionBindingComplete
        || !derivedEffectsAbsent
        || integration.projectRevisionSequence !== null
        || integration.appliedSequence === null
        || integration.nodeTerminalSequence !== integration.appliedSequence + 1
        || (isLatestAttempt && (
          node.activeIntegrationId !== null
          || node.integrationStatus !== IntegrationStatus.FAILED
          || node.integratedChangeSetId !== null
          || node.integratedRevision !== null
          || node.integratedTargetRef !== null
        ))) {
        throw new ProjectionError(
          `Failed Integration ${integration.id} did not preserve a safe accepted Node.`,
          'incomplete-integration-projection'
        );
      }
    }
  }

  for (const reversion of reversions.values()) {
    const integration = integrations.get(reversion.integrationId);
    const sourceChangeSet = changeSets.get(reversion.sourceChangeSetId);
    const node = nodes.get(reversion.nodeId);
    const goal = goals.get(reversion.goalId);
    const preparedComplete = reversion.preparedSequence !== null
      && reversion.candidateRevision !== null
      && reversion.candidateTree !== null
      && reversion.candidateParents.length === 1
      && reversion.candidateParents[0] === reversion.expectedTargetRevision
      && reversion.candidateRef === `refs/fwa/integrations/${reversion.id}/candidate`
      && typeof reversion.candidateWorkspacePath === 'string'
      && reversion.patchArtifact !== null
      && reversion.executionArtifact !== null;
    const regressionComplete = reversion.regressionEvidence !== null
      && reversion.regressionEvidence.integrationId === reversion.id
      && reversion.regressionEvidence.candidateRevision === reversion.candidateRevision
      && reversion.regressionEvidence.profile.sha256 === reversion.regressionProfileHash;
    const publishedEffectsAbsent = reversion.revertChangeSetId === null
      && reversion.changeSetSequence === null
      && reversion.projectRevisionSequence === null
      && reversion.affectedNodeIds.length === 0
      && reversion.recomputeRootNodeIds.length === 0
      && reversion.reopenedGoalIds.length === 0
      && reversion.revertedRefIds.length === 0
      && reversion.revertedAt === null;
    if (!integration
      || !sourceChangeSet
      || !node
      || !goal
      || reversion.integrationRequestedSequence !== reversion.requestedSequence + 1
      || !integration.reversionIds.includes(reversion.id)
      || sourceChangeSet.kind !== 'execution'
      || sourceChangeSet.nodeId !== node.id
      || sourceChangeSet.goalId !== goal.id
      || reversion.revertedRevision !== integration.integratedRevision
      || reversion.targetRef !== integration.targetRef) {
      throw new ProjectionError(
        `Reversion ${reversion.id} has an incomplete source binding.`,
        'incomplete-reversion-projection'
      );
    }
    if (reversion.status === ReversionStatus.PENDING) {
      if (integration.activeReversionId !== reversion.id
        || integration.status !== IntegrationStatus.INTEGRATED
        || reversion.startedSequence !== null
        || reversion.preparedSequence !== null
        || !publishedEffectsAbsent
        || reversion.integrationReleaseSequence !== null
        || reversion.terminalSequence !== null) {
        throw new ProjectionError(
          `Pending Reversion ${reversion.id} lost its source Integration.`,
          'incomplete-reversion-projection'
        );
      }
    } else if (reversion.status === ReversionStatus.RUNNING) {
      if (integration.activeReversionId !== reversion.id
        || integration.status !== IntegrationStatus.INTEGRATED
        || reversion.startedSequence === null
        || (reversion.preparedSequence === null
          ? reversion.candidateRevision !== null
          : !preparedComplete)
        || (reversion.regressionEvidence !== null && !regressionComplete)
        || !publishedEffectsAbsent
        || reversion.integrationReleaseSequence !== null
        || reversion.terminalSequence !== null) {
        throw new ProjectionError(
          `Running Reversion ${reversion.id} has incomplete durable state.`,
          'incomplete-reversion-projection'
        );
      }
    } else if (reversion.status === ReversionStatus.RECOVERY_REQUIRED) {
      if (integration.activeReversionId !== reversion.id
        || integration.status !== IntegrationStatus.INTEGRATED
        || !preparedComplete
        || !publishedEffectsAbsent
        || reversion.integrationReleaseSequence !== null
        || reversion.failure === null
        || reversion.terminalSequence === null) {
        throw new ProjectionError(
          `Recovery-required Reversion ${reversion.id} lost its candidate.`,
          'incomplete-reversion-projection'
        );
      }
    } else if ([ReversionStatus.CONFLICTED, ReversionStatus.FAILED].includes(
      reversion.status
    )) {
      const successfulRetry = integration.status === IntegrationStatus.REVERTED
        ? reversions.get(integration.revertedByReversionId)
        : null;
      const supersededBySuccessfulRetry = successfulRetry !== null
        && successfulRetry !== undefined
        && successfulRetry.id !== reversion.id
        && successfulRetry.status === ReversionStatus.REVERTED
        && successfulRetry.integrationId === integration.id
        && Number.isSafeInteger(reversion.terminalSequence)
        && successfulRetry.requestedSequence > reversion.terminalSequence
        && integration.reversionIds.indexOf(successfulRetry.id)
          > integration.reversionIds.indexOf(reversion.id);
      if (![IntegrationStatus.INTEGRATED, IntegrationStatus.REVERTED].includes(integration.status)
        || (integration.status === IntegrationStatus.REVERTED && !supersededBySuccessfulRetry)
        || integration.activeReversionId === reversion.id
        || !publishedEffectsAbsent
        || reversion.failure === null
        || reversion.terminalSequence === null
        || reversion.integrationReleaseSequence !== reversion.terminalSequence + 1
        || (reversion.status === ReversionStatus.CONFLICTED && (
          reversion.conflicts.length === 0
          || reversion.candidateRevision !== null
          || reversion.preparedSequence !== null
          || reversion.candidateRef !== `refs/fwa/integrations/${reversion.id}/candidate`
        ))) {
        throw new ProjectionError(
          `Terminal Reversion ${reversion.id} did not release its source Integration.`,
          'incomplete-reversion-projection'
        );
      }
    } else if (reversion.status === ReversionStatus.REVERTED) {
      const revertChangeSet = changeSets.get(reversion.revertChangeSetId);
      if (!preparedComplete
        || !regressionComplete
        || reversion.regressionEvidence.result !== 'pass'
        || !revertChangeSet
        || revertChangeSet.kind !== 'revert'
        || revertChangeSet.reversionId !== reversion.id
        || revertChangeSet.revertsChangeSetId !== sourceChangeSet.id
        || reversion.changeSetSequence === null
        || reversion.projectRevisionSequence === null
        || reversion.terminalSequence === null
        || reversion.integrationReleaseSequence === null
        || integration.status !== IntegrationStatus.REVERTED
        || integration.activeReversionId !== null
        || (reversion.requestedSequence > (node.retrySequence ?? 0)
          && (node.validity !== Validity.INVALID || node.revertedByReversionId !== reversion.id))
        || !reversion.affectedNodeIds.every((nodeId) => (
          nodes.get(nodeId)?.staleByReversionIds.includes(reversion.id)
          && (nodes.get(nodeId).validity === Validity.STALE
            || nodes.get(nodeId).retrySequence > reversion.requestedSequence)
        ))
        || !reversion.recomputeRootNodeIds.every((nodeId) => (
          reversion.affectedNodeIds.includes(nodeId)
        ))) {
        throw new ProjectionError(
          `Applied Reversion ${reversion.id} has incomplete history or invalidation.`,
          'incomplete-reversion-projection'
        );
      }
    }
  }

  for (const projectRevision of projectRevisions) {
    if (projectRevision.kind === undefined) {
      const integration = integrations.get(projectRevision.integrationId);
      if (!integration
        || ![IntegrationStatus.INTEGRATED, IntegrationStatus.REVERTED].includes(
          integration.status
        )
        || integration.projectRevisionSequence !== projectRevision.advancedSequence
        || integration.targetRef !== projectRevision.targetRef
        || integration.expectedTargetRevision !== projectRevision.previousRevision
        || integration.integratedRevision !== projectRevision.revision) {
        throw new ProjectionError(
          `Project revision ${projectRevision.revision} is not bound to one integrated change.`,
          'incomplete-project-revision-projection'
        );
      }
    } else if (projectRevision.kind === 'reversion') {
      const reversion = reversions.get(projectRevision.reversionId);
      if (!reversion
        || reversion.status !== ReversionStatus.REVERTED
        || reversion.projectRevisionSequence !== projectRevision.advancedSequence
        || reversion.targetRef !== projectRevision.targetRef
        || reversion.expectedTargetRevision !== projectRevision.previousRevision
        || reversion.candidateRevision !== projectRevision.revision
        || reversion.revertChangeSetId !== projectRevision.changeSetId) {
        throw new ProjectionError(
          `Project revision ${projectRevision.revision} is not bound to one Reversion.`,
          'incomplete-project-revision-projection'
        );
      }
    } else {
      throw new ProjectionError(
        `Project revision ${projectRevision.revision} has an unknown kind.`,
        'incomplete-project-revision-projection'
      );
    }
  }

  for (const node of nodes.values()) {
    const goal = goals.get(node.goalId);
    const latestIntegration = integrations.get(node.integrationIds.at(-1));
    if (latestIntegration === undefined
      || latestIntegration.requestedSequence < (node.retrySequence ?? 0)) {
      if (node.activeIntegrationId !== null
        || node.integrationStatus !== null
        || node.integratedChangeSetId !== null
        || node.integratedRevision !== null
        || node.integratedTargetRef !== null) {
        throw new ProjectionError(
          `Node ${node.id} has Integration state without an Integration history.`,
          'incomplete-integration-projection'
        );
      }
    } else {
      const latest = latestIntegration;
      if (!latest || latest.nodeId !== node.id || node.integrationStatus !== latest.status) {
        throw new ProjectionError(
          `Node ${node.id} does not reflect its latest Integration attempt.`,
          'incomplete-integration-projection'
        );
      }
    }

    const dependenciesSatisfied = areNodeDependenciesSatisfied(node, nodes, goal);
    if (node.status === NodeStatus.PLANNED && dependenciesSatisfied) {
      throw new ProjectionError(
        `Node ${node.id} was not marked ready after its dependencies integrated.`,
        'incomplete-node-readiness'
      );
    }
  }

  for (const goal of goals.values()) {
    if (goal.planId === null) continue;
    const allIntegrated = goal.nodeIds.every((nodeId) => {
      const node = nodes.get(nodeId);
      return node?.status === NodeStatus.ACCEPTED
        && node.validity === Validity.VALID
        && node.integrationStatus === IntegrationStatus.INTEGRATED
        && node.integratedChangeSetId === node.acceptedChangeSetId
        && goal.integrationTargetRef !== null
        && node.integratedTargetRef === goal.integrationTargetRef;
    });
    if ((goal.status === GoalStatus.COMPLETED) !== allIntegrated) {
      throw new ProjectionError(
        `Goal ${goal.id} completion does not match its integrated Nodes.`,
        'incomplete-goal-projection'
      );
    }
  }

  return {
    lastSequence,
    refs: [...refs.values()].sort((left, right) => left.id.localeCompare(right.id)),
    goals: [...goals.values()].sort((left, right) => left.id.localeCompare(right.id)),
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    runs: [...runs.values()].sort((left, right) => left.id.localeCompare(right.id)),
    changeSets: [...changeSets.values()].sort((left, right) => left.id.localeCompare(right.id)),
    evaluations: [...evaluations.values()].sort((left, right) => (
      left.id.localeCompare(right.id)
    )),
    evidence: [...evidence.values()].sort((left, right) => left.id.localeCompare(right.id)),
    integrations: [...integrations.values()].sort((left, right) => (
      left.id.localeCompare(right.id)
    )),
    reversions: [...reversions.values()].sort((left, right) => (
      left.id.localeCompare(right.id)
    )),
    projectRevisions: [...projectRevisions].sort((left, right) => (
      left.advancedSequence - right.advancedSequence
    )),
    streamVersions: Object.fromEntries([...streamVersions.entries()].sort())
  };
}
