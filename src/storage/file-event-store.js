import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink
} from 'node:fs/promises';
import path from 'node:path';

export const FILE_EVENT_STORE_SCHEMA_VERSION = 1;

const GENESIS_HASH = '0'.repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BATCH_FILE_PATTERN = /^batch-(\d{16})\.json$/;
const BATCH_READ_CONCURRENCY = 4;
const LOCK_TEMP_FILE_PATTERN = /^\.lock\.[0-9a-f-]+\.tmp$/i;
const LOCK_FILE_NAME = '.lock';
const LOCK_SCHEMA_VERSION = 1;
const RECOVERY_CLAIM_SCHEMA_VERSION = 1;
const STALE_CLAIM_TAKEOVER_SCHEMA_VERSION = 1;
const LOCK_RECOVERY_DIRECTORY = 'recovery';
const LOCK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_RELEASE_RETRY_DELAYS = Object.freeze([5, 10, 20, 40, 80]);

export class FileEventStoreError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'FileEventStoreError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * Hash a JSON value using a deterministic, recursively key-sorted encoding.
 * This is suitable for building the stable intentHash accepted by appendBatch.
 */
export function hashCanonicalValue(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * A dependency-free, append-only event store rooted at <project>/.fwa/events.
 *
 * Events are complete domain event envelopes. The store never changes them or
 * recalculates an event-level hash. Callers must pre-assign globally continuous
 * event.sequence values before calling appendBatch.
 */
export class FileEventStore {
  constructor(projectRoot, {
    clock = () => new Date(),
    pidProbe = defaultPidProbe,
    idFactory = randomUUID
  } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new FileEventStoreError(
        'projectRoot must be a non-empty string.',
        'invalid-project-root'
      );
    }

    if (typeof clock !== 'function' || typeof pidProbe !== 'function'
      || typeof idFactory !== 'function') {
      throw new FileEventStoreError(
        'clock, pidProbe, and idFactory must be functions.',
        'invalid-event-store-options'
      );
    }
    this.projectRoot = path.resolve(projectRoot);
    this.stateDirectory = path.join(this.projectRoot, '.fwa');
    this.eventsDirectory = path.join(this.stateDirectory, 'events');
    this.lockPath = path.join(this.eventsDirectory, LOCK_FILE_NAME);
    this.recoveryDirectory = path.join(this.eventsDirectory, LOCK_RECOVERY_DIRECTORY);
    this.clock = clock;
    this.pidProbe = pidProbe;
    this.idFactory = idFactory;
  }

  async init() {
    await assertRealDirectory(this.projectRoot, 'project root');
    await ensureRealDirectory(this.stateDirectory, 0o700, 'FWA state directory');

    const created = !(await pathExists(this.eventsDirectory));
    await ensureRealDirectory(this.eventsDirectory, 0o700, 'event directory');
    await ensureRealDirectory(this.recoveryDirectory, 0o700, 'event recovery directory');

    const verification = await this.verify();
    return { created, ...verification };
  }

  async readAll() {
    await this.#assertInitialized();
    return this.#readVerifiedState();
  }

  async verify() {
    await this.#assertInitialized();
    const state = await this.#readVerifiedState();
    return {
      ok: true,
      batchCount: state.batches.length,
      eventCount: state.events.length,
      commandCount: state.batches.length,
      lastSequence: state.lastSequence,
      lastBatchHash: state.lastBatchHash
    };
  }

  async inspectLock() {
    await this.#assertInitialized();
    let lock;
    let sourcePath = this.lockPath;
    let published = true;
    try {
      lock = await readLock(this.lockPath, { allowMissing: true });
    } catch (error) {
      if (error instanceof FileEventStoreError) throw error;
      throw new FileEventStoreError(
        `Failed to inspect event-store lock ${this.lockPath}.`,
        'lock-read-failed',
        { cause: error }
      );
    }
    if (!lock) {
      const entries = await readdir(this.eventsDirectory, { withFileTypes: true });
      const publicationTemps = entries
        .filter((entry) => entry.isFile() && LOCK_TEMP_FILE_PATTERN.test(entry.name))
        .map((entry) => path.join(this.eventsDirectory, entry.name));
      if (publicationTemps.length === 0) {
        return {
          held: false,
          status: 'free',
          stale: false,
          reason: 'event-store-free',
          lock: null,
          published: false
        };
      }
      if (publicationTemps.length !== 1) {
        throw new FileEventStoreError(
          'Multiple orphaned event-lock publication files require manual inspection.',
          'ambiguous-temporary-locks',
          { details: { files: publicationTemps } }
        );
      }
      sourcePath = publicationTemps[0];
      published = false;
      lock = await readLock(sourcePath);
    }
    let ownerAlive = null;
    try {
      const probed = await this.pidProbe(lock.pid);
      if (typeof probed !== 'boolean') throw new TypeError('pidProbe must return boolean.');
      ownerAlive = probed;
    } catch {
      ownerAlive = null;
    }
    return {
      held: true,
      status: ownerAlive === false
        ? 'stale'
        : ownerAlive === true ? 'active' : 'indeterminate',
      stale: ownerAlive === false,
      reason: ownerAlive === false
        ? 'owner-dead'
        : ownerAlive === true ? 'owner-alive' : 'owner-liveness-unknown',
      ownerAlive,
      lock,
      published,
      sourcePath
    };
  }

  /**
   * Explicitly archive a lock and incomplete transaction files only when the
   * recorded owner PID is conclusively dead. A hard-link claim plus two lock-id
   * comparisons prevents one recovery process from deleting a replacement lock.
   */
  async recoverStaleLock({ expectedLockId } = {}) {
    await this.#assertInitialized();
    const inspection = await this.inspectLock();
    if (!inspection.held) {
      return { recovered: false, reason: 'event-store-free' };
    }
    if (expectedLockId !== undefined && inspection.lock.lockId !== expectedLockId) {
      throw new FileEventStoreError(
        'The event-store lock changed before recovery.',
        'lock-recovery-conflict',
        { details: { expectedLockId, actualLockId: inspection.lock.lockId } }
      );
    }
    if (!inspection.stale) {
      throw new FileEventStoreError(
        `Event-store lock ${inspection.lock.lockId} is not safely stale.`,
        'event-store-lock-not-stale',
        { details: inspection }
      );
    }

    const lockId = inspection.lock.lockId;
    let sourcePath = inspection.sourcePath;
    const recoveryClaim = await this.#acquireRecoveryClaim(lockId);

    let recovered = false;
    try {
      let current = await readLock(sourcePath);
      if (current.lockId !== lockId) {
        throw new FileEventStoreError(
          'The event-store lock changed during recovery.',
          'lock-recovery-conflict',
          { details: { expectedLockId: lockId, actualLockId: current.lockId } }
        );
      }

      let publicationTempPath = null;
      if (!inspection.published) {
        publicationTempPath = sourcePath;
        try {
          await link(sourcePath, this.lockPath);
        } catch (error) {
          throw new FileEventStoreError(
            'A writer published a different event-store lock during recovery.',
            'lock-recovery-conflict',
            { cause: error, details: { lockId } }
          );
        }
        sourcePath = this.lockPath;
        current = await readLock(sourcePath);
        if (current.lockId !== lockId) {
          throw new FileEventStoreError(
            'The recovery fence does not match the selected lock.',
            'lock-recovery-conflict'
          );
        }
      }

      const entries = await readdir(this.eventsDirectory, { withFileTypes: true });
      const transactionTemps = entries
        .filter((entry) => (
          entry.isFile()
          && entry.name.endsWith('.tmp')
          && !LOCK_TEMP_FILE_PATTERN.test(entry.name)
        ))
        .map((entry) => entry.name)
        .sort();
      const matchingPublicationTemps = [];
      for (const entry of entries.filter((candidate) => (
        candidate.isFile() && LOCK_TEMP_FILE_PATTERN.test(candidate.name)
      ))) {
        const candidatePath = path.join(this.eventsDirectory, entry.name);
        if (publicationTempPath && candidatePath === publicationTempPath) continue;
        const candidate = await readLock(candidatePath);
        if (candidate.lockId !== lockId) {
          throw new FileEventStoreError(
            'Another lock publication is in progress during stale-lock recovery.',
            'lock-recovery-conflict',
            { details: { selectedLockId: lockId, otherLockId: candidate.lockId } }
          );
        }
        matchingPublicationTemps.push(candidatePath);
      }
      const timestamp = this.#now().toISOString().replaceAll(':', '-');
      const archivedFiles = [];
      for (const name of transactionTemps) {
        const destination = path.join(
          this.recoveryDirectory,
          `${timestamp}--${lockId}--${randomUUID()}--${name}`
        );
        await rename(path.join(this.eventsDirectory, name), destination);
        archivedFiles.push(destination);
      }

      await this.#readVerifiedState({ lockOwned: true });
      const currentBeforeArchive = await readLock(this.lockPath);
      if (currentBeforeArchive.lockId !== lockId) {
        throw new FileEventStoreError(
          'The event-store lock changed before archival.',
          'lock-recovery-conflict'
        );
      }
      const archivedLockPath = path.join(
        this.recoveryDirectory,
        `${timestamp}--${lockId}--stale-lock.json`
      );
      let archivedPublicationPath = null;
      if (publicationTempPath) {
        archivedPublicationPath = path.join(
          this.recoveryDirectory,
          `${timestamp}--${lockId}--publication-temp.json`
        );
        await rename(publicationTempPath, archivedPublicationPath);
      }
      const archivedMatchingPublications = [];
      for (const candidatePath of matchingPublicationTemps) {
        const destination = path.join(
          this.recoveryDirectory,
          `${timestamp}--${lockId}--${randomUUID()}--publication-temp.json`
        );
        await rename(candidatePath, destination);
        archivedMatchingPublications.push(destination);
      }
      await rename(this.lockPath, archivedLockPath);
      await syncDirectoryWhenSupported(this.eventsDirectory);
      await syncDirectoryWhenSupported(this.recoveryDirectory);
      recovered = true;
      return {
        recovered: true,
        reason: 'owner-dead',
        lock: inspection.lock,
        archivedLockPath,
        archivedPublicationPath,
        archivedMatchingPublications,
        archivedFiles
      };
    } catch (error) {
      if (error instanceof FileEventStoreError) throw error;
      throw new FileEventStoreError(
        `Failed to recover stale event-store lock ${lockId}.`,
        'lock-recovery-failed',
        { cause: error, details: { lockId } }
      );
    } finally {
      try {
        await this.#releaseRecoveryClaim(recoveryClaim);
      } catch (error) {
        if (error.code !== 'ENOENT' && recovered) {
          // The claim lives inside the ignored recovery directory and is safe
          // to leave as evidence; it never blocks a writer.
        }
      }
    }
  }

  /**
   * Append one command transaction.
   *
   * @param {string} commandId Stable identifier for this command attempt.
   * @param {object[]} events Complete JSON event envelopes with global sequence.
   * @param {object} options Concurrency and idempotency guards.
   * @param {number} options.expectedLastSequence Last sequence observed by caller.
   * @param {string} options.intentHash Stable SHA-256 of normalized command input.
   * @returns {{appended: boolean, batch: object}}
   */
  async appendBatch(commandId, events, { expectedLastSequence, intentHash } = {}) {
    validateCommandId(commandId);
    validateExpectedLastSequence(expectedLastSequence);
    validateIntentHash(intentHash);
    await this.#assertInitialized();

    const lock = await this.#acquireLock();
    let result;
    let operationError;

    try {
      const state = await this.#readVerifiedState({ lockOwned: true });
      const existing = state.batches.find((batch) => batch.commandId === commandId);

      if (existing) {
        if (existing.intentHash !== intentHash) {
          throw new FileEventStoreError(
            `Command ${JSON.stringify(commandId)} was already recorded with a different intentHash.`,
            'idempotency-conflict',
            {
              details: {
                commandId,
                recordedIntentHash: existing.intentHash,
                requestedIntentHash: intentHash
              }
            }
          );
        }
        result = { appended: false, batch: existing };
      } else {
        if (state.lastSequence !== expectedLastSequence) {
          throw new FileEventStoreError(
            `Expected last sequence ${expectedLastSequence}, but the store is at ${state.lastSequence}.`,
            'concurrency-conflict',
            {
              details: {
                expectedLastSequence,
                actualLastSequence: state.lastSequence
              }
            }
          );
        }

        const eventSnapshot = snapshotAndValidateEvents(events, state.lastSequence);
        const batchSequence = state.batches.length + 1;
        const payloadHash = hashCanonicalValue(eventSnapshot);
        const batchWithoutHash = {
          schemaVersion: FILE_EVENT_STORE_SCHEMA_VERSION,
          batchSequence,
          commandId,
          intentHash,
          firstSequence: eventSnapshot[0].sequence,
          lastSequence: eventSnapshot.at(-1).sequence,
          eventCount: eventSnapshot.length,
          previousHash: state.lastBatchHash,
          payloadHash,
          events: eventSnapshot
        };
        const batch = {
          ...batchWithoutHash,
          hash: hashCanonicalValue(batchWithoutHash)
        };

        await this.#writeBatch(batch);
        result = { appended: true, batch };
      }
    } catch (error) {
      operationError = error;
    }

    try {
      await this.#releaseLock(lock);
    } catch (error) {
      if (!operationError) {
        operationError = error instanceof FileEventStoreError
          ? error
          : new FileEventStoreError(
            `Failed to release event-store lock ${this.lockPath}.`,
            'lock-release-failed',
            { cause: error }
          );
        operationError.details = {
          ...(operationError.details ?? {}),
          operationCompleted: result !== undefined
        };
        if (result !== undefined) {
          Object.defineProperty(operationError, 'recoveryResult', {
            value: result,
            enumerable: false
          });
        }
      } else {
        operationError.details = {
          ...(operationError.details ?? {}),
          lockReleaseFailed: true
        };
        Object.defineProperty(operationError, 'lockReleaseError', {
          value: error,
          enumerable: false
        });
      }
      Object.defineProperty(operationError, 'recoveryLockId', {
        value: lock.lockId,
        enumerable: false,
        configurable: false,
        writable: false
      });
    }

    if (operationError) throw operationError;
    return result;
  }

  /**
   * Finish releasing a lock that this process demonstrably published. This is
   * intentionally capability-narrow: a caller must present the exact lock id,
   * and locks owned by another PID are never removed here.
   */
  async releaseOwnedLock({ expectedLockId } = {}) {
    if (typeof expectedLockId !== 'string' || !LOCK_ID_PATTERN.test(expectedLockId)) {
      throw new FileEventStoreError(
        'expectedLockId must be a UUID.',
        'invalid-lock-id'
      );
    }
    await this.#assertInitialized();
    const current = await readLock(this.lockPath);
    if (current.lockId !== expectedLockId || current.pid !== process.pid) {
      throw new FileEventStoreError(
        'The event-store lock is not owned by this process and lock id.',
        'lock-release-conflict',
        {
          details: {
            expectedLockId,
            actualLockId: current.lockId,
            ownerPid: current.pid
          }
        }
      );
    }
    await this.#releaseLock(current);
    return { released: true, lockId: current.lockId };
  }

  async #acquireRecoveryClaim(lockId) {
    const claimPath = path.join(this.recoveryDirectory, `.claim-${lockId}`);
    for (let recoveryAttempt = 0; recoveryAttempt < 2; recoveryAttempt += 1) {
      const claim = {
        schemaVersion: RECOVERY_CLAIM_SCHEMA_VERSION,
        claimId: randomUUID(),
        lockId,
        pid: process.pid,
        acquiredAt: this.#now().toISOString()
      };
      const tempPath = path.join(
        this.recoveryDirectory,
        `.claim-${lockId}.${claim.claimId}.tmp`
      );
      let temporaryFile;
      let published = false;
      let publicationConflict = false;
      try {
        temporaryFile = await open(tempPath, 'wx', 0o600);
        await temporaryFile.writeFile(`${JSON.stringify(claim)}\n`, 'utf8');
        await temporaryFile.sync();
        await temporaryFile.close();
        temporaryFile = undefined;
        try {
          await link(tempPath, claimPath);
          published = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          publicationConflict = true;
          throw error;
        }
        await unlinkWithRetry(tempPath);
        await syncDirectoryWhenSupported(this.recoveryDirectory);
        return { ...claim, path: claimPath };
      } catch (error) {
        if (temporaryFile) await temporaryFile.close().catch(() => {});
        let cleanupError = null;
        try {
          await unlinkWithRetry(tempPath, { allowMissing: true });
        } catch (candidate) {
          cleanupError = candidate;
        }
        if (published) {
          try {
            const current = await readRecoveryClaim(claimPath, { allowMissing: true });
            if (current?.claimId === claim.claimId && current.lockId === lockId) {
              await unlinkWithRetry(claimPath);
            }
          } catch (candidate) {
            cleanupError ??= candidate;
          }
        }
        if (!publicationConflict) {
          throw new FileEventStoreError(
            'Failed to publish the event-lock recovery claim.',
            'lock-recovery-failed',
            {
              cause: error,
              details: {
                lockId,
                published,
                cleanupFailed: cleanupError !== null
              }
            }
          );
        }

        const existing = await readRecoveryClaim(claimPath);
        let ownerAlive = null;
        if (existing.pid === process.pid) {
          ownerAlive = true;
        } else {
          try {
            const probed = await this.pidProbe(existing.pid);
            if (typeof probed !== 'boolean') throw new TypeError('pidProbe must return boolean.');
            ownerAlive = probed;
          } catch {
            ownerAlive = null;
          }
        }
        if (ownerAlive !== false || recoveryAttempt > 0) {
          throw new FileEventStoreError(
            'Another process owns the event-lock recovery claim.',
            'lock-recovery-conflict',
            { details: { lockId, ownerAlive, claimId: existing.claimId } }
          );
        }

        try {
          await this.#recoverAbandonedRecoveryClaim(existing, claimPath);
        } catch (claimError) {
          throw claimError instanceof FileEventStoreError
            ? claimError
            : new FileEventStoreError(
              'Failed to recover an abandoned recovery claim.',
              'lock-recovery-conflict',
              { cause: claimError, details: { lockId, claimId: existing.claimId } }
            );
        }
      }
    }
    throw new FileEventStoreError(
      'Failed to acquire the event-lock recovery claim.',
      'lock-recovery-conflict'
    );
  }

  async #recoverAbandonedRecoveryClaim(existing, claimPath) {
    const takeover = await this.#acquireStaleClaimTakeover(existing);
    const staleClaimGuard = path.join(
      this.recoveryDirectory,
      `.stale-claim-${existing.claimId}`
    );
    try {
      try {
        await link(claimPath, staleClaimGuard);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      const [guarded, current, sameIdentity] = await Promise.all([
        readRecoveryClaim(staleClaimGuard),
        readRecoveryClaim(claimPath),
        areHardLinks(claimPath, staleClaimGuard)
      ]);
      if (guarded.claimId !== existing.claimId
        || guarded.lockId !== existing.lockId
        || current.claimId !== existing.claimId
        || current.lockId !== existing.lockId
        || !sameIdentity) {
        throw new FileEventStoreError(
          'The recovery claim changed during stale-claim recovery.',
          'lock-recovery-conflict'
        );
      }

      // All contenders for this abandoned claim must own the takeover record
      // before reaching this unlink. Once the old canonical name is removed,
      // this method never touches it again, so a new claimant cannot be deleted.
      await unlinkWithRetry(claimPath);
      const archivePath = path.join(
        this.recoveryDirectory,
        `${this.#now().toISOString().replaceAll(':', '-')}--${existing.claimId}--${takeover.takeoverId}--stale-claim.json`
      );
      await rename(staleClaimGuard, archivePath);
      await syncDirectoryWhenSupported(this.recoveryDirectory);
    } finally {
      await this.#releaseStaleClaimTakeover(takeover);
    }
  }

  async #acquireStaleClaimTakeover(existing) {
    const takeover = {
      schemaVersion: STALE_CLAIM_TAKEOVER_SCHEMA_VERSION,
      takeoverId: randomUUID(),
      claimId: existing.claimId,
      lockId: existing.lockId,
      pid: process.pid,
      acquiredAt: this.#now().toISOString()
    };
    const takeoverPath = path.join(
      this.recoveryDirectory,
      `.stale-claim-${existing.claimId}.takeover`
    );
    const tempPath = `${takeoverPath}.${takeover.takeoverId}.tmp`;
    let temporaryFile;
    let published = false;
    try {
      temporaryFile = await open(tempPath, 'wx', 0o600);
      await temporaryFile.writeFile(`${JSON.stringify(takeover)}\n`, 'utf8');
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;
      await link(tempPath, takeoverPath);
      published = true;
      await unlinkWithRetry(tempPath);
      await syncDirectoryWhenSupported(this.recoveryDirectory);
      return { ...takeover, path: takeoverPath };
    } catch (error) {
      if (temporaryFile) await temporaryFile.close().catch(() => {});
      await unlinkWithRetry(tempPath, { allowMissing: true }).catch(() => {});
      if (published) {
        const current = await readStaleClaimTakeover(takeoverPath, { allowMissing: true })
          .catch(() => null);
        if (current && sameStaleClaimTakeover(current, takeover)) {
          await unlinkWithRetry(takeoverPath, { allowMissing: true }).catch(() => {});
        }
      }
      if (error.code === 'EEXIST') {
        const current = await readStaleClaimTakeover(takeoverPath);
        let ownerAlive = null;
        if (current.pid === process.pid) {
          ownerAlive = true;
        } else {
          try {
            const probed = await this.pidProbe(current.pid);
            if (typeof probed !== 'boolean') throw new TypeError('pidProbe must return boolean.');
            ownerAlive = probed;
          } catch {
            ownerAlive = null;
          }
        }
        throw new FileEventStoreError(
          'Another process owns stale recovery-claim takeover.',
          'lock-recovery-conflict',
          {
            details: {
              claimId: existing.claimId,
              takeoverId: current.takeoverId,
              ownerAlive
            }
          }
        );
      }
      throw new FileEventStoreError(
        'Failed to publish stale recovery-claim takeover.',
        'lock-recovery-failed',
        { cause: error, details: { claimId: existing.claimId, published } }
      );
    }
  }

  async #releaseStaleClaimTakeover(expected) {
    const current = await readStaleClaimTakeover(expected.path, { allowMissing: true });
    if (!current) return;
    if (!sameStaleClaimTakeover(current, expected)) {
      throw new FileEventStoreError(
        'Stale recovery-claim takeover changed before release.',
        'lock-recovery-conflict'
      );
    }
    await unlinkWithRetry(expected.path);
  }

  async #releaseRecoveryClaim(claim) {
    const current = await readRecoveryClaim(claim.path, { allowMissing: true });
    if (!current) return;
    if (current.claimId !== claim.claimId || current.lockId !== claim.lockId) {
      throw new FileEventStoreError(
        'The event-lock recovery claim changed before release.',
        'lock-recovery-conflict'
      );
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await unlink(claim.path);
        return;
      } catch (error) {
        const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
        if (!retryable || attempt >= LOCK_RELEASE_RETRY_DELAYS.length) {
          throw new FileEventStoreError(
            'Failed to release the event-lock recovery claim.',
            'lock-recovery-failed',
            { cause: error, details: { claimId: claim.claimId } }
          );
        }
        await new Promise((resolve) => setTimeout(
          resolve,
          LOCK_RELEASE_RETRY_DELAYS[attempt]
        ));
      }
    }
  }

  async #assertInitialized() {
    await assertRealDirectory(this.projectRoot, 'project root');
    await assertRealDirectory(this.stateDirectory, 'FWA state directory', 'event-store-not-initialized');
    await assertRealDirectory(this.eventsDirectory, 'event directory', 'event-store-not-initialized');
    await assertRealDirectory(
      this.recoveryDirectory,
      'event recovery directory',
      'event-store-not-initialized'
    );
  }

  async #acquireLock() {
    const lockId = this.idFactory();
    if (typeof lockId !== 'string' || !LOCK_ID_PATTERN.test(lockId)) {
      throw new FileEventStoreError(
        'Event-store lock idFactory must return a UUID.',
        'invalid-lock-id'
      );
    }
    const lockRecord = {
      schemaVersion: LOCK_SCHEMA_VERSION,
      lockId,
      pid: process.pid,
      acquiredAt: this.#now().toISOString()
    };
    const tempPath = path.join(this.eventsDirectory, `.lock.${lockId}.tmp`);
    let temporaryFile;
    let published = false;
    try {
      temporaryFile = await open(tempPath, 'wx', 0o600);
      await temporaryFile.writeFile(`${JSON.stringify(lockRecord)}\n`, 'utf8');
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;
      try {
        await link(tempPath, this.lockPath);
        published = true;
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new FileEventStoreError(
            `Event store is locked: ${this.lockPath}`,
            'event-store-locked',
            { cause: error }
          );
        }
        throw error;
      }
      await unlinkWithRetry(tempPath);
      try {
        await syncDirectoryWhenSupported(this.eventsDirectory);
      } catch (error) {
        const current = await readLock(this.lockPath, { allowMissing: true });
        if (current?.lockId === lockId) await unlinkWithRetry(this.lockPath);
        published = false;
        throw error;
      }
      return lockRecord;
    } catch (error) {
      if (temporaryFile) await temporaryFile.close().catch(() => {});
      let cleanupError = null;
      try {
        await unlinkWithRetry(tempPath, { allowMissing: true });
      } catch (candidate) {
        cleanupError = candidate;
      }
      if (published) {
        try {
          const current = await readLock(this.lockPath, { allowMissing: true });
          if (current?.lockId === lockId) await unlinkWithRetry(this.lockPath);
        } catch (candidate) {
          cleanupError ??= candidate;
        }
      }
      if (error instanceof FileEventStoreError) throw error;
      const lockStillExists = await pathExists(this.lockPath).catch(() => false);
      if (lockStillExists && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        throw new FileEventStoreError(
          `Event store is locked: ${this.lockPath}`,
          'event-store-locked',
          { cause: error }
        );
      }
      throw new FileEventStoreError(
        `Failed to acquire event-store lock ${this.lockPath}.`,
        'lock-acquire-failed',
        {
          cause: error,
          details: {
            lockId,
            published,
            cleanupFailed: cleanupError !== null
          }
        }
      );
    }
  }

  async #releaseLock(lock) {
    const currentLock = await readLock(this.lockPath);
    if (currentLock.lockId !== lock.lockId) {
      throw new FileEventStoreError(
        'The event-store lock changed before release.',
        'lock-release-conflict',
        { details: { expectedLockId: lock.lockId, actualLockId: currentLock.lockId } }
      );
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await unlink(this.lockPath);
        return;
      } catch (error) {
        const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
        if (!retryable || attempt >= LOCK_RELEASE_RETRY_DELAYS.length) {
          throw new FileEventStoreError(
            `Failed to release event-store lock ${this.lockPath}.`,
            'lock-release-failed',
            { cause: error, details: { lockId: lock.lockId } }
          );
        }
        await new Promise((resolve) => setTimeout(
          resolve,
          LOCK_RELEASE_RETRY_DELAYS[attempt]
        ));
        const observed = await readLock(this.lockPath);
        if (observed.lockId !== lock.lockId) {
          throw new FileEventStoreError(
            'The event-store lock changed during release retry.',
            'lock-release-conflict'
          );
        }
      }
    }
  }

  async #readVerifiedState({ lockOwned = false } = {}) {
    let entries;
    try {
      entries = await readdir(this.eventsDirectory, { withFileTypes: true });
    } catch (error) {
      throw new FileEventStoreError(
        `Failed to list event directory ${this.eventsDirectory}.`,
        'event-store-read-failed',
        { cause: error }
      );
    }

    const lockPresent = entries.some((entry) => entry.name === LOCK_FILE_NAME);
    const temporaryEntries = entries.filter((entry) => (
      entry.name.endsWith('.tmp') && !LOCK_TEMP_FILE_PATTERN.test(entry.name)
    ));
    const lockTemporaryEntries = entries.filter((entry) => (
      LOCK_TEMP_FILE_PATTERN.test(entry.name)
    ));
    if (lockPresent && !lockOwned) {
      throw new FileEventStoreError(
        `An event transaction owns ${this.lockPath}.`,
        'event-store-locked'
      );
    }
    if (temporaryEntries.length > 0) {
      const names = temporaryEntries.map((entry) => entry.name).sort();
      throw new FileEventStoreError(
        `Orphaned event transaction file(s): ${names.join(', ')}.`,
        'orphan-temporary-batch',
        { details: { files: names } }
      );
    }
    if (!lockPresent && lockTemporaryEntries.length > 0) {
      const names = lockTemporaryEntries.map((entry) => entry.name).sort();
      throw new FileEventStoreError(
        `Orphaned event-lock publication file(s): ${names.join(', ')}.`,
        'orphan-temporary-lock',
        { details: { files: names } }
      );
    }

    const batchFiles = [];
    for (const entry of entries) {
      if (entry.name === LOCK_FILE_NAME
        || entry.name === LOCK_RECOVERY_DIRECTORY
        || LOCK_TEMP_FILE_PATTERN.test(entry.name)) continue;
      const match = BATCH_FILE_PATTERN.exec(entry.name);
      if (!entry.isFile() || !match) {
        throw new FileEventStoreError(
          `Unexpected entry in event directory: ${entry.name}`,
          'event-store-corruption',
          { details: { entry: entry.name } }
        );
      }
      batchFiles.push({ name: entry.name, batchSequence: Number(match[1]) });
    }
    batchFiles.sort((left, right) => left.name.localeCompare(right.name));

    const batches = [];
    const events = [];
    const commandIds = new Set();
    let expectedBatchSequence = 1;
    let expectedEventSequence = 1;
    let previousHash = GENESIS_HASH;

    for (let offset = 0; offset < batchFiles.length; offset += BATCH_READ_CONCURRENCY) {
      const window = batchFiles.slice(offset, offset + BATCH_READ_CONCURRENCY);
      // Bound disk reads, but consume every result in journal order. A later
      // read/JSON failure must never mask an earlier sequence or hash failure.
      const reads = await Promise.allSettled(window.map(file =>
        readBatch(path.join(this.eventsDirectory, file.name))));
      for (let index = 0; index < window.length; index += 1) {
        const file = window[index];
        if (file.batchSequence !== expectedBatchSequence) {
          throw new FileEventStoreError(
            `Event batch sequence gap: expected ${expectedBatchSequence}, found ${file.batchSequence}.`,
            'batch-sequence-gap',
            { details: { expected: expectedBatchSequence, actual: file.batchSequence } }
          );
        }

        if (reads[index].status === 'rejected') throw reads[index].reason;
        const batch = reads[index].value;
        validatePersistedBatch({
          batch,
          fileName: file.name,
          expectedBatchSequence,
          expectedEventSequence,
          previousHash,
          commandIds
        });

        batches.push(batch);
        events.push(...batch.events);
        commandIds.add(batch.commandId);
        expectedBatchSequence += 1;
        expectedEventSequence = batch.lastSequence + 1;
        previousHash = batch.hash;
      }
    }

    return {
      batches,
      events,
      lastSequence: expectedEventSequence - 1,
      lastBatchHash: previousHash
    };
  }

  async #writeBatch(batch) {
    const finalName = batchFileName(batch.batchSequence);
    const finalPath = path.join(this.eventsDirectory, finalName);
    const tempName = `.${finalName}.${randomUUID()}.tmp`;
    const tempPath = path.join(this.eventsDirectory, tempName);
    let temporaryFile;

    try {
      temporaryFile = await open(tempPath, 'wx', 0o600);
      await temporaryFile.writeFile(`${JSON.stringify(batch, null, 2)}\n`, 'utf8');
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;
      await rename(tempPath, finalPath);
    } catch (error) {
      if (temporaryFile) await temporaryFile.close().catch(() => {});
      throw new FileEventStoreError(
        `Atomic event-batch write failed; inspect ${tempPath} before recovery.`,
        'atomic-write-failed',
        { cause: error, details: { tempPath, finalPath } }
      );
    }

    await syncDirectoryWhenSupported(this.eventsDirectory);
  }

  #now() {
    const value = this.clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new FileEventStoreError('clock returned an invalid date.', 'invalid-clock');
    }
    return date;
  }
}

function stableStringify(value) {
  const ancestors = new Set();

  function encode(current, location) {
    if (current === null) return 'null';

    switch (typeof current) {
      case 'string':
      case 'boolean':
        return JSON.stringify(current);
      case 'number':
        if (!Number.isFinite(current)) {
          throw new TypeError(`Non-finite number at ${location} is not valid JSON.`);
        }
        return JSON.stringify(current);
      case 'object': {
        if (ancestors.has(current)) {
          throw new TypeError(`Circular value at ${location} is not valid JSON.`);
        }
        ancestors.add(current);
        try {
          if (Array.isArray(current)) {
            const values = [];
            for (let index = 0; index < current.length; index += 1) {
              if (!Object.hasOwn(current, index)) {
                throw new TypeError(`Sparse array at ${location}[${index}] is not valid event data.`);
              }
              values.push(encode(current[index], `${location}[${index}]`));
            }
            return `[${values.join(',')}]`;
          }

          const prototype = Object.getPrototypeOf(current);
          if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`Non-plain object at ${location} is not valid event data.`);
          }
          if (Object.getOwnPropertySymbols(current).length > 0) {
            throw new TypeError(`Symbol properties at ${location} are not valid event data.`);
          }

          const properties = Object.keys(current)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${encode(current[key], `${location}.${key}`)}`);
          return `{${properties.join(',')}}`;
        } finally {
          ancestors.delete(current);
        }
      }
      default:
        throw new TypeError(`Value of type ${typeof current} at ${location} is not valid JSON.`);
    }
  }

  return encode(value, '$');
}

function snapshotAndValidateEvents(events, lastSequence) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new FileEventStoreError(
      'appendBatch requires at least one event.',
      'invalid-event-batch'
    );
  }

  let snapshot;
  try {
    snapshot = JSON.parse(stableStringify(events));
  } catch (error) {
    throw new FileEventStoreError(
      `Events must contain only plain JSON values: ${error.message}`,
      'invalid-event-batch',
      { cause: error }
    );
  }

  let expected = lastSequence + 1;
  for (const event of snapshot) {
    if (!isPlainRecord(event)) {
      throw new FileEventStoreError(
        `Event at sequence ${expected} must be a JSON object.`,
        'invalid-event-batch'
      );
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== expected) {
      throw new FileEventStoreError(
        `Event sequence gap: expected ${expected}, found ${String(event.sequence)}.`,
        'event-sequence-gap',
        { details: { expected, actual: event.sequence } }
      );
    }
    expected += 1;
  }

  return snapshot;
}

async function readBatch(filePath) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new FileEventStoreError(
      `Failed to read event batch ${filePath}.`,
      'event-store-corruption',
      { cause: error }
    );
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new FileEventStoreError(
      `Event batch is not valid JSON: ${filePath}.`,
      'event-store-corruption',
      { cause: error }
    );
  }
}

function validatePersistedBatch({
  batch,
  fileName,
  expectedBatchSequence,
  expectedEventSequence,
  previousHash,
  commandIds
}) {
  if (!isPlainRecord(batch)) {
    throw corruption(fileName, 'batch root must be an object');
  }
  if (batch.schemaVersion !== FILE_EVENT_STORE_SCHEMA_VERSION) {
    throw new FileEventStoreError(
      `Unsupported event batch schema ${String(batch.schemaVersion)} in ${fileName}.`,
      'unsupported-event-store-schema',
      { details: { fileName, schemaVersion: batch.schemaVersion } }
    );
  }

  const expectedKeys = [
    'batchSequence',
    'commandId',
    'eventCount',
    'events',
    'firstSequence',
    'hash',
    'intentHash',
    'lastSequence',
    'payloadHash',
    'previousHash',
    'schemaVersion'
  ];
  const actualKeys = Object.keys(batch).sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw corruption(fileName, 'batch fields do not match schema version 1');
  }
  if (batch.batchSequence !== expectedBatchSequence) {
    throw corruption(fileName, `batchSequence must be ${expectedBatchSequence}`);
  }
  if (typeof batch.commandId !== 'string' || batch.commandId.trim() === '') {
    throw corruption(fileName, 'commandId must be a non-empty string');
  }
  if (commandIds.has(batch.commandId)) {
    throw corruption(fileName, `commandId ${JSON.stringify(batch.commandId)} is duplicated`);
  }
  if (!HASH_PATTERN.test(batch.intentHash)) {
    throw corruption(fileName, 'intentHash must be a lowercase SHA-256 hash');
  }
  if (!Array.isArray(batch.events) || batch.events.length === 0) {
    throw corruption(fileName, 'events must be a non-empty array');
  }
  if (batch.eventCount !== batch.events.length) {
    throw corruption(fileName, 'eventCount does not match events.length');
  }
  if (batch.firstSequence !== expectedEventSequence) {
    throw new FileEventStoreError(
      `Event sequence gap in ${fileName}: expected ${expectedEventSequence}, found ${String(batch.firstSequence)}.`,
      'event-sequence-gap'
    );
  }

  for (let index = 0; index < batch.events.length; index += 1) {
    const event = batch.events[index];
    const expected = expectedEventSequence + index;
    if (!isPlainRecord(event) || event.sequence !== expected || !Number.isSafeInteger(event.sequence)) {
      throw new FileEventStoreError(
        `Event sequence gap in ${fileName}: expected ${expected}, found ${String(event?.sequence)}.`,
        'event-sequence-gap'
      );
    }
  }

  const expectedLastSequence = expectedEventSequence + batch.events.length - 1;
  if (batch.lastSequence !== expectedLastSequence) {
    throw corruption(fileName, `lastSequence must be ${expectedLastSequence}`);
  }
  if (batch.previousHash !== previousHash) {
    throw new FileEventStoreError(
      `Previous hash mismatch in ${fileName}.`,
      'previous-hash-mismatch',
      { details: { expected: previousHash, actual: batch.previousHash } }
    );
  }

  let actualPayloadHash;
  let actualBatchHash;
  try {
    actualPayloadHash = hashCanonicalValue(batch.events);
    const { hash, ...batchWithoutHash } = batch;
    actualBatchHash = hashCanonicalValue(batchWithoutHash);
  } catch (error) {
    throw new FileEventStoreError(
      `Invalid JSON value in event batch ${fileName}: ${error.message}`,
      'event-store-corruption',
      { cause: error }
    );
  }

  if (!HASH_PATTERN.test(batch.payloadHash) || batch.payloadHash !== actualPayloadHash) {
    throw new FileEventStoreError(
      `Payload hash mismatch in ${fileName}.`,
      'payload-hash-mismatch',
      { details: { expected: actualPayloadHash, actual: batch.payloadHash } }
    );
  }
  if (!HASH_PATTERN.test(batch.hash) || batch.hash !== actualBatchHash) {
    throw new FileEventStoreError(
      `Batch hash mismatch in ${fileName}.`,
      'batch-hash-mismatch',
      { details: { expected: actualBatchHash, actual: batch.hash } }
    );
  }
}

function validateCommandId(commandId) {
  if (typeof commandId !== 'string' || commandId.trim() === '') {
    throw new FileEventStoreError('commandId must be a non-empty string.', 'invalid-command-id');
  }
}

function validateExpectedLastSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FileEventStoreError(
      'expectedLastSequence must be a non-negative safe integer.',
      'invalid-expected-last-sequence'
    );
  }
}

function validateIntentHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new FileEventStoreError(
      'intentHash must be a lowercase SHA-256 hash.',
      'invalid-intent-hash'
    );
  }
}

function corruption(fileName, reason) {
  return new FileEventStoreError(
    `Corrupt event batch ${fileName}: ${reason}.`,
    'event-store-corruption',
    { details: { fileName, reason } }
  );
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function batchFileName(batchSequence) {
  if (!Number.isSafeInteger(batchSequence) || batchSequence < 1 || batchSequence > 9_999_999_999_999_999) {
    throw new FileEventStoreError(
      `Invalid batch sequence ${String(batchSequence)}.`,
      'invalid-batch-sequence'
    );
  }
  return `batch-${String(batchSequence).padStart(16, '0')}.json`;
}

async function readLock(lockPath, { allowMissing = false } = {}) {
  let stats;
  try {
    stats = await lstat(lockPath);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    if (error.code === 'ENOENT') {
      throw new FileEventStoreError('The event-store lock is missing.', 'event-store-lock-missing');
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new FileEventStoreError(
      `Event-store lock must be a real file: ${lockPath}`,
      'unsafe-event-store-lock'
    );
  }
  let source;
  try {
    source = await readFile(lockPath, 'utf8');
  } catch (error) {
    throw new FileEventStoreError(
      `Failed to read event-store lock ${lockPath}.`,
      'lock-read-failed',
      { cause: error }
    );
  }
  let lock;
  try {
    lock = JSON.parse(source);
  } catch (error) {
    throw new FileEventStoreError(
      `Event-store lock is corrupt: ${lockPath}.`,
      'event-store-lock-corruption',
      { cause: error }
    );
  }
  const expected = ['acquiredAt', 'lockId', 'pid', 'schemaVersion'];
  const actual = isPlainRecord(lock) ? Object.keys(lock).sort() : [];
  if (!isPlainRecord(lock)
    || actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
    || lock.schemaVersion !== LOCK_SCHEMA_VERSION
    || !LOCK_ID_PATTERN.test(lock.lockId)
    || !Number.isSafeInteger(lock.pid)
    || lock.pid < 1
    || typeof lock.acquiredAt !== 'string'
    || !Number.isFinite(Date.parse(lock.acquiredAt))
    || new Date(lock.acquiredAt).toISOString() !== lock.acquiredAt) {
    throw new FileEventStoreError(
      `Event-store lock is corrupt: ${lockPath}.`,
      'event-store-lock-corruption'
    );
  }
  return lock;
}

async function readRecoveryClaim(claimPath, { allowMissing = false } = {}) {
  let stats;
  try {
    stats = await lstat(claimPath);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new FileEventStoreError(
      `Recovery claim must be a real file: ${claimPath}`,
      'unsafe-event-store-lock'
    );
  }
  let claim;
  try {
    claim = JSON.parse(await readFile(claimPath, 'utf8'));
  } catch (error) {
    throw new FileEventStoreError(
      `Event-lock recovery claim is corrupt: ${claimPath}.`,
      'lock-recovery-corruption',
      { cause: error }
    );
  }
  const expected = ['acquiredAt', 'claimId', 'lockId', 'pid', 'schemaVersion'];
  const actual = isPlainRecord(claim) ? Object.keys(claim).sort() : [];
  if (!isPlainRecord(claim)
    || actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
    || claim.schemaVersion !== RECOVERY_CLAIM_SCHEMA_VERSION
    || !LOCK_ID_PATTERN.test(claim.claimId)
    || !LOCK_ID_PATTERN.test(claim.lockId)
    || !Number.isSafeInteger(claim.pid)
    || claim.pid < 1
    || typeof claim.acquiredAt !== 'string'
    || !Number.isFinite(Date.parse(claim.acquiredAt))
    || new Date(claim.acquiredAt).toISOString() !== claim.acquiredAt) {
    throw new FileEventStoreError(
      `Event-lock recovery claim is corrupt: ${claimPath}.`,
      'lock-recovery-corruption'
    );
  }
  return claim;
}

async function readStaleClaimTakeover(takeoverPath, { allowMissing = false } = {}) {
  let stats;
  try {
    stats = await lstat(takeoverPath);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new FileEventStoreError(
      `Stale recovery-claim takeover must be a real file: ${takeoverPath}`,
      'unsafe-event-store-lock'
    );
  }
  let takeover;
  try {
    takeover = JSON.parse(await readFile(takeoverPath, 'utf8'));
  } catch (error) {
    throw new FileEventStoreError(
      `Stale recovery-claim takeover is corrupt: ${takeoverPath}.`,
      'lock-recovery-corruption',
      { cause: error }
    );
  }
  const expected = [
    'acquiredAt',
    'claimId',
    'lockId',
    'pid',
    'schemaVersion',
    'takeoverId'
  ];
  const actual = isPlainRecord(takeover) ? Object.keys(takeover).sort() : [];
  if (!isPlainRecord(takeover)
    || actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
    || takeover.schemaVersion !== STALE_CLAIM_TAKEOVER_SCHEMA_VERSION
    || !LOCK_ID_PATTERN.test(takeover.takeoverId)
    || !LOCK_ID_PATTERN.test(takeover.claimId)
    || !LOCK_ID_PATTERN.test(takeover.lockId)
    || !Number.isSafeInteger(takeover.pid)
    || takeover.pid < 1
    || typeof takeover.acquiredAt !== 'string'
    || !Number.isFinite(Date.parse(takeover.acquiredAt))
    || new Date(takeover.acquiredAt).toISOString() !== takeover.acquiredAt) {
    throw new FileEventStoreError(
      `Stale recovery-claim takeover is corrupt: ${takeoverPath}.`,
      'lock-recovery-corruption'
    );
  }
  return takeover;
}

function sameStaleClaimTakeover(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.takeoverId === right.takeoverId
    && left.claimId === right.claimId
    && left.lockId === right.lockId
    && left.pid === right.pid
    && left.acquiredAt === right.acquiredAt;
}

async function areHardLinks(leftPath, rightPath) {
  const [left, right] = await Promise.all([
    lstat(leftPath, { bigint: true }),
    lstat(rightPath, { bigint: true })
  ]);
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino;
}

async function defaultPidProbe(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM' || error.code === 'EACCES') return true;
    throw error;
  }
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

async function unlinkWithRetry(targetPath, { allowMissing = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(targetPath);
      return;
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (!retryable || attempt >= LOCK_RELEASE_RETRY_DELAYS.length) throw error;
      await new Promise((resolve) => setTimeout(
        resolve,
        LOCK_RELEASE_RETRY_DELAYS[attempt]
      ));
    }
  }
}

async function assertRealDirectory(targetPath, label, missingCode = 'invalid-project-root') {
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new FileEventStoreError(`${label} does not exist: ${targetPath}`, missingCode, { cause: error });
    }
    throw error;
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new FileEventStoreError(
      `${label} must be a real directory: ${targetPath}`,
      'unsafe-event-store-path'
    );
  }
}

async function ensureRealDirectory(targetPath, mode, label) {
  try {
    await mkdir(targetPath, { mode });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await assertRealDirectory(targetPath, label, 'event-store-not-initialized');
}

async function syncDirectoryWhenSupported(directoryPath) {
  let directory;
  try {
    directory = await open(directoryPath, 'r');
    await directory.sync();
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      throw new FileEventStoreError(
        `Event batch was renamed, but directory fsync failed for ${directoryPath}.`,
        'directory-sync-failed',
        { cause: error }
      );
    }
  } finally {
    if (directory) await directory.close().catch(() => {});
  }
}
