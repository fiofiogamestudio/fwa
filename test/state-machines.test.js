import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEvent,
  eventHash,
  stableStringify,
  verifyEventHash
} from '../src/core/events.js';
import {
  GoalStatus,
  EvaluationStatus,
  IntegrationStatus,
  NodeStatus,
  RunStatus,
  StateTransitionError,
  Validity,
  allowedTransitions,
  canTransitionNode,
  transitionGoal,
  transitionEvaluation,
  transitionIntegration,
  transitionNode,
  transitionRun,
  transitionValidity
} from '../src/core/state-machines.js';

test('goal state supports planning, pause/resume, recovery, and completion', () => {
  assert.equal(transitionGoal(GoalStatus.DRAFT, GoalStatus.PLANNED), 'planned');
  assert.equal(transitionGoal(GoalStatus.PLANNED, GoalStatus.ACTIVE), 'active');
  assert.equal(transitionGoal(GoalStatus.ACTIVE, GoalStatus.PAUSED), 'paused');
  assert.equal(transitionGoal(GoalStatus.PAUSED, GoalStatus.ACTIVE), 'active');
  assert.equal(transitionGoal(GoalStatus.ACTIVE, GoalStatus.COMPLETED), 'completed');
  assert.equal(transitionGoal(GoalStatus.FAILED, GoalStatus.PLANNED), 'planned');
});

test('node acceptance is separate from integration', () => {
  const accepted = transitionNode(NodeStatus.EVALUATING, NodeStatus.ACCEPTED);
  assert.equal(accepted, 'accepted');
  assert.equal(NodeStatus.INTEGRATED, undefined);

  const integrating = transitionIntegration(
    IntegrationStatus.PENDING,
    IntegrationStatus.RUNNING
  );
  assert.equal(integrating, 'running');
  assert.equal(
    transitionIntegration(integrating, IntegrationStatus.INTEGRATED),
    'integrated'
  );
});

test('evaluation state separates execution, evidence outcome, interruption, and recovery', () => {
  assert.equal(
    transitionEvaluation(EvaluationStatus.REQUESTED, EvaluationStatus.RUNNING),
    EvaluationStatus.RUNNING
  );
  assert.equal(
    transitionEvaluation(EvaluationStatus.RUNNING, EvaluationStatus.PASSED),
    EvaluationStatus.PASSED
  );
  assert.equal(
    transitionEvaluation(EvaluationStatus.RUNNING, EvaluationStatus.REJECTED),
    EvaluationStatus.REJECTED
  );
  assert.equal(
    transitionEvaluation(EvaluationStatus.REQUESTED, EvaluationStatus.INTERRUPTED),
    EvaluationStatus.INTERRUPTED
  );
  assert.equal(
    transitionEvaluation(EvaluationStatus.RUNNING, EvaluationStatus.INTERRUPTED),
    EvaluationStatus.INTERRUPTED
  );
  assert.equal(
    transitionEvaluation(
      EvaluationStatus.RUNNING,
      EvaluationStatus.RECOVERY_REQUIRED
    ),
    EvaluationStatus.RECOVERY_REQUIRED
  );

  for (const terminal of [
    EvaluationStatus.PASSED,
    EvaluationStatus.REJECTED,
    EvaluationStatus.INTERRUPTED,
    EvaluationStatus.RECOVERY_REQUIRED
  ]) {
    assert.throws(
      () => transitionEvaluation(terminal, EvaluationStatus.RUNNING),
      StateTransitionError
    );
  }
});

test('an interrupted running evaluation can defer its node without losing output', () => {
  assert.equal(
    transitionNode(NodeStatus.EVALUATING, NodeStatus.PRODUCED),
    NodeStatus.PRODUCED
  );
});

test('an accepted but stale node can be queued for recomputation', () => {
  assert.equal(
    transitionValidity(Validity.VALID, Validity.STALE),
    Validity.STALE
  );
  assert.equal(transitionNode(NodeStatus.ACCEPTED, NodeStatus.READY), 'ready');
});

test('run terminal states cannot be rewritten for a retry', () => {
  assert.equal(transitionRun(RunStatus.PENDING, RunStatus.FAILED), 'failed');
  assert.equal(transitionRun(RunStatus.PENDING, RunStatus.RUNNING), 'running');
  assert.equal(transitionRun(RunStatus.RUNNING, RunStatus.PRODUCED), 'produced');
  assert.throws(
    () => transitionRun(RunStatus.PRODUCED, RunStatus.RUNNING),
    StateTransitionError
  );
  assert.throws(
    () => transitionRun(RunStatus.FAILED, RunStatus.RUNNING),
    StateTransitionError
  );
});

test('pause is a Run concern and Node cancellation is an explicit policy choice', () => {
  assert.equal(transitionRun(RunStatus.RUNNING, RunStatus.PAUSED), 'paused');
  assert.equal(NodeStatus.PAUSED, undefined);
  assert.equal(transitionNode(NodeStatus.RUNNING, NodeStatus.READY), 'ready');
  assert.equal(transitionNode(NodeStatus.RUNNING, NodeStatus.BLOCKED), 'blocked');
  assert.equal(transitionNode(NodeStatus.RUNNING, NodeStatus.CANCELLED), 'cancelled');
});

test('integration failure is terminal for one attempt and revert keeps node status separate', () => {
  assert.equal(
    transitionIntegration(IntegrationStatus.PENDING, IntegrationStatus.FAILED),
    'failed'
  );
  assert.equal(
    transitionIntegration(IntegrationStatus.RUNNING, IntegrationStatus.FAILED),
    'failed'
  );
  assert.throws(
    () => transitionIntegration(IntegrationStatus.FAILED, IntegrationStatus.RUNNING),
    StateTransitionError
  );
  assert.throws(
    () => transitionIntegration(
      IntegrationStatus.RUNNING,
      IntegrationStatus.CANCELLED
    ),
    StateTransitionError
  );
  assert.equal(
    transitionIntegration(IntegrationStatus.INTEGRATED, IntegrationStatus.REVERTING),
    'reverting'
  );
  assert.equal(
    transitionIntegration(IntegrationStatus.REVERTING, IntegrationStatus.REVERTED),
    'reverted'
  );
});

test('ambiguous integration promotion requires recovery before a terminal verdict', () => {
  const recovery = transitionIntegration(
    IntegrationStatus.RUNNING,
    IntegrationStatus.RECOVERY_REQUIRED
  );
  assert.equal(recovery, 'recovery-required');
  assert.equal(
    transitionIntegration(recovery, IntegrationStatus.INTEGRATED),
    'integrated'
  );
  assert.equal(
    transitionIntegration(recovery, IntegrationStatus.FAILED),
    'failed'
  );
  assert.throws(
    () => transitionIntegration(recovery, IntegrationStatus.RUNNING),
    StateTransitionError
  );
});

test('illegal, repeated, and unknown transitions fail closed', () => {
  assert.equal(canTransitionNode(NodeStatus.READY, NodeStatus.RUNNING), true);
  assert.equal(canTransitionNode(NodeStatus.READY, NodeStatus.ACCEPTED), false);
  assert.equal(canTransitionNode(NodeStatus.READY, NodeStatus.READY), false);

  assert.throws(
    () => transitionNode(NodeStatus.READY, NodeStatus.ACCEPTED),
    (error) => error instanceof StateTransitionError
      && error.code === 'FWA_INVALID_STATE_TRANSITION'
  );
  assert.throws(
    () => transitionNode('mystery', NodeStatus.READY),
    /unknown source state/
  );
  assert.throws(
    () => transitionNode(NodeStatus.READY, 'mystery'),
    /unknown target state/
  );
});

test('allowedTransitions returns a defensive copy', () => {
  const transitions = allowedTransitions('node', NodeStatus.PLANNED);
  transitions.push('invented');

  assert.deepEqual(
    allowedTransitions('node', NodeStatus.PLANNED),
    [NodeStatus.READY, NodeStatus.BLOCKED, NodeStatus.CANCELLED]
  );
});

test('stable event serialization ignores object key insertion order', () => {
  assert.equal(
    stableStringify({ z: 1, nested: { b: 2, a: 1 } }),
    stableStringify({ nested: { a: 1, b: 2 }, z: 1 })
  );
});

test('createEvent produces an immutable, self-verifying envelope', () => {
  const event = createEvent({
    type: 'GoalCreated',
    streamId: 'goal:G-1',
    sequence: 1,
    payload: { goalId: 'G-1', title: 'Build a feature' },
    metadata: { source: 'test' }
  }, {
    clock: () => new Date('2026-09-05T00:00:00.000Z'),
    idFactory: () => 'E-1'
  });

  assert.deepEqual(event, {
    schemaVersion: 1,
    eventId: 'E-1',
    type: 'GoalCreated',
    streamId: 'goal:G-1',
    sequence: 1,
    occurredAt: '2026-09-05T00:00:00.000Z',
    actor: 'system',
    correlationId: 'E-1',
    causationId: null,
    payload: { goalId: 'G-1', title: 'Build a feature' },
    metadata: { source: 'test' },
    hash: eventHash(event)
  });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(verifyEventHash(event), true);
});

test('event verification detects changed content and invalid input fails closed', () => {
  const event = createEvent({
    type: 'NodeReady',
    streamId: 'node:N-1',
    sequence: 2,
    payload: { nodeId: 'N-1' }
  }, {
    clock: () => '2026-09-05T00:00:00Z',
    idFactory: () => 'E-2'
  });
  const changed = {
    ...event,
    payload: { nodeId: 'N-2' }
  };

  assert.equal(verifyEventHash(changed), false);
  assert.equal(verifyEventHash({}), false);
  assert.throws(
    () => createEvent({ type: 'NodeReady', streamId: 'node:N-1', sequence: 0 }),
    /positive safe integer/
  );
  assert.throws(
    () => stableStringify({ value: Number.NaN }),
    /non-finite number/
  );
  assert.throws(
    () => stableStringify(Array(1)),
    /non-JSON value/
  );
});
