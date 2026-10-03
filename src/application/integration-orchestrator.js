import { createHash } from 'node:crypto';
import path from 'node:path';

import { matchesEffectPattern, normalizeWorkspacePath } from '../core/effects.js';
import { createEvent, stableStringify } from '../core/events.js';
import { validateEvidenceAgainstProfile } from '../core/evaluator.js';
import { changedRefsForFiles, refVersionDigest } from '../core/refs.js';
import {
  computeDependencyInvalidation,
  computeInvalidation
} from '../core/invalidation.js';
import {
  EvaluationStatus,
  GoalStatus,
  IntegrationStatus,
  NodeStatus,
  ReversionStatus,
  RunStatus,
  Validity
} from '../core/state-machines.js';
import { hashCanonicalValue } from '../storage/file-event-store.js';
import { loadProject } from './project.js';
import { projectEvents } from './projection.js';
import { retryUnstartedLeaseOperation, startLeaseHeartbeat } from './lease-operations.js';
import { areNodeDependenciesSatisfied } from '../core/scheduling.js';
import { runIntegrationRegressionGate } from './integration-regression-gate.js';

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_ORPHAN_GRACE_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAYS = Object.freeze([5, 10, 20, 40, 80]);
const INTERNAL_COMMAND_PREFIX = '@fwa/';
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const STRATEGY = 'exact-base-single-commit';
const GATED_MERGE_STRATEGY = 'merge-commit-regression-gated';

export class IntegrationOrchestrationError extends Error {
  constructor(message, code = 'integration-orchestration-error', details = undefined) {
    super(message);
    this.name = 'IntegrationOrchestrationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value, expectedKeys) {
  return isPlainObject(value)
    && stableStringify(Object.keys(value).sort()) === stableStringify([...expectedKeys].sort());
}

function requireTrimmedString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new IntegrationOrchestrationError(
      `${name} must be a non-empty, trimmed string.`,
      'invalid-integration-command'
    );
  }
  return value;
}

function requirePublicCommandId(value) {
  const commandId = requireTrimmedString(value, 'commandId');
  if (commandId.startsWith(INTERNAL_COMMAND_PREFIX)) {
    throw new IntegrationOrchestrationError(
      `commandId prefix ${INTERNAL_COMMAND_PREFIX} is reserved for FWA transactions.`,
      'reserved-command-id'
    );
  }
  return commandId;
}

function requireSafeDuration(value, name, fallback) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 86_400_000) {
    throw new IntegrationOrchestrationError(
      `${name} must be a positive safe integer no greater than one day.`,
      'invalid-integration-command'
    );
  }
  return selected;
}

function requireBoolean(value, name, fallback = false) {
  const selected = value ?? fallback;
  if (typeof selected !== 'boolean') {
    throw new IntegrationOrchestrationError(
      `${name} must be a boolean.`,
      'invalid-integration-command'
    );
  }
  return selected;
}

/** Canonicalize a local branch name before it enters an idempotent command intent. */
export function normalizeIntegrationTargetRef(value) {
  const input = requireTrimmedString(value, 'targetRef');
  if (input.startsWith('refs/') && !input.startsWith('refs/heads/')) {
    throw new IntegrationOrchestrationError(
      'targetRef must name a local branch below refs/heads/.',
      'invalid-integration-target'
    );
  }
  const branch = input.startsWith('refs/heads/')
    ? input.slice('refs/heads/'.length)
    : input;
  const components = branch.split('/');
  const invalid = branch.length === 0
    || branch.length > 1000
    || branch === '@'
    || branch.startsWith('-')
    || branch.endsWith('.')
    || branch.includes('..')
    || branch.includes('@{')
    || branch.includes('//')
    || /[\u0000-\u0020\u007f~^:?*\\[]/u.test(branch)
    || components.some((component) => (
      component.length === 0
      || component.startsWith('.')
      || component.endsWith('.lock')
    ));
  if (invalid) {
    throw new IntegrationOrchestrationError(
      `${JSON.stringify(input)} is not a safe local branch name.`,
      'invalid-integration-target'
    );
  }
  return `refs/heads/${branch}`;
}

function cloneJson(value) {
  try {
    return JSON.parse(stableStringify(value));
  } catch {
    return null;
  }
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

function candidateChangedRefIds(refs, changedFiles, options = {}) {
  return [...changedRefsForFiles(
    (refs ?? []).map((ref) => refContract(ref)),
    changedFiles,
    { ignoreCase: options.ignoreCase === true }
  )].sort((left, right) => left.localeCompare(right, 'en'));
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
  return {
    code: typeof error?.code === 'string' ? error.code : fallbackCode,
    message: typeof error?.message === 'string' ? error.message : String(error),
    details: error?.details === undefined ? null : cloneJson(redactSecrets(error.details))
  };
}

async function removeCandidateWorkspace(candidateWorkspace, {
  ownerId,
  workspacePath,
  cleanup,
  failureCode
}) {
  if (candidateWorkspace === undefined
    || candidateWorkspace === null
    || typeof candidateWorkspace.cleanup !== 'function') {
    cleanup.candidateWorkspaceRemoved = false;
    cleanup.warnings.push({
      phase: 'candidate-workspace-cleanup',
      failure: {
        code: failureCode,
        message: `Candidate workspace cleanup is unavailable for ${ownerId}.`,
        details: null
      }
    });
    return false;
  }
  try {
    const removed = await candidateWorkspace.cleanup({
      integrationId: ownerId,
      ...(workspacePath === undefined || workspacePath === null ? {} : { workspacePath }),
      force: true
    });
    const complete = removed?.removed === true || removed?.alreadyAbsent === true;
    cleanup.candidateWorkspaceRemoved = complete;
    if (!complete) {
      cleanup.warnings.push({
        phase: 'candidate-workspace-cleanup',
        failure: {
          code: failureCode,
          message: `Candidate workspace cleanup returned no completion proof for ${ownerId}.`,
          details: cloneJson(removed)
        }
      });
    }
    return complete;
  } catch (error) {
    cleanup.candidateWorkspaceRemoved = false;
    cleanup.warnings.push({
      phase: 'candidate-workspace-cleanup',
      failure: failureFrom(error, failureCode)
    });
    return false;
  }
}

async function removeRetainedRegressionWorkspace(
  evaluationWorkspace,
  ownerId,
  candidateRevision
) {
  assertPort(evaluationWorkspace, 'evaluationWorkspace', ['removeEvaluation']);
  const removal = await evaluationWorkspace.removeEvaluation({
    evaluationId: ownerId,
    revision: candidateRevision,
    force: true
  });
  if (removal?.removed !== true && removal?.alreadyAbsent !== true) {
    throw new IntegrationOrchestrationError(
      `Evaluation workspace cleanup returned no completion proof for ${ownerId}.`,
      'regression-workspace-cleanup-unproven',
      { ownerId, removal: cloneJson(removal) }
    );
  }
  return cloneJson(removal);
}

async function removeTerminalCandidateResidue(candidateWorkspace, projection, {
  ownerKind,
  cleanup,
  failureCode
}) {
  if (candidateWorkspace === undefined) return false;
  if (candidateWorkspace === null
    || typeof candidateWorkspace.cleanup !== 'function'
    || typeof candidateWorkspace.inspectResidue !== 'function') {
    cleanup.candidateWorkspaceRemoved = false;
    cleanup.warnings.push({
      phase: 'candidate-workspace-cleanup',
      failure: {
        code: failureCode,
        message: 'Candidate workspace residue inspection is unavailable.',
        details: null
      }
    });
    return false;
  }
  const records = ownerKind === 'reversion'
    ? (projection.reversions ?? [])
    : (projection.integrations ?? []);
  const knownIds = new Set(records.map((record) => record.id));
  const unboundIds = new Set(records
    .filter((record) => record.candidateRevision === null && !isActiveRecord(record))
    .map((record) => record.id));
  try {
    const before = await candidateWorkspace.inspectResidue();
    if (!isPlainObject(before)
      || !Array.isArray(before.entries)
      || !Array.isArray(before.candidateRefs)
      || before.candidateRefCount !== before.candidateRefs.length) {
      throw new TypeError('inspectResidue returned an invalid snapshot');
    }
    const relevant = before.entries.filter((entry) => knownIds.has(entry?.integrationId));
    const prunableRefs = before.candidateRefs.filter((entry) => (
      entry?.structurallyValid === true
      && unboundIds.has(entry.integrationId)
      && entry.candidateRef === `refs/fwa/integrations/${entry.integrationId}/candidate`
    ));
    const hadResidue = relevant.length > 0 || prunableRefs.length > 0;
    let complete = true;
    for (const entry of relevant) {
      const removed = await candidateWorkspace.cleanup({
        integrationId: entry.integrationId,
        workspacePath: entry.workspacePath,
        force: true
      });
      complete = complete && (removed?.removed === true || removed?.alreadyAbsent === true);
    }
    for (const entry of prunableRefs) {
      if (typeof candidateWorkspace.pruneCandidateRef !== 'function') {
        throw new TypeError('candidateWorkspace must provide pruneCandidateRef for orphan refs');
      }
      const pruned = await candidateWorkspace.pruneCandidateRef({
        integrationId: entry.integrationId,
        expectedRevision: entry.candidateRevision
      });
      complete = complete && (pruned?.removed === true || pruned?.alreadyAbsent === true);
    }
    const after = await candidateWorkspace.inspectResidue();
    if (!isPlainObject(after)
      || !Array.isArray(after.entries)
      || !Array.isArray(after.candidateRefs)
      || after.candidateRefCount !== after.candidateRefs.length) {
      throw new TypeError('inspectResidue returned an invalid snapshot');
    }
    const orphanRefRemains = after.candidateRefs.some((entry) => (
        entry?.structurallyValid === true
        && unboundIds.has(entry.integrationId)
        && entry.candidateRef === `refs/fwa/integrations/${entry.integrationId}/candidate`
      ));
    cleanup.candidateWorkspaceRemoved = complete
      && after.entries.every((entry) => !knownIds.has(entry?.integrationId))
      && !orphanRefRemains;
    if (!cleanup.candidateWorkspaceRemoved) {
      cleanup.warnings.push({
        phase: 'candidate-workspace-cleanup',
        failure: {
          code: failureCode,
          message: `Candidate workspace residue remains for ${ownerKind} operations.`,
          details: null
        }
      });
    }
    return hadResidue && cleanup.candidateWorkspaceRemoved;
  } catch (error) {
    cleanup.candidateWorkspaceRemoved = false;
    cleanup.warnings.push({
      phase: 'candidate-workspace-cleanup',
      failure: failureFrom(error, failureCode)
    });
    return false;
  }
}

function isActiveRecord(record) {
  return ['pending', 'running', 'recovery-required'].includes(record?.status);
}

function assertPort(port, name, methods) {
  if (port === null || typeof port !== 'object') {
    throw new IntegrationOrchestrationError(
      `${name} must be an adapter object.`,
      'invalid-integration-port'
    );
  }
  const missing = methods.filter((method) => typeof port[method] !== 'function');
  if (missing.length > 0) {
    throw new IntegrationOrchestrationError(
      `${name} is missing method(s): ${missing.join(', ')}.`,
      'invalid-integration-port',
      { port: name, missing }
    );
  }
  return port;
}

function isActiveRun(run) {
  return [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.PAUSED].includes(run.status);
}

function isActiveEvaluation(evaluation) {
  return [
    EvaluationStatus.REQUESTED,
    EvaluationStatus.RUNNING,
    EvaluationStatus.RECOVERY_REQUIRED
  ].includes(evaluation.status);
}

function isActiveIntegration(integration) {
  return [
    IntegrationStatus.PENDING,
    IntegrationStatus.RUNNING,
    IntegrationStatus.RECOVERY_REQUIRED
  ].includes(integration.status);
}

function isActiveReversion(reversion) {
  return [
    ReversionStatus.PENDING,
    ReversionStatus.RUNNING,
    ReversionStatus.RECOVERY_REQUIRED
  ].includes(reversion.status);
}

function isDeterministicIntegrationPreconditionError(error) {
  return [
    'integration-project-revision-mismatch',
    'integration-goal-target-mismatch'
  ].includes(error?.code);
}

function assertSerialOperationAvailable(projection) {
  const runs = projection.runs.filter(isActiveRun);
  const evaluations = (projection.evaluations ?? []).filter(isActiveEvaluation);
  const integrations = (projection.integrations ?? []).filter(isActiveIntegration);
  const reversions = (projection.reversions ?? []).filter(isActiveReversion);
  if (runs.length > 0 || evaluations.length > 0
    || integrations.length > 0 || reversions.length > 0) {
    throw new IntegrationOrchestrationError(
      'Another Run, Evaluation, or Integration is already active for this project.',
      'project-operation-active',
      {
        runIds: runs.map((run) => run.id),
        evaluationIds: evaluations.map((evaluation) => evaluation.id),
        integrationIds: integrations.map((integration) => integration.id),
        reversionIds: reversions.map((reversion) => reversion.id)
      }
    );
  }
}

function recordedBatch(storeState, commandId, intentHash) {
  const batch = storeState.batches.find((candidate) => candidate.commandId === commandId);
  if (!batch) return null;
  if (batch.intentHash !== intentHash) {
    throw new IntegrationOrchestrationError(
      `Command ${commandId} was already recorded with a different intent.`,
      'command-id-conflict',
      { commandId, expectedIntentHash: batch.intentHash, actualIntentHash: intentHash }
    );
  }
  return batch;
}

function eventFromBatch(batch, type) {
  const event = batch.events.find((candidate) => candidate.type === type);
  if (!event) {
    throw new IntegrationOrchestrationError(
      `Recorded command ${batch.commandId} has no ${type} event.`,
      'recorded-command-type-mismatch'
    );
  }
  return event;
}

function requireObjectId(value, name) {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) {
    throw new IntegrationOrchestrationError(
      `${name} must be a full Git object id.`,
      'invalid-integration-adapter-result'
    );
  }
  return value;
}

function validatePrepared(value, requested) {
  if (!isPlainObject(value)) {
    throw new IntegrationOrchestrationError(
      'The Git integration adapter returned no prepared candidate.',
      'invalid-integration-adapter-result'
    );
  }
  const candidateRevision = requireObjectId(value.candidateRevision, 'candidateRevision');
  const candidateTree = requireObjectId(value.candidateTree, 'candidateTree');
  for (const [field, expected] of [
    ['targetRef', requested.targetRef],
    ['expectedTargetRevision', requested.expectedTargetRevision],
    ['changeSetHeadRevision', requested.changeSetHeadRevision]
  ]) {
    if (value[field] !== undefined && value[field] !== expected) {
      throw new IntegrationOrchestrationError(
        `Prepared integration ${field} does not match its request.`,
        'invalid-integration-adapter-result',
        { field, expected, actual: value[field] }
      );
    }
  }
  return { candidateRevision, candidateTree };
}

function validateGatedPrepared(value, requested) {
  if (!isPlainObject(value)
    || !['prepared', 'conflicted'].includes(value.disposition)
    || value.kind !== 'merge'
    || value.integrationId !== requested.integrationId
    || value.targetRef !== requested.targetRef
    || value.expectedTargetRevision !== requested.expectedTargetRevision
    || value.sourceRevision !== requested.sourceRevision
    || typeof value.workspacePath !== 'string'
    || value.workspacePath.trim() === ''
    || value.candidateRef !== `refs/fwa/integrations/${requested.integrationId}/candidate`
    || !Array.isArray(value.conflicts)) {
    throw new IntegrationOrchestrationError(
      'The Git merge workspace returned an invalid candidate result.',
      'invalid-integration-adapter-result'
    );
  }
  if (value.disposition === 'conflicted') {
    if (value.candidateRevision !== null
      || value.candidateTree !== null
      || !Array.isArray(value.parents)
      || value.parents.length !== 0
      || value.conflicts.length === 0) {
      throw new IntegrationOrchestrationError(
        'The Git merge workspace returned contradictory conflict data.',
        'invalid-integration-adapter-result'
      );
    }
    return {
      disposition: 'conflicted',
      workspacePath: value.workspacePath,
      candidateRef: value.candidateRef,
      conflicts: cloneJson(value.conflicts)
    };
  }
  const candidateRevision = requireObjectId(value.candidateRevision, 'candidateRevision');
  const candidateTree = requireObjectId(value.candidateTree, 'candidateTree');
  if (!Array.isArray(value.parents)
    || value.parents.length !== 2
    || value.parents[0] !== requested.expectedTargetRevision
    || value.parents[1] !== requested.sourceRevision
    || value.conflicts.length !== 0
    || typeof value.patch !== 'string'
    || !Array.isArray(value.changedFiles)
    || !Array.isArray(value.changes)) {
    throw new IntegrationOrchestrationError(
      'The merge candidate does not have the required ordered parents.',
      'invalid-integration-adapter-result'
    );
  }
  const effects = validateCandidateEffects(value, 'merge', 'invalid-integration-adapter-result');
  return {
    disposition: 'prepared',
    workspacePath: value.workspacePath,
    candidateRef: value.candidateRef,
    candidateRevision,
    candidateTree,
    parents: [...value.parents],
    ...effects,
    conflicts: []
  };
}

function validateCandidateEffects(value, kind, errorCode) {
  if (value.patch.length === 0 || value.changedFiles.length === 0 || value.changes.length === 0) {
    throw new IntegrationOrchestrationError(
      `The ${kind} candidate must contain a non-empty patch and changed effects.`,
      errorCode
    );
  }
  const changedFiles = value.changedFiles.map((file, index) => {
    try {
      return normalizeWorkspacePath(file, { path: `changedFiles[${index}]` });
    } catch (error) {
      throw new IntegrationOrchestrationError(
        `The ${kind} candidate contains an unsafe changed path: ${error.message}`,
        errorCode
      );
    }
  });
  if (new Set(changedFiles).size !== changedFiles.length
    || stableStringify(changedFiles) !== stableStringify(
      [...changedFiles].sort((left, right) => left.localeCompare(right, 'en'))
    )) {
    throw new IntegrationOrchestrationError(
      `The ${kind} candidate changedFiles must be unique and sorted.`,
      errorCode
    );
  }
  const changes = cloneJson(value.changes);
  if (!Array.isArray(changes)
    || changes.some((change) => !isPlainObject(change)
      || typeof change.status !== 'string'
      || change.status.length === 0
      || change.status !== change.status.trim()
      || typeof change.path !== 'string')) {
    throw new IntegrationOrchestrationError(
      `The ${kind} candidate changes are malformed.`,
      errorCode
    );
  }
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    for (const field of ['path', 'previousPath', 'renamedTo']) {
      if (change[field] === undefined) continue;
      try {
        change[field] = normalizeWorkspacePath(change[field], {
          path: `changes[${index}].${field}`
        });
      } catch (error) {
        throw new IntegrationOrchestrationError(
          `The ${kind} candidate contains an unsafe changed path: ${error.message}`,
          errorCode
        );
      }
    }
  }
  const filesFromChanges = [...new Set(changes.flatMap((change) => [
    change.path,
    ...(change.previousPath === undefined ? [] : [change.previousPath])
  ]))].sort((left, right) => left.localeCompare(right, 'en'));
  if (stableStringify(filesFromChanges) !== stableStringify(changedFiles)) {
    throw new IntegrationOrchestrationError(
      `The ${kind} candidate changes and changedFiles disagree.`,
      errorCode
    );
  }
  return { changedFiles, changes, patch: value.patch };
}

function validateRevertPrepared(value, requested) {
  if (!isPlainObject(value)
    || !['prepared', 'conflicted'].includes(value.disposition)
    || value.kind !== 'revert'
    || value.integrationId !== requested.reversionId
    || value.targetRef !== requested.targetRef
    || value.expectedTargetRevision !== requested.expectedTargetRevision
    || value.revertedRevision !== requested.revertedRevision
    || typeof value.workspacePath !== 'string'
    || value.workspacePath.trim() === ''
    || value.candidateRef !== `refs/fwa/integrations/${requested.reversionId}/candidate`
    || !Array.isArray(value.conflicts)) {
    throw new IntegrationOrchestrationError(
      'The Git revert workspace returned an invalid candidate result.',
      'invalid-reversion-adapter-result'
    );
  }
  if (value.disposition === 'conflicted') {
    if (value.candidateRevision !== null
      || value.candidateTree !== null
      || !Array.isArray(value.parents)
      || value.parents.length !== 0
      || value.conflicts.length === 0) {
      throw new IntegrationOrchestrationError(
        'The Git revert workspace returned contradictory conflict data.',
        'invalid-reversion-adapter-result'
      );
    }
    return {
      disposition: 'conflicted',
      workspacePath: value.workspacePath,
      candidateRef: value.candidateRef,
      conflicts: cloneJson(value.conflicts)
    };
  }
  const candidateRevision = requireObjectId(value.candidateRevision, 'candidateRevision');
  const candidateTree = requireObjectId(value.candidateTree, 'candidateTree');
  if (!Array.isArray(value.parents)
    || value.parents.length !== 1
    || value.parents[0] !== requested.expectedTargetRevision
    || value.conflicts.length !== 0
    || typeof value.patch !== 'string'
    || !Array.isArray(value.changedFiles)
    || !Array.isArray(value.changes)) {
    throw new IntegrationOrchestrationError(
      'The revert candidate does not satisfy the required single-parent contract.',
      'invalid-reversion-adapter-result'
    );
  }
  const effects = validateCandidateEffects(value, 'revert', 'invalid-reversion-adapter-result');
  return {
    disposition: 'prepared',
    workspacePath: value.workspacePath,
    candidateRef: value.candidateRef,
    candidateRevision,
    candidateTree,
    parents: [...value.parents],
    ...effects,
    conflicts: []
  };
}

function validateRegressionEvidence(value, integration) {
  const requiredKeys = [
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
  ];
  const criteriaPass = Array.isArray(value?.criteria)
    && value.criteria.length > 0
    && value.criteria.every((criterion) => isPlainObject(criterion)
      && ['pass', 'fail'].includes(criterion.result));
  const derivedRegressionResult = criteriaPass
    && value.criteria.every((criterion) => criterion.result === 'pass')
    && Array.isArray(value?.policyViolations)
    && value.policyViolations.length === 0
    ? 'pass'
    : 'fail';
  const derivedResult = derivedRegressionResult === 'pass'
    && value?.cleanup?.status === 'succeeded'
    ? 'pass'
    : 'fail';
  const criterionKinds = new Set(
    Array.isArray(value?.criteria) ? value.criteria.map((criterion) => criterion?.kind) : []
  );
  if (!hasExactKeys(value, requiredKeys)
    || value.schemaVersion !== 1
    || value.kind !== 'integration-regression-gate'
    || value.integrationId !== integration.id
    || value.candidateRevision !== integration.candidateRevision
    || !['pass', 'fail'].includes(value.result)
    || !['pass', 'fail'].includes(value.regressionResult)
    || !isPlainObject(value.profile)
    || value.profile.sha256 !== integration.regressionProfileHash
    || !isPlainObject(value.profileArtifact)
    || !isPlainObject(value.resultArtifact)
    || !Array.isArray(value.criteria)
    || !Array.isArray(value.policyViolations)
    || !isPlainObject(value.cleanup)
    || !isPlainObject(value.evaluator)
    || !isPlainObject(value.environmentFingerprint)
    || !isPlainObject(value.workspace)
    || value.workspace.evaluationId !== integration.id
    || value.workspace.headRevision !== integration.candidateRevision
    || value.workspace.detached !== true
    || value.regressionResult !== derivedRegressionResult
    || value.result !== derivedResult
    || (value.result === 'pass'
      && (!criterionKinds.has('compile') || !criterionKinds.has('test')))) {
    throw new IntegrationOrchestrationError(
      'The integration regression gate returned invalid or unbound Evidence.',
      'invalid-integration-regression-result'
    );
  }
  const cloned = cloneJson(value);
  if (cloned === null) {
    throw new IntegrationOrchestrationError(
      'The integration regression gate returned non-JSON Evidence.',
      'invalid-integration-regression-result'
    );
  }
  return cloned;
}

function validatePreparedInspection(value, requested) {
  if (!isPlainObject(value)
    || !['not-applied', 'applied', 'advanced', 'diverged', 'inconsistent'].includes(
      value.disposition
    )
    || value.targetRef !== requested.targetRef
    || value.expectedTargetRevision !== requested.expectedTargetRevision
    || value.candidateRevision !== requested.candidateRevision
    || value.candidateTree !== requested.candidateTree
    || stableStringify(value.parents) !== stableStringify(requested.parents)
    || value.observedTargetRevision !== value.targetRevision
    || typeof value.containsCandidate !== 'boolean'
    || (requested.patchDigest !== undefined && (
      value.patchDigest !== requested.patchDigest
      || stableStringify(value.changedFiles) !== stableStringify(requested.changedFiles)
      || stableStringify(value.changes) !== stableStringify(requested.changes)
    ))) {
    throw new IntegrationOrchestrationError(
      'The Git promotion adapter returned an invalid prepared-candidate inspection.',
      'invalid-integration-adapter-result'
    );
  }
  return value;
}

function validateInspection(value, requested) {
  if (!isPlainObject(value)
    || !['not-applied', 'applied', 'advanced', 'diverged', 'inconsistent'].includes(
      value.disposition
    )) {
    throw new IntegrationOrchestrationError(
      'The Git integration adapter returned an invalid inspection.',
      'invalid-integration-adapter-result'
    );
  }
  for (const field of [
    'targetRef',
    'expectedTargetRevision',
    'changeSetHeadRevision',
    'candidateRevision',
    'candidateTree'
  ]) {
    if (value[field] !== requested[field]) {
      throw new IntegrationOrchestrationError(
        `Inspected integration ${field} does not match its request.`,
        'invalid-integration-adapter-result',
        { field, expected: requested[field], actual: value[field] }
      );
    }
  }
  const targetRevision = value.targetRevision === null
    ? null
    : requireObjectId(value.targetRevision, 'targetRevision');
  if (value.observedTargetRevision !== targetRevision
    || typeof value.containsCandidate !== 'boolean') {
    throw new IntegrationOrchestrationError(
      'The Git integration inspection omitted or contradicted its observed target state.',
      'invalid-integration-adapter-result'
    );
  }
  const isOtherRevision = targetRevision !== null
    && targetRevision !== requested.expectedTargetRevision
    && targetRevision !== requested.candidateRevision;
  const semanticMatch = (
    value.disposition === 'not-applied'
      ? targetRevision === requested.expectedTargetRevision && !value.containsCandidate
      : value.disposition === 'applied'
        ? targetRevision === requested.candidateRevision && value.containsCandidate
        : value.disposition === 'advanced'
          ? isOtherRevision && value.containsCandidate
          : value.disposition === 'diverged'
            ? isOtherRevision && !value.containsCandidate
            : !value.containsCandidate
  );
  if (!semanticMatch) {
    throw new IntegrationOrchestrationError(
      `The Git integration inspection has contradictory ${value.disposition} semantics.`,
      'invalid-integration-adapter-result',
      {
        disposition: value.disposition,
        targetRevision,
        containsCandidate: value.containsCandidate
      }
    );
  }
  return value;
}



function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error
    ? signal.reason
    : new Error('Integration was aborted.');
  if (typeof reason.code !== 'string') reason.code = 'FWA_INTEGRATION_ABORTED';
  throw reason;
}

async function verifyEvidenceArtifacts(artifacts, evidence) {
  const refs = [evidence.profileArtifact, evidence.resultArtifact];
  for (const criterion of evidence.criteria) {
    refs.push(criterion.stdoutArtifact, criterion.stderrArtifact);
    for (const expected of criterion.expectedArtifacts) {
      if (expected.artifact !== null) refs.push(expected.artifact);
    }
  }
  for (const ref of refs) await artifacts.verify(ref);
}

function parseCanonicalRegressionArtifact(bytes, name) {
  let source;
  let value;
  try {
    source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) {
      throw new TypeError('bytes are not canonical UTF-8');
    }
    value = JSON.parse(source);
  } catch (error) {
    throw new IntegrationOrchestrationError(
      `${name} is not valid UTF-8 JSON: ${error.message}`,
      'invalid-integration-regression-artifact'
    );
  }
  if (!isPlainObject(value) || stableStringify(value) !== source) {
    throw new IntegrationOrchestrationError(
      `${name} is not a canonical JSON object.`,
      'invalid-integration-regression-artifact'
    );
  }
  return value;
}

async function verifyRegressionEvidenceArtifacts(artifacts, evidence, integration) {
  const refs = [evidence.profileArtifact, evidence.resultArtifact];
  for (const criterion of evidence.criteria) {
    refs.push(criterion.stdoutArtifact, criterion.stderrArtifact);
    for (const expected of criterion.expectedArtifacts ?? []) {
      if (expected.artifact !== null) refs.push(expected.artifact);
    }
  }
  for (const ref of refs) await artifacts.verify(ref);

  const profile = parseCanonicalRegressionArtifact(
    await artifacts.get(evidence.profileArtifact),
    `Integration ${integration.id} regression profile artifact`
  );
  const profileMatches = evidence.profile.sha256 === `sha256:${evidence.profileArtifact.digest}`
    && evidence.profile.sha256 === integration.regressionProfileHash
    && evidence.profile.id === profile.id
    && evidence.profile.schemaVersion === profile.schemaVersion
    && Array.isArray(profile.checks)
    && profile.checks.length === evidence.criteria.length
    && profile.checks.every((check, index) => {
      const criterion = evidence.criteria[index];
      return isPlainObject(check)
        && criterion.id === check.id
        && criterion.kind === check.kind
        && criterion.command?.command === check.command
        && stableStringify(criterion.command?.args) === stableStringify(check.args)
        && criterion.command?.cwd === (check.cwd ?? '.');
    });
  if (!profileMatches) {
    throw new IntegrationOrchestrationError(
      `Integration ${integration.id} regression profile artifact is not bound to its Evidence.`,
      'invalid-integration-regression-artifact'
    );
  }
  const profileBinding = validateEvidenceAgainstProfile(profile, evidence);
  if (!profileBinding.ok) {
    throw new IntegrationOrchestrationError(
      `Integration ${integration.id} regression Evidence violates its normalized profile.`,
      'invalid-integration-regression-artifact',
      { errors: profileBinding.errors }
    );
  }

  const resultEnvelope = parseCanonicalRegressionArtifact(
    await artifacts.get(evidence.resultArtifact),
    `Integration ${integration.id} regression result artifact`
  );
  const expectedEnvelope = {
    schemaVersion: 1,
    kind: 'integration-regression-result',
    integrationId: evidence.integrationId,
    candidateRevision: evidence.candidateRevision,
    evaluator: evidence.evaluator,
    profile: evidence.profile,
    environmentFingerprint: evidence.environmentFingerprint,
    result: evidence.regressionResult,
    criteria: evidence.criteria,
    policyViolations: evidence.policyViolations
  };
  if (stableStringify(resultEnvelope) !== stableStringify(expectedEnvelope)) {
    throw new IntegrationOrchestrationError(
      `Integration ${integration.id} regression result artifact is not bound to its Evidence.`,
      'invalid-integration-regression-artifact'
    );
  }
}

function candidateExecutionEnvelope(record, kind) {
  if (kind === 'merge') {
    return {
      schemaVersion: 1,
      kind: 'merge-candidate',
      integrationId: record.id,
      sourceChangeSetId: record.changeSetId,
      targetRef: record.targetRef,
      expectedTargetRevision: record.expectedTargetRevision,
      sourceRevision: record.headRevision,
      candidateRevision: record.candidateRevision,
      candidateTree: record.candidateTree,
      parents: record.candidateParents,
      changedFiles: record.changedFiles,
      changes: record.changes,
      changedRefIds: record.changedRefIds,
      patchArtifact: record.patchArtifact
    };
  }
  return {
    schemaVersion: 1,
    kind: 'reversion-candidate',
    reversionId: record.id,
    sourceChangeSetId: record.sourceChangeSetId,
    sourceIntegrationId: record.integrationId,
    targetRef: record.targetRef,
    expectedTargetRevision: record.expectedTargetRevision,
    revertedRevision: record.revertedRevision,
    candidateRevision: record.candidateRevision,
    candidateTree: record.candidateTree,
    parents: record.candidateParents,
    changedFiles: record.changedFiles,
    changes: record.changes,
    changedRefIds: record.changedRefIds,
    patchArtifact: record.patchArtifact
  };
}

async function verifyCandidateArtifacts(artifacts, record, kind) {
  await artifacts.verify(record.patchArtifact);
  await artifacts.verify(record.executionArtifact);
  const patchBytes = await artifacts.get(record.patchArtifact);
  const executionBytes = await artifacts.get(record.executionArtifact);
  if (!Buffer.isBuffer(patchBytes)
    || patchBytes.byteLength !== record.patchArtifact.size
    || createHash('sha256').update(patchBytes).digest('hex') !== record.patchArtifact.digest
    || patchBytes.byteLength === 0) {
    throw new IntegrationOrchestrationError(
      `${kind === 'merge' ? 'Integration' : 'Reversion'} ${record.id} patch artifact bytes do not match its ArtifactRef.`,
      'invalid-integration-candidate-artifact'
    );
  }
  if (!Buffer.isBuffer(executionBytes)
    || executionBytes.byteLength !== record.executionArtifact.size
    || createHash('sha256').update(executionBytes).digest('hex')
      !== record.executionArtifact.digest) {
    throw new IntegrationOrchestrationError(
      `${kind === 'merge' ? 'Integration' : 'Reversion'} ${record.id} execution artifact bytes do not match its ArtifactRef.`,
      'invalid-integration-candidate-artifact'
    );
  }
  const envelope = parseCanonicalRegressionArtifact(
    executionBytes,
    `${kind === 'merge' ? 'Integration' : 'Reversion'} ${record.id} candidate execution artifact`
  );
  if (stableStringify(envelope) !== stableStringify(candidateExecutionEnvelope(record, kind))) {
    throw new IntegrationOrchestrationError(
      `${kind === 'merge' ? 'Integration' : 'Reversion'} ${record.id} candidate artifacts are not bound to its durable record.`,
      'invalid-integration-candidate-artifact'
    );
  }
}

export class IntegrationOrchestrator {
  constructor(projectRoot, {
    store,
    clock = () => new Date(),
    idFactory,
    actor = 'cli',
    lockRetryDelays = DEFAULT_LOCK_RETRY_DELAYS
  } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new TypeError('projectRoot must be a non-empty string.');
    }
    if (store === null || typeof store !== 'object'
      || typeof store.readAll !== 'function'
      || typeof store.appendBatch !== 'function') {
      throw new TypeError('store must provide readAll and appendBatch.');
    }
    if (typeof clock !== 'function' || typeof idFactory !== 'function') {
      throw new TypeError('clock and idFactory must be functions.');
    }
    if (!Array.isArray(lockRetryDelays)
      || lockRetryDelays.some((delay) => !Number.isInteger(delay) || delay < 0)) {
      throw new TypeError('lockRetryDelays must contain non-negative integers.');
    }
    this.projectRoot = path.resolve(projectRoot);
    this.store = store;
    this.clock = clock;
    this.idFactory = idFactory;
    this.actor = requireTrimmedString(actor, 'actor');
    this.lockRetryDelays = [...lockRetryDelays];
  }

  async integrateChangeSet({
    changeSetId,
    targetRef,
    workspace,
    lease,
    artifacts,
    commandId,
    signal,
    leaseTtlMs
  } = {}) {
    assertPort(workspace, 'workspace', ['verifyChangeSet', 'prepare', 'promote', 'inspect']);
    assertPort(lease, 'lease', [
      'init', 'inspect', 'acquire', 'heartbeat', 'release', 'archiveStale'
    ]);
    assertPort(artifacts, 'artifacts', ['init', 'verify']);
    const normalizedChangeSetId = requireTrimmedString(changeSetId, 'changeSetId');
    const normalizedTargetRef = normalizeIntegrationTargetRef(targetRef);
    const normalizedCommandId = commandId === undefined
      ? this.#id('command')
      : requirePublicCommandId(commandId);
    const ttlMs = requireSafeDuration(leaseTtlMs, 'leaseTtlMs', DEFAULT_LEASE_TTL_MS);
    const intent = {
      schemaVersion: 1,
      type: 'IntegrateChangeSet',
      changeSetId: normalizedChangeSetId,
      targetRef: normalizedTargetRef,
      strategy: STRATEGY
    };
    const intentHash = hashCanonicalValue(intent);
    let state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
    if (existing) {
      return this.#existingResult(
        state,
        normalizedCommandId,
        eventFromBatch(existing, 'IntegrationRequested').payload.integrationId,
        lease
      );
    }

    await retryUnstartedLeaseOperation(lease, () => lease.init());
    await artifacts.init();
    const integrationId = this.#id('integration');
    let capability;
    let heartbeat = null;
    let requestedRecorded = false;
    const cleanup = { leaseReleased: false, warnings: [] };

    try {
      capability = await retryUnstartedLeaseOperation(lease, () => lease.acquire({
        ownerKind: 'integration',
        ownerId: integrationId,
        ttlMs
      }));
      state = await this.#readState();
      const racedExisting = recordedBatch(state.store, normalizedCommandId, intentHash);
      if (racedExisting) {
        const replay = await this.#existingResult(
          state,
          normalizedCommandId,
          eventFromBatch(racedExisting, 'IntegrationRequested').payload.integrationId,
          lease
        );
        return { ...replay, cleanup };
      }
      assertSerialOperationAvailable(state.projection);
      let selected = this.#selectAcceptedChangeSet(
        state.projection,
        normalizedChangeSetId,
        normalizedTargetRef
      );
      await verifyEvidenceArtifacts(artifacts, selected.evidence);
      await workspace.verifyChangeSet(selected.changeSet);
      throwIfAborted(signal);

      await this.#appendDerived({
        commandId: normalizedCommandId,
        correlationId: normalizedCommandId,
        intent,
        build: (latest) => {
          assertSerialOperationAvailable(latest.projection);
          const current = this.#selectAcceptedChangeSet(
            latest.projection,
            normalizedChangeSetId,
            normalizedTargetRef
          );
          return [
            {
              type: 'IntegrationRequested',
              streamId: `integration:${integrationId}`,
              payload: {
                integrationId,
                nodeId: current.node.id,
                runId: current.run.id,
                changeSetId: current.changeSet.id,
                evaluationId: current.evaluation.id,
                evidenceId: current.evidence.id,
                baseRevision: current.changeSet.baseRevision,
                headRevision: current.changeSet.headRevision,
                targetRef: normalizedTargetRef,
                expectedTargetRevision: current.changeSet.baseRevision,
                strategy: STRATEGY
              }
            },
            {
              type: 'NodeIntegrationRequested',
              streamId: `node:${current.node.id}`,
              payload: {
                integrationId,
                nodeId: current.node.id,
                changeSetId: current.changeSet.id
              }
            }
          ];
        }
      });
      requestedRecorded = true;

      await this.#appendDerived({
        commandId: this.#internalCommand(integrationId, 'started'),
        correlationId: normalizedCommandId,
        intent: {
          schemaVersion: 1,
          type: 'StartIntegration',
          integrationId,
          leaseId: capability.lease.leaseId
        },
        build: (latest) => {
          const integration = this.#requireIntegration(latest.projection, integrationId);
          const node = latest.projection.nodes.find(
            (candidate) => candidate.id === integration.nodeId
          );
          if (integration.status !== IntegrationStatus.PENDING
            || node?.activeIntegrationId !== integrationId) {
            throw new IntegrationOrchestrationError(
              `Integration ${integrationId} is no longer startable.`,
              'integration-not-pending'
            );
          }
          return [
            {
              type: 'IntegrationExecutionStarted',
              streamId: `integration:${integrationId}`,
              payload: { integrationId, leaseId: capability.lease.leaseId }
            },
            {
              type: 'NodeIntegrationStarted',
              streamId: `node:${node.id}`,
              payload: {
                integrationId,
                nodeId: node.id,
                changeSetId: integration.changeSetId
              }
            }
          ];
        }
      });

      heartbeat = startLeaseHeartbeat(lease, capability, ttlMs, signal);
      selected = this.#selectIntegrationInputs((await this.#readState()).projection, integrationId);
      throwIfAborted(heartbeat.signal);
      const requested = this.#gitRequest(selected.integration);
      const prepared = validatePrepared(await workspace.prepare(requested), requested);
      await this.#recordPrepared({
        integrationId,
        correlationId: normalizedCommandId,
        ...prepared
      });
      throwIfAborted(heartbeat.signal);

      const durableState = await this.#readState();
      const durable = this.#requireIntegration(durableState.projection, integrationId);
      this.#assertDurableIntegrationPreconditions(durableState.projection, durable);
      const durableRequest = this.#gitRequest(durable);
      await workspace.promote(durableRequest);
      const inspection = validateInspection(
        await workspace.inspect(durableRequest),
        durableRequest
      );
      if (inspection.disposition !== 'applied') {
        throw new IntegrationOrchestrationError(
          `Git did not prove that integration ${integrationId} reached ${durable.targetRef}.`,
          'integration-promotion-unproven',
          { inspection }
        );
      }
      await heartbeat.stop();
      heartbeat = null;
      await this.#recordApplied({ integrationId, correlationId: normalizedCommandId });
      return this.#integrationResult(normalizedCommandId, integrationId, true, cleanup);
    } catch (error) {
      if (heartbeat) {
        try {
          await heartbeat.stop();
        } catch (heartbeatError) {
          if (error?.heartbeatError === undefined) error.heartbeatError = heartbeatError;
        }
        heartbeat = null;
      }
      if (!requestedRecorded) throw error;
      await this.#settleFailedAttempt({
        integrationId,
        correlationId: normalizedCommandId,
        workspace,
        error
      });
      return this.#integrationResult(normalizedCommandId, integrationId, true, cleanup);
    } finally {
      if (capability) {
        try {
          await retryUnstartedLeaseOperation(lease, () => lease.release({
            leaseId: capability.lease.leaseId,
            ownerToken: capability.ownerToken
          }));
          cleanup.leaseReleased = true;
        } catch (error) {
          cleanup.warnings.push({
            phase: 'lease-release',
            failure: failureFrom(error, 'INTEGRATION_LEASE_RELEASE_FAILED')
          });
        }
      }
    }
  }

  async integrateChangeSetGated({
    changeSetId,
    targetRef,
    candidateWorkspace,
    promotion,
    evaluator,
    profile,
    evaluationWorkspace,
    regressionGate = runIntegrationRegressionGate,
    lease,
    artifacts,
    commandId,
    signal,
    leaseTtlMs
  } = {}) {
    assertPort(candidateWorkspace, 'candidateWorkspace', ['prepareMerge', 'cleanup']);
    assertPort(promotion, 'promotion', [
      'verifyChangeSet', 'promotePrepared', 'inspectPrepared'
    ]);
    assertPort(evaluator, 'evaluator', ['normalizeProfile', 'evaluate']);
    assertPort(evaluationWorkspace, 'evaluationWorkspace', [
      'createEvaluation', 'inspectEvaluation', 'removeEvaluation'
    ]);
    assertPort(lease, 'lease', [
      'init', 'inspect', 'acquire', 'heartbeat', 'release', 'archiveStale'
    ]);
    assertPort(artifacts, 'artifacts', ['init', 'get', 'put', 'verify']);
    if (typeof regressionGate !== 'function') {
      throw new IntegrationOrchestrationError(
        'regressionGate must be a function.',
        'invalid-integration-port'
      );
    }
    const normalizedChangeSetId = requireTrimmedString(changeSetId, 'changeSetId');
    const normalizedTargetRef = normalizeIntegrationTargetRef(targetRef);
    const normalizedCommandId = commandId === undefined
      ? this.#id('command')
      : requirePublicCommandId(commandId);
    const ttlMs = requireSafeDuration(leaseTtlMs, 'leaseTtlMs', DEFAULT_LEASE_TTL_MS);
    let normalizedProfile;
    try {
      normalizedProfile = cloneJson(evaluator.normalizeProfile(profile));
    } catch (error) {
      throw new IntegrationOrchestrationError(
        `Integration regression profile is invalid: ${error.message}`,
        'invalid-integration-profile',
        { cause: failureFrom(error, 'INVALID_PROFILE') }
      );
    }
    if (!isPlainObject(normalizedProfile)) {
      throw new IntegrationOrchestrationError(
        'Integration regression profile must normalize to a JSON object.',
        'invalid-integration-profile'
      );
    }
    const checkKinds = Array.isArray(normalizedProfile.checks)
      ? new Set(normalizedProfile.checks.map((check) => check?.kind))
      : new Set();
    if (!checkKinds.has('compile') || !checkKinds.has('test')) {
      throw new IntegrationOrchestrationError(
        'Integration regression profile must contain both compile and test checks.',
        'incomplete-integration-regression-profile',
        { requiredKinds: ['compile', 'test'], actualKinds: [...checkKinds].sort() }
      );
    }
    const regressionProfileHash = `sha256:${hashCanonicalValue(normalizedProfile)}`;
    const intent = {
      schemaVersion: 1,
      type: 'IntegrateChangeSet',
      changeSetId: normalizedChangeSetId,
      targetRef: normalizedTargetRef,
      strategy: GATED_MERGE_STRATEGY,
      regressionProfileHash
    };
    const intentHash = hashCanonicalValue(intent);
    let state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
    if (existing) {
      return this.#existingResult(
        state,
        normalizedCommandId,
        eventFromBatch(existing, 'IntegrationRequested').payload.integrationId,
        lease,
        candidateWorkspace
      );
    }

    await retryUnstartedLeaseOperation(lease, () => lease.init());
    await artifacts.init();
    const integrationId = this.#id('integration');
    let capability;
    let heartbeat = null;
    let requestedRecorded = false;
    let prepared = null;
    let candidateCleanupOwned = false;
    let promotionAttempted = false;
    const cleanup = {
      leaseReleased: false,
      candidateWorkspaceRemoved: false,
      warnings: []
    };
    try {
      capability = await retryUnstartedLeaseOperation(lease, () => lease.acquire({
        ownerKind: 'integration',
        ownerId: integrationId,
        ttlMs
      }));
      state = await this.#readState();
      const racedExisting = recordedBatch(state.store, normalizedCommandId, intentHash);
      if (racedExisting) {
        return this.#existingResult(
          state,
          normalizedCommandId,
          eventFromBatch(racedExisting, 'IntegrationRequested').payload.integrationId,
          lease,
          candidateWorkspace
        );
      }
      assertSerialOperationAvailable(state.projection);
      let selected = this.#selectAcceptedChangeSet(
        state.projection,
        normalizedChangeSetId,
        normalizedTargetRef,
        { allowDivergentBase: true }
      );
      await verifyEvidenceArtifacts(artifacts, selected.evidence);
      await promotion.verifyChangeSet(selected.changeSet);
      throwIfAborted(signal);
      const expectedTargetRevision = this.#expectedTargetRevision(
        state.projection,
        normalizedTargetRef,
        selected.changeSet.baseRevision
      );

      await this.#appendDerived({
        commandId: normalizedCommandId,
        correlationId: normalizedCommandId,
        intent,
        build: (latest) => {
          assertSerialOperationAvailable(latest.projection);
          const current = this.#selectAcceptedChangeSet(
            latest.projection,
            normalizedChangeSetId,
            normalizedTargetRef,
            { allowDivergentBase: true }
          );
          const currentTarget = this.#expectedTargetRevision(
            latest.projection,
            normalizedTargetRef,
            current.changeSet.baseRevision
          );
          if (currentTarget !== expectedTargetRevision) {
            throw new IntegrationOrchestrationError(
              'The target revision changed while the gated Integration was being scheduled.',
              'integration-project-revision-mismatch'
            );
          }
          return [{
            type: 'IntegrationRequested',
            streamId: `integration:${integrationId}`,
            payload: {
              integrationId,
              nodeId: current.node.id,
              runId: current.run.id,
              changeSetId: current.changeSet.id,
              evaluationId: current.evaluation.id,
              evidenceId: current.evidence.id,
              baseRevision: current.changeSet.baseRevision,
              headRevision: current.changeSet.headRevision,
              targetRef: normalizedTargetRef,
              expectedTargetRevision,
              strategy: GATED_MERGE_STRATEGY,
              regressionProfileHash
            }
          }, {
            type: 'NodeIntegrationRequested',
            streamId: `node:${current.node.id}`,
            payload: {
              integrationId,
              nodeId: current.node.id,
              changeSetId: current.changeSet.id
            }
          }];
        }
      });
      requestedRecorded = true;

      await this.#appendDerived({
        commandId: this.#internalCommand(integrationId, 'started'),
        correlationId: normalizedCommandId,
        intent: { schemaVersion: 1, type: 'StartIntegration', integrationId },
        build: (latest) => {
          const integration = this.#requireIntegration(latest.projection, integrationId);
          const node = latest.projection.nodes.find(
            (candidate) => candidate.id === integration.nodeId
          );
          if (integration.status !== IntegrationStatus.PENDING
            || node?.activeIntegrationId !== integrationId) {
            throw new IntegrationOrchestrationError(
              `Integration ${integrationId} is no longer startable.`,
              'integration-not-pending'
            );
          }
          return [{
            type: 'IntegrationExecutionStarted',
            streamId: `integration:${integrationId}`,
            payload: { integrationId, leaseId: capability.lease.leaseId }
          }, {
            type: 'NodeIntegrationStarted',
            streamId: `node:${node.id}`,
            payload: {
              integrationId,
              nodeId: node.id,
              changeSetId: integration.changeSetId
            }
          }];
        }
      });

      heartbeat = startLeaseHeartbeat(lease, capability, ttlMs, signal);
      selected = this.#selectIntegrationInputs((await this.#readState()).projection, integrationId);
      throwIfAborted(heartbeat.signal);
      candidateCleanupOwned = true;
      prepared = validateGatedPrepared(await candidateWorkspace.prepareMerge({
        integrationId,
        targetRef: selected.integration.targetRef,
        expectedTargetRevision: selected.integration.expectedTargetRevision,
        sourceRevision: selected.integration.headRevision
      }), {
        integrationId,
        targetRef: selected.integration.targetRef,
        expectedTargetRevision: selected.integration.expectedTargetRevision,
        sourceRevision: selected.integration.headRevision
      });
      if (prepared.disposition === 'conflicted') {
        await this.#recordConflicted({
          integrationId,
          correlationId: normalizedCommandId,
          workspacePath: prepared.workspacePath,
          candidateRef: prepared.candidateRef,
          conflicts: prepared.conflicts
        });
        await heartbeat.stop();
        heartbeat = null;
        return this.#integrationResult(normalizedCommandId, integrationId, true, cleanup);
      }
      const preparedState = await this.#readState();
      const changedRefIds = candidateChangedRefIds(
        preparedState.projection.refs,
        prepared.changedFiles,
        { ignoreCase: selected.changeSet.coreIgnoreCase }
      );
      const patchArtifact = await artifacts.put(prepared.patch);
      const executionArtifact = await artifacts.put(stableStringify({
        schemaVersion: 1,
        kind: 'merge-candidate',
        integrationId,
        sourceChangeSetId: selected.changeSet.id,
        targetRef: selected.integration.targetRef,
        expectedTargetRevision: selected.integration.expectedTargetRevision,
        sourceRevision: selected.integration.headRevision,
        candidateRevision: prepared.candidateRevision,
        candidateTree: prepared.candidateTree,
        parents: prepared.parents,
        changedFiles: prepared.changedFiles,
        changes: prepared.changes,
        changedRefIds,
        patchArtifact
      }));
      await artifacts.verify(patchArtifact);
      await artifacts.verify(executionArtifact);
      prepared = {
        ...prepared,
        changedRefIds,
        patchArtifact,
        executionArtifact
      };
      await this.#recordPreparedGated({
        integrationId,
        correlationId: normalizedCommandId,
        ...prepared
      });
      throwIfAborted(heartbeat.signal);

      const durable = this.#requireIntegration(
        (await this.#readState()).projection,
        integrationId
      );
      const regressionEvidence = validateRegressionEvidence(await regressionGate({
        integrationId,
        candidateRevision: durable.candidateRevision,
        profile: normalizedProfile,
        evaluator,
        workspace: evaluationWorkspace,
        artifacts,
        signal: heartbeat.signal
      }), durable);
      await verifyRegressionEvidenceArtifacts(artifacts, regressionEvidence, durable);
      await this.#recordRegression({
        integrationId,
        correlationId: normalizedCommandId,
        evidence: regressionEvidence
      });
      if (regressionEvidence.result !== 'pass') {
        await this.#recordFailed({
          integrationId,
          correlationId: normalizedCommandId,
          phase: 'regression',
          failure: {
            code: 'INTEGRATION_REGRESSION_REJECTED',
            message: 'The prepared candidate did not pass its integration regression gate.',
            details: {
              regressionResult: regressionEvidence.regressionResult,
              policyViolations: regressionEvidence.policyViolations,
              cleanup: regressionEvidence.cleanup
            }
          }
        });
        await heartbeat.stop();
        heartbeat = null;
        return this.#integrationResult(normalizedCommandId, integrationId, true, cleanup);
      }

      const durableState = await this.#readState();
      const durableIntegration = this.#requireIntegration(
        durableState.projection,
        integrationId
      );
      await verifyRegressionEvidenceArtifacts(
        artifacts,
        durableIntegration.regressionEvidence,
        durableIntegration
      );
      await verifyCandidateArtifacts(artifacts, durableIntegration, 'merge');
      this.#assertDurableIntegrationPreconditions(
        durableState.projection,
        durableIntegration
      );
      const promotionRequest = this.#preparedPromotionRequest(durableIntegration);
      promotionAttempted = true;
      await promotion.promotePrepared(promotionRequest);
      const inspection = validatePreparedInspection(
        await promotion.inspectPrepared(promotionRequest),
        promotionRequest
      );
      if (inspection.disposition !== 'applied') {
        throw new IntegrationOrchestrationError(
          `Git did not prove that integration ${integrationId} reached its target.`,
          'integration-promotion-unproven',
          { inspection }
        );
      }
      await heartbeat.stop();
      heartbeat = null;
      await this.#recordApplied({ integrationId, correlationId: normalizedCommandId });
      return this.#integrationResult(normalizedCommandId, integrationId, true, cleanup);
    } catch (error) {
      if (heartbeat) {
        try {
          await heartbeat.stop();
        } catch (heartbeatError) {
          if (error?.heartbeatError === undefined) error.heartbeatError = heartbeatError;
        }
        heartbeat = null;
      }
      if (!requestedRecorded) throw error;
      const currentState = await this.#readState();
      const current = this.#requireIntegration(currentState.projection, integrationId);
      if (![IntegrationStatus.INTEGRATED, IntegrationStatus.FAILED,
        IntegrationStatus.CONFLICTED].includes(current.status)) {
        const retainedGateWorkspace = error?.cleanup?.status === 'retained';
        if (retainedGateWorkspace) {
          await this.#recordRecoveryRequired({
            integrationId,
            correlationId: normalizedCommandId,
            phase: 'regression',
            failure: failureFrom(error, 'INTEGRATION_REGRESSION_INTERRUPTED')
          });
        } else if (promotionAttempted && current.candidateRevision !== null) {
          const request = this.#preparedPromotionRequest(current);
          try {
            const inspection = validatePreparedInspection(
              await promotion.inspectPrepared(request),
              request
            );
            if (inspection.disposition === 'applied') {
              await this.#recordApplied({
                integrationId,
                correlationId: normalizedCommandId
              });
            } else if (inspection.disposition === 'advanced') {
              await this.#recordRecoveryRequired({
                integrationId,
                correlationId: normalizedCommandId,
                phase: 'promotion',
                failure: {
                  code: 'INTEGRATION_TARGET_ADVANCED_AFTER_CANDIDATE',
                  message: 'The target contains the candidate but has advanced beyond it; the durable project revision cannot be inferred.',
                  details: { inspection: cloneJson(inspection) }
                }
              });
            } else if (inspection.disposition === 'not-applied') {
              await this.#recordFailed({
                integrationId,
                correlationId: normalizedCommandId,
                phase: 'promotion',
                failure: failureFrom(error, 'INTEGRATION_PROMOTION_FAILED')
              });
            } else {
              await this.#recordRecoveryRequired({
                integrationId,
                correlationId: normalizedCommandId,
                phase: 'promotion',
                failure: failureFrom(error, 'INTEGRATION_PROMOTION_UNCERTAIN')
              });
            }
          } catch (inspectionError) {
            await this.#recordRecoveryRequired({
              integrationId,
              correlationId: normalizedCommandId,
              phase: 'inspection',
              failure: failureFrom(inspectionError, 'INTEGRATION_INSPECTION_FAILED')
            });
          }
        } else {
          await this.#recordFailed({
            integrationId,
            correlationId: normalizedCommandId,
            phase: current.candidateRevision === null ? 'preparation' : 'regression',
            failure: failureFrom(error, 'GATED_INTEGRATION_FAILED')
          });
        }
      }
      return this.#integrationResult(normalizedCommandId, integrationId, true, cleanup);
    } finally {
      if (candidateCleanupOwned) {
        try {
          const removed = await candidateWorkspace.cleanup({
            integrationId,
            ...(prepared?.workspacePath === undefined
              ? {}
              : { workspacePath: prepared.workspacePath }),
            force: prepared === null || prepared.disposition === 'conflicted'
          });
          cleanup.candidateWorkspaceRemoved = removed?.removed === true
            || removed?.alreadyAbsent === true;
        } catch (error) {
          cleanup.warnings.push({
            phase: 'candidate-workspace-cleanup',
            failure: failureFrom(error, 'INTEGRATION_WORKSPACE_CLEANUP_FAILED')
          });
        }
      }
      if (capability) {
        try {
          await retryUnstartedLeaseOperation(lease, () => lease.release({
            leaseId: capability.lease.leaseId,
            ownerToken: capability.ownerToken
          }));
          cleanup.leaseReleased = true;
        } catch (error) {
          cleanup.warnings.push({
            phase: 'lease-release',
            failure: failureFrom(error, 'INTEGRATION_LEASE_RELEASE_FAILED')
          });
        }
      }
    }
  }

  async revertChangeSet({
    changeSetId,
    targetRef,
    candidateWorkspace,
    promotion,
    evaluator,
    profile,
    evaluationWorkspace,
    regressionGate = runIntegrationRegressionGate,
    lease,
    artifacts,
    commandId,
    signal,
    leaseTtlMs
  } = {}) {
    assertPort(candidateWorkspace, 'candidateWorkspace', ['prepareRevert', 'cleanup']);
    assertPort(promotion, 'promotion', [
      'verifyChangeSet', 'promotePrepared', 'inspectPrepared'
    ]);
    assertPort(evaluator, 'evaluator', ['normalizeProfile', 'evaluate']);
    assertPort(evaluationWorkspace, 'evaluationWorkspace', [
      'createEvaluation', 'inspectEvaluation', 'removeEvaluation'
    ]);
    assertPort(lease, 'lease', [
      'init', 'inspect', 'acquire', 'heartbeat', 'release', 'archiveStale'
    ]);
    assertPort(artifacts, 'artifacts', ['init', 'get', 'put', 'verify']);
    if (typeof regressionGate !== 'function') {
      throw new IntegrationOrchestrationError(
        'regressionGate must be a function.',
        'invalid-reversion-port'
      );
    }
    const normalizedChangeSetId = requireTrimmedString(changeSetId, 'changeSetId');
    const normalizedTargetRef = normalizeIntegrationTargetRef(targetRef);
    const normalizedCommandId = commandId === undefined
      ? this.#id('command')
      : requirePublicCommandId(commandId);
    const ttlMs = requireSafeDuration(leaseTtlMs, 'leaseTtlMs', DEFAULT_LEASE_TTL_MS);
    let normalizedProfile;
    try {
      normalizedProfile = cloneJson(evaluator.normalizeProfile(profile));
    } catch (error) {
      throw new IntegrationOrchestrationError(
        `Reversion regression profile is invalid: ${error.message}`,
        'invalid-reversion-profile',
        { cause: failureFrom(error, 'INVALID_PROFILE') }
      );
    }
    if (!isPlainObject(normalizedProfile)) {
      throw new IntegrationOrchestrationError(
        'Reversion regression profile must normalize to a JSON object.',
        'invalid-reversion-profile'
      );
    }
    const checkKinds = Array.isArray(normalizedProfile.checks)
      ? new Set(normalizedProfile.checks.map((check) => check?.kind))
      : new Set();
    if (!checkKinds.has('compile') || !checkKinds.has('test')) {
      throw new IntegrationOrchestrationError(
        'Reversion regression profile must contain both compile and test checks.',
        'incomplete-reversion-regression-profile',
        { requiredKinds: ['compile', 'test'], actualKinds: [...checkKinds].sort() }
      );
    }
    const regressionProfileHash = `sha256:${hashCanonicalValue(normalizedProfile)}`;
    const intent = {
      schemaVersion: 1,
      type: 'RevertChangeSet',
      changeSetId: normalizedChangeSetId,
      targetRef: normalizedTargetRef,
      regressionProfileHash
    };
    const intentHash = hashCanonicalValue(intent);
    let state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
    if (existing) {
      return this.#existingReversionResult(
        state,
        normalizedCommandId,
        eventFromBatch(existing, 'ReversionRequested').payload.reversionId,
        lease,
        candidateWorkspace
      );
    }

    await retryUnstartedLeaseOperation(lease, () => lease.init());
    await artifacts.init();
    const reversionId = this.#id('reversion');
    let capability;
    let heartbeat = null;
    let requestedRecorded = false;
    let prepared = null;
    let candidateCleanupOwned = false;
    let promotionAttempted = false;
    const cleanup = {
      leaseReleased: false,
      candidateWorkspaceRemoved: false,
      warnings: []
    };
    try {
      capability = await retryUnstartedLeaseOperation(lease, () => lease.acquire({
        ownerKind: 'reversion',
        ownerId: reversionId,
        ttlMs
      }));
      state = await this.#readState();
      const racedExisting = recordedBatch(state.store, normalizedCommandId, intentHash);
      if (racedExisting) {
        return this.#existingReversionResult(
          state,
          normalizedCommandId,
          eventFromBatch(racedExisting, 'ReversionRequested').payload.reversionId,
          lease,
          candidateWorkspace
        );
      }
      assertSerialOperationAvailable(state.projection);
      let selected = this.#selectReversionSource(
        state.projection,
        normalizedChangeSetId,
        normalizedTargetRef
      );
      await verifyEvidenceArtifacts(artifacts, selected.evidence);
      await promotion.verifyChangeSet(selected.changeSet);
      throwIfAborted(signal);

      await this.#appendDerived({
        commandId: normalizedCommandId,
        correlationId: normalizedCommandId,
        intent,
        build: (latest) => {
          assertSerialOperationAvailable(latest.projection);
          const current = this.#selectReversionSource(
            latest.projection,
            normalizedChangeSetId,
            normalizedTargetRef
          );
          if (current.expectedTargetRevision !== selected.expectedTargetRevision) {
            throw new IntegrationOrchestrationError(
              'The target revision changed while the Reversion was being scheduled.',
              'reversion-project-revision-mismatch'
            );
          }
          return [{
            type: 'ReversionRequested',
            streamId: `reversion:${reversionId}`,
            payload: {
              reversionId,
              integrationId: current.integration.id,
              changeSetId: current.changeSet.id,
              nodeId: current.node.id,
              goalId: current.goal.id,
              targetRef: normalizedTargetRef,
              expectedTargetRevision: current.expectedTargetRevision,
              revertedRevision: current.integration.integratedRevision,
              regressionProfileHash
            }
          }, {
            type: 'IntegrationReversionRequested',
            streamId: `integration:${current.integration.id}`,
            payload: {
              reversionId,
              integrationId: current.integration.id,
              changeSetId: current.changeSet.id
            }
          }];
        }
      });
      requestedRecorded = true;

      await this.#appendDerived({
        commandId: this.#internalReversionCommand(reversionId, 'started'),
        correlationId: normalizedCommandId,
        intent: { schemaVersion: 1, type: 'StartReversion', reversionId },
        build: (latest) => {
          const reversion = this.#requireReversion(latest.projection, reversionId);
          if (reversion.status !== ReversionStatus.PENDING) {
            throw new IntegrationOrchestrationError(
              `Reversion ${reversionId} is no longer startable.`,
              'reversion-not-pending'
            );
          }
          return [{
            type: 'ReversionStarted',
            streamId: `reversion:${reversionId}`,
            payload: { reversionId, leaseId: capability.lease.leaseId }
          }];
        }
      });

      heartbeat = startLeaseHeartbeat(lease, capability, ttlMs, signal);
      selected = this.#selectReversionInputs((await this.#readState()).projection, reversionId);
      throwIfAborted(heartbeat.signal);
      candidateCleanupOwned = true;
      prepared = validateRevertPrepared(await candidateWorkspace.prepareRevert({
        integrationId: reversionId,
        targetRef: selected.reversion.targetRef,
        expectedTargetRevision: selected.reversion.expectedTargetRevision,
        revertedRevision: selected.reversion.revertedRevision
      }), {
        reversionId,
        targetRef: selected.reversion.targetRef,
        expectedTargetRevision: selected.reversion.expectedTargetRevision,
        revertedRevision: selected.reversion.revertedRevision
      });
      if (prepared.disposition === 'conflicted') {
        await this.#recordReversionConflicted({
          reversionId,
          correlationId: normalizedCommandId,
          workspacePath: prepared.workspacePath,
          candidateRef: prepared.candidateRef,
          conflicts: prepared.conflicts
        });
        await heartbeat.stop();
        heartbeat = null;
        return this.#reversionResult(normalizedCommandId, reversionId, true, cleanup);
      }

      const preparedState = await this.#readState();
      const changedRefIds = candidateChangedRefIds(
        preparedState.projection.refs,
        prepared.changedFiles,
        { ignoreCase: selected.changeSet.coreIgnoreCase }
      );
      const patchArtifact = await artifacts.put(prepared.patch);
      const executionArtifact = await artifacts.put(stableStringify({
        schemaVersion: 1,
        kind: 'reversion-candidate',
        reversionId,
        sourceChangeSetId: selected.reversion.sourceChangeSetId,
        sourceIntegrationId: selected.reversion.integrationId,
        targetRef: selected.reversion.targetRef,
        expectedTargetRevision: selected.reversion.expectedTargetRevision,
        revertedRevision: selected.reversion.revertedRevision,
        candidateRevision: prepared.candidateRevision,
        candidateTree: prepared.candidateTree,
        parents: prepared.parents,
        changedFiles: prepared.changedFiles,
        changes: prepared.changes,
        changedRefIds,
        patchArtifact
      }));
      await artifacts.verify(patchArtifact);
      await artifacts.verify(executionArtifact);
      prepared = { ...prepared, changedRefIds, patchArtifact, executionArtifact };
      await this.#recordReversionPrepared({
        reversionId,
        correlationId: normalizedCommandId,
        ...prepared
      });
      throwIfAborted(heartbeat.signal);

      const durable = this.#requireReversion(
        (await this.#readState()).projection,
        reversionId
      );
      const regressionEvidence = validateRegressionEvidence(await regressionGate({
        integrationId: reversionId,
        candidateRevision: durable.candidateRevision,
        profile: normalizedProfile,
        evaluator,
        workspace: evaluationWorkspace,
        artifacts,
        signal: heartbeat.signal
      }), {
        id: reversionId,
        candidateRevision: durable.candidateRevision,
        regressionProfileHash: durable.regressionProfileHash
      });
      await verifyRegressionEvidenceArtifacts(artifacts, regressionEvidence, {
        id: reversionId,
        candidateRevision: durable.candidateRevision,
        regressionProfileHash: durable.regressionProfileHash
      });
      await this.#recordReversionRegression({
        reversionId,
        correlationId: normalizedCommandId,
        evidence: regressionEvidence
      });
      if (regressionEvidence.result !== 'pass') {
        await this.#recordReversionFailed({
          reversionId,
          correlationId: normalizedCommandId,
          phase: 'regression',
          failure: {
            code: 'REVERSION_REGRESSION_REJECTED',
            message: 'The prepared revert candidate did not pass compile and test regression.',
            details: {
              regressionResult: regressionEvidence.regressionResult,
              policyViolations: regressionEvidence.policyViolations,
              cleanup: regressionEvidence.cleanup
            }
          }
        });
        await heartbeat.stop();
        heartbeat = null;
        return this.#reversionResult(normalizedCommandId, reversionId, true, cleanup);
      }

      const durableState = await this.#readState();
      const durableReversion = this.#requireReversion(
        durableState.projection,
        reversionId
      );
      await verifyRegressionEvidenceArtifacts(
        artifacts,
        durableReversion.regressionEvidence,
        durableReversion
      );
      await verifyCandidateArtifacts(artifacts, durableReversion, 'reversion');
      this.#assertDurableReversionPreconditions(durableState.projection, durableReversion);
      const promotionRequest = this.#reversionPromotionRequest(durableReversion);
      promotionAttempted = true;
      await promotion.promotePrepared(promotionRequest);
      const inspection = validatePreparedInspection(
        await promotion.inspectPrepared(promotionRequest),
        promotionRequest
      );
      if (inspection.disposition !== 'applied') {
        throw new IntegrationOrchestrationError(
          `Git did not prove that Reversion ${reversionId} reached its target.`,
          'reversion-promotion-unproven',
          { inspection }
        );
      }
      await heartbeat.stop();
      heartbeat = null;
      await this.#recordReversionApplied({
        reversionId,
        correlationId: normalizedCommandId
      });
      return this.#reversionResult(normalizedCommandId, reversionId, true, cleanup);
    } catch (error) {
      if (heartbeat) {
        try {
          await heartbeat.stop();
        } catch (heartbeatError) {
          if (error?.heartbeatError === undefined) error.heartbeatError = heartbeatError;
        }
        heartbeat = null;
      }
      if (!requestedRecorded) throw error;
      const currentState = await this.#readState();
      const current = this.#requireReversion(currentState.projection, reversionId);
      if (![ReversionStatus.REVERTED, ReversionStatus.FAILED,
        ReversionStatus.CONFLICTED].includes(current.status)) {
        const retainedGateWorkspace = error?.cleanup?.status === 'retained';
        if (retainedGateWorkspace) {
          await this.#recordReversionRecoveryRequired({
            reversionId,
            correlationId: normalizedCommandId,
            phase: 'regression',
            failure: failureFrom(error, 'REVERSION_REGRESSION_INTERRUPTED')
          });
        } else if (promotionAttempted && current.candidateRevision !== null) {
          const request = this.#reversionPromotionRequest(current);
          try {
            const inspection = validatePreparedInspection(
              await promotion.inspectPrepared(request),
              request
            );
            if (inspection.disposition === 'applied') {
              await this.#recordReversionApplied({
                reversionId,
                correlationId: normalizedCommandId
              });
            } else if (inspection.disposition === 'advanced') {
              await this.#recordReversionRecoveryRequired({
                reversionId,
                correlationId: normalizedCommandId,
                phase: 'promotion',
                failure: {
                  code: 'REVERSION_TARGET_ADVANCED_AFTER_CANDIDATE',
                  message: 'The target contains the revert candidate but has advanced beyond it; the durable project revision cannot be inferred.',
                  details: { inspection: cloneJson(inspection) }
                }
              });
            } else if (inspection.disposition === 'not-applied') {
              await this.#recordReversionFailed({
                reversionId,
                correlationId: normalizedCommandId,
                phase: 'promotion',
                failure: failureFrom(error, 'REVERSION_PROMOTION_FAILED')
              });
            } else {
              await this.#recordReversionRecoveryRequired({
                reversionId,
                correlationId: normalizedCommandId,
                phase: 'promotion',
                failure: failureFrom(error, 'REVERSION_PROMOTION_UNCERTAIN')
              });
            }
          } catch (inspectionError) {
            await this.#recordReversionRecoveryRequired({
              reversionId,
              correlationId: normalizedCommandId,
              phase: 'inspection',
              failure: failureFrom(inspectionError, 'REVERSION_INSPECTION_FAILED')
            });
          }
        } else {
          await this.#recordReversionFailed({
            reversionId,
            correlationId: normalizedCommandId,
            phase: current.candidateRevision === null ? 'preparation' : 'regression',
            failure: failureFrom(error, 'REVERSION_FAILED')
          });
        }
      }
      return this.#reversionResult(normalizedCommandId, reversionId, true, cleanup);
    } finally {
      if (candidateCleanupOwned) {
        try {
          const removed = await candidateWorkspace.cleanup({
            integrationId: reversionId,
            ...(prepared?.workspacePath === undefined
              ? {}
              : { workspacePath: prepared.workspacePath }),
            force: prepared === null || prepared.disposition === 'conflicted'
          });
          cleanup.candidateWorkspaceRemoved = removed?.removed === true
            || removed?.alreadyAbsent === true;
        } catch (error) {
          cleanup.warnings.push({
            phase: 'candidate-workspace-cleanup',
            failure: failureFrom(error, 'REVERSION_WORKSPACE_CLEANUP_FAILED')
          });
        }
      }
      if (capability) {
        try {
          await retryUnstartedLeaseOperation(lease, () => lease.release({
            leaseId: capability.lease.leaseId,
            ownerToken: capability.ownerToken
          }));
          cleanup.leaseReleased = true;
        } catch (error) {
          cleanup.warnings.push({
            phase: 'lease-release',
            failure: failureFrom(error, 'REVERSION_LEASE_RELEASE_FAILED')
          });
        }
      }
    }
  }

  async reconcileReversion({
    promotion,
    candidateWorkspace,
    evaluationWorkspace,
    confirmProcessesStopped = false,
    lease,
    artifacts,
    correlationId,
    orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS
  } = {}) {
    assertPort(promotion, 'promotion', ['promotePrepared', 'inspectPrepared']);
    assertPort(candidateWorkspace, 'candidateWorkspace', [
      'cleanup', 'inspectResidue', 'pruneCandidateRef'
    ]);
    const processesStoppedConfirmed = requireBoolean(
      confirmProcessesStopped,
      'confirmProcessesStopped'
    );
    if (processesStoppedConfirmed) {
      assertPort(evaluationWorkspace, 'evaluationWorkspace', ['removeEvaluation']);
    }
    assertPort(lease, 'lease', [
      'init', 'inspect', 'acquire', 'heartbeat', 'release', 'archiveStale'
    ]);
    assertPort(artifacts, 'artifacts', ['get', 'init', 'verify']);
    const requestedCorrelationId = correlationId === undefined
      ? this.#id('command')
      : requirePublicCommandId(correlationId);
    const graceMs = requireSafeDuration(
      orphanGraceMs,
      'orphanGraceMs',
      DEFAULT_ORPHAN_GRACE_MS
    );
    await retryUnstartedLeaseOperation(lease, () => lease.init());
    await artifacts.init();
    let state = await this.#readState();
    const conflictingRun = state.projection.runs.find(isActiveRun);
    const conflictingEvaluation = (state.projection.evaluations ?? []).find(
      isActiveEvaluation
    );
    const conflictingIntegration = (state.projection.integrations ?? []).find(
      isActiveIntegration
    );
    if (conflictingRun || conflictingEvaluation || conflictingIntegration) {
      return {
        ok: true,
        reconciled: false,
        reason: conflictingRun
          ? 'run-operation-active'
          : conflictingEvaluation
            ? 'evaluation-operation-active'
            : 'integration-operation-active'
      };
    }
    let active = (state.projection.reversions ?? []).find(isActiveReversion);
    let leaseInspection = await retryUnstartedLeaseOperation(lease, () => lease.inspect());
    let archived = null;
    if (leaseInspection.held) {
      if (leaseInspection.lease.ownerKind !== 'reversion') {
        return {
          ok: true,
          reconciled: false,
          reason: 'another-operation-owns-lease',
          lease: leaseInspection
        };
      }
      if (!leaseInspection.stale) {
        return {
          ok: true,
          reconciled: false,
          reason: active?.id === leaseInspection.lease.ownerId
            ? 'reversion-owner-not-dead'
            : 'another-operation-owns-lease',
          lease: leaseInspection
        };
      }
      archived = await retryUnstartedLeaseOperation(lease, () => lease.archiveStale({
        expectedLeaseId: leaseInspection.lease.leaseId
      }));
    }
    if (!active) {
      const cleanup = {
        leaseReleased: true,
        candidateWorkspaceRemoved: false,
        warnings: []
      };
      const residueRemoved = await removeTerminalCandidateResidue(
        candidateWorkspace,
        state.projection,
        {
        ownerKind: 'reversion',
        cleanup,
        failureCode: 'REVERSION_WORKSPACE_CLEANUP_FAILED'
        }
      );
      return {
        ok: true,
        reconciled: archived !== null || residueRemoved,
        reason: residueRemoved
          ? 'candidate-workspace-residue-removed'
          : archived === null
            ? 'nothing-to-reconcile'
            : 'orphan-reversion-lease-archived',
        archived,
        cleanup
      };
    }
    if (active.status === ReversionStatus.PENDING) {
      const ageMs = this.#now().getTime() - Date.parse(active.requestedAt);
      if (ageMs < graceMs) {
        return {
          ok: true,
          reconciled: archived !== null,
          reason: 'reversion-request-grace-period',
          archived
        };
      }
    }

    let capability;
    const cleanup = {
      leaseReleased: false,
      candidateWorkspaceRemoved: false,
      warnings: []
    };
    let cleanupUnboundCandidateRef = false;
    const candidateOwnerId = active.id;
    const candidateWorkspacePath = active.candidateWorkspacePath;
    try {
      capability = await retryUnstartedLeaseOperation(lease, () => lease.acquire({
        ownerKind: 'reversion',
        ownerId: active.id
      }));
      state = await this.#readState();
      active = (state.projection.reversions ?? []).find(
        (reversion) => reversion.id === active.id
      );
      if (!active || !isActiveReversion(active)) {
        const result = this.#resultReversionFromState(
          state,
          requestedCorrelationId,
          candidateOwnerId,
          false,
          cleanup
        );
        return {
          ...result,
          reconciled: false,
          reason: 'reversion-state-changed',
          archived
        };
      }
      if (active.status === ReversionStatus.PENDING || active.candidateRevision === null) {
        await this.#recordReversionFailed({
          reversionId: active.id,
          correlationId: requestedCorrelationId,
          phase: 'reconciliation',
          failure: {
            code: 'REVERSION_OWNER_LOST_BEFORE_PREPARATION',
            message: 'The Reversion owner disappeared before a candidate was durably prepared.',
            details: null
          }
        });
        cleanupUnboundCandidateRef = true;
      } else if (active.regressionEvidence?.result !== 'pass') {
        if (active.regressionEvidence === null && processesStoppedConfirmed
          && (active.status === ReversionStatus.RUNNING || active.phase === 'regression')) {
          try {
            const removal = await removeRetainedRegressionWorkspace(
              evaluationWorkspace,
              active.id,
              active.candidateRevision
            );
            await this.#recordReversionFailed({
              reversionId: active.id,
              correlationId: requestedCorrelationId,
              phase: 'regression-recovery-abort',
              failure: {
                code: 'REVERSION_REGRESSION_ABORTED_AFTER_PROCESS_CONFIRMATION',
                message: 'The retained regression workspace was removed after the operator confirmed all evaluator processes had stopped.',
                details: {
                  processesStoppedConfirmed: true,
                  evaluationWorkspaceRemoval: removal
                }
              }
            });
          } catch (error) {
            cleanup.warnings.push({
              phase: 'regression-workspace-cleanup',
              failure: failureFrom(error, 'REVERSION_REGRESSION_WORKSPACE_CLEANUP_FAILED')
            });
            if (active.status !== ReversionStatus.RECOVERY_REQUIRED) {
              await this.#recordReversionRecoveryRequired({
                reversionId: active.id,
                correlationId: requestedCorrelationId,
                phase: 'regression',
                failure: failureFrom(error, 'REVERSION_REGRESSION_WORKSPACE_CLEANUP_FAILED')
              });
            }
          }
        } else if (active.status !== ReversionStatus.RECOVERY_REQUIRED) {
          await this.#recordReversionRecoveryRequired({
            reversionId: active.id,
            correlationId: requestedCorrelationId,
            phase: 'regression',
            failure: {
              code: 'REVERSION_REGRESSION_NOT_DURABLY_PASSED',
              message: 'A retained revert candidate remains fenced without durable passing regression Evidence.',
              details: {
                evidenceResult: active.regressionEvidence?.result ?? null
              }
            }
          });
        }
      } else {
        const request = this.#reversionPromotionRequest(active);
        try {
          const selected = this.#selectReversionInputs(state.projection, active.id);
          await verifyEvidenceArtifacts(artifacts, selected.evidence);
          await verifyCandidateArtifacts(artifacts, active, 'reversion');
          await verifyRegressionEvidenceArtifacts(artifacts, active.regressionEvidence, active);
          let inspection = validatePreparedInspection(
            await promotion.inspectPrepared(request),
            request
          );
          if (inspection.disposition === 'not-applied') {
            this.#assertDurableReversionPreconditions(state.projection, active);
            await promotion.promotePrepared(request);
            inspection = validatePreparedInspection(
              await promotion.inspectPrepared(request),
              request
            );
          }
          if (inspection.disposition === 'applied') {
            await this.#recordReversionApplied({
              reversionId: active.id,
              correlationId: requestedCorrelationId
            });
          } else if (inspection.disposition === 'advanced') {
            if (active.status !== ReversionStatus.RECOVERY_REQUIRED) {
              await this.#recordReversionRecoveryRequired({
                reversionId: active.id,
                correlationId: requestedCorrelationId,
                phase: 'reconciliation',
                failure: {
                  code: 'REVERSION_TARGET_ADVANCED_AFTER_CANDIDATE',
                  message: 'The target contains the revert candidate but has advanced beyond it; manual reconciliation is required.',
                  details: { inspection: cloneJson(inspection) }
                }
              });
            }
          } else if (['not-applied', 'diverged'].includes(inspection.disposition)) {
            await this.#recordReversionFailed({
              reversionId: active.id,
              correlationId: requestedCorrelationId,
              phase: 'reconciliation',
              failure: {
                code: inspection.disposition === 'diverged'
                  ? 'REVERSION_TARGET_DIVERGED'
                  : 'REVERSION_NOT_APPLIED',
                message: inspection.disposition === 'diverged'
                  ? 'The target branch advanced without the revert candidate.'
                  : 'The revert candidate was not applied to the target branch.',
                details: { inspection: cloneJson(inspection) }
              }
            });
          } else if (active.status !== ReversionStatus.RECOVERY_REQUIRED) {
            await this.#recordReversionRecoveryRequired({
              reversionId: active.id,
              correlationId: requestedCorrelationId,
              phase: 'reconciliation',
              failure: {
                code: 'REVERSION_TARGET_AMBIGUOUS',
                message: 'The target branch state remains ambiguous.',
                details: { inspection: cloneJson(inspection) }
              }
            });
          }
        } catch (error) {
          if (active.status !== ReversionStatus.RECOVERY_REQUIRED) {
            await this.#recordReversionRecoveryRequired({
              reversionId: active.id,
              correlationId: requestedCorrelationId,
              phase: 'reconciliation',
              failure: failureFrom(error, 'REVERSION_RECONCILIATION_FAILED')
            });
          }
        }
      }
      const result = await this.#reversionResult(
        requestedCorrelationId,
        active.id,
        true,
        cleanup
      );
      return {
        ...result,
        reconciled: true,
        reason: result.ok ? 'reversion-applied' : result.reversion.status,
        archived
      };
    } finally {
      await removeCandidateWorkspace(candidateWorkspace, {
        ownerId: candidateOwnerId,
        workspacePath: candidateWorkspacePath,
        cleanup,
        failureCode: 'REVERSION_WORKSPACE_CLEANUP_FAILED'
      });
      if (cleanupUnboundCandidateRef) {
        const latest = await this.#readState();
        await removeTerminalCandidateResidue(candidateWorkspace, latest.projection, {
          ownerKind: 'reversion',
          cleanup,
          failureCode: 'REVERSION_CANDIDATE_REF_CLEANUP_FAILED'
        });
      }
      if (capability) {
        try {
          await retryUnstartedLeaseOperation(lease, () => lease.release({
            leaseId: capability.lease.leaseId,
            ownerToken: capability.ownerToken
          }));
          cleanup.leaseReleased = true;
        } catch (error) {
          cleanup.warnings.push({
            phase: 'lease-release',
            failure: failureFrom(error, 'REVERSION_LEASE_RELEASE_FAILED')
          });
        }
      }
    }
  }

  async reconcile({
    workspace,
    candidateWorkspace,
    evaluationWorkspace,
    confirmProcessesStopped = false,
    lease,
    artifacts,
    correlationId,
    orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS
  } = {}) {
    assertPort(workspace, 'workspace', ['promote', 'inspect']);
    assertPort(candidateWorkspace, 'candidateWorkspace', [
      'cleanup', 'inspectResidue', 'pruneCandidateRef'
    ]);
    const processesStoppedConfirmed = requireBoolean(
      confirmProcessesStopped,
      'confirmProcessesStopped'
    );
    if (processesStoppedConfirmed) {
      assertPort(evaluationWorkspace, 'evaluationWorkspace', ['removeEvaluation']);
    }
    assertPort(lease, 'lease', [
      'init', 'inspect', 'acquire', 'heartbeat', 'release', 'archiveStale'
    ]);
    assertPort(artifacts, 'artifacts', ['get', 'init', 'verify']);
    const requestedCorrelationId = correlationId === undefined
      ? this.#id('command')
      : requirePublicCommandId(correlationId);
    const graceMs = requireSafeDuration(
      orphanGraceMs,
      'orphanGraceMs',
      DEFAULT_ORPHAN_GRACE_MS
    );
    await retryUnstartedLeaseOperation(lease, () => lease.init());
    await artifacts.init();
    let state = await this.#readState();
    const conflictingRun = state.projection.runs.find(isActiveRun);
    const conflictingEvaluation = (state.projection.evaluations ?? []).find(
      isActiveEvaluation
    );
    if (conflictingRun || conflictingEvaluation) {
      return {
        ok: true,
        reconciled: false,
        reason: conflictingRun ? 'run-operation-active' : 'evaluation-operation-active',
        run: conflictingRun ?? null,
        evaluation: conflictingEvaluation ?? null
      };
    }
    let active = (state.projection.integrations ?? []).find(isActiveIntegration);
    let leaseInspection = await retryUnstartedLeaseOperation(lease, () => lease.inspect());
    let archived = null;
    if (leaseInspection.held) {
      if (leaseInspection.lease.ownerKind !== 'integration') {
        return {
          ok: true,
          reconciled: false,
          reason: 'another-operation-owns-lease',
          lease: leaseInspection
        };
      }
      if (!leaseInspection.stale) {
        return {
          ok: true,
          reconciled: false,
          reason: active?.id === leaseInspection.lease.ownerId
            ? 'integration-owner-not-dead'
            : 'another-operation-owns-lease',
          lease: leaseInspection
        };
      }
      archived = await retryUnstartedLeaseOperation(lease, () => lease.archiveStale({
        expectedLeaseId: leaseInspection.lease.leaseId
      }));
      leaseInspection = await retryUnstartedLeaseOperation(lease, () => lease.inspect());
    }
    if (!active) {
      const cleanup = {
        leaseReleased: true,
        candidateWorkspaceRemoved: false,
        warnings: []
      };
      const residueRemoved = await removeTerminalCandidateResidue(
        candidateWorkspace,
        state.projection,
        {
        ownerKind: 'integration',
        cleanup,
        failureCode: 'INTEGRATION_WORKSPACE_CLEANUP_FAILED'
        }
      );
      return {
        ok: true,
        reconciled: archived !== null || residueRemoved,
        reason: residueRemoved
          ? 'candidate-workspace-residue-removed'
          : archived === null
            ? 'nothing-to-reconcile'
            : 'orphan-integration-lease-archived',
        archived,
        cleanup
      };
    }
    if (active.status === IntegrationStatus.PENDING) {
      const ageMs = this.#now().getTime() - Date.parse(active.requestedAt);
      if (ageMs < graceMs) {
        return {
          ok: true,
          reconciled: archived !== null,
          reason: 'integration-request-grace-period',
          archived
        };
      }
    }

    let capability;
    const cleanup = {
      leaseReleased: false,
      candidateWorkspaceRemoved: active.strategy !== GATED_MERGE_STRATEGY,
      warnings: []
    };
    let cleanupUnboundCandidateRef = false;
    const candidateOwnerId = active.id;
    const candidateWorkspacePath = active.candidateWorkspacePath;
    const candidateCleanupRequired = active.strategy === GATED_MERGE_STRATEGY;
    try {
      capability = await retryUnstartedLeaseOperation(lease, () => lease.acquire({
        ownerKind: 'integration',
        ownerId: active.id
      }));
      state = await this.#readState();
      active = (state.projection.integrations ?? []).find(
        (integration) => integration.id === active.id
      );
      if (!active || !isActiveIntegration(active)) {
        const result = this.#resultFromState(
          state,
          requestedCorrelationId,
          candidateOwnerId,
          false,
          cleanup
        );
        return {
          ...result,
          reconciled: false,
          reason: 'integration-state-changed',
          archived
        };
      }
      if (active.status === IntegrationStatus.PENDING || active.candidateRevision === null) {
        await this.#recordFailed({
          integrationId: active.id,
          correlationId: requestedCorrelationId,
          phase: 'reconciliation',
          failure: {
            code: 'INTEGRATION_OWNER_LOST_BEFORE_PREPARATION',
            message: 'The integration owner disappeared before a candidate was durably prepared.',
            details: null
          }
        });
        cleanupUnboundCandidateRef = true;
      } else if (active.strategy === GATED_MERGE_STRATEGY) {
        await this.#reconcileGatedIntegration({
          projection: state.projection,
          integration: active,
          workspace,
          evaluationWorkspace,
          processesStoppedConfirmed,
          cleanup,
          artifacts,
          correlationId: requestedCorrelationId
        });
      } else {
        let inspection;
        let settlementRecorded = false;
        const request = this.#gitRequest(active);
        try {
          const selected = this.#selectIntegrationInputs(state.projection, active.id);
          await verifyEvidenceArtifacts(artifacts, selected.evidence);
          inspection = validateInspection(await workspace.inspect(request), request);
          if (inspection.disposition === 'not-applied'
            && active.status === IntegrationStatus.RUNNING) {
            this.#assertDurableIntegrationPreconditions(state.projection, active);
            try {
              await workspace.promote(request);
            } catch (promotionError) {
              await this.#settleFailedAttempt({
                integrationId: active.id,
                correlationId: requestedCorrelationId,
                workspace,
                error: promotionError
              });
              settlementRecorded = true;
            }
            if (!settlementRecorded) {
              inspection = validateInspection(await workspace.inspect(request), request);
            }
          }
        } catch (error) {
          if (isDeterministicIntegrationPreconditionError(error)) {
            await this.#recordFailed({
              integrationId: active.id,
              correlationId: requestedCorrelationId,
              phase: 'reconciliation',
              failure: failureFrom(error, 'INTEGRATION_PRECONDITION_FAILED')
            });
            settlementRecorded = true;
          } else {
            await this.#recordRecoveryRequired({
              integrationId: active.id,
              correlationId: requestedCorrelationId,
              phase: 'reconciliation',
              failure: failureFrom(error, 'INTEGRATION_RECONCILIATION_INSPECTION_FAILED')
            });
            return {
              ok: false,
              reconciled: true,
              reason: 'integration-recovery-required',
              integration: (await this.#readState()).projection.integrations.find(
                (candidate) => candidate.id === active.id
              ),
              archived,
              cleanup
            };
          }
        }
        if (settlementRecorded) {
          // The attempt was settled after a durable-state refusal or failed promotion.
        } else if (inspection.disposition === 'applied') {
          await this.#recordApplied({
            integrationId: active.id,
            correlationId: requestedCorrelationId
          });
        } else if (inspection.disposition === 'advanced') {
          await this.#recordRecoveryRequired({
            integrationId: active.id,
            correlationId: requestedCorrelationId,
            phase: 'reconciliation',
            failure: {
              code: 'INTEGRATION_TARGET_ADVANCED_AFTER_CANDIDATE',
              message: 'The target contains the candidate but has advanced beyond it; manual reconciliation is required.',
              details: { inspection: cloneJson(inspection) }
            }
          });
        } else if (['not-applied', 'diverged'].includes(inspection.disposition)) {
          const diverged = inspection.disposition === 'diverged';
          await this.#recordFailed({
            integrationId: active.id,
            correlationId: requestedCorrelationId,
            phase: 'reconciliation',
            failure: {
              code: diverged ? 'INTEGRATION_TARGET_DIVERGED' : 'INTEGRATION_NOT_APPLIED',
              message: diverged
                ? 'The target branch advanced without the prepared candidate.'
                : 'The prepared candidate was not applied to the target branch.',
              details: { inspection: cloneJson(inspection) }
            }
          });
        } else {
          await this.#recordRecoveryRequired({
            integrationId: active.id,
            correlationId: requestedCorrelationId,
            phase: 'reconciliation',
            failure: {
              code: 'INTEGRATION_TARGET_AMBIGUOUS',
              message: 'The target branch is neither the expected base nor proven to contain the candidate.',
              details: { inspection: cloneJson(inspection) }
            }
          });
        }
      }
      const result = await this.#integrationResult(
        requestedCorrelationId,
        active.id,
        true,
        cleanup
      );
      return {
        ...result,
        reconciled: true,
        reason: result.ok ? 'integration-applied' : result.integration.status,
        archived
      };
    } finally {
      if (candidateCleanupRequired) {
        await removeCandidateWorkspace(candidateWorkspace, {
          ownerId: candidateOwnerId,
          workspacePath: candidateWorkspacePath,
          cleanup,
          failureCode: 'INTEGRATION_WORKSPACE_CLEANUP_FAILED'
        });
      }
      if (cleanupUnboundCandidateRef) {
        const latest = await this.#readState();
        await removeTerminalCandidateResidue(candidateWorkspace, latest.projection, {
          ownerKind: 'integration',
          cleanup,
          failureCode: 'INTEGRATION_CANDIDATE_REF_CLEANUP_FAILED'
        });
      }
      if (capability) {
        try {
          await retryUnstartedLeaseOperation(lease, () => lease.release({
            leaseId: capability.lease.leaseId,
            ownerToken: capability.ownerToken
          }));
          cleanup.leaseReleased = true;
        } catch (error) {
          cleanup.warnings.push({
            phase: 'lease-release',
            failure: failureFrom(error, 'INTEGRATION_LEASE_RELEASE_FAILED')
          });
        }
      }
    }
  }

  async #reconcileGatedIntegration({
    projection,
    integration,
    workspace,
    evaluationWorkspace,
    processesStoppedConfirmed,
    cleanup,
    artifacts,
    correlationId
  }) {
    if (typeof workspace.promotePrepared !== 'function'
      || typeof workspace.inspectPrepared !== 'function') {
      await this.#recordFailed({
        integrationId: integration.id,
        correlationId,
        phase: 'reconciliation',
        failure: {
          code: 'GATED_INTEGRATION_ADAPTER_UNAVAILABLE',
          message: 'Recovery requires promotePrepared and inspectPrepared support.',
          details: null
        }
      });
      return;
    }
    if (integration.regressionEvidence?.result !== 'pass') {
      if (integration.regressionEvidence === null && processesStoppedConfirmed
        && (integration.status === IntegrationStatus.RUNNING
          || integration.phase === 'regression')) {
        try {
          const removal = await removeRetainedRegressionWorkspace(
            evaluationWorkspace,
            integration.id,
            integration.candidateRevision
          );
          await this.#recordFailed({
            integrationId: integration.id,
            correlationId,
            phase: 'regression-recovery-abort',
            failure: {
              code: 'INTEGRATION_REGRESSION_ABORTED_AFTER_PROCESS_CONFIRMATION',
              message: 'The retained regression workspace was removed after the operator confirmed all evaluator processes had stopped.',
              details: {
                processesStoppedConfirmed: true,
                evaluationWorkspaceRemoval: removal
              }
            }
          });
        } catch (error) {
          cleanup.warnings.push({
            phase: 'regression-workspace-cleanup',
            failure: failureFrom(error, 'INTEGRATION_REGRESSION_WORKSPACE_CLEANUP_FAILED')
          });
          if (integration.status !== IntegrationStatus.RECOVERY_REQUIRED) {
            await this.#recordRecoveryRequired({
              integrationId: integration.id,
              correlationId,
              phase: 'regression',
              failure: failureFrom(error, 'INTEGRATION_REGRESSION_WORKSPACE_CLEANUP_FAILED')
            });
          }
        }
      } else if (integration.status !== IntegrationStatus.RECOVERY_REQUIRED) {
        await this.#recordRecoveryRequired({
          integrationId: integration.id,
          correlationId,
          phase: 'regression',
          failure: {
            code: 'INTEGRATION_REGRESSION_NOT_DURABLY_PASSED',
            message: 'A retained gated candidate remains fenced without durable passing regression Evidence.',
            details: {
              evidenceResult: integration.regressionEvidence?.result ?? null
            }
          }
        });
      }
      return;
    }
    const request = this.#preparedPromotionRequest(integration);
    try {
      const selected = this.#selectIntegrationInputs(projection, integration.id);
      await verifyEvidenceArtifacts(artifacts, selected.evidence);
      await verifyCandidateArtifacts(artifacts, integration, 'merge');
      await verifyRegressionEvidenceArtifacts(
        artifacts,
        integration.regressionEvidence,
        integration
      );
      let inspection = validatePreparedInspection(
        await workspace.inspectPrepared(request),
        request
      );
      if (inspection.disposition === 'not-applied') {
        this.#assertDurableIntegrationPreconditions(projection, integration);
        await workspace.promotePrepared(request);
        inspection = validatePreparedInspection(
          await workspace.inspectPrepared(request),
          request
        );
      }
      if (inspection.disposition === 'applied') {
        await this.#recordApplied({ integrationId: integration.id, correlationId });
      } else if (inspection.disposition === 'advanced') {
        if (integration.status !== IntegrationStatus.RECOVERY_REQUIRED) {
          await this.#recordRecoveryRequired({
            integrationId: integration.id,
            correlationId,
            phase: 'reconciliation',
            failure: {
              code: 'INTEGRATION_TARGET_ADVANCED_AFTER_CANDIDATE',
              message: 'The target contains the gated candidate but has advanced beyond it; manual reconciliation is required.',
              details: { inspection: cloneJson(inspection) }
            }
          });
        }
      } else if (['not-applied', 'diverged'].includes(inspection.disposition)) {
        await this.#recordFailed({
          integrationId: integration.id,
          correlationId,
          phase: 'reconciliation',
          failure: {
            code: inspection.disposition === 'diverged'
              ? 'INTEGRATION_TARGET_DIVERGED'
              : 'INTEGRATION_NOT_APPLIED',
            message: inspection.disposition === 'diverged'
              ? 'The target branch advanced without the gated candidate.'
              : 'The gated candidate was not applied to the target branch.',
            details: { inspection: cloneJson(inspection) }
          }
        });
      } else if (integration.status !== IntegrationStatus.RECOVERY_REQUIRED) {
        await this.#recordRecoveryRequired({
          integrationId: integration.id,
          correlationId,
          phase: 'reconciliation',
          failure: {
            code: 'INTEGRATION_TARGET_AMBIGUOUS',
            message: 'The gated target state remains ambiguous.',
            details: { inspection: cloneJson(inspection) }
          }
        });
      }
    } catch (error) {
      if (isDeterministicIntegrationPreconditionError(error)) {
        await this.#recordFailed({
          integrationId: integration.id,
          correlationId,
          phase: 'reconciliation',
          failure: failureFrom(error, 'INTEGRATION_PRECONDITION_FAILED')
        });
      } else if (integration.status !== IntegrationStatus.RECOVERY_REQUIRED) {
        await this.#recordRecoveryRequired({
          integrationId: integration.id,
          correlationId,
          phase: 'reconciliation',
          failure: failureFrom(error, 'INTEGRATION_RECONCILIATION_FAILED')
        });
      }
    }
  }

  #assertProjectRevisionBase(projection, targetRef, baseRevision) {
    const previous = (projection.projectRevisions ?? []).findLast(
      (candidate) => candidate.targetRef === targetRef
    );
    if (previous !== undefined && previous.revision !== baseRevision) {
      throw new IntegrationOrchestrationError(
        `Target ${targetRef} has an unrecorded revision between FWA Integrations.`,
        'integration-project-revision-mismatch',
        {
          targetRef,
          expectedBaseRevision: previous.revision,
          actualBaseRevision: baseRevision
        }
      );
    }
  }

  #assertGoalTarget(projection, goalId, targetRef) {
    const goal = projection.goals.find((candidate) => candidate.id === goalId);
    if (!goal || goal.status !== GoalStatus.ACTIVE) {
      throw new IntegrationOrchestrationError(
        `Goal ${goalId} is not active for Integration.`,
        'changeset-not-integrable'
      );
    }
    if (goal.integrationTargetRef !== null && goal.integrationTargetRef !== targetRef) {
      throw new IntegrationOrchestrationError(
        `Goal ${goalId} is already bound to ${goal.integrationTargetRef}.`,
        'integration-goal-target-mismatch',
        {
          goalId,
          expectedTargetRef: goal.integrationTargetRef,
          actualTargetRef: targetRef
        }
      );
    }
  }

  #assertDurableIntegrationPreconditions(projection, integration) {
    this.#assertProjectRevisionBase(
      projection,
      integration.targetRef,
      integration.expectedTargetRevision
    );
    this.#assertGoalTarget(projection, integration.goalId, integration.targetRef);
  }

  #expectedTargetRevision(projection, targetRef, fallbackRevision) {
    return (projection.projectRevisions ?? []).findLast(
      (candidate) => candidate.targetRef === targetRef
    )?.revision ?? fallbackRevision;
  }

  #selectAcceptedChangeSet(
    projection,
    changeSetId,
    targetRef,
    { allowDivergentBase = false } = {}
  ) {
    const changeSet = projection.changeSets.find((candidate) => candidate.id === changeSetId);
    const node = projection.nodes.find((candidate) => candidate.id === changeSet?.nodeId);
    const run = projection.runs.find((candidate) => candidate.id === changeSet?.runId);
    const evidenceId = node?.acceptanceEvidenceIds?.length === 1
      ? node.acceptanceEvidenceIds[0]
      : null;
    const evidence = projection.evidence.find((candidate) => candidate.id === evidenceId);
    const evaluation = projection.evaluations.find(
      (candidate) => candidate.id === evidence?.evaluationId
    );
    const exactBinding = changeSet && node && run && evidence && evaluation
      && changeSet.valid
      && changeSet.nodeId === node.id
      && changeSet.runId === run.id
      && run.status === RunStatus.PRODUCED
      && run.changeSetId === changeSet.id
      && node.status === NodeStatus.ACCEPTED
      && node.validity === Validity.VALID
      && node.acceptedChangeSetId === changeSet.id
      && node.changeSetIds.at(-1) === changeSet.id
      && node.activeIntegrationId === null
      && node.integrationStatus !== IntegrationStatus.INTEGRATED
      && evaluation.status === EvaluationStatus.PASSED
      && evaluation.evidenceId === evidence.id
      && evaluation.nodeId === node.id
      && evaluation.runId === run.id
      && evaluation.changeSetId === changeSet.id
      && evaluation.headRevision === changeSet.headRevision
      && evidence.result === 'pass'
      && evidence.policyViolations.length === 0
      && evidence.nodeId === node.id
      && evidence.runId === run.id
      && evidence.changeSetId === changeSet.id
      && evidence.headRevision === changeSet.headRevision;
    if (!exactBinding) {
      throw new IntegrationOrchestrationError(
        `ChangeSet ${changeSetId} is not the current accepted, valid, passing output of its Node.`,
        'changeset-not-integrable',
        {
          changeSetFound: Boolean(changeSet),
          nodeStatus: node?.status ?? null,
          nodeValidity: node?.validity ?? null,
          acceptedChangeSetId: node?.acceptedChangeSetId ?? null,
          integrationStatus: node?.integrationStatus ?? null,
          evidenceId
        }
      );
    }
    if (changeSet.commits.length === 0 || changeSet.changedFiles.length === 0) {
      throw new IntegrationOrchestrationError(
        `ChangeSet ${changeSetId} has no material commit to integrate.`,
        'empty-changeset-not-integrable'
      );
    }
    if (!allowDivergentBase) {
      this.#assertProjectRevisionBase(projection, targetRef, changeSet.baseRevision);
    }
    this.#assertGoalTarget(projection, node.goalId, targetRef);
    return { changeSet, node, run, evidence, evaluation };
  }

  #selectIntegrationInputs(projection, integrationId) {
    const integration = this.#requireIntegration(projection, integrationId);
    const node = projection.nodes.find((candidate) => candidate.id === integration.nodeId);
    const run = projection.runs.find((candidate) => candidate.id === integration.runId);
    const changeSet = projection.changeSets.find(
      (candidate) => candidate.id === integration.changeSetId
    );
    const evaluation = projection.evaluations.find(
      (candidate) => candidate.id === integration.evaluationId
    );
    const evidence = projection.evidence.find(
      (candidate) => candidate.id === integration.evidenceId
    );
    if (!node || !run || !changeSet || !evaluation || !evidence) {
      throw new IntegrationOrchestrationError(
        `Integration ${integrationId} lost its aggregate binding.`,
        'integration-binding-mismatch'
      );
    }
    return { integration, node, run, changeSet, evaluation, evidence };
  }

  #requireIntegration(projection, integrationId) {
    const integration = (projection.integrations ?? []).find(
      (candidate) => candidate.id === integrationId
    );
    if (!integration) {
      throw new IntegrationOrchestrationError(
        `Integration ${integrationId} does not exist.`,
        'integration-not-found'
      );
    }
    return integration;
  }

  #gitRequest(integration) {
    return {
      integrationId: integration.id,
      changeSetId: integration.changeSetId,
      targetRef: integration.targetRef,
      expectedTargetRevision: integration.expectedTargetRevision,
      changeSetHeadRevision: integration.headRevision,
      ...(integration.candidateRevision === null ? {} : {
        candidateRevision: integration.candidateRevision,
        candidateTree: integration.candidateTree
      })
    };
  }

  #preparedPromotionRequest(integration) {
    if (integration.strategy !== GATED_MERGE_STRATEGY
      || integration.candidateRevision === null
      || integration.candidateTree === null
      || !Array.isArray(integration.candidateParents)
      || integration.candidateParents.length !== 2
      || integration.patchArtifact === null
      || !Array.isArray(integration.changedFiles)
      || !Array.isArray(integration.changes)) {
      throw new IntegrationOrchestrationError(
        `Integration ${integration.id} has no promotable merge candidate.`,
        'integration-candidate-incomplete'
      );
    }
    return {
      integrationId: integration.id,
      targetRef: integration.targetRef,
      expectedTargetRevision: integration.expectedTargetRevision,
      candidateRevision: integration.candidateRevision,
      candidateTree: integration.candidateTree,
      parents: [...integration.candidateParents],
      patchDigest: integration.patchArtifact?.digest,
      changedFiles: [...integration.changedFiles],
      changes: cloneJson(integration.changes)
    };
  }

  #selectReversionSource(projection, changeSetId, targetRef) {
    const changeSet = projection.changeSets.find((candidate) => candidate.id === changeSetId);
    const node = projection.nodes.find((candidate) => candidate.id === changeSet?.nodeId);
    const integration = (projection.integrations ?? []).find((candidate) => (
      candidate.id === node?.integrationIds?.at(-1)
    ));
    const run = projection.runs.find((candidate) => candidate.id === changeSet?.runId);
    const evidence = projection.evidence.find((candidate) => (
      candidate.id === integration?.evidenceId
    ));
    const evaluation = projection.evaluations.find((candidate) => (
      candidate.id === integration?.evaluationId
    ));
    const goal = projection.goals.find((candidate) => candidate.id === node?.goalId);
    const projectRevision = (projection.projectRevisions ?? []).findLast(
      (candidate) => candidate.targetRef === targetRef
    );
    const bindingComplete = changeSet && changeSet.kind === 'execution'
      && node && integration && run && evidence && evaluation && goal && projectRevision
      && changeSet.revertedByReversionId === null
      && integration.status === IntegrationStatus.INTEGRATED
      && integration.activeReversionId === null
      && integration.changeSetId === changeSet.id
      && integration.targetRef === targetRef
      && integration.integratedRevision === node.integratedRevision
      && node.status === NodeStatus.ACCEPTED
      && node.validity === Validity.VALID
      && node.integrationStatus === IntegrationStatus.INTEGRATED
      && node.integratedChangeSetId === changeSet.id
      && node.integratedTargetRef === targetRef
      && node.activeIntegrationId === null
      && run.status === RunStatus.PRODUCED
      && run.changeSetId === changeSet.id
      && evaluation.status === EvaluationStatus.PASSED
      && evidence.result === 'pass'
      && evidence.policyViolations.length === 0
      && [GoalStatus.ACTIVE, GoalStatus.COMPLETED].includes(goal.status)
      && projectRevision.revision !== undefined;
    if (!bindingComplete) {
      throw new IntegrationOrchestrationError(
        `ChangeSet ${changeSetId} is not the current, valid integrated output of its Node.`,
        'changeset-not-revertible',
        {
          changeSetFound: Boolean(changeSet),
          kind: changeSet?.kind ?? null,
          integrationStatus: integration?.status ?? null,
          nodeValidity: node?.validity ?? null,
          nodeIntegrationStatus: node?.integrationStatus ?? null,
          targetRef
        }
      );
    }
    return {
      changeSet,
      node,
      integration,
      run,
      evidence,
      evaluation,
      goal,
      expectedTargetRevision: projectRevision.revision
    };
  }

  #selectReversionInputs(projection, reversionId) {
    const reversion = this.#requireReversion(projection, reversionId);
    const integration = this.#requireIntegration(projection, reversion.integrationId);
    const changeSet = projection.changeSets.find(
      (candidate) => candidate.id === reversion.sourceChangeSetId
    );
    const node = projection.nodes.find((candidate) => candidate.id === reversion.nodeId);
    const goal = projection.goals.find((candidate) => candidate.id === reversion.goalId);
    const evidence = projection.evidence.find(
      (candidate) => candidate.id === integration.evidenceId
    );
    if (!changeSet || !node || !goal || !evidence) {
      throw new IntegrationOrchestrationError(
        `Reversion ${reversionId} lost its aggregate binding.`,
        'reversion-binding-mismatch'
      );
    }
    return { reversion, integration, changeSet, node, goal, evidence };
  }

  #requireReversion(projection, reversionId) {
    const reversion = (projection.reversions ?? []).find(
      (candidate) => candidate.id === reversionId
    );
    if (!reversion) {
      throw new IntegrationOrchestrationError(
        `Reversion ${reversionId} does not exist.`,
        'reversion-not-found'
      );
    }
    return reversion;
  }

  #assertDurableReversionPreconditions(projection, reversion) {
    const selected = this.#selectReversionInputs(projection, reversion.id);
    const latestProjectRevision = (projection.projectRevisions ?? []).findLast(
      (candidate) => candidate.targetRef === reversion.targetRef
    );
    if (![ReversionStatus.RUNNING, ReversionStatus.RECOVERY_REQUIRED].includes(
      reversion.status
    )
      || reversion.regressionEvidence?.result !== 'pass'
      || reversion.candidateRevision === null
      || reversion.candidateTree === null
      || selected.integration.status !== IntegrationStatus.INTEGRATED
      || selected.integration.activeReversionId !== reversion.id
      || latestProjectRevision?.revision !== reversion.expectedTargetRevision) {
      throw new IntegrationOrchestrationError(
        `Reversion ${reversion.id} no longer matches the durable project state.`,
        'reversion-project-revision-mismatch'
      );
    }
  }

  #reversionPromotionRequest(reversion) {
    if (reversion.candidateRevision === null
      || reversion.candidateTree === null
      || !Array.isArray(reversion.candidateParents)
      || reversion.candidateParents.length !== 1
      || reversion.patchArtifact === null
      || !Array.isArray(reversion.changedFiles)
      || !Array.isArray(reversion.changes)) {
      throw new IntegrationOrchestrationError(
        `Reversion ${reversion.id} has no promotable candidate.`,
        'reversion-candidate-incomplete'
      );
    }
    return {
      integrationId: reversion.id,
      targetRef: reversion.targetRef,
      expectedTargetRevision: reversion.expectedTargetRevision,
      candidateRevision: reversion.candidateRevision,
      candidateTree: reversion.candidateTree,
      parents: [...reversion.candidateParents],
      patchDigest: reversion.patchArtifact?.digest,
      changedFiles: [...reversion.changedFiles],
      changes: cloneJson(reversion.changes)
    };
  }

  #revertChangeSetId(reversionId) {
    return `changeset_${reversionId}`;
  }

  async #recordReversionPrepared({
    reversionId,
    correlationId,
    workspacePath,
    candidateRef,
    candidateRevision,
    candidateTree,
    parents,
    changedFiles,
    changes,
    changedRefIds,
    patchArtifact,
    executionArtifact
  }) {
    await this.#appendDerived({
      commandId: this.#internalReversionCommand(reversionId, 'prepared'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'PrepareReversion',
        reversionId,
        candidateRevision,
        candidateTree,
        parents,
        changedFiles,
        changes,
        changedRefIds,
        patchArtifact,
        executionArtifact
      },
      build: (latest) => {
        const reversion = this.#requireReversion(latest.projection, reversionId);
        if (reversion.status !== ReversionStatus.RUNNING
          || reversion.candidateRevision !== null) {
          throw new IntegrationOrchestrationError(
            `Reversion ${reversionId} is not awaiting preparation.`,
            'reversion-not-running'
          );
        }
        return [{
          type: 'ReversionPrepared',
          streamId: `reversion:${reversionId}`,
          payload: {
            reversionId,
            workspacePath,
            candidateRef,
            candidateRevision,
            candidateTree,
            parents,
            changedFiles,
            changes,
            changedRefIds,
            patchArtifact,
            executionArtifact
          }
        }];
      }
    });
  }

  async #recordReversionRegression({ reversionId, correlationId, evidence }) {
    await this.#appendDerived({
      commandId: this.#internalReversionCommand(reversionId, 'regression-recorded'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'RecordReversionRegression',
        reversionId,
        evidence
      },
      build: (latest) => {
        const reversion = this.#requireReversion(latest.projection, reversionId);
        if (reversion.status !== ReversionStatus.RUNNING
          || reversion.candidateRevision === null
          || reversion.regressionEvidence !== null) {
          throw new IntegrationOrchestrationError(
            `Reversion ${reversionId} cannot record regression Evidence.`,
            'reversion-regression-not-recordable'
          );
        }
        return [{
          type: 'ReversionRegressionRecorded',
          streamId: `reversion:${reversionId}`,
          payload: { reversionId, evidence }
        }];
      }
    });
  }

  async #recordReversionConflicted({
    reversionId,
    correlationId,
    workspacePath,
    candidateRef,
    conflicts
  }) {
    await this.#appendDerived({
      commandId: this.#internalReversionCommand(reversionId, 'conflicted'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'ConflictReversion',
        reversionId,
        workspacePath,
        candidateRef,
        conflicts
      },
      build: (latest) => {
        const reversion = this.#requireReversion(latest.projection, reversionId);
        const integration = this.#requireIntegration(
          latest.projection,
          reversion.integrationId
        );
        if (reversion.status !== ReversionStatus.RUNNING
          || reversion.candidateRevision !== null
          || integration.activeReversionId !== reversionId) {
          throw new IntegrationOrchestrationError(
            `Reversion ${reversionId} cannot record a physical conflict.`,
            'reversion-conflict-not-recordable'
          );
        }
        return [{
          type: 'ReversionConflicted',
          streamId: `reversion:${reversionId}`,
          payload: { reversionId, workspacePath, candidateRef, conflicts }
        }, {
          type: 'IntegrationReversionReleased',
          streamId: `integration:${integration.id}`,
          payload: {
            reversionId,
            integrationId: integration.id,
            status: ReversionStatus.CONFLICTED
          }
        }];
      }
    });
  }

  async #recordReversionFailed({ reversionId, correlationId, phase, failure }) {
    await this.#appendDerived({
      commandId: this.#internalReversionCommand(reversionId, `failed-${phase}`),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'FailReversion',
        reversionId,
        phase,
        failure
      },
      build: (latest) => {
        const reversion = this.#requireReversion(latest.projection, reversionId);
        const integration = this.#requireIntegration(
          latest.projection,
          reversion.integrationId
        );
        if (!isActiveReversion(reversion)
          || integration.activeReversionId !== reversionId) {
          throw new IntegrationOrchestrationError(
            `Reversion ${reversionId} is not active.`,
            'reversion-not-active'
          );
        }
        return [{
          type: 'ReversionFailed',
          streamId: `reversion:${reversionId}`,
          payload: { reversionId, phase, failure }
        }, {
          type: 'IntegrationReversionReleased',
          streamId: `integration:${integration.id}`,
          payload: {
            reversionId,
            integrationId: integration.id,
            status: ReversionStatus.FAILED
          }
        }];
      }
    });
  }

  async #recordReversionRecoveryRequired({
    reversionId,
    correlationId,
    phase,
    failure
  }) {
    const current = this.#requireReversion(
      (await this.#readState()).projection,
      reversionId
    );
    if (current.status === ReversionStatus.RECOVERY_REQUIRED) return;
    await this.#appendDerived({
      commandId: this.#internalReversionCommand(reversionId, 'recovery-required'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'RequireReversionRecovery',
        reversionId,
        phase,
        failure
      },
      build: (latest) => {
        const reversion = this.#requireReversion(latest.projection, reversionId);
        if (reversion.status !== ReversionStatus.RUNNING
          || reversion.candidateRevision === null) {
          throw new IntegrationOrchestrationError(
            `Reversion ${reversionId} is not durably prepared.`,
            'reversion-not-running'
          );
        }
        return [{
          type: 'ReversionRecoveryRequired',
          streamId: `reversion:${reversionId}`,
          payload: { reversionId, phase, failure }
        }];
      }
    });
  }

  async #recordReversionApplied({ reversionId, correlationId }) {
    const revertChangeSetId = this.#revertChangeSetId(reversionId);
    await this.#appendDerived({
      commandId: this.#internalReversionCommand(reversionId, 'applied'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'ApplyReversion',
        reversionId,
        revertChangeSetId
      },
      build: (latest) => {
        const selected = this.#selectReversionInputs(latest.projection, reversionId);
        const { reversion, integration, changeSet, node } = selected;
        this.#assertDurableReversionPreconditions(latest.projection, reversion);
        const impact = reversion.changedRefIds.length > 0
          ? computeInvalidation(latest.projection.nodes, reversion.changedRefIds, {
              excludeNodeIds: [node.id]
            })
          : computeDependencyInvalidation(latest.projection.nodes, [node.id]);
        const materializedStatuses = new Set([
          NodeStatus.PRODUCED,
          NodeStatus.ACCEPTED
        ]);
        const affectedNodeIds = [...impact.affectedNodeIds]
          .filter((nodeId) => {
            const candidate = latest.projection.nodes.find((item) => item.id === nodeId);
            return candidate?.validity === Validity.VALID
              && materializedStatuses.has(candidate.status)
              && candidate.runIds.length > 0;
          })
          .sort();
        const recomputeRootNodeIds = [...impact.recomputeRootNodeIds]
          .filter((nodeId) => affectedNodeIds.includes(nodeId))
          .sort();
        const reopenedGoalIds = [];
        const specs = [{
          type: 'RevertChangeSetCaptured',
          streamId: `changeset:${revertChangeSetId}`,
          payload: {
            reversionId,
            changeSetId: revertChangeSetId,
            sourceChangeSetId: changeSet.id,
            nodeId: node.id,
            goalId: node.goalId,
            baseRevision: reversion.expectedTargetRevision,
            headRevision: reversion.candidateRevision,
            commits: [reversion.candidateRevision],
            changedFiles: reversion.changedFiles,
            changes: reversion.changes,
            changedRefIds: reversion.changedRefIds,
            ref: reversion.candidateRef,
            valid: true,
            violations: [],
            stats: { files: reversion.changedFiles.length },
            patchArtifact: reversion.patchArtifact,
            executionArtifact: reversion.executionArtifact
          }
        }, {
          type: 'ProjectRevisionReverted',
          streamId: `project-revision:${reversion.targetRef}`,
          payload: {
            reversionId,
            sourceIntegrationId: integration.id,
            changeSetId: revertChangeSetId,
            targetRef: reversion.targetRef,
            previousRevision: reversion.expectedTargetRevision,
            revision: reversion.candidateRevision
          }
        }, {
          type: 'ChangeSetReverted',
          streamId: `changeset:${changeSet.id}`,
          payload: {
            reversionId,
            changeSetId: changeSet.id,
            revertChangeSetId
          }
        }, {
          type: 'IntegrationReverting',
          streamId: `integration:${integration.id}`,
          payload: { reversionId, integrationId: integration.id }
        }, {
          type: 'IntegrationReverted',
          streamId: `integration:${integration.id}`,
          payload: {
            reversionId,
            integrationId: integration.id,
            revertChangeSetId
          }
        }, {
          type: 'NodeReverted',
          streamId: `node:${node.id}`,
          payload: {
            reversionId,
            nodeId: node.id,
            changeSetId: changeSet.id,
            revertChangeSetId
          }
        }];
        for (const nodeId of affectedNodeIds) {
          specs.push({
            type: 'NodeMarkedStale',
            streamId: `node:${nodeId}`,
            payload: {
              reversionId,
              nodeId,
              sourceNodeId: node.id,
              changedRefIds: reversion.changedRefIds,
              recomputeRoot: recomputeRootNodeIds.includes(nodeId)
            }
          });
        }
        for (const refId of reversion.changedRefIds) {
          const ref = (latest.projection.refs ?? []).find(
            (candidate) => candidate.id === refId
          );
          if (!ref) {
            throw new IntegrationOrchestrationError(
              `Reversion ${reversionId} lost changed Ref ${refId}.`,
              'reversion-ref-binding-mismatch'
            );
          }
          const changedFiles = reversion.changedFiles.filter((file) => (
            matchesEffectPattern(ref.uri, file, {
              ignoreCase: changeSet.coreIgnoreCase === true
            })
          ));
          specs.push({
            type: 'RefVersionReverted',
            streamId: `ref:${ref.id}`,
            payload: {
              reversionId,
              changeSetId: revertChangeSetId,
              refId: ref.id,
              previousVersion: ref.version,
              previousHash: ref.hash,
              version: reversion.candidateRevision,
              hash: refVersionDigest({
                ref: refContract(ref),
                revision: reversion.candidateRevision,
                changedFiles: reversion.changedFiles,
                changes: reversion.changes,
                ignoreCase: changeSet.coreIgnoreCase === true
              }),
              changedFiles
            }
          });
        }
        const impactedNodeIds = new Set([node.id, ...affectedNodeIds]);
        for (const goal of latest.projection.goals
          .filter((candidate) => candidate.status === GoalStatus.COMPLETED)
          .filter((candidate) => candidate.nodeIds.some((nodeId) => (
            impactedNodeIds.has(nodeId)
          )))
          .sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
          reopenedGoalIds.push(goal.id);
          specs.push({
            type: 'GoalReopened',
            streamId: `goal:${goal.id}`,
            payload: { reversionId, goalId: goal.id }
          });
        }
        specs.push({
          type: 'ReversionApplied',
          streamId: `reversion:${reversionId}`,
          payload: {
            reversionId,
            revertChangeSetId,
            affectedNodeIds,
            recomputeRootNodeIds,
            reopenedGoalIds,
            revertedRefIds: reversion.changedRefIds
          }
        });
        return specs;
      }
    });
  }

  async #recordPrepared({
    integrationId,
    correlationId,
    candidateRevision,
    candidateTree
  }) {
    await this.#appendDerived({
      commandId: this.#internalCommand(integrationId, 'prepared'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'PrepareIntegration',
        integrationId,
        candidateRevision,
        candidateTree
      },
      build: (latest) => {
        const integration = this.#requireIntegration(latest.projection, integrationId);
        if (integration.status !== IntegrationStatus.RUNNING
          || integration.candidateRevision !== null) {
          throw new IntegrationOrchestrationError(
            `Integration ${integrationId} is not awaiting preparation.`,
            'integration-not-running'
          );
        }
        return [{
          type: 'IntegrationPrepared',
          streamId: `integration:${integrationId}`,
          payload: { integrationId, candidateRevision, candidateTree }
        }];
      }
    });
  }

  async #recordPreparedGated({
    integrationId,
    correlationId,
    workspacePath,
    candidateRef,
    candidateRevision,
    candidateTree,
    parents,
    changedFiles,
    changes,
    changedRefIds,
    patchArtifact,
    executionArtifact
  }) {
    await this.#appendDerived({
      commandId: this.#internalCommand(integrationId, 'merge-prepared'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'PrepareMergeIntegration',
        integrationId,
        candidateRevision,
        candidateTree,
        parents,
        changedFiles,
        changes,
        changedRefIds,
        patchArtifact,
        executionArtifact
      },
      build: (latest) => {
        const integration = this.#requireIntegration(latest.projection, integrationId);
        if (integration.status !== IntegrationStatus.RUNNING
          || integration.strategy !== GATED_MERGE_STRATEGY
          || integration.candidateRevision !== null) {
          throw new IntegrationOrchestrationError(
            `Integration ${integrationId} is not awaiting merge preparation.`,
            'integration-not-running'
          );
        }
        return [{
          type: 'IntegrationMergePrepared',
          streamId: `integration:${integrationId}`,
          payload: {
            integrationId,
            workspacePath,
            candidateRef,
            candidateRevision,
            candidateTree,
            parents,
            changedFiles,
            changes,
            changedRefIds,
            patchArtifact,
            executionArtifact
          }
        }];
      }
    });
  }

  async #recordRegression({ integrationId, correlationId, evidence }) {
    await this.#appendDerived({
      commandId: this.#internalCommand(integrationId, 'regression-recorded'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'RecordIntegrationRegression',
        integrationId,
        evidence
      },
      build: (latest) => {
        const integration = this.#requireIntegration(latest.projection, integrationId);
        if (integration.status !== IntegrationStatus.RUNNING
          || integration.strategy !== GATED_MERGE_STRATEGY
          || integration.candidateRevision === null
          || integration.regressionEvidence !== null) {
          throw new IntegrationOrchestrationError(
            `Integration ${integrationId} cannot record regression Evidence.`,
            'integration-regression-not-recordable'
          );
        }
        return [{
          type: 'IntegrationRegressionRecorded',
          streamId: `integration:${integrationId}`,
          payload: { integrationId, evidence }
        }];
      }
    });
  }

  async #recordConflicted({
    integrationId,
    correlationId,
    workspacePath,
    candidateRef,
    conflicts
  }) {
    await this.#appendDerived({
      commandId: this.#internalCommand(integrationId, 'conflicted'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'ConflictIntegration',
        integrationId,
        workspacePath,
        candidateRef,
        conflicts
      },
      build: (latest) => {
        const integration = this.#requireIntegration(latest.projection, integrationId);
        const node = latest.projection.nodes.find(
          (candidate) => candidate.id === integration.nodeId
        );
        if (!node
          || integration.status !== IntegrationStatus.RUNNING
          || integration.strategy !== GATED_MERGE_STRATEGY
          || integration.candidateRevision !== null
          || node.activeIntegrationId !== integrationId) {
          throw new IntegrationOrchestrationError(
            `Integration ${integrationId} cannot record a physical conflict.`,
            'integration-conflict-not-recordable'
          );
        }
        return [{
          type: 'IntegrationConflicted',
          streamId: `integration:${integrationId}`,
          payload: {
            integrationId,
            nodeId: node.id,
            changeSetId: integration.changeSetId,
            workspacePath,
            candidateRef,
            conflicts
          }
        }, {
          type: 'NodeIntegrationConflicted',
          streamId: `node:${node.id}`,
          payload: {
            integrationId,
            nodeId: node.id,
            changeSetId: integration.changeSetId
          }
        }];
      }
    });
  }

  async #recordApplied({ integrationId, correlationId }) {
    await this.#appendDerived({
      commandId: this.#internalCommand(integrationId, 'applied'),
      correlationId,
      intent: { schemaVersion: 1, type: 'ApplyIntegration', integrationId },
      build: (latest) => {
        const integration = this.#requireIntegration(latest.projection, integrationId);
        const node = latest.projection.nodes.find(
          (candidate) => candidate.id === integration.nodeId
        );
        const goal = latest.projection.goals.find(
          (candidate) => candidate.id === integration.goalId
        );
        if (!node
          || !goal
          || ![IntegrationStatus.RUNNING, IntegrationStatus.RECOVERY_REQUIRED].includes(
            integration.status
          )
          || integration.candidateRevision === null
          || (integration.strategy === GATED_MERGE_STRATEGY
            && integration.regressionEvidence?.result !== 'pass')
          || node.activeIntegrationId !== integrationId
          || (goal.integrationTargetRef !== null
            && goal.integrationTargetRef !== integration.targetRef)) {
          throw new IntegrationOrchestrationError(
            `Integration ${integrationId} cannot be marked applied.`,
            'integration-not-applicable'
          );
        }
        const changeSet = latest.projection.changeSets.find(
          (candidate) => candidate.id === integration.changeSetId
        );
        if (!changeSet) {
          throw new IntegrationOrchestrationError(
            `Integration ${integrationId} lost ChangeSet ${integration.changeSetId}.`,
            'integration-binding-mismatch'
          );
        }
        const candidateEffects = integration.strategy === GATED_MERGE_STRATEGY
          ? integration
          : changeSet;
        const changedRefIds = [...(candidateEffects.changedRefIds ?? [])]
          .sort((left, right) => left.localeCompare(right, 'en'));
        const impact = changedRefIds.length === 0
          ? computeDependencyInvalidation(latest.projection.nodes, [node.id])
          : computeInvalidation(latest.projection.nodes, changedRefIds, {
              excludeNodeIds: [node.id]
            });
        const materializedStatuses = new Set([
          NodeStatus.PRODUCED,
          NodeStatus.ACCEPTED
        ]);
        const affectedNodeIds = [...impact.affectedNodeIds]
          .filter((nodeId) => {
            const candidate = latest.projection.nodes.find((item) => item.id === nodeId);
            return candidate?.validity === Validity.VALID
              && materializedStatuses.has(candidate.status)
              && candidate.runIds.length > 0;
          })
          .sort();
        const recomputeRootNodeIds = [...impact.recomputeRootNodeIds]
          .filter((nodeId) => affectedNodeIds.includes(nodeId))
          .sort();
        const affectedNodeIdSet = new Set(affectedNodeIds);
        const reopenedGoalIds = [];
        const specs = [
          {
            type: 'ProjectRevisionAdvanced',
            streamId: `project-revision:${integration.targetRef}`,
            payload: {
              integrationId,
              targetRef: integration.targetRef,
              previousRevision: integration.expectedTargetRevision,
              revision: integration.candidateRevision
            }
          },
          {
            type: 'IntegrationApplied',
            streamId: `integration:${integrationId}`,
            payload: {
              integrationId,
              nodeId: integration.nodeId,
              changeSetId: integration.changeSetId,
              targetRef: integration.targetRef,
              previousRevision: integration.expectedTargetRevision,
              integratedRevision: integration.candidateRevision,
              candidateTree: integration.candidateTree
            }
          },
          {
            type: 'NodeIntegrated',
            streamId: `node:${node.id}`,
            payload: {
              integrationId,
              nodeId: node.id,
              changeSetId: integration.changeSetId,
              targetRef: integration.targetRef,
              integratedRevision: integration.candidateRevision
            }
          }
        ];
        const integratedNodes = latest.projection.nodes.map((candidate) => candidate.id === node.id
          ? { ...candidate, integrationStatus: IntegrationStatus.INTEGRATED,
              integratedChangeSetId: integration.changeSetId, integratedTargetRef: integration.targetRef }
          : candidate);
        const newlySatisfied = latest.projection.nodes.filter((candidate) => (
          candidate.status === NodeStatus.PLANNED
          && candidate.dependsOn.includes(node.id)
          && areNodeDependenciesSatisfied(candidate, integratedNodes,
            { ...goal, integrationTargetRef: integration.targetRef })
        ));
        for (const candidate of newlySatisfied) {
          specs.push({
            type: 'NodeReady',
            streamId: `node:${candidate.id}`,
            payload: {
              goalId: candidate.goalId,
              planId: candidate.planId,
              nodeId: candidate.id,
              reason: 'dependencies-satisfied'
            }
          });
        }
        const completesGoal = goal?.status === GoalStatus.ACTIVE
          && (goal.integrationTargetRef === null
            || goal.integrationTargetRef === integration.targetRef)
          && !goal.nodeIds.some((nodeId) => affectedNodeIdSet.has(nodeId))
          && goal.nodeIds.every((nodeId) => {
            const candidate = latest.projection.nodes.find((item) => item.id === nodeId);
            if (candidate?.status !== NodeStatus.ACCEPTED
              || candidate.validity !== Validity.VALID) return false;
            if (candidate.id === node.id) {
              return candidate.acceptedChangeSetId === integration.changeSetId;
            }
            return candidate.integrationStatus === IntegrationStatus.INTEGRATED
              && candidate.integratedChangeSetId === candidate.acceptedChangeSetId
              && candidate.integratedTargetRef === integration.targetRef;
          });
        if (completesGoal) {
          specs.push({
            type: 'GoalCompleted',
            streamId: `goal:${goal.id}`,
            payload: {
              goalId: goal.id,
              planId: goal.planId,
              integrationId,
              targetRef: integration.targetRef,
              revision: integration.candidateRevision
            }
          });
        }
        for (const nodeId of affectedNodeIds) {
          specs.push({
            type: 'NodeMarkedStale',
            streamId: `node:${nodeId}`,
            payload: {
              integrationId,
              nodeId,
              sourceNodeId: node.id,
              changedRefIds,
              recomputeRoot: recomputeRootNodeIds.includes(nodeId)
            }
          });
        }
        for (const affectedGoal of latest.projection.goals
          .filter((candidate) => candidate.status === GoalStatus.COMPLETED)
          .filter((candidate) => candidate.nodeIds.some((nodeId) => (
            affectedNodeIdSet.has(nodeId)
          )))
          .sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
          reopenedGoalIds.push(affectedGoal.id);
          specs.push({
            type: 'GoalReopened',
            streamId: `goal:${affectedGoal.id}`,
            payload: { integrationId, goalId: affectedGoal.id }
          });
        }
        for (const refId of changedRefIds) {
          const ref = (latest.projection.refs ?? []).find(
            (candidate) => candidate.id === refId
          );
          if (!ref) {
            throw new IntegrationOrchestrationError(
              `Integration ${integrationId} lost changed Ref ${refId}.`,
              'integration-ref-binding-mismatch'
            );
          }
          const changedFiles = candidateEffects.changedFiles.filter((file) => (
            matchesEffectPattern(ref.uri, file, {
              ignoreCase: changeSet.coreIgnoreCase === true
            })
          ));
          specs.push({
            type: 'RefVersionAdvanced',
            streamId: `ref:${ref.id}`,
            payload: {
              integrationId,
              changeSetId: changeSet.id,
              refId: ref.id,
              previousVersion: ref.version,
              previousHash: ref.hash,
              version: integration.candidateRevision,
              hash: refVersionDigest({
                ref: refContract(ref),
                revision: integration.candidateRevision,
                changedFiles: candidateEffects.changedFiles,
                changes: candidateEffects.changes,
                ignoreCase: changeSet.coreIgnoreCase === true
              }),
              changedFiles
            }
          });
        }
        specs.push({
          type: 'IntegrationEffectsApplied',
          streamId: `integration:${integrationId}`,
          payload: {
            integrationId,
            affectedNodeIds,
            recomputeRootNodeIds,
            reopenedGoalIds,
            advancedRefIds: changedRefIds
          }
        });
        return specs;
      }
    });
  }

  async #recordFailed({ integrationId, correlationId, phase, failure }) {
    await this.#appendDerived({
      commandId: this.#internalCommand(integrationId, `failed-${phase}`),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'FailIntegration',
        integrationId,
        phase,
        failure
      },
      build: (latest) => {
        const integration = this.#requireIntegration(latest.projection, integrationId);
        const node = latest.projection.nodes.find(
          (candidate) => candidate.id === integration.nodeId
        );
        if (!node || !isActiveIntegration(integration)) {
          throw new IntegrationOrchestrationError(
            `Integration ${integrationId} is not active.`,
            'integration-not-active'
          );
        }
        const links = {
          integrationId,
          nodeId: node.id,
          changeSetId: integration.changeSetId,
          phase,
          failure
        };
        return [
          {
            type: 'IntegrationFailed',
            streamId: `integration:${integrationId}`,
            payload: links
          },
          {
            type: 'NodeIntegrationFailed',
            streamId: `node:${node.id}`,
            payload: {
              integrationId,
              nodeId: node.id,
              changeSetId: integration.changeSetId
            }
          }
        ];
      }
    });
  }

  async #recordRecoveryRequired({ integrationId, correlationId, phase, failure }) {
    const current = this.#requireIntegration((await this.#readState()).projection, integrationId);
    if (current.status === IntegrationStatus.RECOVERY_REQUIRED) return;
    await this.#appendDerived({
      commandId: this.#internalCommand(integrationId, 'recovery-required'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'RequireIntegrationRecovery',
        integrationId,
        phase,
        failure
      },
      build: (latest) => {
        const integration = this.#requireIntegration(latest.projection, integrationId);
        const node = latest.projection.nodes.find(
          (candidate) => candidate.id === integration.nodeId
        );
        if (!node || integration.status !== IntegrationStatus.RUNNING) {
          throw new IntegrationOrchestrationError(
            `Integration ${integrationId} is not running.`,
            'integration-not-running'
          );
        }
        const links = {
          integrationId,
          nodeId: node.id,
          changeSetId: integration.changeSetId,
          phase,
          failure
        };
        return [
          {
            type: 'IntegrationRecoveryRequired',
            streamId: `integration:${integrationId}`,
            payload: links
          },
          {
            type: 'NodeIntegrationRecoveryRequired',
            streamId: `node:${node.id}`,
            payload: {
              integrationId,
              nodeId: node.id,
              changeSetId: integration.changeSetId
            }
          }
        ];
      }
    });
  }

  async #settleFailedAttempt({ integrationId, correlationId, workspace, error }) {
    let state = await this.#readState();
    let integration = this.#requireIntegration(state.projection, integrationId);
    if (!isActiveIntegration(integration)) return;
    const failure = failureFrom(error, 'INTEGRATION_FAILED');
    if (integration.candidateRevision === null) {
      await this.#recordFailed({
        integrationId,
        correlationId,
        phase: integration.status === IntegrationStatus.PENDING ? 'setup' : 'preparation',
        failure
      });
      return;
    }
    let inspection;
    const request = this.#gitRequest(integration);
    try {
      inspection = validateInspection(await workspace.inspect(request), request);
    } catch (inspectionError) {
      await this.#recordRecoveryRequired({
        integrationId,
        correlationId,
        phase: 'promotion',
        failure: {
          code: 'INTEGRATION_PROMOTION_STATE_UNKNOWN',
          message: 'Promotion failed and the target state could not be proven.',
          details: {
            originalFailure: failure,
            inspectionFailure: failureFrom(
              inspectionError,
              'INTEGRATION_INSPECTION_FAILED'
            )
          }
        }
      });
      return;
    }
    if (inspection.disposition === 'applied') {
      await this.#recordApplied({ integrationId, correlationId });
      return;
    }
    if (inspection.disposition === 'advanced') {
      await this.#recordRecoveryRequired({
        integrationId,
        correlationId,
        phase: 'promotion',
        failure: {
          code: 'INTEGRATION_TARGET_ADVANCED_AFTER_CANDIDATE',
          message: 'The target contains the candidate but has advanced beyond it; the durable project revision cannot be inferred.',
          details: { originalFailure: failure, inspection: cloneJson(inspection) }
        }
      });
      return;
    }
    if (['not-applied', 'diverged'].includes(inspection.disposition)) {
      const terminalFailure = inspection.disposition === 'diverged'
        ? {
            code: 'INTEGRATION_TARGET_DIVERGED',
            message: 'The target branch advanced without the prepared candidate.',
            details: { originalFailure: failure, inspection: cloneJson(inspection) }
          }
        : failure;
      await this.#recordFailed({
        integrationId,
        correlationId,
        phase: 'promotion',
        failure: terminalFailure
      });
      return;
    }
    await this.#recordRecoveryRequired({
      integrationId,
      correlationId,
      phase: 'promotion',
      failure: {
        code: 'INTEGRATION_TARGET_AMBIGUOUS',
        message: 'Promotion failed after the target branch entered an ambiguous state.',
        details: { originalFailure: failure, inspection: cloneJson(inspection) }
      }
    });
  }

  async #existingResult(state, commandId, integrationId, lease, candidateWorkspace = undefined) {
    const integration = this.#requireIntegration(state.projection, integrationId);
    if (isActiveIntegration(integration)) {
      throw new IntegrationOrchestrationError(
        `Integration ${integrationId} is still ${integration.status}; reconcile it before retrying.`,
        'integration-reconciliation-required',
        { integrationId, status: integration.status }
      );
    }
    await retryUnstartedLeaseOperation(lease, () => lease.init());
    const inspection = await retryUnstartedLeaseOperation(lease, () => lease.inspect());
    const stillOwnsLease = inspection.held
      && inspection.lease.ownerKind === 'integration'
      && inspection.lease.ownerId === integrationId;
    const cleanup = {
      leaseReleased: !stillOwnsLease,
      warnings: []
    };
    if (integration.strategy === GATED_MERGE_STRATEGY) {
      cleanup.candidateWorkspaceRemoved = false;
      await removeCandidateWorkspace(candidateWorkspace, {
        ownerId: integration.id,
        workspacePath: integration.candidateWorkspacePath,
        cleanup,
        failureCode: 'INTEGRATION_WORKSPACE_CLEANUP_FAILED'
      });
    }
    return this.#resultFromState(state, commandId, integrationId, false, cleanup);
  }

  async #existingReversionResult(
    state,
    commandId,
    reversionId,
    lease,
    candidateWorkspace = undefined
  ) {
    const reversion = this.#requireReversion(state.projection, reversionId);
    if (isActiveReversion(reversion)) {
      throw new IntegrationOrchestrationError(
        `Reversion ${reversionId} is still ${reversion.status}; reconcile it before retrying.`,
        'reversion-reconciliation-required',
        { reversionId, status: reversion.status }
      );
    }
    await retryUnstartedLeaseOperation(lease, () => lease.init());
    const inspection = await retryUnstartedLeaseOperation(lease, () => lease.inspect());
    const stillOwnsLease = inspection.held
      && inspection.lease.ownerKind === 'reversion'
      && inspection.lease.ownerId === reversionId;
    const cleanup = {
      leaseReleased: !stillOwnsLease,
      candidateWorkspaceRemoved: false,
      warnings: []
    };
    await removeCandidateWorkspace(candidateWorkspace, {
      ownerId: reversion.id,
      workspacePath: reversion.candidateWorkspacePath,
      cleanup,
      failureCode: 'REVERSION_WORKSPACE_CLEANUP_FAILED'
    });
    return this.#resultReversionFromState(state, commandId, reversionId, false, cleanup);
  }

  async #reversionResult(commandId, reversionId, appended, cleanup) {
    return this.#resultReversionFromState(
      await this.#readState(),
      commandId,
      reversionId,
      appended,
      cleanup
    );
  }

  #resultReversionFromState(state, commandId, reversionId, appended, cleanup) {
    const selected = this.#selectReversionInputs(state.projection, reversionId);
    const projectRevision = (state.projection.projectRevisions ?? []).find(
      (candidate) => candidate.reversionId === reversionId
    ) ?? null;
    const revertChangeSet = selected.reversion.revertChangeSetId === null
      ? null
      : state.projection.changeSets.find(
          (candidate) => candidate.id === selected.reversion.revertChangeSetId
        ) ?? null;
    return {
      ok: selected.reversion.status === ReversionStatus.REVERTED,
      appended,
      commandId,
      ...selected,
      revertChangeSet,
      projectRevision,
      cleanup
    };
  }

  async #integrationResult(commandId, integrationId, appended, cleanup) {
    return this.#resultFromState(
      await this.#readState(),
      commandId,
      integrationId,
      appended,
      cleanup
    );
  }

  #resultFromState(state, commandId, integrationId, appended, cleanup) {
    const selected = this.#selectIntegrationInputs(state.projection, integrationId);
    const projectRevision = (state.projection.projectRevisions ?? []).find(
      (candidate) => candidate.integrationId === integrationId
    ) ?? null;
    return {
      ok: selected.integration.status === IntegrationStatus.INTEGRATED,
      appended,
      commandId,
      ...selected,
      projectRevision,
      cleanup
    };
  }

  async #appendDerived({ commandId, correlationId, intent, build }) {
    const intentHash = hashCanonicalValue(intent);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const state = await this.#readState();
        const existing = recordedBatch(state.store, commandId, intentHash);
        if (existing) return { appended: false, batch: existing, state };
        const specs = build(state);
        if (!Array.isArray(specs) || specs.length === 0) {
          throw new IntegrationOrchestrationError(
            'A derived integration batch must contain at least one event.',
            'empty-integration-event-batch'
          );
        }
        const events = this.#materializeEvents(state, correlationId, specs);
        projectEvents([...state.store.events, ...events]);
        const write = await this.#appendBatch(commandId, events, {
          expectedLastSequence: state.store.lastSequence,
          intentHash
        });
        return { appended: write.appended, batch: write.batch, state: await this.#readState() };
      } catch (error) {
        const retryable = error?.code === 'concurrency-conflict'
          || error?.code === 'event-store-locked'
          || (error?.code === 'lock-acquire-failed'
            && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.cause?.code));
        if (!retryable || attempt >= this.lockRetryDelays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.lockRetryDelays[attempt]));
      }
    }
  }

  #materializeEvents(state, correlationId, specs) {
    const versions = new Map(Object.entries(state.projection.streamVersions));
    return specs.map((spec, index) => {
      const streamVersion = (versions.get(spec.streamId) ?? 0) + 1;
      versions.set(spec.streamId, streamVersion);
      return createEvent({
        type: spec.type,
        streamId: spec.streamId,
        sequence: state.store.lastSequence + index + 1,
        occurredAt: this.clock(),
        actor: this.actor,
        correlationId,
        causationId: spec.causationId ?? null,
        payload: spec.payload,
        metadata: { streamVersion }
      }, { idFactory: () => this.#id('event') });
    });
  }

  async #readState() {
    return this.#withRetry(async () => {
      const project = loadProject(this.projectRoot);
      const store = await this.store.readAll();
      return { project, store, projection: projectEvents(store.events) };
    });
  }

  async #appendBatch(commandId, events, options) {
    try {
      return await this.store.appendBatch(commandId, events, options);
    } catch (error) {
      if (typeof error?.recoveryLockId !== 'string'
        || typeof this.store.releaseOwnedLock !== 'function') {
        throw error;
      }
      try {
        await this.store.releaseOwnedLock({ expectedLockId: error.recoveryLockId });
      } catch (recoveryError) {
        Object.defineProperty(error, 'lockRecoveryError', {
          value: recoveryError,
          enumerable: false
        });
        throw error;
      }
      if (Object.hasOwn(error, 'recoveryResult')) return error.recoveryResult;
      throw error;
    }
  }

  async #withRetry(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryable = error?.code === 'event-store-locked'
          || (error?.code === 'lock-acquire-failed'
            && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.cause?.code));
        if (!retryable || attempt >= this.lockRetryDelays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.lockRetryDelays[attempt]));
      }
    }
  }

  #now() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new IntegrationOrchestrationError('clock returned an invalid date.', 'invalid-clock');
    }
    return date;
  }

  #id(prefix) {
    return `${prefix}_${requireTrimmedString(this.idFactory(), `${prefix} id`)}`;
  }

  #internalCommand(integrationId, phase) {
    return `${INTERNAL_COMMAND_PREFIX}integration/${integrationId}/${phase}`;
  }

  #internalReversionCommand(reversionId, phase) {
    return `${INTERNAL_COMMAND_PREFIX}reversion/${reversionId}/${phase}`;
  }
}
