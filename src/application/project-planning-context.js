import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { hashCanonicalValue } from '../storage/file-event-store.js';

export const PROJECT_PATH_LIMITS = Object.freeze({ maxDirectories: 128, maxEntries: 4096,
  maxEntriesPerDirectory: 512, maxPaths: 2048, maxDepth: 8, maxBytes: 128 * 1024, maxIssues: 32 });
const EXCLUDED_DIRECTORIES = Object.freeze(['.cache', '.fwa', '.git', '.godot', '.gradle', '.idea', '.local',
  '.mypy_cache', '.next', '.nuxt', '.pytest_cache', '.ruff_cache', '.venv', '.vs', '__pycache__',
  'bin', 'build', 'coverage', 'dist', 'fw', 'library', 'logs', 'node_modules', 'obj', 'target', 'temp', 'vendor', 'venv'].sort());
const excluded = new Set(EXCLUDED_DIRECTORIES);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const failure = (message, code, cause) => Object.assign(new Error(message, { cause }), { code });

function scanLimits(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || Object.keys(overrides).some(key => !Object.hasOwn(PROJECT_PATH_LIMITS, key))) throw new TypeError('Unknown project path snapshot limit.');
  const limits = { ...PROJECT_PATH_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'maxBytes' ? 2048 : 1) || value > PROJECT_PATH_LIMITS[key]) {
      throw new TypeError(`Project path snapshot ${key} must be a positive bounded integer.`);
    }
  }
  return limits;
}

/** Read paths only. Limits are trusted caller options, never browser-supplied scan roots. */
export async function projectPlanningContext(projectRoot, { limits: overrides = {} } = {}) {
  const limits = scanLimits(overrides), root = path.resolve(projectRoot);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || !samePath(await realpath(root), root)) {
      throw failure('Planning project root must be an ordinary directory without link ancestors.', 'planning-project-unsafe-root');
    }
  } catch (error) {
    if (error.code === 'planning-project-unsafe-root') throw error;
    throw failure('Cannot read the planning project root.', 'planning-project-unavailable', error);
  }
  const snapshot = { schemaVersion: 1, kind: 'project-file-paths', entries: [], limits,
    excludedDirectoryNames: EXCLUDED_DIRECTORIES, complete: true, truncated: false,
    skipped: { excludedDirectories: 0, links: 0, specialFiles: 0 }, issues: [], omittedIssues: 0,
    stats: { directories: 0, entriesInspected: 0 },
    contentBoundary: 'Project-relative paths observed during this bounded scan only. File bodies are never read. The hash binds this inventory, not file contents or an atomic Git revision. Excluded directories, links, limits and read errors may hide paths; an absent path is not proof of nonexistence.' };
  let stop = false, entryBytes = 0;
  const issue = (relative, code, truncated = false, errorCode) => {
    snapshot.complete = false; snapshot.truncated ||= truncated;
    if (snapshot.issues.length < limits.maxIssues) snapshot.issues.push({ path: relative || '.', code, ...(errorCode ? { errorCode } : {}) });
    else snapshot.omittedIssues++;
  };
  const queue = [{ relative: '', depth: 0 }];
  while (queue.length && !stop) {
    const directory = queue.shift(), absolute = path.join(root, directory.relative);
    if (snapshot.stats.directories >= limits.maxDirectories) { issue(directory.relative, 'directory-limit', true); break; }
    if (directory.depth >= limits.maxDepth) { issue(directory.relative, 'depth-limit', true); continue; }
    const children = [];
    let handle, before, complete = false;
    try {
      before = await lstat(absolute);
      if (before.isSymbolicLink() || !before.isDirectory() || !samePath(await realpath(absolute), absolute)) {
        snapshot.skipped.links++; issue(directory.relative, 'link-or-replaced-directory'); continue;
      }
      handle = await opendir(absolute, { bufferSize: 16 }); snapshot.stats.directories++;
      while (children.length < limits.maxEntriesPerDirectory && snapshot.stats.entriesInspected < limits.maxEntries) {
        const entry = await handle.read();
        if (!entry) { complete = true; break; }
        snapshot.stats.entriesInspected++; children.push(entry);
      }
      if (!complete) {
        // Do not retain an order-dependent prefix of a partially read directory.
        const global = snapshot.stats.entriesInspected >= limits.maxEntries;
        issue(directory.relative, global ? 'entry-limit' : 'directory-entry-limit', true); stop ||= global; continue;
      }
      const after = await lstat(absolute);
      if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino
        || !samePath(await realpath(absolute), absolute)) {
        issue(directory.relative, 'directory-changed-during-scan'); continue;
      }
    } catch (error) { issue(directory.relative, 'directory-unreadable', false, error.code || 'UNKNOWN'); continue; }
    finally { if (handle) await handle.close(); }
    children.sort((a, b) => compare(a.name, b.name));
    for (const child of children) {
      const relative = directory.relative ? `${directory.relative}/${child.name}` : child.name;
      let info;
      try { info = await lstat(path.join(root, relative)); }
      catch (error) { issue(relative, 'entry-unreadable', false, error.code || 'UNKNOWN'); continue; }
      if (info.isSymbolicLink()) { snapshot.skipped.links++; issue(relative, 'link-not-followed'); continue; }
      if (info.isDirectory() && excluded.has(child.name.toLowerCase())) { snapshot.skipped.excludedDirectories++; continue; }
      if (!info.isDirectory() && !info.isFile()) { snapshot.skipped.specialFiles++; issue(relative, 'special-file-not-read'); continue; }
      const entry = { path: relative, kind: info.isDirectory() ? 'directory' : 'file' };
      if (snapshot.entries.length >= limits.maxPaths || entryBytes + bytes(entry) + 1 > limits.maxBytes) {
        issue(relative, snapshot.entries.length >= limits.maxPaths ? 'path-limit' : 'snapshot-byte-limit', true); stop = true; break;
      }
      snapshot.entries.push(entry); entryBytes += bytes(entry) + 1;
      if (info.isDirectory()) queue.push({ relative, depth: directory.depth + 1 });
    }
  }
  snapshot.entries.sort((a, b) => compare(a.path, b.path));
  snapshot.issues.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code));
  if (bytes(snapshot) > limits.maxBytes) {
    issue('', 'snapshot-byte-limit', true);
    // The byte limit covers the complete snapshot, including omission diagnostics.
    // First preserve diagnostics, then retain the largest sorted path prefix that fits.
    const entries = snapshot.entries; snapshot.entries = [];
    while (bytes(snapshot) > limits.maxBytes && snapshot.issues.length) { snapshot.issues.pop(); snapshot.omittedIssues++; }
    let low = 0, high = entries.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2); snapshot.entries = entries.slice(0, middle);
      if (bytes(snapshot) <= limits.maxBytes) low = middle; else high = middle - 1;
    }
    snapshot.entries = entries.slice(0, low);
    snapshot.issues.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code));
  }
  return { hash: `sha256:${hashCanonicalValue(snapshot)}`, snapshot };
}
