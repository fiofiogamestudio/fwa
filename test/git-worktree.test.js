import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  chmod,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  GitWorktreeAdapter,
  GitWorktreeError
} from '../src/adapters/git-worktree.js';

const FIXED_TIME = new Date('2026-09-05T08:30:00.000Z');

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

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-git-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Test']);
  await git(root, ['config', 'user.email', 'fwa-test@example.invalid']);
  await git(root, ['config', 'core.ignorecase', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\nignored-output/\n', 'utf8');
  await writeFile(path.join(root, 'keep.txt'), 'original\n', 'utf8');
  await writeFile(
    path.join(root, 'rename-source.txt'),
    Array.from({ length: 20 }, (_, index) => `rename line ${index}\n`).join(''),
    'utf8'
  );
  await writeFile(path.join(root, 'delete-me.txt'), 'delete me\n', 'utf8');
  await writeFile(path.join(root, 'move-to-state.txt'), 'state candidate\n', 'utf8');
  await git(root, ['add', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'initial']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, head };
}

function adapter(root, options = {}) {
  return new GitWorktreeAdapter(root, {
    clock: () => FIXED_TIME,
    ...options
  });
}

function findChange(changes, filePath) {
  return changes.find((change) => change.path === filePath);
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isWorktreeRemove(arguments_, workspacePath) {
  return arguments_[0] === 'worktree'
    && arguments_[1] === 'remove'
    && arguments_.at(-1) === workspacePath;
}

function assertFsmonitorDisabled(environment) {
  assert.equal(environment.GIT_CONFIG_COUNT, '1');
  assert.equal(environment.GIT_CONFIG_KEY_0, 'core.fsmonitor');
  assert.equal(environment.GIT_CONFIG_VALUE_0, 'false');
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
  error.result = { status: 1, stdout: '', stderr: error.message };
  return error;
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

test('inspect resolves commits and accepts ignored .fwa runtime state', async (t) => {
  const { root, head } = await fixture(t);
  await mkdir(path.join(root, '.fwa'), { recursive: true });
  await writeFile(path.join(root, '.fwa', 'runtime.json'), '{}\n', 'utf8');

  const result = await adapter(root).inspect({ baseRevision: 'main' });

  assert.equal(result.projectRoot, await import('node:fs/promises').then(({ realpath }) => realpath(root)));
  assert.equal(result.baseRevision, head);
  assert.equal(result.headRevision, head);
  assert.equal(result.requestedBaseRevision, 'main');
  assert.equal(result.coreIgnoreCase, false);
  assert.deepEqual(result.core, { ignoreCase: false });
  assert.equal(result.clean, true);

  await writeFile(path.join(root, 'keep.txt'), 'dirty\n', 'utf8');
  await assert.rejects(
    adapter(root).inspect(),
    (error) => error instanceof GitWorktreeError
      && error.code === 'dirty-project-root'
      && error.details.changes.some((change) => change.path === 'keep.txt')
  );
});

test('worktree Git commands ignore inherited Git repository routing', async (t) => {
  const { root, head } = await fixture(t);
  const restore = replaceProcessEnvironment({
    GIT_INDEX_FILE: path.join(root, 'poison.index'),
    GIT_OBJECT_DIRECTORY: path.join(root, 'missing-object-directory'),
    gIt_NaMeSpAcE: 'poisoned-namespace'
  });

  try {
    const result = await adapter(root).inspect();
    assert.equal(result.headRevision, head);
    assert.equal(result.clean, true);
  } finally {
    restore();
  }
});

test('inspect rejects descendants, unresolved revisions, and moves across the state boundary', async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, 'subdirectory'));

  await assert.rejects(
    adapter(path.join(root, 'subdirectory')).inspect(),
    (error) => error.code === 'project-root-not-top-level'
  );
  await assert.rejects(
    adapter(root).inspect({ baseRevision: 'missing-revision' }),
    (error) => error.code === 'revision-not-found'
  );
  await assert.rejects(
    adapter(root).inspect({ baseRevision: '--help' }),
    (error) => error.code === 'invalid-revision'
  );

  await mkdir(path.join(root, '.fwa'), { recursive: true });
  await git(root, ['mv', 'move-to-state.txt', '.fwa/move-to-state.txt']);
  await assert.rejects(
    adapter(root).inspect(),
    (error) => error.code === 'fwa-state-tracked'
      && error.details.paths.includes('.fwa/move-to-state.txt')
  );
});

test('inspect allows pre-existing ignored host caches', async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, 'ignored-output'));
  await writeFile(path.join(root, 'ignored-output', 'cache.bin'), 'ignored\n', 'utf8');

  const result = await adapter(root).inspect();
  assert.equal(result.clean, true);
});

test('inspect requires .fwa to be ignored and completely absent from the Git index', async (t) => {
  const notIgnored = await fixture(t);
  await writeFile(path.join(notIgnored.root, '.gitignore'), 'ignored-output/\n', 'utf8');
  await git(notIgnored.root, ['add', '.gitignore']);
  await git(notIgnored.root, ['commit', '--no-gpg-sign', '-m', 'stop ignoring state']);
  await assert.rejects(
    adapter(notIgnored.root).inspect(),
    (error) => error.code === 'fwa-state-not-ignored'
      && error.details.remediation.includes('/.fwa/')
  );

  const tracked = await fixture(t);
  await mkdir(path.join(tracked.root, '.fwa'));
  await writeFile(path.join(tracked.root, '.fwa', 'tracked.json'), '{}\n', 'utf8');
  await git(tracked.root, ['add', '-f', '.fwa/tracked.json']);
  await git(tracked.root, ['commit', '--no-gpg-sign', '-m', 'bad tracked state']);
  await assert.rejects(
    adapter(tracked.root).inspect(),
    (error) => error.code === 'fwa-state-tracked'
      && error.details.paths.includes('.fwa/tracked.json')
  );
});

test('creates a detached evaluation worktree at the exact immutable revision', async (t) => {
  const { root, head } = await fixture(t);
  const workspace = adapter(root);

  await writeFile(path.join(root, 'later.txt'), 'later main state\n', 'utf8');
  await git(root, ['add', '--', 'later.txt']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'advance main']);
  const advancedHead = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();

  const evaluation = await workspace.createEvaluation({
    evaluationId: 'evaluation_exact',
    revision: head
  });

  assert.equal(evaluation.headRevision, head);
  assert.equal(evaluation.detached, true);
  assert.equal(await pathExists(path.join(evaluation.workspacePath, 'later.txt')), false);
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), advancedHead);

  await writeFile(path.join(evaluation.workspacePath, 'keep.txt'), 'mutated by evaluator\n', 'utf8');
  await writeFile(path.join(evaluation.workspacePath, 'report.json'), '{}\n', 'utf8');
  const inspection = await workspace.inspectEvaluation({
    evaluationId: 'evaluation_exact',
    workspacePath: evaluation.workspacePath,
    revision: head
  });
  assert.deepEqual(
    inspection.trackedChanges.map((change) => change.path),
    ['keep.txt']
  );
  assert.equal(inspection.changes.some((change) => change.path === 'report.json'), true);

  const removed = await workspace.removeEvaluation({
    evaluationId: 'evaluation_exact',
    workspacePath: evaluation.workspacePath
  });
  assert.equal(removed.removed, true);
  assert.equal(await pathExists(evaluation.workspacePath), false);
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), advancedHead);
});

test('evaluation ownership rejects path/revision/branch drift and cleans owned drift safely', async (t) => {
  const { root, head } = await fixture(t);
  const workspace = adapter(root);
  const evaluation = await workspace.createEvaluation({
    evaluationId: 'evaluation_guarded',
    revision: head
  });

  await assert.rejects(
    workspace.inspectEvaluation({
      evaluationId: 'evaluation_guarded',
      workspacePath: root,
      revision: head
    }),
    (error) => error.code === 'evaluation-workspace-path-outside-owner'
  );

  await git(evaluation.workspacePath, ['switch', '-c', 'evaluation-hijack']);
  await assert.rejects(
    workspace.inspectEvaluation({
      evaluationId: 'evaluation_guarded',
      workspacePath: evaluation.workspacePath,
      revision: head
    }),
    (error) => error.code === 'evaluation-workspace-not-detached'
  );

  const removed = await workspace.removeEvaluation({
    evaluationId: 'evaluation_guarded',
    workspacePath: evaluation.workspacePath
  });
  assert.equal(removed.removed, true);
});

test('a missing evaluation directory with live Git registration is pruned with proof', async (t) => {
  const { root, head } = await fixture(t);
  const workspace = adapter(root);
  const evaluation = await workspace.createEvaluation({
    evaluationId: 'evaluation_registered',
    revision: head
  });
  await rm(evaluation.workspacePath, { recursive: true, force: true });

  assert.deepEqual(await workspace.inspectEvaluationResidue(), {
    ok: false,
    entries: [{
      evaluationId: 'evaluation_registered',
      workspacePath: evaluation.workspacePath,
      registered: true,
      exists: false
    }],
    count: 1,
    projectRoot: root
  });
  await assert.rejects(
    workspace.removeEvaluation({
      evaluationId: 'evaluation_registered',
      workspacePath: evaluation.workspacePath,
      revision: 'f'.repeat(40)
    }),
    (error) => error.code === 'evaluation-workspace-revision-mismatch'
  );
  assert.equal((await workspace.inspectEvaluationResidue()).count, 1);
  const removed = await workspace.removeEvaluation({
    evaluationId: 'evaluation_registered',
    workspacePath: evaluation.workspacePath,
    revision: head
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.alreadyAbsent, false);
  assert.deepEqual(await workspace.inspectEvaluationResidue(), {
    ok: true,
    entries: [],
    count: 0,
    projectRoot: root
  });
});

test('a missing evaluations parent with live Git registration is pruned with proof', async (t) => {
  const { root, head } = await fixture(t);
  const workspace = adapter(root);
  const evaluation = await workspace.createEvaluation({
    evaluationId: 'evaluation_parent_removed',
    revision: head
  });
  await rm(path.dirname(evaluation.workspacePath), { recursive: true, force: true });

  const removed = await workspace.removeEvaluation({
    evaluationId: 'evaluation_parent_removed',
    workspacePath: evaluation.workspacePath,
    revision: head
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.alreadyAbsent, false);
  assert.equal(await pathExists(evaluation.workspacePath), false);
  assert.deepEqual(await workspace.inspectEvaluationResidue(), {
    ok: true,
    entries: [],
    count: 0,
    projectRoot: root
  });
});

test('a missing evaluation path accepts nonzero Git after its registration disappears', async (t) => {
  const { root, head } = await fixture(t);
  const created = await adapter(root).createEvaluation({
    evaluationId: 'evaluation_missing_partial',
    revision: head
  });
  const administrativePath = await worktreeAdministrativePath(created.workspacePath);
  await rm(created.workspacePath, { recursive: true, force: true });
  let intercepted = false;
  const subject = adapter(root, {
    gitRunner: async (executable, arguments_, options) => {
      assertFsmonitorDisabled(options.env);
      if (!intercepted && isWorktreeRemove(arguments_, created.workspacePath)) {
        intercepted = true;
        await rm(administrativePath, { recursive: true, force: true });
        throw syntheticRemoveFailure();
      }
      return run(executable, arguments_, options);
    }
  });

  const removed = await subject.removeEvaluation({
    evaluationId: 'evaluation_missing_partial',
    workspacePath: created.workspacePath,
    revision: head
  });

  assert.equal(intercepted, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.filesystemFallbackUsed, false);
  assert.equal(await pathExists(created.workspacePath), false);
  assert.doesNotMatch(
    (await git(root, ['worktree', 'list', '--porcelain'])).stdout,
    /evaluation_missing_partial/u
  );
});

test('creates an owned linked worktree and captures tracked, untracked, renamed, and deleted files', async (t) => {
  const { root, head: mainHead } = await fixture(t);
  const subject = adapter(root);
  const created = await subject.create({ runId: 'run_123', baseRevision: 'main' });

  assert.equal(created.workspacePath, path.join(root, '.fwa', 'worktrees', 'run_123'));
  assert.equal(created.branch, 'fwa/runs/run_123');
  assert.equal(created.ref, 'refs/heads/fwa/runs/run_123');
  assert.equal(created.baseRevision, mainHead);
  assert.equal(created.headRevision, mainHead);
  assert.equal(
    (await git(created.workspacePath, ['branch', '--show-current'])).stdout.trim(),
    created.branch
  );

  await git(created.workspacePath, ['mv', 'rename-source.txt', 'renamed.txt']);
  await rm(path.join(created.workspacePath, 'delete-me.txt'));
  await writeFile(path.join(created.workspacePath, 'keep.txt'), 'modified\n', 'utf8');
  await writeFile(path.join(created.workspacePath, 'untracked file.txt'), 'new\n', 'utf8');

  const beforeCapture = await subject.getChangedFiles({
    runId: 'run_123',
    workspacePath: created.workspacePath,
    baseRevision: mainHead
  });
  assert.equal(findChange(beforeCapture, 'renamed.txt').status, 'renamed');
  assert.equal(findChange(beforeCapture, 'renamed.txt').previousPath, 'rename-source.txt');
  assert.equal(findChange(beforeCapture, 'rename-source.txt').status, 'deleted');
  assert.equal(findChange(beforeCapture, 'rename-source.txt').renamedTo, 'renamed.txt');
  assert.equal(findChange(beforeCapture, 'delete-me.txt').status, 'deleted');
  assert.equal(findChange(beforeCapture, 'keep.txt').status, 'modified');
  assert.equal(findChange(beforeCapture, 'untracked file.txt').status, 'untracked');

  const captured = await subject.capture({
    runId: 'run_123',
    workspacePath: created.workspacePath,
    baseRevision: mainHead
  });

  assert.match(captured.captureCommit, /^[a-f0-9]{40,64}$/u);
  assert.equal(captured.headRevision, captured.captureCommit);
  assert.deepEqual(captured.commits, [captured.captureCommit]);
  assert.equal(findChange(captured.changedFiles, 'renamed.txt').status, 'renamed');
  assert.equal(findChange(captured.changedFiles, 'renamed.txt').previousPath, 'rename-source.txt');
  assert.equal(findChange(captured.changedFiles, 'rename-source.txt').status, 'deleted');
  assert.equal(findChange(captured.changedFiles, 'rename-source.txt').renamedTo, 'renamed.txt');
  assert.equal(findChange(captured.changedFiles, 'delete-me.txt').status, 'deleted');
  assert.equal(findChange(captured.changedFiles, 'keep.txt').status, 'modified');
  assert.equal(findChange(captured.changedFiles, 'untracked file.txt').status, 'added');
  assert.match(captured.patch, /diff --git a\/keep\.txt b\/keep\.txt/u);
  assert.match(captured.patch, /untracked file\.txt/u);
  assert.equal((await git(created.workspacePath, ['status', '--porcelain'])).stdout, '');
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), mainHead);
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'original\n');
  assert.equal(
    (await git(root, ['rev-parse', created.ref])).stdout.trim(),
    captured.headRevision
  );

  const removed = await subject.remove({
    runId: 'run_123',
    workspacePath: created.workspacePath
  });
  assert.equal(removed.removed, true);
  assert.equal(await pathExists(created.workspacePath), false);
  assert.equal(
    (await git(root, ['rev-parse', created.ref])).stdout.trim(),
    captured.headRevision
  );
  assert.deepEqual(await subject.remove({
    runId: 'run_123',
    workspacePath: created.workspacePath
  }), {
    removed: false,
    alreadyAbsent: true,
    filesystemFallbackUsed: false,
    runId: 'run_123',
    workspacePath: created.workspacePath,
    ref: created.ref
  });
});

test('remove never treats a missing directory as removed while Git registration remains', async (t) => {
  const { root, head } = await fixture(t);
  const subject = adapter(root);
  const created = await subject.create({ runId: 'missing_registered', baseRevision: head });
  await rm(created.workspacePath, { recursive: true, force: true });

  await assert.rejects(
    subject.remove({
      runId: 'missing_registered',
      workspacePath: created.workspacePath
    }),
    (error) => error.code === 'worktree-registration-remains'
  );
  const registrations = (await git(root, ['worktree', 'list', '--porcelain'])).stdout;
  assert.match(registrations, /missing_registered/u);
});

test('remove recovers a Git-successful unregistered physical residue', async (t) => {
  const { root, head } = await fixture(t);
  const created = await adapter(root).create({
    runId: 'run_success_residue',
    baseRevision: head
  });
  let intercepted = false;
  const subject = adapter(root, {
    gitRunner: async (executable, arguments_, options) => {
      assertFsmonitorDisabled(options.env);
      if (!intercepted && isWorktreeRemove(arguments_, created.workspacePath)) {
        intercepted = true;
        await unregisterWorktreeWithoutDeleting(created.workspacePath);
        return { status: 0, stdout: '', stderr: '' };
      }
      return run(executable, arguments_, options);
    }
  });

  const removed = await subject.remove({
    runId: 'run_success_residue',
    workspacePath: created.workspacePath,
    force: true
  });

  assert.equal(intercepted, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.filesystemFallbackUsed, true);
  assert.equal(await pathExists(created.workspacePath), false);
  assert.doesNotMatch(
    (await git(root, ['worktree', 'list', '--porcelain'])).stdout,
    /run_success_residue/u
  );
});

test('remove fails closed after a nonzero Git result while registration remains', async (t) => {
  const { root, head } = await fixture(t);
  const owner = adapter(root);
  const created = await owner.create({ runId: 'run_registered_failure', baseRevision: head });
  const marker = path.join(created.workspacePath, 'keep.txt');
  const subject = adapter(root, {
    gitRunner: async (executable, arguments_, options) => {
      assertFsmonitorDisabled(options.env);
      if (isWorktreeRemove(arguments_, created.workspacePath)) {
        throw syntheticRemoveFailure();
      }
      return run(executable, arguments_, options);
    }
  });

  await assert.rejects(
    subject.remove({
      runId: 'run_registered_failure',
      workspacePath: created.workspacePath,
      force: true
    }),
    (error) => error.code === 'worktree-remove-failed'
      && error.details.registered === true
  );
  assert.equal(await pathExists(marker), true);
  assert.match((await git(root, ['worktree', 'list', '--porcelain'])).stdout, /run_registered_failure/u);

  await owner.remove({
    runId: 'run_registered_failure',
    workspacePath: created.workspacePath,
    force: true
  });
});

test('remove refuses a substituted link after Git unregisters the owned directory', async (t) => {
  const { root, head } = await fixture(t);
  const foreignDirectory = path.join(root, '.fwa', 'foreign-run-target');
  const probePath = path.join(root, '.fwa', 'link-probe');
  await mkdir(foreignDirectory, { recursive: true });
  await writeFile(path.join(foreignDirectory, 'must-survive.txt'), 'safe\n', 'utf8');
  try {
    await symlink(
      foreignDirectory,
      probePath,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await rm(probePath, { force: true });
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`symbolic links are unavailable in this environment: ${error.code}`);
      return;
    }
    throw error;
  }

  const created = await adapter(root).create({ runId: 'run_identity_swap', baseRevision: head });
  const subject = adapter(root, {
    gitRunner: async (executable, arguments_, options) => {
      assertFsmonitorDisabled(options.env);
      if (isWorktreeRemove(arguments_, created.workspacePath)) {
        await unregisterWorktreeWithoutDeleting(created.workspacePath);
        await rm(created.workspacePath, { recursive: true, force: true });
        await symlink(
          foreignDirectory,
          created.workspacePath,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
        return { status: 0, stdout: '', stderr: '' };
      }
      return run(executable, arguments_, options);
    }
  });

  await assert.rejects(
    subject.remove({
      runId: 'run_identity_swap',
      workspacePath: created.workspacePath,
      force: true
    }),
    (error) => error.code === 'invalid-workspace-path'
  );
  assert.equal(
    await readFile(path.join(foreignDirectory, 'must-survive.txt'), 'utf8'),
    'safe\n'
  );
  await rm(created.workspacePath, { force: true });
});

test('removeEvaluation recovers nonzero Git removal after safe unregistration', async (t) => {
  const { root, head } = await fixture(t);
  const created = await adapter(root).createEvaluation({
    evaluationId: 'evaluation_partial_remove',
    revision: head
  });
  let intercepted = false;
  const subject = adapter(root, {
    gitRunner: async (executable, arguments_, options) => {
      assertFsmonitorDisabled(options.env);
      if (!intercepted && isWorktreeRemove(arguments_, created.workspacePath)) {
        intercepted = true;
        await unregisterWorktreeWithoutDeleting(created.workspacePath);
        throw syntheticRemoveFailure();
      }
      return run(executable, arguments_, options);
    }
  });

  const removed = await subject.removeEvaluation({
    evaluationId: 'evaluation_partial_remove',
    workspacePath: created.workspacePath,
    revision: head
  });

  assert.equal(intercepted, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.filesystemFallbackUsed, true);
  assert.equal(await pathExists(created.workspacePath), false);
});

test('removeEvaluation never falls back while a failed Git removal stays registered', async (t) => {
  const { root, head } = await fixture(t);
  const owner = adapter(root);
  const created = await owner.createEvaluation({
    evaluationId: 'evaluation_registered_failure',
    revision: head
  });
  const marker = path.join(created.workspacePath, 'keep.txt');
  const subject = adapter(root, {
    gitRunner: async (executable, arguments_, options) => {
      assertFsmonitorDisabled(options.env);
      if (isWorktreeRemove(arguments_, created.workspacePath)) {
        throw syntheticRemoveFailure();
      }
      return run(executable, arguments_, options);
    }
  });

  await assert.rejects(
    subject.removeEvaluation({
      evaluationId: 'evaluation_registered_failure',
      workspacePath: created.workspacePath,
      revision: head
    }),
    (error) => error.code === 'evaluation-worktree-remove-failed'
      && error.details.registered === true
  );
  assert.equal(await pathExists(marker), true);
  assert.match(
    (await git(root, ['worktree', 'list', '--porcelain'])).stdout,
    /evaluation_registered_failure/u
  );

  await owner.removeEvaluation({
    evaluationId: 'evaluation_registered_failure',
    workspacePath: created.workspacePath,
    revision: head
  });
});

test('getChangedFiles exposes ignored writes and capture fails before omitting them', async (t) => {
  const { root, head } = await fixture(t);
  const subject = adapter(root);
  const created = await subject.create({ runId: 'ignored_write', baseRevision: head });
  await mkdir(path.join(created.workspacePath, 'ignored-output'));
  await writeFile(
    path.join(created.workspacePath, 'ignored-output', 'cache.bin'),
    'generated\n',
    'utf8'
  );

  const changes = await subject.getChangedFiles({
    runId: 'ignored_write',
    workspacePath: created.workspacePath,
    baseRevision: head
  });
  assert.deepEqual(findChange(changes, 'ignored-output/cache.bin'), {
    status: 'ignored-untracked',
    code: '!!',
    path: 'ignored-output/cache.bin',
    capturable: false
  });
  await assert.rejects(
    subject.capture({
      runId: 'ignored_write',
      workspacePath: created.workspacePath,
      baseRevision: head
    }),
    (error) => error.code === 'uncapturable-ignored-files'
      && error.details.ignoredFiles.some((change) => change.path === 'ignored-output/cache.bin')
  );
  assert.equal((await git(created.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim(), head);
  assert.equal(await readFile(
    path.join(created.workspacePath, 'ignored-output', 'cache.bin'),
    'utf8'
  ), 'generated\n');

  await subject.remove({
    runId: 'ignored_write',
    workspacePath: created.workspacePath,
    force: true
  });
});

test('create rejects ignored files produced while materializing a new run baseline', async (t) => {
  const { root, head } = await fixture(t);
  const hookPath = path.join(root, '.git', 'hooks', 'post-checkout');
  await writeFile(
    hookPath,
    '#!/bin/sh\nmkdir -p ignored-output\nprintf generated > ignored-output/from-hook.bin\n',
    'utf8'
  );
  if (process.platform !== 'win32') await chmod(hookPath, 0o755);

  const subject = adapter(root);
  const workspacePath = path.join(root, '.fwa', 'worktrees', 'hook_dirty');
  await assert.rejects(
    subject.create({ runId: 'hook_dirty', baseRevision: head }),
    (error) => error.code === 'worktree-baseline-dirty'
      && error.details.changes.some((change) => (
        change.status === 'ignored-untracked'
          && change.path === 'ignored-output/from-hook.bin'
      ))
  );
  assert.equal(await readFile(
    path.join(workspacePath, 'ignored-output', 'from-hook.bin'),
    'utf8'
  ), 'generated');

  await subject.remove({ runId: 'hook_dirty', workspacePath, force: true });
});

test('capture rechecks ignored writes after staging and reports an already-created ref', async (t) => {
  const { root, head } = await fixture(t);
  let racedFile;
  const subject = new GitWorktreeAdapter(root, {
    clock: () => {
      writeFileSync(racedFile, 'late ignored write\n', 'utf8');
      return FIXED_TIME;
    }
  });
  const created = await subject.create({ runId: 'late_ignore', baseRevision: head });
  const ignoredDirectory = path.join(created.workspacePath, 'ignored-output');
  await mkdir(ignoredDirectory);
  racedFile = path.join(ignoredDirectory, 'late.bin');
  await writeFile(path.join(created.workspacePath, 'keep.txt'), 'capture me\n', 'utf8');

  let capturedError;
  await assert.rejects(
    subject.capture({
      runId: 'late_ignore',
      workspacePath: created.workspacePath,
      baseRevision: head
    }),
    (error) => {
      capturedError = error;
      return error.code === 'uncapturable-ignored-files'
        && error.details.phase === 'post-capture'
        && error.details.ignoredFiles.some((change) => (
          change.path === 'ignored-output/late.bin'
        ));
    }
  );
  assert.match(capturedError.details.captureCommit, /^[a-f0-9]{40,64}$/u);
  assert.equal(capturedError.details.headRevision, capturedError.details.captureCommit);
  assert.equal(
    (await git(root, ['rev-parse', created.ref])).stdout.trim(),
    capturedError.details.headRevision
  );

  await subject.remove({
    runId: 'late_ignore',
    workspacePath: created.workspacePath,
    force: true
  });
});

test('capture rejects dirty submodule contents that no parent commit can contain', async (t) => {
  const { root } = await fixture(t);
  const submoduleRoot = await mkdtemp(path.join(os.tmpdir(), 'fwa-git-submodule-'));
  t.after(() => rm(submoduleRoot, { recursive: true, force: true }));
  await git(submoduleRoot, ['init', '-b', 'main']);
  await git(submoduleRoot, ['config', 'user.name', 'FWA Test']);
  await git(submoduleRoot, ['config', 'user.email', 'fwa-test@example.invalid']);
  await writeFile(path.join(submoduleRoot, 'nested.txt'), 'submodule base\n', 'utf8');
  await git(submoduleRoot, ['add', 'nested.txt']);
  await git(submoduleRoot, ['commit', '--no-gpg-sign', '-m', 'submodule base']);

  await git(root, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    submoduleRoot,
    'vendor/sub'
  ]);
  await git(root, ['commit', '--no-gpg-sign', '-am', 'add submodule']);
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const subject = adapter(root);
  const created = await subject.create({ runId: 'dirty_submodule', baseRevision: head });
  await git(created.workspacePath, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--recursive'
  ]);
  await writeFile(
    path.join(created.workspacePath, 'vendor', 'sub', 'nested.txt'),
    'dirty nested content\n',
    'utf8'
  );

  const before = await subject.getChangedFiles({
    runId: 'dirty_submodule',
    workspacePath: created.workspacePath,
    baseRevision: head
  });
  assert.equal(findChange(before, 'vendor/sub').status, 'modified');

  await assert.rejects(
    subject.capture({
      runId: 'dirty_submodule',
      workspacePath: created.workspacePath,
      baseRevision: head
    }),
    (error) => error.code === 'uncapturable-worktree-effects'
      && error.details.headRevision === head
      && error.details.captureCommit === null
      && error.details.residualChanges.some((change) => change.path === 'vendor/sub')
  );
  assert.equal((await git(root, ['rev-parse', created.ref])).stdout.trim(), head);
  assert.equal(
    await readFile(path.join(created.workspacePath, 'vendor', 'sub', 'nested.txt'), 'utf8'),
    'dirty nested content\n'
  );
});

test('capture is idempotent when no new workspace changes exist', async (t) => {
  const { root, head } = await fixture(t);
  const subject = adapter(root);
  const created = await subject.create({ runId: 'stable', baseRevision: head });

  const first = await subject.capture({
    runId: 'stable',
    workspacePath: created.workspacePath,
    baseRevision: head
  });
  const second = await subject.capture({
    runId: 'stable',
    workspacePath: created.workspacePath,
    baseRevision: head
  });

  assert.equal(first.captureCommit, null);
  assert.equal(first.headRevision, head);
  assert.deepEqual(first.commits, []);
  assert.deepEqual(first.changedFiles, []);
  assert.equal(first.patch, '');
  assert.deepEqual(second, first);

  await subject.remove({ runId: 'stable', workspacePath: created.workspacePath });
});

test('strict run ownership rejects traversal and foreign workspace paths', async (t) => {
  const { root, head } = await fixture(t);
  const subject = adapter(root);

  for (const runId of ['../escape', 'nested/run', '.hidden', '-option', 'CON', '', 'a'.repeat(65)]) {
    await assert.rejects(
      subject.create({ runId, baseRevision: head }),
      (error) => error.code === 'invalid-run-id'
    );
  }

  const created = await subject.create({ runId: 'safe_run', baseRevision: head });
  const foreignPath = path.join(root, 'foreign');
  await mkdir(foreignPath);

  await assert.rejects(
    subject.getChangedFiles({
      runId: 'safe_run',
      workspacePath: foreignPath,
      baseRevision: head
    }),
    (error) => error.code === 'workspace-path-outside-run'
  );
  await assert.rejects(
    subject.capture({
      runId: 'safe_run',
      workspacePath: path.join(root, '.fwa', 'worktrees', '..', '..', 'foreign'),
      baseRevision: head
    }),
    (error) => error.code === 'workspace-path-outside-run'
  );
  await assert.rejects(
    subject.remove({ runId: 'safe_run', workspacePath: root, force: true }),
    (error) => error.code === 'workspace-path-outside-run'
  );

  assert.equal(await pathExists(created.workspacePath), true);
  await subject.remove({ runId: 'safe_run', workspacePath: created.workspacePath });
});

test('remove rejects a symlink substituted beneath the owned worktree directory', async (t) => {
  const { root } = await fixture(t);
  const subject = adapter(root);
  const worktreesDirectory = path.join(root, '.fwa', 'worktrees');
  const foreignDirectory = path.join(root, 'foreign-target');
  const marker = path.join(foreignDirectory, 'must-survive.txt');
  await mkdir(worktreesDirectory, { recursive: true });
  await mkdir(foreignDirectory);
  await writeFile(marker, 'safe\n', 'utf8');
  try {
    await symlink(
      foreignDirectory,
      path.join(worktreesDirectory, 'substituted'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`directory links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    subject.remove({
      runId: 'substituted',
      workspacePath: path.join(worktreesDirectory, 'substituted'),
      force: true
    }),
    (error) => error.code === 'invalid-workspace-path'
  );
  assert.equal(await readFile(marker, 'utf8'), 'safe\n');
});

test('remove refuses dirty worktrees unless force is explicit', async (t) => {
  const { root, head } = await fixture(t);
  const subject = adapter(root);
  const created = await subject.create({ runId: 'cleanup', baseRevision: head });
  await writeFile(path.join(created.workspacePath, 'local-only.txt'), 'dirty\n', 'utf8');

  await assert.rejects(
    subject.remove({ runId: 'cleanup', workspacePath: created.workspacePath }),
    (error) => error.code === 'worktree-remove-failed'
  );
  assert.equal(await pathExists(created.workspacePath), true);

  const result = await subject.remove({
    runId: 'cleanup',
    workspacePath: created.workspacePath,
    force: true
  });
  assert.equal(result.removed, true);
  assert.equal(await pathExists(created.workspacePath), false);
});
