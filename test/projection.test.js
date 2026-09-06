import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvent, eventHash } from '../src/core/events.js';
import { ProjectionError, projectEvents } from '../src/application/projection.js';

function event(sequence, type, streamId, streamVersion, payload) {
  return createEvent({
    type,
    streamId,
    sequence,
    occurredAt: '2026-09-05T00:00:00.000Z',
    payload,
    metadata: { streamVersion }
  }, { idFactory: () => `event-${sequence}` });
}

function planPrefix() {
  return [
    event(1, 'GoalCreated', 'goal:g', 1, {
      goalId: 'g',
      title: 'Goal',
      request: 'Request'
    }),
    event(2, 'PlanLoaded', 'goal:g', 2, {
      goalId: 'g',
      planId: 'p',
      planHash: `sha256:${'a'.repeat(64)}`,
      nodeIds: ['a', 'b']
    })
  ];
}

function nodePayload(
  id,
  dependsOn = [],
  acceptance = { checks: ['passes'] }
) {
  return {
    id,
    dependsOn,
    reads: [],
    writes: [`out/${id}`],
    capabilities: ['script'],
    acceptance,
    budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 100 }
  };
}

const BASE_OID = '1'.repeat(40);
const HEAD_OID = '2'.repeat(40);
const CANDIDATE_OID = 'a'.repeat(40);
const CANDIDATE_TREE = 'b'.repeat(40);
const EXTERNAL_BASE_OID = 'c'.repeat(40);
const SECOND_HEAD_OID = 'd'.repeat(40);
const TARGET_REF = 'refs/heads/main';
const OTHER_TARGET_REF = 'refs/heads/release';
const ARTIFACT = Object.freeze({
  schemaVersion: 1,
  algorithm: 'sha256',
  digest: '3'.repeat(64),
  size: 12
});

function artifact(digestCharacter, size = 12) {
  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    digest: digestCharacter.repeat(64),
    size
  };
}

const PROFILE_ARTIFACT = Object.freeze(artifact('5', 24));
const RESULT_ARTIFACT = Object.freeze(artifact('6', 32));
const STDOUT_ARTIFACT = Object.freeze(artifact('7', 8));
const STDERR_ARTIFACT = Object.freeze(artifact('8', 0));
const EXPECTED_ARTIFACT = Object.freeze(artifact('9', 16));

function runnablePrefix(acceptance = undefined) {
  const prefix = planPrefix();
  return [
    ...prefix,
    event(3, 'NodePlanned', 'node:a', 1, {
      goalId: 'g', planId: 'p', node: nodePayload('a', [], acceptance)
    }),
    event(4, 'NodePlanned', 'node:b', 1, {
      goalId: 'g', planId: 'p', node: nodePayload('b', ['a'])
    }),
    event(5, 'NodeReady', 'node:a', 2, {
      goalId: 'g', planId: 'p', nodeId: 'a', reason: 'dependencies-satisfied'
    }),
    event(6, 'RunCreated', 'run:r1', 1, {
      runId: 'r1',
      nodeId: 'a',
      goalId: 'g',
      planId: 'p',
      executor: { id: 'file-operations', version: '1' },
      requestedBaseRevision: 'HEAD',
      baseRevision: BASE_OID,
      inputHash: `sha256:${'4'.repeat(64)}`,
      workspaceRelativePath: '.fwa/worktrees/r1'
    })
  ];
}

function runningPrefix(acceptance = undefined) {
  return [
    ...runnablePrefix(acceptance),
    event(7, 'GoalActivated', 'goal:g', 3, {
      goalId: 'g', nodeId: 'a', runId: 'r1'
    }),
    event(8, 'NodeStarted', 'node:a', 3, {
      goalId: 'g', nodeId: 'a', runId: 'r1'
    }),
    event(9, 'RunStarted', 'run:r1', 2, {
      goalId: 'g',
      nodeId: 'a',
      runId: 'r1',
      workspacePath: 'C:/work/.fwa/worktrees/r1',
      leaseId: '11111111-1111-4111-8111-111111111111'
    })
  ];
}

function changeSetEvent(sequence = 10, overrides = {}) {
  return event(sequence, 'ChangeSetCaptured', `changeset:${overrides.changeSetId ?? 'c1'}`, 1, {
    changeSetId: 'c1',
    runId: 'r1',
    nodeId: 'a',
    goalId: 'g',
    baseRevision: BASE_OID,
    headRevision: HEAD_OID,
    commits: [HEAD_OID],
    changedFiles: ['out/a'],
    changes: [{ status: 'added', code: 'A', path: 'out/a' }],
    ref: 'refs/heads/fwa/runs/r1',
    branch: 'fwa/runs/r1',
    valid: true,
    violations: [],
    stats: { fileCount: 1, diffLines: 1, durationMs: 2 },
    patchArtifact: ARTIFACT,
    executionArtifact: ARTIFACT,
    ...overrides
  });
}

function producedPrefix(acceptance = undefined) {
  return [
    ...runningPrefix(acceptance),
    changeSetEvent(),
    event(11, 'RunProduced', 'run:r1', 3, {
      runId: 'r1', nodeId: 'a', changeSetId: 'c1', summary: 'Produced one file.'
    }),
    event(12, 'NodeProduced', 'node:a', 4, {
      nodeId: 'a', runId: 'r1', changeSetId: 'c1'
    }),
    event(13, 'RunWorkspaceRemoved', 'run:r1', 4, {
      runId: 'r1',
      workspacePath: 'C:/work/.fwa/worktrees/r1',
      reason: 'removed'
    })
  ];
}

function evaluationRequested(sequence = 14, overrides = {}) {
  return event(
    sequence,
    'EvaluationRequested',
    `evaluation:${overrides.evaluationId ?? 'e1'}`,
    1,
    {
      evaluationId: 'e1',
      nodeId: 'a',
      runId: 'r1',
      changeSetId: 'c1',
      headRevision: HEAD_OID,
      evaluator: { id: 'command-evaluator', version: '1' },
      profileHash: `sha256:${PROFILE_ARTIFACT.digest}`,
      profileArtifact: PROFILE_ARTIFACT,
      contractId: null,
      requiredCriteria: ['passes'],
      workspaceRelativePath: '.fwa/evaluations/e1',
      ...overrides
    }
  );
}

function evaluationRunningPrefix({ acceptance = undefined, requestOverrides = {} } = {}) {
  return [
    ...producedPrefix(acceptance),
    evaluationRequested(14, requestOverrides),
    event(15, 'EvaluationExecutionStarted', 'evaluation:e1', 2, {
      evaluationId: 'e1',
      workspacePath: 'C:/work/.fwa/evaluations/e1',
      leaseId: '22222222-2222-4222-8222-222222222222',
      headRevision: HEAD_OID
    }),
    event(16, 'NodeEvaluationStarted', 'node:a', 5, {
      nodeId: 'a', evaluationId: 'e1', runId: 'r1', changeSetId: 'c1'
    })
  ];
}

function criterion(overrides = {}) {
  return {
    id: 'passes',
    kind: 'command',
    result: 'pass',
    command: { command: 'node', args: ['--test'], cwd: '.' },
    exitCode: 0,
    signal: null,
    timedOut: false,
    terminationConfirmed: true,
    durationMs: 4,
    stdoutArtifact: STDOUT_ARTIFACT,
    stderrArtifact: STDERR_ARTIFACT,
    expectedArtifacts: [{
      path: 'out/a',
      size: EXPECTED_ARTIFACT.size,
      digest: EXPECTED_ARTIFACT.digest,
      artifact: EXPECTED_ARTIFACT,
      failure: null
    }],
    failure: null,
    ...overrides
  };
}

function evidenceRecorded(sequence = 17, overrides = {}) {
  return event(
    sequence,
    'EvidenceRecorded',
    `evidence:${overrides.evidenceId ?? 'v1'}`,
    1,
    {
      evidenceId: 'v1',
      evaluationId: 'e1',
      nodeId: 'a',
      runId: 'r1',
      changeSetId: 'c1',
      headRevision: HEAD_OID,
      kind: 'command-evaluation',
      result: 'pass',
      evaluator: { id: 'command-evaluator', version: '1' },
      profileArtifact: PROFILE_ARTIFACT,
      resultArtifact: RESULT_ARTIFACT,
      environmentFingerprint: {
        platform: 'win32',
        arch: 'x64',
        runtime: { name: 'node', version: 'v24.0.0' },
        environmentSha256: `sha256:${'a'.repeat(64)}`
      },
      criteria: [criterion()],
      policyViolations: [],
      ...overrides
    }
  );
}

function acceptedEvaluationPrefix() {
  return [
    ...evaluationRunningPrefix(),
    evidenceRecorded(),
    event(18, 'EvaluationPassed', 'evaluation:e1', 3, {
      evaluationId: 'e1',
      evidenceId: 'v1',
      nodeId: 'a',
      runId: 'r1',
      changeSetId: 'c1'
    }),
    event(19, 'NodeAccepted', 'node:a', 6, {
      nodeId: 'a',
      evaluationId: 'e1',
      evidenceId: 'v1',
      runId: 'r1',
      changeSetId: 'c1'
    })
  ];
}

function integrationRequested(sequence = 20, overrides = {}) {
  return event(
    sequence,
    'IntegrationRequested',
    `integration:${overrides.integrationId ?? 'i1'}`,
    1,
    {
      integrationId: 'i1',
      nodeId: 'a',
      runId: 'r1',
      changeSetId: 'c1',
      evaluationId: 'e1',
      evidenceId: 'v1',
      baseRevision: BASE_OID,
      headRevision: HEAD_OID,
      targetRef: TARGET_REF,
      expectedTargetRevision: BASE_OID,
      strategy: 'exact-base-single-commit',
      ...overrides
    }
  );
}

function integrationRequestedPrefix() {
  return [
    ...acceptedEvaluationPrefix(),
    integrationRequested(),
    event(21, 'NodeIntegrationRequested', 'node:a', 7, {
      integrationId: 'i1', nodeId: 'a', changeSetId: 'c1'
    })
  ];
}

function integrationRunningPrefix() {
  return [
    ...integrationRequestedPrefix(),
    event(22, 'IntegrationExecutionStarted', 'integration:i1', 2, {
      integrationId: 'i1',
      leaseId: '33333333-3333-4333-8333-333333333333'
    }),
    event(23, 'NodeIntegrationStarted', 'node:a', 8, {
      integrationId: 'i1', nodeId: 'a', changeSetId: 'c1'
    })
  ];
}

function integrationPreparedPrefix() {
  return [
    ...integrationRunningPrefix(),
    event(24, 'IntegrationPrepared', 'integration:i1', 3, {
      integrationId: 'i1',
      candidateRevision: CANDIDATE_OID,
      candidateTree: CANDIDATE_TREE
    })
  ];
}

function integratedFirstNodePrefix() {
  return [
    ...integrationPreparedPrefix(),
    event(25, 'ProjectRevisionAdvanced', `project-revision:${TARGET_REF}`, 1, {
      integrationId: 'i1',
      targetRef: TARGET_REF,
      previousRevision: BASE_OID,
      revision: CANDIDATE_OID
    }),
    event(26, 'IntegrationApplied', 'integration:i1', 4, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      targetRef: TARGET_REF,
      previousRevision: BASE_OID,
      integratedRevision: CANDIDATE_OID,
      candidateTree: CANDIDATE_TREE
    }),
    event(27, 'NodeIntegrated', 'node:a', 9, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      targetRef: TARGET_REF,
      integratedRevision: CANDIDATE_OID
    }),
    event(28, 'NodeReady', 'node:b', 2, {
      goalId: 'g', planId: 'p', nodeId: 'b', reason: 'dependencies-satisfied'
    }),
    event(29, 'IntegrationEffectsApplied', 'integration:i1', 5, {
      integrationId: 'i1',
      affectedNodeIds: [],
      recomputeRootNodeIds: [],
      reopenedGoalIds: [],
      advancedRefIds: []
    })
  ];
}

function acceptedSecondNodeAfterExternalAdvancePrefix() {
  return [
    ...integratedFirstNodePrefix(),
    event(30, 'RunCreated', 'run:r2', 1, {
      runId: 'r2',
      nodeId: 'b',
      goalId: 'g',
      planId: 'p',
      executor: { id: 'file-operations', version: '1' },
      requestedBaseRevision: EXTERNAL_BASE_OID,
      baseRevision: EXTERNAL_BASE_OID,
      inputHash: `sha256:${'4'.repeat(64)}`,
      workspaceRelativePath: '.fwa/worktrees/r2'
    }),
    event(31, 'NodeStarted', 'node:b', 3, {
      goalId: 'g', nodeId: 'b', runId: 'r2'
    }),
    event(32, 'RunStarted', 'run:r2', 2, {
      goalId: 'g',
      nodeId: 'b',
      runId: 'r2',
      workspacePath: 'C:/work/.fwa/worktrees/r2',
      leaseId: '44444444-4444-4444-8444-444444444444'
    }),
    event(33, 'ChangeSetCaptured', 'changeset:c2', 1, {
      changeSetId: 'c2',
      runId: 'r2',
      nodeId: 'b',
      goalId: 'g',
      baseRevision: EXTERNAL_BASE_OID,
      headRevision: SECOND_HEAD_OID,
      commits: [SECOND_HEAD_OID],
      changedFiles: ['out/b'],
      changes: [{ status: 'added', code: 'A', path: 'out/b' }],
      ref: 'refs/heads/fwa/runs/r2',
      branch: 'fwa/runs/r2',
      valid: true,
      violations: [],
      stats: { fileCount: 1, diffLines: 1, durationMs: 2 },
      patchArtifact: ARTIFACT,
      executionArtifact: ARTIFACT
    }),
    event(34, 'RunProduced', 'run:r2', 3, {
      runId: 'r2', nodeId: 'b', changeSetId: 'c2', summary: 'Produced one file.'
    }),
    event(35, 'NodeProduced', 'node:b', 4, {
      nodeId: 'b', runId: 'r2', changeSetId: 'c2'
    }),
    event(36, 'RunWorkspaceRemoved', 'run:r2', 4, {
      runId: 'r2',
      workspacePath: 'C:/work/.fwa/worktrees/r2',
      reason: 'removed'
    }),
    event(37, 'EvaluationRequested', 'evaluation:e2', 1, {
      evaluationId: 'e2',
      nodeId: 'b',
      runId: 'r2',
      changeSetId: 'c2',
      headRevision: SECOND_HEAD_OID,
      evaluator: { id: 'command-evaluator', version: '1' },
      profileHash: `sha256:${PROFILE_ARTIFACT.digest}`,
      profileArtifact: PROFILE_ARTIFACT,
      contractId: null,
      requiredCriteria: ['passes'],
      workspaceRelativePath: '.fwa/evaluations/e2'
    }),
    event(38, 'EvaluationExecutionStarted', 'evaluation:e2', 2, {
      evaluationId: 'e2',
      workspacePath: 'C:/work/.fwa/evaluations/e2',
      leaseId: '55555555-5555-4555-8555-555555555555',
      headRevision: SECOND_HEAD_OID
    }),
    event(39, 'NodeEvaluationStarted', 'node:b', 5, {
      nodeId: 'b', evaluationId: 'e2', runId: 'r2', changeSetId: 'c2'
    }),
    event(40, 'EvidenceRecorded', 'evidence:v2', 1, {
      evidenceId: 'v2',
      evaluationId: 'e2',
      nodeId: 'b',
      runId: 'r2',
      changeSetId: 'c2',
      headRevision: SECOND_HEAD_OID,
      kind: 'command-evaluation',
      result: 'pass',
      evaluator: { id: 'command-evaluator', version: '1' },
      profileArtifact: PROFILE_ARTIFACT,
      resultArtifact: RESULT_ARTIFACT,
      environmentFingerprint: {
        platform: 'win32',
        arch: 'x64',
        runtime: { name: 'node', version: 'v24.0.0' },
        environmentSha256: `sha256:${'a'.repeat(64)}`
      },
      criteria: [criterion()],
      policyViolations: []
    }),
    event(41, 'EvaluationPassed', 'evaluation:e2', 3, {
      evaluationId: 'e2', evidenceId: 'v2', nodeId: 'b', runId: 'r2', changeSetId: 'c2'
    }),
    event(42, 'NodeAccepted', 'node:b', 6, {
      nodeId: 'b', evaluationId: 'e2', evidenceId: 'v2', runId: 'r2', changeSetId: 'c2'
    })
  ];
}

function singleNodeAcceptedPrefix() {
  return [
    event(1, 'GoalCreated', 'goal:g', 1, {
      goalId: 'g', title: 'Goal', request: 'Request'
    }),
    event(2, 'PlanLoaded', 'goal:g', 2, {
      goalId: 'g',
      planId: 'p',
      planHash: `sha256:${'a'.repeat(64)}`,
      nodeIds: ['a']
    }),
    event(3, 'NodePlanned', 'node:a', 1, {
      goalId: 'g', planId: 'p', node: nodePayload('a')
    }),
    event(4, 'NodeReady', 'node:a', 2, {
      goalId: 'g', planId: 'p', nodeId: 'a', reason: 'dependencies-satisfied'
    }),
    event(5, 'RunCreated', 'run:r1', 1, {
      runId: 'r1',
      nodeId: 'a',
      goalId: 'g',
      planId: 'p',
      executor: { id: 'file-operations', version: '1' },
      requestedBaseRevision: 'HEAD',
      baseRevision: BASE_OID,
      inputHash: `sha256:${'4'.repeat(64)}`,
      workspaceRelativePath: '.fwa/worktrees/r1'
    }),
    event(6, 'GoalActivated', 'goal:g', 3, {
      goalId: 'g', nodeId: 'a', runId: 'r1'
    }),
    event(7, 'NodeStarted', 'node:a', 3, {
      goalId: 'g', nodeId: 'a', runId: 'r1'
    }),
    event(8, 'RunStarted', 'run:r1', 2, {
      goalId: 'g',
      nodeId: 'a',
      runId: 'r1',
      workspacePath: 'C:/work/.fwa/worktrees/r1',
      leaseId: '11111111-1111-4111-8111-111111111111'
    }),
    changeSetEvent(9),
    event(10, 'RunProduced', 'run:r1', 3, {
      runId: 'r1', nodeId: 'a', changeSetId: 'c1', summary: 'Produced one file.'
    }),
    event(11, 'NodeProduced', 'node:a', 4, {
      nodeId: 'a', runId: 'r1', changeSetId: 'c1'
    }),
    event(12, 'RunWorkspaceRemoved', 'run:r1', 4, {
      runId: 'r1',
      workspacePath: 'C:/work/.fwa/worktrees/r1',
      reason: 'removed'
    }),
    evaluationRequested(13),
    event(14, 'EvaluationExecutionStarted', 'evaluation:e1', 2, {
      evaluationId: 'e1',
      workspacePath: 'C:/work/.fwa/evaluations/e1',
      leaseId: '22222222-2222-4222-8222-222222222222',
      headRevision: HEAD_OID
    }),
    event(15, 'NodeEvaluationStarted', 'node:a', 5, {
      nodeId: 'a', evaluationId: 'e1', runId: 'r1', changeSetId: 'c1'
    }),
    evidenceRecorded(16),
    event(17, 'EvaluationPassed', 'evaluation:e1', 3, {
      evaluationId: 'e1', evidenceId: 'v1', nodeId: 'a', runId: 'r1', changeSetId: 'c1'
    }),
    event(18, 'NodeAccepted', 'node:a', 6, {
      nodeId: 'a', evaluationId: 'e1', evidenceId: 'v1', runId: 'r1', changeSetId: 'c1'
    })
  ];
}

test('projection rejects a plan event sequence that omits declared nodes', () => {
  assert.throws(
    () => projectEvents(planPrefix()),
    (error) => error instanceof ProjectionError
      && error.code === 'incomplete-plan-projection'
  );
});

test('projection enforces node ownership and initial dependency readiness', () => {
  const prefix = planPrefix();
  const nodes = [
    event(3, 'NodePlanned', 'node:a', 1, {
      goalId: 'g',
      planId: 'p',
      node: nodePayload('a')
    }),
    event(4, 'NodePlanned', 'node:b', 1, {
      goalId: 'g',
      planId: 'p',
      node: nodePayload('b', ['a'])
    })
  ];

  assert.throws(
    () => projectEvents([
      ...prefix,
      ...nodes,
      event(5, 'NodeReady', 'node:b', 2, {
        goalId: 'g',
        planId: 'p',
        nodeId: 'b'
      })
    ]),
    (error) => error.code === 'node-not-ready'
  );

  const projected = projectEvents([
    ...prefix,
    ...nodes,
    event(5, 'NodeReady', 'node:a', 2, {
      goalId: 'g',
      planId: 'p',
      nodeId: 'a'
    })
  ]);
  assert.equal(projected.nodes.find((node) => node.id === 'a').status, 'ready');
  assert.equal(projected.nodes.find((node) => node.id === 'b').status, 'planned');
});

test('projection fails on event tampering and stream-version gaps', () => {
  const created = planPrefix()[0];
  assert.throws(
    () => projectEvents([{ ...created, payload: { ...created.payload, title: 'Changed' } }]),
    (error) => error.code === 'event-hash-invalid'
  );

  const wrongVersion = event(1, 'GoalCreated', 'goal:g', 2, {
    goalId: 'g',
    title: 'Goal',
    request: 'Request'
  });
  assert.throws(
    () => projectEvents([wrongVersion]),
    (error) => error.code === 'stream-version-conflict'
  );
});

test('projection rejects unsupported event schemas and malformed content', () => {
  const created = planPrefix()[0];
  const unsupported = { ...created, schemaVersion: 999 };
  unsupported.hash = eventHash(unsupported);
  assert.throws(
    () => projectEvents([unsupported]),
    (error) => error.code === 'event-envelope-invalid'
      && /Unsupported event schema/.test(error.message)
  );

  const malformed = { ...created, payload: null };
  malformed.hash = eventHash(malformed);
  assert.throws(
    () => projectEvents([malformed]),
    (error) => error instanceof ProjectionError
      && error.code === 'event-envelope-invalid'
  );
});

test('projection rejects a plan id reused by another goal', () => {
  const events = [
    event(1, 'GoalCreated', 'goal:g1', 1, {
      goalId: 'g1', title: 'First', request: 'First'
    }),
    event(2, 'PlanLoaded', 'goal:g1', 2, {
      goalId: 'g1', planId: 'shared', planHash: `sha256:${'a'.repeat(64)}`, nodeIds: ['a']
    }),
    event(3, 'NodePlanned', 'node:a', 1, {
      goalId: 'g1', planId: 'shared', node: nodePayload('a')
    }),
    event(4, 'GoalCreated', 'goal:g2', 1, {
      goalId: 'g2', title: 'Second', request: 'Second'
    }),
    event(5, 'PlanLoaded', 'goal:g2', 2, {
      goalId: 'g2', planId: 'shared', planHash: `sha256:${'b'.repeat(64)}`, nodeIds: ['b']
    })
  ];

  assert.throws(
    () => projectEvents(events),
    (error) => error.code === 'plan-already-exists'
  );
});

test('projection replays the produced Run and immutable ChangeSet chain', () => {
  const projected = projectEvents([
    ...runningPrefix(),
    changeSetEvent(),
    event(11, 'RunProduced', 'run:r1', 3, {
      runId: 'r1', nodeId: 'a', changeSetId: 'c1', summary: 'Produced one file.'
    }),
    event(12, 'NodeProduced', 'node:a', 4, {
      nodeId: 'a', runId: 'r1', changeSetId: 'c1'
    }),
    event(13, 'RunWorkspaceRemoved', 'run:r1', 4, {
      runId: 'r1',
      workspacePath: 'C:/work/.fwa/worktrees/r1',
      reason: 'removed'
    })
  ]);

  assert.equal(projected.goals[0].status, 'active');
  assert.equal(projected.nodes.find((node) => node.id === 'a').status, 'produced');
  assert.equal(projected.runs[0].status, 'produced');
  assert.equal(projected.runs[0].changeSetId, 'c1');
  assert.equal(projected.runs[0].workspaceStatus, 'removed');
  assert.equal(projected.changeSets[0].ref, 'refs/heads/fwa/runs/r1');
});

test('projection rejects workspace cleanup before a Run is produced', () => {
  assert.throws(
    () => projectEvents([
      ...runningPrefix(),
      event(10, 'RunWorkspaceRemoved', 'run:r1', 3, {
        runId: 'r1',
        workspacePath: 'C:/work/.fwa/worktrees/r1',
        reason: 'removed'
      })
    ]),
    (error) => error.code === 'run-cleanup-mismatch'
  );
});

test('projection accepts a pending setup failure without consuming ready node state', () => {
  const projected = projectEvents([
    ...runnablePrefix(),
    event(7, 'RunFailed', 'run:r1', 2, {
      runId: 'r1',
      phase: 'setup',
      failure: { code: 'SETUP_FAILED', message: 'Could not create worktree.', details: null }
    })
  ]);
  assert.equal(projected.runs[0].status, 'failed');
  assert.equal(projected.nodes.find((node) => node.id === 'a').status, 'ready');
  assert.equal(projected.goals[0].status, 'planned');
});

test('projection requires activation and paired node failure for a started Run', () => {
  assert.throws(
    () => projectEvents([
      ...runnablePrefix(),
      event(7, 'NodeStarted', 'node:a', 3, {
        goalId: 'g', nodeId: 'a', runId: 'r1'
      })
    ]),
    (error) => error.code === 'goal-not-active'
  );

  assert.throws(
    () => projectEvents([
      ...runningPrefix(),
      event(10, 'RunFailed', 'run:r1', 3, {
        runId: 'r1',
        phase: 'execution',
        failure: { code: 'FAILED', message: 'Executor failed.', details: null }
      })
    ]),
    (error) => error.code === 'incomplete-run-projection'
  );
});

test('projection rejects contradictory or multiple ChangeSets for one Run', () => {
  assert.throws(
    () => projectEvents([
      ...runningPrefix(),
      changeSetEvent(10, {
        valid: true,
        violations: [{ code: 'OUTSIDE', path: 'writes', message: 'outside' }]
      })
    ]),
    (error) => error.code === 'invalid-event-payload'
  );

  assert.throws(
    () => projectEvents([
      ...runningPrefix(),
      changeSetEvent(),
      changeSetEvent(11, { changeSetId: 'c2' })
    ]),
    (error) => error.code === 'changeset-run-mismatch'
  );

  assert.throws(
    () => projectEvents([
      ...runningPrefix(),
      changeSetEvent(10, {
        valid: false,
        violations: [{ code: 'OUTSIDE', path: 'writes', message: 'outside' }]
      }),
      event(11, 'RunProduced', 'run:r1', 3, {
        runId: 'r1', nodeId: 'a', changeSetId: 'c1', summary: 'Should fail.'
      })
    ]),
    (error) => error.code === 'changeset-run-mismatch'
  );
});

test('projection binds passing evidence to one accepted node and ChangeSet', () => {
  const projected = projectEvents(acceptedEvaluationPrefix());
  const node = projected.nodes.find((item) => item.id === 'a');
  const evaluation = projected.evaluations[0];
  const record = projected.evidence[0];

  assert.equal(node.status, 'accepted');
  assert.equal(node.activeEvaluationId, null);
  assert.equal(node.acceptedChangeSetId, 'c1');
  assert.deepEqual(node.evaluationIds, ['e1']);
  assert.deepEqual(node.acceptanceEvidenceIds, ['v1']);
  assert.equal(evaluation.status, 'passed');
  assert.equal(evaluation.evidenceId, 'v1');
  assert.equal(evaluation.workspaceStatus, 'cleanup-pending');
  assert.equal(record.result, 'pass');
  assert.equal(record.changeSetId, 'c1');
  assert.deepEqual(record.policyViolations, []);
});

test('inline acceptance permits any explicitly allowed evaluator candidate', () => {
  const allowed = projectEvents([
    ...producedPrefix({
      checks: ['passes'],
      evaluators: ['other-evaluator', 'command-evaluator']
    }),
    evaluationRequested()
  ]);
  assert.equal(allowed.evaluations[0].evaluator.id, 'command-evaluator');

  assert.throws(
    () => projectEvents([
      ...producedPrefix({
        checks: ['passes'],
        evaluators: ['other-evaluator', 'backup-evaluator']
      }),
      evaluationRequested()
    ]),
    (error) => error.code === 'evaluation-binding-mismatch'
  );
});

test('projection enforces serial exclusion between active Runs and Evaluations', () => {
  assert.throws(
    () => projectEvents([
      ...producedPrefix(),
      evaluationRequested(),
      event(15, 'RunCreated', 'run:r2', 1, {
        runId: 'r2',
        nodeId: 'a',
        goalId: 'g',
        planId: 'p',
        executor: { id: 'file-operations', version: '1' },
        requestedBaseRevision: 'HEAD',
        baseRevision: BASE_OID,
        inputHash: `sha256:${'c'.repeat(64)}`,
        workspaceRelativePath: '.fwa/worktrees/r2'
      })
    ]),
    (error) => error.code === 'active-evaluation-exists'
  );

  assert.throws(
    () => projectEvents([
      ...producedPrefix(),
      evaluationRequested(),
      evaluationRequested(15, {
        evaluationId: 'e2',
        workspaceRelativePath: '.fwa/evaluations/e2'
      })
    ]),
    (error) => error.code === 'active-project-operation-exists'
  );

  const prefix = planPrefix();
  const producedWithIndependentNode = [
    ...prefix,
    event(3, 'NodePlanned', 'node:a', 1, {
      goalId: 'g', planId: 'p', node: nodePayload('a')
    }),
    event(4, 'NodePlanned', 'node:b', 1, {
      goalId: 'g', planId: 'p', node: nodePayload('b')
    }),
    event(5, 'NodeReady', 'node:a', 2, {
      goalId: 'g', planId: 'p', nodeId: 'a'
    }),
    event(6, 'RunCreated', 'run:r1', 1, {
      runId: 'r1',
      nodeId: 'a',
      goalId: 'g',
      planId: 'p',
      executor: { id: 'file-operations', version: '1' },
      requestedBaseRevision: 'HEAD',
      baseRevision: BASE_OID,
      inputHash: `sha256:${'4'.repeat(64)}`,
      workspaceRelativePath: '.fwa/worktrees/r1'
    }),
    event(7, 'GoalActivated', 'goal:g', 3, {
      goalId: 'g', nodeId: 'a', runId: 'r1'
    }),
    event(8, 'NodeStarted', 'node:a', 3, {
      goalId: 'g', nodeId: 'a', runId: 'r1'
    }),
    event(9, 'RunStarted', 'run:r1', 2, {
      goalId: 'g',
      nodeId: 'a',
      runId: 'r1',
      workspacePath: 'C:/work/.fwa/worktrees/r1',
      leaseId: '11111111-1111-4111-8111-111111111111'
    }),
    changeSetEvent(),
    event(11, 'RunProduced', 'run:r1', 3, {
      runId: 'r1', nodeId: 'a', changeSetId: 'c1', summary: 'Produced one file.'
    }),
    event(12, 'NodeProduced', 'node:a', 4, {
      nodeId: 'a', runId: 'r1', changeSetId: 'c1'
    }),
    event(13, 'RunWorkspaceRemoved', 'run:r1', 4, {
      runId: 'r1',
      workspacePath: 'C:/work/.fwa/worktrees/r1',
      reason: 'removed'
    }),
    event(14, 'NodeReady', 'node:b', 2, {
      goalId: 'g', planId: 'p', nodeId: 'b'
    }),
    event(15, 'RunCreated', 'run:r2', 1, {
      runId: 'r2',
      nodeId: 'b',
      goalId: 'g',
      planId: 'p',
      executor: { id: 'file-operations', version: '1' },
      requestedBaseRevision: 'HEAD',
      baseRevision: BASE_OID,
      inputHash: `sha256:${'d'.repeat(64)}`,
      workspaceRelativePath: '.fwa/worktrees/r2'
    })
  ];
  assert.throws(
    () => projectEvents([
      ...producedWithIndependentNode,
      evaluationRequested(16)
    ]),
    (error) => error.code === 'active-project-operation-exists'
  );
});

test('evaluation acceptance does not make an unintegrated dependent node ready', () => {
  assert.throws(
    () => projectEvents([
      ...acceptedEvaluationPrefix(),
      event(20, 'NodeReady', 'node:b', 2, {
        goalId: 'g', planId: 'p', nodeId: 'b', reason: 'dependencies-satisfied'
      })
    ]),
    (error) => error.code === 'node-not-ready'
  );
});

test('exact-base integration advances a project revision without changing Node acceptance', () => {
  const projected = projectEvents(integratedFirstNodePrefix());
  const node = projected.nodes.find((candidate) => candidate.id === 'a');
  const dependent = projected.nodes.find((candidate) => candidate.id === 'b');
  const integration = projected.integrations[0];

  assert.equal(node.status, 'accepted');
  assert.equal(node.validity, 'valid');
  assert.deepEqual(node.integrationIds, ['i1']);
  assert.equal(node.activeIntegrationId, null);
  assert.equal(node.integrationStatus, 'integrated');
  assert.equal(node.integratedChangeSetId, 'c1');
  assert.equal(node.integratedRevision, CANDIDATE_OID);
  assert.equal(node.integratedTargetRef, TARGET_REF);
  assert.equal(dependent.status, 'ready');
  assert.equal(integration.status, 'integrated');
  assert.equal(integration.strategy, 'exact-base-single-commit');
  assert.equal(integration.evaluationId, 'e1');
  assert.equal(integration.evidenceId, 'v1');
  assert.equal(integration.candidateTree, CANDIDATE_TREE);
  assert.deepEqual(projected.projectRevisions, [{
    integrationId: 'i1',
    targetRef: TARGET_REF,
    previousRevision: BASE_OID,
    revision: CANDIDATE_OID,
    advancedAt: '2026-09-05T00:00:00.000Z',
    advancedSequence: 25,
    version: 1
  }]);
  assert.equal(projected.goals[0].status, 'active');
  assert.equal(projected.goals[0].integrationTargetRef, TARGET_REF);
});

test('a Goal target and its recorded target revision fence later Integration requests', () => {
  const prefix = acceptedSecondNodeAfterExternalAdvancePrefix();
  const request = (targetRef) => event(43, 'IntegrationRequested', 'integration:i2', 1, {
    integrationId: 'i2',
    nodeId: 'b',
    runId: 'r2',
    changeSetId: 'c2',
    evaluationId: 'e2',
    evidenceId: 'v2',
    baseRevision: EXTERNAL_BASE_OID,
    headRevision: SECOND_HEAD_OID,
    targetRef,
    expectedTargetRevision: EXTERNAL_BASE_OID,
    strategy: 'exact-base-single-commit'
  });

  assert.throws(
    () => projectEvents([...prefix, request(TARGET_REF)]),
    (error) => error.code === 'integration-project-revision-mismatch'
  );
  assert.throws(
    () => projectEvents([...prefix, request(OTHER_TARGET_REF)]),
    (error) => error.code === 'integration-goal-target-mismatch'
  );
});

test('integration request binds the exact accepted Evidence, ChangeSet, and target base', () => {
  for (const overrides of [
    { evidenceId: 'other-evidence' },
    { headRevision: 'c'.repeat(40) },
    { expectedTargetRevision: 'd'.repeat(40) },
    { strategy: 'merge-whatever-is-current' },
    { targetRef: 'HEAD' }
  ]) {
    assert.throws(
      () => projectEvents([
        ...acceptedEvaluationPrefix(),
        integrationRequested(20, overrides)
      ]),
      (error) => ['integration-binding-mismatch', 'invalid-event-payload'].includes(
        error.code
      )
    );
  }
});

test('integration cross-stream transitions must be adjacent and candidate bindings immutable', () => {
  assert.throws(
    () => projectEvents([
      ...acceptedEvaluationPrefix(),
      integrationRequested()
    ]),
    (error) => error.code === 'incomplete-integration-projection'
  );

  assert.throws(
    () => projectEvents([
      ...acceptedEvaluationPrefix(),
      integrationRequested(),
      event(21, 'EvaluationWorkspaceRemoved', 'evaluation:e1', 4, {
        evaluationId: 'e1',
        workspacePath: 'C:/work/.fwa/evaluations/e1',
        reason: 'removed'
      }),
      event(22, 'NodeIntegrationRequested', 'node:a', 7, {
        integrationId: 'i1', nodeId: 'a', changeSetId: 'c1'
      })
    ]),
    (error) => error.code === 'integration-binding-mismatch'
  );

  assert.throws(
    () => projectEvents([
      ...integrationPreparedPrefix(),
      event(25, 'ProjectRevisionAdvanced', `project-revision:${TARGET_REF}`, 1, {
        integrationId: 'i1',
        targetRef: TARGET_REF,
        previousRevision: BASE_OID,
        revision: CANDIDATE_OID
      }),
      event(26, 'IntegrationApplied', 'integration:i1', 4, {
        integrationId: 'i1',
        nodeId: 'a',
        changeSetId: 'c1',
        targetRef: TARGET_REF,
        previousRevision: BASE_OID,
        integratedRevision: CANDIDATE_OID,
        candidateTree: 'c'.repeat(40)
      })
    ]),
    (error) => error.code === 'integration-binding-mismatch'
  );

  assert.throws(
    () => projectEvents([
      ...integrationPreparedPrefix(),
      event(25, 'ProjectRevisionAdvanced', `project-revision:${TARGET_REF}`, 1, {
        integrationId: 'i1',
        targetRef: TARGET_REF,
        previousRevision: BASE_OID,
        revision: CANDIDATE_OID
      })
    ]),
    (error) => error.code === 'incomplete-integration-projection'
  );
});

test('an active or recovery-required Integration fences all other project operations', () => {
  const lateRef = (sequence) => event(
    sequence,
    'RefRegistered',
    'ref:ref://code/frozen',
    1,
    {
      id: 'ref://code/frozen',
      kind: 'code',
      uri: 'frozen/**',
      version: 'initial',
      hash: `sha256:${'0'.repeat(64)}`,
      metadata: {}
    }
  );
  assert.throws(
    () => projectEvents([...integrationRequestedPrefix(), lateRef(22)]),
    (error) => error.code === 'active-project-operation-exists'
  );
  assert.throws(
    () => projectEvents([
      ...integrationRequestedPrefix(),
      event(22, 'RunCreated', 'run:r2', 1, {
        runId: 'r2',
        nodeId: 'a',
        goalId: 'g',
        planId: 'p',
        executor: { id: 'file-operations', version: '1' },
        requestedBaseRevision: 'HEAD',
        baseRevision: BASE_OID,
        inputHash: `sha256:${'c'.repeat(64)}`,
        workspaceRelativePath: '.fwa/worktrees/r2'
      })
    ]),
    (error) => error.code === 'active-integration-exists'
  );

  assert.throws(
    () => projectEvents([
      ...integrationRequestedPrefix(),
      evaluationRequested(22, {
        evaluationId: 'e2',
        workspaceRelativePath: '.fwa/evaluations/e2'
      })
    ]),
    (error) => error.code === 'active-project-operation-exists'
  );

  assert.throws(
    () => projectEvents([
      ...integrationRequestedPrefix(),
      integrationRequested(22, { integrationId: 'i2' })
    ]),
    (error) => error.code === 'active-project-operation-exists'
  );

  const recoveryEvents = [
    ...integrationPreparedPrefix(),
    event(25, 'IntegrationRecoveryRequired', 'integration:i1', 4, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      phase: 'promotion',
      failure: {
        code: 'PROMOTION_UNCERTAIN',
        message: 'Target advancement could not be confirmed.',
        details: null
      }
    }),
    event(26, 'NodeIntegrationRecoveryRequired', 'node:a', 9, {
      integrationId: 'i1', nodeId: 'a', changeSetId: 'c1'
    })
  ];
  const projected = projectEvents(recoveryEvents);
  assert.equal(projected.integrations[0].status, 'recovery-required');
  assert.equal(projected.nodes.find((node) => node.id === 'a').status, 'accepted');
  assert.equal(
    projected.nodes.find((node) => node.id === 'a').integrationStatus,
    'recovery-required'
  );
  assert.throws(
    () => projectEvents([
      ...recoveryEvents,
      integrationRequested(27, { integrationId: 'i2' })
    ]),
    (error) => error.code === 'active-project-operation-exists'
  );
  assert.throws(
    () => projectEvents([...recoveryEvents, lateRef(27)]),
    (error) => error.code === 'active-project-operation-exists'
  );
});

test('failed integration preserves acceptance and retry uses a new Integration identity', () => {
  const failure = {
    code: 'TARGET_MOVED',
    message: 'The target no longer equals the accepted base.',
    details: { expected: BASE_OID }
  };
  const failed = [
    ...integrationRequestedPrefix(),
    event(22, 'IntegrationFailed', 'integration:i1', 2, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      phase: 'preflight',
      failure
    }),
    event(23, 'NodeIntegrationFailed', 'node:a', 8, {
      integrationId: 'i1', nodeId: 'a', changeSetId: 'c1'
    })
  ];
  const projected = projectEvents(failed);
  const node = projected.nodes.find((candidate) => candidate.id === 'a');
  assert.equal(node.status, 'accepted');
  assert.equal(node.integrationStatus, 'failed');
  assert.equal(node.activeIntegrationId, null);
  assert.equal(node.acceptedChangeSetId, 'c1');
  assert.equal(projected.integrations[0].failure.code, 'TARGET_MOVED');

  const retried = projectEvents([
    ...failed,
    integrationRequested(24, { integrationId: 'i2' }),
    event(25, 'NodeIntegrationRequested', 'node:a', 9, {
      integrationId: 'i2', nodeId: 'a', changeSetId: 'c1'
    })
  ]);
  assert.deepEqual(
    retried.nodes.find((candidate) => candidate.id === 'a').integrationIds,
    ['i1', 'i2']
  );
  assert.equal(
    retried.nodes.find((candidate) => candidate.id === 'a').integrationStatus,
    'pending'
  );
});

test('reconciliation may resolve a prepared recovery-required Integration', () => {
  const recovery = [
    ...integrationPreparedPrefix(),
    event(25, 'IntegrationRecoveryRequired', 'integration:i1', 4, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      phase: 'promotion',
      failure: {
        code: 'PROMOTION_UNCERTAIN',
        message: 'Target advancement could not be confirmed.',
        details: null
      }
    }),
    event(26, 'NodeIntegrationRecoveryRequired', 'node:a', 9, {
      integrationId: 'i1', nodeId: 'a', changeSetId: 'c1'
    })
  ];
  const applied = projectEvents([
    ...recovery,
    event(27, 'ProjectRevisionAdvanced', `project-revision:${TARGET_REF}`, 1, {
      integrationId: 'i1',
      targetRef: TARGET_REF,
      previousRevision: BASE_OID,
      revision: CANDIDATE_OID
    }),
    event(28, 'IntegrationApplied', 'integration:i1', 5, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      targetRef: TARGET_REF,
      previousRevision: BASE_OID,
      integratedRevision: CANDIDATE_OID,
      candidateTree: CANDIDATE_TREE
    }),
    event(29, 'NodeIntegrated', 'node:a', 10, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      targetRef: TARGET_REF,
      integratedRevision: CANDIDATE_OID
    }),
    event(30, 'NodeReady', 'node:b', 2, {
      goalId: 'g', planId: 'p', nodeId: 'b', reason: 'dependencies-satisfied'
    }),
    event(31, 'IntegrationEffectsApplied', 'integration:i1', 6, {
      integrationId: 'i1',
      affectedNodeIds: [],
      recomputeRootNodeIds: [],
      reopenedGoalIds: [],
      advancedRefIds: []
    })
  ]);
  assert.equal(applied.integrations[0].status, 'integrated');
  assert.equal(applied.nodes.find((node) => node.id === 'b').status, 'ready');

  const failed = projectEvents([
    ...recovery,
    event(27, 'IntegrationFailed', 'integration:i1', 5, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      phase: 'reconciliation',
      failure: {
        code: 'TARGET_NOT_ADVANCED',
        message: 'The target remained at its expected revision.',
        details: null
      }
    }),
    event(28, 'NodeIntegrationFailed', 'node:a', 10, {
      integrationId: 'i1', nodeId: 'a', changeSetId: 'c1'
    })
  ]);
  assert.equal(failed.integrations[0].status, 'failed');
  assert.equal(failed.nodes.find((node) => node.id === 'a').status, 'accepted');
});

test('the final integrated Node completes its Goal only through the adjacent completion event', () => {
  const prefix = [
    ...singleNodeAcceptedPrefix(),
    integrationRequested(19),
    event(20, 'NodeIntegrationRequested', 'node:a', 7, {
      integrationId: 'i1', nodeId: 'a', changeSetId: 'c1'
    }),
    event(21, 'IntegrationExecutionStarted', 'integration:i1', 2, {
      integrationId: 'i1',
      leaseId: '33333333-3333-4333-8333-333333333333'
    }),
    event(22, 'NodeIntegrationStarted', 'node:a', 8, {
      integrationId: 'i1', nodeId: 'a', changeSetId: 'c1'
    }),
    event(23, 'IntegrationPrepared', 'integration:i1', 3, {
      integrationId: 'i1',
      candidateRevision: CANDIDATE_OID,
      candidateTree: CANDIDATE_TREE
    }),
    event(24, 'ProjectRevisionAdvanced', `project-revision:${TARGET_REF}`, 1, {
      integrationId: 'i1',
      targetRef: TARGET_REF,
      previousRevision: BASE_OID,
      revision: CANDIDATE_OID
    }),
    event(25, 'IntegrationApplied', 'integration:i1', 4, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      targetRef: TARGET_REF,
      previousRevision: BASE_OID,
      integratedRevision: CANDIDATE_OID,
      candidateTree: CANDIDATE_TREE
    }),
    event(26, 'NodeIntegrated', 'node:a', 9, {
      integrationId: 'i1',
      nodeId: 'a',
      changeSetId: 'c1',
      targetRef: TARGET_REF,
      integratedRevision: CANDIDATE_OID
    })
  ];

  assert.throws(
    () => projectEvents([
      ...prefix,
      event(27, 'IntegrationEffectsApplied', 'integration:i1', 5, {
        integrationId: 'i1',
        affectedNodeIds: [],
        recomputeRootNodeIds: [],
        reopenedGoalIds: [],
        advancedRefIds: []
      })
    ]),
    (error) => error.code === 'incomplete-goal-projection'
  );

  const projected = projectEvents([
    ...prefix,
    event(27, 'GoalCompleted', 'goal:g', 4, {
      goalId: 'g',
      planId: 'p',
      integrationId: 'i1',
      targetRef: TARGET_REF,
      revision: CANDIDATE_OID
    }),
    event(28, 'IntegrationEffectsApplied', 'integration:i1', 5, {
      integrationId: 'i1',
      affectedNodeIds: [],
      recomputeRootNodeIds: [],
      reopenedGoalIds: [],
      advancedRefIds: []
    })
  ]);
  assert.equal(projected.goals[0].status, 'completed');
  assert.equal(projected.goals[0].completedRevision, CANDIDATE_OID);
  assert.equal(projected.goals[0].completedTargetRef, TARGET_REF);

  assert.throws(
    () => projectEvents([
      ...prefix,
      event(27, 'GoalCompleted', 'goal:g', 4, {
        goalId: 'g',
        planId: 'p',
        integrationId: 'i1',
        targetRef: TARGET_REF,
        revision: 'c'.repeat(40)
      })
    ]),
    (error) => error.code === 'goal-not-complete'
  );
});

test('projection preserves failed expected-artifact evidence and rejects the node', () => {
  const missingArtifactFailure = {
    code: 'ARTIFACT_MISSING',
    message: 'Expected artifact was not produced.',
    details: { path: 'out/a' }
  };
  const failedCriterion = criterion({
    result: 'fail',
    exitCode: 1,
    expectedArtifacts: [{
      path: 'out/a',
      size: null,
      digest: null,
      artifact: null,
      failure: missingArtifactFailure
    }, {
      path: 'out/actual',
      size: EXPECTED_ARTIFACT.size,
      digest: EXPECTED_ARTIFACT.digest,
      artifact: EXPECTED_ARTIFACT,
      failure: {
        code: 'EXPECTED_ARTIFACT_DIGEST_MISMATCH',
        message: 'Expected artifact digest differs.',
        details: { actual: EXPECTED_ARTIFACT.digest }
      }
    }],
    failure: {
      code: 'COMMAND_FAILED',
      message: 'Command exited unsuccessfully.',
      details: { exitCode: 1 }
    }
  });
  const projected = projectEvents([
    ...evaluationRunningPrefix(),
    evidenceRecorded(17, { result: 'fail', criteria: [failedCriterion] }),
    event(18, 'EvaluationRejected', 'evaluation:e1', 3, {
      evaluationId: 'e1',
      evidenceId: 'v1',
      nodeId: 'a',
      runId: 'r1',
      changeSetId: 'c1'
    }),
    event(19, 'NodeRejected', 'node:a', 6, {
      nodeId: 'a',
      evaluationId: 'e1',
      evidenceId: 'v1',
      runId: 'r1',
      changeSetId: 'c1'
    })
  ]);

  assert.equal(projected.nodes.find((item) => item.id === 'a').status, 'rejected');
  assert.equal(projected.evaluations[0].status, 'rejected');
  assert.equal(projected.evidence[0].criteria[0].expectedArtifacts[0].artifact, null);
  assert.deepEqual(
    projected.evidence[0].criteria[0].expectedArtifacts[0].failure,
    missingArtifactFailure
  );
  assert.equal(
    projected.evidence[0].criteria[0].expectedArtifacts[1].artifact.digest,
    EXPECTED_ARTIFACT.digest
  );
  assert.equal(
    projected.evidence[0].criteria[0].expectedArtifacts[1].failure.code,
    'EXPECTED_ARTIFACT_DIGEST_MISMATCH'
  );
});

test('projection distinguishes requested and running evaluation interruption', () => {
  const requestedInterrupted = projectEvents([
    ...producedPrefix(),
    evaluationRequested(),
    event(15, 'EvaluationInterrupted', 'evaluation:e1', 2, {
      evaluationId: 'e1',
      nodeId: 'a',
      runId: 'r1',
      changeSetId: 'c1',
      phase: 'setup',
      failure: {
        code: 'SETUP_FAILED', message: 'Workspace setup failed.', details: null
      },
      workspaceDisposition: 'removed'
    })
  ]);
  assert.equal(requestedInterrupted.evaluations[0].status, 'interrupted');
  assert.equal(requestedInterrupted.evaluations[0].workspaceStatus, 'removed');
  assert.equal(
    requestedInterrupted.nodes.find((item) => item.id === 'a').status,
    'produced'
  );
  assert.equal(
    requestedInterrupted.nodes.find((item) => item.id === 'a').activeEvaluationId,
    null
  );

  const runningInterrupted = projectEvents([
    ...evaluationRunningPrefix(),
    event(17, 'EvaluationInterrupted', 'evaluation:e1', 3, {
      evaluationId: 'e1',
      nodeId: 'a',
      runId: 'r1',
      changeSetId: 'c1',
      phase: 'execution',
      failure: {
        code: 'EVALUATOR_FAILED', message: 'Evaluator infrastructure failed.', details: null
      },
      workspaceDisposition: 'preserved'
    }),
    event(18, 'NodeEvaluationDeferred', 'node:a', 6, {
      nodeId: 'a', evaluationId: 'e1', runId: 'r1', changeSetId: 'c1'
    })
  ]);
  assert.equal(runningInterrupted.evaluations[0].workspaceStatus, 'preserved');
  assert.equal(runningInterrupted.nodes.find((item) => item.id === 'a').status, 'produced');

  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix(),
      event(17, 'EvaluationInterrupted', 'evaluation:e1', 3, {
        evaluationId: 'e1',
        nodeId: 'a',
        runId: 'r1',
        changeSetId: 'c1',
        phase: 'execution',
        failure: { code: 'FAILED', message: 'Interrupted.', details: null },
        workspaceDisposition: 'preserved'
      })
    ]),
    (error) => error.code === 'incomplete-evaluation-projection'
  );
});

test('recovery-required evaluation retains its active node and owned workspace', () => {
  const projected = projectEvents([
    ...evaluationRunningPrefix(),
    event(17, 'EvaluationRecoveryRequired', 'evaluation:e1', 3, {
      evaluationId: 'e1',
      nodeId: 'a',
      runId: 'r1',
      changeSetId: 'c1',
      phase: 'lease-release',
      failure: {
        code: 'LEASE_RELEASE_FAILED', message: 'Lease ownership is uncertain.', details: null
      },
      workspacePath: 'C:/work/.fwa/evaluations/e1'
    })
  ]);
  const node = projected.nodes.find((item) => item.id === 'a');
  assert.equal(projected.evaluations[0].status, 'recovery-required');
  assert.equal(projected.evaluations[0].workspaceStatus, 'preserved');
  assert.equal(node.status, 'evaluating');
  assert.equal(node.activeEvaluationId, 'e1');
});

test('terminal evaluation workspace cleanup is replayed without changing its verdict', () => {
  const projected = projectEvents([
    ...acceptedEvaluationPrefix(),
    event(20, 'EvaluationWorkspaceCleanupFailed', 'evaluation:e1', 4, {
      evaluationId: 'e1',
      workspacePath: 'C:/work/.fwa/evaluations/e1',
      failure: { code: 'BUSY', message: 'Workspace is busy.', details: null }
    }),
    event(21, 'EvaluationWorkspaceRemoved', 'evaluation:e1', 5, {
      evaluationId: 'e1',
      workspacePath: 'C:/work/.fwa/evaluations/e1',
      reason: 'removed'
    })
  ]);

  assert.equal(projected.evaluations[0].status, 'passed');
  assert.equal(projected.evaluations[0].workspaceStatus, 'removed');
  assert.equal(projected.evaluations[0].cleanupFailures.length, 1);
  assert.equal(projected.nodes.find((item) => item.id === 'a').status, 'accepted');
});

test('projection rejects contradictory, duplicate, and cross-bound evaluation evidence', () => {
  const failingCriterion = (id) => criterion({
    id,
    result: 'fail',
    exitCode: 1,
    failure: {
      code: 'COMMAND_FAILED',
      message: 'The criterion failed.',
      details: null
    }
  });
  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix(),
      evidenceRecorded(17, {
        result: 'fail',
        criteria: [criterion({ result: 'fail' })]
      })
    ]),
    (error) => error.code === 'invalid-event-payload'
  );

  assert.throws(
    () => projectEvents([
      ...producedPrefix(),
      evaluationRequested(14, { contractId: 'wrong-contract' })
    ]),
    (error) => error.code === 'evaluation-binding-mismatch'
  );

  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix(),
      evidenceRecorded(17, { criteria: [criterion(), criterion()] })
    ]),
    (error) => error.code === 'invalid-event-payload'
  );

  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix(),
      evidenceRecorded(17, {
        policyViolations: [{ code: 'POLICY', message: 'Policy failed.' }]
      })
    ]),
    (error) => error.code === 'invalid-event-payload'
  );

  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix(),
      evidenceRecorded(17, { headRevision: BASE_OID })
    ]),
    (error) => error.code === 'evidence-binding-mismatch'
  );

  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix(),
      evidenceRecorded(17, { criteria: [criterion({ id: 'not-required' })] })
    ]),
    (error) => error.code === 'evidence-binding-mismatch'
  );

  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix(),
      evidenceRecorded(17, {
        result: 'fail',
        criteria: [failingCriterion('not-required')]
      })
    ]),
    (error) => error.code === 'evidence-binding-mismatch'
  );

  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix({
        acceptance: { checks: ['passes', 'second'] },
        requestOverrides: { requiredCriteria: ['passes', 'second'] }
      }),
      evidenceRecorded(17, {
        result: 'fail',
        criteria: [failingCriterion('passes')]
      })
    ]),
    (error) => error.code === 'evidence-binding-mismatch'
  );

  const mismatchedExpectedArtifact = criterion({
    expectedArtifacts: [{
      path: 'out/a',
      size: EXPECTED_ARTIFACT.size,
      digest: 'b'.repeat(64),
      artifact: EXPECTED_ARTIFACT,
      failure: null
    }]
  });
  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix(),
      evidenceRecorded(17, { criteria: [mismatchedExpectedArtifact] })
    ]),
    (error) => error.code === 'invalid-event-payload'
  );

  assert.throws(
    () => projectEvents([
      ...evaluationRunningPrefix(),
      evidenceRecorded(),
      event(18, 'EvidenceRecorded', 'evidence:v2', 1, {
        ...evidenceRecorded().payload,
        evidenceId: 'v2'
      })
    ]),
    (error) => error.code === 'evidence-binding-mismatch'
  );
});
