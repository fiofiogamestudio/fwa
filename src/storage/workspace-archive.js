import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { stableStringify } from '../core/events.js';

const ARCHIVE_SCHEMA_VERSION = 1;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const IMMUTABLE_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'runId', 'workspacePath', 'source', 'history'
]);

export class WorkspaceArchiveError extends Error {
  constructor(message, code = 'workspace-archive-error', options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'WorkspaceArchiveError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * Durable, append-only snapshots of terminal Run workspaces. The archive is
 * deliberately a storage boundary: it has no delete or overwrite operation.
 * Git remains responsible for removing the registered source worktree.
 */
export class WorkspaceArchiveStore {
  constructor(projectRoot, { clock = () => new Date() } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new WorkspaceArchiveError('projectRoot must be a non-empty string.', 'invalid-project-root');
    }
    if (typeof clock !== 'function') throw new WorkspaceArchiveError('clock must be a function.', 'invalid-clock');
    this.projectRoot = path.resolve(projectRoot);
    this.clock = clock;
    this.stateDirectory = path.join(this.projectRoot, '.fwa');
    this.archiveDirectory = path.join(this.stateDirectory, 'workspace-archives');
    this.runsDirectory = path.join(this.archiveDirectory, 'runs');
  }

  async init() {
    await ensureDirectory(this.stateDirectory, 'FWA state directory');
    const created = !(await exists(this.runsDirectory));
    await ensureDirectory(this.archiveDirectory, 'workspace archive directory');
    await ensureDirectory(this.runsDirectory, 'Run workspace archive directory');
    const entries = await readdir(this.runsDirectory, { withFileTypes: true });
    // A staging directory is deliberately retained after an interrupted copy.
    // It is reported to verification, while create() may resume it only after
    // proving the exact same Run/source/history intent.
    const pendingTemps = entries
      .filter((entry) => entry.name.startsWith('.archive-'))
      .map((entry) => path.join(this.runsDirectory, entry.name));
    return { created, pendingTemps };
  }

  async create({ runId, workspacePath, sourceIdentity, history } = {}) {
    const normalizedRunId = validateRunId(runId);
    if (!isRecord(sourceIdentity)) {
      throw new WorkspaceArchiveError('sourceIdentity must be an object.', 'invalid-source-identity');
    }
    const normalizedHistory = cloneJson(history ?? {}, 'history');
    const existingPath = this.#archivePath(normalizedRunId);
    if (await exists(existingPath)) {
      await assertRealDirectory(existingPath, 'workspace archive directory');
      const existing = await this.#readAndVerify(existingPath, normalizedRunId);
      if (stableStringify(existing.manifest.history) !== stableStringify(normalizedHistory)
        || stableStringify(existing.manifest.source.identity) !== stableStringify(sourceIdentity)) {
        throw new WorkspaceArchiveError(
          `Workspace archive for Run ${normalizedRunId} does not match the current source.`,
          'workspace-archive-collision',
          { details: { archivePath: existingPath } }
        );
      }
      if (await exists(path.resolve(workspacePath))) {
        const source = await this.#assertSourcePath(normalizedRunId, workspacePath);
        const sourceSnapshot = await snapshotTree(source.path);
        if (sourceSnapshot.treeDigest !== existing.manifest.source.treeDigest
          || stableStringify(sourceSnapshot.entries) !== stableStringify(existing.manifest.source.entries)) {
          throw new WorkspaceArchiveError('Workspace source differs from the retained archive.', 'workspace-archive-source-mismatch');
        }
        await assertSnapshotUnchanged(source.path, sourceSnapshot);
      }
      return { ...existing, reused: true };
    }

    const source = await this.#assertSourcePath(normalizedRunId, workspacePath);
    const sourceSnapshot = await snapshotTree(source.path);

    const tempPath = path.join(this.runsDirectory, `.archive-${normalizedRunId}.tmp`);
    const intent = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      kind: 'fwa-run-workspace-archive-intent',
      runId: normalizedRunId,
      workspacePath: source.path,
      sourceIdentityDigest: digest(Buffer.from(stableStringify(sourceIdentity), 'utf8')),
      historyDigest: digest(Buffer.from(stableStringify(normalizedHistory), 'utf8'))
    };
    try {
      if (await exists(tempPath)) {
        await assertRealDirectory(tempPath, 'workspace archive staging directory');
        const savedIntent = await readCanonical(path.join(tempPath, 'intent.json'));
        if (stableStringify(savedIntent) !== stableStringify(intent)) {
          throw new WorkspaceArchiveError(
            `Workspace archive staging for Run ${normalizedRunId} has a different intent.`,
            'workspace-archive-temp-conflict',
            { details: { tempPath } }
          );
        }
      } else {
        await mkdir(tempPath, { recursive: true, mode: 0o700 });
        await writeCanonical(path.join(tempPath, 'intent.json'), intent);
      }
      await mkdir(tempPath, { recursive: true, mode: 0o700 });
      const payloadPath = path.join(tempPath, 'payload');
      let copied;
      if (await exists(payloadPath)) {
        await assertRealDirectory(payloadPath, 'workspace archive staging payload');
        copied = await snapshotTree(payloadPath);
      }
      if (!copied || copied.treeDigest !== sourceSnapshot.treeDigest
        || stableStringify(copied.entries) !== stableStringify(sourceSnapshot.entries)) {
        // This path is owned by the verified intent above. Rebuilding only its
        // payload is safe; unknown staging directories are never removed.
        await rm(payloadPath, { recursive: true, force: true });
        await mkdir(payloadPath, { recursive: true, mode: 0o700 });
        await copyTree(source.path, payloadPath);
        copied = await snapshotTree(payloadPath);
      }
      await assertSnapshotUnchanged(source.path, sourceSnapshot);
      if (copied.treeDigest !== sourceSnapshot.treeDigest
        || stableStringify(copied.entries) !== stableStringify(sourceSnapshot.entries)) {
        throw new WorkspaceArchiveError('Archive bytes differ from the source snapshot.', 'workspace-archive-bytes-mismatch');
      }
      const createdAt = normalizeTimestamp(this.clock());
      const manifest = {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        kind: 'fwa-run-workspace-archive',
        runId: normalizedRunId,
        workspacePath: source.path,
        readOnly: true,
        createdAt,
        source: {
          identity: cloneJson(sourceIdentity, 'sourceIdentity'),
          entries: sourceSnapshot.entries,
          treeDigest: sourceSnapshot.treeDigest
        },
        history: normalizedHistory
      };
      await writeCanonical(path.join(tempPath, 'manifest.json'), manifest);
      await rename(tempPath, existingPath);
      await makeReadOnly(existingPath);
      const verified = await this.#readAndVerify(existingPath, normalizedRunId);
      return { ...verified, reused: false };
    } catch (error) {
      if (error instanceof WorkspaceArchiveError) throw error;
      throw new WorkspaceArchiveError(
        `Failed to create workspace archive for Run ${normalizedRunId}.`,
        'workspace-archive-write-failed',
        { cause: error, details: { runId: normalizedRunId, tempPath } }
      );
    }
  }

  async verifyRun({ runId, expectedHistory, expectedSourceIdentity } = {}) {
    const normalizedRunId = validateRunId(runId);
    const archive = await this.#readAndVerify(this.#archivePath(normalizedRunId), normalizedRunId);
    if (expectedHistory !== undefined
      && stableStringify(archive.manifest.history) !== stableStringify(expectedHistory)) {
      throw new WorkspaceArchiveError('Workspace archive history does not match the Run.', 'workspace-archive-history-mismatch');
    }
    if (expectedSourceIdentity !== undefined
      && stableStringify(archive.manifest.source.identity) !== stableStringify(expectedSourceIdentity)) {
      throw new WorkspaceArchiveError('Workspace archive source identity does not match the Run.', 'workspace-archive-source-mismatch');
    }
    return archive;
  }

  async inspectAll() {
    if (!(await exists(this.archiveDirectory))) return [];
    await assertRealDirectory(this.archiveDirectory, 'workspace archive root');
    const rootEntries = await readdir(this.archiveDirectory, { withFileTypes: true });
    const rootNames = rootEntries.map((entry) => entry.name).sort();
    if (stableStringify(rootNames) !== stableStringify(['runs'])) {
      throw new WorkspaceArchiveError(
        'Workspace archive root contains unexpected entries.',
        'workspace-archive-root-invalid',
        { details: { archiveDirectory: this.archiveDirectory, entries: rootNames } }
      );
    }
    if (!(await exists(this.runsDirectory))) return [];
    const entries = await readdir(this.runsDirectory, { withFileTypes: true });
    const archives = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.archive-')) {
        throw new WorkspaceArchiveError(
          'An incomplete workspace archive transaction requires inspection.',
          'orphan-workspace-archive-temp',
          { details: { path: path.join(this.runsDirectory, entry.name) } }
        );
      }
      if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) {
        throw new WorkspaceArchiveError(
          `Unexpected workspace archive entry: ${entry.name}.`,
          'workspace-archive-entry-invalid'
        );
      }
      try {
        archives.push(await this.#readAndVerify(path.join(this.runsDirectory, entry.name), entry.name));
      } catch (error) {
        if (error instanceof WorkspaceArchiveError) throw error;
        throw new WorkspaceArchiveError(`Cannot verify workspace archive ${entry.name}.`, 'workspace-archive-invalid', { cause: error });
      }
    }
    return archives.sort((left, right) => left.manifest.runId.localeCompare(right.manifest.runId));
  }

  #archivePath(runId) {
    return path.join(this.runsDirectory, runId);
  }

  async #assertSourcePath(runId, workspacePath) {
    if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
      throw new WorkspaceArchiveError('workspacePath must be a non-empty string.', 'invalid-workspace-path');
    }
    const expected = path.join(this.projectRoot, '.fwa', 'worktrees', runId);
    const requested = path.resolve(workspacePath);
    if (requested !== path.resolve(expected)) {
      throw new WorkspaceArchiveError('workspacePath must be the exact Run worktree path.', 'workspace-path-outside-run');
    }
    let stats;
    try { stats = await lstat(requested); } catch (error) {
      throw new WorkspaceArchiveError(`Run workspace does not exist: ${requested}`, 'workspace-path-missing', { cause: error });
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new WorkspaceArchiveError('Run workspace must be a real directory.', 'unsafe-workspace-path');
    }
    return { path: path.resolve(requested), device: stats.dev, inode: stats.ino };
  }

  async #readAndVerify(archivePath, expectedRunId) {
    try {
      await lstat(archivePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new WorkspaceArchiveError(
          `Workspace archive does not exist: ${archivePath}`,
          'workspace-archive-manifest-missing',
          { cause: error }
        );
      }
      throw error;
    }
    await assertRealDirectory(archivePath, 'workspace archive directory');
    const layout = await readdir(archivePath, { withFileTypes: true });
    const names = layout.map((entry) => entry.name).sort();
    if (stableStringify(names) !== stableStringify(['intent.json', 'manifest.json', 'payload'])) {
      throw new WorkspaceArchiveError(
        'Workspace archive contains unexpected entries.',
        'workspace-archive-layout-invalid',
        { details: { archivePath, entries: names } }
      );
    }
    for (const entry of layout) {
      if (entry.isSymbolicLink()) {
        throw new WorkspaceArchiveError('Workspace archive entries cannot be links.', 'unsafe-workspace-entry', { details: { archivePath, entry: entry.name } });
      }
    }
    const manifestPath = path.join(archivePath, 'manifest.json');
    const payloadPath = path.join(archivePath, 'payload');
    const intent = await readCanonical(path.join(archivePath, 'intent.json'));
    const manifest = await readCanonical(manifestPath);
    validateManifest(manifest, expectedRunId);
    validateDurableIntent(intent, manifest, archivePath);
    await assertRealDirectory(payloadPath, 'workspace archive payload');
    const payload = await snapshotTree(payloadPath);
    if (payload.treeDigest !== manifest.source.treeDigest
      || stableStringify(payload.entries) !== stableStringify(manifest.source.entries)) {
      throw new WorkspaceArchiveError('Workspace archive content failed its manifest hash check.', 'workspace-archive-integrity-mismatch', { details: { archivePath } });
    }
    return {
      archivePath,
      manifest,
      manifestDigest: digest(Buffer.from(`${stableStringify(manifest)}\n`, 'utf8')),
      treeDigest: payload.treeDigest,
      entries: payload.entries
    };
  }
}

async function snapshotTree(root) {
  const entries = [];
  await assertRealDirectory(root, 'workspace archive snapshot root');
  async function visit(directory, prefix) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relative = prefix === '' ? child.name : `${prefix}/${child.name}`;
      const target = path.join(directory, child.name);
      const stats = await lstat(target);
      if (stats.isSymbolicLink() || child.isSymbolicLink()) {
        throw new WorkspaceArchiveError(`Links are not allowed in workspace archives: ${relative}`, 'unsafe-workspace-entry');
      }
      if (stats.isDirectory()) {
        entries.push({ path: relative, type: 'directory', mode: stats.mode & 0o777 });
        await visit(target, relative);
      } else if (stats.isFile()) {
        const bytes = await readFile(target);
        entries.push({
          path: relative,
          type: 'file',
          mode: stats.mode & 0o777,
          size: bytes.byteLength,
          sha256: digest(bytes)
        });
      } else {
        throw new WorkspaceArchiveError(`Unsupported workspace entry: ${relative}`, 'unsafe-workspace-entry');
      }
    }
  }
  await visit(root, '');
  return { entries, treeDigest: digest(Buffer.from(stableStringify(entries), 'utf8')) };
}

async function assertSnapshotUnchanged(root, expected) {
  const actual = await snapshotTree(root);
  if (actual.treeDigest !== expected.treeDigest || stableStringify(actual.entries) !== stableStringify(expected.entries)) {
    throw new WorkspaceArchiveError('Run workspace changed during archive capture.', 'workspace-changed-during-archive');
  }
}

async function copyTree(source, destination) {
  const children = await readdir(source, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const from = path.join(source, child.name);
    const to = path.join(destination, child.name);
    const stats = await lstat(from);
    if (stats.isSymbolicLink() || child.isSymbolicLink()) throw new WorkspaceArchiveError(`Links are not allowed in workspace archives: ${child.name}`, 'unsafe-workspace-entry');
    if (stats.isDirectory()) {
      await mkdir(to, { recursive: true, mode: stats.mode & 0o777 });
      await copyTree(from, to);
    } else if (stats.isFile()) {
      const bytes = await readFile(from);
      await writeFile(to, bytes, { mode: stats.mode & 0o777 });
    } else throw new WorkspaceArchiveError(`Unsupported workspace entry: ${child.name}`, 'unsafe-workspace-entry');
  }
}

async function makeReadOnly(root) {
  // The API is immutable by construction. chmod is only a local convenience
  // for the container and metadata; payload bytes remain protected by hashes,
  // and verification is authoritative on Windows and permissive hosts.
  await chmod(root, 0o555).catch(() => {});
  await chmod(path.join(root, 'manifest.json'), 0o444).catch(() => {});
  await chmod(path.join(root, 'intent.json'), 0o444).catch(() => {});
}

async function assertRealDirectory(target, label) {
  let stats;
  try { stats = await lstat(target); } catch (error) {
    throw new WorkspaceArchiveError(`${label} does not exist: ${target}`, 'workspace-archive-temp-missing', { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new WorkspaceArchiveError(`${label} must be a real directory: ${target}`, 'unsafe-workspace-archive-path');
  }
}

async function writeCanonical(filePath, value) {
  await writeFile(filePath, `${stableStringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function readCanonical(filePath) {
  let source;
  try { source = await readFile(filePath, 'utf8'); } catch (error) {
    throw new WorkspaceArchiveError(`Workspace archive manifest is unreadable: ${filePath}`, 'workspace-archive-manifest-missing', { cause: error });
  }
  if (!source.endsWith('\n')) throw new WorkspaceArchiveError('Workspace archive manifest must end with one newline.', 'workspace-archive-manifest-invalid');
  let value;
  try { value = JSON.parse(source); } catch (error) { throw new WorkspaceArchiveError('Workspace archive manifest is not JSON.', 'workspace-archive-manifest-invalid', { cause: error }); }
  if (stableStringify(value) !== source.slice(0, -1)) throw new WorkspaceArchiveError('Workspace archive manifest is not canonical JSON.', 'workspace-archive-manifest-invalid');
  return value;
}

function validateManifest(value, expectedRunId) {
  if (!isRecord(value) || value.schemaVersion !== ARCHIVE_SCHEMA_VERSION || value.kind !== 'fwa-run-workspace-archive' || value.runId !== expectedRunId || value.readOnly !== true || !isRecord(value.source) || !Array.isArray(value.source.entries) || !HASH_PATTERN.test(value.source.treeDigest) || !isRecord(value.source.identity) || !isRecord(value.history)) {
    throw new WorkspaceArchiveError('Workspace archive manifest has an invalid shape.', 'workspace-archive-manifest-invalid');
  }
}

function validateDurableIntent(intent, manifest, archivePath) {
  if (!isRecord(intent)
    || intent.schemaVersion !== ARCHIVE_SCHEMA_VERSION
    || intent.kind !== 'fwa-run-workspace-archive-intent'
    || intent.runId !== manifest.runId
    || intent.workspacePath !== manifest.workspacePath
    || !HASH_PATTERN.test(intent.sourceIdentityDigest)
    || !HASH_PATTERN.test(intent.historyDigest)
    || intent.sourceIdentityDigest !== digest(Buffer.from(stableStringify(manifest.source.identity), 'utf8'))
    || intent.historyDigest !== digest(Buffer.from(stableStringify(manifest.history), 'utf8'))) {
    throw new WorkspaceArchiveError(
      'Workspace archive intent does not match its manifest.',
      'workspace-archive-intent-mismatch',
      { details: { archivePath } }
    );
  }
}

function validateRunId(value) {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) throw new WorkspaceArchiveError('runId is invalid.', 'invalid-run-id');
  return value;
}

function cloneJson(value, label) {
  try { return JSON.parse(stableStringify(value)); } catch (error) { throw new WorkspaceArchiveError(`${label} must be JSON compatible.`, 'invalid-workspace-archive-input', { cause: error }); }
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function normalizeTimestamp(value) { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new WorkspaceArchiveError('clock returned an invalid date.', 'invalid-clock'); return date.toISOString(); }
async function exists(target) { try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function ensureDirectory(target, label) {
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new WorkspaceArchiveError(`${label} must be a real directory.`, 'unsafe-workspace-archive-path');
    }
    return;
  } catch (error) {
    if (error instanceof WorkspaceArchiveError || error.code !== 'ENOENT') throw error;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new WorkspaceArchiveError(`${label} must be a real directory.`, 'unsafe-workspace-archive-path');
}
