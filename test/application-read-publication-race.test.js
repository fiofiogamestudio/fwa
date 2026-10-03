import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FwaApplication } from '../src/application/fwa-application.js';
import { FileEventStoreError } from '../src/storage/file-event-store.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwa-read-publication-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const app = new FwaApplication(root); await app.init();
  await app.createGoal({ title: 'Baseline', commandId: 'baseline' });
  return { root, app, events: path.join(root, '.fwa', 'events') };
}
async function fileSnapshot(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.filter(item => item.isFile()).map(async item =>
    [item.name, (await fs.readFile(path.join(directory, item.name))).toString('base64')])));
}

test('status replays the verified store after a real lock publication completes', async t => {
  const { root, app: writer, events } = await fixture(t), reader = new FwaApplication(root);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const originalLink = fs.link;
  fs.link = async (source, target) => {
    if (target === writer.store.lockPath) { entered(); await blocked; }
    return originalLink(source, target);
  };
  syncBuiltinESMExports();
  const writing = writer.createGoal({ title: 'Published result', commandId: 'published-result' });
  try {
    await started;
    // The durable store itself remains strict; only the application read boundary waits.
    await assert.rejects(reader.store.readAll(), { code: 'orphan-temporary-lock' });
    const originalRead = reader.store.readAll.bind(reader.store), failures = []; let reads = 0;
    reader.store.readAll = async () => {
      reads++;
      try { return await originalRead(); }
      catch (error) { failures.push(error.code); if (error.code === 'orphan-temporary-lock') release(); throw error; }
    };
    const status = await reader.getStatus(); await writing;
    assert.ok(failures.includes('orphan-temporary-lock')); assert.ok(reads >= 2 && reads <= reader.lockRetryDelays.length + 1);
    assert.deepEqual(status.goals.map(goal => goal.title).sort(), ['Baseline', 'Published result']);
    assert.equal(status.eventCount, 2);
    assert.ok((await fs.readdir(events)).every(name => !name.endsWith('.tmp') && name !== '.lock'));
  } finally {
    release(); await writing; fs.link = originalLink; syncBuiltinESMExports();
  }
});

test('a persistent publication temp exhausts the existing read budget without deleting or writing anything', async t => {
  const { app, events } = await fixture(t);
  const name = '.lock.33333333-3333-4333-8333-333333333333.tmp';
  await fs.writeFile(path.join(events, name), '{"schemaVersion":');
  const before = await fileSnapshot(events), originalRead = app.store.readAll.bind(app.store); let reads = 0;
  app.store.readAll = () => { reads++; return originalRead(); };
  assert.equal(app.lockRetryDelays.reduce((total, delay) => total + delay, 0), 565);
  await assert.rejects(app.getStatus(), error => error.code === 'orphan-temporary-lock'
    && error.details.files.length === 1 && error.details.files[0] === name);
  assert.equal(reads, app.lockRetryDelays.length + 1);
  assert.deepEqual(await fileSnapshot(events), before);
});

test('verified batch corruption still fails on the first status read', async t => {
  const { app, events } = await fixture(t);
  const batchName = (await fs.readdir(events)).find(name => name.startsWith('batch-'));
  const target = path.join(events, batchName), batch = JSON.parse(await fs.readFile(target, 'utf8'));
  batch.events[0].payload.title = 'Tampered'; await fs.writeFile(target, JSON.stringify(batch));
  const before = await fileSnapshot(events), originalRead = app.store.readAll.bind(app.store); let reads = 0;
  app.store.readAll = () => { reads++; return originalRead(); };
  await assert.rejects(app.getStatus(), { code: 'payload-hash-mismatch' });
  assert.equal(reads, 1); assert.deepEqual(await fileSnapshot(events), before);
});

test('the write boundary never retries an orphan-publication error', async t => {
  const { app, events } = await fixture(t), before = await fileSnapshot(events);
  const failure = new FileEventStoreError('Publication residue', 'orphan-temporary-lock'); let writes = 0;
  app.store.appendBatch = async () => { writes++; throw failure; };
  await assert.rejects(app.createGoal({ title: 'Must not replay', commandId: 'write-failure' }), error => error === failure);
  assert.equal(writes, 1); assert.deepEqual(await fileSnapshot(events), before);
});
