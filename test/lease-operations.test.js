import assert from 'node:assert/strict';
import test from 'node:test';
import { settleLeaseOperation, startLeaseHeartbeat } from '../src/application/lease-operations.js';

test('lease recovery preserves successful results and releases only the owned guard', async () => {
  assert.equal(await settleLeaseOperation({}, async () => 7), 7);
  const calls = [];
  const failure = Object.assign(new Error('guard removal failed'), {
    recoveryGuardId: 'owned', recoveryResult: { held: true }
  });
  const value = await settleLeaseOperation({ releaseOwnedGuard: async (request) => calls.push(request) },
    async () => { throw failure; });
  assert.deepEqual(value, { held: true });
  assert.deepEqual(calls, [{ expectedGuardId: 'owned' }]);
});

test('lease recovery never hides the original failure when ownership recovery fails', async () => {
  const original = Object.assign(new Error('original'), { recoveryGuardId: 'owned' });
  const recovery = new Error('still locked');
  await assert.rejects(settleLeaseOperation({ releaseOwnedGuard: async () => { throw recovery; } },
    async () => { throw original; }), (error) => error === original && error.guardRecoveryError === recovery);
  const ordinary = new Error('not recoverable');
  await assert.rejects(settleLeaseOperation({}, async () => { throw ordinary; }), (error) => error === ordinary);
});

test('shared heartbeat propagates external abort and stops without renewing a cancelled lease', async (t) => {
  t.mock.timers.enable();
  const controller = new AbortController();
  let calls = 0;
  const heartbeat = startLeaseHeartbeat({ heartbeat: async () => { calls++; } }, {
    lease: { leaseId: 'lease' }, ownerToken: 'owner'
  }, 300, controller.signal);
  controller.abort('cancelled');
  t.mock.timers.tick(300);
  await heartbeat.stop();
  assert.equal(heartbeat.signal.aborted, true);
  assert.equal(heartbeat.signal.reason, 'cancelled');
  assert.equal(calls, 0);
});

test('shared heartbeat exposes renewal failure through both its signal and stop', async (t) => {
  t.mock.timers.enable();
  const failure = new Error('lease ownership lost');
  const heartbeat = startLeaseHeartbeat({ heartbeat: async () => { throw failure; } }, {
    lease: { leaseId: 'lease' }, ownerToken: 'owner'
  }, 300);
  t.mock.timers.tick(100);
  await assert.rejects(heartbeat.stop(), (error) => error === failure);
  assert.equal(heartbeat.signal.reason, failure);
});
