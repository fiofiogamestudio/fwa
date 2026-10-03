import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceLease } from '../src/storage/workspace-lease.js';

const record = { schemaVersion: 1, guardId: '33333333-3333-4333-8333-333333333333', pid: process.pid,
  acquiredAt: '2026-09-19T00:00:00.000Z' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwa-guard-probe-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
  const lease = new WorkspaceLease(root); await lease.init();
  const guardPath = path.join(root, '.fwa', '.workspace-lease.guard');
  await fs.writeFile(guardPath, JSON.stringify(record), { flag: 'wx' });
  return { lease, guardPath };
}
async function withFsHook(name, hook, action) {
  const original = fs[name]; fs[name] = (...args) => hook(original, ...args); syncBuiltinESMExports();
  try { return await action(); }
  finally { fs[name] = original; syncBuiltinESMExports(); }
}

test('a guard released after publication collision can be acquired once without a false read failure', async t => {
  const { lease, guardPath } = await fixture(t); let publications = 0, released = false;
  await withFsHook('link', async (original, source, target) => {
    if (target === guardPath) publications++;
    try { return await original(source, target); }
    catch (error) {
      if (target === guardPath && error.code === 'EEXIST' && !released) {
        released = true; await fs.unlink(guardPath); // The existing operation releases its guard before stale-owner probing.
      }
      throw error;
    }
  }, async () => assert.equal((await lease.inspect()).held, false));
  assert.equal(released, true); assert.equal(publications, 2);
  await assert.rejects(fs.lstat(guardPath), { code: 'ENOENT' });
});

test('a guard released between probe lstat and read is absent rather than corrupt JSON', async t => {
  const { lease, guardPath } = await fixture(t); let released = false;
  await withFsHook('readFile', async (original, file, ...args) => {
    if (file === guardPath && !released) { released = true; await fs.unlink(guardPath); }
    return original(file, ...args);
  }, async () => assert.equal((await lease.inspect()).held, false));
  assert.equal(released, true); await assert.rejects(fs.lstat(guardPath), { code: 'ENOENT' });
});

test('permission failures while probing an existing guard remain failures and preserve the guard', async t => {
  for (const operation of ['lstat', 'readFile']) {
    const { lease, guardPath } = await fixture(t);
    await withFsHook(operation, async (original, file, ...args) => {
      if (file === guardPath) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
      return original(file, ...args);
    }, () => assert.rejects(lease.inspect(), error => error.cause?.code === 'EACCES'
      && error.code === (operation === 'lstat' ? 'lease-guard-read-failed' : 'workspace-lease-guard-corruption')));
    assert.deepEqual(JSON.parse(await fs.readFile(guardPath, 'utf8')), record);
  }
});

test('a replacement guard still fences the bounded publication retry', async t => {
  const { lease, guardPath } = await fixture(t); let publications = 0;
  const replacement = { ...record, guardId: '44444444-4444-4444-4444-444444444444' };
  await withFsHook('link', async (original, source, target) => {
    if (target === guardPath && ++publications === 2) await fs.writeFile(guardPath, JSON.stringify(replacement), { flag: 'wx' });
    try { return await original(source, target); }
    catch (error) {
      if (target === guardPath && publications === 1 && error.code === 'EEXIST') await fs.unlink(guardPath);
      throw error;
    }
  }, () => assert.rejects(lease.inspect(), { code: 'workspace-lease-busy' }));
  assert.equal(publications, 2); assert.deepEqual(JSON.parse(await fs.readFile(guardPath, 'utf8')), replacement);
});
