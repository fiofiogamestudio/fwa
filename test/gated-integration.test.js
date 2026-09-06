import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
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

const ZERO_REF_HASH = `sha256:${'0'.repeat(64)}`;

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
    child.on('close', (status, signal) => {
      const result = {
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (!allowedExitCodes.includes(status)) {
        reject(new Error(
          `${executable} ${arguments_.join(' ')} exited ${String(status)}: ${result.stderr}`
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function git(cwd, arguments_, options = {}) {
  return run('git', arguments_, { cwd, ...options });
}

async function gitLine(cwd, arguments_) {
  return (await git(cwd, arguments_)).stdout.trim();
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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

function acceptanceProfile(nodeId) {
  return {
    schemaVersion: 1,
    id: `${nodeId}-acceptance`,
    checks: [check(`${nodeId}-accepted`, 'command', 'process.exit(0)')]
  };
}

function regressionProfile({ failTests = false } = {}) {
  return {
    schemaVersion: 1,
    id: failTests ? 'gated-regression-failing' : 'gated-regression-passing',
    checks: [
      check(
        'compile-candidate',
        'compile',
        "const fs=require('node:fs');const ok=fs.readFileSync('source.txt','utf8').trim()==='source'&&fs.readFileSync('target.txt','utf8').trim()==='target';process.exit(ok?0:8)"
      ),
      check('test-candidate', 'test', `process.exit(${failTests ? 9 : 0})`)
    ]
  };
}

function reversionProfile({ failTests = false } = {}) {
  return {
    schemaVersion: 1,
    id: failTests ? 'gated-reversion-failing' : 'gated-reversion-passing',
    checks: [
      check(
        'compile-reverted-candidate',
        'compile',
        "const fs=require('node:fs');const ok=!fs.existsSync('source.txt')&&fs.readFileSync('target.txt','utf8').trim()==='target';process.exit(ok?0:8)"
      ),
      check(
        'test-reverted-candidate',
        'test',
        `process.exit(${failTests ? 9 : 0})`
      )
    ]
  };
}

async function acceptNext({ app, workspace, nodeId, filePath, content }) {
  const produced = await app.runNext({
    executor: new FileOperationsExecutor(),
    workspace,
    input: {
      schemaVersion: 1,
      operations: [{ type: 'write', path: filePath, content }]
    },
    commandId: `produce-${nodeId}`
  });
  assert.equal(produced.ok, true);
  assert.equal(produced.node.id, nodeId);
  const evaluated = await app.evaluateChangeSet({
    changeSetId: produced.changeSet.id,
    profile: acceptanceProfile(nodeId),
    evaluator: new CommandEvaluator(),
    workspace,
    commandId: `evaluate-${nodeId}`
  });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.node.status, 'accepted');
  return produced.changeSet;
}

async function divergentAcceptedFixture(t, {
  conflict = false,
  includeDownstream = false,
  logicalRefInvalidation = false,
  caseInsensitiveRefs = false
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-gated-integration-'));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25
  }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Gated Integration Test']);
  await git(root, ['config', 'user.email', 'fwa-gated-test@example.invalid']);
  await git(root, [
    'config', 'core.ignorecase', caseInsensitiveRefs ? 'true' : 'false'
  ]);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  if (conflict) await writeFile(path.join(root, 'conflict.txt'), 'base\n', 'utf8');
  await git(root, ['add', '-A', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'test: establish gated base']);
  const baseRevision = await gitLine(root, ['rev-parse', 'HEAD']);

  const app = new FwaApplication(root);
  await app.init();
  if (logicalRefInvalidation) {
    await app.registerRef({
      commandId: 'register-gated-source-ref',
      ref: {
        id: 'ref://code/gated-source',
        kind: 'code',
        uri: caseInsensitiveRefs ? 'Source.txt' : 'source.txt',
        version: 'initial',
        hash: ZERO_REF_HASH,
        metadata: {}
      }
    });
  }
  const goal = await app.createGoal({
    title: 'Exercise gated integration',
    request: 'Merge one accepted branch after another accepted branch advances main.',
    commandId: 'create-gated-goal'
  });
  const sourcePath = conflict ? 'conflict.txt' : 'source.txt';
  const targetPath = conflict ? 'conflict.txt' : 'target.txt';
  const nodes = [{
    id: 'source',
    dependsOn: [],
    reads: ['seed.txt'],
    writes: logicalRefInvalidation
      ? ['ref://code/gated-source']
      : [sourcePath],
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    acceptance: { checks: ['source-accepted'] },
    budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 50 }
  }, {
    id: 'target',
    dependsOn: [],
    reads: logicalRefInvalidation
      ? ['seed.txt', 'ref://code/gated-source']
      : ['seed.txt'],
    writes: [targetPath],
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    acceptance: { checks: ['target-accepted'] },
    budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 50 }
  }];
  if (logicalRefInvalidation) {
    nodes.push({
      id: 'future-consumer',
      dependsOn: [],
      reads: ['ref://code/gated-source'],
      writes: ['future.txt'],
      capabilities: [FILE_OPERATIONS_CAPABILITY],
      acceptance: { checks: ['future-consumer-accepted'] },
      budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 50 }
    });
  }
  if (includeDownstream) {
    nodes.push({
      id: 'consumer',
      dependsOn: ['source'],
      reads: ['source.txt'],
      writes: ['consumer.txt'],
      capabilities: [FILE_OPERATIONS_CAPABILITY],
      acceptance: { checks: ['consumer-accepted'] },
      budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 50 }
    });
  }
  await app.loadPlan({
    goalId: goal.goal.id,
    commandId: 'load-gated-plan',
    plan: {
      schemaVersion: 1,
      nodes
    }
  });

  const workspace = new GitWorktreeAdapter(root);
  const source = await acceptNext({
    app,
    workspace,
    nodeId: 'source',
    filePath: sourcePath,
    content: conflict ? 'source\n' : 'source\n'
  });
  const target = await acceptNext({
    app,
    workspace,
    nodeId: 'target',
    filePath: targetPath,
    content: conflict ? 'target\n' : 'target\n'
  });
  assert.equal(source.baseRevision, baseRevision);
  assert.equal(target.baseRevision, baseRevision);

  const promotion = new GitIntegrationAdapter(root);
  const targetIntegration = await app.integrateChangeSet({
    changeSetId: target.id,
    targetRef: 'main',
    workspace: promotion,
    commandId: 'integrate-target-first'
  });
  assert.equal(targetIntegration.ok, true);
  const targetRevision = targetIntegration.integration.integratedRevision;
  assert.equal(await gitLine(root, ['rev-parse', 'refs/heads/main']), targetRevision);
  assert.equal((await git(root, ['status', '--porcelain=v1', '-z'])).stdout, '');

  return {
    root,
    app,
    source,
    targetRevision,
    candidateWorkspace: new GitIntegrationWorkspaceAdapter(root),
    promotion,
    evaluationWorkspace: workspace
  };
}

async function integrateGated(fixture, profile, commandId) {
  return fixture.app.integrateChangeSetGated({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace: fixture.candidateWorkspace,
    promotion: fixture.promotion,
    evaluator: new CommandEvaluator(),
    profile,
    evaluationWorkspace: fixture.evaluationWorkspace,
    commandId
  });
}

async function integratedGatedFixture(t, { includeDownstream = false } = {}) {
  const fixture = await divergentAcceptedFixture(t, { includeDownstream });
  const integrationResult = await integrateGated(
    fixture,
    regressionProfile(),
    'gated-merge-before-revert'
  );
  assert.equal(integrationResult.ok, true, JSON.stringify(integrationResult, null, 2));
  return { ...fixture, integrationResult };
}

test('gated integration promotes an exact two-parent merge candidate', async (t) => {
  const fixture = await divergentAcceptedFixture(t);
  const result = await integrateGated(
    fixture,
    regressionProfile(),
    'gated-merge-pass'
  );

  assert.equal(result.ok, true);
  assert.equal(result.integration.status, 'integrated');
  assert.equal(result.integration.regressionEvidence.result, 'pass');
  assert.deepEqual(result.integration.changedFiles, ['source.txt']);
  assert.deepEqual(result.integration.changedRefIds, []);
  assert.equal((await fixture.app.artifacts.verify(result.integration.patchArtifact)).ok, true);
  assert.equal((await fixture.app.artifacts.verify(
    result.integration.executionArtifact
  )).ok, true);
  assert.deepEqual(result.integration.candidateParents, [
    fixture.targetRevision,
    fixture.source.headRevision
  ]);
  assert.deepEqual(
    (await gitLine(fixture.root, [
      'rev-list', '--parents', '-n', '1', result.integration.integratedRevision
    ])).split(' '),
    [result.integration.integratedRevision, fixture.targetRevision, fixture.source.headRevision]
  );
  assert.equal(
    await gitLine(fixture.root, ['rev-parse', 'refs/heads/main']),
    result.integration.integratedRevision
  );
  assert.equal(await readFile(path.join(fixture.root, 'source.txt'), 'utf8'), 'source\n');
  assert.equal(await readFile(path.join(fixture.root, 'target.txt'), 'utf8'), 'target\n');
  assert.equal(result.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(await pathExists(result.integration.candidateWorkspacePath), false);
  assert.equal(
    await gitLine(fixture.root, ['show-ref', '--verify', '--hash', result.integration.candidateRef]),
    result.integration.integratedRevision
  );
});

test('integration advances a Ref and stales only materialized consumers of its old version', async (t) => {
  const fixture = await divergentAcceptedFixture(t, { logicalRefInvalidation: true });
  const result = await integrateGated(
    fixture,
    regressionProfile(),
    'gated-merge-ref-invalidation'
  );

  assert.equal(result.ok, true);
  assert.equal(result.integration.status, 'integrated');
  assert.deepEqual(result.integration.changedFiles, ['source.txt']);
  assert.deepEqual(result.integration.changedRefIds, ['ref://code/gated-source']);
  assert.deepEqual(result.integration.affectedNodeIds, ['target']);
  assert.deepEqual(result.integration.recomputeRootNodeIds, ['target']);
  const status = await fixture.app.getStatus();
  const source = status.nodes.find((node) => node.id === 'source');
  const target = status.nodes.find((node) => node.id === 'target');
  const future = status.nodes.find((node) => node.id === 'future-consumer');
  const ref = status.refs.find((candidate) => candidate.id === 'ref://code/gated-source');
  assert.equal(source.validity, 'valid');
  assert.equal(target.status, 'accepted');
  assert.equal(target.integrationStatus, 'integrated');
  assert.equal(target.validity, 'stale');
  assert.deepEqual(target.staleByIntegrationIds, [result.integration.id]);
  assert.equal(future.status, 'ready');
  assert.equal(future.validity, 'valid');
  assert.deepEqual(future.staleByIntegrationIds, []);
  assert.equal(ref.version, result.integration.integratedRevision);
  assert.equal(status.goals[0].status, 'active');
  assert.deepEqual(
    (await fixture.app.listEvents())
      .filter((event) => event.type === 'NodeMarkedStale')
      .map((event) => event.payload),
    [{
      integrationId: result.integration.id,
      nodeId: 'target',
      sourceNodeId: 'source',
      changedRefIds: ['ref://code/gated-source'],
      recomputeRoot: true
    }]
  );
});

test('gated integration matches case-only Ref URIs when Git ignorecase is enabled', async (t) => {
  const fixture = await divergentAcceptedFixture(t, {
    logicalRefInvalidation: true,
    caseInsensitiveRefs: true
  });
  const result = await integrateGated(
    fixture,
    regressionProfile(),
    'gated-merge-case-insensitive-ref'
  );

  assert.equal(result.ok, true, JSON.stringify(result.integration, null, 2));
  assert.deepEqual(result.integration.changedFiles, ['source.txt']);
  assert.deepEqual(result.integration.changedRefIds, ['ref://code/gated-source']);
  const status = await fixture.app.getStatus();
  assert.equal(
    status.refs.find((ref) => ref.id === 'ref://code/gated-source').version,
    result.integration.integratedRevision
  );
  const advanced = (await fixture.app.listEvents()).find(
    (event) => event.type === 'RefVersionAdvanced'
      && event.payload.integrationId === result.integration.id
  );
  assert.deepEqual(advanced.payload.changedFiles, ['source.txt']);
  assert.equal(advanced.payload.refId, 'ref://code/gated-source');
});

test('candidate effects follow a target rename for merge, Ref invalidation, and revert', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-gated-rename-effects-'));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25
  }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Rename Effects Test']);
  await git(root, ['config', 'user.email', 'fwa-rename-effects@example.invalid']);
  await git(root, ['config', 'core.ignorecase', 'false']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'old.txt'), 'base\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  await git(root, ['add', '-A', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'test: establish rename base']);

  const app = new FwaApplication(root);
  const workspace = new GitWorktreeAdapter(root);
  const promotion = new GitIntegrationAdapter(root);
  const candidateWorkspace = new GitIntegrationWorkspaceAdapter(root);
  const evaluator = new CommandEvaluator();
  await app.init();
  for (const [id, uri] of [
    ['ref://code/old-name', 'old.txt'],
    ['ref://code/new-name', 'new.txt']
  ]) {
    await app.registerRef({
      commandId: `register-${id.split('/').at(-1)}`,
      ref: { id, kind: 'code', uri, version: 'initial', hash: ZERO_REF_HASH, metadata: {} }
    });
  }
  const goal = await app.createGoal({
    title: 'Track candidate effects through a rename',
    commandId: 'create-rename-effects-goal'
  });
  await app.loadPlan({
    goalId: goal.goal.id,
    commandId: 'load-rename-effects-plan',
    plan: {
      schemaVersion: 1,
      nodes: [{
        id: 'rename-source',
        dependsOn: [],
        reads: ['seed.txt'],
        writes: ['ref://code/old-name'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['rename-source-accepted'] },
        budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 50 }
      }, {
        id: 'rename-target',
        dependsOn: [],
        reads: ['seed.txt'],
        writes: ['ref://code/old-name', 'ref://code/new-name'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['rename-target-accepted'] },
        budget: { maxRetries: 1, maxFiles: 3, maxDiffLines: 50 }
      }, {
        id: 'rename-consumer',
        dependsOn: ['rename-source'],
        reads: ['ref://code/new-name'],
        writes: ['consumer.txt'],
        capabilities: [FILE_OPERATIONS_CAPABILITY],
        acceptance: { checks: ['rename-consumer-accepted'] },
        budget: { maxRetries: 1, maxFiles: 2, maxDiffLines: 50 }
      }]
    }
  });

  const produceAndAccept = async (nodeId, operations) => {
    const produced = await app.runNext({
      executor: new FileOperationsExecutor(),
      workspace,
      input: { schemaVersion: 1, operations },
      commandId: `produce-${nodeId}`
    });
    assert.equal(produced.ok, true, JSON.stringify(produced, null, 2));
    assert.equal(produced.node.id, nodeId);
    const evaluated = await app.evaluateChangeSet({
      changeSetId: produced.changeSet.id,
      profile: acceptanceProfile(nodeId),
      evaluator,
      workspace,
      commandId: `evaluate-${nodeId}`
    });
    assert.equal(evaluated.ok, true, JSON.stringify(evaluated, null, 2));
    return produced.changeSet;
  };

  const source = await produceAndAccept('rename-source', [{
    type: 'write', path: 'old.txt', content: 'source\n'
  }]);
  assert.deepEqual(source.changedFiles, ['old.txt']);
  assert.deepEqual(source.changedRefIds, ['ref://code/old-name']);
  const target = await produceAndAccept('rename-target', [{
    type: 'delete', path: 'old.txt'
  }, {
    type: 'write', path: 'new.txt', content: 'base\n'
  }]);
  const targetResult = await app.integrateChangeSet({
    changeSetId: target.id,
    targetRef: 'main',
    workspace: promotion,
    commandId: 'integrate-rename-target'
  });
  assert.equal(targetResult.ok, true, JSON.stringify(targetResult, null, 2));

  const renamedProfile = {
    schemaVersion: 1,
    id: 'renamed-merge-regression',
    checks: [check(
      'compile-renamed-candidate',
      'compile',
      "const fs=require('node:fs');const ok=!fs.existsSync('old.txt')&&fs.readFileSync('new.txt','utf8')==='source\\n';process.exit(ok?0:8)"
    ), check('test-renamed-candidate', 'test', 'process.exit(0)')]
  };
  const merged = await app.integrateChangeSetGated({
    changeSetId: source.id,
    targetRef: 'main',
    candidateWorkspace,
    promotion,
    evaluator,
    profile: renamedProfile,
    evaluationWorkspace: workspace,
    commandId: 'integrate-source-through-rename'
  });
  assert.equal(merged.ok, true, JSON.stringify(merged, null, 2));
  assert.deepEqual(merged.integration.changedFiles, ['new.txt']);
  assert.deepEqual(merged.integration.changedRefIds, ['ref://code/new-name']);
  assert.equal((await app.artifacts.verify(merged.integration.patchArtifact)).ok, true);
  assert.equal((await app.artifacts.verify(merged.integration.executionArtifact)).ok, true);
  let status = await app.getStatus();
  assert.equal(
    status.refs.find((ref) => ref.id === 'ref://code/new-name').version,
    merged.integration.integratedRevision
  );
  assert.equal(
    status.refs.find((ref) => ref.id === 'ref://code/old-name').version,
    targetResult.integration.integratedRevision
  );

  const consumer = await produceAndAccept('rename-consumer', [{
    type: 'write', path: 'consumer.txt', content: 'observed new ref\n'
  }]);
  const consumerResult = await app.integrateChangeSet({
    changeSetId: consumer.id,
    targetRef: 'main',
    workspace: promotion,
    commandId: 'integrate-rename-consumer'
  });
  assert.equal(consumerResult.ok, true, JSON.stringify(consumerResult, null, 2));

  const reverted = await app.revertChangeSet({
    changeSetId: source.id,
    targetRef: 'main',
    candidateWorkspace,
    promotion,
    evaluator,
    profile: {
      schemaVersion: 1,
      id: 'renamed-revert-regression',
      checks: [check(
        'compile-renamed-revert',
        'compile',
        "const fs=require('node:fs');const ok=!fs.existsSync('old.txt')&&fs.readFileSync('new.txt','utf8')==='base\\n'&&fs.existsSync('consumer.txt');process.exit(ok?0:8)"
      ), check('test-renamed-revert', 'test', 'process.exit(0)')]
    },
    evaluationWorkspace: workspace,
    commandId: 'revert-source-through-rename'
  });
  assert.equal(reverted.ok, true, JSON.stringify(reverted, null, 2));
  assert.deepEqual(reverted.reversion.changedFiles, ['new.txt']);
  assert.deepEqual(reverted.reversion.changedRefIds, ['ref://code/new-name']);
  assert.deepEqual(reverted.revertChangeSet.changedFiles, ['new.txt']);
  assert.deepEqual(reverted.revertChangeSet.changedRefIds, ['ref://code/new-name']);
  assert.deepEqual(reverted.reversion.affectedNodeIds, ['rename-consumer']);
  status = await app.getStatus();
  const consumerNode = status.nodes.find((node) => node.id === 'rename-consumer');
  assert.equal(consumerNode.validity, 'stale');
  assert.deepEqual(consumerNode.staleByReversionIds, [reverted.reversion.id]);
});

test('a physical merge conflict records details and never moves the target', async (t) => {
  const fixture = await divergentAcceptedFixture(t, { conflict: true });
  const result = await integrateGated(
    fixture,
    regressionProfile(),
    'gated-merge-conflict'
  );

  assert.equal(result.ok, false);
  assert.equal(result.integration.status, 'conflicted');
  assert.equal(result.integration.candidateRevision, null);
  assert.deepEqual(result.integration.conflicts.map((entry) => entry.path), ['conflict.txt']);
  assert.equal(await gitLine(fixture.root, ['rev-parse', 'refs/heads/main']), fixture.targetRevision);
  assert.equal(await readFile(path.join(fixture.root, 'conflict.txt'), 'utf8'), 'target\n');
  assert.equal(result.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(await pathExists(result.integration.candidateWorkspacePath), false);
  assert.equal((await git(fixture.root, [
    'show-ref', '--verify', '--quiet', result.integration.candidateRef
  ], { allowedExitCodes: [0, 1] })).status, 1);
});

test('a failed candidate regression retains evidence but never moves the target', async (t) => {
  const fixture = await divergentAcceptedFixture(t);
  const result = await integrateGated(
    fixture,
    regressionProfile({ failTests: true }),
    'gated-merge-regression-fail'
  );

  assert.equal(result.ok, false);
  assert.equal(result.integration.status, 'failed');
  assert.equal(result.integration.phase, 'regression');
  assert.equal(result.integration.failure.code, 'INTEGRATION_REGRESSION_REJECTED');
  assert.equal(result.integration.regressionEvidence.result, 'fail');
  assert.equal(result.integration.regressionEvidence.regressionResult, 'fail');
  assert.equal(await gitLine(fixture.root, ['rev-parse', 'refs/heads/main']), fixture.targetRevision);
  assert.equal(await readFile(path.join(fixture.root, 'target.txt'), 'utf8'), 'target\n');
  assert.equal(await pathExists(path.join(fixture.root, 'source.txt')), false);
  assert.deepEqual(result.integration.candidateParents, [
    fixture.targetRevision,
    fixture.source.headRevision
  ]);
  assert.equal(result.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(await pathExists(result.integration.candidateWorkspacePath), false);
  assert.equal(
    await gitLine(fixture.root, ['show-ref', '--verify', '--hash', result.integration.candidateRef]),
    result.integration.candidateRevision
  );
  assert.equal((await git(fixture.root, [
    'merge-base', '--is-ancestor', result.integration.candidateRevision, 'refs/heads/main'
  ], { allowedExitCodes: [0, 1] })).status, 1);
  let verification;
  try {
    verification = await fixture.app.verify({ integration: fixture.promotion });
  } catch (error) {
    assert.fail(JSON.stringify({ code: error.code, details: error.details }, null, 2));
  }
  assert.ok(verification.gitVerifiedCandidateCount >= 1);
  await git(fixture.root, [
    'update-ref', '-d', result.integration.candidateRef, result.integration.candidateRevision
  ]);
  await assert.rejects(
    fixture.app.verify({ integration: fixture.promotion }),
    (error) => error.code === 'candidate-ref-mismatch'
  );
});

test('a failed Reversion candidate must retain its durable Git ref', async (t) => {
  const fixture = await integratedGatedFixture(t);
  const result = await fixture.app.revertChangeSet({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace: fixture.candidateWorkspace,
    promotion: fixture.promotion,
    evaluator: new CommandEvaluator(),
    profile: reversionProfile({ failTests: true }),
    evaluationWorkspace: fixture.evaluationWorkspace,
    commandId: 'revert-gated-regression-fail'
  });

  assert.equal(result.ok, false);
  assert.equal(result.reversion.status, 'failed');
  assert.equal(result.reversion.phase, 'regression');
  assert.equal(result.reversion.failure.code, 'REVERSION_REGRESSION_REJECTED');
  assert.equal(result.reversion.regressionEvidence.result, 'fail');
  assert.equal(
    await gitLine(fixture.root, [
      'show-ref', '--verify', '--hash', result.reversion.candidateRef
    ]),
    result.reversion.candidateRevision
  );
  assert.ok((await fixture.app.verify({ integration: fixture.promotion }))
    .gitVerifiedCandidateCount >= 2);
  await git(fixture.root, [
    'update-ref', '-d', result.reversion.candidateRef, result.reversion.candidateRevision
  ]);
  await assert.rejects(
    fixture.app.verify({ integration: fixture.promotion }),
    (error) => error.code === 'candidate-ref-mismatch'
  );
});

test('a gated merge can be reverted through regression and CAS without erasing history', async (t) => {
  const fixture = await integratedGatedFixture(t, { includeDownstream: true });
  const mergeRevision = fixture.integrationResult.integration.integratedRevision;
  assert.equal((await fixture.app.getStatus()).nodes.find(
    (node) => node.id === 'consumer'
  ).status, 'ready');

  const result = await fixture.app.revertChangeSet({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace: fixture.candidateWorkspace,
    promotion: fixture.promotion,
    evaluator: new CommandEvaluator(),
    profile: reversionProfile(),
    evaluationWorkspace: fixture.evaluationWorkspace,
    commandId: 'revert-gated-merge'
  });

  assert.equal(result.ok, true, JSON.stringify(result.reversion, null, 2));
  assert.equal(result.reversion.status, 'reverted');
  assert.equal(result.reversion.revertedRevision, mergeRevision);
  assert.equal(result.reversion.regressionEvidence.result, 'pass');
  assert.deepEqual(result.reversion.candidateParents, [mergeRevision]);
  assert.deepEqual(result.reversion.changedFiles, ['source.txt']);
  assert.deepEqual(result.reversion.changedRefIds, []);
  assert.equal(result.revertChangeSet.kind, 'revert');
  assert.equal(result.revertChangeSet.revertsChangeSetId, fixture.source.id);
  assert.equal(result.revertChangeSet.baseRevision, mergeRevision);
  assert.equal(result.revertChangeSet.headRevision, result.reversion.candidateRevision);
  assert.deepEqual(result.revertChangeSet.commits, [result.reversion.candidateRevision]);
  assert.deepEqual(result.revertChangeSet.changedFiles, ['source.txt']);
  assert.deepEqual(
    (await gitLine(fixture.root, [
      'rev-list', '--parents', '-n', '1', result.reversion.candidateRevision
    ])).split(' '),
    [result.reversion.candidateRevision, mergeRevision]
  );
  assert.equal(
    await gitLine(fixture.root, ['show', '-s', '--format=%s', result.reversion.candidateRevision]),
    `fwa(${result.reversion.id}): revert ${mergeRevision}`
  );
  assert.equal(
    await gitLine(fixture.root, ['rev-parse', 'refs/heads/main']),
    result.reversion.candidateRevision
  );
  assert.equal(await pathExists(path.join(fixture.root, 'source.txt')), false);
  assert.equal(await readFile(path.join(fixture.root, 'target.txt'), 'utf8'), 'target\n');
  assert.equal(
    await gitLine(fixture.root, ['show', `${mergeRevision}:source.txt`]),
    'source'
  );
  assert.equal((await git(fixture.root, [
    'merge-base', '--is-ancestor', mergeRevision, result.reversion.candidateRevision
  ], { allowedExitCodes: [0, 1] })).status, 0);
  assert.equal((await git(fixture.root, [
    'merge-base', '--is-ancestor', fixture.source.headRevision,
    result.reversion.candidateRevision
  ], { allowedExitCodes: [0, 1] })).status, 0);
  assert.deepEqual(result.reversion.affectedNodeIds, []);
  assert.deepEqual(result.reversion.recomputeRootNodeIds, []);
  const status = await fixture.app.getStatus();
  const sourceNode = status.nodes.find((node) => node.id === 'source');
  const consumer = status.nodes.find((node) => node.id === 'consumer');
  assert.equal(sourceNode.integrationStatus, 'reverted');
  assert.equal(sourceNode.validity, 'invalid');
  assert.equal(consumer.status, 'ready');
  assert.equal(consumer.validity, 'valid');
  assert.equal(status.projectRevisions.at(-1).revision, result.reversion.candidateRevision);
  assert.equal(result.cleanup.leaseReleased, true);
  assert.equal(result.cleanup.candidateWorkspaceRemoved, true);
  assert.equal(await pathExists(result.reversion.candidateWorkspacePath), false);
  assert.equal(
    await gitLine(fixture.root, [
      'show-ref', '--verify', '--hash', result.reversion.candidateRef
    ]),
    result.reversion.candidateRevision
  );
});

test('reconcileReversion records a real promotion whose response was lost', async (t) => {
  const fixture = await integratedGatedFixture(t);
  const mergeRevision = fixture.integrationResult.integration.integratedRevision;
  let promoteCalls = 0;
  const lostPromotionResponse = {
    verifyChangeSet: (changeSet) => fixture.promotion.verifyChangeSet(changeSet),
    async promotePrepared(request) {
      promoteCalls += 1;
      await fixture.promotion.promotePrepared(request);
      const error = new Error('Simulated crash after revert promotion.');
      error.code = 'SIMULATED_REVERSION_RESPONSE_LOST';
      throw error;
    },
    async inspectPrepared() {
      const error = new Error('Simulated inspection outage after the crash.');
      error.code = 'SIMULATED_REVERSION_INSPECTION_OUTAGE';
      throw error;
    }
  };
  const interrupted = await fixture.app.revertChangeSet({
    changeSetId: fixture.source.id,
    targetRef: 'main',
    candidateWorkspace: fixture.candidateWorkspace,
    promotion: lostPromotionResponse,
    evaluator: new CommandEvaluator(),
    profile: reversionProfile(),
    evaluationWorkspace: fixture.evaluationWorkspace,
    commandId: 'revert-with-lost-response'
  });

  assert.equal(promoteCalls, 1);
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.reversion.status, 'recovery-required');
  assert.equal(interrupted.reversion.phase, 'inspection');
  assert.equal(interrupted.reversion.regressionEvidence.result, 'pass');
  assert.equal(
    await gitLine(fixture.root, ['rev-parse', 'refs/heads/main']),
    interrupted.reversion.candidateRevision
  );
  assert.deepEqual(interrupted.reversion.candidateParents, [mergeRevision]);
  assert.equal(interrupted.cleanup.leaseReleased, true);
  assert.equal(interrupted.cleanup.candidateWorkspaceRemoved, true);

  let recoveryPromoteCalls = 0;
  const recoveringPromotion = {
    inspectPrepared: (request) => fixture.promotion.inspectPrepared(request),
    async promotePrepared(request) {
      recoveryPromoteCalls += 1;
      return fixture.promotion.promotePrepared(request);
    }
  };
  const reconciled = await fixture.app.reconcileReversion({
    promotion: recoveringPromotion,
    candidateWorkspace: fixture.candidateWorkspace,
    correlationId: 'reconcile-lost-revert-response'
  });

  assert.equal(reconciled.ok, true, JSON.stringify(reconciled, null, 2));
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.reason, 'reversion-applied');
  assert.equal(reconciled.reversion.status, 'reverted');
  assert.equal(reconciled.reversion.candidateRevision, interrupted.reversion.candidateRevision);
  assert.equal(reconciled.revertChangeSet.kind, 'revert');
  assert.equal(recoveryPromoteCalls, 0);
  assert.equal(reconciled.cleanup.leaseReleased, true);
  assert.equal(
    await gitLine(fixture.root, ['rev-parse', 'refs/heads/main']),
    reconciled.reversion.candidateRevision
  );
  assert.equal(await pathExists(path.join(fixture.root, 'source.txt')), false);
  assert.equal(await readFile(path.join(fixture.root, 'target.txt'), 'utf8'), 'target\n');
  const verification = await fixture.app.verify({
    workspace: fixture.evaluationWorkspace,
    integration: fixture.promotion
  });
  assert.equal(verification.operationallyClean, true);
  assert.equal(verification.gitVerifiedReversionCount, 1);
});
