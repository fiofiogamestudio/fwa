import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sourceSnapshot } from '../tools/source-snapshot.mjs';

test('source manifests are deterministic and cover source, tests, examples and documentation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-source-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['package.json', 'README.md', '.editorconfig', '.gitignore', '.npmignore']) {
    await writeFile(path.join(root, name), name);
  }
  for (const directory of ['bin', 'src', 'test', 'tools', 'examples', 'docs']) {
    await mkdir(path.join(root, directory));
    await writeFile(path.join(root, directory, 'sample.txt'), directory);
  }
  const before = await sourceSnapshot(root);
  assert.deepEqual(before, await sourceSnapshot(root));
  assert.equal(before.files.length, 11);
  await writeFile(path.join(root, 'test', 'sample.txt'), 'changed regression');
  const after = await sourceSnapshot(root);
  assert.notEqual(after.digest, before.digest);
  assert.equal(after.files.find((file) => file.path === 'src/sample.txt').sha256,
    before.files.find((file) => file.path === 'src/sample.txt').sha256);
});
