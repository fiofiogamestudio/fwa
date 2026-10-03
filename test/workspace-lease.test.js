import assert from 'node:assert/strict';
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WORKSPACE_LEASE_SCHEMA_VERSION,
  WorkspaceLease
} from '../src/storage/workspace-lease.js';

const LEASE_ID_1 = '11111111-1111-4111-8111-111111111111';
const LEASE_ID_2 = '22222222-2222-4222-8222-222222222222';
const TOKEN_1 = 'a'.repeat(64);
const TOKEN_2 = 'b'.repeat(64);
const GUARD_ID_1 = '33333333-3333-4333-8333-333333333333';
const GUARD_ID_2 = '44444444-4444-4444-8444-444444444444';

function guardRecord({
  guardId = GUARD_ID_1,
  pid = 4321,
  acquiredAt = '2026-09-05T00:00:00.000Z'
} = {}) {
  return { schemaVersion: 1, guardId, pid, acquiredAt };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-workspace-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = new Date('2026-09-05T00:00:00.000Z');
  const lease = new WorkspaceLease(root, {
    clock: () => now,
    pidProbe: async () => true,
    idFactory: () => LEASE_ID_1,
    tokenFactory: () => TOKEN_1,
    defaultTtlMs: 10_000,
    ...options
  });
  await lease.init();
  return {
    root,
    lease,
    stateDirectory: path.join(root, '.fwa'),
    leasePath: path.join(root, '.fwa', 'workspace-lease.json'),
    archiveDirectory: path.join(root, '.fwa', 'lease-archive'),
    setNow(value) {
      now = new Date(value);
    }
  };
}

async function rewriteCurrentRunLeaseAsV1(item) {
  const current = JSON.parse(await readFile(item.leasePath, 'utf8'));
  const {
    ownerKind: ignoredOwnerKind,
    ownerId: ignoredOwnerId,
    ...legacy
  } = current;
  legacy.schemaVersion = 1;
  await writeFile(item.leasePath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  return legacy;
}

test('acquires one durable lease and archives it on owner release', async (t) => {
  const item = await fixture(t);
  const acquired = await item.lease.acquire({ runId: 'run-1', pid: 1234 });

  assert.equal(acquired.acquired, true);
  assert.equal(acquired.ownerToken, TOKEN_1);
  assert.equal(acquired.lease.leaseId, LEASE_ID_1);
  assert.equal(acquired.lease.schemaVersion, WORKSPACE_LEASE_SCHEMA_VERSION);
  assert.equal(acquired.lease.ownerKind, 'run');
  assert.equal(acquired.lease.ownerId, 'run-1');
  assert.equal(acquired.lease.runId, 'run-1');
  assert.equal(acquired.lease.pid, 1234);
  assert.equal(acquired.lease.acquiredAt, '2026-09-05T00:00:00.000Z');
  assert.equal(acquired.lease.expiresAt, '2026-09-05T00:00:10.000Z');
  assert.equal(Object.hasOwn(acquired.lease, 'ownerTokenHash'), false);

  const persisted = JSON.parse(await readFile(item.leasePath, 'utf8'));
  assert.equal(persisted.schemaVersion, WORKSPACE_LEASE_SCHEMA_VERSION);
  assert.equal(persisted.ownerKind, 'run');
  assert.equal(persisted.ownerId, 'run-1');
  assert.equal(persisted.runId, 'run-1');
  assert.match(persisted.ownerTokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(persisted.ownerTokenHash, TOKEN_1);
  const inspection = await item.lease.inspect();
  assert.equal(inspection.status, 'active');
  assert.equal(inspection.ownerAlive, true);
  assert.equal(inspection.stale, false);

  const released = await item.lease.release({ leaseId: LEASE_ID_1, ownerToken: TOKEN_1 });
  assert.equal(released.released, true);
  await assert.rejects(lstat(item.leasePath), (error) => error.code === 'ENOENT');
  assert.equal((await item.lease.inspect()).status, 'free');

  const archivedFiles = await readdir(item.archiveDirectory);
  assert.equal(archivedFiles.length, 1);
  assert.match(archivedFiles[0], /--11111111-1111-4111-8111-111111111111--released\.json$/);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(item.archiveDirectory, archivedFiles[0]), 'utf8')),
    persisted
  );
});

test('acquires explicit run, evaluation, integration, and reversion owners without run aliases', async (t) => {
  const explicitRun = await fixture(t);
  const run = await explicitRun.lease.acquire({
    ownerKind: 'run',
    ownerId: 'run-explicit',
    pid: 1234
  });
  assert.equal(run.lease.ownerKind, 'run');
  assert.equal(run.lease.ownerId, 'run-explicit');
  assert.equal(run.lease.runId, 'run-explicit');

  const evaluation = await fixture(t);
  const acquired = await evaluation.lease.acquire({
    ownerKind: 'evaluation',
    ownerId: 'evaluation-1',
    pid: 2345
  });
  assert.equal(acquired.lease.ownerKind, 'evaluation');
  assert.equal(acquired.lease.ownerId, 'evaluation-1');
  assert.equal(Object.hasOwn(acquired.lease, 'runId'), false);

  const persisted = JSON.parse(await readFile(evaluation.leasePath, 'utf8'));
  assert.equal(persisted.ownerKind, 'evaluation');
  assert.equal(persisted.ownerId, 'evaluation-1');
  assert.equal(Object.hasOwn(persisted, 'runId'), false);
  const inspection = await evaluation.lease.inspect();
  assert.equal(inspection.lease.ownerKind, 'evaluation');
  assert.equal(inspection.lease.ownerId, 'evaluation-1');
  assert.equal(Object.hasOwn(inspection.lease, 'runId'), false);

  const integration = await fixture(t);
  const integrated = await integration.lease.acquire({
    ownerKind: 'integration',
    ownerId: 'integration-1',
    pid: 4567
  });
  assert.equal(integrated.lease.ownerKind, 'integration');
  assert.equal(integrated.lease.ownerId, 'integration-1');
  assert.equal(Object.hasOwn(integrated.lease, 'runId'), false);
  const persistedIntegration = JSON.parse(await readFile(integration.leasePath, 'utf8'));
  assert.equal(persistedIntegration.ownerKind, 'integration');
  assert.equal(persistedIntegration.ownerId, 'integration-1');
  assert.equal(Object.hasOwn(persistedIntegration, 'runId'), false);

  const reversion = await fixture(t);
  const reverted = await reversion.lease.acquire({
    ownerKind: 'reversion',
    ownerId: 'reversion-1',
    pid: 5678
  });
  assert.equal(reverted.lease.ownerKind, 'reversion');
  assert.equal(reverted.lease.ownerId, 'reversion-1');
  assert.equal(Object.hasOwn(reverted.lease, 'runId'), false);
  const persistedReversion = JSON.parse(await readFile(reversion.leasePath, 'utf8'));
  assert.equal(persistedReversion.ownerKind, 'reversion');
  assert.equal(persistedReversion.ownerId, 'reversion-1');
  assert.equal(Object.hasOwn(persistedReversion, 'runId'), false);
  const inspectedReversion = await reversion.lease.inspect();
  assert.equal(inspectedReversion.lease.ownerKind, 'reversion');
  assert.equal(inspectedReversion.lease.ownerId, 'reversion-1');
  assert.equal(Object.hasOwn(inspectedReversion.lease, 'runId'), false);

  await assert.rejects(
    explicitRun.lease.acquire({
      ownerKind: 'evaluation',
      ownerId: 'evaluation-blocked',
      pid: 3456
    }),
    (error) => error.code === 'workspace-lease-held'
      && error.details.lease.ownerKind === 'run'
      && error.details.lease.ownerId === 'run-explicit'
  );
  await assert.rejects(
    evaluation.lease.acquire({ runId: 'run-blocked', pid: 3456 }),
    (error) => error.code === 'workspace-lease-held'
      && error.details.lease.ownerKind === 'evaluation'
      && error.details.lease.ownerId === 'evaluation-1'
      && !Object.hasOwn(error.details.lease, 'runId')
  );

  const heartbeat = await evaluation.lease.heartbeat({
    leaseId: LEASE_ID_1,
    ownerToken: TOKEN_1
  });
  assert.equal(heartbeat.lease.ownerKind, 'evaluation');
  assert.equal(Object.hasOwn(heartbeat.lease, 'runId'), false);
  const released = await evaluation.lease.release({
    leaseId: LEASE_ID_1,
    ownerToken: TOKEN_1
  });
  assert.equal(released.lease.ownerKind, 'evaluation');
  assert.equal(Object.hasOwn(released.lease, 'runId'), false);
  const archived = JSON.parse(await readFile(released.archivePath, 'utf8'));
  assert.equal(archived.ownerKind, 'evaluation');
  assert.equal(Object.hasOwn(archived, 'runId'), false);
});

test('reads v1 run leases through the generic owner API and migrates them on heartbeat', async (t) => {
  const item = await fixture(t);
  await item.lease.acquire({ runId: 'legacy-run', pid: 1234 });
  const legacy = await rewriteCurrentRunLeaseAsV1(item);

  const inspection = await item.lease.inspect();
  assert.equal(inspection.lease.schemaVersion, 1);
  assert.equal(inspection.lease.ownerKind, 'run');
  assert.equal(inspection.lease.ownerId, 'legacy-run');
  assert.equal(inspection.lease.runId, 'legacy-run');

  item.setNow('2026-09-05T00:00:01.000Z');
  const heartbeat = await item.lease.heartbeat({
    leaseId: LEASE_ID_1,
    ownerToken: TOKEN_1
  });
  assert.equal(heartbeat.lease.schemaVersion, WORKSPACE_LEASE_SCHEMA_VERSION);
  assert.equal(heartbeat.lease.ownerKind, 'run');
  assert.equal(heartbeat.lease.ownerId, legacy.runId);
  assert.equal(heartbeat.lease.runId, legacy.runId);
  const migrated = JSON.parse(await readFile(item.leasePath, 'utf8'));
  assert.equal(migrated.schemaVersion, WORKSPACE_LEASE_SCHEMA_VERSION);
  assert.equal(migrated.ownerKind, 'run');
  assert.equal(migrated.ownerId, legacy.runId);
  assert.equal(migrated.runId, legacy.runId);
});

test('releases and stale-archives v1 run leases while exposing mapped owners', async (t) => {
  const releasedItem = await fixture(t);
  await releasedItem.lease.acquire({ runId: 'legacy-release', pid: 1234 });
  const legacyReleased = await rewriteCurrentRunLeaseAsV1(releasedItem);
  const released = await releasedItem.lease.release({
    leaseId: LEASE_ID_1,
    ownerToken: TOKEN_1
  });
  assert.equal(released.lease.ownerKind, 'run');
  assert.equal(released.lease.ownerId, 'legacy-release');
  assert.equal(released.lease.runId, 'legacy-release');
  assert.deepEqual(
    JSON.parse(await readFile(released.archivePath, 'utf8')),
    legacyReleased
  );

  const staleItem = await fixture(t, { pidProbe: async () => false });
  await staleItem.lease.acquire({ runId: 'legacy-stale', pid: 9876 });
  const legacyStale = await rewriteCurrentRunLeaseAsV1(staleItem);
  const archived = await staleItem.lease.archiveStale({ expectedLeaseId: LEASE_ID_1 });
  assert.equal(archived.archived, true);
  assert.equal(archived.lease.ownerKind, 'run');
  assert.equal(archived.lease.ownerId, 'legacy-stale');
  assert.equal(archived.lease.runId, 'legacy-stale');
  assert.deepEqual(
    JSON.parse(await readFile(archived.archivePath, 'utf8')),
    legacyStale
  );
});

test('init fences a live atomic-update temp before classifying orphan transactions', async (t) => {
  const item = await fixture(t);
  await item.lease.acquire({ runId: 'live-heartbeat', pid: process.pid });
  const guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  const tempPath = path.join(item.stateDirectory, `.workspace-lease.${LEASE_ID_1}.${GUARD_ID_2}.tmp`);
  const currentBytes = await readFile(item.leasePath);
  // Hold the exact public on-disk phase of heartbeat: a live operation guard,
  // the canonical lease and a fully written update awaiting atomic publication.
  await writeFile(guardPath, `${JSON.stringify(guardRecord({ pid: process.pid }))}\n`, { flag: 'wx' });
  await writeFile(tempPath, currentBytes, { flag: 'wx' });
  await assert.rejects(item.lease.init(), error => error.code === 'workspace-lease-busy');
  assert.deepEqual(await readFile(tempPath), currentBytes);
  assert.deepEqual(await readFile(item.leasePath), currentBytes);
  await unlink(guardPath);
  // With no live operation protecting it, the same unfinished temp really is
  // orphaned and must still fail closed without being removed by init.
  await assert.rejects(item.lease.init(), error => error.code === 'orphan-temporary-lease');
  assert.deepEqual(await readFile(tempPath), currentBytes);
  await unlink(tempPath);
  assert.equal((await item.lease.init()).held, true);
});

test('heartbeats atomically and rejects the wrong lease id or owner token', async (t) => {
  const item = await fixture(t);
  await item.lease.acquire({ runId: 'run-1', pid: 1234 });

  await assert.rejects(
    item.lease.heartbeat({ leaseId: LEASE_ID_2, ownerToken: TOKEN_1 }),
    (error) => error.code === 'lease-owner-mismatch'
  );
  await assert.rejects(
    item.lease.release({ leaseId: LEASE_ID_1, ownerToken: TOKEN_2 }),
    (error) => error.code === 'lease-owner-mismatch'
  );

  item.setNow('2026-09-05T00:00:04.000Z');
  const heartbeat = await item.lease.heartbeat({
    leaseId: LEASE_ID_1,
    ownerToken: TOKEN_1,
    ttlMs: 20_000
  });
  assert.equal(heartbeat.lease.heartbeatAt, '2026-09-05T00:00:04.000Z');
  assert.equal(heartbeat.lease.expiresAt, '2026-09-05T00:00:24.000Z');
  assert.equal(
    (await readdir(item.stateDirectory)).some((name) => name.endsWith('.tmp')),
    false
  );
  assert.equal((await item.lease.inspect()).status, 'active');
});

test('does not auto-steal a dead lease; explicit stale archival is required', async (t) => {
  let ids = [LEASE_ID_1, LEASE_ID_2];
  let tokens = [TOKEN_1, TOKEN_2];
  const item = await fixture(t, {
    pidProbe: async () => false,
    idFactory: () => ids.shift(),
    tokenFactory: () => tokens.shift()
  });
  await item.lease.acquire({ runId: 'abandoned', pid: 9876 });

  const inspection = await item.lease.inspect();
  assert.equal(inspection.status, 'stale');
  assert.equal(inspection.reason, 'owner-dead');
  assert.equal(inspection.stale, true);
  await assert.rejects(
    item.lease.acquire({ runId: 'replacement', pid: 9877 }),
    (error) => error.code === 'workspace-lease-held' && error.details.stale === true
  );

  const archived = await item.lease.archiveStale({ expectedLeaseId: LEASE_ID_1 });
  assert.equal(archived.archived, true);
  assert.equal(archived.reason, 'owner-dead');
  const replacement = await item.lease.acquire({ runId: 'replacement', pid: 9877 });
  assert.equal(replacement.lease.leaseId, LEASE_ID_2);
});

test('never archives an expired lease while its owner is alive', async (t) => {
  const item = await fixture(t, { pidProbe: async () => true });
  await item.lease.acquire({ runId: 'slow-but-alive', pid: 1234, ttlMs: 1000 });
  item.setNow('2026-09-05T00:00:02.000Z');

  const inspection = await item.lease.inspect();
  assert.equal(inspection.expired, true);
  assert.equal(inspection.ownerAlive, true);
  assert.equal(inspection.status, 'expired-owner-alive');
  assert.equal(inspection.reason, 'owner-alive');
  assert.equal(inspection.stale, false);
  await assert.rejects(
    item.lease.archiveStale({ expectedLeaseId: LEASE_ID_1 }),
    (error) => error.code === 'workspace-lease-not-stale'
  );
  assert.equal((await lstat(item.leasePath)).isFile(), true);
});

test('fails closed after expiry when owner probing is unavailable', async (t) => {
  const item = await fixture(t, {
    pidProbe: async () => {
      throw new Error('probe unavailable');
    }
  });
  await item.lease.acquire({ runId: 'unknown-owner', pid: 1234, ttlMs: 1000 });
  item.setNow('2026-09-05T00:00:02.000Z');

  const inspection = await item.lease.inspect();
  assert.equal(inspection.status, 'indeterminate');
  assert.equal(inspection.ownerAlive, null);
  assert.equal(inspection.reason, 'owner-liveness-unknown');
  assert.equal(inspection.stale, false);
  await assert.rejects(
    item.lease.archiveStale(),
    (error) => error.code === 'workspace-lease-not-stale'
  );
});

test('never archives an unexpired lease when owner liveness is unknown', async (t) => {
  const item = await fixture(t, {
    pidProbe: async () => {
      throw new Error('probe unavailable');
    }
  });
  await item.lease.acquire({ runId: 'unknown-owner', pid: 1234 });

  const inspection = await item.lease.inspect();
  assert.equal(inspection.status, 'active');
  assert.equal(inspection.reason, 'lease-unexpired');
  assert.equal(inspection.ownerAlive, null);
  assert.equal(inspection.stale, false);
  await assert.rejects(
    item.lease.archiveStale(),
    (error) => error.code === 'workspace-lease-not-stale'
  );
});

test('stale recovery uses an expected lease id as a compare guard', async (t) => {
  const item = await fixture(t, { pidProbe: async () => false });
  await item.lease.acquire({ runId: 'dead', pid: 1234 });

  await assert.rejects(
    item.lease.archiveStale({ expectedLeaseId: LEASE_ID_2 }),
    (error) => error.code === 'lease-recovery-conflict'
  );
  assert.equal((await lstat(item.leasePath)).isFile(), true);
});

test('archiveStale is an idempotent no-op when the workspace is free', async (t) => {
  const item = await fixture(t);
  assert.deepEqual(await item.lease.archiveStale(), {
    archived: false,
    reason: 'workspace-free'
  });
});

test('an exclusive operation guard prevents concurrent lease mutation', async (t) => {
  const item = await fixture(t);
  const guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  await writeFile(guardPath, `${JSON.stringify(guardRecord())}\n`, { flag: 'wx' });

  await assert.rejects(
    item.lease.inspect(),
    (error) => error.code === 'workspace-lease-busy'
  );
  await assert.rejects(
    item.lease.acquire({ runId: 'run-1' }),
    (error) => error.code === 'workspace-lease-busy'
  );
  await unlink(guardPath);
  assert.equal((await item.lease.inspect()).status, 'free');
});

test('releaseOwnedGuard removes only the exact guard published by this process', async (t) => {
  const item = await fixture(t);
  const guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  await writeFile(
    guardPath,
    `${JSON.stringify(guardRecord({ pid: process.pid }))}\n`,
    { flag: 'wx' }
  );
  assert.deepEqual(
    await item.lease.releaseOwnedGuard({ expectedGuardId: GUARD_ID_1 }),
    { released: true, guardId: GUARD_ID_1 }
  );

  await writeFile(
    guardPath,
    `${JSON.stringify(guardRecord({ pid: process.pid + 1 }))}\n`,
    { flag: 'wx' }
  );
  await assert.rejects(
    item.lease.releaseOwnedGuard({ expectedGuardId: GUARD_ID_1 }),
    (error) => error.code === 'lease-guard-ownership-lost'
  );
  assert.equal((await readFile(guardPath, 'utf8')).includes(GUARD_ID_1), true);
  await unlink(guardPath);
});

test('archives a guard only when its owner PID is confirmed dead', async (t) => {
  const item = await fixture(t, { pidProbe: async () => false });
  const guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  const abandoned = guardRecord();
  await writeFile(guardPath, `${JSON.stringify(abandoned)}\n`, { flag: 'wx' });

  assert.equal((await item.lease.inspect()).status, 'free');
  const archived = (await readdir(item.archiveDirectory))
    .filter((name) => name.includes(`guard-${GUARD_ID_1}`));
  assert.equal(archived.length, 1);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(item.archiveDirectory, archived[0]), 'utf8')),
    abandoned
  );
  assert.equal((await readdir(item.stateDirectory)).includes('.workspace-lease.guard'), false);
});

test('resumes dead-guard recovery after its archive hardlink was published', async (t) => {
  const item = await fixture(t, { pidProbe: async () => false });
  const guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  const abandoned = guardRecord();
  const archivePath = path.join(
    item.archiveDirectory,
    `${abandoned.acquiredAt.replaceAll(':', '-')}--guard-${abandoned.guardId}--owner-dead.json`
  );
  await writeFile(guardPath, `${JSON.stringify(abandoned)}\n`, { flag: 'wx' });
  await link(guardPath, archivePath);

  assert.equal((await item.lease.inspect()).status, 'free');
  assert.equal((await readdir(item.stateDirectory)).includes('.workspace-lease.guard'), false);
  assert.deepEqual(JSON.parse(await readFile(archivePath, 'utf8')), abandoned);
  assert.equal(
    (await readdir(item.archiveDirectory)).some((name) => name.endsWith('.takeover')),
    false
  );
});

test('concurrent dead-guard resumptions have one safe archive result', async (t) => {
  const item = await fixture(t, { pidProbe: async () => false });
  const contender = new WorkspaceLease(item.root, {
    clock: () => new Date('2026-09-05T00:00:00.000Z'),
    pidProbe: async () => false,
    defaultTtlMs: 10_000
  });
  const guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  const abandoned = guardRecord();
  const archivePath = path.join(
    item.archiveDirectory,
    `${abandoned.acquiredAt.replaceAll(':', '-')}--guard-${abandoned.guardId}--owner-dead.json`
  );
  await writeFile(guardPath, `${JSON.stringify(abandoned)}\n`, { flag: 'wx' });
  await link(guardPath, archivePath);

  const outcomes = await Promise.allSettled([
    item.lease.inspect(),
    contender.inspect()
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled'
      && outcome.value.status === 'free').length,
    1
  );
  assert.equal((await readdir(item.stateDirectory)).includes('.workspace-lease.guard'), false);
  assert.deepEqual(JSON.parse(await readFile(archivePath, 'utf8')), abandoned);
});

test('dead-guard resume rejects copied evidence without deleting canonical guard', async (t) => {
  const item = await fixture(t, { pidProbe: async () => false });
  const guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  const abandoned = guardRecord();
  const source = `${JSON.stringify(abandoned)}\n`;
  const archivePath = path.join(
    item.archiveDirectory,
    `${abandoned.acquiredAt.replaceAll(':', '-')}--guard-${abandoned.guardId}--owner-dead.json`
  );
  await writeFile(guardPath, source, { flag: 'wx' });
  await writeFile(archivePath, source, { flag: 'wx' });

  await assert.rejects(
    item.lease.inspect(),
    (error) => error.code === 'lease-guard-recovery-conflict'
  );
  assert.deepEqual(JSON.parse(await readFile(guardPath, 'utf8')), abandoned);
});

test('fails closed when a guard owner probe is indeterminate', async (t) => {
  const item = await fixture(t, {
    pidProbe: async () => {
      throw new Error('probe unavailable');
    }
  });
  const guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  await writeFile(guardPath, `${JSON.stringify(guardRecord())}\n`, { flag: 'wx' });

  await assert.rejects(
    item.lease.inspect(),
    (error) => error.code === 'workspace-lease-busy'
  );
  assert.equal(JSON.parse(await readFile(guardPath, 'utf8')).guardId, GUARD_ID_1);
});

test('guard recovery compare-check never removes a replaced guard', async (t) => {
  let guardPath;
  const replacement = guardRecord({ guardId: GUARD_ID_2, pid: process.pid });
  const item = await fixture(t, {
    pidProbe: async (pid) => {
      if (pid === 4321) {
        await writeFile(guardPath, `${JSON.stringify(replacement)}\n`, 'utf8');
        return false;
      }
      return true;
    }
  });
  guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  await writeFile(guardPath, `${JSON.stringify(guardRecord())}\n`, { flag: 'wx' });

  await assert.rejects(
    item.lease.inspect(),
    (error) => error.code === 'lease-guard-recovery-conflict'
  );
  assert.deepEqual(JSON.parse(await readFile(guardPath, 'utf8')), replacement);
  assert.equal(
    (await readdir(item.archiveDirectory)).some((name) => name.includes(GUARD_ID_1)),
    false
  );
});

test('rejects corrupted guard evidence instead of guessing it is stale', async (t) => {
  const item = await fixture(t, { pidProbe: async () => false });
  const guardPath = path.join(item.stateDirectory, '.workspace-lease.guard');
  await writeFile(guardPath, '{"pid":', { flag: 'wx' });

  await assert.rejects(
    item.lease.inspect(),
    (error) => error.code === 'workspace-lease-guard-corruption'
  );
});

test('simultaneous acquirers cannot both own the workspace', async (t) => {
  const item = await fixture(t);
  const contender = new WorkspaceLease(item.root, {
    clock: () => new Date('2026-09-05T00:00:00.000Z'),
    pidProbe: async () => true,
    idFactory: () => LEASE_ID_2,
    tokenFactory: () => TOKEN_2,
    defaultTtlMs: 10_000
  });

  const outcomes = await Promise.allSettled([
    item.lease.acquire({ runId: 'run-a', pid: 1001 }),
    contender.acquire({ runId: 'run-b', pid: 1002 })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.ok(['workspace-lease-busy', 'workspace-lease-held'].includes(rejected.reason.code));

  const persisted = JSON.parse(await readFile(item.leasePath, 'utf8'));
  assert.ok(['run-a', 'run-b'].includes(persisted.runId));
});

test('rejects orphaned atomic-update files before any lease operation', async (t) => {
  const item = await fixture(t);
  const orphan = path.join(item.stateDirectory, `.workspace-lease.${LEASE_ID_1}.orphan.tmp`);
  await writeFile(orphan, '{"partial":', 'utf8');

  await assert.rejects(
    item.lease.inspect(),
    (error) => error.code === 'orphan-temporary-lease'
  );
  await assert.rejects(
    item.lease.acquire({ runId: 'run-1' }),
    (error) => error.code === 'orphan-temporary-lease'
  );
});

test('a partial guard temp is detectable and never becomes the canonical guard', async (t) => {
  const item = await fixture(t);
  const partial = path.join(
    item.stateDirectory,
    `.workspace-lease.guard.${GUARD_ID_1}.tmp`
  );
  await writeFile(partial, '{"schemaVersion":1,"guardId":', 'utf8');

  await assert.rejects(
    item.lease.inspect(),
    (error) => error.code === 'orphan-temporary-lease'
  );
  await assert.rejects(
    lstat(path.join(item.stateDirectory, '.workspace-lease.guard')),
    (error) => error.code === 'ENOENT'
  );
  assert.equal(await readFile(partial, 'utf8'), '{"schemaVersion":1,"guardId":');
});

test('rejects corrupted, unsupported, and unsafe lease files', async (t) => {
  const corrupted = await fixture(t);
  await writeFile(corrupted.leasePath, '{"schemaVersion":', 'utf8');
  await assert.rejects(
    corrupted.lease.inspect(),
    (error) => error.code === 'workspace-lease-corruption'
  );

  const unsupported = await fixture(t);
  await writeFile(unsupported.leasePath, `${JSON.stringify({ schemaVersion: 99 })}\n`, 'utf8');
  await assert.rejects(
    unsupported.lease.inspect(),
    (error) => error.code === 'workspace-lease-corruption'
      || error.code === 'unsupported-workspace-lease-schema'
  );

  const unsafe = await fixture(t);
  const target = path.join(unsafe.root, 'outside-lease.json');
  await writeFile(target, '{}\n', 'utf8');
  try {
    await symlink(target, unsafe.leasePath, 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.diagnostic('Skipping symlink subcase because this Windows account cannot create file symlinks.');
      return;
    }
    throw error;
  }
  await assert.rejects(
    unsafe.lease.inspect(),
    (error) => error.code === 'unsafe-workspace-lease-path'
  );
});

test('rejects tampered v2 owner identities and evaluation run aliases', async (t) => {
  const mismatchedRun = await fixture(t);
  await mismatchedRun.lease.acquire({ runId: 'run-original', pid: 1234 });
  const runRecord = JSON.parse(await readFile(mismatchedRun.leasePath, 'utf8'));
  runRecord.ownerId = 'run-tampered';
  await writeFile(mismatchedRun.leasePath, `${JSON.stringify(runRecord)}\n`, 'utf8');
  await assert.rejects(
    mismatchedRun.lease.inspect(),
    (error) => error.code === 'workspace-lease-corruption'
      && error.details.reason.includes('runId must equal ownerId')
  );

  const disguisedEvaluation = await fixture(t);
  await disguisedEvaluation.lease.acquire({
    ownerKind: 'evaluation',
    ownerId: 'evaluation-original',
    pid: 1234
  });
  const evaluationRecord = JSON.parse(await readFile(disguisedEvaluation.leasePath, 'utf8'));
  evaluationRecord.runId = 'fake-run';
  await writeFile(
    disguisedEvaluation.leasePath,
    `${JSON.stringify(evaluationRecord)}\n`,
    'utf8'
  );
  await assert.rejects(
    disguisedEvaluation.lease.inspect(),
    (error) => error.code === 'workspace-lease-corruption'
      && error.details.reason.includes('schema version 2')
  );

  const invalidKind = await fixture(t);
  await invalidKind.lease.acquire({ runId: 'run-original', pid: 1234 });
  const invalidKindRecord = JSON.parse(await readFile(invalidKind.leasePath, 'utf8'));
  invalidKindRecord.ownerKind = 'planner';
  await writeFile(invalidKind.leasePath, `${JSON.stringify(invalidKindRecord)}\n`, 'utf8');
  await assert.rejects(
    invalidKind.lease.inspect(),
    (error) => error.code === 'workspace-lease-corruption'
      && error.details.reason.includes('ownerKind')
  );
});

test('rejects backwards clocks and invalid public inputs', async (t) => {
  const item = await fixture(t);
  await assert.rejects(
    item.lease.acquire({ runId: '', pid: 1 }),
    (error) => error.code === 'invalid-run-id'
  );
  await assert.rejects(
    item.lease.acquire({ runId: 'run', pid: 0 }),
    (error) => error.code === 'invalid-pid'
  );
  await assert.rejects(
    item.lease.acquire({ runId: 'run', ttlMs: 0 }),
    (error) => error.code === 'invalid-lease-ttl'
  );
  await assert.rejects(
    item.lease.acquire({ ownerKind: 'planner', ownerId: 'plan-1' }),
    (error) => error.code === 'invalid-owner-kind'
  );
  await assert.rejects(
    item.lease.acquire({ ownerKind: 'evaluation' }),
    (error) => error.code === 'invalid-lease-owner'
  );
  await assert.rejects(
    item.lease.acquire({ ownerKind: 'evaluation', ownerId: '' }),
    (error) => error.code === 'invalid-owner-id'
  );
  await assert.rejects(
    item.lease.acquire({
      ownerKind: 'evaluation',
      ownerId: 'evaluation-1',
      runId: 'fake-run'
    }),
    (error) => error.code === 'invalid-lease-owner'
  );
  await assert.rejects(
    item.lease.acquire({
      ownerKind: 'integration',
      ownerId: 'integration-1',
      runId: 'fake-run'
    }),
    (error) => error.code === 'invalid-lease-owner'
  );
  await assert.rejects(
    item.lease.acquire({
      ownerKind: 'reversion',
      ownerId: 'reversion-1',
      runId: 'fake-run'
    }),
    (error) => error.code === 'invalid-lease-owner'
  );
  await assert.rejects(
    item.lease.acquire({
      ownerKind: 'run',
      ownerId: 'run-owner',
      runId: 'different-run'
    }),
    (error) => error.code === 'invalid-lease-owner'
  );

  await item.lease.acquire({ runId: 'run', pid: 1234 });
  item.setNow('2026-09-04T23:59:59.000Z');
  await assert.rejects(
    item.lease.heartbeat({ leaseId: LEASE_ID_1, ownerToken: TOKEN_1 }),
    (error) => error.code === 'lease-clock-regression'
  );
});
