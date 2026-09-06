import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import {
  IntegrationRegressionGateError,
  runIntegrationRegressionGate
} from '../src/application/integration-regression-gate.js';
import { stableStringify } from '../src/core/events.js';

const CANDIDATE_REVISION = 'a'.repeat(40);
const INTEGRATION_ID = 'integration-17';
const WORKSPACE_PATH = 'D:\\fake-project\\.fwa\\evaluations\\integration-17';

function profile() {
  return {
    schemaVersion: 1,
    id: 'integration-regression',
    checks: [{
      id: 'test-suite',
      kind: 'command',
      command: 'test-runner',
      args: ['--ci'],
      timeoutMs: 4_321,
      expectedExitCodes: [0]
    }]
  };
}

function artifactStore({ log = [], failInit = false, failPutAt = null } = {}) {
  const state = {
    initCalls: 0,
    putCalls: 0,
    verifyCalls: 0,
    values: [],
    bytesByDigest: new Map()
  };
  const subject = {
    state,
    async init() {
      state.initCalls += 1;
      log.push('artifacts:init');
      if (failInit) {
        const error = new Error('simulated artifact init failure');
        error.code = 'SIMULATED_ARTIFACT_INIT_FAILURE';
        throw error;
      }
      return { created: true };
    },
    async put(value) {
      state.putCalls += 1;
      const bytes = Buffer.from(value);
      log.push(`artifacts:put:${state.putCalls}`);
      if (state.putCalls === failPutAt) {
        const error = new Error('simulated artifact put failure');
        error.code = 'SIMULATED_ARTIFACT_PUT_FAILURE';
        throw error;
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      const ref = {
        schemaVersion: 1,
        algorithm: 'sha256',
        digest,
        size: bytes.byteLength
      };
      state.values.push({ bytes, ref });
      state.bytesByDigest.set(digest, bytes);
      return ref;
    },
    async verify(ref) {
      state.verifyCalls += 1;
      log.push(`artifacts:verify:${state.verifyCalls}`);
      const bytes = state.bytesByDigest.get(ref.digest);
      assert.ok(bytes, 'fake store can only verify a ref it stored');
      assert.equal(bytes.byteLength, ref.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.digest);
      return { ok: true, ref };
    }
  };
  return subject;
}

function workspace({
  log = [],
  trackedChanges = [],
  createError = null,
  cleanupError = null,
  removal = { removed: true, alreadyAbsent: false }
} = {}) {
  const state = {
    creates: [],
    inspections: [],
    removals: []
  };
  return {
    state,
    async createEvaluation(request) {
      state.creates.push(request);
      log.push('workspace:create');
      if (createError !== null) throw createError;
      return {
        evaluationId: request.evaluationId,
        workspacePath: WORKSPACE_PATH,
        headRevision: request.revision,
        detached: true
      };
    },
    async inspectEvaluation(request) {
      state.inspections.push(request);
      log.push('workspace:inspect');
      return {
        evaluationId: request.evaluationId,
        workspacePath: request.workspacePath,
        headRevision: request.revision,
        detached: true,
        changes: [...trackedChanges, { code: '??', path: 'generated/results.xml' }],
        trackedChanges: [...trackedChanges]
      };
    },
    async removeEvaluation(request) {
      state.removals.push(request);
      log.push('workspace:remove');
      if (cleanupError !== null) throw cleanupError;
      return removal;
    }
  };
}

function checkResult(check, outcome) {
  const failed = outcome === 'fail';
  const aborted = outcome === 'abort';
  return {
    id: check.id,
    kind: check.kind,
    status: failed || aborted ? 'failed' : 'passed',
    passed: !failed && !aborted,
    command: check.command,
    args: [...check.args],
    cwd: WORKSPACE_PATH,
    timeoutMs: check.timeoutMs,
    expectedExitCodes: [...check.expectedExitCodes],
    exitCode: failed ? 7 : aborted ? null : 0,
    signal: null,
    terminationConfirmed: true,
    timedOut: false,
    aborted,
    durationMs: 11,
    stdout: failed ? '' : 'ok\n',
    stderr: failed ? 'tests failed\n' : '',
    stdoutBytes: failed ? 0 : 3,
    stderrBytes: failed ? 13 : 0,
    stdoutObservedBytes: failed ? 0 : 3,
    stderrObservedBytes: failed ? 13 : 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    expectedArtifacts: [],
    failure: failed
      ? { code: 'TESTS_FAILED', message: 'The test command failed.', details: null }
      : aborted
        ? { code: 'COMMAND_ABORTED', message: 'Evaluation was aborted.', details: null }
        : null
  };
}

function evaluator({ log = [], outcome = 'pass', throwError = null } = {}) {
  const normalizer = new CommandEvaluator();
  const state = { evaluations: [], normalizedProfile: null };
  const subject = {
    schemaVersion: 1,
    id: 'fake-regression-evaluator',
    version: '1',
    normalizeProfile(value) {
      log.push('evaluator:normalize');
      state.normalizedProfile = normalizer.normalizeProfile(value);
      return state.normalizedProfile;
    },
    async evaluate(context) {
      state.evaluations.push(context);
      log.push('evaluator:evaluate');
      if (throwError !== null) throw throwError;
      const checks = context.manifest.checks.map((check) => checkResult(check, outcome));
      return {
        schemaVersion: 1,
        evaluator: { id: subject.id, version: subject.version },
        manifest: {
          id: context.manifest.id,
          schemaVersion: context.manifest.schemaVersion
        },
        passed: outcome === 'pass',
        environmentFingerprint: {
          platform: 'fake',
          arch: 'fake',
          runtime: { name: 'fake-runtime', version: '1' },
          environmentSha256: 'b'.repeat(64)
        },
        durationMs: 12,
        checks
      };
    }
  };
  return { state, subject };
}

function request({ evaluator: evaluatorPort, workspace: workspacePort, artifacts, signal }) {
  return {
    integrationId: INTEGRATION_ID,
    candidateRevision: CANDIDATE_REVISION,
    profile: profile(),
    evaluator: evaluatorPort,
    workspace: workspacePort,
    artifacts,
    signal
  };
}

test('pass persists canonical bindings, evaluates the exact detached candidate, and cleans up', async () => {
  const log = [];
  const evaluatorFixture = evaluator({ log });
  const workspaceFixture = workspace({ log });
  const artifacts = artifactStore({ log });
  const controller = new AbortController();

  const evidence = await runIntegrationRegressionGate(request({
    evaluator: evaluatorFixture.subject,
    workspace: workspaceFixture,
    artifacts,
    signal: controller.signal
  }));

  assert.equal(evidence.result, 'pass');
  assert.equal(evidence.regressionResult, 'pass');
  assert.equal(evidence.integrationId, INTEGRATION_ID);
  assert.equal(evidence.candidateRevision, CANDIDATE_REVISION);
  assert.deepEqual(workspaceFixture.state.creates, [{
    evaluationId: INTEGRATION_ID,
    revision: CANDIDATE_REVISION
  }]);
  assert.deepEqual(workspaceFixture.state.inspections, [{
    evaluationId: INTEGRATION_ID,
    workspacePath: WORKSPACE_PATH,
    revision: CANDIDATE_REVISION
  }]);
  assert.deepEqual(workspaceFixture.state.removals, [{
    evaluationId: INTEGRATION_ID,
    workspacePath: WORKSPACE_PATH,
    force: true
  }]);
  assert.deepEqual(evidence.workspace, {
    evaluationId: INTEGRATION_ID,
    headRevision: CANDIDATE_REVISION,
    detached: true
  });
  assert.deepEqual(evidence.cleanup, {
    attempted: true,
    status: 'succeeded',
    removed: true,
    alreadyAbsent: false,
    failure: null
  });

  const evaluationContext = evaluatorFixture.state.evaluations[0];
  assert.equal(evaluationContext.workspaceRoot, WORKSPACE_PATH);
  assert.equal(evaluationContext.signal, controller.signal);
  assert.equal(evaluationContext.manifest.checks[0].timeoutMs, 4_321);
  assert.deepEqual(Object.keys(evaluationContext).sort(), ['manifest', 'signal', 'workspaceRoot']);

  assert.ok(log.indexOf('evaluator:normalize') < log.indexOf('artifacts:init'));
  assert.ok(log.indexOf('artifacts:put:1') < log.indexOf('workspace:create'));
  assert.ok(log.indexOf('artifacts:verify:1') < log.indexOf('workspace:create'));
  const profileBytes = artifacts.state.values[0].bytes.toString('utf8');
  assert.equal(profileBytes, stableStringify(evaluatorFixture.state.normalizedProfile));
  assert.equal(evidence.profile.sha256, `sha256:${evidence.profileArtifact.digest}`);

  const resultBytes = artifacts.state.bytesByDigest.get(evidence.resultArtifact.digest);
  const resultEnvelope = JSON.parse(resultBytes.toString('utf8'));
  assert.equal(resultBytes.toString('utf8'), stableStringify(resultEnvelope));
  assert.equal(resultEnvelope.kind, 'integration-regression-result');
  assert.equal(resultEnvelope.integrationId, INTEGRATION_ID);
  assert.equal(resultEnvelope.candidateRevision, CANDIDATE_REVISION);
  assert.equal(resultEnvelope.profile.sha256, evidence.profile.sha256);
  assert.equal(resultEnvelope.result, 'pass');

  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.profile), true);
  assert.equal(Object.isFrozen(evidence.criteria), true);
  assert.equal(Object.isFrozen(evidence.cleanup), true);
  assert.throws(() => {
    evidence.profile.sha256 = 'sha256:forged';
  }, TypeError);
});

test('the canonical profile snapshot cannot be mutated by an injected evaluator', async () => {
  const evaluatorFixture = evaluator();
  const originalEvaluate = evaluatorFixture.subject.evaluate.bind(evaluatorFixture.subject);
  let mutationSucceeded = null;
  evaluatorFixture.subject.evaluate = async (context) => {
    mutationSucceeded = Reflect.set(context.manifest.checks[0], 'command', 'forged-command');
    return originalEvaluate(context);
  };
  const workspaceFixture = workspace();
  const artifacts = artifactStore();

  const evidence = await runIntegrationRegressionGate(request({
    evaluator: evaluatorFixture.subject,
    workspace: workspaceFixture,
    artifacts
  }));

  assert.equal(mutationSucceeded, false);
  assert.equal(evidence.result, 'pass');
  assert.equal(evaluatorFixture.state.evaluations[0].manifest.checks[0].command, 'test-runner');
  assert.equal(
    artifacts.state.values[0].bytes.toString('utf8'),
    stableStringify(evaluatorFixture.state.evaluations[0].manifest)
  );
});

test('a test failure returns durable fail Evidence and still cleans up', async () => {
  const evaluatorFixture = evaluator({ outcome: 'fail' });
  const workspaceFixture = workspace();
  const artifacts = artifactStore();

  const evidence = await runIntegrationRegressionGate(request({
    evaluator: evaluatorFixture.subject,
    workspace: workspaceFixture,
    artifacts
  }));

  assert.equal(evidence.result, 'fail');
  assert.equal(evidence.regressionResult, 'fail');
  assert.equal(evidence.criteria[0].result, 'fail');
  assert.equal(evidence.criteria[0].failure.code, 'TESTS_FAILED');
  assert.equal(evidence.cleanup.status, 'succeeded');
  assert.equal(workspaceFixture.state.removals.length, 1);
  assert.ok(artifacts.state.bytesByDigest.has(evidence.resultArtifact.digest));
});

test('tracked-source mutation is a policy violation even when tests pass', async () => {
  const evaluatorFixture = evaluator();
  const workspaceFixture = workspace({
    trackedChanges: [{ code: ' M', path: 'src/game.cs' }]
  });
  const artifacts = artifactStore();

  const evidence = await runIntegrationRegressionGate(request({
    evaluator: evaluatorFixture.subject,
    workspace: workspaceFixture,
    artifacts
  }));

  assert.equal(evidence.result, 'fail');
  assert.equal(evidence.regressionResult, 'fail');
  assert.equal(evidence.criteria[0].result, 'pass');
  assert.deepEqual(evidence.policyViolations, [{
    code: 'EVALUATION_MUTATED_TRACKED_FILE',
    message: 'Evaluation changed tracked path src/game.cs.',
    details: { code: ' M', path: 'src/game.cs' }
  }]);
  assert.equal(evidence.cleanup.status, 'succeeded');
});

test('artifact failure after a settled result rejects with explicit successful cleanup', async () => {
  const evaluatorFixture = evaluator();
  const workspaceFixture = workspace();
  const artifacts = artifactStore({ failPutAt: 4 });

  await assert.rejects(
    runIntegrationRegressionGate(request({
      evaluator: evaluatorFixture.subject,
      workspace: workspaceFixture,
      artifacts
    })),
    (error) => {
      assert.ok(error instanceof IntegrationRegressionGateError);
      assert.equal(error.code, 'integration-regression-gate-failed');
      assert.equal(error.details.phase, 'result-materialization');
      assert.equal(error.details.failure.code, 'SIMULATED_ARTIFACT_PUT_FAILURE');
      assert.deepEqual(error.cleanup, {
        attempted: true,
        status: 'succeeded',
        removed: true,
        alreadyAbsent: false,
        failure: null
      });
      assert.equal(Object.isFrozen(error.cleanup), true);
      return true;
    }
  );
  assert.equal(workspaceFixture.state.removals.length, 1);
});

test('artifact store setup failure is explicit and never creates a worktree', async () => {
  const evaluatorFixture = evaluator();
  const workspaceFixture = workspace();
  const artifacts = artifactStore({ failInit: true });

  await assert.rejects(
    runIntegrationRegressionGate(request({
      evaluator: evaluatorFixture.subject,
      workspace: workspaceFixture,
      artifacts
    })),
    (error) => {
      assert.equal(error.details.phase, 'artifact-store-init');
      assert.equal(error.cleanup.status, 'not-required');
      assert.equal(error.cleanup.attempted, false);
      return true;
    }
  );
  assert.equal(workspaceFixture.state.creates.length, 0);
  assert.equal(workspaceFixture.state.removals.length, 0);
});

test('a post-side-effect create failure attempts cleanup by deterministic evaluation id', async () => {
  const createError = new Error('worktree add succeeded but baseline validation failed');
  createError.code = 'SIMULATED_POST_CREATE_FAILURE';
  const evaluatorFixture = evaluator();
  const workspaceFixture = workspace({ createError });
  const artifacts = artifactStore();

  await assert.rejects(
    runIntegrationRegressionGate(request({
      evaluator: evaluatorFixture.subject,
      workspace: workspaceFixture,
      artifacts
    })),
    (error) => {
      assert.equal(error.details.phase, 'workspace-create');
      assert.deepEqual(error.cleanup, {
        attempted: true,
        status: 'succeeded',
        removed: true,
        alreadyAbsent: false,
        failure: null
      });
      return true;
    }
  );
  assert.deepEqual(workspaceFixture.state.removals, [{
    evaluationId: INTEGRATION_ID,
    force: true
  }]);
  assert.equal(evaluatorFixture.state.evaluations.length, 0);
});

test('cleanup failure is returned as explicit fail-closed gate Evidence', async () => {
  const cleanupError = new Error('simulated cleanup failure');
  cleanupError.code = 'SIMULATED_CLEANUP_FAILURE';
  const evaluatorFixture = evaluator();
  const workspaceFixture = workspace({ cleanupError });
  const artifacts = artifactStore();

  const evidence = await runIntegrationRegressionGate(request({
    evaluator: evaluatorFixture.subject,
    workspace: workspaceFixture,
    artifacts
  }));

  assert.equal(evidence.regressionResult, 'pass');
  assert.equal(evidence.result, 'fail');
  assert.deepEqual(evidence.cleanup, {
    attempted: true,
    status: 'failed',
    removed: false,
    alreadyAbsent: false,
    failure: {
      code: 'SIMULATED_CLEANUP_FAILURE',
      message: 'simulated cleanup failure',
      details: null
    }
  });
  assert.ok(artifacts.state.bytesByDigest.has(evidence.resultArtifact.digest));
});

test('a pre-aborted signal is passed through and returns fail Evidence after confirmed termination', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stop requested'));
  const evaluatorFixture = evaluator({ outcome: 'abort' });
  const workspaceFixture = workspace();
  const artifacts = artifactStore();

  const evidence = await runIntegrationRegressionGate(request({
    evaluator: evaluatorFixture.subject,
    workspace: workspaceFixture,
    artifacts,
    signal: controller.signal
  }));

  assert.equal(evaluatorFixture.state.evaluations[0].signal, controller.signal);
  assert.equal(evidence.result, 'fail');
  assert.equal(evidence.regressionResult, 'fail');
  assert.equal(evidence.criteria[0].aborted, true);
  assert.equal(evidence.criteria[0].failure.code, 'COMMAND_ABORTED');
  assert.equal(evidence.cleanup.status, 'succeeded');
});

test('an evaluator without a terminal result retains the worktree and exposes recovery state', async () => {
  const terminationError = new Error('process tree did not close');
  terminationError.code = 'FWA_PROCESS_TERMINATION_UNCONFIRMED';
  const evaluatorFixture = evaluator({ throwError: terminationError });
  const workspaceFixture = workspace();
  const artifacts = artifactStore();

  await assert.rejects(
    runIntegrationRegressionGate(request({
      evaluator: evaluatorFixture.subject,
      workspace: workspaceFixture,
      artifacts
    })),
    (error) => {
      assert.equal(error.details.phase, 'evaluation');
      assert.deepEqual(error.cleanup, {
        attempted: false,
        status: 'retained',
        removed: false,
        alreadyAbsent: false,
        failure: {
          code: 'EVALUATION_WORKTREE_RETAINED',
          message: 'Evaluation worktree retained because the evaluator did not return a fully settled result.',
          details: null
        }
      });
      return true;
    }
  );
  assert.equal(workspaceFixture.state.removals.length, 0);
});
