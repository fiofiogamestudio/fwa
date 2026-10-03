import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink
} from 'node:fs/promises';
import path from 'node:path';

export const ARTIFACT_REF_SCHEMA_VERSION = 1;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SHARD_PATTERN = /^[a-f0-9]{2}$/;
const TEMP_FILE_PATTERN = /^\.artifact-([a-f0-9]{64})-([0-9a-f-]+)\.tmp$/i;
const UNLINK_RETRY_DELAYS = Object.freeze([5, 10, 20, 40, 80]);
// All instances in this process share a gate for the same physical store. A
// public read may recover/scan the tree too, so serializing only put is unsafe.
// This is not a cross-process lock and creates no persistent ownership state.
const storeOperations = new Map();

export class ArtifactStoreError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ArtifactStoreError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * Dependency-free, immutable content-addressed storage rooted at
 * <project>/.fwa/artifacts/sha256. Artifact refs are portable JSON values and
 * intentionally contain no machine-specific absolute path.
 */
export class ArtifactStore {
  constructor(projectRoot) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new ArtifactStoreError(
        'projectRoot must be a non-empty string.',
        'invalid-project-root'
      );
    }
    this.projectRoot = path.resolve(projectRoot);
    this.stateDirectory = path.join(this.projectRoot, '.fwa');
    this.artifactsDirectory = path.join(this.stateDirectory, 'artifacts');
    this.hashDirectory = path.join(this.artifactsDirectory, 'sha256');
  }

  async init() {
    return this.#withStoreOperation(() => this.#init());
  }

  async #init() {
    await assertRealDirectory(this.projectRoot, 'project root');
    await ensureRealDirectory(this.stateDirectory, 0o700, 'FWA state directory');
    const created = !(await pathExists(this.artifactsDirectory));
    await ensureRealDirectory(this.artifactsDirectory, 0o700, 'artifact directory');
    await ensureRealDirectory(this.hashDirectory, 0o700, 'SHA-256 artifact directory');
    const recovery = await this.#recoverPublishedTemps();
    const verification = await this.#verifyPrepared();
    return { created, recovery, ...verification };
  }

  /**
   * Store bytes once. A hard-link publish makes creation atomic and prevents a
   * concurrent writer from replacing an already-addressed artifact.
   */
  async put(value) {
    // Snapshot before waiting for the gate; the caller may reuse its buffer as
    // soon as put returns a promise, while another publication is still active.
    const bytes = snapshotBytes(value);
    return this.#withStoreOperation(() => this.#put(bytes));
  }

  async #put(bytes) {
    await this.#assertInitialized();
    await this.#recoverPublishedTemps();
    const digest = digestBytes(bytes);
    const ref = createArtifactRef(digest, bytes.byteLength);
    await this.#assertSafeTree();

    const shardDirectory = path.join(this.hashDirectory, digest.slice(0, 2));
    await ensureRealDirectory(shardDirectory, 0o700, 'artifact shard directory');
    const artifactPath = path.join(shardDirectory, digest);

    if (await pathExists(artifactPath)) {
      await verifyArtifactFile(artifactPath, ref);
      return ref;
    }

    const tempPath = path.join(
      shardDirectory,
      `.artifact-${digest}-${randomUUID()}.tmp`
    );
    let temporaryFile;
    let published = false;
    try {
      temporaryFile = await open(tempPath, 'wx', 0o600);
      await temporaryFile.writeFile(bytes);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;

      try {
        await link(tempPath, artifactPath);
        published = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await verifyArtifactFile(artifactPath, ref);
      }

      await unlinkWithRetry(tempPath, { allowMissing: true });
      await syncDirectoryWhenSupported(shardDirectory);
    } catch (error) {
      if (temporaryFile) await temporaryFile.close().catch(() => {});
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        `Atomic artifact write failed; inspect ${tempPath}.`,
        'artifact-write-failed',
        { cause: error, details: { tempPath, artifactPath, published } }
      );
    }

    await verifyArtifactFile(artifactPath, ref);
    return ref;
  }

  async get(ref) {
    return this.#withStoreOperation(() => this.#get(ref));
  }

  async #get(ref) {
    await this.#assertInitialized();
    await this.#recoverPublishedTemps();
    const normalized = validateArtifactRef(ref);
    await this.#assertSafeTree();
    const artifactPath = this.#pathFor(normalized.digest);
    return verifyArtifactFile(artifactPath, normalized, { returnBytes: true });
  }

  /** Verify one ref, or scan and verify the complete store when ref is omitted. */
  async verify(ref) {
    return this.#withStoreOperation(() => this.#verify(ref));
  }

  async #verify(ref) {
    await this.#assertInitialized();
    await this.#recoverPublishedTemps();
    return this.#verifyPrepared(ref);
  }

  // These prepared helpers run only inside the current operation's store gate,
  // after its path checks and recovery. Nothing is retained across public calls.
  async #verifyPrepared(ref) {
    if (ref !== undefined) {
      const normalized = validateArtifactRef(ref);
      await this.#assertSafeTree();
      await verifyArtifactFile(this.#pathFor(normalized.digest), normalized);
      return { ok: true, ref: normalized };
    }

    const refs = await this.#listRefsPrepared();
    return {
      ok: true,
      artifactCount: refs.length,
      totalBytes: refs.reduce((total, candidate) => total + candidate.size, 0)
    };
  }

  /**
   * Return a verified inventory suitable for reachability checks. Merely
   * finding a digest-shaped filename is insufficient: every byte sequence is
   * hashed again before its ref is returned.
   */
  async listRefs() {
    return this.#withStoreOperation(() => this.#listRefs());
  }

  async #listRefs() {
    await this.#assertInitialized();
    await this.#recoverPublishedTemps();
    return this.#listRefsPrepared();
  }

  async #listRefsPrepared() {
    const entries = await this.#scanTree();
    const refs = [];
    for (const entry of entries) {
      const stats = await verifyArtifactFile(entry.filePath, {
        schemaVersion: ARTIFACT_REF_SCHEMA_VERSION,
        algorithm: 'sha256',
        digest: entry.digest
      }, { sizeOptional: true });
      refs.push(createArtifactRef(entry.digest, stats.byteLength));
    }
    return Object.freeze(refs);
  }

  /**
   * Complete the safe half of an interrupted hard-link publication. A temp is
   * removed only when the final digest path is the very same filesystem object;
   * equal bytes in a copied file are deliberately insufficient evidence.
   */
  async recoverPublishedTemps() {
    return this.#withStoreOperation(() => this.#recoverPublishedTemps());
  }

  async #recoverPublishedTemps() {
    await this.#assertInitialized();
    const recovered = [];
    let shards;
    try {
      shards = await readdir(this.hashDirectory, { withFileTypes: true });
    } catch (error) {
      throw new ArtifactStoreError(
        `Failed to list artifact store ${this.hashDirectory}.`,
        'artifact-store-read-failed',
        { cause: error }
      );
    }
    for (const shard of shards) {
      if (shard.isSymbolicLink() || !shard.isDirectory() || !SHARD_PATTERN.test(shard.name)) {
        continue;
      }
      const shardPath = path.join(this.hashDirectory, shard.name);
      const files = await readdir(shardPath, { withFileTypes: true });
      for (const file of files) {
        const match = TEMP_FILE_PATTERN.exec(file.name);
        if (!match || file.isSymbolicLink() || !file.isFile()) continue;
        const digest = match[1].toLowerCase();
        if (digest.slice(0, 2) !== shard.name) continue;
        const tempPath = path.join(shardPath, file.name);
        const artifactPath = path.join(shardPath, digest);
        let temporaryStats;
        let artifactStats;
        try {
          [temporaryStats, artifactStats] = await Promise.all([
            lstat(tempPath, { bigint: true }),
            lstat(artifactPath, { bigint: true })
          ]);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        if (!sameFileIdentity(temporaryStats, artifactStats)
          || temporaryStats.isSymbolicLink()
          || artifactStats.isSymbolicLink()
          || !temporaryStats.isFile()
          || !artifactStats.isFile()) {
          continue;
        }
        await verifyArtifactFile(artifactPath, {
          schemaVersion: ARTIFACT_REF_SCHEMA_VERSION,
          algorithm: 'sha256',
          digest
        }, { sizeOptional: true });
        await unlinkWithRetry(tempPath, { allowMissing: true });
        recovered.push(tempPath);
        await syncDirectoryWhenSupported(shardPath);
      }
    }
    return { recoveredCount: recovered.length, recovered };
  }

  async #withStoreOperation(operation) {
    // Resolve parent aliases as well as Windows casing. Invalid roots still go
    // through the original path validation inside the guarded operation.
    const root = await realpath(this.projectRoot).catch(() => this.projectRoot);
    const directory = path.join(root, '.fwa', 'artifacts');
    const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    const result = (storeOperations.get(key) ?? Promise.resolve()).then(operation);
    const settled = result.catch(() => {});
    storeOperations.set(key, settled);
    try {
      return await result;
    } finally {
      if (storeOperations.get(key) === settled) storeOperations.delete(key);
    }
  }

  async #assertInitialized() {
    await assertRealDirectory(this.projectRoot, 'project root');
    await assertRealDirectory(
      this.stateDirectory,
      'FWA state directory',
      'artifact-store-not-initialized'
    );
    await assertRealDirectory(
      this.artifactsDirectory,
      'artifact directory',
      'artifact-store-not-initialized'
    );
    await assertRealDirectory(
      this.hashDirectory,
      'SHA-256 artifact directory',
      'artifact-store-not-initialized'
    );
  }

  #pathFor(digest) {
    return path.join(this.hashDirectory, digest.slice(0, 2), digest);
  }

  async #assertSafeTree() {
    await this.#scanTree({ hashContents: false });
  }

  async #scanTree() {
    let rootEntries;
    try {
      rootEntries = await readdir(this.artifactsDirectory, { withFileTypes: true });
    } catch (error) {
      throw new ArtifactStoreError(
        `Failed to list artifact directory ${this.artifactsDirectory}.`,
        'artifact-store-read-failed',
        { cause: error }
      );
    }
    for (const entry of rootEntries) {
      const entryPath = path.join(this.artifactsDirectory, entry.name);
      if (entry.name.endsWith('.tmp')) throw orphanTemporaryArtifact(entryPath);
      if (entry.name !== 'sha256' || entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new ArtifactStoreError(
          `Unexpected or unsafe artifact-store entry: ${entryPath}`,
          entry.isSymbolicLink() ? 'unsafe-artifact-path' : 'artifact-store-corruption',
          { details: { entry: entryPath } }
        );
      }
    }

    let shardEntries;
    try {
      shardEntries = await readdir(this.hashDirectory, { withFileTypes: true });
    } catch (error) {
      throw new ArtifactStoreError(
        `Failed to list artifact store ${this.hashDirectory}.`,
        'artifact-store-read-failed',
        { cause: error }
      );
    }

    const artifacts = [];
    for (const shard of shardEntries.sort(compareDirectoryEntries)) {
      const shardPath = path.join(this.hashDirectory, shard.name);
      if (TEMP_FILE_PATTERN.test(shard.name) || shard.name.endsWith('.tmp')) {
        throw orphanTemporaryArtifact(shardPath);
      }
      if (shard.isSymbolicLink() || !shard.isDirectory() || !SHARD_PATTERN.test(shard.name)) {
        throw new ArtifactStoreError(
          `Unexpected or unsafe artifact-store entry: ${shardPath}`,
          shard.isSymbolicLink() ? 'unsafe-artifact-path' : 'artifact-store-corruption',
          { details: { entry: shardPath } }
        );
      }
      await assertRealDirectory(shardPath, 'artifact shard directory');

      let files;
      try {
        files = await readdir(shardPath, { withFileTypes: true });
      } catch (error) {
        throw new ArtifactStoreError(
          `Failed to list artifact shard ${shardPath}.`,
          'artifact-store-read-failed',
          { cause: error }
        );
      }
      for (const file of files.sort(compareDirectoryEntries)) {
        const filePath = path.join(shardPath, file.name);
        if (TEMP_FILE_PATTERN.test(file.name) || file.name.endsWith('.tmp')) {
          throw orphanTemporaryArtifact(filePath);
        }
        if (file.isSymbolicLink() || !file.isFile()) {
          throw new ArtifactStoreError(
            `Artifact must be a real file: ${filePath}`,
            'unsafe-artifact-path',
            { details: { entry: filePath } }
          );
        }
        if (!DIGEST_PATTERN.test(file.name) || file.name.slice(0, 2) !== shard.name) {
          throw new ArtifactStoreError(
            `Artifact path does not match the SHA-256 layout: ${filePath}`,
            'artifact-store-corruption',
            { details: { entry: filePath } }
          );
        }
        artifacts.push({ digest: file.name, filePath });
      }
    }
    return artifacts;
  }
}

export function createArtifactRef(digest, size) {
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    throw new ArtifactStoreError(
      'Artifact digest must be a lowercase SHA-256 hash.',
      'invalid-artifact-ref'
    );
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ArtifactStoreError(
      'Artifact size must be a non-negative safe integer.',
      'invalid-artifact-ref'
    );
  }
  return Object.freeze({
    schemaVersion: ARTIFACT_REF_SCHEMA_VERSION,
    algorithm: 'sha256',
    digest,
    size
  });
}

function validateArtifactRef(ref) {
  if (!isPlainRecord(ref)) {
    throw new ArtifactStoreError('Artifact ref must be an object.', 'invalid-artifact-ref');
  }
  const expectedKeys = ['algorithm', 'digest', 'schemaVersion', 'size'];
  const actualKeys = Object.keys(ref).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new ArtifactStoreError(
      'Artifact ref fields do not match schema version 1.',
      'invalid-artifact-ref'
    );
  }
  if (ref.schemaVersion !== ARTIFACT_REF_SCHEMA_VERSION || ref.algorithm !== 'sha256') {
    throw new ArtifactStoreError(
      'Artifact ref must use schema version 1 and SHA-256.',
      'invalid-artifact-ref'
    );
  }
  return createArtifactRef(ref.digest, ref.size);
}

async function verifyArtifactFile(filePath, ref, {
  returnBytes = false,
  sizeOptional = false
} = {}) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ArtifactStoreError(
        `Artifact is missing: ${ref.digest}`,
        'artifact-not-found',
        { cause: error, details: { ref } }
      );
    }
    throw new ArtifactStoreError(
      `Failed to inspect artifact ${filePath}.`,
      'artifact-store-read-failed',
      { cause: error }
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ArtifactStoreError(
      `Artifact must be a real file: ${filePath}`,
      'unsafe-artifact-path'
    );
  }

  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new ArtifactStoreError(
      `Failed to read artifact ${filePath}.`,
      'artifact-store-read-failed',
      { cause: error }
    );
  }
  const actualDigest = digestBytes(bytes);
  if (actualDigest !== ref.digest) {
    throw new ArtifactStoreError(
      `Artifact digest mismatch for ${ref.digest}.`,
      'artifact-corruption',
      { details: { expected: ref.digest, actual: actualDigest } }
    );
  }
  if (!sizeOptional && bytes.byteLength !== ref.size) {
    throw new ArtifactStoreError(
      `Artifact size mismatch for ${ref.digest}.`,
      'artifact-corruption',
      { details: { expected: ref.size, actual: bytes.byteLength } }
    );
  }
  if (returnBytes) return bytes;
  return { byteLength: bytes.byteLength };
}

function snapshotBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  throw new ArtifactStoreError(
    'Artifact content must be a string, Buffer, or Uint8Array.',
    'invalid-artifact-content'
  );
}

function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareDirectoryEntries(left, right) {
  return left.name.localeCompare(right.name);
}

function orphanTemporaryArtifact(filePath) {
  return new ArtifactStoreError(
    `Orphaned artifact transaction: ${filePath}`,
    'orphan-temporary-artifact',
    { details: { file: filePath } }
  );
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino !== 0n
    && left.ino === right.ino;
}

async function unlinkWithRetry(targetPath, { allowMissing = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(targetPath);
      return;
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (!retryable || attempt >= UNLINK_RETRY_DELAYS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, UNLINK_RETRY_DELAYS[attempt]));
    }
  }
}

async function assertRealDirectory(targetPath, label, missingCode = 'invalid-project-root') {
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new ArtifactStoreError(`${label} does not exist: ${targetPath}`, missingCode, { cause: error });
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ArtifactStoreError(
      `${label} must be a real directory: ${targetPath}`,
      'unsafe-artifact-path'
    );
  }
}

async function ensureRealDirectory(targetPath, mode, label) {
  try {
    await mkdir(targetPath, { mode });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await assertRealDirectory(targetPath, label, 'artifact-store-not-initialized');
}

async function syncDirectoryWhenSupported(directoryPath) {
  let directory;
  try {
    directory = await open(directoryPath, 'r');
    await directory.sync();
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EACCES'].includes(error.code)) {
      throw new ArtifactStoreError(
        `Directory fsync failed for ${directoryPath}.`,
        'directory-sync-failed',
        { cause: error }
      );
    }
  } finally {
    if (directory) await directory.close().catch(() => {});
  }
}
