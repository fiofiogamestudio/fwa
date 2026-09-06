import { createHash } from 'node:crypto';

import {
  matchesEffectPattern,
  normalizeEffectPattern
} from './effects.js';
import { stableStringify } from './events.js';

const REF_ID_PATTERN = /^ref:\/\/([a-z][a-z0-9-]*)\/([a-z0-9][a-z0-9._/-]*)$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function issue(code, path, message, details = undefined) {
  const result = { code, path, message };
  if (details !== undefined) result.details = details;
  return Object.freeze(result);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function cloneJson(value, path, errors) {
  try {
    return JSON.parse(stableStringify(value));
  } catch (error) {
    errors.push(issue('INVALID_REF_METADATA', path, error.message));
    return null;
  }
}

export class RefValidationError extends Error {
  constructor(errors) {
    super(`Ref validation failed with ${errors.length} error(s).`);
    this.name = 'RefValidationError';
    this.code = 'FWA_INVALID_REF';
    this.errors = Object.freeze([...errors]);
  }
}

export function isRefId(value) {
  if (typeof value !== 'string') return false;
  const match = REF_ID_PATTERN.exec(value);
  if (!match) return false;
  const logicalPath = match[2];
  return !logicalPath.includes('//')
    && !logicalPath.split('/').some((part) => part === '.' || part === '..')
    && !logicalPath.endsWith('/');
}

export function validateRef(ref, options = {}) {
  const errors = [];
  const path = options.path ?? 'ref';
  if (!isPlainObject(ref)) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze([issue('INVALID_REF', path, 'Expected a Ref object.')])
    });
  }

  const allowed = ['id', 'kind', 'uri', 'version', 'hash', 'metadata'];
  for (const field of Object.keys(ref)) {
    if (!allowed.includes(field)) {
      errors.push(issue(
        'UNKNOWN_REF_FIELD',
        `${path}.${field}`,
        `Unknown Ref field "${field}".`
      ));
    }
  }

  const match = typeof ref.id === 'string' ? REF_ID_PATTERN.exec(ref.id) : null;
  if (!isRefId(ref.id)) {
    errors.push(issue(
      'INVALID_REF_ID',
      `${path}.id`,
      'Expected a canonical logical id such as ref://code/player-controller.'
    ));
  }
  if (typeof ref.kind !== 'string'
    || !/^[a-z][a-z0-9-]*$/u.test(ref.kind)
    || ref.kind !== match?.[1]) {
    errors.push(issue(
      'INVALID_REF_KIND',
      `${path}.kind`,
      'kind must be lowercase and equal the first logical-id segment.'
    ));
  }
  try {
    normalizeEffectPattern(ref.uri, { path: `${path}.uri` });
  } catch (error) {
    errors.push(issue(
      'INVALID_REF_URI',
      `${path}.uri`,
      'uri must be one portable workspace-relative path or glob.',
      { cause: error.code ?? error.name }
    ));
  }
  if (typeof ref.version !== 'string'
    || ref.version.length === 0
    || ref.version !== ref.version.trim()) {
    errors.push(issue(
      'INVALID_REF_VERSION',
      `${path}.version`,
      'version must be a non-empty, trimmed string.'
    ));
  }
  if (typeof ref.hash !== 'string' || !SHA256_PATTERN.test(ref.hash)) {
    errors.push(issue(
      'INVALID_REF_HASH',
      `${path}.hash`,
      'hash must be a lowercase sha256:<64 hex> digest.'
    ));
  }
  if (!isPlainObject(ref.metadata)) {
    errors.push(issue(
      'INVALID_REF_METADATA',
      `${path}.metadata`,
      'metadata must be a JSON object.'
    ));
  } else {
    cloneJson(ref.metadata, `${path}.metadata`, errors);
  }

  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

export function normalizeRef(ref, options = {}) {
  const result = validateRef(ref, options);
  if (!result.ok) throw new RefValidationError(result.errors);
  return Object.freeze({
    id: ref.id,
    kind: ref.kind,
    uri: normalizeEffectPattern(ref.uri),
    version: ref.version,
    hash: ref.hash,
    metadata: Object.freeze(cloneJson(ref.metadata, 'ref.metadata', []))
  });
}

export function assertRefSet(refs) {
  if (!Array.isArray(refs)) {
    throw new TypeError('refs must be an array.');
  }
  const normalized = [];
  const ids = new Set();
  for (let index = 0; index < refs.length; index += 1) {
    const ref = normalizeRef(refs[index], { path: `refs[${index}]` });
    if (ids.has(ref.id)) {
      throw new RefValidationError([issue(
        'DUPLICATE_REF_ID',
        `refs[${index}].id`,
        `Duplicate Ref id "${ref.id}".`
      )]);
    }
    ids.add(ref.id);
    normalized.push(ref);
  }
  return Object.freeze(normalized);
}

function resolveEffectList(values, refsById, path) {
  if (!Array.isArray(values)) throw new TypeError(`${path} must be an array.`);
  const patterns = [];
  const snapshots = [];
  const seenPatterns = new Set();
  const seenRefs = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (isRefId(value)) {
      const ref = refsById.get(value);
      if (!ref) {
        throw new RefValidationError([issue(
          'UNKNOWN_REF',
          `${path}[${index}]`,
          `Logical Ref "${value}" is not registered.`
        )]);
      }
      if (!seenRefs.has(ref.id)) {
        snapshots.push(Object.freeze({
          id: ref.id,
          kind: ref.kind,
          uri: ref.uri,
          version: ref.version,
          hash: ref.hash
        }));
        seenRefs.add(ref.id);
      }
      if (!seenPatterns.has(ref.uri)) {
        patterns.push(ref.uri);
        seenPatterns.add(ref.uri);
      }
    } else {
      const pattern = normalizeEffectPattern(value, { path: `${path}[${index}]` });
      if (!seenPatterns.has(pattern)) {
        patterns.push(pattern);
        seenPatterns.add(pattern);
      }
    }
  }
  return { patterns: Object.freeze(patterns), refs: Object.freeze(snapshots) };
}

export function resolveNodeEffects(node, refs) {
  if (!isPlainObject(node)) throw new TypeError('node must be an object.');
  const normalizedRefs = assertRefSet(refs);
  const refsById = new Map(normalizedRefs.map((ref) => [ref.id, ref]));
  const reads = resolveEffectList(node.reads, refsById, 'node.reads');
  const writes = resolveEffectList(node.writes, refsById, 'node.writes');
  return Object.freeze({
    reads: reads.patterns,
    writes: writes.patterns,
    consumedRefs: reads.refs,
    producedRefs: writes.refs
  });
}

export function changedRefsForFiles(producedRefs, changedFiles, options = {}) {
  const normalizedRefs = assertRefSet(producedRefs.map((ref) => ({
    ...ref,
    metadata: ref.metadata ?? {}
  })));
  if (!Array.isArray(changedFiles)) throw new TypeError('changedFiles must be an array.');
  return Object.freeze(normalizedRefs
    .filter((ref) => changedFiles.some((file) => matchesEffectPattern(
      ref.uri,
      file,
      { ignoreCase: options.ignoreCase === true }
    )))
    .map((ref) => ref.id)
    .sort((left, right) => left.localeCompare(right, 'en')));
}

export function refVersionDigest({ ref, revision, changedFiles, changes, ignoreCase = false }) {
  const normalized = normalizeRef(ref);
  if (typeof revision !== 'string' || revision.length === 0 || revision !== revision.trim()) {
    throw new TypeError('revision must be a non-empty, trimmed string.');
  }
  if (typeof ignoreCase !== 'boolean') {
    throw new TypeError('ignoreCase must be a boolean.');
  }
  const relevantFiles = [...changedFiles]
    .filter((file) => matchesEffectPattern(normalized.uri, file, { ignoreCase }))
    .sort();
  const relevantChanges = [...changes]
    .filter((change) => relevantFiles.includes(change.path)
      || (change.previousPath !== undefined && relevantFiles.includes(change.previousPath)))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  const digest = createHash('sha256').update(stableStringify({
    schemaVersion: 1,
    refId: normalized.id,
    revision,
    ignoreCase,
    changedFiles: relevantFiles,
    changes: relevantChanges
  }), 'utf8').digest('hex');
  return `sha256:${digest}`;
}
