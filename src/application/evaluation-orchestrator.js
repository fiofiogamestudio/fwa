import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { assertEvaluator } from '../core/evaluator.js';
import { createEvent, stableStringify } from '../core/events.js';
import {
  EvaluationStatus,
  IntegrationStatus,
  NodeStatus,
  ReversionStatus,
  RunStatus
} from '../core/state-machines.js';
import { hashCanonicalValue } from '../storage/file-event-store.js';
import { loadProject } from './project.js';
import { projectEvents } from './projection.js';
import { settleLeaseOperation, startLeaseHeartbeat } from './lease-operations.js';

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_ORPHAN_GRACE_MS = 5_000;
const DEFAULT_LOCK_RETRY_DELAYS = Object.freeze([5, 10, 20, 40, 80]);
const INTERNAL_COMMAND_PREFIX = '@fwa/';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class EvaluationOrchestrationError extends Error {
  constructor(message, code = 'evaluation-orchestration-error', details = undefined) {
    super(message);
    this.name = 'EvaluationOrchestrationError';
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

function requireTrimmedString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new EvaluationOrchestrationError(
      `${name} must be a non-empty, trimmed string.`,
      'invalid-evaluation-command'
    );
  }
  return value;
}

function requirePublicCommandId(value) {
  const commandId = requireTrimmedString(value, 'commandId');
  if (commandId.startsWith(INTERNAL_COMMAND_PREFIX)) {
    throw new EvaluationOrchestrationError(
      `commandId prefix ${INTERNAL_COMMAND_PREFIX} is reserved for FWA transactions.`,
      'reserved-command-id'
    );
  }
  return commandId;
}

function requireSafeDuration(value, name, fallback) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 86_400_000) {
    throw new EvaluationOrchestrationError(
      `${name} must be a positive safe integer no greater than one day.`,
      'invalid-evaluation-command'
    );
  }
  return selected;
}

function cloneJson(value, name) {
  try {
    return JSON.parse(stableStringify(value));
  } catch (error) {
    throw new EvaluationOrchestrationError(
      `${name} must be a JSON value: ${error.message}`,
      'invalid-evaluation-command',
      { name }
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
  const code = typeof error?.code === 'string' ? error.code : fallbackCode;
  const message = typeof error?.message === 'string' ? error.message : String(error);
  const details = error?.details !== undefined
    ? optionalJson(redactSecrets(error.details))
    : error?.errors !== undefined
      ? { errors: optionalJson(redactSecrets(error.errors)) }
      : null;
  return { code, message, details };
}

function normalizeFailureRecord(value, name) {
  if (value === null) return null;
  if (!isPlainObject(value)
    || typeof value.code !== 'string'
    || value.code.length === 0
    || typeof value.message !== 'string'
    || value.message.length === 0) {
    throw new EvaluationOrchestrationError(
      `${name} is not a valid failure record.`,
      'invalid-evaluator-result'
    );
  }
  return {
    code: value.code,
    message: value.message,
    details: Object.hasOwn(value, 'details')
      ? cloneJson(value.details, `${name}.details`)
      : null
  };
}

function assertPort(port, name, methods) {
  if (!isPlainObject(port) && (port === null || typeof port !== 'object')) {
    throw new EvaluationOrchestrationError(
      `${name} must be an adapter object.`,
      'invalid-evaluation-port'
    );
  }
  const missing = methods.filter((method) => typeof port?.[method] !== 'function');
  if (missing.length > 0) {
    throw new EvaluationOrchestrationError(
      `${name} is missing method(s): ${missing.join(', ')}.`,
      'invalid-evaluation-port',
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

function assertSerialOperationAvailable(projection) {
  const runs = projection.runs.filter(isActiveRun);
  const evaluations = (projection.evaluations ?? []).filter(isActiveEvaluation);
  const integrations = (projection.integrations ?? []).filter((integration) => [
    IntegrationStatus.PENDING,
    IntegrationStatus.RUNNING,
    IntegrationStatus.RECOVERY_REQUIRED
  ].includes(integration.status));
  const reversions = (projection.reversions ?? []).filter((reversion) => [
    ReversionStatus.PENDING,
    ReversionStatus.RUNNING,
    ReversionStatus.RECOVERY_REQUIRED
  ].includes(reversion.status));
  if (runs.length > 0 || evaluations.length > 0
    || integrations.length > 0 || reversions.length > 0) {
    throw new EvaluationOrchestrationError(
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
    throw new EvaluationOrchestrationError(
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
    throw new EvaluationOrchestrationError(
      `Recorded command ${batch.commandId} has no ${type} event.`,
      'recorded-command-type-mismatch'
    );
  }
  return event;
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

function normalizeAcceptance(node, evaluator, profile) {
  const acceptance = node.acceptance;
  const actualIds = profile.checks.map((check) => check.id);
  if (typeof acceptance === 'string') {
    if (profile.id !== acceptance) {
      throw new EvaluationOrchestrationError(
        `Evaluation profile ${profile.id} does not resolve acceptance contract ${acceptance}.`,
        'evaluation-contract-mismatch',
        { expectedContractId: acceptance, actualProfileId: profile.id }
      );
    }
    return { contractId: acceptance, requiredCriteria: actualIds };
  }
  if (!isPlainObject(acceptance)) {
    throw new EvaluationOrchestrationError(
      `Node ${node.id} has no usable acceptance contract.`,
      'evaluation-contract-mismatch'
    );
  }

  const allowedEvaluators = acceptance.evaluators ?? [];
  if (allowedEvaluators.length > 0
    && !allowedEvaluators.includes(evaluator.id)) {
    throw new EvaluationOrchestrationError(
      `Node ${node.id} does not allow evaluator ${evaluator.id}.`,
      'evaluation-evaluator-mismatch',
      { requiredEvaluators: allowedEvaluators, actualEvaluator: evaluator.id }
    );
  }
  const required = [...(acceptance.commands ?? []), ...(acceptance.checks ?? [])];
  if (required.length === 0) {
    throw new EvaluationOrchestrationError(
      `Node ${node.id} acceptance does not name any command/check criterion.`,
      'evaluation-contract-mismatch'
    );
  }
  const requiredSet = new Set(required);
  if (requiredSet.size !== required.length) {
    throw new EvaluationOrchestrationError(
      `Node ${node.id} acceptance repeats a criterion across fields.`,
      'evaluation-contract-mismatch',
      { criteria: required }
    );
  }
  const actualSet = new Set(actualIds);
  const missing = required.filter((id) => !actualSet.has(id));
  const unexpected = actualIds.filter((id) => !requiredSet.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new EvaluationOrchestrationError(
      `Evaluation profile does not exactly cover node ${node.id}'s acceptance criteria.`,
      'evaluation-contract-mismatch',
      { missing, unexpected }
    );
  }
  return { contractId: null, requiredCriteria: required };
}

function validateEnvironmentFingerprint(value) {
  if (!isPlainObject(value)
    || typeof value.platform !== 'string'
    || typeof value.arch !== 'string'
    || !isPlainObject(value.runtime)
    || typeof value.runtime.name !== 'string'
    || typeof value.runtime.version !== 'string'
    || typeof value.environmentSha256 !== 'string'
    || !SHA256_PATTERN.test(value.environmentSha256)) {
    throw new EvaluationOrchestrationError(
      'Evaluator returned an invalid environment fingerprint.',
      'invalid-evaluator-result'
    );
  }
  return {
    platform: value.platform,
    arch: value.arch,
    runtime: cloneJson(value.runtime, 'environment runtime'),
    environmentSha256: `sha256:${value.environmentSha256}`
  };
}

function decodeArtifactBytes(value, context) {
  if (typeof value !== 'string') {
    throw new EvaluationOrchestrationError(
      `${context} bytesBase64 must be a string.`,
      'invalid-evaluator-result'
    );
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new EvaluationOrchestrationError(
      `${context} bytesBase64 is not canonical base64.`,
      'invalid-evaluator-result'
    );
  }
  return bytes;
}

async function putVerified(artifacts, bytes) {
  const ref = await artifacts.put(bytes);
  await artifacts.verify(ref);
  return ref;
}

async function materializeEvidence({
  artifacts,
  evaluator,
  profile,
  profileArtifact,
  rawResult,
  workspaceInspection,
  evaluation,
  evidenceId
}) {
  const result = cloneJson(rawResult, 'evaluator result');
  if (!isPlainObject(result)
    || !isPlainObject(result.evaluator)
    || result.evaluator.id !== evaluator.id
    || result.evaluator.version !== evaluator.version
    || !isPlainObject(result.manifest)
    || result.manifest.id !== profile.id
    || result.manifest.schemaVersion !== profile.schemaVersion
    || !Array.isArray(result.checks)
    || result.checks.length !== profile.checks.length) {
    throw new EvaluationOrchestrationError(
      'Evaluator result does not match its evaluator, profile, or complete check set.',
      'invalid-evaluator-result'
    );
  }

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
      throw new EvaluationOrchestrationError(
        `Evaluator returned a malformed or mismatched result for criterion ${expected.id}.`,
        'invalid-evaluator-result',
        { criterionId: expected.id }
      );
    }

    const stdoutArtifact = await putVerified(artifacts, Buffer.from(actual.stdout, 'utf8'));
    const stderrArtifact = await putVerified(artifacts, Buffer.from(actual.stderr, 'utf8'));
    const expectedArtifacts = [];
    for (let artifactIndex = 0;
      artifactIndex < expected.expectedArtifacts.length;
      artifactIndex += 1) {
      const expectedSpec = expected.expectedArtifacts[artifactIndex];
      const observed = actual.expectedArtifacts[artifactIndex];
      if (!isPlainObject(observed) || observed.path !== expectedSpec.path) {
        throw new EvaluationOrchestrationError(
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
          || !SHA256_PATTERN.test(observed.digest)) {
          throw new EvaluationOrchestrationError(
            `Evaluator artifact metadata is invalid for ${expectedSpec.path}.`,
            'invalid-evaluator-result'
          );
        }
        artifact = await putVerified(artifacts, bytes);
        if (!sameDigest(artifact.digest, observed.digest)) {
          throw new EvaluationOrchestrationError(
            `Evaluator artifact digest is false for ${expectedSpec.path}.`,
            'invalid-evaluator-result'
          );
        }
        digest = observed.digest;
        size = observed.size;
      } else if (observed.digest !== null || observed.size !== null) {
        throw new EvaluationOrchestrationError(
          `Evaluator returned a partial artifact binding for ${expectedSpec.path}.`,
          'invalid-evaluator-result'
        );
      }
      let artifactFailure = normalizeFailureRecord(
        observed.failure,
        'expected artifact failure'
      );
      if (artifactFailure === null
        && expectedSpec.size !== null
        && size !== expectedSpec.size) {
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
      terminationConfirmed: actual.terminationConfirmed === true,
      durationMs: actual.durationMs,
      stdoutArtifact,
      stderrArtifact,
      expectedArtifacts,
      failure: normalizeFailureRecord(actual.failure, 'criterion failure')
    });
  }

  const policyViolations = (workspaceInspection.trackedChanges ?? []).map((change) => ({
    code: 'EVALUATION_MUTATED_TRACKED_FILE',
    message: `Evaluation changed tracked path ${change.path}.`,
    details: cloneJson(change, 'workspace change')
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
  const evidenceResult = derivedPass && policyViolations.length === 0 ? 'pass' : 'fail';
  const resultEnvelope = {
    schemaVersion: 1,
    evaluator: { id: evaluator.id, version: evaluator.version },
    profile: {
      id: profile.id,
      schemaVersion: profile.schemaVersion,
      sha256: `sha256:${profileArtifact.digest}`
    },
    environmentFingerprint,
    result: evidenceResult,
    criteria,
    policyViolations
  };
  const resultArtifact = await putVerified(
    artifacts,
    Buffer.from(stableStringify(resultEnvelope), 'utf8')
  );
  return {
    evidenceId,
    evaluationId: evaluation.id,
    nodeId: evaluation.nodeId,
    runId: evaluation.runId,
    changeSetId: evaluation.changeSetId,
    headRevision: evaluation.headRevision,
    kind: 'command-evaluation',
    result: evidenceResult,
    evaluator: { id: evaluator.id, version: evaluator.version },
    profileArtifact,
    resultArtifact,
    environmentFingerprint,
    criteria,
    policyViolations
  };
}



export class EvaluationOrchestrator {
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

  async evaluateChangeSet({
    changeSetId,
    profile,
    evaluator,
    workspace,
    lease,
    artifacts,
    commandId,
    signal,
    leaseTtlMs
  } = {}) {
    assertEvaluator(evaluator);
    assertPort(workspace, 'workspace', [
      'verifyChangeSet',
      'createEvaluation',
      'inspectEvaluation',
      'removeEvaluation'
    ]);
    assertPort(lease, 'lease', [
      'init', 'inspect', 'acquire', 'heartbeat', 'release', 'archiveStale'
    ]);
    assertPort(artifacts, 'artifacts', ['init', 'put', 'verify']);
    const normalizedChangeSetId = requireTrimmedString(changeSetId, 'changeSetId');
    const normalizedProfile = cloneJson(
      evaluator.normalizeProfile(profile),
      'normalized evaluation profile'
    );
    const normalizedCommandId = commandId === undefined
      ? this.#id('command')
      : requirePublicCommandId(commandId);
    const ttlMs = requireSafeDuration(leaseTtlMs, 'leaseTtlMs', DEFAULT_LEASE_TTL_MS);
    const evaluatorIdentity = { id: evaluator.id, version: evaluator.version };
    const intent = {
      schemaVersion: 1,
      type: 'EvaluateChangeSet',
      changeSetId: normalizedChangeSetId,
      evaluator: evaluatorIdentity,
      profile: normalizedProfile
    };
    const intentHash = hashCanonicalValue(intent);
    let state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
    if (existing) {
      const requested = eventFromBatch(existing, 'EvaluationRequested');
      return this.#existingEvaluationResult(
        state,
        normalizedCommandId,
        requested.payload.evaluationId,
        lease
      );
    }

    await settleLeaseOperation(lease, () => lease.init());
    await artifacts.init();
    const evaluationId = this.#id('evaluation');
    let capability;
    let requestedRecorded = false;
    let startedRecorded = false;
    let terminalRecorded = false;
    let workspaceResult = null;
    let heartbeat = null;
    let releaseLease = true;
    const cleanup = {
      worktreeRemoved: false,
      leaseReleased: false,
      warnings: []
    };

    try {
      capability = await settleLeaseOperation(lease, () => lease.acquire({
        ownerKind: 'evaluation',
        ownerId: evaluationId,
        ttlMs
      }));
      state = await this.#readState();
      const racedExisting = recordedBatch(state.store, normalizedCommandId, intentHash);
      if (racedExisting) {
        const requested = eventFromBatch(racedExisting, 'EvaluationRequested');
        const replay = await this.#existingEvaluationResult(
          state,
          normalizedCommandId,
          requested.payload.evaluationId,
          lease
        );
        cleanup.worktreeRemoved = replay.cleanup.worktreeRemoved;
        return { ...replay, cleanup };
      }
      assertSerialOperationAvailable(state.projection);
      const selected = this.#selectChangeSet(state.projection, normalizedChangeSetId);
      const acceptance = normalizeAcceptance(selected.node, evaluator, normalizedProfile);
      await workspace.verifyChangeSet(selected.changeSet);

      const profileBytes = Buffer.from(stableStringify(normalizedProfile), 'utf8');
      const profileArtifact = await putVerified(artifacts, profileBytes);
      const profileHash = `sha256:${profileArtifact.digest}`;
      await this.#appendDerived({
        commandId: normalizedCommandId,
        correlationId: normalizedCommandId,
        intent,
        build: (latest) => {
          assertSerialOperationAvailable(latest.projection);
          const current = this.#selectChangeSet(latest.projection, normalizedChangeSetId);
          normalizeAcceptance(current.node, evaluator, normalizedProfile);
          return [{
            type: 'EvaluationRequested',
            streamId: `evaluation:${evaluationId}`,
            payload: {
              evaluationId,
              nodeId: current.node.id,
              runId: current.run.id,
              changeSetId: current.changeSet.id,
              headRevision: current.changeSet.headRevision,
              evaluator: evaluatorIdentity,
              profileHash,
              profileArtifact,
              workspaceRelativePath: `.fwa/evaluations/${evaluationId}`,
              contractId: acceptance.contractId,
              requiredCriteria: acceptance.requiredCriteria
            }
          }];
        }
      });
      requestedRecorded = true;

      workspaceResult = await workspace.createEvaluation({
        evaluationId,
        revision: selected.changeSet.headRevision
      });
      await this.#appendDerived({
        commandId: this.#internalCommand(evaluationId, 'started'),
        correlationId: normalizedCommandId,
        intent: {
          schemaVersion: 1,
          type: 'StartEvaluation',
          evaluationId,
          workspacePath: workspaceResult.workspacePath,
          leaseId: capability.lease.leaseId,
          headRevision: selected.changeSet.headRevision
        },
        build: (latest) => {
          const evaluation = latest.projection.evaluations.find(
            (candidate) => candidate.id === evaluationId
          );
          const node = latest.projection.nodes.find(
            (candidate) => candidate.id === evaluation?.nodeId
          );
          if (!evaluation || !node
            || evaluation.status !== EvaluationStatus.REQUESTED
            || node.status !== NodeStatus.PRODUCED) {
            throw new EvaluationOrchestrationError(
              `Evaluation ${evaluationId} is no longer startable.`,
              'evaluation-not-requested'
            );
          }
          return [
            {
              type: 'EvaluationExecutionStarted',
              streamId: `evaluation:${evaluationId}`,
              payload: {
                evaluationId,
                workspacePath: workspaceResult.workspacePath,
                leaseId: capability.lease.leaseId,
                headRevision: evaluation.headRevision
              }
            },
            {
              type: 'NodeEvaluationStarted',
              streamId: `node:${node.id}`,
              payload: {
                nodeId: node.id,
                evaluationId,
                runId: evaluation.runId,
                changeSetId: evaluation.changeSetId
              }
            }
          ];
        }
      });
      startedRecorded = true;

      heartbeat = startLeaseHeartbeat(lease, capability, ttlMs, signal);
      const rawResult = await evaluator.evaluate({
        workspaceRoot: workspaceResult.workspacePath,
        manifest: normalizedProfile,
        signal: heartbeat.signal
      });
      await heartbeat.stop();
      heartbeat = null;
      const workspaceInspection = await workspace.inspectEvaluation({
        evaluationId,
        workspacePath: workspaceResult.workspacePath,
        revision: selected.changeSet.headRevision
      });
      const latest = await this.#readState();
      const evaluation = latest.projection.evaluations.find(
        (candidate) => candidate.id === evaluationId
      );
      if (!evaluation || evaluation.status !== EvaluationStatus.RUNNING) {
        throw new EvaluationOrchestrationError(
          `Evaluation ${evaluationId} is no longer running.`,
          'evaluation-not-running'
        );
      }
      const evidenceId = this.#id('evidence');
      const evidence = await materializeEvidence({
        artifacts,
        evaluator,
        profile: normalizedProfile,
        profileArtifact,
        rawResult,
        workspaceInspection,
        evaluation,
        evidenceId
      });

      const passed = evidence.result === 'pass';
      await this.#appendDerived({
        commandId: this.#internalCommand(evaluationId, 'finished'),
        correlationId: normalizedCommandId,
        intent: {
          schemaVersion: 1,
          type: 'FinishEvaluation',
          evaluationId,
          evidence
        },
        build: (currentState) => {
          const current = currentState.projection.evaluations.find(
            (candidate) => candidate.id === evaluationId
          );
          const node = currentState.projection.nodes.find(
            (candidate) => candidate.id === current?.nodeId
          );
          if (!current || !node
            || current.status !== EvaluationStatus.RUNNING
            || node.status !== NodeStatus.EVALUATING) {
            throw new EvaluationOrchestrationError(
              `Evaluation ${evaluationId} is no longer finishable.`,
              'evaluation-not-running'
            );
          }
          const links = {
            evaluationId,
            evidenceId,
            nodeId: current.nodeId,
            runId: current.runId,
            changeSetId: current.changeSetId
          };
          return [
            {
              type: 'EvidenceRecorded',
              streamId: `evidence:${evidenceId}`,
              payload: evidence
            },
            {
              type: passed ? 'EvaluationPassed' : 'EvaluationRejected',
              streamId: `evaluation:${evaluationId}`,
              payload: links
            },
            {
              type: passed ? 'NodeAccepted' : 'NodeRejected',
              streamId: `node:${node.id}`,
              payload: links
            }
          ];
        }
      });
      terminalRecorded = true;

      await this.#cleanupTerminalEvaluation({
        workspace,
        evaluationId,
        correlationId: normalizedCommandId,
        cleanup
      });
      return await this.#evaluationResult(
        normalizedCommandId,
        evaluationId,
        true,
        cleanup
      );
    } catch (error) {
      if (heartbeat) {
        try {
          await heartbeat.stop();
        } catch (heartbeatError) {
          if (error?.heartbeatError === undefined) error.heartbeatError = heartbeatError;
        }
      }
      if (requestedRecorded) {
        if (terminalRecorded) throw error;
        if (startedRecorded && error?.code === 'FWA_PROCESS_TERMINATION_UNCONFIRMED') {
          releaseLease = true;
          await this.#recordRecoveryRequired({
            evaluationId,
            correlationId: normalizedCommandId,
            failure: failureFrom(error, 'EVALUATION_TERMINATION_UNCONFIRMED'),
            phase: 'evaluation'
          });
        } else if (startedRecorded) {
          await this.#recordInterrupted({
            evaluationId,
            correlationId: normalizedCommandId,
            failure: failureFrom(error, 'EVALUATION_INFRASTRUCTURE_FAILED'),
            phase: 'evaluation',
            workspaceDisposition: 'preserved',
            deferNode: true
          });
        } else {
          const disposition = await this.#cleanupInterruptedSetup({
            workspace,
            evaluationId,
            workspaceResult
          });
          await this.#recordInterrupted({
            evaluationId,
            correlationId: normalizedCommandId,
            failure: failureFrom(error, 'EVALUATION_SETUP_FAILED'),
            phase: 'setup',
            workspaceDisposition: disposition,
            deferNode: false
          });
          cleanup.worktreeRemoved = disposition === 'removed';
        }
        return await this.#evaluationResult(
          normalizedCommandId,
          evaluationId,
          true,
          cleanup
        );
      }
      throw error;
    } finally {
      if (capability && releaseLease) {
        try {
          await settleLeaseOperation(lease, () => lease.release({
            leaseId: capability.lease.leaseId,
            ownerToken: capability.ownerToken
          }));
          cleanup.leaseReleased = true;
        } catch (error) {
          cleanup.warnings.push({
            phase: 'lease-release',
            failure: failureFrom(error, 'EVALUATION_LEASE_RELEASE_FAILED')
          });
        }
      }
    }
  }

  async reconcile({
    workspace,
    lease,
    correlationId,
    orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS
  } = {}) {
    assertPort(workspace, 'workspace', ['removeEvaluation']);
    assertPort(lease, 'lease', [
      'init', 'inspect', 'acquire', 'heartbeat', 'release', 'archiveStale'
    ]);
    const requestedCorrelationId = correlationId === undefined
      ? this.#id('command')
      : requirePublicCommandId(correlationId);
    const graceMs = requireSafeDuration(orphanGraceMs, 'orphanGraceMs', DEFAULT_ORPHAN_GRACE_MS);
    await settleLeaseOperation(lease, () => lease.init());
    let state = await this.#readState();
    const activeRun = state.projection.runs.find(isActiveRun);
    if (activeRun) {
      return {
        ok: true,
        reconciled: false,
        reason: 'run-operation-active',
        run: activeRun
      };
    }
    const activeIntegration = (state.projection.integrations ?? []).find(
      (integration) => [
        IntegrationStatus.PENDING,
        IntegrationStatus.RUNNING,
        IntegrationStatus.RECOVERY_REQUIRED
      ].includes(integration.status)
    );
    if (activeIntegration) {
      return {
        ok: true,
        reconciled: false,
        reason: 'integration-operation-active',
        integration: activeIntegration
      };
    }
    const activeReversion = (state.projection.reversions ?? []).find(
      (reversion) => [
        ReversionStatus.PENDING,
        ReversionStatus.RUNNING,
        ReversionStatus.RECOVERY_REQUIRED
      ].includes(reversion.status)
    );
    if (activeReversion) {
      return {
        ok: true,
        reconciled: false,
        reason: 'reversion-operation-active',
        reversion: activeReversion
      };
    }
    const active = (state.projection.evaluations ?? []).find(isActiveEvaluation);
    const cleanupCandidate = (state.projection.evaluations ?? []).find((evaluation) => (
      [EvaluationStatus.PASSED, EvaluationStatus.REJECTED].includes(evaluation.status)
      && ['cleanup-pending', 'cleanup-failed'].includes(evaluation.workspaceStatus)
    ));
    let inspection = await settleLeaseOperation(lease, () => lease.inspect());
    let archived = null;
    if (inspection.held) {
      if (inspection.lease.ownerKind !== 'evaluation') {
        return {
          ok: true,
          reconciled: false,
          reason: 'another-operation-owns-lease',
          lease: inspection
        };
      }
      const expectedEvaluationId = active?.id ?? cleanupCandidate?.id ?? null;
      if (!inspection.stale) {
        return {
          ok: true,
          reconciled: false,
          reason: expectedEvaluationId === null
            || inspection.lease.ownerId === expectedEvaluationId
            ? 'evaluation-owner-not-dead'
            : 'another-operation-owns-lease',
          lease: inspection
        };
      }
      archived = await settleLeaseOperation(lease, () => lease.archiveStale({
        expectedLeaseId: inspection.lease.leaseId
      }));
      inspection = await settleLeaseOperation(lease, () => lease.inspect());
    }
    if (!active && !cleanupCandidate) {
      return {
        ok: true,
        reconciled: archived !== null,
        reason: archived === null
          ? 'nothing-to-reconcile'
          : 'orphan-evaluation-lease-archived',
        archived
      };
    }

    if (active?.status === EvaluationStatus.RUNNING) {
      await this.#recordRecoveryRequired({
        evaluationId: active.id,
        correlationId: requestedCorrelationId,
        phase: 'reconciliation',
        failure: {
          code: 'EVALUATION_PROCESS_STATE_UNKNOWN',
          message: 'The evaluator owner ended without durable proof that every child process stopped.',
          details: null
        }
      });
      return {
        ok: false,
        reconciled: true,
        reason: 'evaluation-recovery-required',
        archived,
        evaluation: (await this.#readState()).projection.evaluations.find(
          (candidate) => candidate.id === active.id
        )
      };
    }
    if (active?.status === EvaluationStatus.RECOVERY_REQUIRED) {
      return {
        ok: false,
        reconciled: archived !== null,
        reason: 'manual-recovery-required',
        evaluation: active,
        archived
      };
    }
    if (active?.status === EvaluationStatus.REQUESTED) {
      const ageMs = this.#now().getTime() - Date.parse(active.requestedAt);
      if (ageMs < graceMs) {
        return {
          ok: true,
          reconciled: archived !== null,
          reason: 'evaluation-request-grace-period',
          archived
        };
      }
    }

    const candidate = active ?? cleanupCandidate;
    let capability;
    let reconciliationCleanup = null;
    try {
      capability = await settleLeaseOperation(lease, () => lease.acquire({
        ownerKind: 'evaluation',
        ownerId: candidate.id
      }));
      state = await this.#readState();
      const fencedRun = state.projection.runs.find(isActiveRun);
      if (fencedRun) {
        return {
          ok: true,
          reconciled: false,
          reason: 'run-operation-claimed-before-evaluation-reconciliation',
          run: fencedRun
        };
      }
      const fenced = state.projection.evaluations.find(
        (evaluation) => evaluation.id === candidate.id
      );
      if (!fenced) {
        return { ok: true, reconciled: false, reason: 'evaluation-no-longer-exists' };
      }
      if (fenced.status === EvaluationStatus.REQUESTED) {
        const disposition = await this.#cleanupInterruptedSetup({
          workspace,
          evaluationId: fenced.id,
          workspaceResult: fenced.workspacePath ? { workspacePath: fenced.workspacePath } : null
        });
        await this.#recordInterrupted({
          evaluationId: fenced.id,
          correlationId: requestedCorrelationId,
          phase: 'reconciliation',
          failure: {
            code: 'EVALUATION_OWNER_LOST',
            message: `Evaluation ${fenced.id} was requested but its owner disappeared.`,
            details: null
          },
          workspaceDisposition: disposition,
          deferNode: false
        });
        return {
          ok: disposition === 'removed',
          reconciled: true,
          reason: 'requested-evaluation-interrupted',
          archived,
          evaluation: (await this.#readState()).projection.evaluations.find(
            (evaluation) => evaluation.id === fenced.id
          )
        };
      }
      if ([EvaluationStatus.PASSED, EvaluationStatus.REJECTED].includes(fenced.status)
        && ['cleanup-pending', 'cleanup-failed'].includes(fenced.workspaceStatus)) {
        const cleanup = { worktreeRemoved: false, leaseReleased: false, warnings: [] };
        reconciliationCleanup = cleanup;
        await this.#cleanupTerminalEvaluation({
          workspace,
          evaluationId: fenced.id,
          correlationId: requestedCorrelationId,
          cleanup
        });
        return {
          ok: cleanup.worktreeRemoved,
          reconciled: true,
          reason: 'evaluation-cleanup-retried',
          archived,
          cleanup
        };
      }
      return { ok: true, reconciled: false, reason: 'evaluation-state-changed' };
    } finally {
      if (capability) {
        await settleLeaseOperation(lease, () => lease.release({
          leaseId: capability.lease.leaseId,
          ownerToken: capability.ownerToken
        }));
        if (reconciliationCleanup) reconciliationCleanup.leaseReleased = true;
      }
    }
  }

  #selectChangeSet(projection, changeSetId) {
    const changeSet = projection.changeSets.find((candidate) => candidate.id === changeSetId);
    const node = projection.nodes.find((candidate) => candidate.id === changeSet?.nodeId);
    const run = projection.runs.find((candidate) => candidate.id === changeSet?.runId);
    if (!changeSet || !node || !run) {
      throw new EvaluationOrchestrationError(
        `ChangeSet ${changeSetId} does not exist with its Node and Run.`,
        'changeset-not-found'
      );
    }
    if (!changeSet.valid
      || run.status !== RunStatus.PRODUCED
      || node.status !== NodeStatus.PRODUCED
      || node.validity !== 'valid'
      || node.changeSetIds.at(-1) !== changeSet.id
      || run.changeSetId !== changeSet.id) {
      throw new EvaluationOrchestrationError(
        `ChangeSet ${changeSetId} is not the latest valid produced output of node ${node.id}.`,
        'changeset-not-evaluable',
        {
          nodeStatus: node.status,
          nodeValidity: node.validity,
          latestChangeSetId: node.changeSetIds.at(-1),
          runStatus: run.status,
          changeSetValid: changeSet.valid
        }
      );
    }
    return { changeSet, node, run };
  }

  async #cleanupInterruptedSetup({ workspace, evaluationId, workspaceResult }) {
    try {
      const removal = await workspace.removeEvaluation({
        evaluationId,
        workspacePath: workspaceResult?.workspacePath
          ?? path.join(this.projectRoot, '.fwa', 'evaluations', evaluationId),
        force: true
      });
      return removal?.removed === true || removal?.alreadyAbsent === true
        ? 'removed'
        : 'setup-unknown';
    } catch {
      return 'setup-unknown';
    }
  }

  async #cleanupTerminalEvaluation({ workspace, evaluationId, correlationId, cleanup }) {
    const state = await this.#readState();
    const evaluation = state.projection.evaluations.find(
      (candidate) => candidate.id === evaluationId
    );
    if (!evaluation
      || ![EvaluationStatus.PASSED, EvaluationStatus.REJECTED].includes(evaluation.status)) {
      throw new EvaluationOrchestrationError(
        `Evaluation ${evaluationId} is not terminal and awaiting cleanup.`,
        'evaluation-cleanup-mismatch'
      );
    }
    if (evaluation.workspaceStatus === 'removed') {
      cleanup.worktreeRemoved = true;
      return;
    }
    let removal;
    try {
      removal = await workspace.removeEvaluation({
        evaluationId,
        workspacePath: evaluation.workspacePath,
        force: true
      });
    } catch (error) {
      const failure = failureFrom(error, 'EVALUATION_WORKTREE_CLEANUP_FAILED');
      cleanup.warnings.push({ phase: 'worktree-cleanup', failure });
      await this.#recordCleanupFailure({ evaluation, correlationId, failure });
      return;
    }
    if (removal?.removed !== true && removal?.alreadyAbsent !== true) {
      const failure = {
        code: 'INVALID_EVALUATION_WORKTREE_REMOVAL_RESULT',
        message: 'The workspace adapter did not prove evaluation removal or prior absence.',
        details: optionalJson(removal)
      };
      cleanup.warnings.push({ phase: 'worktree-cleanup', failure });
      await this.#recordCleanupFailure({ evaluation, correlationId, failure });
      return;
    }
    await this.#appendDerived({
      commandId: this.#internalCommand(evaluationId, 'workspace-removed'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'RecordEvaluationWorkspaceRemoved',
        evaluationId,
        workspacePath: evaluation.workspacePath,
        removal: optionalJson(removal)
      },
      build: (latest) => {
        const current = latest.projection.evaluations.find(
          (candidate) => candidate.id === evaluationId
        );
        if (!current || current.workspaceStatus === 'removed') {
          throw new EvaluationOrchestrationError(
            `Evaluation ${evaluationId} no longer needs cleanup.`,
            'evaluation-cleanup-mismatch'
          );
        }
        return [{
          type: 'EvaluationWorkspaceRemoved',
          streamId: `evaluation:${evaluationId}`,
          payload: {
            evaluationId,
            workspacePath: current.workspacePath,
            reason: removal.alreadyAbsent ? 'already-absent' : 'removed'
          }
        }];
      }
    });
    cleanup.worktreeRemoved = true;
  }

  async #recordCleanupFailure({ evaluation, correlationId, failure }) {
    await this.#appendDerived({
      commandId: this.#internalCommand(
        evaluation.id,
        `workspace-cleanup-failed-${evaluation.cleanupFailures.length + 1}`
      ),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'RecordEvaluationWorkspaceCleanupFailure',
        evaluationId: evaluation.id,
        failure
      },
      build: (latest) => {
        const current = latest.projection.evaluations.find(
          (candidate) => candidate.id === evaluation.id
        );
        if (!current || current.workspaceStatus === 'removed') {
          throw new EvaluationOrchestrationError(
            `Evaluation ${evaluation.id} no longer needs cleanup.`,
            'evaluation-cleanup-mismatch'
          );
        }
        return [{
          type: 'EvaluationWorkspaceCleanupFailed',
          streamId: `evaluation:${evaluation.id}`,
          payload: {
            evaluationId: evaluation.id,
            workspacePath: current.workspacePath,
            failure
          }
        }];
      }
    });
  }

  async #recordInterrupted({
    evaluationId,
    correlationId,
    phase,
    failure,
    workspaceDisposition,
    deferNode
  }) {
    await this.#appendDerived({
      commandId: this.#internalCommand(evaluationId, `interrupted-${phase}`),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'InterruptEvaluation',
        evaluationId,
        phase,
        failure,
        workspaceDisposition,
        deferNode
      },
      build: (latest) => {
        const evaluation = latest.projection.evaluations.find(
          (candidate) => candidate.id === evaluationId
        );
        const node = latest.projection.nodes.find(
          (candidate) => candidate.id === evaluation?.nodeId
        );
        if (!evaluation || !node
          || ![EvaluationStatus.REQUESTED, EvaluationStatus.RUNNING].includes(evaluation.status)) {
          throw new EvaluationOrchestrationError(
            `Evaluation ${evaluationId} cannot be interrupted from its current state.`,
            'evaluation-not-active'
          );
        }
        const links = {
          evaluationId,
          nodeId: evaluation.nodeId,
          runId: evaluation.runId,
          changeSetId: evaluation.changeSetId
        };
        const events = [{
          type: 'EvaluationInterrupted',
          streamId: `evaluation:${evaluationId}`,
          payload: { ...links, phase, failure, workspaceDisposition }
        }];
        if (deferNode) {
          events.push({
            type: 'NodeEvaluationDeferred',
            streamId: `node:${node.id}`,
            payload: links
          });
        }
        return events;
      }
    });
  }

  async #recordRecoveryRequired({ evaluationId, correlationId, phase, failure }) {
    await this.#appendDerived({
      commandId: this.#internalCommand(evaluationId, 'recovery-required'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'RequireEvaluationRecovery',
        evaluationId,
        phase,
        failure
      },
      build: (latest) => {
        const evaluation = latest.projection.evaluations.find(
          (candidate) => candidate.id === evaluationId
        );
        if (!evaluation || evaluation.status !== EvaluationStatus.RUNNING) {
          throw new EvaluationOrchestrationError(
            `Evaluation ${evaluationId} is not running.`,
            'evaluation-not-running'
          );
        }
        return [{
          type: 'EvaluationRecoveryRequired',
          streamId: `evaluation:${evaluationId}`,
          payload: {
            evaluationId,
            nodeId: evaluation.nodeId,
            runId: evaluation.runId,
            changeSetId: evaluation.changeSetId,
            phase,
            failure,
            workspacePath: evaluation.workspacePath
          }
        }];
      }
    });
  }

  async #existingEvaluationResult(state, commandId, evaluationId, lease) {
    const evaluation = state.projection.evaluations.find(
      (candidate) => candidate.id === evaluationId
    );
    if (!evaluation) {
      throw new EvaluationOrchestrationError(
        `Recorded Evaluation ${evaluationId} is missing from the projection.`,
        'evaluation-not-found'
      );
    }
    if (isActiveEvaluation(evaluation)) {
      throw new EvaluationOrchestrationError(
        `Evaluation ${evaluationId} is still ${evaluation.status}; reconcile it before retrying.`,
        'evaluation-reconciliation-required',
        { evaluationId, status: evaluation.status }
      );
    }
    await settleLeaseOperation(lease, () => lease.init());
    const inspection = await settleLeaseOperation(lease, () => lease.inspect());
    const stillOwnsLease = inspection.held
      && inspection.lease.ownerKind === 'evaluation'
      && inspection.lease.ownerId === evaluationId;
    return this.#resultFromState(state, commandId, evaluationId, false, {
      worktreeRemoved: evaluation.workspaceStatus === 'removed',
      leaseReleased: !stillOwnsLease,
      warnings: []
    });
  }

  async #evaluationResult(commandId, evaluationId, appended, cleanup) {
    const state = await this.#readState();
    return this.#resultFromState(state, commandId, evaluationId, appended, cleanup);
  }

  #resultFromState(state, commandId, evaluationId, appended, cleanup) {
    const evaluation = state.projection.evaluations.find(
      (candidate) => candidate.id === evaluationId
    );
    const node = state.projection.nodes.find((candidate) => candidate.id === evaluation?.nodeId);
    const run = state.projection.runs.find((candidate) => candidate.id === evaluation?.runId);
    const changeSet = state.projection.changeSets.find(
      (candidate) => candidate.id === evaluation?.changeSetId
    );
    const evidence = state.projection.evidence.find(
      (candidate) => candidate.id === evaluation?.evidenceId
    ) ?? null;
    return {
      ok: evaluation?.status === EvaluationStatus.PASSED,
      appended,
      commandId,
      evaluation,
      node,
      run,
      changeSet,
      evidence,
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
          throw new EvaluationOrchestrationError(
            'A derived evaluation batch must contain at least one event.',
            'empty-evaluation-event-batch'
          );
        }
        const events = this.#materializeEvents(state, correlationId, specs);
        projectEvents([...state.store.events, ...events]);
        const write = await this.#appendBatch(commandId, events, {
          expectedLastSequence: state.store.lastSequence,
          intentHash
        });
        const latest = await this.#readState();
        return { appended: write.appended, batch: write.batch, state: latest };
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
      const projection = projectEvents(store.events);
      return { project, store, projection };
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

  #id(prefix) {
    return `${prefix}_${requireTrimmedString(this.idFactory(), `${prefix} id`)}`;
  }

  #internalCommand(evaluationId, phase) {
    return `${INTERNAL_COMMAND_PREFIX}evaluation/${
      requireTrimmedString(evaluationId, 'evaluationId')
    }/${requireTrimmedString(phase, 'phase')}`;
  }

  #now() {
    const value = this.clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new EvaluationOrchestrationError('clock returned an invalid date.', 'invalid-clock');
    }
    return date;
  }
}
