const defineStatuses = (statuses) => Object.freeze(
  Object.fromEntries(statuses.map((status) => [
    status.toUpperCase().replaceAll('-', '_'),
    status
  ]))
);

export const GoalStatus = defineStatuses([
  'draft',
  'planned',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled'
]);

export const NodeStatus = defineStatuses([
  'planned',
  'ready',
  'running',
  'produced',
  'evaluating',
  'accepted',
  'rejected',
  'blocked',
  'failed',
  'cancelled'
]);

export const RunStatus = defineStatuses([
  'pending',
  'running',
  'paused',
  'produced',
  'failed',
  'cancelled'
]);

export const EvaluationStatus = defineStatuses([
  'requested',
  'running',
  'passed',
  'rejected',
  'interrupted',
  'recovery-required'
]);

export const IntegrationStatus = defineStatuses([
  'pending',
  'running',
  'integrated',
  'conflicted',
  'failed',
  'recovery-required',
  'reverting',
  'reverted',
  'cancelled'
]);

export const ReversionStatus = defineStatuses([
  'pending',
  'running',
  'reverted',
  'conflicted',
  'failed',
  'recovery-required',
  'cancelled'
]);

export const Validity = defineStatuses([
  'valid',
  'stale',
  'invalid'
]);

export const ValidityStatus = Validity;

const transitionEntries = {
  goal: {
    [GoalStatus.DRAFT]: [GoalStatus.PLANNED, GoalStatus.CANCELLED],
    [GoalStatus.PLANNED]: [
      GoalStatus.ACTIVE,
      GoalStatus.FAILED,
      GoalStatus.CANCELLED
    ],
    [GoalStatus.ACTIVE]: [
      GoalStatus.PAUSED,
      GoalStatus.COMPLETED,
      GoalStatus.FAILED,
      GoalStatus.CANCELLED
    ],
    [GoalStatus.PAUSED]: [
      GoalStatus.ACTIVE,
      GoalStatus.FAILED,
      GoalStatus.CANCELLED
    ],
    [GoalStatus.COMPLETED]: [GoalStatus.ACTIVE],
    [GoalStatus.FAILED]: [GoalStatus.PLANNED, GoalStatus.CANCELLED],
    [GoalStatus.CANCELLED]: []
  },
  node: {
    [NodeStatus.PLANNED]: [
      NodeStatus.READY,
      NodeStatus.BLOCKED,
      NodeStatus.CANCELLED
    ],
    [NodeStatus.READY]: [
      NodeStatus.RUNNING,
      NodeStatus.BLOCKED,
      NodeStatus.CANCELLED
    ],
    [NodeStatus.RUNNING]: [
      NodeStatus.READY,
      NodeStatus.BLOCKED,
      NodeStatus.PRODUCED,
      NodeStatus.FAILED,
      NodeStatus.CANCELLED
    ],
    [NodeStatus.PRODUCED]: [
      NodeStatus.READY,
      NodeStatus.EVALUATING,
      NodeStatus.FAILED,
      NodeStatus.CANCELLED
    ],
    [NodeStatus.EVALUATING]: [
      NodeStatus.PRODUCED,
      NodeStatus.ACCEPTED,
      NodeStatus.REJECTED,
      NodeStatus.FAILED,
      NodeStatus.CANCELLED
    ],
    [NodeStatus.ACCEPTED]: [NodeStatus.READY],
    [NodeStatus.REJECTED]: [NodeStatus.READY, NodeStatus.CANCELLED],
    [NodeStatus.BLOCKED]: [
      NodeStatus.READY,
      NodeStatus.FAILED,
      NodeStatus.CANCELLED
    ],
    [NodeStatus.FAILED]: [NodeStatus.READY, NodeStatus.CANCELLED],
    [NodeStatus.CANCELLED]: []
  },
  run: {
    [RunStatus.PENDING]: [
      RunStatus.RUNNING,
      RunStatus.FAILED,
      RunStatus.CANCELLED
    ],
    [RunStatus.RUNNING]: [
      RunStatus.PAUSED,
      RunStatus.PRODUCED,
      RunStatus.FAILED,
      RunStatus.CANCELLED
    ],
    [RunStatus.PAUSED]: [
      RunStatus.RUNNING,
      RunStatus.FAILED,
      RunStatus.CANCELLED
    ],
    [RunStatus.PRODUCED]: [],
    [RunStatus.FAILED]: [],
    [RunStatus.CANCELLED]: []
  },
  evaluation: {
    [EvaluationStatus.REQUESTED]: [
      EvaluationStatus.RUNNING,
      EvaluationStatus.INTERRUPTED
    ],
    [EvaluationStatus.RUNNING]: [
      EvaluationStatus.PASSED,
      EvaluationStatus.REJECTED,
      EvaluationStatus.INTERRUPTED,
      EvaluationStatus.RECOVERY_REQUIRED
    ],
    [EvaluationStatus.PASSED]: [],
    [EvaluationStatus.REJECTED]: [],
    [EvaluationStatus.INTERRUPTED]: [],
    [EvaluationStatus.RECOVERY_REQUIRED]: []
  },
  integration: {
    [IntegrationStatus.PENDING]: [
      IntegrationStatus.RUNNING,
      IntegrationStatus.CONFLICTED,
      IntegrationStatus.FAILED,
      IntegrationStatus.CANCELLED
    ],
    [IntegrationStatus.RUNNING]: [
      IntegrationStatus.INTEGRATED,
      IntegrationStatus.CONFLICTED,
      IntegrationStatus.FAILED,
      IntegrationStatus.RECOVERY_REQUIRED
    ],
    [IntegrationStatus.INTEGRATED]: [IntegrationStatus.REVERTING],
    [IntegrationStatus.CONFLICTED]: [IntegrationStatus.CANCELLED],
    [IntegrationStatus.FAILED]: [IntegrationStatus.CANCELLED],
    [IntegrationStatus.RECOVERY_REQUIRED]: [
      IntegrationStatus.INTEGRATED,
      IntegrationStatus.FAILED
    ],
    [IntegrationStatus.REVERTING]: [
      IntegrationStatus.REVERTED,
      IntegrationStatus.FAILED
    ],
    [IntegrationStatus.REVERTED]: [],
    [IntegrationStatus.CANCELLED]: []
  },
  reversion: {
    [ReversionStatus.PENDING]: [
      ReversionStatus.RUNNING,
      ReversionStatus.FAILED,
      ReversionStatus.CANCELLED
    ],
    [ReversionStatus.RUNNING]: [
      ReversionStatus.REVERTED,
      ReversionStatus.CONFLICTED,
      ReversionStatus.FAILED,
      ReversionStatus.RECOVERY_REQUIRED
    ],
    [ReversionStatus.RECOVERY_REQUIRED]: [
      ReversionStatus.REVERTED,
      ReversionStatus.FAILED
    ],
    [ReversionStatus.REVERTED]: [],
    [ReversionStatus.CONFLICTED]: [ReversionStatus.CANCELLED],
    [ReversionStatus.FAILED]: [ReversionStatus.CANCELLED],
    [ReversionStatus.CANCELLED]: []
  },
  validity: {
    [Validity.VALID]: [Validity.STALE, Validity.INVALID],
    [Validity.STALE]: [Validity.VALID, Validity.INVALID],
    [Validity.INVALID]: [Validity.VALID]
  }
};

const machines = Object.freeze(Object.fromEntries(
  Object.entries(transitionEntries).map(([kind, transitions]) => [
    kind,
    Object.freeze(Object.fromEntries(
      Object.entries(transitions).map(([status, targets]) => [
        status,
        Object.freeze([...targets])
      ])
    ))
  ])
));

export const StateMachineKind = Object.freeze({
  GOAL: 'goal',
  NODE: 'node',
  RUN: 'run',
  EVALUATION: 'evaluation',
  INTEGRATION: 'integration',
  REVERSION: 'reversion',
  VALIDITY: 'validity'
});

export class StateTransitionError extends Error {
  constructor(kind, from, to, reason) {
    super(`Cannot transition ${kind} from "${from}" to "${to}": ${reason}.`);
    this.name = 'StateTransitionError';
    this.code = 'FWA_INVALID_STATE_TRANSITION';
    this.kind = kind;
    this.from = from;
    this.to = to;
  }
}

function getMachine(kind) {
  const machine = machines[kind];
  if (!machine) {
    throw new TypeError(`Unknown state machine kind: ${String(kind)}.`);
  }
  return machine;
}

export function allowedTransitions(kind, from) {
  const machine = getMachine(kind);
  const transitions = machine[from];
  if (!transitions) {
    throw new StateTransitionError(kind, from, undefined, 'unknown source state');
  }
  return [...transitions];
}

export function canTransition(kind, from, to) {
  const machine = getMachine(kind);
  return Object.hasOwn(machine, from) && machine[from].includes(to);
}

export function transitionStatus(kind, from, to) {
  const machine = getMachine(kind);
  if (!Object.hasOwn(machine, from)) {
    throw new StateTransitionError(kind, from, to, 'unknown source state');
  }
  if (!Object.hasOwn(machine, to)) {
    throw new StateTransitionError(kind, from, to, 'unknown target state');
  }
  if (!machine[from].includes(to)) {
    throw new StateTransitionError(kind, from, to, 'transition is not allowed');
  }
  return to;
}

export const canTransitionGoal = (from, to) => canTransition('goal', from, to);
export const canTransitionNode = (from, to) => canTransition('node', from, to);
export const canTransitionRun = (from, to) => canTransition('run', from, to);
export const canTransitionEvaluation = (from, to) => (
  canTransition('evaluation', from, to)
);
export const canTransitionIntegration = (from, to) => (
  canTransition('integration', from, to)
);
export const canTransitionReversion = (from, to) => (
  canTransition('reversion', from, to)
);
export const canTransitionValidity = (from, to) => (
  canTransition('validity', from, to)
);

export const transitionGoal = (from, to) => transitionStatus('goal', from, to);
export const transitionNode = (from, to) => transitionStatus('node', from, to);
export const transitionRun = (from, to) => transitionStatus('run', from, to);
export const transitionEvaluation = (from, to) => (
  transitionStatus('evaluation', from, to)
);
export const transitionIntegration = (from, to) => (
  transitionStatus('integration', from, to)
);
export const transitionReversion = (from, to) => (
  transitionStatus('reversion', from, to)
);
export const transitionValidity = (from, to) => (
  transitionStatus('validity', from, to)
);
