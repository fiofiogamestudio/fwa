import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { boundedBase64, canonical, digest, libraryError, libraryPath, normalizeEntries, publish,
  REFERENCE_LIBRARY_LIMITS, safeDirectory, safeRead } from '../storage/library-files.js';
import { readZip } from '../storage/zip-reader.js';
import { INTERACTION_FIELDS, LIBRARY_ACCESS_VALUES } from '../core/interaction-contract.js';

export { REFERENCE_LIBRARY_LIMITS } from '../storage/library-files.js';
const EMPTY_HASH = '0'.repeat(64);
const identifier = (value, label) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(value)) throw libraryError('library-invalid-id', `${label} must be a portable lowercase identifier.`);
  return value;
};
function accessFor(relative, rules) {
  let access = 'read', inheritedFrom = null;
  for (const rule of [...rules].sort((a, b) => a.path.length - b.path.length)) {
    if (!rule.path || relative === rule.path || relative.startsWith(`${rule.path}/`)) { access = rule.access; inheritedFrom = rule.path; }
  }
  return { access, inheritedFrom, explicit: inheritedFrom === relative };
}
/** Library permissions never authorize writes to project/, fw/, or original import locations. */
export function resolveLibraryPermission(relative, rules = []) {
  const normalized = libraryPath(relative, { root: true });
  if (!Array.isArray(rules)) throw libraryError('library-invalid-permission', 'Permission rules must be an array.');
  const validated = rules.map(rule => {
    if (!rule || !LIBRARY_ACCESS_VALUES.includes(rule.access)) throw libraryError('library-invalid-permission', 'Access must be read, write, or deny.');
    return { path: libraryPath(rule.path, { root: true }), access: rule.access };
  });
  return accessFor(normalized, validated);
}
function contentType(file) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.md': 'text/plain', '.txt': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Versioned copies in ignored .fwa/library, not workspace files or ordinary Refs.
 * The library journal is independent from the core event stream. A published
 * import event is the visibility/commit point; unpublished objects are harmless.
 */
export class ReferenceLibrary {
  constructor(projectRoot) {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw libraryError('library-invalid-root', 'An explicit absolute project root is required.');
    this.projectRoot = path.resolve(projectRoot);
    this.root = path.join(this.projectRoot, '.fwa', 'library');
    this.eventsRoot = path.join(this.root, 'events');
    this.lockPath = path.join(this.root, '.mutation.lock');
  }
  async init() {
    await safeDirectory(this.projectRoot, this.root, true);
    for (const directory of ['objects', 'versions', 'events']) await safeDirectory(this.projectRoot, path.join(this.root, directory), true);
    return { schemaVersion: 1, storage: '.fwa/library', libraries: (await this.#state()).libraries.length };
  }
  async #state() {
    await safeDirectory(this.projectRoot, this.eventsRoot);
    const names = (await readdir(this.eventsRoot)).filter(name => /^event-\d{12}\.json$/.test(name)).sort();
    const events = [], libraries = new Map(), commands = new Map();
    let previousHash = EMPTY_HASH;
    for (const name of names) {
      const event = JSON.parse((await safeRead(this.projectRoot, path.join(this.eventsRoot, name), 4 * 1024 * 1024)).toString('utf8'));
      const { hash, ...body } = event;
      if (body.schemaVersion !== 1 || body.sequence !== events.length + 1 || name !== `event-${String(body.sequence).padStart(12, '0')}.json`
        || body.previousHash !== previousHash || digest(canonical(body)) !== hash || commands.has(body.commandId)) throw libraryError('library-corrupt-journal', 'Library event hash/sequence/command chain is invalid.');
      previousHash = hash; events.push(event); commands.set(body.commandId, event);
      const payload = body.payload;
      if (body.type === 'LibraryImported') {
        identifier(payload.libraryId, 'libraryId');
        const library = libraries.get(payload.libraryId) || { id: payload.libraryId, label: payload.label, versions: [], permissions: [] };
        library.label = payload.label; library.currentVersionId = payload.versionId;
        if (!library.versions.includes(payload.versionId)) library.versions.push(payload.versionId);
        libraries.set(library.id, library);
      } else if (body.type === 'LibraryPermissionSet') {
        const library = libraries.get(payload.libraryId);
        if (!library) throw libraryError('library-corrupt-journal', 'Permission event refers to an unknown library.');
        library.permissions = library.permissions.filter(rule => rule.path !== payload.path);
        if (payload.access !== null) {
          resolveLibraryPermission(payload.path, [{ path: payload.path, access: payload.access }]);
          library.permissions.push({ path: payload.path, access: payload.access });
        }
      } else throw libraryError('library-corrupt-journal', 'Unknown library event type.');
    }
    return { events, commands, libraries: [...libraries.values()], lastSequence: events.length, previousHash };
  }
  async #mutate(commandId, intent, execute) {
    identifier(commandId, 'commandId');
    await safeDirectory(this.projectRoot, this.root);
    const token = canonical({ pid: process.pid, token: randomUUID(), commandId });
    let lock;
    try { lock = await open(this.lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw libraryError('library-busy', 'Library mutation lock exists; retry the same command, or inspect a stopped owner manually.'); throw error; }
    try {
      await lock.writeFile(token); await lock.sync(); await lock.close(); lock = null;
      const state = await this.#state(), intentHash = digest(canonical(intent));
      const existing = state.commands.get(commandId);
      if (existing) {
        if (existing.intentHash !== intentHash) throw libraryError('library-command-conflict', 'commandId is already bound to a different import or permission request.');
        return { appended: false, event: existing };
      }
      const { type, payload } = await execute(state);
      const body = { schemaVersion: 1, sequence: state.lastSequence + 1, previousHash: state.previousHash,
        commandId, intentHash, type, timestamp: new Date().toISOString(), payload };
      const event = { ...body, hash: digest(canonical(body)) };
      await publish(this.projectRoot, path.join(this.eventsRoot, `event-${String(event.sequence).padStart(12, '0')}.json`), Buffer.from(canonical(event)));
      return { appended: true, event };
    } finally {
      await lock?.close();
      const actual = await safeRead(this.projectRoot, this.lockPath, 4096);
      if (actual.toString('utf8') !== token) throw libraryError('library-lock-changed', 'Library mutation lock identity changed.');
      await unlink(this.lockPath);
    }
  }
  async #import({ commandId, libraryId, label, entries, source }) {
    identifier(commandId, 'commandId');
    const id = identifier(libraryId ?? `lib-${digest(commandId).slice(0, 24)}`, 'libraryId');
    if (typeof label !== 'string' || !label.trim() || label.length > INTERACTION_FIELDS.libraryLabel.maxLength) throw libraryError('library-invalid-label', `Import label must contain 1–${INTERACTION_FIELDS.libraryLabel.maxLength} characters.`);
    const manifest = { schemaVersion: 1, entries: entries.map(entry => ({ path: entry.path, type: entry.type,
      ...(entry.type === 'file' ? { hash: digest(entry.bytes), size: entry.bytes.length } : {}) })) };
    const versionId = digest(canonical(manifest));
    const payload = { libraryId: id, label: label.trim(), versionId, hash: `sha256:${versionId}`, source,
      fileCount: entries.filter(entry => entry.type === 'file').length, totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes?.length || 0), 0) };
    const result = await this.#mutate(commandId, payload, async () => {
      for (const entry of entries) if (entry.type === 'file') await publish(this.projectRoot, this.#objectPath(digest(entry.bytes)), entry.bytes);
      await publish(this.projectRoot, path.join(this.root, 'versions', `${versionId}.json`), Buffer.from(canonical(manifest)));
      return { type: 'LibraryImported', payload };
    });
    // Replaying a durable command is not permission to claim damaged bytes still exist.
    if (!result.appended) {
      const verified = await this.#version(id, versionId);
      for (const entry of verified.entries) if (entry.type === 'file') await this.#readEntry(entry);
    }
    return { ...result, libraryId: id, versionId, hash: payload.hash, manifestHash: payload.hash, fileCount: payload.fileCount, totalBytes: payload.totalBytes };
  }
  async importFiles({ commandId, libraryId, label, files, directories = [] } = {}) {
    if (!Array.isArray(files) || !Array.isArray(directories) || files.length + directories.length > REFERENCE_LIBRARY_LIMITS.maxFiles) throw libraryError('library-import-limit', 'Bounded files and directories arrays are required.');
    const totalEncoded = files.reduce((sum, file) => sum + (typeof file?.base64 === 'string' ? file.base64.length : 0), 0);
    if (totalEncoded > Math.ceil(REFERENCE_LIBRARY_LIMITS.maxTotalBytes / 3) * 4 + files.length * 4) throw libraryError('library-import-limit', 'Total base64 payload is oversized.');
    const entries = normalizeEntries(files.map(file => ({ path: file?.path, bytes: boundedBase64(file?.base64, REFERENCE_LIBRARY_LIMITS.maxFileBytes) })), directories);
    return this.#import({ commandId, libraryId, label, entries, source: 'files' });
  }
  async importArchive({ commandId, libraryId, label, format, base64 } = {}) {
    if (format !== 'zip') throw libraryError('library-unsupported-archive', 'Only ZIP (store/deflate) import is supported; other formats are not extracted.');
    const entries = readZip(boundedBase64(base64, REFERENCE_LIBRARY_LIMITS.maxArchiveBytes));
    return this.#import({ commandId, libraryId, label, entries, source: 'zip' });
  }
  async list() { return (await this.#state()).libraries; }
  async listEvents() { return (await this.#state()).events; }
  #objectPath(hash) { return path.join(this.root, 'objects', hash.slice(0, 2), hash); }
  async #version(libraryId, versionId, state = null) {
    identifier(libraryId, 'libraryId');
    state ||= await this.#state();
    const library = state.libraries.find(item => item.id === libraryId);
    if (!library) throw libraryError('library-not-found', 'Reference library was not found.');
    const selected = versionId ?? library.currentVersionId;
    if (typeof selected !== 'string' || !/^[a-f0-9]{64}$/.test(selected) || !library.versions.includes(selected)) throw libraryError('library-version-not-found', 'Version does not belong to this library.');
    const raw = await safeRead(this.projectRoot, path.join(this.root, 'versions', `${selected}.json`), 4 * 1024 * 1024);
    const manifest = JSON.parse(raw.toString('utf8'));
    if (digest(canonical(manifest)) !== selected || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) throw libraryError('library-corrupt-manifest', 'Version manifest does not match its hash.');
    for (const entry of manifest.entries) {
      libraryPath(entry.path);
      if (!['file', 'directory'].includes(entry.type) || (entry.type === 'file' && (!/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > REFERENCE_LIBRARY_LIMITS.maxFileBytes))) throw libraryError('library-corrupt-manifest', 'Invalid immutable manifest entry.');
    }
    return { library, versionId: selected, hash: `sha256:${selected}`, manifestHash: `sha256:${selected}`, entries: manifest.entries,
      permissionSequence: state.lastSequence, permissionHash: `sha256:${digest(canonical(library.permissions))}` };
  }
  async tree(options = {}) {
    const version = await this.#version(options.libraryId, options.versionId);
    const tree = { name: version.library.label, path: '', type: 'directory', ...accessFor('', version.library.permissions), children: [] };
    const parents = new Map([['', tree]]);
    for (const entry of version.entries) {
      const child = { ...entry, name: entry.path.split('/').at(-1), ...accessFor(entry.path, version.library.permissions), ...(entry.type === 'directory' ? { children: [] } : {}) };
      const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
      if (!parents.has(parent)) throw libraryError('library-corrupt-manifest', 'Manifest parent directory is missing.');
      parents.get(parent).children.push(child); if (child.children) parents.set(entry.path, child);
    }
    return { ...version, tree };
  }
  async resolvePermission({ libraryId, path: relative = '' } = {}) {
    const version = await this.#version(libraryId);
    return { ...resolveLibraryPermission(relative, version.library.permissions), sequence: version.permissionSequence };
  }
  async setPermission({ commandId, libraryId, path: relative = '', access } = {}) {
    identifier(libraryId, 'libraryId'); relative = libraryPath(relative, { root: true });
    if (!INTERACTION_FIELDS.permission.options.includes(access)) throw libraryError('library-invalid-permission', 'Permission must be read, write, deny, or null to remove an override.');
    return this.#mutate(commandId, { libraryId, path: relative, access }, async state => {
      const version = await this.#version(libraryId, undefined, state);
      if (relative && !version.entries.some(entry => entry.path === relative)) throw libraryError('library-path-not-found', 'Permission path does not exist in the current reference tree.');
      return { type: 'LibraryPermissionSet', payload: { libraryId, path: relative, access } };
    });
  }
  async #readEntry(entry) {
    const bytes = await safeRead(this.projectRoot, this.#objectPath(entry.hash), entry.size);
    if (bytes.length !== entry.size || digest(bytes) !== entry.hash) throw libraryError('library-corrupt-content', 'Imported content does not match its immutable hash.');
    return bytes;
  }
  async readFile({ libraryId, versionId, path: relative, maxBytes = REFERENCE_LIBRARY_LIMITS.maxFileBytes } = {}) {
    relative = libraryPath(relative);
    const version = await this.#version(libraryId, versionId), permission = accessFor(relative, version.library.permissions);
    if (permission.access === 'deny') throw libraryError('library-read-denied', 'This reference path is explicitly denied.');
    const entry = version.entries.find(item => item.path === relative && item.type === 'file');
    if (!entry) throw libraryError('library-file-not-found', 'Reference file was not found.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || entry.size > maxBytes) throw libraryError('library-preview-limit', 'File is too large for this preview limit.');
    return { libraryId, versionId: version.versionId, path: relative, hash: `sha256:${entry.hash}`, size: entry.size,
      contentType: contentType(relative), bytes: await this.#readEntry(entry), permission };
  }
  async describeReference({ libraryId, versionId } = {}) {
    const version = await this.#version(libraryId, versionId);
    return { id: `ref://library/${libraryId}`, kind: 'library', provider: 'fwa-library', libraryId,
      versionId: version.versionId, version: `library:${version.versionId}`, hash: version.hash, manifestHash: version.hash,
      materializationRequired: true, ordinaryWorkspaceRef: false };
  }
  async materializeSnapshot({ libraryId, versionId, destinationRoot, authorized = false } = {}) {
    if (authorized !== true || typeof destinationRoot !== 'string' || !path.isAbsolute(destinationRoot)) throw libraryError('library-materialization-not-authorized', 'A trusted caller must explicitly authorize an absolute, new destination.');
    const destination = path.resolve(destinationRoot), relative = path.relative(this.projectRoot, destination);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && !relative.startsWith(`.fwa${path.sep}`))) {
      throw libraryError('library-workspace-write-denied', 'Materialization inside a project is restricted to ignored .fwa state, not project/ or fw/.');
    }
    const withinLibrary = path.relative(this.root, destination);
    if (withinLibrary === '' || (!path.isAbsolute(withinLibrary) && withinLibrary !== '..' && !withinLibrary.startsWith(`..${path.sep}`))) throw libraryError('library-unsafe-destination', 'Snapshot cannot overwrite library storage.');
    await safeDirectory(path.parse(destination).root, path.dirname(destination));
    try { await lstat(destination); throw libraryError('library-destination-exists', 'Snapshot destination must not exist.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const version = await this.#version(libraryId, versionId), files = [], omitted = [];
    for (const entry of version.entries) {
      const permission = accessFor(entry.path, version.library.permissions);
      if (permission.access === 'deny') { omitted.push(entry.path); continue; }
      files.push({ ...entry, permission, ...(entry.type === 'file' ? { bytes: await this.#readEntry(entry) } : {}) });
    }
    // Verification precedes writes. mkdir reserves this new destination without
    // replacing an existing path; failures remain explicit incomplete snapshots.
    await mkdir(destination, { mode: 0o700 });
    try {
      for (const file of files) {
        const target = path.join(destination, ...file.path.split('/'));
        if (file.type === 'directory') await safeDirectory(destination, target, true);
        else {
          await safeDirectory(destination, path.dirname(target), true);
          const handle = await open(target, 'wx', 0o600);
          try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
        }
      }
    } catch (error) { error.partialDestination = destination; throw error; }
    return { destinationRoot: destination, libraryId, versionId: version.versionId, hash: version.hash, manifestHash: version.hash,
      permissionSequence: version.permissionSequence, permissionHash: version.permissionHash, files: files.map(({ bytes, ...entry }) => entry), omitted,
      permissionEnforcement: 'caller-must-enforce; copied-file-mode-is-not-an-executor-sandbox' };
  }
}
