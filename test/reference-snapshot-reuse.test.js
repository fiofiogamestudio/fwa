import assert from 'node:assert/strict';
import test from 'node:test';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReferenceLibrary } from '../src/application/reference-library.js';

const file = (relative, content = 'safe') => ({ path: relative, base64: Buffer.from(content).toString('base64') });
const fails = code => error => error.code === code;
async function fixture(t, files = [file('docs/a.txt'), file('b.txt')], directories = ['empty']) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-snapshot-reuse-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert.ok(relative.startsWith('fwa-snapshot-reuse-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const library = new ReferenceLibrary(root); await library.init();
  const imported = await library.importFiles({ commandId: 'import', libraryId: 'data', label: 'Data', files, directories });
  const parent = path.join(root, '.fwa', 'snapshots'); await mkdir(parent);
  const version = await library.tree({ libraryId: 'data' });
  const options = { libraryId: 'data', versionId: imported.versionId, destinationRoot: path.join(parent, 'stable'),
    authorized: true, reuseExisting: true, expectedPermissionHash: version.permissionHash };
  return { root, parent, library, options };
}
async function assertNoStaging(parent) {
  assert.equal((await readdir(parent)).some(name => name.startsWith('.snapshot-')), false, 'The caller must clean its own staging directory.');
}

test('two independent callers publish a complete reusable snapshot and preserve the default new-only contract', async t => {
  const files = Array.from({ length: 12 }, (_, index) => file(`docs/${index}.txt`, `${index}:` + 'x'.repeat(16 * 1024)));
  const { root, parent, library, options } = await fixture(t, files);
  const reopened = new ReferenceLibrary(root);
  let done = false, visibleChecks = 0, observationError;
  const inspectVisible = async () => {
    try { await lstat(options.destinationRoot); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const expected of files) assert.equal(await readFile(path.join(options.destinationRoot, expected.path), 'utf8'), Buffer.from(expected.base64, 'base64').toString('utf8'));
    assert.deepEqual(await readdir(path.join(options.destinationRoot, 'empty')), []); visibleChecks++;
  };
  const observer = (async () => {
    while (!done) { await inspectVisible(); await setImmediate(); }
    await inspectVisible();
  })().catch(error => { observationError = error; });
  const results = await Promise.allSettled([library.materializeSnapshot(options), reopened.materializeSnapshot(options)]);
  done = true; await observer;
  assert.equal(observationError, undefined, observationError?.stack);
  for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.stack);
  assert.deepEqual(results[0].value, results[1].value); assert.ok(visibleChecks > 0);
  assert.deepEqual(await readdir(parent), ['stable']);
  assert.deepEqual(await reopened.materializeSnapshot(options), results[0].value);
  const { reuseExisting, ...newOnly } = options;
  await assert.rejects(library.materializeSnapshot(newOnly), fails('library-destination-exists'));
  await assert.rejects(library.materializeSnapshot({ ...options, reuseExisting: false }), fails('library-destination-exists'));
  await assertNoStaging(parent);
});

test('reuse refuses corrupted bytes, extra paths and missing entries without repairing the suspect cache', async t => {
  for (const kind of ['tampered', 'extra-file', 'extra-directory', 'missing-file', 'missing-directory', 'file-as-directory']) {
    await t.test(kind, async t => {
      const { parent, library, options } = await fixture(t);
      await library.materializeSnapshot(options);
      const target = path.join(options.destinationRoot, 'docs/a.txt');
      if (kind === 'tampered') await writeFile(target, 'evil');
      if (kind === 'extra-file') await writeFile(path.join(options.destinationRoot, 'injected.txt'), 'unexpected');
      if (kind === 'extra-directory') await mkdir(path.join(options.destinationRoot, 'injected'));
      if (kind === 'missing-file' || kind === 'file-as-directory') await unlink(target);
      if (kind === 'missing-directory') await rmdir(path.join(options.destinationRoot, 'empty'));
      if (kind === 'file-as-directory') await mkdir(target);
      await assert.rejects(library.materializeSnapshot(options), fails('library-snapshot-mismatch'));
      if (kind === 'tampered') assert.equal(await readFile(target, 'utf8'), 'evil');
      if (kind === 'extra-file') assert.equal(await readFile(path.join(options.destinationRoot, 'injected.txt'), 'utf8'), 'unexpected');
      if (kind === 'extra-directory') assert.equal((await lstat(path.join(options.destinationRoot, 'injected'))).isDirectory(), true);
      if (kind === 'missing-file') await assert.rejects(lstat(target), fails('ENOENT'));
      if (kind === 'missing-directory') await assert.rejects(lstat(path.join(options.destinationRoot, 'empty')), fails('ENOENT'));
      if (kind === 'file-as-directory') assert.equal((await lstat(target)).isDirectory(), true);
      await assertNoStaging(parent);
    });
  }
});

test('reuse rejects a linked snapshot root and linked descendant directory without touching their targets', async t => {
  for (const kind of ['root', 'descendant']) await t.test(kind, async t => {
    const { root, parent, library, options } = await fixture(t);
    await library.materializeSnapshot(options);
    const source = kind === 'root' ? options.destinationRoot : path.join(options.destinationRoot, 'docs');
    const outside = path.join(root, 'retained-target'); await rename(source, outside);
    await symlink(outside, source, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(library.materializeSnapshot(options), fails(kind === 'root' ? 'library-unsafe-storage' : 'library-snapshot-mismatch'));
    assert.equal(await readFile(path.join(outside, kind === 'root' ? 'docs/a.txt' : 'a.txt'), 'utf8'), 'safe');
    assert.equal((await lstat(source)).isSymbolicLink(), true); await assertNoStaging(parent);
  });
});

test('reuse rejects a hardlinked cached file even when the linked bytes match the manifest', async t => {
  const { root, parent, library, options } = await fixture(t); await library.materializeSnapshot(options);
  const target = path.join(options.destinationRoot, 'docs/a.txt'), original = path.join(root, 'original.txt');
  await writeFile(original, 'safe'); await unlink(target); await link(original, target);
  await assert.rejects(library.materializeSnapshot(options), fails('library-unsafe-storage'));
  assert.equal(await readFile(original, 'utf8'), 'safe'); assert.ok((await lstat(target)).nlink > 1); await assertNoStaging(parent);
});

test('reuse rejects a file symlink when this host permits creating file symlinks', async t => {
  const { root, parent, library, options } = await fixture(t); await library.materializeSnapshot(options);
  const target = path.join(options.destinationRoot, 'docs/a.txt'), original = path.join(root, 'original.txt');
  await writeFile(original, 'safe'); await unlink(target);
  try { await symlink(original, target, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not grant file-symlink creation; directory junction rejection is tested separately.'); return; } throw error; }
  await assert.rejects(library.materializeSnapshot(options), fails('library-snapshot-mismatch'));
  assert.equal(await readFile(original, 'utf8'), 'safe'); assert.equal((await lstat(target)).isSymbolicLink(), true); await assertNoStaging(parent);
});

test('a stale expected permission hash rejects both new publication and reuse before modifying the destination', async t => {
  const { parent, library, options } = await fixture(t); await library.materializeSnapshot(options);
  await library.setPermission({ commandId: 'deny-one', libraryId: 'data', path: 'b.txt', access: 'deny' });
  const current = await library.tree({ libraryId: 'data' }); assert.notEqual(current.permissionHash, options.expectedPermissionHash);
  await assert.rejects(library.materializeSnapshot(options), fails('library-permission-changed'));
  assert.equal(await readFile(path.join(options.destinationRoot, 'b.txt'), 'utf8'), 'safe');
  const fresh = path.join(parent, 'not-published');
  await assert.rejects(library.materializeSnapshot({ ...options, destinationRoot: fresh }), fails('library-permission-changed'));
  await assert.rejects(lstat(fresh), fails('ENOENT')); await assertNoStaging(parent);
});

test('a readable child of denied ancestors can be reused without exposing its denied siblings', async t => {
  const { parent, library, options } = await fixture(t, [file('private/nested/public.txt'), file('private/nested/secret.txt')], []);
  await library.setPermission({ commandId: 'deny-parent', libraryId: 'data', path: 'private', access: 'deny' });
  await library.setPermission({ commandId: 'allow-child', libraryId: 'data', path: 'private/nested/public.txt', access: 'read' });
  options.expectedPermissionHash = (await library.tree({ libraryId: 'data' })).permissionHash;
  const snapshot = await library.materializeSnapshot(options), replay = await library.materializeSnapshot(options);
  assert.deepEqual(replay, snapshot); assert.deepEqual(snapshot.files.map(entry => entry.path), ['private/nested/public.txt']);
  assert.deepEqual(snapshot.omitted, ['private', 'private/nested', 'private/nested/secret.txt']);
  assert.equal(await readFile(path.join(options.destinationRoot, 'private/nested/public.txt'), 'utf8'), 'safe');
  assert.deepEqual(await readdir(path.join(options.destinationRoot, 'private/nested')), ['public.txt']); await assertNoStaging(parent);
});

test('all-denied references publish and concurrently reuse an empty directory without weakening new-only or extra-path checks', async t => {
  const { root, parent, library, options } = await fixture(t);
  await library.setPermission({ commandId: 'deny-all', libraryId: 'data', path: '', access: 'deny' });
  options.expectedPermissionHash = (await library.tree({ libraryId: 'data' })).permissionHash;
  const results = await Promise.allSettled([library.materializeSnapshot(options), new ReferenceLibrary(root).materializeSnapshot(options)]);
  for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.stack);
  assert.deepEqual(results[0].value, results[1].value); assert.deepEqual(results[0].value.files, []);
  assert.deepEqual(await readdir(options.destinationRoot), []);
  await assert.rejects(library.materializeSnapshot({ ...options, reuseExisting: false }), fails('library-destination-exists'));
  await writeFile(path.join(options.destinationRoot, 'unexpected.txt'), 'not authorized');
  await assert.rejects(library.materializeSnapshot(options), fails('library-snapshot-mismatch'));
  assert.equal(await readFile(path.join(options.destinationRoot, 'unexpected.txt'), 'utf8'), 'not authorized'); await assertNoStaging(parent);
});
