import test from 'node:test';
import assert from 'node:assert/strict';
import { retryUnstartedLeaseOperation } from '../src/application/lease-guard-retry.js';

test('editor lease retry waits for short guard contention before one successful operation', async () => {
  let attempts = 0, effects = 0;
  const result = await retryUnstartedLeaseOperation({}, async () => {
    if (++attempts < 3) throw Object.assign(new Error('inspection in progress'), { code: 'workspace-lease-busy' });
    effects++; return { held: false };
  });
  assert.deepEqual(result, { held: false }); assert.equal(attempts, 3); assert.equal(effects, 1);
});

test('editor lease retry remains bounded for a persistent guard', async () => {
  let attempts = 0;
  const failure = Object.assign(new Error('busy'), { code: 'workspace-lease-busy' });
  await assert.rejects(retryUnstartedLeaseOperation({}, async () => { attempts++; throw failure; }), error => error === failure);
  assert.equal(attempts, 9);
});

test('editor lease retry never replays held, uncertain or partially completed operations', async () => {
  for (const fields of [
    { code: 'workspace-lease-held' }, { code: 'FWA_PROCESS_TERMINATION_UNCONFIRMED' },
    { code: 'workspace-lease-busy', recoveryGuardId: 'owned' },
    { code: 'workspace-lease-busy', recoveryResult: {} },
    { code: 'workspace-lease-busy', details: { operationCompleted: true } }
  ]) {
    let attempts = 0; const failure = Object.assign(new Error('must remain blocked'), fields);
    await assert.rejects(retryUnstartedLeaseOperation({}, async () => { attempts++; throw failure; }), error => error === failure);
    assert.equal(attempts, 1);
  }
});
