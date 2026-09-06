import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  GitIntegrationAdapter,
  GitIntegrationError
} from '../src/adapters/git-integration.js';

const FIXED_TIME = new Date('2026-09-06T08:30:00.000Z');
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

async function commitTree(root, tree, parents, message) {
  const arguments_ = ['commit-tree', tree];
  for (const parent of parents) arguments_.push('-p', parent);
  arguments_.push('-m', message);
  return gitLine(root, arguments_);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-git-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Test']);
  await git(root, ['config', 'user.email', 'fwa-test@example.invalid']);
  await git(root, ['config', 'core.ignorecase', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n', 'utf8');
  await writeFile(path.join(root, 'seed.txt'), 'base\n', 'utf8');
  await git(root, ['add', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'base']);
  const baseRevision = await gitLine(root, ['rev-parse', 'HEAD']);

  await git(root, ['switch', '-c', 'accepted-source']);
  await writeFile(path.join(root, 'seed.txt'), 'accepted\n', 'utf8');
  await writeFile(path.join(root, 'added.txt'), 'new file\n', 'utf8');
  await git(root, ['add', '--', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'accepted change set']);
  const headRevision = await gitLine(root, ['rev-parse', 'HEAD']);
  await git(root, ['switch', 'main']);

  const subject = new GitIntegrationAdapter(root, { clock: () => FIXED_TIME });
  return { root, baseRevision, headRevision, subject };
}

function request(item, overrides = {}) {
  return {
    integrationId: 'integration_1',
    changeSetId: 'changeset_1',
    targetRef: TARGET_REF,
    expectedTargetRevision: item.baseRevision,
    changeSetHeadRevision: item.headRevision,
    ...overrides
  };
}

function candidateRef(integrationId = 'integration_1') {
  return `refs/fwa/integrations/${integrationId}/candidate`;
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

test('prepare creates an explicit candidate without moving the target or project root', async (t) => {
  const item = await fixture(t);
  const beforeStatus = (await git(item.root, ['status', '--porcelain=v1', '-z'])).stdout;

  const prepared = await item.subject.prepare(request(item));

  assert.equal(prepared.targetRef, TARGET_REF);
  assert.equal(prepared.expectedTargetRevision, item.baseRevision);
  assert.equal(prepared.changeSetHeadRevision, item.headRevision);
  assert.notEqual(prepared.candidateRevision, item.baseRevision);
  assert.notEqual(prepared.candidateRevision, item.headRevision);
  assert.equal(
    await gitLine(item.root, ['show-ref', '--verify', '--hash', candidateRef()]),
    prepared.candidateRevision
  );
  assert.equal(
    prepared.candidateTree,
    await gitLine(item.root, ['rev-parse', `${item.headRevision}^{tree}`])
  );
  assert.deepEqual(
    (await gitLine(item.root, [
      'rev-list', '--parents', '-n', '1', prepared.candidateRevision
    ])).split(' '),
    [prepared.candidateRevision, item.baseRevision]
  );
  assert.equal(
    await gitLine(item.root, ['show', '--no-patch', '--format=%s', prepared.candidateRevision]),
    'fwa(integration_1): integrate changeset_1'
  );
  assert.equal(await gitLine(item.root, ['rev-parse', TARGET_REF]), item.baseRevision);
  assert.equal(await gitLine(item.root, ['rev-parse', 'HEAD']), item.baseRevision);
  assert.equal(await gitLine(item.root, ['symbolic-ref', 'HEAD']), TARGET_REF);
  assert.equal(
    (await readFile(path.join(item.root, 'seed.txt'), 'utf8')).replaceAll('\r\n', '\n'),
    'base\n'
  );
  assert.equal((await git(item.root, ['status', '--porcelain=v1', '-z'])).stdout, beforeStatus);

  const inspection = await item.subject.inspect(prepared);
  assert.equal(inspection.disposition, 'not-applied');
  assert.equal(inspection.targetRevision, item.baseRevision);

  const runId = 'run_verify';
  const ref = `refs/heads/fwa/runs/${runId}`;
  await git(item.root, ['update-ref', ref, item.headRevision]);
  const verification = await item.subject.verifyChangeSet({
    id: 'changeset_verify',
    runId,
    branch: `fwa/runs/${runId}`,
    ref,
    baseRevision: item.baseRevision,
    headRevision: item.headRevision,
    commits: [item.headRevision]
  });
  assert.equal(verification.ok, true);
  assert.equal(verification.headRevision, item.headRevision);
});

test('prepare rejects empty trees, a non-descendant ChangeSet, and a moved target base', async (t) => {
  const item = await fixture(t);
  const baseTree = await gitLine(item.root, ['rev-parse', `${item.baseRevision}^{tree}`]);
  const sameTreeHead = await commitTree(
    item.root,
    baseTree,
    [item.baseRevision],
    'same tree'
  );
  await assert.rejects(
    item.subject.prepare(request(item, { changeSetHeadRevision: sameTreeHead })),
    (error) => error instanceof GitIntegrationError && error.code === 'empty-integration-tree'
  );

  const headTree = await gitLine(item.root, ['rev-parse', `${item.headRevision}^{tree}`]);
  const unrelated = await commitTree(item.root, headTree, [], 'unrelated source');
  await assert.rejects(
    item.subject.prepare(request(item, { changeSetHeadRevision: unrelated })),
    (error) => error instanceof GitIntegrationError && error.code === 'changeset-base-mismatch'
  );

  await git(item.root, ['switch', 'accepted-source']);
  const moved = await commitTree(item.root, baseTree, [item.baseRevision], 'move target');
  await git(item.root, ['update-ref', TARGET_REF, moved, item.baseRevision]);
  await assert.rejects(
    item.subject.prepare(request(item)),
    (error) => error instanceof GitIntegrationError && error.code === 'target-revision-mismatch'
  );
  assert.equal(await gitLine(item.root, ['rev-parse', TARGET_REF]), moved);
});

test('a clean project-root target is promoted by a safe fast-forward', async (t) => {
  const item = await fixture(t);
  const prepared = await item.subject.prepare(request(item));
  const originalSeed = await readFile(path.join(item.root, 'seed.txt'));

  await writeFile(path.join(item.root, 'seed.txt'), 'dirty\n', 'utf8');
  await assert.rejects(
    item.subject.promote(prepared),
    (error) => error instanceof GitIntegrationError && error.code === 'dirty-target-worktree'
  );
  assert.equal(await gitLine(item.root, ['rev-parse', TARGET_REF]), item.baseRevision);
  await writeFile(path.join(item.root, 'seed.txt'), originalSeed);
  assert.equal((await git(item.root, ['status', '--porcelain=v1', '-z'])).stdout, '');

  const promoted = await item.subject.promote(prepared);

  assert.equal(promoted.mode, 'root-fast-forward');
  assert.equal(promoted.previousRevision, item.baseRevision);
  assert.equal(promoted.targetRevision, prepared.candidateRevision);
  assert.equal(await gitLine(item.root, ['rev-parse', 'HEAD']), prepared.candidateRevision);
  assert.equal(await gitLine(item.root, ['rev-parse', TARGET_REF]), prepared.candidateRevision);
  assert.equal(
    (await readFile(path.join(item.root, 'seed.txt'), 'utf8')).replaceAll('\r\n', '\n'),
    'accepted\n'
  );
  assert.equal((await git(item.root, ['status', '--porcelain=v1', '-z'])).stdout, '');
  assert.equal((await item.subject.inspect(prepared)).disposition, 'applied');

  const verified = await item.subject.verify({
    id: prepared.integrationId,
    changeSetId: prepared.changeSetId,
    targetRef: prepared.targetRef,
    expectedTargetRevision: prepared.expectedTargetRevision,
    headRevision: prepared.changeSetHeadRevision,
    candidateRevision: prepared.candidateRevision,
    candidateTree: prepared.candidateTree,
    integratedRevision: prepared.candidateRevision,
    previousRevision: prepared.expectedTargetRevision
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.disposition, 'applied');

  const integratedSeed = await readFile(path.join(item.root, 'seed.txt'));
  await writeFile(path.join(item.root, 'seed.txt'), 'dirty after ref update\n', 'utf8');
  assert.equal((await item.subject.inspect(prepared)).disposition, 'inconsistent');
  assert.equal((await item.subject.verify({
    ...prepared,
    id: prepared.integrationId,
    headRevision: prepared.changeSetHeadRevision,
    integratedRevision: prepared.candidateRevision
  })).ok, true);
  await writeFile(path.join(item.root, 'seed.txt'), integratedSeed);
});

test('an un-checked-out target uses compare-and-swap without changing the project root', async (t) => {
  const item = await fixture(t);
  const prepared = await item.subject.prepare(request(item));
  await git(item.root, ['switch', 'accepted-source']);
  const before = {
    ref: await gitLine(item.root, ['symbolic-ref', 'HEAD']),
    head: await gitLine(item.root, ['rev-parse', 'HEAD']),
    status: (await git(item.root, ['status', '--porcelain=v1', '-z'])).stdout,
    seed: await readFile(path.join(item.root, 'seed.txt'), 'utf8')
  };

  const promoted = await item.subject.promote(prepared);

  assert.equal(promoted.mode, 'ref-cas');
  assert.equal(await gitLine(item.root, ['rev-parse', TARGET_REF]), prepared.candidateRevision);
  assert.equal(await gitLine(item.root, ['symbolic-ref', 'HEAD']), before.ref);
  assert.equal(await gitLine(item.root, ['rev-parse', 'HEAD']), before.head);
  assert.equal((await git(item.root, ['status', '--porcelain=v1', '-z'])).stdout, before.status);
  assert.equal(await readFile(path.join(item.root, 'seed.txt'), 'utf8'), before.seed);
});

test('promotion refuses a target checked out in any other worktree', async (t) => {
  const item = await fixture(t);
  const prepared = await item.subject.prepare(request(item));
  await git(item.root, ['switch', 'accepted-source']);
  const externalParent = await mkdtemp(path.join(os.tmpdir(), 'fwa-target-checkout-'));
  const external = path.join(externalParent, 'main');
  t.after(async () => {
    await git(item.root, ['worktree', 'remove', '--force', external], {
      allowedExitCodes: [0, 128]
    }).catch(() => {});
    await rm(externalParent, { recursive: true, force: true });
  });
  await git(item.root, ['worktree', 'add', external, 'main']);

  await assert.rejects(
    item.subject.promote(prepared),
    (error) => error instanceof GitIntegrationError
      && error.code === 'target-checked-out-elsewhere'
      && error.details.worktrees.some((entry) => path.resolve(entry) === path.resolve(external))
  );
  assert.equal(await gitLine(item.root, ['rev-parse', TARGET_REF]), item.baseRevision);
});

test('the atomic ref compare-and-swap detects a race after its final precheck', async (t) => {
  const item = await fixture(t);
  await git(item.root, ['switch', 'accepted-source']);
  const baseTree = await gitLine(item.root, ['rev-parse', `${item.baseRevision}^{tree}`]);
  const rival = await commitTree(item.root, baseTree, [item.baseRevision], 'rival target update');
  let injected = false;
  const racingSubject = new GitIntegrationAdapter(item.root, {
    clock: () => FIXED_TIME,
    gitRunner: async (executable, arguments_, options) => {
      if (!injected
        && arguments_[0] === 'update-ref'
        && arguments_[3] === TARGET_REF) {
        injected = true;
        await git(item.root, ['update-ref', TARGET_REF, rival, item.baseRevision]);
      }
      return run(executable, arguments_, options);
    }
  });
  const prepared = await racingSubject.prepare(request(item));

  await assert.rejects(
    racingSubject.promote(prepared),
    (error) => error instanceof GitIntegrationError
      && error.code === 'target-ref-race'
      && error.details.targetRevision === rival
  );
  assert.equal(injected, true);
  assert.equal(await gitLine(item.root, ['rev-parse', TARGET_REF]), rival);
});

test('inspection classifies recovery states and rejects candidate contract tampering', async (t) => {
  const item = await fixture(t);
  const prepared = await item.subject.prepare(request(item));
  assert.equal((await item.subject.inspect(prepared)).disposition, 'not-applied');

  await git(item.root, ['switch', 'accepted-source']);
  await item.subject.promote(prepared);
  assert.equal((await item.subject.inspect(prepared)).disposition, 'applied');

  const candidateTree = prepared.candidateTree;
  const advanced = await commitTree(
    item.root,
    candidateTree,
    [prepared.candidateRevision],
    'advance after integration'
  );
  await git(item.root, [
    'update-ref', TARGET_REF, advanced, prepared.candidateRevision
  ]);
  assert.equal((await item.subject.inspect(prepared)).disposition, 'advanced');
  assert.equal((await item.subject.verify({
    ...prepared,
    id: prepared.integrationId,
    headRevision: prepared.changeSetHeadRevision,
    integratedRevision: prepared.candidateRevision
  })).ok, true);

  const diverged = await commitTree(
    item.root,
    candidateTree,
    [item.baseRevision],
    'advance without candidate'
  );
  await git(item.root, ['update-ref', TARGET_REF, diverged, advanced]);
  assert.equal((await item.subject.inspect(prepared)).disposition, 'diverged');
  await assert.rejects(
    item.subject.verify({
      ...prepared,
      id: prepared.integrationId,
      headRevision: prepared.changeSetHeadRevision,
      integratedRevision: prepared.candidateRevision
    }),
    (error) => error instanceof GitIntegrationError && error.code === 'integration-not-contained'
  );

  const inconsistent = await commitTree(item.root, candidateTree, [], 'rewritten target');
  await git(item.root, ['update-ref', TARGET_REF, inconsistent, diverged]);
  assert.equal((await item.subject.inspect(prepared)).disposition, 'inconsistent');
  await git(item.root, ['update-ref', '-d', TARGET_REF, inconsistent]);
  const missing = await item.subject.inspect(prepared);
  assert.equal(missing.disposition, 'inconsistent');
  assert.equal(missing.targetRevision, null);

  const baseTree = await gitLine(item.root, ['rev-parse', `${item.baseRevision}^{tree}`]);
  await assert.rejects(
    item.subject.inspect({ ...prepared, candidateTree: baseTree }),
    (error) => error instanceof GitIntegrationError && error.code === 'candidate-contract-mismatch'
  );
  await assert.rejects(
    item.subject.inspect({ ...prepared, candidateRevision: item.headRevision }),
    (error) => error instanceof GitIntegrationError && error.code === 'candidate-ref-mismatch'
  );
});

test('a durable candidate ref survives aggressive garbage collection', async (t) => {
  const item = await fixture(t);
  const prepared = await item.subject.prepare(request(item));

  await git(item.root, ['reflog', 'expire', '--expire=now', '--all']);
  await git(item.root, ['gc', '--prune=now']);

  assert.equal(
    await gitLine(item.root, ['show-ref', '--verify', '--hash', candidateRef()]),
    prepared.candidateRevision
  );
  assert.equal((await item.subject.inspect(prepared)).disposition, 'not-applied');

  await item.subject.promote(prepared);
  await git(item.root, ['reflog', 'expire', '--expire=now', '--all']);
  await git(item.root, ['gc', '--prune=now']);
  assert.equal((await item.subject.verify({
    ...prepared,
    id: prepared.integrationId,
    headRevision: prepared.changeSetHeadRevision,
    integratedRevision: prepared.candidateRevision
  })).ok, true);
});

test('candidate contract inspection ignores Git replacement objects', async (t) => {
  const item = await fixture(t);
  const baseTree = await gitLine(item.root, [
    '--no-replace-objects', 'rev-parse', `${item.baseRevision}^{tree}`
  ]);
  const rawHeadTree = await gitLine(item.root, [
    '--no-replace-objects', 'rev-parse', `${item.headRevision}^{tree}`
  ]);
  const replacementHead = await commitTree(
    item.root,
    baseTree,
    [item.baseRevision],
    'replacement head'
  );
  await git(item.root, ['replace', item.headRevision, replacementHead]);

  const prepared = await item.subject.prepare(request(item));
  assert.equal(prepared.candidateTree, rawHeadTree);

  const replacementCandidate = await commitTree(
    item.root,
    baseTree,
    [item.baseRevision],
    `fwa(${prepared.integrationId}): integrate ${prepared.changeSetId}`
  );
  await git(item.root, ['replace', prepared.candidateRevision, replacementCandidate]);
  assert.equal(
    await gitLine(item.root, ['rev-parse', `${prepared.candidateRevision}^{tree}`]),
    baseTree
  );
  assert.equal((await item.subject.inspect(prepared)).disposition, 'not-applied');
});

test('every integration Git command receives a sanitized environment', async (t) => {
  const item = await fixture(t);
  const observed = [];
  const subject = new GitIntegrationAdapter(item.root, {
    clock: () => FIXED_TIME,
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

  try {
    const prepared = await subject.prepare(request(item));
    assert.equal((await subject.inspect(prepared)).disposition, 'not-applied');
  } finally {
    restore();
  }
  assert.ok(observed.length > 0);
});

test('target refs require exact spelling and reject case conflicts', async (t) => {
  const item = await fixture(t);
  await assert.rejects(
    item.subject.prepare(request(item, { targetRef: 'refs/heads/MAIN' })),
    (error) => error instanceof GitIntegrationError
      && error.code === 'target-ref-case-mismatch'
      && error.details.actualRef === TARGET_REF
  );

  if (process.platform !== 'win32') {
    await git(item.root, ['update-ref', 'refs/heads/MAIN', item.baseRevision]);
    await assert.rejects(
      item.subject.prepare(request(item)),
      (error) => error instanceof GitIntegrationError
        && error.code === 'target-ref-case-conflict'
        && error.details.refs.includes(TARGET_REF)
        && error.details.refs.includes('refs/heads/MAIN')
    );
  }
});

test('public inputs require a fully-qualified branch ref and full object ids', async (t) => {
  const item = await fixture(t);
  const shortRevision = item.baseRevision.slice(0, 12);
  await assert.rejects(
    item.subject.prepare(request(item, { targetRef: 'main' })),
    (error) => error instanceof GitIntegrationError && error.code === 'invalid-target-ref'
  );
  await assert.rejects(
    item.subject.prepare(request(item, { targetRef: 'refs/tags/main' })),
    (error) => error instanceof GitIntegrationError && error.code === 'invalid-target-ref'
  );
  await assert.rejects(
    item.subject.prepare(request(item, { expectedTargetRevision: shortRevision })),
    (error) => error instanceof GitIntegrationError && error.code === 'invalid-object-id'
  );
});
