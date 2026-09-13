import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

export const REFERENCE_LIBRARY_LIMITS = Object.freeze({
  maxFiles: 2000, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  maxArchiveBytes: 32 * 1024 * 1024, maxCompressionRatio: 200, maxPathBytes: 512, maxDepth: 32
});
export function libraryError(code, message) { return Object.assign(new Error(message), { code }); }
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function libraryPath(value, { root = false } = {}) {
  if (root && value === '') return '';
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\\') || /^[A-Za-z]:|^\//.test(value)
    || /[\x00-\x1f\x7f<>:"|?*]/u.test(value)) throw libraryError('library-unsafe-path', 'Use a portable relative path, not an absolute path or glob.');
  const normalized = value.normalize('NFC');
  const parts = normalized.split('/');
  if (Buffer.byteLength(normalized) > REFERENCE_LIBRARY_LIMITS.maxPathBytes || parts.length > REFERENCE_LIBRARY_LIMITS.maxDepth
    || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      || ['.git', '.fwa'].includes(part.toLowerCase()))) throw libraryError('library-unsafe-path', `Unsafe or reserved path: ${value}`);
  return normalized;
}
export function boundedBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw libraryError('library-invalid-bytes', 'Expected canonical base64 within the declared byte limit.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw libraryError('library-invalid-bytes', 'Base64 is invalid or oversized.');
  return bytes;
}
export function normalizeEntries(files, directories = [], limits = REFERENCE_LIBRARY_LIMITS) {
  if (!Array.isArray(files) || !Array.isArray(directories) || files.length + directories.length > limits.maxFiles) {
    throw libraryError('library-import-limit', 'Import entry count exceeds the configured limit.');
  }
  const entries = new Map();
  const explicit = new Set();
  let total = 0;
  function insert(normalized, type, bytes, isExplicit) {
    const key = normalized.toLowerCase();
    const previous = entries.get(key);
    if (previous && (previous.path !== normalized || previous.type !== type || type === 'file' || (isExplicit && explicit.has(key)))) {
      throw libraryError('library-path-conflict', `Duplicate, case-colliding or file/directory-conflicting path: ${normalized}`);
    }
    if (isExplicit) explicit.add(key);
    entries.set(key, previous || { path: normalized, type, ...(bytes === undefined ? {} : { bytes }) });
  }
  function add(relative, type, bytes, isExplicit) {
    const normalized = libraryPath(relative), segments = normalized.split('/');
    for (let count = 1; count < segments.length; count++) insert(segments.slice(0, count).join('/'), 'directory', undefined, false);
    insert(normalized, type, bytes, isExplicit);
  }
  for (const directory of directories) add(directory, 'directory', undefined, true);
  for (const file of files) {
    if (!file || typeof file !== 'object' || (!Buffer.isBuffer(file.bytes) && !(file.bytes instanceof Uint8Array))) {
      throw libraryError('library-invalid-bytes', 'File contents must be bytes.');
    }
    if (file.bytes.length > limits.maxFileBytes || (total += file.bytes.length) > limits.maxTotalBytes) {
      throw libraryError('library-import-limit', 'Uncompressed import exceeds the configured byte limit.');
    }
    add(file.path, 'file', Buffer.from(file.bytes), true);
  }
  if (!entries.size || entries.size > limits.maxFiles) throw libraryError('library-import-limit', 'Import must contain a bounded nonempty file tree.');
  return [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function safeDirectory(root, directory, create = false) {
  const relative = path.relative(root, directory);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw libraryError('library-path-escape', 'Storage path escaped its project.');
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT' || !create || current === root) throw error;
      await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw libraryError('library-unsafe-storage', 'Storage directories must not be links.');
  }
}
export async function safeRead(root, file, maxBytes) {
  await safeDirectory(root, path.dirname(file));
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw libraryError('library-unsafe-storage', 'Stored file must be a bounded regular, unlinked file.');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.size > maxBytes || after.dev !== before.dev || after.ino !== before.ino) {
      throw libraryError('library-unsafe-storage', 'Stored file identity changed while opening.');
    }
    const bytes = Buffer.alloc(after.size + 1);
    let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== after.size) throw libraryError('library-storage-changed', 'Stored file size changed while reading.');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export async function publish(root, file, bytes) {
  await safeDirectory(root, path.dirname(file), true);
  const temporary = path.join(path.dirname(file), `.library-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, file);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await safeRead(root, file, bytes.length);
    if (!existing.equals(bytes)) throw libraryError('library-storage-conflict', 'Immutable storage contains conflicting bytes.');
  } finally { await unlink(temporary); }
}
