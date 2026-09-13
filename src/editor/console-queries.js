import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { projectEvents } from '../application/projection.js';
import { normalizeWorkspacePath } from '../core/effects.js';
import { isRefId } from '../core/refs.js';

export const CONSOLE_READ_LIMITS = Object.freeze({
  textBytes: 2 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  artifactCount: 256,
  artifactGraphBytes: 32 * 1024 * 1024
});

const IMAGES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.svg', 'image/svg+xml']]);
const TEXT = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml',
  '.csv', '.tsv', '.xml', '.log', '.diff', '.patch', '.js', '.mjs', '.cjs', '.ts', '.cs',
  '.gd', '.gdshader', '.tscn', '.tres', '.proto', '.css', '.html', '.htm', '.sh', '.ps1']);
const DIGEST = /^[a-f0-9]{64}$/;

function failure(message, code = 'editor-invalid-query', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function queryFields(params, allowed) {
  const seen = new Set();
  for (const [key] of params) {
    if (!allowed.includes(key) || seen.has(key)) throw failure(`Unknown or repeated query parameter: ${key}.`);
    seen.add(key);
  }
}

function integer(params, key, fallback, maximum) {
  const value = params.get(key);
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw failure(`${key} must be an integer from 0 to ${maximum}.`);
  }
  return Number(value);
}

// Both application methods only load/validate committed events. In particular,
// never call verify(), ArtifactStore.get(), or any reconciliation from a GET.
async function snapshot(state) {
  const status = await state.application.getStatus();
  if (status.projectId !== state.projectId || status.projectRoot !== state.projectRoot) {
    throw failure('Project identity changed; restart the console.', 'editor-project-changed', 409);
  }
  const events = await state.application.listEvents();
  return { events, projection: projectEvents(events) };
}

function belongsToNode(event, nodeId, projection) {
  const payload = event.payload;
  if (event.streamId === `node:${nodeId}` || payload.nodeId === nodeId
    || payload.node?.id === nodeId || payload.nodeIds?.includes(nodeId)) return true;
  for (const [collection, field] of [['runs', 'runId'], ['changeSets', 'changeSetId'],
    ['evaluations', 'evaluationId'], ['evidence', 'evidenceId'], ['integrations', 'integrationId'], ['reversions', 'reversionId']]) {
    if (payload[field] && projection[collection]?.some((item) => item.id === payload[field] && item.nodeId === nodeId)) return true;
  }
  return false;
}

export async function queryEvents(state, params) {
  queryFields(params, ['after', 'limit', 'nodeId']);
  const after = integer(params, 'after', 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(params, 'limit', 100, 500);
  if (limit === 0) throw failure('limit must be at least 1.');
  const { events, projection } = await snapshot(state);
  const nodeId = params.get('nodeId');
  if (nodeId !== null && !projection.nodes.some((node) => node.id === nodeId)) {
    throw failure('Unknown node ID.', 'editor-node-not-found', 404);
  }
  const candidates = events.filter((event) => event.sequence > after
    && (nodeId === null || belongsToNode(event, nodeId, projection)));
  const selected = candidates.slice(0, limit);
  const hasMore = candidates.length > limit;
  // Once caught up, advance over nonmatching events too. The cursor remains a
  // global event sequence, never a page index or an index in a filtered array.
  const nextSequence = hasMore ? selected.at(-1).sequence : Math.max(after, events.at(-1)?.sequence ?? 0);
  return { events: selected, nextSequence, hasMore };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

async function pathSnapshot(projectRoot, relativePath) {
  const target = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw failure('Resource is outside the fixed project.', 'editor-unsafe-resource', 403);
  }
  // Walk all ancestors, including the root, so normalizing a junction cannot
  // erase evidence that the caller would otherwise be reading through a link.
  const parts = path.resolve(projectRoot).slice(path.parse(projectRoot).root.length).split(path.sep).filter(Boolean);
  let cursor = path.parse(projectRoot).root;
  const paths = [];
  for (const part of [...parts, ...relative.split(path.sep)]) {
    cursor = path.join(cursor, part);
    const stats = await lstat(cursor, { bigint: true });
    if (stats.isSymbolicLink() || (cursor === target ? !stats.isFile() : !stats.isDirectory())) {
      throw failure('Resource must be a regular file under real directories; links are not previewable.', 'editor-unsafe-resource', 403);
    }
    paths.push({ path: cursor, stats });
  }
  const physicalRoot = await realpath(projectRoot);
  const physicalTarget = await realpath(target);
  const physicalRelative = path.relative(physicalRoot, physicalTarget);
  if (physicalRelative.startsWith(`..${path.sep}`) || physicalRelative === '..' || path.isAbsolute(physicalRelative)) {
    throw failure('Resource resolves outside the project.', 'editor-unsafe-resource', 403);
  }
  return { target, paths, stats: paths.at(-1).stats };
}

// A bounded, descriptor-based read. Recheck directory/file identities after the
// read to reject replacement races. This is not a sandbox against a hostile OS
// administrator changing paths between syscalls; the project remains trusted.
async function readResource(projectRoot, relativePath, maximum) {
  let handle;
  try {
    const before = await pathSnapshot(projectRoot, relativePath);
    if (before.stats.size > BigInt(maximum)) throw failure('Resource exceeds the preview size limit.', 'editor-resource-too-large', 413);
    handle = await open(before.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before.stats, opened)) {
      throw failure('Resource changed while opening.', 'editor-resource-changed', 409);
    }
    const chunks = [];
    let size = 0;
    while (size <= maximum) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (size > maximum) throw failure('Resource exceeds the preview size limit.', 'editor-resource-too-large', 413);
    const after = await pathSnapshot(projectRoot, relativePath);
    const finished = await handle.stat({ bigint: true });
    if (before.paths.length !== after.paths.length || before.paths.some((entry, index) => !sameIdentity(entry.stats, after.paths[index].stats))
      || !sameIdentity(opened, finished) || opened.size !== finished.size || opened.mtimeNs !== finished.mtimeNs
      || opened.ctimeNs !== finished.ctimeNs || BigInt(size) !== finished.size) {
      throw failure('Resource changed during preview; retry the read.', 'editor-resource-changed', 409);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('Registered resource is missing from the current workspace.', 'editor-resource-not-found', 404);
    if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw failure('Unsafe resource path.', 'editor-unsafe-resource', 403);
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

function decodeText(bytes) {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (value.includes('\0')) return null;
    return value;
  } catch { return null; }
}

export async function queryRefContent(state, params) {
  queryFields(params, ['id', 'raw', 'hash']);
  const id = params.get('id');
  if (!isRefId(id)) throw failure('id must be a canonical registered ref:// ID.');
  if (params.has('raw') && params.get('raw') !== '1') throw failure('raw must equal 1 when supplied.');
  if (params.has('hash') && (params.get('raw') !== '1' || !DIGEST.test(params.get('hash')))) {
    throw failure('hash is an optional lowercase SHA-256 binding for a raw image response.');
  }
  const { projection } = await snapshot(state);
  const ref = projection.refs.find((item) => item.id === id);
  if (!ref) throw failure('Ref is not registered in this project.', 'editor-ref-not-found', 404);
  const base = { ref, kind: 'unsupported', mime: 'application/octet-stream',
    versionLabel: `Current workspace bytes; registered version: ${ref.version}` };
  if (/[*?]/.test(ref.uri)) {
    if (params.has('raw')) throw failure('Glob references cannot be served as an image.', 'editor-preview-unsupported', 415);
    return { body: { ...base, reason: 'Glob references identify a set of files; no directory scan or implicit file selection is performed.' } };
  }
  const relativePath = normalizeWorkspacePath(ref.uri);
  const extension = path.extname(relativePath).toLowerCase();
  const mime = IMAGES.get(extension);
  if (!mime && !TEXT.has(extension)) {
    if (params.has('raw')) throw failure('Only supported image references have a raw response.', 'editor-preview-unsupported', 415);
    return { body: { ...base, reason: 'This file type has no safe preview.' } };
  }
  const bytes = await readResource(state.projectRoot, relativePath, mime ? CONSOLE_READ_LIMITS.fileBytes : CONSOLE_READ_LIMITS.textBytes);
  const observedHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (params.has('hash') && `sha256:${params.get('hash')}` !== observedHash) {
    throw failure('Image changed after its preview metadata was read; refresh the reference.', 'editor-resource-changed', 409);
  }
  const result = { ...base, observedHash, matchesRegisteredHash: observedHash === ref.hash };
  if (mime) {
    // Bind a displayed image to the bytes described by its metadata. Otherwise
    // an edit between these two GETs could silently invalidate the hash badge.
    const url = `/api/fwa/refs/content?id=${encodeURIComponent(id)}&raw=1&hash=${observedHash.slice(7)}`;
    return params.has('raw') ? { bytes, mime } : { body: { ...result, kind: 'image', mime, url } };
  }
  if (params.has('raw')) throw failure('Only supported image references have a raw response.', 'editor-preview-unsupported', 415);
  const text = decodeText(bytes);
  if (text === null) return { body: { ...result, reason: 'File is not UTF-8 text.' } };
  return { body: { ...result, kind: 'text', mime: 'text/plain; charset=utf-8', text } };
}

function artifactRef(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === 1 && value.algorithm === 'sha256' && typeof value.digest === 'string' && DIGEST.test(value.digest)
    && Number.isSafeInteger(value.size) && value.size >= 0
    && Object.keys(value).sort().join(',') === 'algorithm,digest,schemaVersion,size';
}

function collectArtifacts(value, found) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (artifactRef(item)) {
      const known = found.get(item.digest);
      if (known && known.size !== item.size) throw failure('Conflicting sizes for a referenced artifact.', 'editor-artifact-corruption', 409);
      found.set(item.digest, item);
    } else {
      // Avoid spreading an untrusted wide JSON object into call arguments.
      for (const child of Object.values(item)) pending.push(child);
    }
  }
}

async function readArtifact(state, ref) {
  if (ref.size > CONSOLE_READ_LIMITS.fileBytes) throw failure('Artifact exceeds the preview size limit.', 'editor-resource-too-large', 413);
  let bytes;
  try {
    // Bound even a corrupt file by its authorized size, not just the global
    // ceiling, so failed graph branches cannot evade the traversal byte budget.
    bytes = await readResource(state.projectRoot, `.fwa/artifacts/sha256/${ref.digest.slice(0, 2)}/${ref.digest}`, ref.size);
  } catch (error) {
    if (error.code === 'editor-resource-too-large') throw failure('Artifact size does not match its authorized reference.', 'editor-artifact-corruption', 409);
    throw error;
  }
  if (bytes.length !== ref.size || createHash('sha256').update(bytes).digest('hex') !== ref.digest) {
    throw failure('Artifact digest or size does not match its authorized reference.', 'editor-artifact-corruption', 409);
  }
  return bytes;
}

export async function queryArtifact(state, params) {
  queryFields(params, ['digest', 'raw']);
  if (params.has('raw') && params.get('raw') !== '1') throw failure('raw must be 1 when supplied.');
  const digest = params.get('digest');
  if (!DIGEST.test(digest ?? '')) throw failure('digest must be a lowercase SHA-256 digest.');
  const { events } = await snapshot(state);
  const known = new Map();
  collectArtifacts(events, known);
  const visited = new Set();
  let totalBytes = 0;
  let branchFailure;
  // Directly event-authorized logs/diffs do not need unrelated artifact reads.
  // Nested references are authorized only after their parent bytes verify.
  while (!known.has(digest)) {
    const next = [...known.values()].find((ref) => !visited.has(ref.digest));
    if (!next) throw branchFailure ?? failure('Artifact is not reachable from this project history.', 'editor-artifact-not-authorized', 404);
    if (visited.size >= CONSOLE_READ_LIMITS.artifactCount) {
      throw failure('Artifact reachability exceeds the bounded preview traversal.', 'editor-artifact-traversal-limit', 413);
    }
    visited.add(next.digest);
    if (next.size > CONSOLE_READ_LIMITS.fileBytes) {
      branchFailure ??= failure('A potentially relevant artifact exceeds the preview size limit.', 'editor-resource-too-large', 413);
      continue;
    }
    if (totalBytes + next.size > CONSOLE_READ_LIMITS.artifactGraphBytes) {
      branchFailure ??= failure('Artifact reachability exceeds the bounded preview traversal.', 'editor-artifact-traversal-limit', 413);
      continue;
    }
    totalBytes += next.size;
    let content;
    try { content = await readArtifact(state, next); }
    catch (error) {
      // A broken/oversize historical root must not hide an independently
      // reachable artifact. Failed parents NEVER authorize any child refs.
      branchFailure ??= error;
      continue;
    }
    const text = decodeText(content);
    if (text !== null) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { continue; }
      collectArtifacts(parsed, known);
    }
  }
  if (visited.size >= CONSOLE_READ_LIMITS.artifactCount
    || totalBytes + known.get(digest).size > CONSOLE_READ_LIMITS.artifactGraphBytes) {
    throw failure('Artifact reachability exceeds the bounded preview traversal.', 'editor-artifact-traversal-limit', 413);
  }
  const bytes = await readArtifact(state, known.get(digest));
  let mime = null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) mime = 'image/gif';
  else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';
  else if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') mime = 'video/mp4';
  else if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) mime = 'video/webm';
  if (mime) {
    if (params.get('raw') === '1') return { bytes, mime };
    return { digest, size: bytes.length, format: mime.startsWith('image/') ? 'image' : 'video', mime,
      url: `/api/fwa/artifacts?digest=${digest}&raw=1`, immutable: true };
  }
  if (params.has('raw')) throw failure('Only recognized image/video artifacts support raw preview.', 'editor-preview-unsupported', 415);
  const fullText = decodeText(bytes);
  if (fullText === null) throw failure('Artifact is not UTF-8 text.', 'editor-preview-unsupported', 415);
  const truncated = bytes.length > CONSOLE_READ_LIMITS.textBytes;
  // Buffer decoding may replace only a clipped final codepoint in the preview;
  // the full artifact has already been validated as UTF-8 and SHA-256 checked.
  const text = truncated ? bytes.subarray(0, CONSOLE_READ_LIMITS.textBytes).toString('utf8') : fullText;
  let format = 'text';
  if (!truncated) { try { JSON.parse(fullText); format = 'json'; } catch { /* plain text */ } }
  return { digest, size: bytes.length, text, format, truncated };
}
