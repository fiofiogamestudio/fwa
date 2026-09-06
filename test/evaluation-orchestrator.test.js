import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import {
  FILE_OPERATIONS_CAPABILITY,
  FileOperationsExecutor
} from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { createEvent, stableStringify } from '../src/core/events.js';
import { WorkspaceLease } from '../src/storage/workspace-lease.js';

const CHECK_ID = 'verify-produced-output';

async function run(executable, arguments_, { cwd, allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status) => {
      const result = {
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (!allowedExitCodes.includes(status)) {
        reject(new Error(
          `${executable} ${arguments_.join(' ')} exited ${status}: ${result.stderr}`
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function git(cwd, arguments_, options) {
  return run('git', arguments_, { cwd, ...options });
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function executionPlan(
  acceptance = { checks: [CHECK_ID] },
  additionalNodes = []
) {
  return {
    schemaVersion: 1,
    id: 'evaluation-plan',
    nodes: [{
      id: 'produce-files',
      title: 'Produce output for evaluation',
      dependsOn: [],
      reads: ['seed.txt'],
      writes: ['generated/**'],
      capabilities: [FILE_OPERATIONS_CAPABILITY],
      acceptance,
      budget: { maxRetries: 1, maxFiles: 4, maxDiffLines: 100 }
    }, ...additionalNodes]
  };
}

function evaluationProfile({
  id = 'evaluation-profile',
  checkId = CHECK_ID,
  script = 'process.exit(0)',
  expectedArtifacts = undefined
} = {}) {
  const check = {
    id: checkId,
    kind: 'command',
    command: process.execPath,
    args: ['-e', script],
    timeoutMs: 10_000,
    expectedExitCodes: [0]
  };
  if (expectedArtifacts !== undefined) {
    check.expectedArtifacts = expectedArtifacts;
  }
  return { schemaVersion: 1, id, checks: [check] };
}

function countingEvaluator(delegate = new CommandEvaluator()) {
  const state = { calls: 0 };
  return {
    state,
    evaluator: {
      schemaVersion: delegate.schemaVersion,
      id: delegate.id,
      version: delegate.version,
      normalizeProfile(profile) {
        return delegate.normalizeProfile(profile);
      },
      async evaluate(context) {
        state.calls += 1;
        return delegate.evaluate(context);
      }
    }
  };
}

function syntheticVerdictEvaluator(resultFactory) {
  const normalizer = new CommandEvaluator();
  const evaluator = {
    schemaVersion: 1,
    id: 'synthetic-verdict-evaluator',
    version: '1',
    normalizeProfile(profile) {
      return normalizer.normalizeProfile(profile);
    },
    async evaluate({ manifest }) {
      const result = resultFactory(manifest);
      return {
        schemaVersion: 1,
        evaluator: { id: evaluator.id, version: evaluator.version },
        manifest: { id: manifest.id, schemaVersion: manifest.schemaVersion },
        durationMs: 1,
        environmentFingerprint: {
          platform: 'synthetic',
          arch: 'synthetic',
          runtime: { name: 'synthetic', version: '1' },
          environmentSha256: 'a'.repeat(64)
        },
        ...result
      };
    }
  };
  return evaluator;
}

function failCleanupOnce(delegate) {
  const state = { attempts: 0 };
  return {
    state,
    workspace: {
      verifyChangeSet: (options) => delegate.verifyChangeSet(options),
      createEvaluation: (options) => delegate.createEvaluation(options),
      inspectEvaluation: (options) => delegate.inspectEvaluation(options),
      async removeEvaluation(options) {
        state.attempts += 1;
        if (state.attempts === 1) {
          const error = new Error('Simulated evaluation cleanup failure.');
          error.code = 'SIMULATED_EVALUATION_CLEANUP_FAILURE';
          throw error;
        }
        return delegate.removeEvaluation(options);
      }
    }
  };
}

function failLeaseRelease(delegate) {
  const state = { releaseCalls: 0 };
  return {
    state,
    lease: {
      init: (options) => delegate.init(options),
      inspect: (options) => delegate.inspect(options),
      acquire: (options) => delegate.acquire(options),
      heartbeat: (options) => delegate.heartbeat(options),
      archiveStale: (options) => delegate.archiveStale(options),
      async release() {
        state.releaseCalls += 1;
        const error = new Error('Simulated evaluation lease release failure.');
        error.code = 'SIMULATED_EVALUATION_LEASE_RELEASE_FAILURE';
        throw error;
      }
    }
  };
}

async function fixture(t, { acceptance, additionalNodes = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-evaluation-orchestrator-'));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25
  }));

  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Evaluation Test']);
  await git(root, ['config', 'user.email', 'fwa-evaluation-test@example.invalid']);
  await git(root, ['config', 'core.ignorecase', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base seed\n', 'utf8');
  await git(root, ['add', '.gitignore', 'seed.txt']);
  await git(root, ['commit', '-m', 'test: establish evaluation base']);
  const baseRevision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  const app = new FwaApplication(root);
  await app.init();
  const created = await app.createGoal({
    title: 'Exercise Slice C1',
    request: 'Evaluate an immutable produced ChangeSet.',
    commandId: 'fixture-create-goal'
  });
  await app.loadPlan({
    goalId: created.goal.id,
    plan: executionPlan(acceptance, additionalNodes),
    commandId: 'fixture-load-plan'
  });
  const workspace = new GitWorktreeAdapter(root);
  const produced = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace,
    input: {
      schemaVersion: 1,
      operations: [{
        type: 'write',
        path: 'generated/output.txt',
        content: 'generated\n'
      }]
    },
    baseRevision: 'HEAD',
    commandId: 'fixture-produce-change-set'
  });
  assert.equal(produced.ok, true);
  assert.equal(produced.node.status, 'produced');
  assert.equal(produced.changeSet.valid, true);

  return {
    root,
    app,
    workspace,
    baseRevision,
    changeSet: produced.changeSet
  };
}

test('passing evaluation accepts the node and removes its real Git worktree', async (t) => {
  const { root, app, workspace, changeSet } = await fixture(t, {
    acceptance: {
      checks: [CHECK_ID],
      evaluators: ['other-evaluator', 'command-evaluator']
    }
  });
  const proof = 'proof\n';
  const profile = evaluationProfile({
    script: [
      "const fs = require('node:fs')",
      "if (fs.readFileSync('generated/output.txt', 'utf8').trim() !== 'generated') process.exit(8)",
      `fs.writeFileSync('evaluation-proof.txt', ${JSON.stringify(proof)})`
    ].join(';'),
    expectedArtifacts: [{
      path: 'evaluation-proof.txt',
      size: Buffer.byteLength(proof),
      sha256: sha256(proof)
    }]
  });
  let alternateArtifactCalls = 0;
  const alternateArtifacts = {
    async init() { alternateArtifactCalls += 1; },
    async put() { alternateArtifactCalls += 1; },
    async verify() { alternateArtifactCalls += 1; }
  };
  const result = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile,
    evaluator: new CommandEvaluator(),
    workspace,
    artifacts: alternateArtifacts,
    commandId: 'evaluate-success'
  });

  assert.equal(result.ok, true, JSON.stringify({
    evaluation: result.evaluation,
    evidence: result.evidence,
    cleanup: result.cleanup
  }, null, 2));
  assert.equal(result.appended, true);
  assert.equal(result.evaluation.status, 'passed');
  assert.equal(result.evaluation.workspaceStatus, 'removed');
  assert.equal(result.node.status, 'accepted');
  assert.equal(result.node.acceptedChangeSetId, changeSet.id);
  assert.deepEqual(result.node.acceptanceEvidenceIds, [result.evidence.id]);
  assert.equal(result.evidence.result, 'pass');
  assert.equal(result.evidence.criteria[0].result, 'pass');
  assert.equal(
    result.evidence.criteria[0].expectedArtifacts[0].digest,
    sha256(proof)
  );
  assert.equal(result.cleanup.worktreeRemoved, true);
  assert.equal(result.cleanup.leaseReleased, true);
  assert.equal(alternateArtifactCalls, 0);
  assert.equal(await pathExists(result.evaluation.workspacePath), false);
  assert.equal(await readFile(path.join(root, 'seed.txt'), 'utf8'), 'base seed\n');
  assert.equal((await git(root, ['status', '--porcelain'])).stdout, '');

  const eventTypes = (await app.listEvents())
    .filter((event) => event.payload.evaluationId === result.evaluation.id)
    .map((event) => event.type);
  assert.deepEqual(eventTypes, [
    'EvaluationRequested',
    'EvaluationExecutionStarted',
    'NodeEvaluationStarted',
    'EvidenceRecorded',
    'EvaluationPassed',
    'NodeAccepted',
    'EvaluationWorkspaceRemoved'
  ]);
  const verification = await app.verify({ workspace });
  assert.equal(verification.operationallyClean, true);
  assert.equal(verification.evaluationCount, 1);
  assert.equal(verification.evidenceCount, 1);
  assert.deepEqual(verification.unreferencedArtifacts, []);

  const resultEnvelope = JSON.parse(
    (await app.artifacts.get(result.evidence.resultArtifact)).toString('utf8')
  );
  assert.equal(resultEnvelope.profile.sha256, result.evaluation.profileHash);
  assert.equal(
    resultEnvelope.profile.sha256,
    `sha256:${result.evidence.profileArtifact.digest}`
  );

  const forgedEnvelope = {
    ...resultEnvelope,
    profile: { ...resultEnvelope.profile, sha256: `sha256:${'0'.repeat(64)}` }
  };
  const forgedResultArtifact = await app.artifacts.put(
    Buffer.from(stableStringify(forgedEnvelope), 'utf8')
  );
  const snapshot = await app.store.readAll();
  const forgedEvents = snapshot.events.map((event) => (
    event.type !== 'EvidenceRecorded' || event.payload.evidenceId !== result.evidence.id
      ? event
      : createEvent({
        ...event,
        payload: { ...event.payload, resultArtifact: forgedResultArtifact }
      }, { idFactory: () => event.eventId })
  ));
  const forgedApp = new FwaApplication(root, {
    store: {
      readAll: async () => ({ ...snapshot, events: forgedEvents }),
      async appendBatch() {
        throw new Error('forged verification store is read-only');
      }
    },
    artifacts: app.artifacts,
    lease: app.lease
  });
  await assert.rejects(
    forgedApp.verify({ workspace }),
    (error) => error.code === 'evidence-result-artifact-mismatch'
  );

  const persistedProfile = JSON.parse(
    (await app.artifacts.get(result.evidence.profileArtifact)).toString('utf8')
  );
  const semanticallyDifferentProfile = {
    ...persistedProfile,
    checks: [{
      ...persistedProfile.checks[0],
      command: 'different-command'
    }]
  };
  const forgedProfileArtifact = await app.artifacts.put(
    Buffer.from(stableStringify(semanticallyDifferentProfile), 'utf8')
  );
  const semanticallyForgedResultArtifact = await app.artifacts.put(Buffer.from(
    stableStringify({
      ...resultEnvelope,
      profile: {
        ...resultEnvelope.profile,
        sha256: `sha256:${forgedProfileArtifact.digest}`
      }
    }),
    'utf8'
  ));
  const semanticallyForgedEvents = snapshot.events.map((event) => {
    let payload = event.payload;
    if (event.type === 'EvaluationRequested'
      && event.payload.evaluationId === result.evaluation.id) {
      payload = {
        ...event.payload,
        profileHash: `sha256:${forgedProfileArtifact.digest}`,
        profileArtifact: forgedProfileArtifact
      };
    }
    if (event.type === 'EvidenceRecorded'
      && event.payload.evidenceId === result.evidence.id) {
      payload = {
        ...event.payload,
        profileArtifact: forgedProfileArtifact,
        resultArtifact: semanticallyForgedResultArtifact
      };
    }
    return payload === event.payload
      ? event
      : createEvent({ ...event, payload }, { idFactory: () => event.eventId });
  });
  const semanticForgeryApp = new FwaApplication(root, {
    store: {
      readAll: async () => ({ ...snapshot, events: semanticallyForgedEvents }),
      async appendBatch() {
        throw new Error('forged verification store is read-only');
      }
    },
    artifacts: app.artifacts,
    lease: app.lease
  });
  await assert.rejects(
    semanticForgeryApp.verify({ workspace }),
    (error) => error.code === 'evidence-profile-mismatch'
      && error.details.errors.some((item) => item.code === 'CRITERION_COMMAND_MISMATCH')
  );
});

test('a non-zero exit records durable failing evidence and rejects the node', async (t) => {
  const { app, workspace, changeSet } = await fixture(t);
  const result = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile: evaluationProfile({ script: 'process.exit(7)' }),
    evaluator: new CommandEvaluator(),
    workspace,
    commandId: 'evaluate-nonzero'
  });

  assert.equal(result.ok, false);
  assert.equal(result.evaluation.status, 'rejected');
  assert.equal(result.evaluation.workspaceStatus, 'removed');
  assert.equal(result.node.status, 'rejected');
  assert.equal(result.evidence.result, 'fail');
  assert.equal(result.evidence.criteria[0].result, 'fail');
  assert.equal(result.evidence.criteria[0].exitCode, 7);
  assert.equal(result.evidence.criteria[0].failure.code, 'UNEXPECTED_EXIT_CODE');
  assert.deepEqual(result.evidence.policyViolations, []);
});

test('a missing expected artifact rejects with a null artifact binding and failure', async (t) => {
  const { app, workspace, changeSet } = await fixture(t);
  const result = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile: evaluationProfile({
      expectedArtifacts: [{ path: 'missing/result.json' }]
    }),
    evaluator: new CommandEvaluator(),
    workspace,
    commandId: 'evaluate-missing-artifact'
  });

  const observed = result.evidence.criteria[0].expectedArtifacts[0];
  assert.equal(result.ok, false);
  assert.equal(result.node.status, 'rejected');
  assert.equal(result.evidence.result, 'fail');
  assert.equal(observed.path, 'missing/result.json');
  assert.equal(observed.artifact, null);
  assert.equal(observed.digest, null);
  assert.equal(observed.size, null);
  assert.equal(observed.failure.code, 'EXPECTED_ARTIFACT_MISSING');
});

test('tracked source mutation becomes a policy violation even when the command passes', async (t) => {
  const { root, app, workspace, changeSet } = await fixture(t);
  const result = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile: evaluationProfile({
      script: "require('node:fs').writeFileSync('seed.txt', 'mutated\\n')"
    }),
    evaluator: new CommandEvaluator(),
    workspace,
    commandId: 'evaluate-mutates-source'
  });

  assert.equal(result.ok, false);
  assert.equal(result.node.status, 'rejected');
  assert.equal(result.evidence.criteria[0].result, 'pass');
  assert.equal(result.evidence.result, 'fail');
  assert.equal(result.evidence.policyViolations.length, 1);
  assert.equal(
    result.evidence.policyViolations[0].code,
    'EVALUATION_MUTATED_TRACKED_FILE'
  );
  assert.equal(result.evidence.policyViolations[0].details.path, 'seed.txt');
  assert.equal(await readFile(path.join(root, 'seed.txt'), 'utf8'), 'base seed\n');
  assert.equal((await git(root, ['status', '--porcelain'])).stdout, '');
});

test('contradictory evaluator verdicts become consistent failing evidence', async (t) => {
  const { app, workspace, changeSet } = await fixture(t);
  const proof = Buffer.from('synthetic proof\n', 'utf8');
  const profile = evaluationProfile({
    expectedArtifacts: [{ path: 'synthetic-proof.txt' }]
  });
  const evaluator = syntheticVerdictEvaluator((manifest) => {
    const expected = manifest.checks[0];
    return {
      // The evaluator claims the whole profile passed even though it reports
      // the observed artifact itself as failed.
      passed: true,
      checks: [{
        id: expected.id,
        kind: expected.kind,
        status: 'passed',
        passed: true,
        command: expected.command,
        args: [...expected.args],
        timeoutMs: expected.timeoutMs,
        expectedExitCodes: [...expected.expectedExitCodes],
        exitCode: 0,
        signal: null,
        terminationConfirmed: true,
        timedOut: false,
        aborted: false,
        durationMs: 1,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        expectedArtifacts: [{
          path: expected.expectedArtifacts[0].path,
          passed: false,
          bytesBase64: proof.toString('base64'),
          size: proof.byteLength,
          digest: sha256(proof),
          failure: null
        }],
        failure: null
      }]
    };
  });
  const result = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile,
    evaluator,
    workspace,
    commandId: 'evaluate-contradictory-verdict'
  });

  assert.equal(result.ok, false);
  assert.equal(result.evaluation.status, 'rejected');
  assert.equal(result.evaluation.workspaceStatus, 'removed');
  assert.equal(result.node.status, 'rejected');
  assert.equal(result.evidence.result, 'fail');
  assert.equal(result.evidence.criteria[0].result, 'fail');
  const artifact = result.evidence.criteria[0].expectedArtifacts[0];
  assert.equal(artifact.digest, sha256(proof));
  assert.notEqual(artifact.artifact, null);
  assert.equal(artifact.failure.code, 'EVALUATOR_ARTIFACT_VERDICT_MISMATCH');
  assert.equal(
    result.evidence.policyViolations.some((violation) => (
      violation.code === 'EVALUATOR_VERDICT_MISMATCH'
    )),
    true
  );
  assert.equal(result.cleanup.worktreeRemoved, true);
});

test('command id replay is idempotent and a different evaluation intent conflicts', async (t) => {
  const { app, workspace, changeSet } = await fixture(t);
  const counted = countingEvaluator();
  const profile = evaluationProfile();
  const first = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile,
    evaluator: counted.evaluator,
    workspace,
    commandId: 'evaluate-idempotently'
  });
  const replay = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile,
    evaluator: counted.evaluator,
    workspace,
    commandId: 'evaluate-idempotently'
  });

  assert.equal(first.appended, true);
  assert.equal(replay.appended, false);
  assert.equal(replay.evaluation.id, first.evaluation.id);
  assert.equal(replay.evidence.id, first.evidence.id);
  assert.equal(counted.state.calls, 1);

  await assert.rejects(
    app.evaluateChangeSet({
      changeSetId: changeSet.id,
      profile: evaluationProfile({ script: "process.stdout.write('different')" }),
      evaluator: counted.evaluator,
      workspace,
      commandId: 'evaluate-idempotently'
    }),
    (error) => error.code === 'command-id-conflict'
  );
  assert.equal(counted.state.calls, 1);
});

test('a raced command replay reports failure to release its temporary loser lease', async (t) => {
  const { root, app, workspace, changeSet } = await fixture(t);
  const counted = countingEvaluator();
  const profile = evaluationProfile();
  let reportAcquire;
  let releaseAcquire;
  const acquireEntered = new Promise((resolve) => { reportAcquire = resolve; });
  const acquireGate = new Promise((resolve) => { releaseAcquire = resolve; });
  let loserReleaseCalls = 0;
  const loserLease = {
    init: app.lease.init.bind(app.lease),
    inspect: app.lease.inspect.bind(app.lease),
    heartbeat: app.lease.heartbeat.bind(app.lease),
    archiveStale: app.lease.archiveStale.bind(app.lease),
    async acquire(options) {
      reportAcquire();
      await acquireGate;
      return app.lease.acquire(options);
    },
    async release() {
      loserReleaseCalls += 1;
      const error = new Error('Simulated loser lease release failure.');
      error.code = 'SIMULATED_LOSER_LEASE_RELEASE_FAILURE';
      throw error;
    }
  };
  const shared = {
    changeSetId: changeSet.id,
    profile,
    evaluator: counted.evaluator,
    workspace,
    commandId: 'evaluate-raced-command'
  };

  const loserPromise = app.evaluateChangeSet({ ...shared, lease: loserLease });
  await acquireEntered;
  let winner;
  try {
    winner = await app.evaluateChangeSet(shared);
  } finally {
    releaseAcquire();
  }
  const loser = await loserPromise;

  assert.equal(winner.appended, true);
  assert.equal(winner.ok, true);
  assert.equal(winner.cleanup.leaseReleased, true);
  assert.equal(loser.appended, false);
  assert.equal(loser.evaluation.id, winner.evaluation.id);
  assert.equal(loser.cleanup.worktreeRemoved, true);
  assert.equal(loser.cleanup.leaseReleased, false);
  assert.equal(loser.cleanup.warnings.length, 1);
  assert.equal(loser.cleanup.warnings[0].phase, 'lease-release');
  assert.equal(
    loser.cleanup.warnings[0].failure.code,
    'SIMULATED_LOSER_LEASE_RELEASE_FAILURE'
  );
  assert.equal(loserReleaseCalls, 1);
  assert.equal(counted.state.calls, 1);

  const orphan = await app.lease.inspect();
  assert.equal(orphan.held, true);
  assert.equal(orphan.lease.ownerKind, 'evaluation');
  assert.notEqual(orphan.lease.ownerId, winner.evaluation.id);
  const recoveryLease = new WorkspaceLease(root, { pidProbe: async () => false });
  await recoveryLease.init();
  const archived = await recoveryLease.archiveStale({
    expectedLeaseId: orphan.lease.leaseId
  });
  assert.equal(archived.archived, true);
});

test('replay reports an orphan evaluation lease until reconciliation archives it', async (t) => {
  const { root, app, workspace, changeSet } = await fixture(t);
  const failing = failLeaseRelease(app.lease);
  const evaluator = new CommandEvaluator();
  const profile = evaluationProfile();
  const first = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile,
    evaluator,
    workspace,
    lease: failing.lease,
    commandId: 'evaluate-orphaned-lease'
  });

  assert.equal(first.ok, true);
  assert.equal(first.evaluation.status, 'passed');
  assert.equal(first.evaluation.workspaceStatus, 'removed');
  assert.equal(first.cleanup.worktreeRemoved, true);
  assert.equal(first.cleanup.leaseReleased, false);
  assert.equal(failing.state.releaseCalls, 1);
  assert.equal((await app.lease.inspect()).held, true);

  const replay = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile,
    evaluator,
    workspace,
    lease: failing.lease,
    commandId: 'evaluate-orphaned-lease'
  });
  assert.equal(replay.appended, false);
  assert.equal(replay.evaluation.id, first.evaluation.id);
  assert.equal(replay.cleanup.worktreeRemoved, true);
  assert.equal(replay.cleanup.leaseReleased, false);
  assert.equal(failing.state.releaseCalls, 1);

  const recoveryLease = new WorkspaceLease(root, {
    pidProbe: async () => false
  });
  const reconciled = await app.reconcileEvaluation({
    workspace,
    lease: recoveryLease,
    correlationId: 'reconcile-orphaned-evaluation-lease',
    orphanGraceMs: 1
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.reason, 'orphan-evaluation-lease-archived');
  assert.equal(reconciled.archived.archived, true);
  assert.equal(reconciled.archived.lease.ownerKind, 'evaluation');
  assert.equal(reconciled.archived.lease.ownerId, first.evaluation.id);
  assert.equal((await app.lease.inspect()).held, false);
  assert.equal((await app.verify({ workspace })).operationallyClean, true);
});

test('profile and acceptance mismatch fails before persistence and process spawn', async (t) => {
  const { app, workspace, changeSet } = await fixture(t);
  const counted = countingEvaluator();
  const eventsBefore = await app.listEvents();
  const artifactsBefore = await app.artifacts.listRefs();

  await assert.rejects(
    app.evaluateChangeSet({
      changeSetId: changeSet.id,
      profile: evaluationProfile({ checkId: 'not-the-accepted-check' }),
      evaluator: counted.evaluator,
      workspace,
      commandId: 'evaluate-contract-mismatch'
    }),
    (error) => error.code === 'evaluation-contract-mismatch'
  );

  assert.equal(counted.state.calls, 0);
  assert.equal((await app.listEvents()).length, eventsBefore.length);
  assert.deepEqual(await app.artifacts.listRefs(), artifactsBefore);
  assert.deepEqual((await app.getStatus()).evaluations, []);
});

test('durable cleanup failure is retried to convergence by reconciliation', async (t) => {
  const { app, workspace, changeSet } = await fixture(t);
  const flaky = failCleanupOnce(workspace);
  const result = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile: evaluationProfile(),
    evaluator: new CommandEvaluator(),
    workspace: flaky.workspace,
    commandId: 'evaluate-cleanup-failure'
  });

  assert.equal(result.ok, true);
  assert.equal(result.evaluation.status, 'passed');
  assert.equal(result.evaluation.workspaceStatus, 'cleanup-failed');
  assert.equal(result.cleanup.worktreeRemoved, false);
  assert.equal(result.cleanup.warnings.length, 1);
  assert.equal(flaky.state.attempts, 1);
  assert.equal(await pathExists(result.evaluation.workspacePath), true);

  const before = await app.verify({ workspace });
  assert.equal(before.operationallyClean, false);
  assert.deepEqual(before.pendingEvaluationCleanup, [result.evaluation.id]);
  const reconciled = await app.reconcileEvaluation({
    workspace,
    correlationId: 'reconcile-evaluation-cleanup',
    orphanGraceMs: 1
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.reason, 'evaluation-cleanup-retried');
  assert.equal(reconciled.cleanup.worktreeRemoved, true);
  assert.equal(reconciled.cleanup.leaseReleased, true);
  assert.equal(await pathExists(result.evaluation.workspacePath), false);

  const status = await app.getStatus();
  assert.equal(status.evaluations[0].status, 'passed');
  assert.equal(status.evaluations[0].workspaceStatus, 'removed');
  assert.equal(status.evaluations[0].cleanupFailures.length, 1);
  const after = await app.verify({ workspace });
  assert.equal(after.operationallyClean, true);
  assert.deepEqual(after.pendingEvaluationCleanup, []);
});

test('evaluation reconciliation never cleans while a durable Run is active', async (t) => {
  const followUpNode = {
    id: 'follow-up-run',
    title: 'Represent a newly claimed Run',
    dependsOn: [],
    reads: ['seed.txt'],
    writes: ['follow-up/**'],
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    acceptance: { checks: ['follow-up-check'] },
    budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 20 }
  };
  const {
    app,
    workspace,
    baseRevision,
    changeSet
  } = await fixture(t, { additionalNodes: [followUpNode] });
  const flaky = failCleanupOnce(workspace);
  const evaluationResult = await app.evaluateChangeSet({
    changeSetId: changeSet.id,
    profile: evaluationProfile(),
    evaluator: new CommandEvaluator(),
    workspace: flaky.workspace,
    commandId: 'evaluate-before-active-run'
  });
  assert.equal(evaluationResult.evaluation.status, 'passed');
  assert.equal(evaluationResult.evaluation.workspaceStatus, 'cleanup-failed');
  assert.equal(await pathExists(evaluationResult.evaluation.workspacePath), true);
  assert.equal((await app.lease.inspect()).held, false);

  const store = await app.store.readAll();
  const runId = 'run_reconcile_guard';
  const commandId = 'inject-active-run';
  const runCreated = createEvent({
    type: 'RunCreated',
    streamId: `run:${runId}`,
    sequence: store.lastSequence + 1,
    actor: 'test',
    correlationId: commandId,
    payload: {
      runId,
      nodeId: followUpNode.id,
      goalId: evaluationResult.node.goalId,
      planId: evaluationResult.node.planId,
      executor: { id: 'injected-runner', version: '1' },
      requestedBaseRevision: 'HEAD',
      baseRevision,
      inputHash: `sha256:${'b'.repeat(64)}`,
      workspaceRelativePath: `.fwa/worktrees/${runId}`
    },
    metadata: { streamVersion: 1 }
  });
  await app.store.appendBatch(commandId, [runCreated], {
    expectedLastSequence: store.lastSequence,
    intentHash: sha256('inject one active Run for reconciliation fencing')
  });
  assert.equal(
    (await app.getStatus()).runs.find((runState) => runState.id === runId).status,
    'pending'
  );

  let removeCalls = 0;
  const reconcileWorkspace = {
    async removeEvaluation(options) {
      removeCalls += 1;
      return workspace.removeEvaluation(options);
    }
  };
  const reconciled = await app.reconcileEvaluation({
    workspace: reconcileWorkspace,
    correlationId: 'reconcile-must-respect-active-run',
    orphanGraceMs: 1
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, false);
  assert.equal(reconciled.reason, 'run-operation-active');
  assert.equal(reconciled.run.id, runId);
  assert.equal(removeCalls, 0);
  assert.equal((await app.lease.inspect()).held, false);
  const status = await app.getStatus();
  assert.equal(status.evaluations[0].workspaceStatus, 'cleanup-failed');
  assert.equal(await pathExists(status.evaluations[0].workspacePath), true);
});
