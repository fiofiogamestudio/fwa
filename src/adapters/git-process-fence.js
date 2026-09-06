import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, link, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';

const FILE_NAME = 'git-process-fence.json';
const RECOVERY_FILE_NAME = 'git-process-recovery.json';
const PENDING_DIRECTORY_NAME = 'git-process-fences';
const MAX_RECORD_BYTES = 1024 * 1024;
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeMs === right.mtimeMs;

function error(ErrorType, message, details) {
  return new ErrorType(message, 'git-process-fence-invalid', { details });
}

async function statOrNull(file) {
  try { return await lstat(file); } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }
}

async function directoryProof(projectRoot, ErrorType, { create = false } = {}) {
  const root = path.resolve(projectRoot);
  const state = path.join(root, '.fwa');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !samePath(await realpath(root), root)) {
    throw error(ErrorType, 'Git safety fence requires the original real project directory.', { projectRoot: root });
  }
  if (create) {
    try { await mkdir(state); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
  }
  const stateStat = await lstat(state);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()
    || !samePath(await realpath(state), state)) {
    throw error(ErrorType, 'Git safety fence requires a real project-owned .fwa directory.', { projectRoot: root });
  }
  return { root, state, rootIdentity: identity(rootStat), stateIdentity: identity(stateStat) };
}

async function assertDirectories(proof, ErrorType) {
  const next = await directoryProof(proof.root, ErrorType);
  // Directory size and mtime legitimately change as the record is published.
  if (next.rootIdentity.dev !== proof.rootIdentity.dev || next.rootIdentity.ino !== proof.rootIdentity.ino
    || next.stateIdentity.dev !== proof.stateIdentity.dev || next.stateIdentity.ino !== proof.stateIdentity.ino) {
    throw error(ErrorType, 'Git safety fence directories changed identity.', { projectRoot: proof.root });
  }
}

function validateRecord(record, root, ErrorType) {
  if (!record || record.schemaVersion !== 1
    || !/^git-fence_[a-f0-9-]{36}$/u.test(record.id ?? '')
    || typeof record.projectRoot !== 'string' || !samePath(record.projectRoot, root)
    || record.code !== 'git-process-termination-unconfirmed'
    || record.terminationConfirmed !== false
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || (record.pid !== null && (!Number.isSafeInteger(record.pid) || record.pid < 1))
    || typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd)
    || !Array.isArray(record.arguments) || record.arguments.some((arg) => typeof arg !== 'string')) {
    throw error(ErrorType, 'Git safety fence is malformed or belongs to another project.', { projectRoot: root });
  }
}

export async function inspectGitProcessFence(projectRoot, ErrorType, { ignoreRecoveryGuard = false } = {}) {
  let file = path.join(path.resolve(projectRoot), '.fwa', FILE_NAME);
  const recoveryPath = path.join(path.resolve(projectRoot), '.fwa', RECOVERY_FILE_NAME);
  const recoveryStat = ignoreRecoveryGuard ? null : await statOrNull(recoveryPath);
  if (recoveryStat !== null) {
    const proof = await directoryProof(projectRoot, ErrorType);
    if (!recoveryStat.isFile() || recoveryStat.isSymbolicLink() || recoveryStat.nlink !== 1
      || recoveryStat.size > MAX_RECORD_BYTES) {
      throw error(ErrorType, 'Git recovery guard is not a bounded regular file.', { path: recoveryPath });
    }
    const handle = await open(recoveryPath, 'r');
    let bytes;
    try {
      if (!sameIdentity(identity(recoveryStat), identity(await handle.stat()))) {
        throw error(ErrorType, 'Git recovery guard changed while being opened.', { path: recoveryPath });
      }
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    const after = await lstat(recoveryPath);
    if (!sameIdentity(identity(recoveryStat), identity(after))) {
      throw error(ErrorType, 'Git recovery guard changed while being inspected.', { path: recoveryPath });
    }
    await assertDirectories(proof, ErrorType);
    let recovery;
    try { recovery = JSON.parse(bytes.toString('utf8')); } catch {
      throw error(ErrorType, 'Git recovery guard is incomplete; operator review is required.', { path: recoveryPath });
    }
    validateRecord(recovery.fence, proof.root, ErrorType);
    if (recovery.schemaVersion !== 1 || !Number.isSafeInteger(recovery.ownerPid)
      || recovery.ownerPid < 1 || typeof recovery.id !== 'string') {
      throw error(ErrorType, 'Git recovery guard is malformed.', { path: recoveryPath });
    }
    return {
      held: true, path: file, fence: recovery.fence, recoveryActive: true,
      recoveryGuardPath: recoveryPath, recovery,
      identity: identity(after), digest: createHash('sha256').update(bytes).digest('hex')
    };
  }
  let before = await statOrNull(file);
  let pendingId = null;
  if (before === null) {
    const pendingDirectory = path.join(path.resolve(projectRoot), '.fwa', PENDING_DIRECTORY_NAME);
    const pendingStat = await statOrNull(pendingDirectory);
    if (pendingStat === null) return { held: false, path: file, fence: null };
    await directoryProof(projectRoot, ErrorType);
    if (!pendingStat.isDirectory() || pendingStat.isSymbolicLink()
      || !samePath(await realpath(pendingDirectory), pendingDirectory)) {
      throw error(ErrorType, 'Pending Git fences must remain in a real project-owned directory.', { pendingDirectory });
    }
    const entries = (await readdir(pendingDirectory)).sort();
    if (entries.some((name) => !/^git-fence_[a-f0-9-]{36}\.json$/u.test(name))) {
      throw error(ErrorType, 'Pending Git fence directory contains an unexpected entry.', { pendingDirectory });
    }
    if (entries.length === 0) return { held: false, path: file, fence: null };
    file = path.join(pendingDirectory, entries[0]);
    pendingId = entries[0].slice(0, -5);
    before = await lstat(file);
  }
  const proof = await directoryProof(projectRoot, ErrorType);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_RECORD_BYTES) {
    throw error(ErrorType, 'Git safety fence must be a bounded regular file without links.', { path: file });
  }
  let handle;
  let bytes;
  try {
    handle = await open(file, 'r');
    if (!sameIdentity(identity(before), identity(await handle.stat()))) {
      throw error(ErrorType, 'Git safety fence changed while being opened.', { path: file });
    }
    bytes = await handle.readFile();
  } finally { await handle?.close(); }
  const after = await lstat(file);
  if (!sameIdentity(identity(before), identity(after))) {
    throw error(ErrorType, 'Git safety fence changed while being read.', { path: file });
  }
  await assertDirectories(proof, ErrorType);
  let fence;
  try { fence = JSON.parse(bytes.toString('utf8')); } catch {
    throw error(ErrorType, 'Git safety fence contains invalid JSON; operator review is required.', { path: file });
  }
  validateRecord(fence, proof.root, ErrorType);
  if (pendingId !== null && fence.id !== pendingId) {
    throw error(ErrorType, 'Pending Git fence id does not match its filename.', { path: file });
  }
  return {
    held: true, path: file, fence, identity: identity(after),
    digest: createHash('sha256').update(bytes).digest('hex')
  };
}

export async function recordGitProcessFence(projectRoot, failure, ErrorType) {
  const proof = await directoryProof(projectRoot, ErrorType, { create: true });
  const fence = {
    schemaVersion: 1, id: `git-fence_${randomUUID()}`, projectRoot: proof.root,
    createdAt: new Date().toISOString(), code: 'git-process-termination-unconfirmed',
    terminationConfirmed: false, pid: failure.details?.pid ?? null,
    cwd: path.resolve(failure.details?.cwd ?? proof.root),
    arguments: [...(failure.details?.arguments ?? [])],
    reason: failure.details?.reason ?? 'unknown',
    timeoutMs: failure.details?.timeoutMs ?? null,
    terminationGraceMs: failure.details?.terminationGraceMs ?? null,
    ownerPid: process.pid
  };
  validateRecord(fence, proof.root, ErrorType);
  let file = path.join(proof.state, FILE_NAME);
  let pendingProof = null;
  let handle;
  let publishedIdentity;
  try {
    try { handle = await open(file, 'wx', 0o600); } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      // Each newly unconfirmed command retains its own durable identity. An
      // already-running command may fail while an older fence is being cleared;
      // coalescing that failure into the older id would let its recovery erase it.
      const pendingDirectory = path.join(proof.state, PENDING_DIRECTORY_NAME);
      try { await mkdir(pendingDirectory); } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      const pendingStat = await lstat(pendingDirectory);
      if (!pendingStat.isDirectory() || pendingStat.isSymbolicLink()
        || !samePath(await realpath(pendingDirectory), pendingDirectory)) {
        throw error(ErrorType, 'Pending Git fence directory must not be linked or redirected.', { pendingDirectory });
      }
      pendingProof = { directory: pendingDirectory, dev: pendingStat.dev, ino: pendingStat.ino };
      file = path.join(pendingDirectory, `${fence.id}.json`);
      handle = await open(file, 'wx', 0o600);
    }
    await handle.writeFile(`${JSON.stringify(fence)}\n`, 'utf8');
    await handle.sync();
    publishedIdentity = identity(await handle.stat());
  } finally { await handle?.close(); }
  await assertDirectories(proof, ErrorType);
  if (pendingProof !== null) {
    const after = await lstat(pendingProof.directory);
    if (after.isSymbolicLink() || after.dev !== pendingProof.dev || after.ino !== pendingProof.ino) {
      throw error(ErrorType, 'Pending Git fence directory changed identity.', { path: file });
    }
  }
  const bytes = Buffer.from(`${JSON.stringify(fence)}\n`, 'utf8');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length
    || !sameIdentity(publishedIdentity, identity(stat))) {
    throw error(ErrorType, 'Published Git safety fence changed identity.', { path: file });
  }
  return { held: true, path: file, fence, identity: identity(stat), digest: createHash('sha256').update(bytes).digest('hex') };
}

/** Explicit operator assertion only; never infer safety from PID absence/TTL. */
export async function recoverGitProcessFence(projectRoot, {
  expectedFenceId, confirmProcessesStopped = false
} = {}, ErrorType) {
  if (confirmProcessesStopped !== true || typeof expectedFenceId !== 'string'
    || !/^git-fence_[a-f0-9-]{36}$/u.test(expectedFenceId)) {
    throw new ErrorType(
      'Recovery requires expectedFenceId and confirmProcessesStopped: true after independently stopping the Git process tree.',
      'git-process-recovery-confirmation-required'
    );
  }
  const inspection = await inspectGitProcessFence(projectRoot, ErrorType);
  if (inspection.recoveryActive) {
    throw new ErrorType('Git fence recovery is already guarded; review its owner before retrying.', 'git-process-recovery-active', {
      details: { recoveryGuardPath: inspection.recoveryGuardPath, recovery: inspection.recovery }
    });
  }
  if (!inspection.held || inspection.fence.id !== expectedFenceId) {
    throw new ErrorType('Git safety fence does not match the requested recovery.', 'git-process-fence-mismatch');
  }
  const proof = await directoryProof(projectRoot, ErrorType);
  const recoveryPath = path.join(proof.state, RECOVERY_FILE_NAME);
  const recovery = {
    schemaVersion: 1, id: randomUUID(), ownerPid: process.pid,
    createdAt: new Date().toISOString(), fence: inspection.fence
  };
  let handle;
  try { handle = await open(recoveryPath, 'wx', 0o600); } catch (cause) {
    if (cause.code === 'EEXIST') throw new ErrorType('Another recovery owns the Git safety guard.', 'git-process-recovery-active');
    throw cause;
  }
  let guardIdentity;
  try {
    await handle.writeFile(`${JSON.stringify(recovery)}\n`, 'utf8');
    await handle.sync();
    guardIdentity = identity(await handle.stat());
  } finally { await handle.close(); }
  let completed = false;
  let result;
  try {
    result = await recoverClaimedGitProcessFence(projectRoot, expectedFenceId, ErrorType, inspection);
    completed = true;
  } finally {
    // A failed recovery that lost the active marker must leave its guard as the
    // durable blocker. Never infer that a crashed recovery's owner is safe by age.
    const marker = await statOrNull(inspection.path);
    if (completed || marker !== null) {
      await assertDirectories(proof, ErrorType);
      const current = await lstat(recoveryPath);
      if (!sameIdentity(guardIdentity, identity(current))) {
        throw error(ErrorType, 'Git recovery guard changed; do not release another owner.', { recoveryPath });
      }
      await unlink(recoveryPath);
    }
  }
  const remaining = await inspectGitProcessFence(projectRoot, ErrorType);
  return { ...result, held: remaining.held, remainingFenceId: remaining.fence?.id ?? null };
}

async function recoverClaimedGitProcessFence(projectRoot, expectedFenceId, ErrorType, inspection) {
  const proof = await directoryProof(projectRoot, ErrorType);
  const archiveDirectory = path.join(proof.state, 'git-process-recoveries');
  try { await mkdir(archiveDirectory); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
  const archiveStat = await lstat(archiveDirectory);
  if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()
    || !samePath(await realpath(archiveDirectory), archiveDirectory)) {
    throw error(ErrorType, 'Git recovery receipt directory must not be linked or redirected.', { archiveDirectory });
  }
  const recoveryId = randomUUID();
  const recordPath = path.join(archiveDirectory, `${expectedFenceId}-${recoveryId}.fence.json`);
  const receiptPath = path.join(archiveDirectory, `${expectedFenceId}-${recoveryId}.receipt.json`);
  const receipt = {
    schemaVersion: 1, recoveryId, fenceId: expectedFenceId,
    projectRoot: proof.root, recoveredAt: new Date().toISOString(),
    confirmProcessesStopped: true, fenceDigest: inspection.digest,
    action: 'release-git-process-fence-only', archivedFencePath: recordPath
  };
  const receiptHandle = await open(receiptPath, 'wx', 0o600);
  try {
    await receiptHandle.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
    await receiptHandle.sync();
  } finally { await receiptHandle.close(); }
  await assertDirectories(proof, ErrorType);
  const archiveAfter = await lstat(archiveDirectory);
  const latest = await inspectGitProcessFence(projectRoot, ErrorType, { ignoreRecoveryGuard: true });
  if (archiveAfter.dev !== archiveStat.dev || archiveAfter.ino !== archiveStat.ino
    || !latest.held || latest.fence.id !== expectedFenceId
    || !sameIdentity(inspection.identity, latest.identity) || latest.digest !== inspection.digest) {
    throw error(ErrorType, 'Git safety fence or receipt directory changed before recovery.', { receiptPath });
  }
  // rename keeps the exact original bytes/inode as an audit record. Concurrent
  // recovery cannot remove a replacement silently: verify the moved identity.
  await rename(inspection.path, recordPath);
  const moved = await lstat(recordPath);
  if (!sameIdentity(inspection.identity, identity(moved))) {
    try { await link(recordPath, inspection.path); } catch (cause) {
      if (cause.code !== 'EEXIST') {
        throw error(ErrorType, 'Recovery encountered a replaced fence and could not restore the blocker.', { recordPath, receiptPath });
      }
    }
    throw error(ErrorType, 'Recovery encountered a replaced fence; the safety blocker remains.', { recordPath, receiptPath });
  }
  return { recovered: true, fenceId: expectedFenceId, receiptPath, archivedFencePath: recordPath };
}
