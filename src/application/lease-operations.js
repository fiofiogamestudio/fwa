// Internal lease protocol shared by orchestrators. Run keeps its own deadline policy.
export async function settleLeaseOperation(lease, operation) {
  try {
    return await operation();
  } catch (error) {
    if (typeof error?.recoveryGuardId !== 'string'
      || typeof lease.releaseOwnedGuard !== 'function') {
      throw error;
    }
    try {
      await lease.releaseOwnedGuard({ expectedGuardId: error.recoveryGuardId });
    } catch (recoveryError) {
      Object.defineProperty(error, 'guardRecoveryError', {
        value: recoveryError,
        enumerable: false
      });
      throw error;
    }
    if (Object.hasOwn(error, 'recoveryResult')) return error.recoveryResult;
    throw error;
  }
}

export function startLeaseHeartbeat(lease, capability, ttlMs, externalSignal) {
  const controller = new AbortController();
  let heartbeatError = null;
  let inFlight = Promise.resolve();
  const externalAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) externalAbort();
  else externalSignal?.addEventListener('abort', externalAbort, { once: true });
  const beat = () => {
    inFlight = inFlight.then(async () => {
      if (heartbeatError || controller.signal.aborted) return;
      try {
        await settleLeaseOperation(lease, () => lease.heartbeat({
          leaseId: capability.lease.leaseId,
          ownerToken: capability.ownerToken,
          ttlMs
        }));
      } catch (error) {
        heartbeatError = error;
        controller.abort(error);
      }
    });
  };
  const timer = setInterval(beat, Math.max(100, Math.floor(ttlMs / 3)));
  timer.unref?.();
  return {
    signal: controller.signal,
    async stop() {
      clearInterval(timer);
      externalSignal?.removeEventListener('abort', externalAbort);
      await inFlight;
      if (heartbeatError) throw heartbeatError;
    }
  };
}

