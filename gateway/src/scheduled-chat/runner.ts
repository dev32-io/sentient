import type {
  AtomicScheduleFinalizer,
  DueClaimSource,
  ScheduledExecutionAuthorizer,
  ScheduledMessageSubmitter,
  SchedulingResult,
} from "../scheduling/contracts.js";

export interface ScheduledChatRunner {
  runOnce(signal?: AbortSignal): Promise<SchedulingResult<{ claimed: number; finalized: number }>>;
  start(): void;
  stop(): Promise<void>;
}

/** Bounded scheduler loop. Finalization is the sole handoff to delivery; this
 * runner never invokes a push provider or drainer. */
export function createScheduledChatRunner(deps: {
  claims: DueClaimSource;
  authorizer: ScheduledExecutionAuthorizer;
  submitter: ScheduledMessageSubmitter;
  finalizer: AtomicScheduleFinalizer;
  claimLimit: number;
  leaseMs: number;
  pollMs: number;
  now?: () => Date;
  makeOutboxId?: (occurrenceId: string) => string;
}): ScheduledChatRunner {
  if (
    !Number.isInteger(deps.claimLimit) ||
    deps.claimLimit < 1 ||
    !Number.isInteger(deps.leaseMs) ||
    deps.leaseMs < 1 ||
    !Number.isInteger(deps.pollMs) ||
    deps.pollMs < 1
  )
    throw new Error("invalid scheduled chat runner limits");
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  async function runOnce(
    signal = new AbortController().signal,
  ): Promise<SchedulingResult<{ claimed: number; finalized: number }>> {
    const due = await deps.claims.claimDue(deps.now?.() ?? new Date(), deps.claimLimit, deps.leaseMs);
    if (!due.ok) return due;
    let finalized = 0;
    for (const claim of due.value) {
      if (signal.aborted) return { ok: false, error: { code: "closed", retryable: false } };
      const authorized = await deps.authorizer.authorize(claim, signal);
      if (!authorized.ok) {
        if (authorized.error.retryable) return authorized;
        const completedAt = (deps.now?.() ?? new Date()).toISOString();
        const result = await deps.finalizer.finalizeClaim(claim, { outcome: "expired", completedAt }, undefined);
        if (!result.ok) return result;
        finalized++;
        continue;
      }
      const submitted = await deps.submitter.submit(authorized.value, signal);
      if (!submitted.ok) return submitted;
      const receipt = submitted.value;
      const outbox =
        receipt.outcome === "completed"
          ? {
              outboxId: deps.makeOutboxId?.(claim.occurrenceId) ?? `scheduled:${claim.occurrenceId}`,
              content: receipt.content,
              availableAt: receipt.completedAt,
            }
          : undefined;
      const result = await deps.finalizer.finalizeClaim(claim, receipt, outbox);
      if (!result.ok) return result;
      finalized++;
    }
    return { ok: true, value: { claimed: due.value.length, finalized } };
  }

  return {
    runOnce,
    start() {
      if (controller) return;
      controller = new AbortController();
      const signal = controller.signal;
      loop = (async () => {
        while (!signal.aborted) {
          await runOnce(signal);
          if (signal.aborted) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, deps.pollMs);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      })();
    },
    async stop() {
      controller?.abort();
      await loop;
      controller = null;
      loop = null;
    },
  };
}
