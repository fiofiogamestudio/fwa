import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  GitIntegrationWorkspaceAdapter,
  GitIntegrationWorkspaceError
} from '../src/adapters/git-integration-workspace.js';

const FIXED_TIME = new Date('2026-09-06T10:15:00.000Z');
const TARGET_REF = 'refs/heads/main';
const FIXED_GIT_ENVIRONMENT = new Set([
  'GIT_TERMINAL_PROMPT',
  'GIT_OPTIONAL_LOCKS',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0'
]);
const COMMIT_GIT_ENVIRONMENT = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE'
]);

async function run(executable, arguments_, {
  cwd,
  env = process.env,
  allowedExitCodes = [0]
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env,
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
        const error = new Error(
          `${executable} ${arguments_.join(' ')} exited ${String(status)}: ${result.stderr}`
        );
        error.status = status;
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

async function git(cwd, arguments_, options) {
  return run('git', arguments_, { cwd, ...options });
}

async function gitLine(cwd, arguments_) {
  return (await git(cwd, arguments_)).stdout.trim();
}

function isWorktreeRemove(arguments_, workspacePath) {
  return arguments_[0] === 'worktree'
    && arguments_[1] === 'remove'
    && arguments_.at(-1) === workspacePath;
}

async function worktreeAdministrativePath(workspacePath) {
  const source = (await readFile(path.join(workspacePath, '.git'), 'utf8')).trim();
  assert.match(source, /^gitdir: /u);
  const administrativePath = path.resolve(workspacePath, source.slice('gitdir: '.length));
  assert.match(
    administrativePath.replaceAll('\\', '/'),
    /\/\.git\/worktrees\/[^/]+$/u
  );
  return administrativePath;
}

async function unregisterWorktreeWithoutDeleting(workspacePath) {
  const administrativePath = await worktreeAdministrativePath(workspacePath);
  await rm(administrativePath, { recursive: true, force: true });
}

function syntheticRemoveFailure() {
  const error = new Error('synthetic partial worktree removal');
  error.status = 1;
  error.result = { status: 1, signal: null, stdout: '', stderr: error.message };
  return error;
}

function assertFsmonitorDisabled(environment) {
  assert.equal(environment.GIT_CONFIG_COUNT, '1');
  assert.equal(environment.GIT_CONFIG_KEY_0, 'core.fsmonitor');
  assert.equal(environment.GIT_CONFIG_VALUE_0, 'false');
}

async function createManagedIntegrationWorktree(item, integrationId) {
  const operationDirectory = path.join(
    item.root,
    '.fwa',
    'integrations',
    integrationId
  );
  const workspacePath = path.join(operationDirectory, 'worktree');
  await mkdir(operationDirectory, { recursive: true });
  await git(item.root, [
    'worktree',
    'add',
    '--detach',
    workspacePath,
    item.baseRevision
  ]);
  return workspacePath;
}

async function commitAll(root, message) {
  await git(root, ['add', '-A', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', message]);
  return gitLine(root, ['rev-parse', 'HEAD']);
}

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-git-integration-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Test']);
  await git(root, ['config', 'user.email', 'fwa-test@example.invalid']);
  await git(root, ['config', 'core.ignorecase', 'false']);
  await writeFile(path.join(root, '.gitignore'), '/.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  for (const [filePath, contents] of Object.entries(files)) {
    await writeFile(path.join(root, filePath), contents, 'utf8');
  }
  const baseRevision = await commitAll(root, 'base');
  return { root, baseRevision };
}

function adapter(root, options = {}) {
  return new GitIntegrationWorkspaceAdapter(root, {
    clock: () => FIXED_TIME,
    ...options
  });
}

function mergeRequest(integrationId, targetRevision, sourceRevision) {
  return {
    integrationId,
    targetRef: TARGET_REF,
    expectedTargetRevision: targetRevision,
    sourceRevision
  };
}

function revertRequest(integrationId, targetRevision, revertedRevision) {
  return {
    integrationId,
    targetRef: TARGET_REF,
    expectedTargetRevision: targetRevision,
    revertedRevision
  };
}

function candidateRef(integrationId) {
  return `refs/fwa/integrations/${integrationId}/candidate`;
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

async function assertTargetAndRoot(root, targetRevision) {
  assert.equal(await gitLine(root, ['rev-parse', TARGET_REF]), targetRevision);
  assert.equal(await gitLine(root, ['rev-parse', 'HEAD']), targetRevision);
  assert.equal(await gitLine(root, ['symbolic-ref', 'HEAD']), TARGET_REF);
  assert.equal((await git(root, ['status', '--porcelain=v1', '-z'])).stdout, '');
}

function replaceProcessEnvironment(values) {
  const previous = new Map(Object.keys(values).map((key) => [
    key,
    Object.hasOwn(process.env, key) ? process.env[key] : undefined
  ]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('creates a durable two-parent merge candidate in an isolated worktree', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', '-c', 'accepted-source']);
  await git(item.root, ['mv', 'seed.txt', 'renamed-seed.txt']);
  await writeFile(path.join(item.root, 'source.txt'), 'source contribution\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source change');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'target.txt'), 'target contribution\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'target change');
  const subject = adapter(item.root);

  const prepared = await subject.prepareMerge(
    mergeRequest('merge_clean', targetRevision, sourceRevision)
  );

  assert.equal(prepared.disposition, 'prepared');
  assert.equal(prepared.kind, 'merge');
  assert.deepEqual(prepared.parents, [targetRevision, sourceRevision]);
  assert.deepEqual(prepared.changedFiles, [
    'renamed-seed.txt',
    'seed.txt',
    'source.txt'
  ]);
  assert.deepEqual(prepared.changes, [{
    status: 'renamed',
    code: 'R100',
    path: 'renamed-seed.txt',
    previousPath: 'seed.txt',
    change: 'rename'
  }, {
    status: 'deleted',
    code: 'R100',
    path: 'seed.txt',
    renamedTo: 'renamed-seed.txt',
    change: 'rename'
  }, {
    status: 'added',
    code: 'A',
    path: 'source.txt'
  }]);
  assert.match(prepared.patch, /diff --git a\/seed\.txt b\/renamed-seed\.txt/u);
  assert.match(prepared.patch, /diff --git a\/source\.txt b\/source\.txt/u);
  assert.doesNotMatch(prepared.patch, /target\.txt/u);
  assert.deepEqual(
    (await gitLine(item.root, [
      'rev-list', '--parents', '-n', '1', prepared.candidateRevision
    ])).split(' '),
    [prepared.candidateRevision, targetRevision, sourceRevision]
  );
  assert.equal(
    await gitLine(item.root, ['show-ref', '--verify', '--hash', candidateRef('merge_clean')]),
    prepared.candidateRevision
  );
  assert.equal(
    await gitLine(item.root, ['show', `${prepared.candidateRevision}:source.txt`]),
    'source contribution'
  );
  assert.equal(
    await gitLine(item.root, ['show', `${prepared.candidateRevision}:target.txt`]),
    'target contribution'
  );
  assert.equal(await gitLine(prepared.workspacePath, ['rev-parse', 'HEAD']), prepared.candidateRevision);
  assert.equal((await git(prepared.workspacePath, ['status', '--porcelain=v1', '-z'])).stdout, '');
  assert.equal((await git(item.root, [
    'merge-base', '--is-ancestor', targetRevision, prepared.candidateRevision
  ])).status, 0);
  assert.equal((await git(item.root, [
    'merge-base', '--is-ancestor', sourceRevision, prepared.candidateRevision
  ])).status, 0);
  await assertTargetAndRoot(item.root, targetRevision);

  const cleaned = await subject.cleanup({
    integrationId: 'merge_clean',
    workspacePath: prepared.workspacePath
  });
  assert.equal(cleaned.removed, true);
  assert.equal(cleaned.candidateRetained, true);
  assert.equal(await pathExists(prepared.workspacePath), false);
  await git(item.root, ['reflog', 'expire', '--expire=now', '--all']);
  await git(item.root, ['gc', '--prune=now']);
  assert.equal(
    await gitLine(item.root, ['show-ref', '--verify', '--hash', candidateRef('merge_clean')]),
    prepared.candidateRevision
  );
  await git(item.root, ['cat-file', '-e', `${prepared.candidateRevision}^{commit}`]);
});

test('returns structured content conflicts without moving or publishing the target', async (t) => {
  const item = await fixture(t, { 'conflict.txt': 'common\n' });
  await git(item.root, ['switch', '-c', 'accepted-source']);
  await writeFile(path.join(item.root, 'conflict.txt'), 'source\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source conflict');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'conflict.txt'), 'target\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'target conflict');
  const subject = adapter(item.root);

  const conflicted = await subject.prepareMerge(
    mergeRequest('merge_content_conflict', targetRevision, sourceRevision)
  );

  assert.equal(conflicted.disposition, 'conflicted');
  assert.equal(conflicted.candidateRevision, null);
  assert.deepEqual(conflicted.conflicts.map((item_) => item_.path), ['conflict.txt']);
  assert.deepEqual(
    conflicted.conflicts[0].stages.map((stage) => stage.stage),
    [1, 2, 3]
  );
  for (const stage of conflicted.conflicts[0].stages) {
    assert.match(stage.mode, /^[0-7]{6}$/u);
    assert.match(stage.blobOid, /^[a-f0-9]{40,64}$/u);
  }
  assert.equal((await git(item.root, [
    'show-ref', '--verify', '--quiet', candidateRef('merge_content_conflict')
  ], { allowedExitCodes: [0, 1] })).status, 1);
  await assertTargetAndRoot(item.root, targetRevision);

  await assert.rejects(
    subject.cleanup({
      integrationId: 'merge_content_conflict',
      workspacePath: conflicted.workspacePath
    }),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'integration-workspace-dirty'
  );
  const cleaned = await subject.cleanup({
    integrationId: 'merge_content_conflict',
    workspacePath: conflicted.workspacePath,
    force: true
  });
  assert.equal(cleaned.removed, true);
  assert.equal(cleaned.candidateRetained, false);
});

test('reports the missing side of a modify/delete conflict through index stages', async (t) => {
  const item = await fixture(t, { 'removed.txt': 'common\n' });
  await git(item.root, ['switch', '-c', 'accepted-source']);
  await writeFile(path.join(item.root, 'removed.txt'), 'source modified\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source modifies');
  await git(item.root, ['switch', 'main']);
  await rm(path.join(item.root, 'removed.txt'));
  const targetRevision = await commitAll(item.root, 'target deletes');
  const subject = adapter(item.root);

  const conflicted = await subject.prepareMerge(
    mergeRequest('merge_delete_conflict', targetRevision, sourceRevision)
  );

  assert.equal(conflicted.disposition, 'conflicted');
  assert.deepEqual(conflicted.conflicts, [{
    path: 'removed.txt',
    stages: [
      {
        stage: 1,
        mode: '100644',
        blobOid: await gitLine(item.root, ['rev-parse', `${item.baseRevision}:removed.txt`])
      },
      {
        stage: 3,
        mode: '100644',
        blobOid: await gitLine(item.root, ['rev-parse', `${sourceRevision}:removed.txt`])
      }
    ]
  }]);
  await assertTargetAndRoot(item.root, targetRevision);
  await subject.cleanup({
    integrationId: 'merge_delete_conflict',
    workspacePath: conflicted.workspacePath,
    force: true
  });
});

test('creates a single-parent revert candidate while retaining later unrelated work', async (t) => {
  const item = await fixture(t, { 'reverted.txt': 'before\n' });
  await writeFile(path.join(item.root, 'reverted.txt'), 'integrated\n', 'utf8');
  await writeFile(path.join(item.root, 'integrated-only.txt'), 'remove me\n', 'utf8');
  const revertedRevision = await commitAll(item.root, 'integrated change');
  await writeFile(path.join(item.root, 'later.txt'), 'must survive\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'later unrelated change');
  const subject = adapter(item.root);

  const prepared = await subject.prepareRevert(
    revertRequest('revert_regular', targetRevision, revertedRevision)
  );

  assert.equal(prepared.disposition, 'prepared');
  assert.equal(prepared.kind, 'revert');
  assert.equal(prepared.mainline, null);
  assert.deepEqual(prepared.parents, [targetRevision]);
  assert.deepEqual(prepared.changedFiles, ['integrated-only.txt', 'reverted.txt']);
  assert.deepEqual(prepared.changes, [{
    status: 'deleted',
    code: 'D',
    path: 'integrated-only.txt'
  }, {
    status: 'modified',
    code: 'M',
    path: 'reverted.txt'
  }]);
  assert.match(prepared.patch, /diff --git a\/integrated-only\.txt b\/integrated-only\.txt/u);
  assert.match(prepared.patch, /diff --git a\/reverted\.txt b\/reverted\.txt/u);
  assert.doesNotMatch(prepared.patch, /later\.txt/u);
  assert.deepEqual(
    (await gitLine(item.root, [
      'rev-list', '--parents', '-n', '1', prepared.candidateRevision
    ])).split(' '),
    [prepared.candidateRevision, targetRevision]
  );
  assert.equal(
    await gitLine(item.root, ['show', `${prepared.candidateRevision}:reverted.txt`]),
    'before'
  );
  assert.equal(
    await gitLine(item.root, ['show', `${prepared.candidateRevision}:later.txt`]),
    'must survive'
  );
  assert.equal((await git(item.root, [
    'cat-file', '-e', `${prepared.candidateRevision}:integrated-only.txt`
  ], { allowedExitCodes: [0, 128] })).status, 128);
  assert.equal(
    await gitLine(item.root, ['show-ref', '--verify', '--hash', candidateRef('revert_regular')]),
    prepared.candidateRevision
  );
  await assertTargetAndRoot(item.root, targetRevision);
  await subject.cleanup({
    integrationId: 'revert_regular',
    workspacePath: prepared.workspacePath
  });
});

test('reverts an integrated merge with mainline 1 into a single-parent candidate', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', '-c', 'accepted-source']);
  await writeFile(path.join(item.root, 'feature.txt'), 'feature\n', 'utf8');
  await commitAll(item.root, 'feature change');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'target.txt'), 'target\n', 'utf8');
  await commitAll(item.root, 'target change');
  await git(item.root, [
    'merge', '--no-ff', '--no-edit', '--no-gpg-sign', 'accepted-source', '-m', 'integrated merge'
  ]);
  const revertedRevision = await gitLine(item.root, ['rev-parse', 'HEAD']);
  assert.equal(
    (await gitLine(item.root, ['rev-list', '--parents', '-n', '1', revertedRevision])).split(' ').length,
    3
  );
  await writeFile(path.join(item.root, 'later.txt'), 'later\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'later change');
  const subject = adapter(item.root);

  const prepared = await subject.prepareRevert(
    revertRequest('revert_merge', targetRevision, revertedRevision)
  );

  assert.equal(prepared.mainline, 1);
  assert.deepEqual(prepared.parents, [targetRevision]);
  assert.deepEqual(prepared.changedFiles, ['feature.txt']);
  assert.deepEqual(prepared.changes, [{
    status: 'deleted',
    code: 'D',
    path: 'feature.txt'
  }]);
  assert.match(prepared.patch, /diff --git a\/feature\.txt b\/feature\.txt/u);
  assert.doesNotMatch(prepared.patch, /later\.txt/u);
  assert.equal((await git(item.root, [
    'cat-file', '-e', `${prepared.candidateRevision}:feature.txt`
  ], { allowedExitCodes: [0, 128] })).status, 128);
  assert.equal(
    await gitLine(item.root, ['show', `${prepared.candidateRevision}:target.txt`]),
    'target'
  );
  assert.equal(
    await gitLine(item.root, ['show', `${prepared.candidateRevision}:later.txt`]),
    'later'
  );
  await assertTargetAndRoot(item.root, targetRevision);
  await subject.cleanup({
    integrationId: 'revert_merge',
    workspacePath: prepared.workspacePath
  });
});

test('returns structured revert conflicts and leaves the current target untouched', async (t) => {
  const item = await fixture(t, { 'reverted.txt': 'before\n' });
  await writeFile(path.join(item.root, 'reverted.txt'), 'integrated\n', 'utf8');
  const revertedRevision = await commitAll(item.root, 'integrated change');
  await writeFile(path.join(item.root, 'reverted.txt'), 'later rewrite\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'later conflicting change');
  const subject = adapter(item.root);

  const conflicted = await subject.prepareRevert(
    revertRequest('revert_conflict', targetRevision, revertedRevision)
  );

  assert.equal(conflicted.disposition, 'conflicted');
  assert.equal(conflicted.kind, 'revert');
  assert.equal(conflicted.candidateRevision, null);
  assert.deepEqual(conflicted.conflicts.map((item_) => item_.path), ['reverted.txt']);
  assert.deepEqual(
    conflicted.conflicts[0].stages.map((stage) => stage.stage),
    [1, 2, 3]
  );
  assert.equal((await git(item.root, [
    'show-ref', '--verify', '--quiet', candidateRef('revert_conflict')
  ], { allowedExitCodes: [0, 1] })).status, 1);
  await assertTargetAndRoot(item.root, targetRevision);
  await subject.cleanup({
    integrationId: 'revert_conflict',
    workspacePath: conflicted.workspacePath,
    force: true
  });
});

test('rejects dirty roots, abbreviated object ids, stale targets, and reused candidate ids', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', '-c', 'accepted-source']);
  await writeFile(path.join(item.root, 'source.txt'), 'source\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source change');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'target.txt'), 'target\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'target change');
  const subject = adapter(item.root);

  await writeFile(path.join(item.root, 'dirty.txt'), 'dirty\n', 'utf8');
  await assert.rejects(
    subject.prepareMerge(mergeRequest('dirty', targetRevision, sourceRevision)),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'dirty-project-root'
  );
  await rm(path.join(item.root, 'dirty.txt'));

  await assert.rejects(
    subject.prepareMerge(mergeRequest(
      'short_oid',
      targetRevision.slice(0, 12),
      sourceRevision
    )),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'invalid-object-id'
  );
  await assert.rejects(
    subject.prepareMerge(mergeRequest('../escape', targetRevision, sourceRevision)),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'invalid-integration-id'
  );

  await git(item.root, [
    'update-ref', candidateRef('reused'), sourceRevision, ''
  ]);
  await assert.rejects(
    subject.prepareMerge(mergeRequest('reused', targetRevision, sourceRevision)),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'candidate-ref-already-exists'
  );

  await git(item.root, ['switch', 'accepted-source']);
  await git(item.root, ['update-ref', TARGET_REF, item.baseRevision, targetRevision]);
  await assert.rejects(
    subject.prepareMerge(mergeRequest('stale_target', targetRevision, sourceRevision)),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'target-revision-mismatch'
  );
  assert.equal(
    await pathExists(path.join(item.root, '.fwa', 'integrations', 'stale_target')),
    false
  );
});

test('sanitizes every Git subprocess environment and rejects a poisoned parent view', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', '-c', 'accepted-source']);
  await writeFile(path.join(item.root, 'source.txt'), 'source\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source change');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'target.txt'), 'target\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'target change');
  const observed = [];
  const subject = adapter(item.root, {
    gitRunner: async (executable, arguments_, options) => {
      observed.push(arguments_[0]);
      assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
      assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, '1');
      assert.equal(options.env.GIT_CONFIG_COUNT, '1');
      assert.equal(options.env.GIT_CONFIG_KEY_0, 'core.fsmonitor');
      assert.equal(options.env.GIT_CONFIG_VALUE_0, 'false');
      for (const key of Object.keys(options.env)) {
        if (!/^GIT_/iu.test(key)) continue;
        assert.equal(
          FIXED_GIT_ENVIRONMENT.has(key) || COMMIT_GIT_ENVIRONMENT.has(key),
          true,
          `unexpected Git environment variable ${key}`
        );
      }
      return run(executable, arguments_, options);
    }
  });
  const restore = replaceProcessEnvironment({
    GIT_INDEX_FILE: path.join(item.root, 'poison.index'),
    gIt_NaMeSpAcE: 'poisoned-namespace'
  });

  let prepared;
  try {
    prepared = await subject.prepareMerge(
      mergeRequest('sanitized', targetRevision, sourceRevision)
    );
  } finally {
    restore();
  }
  assert.ok(observed.length > 0);
  await subject.cleanup({
    integrationId: 'sanitized',
    workspacePath: prepared.workspacePath
  });
});

test('cleanup rejects foreign paths and retains successful candidate refs', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', '-c', 'accepted-source']);
  await writeFile(path.join(item.root, 'source.txt'), 'source\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source change');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'target.txt'), 'target\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'target change');
  const subject = adapter(item.root);
  const prepared = await subject.prepareMerge(
    mergeRequest('owned_cleanup', targetRevision, sourceRevision)
  );

  await assert.rejects(
    subject.cleanup({ integrationId: 'owned_cleanup', workspacePath: item.root }),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'integration-workspace-path-outside-owner'
  );
  assert.equal(await pathExists(prepared.workspacePath), true);
  await subject.cleanup({
    integrationId: 'owned_cleanup',
    workspacePath: prepared.workspacePath
  });
  assert.equal(
    await gitLine(item.root, ['show-ref', '--verify', '--hash', candidateRef('owned_cleanup')]),
    prepared.candidateRevision
  );
});

test('cleanup derives the owned workspace path from integrationId', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', '-c', 'derived-cleanup-source']);
  await writeFile(path.join(item.root, 'source.txt'), 'source\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source change');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'target.txt'), 'target\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'target change');
  const subject = adapter(item.root);
  const prepared = await subject.prepareMerge(
    mergeRequest('derived_cleanup', targetRevision, sourceRevision)
  );

  const cleaned = await subject.cleanup({
    integrationId: 'derived_cleanup',
    force: true
  });

  assert.equal(cleaned.removed, true);
  assert.equal(cleaned.workspacePath, prepared.workspacePath);
  assert.equal(await pathExists(prepared.workspacePath), false);
});

test('cleanup recovers nonzero Git removal after safe unregistration', async (t) => {
  const item = await fixture(t);
  const integrationId = 'partial_cleanup';
  const workspacePath = await createManagedIntegrationWorktree(item, integrationId);
  let intercepted = false;
  const subject = adapter(item.root, {
    gitRunner: async (executable, arguments_, options) => {
      assertFsmonitorDisabled(options.env);
      if (!intercepted && isWorktreeRemove(arguments_, workspacePath)) {
        intercepted = true;
        await unregisterWorktreeWithoutDeleting(workspacePath);
        throw syntheticRemoveFailure();
      }
      return run(executable, arguments_, options);
    }
  });

  const cleaned = await subject.cleanup({ integrationId, workspacePath, force: true });

  assert.equal(intercepted, true);
  assert.equal(cleaned.removed, true);
  assert.equal(cleaned.filesystemFallbackUsed, true);
  assert.equal(cleaned.candidateRetained, false);
  assert.equal(await pathExists(workspacePath), false);
  assert.equal(await pathExists(path.dirname(workspacePath)), false);
});

test('cleanup never falls back while a failed Git removal stays registered', async (t) => {
  const item = await fixture(t);
  const integrationId = 'registered_cleanup_failure';
  const workspacePath = await createManagedIntegrationWorktree(item, integrationId);
  const marker = path.join(workspacePath, 'seed.txt');
  const subject = adapter(item.root, {
    gitRunner: async (executable, arguments_, options) => {
      assertFsmonitorDisabled(options.env);
      if (isWorktreeRemove(arguments_, workspacePath)) {
        throw syntheticRemoveFailure();
      }
      return run(executable, arguments_, options);
    }
  });

  await assert.rejects(
    subject.cleanup({ integrationId, workspacePath, force: true }),
    (error) => error.code === 'integration-worktree-remove-failed'
      && error.details.registered === true
  );
  assert.equal(await pathExists(marker), true);
  assert.match(
    (await git(item.root, ['worktree', 'list', '--porcelain'])).stdout,
    /registered_cleanup_failure/u
  );

  await adapter(item.root).cleanup({ integrationId, workspacePath, force: true });
});

test('cleanup accepts nonzero Git for a missing path once registration is gone', async (t) => {
  const item = await fixture(t);
  const integrationId = 'missing_partial_cleanup';
  const workspacePath = await createManagedIntegrationWorktree(item, integrationId);
  const administrativePath = await worktreeAdministrativePath(workspacePath);
  await rm(workspacePath, { recursive: true, force: true });
  let intercepted = false;
  const subject = adapter(item.root, {
    gitRunner: async (executable, arguments_, options) => {
      assertFsmonitorDisabled(options.env);
      if (!intercepted && isWorktreeRemove(arguments_, workspacePath)) {
        intercepted = true;
        await rm(administrativePath, { recursive: true, force: true });
        throw syntheticRemoveFailure();
      }
      return run(executable, arguments_, options);
    }
  });

  const cleaned = await subject.cleanup({ integrationId, workspacePath, force: true });

  assert.equal(intercepted, true);
  assert.equal(cleaned.removed, true);
  assert.equal(cleaned.filesystemFallbackUsed, false);
  assert.equal(cleaned.candidateRetained, false);
  assert.equal(await pathExists(workspacePath), false);
  assert.equal(await pathExists(path.dirname(workspacePath)), false);
});

test('cleanup prunes a registered candidate worktree after its operation parent is removed', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', '-c', 'missing-parent-source']);
  await writeFile(path.join(item.root, 'source.txt'), 'source\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source change');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'target.txt'), 'target\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'target change');
  const subject = adapter(item.root);
  const prepared = await subject.prepareMerge(
    mergeRequest('removed_operation_parent', targetRevision, sourceRevision)
  );
  await rm(path.dirname(prepared.workspacePath), { recursive: true, force: true });

  const cleaned = await subject.cleanup({
    integrationId: 'removed_operation_parent',
    force: true
  });
  assert.equal(cleaned.removed, true);
  assert.equal(cleaned.alreadyAbsent, false);
  assert.equal(cleaned.candidateRetained, true);
  assert.equal(await pathExists(prepared.workspacePath), false);
  assert.equal((await subject.inspectResidue()).count, 0);
});

test('inspectResidue lists managed registrations and cleanup removes a prunable one', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', '-c', 'residue-source']);
  await writeFile(path.join(item.root, 'source.txt'), 'source\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source change');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'target.txt'), 'target\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'target change');
  const subject = adapter(item.root);
  const existing = await subject.prepareMerge(
    mergeRequest('residue_existing', targetRevision, sourceRevision)
  );
  const missing = await subject.prepareMerge(
    mergeRequest('residue_missing', targetRevision, sourceRevision)
  );

  await rm(missing.workspacePath, { recursive: true, force: true });
  assert.equal(await pathExists(missing.workspacePath), false);
  assert.match(
    (await git(item.root, ['worktree', 'list', '--porcelain'])).stdout,
    /prunable/u
  );

  const entries = await subject.listResidue();
  assert.deepEqual(entries, [{
    integrationId: 'residue_existing',
    workspacePath: existing.workspacePath,
    registered: true,
    exists: true
  }, {
    integrationId: 'residue_missing',
    workspacePath: missing.workspacePath,
    registered: true,
    exists: false
  }].sort((left, right) => left.workspacePath.localeCompare(right.workspacePath, 'en')));
  const initialResidue = await subject.inspectResidue();
  assert.equal(initialResidue.ok, false);
  assert.deepEqual(initialResidue.entries, entries);
  assert.equal(initialResidue.count, 2);
  assert.deepEqual(initialResidue.candidateRefs, [{
    integrationId: 'residue_existing',
    candidateRef: candidateRef('residue_existing'),
    candidateRevision: existing.candidateRevision,
    structurallyValid: true
  }, {
    integrationId: 'residue_missing',
    candidateRef: candidateRef('residue_missing'),
    candidateRevision: missing.candidateRevision,
    structurallyValid: true
  }]);
  assert.equal(initialResidue.candidateRefCount, 2);

  await assert.rejects(
    subject.pruneCandidateRef({
      integrationId: 'residue_existing',
      expectedRevision: existing.candidateRevision
    }),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'candidate-ref-workspace-remains'
  );

  const cleanedMissing = await subject.cleanup({ integrationId: 'residue_missing' });
  assert.equal(cleanedMissing.removed, true);
  assert.equal(cleanedMissing.alreadyAbsent, false);
  assert.equal(cleanedMissing.workspacePath, missing.workspacePath);
  assert.equal(cleanedMissing.candidateRetained, true);
  assert.equal(
    (await git(item.root, ['worktree', 'list', '--porcelain'])).stdout
      .replaceAll('\\', '/')
      .includes(missing.workspacePath.replaceAll('\\', '/')),
    false
  );
  const partialResidue = await subject.inspectResidue();
  assert.equal(partialResidue.ok, false);
  assert.deepEqual(partialResidue.entries, [{
    integrationId: 'residue_existing',
    workspacePath: existing.workspacePath,
    registered: true,
    exists: true
  }]);
  assert.equal(partialResidue.count, 1);
  assert.equal(partialResidue.candidateRefCount, 2);

  await assert.rejects(
    subject.pruneCandidateRef({
      integrationId: 'residue_missing',
      expectedRevision: existing.candidateRevision
    }),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'candidate-ref-revision-mismatch'
  );
  const prunedMissing = await subject.pruneCandidateRef({
    integrationId: 'residue_missing',
    expectedRevision: missing.candidateRevision
  });
  assert.equal(prunedMissing.removed, true);

  await subject.cleanup({ integrationId: 'residue_existing' });
  const prunedExisting = await subject.pruneCandidateRef({
    integrationId: 'residue_existing',
    expectedRevision: existing.candidateRevision
  });
  assert.equal(prunedExisting.removed, true);
  assert.deepEqual(await subject.inspectResidue(), {
    ok: true,
    entries: [],
    count: 0,
    candidateRefs: [],
    candidateRefCount: 0
  });
});

test('inspectResidue fails closed for malformed registrations under the managed root', async (t) => {
  const item = await fixture(t);
  const subject = adapter(item.root);
  const invalidIdPath = path.join(
    item.root,
    '.fwa',
    'integrations',
    'bad id',
    'worktree'
  );
  await mkdir(path.dirname(invalidIdPath), { recursive: true });
  await git(item.root, ['worktree', 'add', '--detach', invalidIdPath, 'HEAD']);
  await assert.rejects(
    subject.inspectResidue(),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'invalid-integration-worktree-registration'
  );
  await git(item.root, ['worktree', 'remove', '--force', invalidIdPath]);

  const invalidDepthPath = path.join(
    item.root,
    '.fwa',
    'integrations',
    'nested',
    'extra',
    'worktree'
  );
  await mkdir(path.dirname(invalidDepthPath), { recursive: true });
  await git(item.root, ['worktree', 'add', '--detach', invalidDepthPath, 'HEAD']);
  await assert.rejects(
    subject.inspectResidue(),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'invalid-integration-worktree-registration'
  );
  await git(item.root, ['worktree', 'remove', '--force', invalidDepthPath]);
});

test('candidate ref pruning uses an old-OID CAS and preserves a raced ref', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', '-c', 'cas-source']);
  await writeFile(path.join(item.root, 'source.txt'), 'source\n', 'utf8');
  const sourceRevision = await commitAll(item.root, 'source change');
  await git(item.root, ['switch', 'main']);
  await writeFile(path.join(item.root, 'target.txt'), 'target\n', 'utf8');
  const targetRevision = await commitAll(item.root, 'target change');
  const ownerId = 'cas_race';
  const subject = adapter(item.root);
  const prepared = await subject.prepareMerge(
    mergeRequest(ownerId, targetRevision, sourceRevision)
  );
  await subject.cleanup({ integrationId: ownerId, force: true });

  let raced = false;
  const racing = adapter(item.root, {
    gitRunner: async (executable, arguments_, options) => {
      if (!raced
        && arguments_[0] === 'update-ref'
        && arguments_.includes('-d')
        && arguments_.includes(candidateRef(ownerId))) {
        raced = true;
        await git(item.root, [
          'update-ref',
          candidateRef(ownerId),
          targetRevision,
          prepared.candidateRevision
        ]);
      }
      return run(executable, arguments_, options);
    }
  });
  await assert.rejects(
    racing.pruneCandidateRef({
      integrationId: ownerId,
      expectedRevision: prepared.candidateRevision
    }),
    (error) => error instanceof GitIntegrationWorkspaceError
      && error.code === 'candidate-ref-prune-failed'
  );
  assert.equal(raced, true);
  assert.equal(
    await gitLine(item.root, ['show-ref', '--verify', '--hash', candidateRef(ownerId)]),
    targetRevision
  );
});
