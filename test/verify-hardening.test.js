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
import { GitIntegrationAdapter } from '../src/adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';
import { stableStringify } from '../src/core/events.js';

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

function check(id, kind, source) {
  return {
    id,
    kind,
    command: process.execPath,
    args: ['-e', source],
    timeoutMs: 10_000,
    expectedExitCodes: [0]
  };
}

async function acceptedFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-verify-hardening-'));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25
  }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Verify Test']);
  await git(root, ['config', 'user.email', 'fwa-verify@example.invalid']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  await git(root, ['add', '-A', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'test: establish verify base']);

  const app = new FwaApplication(root);
  await app.init();
  const created = await app.createGoal({
    title: 'Verify exact target evidence',
    commandId: 'create-verify-goal'
  });
  await app.loadPlan({
    goalId: created.goal.id,
    commandId: 'load-verify-plan',
    plan: {
      schemaVersion: 1,
      nodes: [{
        id: 'produce',
        dependsOn: [],
        reads: ['seed.txt'],
        writes: ['generated/**'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['generated-exists'] },
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
        content: 'verified\n'
      }]
    },
    commandId: 'produce-verify-change'
  });
  await app.evaluateChangeSet({
    changeSetId: produced.changeSet.id,
    profile: {
      schemaVersion: 1,
      id: 'verify-acceptance',
      checks: [check('generated-exists', 'command',
        "const fs=require('node:fs');process.exit(fs.existsSync('generated/output.txt')?0:9)")]
    },
    evaluator: new CommandEvaluator(),
    workspace: evaluationWorkspace,
    commandId: 'evaluate-verify-change'
  });
  return {
    root,
    app,
    changeSet: produced.changeSet,
    promotion: new GitIntegrationAdapter(root),
    evaluationWorkspace,
    candidateWorkspace: new GitIntegrationWorkspaceAdapter(root)
  };
}

async function integratedFixture(t) {
  const fixture = await acceptedFixture(t);
  const integrated = await fixture.app.integrateChangeSet({
    changeSetId: fixture.changeSet.id,
    targetRef: 'main',
    workspace: fixture.promotion,
    commandId: 'integrate-verify-change'
  });
  assert.equal(integrated.ok, true);
  return fixture;
}

function fakeCandidateWorkspace() {
  let serial = 0;
  const nextObjectId = () => {
    serial += 1;
    return (serial % 15 + 1).toString(16).repeat(40);
  };
  return {
    async prepareMerge(request) {
      const candidateRevision = nextObjectId();
      return {
        disposition: 'prepared',
        kind: 'merge',
        integrationId: request.integrationId,
        targetRef: request.targetRef,
        expectedTargetRevision: request.expectedTargetRevision,
        sourceRevision: request.sourceRevision,
        workspacePath: path.join('synthetic', request.integrationId, 'worktree'),
        candidateRef: `refs/fwa/integrations/${request.integrationId}/candidate`,
        candidateRevision,
        candidateTree: nextObjectId(),
        parents: [request.expectedTargetRevision, request.sourceRevision],
        changedFiles: ['generated/output.txt'],
        changes: [{ status: 'M', path: 'generated/output.txt' }],
        patch: `synthetic merge ${candidateRevision}\n`,
        conflicts: []
      };
    },
    async prepareRevert(request) {
      const candidateRevision = nextObjectId();
      return {
        disposition: 'prepared',
        kind: 'revert',
        integrationId: request.integrationId,
        targetRef: request.targetRef,
        expectedTargetRevision: request.expectedTargetRevision,
        revertedRevision: request.revertedRevision,
        workspacePath: path.join('synthetic', request.integrationId, 'worktree'),
        candidateRef: `refs/fwa/integrations/${request.integrationId}/candidate`,
        candidateRevision,
        candidateTree: nextObjectId(),
        parents: [request.expectedTargetRevision],
        changedFiles: ['generated/output.txt'],
        changes: [{ status: 'D', path: 'generated/output.txt' }],
        patch: `synthetic revert ${candidateRevision}\n`,
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
    async pruneCandidateRef() {
      return { removed: false, alreadyAbsent: true };
    },
    async inspectResidue() {
      return {
        ok: true,
        entries: [],
        count: 0,
        candidateRefs: [],
        candidateRefCount: 0
      };
    }
  };
}

function fakePromotion(evaluationWorkspace, baseRevision) {
  const state = {
    targetRevision: baseRevision,
    exactPromotions: 0,
    preparedPromotions: 0
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
      const observed = disposition(request);
      return {
        ...request,
        ...observed,
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
      const observed = disposition(request);
      return {
        ...request,
        ...observed,
        targetRevision: state.targetRevision,
        observedTargetRevision: state.targetRevision
      };
    }
  };
}

function gateProfile(id) {
  return {
    schemaVersion: 1,
    id,
    checks: [
      check(`${id}-compile`, 'compile', 'process.exit(0)'),
      check(`${id}-test`, 'test', 'process.exit(0)')
    ]
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
  const resultEnvelope = {
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
  };
  const resultArtifact = await options.artifacts.put(Buffer.from(
    stableStringify(resultEnvelope),
    'utf8'
  ));
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

function artifactFaultStore(delegate, targetDigest, kind) {
  return {
    init: (...args) => delegate.init(...args),
    put: (...args) => delegate.put(...args),
    listRefs: (...args) => delegate.listRefs(...args),
    async verify(ref) {
      if (kind === 'missing' && ref.digest === targetDigest) {
        const error = new Error('Simulated missing gate artifact.');
        error.code = 'artifact-not-found';
        throw error;
      }
      return delegate.verify(ref);
    },
    async get(ref) {
      const bytes = await delegate.get(ref);
      if (kind !== 'tampered' || ref.digest !== targetDigest) return bytes;
      const envelope = JSON.parse(bytes.toString('utf8'));
      envelope.environmentFingerprint.runtime.version = 'tampered';
      return Buffer.from(stableStringify(envelope), 'utf8');
    }
  };
}

async function exactIntegrateWithFakePromotion(fixture, promotion) {
  const integrated = await fixture.app.integrateChangeSet({
    changeSetId: fixture.changeSet.id,
    targetRef: 'main',
    workspace: promotion,
    commandId: 'integrate-before-forged-reversion'
  });
  assert.equal(integrated.ok, true);
  return integrated;
}

async function fakeIntegratedFixture(t) {
  const fixture = await acceptedFixture(t);
  const promotion = fakePromotion(
    fixture.evaluationWorkspace,
    fixture.changeSet.baseRevision
  );
  await exactIntegrateWithFakePromotion(fixture, promotion);
  return {
    ...fixture,
    promotion,
    candidateWorkspace: fakeCandidateWorkspace(),
    integratedTarget: promotion.state.targetRevision
  };
}

async function revertIntegrated(fixture, evaluationWorkspace = fixture.evaluationWorkspace) {
  return fixture.app.revertChangeSet({
    changeSetId: fixture.changeSet.id,
    targetRef: 'main',
    candidateWorkspace: fixture.candidateWorkspace,
    promotion: fixture.promotion,
    evaluator: new CommandEvaluator(),
    profile: {
      schemaVersion: 1,
      id: 'verify-reversion',
      checks: [
        check('compile-reverted', 'compile',
          "const fs=require('node:fs');process.exit(fs.existsSync('generated/output.txt')?9:0)"),
        check('test-reverted', 'test', 'process.exit(0)')
      ]
    },
    evaluationWorkspace,
    commandId: 'revert-verify-change'
  });
}

async function addExternalCommit(root, name) {
  await writeFile(path.join(root, `${name}.txt`), `${name}\n`, 'utf8');
  await git(root, ['add', '-A', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', `test: ${name}`]);
}

test('verify rejects advanced for the latest Integration project revision', async (t) => {
  const fixture = await integratedFixture(t);
  assert.equal((await fixture.app.verify({ integration: fixture.promotion })).operationallyClean, true);

  await addExternalCommit(fixture.root, 'unexpected-advance');
  await assert.rejects(
    fixture.app.verify({ integration: fixture.promotion }),
    (error) => error.code === 'integration-git-evidence-mismatch'
      && error.details.disposition === 'advanced'
      && error.details.isLatest === true
  );
});

test('verify binds Reversion artifacts, accepts historical lineage, and rejects a latest advance',
  async (t) => {
    const fixture = await integratedFixture(t);
    const reverted = await revertIntegrated(fixture);
    assert.equal(reverted.ok, true);
    assert.equal((await fixture.app.verify({
      integration: fixture.promotion
    })).operationallyClean, true);

    const target = reverted.reversion.regressionEvidence.resultArtifact;
    const verifiedDigests = [];
    const delegate = fixture.app.artifacts;
    const forgedArtifacts = {
      init: (...args) => delegate.init(...args),
      put: (...args) => delegate.put(...args),
      listRefs: (...args) => delegate.listRefs(...args),
      async verify(ref) {
        verifiedDigests.push(ref.digest);
        return delegate.verify(ref);
      },
      async get(ref) {
        const bytes = await delegate.get(ref);
        if (ref.digest !== target.digest) return bytes;
        const envelope = JSON.parse(bytes.toString('utf8'));
        envelope.environmentFingerprint.runtime.version = 'forged';
        return Buffer.from(stableStringify(envelope), 'utf8');
      }
    };
    const forged = new FwaApplication(fixture.root, { artifacts: forgedArtifacts });
    await assert.rejects(
      forged.verify({ integration: fixture.promotion }),
      (error) => error.code === 'evidence-result-artifact-mismatch'
    );
    assert.ok(verifiedDigests.includes(reverted.reversion.patchArtifact.digest));
    assert.ok(verifiedDigests.includes(reverted.reversion.executionArtifact.digest));

    await addExternalCommit(fixture.root, 'post-reversion-advance');
    await assert.rejects(
      fixture.app.verify({ integration: fixture.promotion }),
      (error) => error.code === 'reversion-git-evidence-mismatch'
        && error.details.disposition === 'advanced'
        && error.details.isLatest === true
    );
  });

test('verify reports failed regression cleanup as explicit operational residue', async (t) => {
  const fixture = await integratedFixture(t);
  const cleanupFailingWorkspace = {
    createEvaluation: (request) => fixture.evaluationWorkspace.createEvaluation(request),
    inspectEvaluation: (request) => fixture.evaluationWorkspace.inspectEvaluation(request),
    async removeEvaluation() {
      return { removed: false, alreadyAbsent: false };
    }
  };
  const failed = await revertIntegrated(fixture, cleanupFailingWorkspace);
  assert.equal(failed.ok, false);
  assert.equal(failed.reversion.regressionEvidence.cleanup.status, 'failed');
  await fixture.evaluationWorkspace.removeEvaluation({
    evaluationId: failed.reversion.id,
    force: true
  });

  const verification = await fixture.app.verify({ integration: fixture.promotion });
  assert.equal(verification.operationallyClean, false);
  assert.deepEqual(verification.integrationRegressionCleanupFailures, []);
  assert.deepEqual(verification.reversionRegressionCleanupFailures, [failed.reversion.id]);
  assert.deepEqual(verification.candidateWorkspaceResidue, []);
});

test('Integration rejects forged gate surfaces and missing refs, then preserves a corrupt recovery fence',
  async (t) => {
    const fixture = await acceptedFixture(t);
    const candidateWorkspace = fakeCandidateWorkspace();
    const promotion = fakePromotion(
      fixture.evaluationWorkspace,
      fixture.changeSet.baseRevision
    );
    const evaluator = new CommandEvaluator();
    const profile = gateProfile('forged-integration-gate');
    const common = {
      changeSetId: fixture.changeSet.id,
      targetRef: 'main',
      candidateWorkspace,
      promotion,
      evaluator,
      profile,
      evaluationWorkspace: fixture.evaluationWorkspace
    };
    const initialTarget = promotion.state.targetRevision;

    const contradictory = await fixture.app.integrateChangeSetGated({
      ...common,
      commandId: 'reject-contradictory-integration-gate',
      regressionGate: async (options) => ({
        ...await syntheticPassingGate(options),
        regressionResult: 'fail'
      })
    });
    assert.equal(contradictory.ok, false);
    assert.equal(contradictory.integration.status, 'failed');
    assert.equal(
      contradictory.integration.failure.code,
      'invalid-integration-regression-result'
    );
    assert.equal(promotion.state.preparedPromotions, 0);
    assert.equal(promotion.state.targetRevision, initialTarget);

    const missing = await fixture.app.integrateChangeSetGated({
      ...common,
      commandId: 'reject-missing-integration-gate-artifact',
      regressionGate: async (options) => ({
        ...await syntheticPassingGate(options),
        resultArtifact: {
          schemaVersion: 1,
          algorithm: 'sha256',
          digest: 'f'.repeat(64),
          size: 1
        }
      })
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.integration.status, 'failed');
    assert.equal(missing.integration.failure.code, 'artifact-not-found');
    assert.equal(promotion.state.preparedPromotions, 0);
    assert.equal(promotion.state.targetRevision, initialTarget);

    let uncertainPromotions = 0;
    const uncertainPromotion = {
      verifyChangeSet: (changeSet) => promotion.verifyChangeSet(changeSet),
      async promotePrepared() {
        uncertainPromotions += 1;
        const error = new Error('Simulated lost promotion response.');
        error.code = 'SIMULATED_PROMOTION_OUTAGE';
        throw error;
      },
      async inspectPrepared() {
        const error = new Error('Simulated target inspection outage.');
        error.code = 'SIMULATED_INSPECTION_OUTAGE';
        throw error;
      }
    };
    const interrupted = await fixture.app.integrateChangeSetGated({
      ...common,
      promotion: uncertainPromotion,
      commandId: 'interrupt-integration-after-durable-gate',
      regressionGate: syntheticPassingGate
    });
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.integration.status, 'recovery-required');
    assert.equal(interrupted.integration.regressionEvidence.result, 'pass');
    assert.equal(uncertainPromotions, 1);
    assert.equal(promotion.state.targetRevision, initialTarget);

    const targetArtifact = interrupted.integration.regressionEvidence.resultArtifact;
    const corruptApp = new FwaApplication(fixture.root, {
      artifacts: artifactFaultStore(fixture.app.artifacts, targetArtifact.digest, 'missing')
    });
    let recoveryMutations = 0;
    const recoveringPromotion = {
      verifyChangeSet: (changeSet) => promotion.verifyChangeSet(changeSet),
      promote: (request) => promotion.promote(request),
      inspect: (request) => promotion.inspect(request),
      async promotePrepared(request) {
        recoveryMutations += 1;
        return promotion.promotePrepared(request);
      },
      async inspectPrepared(request) {
        recoveryMutations += 1;
        return promotion.inspectPrepared(request);
      }
    };
    const reconciled = await corruptApp.reconcileIntegration({
      workspace: recoveringPromotion,
      candidateWorkspace,
      correlationId: 'refuse-corrupt-integration-recovery'
    });
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.integration.status, 'recovery-required');
    assert.equal(recoveryMutations, 0);
    assert.equal(promotion.state.targetRevision, initialTarget);
    const status = await fixture.app.getStatus();
    assert.equal(status.integrations.find(
      (record) => record.id === interrupted.integration.id
    ).status, 'recovery-required');
  });

test('Reversion rejects forged gate surfaces and swapped refs, then preserves a tampered recovery fence',
  async (t) => {
    const evaluator = new CommandEvaluator();
    const profile = gateProfile('forged-reversion-gate');
    const surfaceFixture = await fakeIntegratedFixture(t);
    const contradictory = await surfaceFixture.app.revertChangeSet({
      changeSetId: surfaceFixture.changeSet.id,
      targetRef: 'main',
      candidateWorkspace: surfaceFixture.candidateWorkspace,
      promotion: surfaceFixture.promotion,
      evaluator,
      profile,
      evaluationWorkspace: surfaceFixture.evaluationWorkspace,
      commandId: 'reject-contradictory-reversion-gate',
      regressionGate: async (options) => ({
        ...await syntheticPassingGate(options),
        regressionResult: 'fail'
      })
    });
    assert.equal(contradictory.ok, false);
    assert.equal(contradictory.reversion.status, 'failed');
    assert.equal(
      contradictory.reversion.failure.code,
      'invalid-integration-regression-result'
    );
    assert.equal(surfaceFixture.promotion.state.preparedPromotions, 0);
    assert.equal(
      surfaceFixture.promotion.state.targetRevision,
      surfaceFixture.integratedTarget
    );

    const swappedFixture = await fakeIntegratedFixture(t);
    const swapped = await swappedFixture.app.revertChangeSet({
      changeSetId: swappedFixture.changeSet.id,
      targetRef: 'main',
      candidateWorkspace: swappedFixture.candidateWorkspace,
      promotion: swappedFixture.promotion,
      evaluator,
      profile,
      evaluationWorkspace: swappedFixture.evaluationWorkspace,
      commandId: 'reject-swapped-reversion-gate-artifact',
      regressionGate: async (options) => {
        const evidence = await syntheticPassingGate(options);
        return { ...evidence, resultArtifact: evidence.profileArtifact };
      }
    });
    assert.equal(swapped.ok, false);
    assert.equal(swapped.reversion.status, 'failed');
    assert.equal(swapped.reversion.failure.code, 'invalid-integration-regression-artifact');
    assert.equal(swappedFixture.promotion.state.preparedPromotions, 0);
    assert.equal(
      swappedFixture.promotion.state.targetRevision,
      swappedFixture.integratedTarget
    );

    const recoveryFixture = await fakeIntegratedFixture(t);
    let uncertainPromotions = 0;
    const uncertainPromotion = {
      verifyChangeSet: (changeSet) => recoveryFixture.promotion.verifyChangeSet(changeSet),
      async promotePrepared() {
        uncertainPromotions += 1;
        const error = new Error('Simulated lost reversion promotion response.');
        error.code = 'SIMULATED_REVERSION_PROMOTION_OUTAGE';
        throw error;
      },
      async inspectPrepared() {
        const error = new Error('Simulated reversion inspection outage.');
        error.code = 'SIMULATED_REVERSION_INSPECTION_OUTAGE';
        throw error;
      }
    };
    const interrupted = await recoveryFixture.app.revertChangeSet({
      changeSetId: recoveryFixture.changeSet.id,
      targetRef: 'main',
      candidateWorkspace: recoveryFixture.candidateWorkspace,
      promotion: uncertainPromotion,
      evaluator,
      profile,
      evaluationWorkspace: recoveryFixture.evaluationWorkspace,
      commandId: 'interrupt-reversion-after-durable-gate',
      regressionGate: syntheticPassingGate
    });
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.reversion.status, 'recovery-required');
    assert.equal(interrupted.reversion.regressionEvidence.result, 'pass');
    assert.equal(uncertainPromotions, 1);
    assert.equal(
      recoveryFixture.promotion.state.targetRevision,
      recoveryFixture.integratedTarget
    );

    const targetArtifact = interrupted.reversion.regressionEvidence.resultArtifact;
    const corruptApp = new FwaApplication(recoveryFixture.root, {
      artifacts: artifactFaultStore(
        recoveryFixture.app.artifacts,
        targetArtifact.digest,
        'tampered'
      )
    });
    let recoveryMutations = 0;
    const recoveringPromotion = {
      async promotePrepared(request) {
        recoveryMutations += 1;
        return recoveryFixture.promotion.promotePrepared(request);
      },
      async inspectPrepared(request) {
        recoveryMutations += 1;
        return recoveryFixture.promotion.inspectPrepared(request);
      }
    };
    const reconciled = await corruptApp.reconcileReversion({
      promotion: recoveringPromotion,
      candidateWorkspace: recoveryFixture.candidateWorkspace,
      correlationId: 'refuse-corrupt-reversion-recovery'
    });
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.reversion.status, 'recovery-required');
    assert.equal(recoveryMutations, 0);
    assert.equal(
      recoveryFixture.promotion.state.targetRevision,
      recoveryFixture.integratedTarget
    );
    const status = await recoveryFixture.app.getStatus();
    assert.equal(status.reversions.find(
      (record) => record.id === interrupted.reversion.id
    ).status, 'recovery-required');
  });
