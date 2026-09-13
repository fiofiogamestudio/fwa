import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { ReferenceLibrary, resolveLibraryPermission, REFERENCE_LIBRARY_LIMITS } from '../src/application/reference-library.js';
import { boundedBase64, normalizeEntries } from '../src/storage/library-files.js';
import { readZip, crc32 } from '../src/storage/zip-reader.js';
import { validateRef } from '../src/core/refs.js';

const file = (name, text = name) => ({ path: name, base64: Buffer.from(text).toString('base64') });
const fails = code => error => error.code === code;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-library-test-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert.ok(relative.startsWith('fwa-library-test-') && !relative.includes(path.sep));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const library = new ReferenceLibrary(path.resolve(root)); await library.init();
  return { root, library };
}
function zip(items) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name), body = Buffer.from(item.text || '');
    const compressed = item.method === 8 ? deflateRawSync(body) : body;
    const flags = item.flags ?? 0x800, method = item.method ?? 0, checksum = crc32(body);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!(flags & 8)) { local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(body.length, 22); }
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(item.attributes ?? (item.name.endsWith('/') ? (0x41ed << 16) >>> 0 : (0x81a4 << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    let descriptor = Buffer.alloc(0);
    if (flags & 8) { descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(body.length, 12); }
    localParts.push(local, name, compressed, descriptor); centralParts.push(central, name);
    offset += local.length + name.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(centralParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

test('imports preserve a cloud-drive tree and immutable bytes without changing source or Git checkout', async t => {
  const { root, library } = await fixture(t);
  const git = args => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Library test']); git(['config', 'user.email', 'library@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n'); await writeFile(path.join(root, 'source.txt'), 'original bytes');
  git(['add', '--', '.gitignore', 'source.txt']); git(['commit', '-m', 'test fixture']);
  const head = git(['rev-parse', 'HEAD']);
  const imported = await library.importFiles({ commandId: 'import-1', label: 'Design folder', files: [file('资料/readme.md', await readFile(path.join(root, 'source.txt')))], directories: ['empty'] });
  assert.equal(imported.appended, true); assert.equal(imported.fileCount, 1);
  const tree = await library.tree({ libraryId: imported.libraryId });
  assert.deepEqual(tree.entries.map(entry => entry.path), ['empty', '资料', '资料/readme.md']);
  assert.equal(tree.tree.children[0].children.length, 0); assert.equal(tree.tree.children[1].children[0].access, 'read');
  const content = await library.readFile({ libraryId: imported.libraryId, path: '资料/readme.md' });
  assert.equal(content.bytes.toString(), 'original bytes'); assert.equal(content.contentType, 'text/plain');
  assert.equal(content.permission.access, 'read'); assert.equal(tree.hash, imported.manifestHash);
  const descriptor = await library.describeReference({ libraryId: imported.libraryId });
  assert.equal(descriptor.ordinaryWorkspaceRef, false); assert.equal(descriptor.materializationRequired, true);
  assert.equal(descriptor.uri, undefined); assert.equal(validateRef(descriptor).ok, false);
  assert.equal(git(['status', '--porcelain']), ''); assert.equal(git(['rev-parse', 'HEAD']), head);
  assert.equal(await readFile(path.join(root, 'source.txt'), 'utf8'), 'original bytes');
});

test('imports replay idempotently and new versions preserve old content and permissions after reopening', async t => {
  const { root, library } = await fixture(t);
  const input = { commandId: 'initial', libraryId: 'design', label: 'Design', files: [file('design.txt', 'v1')] };
  const first = await library.importFiles(input);
  const replay = await library.importFiles(input); assert.equal(replay.appended, false); assert.equal(replay.versionId, first.versionId);
  await assert.rejects(library.importFiles({ ...input, files: [file('design.txt', 'changed')] }), fails('library-command-conflict'));
  await library.setPermission({ commandId: 'permission', libraryId: 'design', path: 'design.txt', access: 'write' });
  const second = await library.importFiles({ ...input, commandId: 'second', files: [file('design.txt', 'v2')] });
  assert.notEqual(second.versionId, first.versionId);
  const reopened = new ReferenceLibrary(root);
  assert.equal((await reopened.readFile({ libraryId: 'design', versionId: first.versionId, path: 'design.txt' })).bytes.toString(), 'v1');
  assert.equal((await reopened.readFile({ libraryId: 'design', path: 'design.txt' })).bytes.toString(), 'v2');
  assert.equal((await reopened.resolvePermission({ libraryId: 'design', path: 'design.txt' })).access, 'write');
  assert.deepEqual((await reopened.listEvents()).map(event => event.type), ['LibraryImported', 'LibraryPermissionSet', 'LibraryImported']);
  assert.deepEqual((await reopened.list())[0].versions, [first.versionId, second.versionId]);
});

test('permission child overrides are explicit, durable, removable, and deny content reads', async t => {
  const { library } = await fixture(t);
  await library.importFiles({ commandId: 'import', libraryId: 'docs', label: 'Docs', files: [file('docs/secret.txt'), file('docs/public.txt'), file('other.txt')] });
  await library.setPermission({ commandId: 'root-write', libraryId: 'docs', path: '', access: 'write' });
  await library.setPermission({ commandId: 'docs-deny', libraryId: 'docs', path: 'docs', access: 'deny' });
  await library.setPermission({ commandId: 'public-read', libraryId: 'docs', path: 'docs/public.txt', access: 'read' });
  assert.equal((await library.resolvePermission({ libraryId: 'docs', path: 'other.txt' })).access, 'write');
  assert.equal((await library.resolvePermission({ libraryId: 'docs', path: 'docs/public.txt' })).explicit, true);
  await assert.rejects(library.readFile({ libraryId: 'docs', path: 'docs/secret.txt' }), fails('library-read-denied'));
  assert.equal((await library.readFile({ libraryId: 'docs', path: 'docs/public.txt' })).permission.access, 'read');
  await library.setPermission({ commandId: 'remove-child', libraryId: 'docs', path: 'docs/public.txt', access: null });
  await assert.rejects(library.readFile({ libraryId: 'docs', path: 'docs/public.txt' }), fails('library-read-denied'));
  await assert.rejects(library.setPermission({ commandId: 'outside', libraryId: 'docs', path: '../project', access: 'write' }), fails('library-unsafe-path'));
  await assert.rejects(library.setPermission({ commandId: 'missing', libraryId: 'docs', path: 'missing', access: 'write' }), fails('library-path-not-found'));
  assert.deepEqual(resolveLibraryPermission('fw/code.txt'), { access: 'read', inheritedFrom: null, explicit: false });
});

test('ZIP supports store, deflate, UTF-8 directories, empty folders and data descriptors', async t => {
  const { library } = await fixture(t);
  const bytes = zip([{ name: 'empty/' }, { name: '文档/a.txt', text: 'store' }, { name: 'b.txt', text: 'deflated text', method: 8, flags: 0x808 }]);
  const result = await library.importArchive({ commandId: 'zip-import', label: 'Archive', format: 'zip', base64: bytes.toString('base64') });
  const tree = await library.tree({ libraryId: result.libraryId });
  assert.deepEqual(tree.entries.map(entry => entry.path), ['b.txt', 'empty', '文档', '文档/a.txt']);
  assert.equal((await library.readFile({ libraryId: result.libraryId, path: 'b.txt' })).bytes.toString(), 'deflated text');
  assert.equal((await library.importArchive({ commandId: 'zip-import', label: 'Archive', format: 'zip', base64: bytes.toString('base64') })).appended, false);
  await assert.rejects(library.importArchive({ commandId: 'rar-import', label: 'RAR', format: 'rar', base64: '' }), fails('library-unsupported-archive'));
});

test('ZIP and folder imports reject traversal, absolute names, links, duplicate/case conflicts and expansion bombs', async t => {
  const { library } = await fixture(t);
  for (const name of ['../evil', '/absolute', 'C:/drive', 'a\\b', '.git/config', 'NUL.txt', 'folder/../evil', 'trailing./x']) {
    assert.throws(() => readZip(zip([{ name, text: 'evil' }])), fails('library-unsafe-path'), name);
    await assert.rejects(library.importFiles({ commandId: 'bad-import', label: 'Bad', files: [file(name)] }), fails('library-unsafe-path'));
  }
  for (const items of [[{ name: 'same' }, { name: 'same' }], [{ name: 'Dir/a' }, { name: 'dir/b' }], [{ name: 'file' }, { name: 'file/child' }]]) {
    assert.throws(() => readZip(zip(items)), fails('library-path-conflict'));
  }
  assert.throws(() => readZip(zip([{ name: 'link', text: '/secret', attributes: (0xa1ff << 16) >>> 0 }])), fails('library-unsupported-archive'));
  assert.throws(() => readZip(zip([{ name: 'secret', flags: 1 }])), fails('library-unsupported-archive'));
  assert.throws(() => readZip(zip([{ name: 'method', method: 99 }])), fails('library-unsupported-archive'));
  assert.throws(() => readZip(zip([{ name: 'huge', text: 'x'.repeat(10000), method: 8 }])), fails('library-import-limit'));
  assert.throws(() => readZip(zip([{ name: 'a', text: 'four' }]), { ...REFERENCE_LIBRARY_LIMITS, maxTotalBytes: 3 }), fails('library-import-limit'));
  assert.throws(() => normalizeEntries([{ path: 'a', bytes: Buffer.alloc(5) }], [], { ...REFERENCE_LIBRARY_LIMITS, maxFileBytes: 4 }), fails('library-import-limit'));
  await assert.rejects(library.importFiles({ commandId: 'base64', label: 'Bad', files: [{ path: 'a', base64: 'AB==' }] }), fails('library-invalid-bytes'));
  assert.deepEqual(await library.list(), []); assert.deepEqual(await library.listEvents(), []);
});

test('ZIP verifies CRC, local/central names, nonoverlapping data and declared inflated sizes', () => {
  const crc = zip([{ name: 'a', text: 'value' }]); crc[31] ^= 1;
  assert.throws(() => readZip(crc), fails('library-invalid-zip'));
  const name = zip([{ name: 'a', text: 'value' }]); name[30] = 98;
  assert.throws(() => readZip(name), fails('library-invalid-zip'));
  const overlap = zip([{ name: 'a', text: 'value' }, { name: 'a', text: 'value' }]);
  const central = overlap.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); overlap.writeUInt32LE(0, central + 47 + 42);
  assert.throws(() => readZip(overlap), fails('library-invalid-zip'));
  const size = zip([{ name: 'a', text: 'deflate output', method: 8 }]); const directory = size.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  size.writeUInt32LE(1, 22); size.writeUInt32LE(1, directory + 24);
  assert.throws(() => readZip(size), fails('library-invalid-zip'));
  assert.throws(() => readZip(size.subarray(0, size.length - 1)), fails('library-invalid-zip'));
});

test('corruption and linked storage fail closed without publishing a successful import', async t => {
  const { root, library } = await fixture(t);
  const first = await library.importFiles({ commandId: 'first', libraryId: 'data', label: 'Data', files: [file('a.txt', 'data')] });
  const entry = (await library.tree({ libraryId: 'data' })).entries[0];
  const stored = path.join(root, '.fwa/library/objects', entry.hash.slice(0, 2), entry.hash);
  await writeFile(stored, 'evil');
  await assert.rejects(library.readFile({ libraryId: 'data', path: 'a.txt' }), fails('library-corrupt-content'));
  await assert.rejects(library.importFiles({ commandId: 'first', libraryId: 'data', label: 'Data', files: [file('a.txt', 'data')] }), fails('library-corrupt-content'));
  await assert.rejects(library.importFiles({ commandId: 'failed', libraryId: 'data', label: 'Data', files: [file('a.txt', 'data')] }), fails('library-storage-conflict'));
  assert.equal((await library.listEvents()).length, 1); assert.equal((await library.list())[0].currentVersionId, first.versionId);
  await writeFile(stored, 'data');
  await link(stored, path.join(root, 'hardlink'));
  await assert.rejects(library.readFile({ libraryId: 'data', path: 'a.txt' }), fails('library-unsafe-storage'));
  const outside = path.join(root, 'outside'); await mkdir(outside);
  const linked = path.join(root, 'linked'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new ReferenceLibrary(linked).init(), fails('library-unsafe-storage'));
});

test('materialization requires a new authorized destination, validates hashes, and binds a permission snapshot', async t => {
  const { root, library } = await fixture(t);
  await library.importFiles({ commandId: 'import', libraryId: 'data', label: 'Data', files: [file('public/a.txt', 'copied'), file('secret.txt', 'secret')] });
  await library.setPermission({ commandId: 'deny', libraryId: 'data', path: 'secret.txt', access: 'deny' });
  await mkdir(path.join(root, '.fwa/snapshots'));
  const destinationRoot = path.join(root, '.fwa/snapshots/one');
  await assert.rejects(library.materializeSnapshot({ libraryId: 'data', destinationRoot }), fails('library-materialization-not-authorized'));
  await assert.rejects(library.materializeSnapshot({ libraryId: 'data', destinationRoot: path.join(root, 'project'), authorized: true }), fails('library-workspace-write-denied'));
  await assert.rejects(library.materializeSnapshot({ libraryId: 'data', destinationRoot: path.join(root, '.fwa/library/new'), authorized: true }), fails('library-unsafe-destination'));
  const snapshot = await library.materializeSnapshot({ libraryId: 'data', destinationRoot, authorized: true });
  assert.equal(await readFile(path.join(destinationRoot, 'public/a.txt'), 'utf8'), 'copied');
  assert.deepEqual(snapshot.omitted, ['secret.txt']); assert.equal(snapshot.files.find(entry => entry.path === 'public/a.txt').permission.access, 'read');
  await assert.rejects(readFile(path.join(destinationRoot, 'secret.txt')), error => error.code === 'ENOENT');
  await assert.rejects(library.materializeSnapshot({ libraryId: 'data', destinationRoot, authorized: true }), fails('library-destination-exists'));
  await library.setPermission({ commandId: 'write', libraryId: 'data', path: 'public', access: 'write' });
  assert.equal(snapshot.files.find(entry => entry.path === 'public/a.txt').permission.access, 'read', 'An old snapshot is not retrospectively reauthorized.');
  assert.notEqual(snapshot.permissionHash, (await library.tree({ libraryId: 'data' })).permissionHash);
});

test('concurrent writers do not overwrite each other and journal tampering is rejected', async t => {
  const { root, library } = await fixture(t);
  const results = await Promise.allSettled(['one', 'two'].map(commandId => library.importFiles({ commandId, label: commandId, files: [file('a.txt')] })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'library-busy');
  const loser = results[0].status === 'rejected' ? 'one' : 'two';
  await library.importFiles({ commandId: loser, label: loser, files: [file('a.txt')] });
  assert.equal((await library.list()).length, 2);
  const record = path.join(root, '.fwa/library/events/event-000000000001.json');
  const event = JSON.parse(await readFile(record, 'utf8')); event.payload.label = 'tampered'; await writeFile(record, JSON.stringify(event));
  await assert.rejects(library.list(), fails('library-corrupt-journal'));
});

test('maximum-depth paths and multi-megabyte base64 avoid recursive or regex resource exhaustion', () => {
  const deepest = Array.from({ length: 32 }, (_, index) => `p${index}`).join('/');
  const entries = normalizeEntries([{ path: deepest, bytes: Buffer.from('bounded') }]);
  assert.equal(entries.length, 32);
  const content = Buffer.alloc(2 * 1024 * 1024, 65), encoded = content.toString('base64');
  assert.deepEqual(boundedBase64(encoded, content.length), content);
  assert.throws(() => boundedBase64(`${encoded.slice(0, -4)}==AA`, content.length), fails('library-invalid-bytes'));
});
