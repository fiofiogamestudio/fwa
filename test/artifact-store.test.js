import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ArtifactStore,
  createArtifactRef
} from '../src/storage/artifact-store.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-artifact-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  await store.init();
  return {
    root,
    store,
    hashDirectory: path.join(root, '.fwa', 'artifacts', 'sha256')
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function artifactPath(hashDirectory, artifactDigest) {
  return path.join(hashDirectory, artifactDigest.slice(0, 2), artifactDigest);
}

test('stores immutable bytes by SHA-256 and returns a portable event ref', async (t) => {
  const { store, hashDirectory } = await fixture(t);
  const ref = await store.put('hello');

  assert.deepEqual(ref, {
    schemaVersion: 1,
    algorithm: 'sha256',
    digest: digest('hello'),
    size: 5
  });
  assert.equal(Object.isFrozen(ref), true);
  assert.equal(ref.digest.includes(path.sep), false);
  assert.equal((await store.get(ref)).toString('utf8'), 'hello');
  assert.deepEqual(await store.verify(ref), { ok: true, ref });
  assert.deepEqual(await store.verify(), {
    ok: true,
    artifactCount: 1,
    totalBytes: 5
  });
  assert.deepEqual(await store.listRefs(), [ref]);
  assert.equal(Object.isFrozen(await store.listRefs()), true);

  const files = await readdir(path.join(hashDirectory, ref.digest.slice(0, 2)));
  assert.deepEqual(files, [ref.digest]);
});

test('deduplicates existing content only after re-verifying it', async (t) => {
  const { store } = await fixture(t);
  const first = await store.put(Buffer.from('same bytes'));
  const second = await store.put(new Uint8Array(Buffer.from('same bytes')));
  assert.deepEqual(second, first);
  assert.deepEqual(await store.verify(), {
    ok: true,
    artifactCount: 1,
    totalBytes: 10
  });
});

test('concurrent identical writes converge without replacing content', async (t) => {
  const { store, hashDirectory } = await fixture(t);
  const refs = await Promise.all(
    Array.from({ length: 20 }, () => store.put('concurrent payload'))
  );
  assert.equal(new Set(refs.map((ref) => ref.digest)).size, 1);
  const [ref] = refs;
  assert.equal((await readFile(artifactPath(hashDirectory, ref.digest))).toString(), 'concurrent payload');
  assert.equal(
    (await readdir(path.join(hashDirectory, ref.digest.slice(0, 2))))
      .some((name) => name.endsWith('.tmp')),
    false
  );
});

test('recovers a publication temp only when it is a hardlink to the final artifact', async (t) => {
  const { store, hashDirectory } = await fixture(t);
  const ref = await store.put('published bytes');
  const shard = path.join(hashDirectory, ref.digest.slice(0, 2));
  const finalPath = artifactPath(hashDirectory, ref.digest);
  const tempPath = path.join(
    shard,
    `.artifact-${ref.digest}-11111111-1111-4111-8111-111111111111.tmp`
  );
  await link(finalPath, tempPath);

  const verification = await store.verify();
  assert.equal(verification.ok, true);
  assert.equal((await readdir(shard)).includes(path.basename(tempPath)), false);
  assert.equal((await store.get(ref)).toString('utf8'), 'published bytes');
});

test('never recovers a copied artifact temp merely because its bytes match', async (t) => {
  const { store, hashDirectory } = await fixture(t);
  const ref = await store.put('same bytes are not identity');
  const shard = path.join(hashDirectory, ref.digest.slice(0, 2));
  const finalPath = artifactPath(hashDirectory, ref.digest);
  const tempPath = path.join(
    shard,
    `.artifact-${ref.digest}-22222222-2222-4222-8222-222222222222.tmp`
  );
  await writeFile(tempPath, await readFile(finalPath));

  await assert.rejects(
    store.verify(),
    (error) => error.code === 'orphan-temporary-artifact'
  );
  assert.equal((await readFile(finalPath)).toString(), 'same bytes are not identity');
  assert.equal((await readFile(tempPath)).toString(), 'same bytes are not identity');
});

test('snapshots caller-owned buffers before persistence', async (t) => {
  const { store } = await fixture(t);
  const source = Buffer.from('before');
  const ref = await store.put(source);
  source.fill(0);
  assert.equal((await store.get(ref)).toString(), 'before');
});

test('stores empty and binary artifacts without text conversion', async (t) => {
  const { store } = await fixture(t);
  const empty = await store.put(Buffer.alloc(0));
  const binary = await store.put(Uint8Array.from([0, 255, 1, 128]));
  assert.equal(empty.size, 0);
  assert.deepEqual([...await store.get(binary)], [0, 255, 1, 128]);
  assert.deepEqual(await store.verify(), {
    ok: true,
    artifactCount: 2,
    totalBytes: 4
  });
});

test('detects content corruption and never overwrites the addressed file', async (t) => {
  const { store, hashDirectory } = await fixture(t);
  const ref = await store.put('trusted');
  const filePath = artifactPath(hashDirectory, ref.digest);
  await writeFile(filePath, 'tampered', 'utf8');

  await assert.rejects(
    store.get(ref),
    (error) => error.code === 'artifact-corruption'
  );
  await assert.rejects(
    store.verify(),
    (error) => error.code === 'artifact-corruption'
  );
  await assert.rejects(
    store.put('trusted'),
    (error) => error.code === 'artifact-corruption'
  );
  assert.equal((await readFile(filePath, 'utf8')), 'tampered');
});

test('validates refs, declared sizes, missing objects, and input content', async (t) => {
  const { store } = await fixture(t);
  const ref = await store.put('value');

  await assert.rejects(
    store.get({ ...ref, size: ref.size + 1 }),
    (error) => error.code === 'artifact-corruption'
  );
  await assert.rejects(
    store.get(createArtifactRef('0'.repeat(64), 0)),
    (error) => error.code === 'artifact-not-found'
  );
  await assert.rejects(
    store.get({ ...ref, extra: true }),
    (error) => error.code === 'invalid-artifact-ref'
  );
  await assert.rejects(
    store.put({ unsupported: true }),
    (error) => error.code === 'invalid-artifact-content'
  );
  assert.throws(
    () => createArtifactRef('ABC', 1),
    (error) => error.code === 'invalid-artifact-ref'
  );
});

test('rejects orphaned publish files before reads and writes', async (t) => {
  const { store, hashDirectory } = await fixture(t);
  const ref = await store.put('original');
  const orphan = path.join(
    hashDirectory,
    ref.digest.slice(0, 2),
    `.artifact-${ref.digest}-interrupted.tmp`
  );
  await writeFile(orphan, 'partial', 'utf8');

  await assert.rejects(
    store.verify(),
    (error) => error.code === 'orphan-temporary-artifact'
  );
  await assert.rejects(
    store.get(ref),
    (error) => error.code === 'orphan-temporary-artifact'
  );
  await assert.rejects(
    store.put('new content'),
    (error) => error.code === 'orphan-temporary-artifact'
  );
});

test('rejects malformed object layout instead of ignoring it', async (t) => {
  const { store, hashDirectory } = await fixture(t);
  await writeFile(path.join(hashDirectory, 'unexpected.json'), '{}\n', 'utf8');
  await assert.rejects(
    store.verify(),
    (error) => error.code === 'artifact-store-corruption'
  );

  const other = await fixture(t);
  const wrongShard = path.join(other.hashDirectory, 'aa');
  await mkdir(wrongShard);
  await writeFile(path.join(wrongShard, 'b'.repeat(64)), 'content', 'utf8');
  await assert.rejects(
    other.store.verify(),
    (error) => error.code === 'artifact-store-corruption'
  );

  const sibling = await fixture(t);
  await writeFile(
    path.join(sibling.root, '.fwa', 'artifacts', 'unexpected'),
    'not store data',
    'utf8'
  );
  await assert.rejects(
    sibling.store.verify(),
    (error) => error.code === 'artifact-store-corruption'
  );
});

test('rejects symlinked artifact directories', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-artifact-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, '.fwa');
  const outside = path.join(root, 'outside');
  await mkdir(stateDirectory);
  await mkdir(outside);
  try {
    await symlink(outside, path.join(stateDirectory, 'artifacts'), 'junction');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('This Windows account cannot create directory links.');
      return;
    }
    throw error;
  }

  const store = new ArtifactStore(root);
  await assert.rejects(
    store.init(),
    (error) => error.code === 'unsafe-artifact-path'
  );
});

test('rejects symlinked artifact objects', async (t) => {
  const { root, store, hashDirectory } = await fixture(t);
  const expectedDigest = digest('outside');
  const shard = path.join(hashDirectory, expectedDigest.slice(0, 2));
  const outside = path.join(root, 'outside.bin');
  await mkdir(shard);
  await writeFile(outside, 'outside', 'utf8');
  try {
    await symlink(outside, path.join(shard, expectedDigest), 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.diagnostic('Skipping file-symlink subcase because it is not permitted.');
      return;
    }
    throw error;
  }

  await assert.rejects(
    store.verify(),
    (error) => error.code === 'unsafe-artifact-path'
  );
});

test('requires explicit initialization and real project paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-artifact-uninitialized-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  await assert.rejects(
    store.put('content'),
    (error) => error.code === 'artifact-store-not-initialized'
  );

  assert.throws(
    () => new ArtifactStore(''),
    (error) => error.code === 'invalid-project-root'
  );
});
