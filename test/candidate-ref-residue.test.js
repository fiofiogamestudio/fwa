import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { GitIntegrationWorkspaceAdapter } from '../src/adapters/git-integration-workspace.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { FwaApplication } from '../src/application/fwa-application.js';

async function run(executable, arguments_, { cwd, allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env: process.env,
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

async function git(cwd, arguments_) {
  return run('git', arguments_, { cwd });
}

test('verify reports an unbound candidate ref until an exact CAS prune removes it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-candidate-ref-residue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Test']);
  await git(root, ['config', 'user.email', 'fwa-test@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'seed\n', 'utf8');
  await git(root, ['add', '-A', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'initial']);
  const revision = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  const app = new FwaApplication(root);
  await app.init();
  const candidates = new GitIntegrationWorkspaceAdapter(root);
  await assert.rejects(
    app.verify({
      candidateWorkspace: {
        async inspectResidue() {
          return { ok: true, entries: [], count: 0 };
        }
      }
    }),
    (error) => error.code === 'invalid-verification-port'
  );
  assert.equal((await app.verify({ candidateWorkspace: candidates })).operationallyClean, true);

  const candidateRef = 'refs/fwa/integrations/orphan_candidate/candidate';
  await git(root, ['update-ref', candidateRef, revision, '']);
  const dirty = await app.verify({ candidateWorkspace: candidates });
  assert.equal(dirty.ok, true);
  assert.equal(dirty.operationallyClean, false);
  assert.deepEqual(dirty.orphanCandidateRefs, [{
    integrationId: 'orphan_candidate',
    candidateRef,
    candidateRevision: revision,
    structurallyValid: true
  }]);

  const pruned = await candidates.pruneCandidateRef({
    integrationId: 'orphan_candidate',
    expectedRevision: revision
  });
  assert.equal(pruned.removed, true);
  const clean = await app.verify({ candidateWorkspace: candidates });
  assert.equal(clean.operationallyClean, true);
  assert.deepEqual(clean.orphanCandidateRefs, []);

  const malformedRef = 'refs/fwa/integrations/nested/extra/candidate';
  await git(root, ['update-ref', malformedRef, revision, '']);
  const malformed = await app.verify({ candidateWorkspace: candidates });
  assert.equal(malformed.operationallyClean, false);
  assert.deepEqual(malformed.orphanCandidateRefs, [{
    integrationId: null,
    candidateRef: malformedRef,
    candidateRevision: revision,
    structurallyValid: false
  }]);
  await git(root, ['update-ref', '-d', malformedRef, revision]);

  const symbolicRef = 'refs/fwa/integrations/symbolic_candidate/candidate';
  await git(root, ['symbolic-ref', symbolicRef, 'refs/heads/main']);
  await assert.rejects(
    app.verify({ candidateWorkspace: candidates }),
    (error) => error.code === 'symbolic-candidate-ref'
  );
  await git(root, ['symbolic-ref', '--delete', symbolicRef]);

  const workspace = new GitWorktreeAdapter(root);
  const evaluation = await workspace.createEvaluation({
    evaluationId: 'stray_evaluation',
    revision
  });
  const evaluationDirty = await app.verify({ workspace });
  assert.equal(evaluationDirty.operationallyClean, false);
  assert.deepEqual(evaluationDirty.evaluationWorkspaceResidue, [evaluation.workspacePath]);
  await workspace.removeEvaluation({
    evaluationId: 'stray_evaluation',
    workspacePath: evaluation.workspacePath,
    revision
  });
  assert.equal((await app.verify({ workspace })).operationallyClean, true);
});

test('candidate inventory includes case-variant namespaces and the direct root ref', async (t) => {
  async function repository(suffix) {
    const root = await mkdtemp(path.join(os.tmpdir(), `fwa-candidate-ref-${suffix}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'user.name', 'FWA Test']);
    await git(root, ['config', 'user.email', 'fwa-test@example.invalid']);
    await writeFile(path.join(root, 'seed.txt'), 'seed\n', 'utf8');
    await git(root, ['add', '--', 'seed.txt']);
    await git(root, ['commit', '--no-gpg-sign', '-m', 'initial']);
    return {
      root,
      revision: (await git(root, ['rev-parse', 'HEAD'])).stdout.trim()
    };
  }

  const caseVariant = await repository('case-variant');
  const caseVariantRef = 'refs/FWA/integrations/case_variant/candidate';
  await git(caseVariant.root, ['update-ref', caseVariantRef, caseVariant.revision, '']);
  assert.deepEqual(
    await new GitIntegrationWorkspaceAdapter(caseVariant.root).listCandidateRefs(),
    [{
      integrationId: null,
      candidateRef: caseVariantRef,
      candidateRevision: caseVariant.revision,
      structurallyValid: false
    }]
  );

  const directRoot = await repository('direct-root');
  const rootRef = 'refs/fwa/integrations';
  await git(directRoot.root, ['update-ref', rootRef, directRoot.revision, '']);
  assert.deepEqual(
    await new GitIntegrationWorkspaceAdapter(directRoot.root).listCandidateRefs(),
    [{
      integrationId: null,
      candidateRef: rootRef,
      candidateRevision: directRoot.revision,
      structurallyValid: false
    }]
  );

  const reservedAncestor = await repository('reserved-ancestor');
  const ancestorRef = 'refs/fwa';
  await git(reservedAncestor.root, ['update-ref', ancestorRef, reservedAncestor.revision, '']);
  assert.deepEqual(
    await new GitIntegrationWorkspaceAdapter(reservedAncestor.root).listCandidateRefs(),
    [{
      integrationId: null,
      candidateRef: ancestorRef,
      candidateRevision: reservedAncestor.revision,
      structurallyValid: false
    }]
  );
});
