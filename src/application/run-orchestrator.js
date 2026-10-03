import path from 'node:path';

import {
  normalizeWorkspacePath,
  normalizeWritePatterns,
  validateActualWrites
} from '../core/effects.js';
import { createEvent, stableStringify } from '../core/events.js';
import { assertExecutor, executorProvidesCapabilities } from '../core/executor.js';
import { summarizeFailure } from '../core/failure-diagnostics.js';
import { changedRefsForFiles, resolveNodeEffects } from '../core/refs.js';
import {
  EvaluationStatus,
  GoalStatus,
  IntegrationStatus,
  NodeStatus,
  ReversionStatus,
  RunStatus
} from '../core/state-machines.js';
import { hashCanonicalValue } from '../storage/file-event-store.js';
import { findParallelConflicts, isNodeSchedulable, isUnfencedGitProcessFailure } from '../core/scheduling.js';
import { diagnoseNodeRetry } from '../core/retry-diagnostics.js';
import { loadProject } from './project.js';
import { projectEvents } from './projection.js';
import { retryUnstartedLeaseOperation, settleLeaseOperation } from './lease-operations.js';

const DEFAULT_LOCK_RETRY_DELAYS = Object.freeze([5, 10, 20, 40, 80, 160, 250]);
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_ORPHAN_GRACE_MS = 30_000;
const INTERNAL_COMMAND_PREFIX = '@fwa/';

export class RunOrchestrationError extends Error {
  constructor(message, code = 'run-orchestration-error', details = undefined) {
    super(message);
    this.name = 'RunOrchestrationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function requireTrimmedString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new RunOrchestrationError(
      `${name} must be a non-empty, trimmed string.`,
      'invalid-run-command'
    );
  }
  return value;
}

function requirePublicCommandId(value) {
  const commandId = requireTrimmedString(value, 'commandId');
  if (commandId.startsWith(INTERNAL_COMMAND_PREFIX)) {
    throw new RunOrchestrationError(
      `commandId prefix ${INTERNAL_COMMAND_PREFIX} is reserved for FWA transactions.`,
      'reserved-command-id'
    );
  }
  return commandId;
}

function requireSafeDuration(value, name, fallback) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 86_400_000) {
    throw new RunOrchestrationError(
      `${name} must be an integer from 1 through 86400000.`,
      'invalid-run-command'
    );
  }
  return selected;
}

function cloneJson(value, name) {
  try {
    return JSON.parse(stableStringify(value));
  } catch (error) {
    throw new RunOrchestrationError(
      `${name} must be JSON compatible: ${error.message}`,
      'invalid-run-command'
    );
  }
}

function optionalJson(value) {
  if (value === undefined) return null;
  try {
    return redactSecrets(JSON.parse(stableStringify(value)));
  } catch {
    return String(value);
  }
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /(?:owner.?token|secret|password|credential)/iu.test(key)
      ? '[REDACTED]'
      : redactSecrets(child)
  ]));
}

function failureFrom(error, fallbackCode = 'RUN_PHASE_FAILED') {
  const code = typeof error?.code === 'string'
    && error.code.length > 0
    && error.code === error.code.trim()
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : String(error);
  const details = error?.details !== undefined
    ? optionalJson(error.details)
    : error?.errors !== undefined
      ? { errors: optionalJson(error.errors) }
      : error?.evidence !== undefined
        ? { evidence: optionalJson(error.evidence) }
        : null;
  return { code, message, details };
}

function assertPort(port, name, methods) {
  if (port === null || typeof port !== 'object' || Array.isArray(port)) {
    throw new RunOrchestrationError(
      `${name} must be an adapter object.`,
      'invalid-run-port'
    );
  }
  const missing = methods.filter((method) => typeof port[method] !== 'function');
  if (missing.length > 0) {
    throw new RunOrchestrationError(
      `${name} is missing method(s): ${missing.join(', ')}.`,
      'invalid-run-port',
      { port: name, missing }
    );
  }
  return port;
}

function isActiveRun(run) {
  return run.status === RunStatus.PENDING
    || run.status === RunStatus.RUNNING
    || run.status === RunStatus.PAUSED;
}

function getActiveRun(projection) {
  const active = projection.runs.filter(isActiveRun);
  if (active.length > 1) {
    throw new RunOrchestrationError(
      'The event history contains more than one active Run.',
      'serial-run-invariant-broken',
      { runIds: active.map((run) => run.id) }
    );
  }
  return active[0] ?? null;
}

function isActiveEvaluation(evaluation) {
  return evaluation.status === EvaluationStatus.REQUESTED
    || evaluation.status === EvaluationStatus.RUNNING
    || evaluation.status === EvaluationStatus.RECOVERY_REQUIRED;
}

function getActiveEvaluations(projection) {
  return (projection.evaluations ?? []).filter(isActiveEvaluation);
}

function getActiveIntegrations(projection) {
  return (projection.integrations ?? []).filter((integration) => [
    IntegrationStatus.PENDING,
    IntegrationStatus.RUNNING,
    IntegrationStatus.RECOVERY_REQUIRED
  ].includes(integration.status));
}

function getActiveReversions(projection) {
  return (projection.reversions ?? []).filter((reversion) => [
    ReversionStatus.PENDING,
    ReversionStatus.RUNNING,
    ReversionStatus.RECOVERY_REQUIRED
  ].includes(reversion.status));
}

function refContracts(projection) {
  return (projection.refs ?? []).map((ref) => ({
    id: ref.id,
    kind: ref.kind,
    uri: ref.uri,
    version: ref.version,
    hash: ref.hash,
    metadata: ref.metadata
  }));
}

function assertNoActiveProjectOperation(projection) {
  const batch = (projection.runBatches ?? []).find((item) => item.status === 'running');
  if (batch) throw new RunOrchestrationError(`Run batch ${batch.id} is active.`,
    'run-batch-active', { batchId: batch.id });
  const unfenced = projection.runs.find((run) => isUnfencedGitProcessFailure(run.failure));
  if (unfenced) {
    throw new RunOrchestrationError('A Git process may still be alive without a durable safety fence; manual recovery is required.',
      'git-process-manual-recovery-required', { runId: unfenced.id, failure: unfenced.failure });
  }
  const active = getActiveRun(projection);
  if (active) {
    throw new RunOrchestrationError(
      `Run ${active.id} is still ${active.status}; reconcile it before scheduling another node.`,
      'active-run-exists',
      { runId: active.id, status: active.status }
    );
  }
  const evaluations = getActiveEvaluations(projection);
  if (evaluations.length > 0) {
    throw new RunOrchestrationError(
      'An Evaluation is still active; reconcile it before scheduling another node.',
      'project-operation-active',
      {
        runIds: [],
        evaluationIds: evaluations.map((evaluation) => evaluation.id)
      }
    );
  }
  const integrations = getActiveIntegrations(projection);
  if (integrations.length > 0) {
    throw new RunOrchestrationError(
      'An Integration is still active; reconcile it before scheduling another node.',
      'project-operation-active',
      {
        runIds: [],
        evaluationIds: [],
        integrationIds: integrations.map((integration) => integration.id)
      }
    );
  }
  const reversions = getActiveReversions(projection);
  if (reversions.length > 0) {
    throw new RunOrchestrationError(
      'A Reversion is still active; reconcile it before scheduling another node.',
      'project-operation-active',
      {
        runIds: [],
        evaluationIds: [],
        integrationIds: [],
        reversionIds: reversions.map((reversion) => reversion.id)
      }
    );
  }
}

function terminationUnconfirmed(failure) {
  return failure?.code?.includes('termination-unconfirmed') === true
    || failure?.details?.terminationConfirmed === false
    || failure?.details?.process?.terminationConfirmed === false;
}

function serializedPort(port, methods, before, failed) {
  let tail = Promise.resolve();
  return Object.fromEntries(methods.map((method) => [method, (...args) => {
    const operation = tail.then(async () => {
      before?.();
      try { return await port[method](...args); }
      catch (error) { failed?.(error); throw error; }
    });
    tail = operation.catch(() => {});
    return operation;
  }]));
}

function leaseIsOwnedByRun(leaseState, runId) {
  if (leaseState?.held !== true || leaseState.lease === null
    || typeof leaseState.lease !== 'object') {
    return false;
  }
  const ownerKind = leaseState.lease.ownerKind
    ?? (typeof leaseState.lease.runId === 'string' ? 'run' : null);
  const ownerId = leaseState.lease.ownerId ?? leaseState.lease.runId;
  return ownerKind === 'run' && ownerId === runId;
}

function historicalRunSnapshot(projection, run) {
  const changeSet = projection.changeSets.find((candidate) => candidate.id === run.changeSetId) ?? null;
  const evaluations = (projection.evaluations ?? []).filter((candidate) => candidate.runId === run.id);
  const evidenceIds = new Set(evaluations.map((candidate) => candidate.evidenceId).filter(Boolean));
  const evidence = (projection.evidence ?? []).filter((candidate) => evidenceIds.has(candidate.id));
  return optionalJson({
    schemaVersion: 1,
    run: {
      id: run.id,
      nodeId: run.nodeId,
      goalId: run.goalId,
      status: run.status,
      requestedBaseRevision: run.requestedBaseRevision,
      baseRevision: run.baseRevision,
      inputHash: run.inputHash,
      effects: run.effects,
      workspacePath: run.workspacePath,
      changeSetId: run.changeSetId,
      failure: run.failure,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      failedAt: run.failedAt,
      ...(run.workspaceSetupRecovery ? { workspaceSetupRecovery: run.workspaceSetupRecovery } : {})
    },
    changeSet,
    evaluations,
    evidence
  });
}

function assertRecoverableRunSetup(run) {
  if (!run || run.status !== RunStatus.FAILED || run.workspaceStatus !== 'setup-unknown'
    || run.startedAt !== null || run.workspacePath !== null || run.changeSetId !== null
    || run.failure?.code !== 'RUN_OWNER_LOST' || run.failure?.phase !== 'reconciliation'
    || run.failure?.details?.previousStatus !== RunStatus.PENDING
    || !/^[a-f0-9]{40,64}$/.test(run.baseRevision ?? '')
    || run.workspaceRelativePath !== `.fwa/worktrees/${run.id}`) {
    throw new RunOrchestrationError('Only reconciled owner-lost, never-started Run setup may be recovered.',
      'run-setup-not-recoverable');
  }
}

function archivedWorkspacePath(run) {
  return run.workspacePath ?? run.workspaceSetupRecovery?.workspacePath;
}

function stableArchiveSourceIdentity(ownership) {
  return {
    path: ownership.identity.path,
    device: ownership.identity.device,
    inode: ownership.identity.inode,
    branch: ownership.branch,
    headRevision: ownership.headRevision,
    registration: {
      workspacePath: ownership.registration.workspacePath,
      headRevision: ownership.registration.headRevision
    }
  };
}

function assertAttemptBudget(node, projection) {
  if (node.runIds.length > node.budget.maxRetries) {
    throw new RunOrchestrationError(
      `Node ${node.id} exhausted its retry budget.`,
      'node-retry-budget-exhausted',
      {
        nodeId: node.id,
        previousAttempts: node.runIds.length,
        maxRetries: node.budget.maxRetries
      }
    );
  }
}

function assertRetryProgress(node, projection, input, baseRevision, executor) {
  const diagnostic = diagnoseNodeRetry(node, projection, {
    inputHash: 'sha256:' + hashCanonicalValue(input), baseRevision, executor
  });
  if (diagnostic.blocked) throw new RunOrchestrationError(diagnostic.message, diagnostic.code, diagnostic);
}

function selectReadyNode(projection, requestedNodeId, admission = undefined) {
  const hasPendingFeedback = (goalId) => (projection.nodeFeedback ?? [])
    .some((feedback) => feedback.goalId === goalId && feedback.status === 'pending');
  const assertAdmission = candidate => {
    assertAttemptBudget(candidate, projection);
    if (admission) {
      assertRetryProgress(candidate, projection, admission.input, admission.baseRevision, admission.executor);
    } else {
      const diagnostic = diagnoseNodeRetry(candidate, projection);
      if (diagnostic.code === 'logical-node-retry-budget-exhausted') {
        throw new RunOrchestrationError(diagnostic.message, diagnostic.code, diagnostic);
      }
    }
  };
  let node;
  if (requestedNodeId !== undefined) {
    node = projection.nodes.find((candidate) => candidate.id === requestedNodeId);
    if (!node) {
      throw new RunOrchestrationError(
        `Node ${requestedNodeId} does not exist.`,
        'node-not-found'
      );
    }
    if (hasPendingFeedback(node.goalId)) {
      throw new RunOrchestrationError('Resolve pending node feedback before dispatching another leaf.',
        'pending-node-feedback', { goalId: node.goalId, nodeId: node.id });
    }
    if (!isNodeSchedulable(node, projection.nodes,
      projection.goals.find((goal) => goal.id === node.goalId))) {
      throw new RunOrchestrationError(
        `Node ${requestedNodeId} is not schedulable (${node.status}; ${node.validity}).`,
        'node-not-ready',
        { nodeId: node.id, status: node.status, validity: node.validity }
      );
    }
  } else {
    const candidates = projection.nodes
      .filter((candidate) => (
        !hasPendingFeedback(candidate.goalId) && isNodeSchedulable(candidate, projection.nodes,
          projection.goals.find((goal) => goal.id === candidate.goalId))
      ))
      .sort((left, right) => (
        (left.readySequence ?? Number.MAX_SAFE_INTEGER)
          - (right.readySequence ?? Number.MAX_SAFE_INTEGER)
        || left.id.localeCompare(right.id)
      ));
    const deferred = [];
    let deferredCount = 0;
    const admissionCodes = new Set(['node-retry-budget-exhausted', 'logical-node-retry-budget-exhausted',
      'retry-input-repair-required', 'retry-no-progress']);
    for (const candidate of candidates) {
      try {
        assertAdmission(candidate);
        return candidate;
      } catch (error) {
        if (!admissionCodes.has(error.code)) throw error;
        deferredCount += 1;
        if (deferred.length < 32) deferred.push({ nodeId: candidate.id, code: error.code,
          message: error.message.slice(0, 512) });
      }
    }
    if (!node) {
      throw new RunOrchestrationError(
        'No valid ready node is available.',
        'no-ready-node',
        { deferred, deferredCount, deferredTruncated: deferredCount > deferred.length }
      );
    }
  }
  assertAdmission(node);
  return node;
}

function countPatchLines(patch) {
  if (typeof patch !== 'string') {
    throw new RunOrchestrationError(
      'The workspace adapter returned a non-string patch.',
      'invalid-workspace-result'
    );
  }
  return patch.split(/\r?\n/u).filter((line) => (
    (line.startsWith('+') && !line.startsWith('+++'))
    || (line.startsWith('-') && !line.startsWith('---'))
  )).length;
}

function sameAbsolutePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === 'win32'
    ? leftPath.toLocaleLowerCase('en-US') === rightPath.toLocaleLowerCase('en-US')
    : leftPath === rightPath;
}

function validateCapture(capture, runId, baseRevision, { workspacePath, ignoreCase }) {
  const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
  const expectedBranch = `fwa/runs/${runId}`;
  const expectedRef = `refs/heads/${expectedBranch}`;
  if (capture === null || typeof capture !== 'object' || Array.isArray(capture)
    || capture.runId !== runId
    || capture.baseRevision !== baseRevision
    || !objectId.test(capture.baseRevision)
    || !objectId.test(capture.headRevision)
    || capture.ref !== expectedRef
    || capture.branch !== expectedBranch
    || !sameAbsolutePath(capture.workspacePath, workspacePath)
    || !Array.isArray(capture.commits)
    || !Array.isArray(capture.changedFiles)
    || capture.commits.some((item) => !objectId.test(item))
    || new Set(capture.commits).size !== capture.commits.length
    || (capture.commits.length > 0 && capture.commits.at(-1) !== capture.headRevision)
    || (capture.commits.length === 0 && capture.headRevision !== capture.baseRevision)
    || typeof capture.patch !== 'string') {
    throw new RunOrchestrationError(
      'The workspace adapter returned an invalid ChangeSet capture.',
      'invalid-workspace-result'
    );
  }
  const changes = [];
  const changedPaths = new Map();
  const addPath = (value, field) => {
    const normalized = normalizeWorkspacePath(value, { path: field });
    const key = ignoreCase ? normalized.toLocaleLowerCase('en-US') : normalized;
    if (changedPaths.has(key) && changedPaths.get(key) !== normalized) {
      throw new RunOrchestrationError(
        `The workspace adapter returned case-colliding paths ${changedPaths.get(key)} and ${normalized}.`,
        'invalid-workspace-result'
      );
    }
    changedPaths.set(key, normalized);
    return normalized;
  };
  for (const [index, item] of capture.changedFiles.entries()) {
    if (typeof item === 'string') {
      const normalized = addPath(item, `capture.changedFiles[${index}]`);
      changes.push({ status: 'changed', code: null, path: normalized });
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)
      || typeof item.path !== 'string'
      || typeof item.status !== 'string'
      || item.capturable === false) {
      throw new RunOrchestrationError(
        `The workspace adapter returned an invalid changedFiles[${index}] entry.`,
        'invalid-workspace-result'
      );
    }
    const change = cloneJson(item, `capture.changedFiles[${index}]`);
    change.path = addPath(change.path, `capture.changedFiles[${index}].path`);
    if (change.previousPath !== undefined) {
      change.previousPath = addPath(
        change.previousPath,
        `capture.changedFiles[${index}].previousPath`
      );
    }
    changes.push(change);
  }
  return {
    ...capture,
    changes,
    changedFiles: [...changedPaths.values()].sort((left, right) => left.localeCompare(right))
  };
}

function validateExecutorResult(result) {
  const snapshot = cloneJson(result, 'executor result');
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.ok !== true) {
    throw new RunOrchestrationError(
      'The executor must return a JSON object with ok: true.',
      'invalid-executor-result'
    );
  }
  return snapshot;
}

function budgetEvidence(node, stats, executorResult) {
  const violations = [];
  if (stats.fileCount > node.budget.maxFiles) {
    violations.push({
      code: 'MAX_FILES_EXCEEDED',
      path: 'budget.maxFiles',
      message: `Changed ${stats.fileCount} files; the limit is ${node.budget.maxFiles}.`,
      details: { actual: stats.fileCount, limit: node.budget.maxFiles }
    });
  }
  if (stats.diffLines > node.budget.maxDiffLines) {
    violations.push({
      code: 'MAX_DIFF_LINES_EXCEEDED',
      path: 'budget.maxDiffLines',
      message: `Changed ${stats.diffLines} diff lines; the limit is ${node.budget.maxDiffLines}.`,
      details: { actual: stats.diffLines, limit: node.budget.maxDiffLines }
    });
  }
  if (node.budget.wallTimeMinutes !== undefined
    && stats.durationMs > node.budget.wallTimeMinutes * 60_000) {
    violations.push({
      code: 'WALL_TIME_EXCEEDED',
      path: 'budget.wallTimeMinutes',
      message: `Execution exceeded the ${node.budget.wallTimeMinutes} minute limit.`,
      details: {
        actualMs: stats.durationMs,
        limitMs: node.budget.wallTimeMinutes * 60_000
      }
    });
  }
  if (node.budget.tokenBudget !== undefined) {
    const tokens = executorResult?.usage?.tokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      violations.push({
        code: 'TOKEN_USAGE_UNREPORTED',
        path: 'executorResult.usage.tokens',
        message: 'The executor did not report token usage required by the node budget.'
      });
    } else if (tokens > node.budget.tokenBudget) {
      violations.push({
        code: 'TOKEN_BUDGET_EXCEEDED',
        path: 'budget.tokenBudget',
        message: `The executor used ${tokens} tokens; the limit is ${node.budget.tokenBudget}.`,
        details: { actual: tokens, limit: node.budget.tokenBudget }
      });
    }
  }
  return violations;
}

function executionFailureEvidence(failure) {
  return {
    code: 'EXECUTION_FAILED',
    path: 'executor',
    message: failure.message,
    details: { failure: summarizeFailure(failure) }
  };
}

function recordedBatch(storeState, commandId, intentHash) {
  const batch = storeState.batches.find((candidate) => candidate.commandId === commandId);
  if (!batch) return null;
  if (batch.intentHash !== intentHash) {
    throw new RunOrchestrationError(
      `Command ${commandId} was already recorded with a different intent.`,
      'idempotency-conflict',
      {
        commandId,
        recordedIntentHash: batch.intentHash,
        requestedIntentHash: intentHash
      }
    );
  }
  return batch;
}

function eventFromBatch(batch, type) {
  const event = batch.events.find((candidate) => candidate.type === type);
  if (!event) {
    throw new RunOrchestrationError(
      `Recorded command ${batch.commandId} has no ${type} event.`,
      'recorded-command-type-mismatch'
    );
  }
  return event;
}

function retryAllowed(node, failure) {
  return !isUnfencedGitProcessFailure(failure) && node.runIds.length <= node.budget.maxRetries;
}


function startHeartbeat(leasePort, acquired, ttlMs, externalSignal, deadlineMs) {
  const controller = new AbortController();
  let heartbeatFailure = null;
  let inFlight = null;
  let stopped = false;
  const externalAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) externalAbort();
  else externalSignal?.addEventListener('abort', externalAbort, { once: true });

  const beat = () => {
    if (stopped || inFlight) return;
    inFlight = retryUnstartedLeaseOperation(leasePort, () => leasePort.heartbeat({
      leaseId: acquired.lease.leaseId,
      ownerToken: acquired.ownerToken,
      ttlMs
    })).catch((error) => {
      heartbeatFailure = error;
      controller.abort(error);
    }).finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(beat, Math.max(100, Math.floor(ttlMs / 3)));
  timer.unref?.();
  const deadlineTimer = deadlineMs === undefined
    ? null
    : setTimeout(() => controller.abort(new RunOrchestrationError(
      `Execution exceeded its ${deadlineMs} ms wall-time budget.`,
      'execution-deadline-exceeded',
      { deadlineMs }
    )), deadlineMs);
  deadlineTimer?.unref?.();

  return {
    signal: controller.signal,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      externalSignal?.removeEventListener('abort', externalAbort);
      await inFlight;
      if (heartbeatFailure) throw heartbeatFailure;
    }
  };
}

function assertArchiveHeartbeatHealthy(heartbeat) {
  if (heartbeat?.signal?.aborted) {
    throw heartbeat.signal.reason ?? new RunOrchestrationError(
      'Workspace lease heartbeat failed during archive.',
      'workspace-lease-heartbeat-failed'
    );
  }
}

export class RunOrchestrator {
  constructor(projectRoot, {
    store,
    clock = () => new Date(),
    idFactory,
    actor = 'cli',
    lockRetryDelays = DEFAULT_LOCK_RETRY_DELAYS,
    workspaceArchives = null
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
    this.workspaceArchives = workspaceArchives;
  }

  async runNext(options = {}) {
    return this.#runNext(options);
  }

  async runReadyBatch({ executions, executor, workspace, lease, artifacts,
    baseRevision = 'HEAD', commandId, maxConcurrency = 4, signal, leaseTtlMs } = {}) {
    assertPort(workspace, 'workspace', ['inspect', 'create', 'capture', 'remove']);
    assertPort(lease, 'lease', ['init', 'inspect', 'acquire', 'heartbeat', 'release', 'archiveStale']);
    assertPort(artifacts, 'artifacts', ['init', 'put', 'verify']);
    if (!Array.isArray(executions) || executions.length < 1 || executions.length > 128
      || !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
      throw new RunOrchestrationError('executions must contain 1..128 unique nodes; maxConcurrency must be 1..8.', 'invalid-run-command');
    }
    const entries = executions.map((entry) => {
      const selectedExecutor = entry.executor ?? executor;
      assertExecutor(selectedExecutor);
      return { nodeId: requireTrimmedString(entry.nodeId, 'nodeId'),
        input: cloneJson(entry.input, 'input'), executor: selectedExecutor };
    });
    if (new Set(entries.map((entry) => entry.nodeId)).size !== entries.length) {
      throw new RunOrchestrationError('Batch node IDs must be unique.', 'invalid-run-command');
    }
    const requestedBaseRevision = requireTrimmedString(baseRevision, 'baseRevision');
    const normalizedCommandId = commandId === undefined ? this.#id('command') : requirePublicCommandId(commandId);
    const ttlMs = requireSafeDuration(leaseTtlMs, 'leaseTtlMs', DEFAULT_LEASE_TTL_MS);
    const intent = { schemaVersion: 1, type: 'RunReadyBatch', baseRevision: requestedBaseRevision,
      maxConcurrency, executions: entries.map((entry) => ({ nodeId: entry.nodeId,
        input: entry.input, executor: { id: entry.executor.id, version: entry.executor.version } })) };
    let state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, hashCanonicalValue(intent));
    if (existing) {
      const recordedId = eventFromBatch(existing, 'RunBatchStarted').payload.batchId;
      const currentLease = await settleLeaseOperation(lease, () => lease.init());
      return this.#batchResult(state, normalizedCommandId, recordedId, false, {
        leaseReleased: !(currentLease.held && currentLease.lease.ownerKind === 'run-batch'
          && currentLease.lease.ownerId === recordedId), warnings: []
      });
    }
    for (const entry of entries) entry.executor.validateInput?.(entry.input);
    assertNoActiveProjectOperation(state.projection);
    const leaseState = await settleLeaseOperation(lease, () => lease.init());
    if (leaseState.held) throw new RunOrchestrationError('The workspace is already leased.', 'workspace-lease-held', leaseState);
    const batchId = this.#id('batch');
    const acquired = await settleLeaseOperation(lease, () => lease.acquire({ ownerKind: 'run-batch', ownerId: batchId, ttlMs }));
    const controller = new AbortController();
    let unsafe = null;
    const markUnsafe = (failure) => { unsafe ??= failure; controller.abort(new RunOrchestrationError(
      'A batch process could not be confirmed stopped; preserve the operation for explicit recovery.',
      'run-batch-recovery-required', { failure })); };
    const externalAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) externalAbort();
    else signal?.addEventListener('abort', externalAbort, { once: true });
    const heartbeat = startHeartbeat(lease, acquired, ttlMs, controller.signal);
    let persisted = false;
    let finished = false;
    const cleanup = { leaseReleased: false, warnings: [] };
    try {
      await artifacts.init();
      const inspection = await workspace.inspect({ baseRevision: requestedBaseRevision });
      if (inspection?.clean !== true || typeof inspection.baseRevision !== 'string'
        || typeof inspection.coreIgnoreCase !== 'boolean') {
        throw new RunOrchestrationError('Invalid batch workspace inspection.', 'invalid-workspace-result');
      }
      const runIds = new Map(entries.map((entry) => [entry.nodeId, this.#id('run')]));
      const initial = await this.#appendDerived({ commandId: normalizedCommandId,
        correlationId: normalizedCommandId, intent, build: (latest) => {
          assertNoActiveProjectOperation(latest.projection);
          const sorted = [...entries].sort((a, b) => {
            const x = latest.projection.nodes.find((node) => node.id === a.nodeId);
            const y = latest.projection.nodes.find((node) => node.id === b.nodeId);
            return (x?.readySequence ?? Infinity) - (y?.readySequence ?? Infinity)
              || a.nodeId.localeCompare(b.nodeId);
          });
          const selected = [];
          const deferred = [];
          for (const entry of sorted) {
            let node;
            try {
              node = selectReadyNode(latest.projection, entry.nodeId);
              assertRetryProgress(node, latest.projection, entry.input, inspection.baseRevision, entry.executor);
            }
            catch (error) { deferred.push({ nodeId: entry.nodeId, code: error.code }); continue; }
            if (!executorProvidesCapabilities(entry.executor, node.capabilities)) {
              deferred.push({ nodeId: node.id, code: 'executor-capability-mismatch' }); continue;
            }
            const effects = resolveNodeEffects(node, refContracts(latest.projection));
            normalizeWritePatterns(effects.writes, { ignoreCase: inspection.coreIgnoreCase });
            const candidate = { nodeId: node.id, reads: effects.reads, writes: effects.writes,
              resources: node.resources ?? [] };
            const conflicts = findParallelConflicts([...selected.map((item) => item.candidate), candidate],
              { ignoreCase: inspection.coreIgnoreCase });
            if (conflicts.length) {
              deferred.push({ nodeId: node.id, code: 'parallel-effect-conflict', conflicts }); continue;
            }
            if (selected.length >= maxConcurrency) {
              deferred.push({ nodeId: node.id, code: 'batch-capacity' }); continue;
            }
            selected.push({ entry, node, effects, candidate });
          }
          if (!selected.length) throw new RunOrchestrationError('No requested node is currently runnable.',
            'no-ready-nodes', { deferred });
          const members = selected.map(({ entry, node }) => ({ runId: runIds.get(node.id), nodeId: node.id,
            executor: { id: entry.executor.id, version: entry.executor.version },
            inputHash: `sha256:${hashCanonicalValue(entry.input)}`, resources: [...(node.resources ?? [])] }));
          return [{ type: 'RunBatchStarted', streamId: `run-batch:${batchId}`, payload: {
            batchId, leaseId: acquired.lease.leaseId, baseRevision: inspection.baseRevision,
            coreIgnoreCase: inspection.coreIgnoreCase, members, deferred
          } }, ...selected.map(({ entry, node, effects }, index) => ({
            type: 'RunCreated', streamId: `run:${members[index].runId}`, payload: {
              runId: members[index].runId, batchId, nodeId: node.id, goalId: node.goalId, planId: node.planId,
              executor: members[index].executor, requestedBaseRevision, baseRevision: inspection.baseRevision,
              inputHash: members[index].inputHash, workspaceRelativePath: `.fwa/worktrees/${members[index].runId}`,
              effects: { logicalReads: [...node.reads], logicalWrites: [...node.writes],
                resolvedReads: [...effects.reads], resolvedWrites: [...effects.writes],
                consumedRefs: effects.consumedRefs.map((ref) => ({ ...ref })),
                producedRefs: effects.producedRefs.map((ref) => ({ ...ref })) }
            }
          }))];
        } });
      if (!initial.appended) return this.#batchResult(initial.state, normalizedCommandId,
        eventFromBatch(initial.batch, 'RunBatchStarted').payload.batchId, false);
      persisted = true;
      const members = eventFromBatch(initial.batch, 'RunBatchStarted').payload.members;
      const gitPort = serializedPort(workspace, ['inspect', 'create', 'capture', 'remove'], () => {
        if (unsafe) throw new RunOrchestrationError('Batch workspace is fenced until explicit recovery.',
          'run-batch-recovery-required', { failure: unsafe });
      }, (error) => { if (terminationUnconfirmed(failureFrom(error))) markUnsafe(failureFrom(error)); });
      const artifactPort = serializedPort(artifacts, ['init', 'put', 'verify']);
      // The coordinator alone heartbeats the real shared capability. Member
      // heartbeat controllers still enforce their independent deadlines/signals.
      const memberLease = Object.fromEntries(['init', 'inspect', 'acquire', 'release', 'archiveStale']
        .map((method) => [method, (...args) => lease[method](...args)]));
      memberLease.heartbeat = async () => {};
      const outcomes = await Promise.allSettled(members.map((member) => {
        const entry = entries.find((item) => item.nodeId === member.nodeId);
        return this.#runNext({ executor: entry.executor, workspace: gitPort, lease: memberLease,
          artifacts: artifactPort, input: entry.input, baseRevision: requestedBaseRevision,
          nodeId: member.nodeId, commandId: `${normalizedCommandId}/${member.runId}`,
          signal: heartbeat.signal, leaseTtlMs: ttlMs },
        { batchId, runId: member.runId, acquired, inspection, markUnsafe });
      }));
      for (let i = 0; i < outcomes.length; i += 1) {
        if (outcomes[i].status === 'rejected') cleanup.warnings.push({ runId: members[i].runId,
          phase: 'member', failure: failureFrom(outcomes[i].reason) });
      }
      state = await this.#readState();
      if (!unsafe && members.every((member) => {
        const run = state.projection.runs.find((item) => item.id === member.runId);
        return run && !isActiveRun(run);
      })) {
        await this.#finishBatch(batchId, normalizedCommandId, 'completed', null);
        finished = true;
      }
      return this.#batchResult(await this.#readState(), normalizedCommandId, batchId, true, cleanup);
    } finally {
      signal?.removeEventListener('abort', externalAbort);
      try { await heartbeat.stop(); }
      catch (error) { cleanup.warnings.push({ phase: 'heartbeat-stop', failure: failureFrom(error) }); }
      // A persisted unfinished batch is a durable operational fence, even when
      // every Run is terminal. Never release its lease as ordinary cleanup.
      if (!persisted || finished) {
        try { await settleLeaseOperation(lease, () => lease.release({
          leaseId: acquired.lease.leaseId, ownerToken: acquired.ownerToken
        })); cleanup.leaseReleased = true; }
        catch (error) { cleanup.warnings.push({ phase: 'lease-release', failure: failureFrom(error) }); }
      }
    }
  }

  async inspectRunSetupWorkspace({ runId, workspace } = {}) {
    assertPort(workspace, 'workspace', ['inspectRunSetupWorkspace']);
    const normalizedRunId = requireTrimmedString(runId, 'runId');
    const state = await this.#readState();
    const run = state.projection.runs.find((candidate) => candidate.id === normalizedRunId);
    assertRecoverableRunSetup(run);
    return workspace.inspectRunSetupWorkspace({ runId: run.id,
      baseRevision: run.baseRevision, workspaceRelativePath: run.workspaceRelativePath });
  }

  async recoverRunSetupWorkspace({ runId, commandId, lease, workspace,
    confirmProcessesStopped = false, leaseTtlMs } = {}) {
    assertPort(lease, 'lease', ['init', 'inspect', 'acquire', 'release']);
    assertPort(workspace, 'workspace', ['inspectRunSetupWorkspace']);
    const normalizedRunId = requireTrimmedString(runId, 'runId');
    const normalizedCommandId = commandId === undefined ? this.#id('command') : requirePublicCommandId(commandId);
    if (confirmProcessesStopped !== true) throw new RunOrchestrationError(
      'Confirm the lost setup owner and its descendant processes have stopped before recovery.',
      'process-stop-confirmation-required');
    const intent = { schemaVersion: 1, type: 'RecoverRunSetupWorkspace', runId: normalizedRunId, confirmProcessesStopped: true };
    let state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, hashCanonicalValue(intent));
    const result = (latest, appended) => ({ ok: true, appended, commandId: normalizedCommandId,
      run: latest.projection.runs.find((run) => run.id === normalizedRunId) });
    if (existing) return result(state, false);
    assertNoActiveProjectOperation(state.projection);
    assertRecoverableRunSetup(state.projection.runs.find((run) => run.id === normalizedRunId));
    const leaseState = await settleLeaseOperation(lease, () => lease.init());
    if (leaseState.held) throw new RunOrchestrationError('A workspace lease is already held.', 'workspace-lease-held');
    const ttlMs = requireSafeDuration(leaseTtlMs, 'leaseTtlMs', DEFAULT_LEASE_TTL_MS);
    const acquired = await settleLeaseOperation(lease, () => lease.acquire({ runId: normalizedRunId, ttlMs }));
    const heartbeat = startHeartbeat(lease, acquired, ttlMs);
    try {
      const observation = await this.inspectRunSetupWorkspace({ runId: normalizedRunId, workspace });
      // No source is removed here. Recheck under the same operation lease before
      // recording either positive ownership or complete physical/Git absence.
      const rechecked = await this.inspectRunSetupWorkspace({ runId: normalizedRunId, workspace });
      if (stableStringify(observation) !== stableStringify(rechecked)) throw new RunOrchestrationError(
        'Run setup identity changed during recovery.', 'workspace-setup-identity-changed');
      assertArchiveHeartbeatHealthy(heartbeat);
      await this.#appendDerived({ commandId: normalizedCommandId, correlationId: normalizedCommandId, intent,
        build: (latest) => {
          assertNoActiveProjectOperation(latest.projection);
          const run = latest.projection.runs.find((candidate) => candidate.id === normalizedRunId);
          assertRecoverableRunSetup(run);
          return [{ type: 'RunWorkspaceSetupRecovered', streamId: `run:${normalizedRunId}`,
            payload: { runId: normalizedRunId, confirmProcessesStopped: true, observation: optionalJson(observation) } }];
        } });
      return result(await this.#readState(), true);
    } finally {
      try { await heartbeat.stop(); }
      finally { await settleLeaseOperation(lease, () => lease.release({ leaseId: acquired.lease.leaseId, ownerToken: acquired.ownerToken })); }
    }
  }

  async archiveRunWorkspace({ runId, commandId, lease, workspace, workspaceArchives, leaseTtlMs } = {}) {
    assertPort(lease, 'lease', ['init', 'inspect', 'acquire', 'release', 'archiveStale']);
    assertPort(workspace, 'workspace', ['inspectRunWorkspace', 'remove']);
    const archiveStore = workspaceArchives ?? this.workspaceArchives;
    assertPort(archiveStore, 'workspaceArchives', ['create', 'verifyRun']);
    const normalizedRunId = requireTrimmedString(runId, 'runId');
    const normalizedCommandId = commandId === undefined
      ? this.#id('command')
      : requirePublicCommandId(commandId);
    const ttlMs = requireSafeDuration(leaseTtlMs, 'leaseTtlMs', DEFAULT_LEASE_TTL_MS);
    const intent = { schemaVersion: 1, type: 'ArchiveRunWorkspace', runId: normalizedRunId };
    let state = await this.#readState();
    const intentHash = hashCanonicalValue(intent);
    const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
    if (existing) return this.#archiveResult(state, normalizedCommandId, normalizedRunId, false);
    assertNoActiveProjectOperation(state.projection);
    const run = state.projection.runs.find((candidate) => candidate.id === normalizedRunId);
    if (!run) throw new RunOrchestrationError(`Run ${normalizedRunId} does not exist.`, 'run-not-found');
    if (run.status !== RunStatus.FAILED || run.workspaceStatus !== 'preserved') {
      throw new RunOrchestrationError(
        `Run ${normalizedRunId} must be a failed Run with a preserved workspace.`,
        'run-workspace-not-archivable',
        { runId: normalizedRunId, status: run.status, workspaceStatus: run.workspaceStatus }
      );
    }
    const leaseState = await settleLeaseOperation(lease, () => lease.init());
    if (leaseState.held) {
      throw new RunOrchestrationError('A workspace lease is already held.', 'workspace-lease-held', { lease: leaseState });
    }
    const acquired = await settleLeaseOperation(lease, () => lease.acquire({ runId: normalizedRunId, ttlMs }));
    let leaseReleased = false;
    let heartbeat = null;
    let heartbeatFailure = null;
    try {
      heartbeat = startHeartbeat(lease, acquired, ttlMs);
      state = await this.#readState();
      const current = state.projection.runs.find((candidate) => candidate.id === normalizedRunId);
      if (!current || current.status !== RunStatus.FAILED || current.workspaceStatus !== 'preserved') {
        throw new RunOrchestrationError('Run changed before workspace archival.', 'run-workspace-not-archivable');
      }
      const history = historicalRunSnapshot(state.projection, current);
      const workspacePath = archivedWorkspacePath(current);
      let existingArchive = null;
      try {
        existingArchive = await archiveStore.verifyRun({ runId: normalizedRunId });
        if (stableStringify(existingArchive.manifest.history) !== stableStringify(history)) {
          throw new RunOrchestrationError('Existing workspace archive history differs from the Run.', 'workspace-archive-history-mismatch');
        }
      } catch (error) {
        if (error?.code !== 'workspace-archive-manifest-missing') throw error;
      }
      let ownership;
      try {
        ownership = await workspace.inspectRunWorkspace({
          runId: normalizedRunId,
          workspacePath
        });
      } catch (error) {
        const sourceMissing = error?.code === 'invalid-workspace-path'
          && error?.cause?.code === 'ENOENT';
        if (!existingArchive || !sourceMissing) throw error;
        ownership = { identity: existingArchive.manifest.source.identity };
      }
      const archiveIdentity = ownership.registration
        ? stableArchiveSourceIdentity(ownership)
        : ownership.identity;
      const archive = await archiveStore.create({
        runId: normalizedRunId,
        workspacePath,
        sourceIdentity: archiveIdentity,
        history
      });
      assertArchiveHeartbeatHealthy(heartbeat);
      if (!existingArchive) {
        const beforeRemoval = await workspace.inspectRunWorkspace({
          runId: normalizedRunId,
          workspacePath
        });
        if (stableStringify(stableArchiveSourceIdentity(beforeRemoval))
          !== stableStringify(archiveIdentity)) {
          throw new RunOrchestrationError(
            'Run workspace Git identity changed after archive capture.',
            'workspace-changed-after-archive',
          { runId: normalizedRunId }
          );
        }
      }
      assertArchiveHeartbeatHealthy(heartbeat);
      const removal = await workspace.remove({
        runId: normalizedRunId,
        workspacePath,
        force: true
      });
      if (removal?.removed !== true && removal?.alreadyAbsent !== true) {
        throw new RunOrchestrationError('Workspace adapter did not prove source removal.', 'workspace-removal-unproven', { removal });
      }
      assertArchiveHeartbeatHealthy(heartbeat);
      await this.#appendDerived({
        commandId: normalizedCommandId,
        correlationId: normalizedCommandId,
        intent,
        build: (latest) => {
          const latestRun = latest.projection.runs.find((candidate) => candidate.id === normalizedRunId);
          if (!latestRun || latestRun.status !== RunStatus.FAILED
            || latestRun.workspaceStatus !== 'preserved'
            || archivedWorkspacePath(latestRun) !== workspacePath) {
            throw new RunOrchestrationError('Run changed before archive event append.', 'run-workspace-not-archivable');
          }
          return [{
            type: 'RunWorkspaceArchived',
            streamId: `run:${normalizedRunId}`,
            payload: {
              runId: normalizedRunId,
              workspacePath,
              archivePath: archive.archivePath,
              archiveManifestDigest: `sha256:${archive.manifestDigest}`,
              archiveTreeDigest: `sha256:${archive.treeDigest}`,
              archiveEntryCount: archive.entries.length,
              removal: optionalJson(removal)
            }
          }];
        }
      });
      return this.#archiveResult(await this.#readState(), normalizedCommandId, normalizedRunId, true);
    } finally {
      if (heartbeat) {
        try { await heartbeat.stop(); }
        catch (error) { heartbeatFailure = error; }
        heartbeat = null;
      }
      try {
        await settleLeaseOperation(lease, () => lease.release({
          leaseId: acquired.lease.leaseId,
          ownerToken: acquired.ownerToken
        }));
        leaseReleased = true;
      } catch (error) {
        // A successful archive must never hide an uncertain lease release.
        // Existing command replay remains available, but the caller must see
        // the operational failure and verify before proceeding.
        throw error;
      }
      if (heartbeatFailure) throw heartbeatFailure;
      void leaseReleased;
    }
  }

  async #finishBatch(batchId, correlationId, outcome, reason) {
    return this.#appendDerived({ commandId: this.#internalCommand(batchId, `finished-${outcome}`),
      correlationId, intent: { type: 'FinishRunBatch', batchId, outcome, reason },
      build: () => [{ type: 'RunBatchFinished', streamId: `run-batch:${batchId}`,
        payload: { batchId, outcome, reason } }] });
  }

  #batchResult(state, commandId, batchId, appended, cleanup = { leaseReleased: false, warnings: [] }) {
    const batch = state.projection.runBatches.find((item) => item.id === batchId);
    const members = batch.members.map((member) => {
      const run = state.projection.runs.find((item) => item.id === member.runId);
      return { nodeId: member.nodeId, runId: member.runId, run,
        changeSet: state.projection.changeSets.find((item) => item.id === run?.changeSetId) ?? null,
        ok: run?.status === RunStatus.PRODUCED,
        cleanup: { worktreeRemoved: run?.workspaceStatus === 'removed' } };
    });
    return { ok: batch.status === 'finished' && members.every((item) => item.ok),
      appended, commandId, batch, members, deferred: batch.deferred ?? [], cleanup };
  }

  async reconcileBatch({ lease, batchId, correlationId, confirmProcessesStopped = false,
    orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS } = {}) {
    assertPort(lease, 'lease', ['init', 'inspect', 'acquire', 'release', 'archiveStale']);
    const graceMs = requireSafeDuration(orphanGraceMs, 'orphanGraceMs', DEFAULT_ORPHAN_GRACE_MS);
    const requestedId = batchId === undefined ? null : requireTrimmedString(batchId, 'batchId');
    const commandId = correlationId === undefined ? this.#id('command') : requirePublicCommandId(correlationId);
    const state = await this.#readState();
    const batch = state.projection.runBatches?.find((item) => requestedId ? item.id === requestedId : item.status === 'running');
    let leaseState = await settleLeaseOperation(lease, () => lease.init());
    if (!batch) {
      // Acquire precedes the atomic manifest publication. A crash in that small
      // window has no member Runs, but still needs a dead-owner, explicit reset.
      if (!leaseState.held || leaseState.lease.ownerKind !== 'run-batch'
        || (requestedId && leaseState.lease.ownerId !== requestedId)) {
        return { ok: true, reconciled: false, reason: 'no-active-run-batch' };
      }
      if (!leaseState.stale) return { ok: false, reconciled: false, reason: 'batch-owner-not-dead', lease: leaseState };
      if (confirmProcessesStopped !== true) return { ok: false, reconciled: false, reason: 'process-stop-confirmation-required', lease: leaseState };
      const archived = await settleLeaseOperation(lease, () => lease.archiveStale({
        expectedLeaseId: leaseState.lease.leaseId
      }));
      return { ok: true, reconciled: true, reason: 'orphan-batch-lease-archived', archived, cleanupResults: [] };
    }
    if (leaseState.held) {
      if (leaseState.lease.ownerKind !== 'run-batch' || leaseState.lease.ownerId !== batch.id) {
        return { ok: false, reconciled: false, reason: 'another-operation-owns-lease', batch, lease: leaseState };
      }
      if (!leaseState.stale) return { ok: false, reconciled: false,
        reason: 'batch-owner-not-dead', batch, lease: leaseState };
    } else if (batch.status === 'running') {
      const ageMs = this.#now().getTime() - Date.parse(batch.createdAt);
      if (!Number.isFinite(ageMs) || ageMs < graceMs) return { ok: false, reconciled: false,
        reason: 'batch-without-lease-within-grace-period', batch };
    }
    // Dead coordinator does not prove executor descendants are gone. This is
    // an explicit operator assertion, not automatic PID/TTL inference.
    if (confirmProcessesStopped !== true) return { ok: false, reconciled: false,
      reason: 'process-stop-confirmation-required', batch };
    if (leaseState.held) await settleLeaseOperation(lease, () => lease.archiveStale({
      expectedLeaseId: leaseState.lease.leaseId
    }));
    const acquired = await settleLeaseOperation(lease, () => lease.acquire({
      ownerKind: 'run-batch', ownerId: batch.id
    }));
    let finished = batch.status === 'finished';
    try {
      for (const member of batch.members) {
        const latest = await this.#readState();
        const run = latest.projection.runs.find((item) => item.id === member.runId);
        if (!run || !isActiveRun(run)) continue;
        const failure = { code: 'RUN_OWNER_LOST', message: 'Batch coordinator was lost; operator confirmed descendant processes stopped.',
          details: { batchId: batch.id, confirmProcessesStopped: true, workspacePreserved: true } };
        const record = run.status === RunStatus.PENDING
          ? this.#recordPendingFailure.bind(this) : this.#recordRunningFailure.bind(this);
        await record({ runId: run.id, commandId: this.#internalCommand(run.id, 'batch-owner-lost'),
          correlationId: commandId, phase: 'reconciliation', failure });
      }
      if (!finished) await this.#finishBatch(batch.id, commandId, 'reconciled',
        'Coordinator is dead and operator confirmed processes stopped; workspaces and Git fences were preserved.');
      finished = true;
      return { ok: true, reconciled: true, reason: 'run-batch-reconciled',
        batch: (await this.#readState()).projection.runBatches.find((item) => item.id === batch.id),
        cleanupResults: [] };
    } finally {
      if (finished) await settleLeaseOperation(lease, () => lease.release({
        leaseId: acquired.lease.leaseId, ownerToken: acquired.ownerToken
      }));
    }
  }

  async #runNext({
    executor,
    workspace,
    lease,
    artifacts,
    input,
    baseRevision = 'HEAD',
    nodeId,
    commandId,
    signal,
    leaseTtlMs
  } = {}, batchContext = null) {
    assertExecutor(executor);
    assertPort(workspace, 'workspace', ['inspect', 'create', 'capture', 'remove']);
    assertPort(lease, 'lease', [
      'init', 'inspect', 'acquire', 'heartbeat', 'release', 'archiveStale'
    ]);
    assertPort(artifacts, 'artifacts', ['init', 'put', 'verify']);
    const normalizedInput = cloneJson(input, 'input');
    const requestedBaseRevision = requireTrimmedString(baseRevision, 'baseRevision');
    const requestedNodeId = nodeId === undefined
      ? undefined
      : requireTrimmedString(nodeId, 'nodeId');
    const normalizedCommandId = commandId === undefined
      ? this.#id('command')
      : requirePublicCommandId(commandId);
    const ttlMs = requireSafeDuration(leaseTtlMs, 'leaseTtlMs', DEFAULT_LEASE_TTL_MS);
    const overallIntent = {
      schemaVersion: 1,
      type: 'RunNext',
      nodeId: requestedNodeId ?? null,
      baseRevision: requestedBaseRevision,
      executor: { id: executor.id, version: executor.version },
      input: normalizedInput
    };
    const overallIntentHash = hashCanonicalValue(overallIntent);

    let state = await this.#readState();
    const existing = batchContext ? null : recordedBatch(state.store, normalizedCommandId, overallIntentHash);
    if (existing) {
      const runId = eventFromBatch(existing, 'RunCreated').payload.runId;
      return await this.#existingRunResult(state, normalizedCommandId, runId, lease);
    }
    // Bad input is a configuration error; do not create a Run or workspace.
    executor.validateInput?.(normalizedInput);
    if (!batchContext) assertNoActiveProjectOperation(state.projection);
    let selectedNode = batchContext
      ? state.projection.nodes.find((node) => node.id === requestedNodeId)
      : requestedNodeId === undefined ? null : selectReadyNode(state.projection, requestedNodeId);

    const leaseState = batchContext ? null : await settleLeaseOperation(lease, () => lease.init());
    if (!batchContext) await artifacts.init();
    if (leaseState?.held) {
      throw new RunOrchestrationError(
        'The workspace is already leased; inspect or reconcile it before running.',
        'workspace-lease-held',
        leaseState
      );
    }

    const inspection = batchContext?.inspection
      ?? await workspace.inspect({ baseRevision: requestedBaseRevision });
    if (inspection?.clean !== true
      || typeof inspection.baseRevision !== 'string'
      || typeof inspection.coreIgnoreCase !== 'boolean') {
      throw new RunOrchestrationError(
        'The workspace adapter returned an invalid inspection.',
        'invalid-workspace-result'
      );
    }
    const admission = { input: normalizedInput, baseRevision: inspection.baseRevision, executor };
    if (!batchContext) selectedNode = selectReadyNode(state.projection, requestedNodeId, admission);
    const selectedEffects = resolveNodeEffects(selectedNode, refContracts(state.projection));
    if (!executorProvidesCapabilities(executor, selectedNode.capabilities)) {
      throw new RunOrchestrationError(
        `Executor ${executor.id} does not provide every capability required by ${selectedNode.id}.`,
        'executor-capability-mismatch',
        { required: selectedNode.capabilities, provided: [...executor.capabilities] }
      );
    }
    normalizeWritePatterns(selectedEffects.writes, {
      ignoreCase: inspection.coreIgnoreCase,
      path: 'node.writes'
    });

    const runId = batchContext?.runId ?? this.#id('run');
    const workspaceRelativePath = `.fwa/worktrees/${runId}`;
    let persistedRunId = null;
    let ownsPersistedRun = false;
    let acquired = null;
    let workspaceInfo = null;
    let heartbeat = null;
    const cleanup = { worktreeRemoved: false, leaseReleased: false, warnings: [] };
    let terminalResult;

    try {
      try {
        if (batchContext) {
          const batch = state.projection.runBatches.find((item) => item.id === batchContext.batchId);
          const member = state.projection.runs.find((item) => item.id === runId);
          if (batch?.status !== 'running' || member?.batchId !== batch.id
            || member.status !== RunStatus.PENDING
            || batch.leaseId !== batchContext.acquired.lease.leaseId) {
            throw new RunOrchestrationError('Batch member no longer owns its operation.', 'run-batch-mismatch');
          }
          acquired = batchContext.acquired;
          persistedRunId = runId;
          ownsPersistedRun = true;
        } else {
        acquired = await settleLeaseOperation(
          lease,
          () => lease.acquire({ runId, ttlMs })
        );
        const fencedState = await this.#readState();
        const fencedExisting = recordedBatch(
          fencedState.store,
          normalizedCommandId,
          overallIntentHash
        );
        if (fencedExisting) {
          persistedRunId = eventFromBatch(fencedExisting, 'RunCreated').payload.runId;
          const replay = await this.#existingRunResult(
            fencedState,
            normalizedCommandId,
            persistedRunId,
            lease
          );
          cleanup.worktreeRemoved = replay.cleanup.worktreeRemoved;
          return { ...replay, cleanup };
        }
        assertNoActiveProjectOperation(fencedState.projection);
        const fencedNode = selectReadyNode(fencedState.projection, selectedNode.id, admission);
        const fencedEffects = resolveNodeEffects(
          fencedNode,
          refContracts(fencedState.projection)
        );
        normalizeWritePatterns(fencedEffects.writes, {
          ignoreCase: inspection.coreIgnoreCase,
          path: 'node.writes'
        });
        if (fencedNode.goalId !== selectedNode.goalId
          || fencedNode.planId !== selectedNode.planId) {
          throw new RunOrchestrationError(
            `Node ${selectedNode.id} changed ownership while the Run was being scheduled.`,
            'node-plan-mismatch'
          );
        }
        if (!executorProvidesCapabilities(executor, fencedNode.capabilities)) {
          throw new RunOrchestrationError(
            `Executor ${executor.id} does not provide every capability required by ${fencedNode.id}.`,
            'executor-capability-mismatch',
            {
              required: fencedNode.capabilities,
              provided: [...executor.capabilities]
            }
          );
        }

        const initial = await this.#appendDerived({
          commandId: normalizedCommandId,
          correlationId: normalizedCommandId,
          intent: overallIntent,
          build: (latest) => {
            assertNoActiveProjectOperation(latest.projection);
            const currentNode = selectReadyNode(latest.projection, fencedNode.id, admission);
            const currentEffects = resolveNodeEffects(
              currentNode,
              refContracts(latest.projection)
            );
            if (currentNode.goalId !== fencedNode.goalId
              || currentNode.planId !== fencedNode.planId) {
              throw new RunOrchestrationError(
                `Node ${fencedNode.id} changed ownership while the Run was being scheduled.`,
                'node-plan-mismatch'
              );
            }
            return [{
              type: 'RunCreated',
              streamId: `run:${runId}`,
              payload: {
                runId,
                nodeId: currentNode.id,
                goalId: currentNode.goalId,
                planId: currentNode.planId,
                executor: { id: executor.id, version: executor.version },
                requestedBaseRevision,
                baseRevision: inspection.baseRevision,
                inputHash: `sha256:${hashCanonicalValue(normalizedInput)}`,
                workspaceRelativePath,
                effects: {
                  logicalReads: [...currentNode.reads],
                  logicalWrites: [...currentNode.writes],
                  resolvedReads: [...currentEffects.reads],
                  resolvedWrites: [...currentEffects.writes],
                  consumedRefs: currentEffects.consumedRefs.map((ref) => ({ ...ref })),
                  producedRefs: currentEffects.producedRefs.map((ref) => ({ ...ref }))
                }
              }
            }];
          }
        });
        persistedRunId = eventFromBatch(initial.batch, 'RunCreated').payload.runId;
        if (!initial.appended) {
          const replay = await this.#existingRunResult(
            initial.state,
            normalizedCommandId,
            persistedRunId,
            lease
          );
          cleanup.worktreeRemoved = replay.cleanup.worktreeRemoved;
          return { ...replay, cleanup };
        }
        ownsPersistedRun = true;
        }

        workspaceInfo = await workspace.create({
          runId: persistedRunId,
          baseRevision: inspection.baseRevision
        });
        if (workspaceInfo?.runId !== persistedRunId
          || workspaceInfo.baseRevision !== inspection.baseRevision
          || typeof workspaceInfo.workspacePath !== 'string') {
          throw new RunOrchestrationError(
            'The workspace adapter returned an invalid created worktree.',
            'invalid-workspace-result'
          );
        }
      } catch (error) {
        if (!ownsPersistedRun) throw error;
        try {
          await this.#recordPendingFailure({
            runId: persistedRunId,
            commandId: this.#internalCommand(persistedRunId, 'setup-failed'),
            correlationId: normalizedCommandId,
            phase: 'setup',
            failure: failureFrom(error, 'RUN_SETUP_FAILED')
          });
        } catch (recordingError) {
          if (recordingError?.code !== 'run-not-pending') throw recordingError;
          const raced = await this.#runResult(
            normalizedCommandId,
            persistedRunId,
            true,
            cleanup
          );
          if (raced.run?.status !== RunStatus.FAILED) throw recordingError;
          return raced;
        }
        terminalResult = await this.#runResult(normalizedCommandId, persistedRunId, true, cleanup);
        return terminalResult;
      }

      const started = await this.#appendDerived({
        commandId: this.#internalCommand(persistedRunId, 'started'),
        correlationId: normalizedCommandId,
        intent: {
          schemaVersion: 1,
          type: 'StartRun',
          runId: persistedRunId,
          workspacePath: workspaceInfo.workspacePath,
          leaseId: acquired.lease.leaseId
        },
        build: (latest) => {
          const run = latest.projection.runs.find((candidate) => candidate.id === persistedRunId);
          const node = latest.projection.nodes.find((candidate) => candidate.id === run?.nodeId);
          const goal = latest.projection.goals.find((candidate) => candidate.id === run?.goalId);
          if (!run || !node || !goal
            || run.status !== RunStatus.PENDING
            || node.status !== NodeStatus.READY) {
            throw new RunOrchestrationError(
              `Run ${persistedRunId} is no longer startable.`,
              'run-not-pending'
            );
          }
          const events = [];
          if (goal.status === GoalStatus.PLANNED) {
            events.push({
              type: 'GoalActivated',
              streamId: `goal:${goal.id}`,
              payload: { goalId: goal.id, nodeId: node.id, runId: run.id }
            });
          } else if (goal.status !== GoalStatus.ACTIVE) {
            throw new RunOrchestrationError(
              `Goal ${goal.id} is not runnable while ${goal.status}.`,
              'goal-not-runnable'
            );
          }
          events.push({
            type: 'NodeStarted',
            streamId: `node:${node.id}`,
            payload: { goalId: goal.id, nodeId: node.id, runId: run.id }
          });
          events.push({
            type: 'RunStarted',
            streamId: `run:${run.id}`,
            payload: {
              goalId: goal.id,
              nodeId: node.id,
              runId: run.id,
              workspacePath: workspaceInfo.workspacePath,
              leaseId: acquired.lease.leaseId
            }
          });
          return events;
        }
      });

      const runningState = started.state;
      const runningRun = runningState.projection.runs.find(
        (candidate) => candidate.id === persistedRunId
      );
      const runningNode = runningState.projection.nodes.find(
        (candidate) => candidate.id === runningRun.nodeId
      );
      const runningGoal = runningState.projection.goals.find(
        (candidate) => candidate.id === runningRun.goalId
      );
      heartbeat = startHeartbeat(
        lease,
        acquired,
        ttlMs,
        signal,
        runningNode.budget.wallTimeMinutes === undefined
          ? undefined
          : runningNode.budget.wallTimeMinutes * 60_000
      );
      const startedAt = Date.now();
      let executorResult = null;
      let executionFailure = null;
      try {
        const rawResult = await executor.execute({
          workspaceRoot: workspaceInfo.workspacePath,
          node: {
            ...runningNode,
            reads: [...runningRun.effects.resolvedReads],
            writes: [...runningRun.effects.resolvedWrites],
            effects: runningRun.effects
          },
          goal: runningGoal,
          baseRevision: runningRun.baseRevision,
          input: normalizedInput,
          signal: heartbeat.signal
        });
        if (batchContext && rawResult?.process?.terminationConfirmed === false) {
          throw new RunOrchestrationError('Executor reported an unconfirmed process despite returning a result.',
            'executor-termination-unconfirmed', { process: optionalJson(rawResult.process) });
        }
        executorResult = validateExecutorResult(rawResult);
      } catch (error) {
        executionFailure = failureFrom(error, 'EXECUTOR_FAILED');
      }
      if (!executionFailure && heartbeat.signal.aborted) {
        executionFailure = failureFrom(
          heartbeat.signal.reason,
          'EXECUTION_ABORTED'
        );
      }
      try {
        await heartbeat.stop();
      } catch (error) {
        executionFailure ??= failureFrom(error, 'LEASE_HEARTBEAT_FAILED');
      }
      heartbeat = null;

      if (executionFailure) {
        // Persist complete executor diagnostics once, before capture (which can
        // itself fail). Events and retry inputs only carry a bounded summary and
        // this immutable reference, never recursively embedded stdout/stderr.
        try {
          const failureArtifact = await artifacts.put(`${stableStringify({
            schemaVersion: 1, runId: persistedRunId,
            executor: { id: executor.id, version: executor.version },
            failure: executionFailure
          })}\n`);
          await artifacts.verify(failureArtifact);
          executionFailure = summarizeFailure(executionFailure, { artifactRef: failureArtifact });
        } catch (error) {
          if (batchContext && terminationUnconfirmed(executionFailure)) batchContext.markUnsafe(executionFailure);
          const retained = summarizeFailure(executionFailure);
          await this.#recordRunningFailure({
            runId: persistedRunId,
            commandId: this.#internalCommand(persistedRunId, 'failure-artifact-failed'),
            correlationId: normalizedCommandId,
            phase: 'artifact',
            failure: { ...retained, details: { ...retained.details,
              retentionFailure: summarizeFailure(failureFrom(error, 'ARTIFACT_WRITE_FAILED')) } }
          });
          cleanup.preservedWorkspace = workspaceInfo.workspacePath;
          return await this.#runResult(normalizedCommandId, persistedRunId, true, cleanup);
        }
      }

      if (batchContext && terminationUnconfirmed(executionFailure)) {
        batchContext.markUnsafe(executionFailure);
        await this.#recordRunningFailure({
          runId: persistedRunId,
          commandId: this.#internalCommand(persistedRunId, 'termination-unconfirmed'),
          correlationId: normalizedCommandId,
          phase: 'execution',
          failure: executionFailure
        });
        cleanup.preservedWorkspace = workspaceInfo.workspacePath;
        return await this.#runResult(normalizedCommandId, persistedRunId, true, cleanup);
      }

      let capture;
      try {
        capture = validateCapture(
          await workspace.capture({
            workspacePath: workspaceInfo.workspacePath,
            baseRevision: inspection.baseRevision,
            runId: persistedRunId
          }),
          persistedRunId,
          inspection.baseRevision,
          {
            workspacePath: workspaceInfo.workspacePath,
            ignoreCase: inspection.coreIgnoreCase
          }
        );
      } catch (error) {
        const captureFailure = failureFrom(error, 'CHANGESET_CAPTURE_FAILED');
        if (executionFailure) captureFailure.details = {
          ...(captureFailure.details ?? {}), executionFailure
        };
        await this.#recordRunningFailure({
          runId: persistedRunId,
          commandId: this.#internalCommand(persistedRunId, 'capture-failed'),
          correlationId: normalizedCommandId,
          phase: 'capture',
          failure: captureFailure
        });
        terminalResult = await this.#runResult(normalizedCommandId, persistedRunId, true, cleanup);
        return terminalResult;
      }

      const durationMs = Math.max(0, Math.ceil(Date.now() - startedAt));
      const writeCheck = validateActualWrites(
        runningRun.effects.resolvedWrites,
        capture.changedFiles,
        { ignoreCase: inspection.coreIgnoreCase }
      );
      const changedRefIds = changedRefsForFiles(
        runningRun.effects.producedRefs,
        capture.changedFiles,
        { ignoreCase: inspection.coreIgnoreCase }
      );
      const stats = {
        fileCount: capture.changedFiles.length,
        diffLines: countPatchLines(capture.patch),
        durationMs
      };
      const violations = [
        ...writeCheck.violations.map((item) => cloneJson(item, 'write violation')),
        ...budgetEvidence(runningNode, stats, executorResult)
      ];
      if (executionFailure) violations.push(executionFailureEvidence(executionFailure));
      const valid = violations.length === 0;

      let patchArtifact;
      let executionArtifact;
      try {
        patchArtifact = await artifacts.put(capture.patch);
        executionArtifact = await artifacts.put(`${stableStringify({
          schemaVersion: 1,
          runId: persistedRunId,
          executor: { id: executor.id, version: executor.version },
          result: executorResult,
          failure: executionFailure,
          input: normalizedInput
        })}\n`);
        await artifacts.verify(patchArtifact);
        await artifacts.verify(executionArtifact);
      } catch (error) {
        await this.#recordRunningFailure({
          runId: persistedRunId,
          commandId: this.#internalCommand(persistedRunId, 'artifact-failed'),
          correlationId: normalizedCommandId,
          phase: 'artifact',
          failure: failureFrom(error, 'ARTIFACT_WRITE_FAILED')
        });
        terminalResult = await this.#runResult(normalizedCommandId, persistedRunId, true, cleanup);
        return terminalResult;
      }

      const changeSetId = this.#id('changeset');
      await this.#appendDerived({
        commandId: this.#internalCommand(persistedRunId, 'finished'),
        correlationId: normalizedCommandId,
        intent: {
          schemaVersion: 1,
          type: 'FinishRun',
          runId: persistedRunId,
          changeSetId,
          capture: {
            baseRevision: capture.baseRevision,
            headRevision: capture.headRevision,
            commits: capture.commits,
             changedFiles: capture.changedFiles,
             changedRefIds,
             coreIgnoreCase: inspection.coreIgnoreCase,
             changes: capture.changes,
            ref: capture.ref,
            branch: capture.branch
          },
          valid,
          violations,
          stats,
          patchArtifact,
          executionArtifact
        },
        build: (latest) => {
          const run = latest.projection.runs.find((candidate) => candidate.id === persistedRunId);
          const node = latest.projection.nodes.find((candidate) => candidate.id === run?.nodeId);
          if (!run || !node
            || run.status !== RunStatus.RUNNING
            || node.status !== NodeStatus.RUNNING) {
            throw new RunOrchestrationError(
              `Run ${persistedRunId} is no longer finishable.`,
              'run-not-running'
            );
          }
          const events = [{
            type: 'ChangeSetCaptured',
            streamId: `changeset:${changeSetId}`,
            payload: {
              changeSetId,
              runId: run.id,
              nodeId: node.id,
              goalId: run.goalId,
              baseRevision: capture.baseRevision,
              headRevision: capture.headRevision,
              commits: capture.commits,
               changedFiles: capture.changedFiles,
               changedRefIds,
               coreIgnoreCase: inspection.coreIgnoreCase,
               changes: capture.changes,
              ref: capture.ref,
              branch: capture.branch,
              valid,
              violations,
              stats,
              patchArtifact,
              executionArtifact
            }
          }];
          if (valid) {
            events.push({
              type: 'RunProduced',
              streamId: `run:${run.id}`,
              payload: {
                runId: run.id,
                nodeId: node.id,
                changeSetId,
                summary: `Executor ${executor.id} produced ${capture.changedFiles.length} changed file(s).`
              }
            });
            events.push({
              type: 'NodeProduced',
              streamId: `node:${node.id}`,
              payload: { nodeId: node.id, runId: run.id, changeSetId }
            });
          } else {
            const failure = executionFailure ?? {
              code: 'CHANGESET_INVALID',
              message: `ChangeSet ${changeSetId} violated its declared effects or budget.`,
              details: { violations }
            };
            events.push({
              type: 'RunFailed',
              streamId: `run:${run.id}`,
              payload: { runId: run.id, phase: 'verification', failure }
            });
            events.push({
              type: 'NodeFailed',
              streamId: `node:${node.id}`,
              payload: { nodeId: node.id, runId: run.id, failure }
            });
            if (retryAllowed(node, failure)) {
              events.push({
                type: 'NodeReady',
                streamId: `node:${node.id}`,
                payload: {
                  goalId: node.goalId,
                  planId: node.planId,
                  nodeId: node.id,
                  reason: 'retry'
                }
              });
            }
          }
          return events;
        }
      });

      if (valid) {
        await this.#cleanupProducedWorkspace({
          workspace,
          runId: persistedRunId,
          correlationId: normalizedCommandId,
          cleanup
        });
      } else {
        cleanup.preservedWorkspace = workspaceInfo.workspacePath;
      }
      terminalResult = await this.#runResult(normalizedCommandId, persistedRunId, true, cleanup);
      return terminalResult;
    } finally {
      if (heartbeat) {
        try {
          await heartbeat.stop();
        } catch (error) {
          cleanup.warnings.push({ phase: 'heartbeat-stop', failure: failureFrom(error) });
        }
      }
      if (acquired && !batchContext) {
        try {
          await settleLeaseOperation(lease, () => lease.release({
            leaseId: acquired.lease.leaseId,
            ownerToken: acquired.ownerToken
          }));
          cleanup.leaseReleased = true;
        } catch (error) {
          cleanup.warnings.push({ phase: 'lease-release', failure: failureFrom(error) });
        }
      }
    }
  }

  async reconcile({
    lease,
    workspace,
    correlationId,
    orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS
  } = {}) {
    assertPort(lease, 'lease', [
      'init', 'inspect', 'acquire', 'release', 'archiveStale'
    ]);
    const requestedCorrelationId = correlationId === undefined
      ? null
      : requirePublicCommandId(correlationId);
    const graceMs = requireSafeDuration(orphanGraceMs, 'orphanGraceMs', DEFAULT_ORPHAN_GRACE_MS);
    const leaseState = await settleLeaseOperation(lease, () => lease.init());
    let state = await this.#readState();
    const activeBatch = (state.projection.runBatches ?? []).find((item) => item.status === 'running');
    if (activeBatch) return { ok: false, reconciled: false,
      reason: 'run-batch-reconciliation-required', batch: activeBatch, cleanupResults: [] };
    const unfenced = state.projection.runs.find((run) => isUnfencedGitProcessFailure(run.failure));
    if (unfenced) {
      return { ok: false, reconciled: false, reason: 'git-process-manual-recovery-required',
        runId: unfenced.id, failure: unfenced.failure, cleanupResults: [] };
    }
    const activeRun = getActiveRun(state.projection);
    const activeEvaluations = getActiveEvaluations(state.projection);

    if (activeEvaluations.length > 0) {
      return {
        ok: true,
        reconciled: false,
        reason: 'evaluation-operation-active',
        evaluation: activeEvaluations[0],
        evaluationIds: activeEvaluations.map((evaluation) => evaluation.id),
        lease: leaseState
      };
    }
    const activeIntegrations = getActiveIntegrations(state.projection);
    if (activeIntegrations.length > 0) {
      return {
        ok: true,
        reconciled: false,
        reason: 'integration-operation-active',
        integration: activeIntegrations[0],
        integrationIds: activeIntegrations.map((integration) => integration.id),
        cleanupResults: []
      };
    }
    const activeReversions = getActiveReversions(state.projection);
    if (activeReversions.length > 0) {
      return {
        ok: true,
        reconciled: false,
        reason: 'reversion-operation-active',
        reversion: activeReversions[0],
        reversionIds: activeReversions.map((reversion) => reversion.id),
        cleanupResults: []
      };
    }

    if (!activeRun) {
      let currentLease = leaseState;
      if (currentLease.held && currentLease.lease.ownerKind !== 'run') {
        return {
          ok: true,
          reconciled: false,
          reason: 'another-operation-owns-lease',
          lease: currentLease
        };
      }
      if (currentLease.held && !currentLease.stale) {
        return {
          ok: true,
          reconciled: false,
          reason: 'lease-owner-not-dead',
          lease: currentLease
        };
      }
      let archived = null;
      if (currentLease.held) {
        archived = await settleLeaseOperation(lease, () => lease.archiveStale({
          expectedLeaseId: currentLease.lease.leaseId
        }));
        currentLease = await settleLeaseOperation(lease, () => lease.inspect());
      }

      const pendingCleanup = state.projection.runs.filter((run) => (
        run.status === RunStatus.PRODUCED
        && run.workspaceStatus !== 'removed'
      ));
      if (pendingCleanup.length === 0) {
        return {
          ok: true,
          reconciled: archived !== null,
          reason: archived ? 'orphan-lease-archived' : 'workspace-free',
          archived
        };
      }
      assertPort(workspace, 'workspace', ['remove']);
      const cleanupResults = [];
      for (const run of pendingCleanup) {
        const cleanupLease = await settleLeaseOperation(
          lease,
          () => lease.acquire({ runId: run.id })
        );
        const cleanup = { worktreeRemoved: false, leaseReleased: false, warnings: [] };
        let fencedActiveRun = null;
        try {
          const fencedState = await this.#readState();
          fencedActiveRun = getActiveRun(fencedState.projection);
          if (!fencedActiveRun) {
            await this.#cleanupProducedWorkspace({
              workspace,
              runId: run.id,
              correlationId: requestedCorrelationId ?? run.id,
              cleanup
            });
          }
        } finally {
          try {
            await settleLeaseOperation(lease, () => lease.release({
              leaseId: cleanupLease.lease.leaseId,
              ownerToken: cleanupLease.ownerToken
            }));
            cleanup.leaseReleased = true;
          } catch (error) {
            cleanup.warnings.push({ phase: 'lease-release', failure: failureFrom(error) });
          }
        }
        cleanupResults.push({ runId: run.id, cleanup });
        if (fencedActiveRun) {
          return {
            ok: true,
            reconciled: archived !== null,
            reason: 'run-owner-claimed-before-cleanup',
            run: fencedActiveRun,
            cleanupResults,
            archived
          };
        }
      }
      return {
        ok: true,
        reconciled: true,
        reason: 'produced-workspace-cleanup',
        cleanupResults,
        archived
      };
    }

    let recoveryFence = null;
    if (leaseState.held) {
      if (leaseState.lease.runId !== activeRun.id) {
        throw new RunOrchestrationError(
          `Active run ${activeRun.id} does not own lease ${leaseState.lease.leaseId}.`,
          'run-lease-mismatch',
          { runId: activeRun.id, lease: leaseState.lease }
        );
      }
      if (!leaseState.stale) {
        return {
          ok: true,
          reconciled: false,
          reason: 'run-owner-not-dead',
          run: activeRun,
          lease: leaseState
        };
      }
      await settleLeaseOperation(
        lease,
        () => lease.archiveStale({ expectedLeaseId: leaseState.lease.leaseId })
      );
    } else {
      const ageMs = this.#now().getTime() - Date.parse(activeRun.createdAt);
      if (!Number.isFinite(ageMs) || ageMs < graceMs) {
        return {
          ok: true,
          reconciled: false,
          reason: 'run-without-lease-within-grace-period',
          run: activeRun,
          ageMs
        };
      }
    }

    try {
      recoveryFence = await settleLeaseOperation(
        lease,
        () => lease.acquire({ runId: activeRun.id })
      );
    } catch (error) {
      if (error?.code !== 'workspace-lease-held') throw error;
      const claimedLease = await settleLeaseOperation(lease, () => lease.inspect());
      return {
        ok: true,
        reconciled: false,
        reason: 'run-owner-claimed-before-reconciliation',
        run: activeRun,
        lease: claimedLease
      };
    }

    try {
      state = await this.#readState();
      const fencedActiveRun = getActiveRun(state.projection);
      if (!fencedActiveRun || fencedActiveRun.id !== activeRun.id) {
        return {
          ok: true,
          reconciled: false,
          reason: 'run-state-changed-before-reconciliation',
          run: fencedActiveRun ?? state.projection.runs.find(
            (candidate) => candidate.id === activeRun.id
          ) ?? null
        };
      }

      const normalizedCommandId = requestedCorrelationId === null
        ? fencedActiveRun.id
        : requestedCorrelationId;
      const recoveryCommandId = this.#internalCommand(fencedActiveRun.id, 'reconciled');
      const failure = {
        code: 'RUN_OWNER_LOST',
        message: `Run ${fencedActiveRun.id} was non-terminal after its owner process disappeared.`,
        details: { previousStatus: fencedActiveRun.status }
      };
      if (fencedActiveRun.status === RunStatus.PENDING) {
        await this.#recordPendingFailure({
          runId: fencedActiveRun.id,
          commandId: recoveryCommandId,
          correlationId: normalizedCommandId,
          phase: 'reconciliation',
          failure
        });
      } else {
        await this.#recordRunningFailure({
          runId: fencedActiveRun.id,
          commandId: recoveryCommandId,
          correlationId: normalizedCommandId,
          phase: 'reconciliation',
          failure
        });
      }
      state = await this.#readState();
      return {
        ok: true,
        reconciled: true,
        reason: 'abandoned-run-failed',
        run: state.projection.runs.find((run) => run.id === fencedActiveRun.id),
        node: state.projection.nodes.find((node) => node.id === fencedActiveRun.nodeId)
      };
    } finally {
      if (recoveryFence) {
        await settleLeaseOperation(lease, () => lease.release({
          leaseId: recoveryFence.lease.leaseId,
          ownerToken: recoveryFence.ownerToken
        }));
      }
    }
  }

  async #cleanupProducedWorkspace({
    workspace,
    runId,
    correlationId,
    cleanup
  }) {
    const before = await this.#readState();
    const run = before.projection.runs.find((candidate) => candidate.id === runId);
    if (!run || run.status !== RunStatus.PRODUCED) {
      throw new RunOrchestrationError(
        `Run ${runId} is not a produced Run awaiting cleanup.`,
        'run-cleanup-mismatch'
      );
    }
    if (run.workspaceStatus === 'removed') {
      cleanup.worktreeRemoved = true;
      return;
    }

    let removal;
    try {
      removal = await workspace.remove({
        runId,
        workspacePath: run.workspacePath
      });
    } catch (error) {
      const failure = failureFrom(error, 'WORKTREE_CLEANUP_FAILED');
      await this.#recordWorkspaceCleanupFailure({
        run,
        correlationId,
        failure,
        cleanup
      });
      return;
    }

    if (removal?.removed !== true && removal?.alreadyAbsent !== true) {
      const failure = {
        code: 'INVALID_WORKTREE_REMOVAL_RESULT',
        message: 'The workspace adapter did not prove removal or prior absence.',
        details: optionalJson(removal)
      };
      await this.#recordWorkspaceCleanupFailure({
        run,
        correlationId,
        failure,
        cleanup
      });
      return;
    }

    await this.#appendDerived({
      commandId: this.#internalCommand(runId, 'workspace-removed'),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'RecordWorkspaceRemoved',
        runId,
        workspacePath: run.workspacePath,
        removal: optionalJson(removal)
      },
      build: (latest) => {
        const current = latest.projection.runs.find((candidate) => candidate.id === runId);
        if (!current || current.status !== RunStatus.PRODUCED
          || current.workspaceStatus === 'removed') {
          throw new RunOrchestrationError(
            `Run ${runId} no longer needs workspace cleanup.`,
            'run-cleanup-mismatch'
          );
        }
        return [{
          type: 'RunWorkspaceRemoved',
          streamId: `run:${runId}`,
          payload: {
            runId,
            workspacePath: current.workspacePath,
            reason: removal?.alreadyAbsent ? 'already-absent' : 'removed'
          }
        }];
      }
    });
    cleanup.worktreeRemoved = true;
  }

  async #recordWorkspaceCleanupFailure({ run, correlationId, failure, cleanup }) {
    cleanup.warnings.push({ phase: 'worktree-cleanup', failure });
    await this.#appendDerived({
      commandId: this.#internalCommand(
        run.id,
        `workspace-cleanup-failed-${run.cleanupFailures.length + 1}`
      ),
      correlationId,
      intent: {
        schemaVersion: 1,
        type: 'RecordWorkspaceCleanupFailure',
        runId: run.id,
        failure
      },
      build: (latest) => {
        const current = latest.projection.runs.find((candidate) => candidate.id === run.id);
        if (!current || current.status !== RunStatus.PRODUCED
          || current.workspaceStatus === 'removed') {
          throw new RunOrchestrationError(
            `Run ${run.id} no longer needs workspace cleanup.`,
            'run-cleanup-mismatch'
          );
        }
        return [{
          type: 'RunWorkspaceCleanupFailed',
          streamId: `run:${run.id}`,
          payload: { runId: run.id, workspacePath: current.workspacePath, failure }
        }];
      }
    });
  }

  async #recordPendingFailure({
    runId,
    commandId,
    correlationId,
    phase,
    failure
  }) {
    return this.#appendDerived({
      commandId,
      correlationId,
      intent: { schemaVersion: 1, type: 'FailPendingRun', runId, phase, failure },
      build: (latest) => {
        const run = latest.projection.runs.find((candidate) => candidate.id === runId);
        if (!run || run.status !== RunStatus.PENDING) {
          throw new RunOrchestrationError(
            `Run ${runId} is not pending.`,
            'run-not-pending'
          );
        }
        return [{
          type: 'RunFailed',
          streamId: `run:${run.id}`,
          payload: { runId: run.id, phase, failure }
        }];
      }
    });
  }

  async #recordRunningFailure({
    runId,
    commandId,
    correlationId,
    phase,
    failure
  }) {
    return this.#appendDerived({
      commandId,
      correlationId,
      intent: { schemaVersion: 1, type: 'FailRunningRun', runId, phase, failure },
      build: (latest) => {
        const run = latest.projection.runs.find((candidate) => candidate.id === runId);
        const node = latest.projection.nodes.find((candidate) => candidate.id === run?.nodeId);
        if (!run || !node
          || (run.status !== RunStatus.RUNNING && run.status !== RunStatus.PAUSED)
          || node.status !== NodeStatus.RUNNING) {
          throw new RunOrchestrationError(
            `Run ${runId} is not running.`,
            'run-not-running'
          );
        }
        const events = [
          {
            type: 'RunFailed',
            streamId: `run:${run.id}`,
            payload: { runId: run.id, phase, failure }
          },
          {
            type: 'NodeFailed',
            streamId: `node:${node.id}`,
            payload: { nodeId: node.id, runId: run.id, failure }
          }
        ];
        if (retryAllowed(node, failure)) {
          events.push({
            type: 'NodeReady',
            streamId: `node:${node.id}`,
            payload: {
              goalId: node.goalId,
              planId: node.planId,
              nodeId: node.id,
              reason: 'retry'
            }
          });
        }
        return events;
      }
    });
  }

  async #existingRunResult(state, commandId, runId, lease) {
    const run = state.projection.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      throw new RunOrchestrationError(
        `Recorded Run ${runId} is missing from the projection.`,
        'run-not-found'
      );
    }
    if (isActiveRun(run)) {
      throw new RunOrchestrationError(
        `Run ${runId} is still ${run.status}; use run reconcile before retrying the command.`,
        'run-reconciliation-required',
        { runId, status: run.status }
      );
    }
    const leaseState = await settleLeaseOperation(lease, () => lease.init());
    return this.#resultFromState(state, commandId, runId, false, {
      worktreeRemoved: run.workspaceStatus === 'removed',
      leaseReleased: !leaseIsOwnedByRun(leaseState, run.id),
      warnings: []
    });
  }

  async #runResult(commandId, runId, appended, cleanup) {
    const state = await this.#readState();
    return this.#resultFromState(state, commandId, runId, appended, cleanup);
  }

  #resultFromState(state, commandId, runId, appended, cleanup) {
    const run = state.projection.runs.find((candidate) => candidate.id === runId);
    const node = state.projection.nodes.find((candidate) => candidate.id === run?.nodeId);
    const goal = state.projection.goals.find((candidate) => candidate.id === run?.goalId);
    const changeSet = state.projection.changeSets.find(
      (candidate) => candidate.id === run?.changeSetId
    ) ?? null;
    return {
      ok: run?.status === RunStatus.PRODUCED,
      appended,
      commandId,
      goal,
      node,
      run,
      changeSet,
      cleanup
    };
  }

  #archiveResult(state, commandId, runId, appended) {
    const run = state.projection.runs.find((candidate) => candidate.id === runId);
    return {
      ok: run?.workspaceStatus === 'removed',
      appended,
      commandId,
      run,
      archive: run?.workspaceArchive ?? null
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
          throw new RunOrchestrationError(
            'A derived event batch must contain at least one event.',
            'empty-run-event-batch'
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

  #internalCommand(runId, phase) {
    return `${INTERNAL_COMMAND_PREFIX}run/${requireTrimmedString(runId, 'runId')}/${requireTrimmedString(phase, 'phase')}`;
  }

  #now() {
    const value = this.clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new RunOrchestrationError('clock returned an invalid date.', 'invalid-clock');
    }
    return date;
  }
}
