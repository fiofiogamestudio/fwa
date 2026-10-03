import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runGitProcess } from '../src/adapters/git-process.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';

const execute = promisify(execFile);
async function git(cwd, args) {
  return (await execute('git', args, { cwd, windowsHide: true })).stdout.trimEnd();
}

async function fixture(t, { empty = false, target = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-restore-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'FWA Test']);
  await git(root, ['config', 'user.email', 'fwa-test@example.invalid']);
  await git(root, ['config', 'core.ignorecase', 'false']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n*.ignored\n');
  await writeFile(path.join(root, 'retained.cjs'), 'exports.value = 1;\n');
  await writeFile(path.join(root, 'old-name.txt'), 'Retain this rename content verbatim.\n');
  await writeFile(path.join(root, 'deleted.txt'), 'delete me\n');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await git(root, ['add', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'initial']);
  const baseRevision = await git(root, ['rev-parse', 'HEAD']);
  const adapter = new GitWorktreeAdapter(root);
  const source = await adapter.create({ runId: 'source', baseRevision });
  const retained = 'function retainedHelper() { return 41; }\nexports.value = retainedHelper();\n';
  const binary = Buffer.from([0, 255, 3, 9, 0, 7]);
  if (!empty) {
    await writeFile(path.join(source.workspacePath, 'retained.cjs'), retained);
    await writeFile(path.join(source.workspacePath, 'binary.bin'), binary);
    await rename(path.join(source.workspacePath, 'old-name.txt'), path.join(source.workspacePath, 'new-name.txt'));
    await rm(path.join(source.workspacePath, 'deleted.txt'));
  }
  const captured = await adapter.capture({ ...source, baseRevision });
  const { patch } = captured;
  const changeSet = {
    ...captured,
    id: 'changeset-source',
    changes: captured.changedFiles,
    changedFiles: [...new Set(captured.changedFiles.map(change => change.path))]
      .sort((left, right) => left.localeCompare(right)),
    patchArtifact: { digest: createHash('sha256').update(patch).digest('hex') }
  };
  const destination = target ? await adapter.create({ runId: 'repair', baseRevision }) : null;
  const input = destination ? { ...destination, changeSet, patch: Buffer.from(patch), writes: ['**'] } : null;
  return { root, adapter, source, destination, baseRevision, patch, changeSet, input, retained, binary };
}

async function snapshot(root) {
  return {
    head: await git(root, ['rev-parse', 'HEAD']),
    index: await git(root, ['write-tree']),
    status: await git(root, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all']),
    diff: await git(root, ['diff', '--binary', 'HEAD'])
  };
}

test('restoration retains text, binary, deletion and both rename effects without moving any HEAD', async (t) => {
  const f = await fixture(t);
  const hostBefore = await snapshot(f.root);
  const result = await f.adapter.restoreCandidate(f.input);
  assert.deepEqual(result, { status: 'restored', changeSetId: f.changeSet.id,
    baseRevision: f.baseRevision, candidateRevision: f.changeSet.headRevision });
  assert.deepEqual(await snapshot(f.root), hostBefore);
  assert.equal(await git(f.destination.workspacePath, ['rev-parse', 'HEAD']), f.baseRevision);
  assert.equal(await readFile(path.join(f.destination.workspacePath, 'retained.cjs'), 'utf8'), f.retained);
  assert.deepEqual(await readFile(path.join(f.destination.workspacePath, 'binary.bin')), f.binary);
  await assert.rejects(access(path.join(f.destination.workspacePath, 'deleted.txt')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(f.destination.workspacePath, 'old-name.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.destination.workspacePath, 'new-name.txt'), 'utf8'),
    'Retain this rename content verbatim.\n');
  await writeFile(path.join(f.destination.workspacePath, 'retained.cjs'), f.retained.replace('return 41', 'return 42'));
  const repaired = await f.adapter.capture({ ...f.destination, baseRevision: f.baseRevision });
  assert.equal(repaired.commits.length, 1);
  assert.notEqual(repaired.headRevision, f.changeSet.headRevision);
  assert.match(repaired.patch, /retainedHelper/u);
  assert.match(repaired.patch, /GIT binary patch/u);
  assert.deepEqual(await snapshot(f.root), hostBefore);
});

test('an empty verified candidate restores successfully without changing the fresh target', async (t) => {
  const f = await fixture(t, { empty: true });
  const before = await snapshot(f.destination.workspacePath);
  assert.equal((await f.adapter.restoreCandidate(f.input)).status, 'restored');
  assert.deepEqual(await snapshot(f.destination.workspacePath), before);
});

test('mismatched patch bytes, artifact digest, ref, history, changes and paths reject before writes', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.destination.workspacePath);
  const cases = [
    { input: { ...f.input, patch: Buffer.from(`${f.patch}\n`) }, code: 'repair-candidate-patch-mismatch' },
    { source: { patchArtifact: { digest: '0'.repeat(64) } }, code: 'repair-candidate-source-mismatch' },
    { source: { ref: 'refs/heads/main' }, code: 'repair-candidate-source-invalid' },
    { source: { commits: [] }, code: 'repair-candidate-source-invalid' },
    { source: { changes: [] }, code: 'repair-candidate-source-mismatch' },
    { source: { changedFiles: f.changeSet.changedFiles.filter(file => file !== 'old-name.txt') }, code: 'repair-candidate-paths-mismatch' }
  ];
  for (const item of cases) {
    await assert.rejects(f.adapter.restoreCandidate(item.input ?? {
      ...f.input, changeSet: { ...f.changeSet, ...item.source }
    }), { code: item.code });
    assert.deepEqual(await snapshot(f.destination.workspacePath), before);
  }
  await git(f.root, ['update-ref', f.changeSet.ref, f.baseRevision, f.changeSet.headRevision]);
  await assert.rejects(f.adapter.restoreCandidate(f.input), { code: 'repair-candidate-source-invalid' });
  assert.deepEqual(await snapshot(f.destination.workspacePath), before);
});

test('current write scope covers rename source and honors actual Git ignorecase', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.destination.workspacePath);
  await assert.rejects(f.adapter.restoreCandidate({ ...f.input,
    writes: f.changeSet.changedFiles.filter(file => file !== 'old-name.txt')
  }), { code: 'repair-candidate-scope-violation' });
  const upperWrites = f.changeSet.changedFiles.map(file => file.toUpperCase());
  await assert.rejects(f.adapter.restoreCandidate({ ...f.input, writes: upperWrites }),
    { code: 'repair-candidate-scope-violation' });
  assert.deepEqual(await snapshot(f.destination.workspacePath), before);
  await git(f.root, ['config', 'core.ignorecase', 'true']);
  assert.equal((await f.adapter.restoreCandidate({ ...f.input, writes: upperWrites })).status, 'restored');
});

test('dirty, ignored and advanced targets cannot be overwritten by candidate restoration', async (t) => {
  const f = await fixture(t);
  for (const name of ['retained.cjs', 'new-untracked.txt', 'generated.ignored']) {
    const file = path.join(f.destination.workspacePath, name);
    await writeFile(file, 'external work\n');
    const before = await snapshot(f.destination.workspacePath);
    await assert.rejects(f.adapter.restoreCandidate(f.input), { code: 'repair-candidate-target-not-fresh' });
    assert.deepEqual(await snapshot(f.destination.workspacePath), before);
    if (name === 'retained.cjs') await git(f.destination.workspacePath, ['restore', '--', name]);
    else await rm(file);
  }
  await git(f.destination.workspacePath, ['commit', '--allow-empty', '--no-gpg-sign', '-m', 'external advance']);
  const before = await snapshot(f.destination.workspacePath);
  await assert.rejects(f.adapter.restoreCandidate(f.input), { code: 'repair-candidate-target-not-fresh' });
  assert.deepEqual(await snapshot(f.destination.workspacePath), before);
});

test('a changed base reports explicit fallback without changing target or host', async (t) => {
  const f = await fixture(t, { target: false });
  await writeFile(path.join(f.root, 'retained.cjs'), 'exports.value = 99;\n');
  await git(f.root, ['add', 'retained.cjs']);
  await git(f.root, ['commit', '--no-gpg-sign', '-m', 'new baseline']);
  const destination = await f.adapter.create({ runId: 'repair' });
  const before = await snapshot(destination.workspacePath);
  const hostBefore = await snapshot(f.root);
  assert.deepEqual(await f.adapter.restoreCandidate({ ...destination,
    changeSet: f.changeSet, patch: f.patch, writes: ['**']
  }), { status: 'baseline-changed', changeSetId: f.changeSet.id,
    baseRevision: destination.baseRevision, candidateRevision: f.changeSet.headRevision,
    candidateBaseRevision: f.baseRevision });
  assert.deepEqual(await snapshot(destination.workspacePath), before);
  assert.deepEqual(await snapshot(f.root), hostBefore);
});

test('restoration requires the registered run path, expected branch and a different source run', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.destination.workspacePath);
  await assert.rejects(f.adapter.restoreCandidate({ ...f.input, workspacePath: f.root }),
    { code: 'repair-candidate-target-invalid' });
  await assert.rejects(f.adapter.restoreCandidate({ ...f.input,
    changeSet: { ...f.changeSet, runId: f.destination.runId }
  }), { code: 'repair-candidate-same-run' });
  assert.deepEqual(await snapshot(f.destination.workspacePath), before);
  await git(f.destination.workspacePath, ['checkout', '--detach', f.baseRevision]);
  const detachedBefore = await snapshot(f.destination.workspacePath);
  await assert.rejects(f.adapter.restoreCandidate(f.input), { code: 'repair-candidate-target-invalid' });
  assert.deepEqual(await snapshot(f.destination.workspacePath), detachedBefore);
});

test('a target changed after apply check is preserved and no patch is applied', async (t) => {
  const f = await fixture(t);
  let injected = false;
  const adapter = new GitWorktreeAdapter(f.root, { gitRunner: async (executable, args, options) => {
    const result = await runGitProcess(executable, args, options);
    if (args[0] === 'apply' && args.includes('--check')) {
      await writeFile(path.join(f.destination.workspacePath, 'concurrent.txt'), 'keep external work\n');
      injected = true;
    }
    return result;
  } });
  await assert.rejects(adapter.restoreCandidate(f.input), { code: 'repair-candidate-target-not-fresh' });
  assert.equal(injected, true);
  assert.equal(await readFile(path.join(f.destination.workspacePath, 'retained.cjs'), 'utf8'), 'exports.value = 1;\n');
  assert.equal(await readFile(path.join(f.destination.workspacePath, 'concurrent.txt'), 'utf8'), 'keep external work\n');
  assert.equal(await git(f.destination.workspacePath, ['diff', '--cached']), '');
});
