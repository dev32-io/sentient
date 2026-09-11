import { expect, it } from "bun:test";
import { createGorushApnsProvider } from "./gorush-provider.js";

const destination = { apnsDeviceToken: "0".repeat(64) };
const payload = {
  bindingId: "b",
  generation: 1,
  sessionId: "s",
  title: "New message" as const,
  mode: "hidden" as const,
};
it("maps controlled Gorush acceptance and permanent APNs invalidation without exposing provider details", async () => {
  const accepted = createGorushApnsProvider({
    url: "http://127.0.0.1:8088/api/push",
    topic: "app",
    now: () => new Date("2026-01-01T00:00:00Z"),
    fetch: async () => Response.json({ counts: 1, logs: [{ type: "succeeded" }] }),
  });
  expect(await accepted.deliver(destination, payload, new AbortController().signal)).toMatchObject({
    ok: true,
    value: { acceptedAt: "2026-01-01T00:00:00.000Z" },
  });
  const invalid = createGorushApnsProvider({
    url: "x",
    topic: "app",
    fetch: async () => Response.json({ counts: 0, logs: [{ type: "failed", error: "BadDeviceToken" }] }),
  });
  expect(await invalid.deliver(destination, payload, new AbortController().signal)).toEqual({
    ok: false,
    error: { code: "not_found", retryable: false },
  });
});
