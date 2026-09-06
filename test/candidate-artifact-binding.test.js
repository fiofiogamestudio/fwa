import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { stableStringify } from '../src/core/events.js';
import { ArtifactStore } from '../src/storage/artifact-store.js';

async function run(executable, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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
      if (status !== 0) {
        reject(new Error(
          `${executable} ${args.join(' ')} exited ${status}: ${Buffer.concat(stderr)}`
        ));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function git(cwd, args) {
  return run('git', args, { cwd });
}

function check(id, kind) {
  return {
    id,
    kind,
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 10_000,
    expectedExitCodes: [0]
  };
}

function gateProfile(id) {
  return {
    schemaVersion: 1,
    id,
    checks: [check(`${id}-compile`, 'compile'), check(`${id}-test`, 'test')]
  };
}

async function acceptedFixture(t, artifactDecorator = (store) => store) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-candidate-artifact-'));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25
  }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Candidate Artifact Test']);
  await git(root, ['config', 'user.email', 'candidate-artifact@example.invalid']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  await git(root, ['add', '-A', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'test: establish candidate base']);

  const durableArtifacts = new ArtifactStore(root);
  const artifacts = artifactDecorator(durableArtifacts);
  const app = new FwaApplication(root, { artifacts });
  await app.init();
  const goal = await app.createGoal({
    title: 'Candidate artifact binding',
    commandId: 'create-candidate-artifact-goal'
  });
  await app.loadPlan({
    goalId: goal.goal.id,
    commandId: 'load-candidate-artifact-plan',
    plan: {
      schemaVersion: 1,
      nodes: [{
        id: 'produce',
        dependsOn: [],
        reads: ['seed.txt'],
        writes: ['generated/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['accept-produced'] },
        budget: { maxRetries: 0, maxFiles: 2, maxDiffLines: 50 }
      }]
    }
  });
  const evaluationWorkspace = new GitWorktreeAdapter(root);
  const produced = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace: evaluationWorkspace,
    input: {
      schemaVersion: 1,
      operations: [{
        type: 'write',
        path: 'generated/output.txt',
        content: 'candidate\n'
      }]
    },
    commandId: 'produce-candidate-artifact-change'
  });
  await app.evaluateChangeSet({
    changeSetId: produced.changeSet.id,
    profile: {
      schemaVersion: 1,
      id: 'candidate-artifact-acceptance',
      checks: [check('accept-produced', 'command')]
    },
    evaluator: new CommandEvaluator(),
    workspace: evaluationWorkspace,
    commandId: 'accept-candidate-artifact-change'
  });
  return {
    root,
    app,
    artifacts,
    durableArtifacts,
    evaluationWorkspace,
    changeSet: produced.changeSet
  };
}

function fakeCandidateWorkspace() {
  let serial = 0;
  const oid = () => {
    serial += 1;
    return (serial % 15 + 1).toString(16).repeat(40);
  };
  return {
    async prepareMerge(request) {
      const candidateRevision = oid();
      return {
        disposition: 'prepared',
        kind: 'merge',
        ...request,
        workspacePath: path.join('synthetic', request.integrationId, 'worktree'),
        candidateRef: `refs/fwa/integrations/${request.integrationId}/candidate`,
        candidateRevision,
        candidateTree: oid(),
        parents: [request.expectedTargetRevision, request.sourceRevision],
        changedFiles: ['generated/output.txt'],
        changes: [{ status: 'M', path: 'generated/output.txt' }],
        patch: `candidate-patch:merge:${request.integrationId}\n`,
        conflicts: []
      };
    },
    async prepareRevert(request) {
      const candidateRevision = oid();
      return {
        disposition: 'prepared',
        kind: 'revert',
        ...request,
        workspacePath: path.join('synthetic', request.integrationId, 'worktree'),
        candidateRef: `refs/fwa/integrations/${request.integrationId}/candidate`,
        candidateRevision,
        candidateTree: oid(),
        parents: [request.expectedTargetRevision],
        changedFiles: ['generated/output.txt'],
        changes: [{ status: 'D', path: 'generated/output.txt' }],
        patch: `candidate-patch:revert:${request.integrationId}\n`,
        conflicts: []
      };
    },
    async cleanup(request) {
      return {
        integrationId: request.integrationId,
        workspacePath: request.workspacePath,
        removed: false,
        alreadyAbsent: true
      };
    },
    async inspectResidue() {
      return {
        ok: true,
        count: 0,
        entries: [],
        candidateRefs: [],
        candidateRefCount: 0
      };
    },
    async pruneCandidateRef(request) {
      return {
        integrationId: request.integrationId,
        expectedRevision: request.expectedRevision,
        removed: false,
        alreadyAbsent: true
      };
    }
  };
}

function fakePromotion(evaluationWorkspace, baseRevision) {
  const state = {
    targetRevision: baseRevision,
    exactPromotions: 0,
    preparedPromotions: 0,
    preparedInspections: 0
  };
  const disposition = (request) => {
    if (state.targetRevision === request.candidateRevision) {
      return { disposition: 'applied', containsCandidate: true };
    }
    if (state.targetRevision === request.expectedTargetRevision) {
      return { disposition: 'not-applied', containsCandidate: false };
    }
    return { disposition: 'advanced', containsCandidate: true };
  };
  return {
    state,
    verifyChangeSet: (changeSet) => evaluationWorkspace.verifyChangeSet(changeSet),
    async prepare(request) {
      return {
        ...request,
        candidateRevision: 'e'.repeat(40),
        candidateTree: 'f'.repeat(40)
      };
    },
    async promote(request) {
      state.exactPromotions += 1;
      state.targetRevision = request.candidateRevision;
      return { ...request, targetRevision: state.targetRevision };
    },
    async inspect(request) {
      return {
        ...request,
        ...disposition(request),
        targetRevision: state.targetRevision,
        observedTargetRevision: state.targetRevision
      };
    },
    async promotePrepared(request) {
      state.preparedPromotions += 1;
      state.targetRevision = request.candidateRevision;
      return { ...request, targetRevision: state.targetRevision };
    },
    async inspectPrepared(request) {
      state.preparedInspections += 1;
      return {
        ...request,
        ...disposition(request),
        targetRevision: state.targetRevision,
        observedTargetRevision: state.targetRevision
      };
    }
  };
}

async function syntheticPassingGate(options) {
  const profileArtifact = await options.artifacts.put(Buffer.from(
    stableStringify(options.profile),
    'utf8'
  ));
  const emptyArtifact = await options.artifacts.put(Buffer.alloc(0));
  const profile = {
    id: options.profile.id,
    schemaVersion: options.profile.schemaVersion,
    sha256: `sha256:${profileArtifact.digest}`
  };
  const evaluator = { id: options.evaluator.id, version: options.evaluator.version };
  const environmentFingerprint = {
    platform: 'synthetic',
    arch: 'synthetic',
    runtime: { name: 'synthetic', version: '1' },
    environmentSha256: `sha256:${'0'.repeat(64)}`
  };
  const criteria = options.profile.checks.map((profileCheck) => ({
    id: profileCheck.id,
    kind: profileCheck.kind,
    result: 'pass',
    command: {
      command: profileCheck.command,
      args: [...profileCheck.args],
      cwd: profileCheck.cwd ?? '.'
    },
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    terminationConfirmed: true,
    durationMs: 0,
    stdoutArtifact: emptyArtifact,
    stderrArtifact: emptyArtifact,
    expectedArtifacts: [],
    failure: null
  }));
  const policyViolations = [];
  const resultArtifact = await options.artifacts.put(Buffer.from(stableStringify({
    schemaVersion: 1,
    kind: 'integration-regression-result',
    integrationId: options.integrationId,
    candidateRevision: options.candidateRevision,
    evaluator,
    profile,
    environmentFingerprint,
    result: 'pass',
    criteria,
    policyViolations
  }), 'utf8'));
  return {
    schemaVersion: 1,
    kind: 'integration-regression-gate',
    integrationId: options.integrationId,
    candidateRevision: options.candidateRevision,
    result: 'pass',
    regressionResult: 'pass',
    evaluator,
    profile,
    profileArtifact,
    resultArtifact,
    environmentFingerprint,
    workspace: {
      evaluationId: options.integrationId,
      headRevision: options.candidateRevision,
      detached: true
    },
    criteria,
    policyViolations,
    cleanup: {
      attempted: true,
      status: 'succeeded',
      removed: true,
      alreadyAbsent: false,
      failure: null
    }
  };
}

async function syntheticProfileViolatingGate(options, { exitCode = 0 } = {}) {
  const evidence = await syntheticPassingGate(options);
  const criteria = evidence.criteria.map((criterion, index) => ({
    ...criterion,
    ...(index === 0 ? { exitCode } : {})
  }));
  const resultArtifact = await options.artifacts.put(Buffer.from(stableStringify({
    schemaVersion: 1,
    kind: 'integration-regression-result',
    integrationId: evidence.integrationId,
    candidateRevision: evidence.candidateRevision,
    evaluator: evidence.evaluator,
    profile: evidence.profile,
    environmentFingerprint: evidence.environmentFingerprint,
    result: evidence.regressionResult,
    criteria,
    policyViolations: evidence.policyViolations
  }), 'utf8'));
  return { ...evidence, criteria, resultArtifact };
}

function tamperCandidatePuts(delegate) {
  const state = { patchArtifact: null, executionArtifact: null };
  return {
    state,
    init: (...args) => delegate.init(...args),
    get: (...args) => delegate.get(...args),
    listRefs: (...args) => delegate.listRefs(...args),
    verify: (...args) => delegate.verify(...args),
    async put(value) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const source = bytes.toString('utf8');
      if (source.startsWith('candidate-patch:')) {
        state.patchArtifact = await delegate.put(Buffer.from(
          'forged patch unrelated to the candidate\n',
          'utf8'
        ));
        return state.patchArtifact;
      }
      try {
        const envelope = JSON.parse(source);
        if (['merge-candidate', 'reversion-candidate'].includes(envelope.kind)) {
          envelope.candidateTree = '0'.repeat(40);
          envelope.changedFiles = ['forged.txt'];
          envelope.changes = [{ status: 'A', path: 'forged.txt' }];
          state.executionArtifact = await delegate.put(Buffer.from(
            stableStringify(envelope),
            'utf8'
          ));
          return state.executionArtifact;
        }
      } catch {
        // Non-JSON artifacts retain their original bytes.
      }
      return delegate.put(bytes);
    }
  };
}

function corruptCandidateGets(delegate, patchArtifact, executionArtifact) {
  const state = { patchGets: 0, executionGets: 0 };
  return {
    state,
    init: (...args) => delegate.init(...args),
    put: (...args) => delegate.put(...args),
    listRefs: (...args) => delegate.listRefs(...args),
    verify: (...args) => delegate.verify(...args),
    async get(ref) {
      if (ref.digest === patchArtifact.digest) {
        state.patchGets += 1;
        return Buffer.from('forged recovery patch\n', 'utf8');
      }
      const bytes = await delegate.get(ref);
      if (ref.digest !== executionArtifact.digest) return bytes;
      state.executionGets += 1;
      const envelope = JSON.parse(bytes.toString('utf8'));
      envelope.candidateRevision = '0'.repeat(40);
      return Buffer.from(stableStringify(envelope), 'utf8');
    }
  };
}

async function exactIntegrate(fixture, promotion) {
  const result = await fixture.app.integrateChangeSet({
    changeSetId: fixture.changeSet.id,
    targetRef: 'main',
    workspace: promotion,
    commandId: 'integrate-before-candidate-reversion'
  });
  assert.equal(result.ok, true);
  return result;
}

test('normal Integration must reject semantically forged patch and execution artifacts before promote',
  async (t) => {
    let maliciousArtifacts;
    const fixture = await acceptedFixture(t, (delegate) => {
      maliciousArtifacts = tamperCandidatePuts(delegate);
      return maliciousArtifacts;
    });
    const promotion = fakePromotion(fixture.evaluationWorkspace, fixture.changeSet.baseRevision);
    const result = await fixture.app.integrateChangeSetGated({
      changeSetId: fixture.changeSet.id,
      targetRef: 'main',
      candidateWorkspace: fakeCandidateWorkspace(),
      promotion,
      evaluator: new CommandEvaluator(),
      profile: gateProfile('normal-integration-artifact-binding'),
      evaluationWorkspace: fixture.evaluationWorkspace,
      regressionGate: syntheticPassingGate,
      commandId: 'normal-integration-forged-candidate-artifacts'
    });

    assert.notEqual(maliciousArtifacts.state.patchArtifact, null);
    assert.notEqual(maliciousArtifacts.state.executionArtifact, null);
    assert.equal(promotion.state.preparedPromotions, 0,
      'a forged candidate artifact pair reached Integration promotion');
    assert.equal(result.ok, false);
  });

test('normal Reversion must reject semantically forged patch and execution artifacts before promote',
  async (t) => {
    let maliciousArtifacts;
    const fixture = await acceptedFixture(t, (delegate) => {
      maliciousArtifacts = tamperCandidatePuts(delegate);
      return maliciousArtifacts;
    });
    const promotion = fakePromotion(fixture.evaluationWorkspace, fixture.changeSet.baseRevision);
    await exactIntegrate(fixture, promotion);
    promotion.state.preparedPromotions = 0;
    const result = await fixture.app.revertChangeSet({
      changeSetId: fixture.changeSet.id,
      targetRef: 'main',
      candidateWorkspace: fakeCandidateWorkspace(),
      promotion,
      evaluator: new CommandEvaluator(),
      profile: gateProfile('normal-reversion-artifact-binding'),
      evaluationWorkspace: fixture.evaluationWorkspace,
      regressionGate: syntheticPassingGate,
      commandId: 'normal-reversion-forged-candidate-artifacts'
    });

    assert.notEqual(maliciousArtifacts.state.patchArtifact, null);
    assert.notEqual(maliciousArtifacts.state.executionArtifact, null);
    assert.equal(promotion.state.preparedPromotions, 0,
      'a forged candidate artifact pair reached Reversion promotion');
    assert.equal(result.ok, false);
  });

test('Integration rejects an injected passing gate with a profile-forbidden exit code', async (t) => {
  const fixture = await acceptedFixture(t);
  const promotion = fakePromotion(fixture.evaluationWorkspace, fixture.changeSet.baseRevision);
  const result = await fixture.app.integrateChangeSetGated({
    changeSetId: fixture.changeSet.id,
    targetRef: 'main',
    candidateWorkspace: fakeCandidateWorkspace(),
    promotion,
    evaluator: new CommandEvaluator(),
    profile: gateProfile('integration-profile-policy-binding'),
    evaluationWorkspace: fixture.evaluationWorkspace,
    regressionGate: (options) => syntheticProfileViolatingGate(options, { exitCode: 9 }),
    commandId: 'reject-profile-forbidden-exit-code'
  });

  assert.equal(result.ok, false);
  assert.equal(promotion.state.preparedPromotions, 0);
});

test('Reversion rejects an injected passing gate that omits a required artifact', async (t) => {
  const fixture = await acceptedFixture(t);
  const promotion = fakePromotion(fixture.evaluationWorkspace, fixture.changeSet.baseRevision);
  await exactIntegrate(fixture, promotion);
  promotion.state.preparedPromotions = 0;
  const profile = gateProfile('reversion-profile-artifact-binding');
  profile.checks[0].expectedArtifacts = [{ path: 'required-output.txt' }];
  const result = await fixture.app.revertChangeSet({
    changeSetId: fixture.changeSet.id,
    targetRef: 'main',
    candidateWorkspace: fakeCandidateWorkspace(),
    promotion,
    evaluator: new CommandEvaluator(),
    profile,
    evaluationWorkspace: fixture.evaluationWorkspace,
    regressionGate: syntheticProfileViolatingGate,
    commandId: 'reject-missing-profile-artifact'
  });

  assert.equal(result.ok, false);
  assert.equal(promotion.state.preparedPromotions, 0);
});

async function interruptGatedIntegration(fixture, candidateWorkspace, promotion) {
  const uncertain = {
    verifyChangeSet: (changeSet) => promotion.verifyChangeSet(changeSet),
    async promotePrepared() {
      const error = new Error('Simulated Integration promotion outage.');
      error.code = 'SIMULATED_PROMOTION_OUTAGE';
      throw error;
    },
    async inspectPrepared() {
      const error = new Error('Simulated Integration inspection outage.');
      error.code = 'SIMULATED_INSPECTION_OUTAGE';
      throw error;
    }
  };
  return fixture.app.integrateChangeSetGated({
    changeSetId: fixture.changeSet.id,
    targetRef: 'main',
    candidateWorkspace,
    promotion: uncertain,
    evaluator: new CommandEvaluator(),
    profile: gateProfile('recovery-integration-artifact-binding'),
    evaluationWorkspace: fixture.evaluationWorkspace,
    regressionGate: syntheticPassingGate,
    commandId: 'interrupt-integration-candidate-promotion'
  });
}

test('Integration recovery must parse and bind candidate artifacts before retrying promote',
  async (t) => {
    const fixture = await acceptedFixture(t);
    const promotion = fakePromotion(fixture.evaluationWorkspace, fixture.changeSet.baseRevision);
    const interrupted = await interruptGatedIntegration(
      fixture,
      fakeCandidateWorkspace(),
      promotion
    );
    assert.equal(interrupted.integration.status, 'recovery-required');
    const corruptArtifacts = corruptCandidateGets(
      fixture.durableArtifacts,
      interrupted.integration.patchArtifact,
      interrupted.integration.executionArtifact
    );
    const recoveryApp = new FwaApplication(fixture.root, { artifacts: corruptArtifacts });
    const recoveryPromotion = {
      verifyChangeSet: (changeSet) => promotion.verifyChangeSet(changeSet),
      promote: (request) => promotion.promote(request),
      inspect: (request) => promotion.inspect(request),
      promotePrepared: (request) => promotion.promotePrepared(request),
      inspectPrepared: (request) => promotion.inspectPrepared(request)
    };
    const recovered = await recoveryApp.reconcileIntegration({
      workspace: recoveryPromotion,
      candidateWorkspace: fakeCandidateWorkspace(),
      correlationId: 'recover-with-forged-integration-candidate-artifacts'
    });

    assert.equal(promotion.state.preparedInspections, 0,
      'Integration recovery inspected/promoted Git before parsing candidate artifacts');
    assert.equal(promotion.state.preparedPromotions, 0);
    assert.equal(recovered.integration.status, 'recovery-required');
    assert.equal(corruptArtifacts.state.patchGets > 0, true);
    assert.equal(corruptArtifacts.state.executionGets > 0, true);
  });

test('Reversion recovery must parse and bind candidate artifacts before retrying promote',
  async (t) => {
    const fixture = await acceptedFixture(t);
    const promotion = fakePromotion(fixture.evaluationWorkspace, fixture.changeSet.baseRevision);
    await exactIntegrate(fixture, promotion);
    promotion.state.preparedPromotions = 0;
    promotion.state.preparedInspections = 0;
    const uncertain = {
      verifyChangeSet: (changeSet) => promotion.verifyChangeSet(changeSet),
      async promotePrepared() {
        const error = new Error('Simulated Reversion promotion outage.');
        error.code = 'SIMULATED_REVERSION_PROMOTION_OUTAGE';
        throw error;
      },
      async inspectPrepared() {
        const error = new Error('Simulated Reversion inspection outage.');
        error.code = 'SIMULATED_REVERSION_INSPECTION_OUTAGE';
        throw error;
      }
    };
    const interrupted = await fixture.app.revertChangeSet({
      changeSetId: fixture.changeSet.id,
      targetRef: 'main',
      candidateWorkspace: fakeCandidateWorkspace(),
      promotion: uncertain,
      evaluator: new CommandEvaluator(),
      profile: gateProfile('recovery-reversion-artifact-binding'),
      evaluationWorkspace: fixture.evaluationWorkspace,
      regressionGate: syntheticPassingGate,
      commandId: 'interrupt-reversion-candidate-promotion'
    });
    assert.equal(interrupted.reversion.status, 'recovery-required');
    const corruptArtifacts = corruptCandidateGets(
      fixture.durableArtifacts,
      interrupted.reversion.patchArtifact,
      interrupted.reversion.executionArtifact
    );
    const recoveryApp = new FwaApplication(fixture.root, { artifacts: corruptArtifacts });
    const recovered = await recoveryApp.reconcileReversion({
      promotion: {
        promotePrepared: (request) => promotion.promotePrepared(request),
        inspectPrepared: (request) => promotion.inspectPrepared(request)
      },
      candidateWorkspace: fakeCandidateWorkspace(),
      correlationId: 'recover-with-forged-reversion-candidate-artifacts'
    });

    assert.equal(promotion.state.preparedInspections, 0,
      'Reversion recovery inspected/promoted Git before parsing candidate artifacts');
    assert.equal(promotion.state.preparedPromotions, 0);
    assert.equal(recovered.reversion.status, 'recovery-required');
    assert.equal(corruptArtifacts.state.patchGets > 0, true);
    assert.equal(corruptArtifacts.state.executionGets > 0, true);
  });
