import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileEventStore,
  hashCanonicalValue
} from '../src/storage/file-event-store.js';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-event-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileEventStore(root, options);
  await store.init();
  return { root, store, eventsDirectory: path.join(root, '.fwa', 'events') };
}

const STALE_LOCK_ID = '11111111-1111-4111-8111-111111111111';

function lockRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    lockId: STALE_LOCK_ID,
    pid: 424242,
    acquiredAt: '2026-09-05T00:00:00.000Z',
    ...overrides
  };
}

function event(sequence, suffix = String(sequence)) {
  return {
    schemaVersion: 1,
    eventId: `event-${suffix}`,
    type: 'TestRecorded',
    occurredAt: '2026-09-05T00:00:00.000Z',
    streamId: 'test-stream',
    sequence,
    payload: { suffix }
  };
}

function intent(value) {
  return hashCanonicalValue(value);
}

async function append(store, commandId, events, expectedLastSequence, commandIntent = { commandId }) {
  return store.appendBatch(commandId, events, {
    expectedLastSequence,
    intentHash: intent(commandIntent)
  });
}

async function batchFiles(eventsDirectory) {
  return (await readdir(eventsDirectory)).filter((name) => name.endsWith('.json')).sort();
}

async function rewriteBatch(eventsDirectory, name, transform) {
  const filePath = path.join(eventsDirectory, name);
  const batch = JSON.parse(await readFile(filePath, 'utf8'));
  transform(batch);
  await writeFile(filePath, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
}

function rehash(batch) {
  batch.payloadHash = hashCanonicalValue(batch.events);
  const { hash: ignored, ...batchWithoutHash } = batch;
  batch.hash = hashCanonicalValue(batchWithoutHash);
}

test('initializes an empty store and reports its durable position', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-event-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileEventStore(root);

  const initialized = await store.init();
  assert.equal(initialized.created, true);
  assert.deepEqual(await store.verify(), {
    ok: true,
    batchCount: 0,
    eventCount: 0,
    commandCount: 0,
    lastSequence: 0,
    lastBatchHash: '0'.repeat(64)
  });

  const state = await store.readAll();
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.batches, []);
  assert.equal(state.lastSequence, 0);
});

test('atomically appends ordered batches and verifies the hash chain', async (t) => {
  const { store, eventsDirectory } = await fixture(t);

  const first = await append(store, 'command-1', [event(1), event(2)], 0);
  const second = await append(store, 'command-2', [event(3)], 2);

  assert.equal(first.appended, true);
  assert.equal(first.batch.firstSequence, 1);
  assert.equal(first.batch.lastSequence, 2);
  assert.equal(second.batch.previousHash, first.batch.hash);
  assert.equal(second.batch.firstSequence, 3);
  assert.deepEqual(await batchFiles(eventsDirectory), [
    'batch-0000000000000001.json',
    'batch-0000000000000002.json'
  ]);
  assert.equal((await readdir(eventsDirectory)).some((name) => name.endsWith('.tmp')), false);

  const state = await store.readAll();
  assert.deepEqual(state.events.map((item) => item.sequence), [1, 2, 3]);
  assert.equal(state.lastSequence, 3);
  assert.equal(state.lastBatchHash, second.batch.hash);
  assert.deepEqual(await store.verify(), {
    ok: true,
    batchCount: 2,
    eventCount: 3,
    commandCount: 2,
    lastSequence: 3,
    lastBatchHash: second.batch.hash
  });
});

test('batch read-ahead preserves exact event and command order across several windows', async (t) => {
  const { store } = await fixture(t), expected = [];
  for (let sequence = 1; sequence <= 9; sequence += 1) {
    const item = event(sequence, sequence % 3 === 0 ? 'large'.repeat(20000) : String(sequence));
    expected.push(await append(store, `command-${sequence}`, [item], sequence - 1));
  }
  const state = await store.readAll();
  assert.deepEqual(state.batches, expected.map(result => result.batch));
  assert.deepEqual(state.events, expected.flatMap(result => result.batch.events));
  assert.equal(state.lastBatchHash, expected.at(-1).batch.hash);
  assert.equal(state.lastSequence, 9);
});

test('batch read-ahead reports the earliest integrity failure before a later JSON failure', async (t) => {
  for (const [firstBad, laterBad] of [[2, 4], [5, 8]]) {
    await t.test(`corrupt batch ${firstBad} before malformed batch ${laterBad}`, async subtest => {
      const { store, eventsDirectory } = await fixture(subtest);
      for (let sequence = 1; sequence <= 8; sequence += 1) {
        await append(store, `command-${sequence}`, [event(sequence)], sequence - 1);
      }
      const names = await batchFiles(eventsDirectory);
      await rewriteBatch(eventsDirectory, names[firstBad - 1], batch => { batch.events[0].payload.suffix = 'tampered'; });
      await writeFile(path.join(eventsDirectory, names[laterBad - 1]), '{invalid JSON');
      const firstFailure = error => error.code === 'payload-hash-mismatch' && error.message.includes(names[firstBad - 1]);
      await assert.rejects(store.readAll(), firstFailure);
      await assert.rejects(store.verify(), firstFailure);
      await assert.rejects(append(store, 'after-corruption', [event(9)], 8), firstFailure);
      assert.equal((await store.inspectLock()).held, false, 'failed append releases its own writer lock');
      assert.deepEqual(await batchFiles(eventsDirectory), names, 'failed verification publishes no transaction');
    });
  }
});

test('a filename sequence gap takes priority over that prefetched file being malformed', async t => {
  const { store, eventsDirectory } = await fixture(t);
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    await append(store, `command-${sequence}`, [event(sequence)], sequence - 1);
  }
  const names = await batchFiles(eventsDirectory);
  await unlink(path.join(eventsDirectory, names[4]));
  await writeFile(path.join(eventsDirectory, names[5]), '{invalid JSON');
  await assert.rejects(store.readAll(), error => error.code === 'batch-sequence-gap'
    && error.details.expected === 5 && error.details.actual === 6);
});

test('a later read verifies previously read batches again and detects new corruption', async t => {
  const { store, eventsDirectory } = await fixture(t);
  for (let sequence = 1; sequence <= 6; sequence += 1) {
    await append(store, `command-${sequence}`, [event(sequence)], sequence - 1);
  }
  assert.equal((await store.readAll()).lastSequence, 6);
  const names = await batchFiles(eventsDirectory);
  await rewriteBatch(eventsDirectory, names[5], batch => { batch.events[0].payload.suffix = 'changed after read'; });
  await assert.rejects(store.readAll(), error => error.code === 'payload-hash-mismatch');
});

test('returns the recorded batch for the same command intent without comparing regenerated events', async (t) => {
  const { store, eventsDirectory } = await fixture(t);
  const commandIntent = { type: 'goal.create', title: 'Build it' };
  const original = await append(store, 'command-1', [event(1, 'original-random-id')], 0, commandIntent);

  const retry = await append(
    store,
    'command-1',
    [event(99, 'different-random-id')],
    99,
    commandIntent
  );

  assert.equal(retry.appended, false);
  assert.deepEqual(retry.batch, original.batch);
  assert.deepEqual(await batchFiles(eventsDirectory), ['batch-0000000000000001.json']);
  assert.equal((await store.readAll()).lastSequence, 1);
});

test('rejects command id reuse with a different intent', async (t) => {
  const { store } = await fixture(t);
  await append(store, 'command-1', [event(1)], 0, { title: 'first' });

  await assert.rejects(
    append(store, 'command-1', [event(2)], 1, { title: 'different' }),
    (error) => error.code === 'idempotency-conflict'
  );
  assert.equal((await store.readAll()).lastSequence, 1);
});

test('checks the optimistic sequence after taking the writer lock', async (t) => {
  const { store } = await fixture(t);
  await append(store, 'command-1', [event(1)], 0);

  await assert.rejects(
    append(store, 'command-2', [event(2)], 0),
    (error) => error.code === 'concurrency-conflict' && error.details.actualLastSequence === 1
  );
});

test('rejects a gap in caller-assigned event sequences', async (t) => {
  const { store } = await fixture(t);

  await assert.rejects(
    append(store, 'command-1', [event(2)], 0),
    (error) => error.code === 'event-sequence-gap'
  );
  assert.equal((await store.readAll()).lastSequence, 0);
});

test('uses an exclusive lock file for the single writer rule', async (t) => {
  const { store, eventsDirectory } = await fixture(t);
  const lockPath = path.join(eventsDirectory, '.lock');
  await writeFile(lockPath, '{}\n', { flag: 'wx' });

  await assert.rejects(
    append(store, 'command-1', [event(1)], 0),
    (error) => error.code === 'event-store-locked'
  );
  await assert.rejects(
    store.readAll(),
    (error) => error.code === 'event-store-locked'
  );
  await assert.rejects(
    store.verify(),
    (error) => error.code === 'event-store-locked'
  );

  await unlink(lockPath);
  assert.equal((await append(store, 'command-1', [event(1)], 0)).appended, true);
});

test('releaseOwnedLock removes only the exact lock published by this process', async (t) => {
  const { store, eventsDirectory } = await fixture(t);
  const lockPath = path.join(eventsDirectory, '.lock');
  await writeFile(lockPath, `${JSON.stringify(lockRecord({ pid: process.pid }))}\n`);
  assert.deepEqual(
    await store.releaseOwnedLock({ expectedLockId: STALE_LOCK_ID }),
    { released: true, lockId: STALE_LOCK_ID }
  );
  assert.equal((await store.verify()).ok, true);

  await writeFile(lockPath, `${JSON.stringify(lockRecord({ pid: process.pid + 1 }))}\n`);
  await assert.rejects(
    store.releaseOwnedLock({ expectedLockId: STALE_LOCK_ID }),
    (error) => error.code === 'lock-release-conflict'
  );
  assert.equal((await readFile(lockPath, 'utf8')).includes(STALE_LOCK_ID), true);
  await unlink(lockPath);
});

test('fails explicitly when an orphaned temporary batch is present', async (t) => {
  const { store, eventsDirectory } = await fixture(t);
  await writeFile(path.join(eventsDirectory, '.batch-interrupted.tmp'), '{"partial":', 'utf8');

  await assert.rejects(
    store.readAll(),
    (error) => error.code === 'orphan-temporary-batch'
  );
  await assert.rejects(
    store.verify(),
    (error) => error.code === 'orphan-temporary-batch'
  );
  await assert.rejects(
    append(store, 'command-1', [event(1)], 0),
    (error) => error.code === 'orphan-temporary-batch'
  );
});

test('detects payload corruption', async (t) => {
  const { store, eventsDirectory } = await fixture(t);
  await append(store, 'command-1', [event(1)], 0);
  const [name] = await batchFiles(eventsDirectory);
  await rewriteBatch(eventsDirectory, name, (batch) => {
    batch.events[0].payload.suffix = 'tampered';
  });

  await assert.rejects(
    store.verify(),
    (error) => error.code === 'payload-hash-mismatch'
  );
});

test('detects a broken previous-hash chain even if the edited batch is rehashed', async (t) => {
  const { store, eventsDirectory } = await fixture(t);
  await append(store, 'command-1', [event(1)], 0);
  await append(store, 'command-2', [event(2)], 1);
  const [firstName] = await batchFiles(eventsDirectory);
  await rewriteBatch(eventsDirectory, firstName, (batch) => {
    batch.events[0].payload.suffix = 'rewritten-and-rehashed';
    rehash(batch);
  });

  await assert.rejects(
    store.verify(),
    (error) => error.code === 'previous-hash-mismatch'
  );
});

test('detects persisted event sequence corruption even if hashes are recomputed', async (t) => {
  const { store, eventsDirectory } = await fixture(t);
  await append(store, 'command-1', [event(1)], 0);
  const [name] = await batchFiles(eventsDirectory);
  await rewriteBatch(eventsDirectory, name, (batch) => {
    batch.events[0].sequence = 2;
    batch.firstSequence = 2;
    batch.lastSequence = 2;
    rehash(batch);
  });

  await assert.rejects(
    store.verify(),
    (error) => error.code === 'event-sequence-gap'
  );
});

test('detects a missing transaction batch by its file sequence', async (t) => {
  const { store, eventsDirectory } = await fixture(t);
  await append(store, 'command-1', [event(1)], 0);
  await append(store, 'command-2', [event(2)], 1);
  const [firstName] = await batchFiles(eventsDirectory);
  await unlink(path.join(eventsDirectory, firstName));

  await assert.rejects(
    store.verify(),
    (error) => error.code === 'batch-sequence-gap'
  );
});

test('fails explicitly on malformed JSON and unsupported schemas', async (t) => {
  const malformed = await fixture(t);
  await writeFile(
    path.join(malformed.eventsDirectory, 'batch-0000000000000001.json'),
    '{"schemaVersion":',
    'utf8'
  );
  await assert.rejects(
    malformed.store.verify(),
    (error) => error.code === 'event-store-corruption'
  );

  const unsupported = await fixture(t);
  await writeFile(
    path.join(unsupported.eventsDirectory, 'batch-0000000000000001.json'),
    JSON.stringify({ schemaVersion: 99 }),
    'utf8'
  );
  await assert.rejects(
    unsupported.store.verify(),
    (error) => error.code === 'unsupported-event-store-schema'
  );
});

test('explicit recovery archives a dead-owner lock and incomplete batch evidence', async (t) => {
  const { store, eventsDirectory } = await fixture(t, {
    pidProbe: async () => false,
    clock: () => new Date('2026-09-05T00:01:00.000Z')
  });
  await writeFile(path.join(eventsDirectory, '.lock'), `${JSON.stringify(lockRecord())}\n`);
  await writeFile(path.join(eventsDirectory, '.batch-interrupted.tmp'), 'partial');

  const inspected = await store.inspectLock();
  assert.equal(inspected.stale, true);
  const recovered = await store.recoverStaleLock({ expectedLockId: STALE_LOCK_ID });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.archivedFiles.length, 1);
  assert.equal((await store.readAll()).events.length, 0);
  assert.ok((await readdir(path.join(eventsDirectory, 'recovery'))).length >= 2);
});

test('event-lock recovery never steals from a live or indeterminate owner', async (t) => {
  const live = await fixture(t, { pidProbe: async () => true });
  await writeFile(
    path.join(live.eventsDirectory, '.lock'),
    `${JSON.stringify(lockRecord())}\n`
  );
  await assert.rejects(
    live.store.recoverStaleLock(),
    (error) => error.code === 'event-store-lock-not-stale'
  );

  const unknown = await fixture(t, { pidProbe: async () => { throw new Error('denied'); } });
  await writeFile(
    path.join(unknown.eventsDirectory, '.lock'),
    `${JSON.stringify(lockRecord())}\n`
  );
  await assert.rejects(
    unknown.store.recoverStaleLock(),
    (error) => error.code === 'event-store-lock-not-stale'
  );
});

test('recovers an orphaned complete lock-publication temp behind an exclusive fence', async (t) => {
  const { store, eventsDirectory } = await fixture(t, {
    pidProbe: async () => false,
    clock: () => new Date('2026-09-05T00:01:00.000Z')
  });
  const publication = path.join(eventsDirectory, `.lock.${STALE_LOCK_ID}.tmp`);
  await writeFile(publication, `${JSON.stringify(lockRecord())}\n`);

  const inspected = await store.inspectLock();
  assert.equal(inspected.published, false);
  assert.equal(inspected.stale, true);
  const recovered = await store.recoverStaleLock({ expectedLockId: STALE_LOCK_ID });
  assert.equal(recovered.recovered, true);
  assert.match(recovered.archivedPublicationPath, /publication-temp\.json$/);
  assert.equal((await store.verify()).ok, true);
});

test('stale-lock recovery compare guard and claim allow at most one winner', async (t) => {
  const { root, store, eventsDirectory } = await fixture(t, {
    pidProbe: async () => false
  });
  await append(store, 'committed-before-crash', [event(1)], 0);
  await writeFile(path.join(eventsDirectory, '.lock'), `${JSON.stringify(lockRecord())}\n`);

  await assert.rejects(
    store.recoverStaleLock({ expectedLockId: '22222222-2222-4222-8222-222222222222' }),
    (error) => error.code === 'lock-recovery-conflict'
  );

  const other = new FileEventStore(root, { pidProbe: async () => false });
  const outcomes = await Promise.allSettled([
    store.recoverStaleLock({ expectedLockId: STALE_LOCK_ID }),
    other.recoverStaleLock({ expectedLockId: STALE_LOCK_ID })
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value.recovered).length,
    1
  );
  assert.equal((await store.readAll()).events.length, 1);
});

test('recovery archives a matching publication temp left beside the canonical lock', async (t) => {
  const { store, eventsDirectory } = await fixture(t, {
    pidProbe: async () => false,
    clock: () => new Date('2026-09-05T00:02:00.000Z')
  });
  const source = `${JSON.stringify(lockRecord())}\n`;
  await writeFile(path.join(eventsDirectory, '.lock'), source);
  await writeFile(path.join(eventsDirectory, `.lock.${STALE_LOCK_ID}.tmp`), source);

  const recovered = await store.recoverStaleLock();
  assert.equal(recovered.archivedMatchingPublications.length, 1);
  assert.equal((await store.verify()).ok, true);
});

test('a dead recovery owner does not permanently wedge the recovery claim', async (t) => {
  const { store, eventsDirectory } = await fixture(t, {
    pidProbe: async () => false,
    clock: () => new Date('2026-09-05T00:03:00.000Z')
  });
  await writeFile(path.join(eventsDirectory, '.lock'), `${JSON.stringify(lockRecord())}\n`);
  const abandonedClaim = {
    schemaVersion: 1,
    claimId: '33333333-3333-4333-8333-333333333333',
    lockId: STALE_LOCK_ID,
    pid: 525252,
    acquiredAt: '2026-09-05T00:01:00.000Z'
  };
  await writeFile(
    path.join(eventsDirectory, 'recovery', `.claim-${STALE_LOCK_ID}`),
    `${JSON.stringify(abandonedClaim)}\n`
  );

  assert.equal((await store.recoverStaleLock()).recovered, true);
  assert.equal((await store.verify()).ok, true);
});

test('resumes stale-claim recovery after its evidence hardlink was published', async (t) => {
  const { store, eventsDirectory } = await fixture(t, {
    pidProbe: async () => false,
    clock: () => new Date('2026-09-05T00:04:00.000Z')
  });
  await writeFile(path.join(eventsDirectory, '.lock'), `${JSON.stringify(lockRecord())}\n`);
  const abandonedClaim = {
    schemaVersion: 1,
    claimId: '33333333-3333-4333-8333-333333333333',
    lockId: STALE_LOCK_ID,
    pid: 525252,
    acquiredAt: '2026-09-05T00:01:00.000Z'
  };
  const recoveryDirectory = path.join(eventsDirectory, 'recovery');
  const claimPath = path.join(recoveryDirectory, `.claim-${STALE_LOCK_ID}`);
  const evidencePath = path.join(
    recoveryDirectory,
    `.stale-claim-${abandonedClaim.claimId}`
  );
  await writeFile(claimPath, `${JSON.stringify(abandonedClaim)}\n`);
  await link(claimPath, evidencePath);

  assert.equal((await store.recoverStaleLock()).recovered, true);
  assert.equal((await store.verify()).ok, true);
  const entries = await readdir(recoveryDirectory);
  assert.equal(entries.includes(path.basename(claimPath)), false);
  assert.equal(entries.includes(path.basename(evidencePath)), false);
  assert.equal(entries.some((name) => name.endsWith('--stale-claim.json')), true);
  assert.equal(entries.some((name) => name.endsWith('.takeover')), false);
});

test('concurrent stale-claim resumptions have one recovery winner', async (t) => {
  const { root, store, eventsDirectory } = await fixture(t, {
    pidProbe: async () => false,
    clock: () => new Date('2026-09-05T00:05:00.000Z')
  });
  await writeFile(path.join(eventsDirectory, '.lock'), `${JSON.stringify(lockRecord())}\n`);
  const abandonedClaim = {
    schemaVersion: 1,
    claimId: '33333333-3333-4333-8333-333333333333',
    lockId: STALE_LOCK_ID,
    pid: 525252,
    acquiredAt: '2026-09-05T00:01:00.000Z'
  };
  const recoveryDirectory = path.join(eventsDirectory, 'recovery');
  const claimPath = path.join(recoveryDirectory, `.claim-${STALE_LOCK_ID}`);
  await writeFile(claimPath, `${JSON.stringify(abandonedClaim)}\n`);
  await link(
    claimPath,
    path.join(recoveryDirectory, `.stale-claim-${abandonedClaim.claimId}`)
  );
  const contender = new FileEventStore(root, {
    pidProbe: async () => false,
    clock: () => new Date('2026-09-05T00:05:00.000Z')
  });

  const outcomes = await Promise.allSettled([
    store.recoverStaleLock(),
    contender.recoverStaleLock()
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled'
      && outcome.value.recovered).length,
    1
  );
  assert.equal((await store.verify()).ok, true);
});

test('stale-claim resume rejects copied evidence without deleting canonical claim', async (t) => {
  const { store, eventsDirectory } = await fixture(t, { pidProbe: async () => false });
  await writeFile(path.join(eventsDirectory, '.lock'), `${JSON.stringify(lockRecord())}\n`);
  const abandonedClaim = {
    schemaVersion: 1,
    claimId: '33333333-3333-4333-8333-333333333333',
    lockId: STALE_LOCK_ID,
    pid: 525252,
    acquiredAt: '2026-09-05T00:01:00.000Z'
  };
  const recoveryDirectory = path.join(eventsDirectory, 'recovery');
  const claimPath = path.join(recoveryDirectory, `.claim-${STALE_LOCK_ID}`);
  const source = `${JSON.stringify(abandonedClaim)}\n`;
  await writeFile(claimPath, source);
  await writeFile(
    path.join(recoveryDirectory, `.stale-claim-${abandonedClaim.claimId}`),
    source
  );

  await assert.rejects(
    store.recoverStaleLock(),
    (error) => error.code === 'lock-recovery-conflict'
  );
  assert.deepEqual(JSON.parse(await readFile(claimPath, 'utf8')), abandonedClaim);
});
