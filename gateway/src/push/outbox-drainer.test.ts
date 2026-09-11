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
