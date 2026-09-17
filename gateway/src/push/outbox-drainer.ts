import type { PushDeliveryRequest, PushDeliveryService, PushFailure, PushResult } from "./contracts.js";

export interface PushOutboxQueue {
  claim(
    limit: number,
    leaseMs: number,
    now: Date,
    signal: AbortSignal,
  ): Promise<PushResult<ReadonlyArray<PushDeliveryRequest>>>;
  complete(deliveryId: string, now: Date): Promise<void>;
  drop(deliveryId: string, failure: PushFailure, now: Date): Promise<void>;
  retry(deliveryId: string, failure: PushFailure, nextAttemptAt: Date, now: Date): Promise<void>;
}
export interface PushDrainConfig {
  claimLimit: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

/** Bounded queue policy kept outside both the provider and schedule producer. */
export function createPushOutboxDrainer(deps: {
  queue: PushOutboxQueue;
  delivery: PushDeliveryService;
  config: PushDrainConfig;
  now?: () => Date;
}) {
  return {
    async drain(signal: AbortSignal): Promise<PushResult<{ claimed: number; completed: number }>> {
      try {
        const now = deps.now?.() ?? new Date();
        const claimed = await deps.queue.claim(deps.config.claimLimit, deps.config.leaseMs, now, signal);
        if (!claimed.ok) return claimed;
        let completed = 0;
        for (const job of claimed.value) {
          if (signal.aborted) return { ok: false, error: { code: "closed", retryable: false } };
          const result = await deps.delivery.deliver(job, signal);
          const at = deps.now?.() ?? new Date();
          if (result.ok) {
            await deps.queue.complete(job.deliveryId, at);
            completed++;
            continue;
          }
          if (!result.error.retryable || job.attempt >= deps.config.maxAttempts) {
            await deps.queue.drop(job.deliveryId, result.error, at);
            continue;
          }
          const delay = Math.min(deps.config.retryMaxMs, deps.config.retryBaseMs * 2 ** Math.max(0, job.attempt - 1));
          await deps.queue.retry(job.deliveryId, result.error, new Date(at.getTime() + delay), at);
        }
        return { ok: true, value: { claimed: claimed.value.length, completed } };
      } catch {
        // A rejected queue/delivery operation must not escape as an unhandled
        // rejection. The claim lease is left intact so the work is redelivered
        // after expiry rather than acked.
        return signal.aborted
          ? { ok: false, error: { code: "closed", retryable: false } }
          : { ok: false, error: { code: "provider_unavailable", retryable: true } };
      }
    },
  };
}
