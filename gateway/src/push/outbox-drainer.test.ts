import { expect, it } from "bun:test";
import type { UserId } from "../user-auth/user-id.js";
import { createPushOutboxDrainer } from "./outbox-drainer.js";

it("applies bounded queue retry without letting the provider own scheduling", async () => {
  const calls: string[] = [];
  const job = {
    deliveryId: "d",
    attempt: 2,
    content: { ownerUserId: "u_a11ce001" as UserId, sessionId: "s", entryId: "e" },
  };
  const drainer = createPushOutboxDrainer({
    now: () => new Date("2026-01-01T00:00:00Z"),
    config: { claimLimit: 5, leaseMs: 1000, maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1000 },
    queue: {
      claim: async () => ({ ok: true, value: [job] }),
      complete: async () => {
        calls.push("complete");
      },
      drop: async () => {
        calls.push("drop");
      },
      retry: async (_id, _error, next) => {
        calls.push(`retry:${next.toISOString()}`);
      },
    },
    delivery: { deliver: async () => ({ ok: false, error: { code: "provider_unavailable", retryable: true } }) },
  });
  expect(await drainer.drain(new AbortController().signal)).toMatchObject({
    ok: true,
    value: { claimed: 1, completed: 0 },
  });
  expect(calls).toEqual(["retry:2026-01-01T00:00:00.200Z"]);
});

const job = {
  deliveryId: "d",
  attempt: 1,
  content: { ownerUserId: "u_a11ce001" as UserId, sessionId: "s", entryId: "e" },
};
const drainConfig = { claimLimit: 5, leaseMs: 1000, maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1000 };

it("returns a typed retryable failure when a queue write rejects and keeps the work for redelivery", async () => {
  const calls: string[] = [];
  let failRetry = true;
  const drainer = createPushOutboxDrainer({
    now: () => new Date("2026-01-01T00:00:00Z"),
    config: drainConfig,
    queue: {
      claim: async () => ({ ok: true, value: [job] }),
      complete: async () => {
        calls.push("complete");
      },
      drop: async () => {
        calls.push("drop");
      },
      retry: async () => {
        calls.push("retry");
        if (failRetry) throw new Error("synthetic outbox fault");
      },
    },
    delivery: { deliver: async () => ({ ok: false, error: { code: "provider_unavailable", retryable: true } }) },
  });
  const signal = new AbortController().signal;
  expect(await drainer.drain(signal)).toEqual({
    ok: false,
    error: { code: "provider_unavailable", retryable: true },
  });
  expect(calls).toEqual(["retry"]);
  failRetry = false;
  expect(await drainer.drain(signal)).toEqual({ ok: true, value: { claimed: 1, completed: 0 } });
  expect(calls).toEqual(["retry", "retry"]);
});

it("returns a typed retryable failure when delivery rejects and never acks the lease", async () => {
  const calls: string[] = [];
  let failDelivery = true;
  const drainer = createPushOutboxDrainer({
    now: () => new Date("2026-01-01T00:00:00Z"),
    config: drainConfig,
    queue: {
      claim: async () => ({ ok: true, value: [job] }),
      complete: async () => {
        calls.push("complete");
      },
      drop: async () => {
        calls.push("drop");
      },
      retry: async () => {
        calls.push("retry");
      },
    },
    delivery: {
      deliver: async () => {
        if (failDelivery) throw new Error("synthetic content resolver fault");
        return { ok: true, value: [] };
      },
    },
  });
  const signal = new AbortController().signal;
  expect(await drainer.drain(signal)).toEqual({
    ok: false,
    error: { code: "provider_unavailable", retryable: true },
  });
  expect(calls).toEqual([]);
  failDelivery = false;
  expect(await drainer.drain(signal)).toEqual({ ok: true, value: { claimed: 1, completed: 1 } });
  expect(calls).toEqual(["complete"]);
});

it("reports a closed non-retryable failure when the signal aborts during a rejected operation", async () => {
  const controller = new AbortController();
  const drainer = createPushOutboxDrainer({
    config: drainConfig,
    queue: {
      claim: async () => ({ ok: true, value: [job] }),
      complete: async () => undefined,
      drop: async () => undefined,
      retry: async () => undefined,
    },
    delivery: {
      deliver: async () => {
        controller.abort();
        throw new Error("synthetic abort fault");
      },
    },
  });
  expect(await drainer.drain(controller.signal)).toEqual({ ok: false, error: { code: "closed", retryable: false } });
});
