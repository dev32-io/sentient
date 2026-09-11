import type { PushOutboxQueue } from "../push/outbox-drainer.js";
import type { ScheduledContentOutbox } from "./contracts.js";

/** Adapts durable schedule-produced content references to the existing push
 * drainer. It contains no executor reference, so delivery retries cannot
 * re-enter chat execution. */
export function createScheduledPushOutboxQueue(outbox: ScheduledContentOutbox): PushOutboxQueue {
  const requireMutation = async (operation: Promise<{ ok: boolean }>, action: string): Promise<void> => {
    const result = await operation;
    if (!result.ok) throw new Error(`scheduled push outbox ${action} failed`);
  };
  return {
    async claim(limit, leaseMs, now, signal) {
      if (signal.aborted) return { ok: false, error: { code: "closed", retryable: false } };
      const result = await outbox.claim(now, limit, leaseMs);
      if (!result.ok)
        return {
          ok: false,
          error: {
            code: result.error.code === "closed" ? "closed" : "provider_unavailable",
            retryable: result.error.retryable,
          },
        };
      return {
        ok: true,
        value: result.value.map((entry) => ({
          deliveryId: entry.outboxId,
          content: {
            ownerUserId: entry.content.ownerUserId,
            sessionId: entry.content.sessionId,
            entryId: entry.content.entryId,
          },
          attempt: entry.attempt ?? 1,
        })),
      };
    },
    async complete(deliveryId) {
      await requireMutation(outbox.acknowledge(deliveryId), "complete");
    },
    async drop(deliveryId) {
      await requireMutation(outbox.acknowledge(deliveryId), "drop");
    },
    async retry(deliveryId, _failure, nextAttemptAt) {
      await requireMutation(outbox.retry(deliveryId, nextAttemptAt), "retry");
    },
  };
}
