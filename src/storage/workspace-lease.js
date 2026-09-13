import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
import { setTimeout as delay } from 'node:timers/promises';

export const WORKSPACE_LEASE_SCHEMA_VERSION = 2;

const LEGACY_WORKSPACE_LEASE_SCHEMA_VERSION = 1;
const WORKSPACE_OWNER_KINDS = Object.freeze([
  'run',
  'run-batch',
  'evaluation',
  'integration',
  'reversion'
]);

const LEASE_FILE_NAME = 'workspace-lease.json';
const ARCHIVE_DIRECTORY_NAME = 'lease-archive';
const OPERATION_LOCK_NAME = '.workspace-lease.guard';
const GUARD_SCHEMA_VERSION = 1;
const GUARD_TAKEOVER_SCHEMA_VERSION = 1;
const TEMP_FILE_PATTERN = /^\.workspace-lease\..+\.tmp$/;
const GUARD_TEMP_FILE_PATTERN = /^\.workspace-lease\.guard\..+\.tmp$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceLeaseError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'WorkspaceLeaseError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * A fail-closed exclusive operation lease for one FWA project workspace.
 * A run-batch coordinator owns one lease throughout all of its isolated Runs.
 *
 * Mutations are serialized by a short-lived guard file. The canonical guard is
 * published only after a complete temporary record is fsynced, and a guard is
 * recovered only when its recorded PID is confirmed dead. Ambiguity is always
 * fail-closed and recovery evidence is archived.
 */
export class WorkspaceLease {
  constructor(projectRoot, {
    clock = () => new Date(),
    pidProbe = defaultPidProbe,
    idFactory = randomUUID,
    tokenFactory = () => randomBytes(32).toString('hex'),
    defaultTtlMs = 30_000
  } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      throw new WorkspaceLeaseError(
        'projectRoot must be a non-empty string.',
        'invalid-project-root'
      );
    }
    if (typeof clock !== 'function' || typeof pidProbe !== 'function'
      || typeof idFactory !== 'function' || typeof tokenFactory !== 'function') {
      throw new WorkspaceLeaseError(
        'clock, pidProbe, idFactory, and tokenFactory must be functions.',
        'invalid-lease-options'
      );
    }
    validateTtl(defaultTtlMs);

    this.projectRoot = path.resolve(projectRoot);
    this.stateDirectory = path.join(this.projectRoot, '.fwa');
    this.leasePath = path.join(this.stateDirectory, LEASE_FILE_NAME);
    this.archiveDirectory = path.join(this.stateDirectory, ARCHIVE_DIRECTORY_NAME);
    this.operationLockPath = path.join(this.stateDirectory, OPERATION_LOCK_NAME);
    this.clock = clock;
    this.pidProbe = pidProbe;
    this.idFactory = idFactory;
    this.tokenFactory = tokenFactory;
    this.defaultTtlMs = defaultTtlMs;
  }

  async init() {
    await assertRealDirectory(this.projectRoot, 'project root');
    const stateCreated = !(await pathExists(this.stateDirectory));
    await ensureRealDirectory(this.stateDirectory, 0o700, 'FWA state directory');
    const archiveCreated = !(await pathExists(this.archiveDirectory));
    await ensureRealDirectory(this.archiveDirectory, 0o700, 'lease archive directory');
    await this.#assertNoOrphanTemps();

    const inspection = await this.inspect();
    return {
      created: stateCreated || archiveCreated,
      ...inspection
    };
  }

  /**
   * Inspect the current lease. Without a fencing token checked by every
   * workspace mutation, expiry alone cannot prove that an executor stopped.
   * A live or indeterminate owner therefore remains fail-closed after expiry.
   */
  async inspect() {
    await this.#assertInitialized();
    return this.#withGuard(async () => {
      await this.#assertNoOrphanTemps();
      const lease = await this.#readLease({ allowMissing: true });
      return this.#classify(lease);
    });
  }

  async acquire({
    runId,
    ownerKind,
    ownerId,
    pid = process.pid,
    ttlMs = this.defaultTtlMs
  } = {}) {
    const owner = normalizeAcquireOwner({ runId, ownerKind, ownerId });
    validatePid(pid);
    validateTtl(ttlMs);
    await this.#assertInitialized();

    return this.#withGuard(async () => {
      await this.#assertNoOrphanTemps();
      const current = await this.#readLease({ allowMissing: true });
      if (current) {
        const inspection = await this.#classify(current);
        const currentOwner = persistedLeaseOwner(current);
        throw new WorkspaceLeaseError(
          `Workspace lease is already held by ${currentOwner.ownerKind} ${
            JSON.stringify(currentOwner.ownerId)
          }.`,
          'workspace-lease-held',
          { details: inspection }
        );
      }

      const now = this.#now();
      const ownerToken = this.tokenFactory();
      validateOwnerToken(ownerToken);
      const lease = {
        schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
        leaseId: this.idFactory(),
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        ...(owner.ownerKind === 'run' ? { runId: owner.ownerId } : {}),
        pid,
        acquiredAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        ownerTokenHash: hashToken(ownerToken)
      };
      validatePersistedLease(lease, this.leasePath);

      let file;
      try {
        file = await open(this.leasePath, 'wx', 0o600);
        await file.writeFile(`${JSON.stringify(lease, null, 2)}\n`, 'utf8');
        await file.sync();
        await file.close();
        file = undefined;
        await syncDirectoryWhenSupported(this.stateDirectory);
      } catch (error) {
        if (file) await file.close().catch(() => {});
        if (error.code === 'EEXIST') {
          throw new WorkspaceLeaseError(
            'Another executor acquired the workspace lease.',
            'workspace-lease-held',
            { cause: error }
          );
        }
        throw new WorkspaceLeaseError(
          `Failed to create workspace lease ${this.leasePath}.`,
          'lease-write-failed',
          { cause: error }
        );
      }

      return {
        acquired: true,
        lease: publicLease(lease),
        ownerToken
      };
    });
  }

  async heartbeat({ leaseId, ownerToken, ttlMs = this.defaultTtlMs } = {}) {
    validateLeaseId(leaseId);
    validateOwnerToken(ownerToken);
    validateTtl(ttlMs);
    await this.#assertInitialized();

    return this.#withGuard(async () => {
      await this.#assertNoOrphanTemps();
      const current = await this.#readOwnedLease(leaseId, ownerToken);
      const now = this.#now();
      if (now.getTime() < Date.parse(current.heartbeatAt)) {
        throw new WorkspaceLeaseError(
          'Clock moved backwards before the recorded heartbeat.',
          'lease-clock-regression',
          { details: { heartbeatAt: current.heartbeatAt, now: now.toISOString() } }
        );
      }

      const updated = {
        ...leaseForCurrentSchema(current),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString()
      };
      await this.#atomicRewrite(updated);
      return { renewed: true, lease: publicLease(updated) };
    });
  }

  async release({ leaseId, ownerToken } = {}) {
    validateLeaseId(leaseId);
    validateOwnerToken(ownerToken);
    await this.#assertInitialized();

    return this.#withGuard(async () => {
      await this.#assertNoOrphanTemps();
      const current = await this.#readOwnedLease(leaseId, ownerToken);
      const archivePath = await this.#archive(current, 'released');
      return {
        released: true,
        lease: publicLease(current),
        archivePath
      };
    });
  }

  /**
   * Archive only after a fresh, serialized check establishes that the owner
   * PID is dead. Expiry is reported as evidence but is not sufficient for
   * takeover until all mutations enforce fencing tokens.
   */
  async archiveStale({ expectedLeaseId } = {}) {
    if (expectedLeaseId !== undefined) validateLeaseId(expectedLeaseId);
    await this.#assertInitialized();

    return this.#withGuard(async () => {
      await this.#assertNoOrphanTemps();
      const current = await this.#readLease({ allowMissing: true });
      if (!current) return { archived: false, reason: 'workspace-free' };
      if (expectedLeaseId !== undefined && current.leaseId !== expectedLeaseId) {
        throw new WorkspaceLeaseError(
          'The current lease differs from the lease selected for recovery.',
          'lease-recovery-conflict',
          { details: { expectedLeaseId, actualLeaseId: current.leaseId } }
        );
      }

      const inspection = await this.#classify(current);
      if (!inspection.stale) {
        throw new WorkspaceLeaseError(
          `Workspace lease ${current.leaseId} is not safely stale.`,
          'workspace-lease-not-stale',
          { details: inspection }
        );
      }

      const archivePath = await this.#archive(current, `stale-${inspection.reason}`);
      return {
        archived: true,
        lease: publicLease(current),
        reason: inspection.reason,
        archivePath
      };
    });
  }

  async #assertInitialized() {
    await assertRealDirectory(this.projectRoot, 'project root');
    await assertRealDirectory(
      this.stateDirectory,
      'FWA state directory',
      'workspace-lease-not-initialized'
    );
    await assertRealDirectory(
      this.archiveDirectory,
      'lease archive directory',
      'workspace-lease-not-initialized'
    );
  }

  async #withGuard(action) {
    let guardRecord;
    let operationError;
    let result;

    try {
      guardRecord = await this.#acquireGuard();
    } catch (error) {
      throw error;
    }

    try {
      result = await action();
    } catch (error) {
      operationError = error;
    }

    const guardReleaseError = await this.#releaseGuard(guardRecord);
    if (guardReleaseError) {
      if (operationError) {
        operationError.guardReleaseError = guardReleaseError;
      } else {
        operationError = new WorkspaceLeaseError(
          `The lease operation completed, but its guard could not be released: ${this.operationLockPath}.`,
          'lease-guard-release-failed',
          {
            cause: guardReleaseError,
            details: { operationCompleted: true }
          }
        );
        // Capabilities such as ownerToken must remain recoverable by the direct
        // caller without becoming enumerable log/event data.
        Object.defineProperty(operationError, 'recoveryResult', {
          value: result,
          enumerable: false,
          configurable: false,
          writable: false
        });
      }
      Object.defineProperty(operationError, 'recoveryGuardId', {
        value: guardRecord.guardId,
        enumerable: false,
        configurable: false,
        writable: false
      });
    }

    if (operationError) throw operationError;
    return result;
  }

  /**
   * Finish releasing a guard left by a completed/failed operation in this
   * process. It cannot take over a live guard owned by another process.
   */
  async releaseOwnedGuard({ expectedGuardId } = {}) {
    if (typeof expectedGuardId !== 'string' || !UUID_PATTERN.test(expectedGuardId)) {
      throw new WorkspaceLeaseError(
        'expectedGuardId must be a UUID.',
        'invalid-workspace-guard-id'
      );
    }
    await this.#assertInitialized();
    const current = await this.#readGuard();
    if (current.guardId !== expectedGuardId || current.pid !== process.pid) {
      throw new WorkspaceLeaseError(
        'The workspace guard is not owned by this process and guard id.',
        'lease-guard-ownership-lost',
        {
          details: {
            expectedGuardId,
            actualGuardId: current.guardId,
            ownerPid: current.pid
          }
        }
      );
    }
    const releaseError = await this.#releaseGuard(current);
    if (releaseError) {
      throw new WorkspaceLeaseError(
        `Failed to release owned workspace guard ${expectedGuardId}.`,
        'lease-guard-release-failed',
        { cause: releaseError, details: { expectedGuardId } }
      );
    }
    return { released: true, guardId: expectedGuardId };
  }

  async #acquireGuard() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = {
        schemaVersion: GUARD_SCHEMA_VERSION,
        guardId: randomUUID(),
        pid: process.pid,
        acquiredAt: this.#now().toISOString()
      };
      const tempPath = path.join(
        this.stateDirectory,
        `.workspace-lease.guard.${record.guardId}.tmp`
      );
      let temporaryFile;
      let published = false;
      try {
        temporaryFile = await open(tempPath, 'wx', 0o600);
        await temporaryFile.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await temporaryFile.sync();
        await temporaryFile.close();
        temporaryFile = undefined;

        try {
          await link(tempPath, this.operationLockPath);
          published = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        await unlinkWithRetry(tempPath);

        if (published) {
          await syncDirectoryWhenSupported(this.stateDirectory);
          return record;
        }
      } catch (error) {
        if (temporaryFile) await temporaryFile.close().catch(() => {});
        if (published) {
          const current = await this.#readGuard().catch(() => null);
          if (current && sameGuard(record, current)) {
            await unlink(this.operationLockPath).catch(() => {});
          }
        }
        throw new WorkspaceLeaseError(
          `Failed to atomically publish workspace lease guard ${this.operationLockPath}.`,
          'lease-guard-failed',
          { cause: error }
        );
      }

      if (attempt === 0 && await this.#archiveDeadGuard()) continue;
      throw new WorkspaceLeaseError(
        'A workspace lease operation is already in progress.',
        'workspace-lease-busy'
      );
    }
    throw new WorkspaceLeaseError(
      'Workspace lease guard could not be acquired after stale recovery.',
      'workspace-lease-busy'
    );
  }

  async #archiveDeadGuard() {
    const expected = await this.#readGuard();
    let ownerAlive;
    try {
      ownerAlive = await this.pidProbe(expected.pid);
      if (typeof ownerAlive !== 'boolean') ownerAlive = null;
    } catch {
      ownerAlive = null;
    }
    if (ownerAlive !== false) return false;

    const archivePath = path.join(
      this.archiveDirectory,
      `${expected.acquiredAt.replaceAll(':', '-')}--guard-${expected.guardId}--owner-dead.json`
    );
    const takeover = await this.#acquireGuardTakeover(expected);
    let archivePublished = false;
    let canonicalRemoved = false;
    try {
      try {
        await link(this.operationLockPath, archivePath);
        archivePublished = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      const [archived, current, sameIdentity] = await Promise.all([
        readGuardFile(archivePath),
        this.#readGuard(),
        areHardLinks(this.operationLockPath, archivePath)
      ]);
      if (!sameGuard(expected, archived)
        || !sameGuard(expected, current)
        || !sameIdentity) {
        throw new WorkspaceLeaseError(
          'Workspace guard changed while stale recovery was being claimed.',
          'lease-guard-recovery-conflict'
        );
      }

      // The takeover record serializes all stale-guard recoverers. After this
      // unlink the old canonical path is never touched again, so a replacement
      // live guard created by a later operation cannot be removed here.
      await unlinkWithRetry(this.operationLockPath);
      canonicalRemoved = true;
      await syncDirectoryWhenSupported(this.archiveDirectory);
      await syncDirectoryWhenSupported(this.stateDirectory);
    } catch (error) {
      if (archivePublished && !canonicalRemoved) {
        await unlinkWithRetryAllowMissing(archivePath).catch(() => {});
      }
      if (error instanceof WorkspaceLeaseError) throw error;
      throw new WorkspaceLeaseError(
        `Failed to finish stale guard recovery for ${expected.guardId}.`,
        'lease-guard-recovery-failed',
        { cause: error, details: { archivePath } }
      );
    } finally {
      await this.#releaseGuardTakeover(takeover);
    }
    return true;
  }

  async #acquireGuardTakeover(expected) {
    const takeover = {
      schemaVersion: GUARD_TAKEOVER_SCHEMA_VERSION,
      takeoverId: randomUUID(),
      guardId: expected.guardId,
      pid: process.pid,
      acquiredAt: this.#now().toISOString()
    };
    const takeoverPath = path.join(
      this.archiveDirectory,
      `.guard-${expected.guardId}.takeover`
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
      await syncDirectoryWhenSupported(this.archiveDirectory);
      return { ...takeover, path: takeoverPath };
    } catch (error) {
      if (temporaryFile) await temporaryFile.close().catch(() => {});
      await unlinkWithRetryAllowMissing(tempPath).catch(() => {});
      if (published) {
        const current = await readGuardTakeover(takeoverPath, { allowMissing: true })
          .catch(() => null);
        if (current && sameGuardTakeover(current, takeover)) {
          await unlinkWithRetryAllowMissing(takeoverPath).catch(() => {});
        }
      }
      if (error.code === 'EEXIST') {
        const current = await readGuardTakeover(takeoverPath);
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
        throw new WorkspaceLeaseError(
          'Another process owns stale workspace-guard takeover.',
          'lease-guard-recovery-conflict',
          {
            details: {
              guardId: expected.guardId,
              takeoverId: current.takeoverId,
              ownerAlive
            }
          }
        );
      }
      throw new WorkspaceLeaseError(
        `Failed to publish stale workspace-guard takeover for ${expected.guardId}.`,
        'lease-guard-recovery-failed',
        { cause: error, details: { guardId: expected.guardId, published } }
      );
    }
  }

  async #releaseGuardTakeover(expected) {
    const current = await readGuardTakeover(expected.path, { allowMissing: true });
    if (!current) return;
    if (!sameGuardTakeover(current, expected)) {
      throw new WorkspaceLeaseError(
        'Workspace-guard takeover changed before release.',
        'lease-guard-recovery-conflict'
      );
    }
    await unlinkWithRetry(expected.path);
  }

  async #readGuard() {
    return readGuardFile(this.operationLockPath);
  }

  async #releaseGuard(expected) {
    let current;
    try {
      current = await this.#readGuard();
    } catch (error) {
      return error;
    }
    if (!sameGuard(expected, current)) {
      return new WorkspaceLeaseError(
        'Workspace guard ownership changed before release.',
        'lease-guard-ownership-lost',
        { details: { expectedGuardId: expected.guardId, actualGuardId: current.guardId } }
      );
    }

    try {
      await unlinkWithRetry(this.operationLockPath);
      return null;
    } catch (error) {
      return error;
    }
  }

  async #readLease({ allowMissing }) {
    let stats;
    try {
      stats = await lstat(this.leasePath);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      if (error.code === 'ENOENT') {
        throw new WorkspaceLeaseError('No workspace lease exists.', 'workspace-lease-missing');
      }
      throw new WorkspaceLeaseError(
        `Failed to inspect workspace lease ${this.leasePath}.`,
        'lease-read-failed',
        { cause: error }
      );
    }

    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new WorkspaceLeaseError(
        `Workspace lease must be a real file: ${this.leasePath}`,
        'unsafe-workspace-lease-path'
      );
    }

    let source;
    try {
      source = await readFile(this.leasePath, 'utf8');
    } catch (error) {
      throw new WorkspaceLeaseError(
        `Failed to read workspace lease ${this.leasePath}.`,
        'lease-read-failed',
        { cause: error }
      );
    }

    let lease;
    try {
      lease = JSON.parse(source);
    } catch (error) {
      throw new WorkspaceLeaseError(
        `Workspace lease is not valid JSON: ${this.leasePath}`,
        'workspace-lease-corruption',
        { cause: error }
      );
    }
    validatePersistedLease(lease, this.leasePath);
    return lease;
  }

  async #readOwnedLease(leaseId, ownerToken) {
    const current = await this.#readLease({ allowMissing: false });
    if (current.leaseId !== leaseId) {
      throw new WorkspaceLeaseError(
        'Lease identifier does not match the current workspace lease.',
        'lease-owner-mismatch'
      );
    }
    if (!tokenMatches(ownerToken, current.ownerTokenHash)) {
      throw new WorkspaceLeaseError(
        'Owner token does not match the current workspace lease.',
        'lease-owner-mismatch'
      );
    }
    return current;
  }

  async #classify(lease) {
    if (!lease) {
      return {
        held: false,
        status: 'free',
        stale: false,
        reason: 'workspace-free',
        lease: null
      };
    }

    const now = this.#now();
    const expired = Date.parse(lease.expiresAt) <= now.getTime();
    let ownerAlive = null;
    try {
      const probed = await this.pidProbe(lease.pid);
      if (typeof probed !== 'boolean') {
        throw new TypeError('pidProbe must resolve to a boolean.');
      }
      ownerAlive = probed;
    } catch {
      ownerAlive = null;
    }

    let status;
    let reason;
    let stale = false;
    if (ownerAlive === false) {
      status = 'stale';
      reason = 'owner-dead';
      stale = true;
    } else if (!expired) {
      status = 'active';
      reason = ownerAlive === true ? 'owner-alive' : 'lease-unexpired';
    } else if (ownerAlive === true) {
      status = 'expired-owner-alive';
      reason = 'owner-alive';
    } else {
      status = 'indeterminate';
      reason = 'owner-liveness-unknown';
    }

    return {
      held: true,
      status,
      stale,
      reason,
      expired,
      ownerAlive,
      inspectedAt: now.toISOString(),
      lease: publicLease(lease)
    };
  }

  async #atomicRewrite(lease) {
    validatePersistedLease(lease, this.leasePath);
    const tempPath = path.join(
      this.stateDirectory,
      `.workspace-lease.${lease.leaseId}.${randomUUID()}.tmp`
    );
    let file;
    try {
      file = await open(tempPath, 'wx', 0o600);
      await file.writeFile(`${JSON.stringify(lease, null, 2)}\n`, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await rename(tempPath, this.leasePath);
      await syncDirectoryWhenSupported(this.stateDirectory);
    } catch (error) {
      if (file) await file.close().catch(() => {});
      throw new WorkspaceLeaseError(
        `Atomic workspace lease update failed; inspect ${tempPath}.`,
        'lease-write-failed',
        { cause: error, details: { tempPath } }
      );
    }
  }

  async #archive(lease, disposition) {
    const archivedAt = this.#now().toISOString();
    const safeTimestamp = archivedAt.replaceAll(':', '-');
    const archivePath = path.join(
      this.archiveDirectory,
      `${safeTimestamp}--${lease.leaseId}--${disposition}.json`
    );
    try {
      await rename(this.leasePath, archivePath);
      await syncDirectoryWhenSupported(this.archiveDirectory);
      await syncDirectoryWhenSupported(this.stateDirectory);
    } catch (error) {
      throw new WorkspaceLeaseError(
        `Failed to archive workspace lease ${lease.leaseId}.`,
        'lease-archive-failed',
        { cause: error }
      );
    }
    return archivePath;
  }

  async #assertNoOrphanTemps() {
    for (const directory of [this.stateDirectory, this.archiveDirectory]) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        throw new WorkspaceLeaseError(
          `Failed to inspect lease directory ${directory}.`,
          'lease-read-failed',
          { cause: error }
        );
      }
      let orphan = entries.find((entry) => TEMP_FILE_PATTERN.test(entry.name));
      // A losing guard contender briefly leaves its fully written publication
      // temp beside the winner's canonical guard. Give that contender its
      // bounded cleanup window; a crash-orphan remains and still fails closed.
      if (directory === this.stateDirectory
        && orphan
        && GUARD_TEMP_FILE_PATTERN.test(orphan.name)) {
        for (const waitMs of [5, 10, 20, 40, 80]) {
          await delay(waitMs);
          entries = await readdir(directory, { withFileTypes: true });
          orphan = entries.find((entry) => TEMP_FILE_PATTERN.test(entry.name));
          if (!orphan || !GUARD_TEMP_FILE_PATTERN.test(orphan.name)) break;
        }
      }
      if (orphan) {
        throw new WorkspaceLeaseError(
          `Orphaned workspace lease transaction: ${path.join(directory, orphan.name)}`,
          'orphan-temporary-lease',
          { details: { file: path.join(directory, orphan.name) } }
        );
      }
    }
  }

  #now() {
    const value = this.clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new WorkspaceLeaseError('clock returned an invalid date.', 'invalid-clock');
    }
    return date;
  }
}

function validatePersistedLease(lease, filePath) {
  if (!isPlainRecord(lease)) throw leaseCorruption(filePath, 'lease root must be an object');
  if (lease.schemaVersion !== LEGACY_WORKSPACE_LEASE_SCHEMA_VERSION
    && lease.schemaVersion !== WORKSPACE_LEASE_SCHEMA_VERSION) {
    throw new WorkspaceLeaseError(
      `Unsupported workspace lease schema ${String(lease.schemaVersion)}.`,
      'unsupported-workspace-lease-schema'
    );
  }

  const commonKeys = [
    'acquiredAt',
    'expiresAt',
    'heartbeatAt',
    'leaseId',
    'ownerTokenHash',
    'pid',
    'schemaVersion'
  ];
  if (lease.schemaVersion === LEGACY_WORKSPACE_LEASE_SCHEMA_VERSION) {
    assertExactLeaseKeys(lease, [...commonKeys, 'runId'], filePath, 1);
    try {
      validateRunId(lease.runId);
    } catch (error) {
      throw leaseCorruption(filePath, error.message);
    }
  } else {
    try {
      validateOwnerKind(lease.ownerKind);
      validateOwnerId(lease.ownerId);
    } catch (error) {
      throw leaseCorruption(filePath, error.message);
    }
    const ownerKeys = lease.ownerKind === 'run'
      ? ['ownerId', 'ownerKind', 'runId']
      : ['ownerId', 'ownerKind'];
    assertExactLeaseKeys(lease, [...commonKeys, ...ownerKeys], filePath, 2);
    if (lease.ownerKind === 'run') {
      try {
        validateRunId(lease.runId);
      } catch (error) {
        throw leaseCorruption(filePath, error.message);
      }
      if (lease.runId !== lease.ownerId) {
        throw leaseCorruption(filePath, 'runId must equal ownerId for a run owner');
      }
    }
  }

  if (typeof lease.leaseId !== 'string' || !UUID_PATTERN.test(lease.leaseId)) {
    throw leaseCorruption(filePath, 'leaseId must be a UUID');
  }
  try {
    validatePid(lease.pid);
  } catch (error) {
    throw leaseCorruption(filePath, error.message);
  }
  if (!HASH_PATTERN.test(lease.ownerTokenHash)) {
    throw leaseCorruption(filePath, 'ownerTokenHash must be a lowercase SHA-256 hash');
  }

  const acquiredAt = parseTimestamp(lease.acquiredAt, 'acquiredAt', filePath);
  const heartbeatAt = parseTimestamp(lease.heartbeatAt, 'heartbeatAt', filePath);
  const expiresAt = parseTimestamp(lease.expiresAt, 'expiresAt', filePath);
  if (heartbeatAt < acquiredAt) {
    throw leaseCorruption(filePath, 'heartbeatAt cannot precede acquiredAt');
  }
  if (expiresAt <= heartbeatAt) {
    throw leaseCorruption(filePath, 'expiresAt must be later than heartbeatAt');
  }
}

function assertExactLeaseKeys(lease, expectedKeys, filePath, schemaVersion) {
  expectedKeys.sort();
  const actualKeys = Object.keys(lease).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw leaseCorruption(
      filePath,
      `lease fields do not match schema version ${schemaVersion}`
    );
  }
}

function parseTimestamp(value, field, filePath) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw leaseCorruption(filePath, `${field} must be an ISO timestamp`);
  }
  if (new Date(value).toISOString() !== value) {
    throw leaseCorruption(filePath, `${field} must use canonical ISO-8601 UTC format`);
  }
  return Date.parse(value);
}

function publicLease(lease) {
  const { ownerTokenHash: ignored, ...visible } = lease;
  const owner = persistedLeaseOwner(lease);
  return {
    ...visible,
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    ...(owner.ownerKind === 'run' ? { runId: owner.ownerId } : {})
  };
}

function persistedLeaseOwner(lease) {
  return lease.schemaVersion === LEGACY_WORKSPACE_LEASE_SCHEMA_VERSION
    ? { ownerKind: 'run', ownerId: lease.runId }
    : { ownerKind: lease.ownerKind, ownerId: lease.ownerId };
}

function leaseForCurrentSchema(lease) {
  const owner = persistedLeaseOwner(lease);
  return {
    schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
    leaseId: lease.leaseId,
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    ...(owner.ownerKind === 'run' ? { runId: owner.ownerId } : {}),
    pid: lease.pid,
    acquiredAt: lease.acquiredAt,
    heartbeatAt: lease.heartbeatAt,
    expiresAt: lease.expiresAt,
    ownerTokenHash: lease.ownerTokenHash
  };
}

function normalizeAcquireOwner({ runId, ownerKind, ownerId }) {
  const hasOwnerKind = ownerKind !== undefined;
  const hasOwnerId = ownerId !== undefined;
  if (!hasOwnerKind && !hasOwnerId) {
    validateRunId(runId);
    return { ownerKind: 'run', ownerId: runId };
  }
  if (!hasOwnerKind || !hasOwnerId) {
    throw new WorkspaceLeaseError(
      'ownerKind and ownerId must be provided together.',
      'invalid-lease-owner'
    );
  }

  validateOwnerKind(ownerKind);
  validateOwnerId(ownerId);
  if (ownerKind !== 'run') {
    if (runId !== undefined) {
      throw new WorkspaceLeaseError(
        `A ${ownerKind} lease cannot include runId.`,
        'invalid-lease-owner'
      );
    }
    return { ownerKind, ownerId };
  }

  if (runId !== undefined) {
    validateRunId(runId);
    if (runId !== ownerId) {
      throw new WorkspaceLeaseError(
        'runId must equal ownerId for a run owner.',
        'invalid-lease-owner'
      );
    }
  }
  return { ownerKind, ownerId };
}

function validateOwnerKind(ownerKind) {
  if (!WORKSPACE_OWNER_KINDS.includes(ownerKind)) {
    throw new WorkspaceLeaseError(
      `ownerKind must be one of: ${WORKSPACE_OWNER_KINDS.join(', ')}.`,
      'invalid-owner-kind'
    );
  }
}

function validateOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.trim() === '') {
    throw new WorkspaceLeaseError('ownerId must be a non-empty string.', 'invalid-owner-id');
  }
  if (ownerId.length > 256 || /[\u0000-\u001f]/u.test(ownerId)) {
    throw new WorkspaceLeaseError('ownerId contains unsafe characters.', 'invalid-owner-id');
  }
}

function validateRunId(runId) {
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new WorkspaceLeaseError('runId must be a non-empty string.', 'invalid-run-id');
  }
  if (runId.length > 256 || /[\u0000-\u001f]/u.test(runId)) {
    throw new WorkspaceLeaseError('runId contains unsafe characters.', 'invalid-run-id');
  }
}

function validateLeaseId(leaseId) {
  if (typeof leaseId !== 'string' || !UUID_PATTERN.test(leaseId)) {
    throw new WorkspaceLeaseError('leaseId must be a UUID.', 'invalid-lease-id');
  }
}

function validateOwnerToken(ownerToken) {
  if (typeof ownerToken !== 'string' || ownerToken.length < 32 || ownerToken.length > 512) {
    throw new WorkspaceLeaseError(
      'ownerToken must be a string between 32 and 512 characters.',
      'invalid-owner-token'
    );
  }
}

function validatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new WorkspaceLeaseError('pid must be a positive safe integer.', 'invalid-pid');
  }
}

function validateTtl(ttlMs) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) {
    throw new WorkspaceLeaseError(
      'ttlMs must be an integer from 1 through 86400000.',
      'invalid-lease-ttl'
    );
  }
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function tokenMatches(token, expectedHash) {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readGuardFile(filePath) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    throw new WorkspaceLeaseError(
      `Failed to inspect workspace lease guard ${filePath}.`,
      'lease-guard-read-failed',
      { cause: error }
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new WorkspaceLeaseError(
      `Workspace lease guard must be a real file: ${filePath}`,
      'unsafe-workspace-lease-path'
    );
  }

  let guard;
  try {
    guard = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new WorkspaceLeaseError(
      `Workspace lease guard is not valid JSON: ${filePath}`,
      'workspace-lease-guard-corruption',
      { cause: error }
    );
  }
  const expectedKeys = ['acquiredAt', 'guardId', 'pid', 'schemaVersion'];
  const actualKeys = isPlainRecord(guard) ? Object.keys(guard).sort() : [];
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || guard.schemaVersion !== GUARD_SCHEMA_VERSION
    || typeof guard.guardId !== 'string'
    || !UUID_PATTERN.test(guard.guardId)
    || !Number.isSafeInteger(guard.pid)
    || guard.pid < 1
    || typeof guard.acquiredAt !== 'string'
    || !Number.isFinite(Date.parse(guard.acquiredAt))
    || new Date(guard.acquiredAt).toISOString() !== guard.acquiredAt) {
    throw new WorkspaceLeaseError(
      `Workspace lease guard does not match schema version 1: ${filePath}`,
      'workspace-lease-guard-corruption'
    );
  }
  return guard;
}

async function readGuardTakeover(filePath, { allowMissing = false } = {}) {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw new WorkspaceLeaseError(
      `Failed to inspect workspace-guard takeover ${filePath}.`,
      'lease-guard-read-failed',
      { cause: error }
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new WorkspaceLeaseError(
      `Workspace-guard takeover must be a real file: ${filePath}`,
      'unsafe-workspace-lease-path'
    );
  }

  let takeover;
  try {
    takeover = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new WorkspaceLeaseError(
      `Workspace-guard takeover is not valid JSON: ${filePath}`,
      'workspace-lease-guard-corruption',
      { cause: error }
    );
  }
  const expectedKeys = [
    'acquiredAt',
    'guardId',
    'pid',
    'schemaVersion',
    'takeoverId'
  ];
  const actualKeys = isPlainRecord(takeover) ? Object.keys(takeover).sort() : [];
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || takeover.schemaVersion !== GUARD_TAKEOVER_SCHEMA_VERSION
    || !UUID_PATTERN.test(takeover.takeoverId)
    || !UUID_PATTERN.test(takeover.guardId)
    || !Number.isSafeInteger(takeover.pid)
    || takeover.pid < 1
    || typeof takeover.acquiredAt !== 'string'
    || !Number.isFinite(Date.parse(takeover.acquiredAt))
    || new Date(takeover.acquiredAt).toISOString() !== takeover.acquiredAt) {
    throw new WorkspaceLeaseError(
      `Workspace-guard takeover does not match schema version 1: ${filePath}`,
      'workspace-lease-guard-corruption'
    );
  }
  return takeover;
}

function sameGuard(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.guardId === right.guardId
    && left.pid === right.pid
    && left.acquiredAt === right.acquiredAt;
}

function sameGuardTakeover(left, right) {
  return left.schemaVersion === right.schemaVersion
    && left.takeoverId === right.takeoverId
    && left.guardId === right.guardId
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

async function unlinkWithRetry(filePath) {
  const retryableCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
  let lastError;
  for (const waitMs of [0, 10, 25, 50, 100]) {
    if (waitMs > 0) await delay(waitMs);
    try {
      await unlink(filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryableCodes.has(error.code)) throw error;
    }
  }
  throw lastError;
}

async function unlinkWithRetryAllowMissing(filePath) {
  try {
    await unlinkWithRetry(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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

function leaseCorruption(filePath, reason) {
  return new WorkspaceLeaseError(
    `Corrupt workspace lease ${filePath}: ${reason}.`,
    'workspace-lease-corruption',
    { details: { filePath, reason } }
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

async function assertRealDirectory(targetPath, label, missingCode = 'invalid-project-root') {
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new WorkspaceLeaseError(`${label} does not exist: ${targetPath}`, missingCode, { cause: error });
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new WorkspaceLeaseError(
      `${label} must be a real directory: ${targetPath}`,
      'unsafe-workspace-lease-path'
    );
  }
}

async function ensureRealDirectory(targetPath, mode, label) {
  try {
    await mkdir(targetPath, { mode });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await assertRealDirectory(targetPath, label, 'workspace-lease-not-initialized');
}

async function syncDirectoryWhenSupported(directoryPath) {
  let directory;
  try {
    directory = await open(directoryPath, 'r');
    await directory.sync();
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EACCES'].includes(error.code)) {
      throw new WorkspaceLeaseError(
        `Directory fsync failed for ${directoryPath}.`,
        'directory-sync-failed',
        { cause: error }
      );
    }
  } finally {
    if (directory) await directory.close().catch(() => {});
  }
}
