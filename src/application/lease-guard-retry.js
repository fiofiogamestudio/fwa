import { settleLeaseOperation } from './lease-operations.js';

// Concurrent editor reads can briefly own the filesystem operation guard. Only
// that pre-operation contention may be retried; held leases and completed or
// uncertain operations retain their original failure and recovery semantics.
export async function retryUnstartedLeaseOperation(lease, operation) {
  const delays = [10, 20, 40, 80, 160, 200, 250, 250];
  for (let attempt = 0; ; attempt += 1) {
    try { return await settleLeaseOperation(lease, operation); }
    catch (error) {
      if (error?.code !== 'workspace-lease-busy' || Object.hasOwn(error, 'recoveryGuardId')
        || Object.hasOwn(error, 'recoveryResult') || error.details?.operationCompleted
        || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}
