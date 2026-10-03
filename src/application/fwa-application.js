import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  assertValidPlan,
  PLAN_SCHEMA_VERSION,
  PlanValidationError
} from '../core/dag.js';
import { createEvent, stableStringify } from '../core/events.js';
import { validateEvidenceAgainstProfile } from '../core/evaluator.js';
import { summarizeFailure } from '../core/failure-diagnostics.js';
import { isRefId, normalizeRef } from '../core/refs.js';
import { GoalStatus } from '../core/state-machines.js';
import { INTERACTION_FIELDS } from '../core/interaction-contract.js';
import { buildWorkflow, currentLogicalPlan, preparePlanRevision } from '../core/workflow.js';
import { buildRetryDiagnostics, diagnoseNodeRetry } from '../core/retry-diagnostics.js';
import { diagnosePlan } from '../core/plan-diagnostics.js';
import { hasActiveProjectOperation, nodeHasUnsettledWorkspace, nodeRetryEligibility } from '../core/scheduling.js';
import {
  FileEventStore,
  hashCanonicalValue
} from '../storage/file-event-store.js';
import { ArtifactStore } from '../storage/artifact-store.js';
import { WorkspaceLease } from '../storage/workspace-lease.js';
import { WorkspaceArchiveStore } from '../storage/workspace-archive.js';
import { WorkbenchJobs } from '../storage/workbench-jobs.js';
import {
  initializeProject,
  loadProject,
  resolveProjectRoot
} from './project.js';
import { projectEvents } from './projection.js';
import { EvaluationOrchestrator } from './evaluation-orchestrator.js';
import { IntegrationOrchestrator } from './integration-orchestrator.js';
import { RunOrchestrator } from './run-orchestrator.js';

const DEFAULT_LOCK_RETRY_DELAYS = Object.freeze([5, 10, 20, 40, 80, 160, 250]);

export class FwaApplicationError extends Error {
  constructor(message, code = 'application-error', details = undefined) {
    super(message);
    this.name = 'FwaApplicationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function requireTrimmedString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new FwaApplicationError(
      `${name} must be a non-empty, trimmed string.`,
      'invalid-command'
    );
  }
  return value;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function parseCanonicalJsonArtifact(bytes, label, details) {
  let source;
  let value;
  try {
    source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) {
      throw new TypeError('bytes are not canonical UTF-8');
    }
    value = JSON.parse(source);
  } catch (error) {
    throw new FwaApplicationError(
      `${label} is not valid UTF-8 JSON: ${error.message}`,
      'evidence-artifact-invalid',
      details
    );
  }
  if (!isPlainObject(value) || stableStringify(value) !== source) {
    throw new FwaApplicationError(
      `${label} is not a canonical JSON object.`,
      'evidence-artifact-invalid',
      details
    );
  }
  return value;
}

function requireExactObjectFields(value, expectedFields) {
  return isPlainObject(value)
    && stableStringify(Object.keys(value).sort()) === stableStringify([...expectedFields].sort());
}

function rejectUnknownFields(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new PlanValidationError(unknown.map((field) => ({
      code: 'UNKNOWN_FIELD',
      path: path === '$' ? field : `${path}.${field}`,
      message: `Unknown field "${field}".`
    })));
  }
}

function aliasedValue(value, fields, path) {
  const present = fields.filter((field) => Object.hasOwn(value, field));
  if (present.length > 1) {
    throw new PlanValidationError([{
      code: 'AMBIGUOUS_FIELD',
      path,
      message: `Use only one of: ${fields.join(', ')}.`,
      details: { fields: present }
    }]);
  }
  return present.length === 0 ? undefined : value[present[0]];
}

function cloneJson(value, path) {
  try {
    return JSON.parse(stableStringify(value));
  } catch (error) {
    throw new PlanValidationError([{
      code: 'NON_JSON_VALUE',
      path,
      message: error.message
    }]);
  }
}

function canonicalBudget(budget, path) {
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
    return budget;
  }
  rejectUnknownFields(budget, [
    'maxRetries', 'max_retries',
    'maxFiles', 'max_files',
    'maxDiffLines', 'max_diff_lines',
    'wallTimeMinutes', 'wall_time_minutes',
    'tokenBudget', 'token_budget'
  ], path);

  const result = {
    maxRetries: aliasedValue(budget, ['maxRetries', 'max_retries'], `${path}.maxRetries`),
    maxFiles: aliasedValue(budget, ['maxFiles', 'max_files'], `${path}.maxFiles`),
    maxDiffLines: aliasedValue(
      budget,
      ['maxDiffLines', 'max_diff_lines'],
      `${path}.maxDiffLines`
    )
  };
  const wallTimeMinutes = aliasedValue(
    budget,
    ['wallTimeMinutes', 'wall_time_minutes'],
    `${path}.wallTimeMinutes`
  );
  const tokenBudget = aliasedValue(
    budget,
    ['tokenBudget', 'token_budget'],
    `${path}.tokenBudget`
  );
  if (wallTimeMinutes !== undefined) result.wallTimeMinutes = wallTimeMinutes;
  if (tokenBudget !== undefined) result.tokenBudget = tokenBudget;
  return result;
}

function canonicalNode(node, index) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return node;
  }
  const path = `nodes[${index}]`;
  rejectUnknownFields(node, [
    'id', 'title', 'parentId', 'resources', 'instruction', 'referenceInputs', 'outcome', 'dependencyReasons', 'derivedFrom',
    'dependsOn', 'depends_on',
    'reads', 'writes',
    'capabilities', 'requires',
    'acceptance', 'acceptanceContract', 'acceptance_contract',
    'budget'
  ], path);

  const result = {
    id: node.id,
    dependsOn: cloneJson(
      aliasedValue(node, ['dependsOn', 'depends_on'], `${path}.dependsOn`),
      `${path}.dependsOn`
    ),
    reads: cloneJson(node.reads, `${path}.reads`),
    writes: cloneJson(node.writes, `${path}.writes`),
    capabilities: cloneJson(
      aliasedValue(node, ['capabilities', 'requires'], `${path}.capabilities`),
      `${path}.capabilities`
    ),
    acceptance: cloneJson(
      aliasedValue(
        node,
        ['acceptance', 'acceptanceContract', 'acceptance_contract'],
        `${path}.acceptance`
      ),
      `${path}.acceptance`
    ),
    budget: canonicalBudget(node.budget, `${path}.budget`)
  };
  if (Object.hasOwn(node, 'title')) result.title = node.title;
  for (const field of ['parentId', 'resources', 'instruction', 'referenceInputs', 'outcome', 'dependencyReasons', 'derivedFrom']) {
    if (Object.hasOwn(node, field)) result[field] = cloneJson(node[field], `${path}.${field}`);
  }
  return result;
}

export function canonicalizePlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    assertValidPlan(plan);
  }

  rejectUnknownFields(plan, ['schemaVersion', 'id', 'goalId', 'goal_id', 'groups', 'nodes'], '$');
  const schemaVersion = Object.hasOwn(plan, 'schemaVersion')
    ? plan.schemaVersion
    : PLAN_SCHEMA_VERSION;
  if (schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new PlanValidationError([{
      code: 'UNSUPPORTED_SCHEMA',
      path: 'schemaVersion',
      message: `Unsupported plan schema version ${String(schemaVersion)}.`
    }]);
  }

  const result = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    nodes: Array.isArray(plan.nodes)
      ? plan.nodes.map((node, index) => canonicalNode(node, index))
      : plan.nodes
  };
  if (Object.hasOwn(plan, 'id')) result.id = plan.id;
  if (Object.hasOwn(plan, 'groups')) result.groups = cloneJson(plan.groups, 'groups');
  const goalId = aliasedValue(plan, ['goalId', 'goal_id'], 'goalId');
  if (goalId !== undefined) result.goalId = goalId;

  assertValidPlan(result);
  return result;
}

function recordedBatch(state, commandId, intentHash) {
  const batch = state.batches.find((candidate) => candidate.commandId === commandId);
  if (!batch) return null;
  if (batch.intentHash !== intentHash) {
    throw new FwaApplicationError(
      `Command "${commandId}" was already recorded with a different intent.`,
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
    throw new FwaApplicationError(
      `Recorded command ${batch.commandId} has no ${type} event.`,
      'recorded-command-type-mismatch'
    );
  }
  return event;
}

export class FwaApplication {
  constructor(projectRoot, options = {}) {
    this.projectRoot = resolveProjectRoot(projectRoot);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.actor = options.actor ?? 'cli';
    this.lockRetryDelays = options.lockRetryDelays ?? DEFAULT_LOCK_RETRY_DELAYS;
    if (typeof this.clock !== 'function' || typeof this.idFactory !== 'function') {
      throw new TypeError('clock and idFactory must be functions.');
    }
    if (!Array.isArray(this.lockRetryDelays)
      || this.lockRetryDelays.some((delay) => !Number.isInteger(delay) || delay < 0)) {
      throw new TypeError('lockRetryDelays must be an array of non-negative integers.');
    }
    this.store = options.store ?? new FileEventStore(this.projectRoot, {
      clock: this.clock,
      ...(options.eventStoreOptions ?? {})
    });
    this.artifacts = options.artifacts ?? new ArtifactStore(this.projectRoot);
    this.lease = options.lease ?? new WorkspaceLease(this.projectRoot, {
      clock: this.clock
    });
    this.workspaceArchives = options.workspaceArchives
      ?? new WorkspaceArchiveStore(this.projectRoot, { clock: this.clock });
    this.runOrchestrator = new RunOrchestrator(this.projectRoot, {
      store: this.store,
      clock: this.clock,
      idFactory: this.idFactory,
      actor: this.actor,
      lockRetryDelays: this.lockRetryDelays,
      workspaceArchives: this.workspaceArchives
    });
    this.evaluationOrchestrator = new EvaluationOrchestrator(this.projectRoot, {
      store: this.store,
      clock: this.clock,
      idFactory: this.idFactory,
      actor: this.actor,
      lockRetryDelays: this.lockRetryDelays
    });
    this.integrationOrchestrator = new IntegrationOrchestrator(this.projectRoot, {
      store: this.store,
      clock: this.clock,
      idFactory: this.idFactory,
      actor: this.actor,
      lockRetryDelays: this.lockRetryDelays
    });
  }

  async init() {
    const project = initializeProject(this.projectRoot, this.clock());
    const storage = await this.store.init();
    const artifacts = await this.artifacts.init();
    const workspaceArchives = await this.workspaceArchives.init();
    const lease = await this.#leaseOperation(() => this.lease.init());
    return {
      initialized: project.initialized,
      project: project.config,
      storage,
      artifacts,
      workspaceArchives,
      lease
    };
  }

  async createGoal({ title, request = title, commandId } = {}) {
    const normalizedTitle = requireTrimmedString(title, 'title');
    const normalizedRequest = requireTrimmedString(request, 'request');
    const normalizedCommandId = this.#commandId(commandId);
    const intentHash = hashCanonicalValue({
      schemaVersion: 1,
      type: 'CreateGoal',
      title: normalizedTitle,
      request: normalizedRequest
    });
    const state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
    if (existing) {
      const event = eventFromBatch(existing, 'GoalCreated');
      return this.#goalResult(state.store, existing, event.payload.goalId, false);
    }

    const goalId = this.#id('goal');
    if (state.projection.goals.some((goal) => goal.id === goalId)) {
      throw new FwaApplicationError(
        `Generated goal id ${goalId} already exists.`,
        'goal-already-exists'
      );
    }
    const event = this.#event({
      type: 'GoalCreated',
      streamId: `goal:${goalId}`,
      sequence: state.store.lastSequence + 1,
      commandId: normalizedCommandId,
      payload: {
        goalId,
        title: normalizedTitle,
        request: normalizedRequest
      },
      streamVersion: 1
    });
    projectEvents([...state.store.events, event]);
    const write = await this.#withLockRetry(() => this.#appendBatch(
      normalizedCommandId,
      [event],
      {
        expectedLastSequence: state.store.lastSequence,
        intentHash
      }
    ));
    const persistedEvent = eventFromBatch(write.batch, 'GoalCreated');
    const resultState = write.appended
      ? state.store
      : await this.#withLockRetry(() => this.store.readAll());
    return this.#goalResult(
      resultState,
      write.batch,
      persistedEvent.payload.goalId,
      write.appended
    );
  }

  async registerRef({ ref, commandId } = {}) {
    const normalizedRef = normalizeRef(ref);
    const normalizedCommandId = this.#commandId(commandId);
    const intentHash = hashCanonicalValue({
      schemaVersion: 1,
      type: 'RegisterRef',
      ref: normalizedRef
    });
    const state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
    if (existing) {
      const event = eventFromBatch(existing, 'RefRegistered');
      const projection = projectEvents(state.store.events);
      return {
        appended: false,
        commandId: normalizedCommandId,
        ref: projection.refs.find((candidate) => candidate.id === event.payload.id)
      };
    }
    if (state.projection.refs.some((candidate) => candidate.id === normalizedRef.id)) {
      throw new FwaApplicationError(
        `Ref ${normalizedRef.id} already exists.`,
        'ref-already-exists'
      );
    }
    const event = this.#event({
      type: 'RefRegistered',
      streamId: `ref:${normalizedRef.id}`,
      sequence: state.store.lastSequence + 1,
      commandId: normalizedCommandId,
      payload: normalizedRef,
      streamVersion: 1
    });
    projectEvents([...state.store.events, event]);
    const write = await this.#withLockRetry(() => this.#appendBatch(
      normalizedCommandId,
      [event],
      { expectedLastSequence: state.store.lastSequence, intentHash }
    ));
    const resultStore = write.appended
      ? { events: [...state.store.events, ...write.batch.events] }
      : await this.#withLockRetry(() => this.store.readAll());
    const projection = projectEvents(resultStore.events);
    return {
      appended: write.appended,
      commandId: write.batch.commandId,
      ref: projection.refs.find((candidate) => candidate.id === normalizedRef.id)
    };
  }

  async loadPlan({ goalId, plan, commandId } = {}) {
    const normalizedGoalId = requireTrimmedString(goalId, 'goalId');
    const normalizedCommandId = this.#commandId(commandId);
    const canonicalPlan = canonicalizePlan(plan);
    if (canonicalPlan.goalId !== undefined && canonicalPlan.goalId !== normalizedGoalId) {
      throw new FwaApplicationError(
        `Plan belongs to ${canonicalPlan.goalId}, not ${normalizedGoalId}.`,
        'plan-goal-mismatch'
      );
    }

    const authoredPlan = { ...canonicalPlan, goalId: normalizedGoalId };
    const intentHash = hashCanonicalValue({
      schemaVersion: 1,
      type: 'LoadPlan',
      goalId: normalizedGoalId,
      plan: authoredPlan
    });
    const state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
    if (existing) {
      const event = eventFromBatch(existing, 'PlanLoaded');
      return this.#planResult(state.store, existing, event.payload.planId, false);
    }

    const knownRefIds = new Set(state.projection.refs.map((ref) => ref.id));
    for (const [nodeIndex, node] of authoredPlan.nodes.entries()) {
      for (const field of ['reads', 'writes']) {
        for (const [valueIndex, value] of node[field].entries()) {
          if (/^ref:\/\//iu.test(value) && !isRefId(value)) {
            throw new FwaApplicationError(
              `Plan has an invalid logical Ref at nodes[${nodeIndex}].${field}[${valueIndex}].`,
              'invalid-plan-ref',
              { value }
            );
          }
          if (isRefId(value) && !knownRefIds.has(value)) {
            throw new FwaApplicationError(
              `Plan references unregistered Ref ${value}.`,
              'plan-ref-not-found',
              { nodeId: node.id, field, refId: value }
            );
          }
        }
      }
    }

    const goal = state.projection.goals.find((candidate) => candidate.id === normalizedGoalId);
    if (!goal) {
      throw new FwaApplicationError(
        `Goal ${normalizedGoalId} does not exist.`,
        'goal-not-found'
      );
    }
    if (goal.status !== GoalStatus.DRAFT) {
      throw new FwaApplicationError(
        `Goal ${normalizedGoalId} is ${goal.status}; a plan can only be loaded while draft.`,
        'goal-not-draft'
      );
    }

    const existingNodeIds = new Set(state.projection.nodes.map((node) => node.id));
    const duplicateNodeIds = authoredPlan.nodes
      .map((node) => node.id)
      .filter((nodeId) => existingNodeIds.has(nodeId));
    if (duplicateNodeIds.length > 0) {
      throw new FwaApplicationError(
        `Node id(s) already exist: ${duplicateNodeIds.join(', ')}.`,
        'node-already-exists',
        { nodeIds: duplicateNodeIds }
      );
    }

    const planId = authoredPlan.id ?? this.#id('plan');
    if (state.projection.goals.some((candidate) => candidate.planId === planId)) {
      throw new FwaApplicationError(
        `Plan id ${planId} already exists.`,
        'plan-already-exists'
      );
    }
    const planHash = `sha256:${hashCanonicalValue(authoredPlan)}`;
    const events = [];
    const firstSequence = state.store.lastSequence + 1;
    const planLoaded = this.#event({
      type: 'PlanLoaded',
      streamId: `goal:${normalizedGoalId}`,
      sequence: firstSequence,
      commandId: normalizedCommandId,
      payload: {
        goalId: normalizedGoalId,
        planId,
        planHash,
        plan: authoredPlan,
        nodeIds: authoredPlan.nodes.map((node) => node.id)
      },
      streamVersion: goal.version + 1
    });
    events.push(planLoaded);

    for (const node of authoredPlan.nodes) {
      events.push(this.#event({
        type: 'NodePlanned',
        streamId: `node:${node.id}`,
        sequence: firstSequence + events.length,
        commandId: normalizedCommandId,
        causationId: planLoaded.eventId,
        payload: {
          goalId: normalizedGoalId,
          planId,
          node
        },
        streamVersion: 1
      }));
    }
    for (const node of authoredPlan.nodes.filter((candidate) => candidate.dependsOn.length === 0)) {
      events.push(this.#event({
        type: 'NodeReady',
        streamId: `node:${node.id}`,
        sequence: firstSequence + events.length,
        commandId: normalizedCommandId,
        causationId: planLoaded.eventId,
        payload: {
          goalId: normalizedGoalId,
          planId,
          nodeId: node.id,
          reason: 'dependencies-satisfied'
        },
        streamVersion: 2
      }));
    }

    projectEvents([...state.store.events, ...events]);

    const write = await this.#withLockRetry(() => this.#appendBatch(
      normalizedCommandId,
      events,
      {
        expectedLastSequence: state.store.lastSequence,
        intentHash
      }
    ));
    const persistedEvent = eventFromBatch(write.batch, 'PlanLoaded');
    const resultState = write.appended
      ? state.store
      : await this.#withLockRetry(() => this.store.readAll());
    return this.#planResult(
      resultState,
      write.batch,
      persistedEvent.payload.planId,
      write.appended
    );
  }

  async submitNodeFeedback({ nodeId, text, commandId } = {}) {
    requireTrimmedString(nodeId, 'nodeId');
    requireTrimmedString(text, 'text');
    if (text.length > INTERACTION_FIELDS.feedback.maxLength) throw new FwaApplicationError(`Feedback exceeds ${INTERACTION_FIELDS.feedback.maxLength} characters.`, 'invalid-command');
    const normalizedCommandId = this.#commandId(commandId);
    const intentHash = hashCanonicalValue({ schemaVersion: 1, type: 'SubmitNodeFeedback', nodeId, text });
    for (let attempt = 0; ; attempt++) {
      const state = await this.#readState();
      const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
      if (existing) {
        const id = eventFromBatch(existing, 'NodeFeedbackSubmitted').payload.feedbackId;
        const feedback = state.projection.nodeFeedback.find(item => item.id === id);
        return { appended: false, commandId: normalizedCommandId, feedback, deferred: feedback.deferredAtSubmission };
      }
      const node = state.projection.nodes.find(item => item.id === nodeId);
      const goal = state.projection.goals.find(item => item.id === node?.goalId);
      if (!node || !goal?.nodeIds.includes(nodeId) || node.supersededByRevision != null) {
        throw new FwaApplicationError('Feedback must target a current leaf Node.', 'node-not-current');
      }
      const deferred = hasActiveProjectOperation(state.projection);
      const feedbackId = this.#id('feedback');
      const event = this.#event({ type: 'NodeFeedbackSubmitted', streamId: `feedback:${feedbackId}`,
        sequence: state.store.lastSequence + 1, streamVersion: 1, commandId: normalizedCommandId,
        payload: { feedbackId, nodeId, goalId: goal.id, logicalId: node.logicalId ?? node.id,
          definitionRevision: node.definitionRevision ?? 1, text, deferredAtSubmission: deferred } });
      const projection = projectEvents([...state.store.events, event]);
      try {
        const write = await this.#withLockRetry(() => this.#appendBatch(normalizedCommandId, [event], {
          expectedLastSequence: state.store.lastSequence, intentHash
        }));
        const current = write.appended ? projection : (await this.#readState()).projection;
        const id = eventFromBatch(write.batch, 'NodeFeedbackSubmitted').payload.feedbackId;
        const feedback = current.nodeFeedback.find(item => item.id === id);
        return { appended: write.appended, commandId: normalizedCommandId,
          feedback, deferred: feedback.deferredAtSubmission };
      } catch (error) {
        if (error.code !== 'concurrency-conflict' || attempt >= this.lockRetryDelays.length) throw error;
      }
    }
  }

  async revisePlan({ goalId, plan, expectedRevision, reason, feedbackIds = [], commandId } = {}) {
    requireTrimmedString(goalId, 'goalId');
    requireTrimmedString(reason, 'reason');
    if (!Array.isArray(feedbackIds) || new Set(feedbackIds).size !== feedbackIds.length
      || feedbackIds.some(id => typeof id !== 'string' || !id || id !== id.trim())) {
      throw new FwaApplicationError('feedbackIds must contain distinct feedback ids.', 'invalid-command');
    }
    const canonicalPlan = canonicalizePlan(plan);
    const normalizedCommandId = this.#commandId(commandId);
    const intentHash = hashCanonicalValue({ schemaVersion: 1, type: 'RevisePlan', goalId,
      plan: canonicalPlan, expectedRevision, reason, feedbackIds });
    const result = (projection, event, appended) => {
      const goal = projection.goals.find(item => item.id === goalId);
      const revision = goal.planHistory.find(item => item.revision === event.payload.revision);
      return { appended, commandId: normalizedCommandId, revision, goal,
        nodes: projection.nodes.filter(item => goal.nodeIds.includes(item.id)),
        nodeBindings: revision.bindings, feedback: projection.nodeFeedback.filter(item => item.goalId === goalId) };
    };
    let state = await this.#readState();
    const existing = recordedBatch(state.store, normalizedCommandId, intentHash);
    if (existing) return result(state.projection, eventFromBatch(existing, 'PlanRevised'), false);
    if (hasActiveProjectOperation(state.projection)) {
      throw new FwaApplicationError('Revision is not applied while a project operation is active. Feedback remains pending.', 'plan-revision-deferred');
    }
    await this.#leaseOperation(() => this.lease.init());
    const reservation = await this.#leaseOperation(() => this.lease.acquire({ runId: this.#id('revision'), ttlMs: 30000 }));
    try {
      state = await this.#readState();
      const replay = recordedBatch(state.store, normalizedCommandId, intentHash);
      if (replay) return result(state.projection, eventFromBatch(replay, 'PlanRevised'), false);
      if (hasActiveProjectOperation(state.projection)) throw new FwaApplicationError('Wait for active operations before applying a revision.', 'plan-revision-deferred');
      const goal = state.projection.goals.find(item => item.id === goalId);
      const prepared = preparePlanRevision(goal, state.projection.nodes, canonicalPlan, expectedRevision);
      for (const { nodeId } of prepared.retiredNodes) {
        const node = state.projection.nodes.find(item => item.id === nodeId);
        if (nodeHasUnsettledWorkspace(node, state.projection)) throw new FwaApplicationError('Settle affected Node workspaces before revising.', 'node-workspace-not-settled');
      }
      const omittedFeedback = state.projection.nodeFeedback.filter(item => item.goalId === goalId && item.status === 'pending'
        && prepared.retiredNodes.some(retired => retired.nodeId === item.nodeId) && !feedbackIds.includes(item.id));
      if (omittedFeedback.length) throw new FwaApplicationError('Explicitly include all pending feedback for each superseded Node.',
        'feedback-revision-incomplete', { feedbackIds: omittedFeedback.map(item => item.id) });
      for (const id of feedbackIds) {
        const feedback = state.projection.nodeFeedback.find(item => item.id === id);
        if (!feedback || feedback.goalId !== goalId || feedback.status !== 'pending'
          || !prepared.retiredNodes.some(item => item.nodeId === feedback.nodeId)) {
          throw new FwaApplicationError('Feedback must be pending and bind an affected current Node.', 'feedback-revision-mismatch');
        }
      }
      const revisionId = `${goal.planId}:revision:${prepared.revision}`;
      const events = [];
      const add = (type, streamId, streamVersion, payload) => {
        const event = this.#event({ type, streamId, streamVersion, payload,
          sequence: state.store.lastSequence + events.length + 1, commandId: normalizedCommandId,
          ...(events[0] ? { causationId: events[0].eventId } : {}) });
        events.push(event); return event;
      };
      const revised = add('PlanRevised', `goal:${goalId}`, goal.version + 1, {
        goalId, planId: goal.planId, revisionId, expectedRevision, revision: prepared.revision,
        plan: prepared.plan, bindings: prepared.bindings, retiredNodes: prepared.retiredNodes, reason, feedbackIds
      });
      for (const retired of prepared.retiredNodes) {
        const node = state.projection.nodes.find(item => item.id === retired.nodeId);
        add('NodeSuperseded', `node:${node.id}`, node.version + 1, { ...retired, goalId, revisionId });
      }
      for (const created of prepared.createdNodes) add('NodePlanned', `node:${created.node.id}`, 1, {
        goalId, planId: goal.planId, ...created
      });
      const allNodes = [...state.projection.nodes, ...prepared.createdNodes.map(item => ({ ...item.node, status: 'planned', validity: 'valid' }))];
      for (const { node } of prepared.createdNodes) {
        const dependenciesReady = node.dependsOn.every(id => {
          const dependency = allNodes.find(item => item.id === id);
          return dependency?.status === 'accepted' && dependency.validity === 'valid'
            && dependency.integrationStatus === 'integrated' && dependency.acceptedChangeSetId != null
            && dependency.acceptedChangeSetId === dependency.integratedChangeSetId
            && goal.integrationTargetRef != null && dependency.integratedTargetRef === goal.integrationTargetRef;
        });
        if (dependenciesReady) add('NodeReady', `node:${node.id}`, 2, { goalId, planId: goal.planId, nodeId: node.id, reason: 'dependencies-satisfied' });
      }
      const projection = projectEvents([...state.store.events, ...events]);
      const write = await this.#withLockRetry(() => this.#appendBatch(normalizedCommandId, events, {
        expectedLastSequence: state.store.lastSequence, intentHash
      }));
      return result(write.appended ? projection : (await this.#readState()).projection,
        write.appended ? revised : eventFromBatch(write.batch, 'PlanRevised'), write.appended);
    } finally {
      await this.#leaseOperation(() => this.lease.release({ leaseId: reservation.lease.leaseId, ownerToken: reservation.ownerToken }));
    }
  }

  async getStatus() {
    const state = await this.#readState();
    const retryDiagnostics = buildRetryDiagnostics(state.projection);
    this.planDiagnosticsCache ??= new Map();
    const planDiagnostics = state.projection.goals.filter(goal => goal.planId != null).map(goal => {
      const plan = currentLogicalPlan(goal, state.projection.nodes);
      const fingerprint = hashCanonicalValue(plan);
      let cached = this.planDiagnosticsCache.get(goal.id);
      if (cached?.fingerprint !== fingerprint) {
        cached = { fingerprint, result: { goalId: goal.id, ...diagnosePlan(plan) } };
        this.planDiagnosticsCache.set(goal.id, cached);
      }
      return structuredClone(cached.result);
    });
    return {
      projectId: state.project.projectId,
      projectRoot: state.project.projectRoot,
      lastSequence: state.store.lastSequence,
      batchCount: state.store.batches.length,
      eventCount: state.store.events.length,
      goals: state.projection.goals,
      refs: state.projection.refs ?? [],
      nodes: state.projection.nodes,
      runs: state.projection.runs,
      changeSets: state.projection.changeSets,
      evaluations: state.projection.evaluations ?? [],
      evidence: state.projection.evidence ?? [],
      integrations: state.projection.integrations ?? [],
      reversions: state.projection.reversions ?? [],
      projectRevisions: state.projection.projectRevisions ?? [],
      runBatches: state.projection.runBatches ?? [],
      retryDiagnostics,
      planDiagnostics,
      workflow: buildWorkflow({ ...state.projection, retryDiagnostics })
    };
  }

  async runNext(options = {}) {
    return this.runOrchestrator.runNext({
      lease: this.lease,
      ...options,
      artifacts: this.artifacts
    });
  }

  async runReadyBatch(options = {}) {
    return this.runOrchestrator.runReadyBatch({ lease: this.lease, ...options, artifacts: this.artifacts });
  }

  async reconcileRunBatch(options = {}) {
    return this.runOrchestrator.reconcileBatch({ lease: this.lease, ...options });
  }

  async archiveRunWorkspace(options = {}) {
    return this.runOrchestrator.archiveRunWorkspace({
      lease: this.lease,
      workspace: options.workspace,
      ...options,
      workspaceArchives: this.workspaceArchives
    });
  }

  async inspectRunSetupWorkspace(options = {}) {
    return this.runOrchestrator.inspectRunSetupWorkspace(options);
  }

  async recoverRunSetupWorkspace(options = {}) {
    return this.runOrchestrator.recoverRunSetupWorkspace({ lease: this.lease, ...options });
  }

  async retryNode({ nodeId, commandId, reason } = {}) {
    const normalizedNodeId = requireTrimmedString(nodeId, 'nodeId');
    const normalizedCommandId = this.#commandId(commandId);
    const normalizedReason = reason === undefined ? null : requireTrimmedString(reason, 'reason');
    const intentHash = hashCanonicalValue({
      schemaVersion: 1, type: 'RetryNode', nodeId: normalizedNodeId, reason: normalizedReason
    });
    const result = (state, batch, appended) => ({
      appended,
      commandId: normalizedCommandId,
      mode: eventFromBatch(batch, 'NodeRetryRequested').payload.mode,
      node: state.projection.nodes.find((item) => item.id === normalizedNodeId)
    });
    const initial = await this.#readState();
    const existing = recordedBatch(initial.store, normalizedCommandId, intentHash);
    if (existing) return result(initial, existing, false);
    await this.#leaseOperation(() => this.lease.init());
    // Reserve the same serial workspace fence used before a Run is persisted.
    // The reservation creates no Run and is always released after this short transaction.
    const reservation = await this.#leaseOperation(() => this.lease.acquire({
      runId: this.#id('retry'), ttlMs: 30_000
    }));
    try {
      for (let attempt = 0; ; attempt += 1) {
        const state = await this.#readState();
        const replay = recordedBatch(state.store, normalizedCommandId, intentHash);
        if (replay) return result(state, replay, false);
        const node = state.projection.nodes.find((item) => item.id === normalizedNodeId);
        const goal = state.projection.goals.find((item) => item.id === node?.goalId);
        if (hasActiveProjectOperation(state.projection)) {
          throw new FwaApplicationError('Reconcile active project operations before retrying.',
            'project-operation-active');
        }
        const eligibility = nodeRetryEligibility(node, state.projection.nodes, goal);
        if (!eligibility.ok) {
          throw new FwaApplicationError(`Node ${normalizedNodeId} cannot retry.`, eligibility.code,
            { nodeId: normalizedNodeId, status: node?.status, validity: node?.validity,
              previousAttempts: node?.runIds.length, maxRetries: node?.budget.maxRetries });
        }
        if (nodeHasUnsettledWorkspace(node, state.projection)) {
          throw new FwaApplicationError('Reconcile node workspaces before retrying.',
            'node-workspace-not-settled');
        }
        // Do not enqueue a retry that the Run admission gate will immediately
        // reject. Historical retry events remain valid and readable.
        const diagnostic = diagnoseNodeRetry(node, state.projection);
        if (['pending-node-feedback', 'logical-node-retry-budget-exhausted'].includes(diagnostic.code)) {
          throw new FwaApplicationError(diagnostic.message, diagnostic.code, diagnostic);
        }
        const event = this.#event({
          type: 'NodeRetryRequested', streamId: `node:${node.id}`,
          sequence: state.store.lastSequence + 1, streamVersion: node.version + 1,
          commandId: normalizedCommandId,
          payload: {
            goalId: node.goalId, planId: node.planId, nodeId: node.id,
            previousRunId: node.runIds.at(-1), mode: eligibility.mode, reason: normalizedReason
          }
        });
        const projection = projectEvents([...state.store.events, event]);
        try {
          const write = await this.#withLockRetry(() => this.#appendBatch(
            normalizedCommandId, [event], { expectedLastSequence: state.store.lastSequence, intentHash }
          ));
          return result(write.appended ? { projection } : await this.#readState(),
            write.batch, write.appended);
        } catch (error) {
          if (error.code !== 'concurrency-conflict' || attempt >= this.lockRetryDelays.length) throw error;
        }
      }
    } finally {
      await this.#leaseOperation(() => this.lease.release({
        leaseId: reservation.lease.leaseId, ownerToken: reservation.ownerToken
      }));
    }
  }

  async reconcileRun(options = {}) {
    const eventLock = await this.store.inspectLock();
    let eventStoreRecovery = { recovered: false, reason: 'event-store-free' };
    if (eventLock.held) {
      if (!eventLock.stale) {
        return {
          ok: true,
          reconciled: false,
          reason: 'event-store-owner-not-dead',
          eventLock
        };
      }
      eventStoreRecovery = await this.store.recoverStaleLock({
        expectedLockId: eventLock.lock.lockId
      });
    }
    const result = await this.runOrchestrator.reconcile({
      lease: this.lease,
      ...options
    });
    return { ...result, eventStoreRecovery };
  }

  async evaluateChangeSet(options = {}) {
    return this.evaluationOrchestrator.evaluateChangeSet({
      lease: this.lease,
      ...options,
      artifacts: this.artifacts
    });
  }

  async reconcileEvaluation(options = {}) {
    const eventLock = await this.store.inspectLock();
    let eventStoreRecovery = { recovered: false, reason: 'event-store-free' };
    if (eventLock.held) {
      if (!eventLock.stale) {
        return {
          ok: true,
          reconciled: false,
          reason: 'event-store-owner-not-dead',
          eventLock
        };
      }
      eventStoreRecovery = await this.store.recoverStaleLock({
        expectedLockId: eventLock.lock.lockId
      });
    }
    const result = await this.evaluationOrchestrator.reconcile({
      lease: this.lease,
      ...options
    });
    return { ...result, eventStoreRecovery };
  }

  async integrateChangeSet(options = {}) {
    return this.integrationOrchestrator.integrateChangeSet({
      lease: this.lease,
      ...options,
      artifacts: this.artifacts
    });
  }

  async integrateChangeSetGated(options = {}) {
    return this.integrationOrchestrator.integrateChangeSetGated({
      lease: this.lease,
      ...options,
      artifacts: this.artifacts
    });
  }

  async revertChangeSet(options = {}) {
    return this.integrationOrchestrator.revertChangeSet({
      lease: this.lease,
      ...options,
      artifacts: this.artifacts
    });
  }

  async reconcileIntegration(options = {}) {
    const eventLock = await this.store.inspectLock();
    let eventStoreRecovery = { recovered: false, reason: 'event-store-free' };
    if (eventLock.held) {
      if (!eventLock.stale) {
        return {
          ok: true,
          reconciled: false,
          reason: 'event-store-owner-not-dead',
          eventLock
        };
      }
      eventStoreRecovery = await this.store.recoverStaleLock({
        expectedLockId: eventLock.lock.lockId
      });
    }
    const result = await this.integrationOrchestrator.reconcile({
      lease: this.lease,
      ...options,
      artifacts: this.artifacts
    });
    return { ...result, eventStoreRecovery };
  }

  async reconcileReversion(options = {}) {
    const eventLock = await this.store.inspectLock();
    let eventStoreRecovery = { recovered: false, reason: 'event-store-free' };
    if (eventLock.held) {
      if (!eventLock.stale) {
        return {
          ok: true,
          reconciled: false,
          reason: 'event-store-owner-not-dead',
          eventLock
        };
      }
      eventStoreRecovery = await this.store.recoverStaleLock({
        expectedLockId: eventLock.lock.lockId
      });
    }
    const result = await this.integrationOrchestrator.reconcileReversion({
      lease: this.lease,
      ...options,
      artifacts: this.artifacts
    });
    return { ...result, eventStoreRecovery };
  }

  async listEvents() {
    const state = await this.#readState();
    return state.store.events;
  }

  async verify({ workspace, integration, candidateWorkspace } = {}) {
    const state = await this.#readState();
    const referencedArtifactDigests = new Set();
    let gitVerifiedChangeSetCount = 0;
    let gitVerifiedIntegrationCount = 0;
    let gitVerifiedReversionCount = 0;
    let gitVerifiedCandidateCount = 0;
    let gitSkippedRevertChangeSetCount = 0;
    if (workspace !== undefined && (workspace === null
      || typeof workspace !== 'object'
      || typeof workspace.verifyChangeSet !== 'function')) {
      throw new FwaApplicationError(
        'workspace must provide verifyChangeSet when supplied.',
        'invalid-verification-port'
      );
    }
    if (integration !== undefined && (integration === null
      || typeof integration !== 'object'
      || typeof integration.verify !== 'function')) {
      throw new FwaApplicationError(
        'integration must provide verify when supplied.',
        'invalid-verification-port'
      );
    }
    if (candidateWorkspace !== undefined && (candidateWorkspace === null
      || typeof candidateWorkspace !== 'object'
      || typeof candidateWorkspace.inspectResidue !== 'function')) {
      throw new FwaApplicationError(
        'candidateWorkspace must provide inspectResidue when supplied.',
        'invalid-verification-port'
      );
    }
    // Failed execution can be retained before capture, so it may have no
    // ChangeSet at all. Follow only the two authored Run failure edges; do not
    // treat arbitrary hashes found in diagnostic output as artifact references.
    for (const run of state.projection.runs) {
      for (const failure of [run.failure, run.failure?.details?.executionFailure]) {
        const ref = failure?.details?.artifactRef;
        if (ref === undefined || ref === null) continue;
        const bytes = await this.artifacts.get(ref);
        // Run diagnostics are canonical JSON with one optional trailing LF,
        // matching the execution evidence writer rather than profile artifacts.
        const canonicalBytes = bytes.at(-1) === 10 ? bytes.subarray(0, -1) : bytes;
        const envelope = parseCanonicalJsonArtifact(canonicalBytes,
          `Run ${run.id} failure artifact`, { runId: run.id });
        const recordedSummary = { code: failure.code, message: failure.message, details: failure.details };
        if (!requireExactObjectFields(envelope, ['schemaVersion', 'runId', 'executor', 'failure'])
          || envelope.schemaVersion !== 1 || envelope.runId !== run.id
          || stableStringify(envelope.executor) !== stableStringify(run.executor)
          || !isPlainObject(envelope.failure)
          || stableStringify(summarizeFailure(envelope.failure, { artifactRef: ref })) !== stableStringify(recordedSummary)) {
          throw new FwaApplicationError(`Run ${run.id} failure artifact does not match its durable failure.`,
            'failure-artifact-binding-mismatch', { runId: run.id, artifactDigest: ref.digest });
        }
        referencedArtifactDigests.add(ref.digest);
      }
    }
    for (const changeSet of state.projection.changeSets) {
      await this.artifacts.verify(changeSet.patchArtifact);
      await this.artifacts.verify(changeSet.executionArtifact);
      referencedArtifactDigests.add(changeSet.patchArtifact.digest);
      referencedArtifactDigests.add(changeSet.executionArtifact.digest);
      if (workspace !== undefined && changeSet.kind !== 'revert') {
        const gitEvidence = await workspace.verifyChangeSet(changeSet);
        const actualPaths = [...new Set(gitEvidence.changes.flatMap((change) => (
          change.previousPath === undefined
            ? [change.path]
            : [change.path, change.previousPath]
        )))].sort((left, right) => left.localeCompare(right));
        if (gitEvidence.patchDigest !== changeSet.patchArtifact.digest
          || stableStringify(gitEvidence.commits) !== stableStringify(changeSet.commits)
          || stableStringify(gitEvidence.changes) !== stableStringify(changeSet.changes)
          || stableStringify(actualPaths) !== stableStringify(changeSet.changedFiles)) {
          throw new FwaApplicationError(
            `Git evidence does not match ChangeSet ${changeSet.id}.`,
            'changeset-git-evidence-mismatch',
            { changeSetId: changeSet.id }
          );
        }
        gitVerifiedChangeSetCount += 1;
      } else if (workspace !== undefined) {
        gitSkippedRevertChangeSetCount += 1;
      }
    }
    const verifyRegressionEvidence = async (record, owner) => {
      if (record === null) return;
      for (const ref of [record.profileArtifact, record.resultArtifact]) {
        await this.artifacts.verify(ref);
        referencedArtifactDigests.add(ref.digest);
      }
      const profileBytes = await this.artifacts.get(record.profileArtifact);
      const normalizedProfile = parseCanonicalJsonArtifact(
        profileBytes,
        `${owner} regression profile artifact`,
        { owner }
      );
      const profileChecksMatch = Array.isArray(normalizedProfile.checks)
        && normalizedProfile.checks.length === record.criteria.length
        && normalizedProfile.checks.every((check, index) => {
          const criterion = record.criteria[index];
          return isPlainObject(check)
            && criterion.id === check.id
            && criterion.kind === check.kind
            && criterion.command?.command === check.command
            && stableStringify(criterion.command?.args) === stableStringify(check.args)
            && criterion.command?.cwd === (check.cwd ?? '.');
        });
      const profileBinding = validateEvidenceAgainstProfile(normalizedProfile, record);
      if (`sha256:${record.profileArtifact.digest}` !== record.profile.sha256
        || normalizedProfile.id !== record.profile.id
        || normalizedProfile.schemaVersion !== record.profile.schemaVersion
        || !profileChecksMatch
        || !profileBinding.ok) {
        throw new FwaApplicationError(
          `${owner} regression profile does not match its Evidence.`,
          'evidence-profile-mismatch',
          { owner, errors: profileBinding.errors }
        );
      }
      const resultBytes = await this.artifacts.get(record.resultArtifact);
      const resultEnvelope = parseCanonicalJsonArtifact(
        resultBytes,
        `${owner} regression result artifact`,
        { owner }
      );
      if (!requireExactObjectFields(resultEnvelope, [
        'candidateRevision',
        'criteria',
        'environmentFingerprint',
        'evaluator',
        'integrationId',
        'kind',
        'policyViolations',
        'profile',
        'result',
        'schemaVersion'
      ])
        || resultEnvelope.schemaVersion !== 1
        || resultEnvelope.kind !== 'integration-regression-result'
        || resultEnvelope.integrationId !== record.integrationId
        || resultEnvelope.candidateRevision !== record.candidateRevision
        || resultEnvelope.result !== record.regressionResult
        || stableStringify(resultEnvelope.evaluator) !== stableStringify(record.evaluator)
        || stableStringify(resultEnvelope.profile) !== stableStringify(record.profile)
        || stableStringify(resultEnvelope.environmentFingerprint)
          !== stableStringify(record.environmentFingerprint)
        || stableStringify(resultEnvelope.criteria) !== stableStringify(record.criteria)
        || stableStringify(resultEnvelope.policyViolations)
          !== stableStringify(record.policyViolations)) {
        throw new FwaApplicationError(
          `${owner} regression result does not match its Evidence.`,
          'evidence-result-artifact-mismatch',
          { owner }
        );
      }
      for (const criterion of record.criteria) {
        for (const ref of [criterion.stdoutArtifact, criterion.stderrArtifact]) {
          await this.artifacts.verify(ref);
          referencedArtifactDigests.add(ref.digest);
        }
        for (const expected of criterion.expectedArtifacts) {
          if (expected.artifact === null) continue;
          await this.artifacts.verify(expected.artifact);
          referencedArtifactDigests.add(expected.artifact.digest);
        }
      }
    };
    const verifyOptionalRecordArtifact = async (record, field) => {
      const ref = record[field];
      if (ref === undefined || ref === null) return;
      await this.artifacts.verify(ref);
      referencedArtifactDigests.add(ref.digest);
    };
    const referenceRegressionProfileHash = (record, owner) => {
      if (record.regressionProfileHash === null) return;
      const match = /^sha256:([a-f0-9]{64})$/u.exec(record.regressionProfileHash);
      if (match === null) {
        throw new FwaApplicationError(
          `${owner} has an invalid durable regression profile hash.`,
          'evidence-profile-mismatch',
          { owner }
        );
      }
      // The regression gate stores stableStringify(normalizedProfile), whose
      // digest is exactly the already-durable regressionProfileHash. That hash
      // is therefore a content-addressed reachability edge even if execution
      // was interrupted before a complete Evidence envelope could be recorded.
      referencedArtifactDigests.add(match[1]);
    };
    const verifyCandidateExecutionArtifact = async (record, expected, owner) => {
      if (record.executionArtifact === undefined || record.executionArtifact === null) return;
      const envelope = parseCanonicalJsonArtifact(
        await this.artifacts.get(record.executionArtifact),
        `${owner} candidate execution artifact`,
        { owner, recordId: record.id }
      );
      if (stableStringify(envelope) !== stableStringify(expected)) {
        throw new FwaApplicationError(
          `${owner} candidate execution artifact does not match its durable record.`,
          'candidate-execution-artifact-mismatch',
          { owner, recordId: record.id }
        );
      }
    };
    for (const record of state.projection.integrations ?? []) {
      referenceRegressionProfileHash(record, `Integration ${record.id}`);
      await verifyOptionalRecordArtifact(record, 'patchArtifact');
      await verifyOptionalRecordArtifact(record, 'executionArtifact');
      if (record.executionArtifact !== null) {
        await verifyCandidateExecutionArtifact(record, {
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
        }, `Integration ${record.id}`);
      }
      await verifyRegressionEvidence(record.regressionEvidence, `Integration ${record.id}`);
    }
    for (const record of state.projection.reversions ?? []) {
      referenceRegressionProfileHash(record, `Reversion ${record.id}`);
      await verifyOptionalRecordArtifact(record, 'patchArtifact');
      await verifyOptionalRecordArtifact(record, 'executionArtifact');
      if (record.executionArtifact !== null) {
        await verifyCandidateExecutionArtifact(record, {
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
        }, `Reversion ${record.id}`);
      }
      await verifyRegressionEvidence(record.regressionEvidence, `Reversion ${record.id}`);
    }
    const evaluationProfiles = new Map();
    for (const evaluation of state.projection.evaluations ?? []) {
      const profileBytes = await this.artifacts.get(evaluation.profileArtifact);
      referencedArtifactDigests.add(evaluation.profileArtifact.digest);
      const profile = parseCanonicalJsonArtifact(
        profileBytes,
        `Evaluation ${evaluation.id} profile artifact`,
        { evaluationId: evaluation.id }
      );
      if (typeof profile.id !== 'string'
        || profile.id.length === 0
        || !Number.isSafeInteger(profile.schemaVersion)
        || profile.schemaVersion < 1
        || !Array.isArray(profile.checks)
        || profile.checks.length === 0
        || profile.checks.some((check) => !isPlainObject(check)
          || typeof check.id !== 'string'
          || check.id.length === 0)
        || stableStringify(profile.checks.map((check) => check.id))
          !== stableStringify(evaluation.requiredCriteria)
        || (evaluation.contractId !== null && profile.id !== evaluation.contractId)
        || evaluation.profileHash !== `sha256:${evaluation.profileArtifact.digest}`) {
        throw new FwaApplicationError(
          `Evaluation ${evaluation.id} profile artifact does not match its durable contract.`,
          'evidence-artifact-invalid',
          { evaluationId: evaluation.id }
        );
      }
      evaluationProfiles.set(evaluation.id, profile);
    }
    for (const evidence of state.projection.evidence ?? []) {
      referencedArtifactDigests.add(evidence.profileArtifact.digest);
      const resultBytes = await this.artifacts.get(evidence.resultArtifact);
      referencedArtifactDigests.add(evidence.resultArtifact.digest);
      const resultEnvelope = parseCanonicalJsonArtifact(
        resultBytes,
        `Evidence ${evidence.id} result artifact`,
        { evidenceId: evidence.id }
      );
      const evaluation = (state.projection.evaluations ?? []).find(
        (candidate) => candidate.id === evidence.evaluationId
      );
      const profile = evaluationProfiles.get(evidence.evaluationId);
      const profileBinding = validateEvidenceAgainstProfile(profile, evidence);
      if (!profileBinding.ok) {
        throw new FwaApplicationError(
          `Evidence ${evidence.id} does not match its normalized evaluation profile.`,
          'evidence-profile-mismatch',
          {
            evidenceId: evidence.id,
            evaluationId: evidence.evaluationId,
            errors: profileBinding.errors
          }
        );
      }
      const expectedProfile = profile && {
        id: profile.id,
        schemaVersion: profile.schemaVersion,
        sha256: evaluation?.profileHash
      };
      const resultArtifactMatches = requireExactObjectFields(resultEnvelope, [
        'criteria',
        'environmentFingerprint',
        'evaluator',
        'policyViolations',
        'profile',
        'result',
        'schemaVersion'
      ])
        && evaluation !== undefined
        && profile !== undefined
        && resultEnvelope.schemaVersion === 1
        && stableStringify(resultEnvelope.evaluator) === stableStringify(evidence.evaluator)
        && stableStringify(resultEnvelope.profile) === stableStringify(expectedProfile)
        && stableStringify(resultEnvelope.environmentFingerprint)
          === stableStringify(evidence.environmentFingerprint)
        && resultEnvelope.result === evidence.result
        && stableStringify(resultEnvelope.criteria) === stableStringify(evidence.criteria)
        && stableStringify(resultEnvelope.policyViolations)
          === stableStringify(evidence.policyViolations)
        && evaluation?.profileArtifact.digest === evidence.profileArtifact.digest;
      if (!resultArtifactMatches) {
        throw new FwaApplicationError(
          `Evidence ${evidence.id} result artifact does not match its projected Evidence.`,
          'evidence-result-artifact-mismatch',
          { evidenceId: evidence.id, evaluationId: evidence.evaluationId }
        );
      }
      for (const criterion of evidence.criteria) {
        for (const ref of [criterion.stdoutArtifact, criterion.stderrArtifact]) {
          await this.artifacts.verify(ref);
          referencedArtifactDigests.add(ref.digest);
        }
        for (const expected of criterion.expectedArtifacts) {
          if (expected.artifact === null) continue;
          await this.artifacts.verify(expected.artifact);
          referencedArtifactDigests.add(expected.artifact.digest);
        }
      }
    }
    const latestProjectRevisionByTarget = new Map();
    for (const projectRevision of state.projection.projectRevisions ?? []) {
      latestProjectRevisionByTarget.set(projectRevision.targetRef, projectRevision);
    }
    const assertGitRecordInspection = ({
      inspection,
      record,
      originField,
      owner,
      code
    }) => {
      const latest = latestProjectRevisionByTarget.get(record.targetRef);
      const isLatest = latest?.[originField] === record.id;
      const observedTargetRevision = inspection?.observedTargetRevision
        ?? inspection?.targetRevision
        ?? null;
      const acceptable = inspection?.containsCandidate === true
        && (isLatest
          ? inspection.disposition === 'applied'
            && observedTargetRevision === latest.revision
          : ['applied', 'advanced'].includes(inspection?.disposition));
      const candidateEffectsMatch = record.patchArtifact === null
        || (inspection?.patchDigest === record.patchArtifact.digest
          && stableStringify(inspection?.changedFiles) === stableStringify(record.changedFiles)
          && stableStringify(inspection?.changes) === stableStringify(record.changes));
      if (!acceptable || !candidateEffectsMatch) {
        throw new FwaApplicationError(
          isLatest
            ? `Git no longer proves ${owner} ${record.id} as the latest exact target revision.`
            : `Git no longer proves historical ${owner} ${record.id} on its target.`,
          code,
          {
            [`${owner.toLowerCase()}Id`]: record.id,
            disposition: inspection?.disposition ?? null,
            observedTargetRevision,
            latestProjectRevision: latest?.revision ?? null,
            isLatest,
            candidateEffectsMatch
          }
        );
      }
    };
    const assertCandidateEffects = ({ inspection, record, owner, code }) => {
      const matches = inspection?.patchDigest === record.patchArtifact.digest
        && stableStringify(inspection?.changedFiles) === stableStringify(record.changedFiles)
        && stableStringify(inspection?.changes) === stableStringify(record.changes);
      if (!matches) {
        throw new FwaApplicationError(
          `Git no longer proves ${owner} ${record.id} candidate effects.`,
          code,
          { recordId: record.id }
        );
      }
    };
    for (const record of state.projection.integrations ?? []) {
      if (integration === undefined) continue;
      let inspection;
      if (record.strategy === 'merge-commit-regression-gated'
        && record.candidateRevision !== null) {
        if (typeof integration.inspectPrepared !== 'function') {
          throw new FwaApplicationError(
            'integration must provide inspectPrepared for merge candidates.',
            'invalid-verification-port'
          );
        }
        inspection = await integration.inspectPrepared({
          integrationId: record.id,
          targetRef: record.targetRef,
          expectedTargetRevision: record.expectedTargetRevision,
          candidateRevision: record.candidateRevision,
          candidateTree: record.candidateTree,
          parents: record.candidateParents,
          patchDigest: record.patchArtifact.digest,
          changedFiles: record.changedFiles,
          changes: record.changes
        });
        assertCandidateEffects({
          inspection,
          record,
          owner: 'Integration',
          code: 'integration-git-evidence-mismatch'
        });
        gitVerifiedCandidateCount += 1;
      } else if (['integrated', 'reverted'].includes(record.status)) {
        inspection = await integration.verify(record);
      } else {
        continue;
      }
      if (['integrated', 'reverted'].includes(record.status)) {
        assertGitRecordInspection({
          inspection,
          record,
          originField: 'integrationId',
          owner: 'Integration',
          code: 'integration-git-evidence-mismatch'
        });
        gitVerifiedIntegrationCount += 1;
      }
    }
    if (integration !== undefined && (state.projection.reversions ?? []).some(
      (record) => record.candidateRevision !== null
    )
      && typeof integration.inspectPrepared !== 'function') {
      throw new FwaApplicationError(
        'integration must provide inspectPrepared for Reversion verification.',
        'invalid-verification-port'
      );
    }
    for (const record of state.projection.reversions ?? []) {
      if (record.candidateRevision === null || integration === undefined) continue;
      const inspection = await integration.inspectPrepared({
        integrationId: record.id,
        targetRef: record.targetRef,
        expectedTargetRevision: record.expectedTargetRevision,
        candidateRevision: record.candidateRevision,
        candidateTree: record.candidateTree,
        parents: record.candidateParents,
        patchDigest: record.patchArtifact.digest,
        changedFiles: record.changedFiles,
        changes: record.changes
      });
      assertCandidateEffects({
        inspection,
        record,
        owner: 'Reversion',
        code: 'reversion-git-evidence-mismatch'
      });
      gitVerifiedCandidateCount += 1;
      if (record.status === 'reverted') {
        assertGitRecordInspection({
          inspection,
          record,
          originField: 'reversionId',
          owner: 'Reversion',
          code: 'reversion-git-evidence-mismatch'
        });
        gitVerifiedReversionCount += 1;
      }
    }
    // A succeeded job publishes its artifact first. Snapshot owners before the
    // inventory, but defer job errors so existing artifact corruption wins.
    const planningJobs = await new WorkbenchJobs(this.projectRoot).list()
      .then(value => ({ value }), error => ({ error }));
    const storedArtifactRefs = await this.artifacts.listRefs();
    if (Object.hasOwn(planningJobs, 'error')) throw planningJobs.error;
    // Planning provenance is owned by durable workbench jobs, not by a Run.
    // Inspect only their authored evidence edge after the existing event/artifact
    // checks; arbitrary hashes and business claims in job results confer nothing.
    for (const job of planningJobs.value) {
      if (job.state !== 'succeeded' || !['workflow.plan', 'workflow.revise'].includes(job.type)) continue;
      const ref = job.result?.evidence;
      const bytes = await this.artifacts.get(ref);
      const details = { commandId: job.commandId, artifactDigest: ref.digest };
      let envelope;
      try {
        const source = bytes.toString('utf8');
        if (!Buffer.from(source, 'utf8').equals(bytes)) throw new TypeError('bytes are not valid UTF-8');
        envelope = JSON.parse(source);
      } catch {
        throw new FwaApplicationError(`Planning evidence for ${job.commandId} is not valid UTF-8 JSON.`,
          'planning-evidence-artifact-invalid', details);
      }
      if (!isPlainObject(envelope) || envelope.schemaVersion !== 1 || envelope.kind !== 'planning-evidence'
        || !isPlainObject(envelope.planner)
        || (Object.hasOwn(envelope, 'projectSnapshot') && !isPlainObject(envelope.projectSnapshot))) {
        throw new FwaApplicationError(`Planning evidence for ${job.commandId} has an invalid envelope.`,
          'planning-evidence-artifact-invalid', details);
      }
      referencedArtifactDigests.add(ref.digest);
    }
    const artifactBytes = storedArtifactRefs.reduce(
      (total, artifact) => total + artifact.size,
      0
    );
    const unreferencedArtifacts = storedArtifactRefs
      .filter((artifact) => !referencedArtifactDigests.has(artifact.digest))
      .map((artifact) => artifact.digest);
    const lease = await this.#leaseOperation(() => this.lease.inspect());
    const activeRuns = state.projection.runs
      .filter((run) => ['pending', 'running', 'paused'].includes(run.status))
      .map((run) => run.id);
    const activeRunBatches = (state.projection.runBatches ?? []).filter(batch => batch.status === 'running').map(batch => batch.id);
    const pendingWorkspaceCleanup = state.projection.runs
      .filter((run) => run.status === 'produced' && run.workspaceStatus !== 'removed')
      .map((run) => run.id);
    const preservedWorkspaces = state.projection.runs
      .filter((run) => run.workspaceStatus === 'preserved')
      .map((run) => run.id);
    const unknownWorkspaces = state.projection.runs
      .filter((run) => run.workspaceStatus === 'setup-unknown')
      .map((run) => run.id);
    const workspaceArchiveErrors = [];
    let workspaceArchives = [];
    try {
      workspaceArchives = await this.workspaceArchives.inspectAll();
    } catch (error) {
      workspaceArchiveErrors.push({
        code: error?.code ?? 'workspace-archive-invalid',
        message: error?.message ?? String(error),
        details: error?.details ?? null
      });
    }
    const archivedRunIds = new Set();
    for (const run of state.projection.runs) {
      if (run.workspaceArchive === null) continue;
      archivedRunIds.add(run.id);
      try {
        const archive = await this.workspaceArchives.verifyRun({ runId: run.id });
        if (archive.archivePath !== run.workspaceArchive.archivePath
          || `sha256:${archive.manifestDigest}` !== run.workspaceArchive.archiveManifestDigest
          || `sha256:${archive.treeDigest}` !== run.workspaceArchive.archiveTreeDigest
          || archive.entries.length !== run.workspaceArchive.archiveEntryCount) {
          throw new FwaApplicationError(
            `Run ${run.id} workspace archive binding does not match its event.`,
            'workspace-archive-binding-mismatch'
          );
        }
      } catch (error) {
        workspaceArchiveErrors.push({
          runId: run.id,
          code: error?.code ?? 'workspace-archive-invalid',
          message: error?.message ?? String(error),
          details: error?.details ?? null
        });
      }
    }
    const unreferencedWorkspaceArchives = workspaceArchives
      .filter((archive) => !archivedRunIds.has(archive.manifest.runId))
      .map((archive) => archive.manifest.runId);
    const activeEvaluations = (state.projection.evaluations ?? [])
      .filter((evaluation) => ['requested', 'running'].includes(evaluation.status))
      .map((evaluation) => evaluation.id);
    const evaluationRecoveryRequired = (state.projection.evaluations ?? [])
      .filter((evaluation) => evaluation.status === 'recovery-required')
      .map((evaluation) => evaluation.id);
    const pendingEvaluationCleanup = (state.projection.evaluations ?? [])
      .filter((evaluation) => ['cleanup-pending', 'cleanup-failed'].includes(
        evaluation.workspaceStatus
      ))
      .map((evaluation) => evaluation.id);
    const preservedEvaluationWorkspaces = (state.projection.evaluations ?? [])
      .filter((evaluation) => evaluation.workspaceStatus === 'preserved')
      .map((evaluation) => evaluation.id);
    const unknownEvaluationWorkspaces = (state.projection.evaluations ?? [])
      .filter((evaluation) => evaluation.workspaceStatus === 'setup-unknown')
      .map((evaluation) => evaluation.id);
    const evaluationWorkspaceResidueSet = new Set();
    const evaluationsDirectory = path.join(this.projectRoot, '.fwa', 'evaluations');
    let evaluationEntries = [];
    try {
      evaluationEntries = await readdir(evaluationsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const entry of evaluationEntries) {
      evaluationWorkspaceResidueSet.add(path.resolve(evaluationsDirectory, entry.name));
    }
    if (workspace !== undefined && typeof workspace.inspectEvaluationResidue === 'function') {
      const residue = await workspace.inspectEvaluationResidue();
      if (!isPlainObject(residue)
        || typeof residue.ok !== 'boolean'
        || !Number.isSafeInteger(residue.count)
        || residue.count < 0
        || !Array.isArray(residue.entries)
        || residue.count !== residue.entries.length
        || residue.entries.some((entry) => !isPlainObject(entry)
          || typeof entry.evaluationId !== 'string'
          || typeof entry.workspacePath !== 'string'
          || entry.registered !== true
          || typeof entry.exists !== 'boolean')) {
        throw new FwaApplicationError(
          'workspace returned an invalid evaluation residue inspection.',
          'invalid-verification-port'
        );
      }
      for (const entry of residue.entries) {
        evaluationWorkspaceResidueSet.add(path.resolve(entry.workspacePath));
      }
    }
    const evaluationWorkspaceResidue = [...evaluationWorkspaceResidueSet]
      .sort((left, right) => left.localeCompare(right));
    const activeIntegrations = (state.projection.integrations ?? [])
      .filter((record) => ['pending', 'running'].includes(record.status))
      .map((record) => record.id);
    const integrationRecoveryRequired = (state.projection.integrations ?? [])
      .filter((record) => record.status === 'recovery-required')
      .map((record) => record.id);
    const activeReversions = (state.projection.reversions ?? [])
      .filter((record) => ['pending', 'running'].includes(record.status))
      .map((record) => record.id);
    const reversionRecoveryRequired = (state.projection.reversions ?? [])
      .filter((record) => record.status === 'recovery-required')
      .map((record) => record.id);
    const integrationRegressionCleanupFailures = (state.projection.integrations ?? [])
      .filter((record) => record.regressionEvidence !== null
        && record.regressionEvidence.cleanup.status !== 'succeeded')
      .map((record) => record.id);
    const reversionRegressionCleanupFailures = (state.projection.reversions ?? [])
      .filter((record) => record.regressionEvidence !== null
        && record.regressionEvidence.cleanup.status !== 'succeeded')
      .map((record) => record.id);
    const candidateWorkspaceResidueSet = new Set();
    const orphanCandidateRefs = [];
    const expectedCandidateRefs = new Map();
    for (const record of [
      ...(state.projection.integrations ?? []),
      ...(state.projection.reversions ?? [])
    ]) {
      if (record.candidateRevision !== null) {
        const candidateRef = `refs/fwa/integrations/${record.id}/candidate`;
        const existing = expectedCandidateRefs.get(candidateRef);
        if (existing !== undefined && existing !== record.candidateRevision) {
          throw new FwaApplicationError(
            `Candidate ref ${candidateRef} has conflicting durable owners.`,
            'candidate-ref-integrity-mismatch',
            { candidateRef, revisions: [existing, record.candidateRevision] }
          );
        }
        expectedCandidateRefs.set(candidateRef, record.candidateRevision);
      }
      if (typeof record.candidateWorkspacePath === 'string'
        && await pathExists(record.candidateWorkspacePath)) {
        candidateWorkspaceResidueSet.add(path.resolve(record.candidateWorkspacePath));
      }
    }
    const integrationsDirectory = path.join(this.projectRoot, '.fwa', 'integrations');
    let integrationEntries = [];
    try {
      integrationEntries = await readdir(integrationsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const entry of integrationEntries) {
      if (!entry.isDirectory()) continue;
      const workspacePath = path.join(integrationsDirectory, entry.name, 'worktree');
      if (await pathExists(workspacePath)) {
        candidateWorkspaceResidueSet.add(path.resolve(workspacePath));
      }
    }
    if (candidateWorkspace !== undefined) {
      const residue = await candidateWorkspace.inspectResidue();
      if (!isPlainObject(residue)
        || typeof residue.ok !== 'boolean'
        || !Number.isSafeInteger(residue.count)
        || residue.count < 0
        || !Array.isArray(residue.entries)
        || residue.count !== residue.entries.length
        || residue.entries.some((entry) => !isPlainObject(entry)
          || typeof entry.integrationId !== 'string'
          || typeof entry.workspacePath !== 'string'
          || entry.registered !== true
          || typeof entry.exists !== 'boolean')
        || !Array.isArray(residue.candidateRefs)
          || !Number.isSafeInteger(residue.candidateRefCount)
          || residue.candidateRefCount < 0
          || residue.candidateRefCount !== residue.candidateRefs.length
          || residue.candidateRefs.some((entry) => !isPlainObject(entry)
            || (entry.integrationId !== null && typeof entry.integrationId !== 'string')
            || typeof entry.candidateRef !== 'string'
            || typeof entry.candidateRevision !== 'string'
            || typeof entry.structurallyValid !== 'boolean')
        ) {
        throw new FwaApplicationError(
          'candidateWorkspace returned an invalid residue inspection.',
          'invalid-verification-port'
        );
      }
      for (const entry of residue.entries) {
        candidateWorkspaceResidueSet.add(path.resolve(entry.workspacePath));
      }
      const observedCandidateRefs = new Map();
      for (const entry of residue.candidateRefs) {
        if (observedCandidateRefs.has(entry.candidateRef)) {
          throw new FwaApplicationError(
            `Candidate ref ${entry.candidateRef} was reported more than once.`,
            'candidate-ref-integrity-mismatch',
            { candidateRef: entry.candidateRef }
          );
        }
        observedCandidateRefs.set(entry.candidateRef, entry);
      }
      for (const [candidateRef, candidateRevision] of expectedCandidateRefs) {
        const observed = observedCandidateRefs.get(candidateRef);
        if (observed === undefined
          || observed.structurallyValid !== true
          || observed.candidateRevision !== candidateRevision) {
          throw new FwaApplicationError(
            `Candidate ref ${candidateRef} no longer matches its durable record.`,
            'candidate-ref-integrity-mismatch',
            {
              candidateRef,
              expectedRevision: candidateRevision,
              observedRevision: observed?.candidateRevision ?? null
            }
          );
        }
      }
      for (const entry of residue.candidateRefs) {
        if (!expectedCandidateRefs.has(entry.candidateRef)) {
          orphanCandidateRefs.push({ ...entry });
        }
      }
    }
    const candidateWorkspaceResidue = [...candidateWorkspaceResidueSet]
      .sort((left, right) => left.localeCompare(right));
    return {
      ok: true,
      operationallyClean: activeRuns.length === 0
        && activeRunBatches.length === 0
        && !lease.held
        && pendingWorkspaceCleanup.length === 0
        && preservedWorkspaces.length === 0
        && unknownWorkspaces.length === 0
        && workspaceArchiveErrors.length === 0
        && unreferencedWorkspaceArchives.length === 0
        && activeEvaluations.length === 0
        && evaluationRecoveryRequired.length === 0
        && pendingEvaluationCleanup.length === 0
        && preservedEvaluationWorkspaces.length === 0
        && unknownEvaluationWorkspaces.length === 0
        && evaluationWorkspaceResidue.length === 0
        && activeIntegrations.length === 0
        && integrationRecoveryRequired.length === 0
        && activeReversions.length === 0
        && reversionRecoveryRequired.length === 0
        && integrationRegressionCleanupFailures.length === 0
        && reversionRegressionCleanupFailures.length === 0
        && candidateWorkspaceResidue.length === 0
        && orphanCandidateRefs.length === 0
        && unreferencedArtifacts.length === 0,
      projectId: state.project.projectId,
      projectRoot: state.project.projectRoot,
      batchCount: state.store.batches.length,
      eventCount: state.store.events.length,
      commandCount: state.store.batches.length,
      lastSequence: state.store.lastSequence,
      lastBatchHash: state.store.lastBatchHash,
      goalCount: state.projection.goals.length,
      nodeCount: state.projection.nodes.length,
      runCount: state.projection.runs.length,
      runBatchCount: (state.projection.runBatches ?? []).length,
      changeSetCount: state.projection.changeSets.length,
      evaluationCount: (state.projection.evaluations ?? []).length,
      evidenceCount: (state.projection.evidence ?? []).length,
      integrationCount: (state.projection.integrations ?? []).length,
      reversionCount: (state.projection.reversions ?? []).length,
      refCount: (state.projection.refs ?? []).length,
      projectRevisionCount: (state.projection.projectRevisions ?? []).length,
      gitVerifiedChangeSetCount,
      gitSkippedRevertChangeSetCount,
      gitVerifiedCandidateCount,
      gitVerifiedIntegrationCount,
      gitVerifiedReversionCount,
      artifactCount: storedArtifactRefs.length,
      artifactBytes,
      referencedArtifactCount: referencedArtifactDigests.size,
      unreferencedArtifacts,
      activeRuns,
      activeRunBatches,
      lease,
      pendingWorkspaceCleanup,
      preservedWorkspaces,
      unknownWorkspaces,
      workspaceArchives: workspaceArchives.map((archive) => ({
        runId: archive.manifest.runId,
        archivePath: archive.archivePath,
        manifestDigest: archive.manifestDigest,
        treeDigest: archive.treeDigest,
        entryCount: archive.entries.length
      })),
      workspaceArchiveErrors,
      unreferencedWorkspaceArchives,
      activeEvaluations,
      evaluationRecoveryRequired,
      pendingEvaluationCleanup,
      preservedEvaluationWorkspaces,
      unknownEvaluationWorkspaces,
      evaluationWorkspaceResidue,
      activeIntegrations,
      integrationRecoveryRequired,
      activeReversions,
      reversionRecoveryRequired,
      integrationRegressionCleanupFailures,
      reversionRegressionCleanupFailures,
      candidateWorkspaceResidue,
      orphanCandidateRefs
    };
  }

  async #readState() {
    return this.#withLockRetry(async () => {
      const project = loadProject(this.projectRoot);
      const store = await this.store.readAll();
      const projection = projectEvents(store.events);
      return { project, store, projection };
    }, { readOnly: true });
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

  async #leaseOperation(operation) {
    try {
      return await operation();
    } catch (error) {
      if (typeof error?.recoveryGuardId !== 'string'
        || typeof this.lease.releaseOwnedGuard !== 'function') {
        throw error;
      }
      try {
        await this.lease.releaseOwnedGuard({ expectedGuardId: error.recoveryGuardId });
      } catch (recoveryError) {
        Object.defineProperty(error, 'guardRecoveryError', {
          value: recoveryError,
          enumerable: false
        });
        throw error;
      }
      if (Object.hasOwn(error, 'recoveryResult')) return error.recoveryResult;
      throw error;
    }
  }

  async #withLockRetry(operation, { readOnly = false } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const transientWindowsOpenRace = error?.code === 'lock-acquire-failed'
          && ['EPERM', 'EACCES', 'EBUSY'].includes(error?.cause?.code)
          && error?.cause?.syscall === 'open';
        // A reader may see a writer's complete or partial lock publication temp
        // before its atomic link. Re-read and re-verify within the existing
        // budget; persistent residue still fails, and writes gain no retries.
        const pendingPublication = readOnly && error?.code === 'orphan-temporary-lock';
        if ((error?.code !== 'event-store-locked' && !transientWindowsOpenRace && !pendingPublication)
          || attempt >= this.lockRetryDelays.length) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, this.lockRetryDelays[attempt]));
      }
    }
  }

  #commandId(value) {
    const commandId = value === undefined
      ? this.#id('command')
      : requireTrimmedString(value, 'commandId');
    if (commandId.startsWith('@fwa/')) {
      throw new FwaApplicationError(
        'commandId prefix @fwa/ is reserved for FWA transactions.',
        'reserved-command-id'
      );
    }
    return commandId;
  }

  #id(prefix) {
    return `${prefix}_${requireTrimmedString(this.idFactory(), `${prefix} id`)}`;
  }

  #event({
    type,
    streamId,
    sequence,
    commandId,
    causationId = null,
    payload,
    streamVersion
  }) {
    return createEvent({
      type,
      streamId,
      sequence,
      occurredAt: this.clock(),
      actor: this.actor,
      correlationId: commandId,
      causationId,
      payload,
      metadata: { streamVersion }
    }, {
      idFactory: () => this.#id('event')
    });
  }

  #goalResult(previousState, batch, goalId, appended) {
    const events = appended
      ? [...previousState.events, ...batch.events]
      : previousState.events;
    const projection = projectEvents(events);
    const goal = projection.goals.find((candidate) => candidate.id === goalId);
    return { appended, commandId: batch.commandId, goal };
  }

  #planResult(previousState, batch, planId, appended) {
    const events = appended
      ? [...previousState.events, ...batch.events]
      : previousState.events;
    const projection = projectEvents(events);
    const goal = projection.goals.find((candidate) => candidate.planId === planId);
    return {
      appended,
      commandId: batch.commandId,
      planId,
      planHash: goal?.planHash,
      goal,
      nodes: goal
        ? projection.nodes.filter((node) => goal.nodeIds.includes(node.id))
        : []
    };
  }
}
