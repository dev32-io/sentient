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
const url = "http://127.0.0.1:8088/api/push";
const signal = () => new AbortController().signal;
const unavailable = { ok: false, error: { code: "provider_unavailable", retryable: true } } as const;

it("uses pinned Gorush APNs fields and explicit per-stack routing for sandbox and production", async () => {
  // Gorush v1.22.0 router/server.go counts the APNs topic as well as the token;
  // successful synchronous APNs sends return an empty logs array, not an APNs id.
  for (const sandbox of [true, false]) {
    const topic = sandbox ? "io.dev32.sentient.debug" : "io.dev32.sentient";
    let body: Record<string, unknown> | undefined;
    const provider = createGorushApnsProvider({
      url,
      topic,
      sandbox,
      now: () => new Date("2026-01-01T00:00:00Z"),
      fetch: async (input, init) => {
        expect(input).toBe(url);
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeDefined();
        body = JSON.parse(String(init?.body)).notifications[0];
        return Response.json({ success: "ok", counts: 2, logs: [] });
      },
    });
    expect(await provider.deliver(destination, payload, signal())).toMatchObject({
      ok: true,
      value: { acceptedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(body).toMatchObject({
      tokens: [destination.apnsDeviceToken],
      platform: 1,
      topic,
      development: sandbox,
      production: !sandbox,
      push_type: "alert",
      title: "New message",
      data: { bindingId: "b", generation: 1, sessionId: "s", mode: "hidden" },
    });
    expect(body?.collapse_id).toMatch(/^[a-f0-9]{32}$/);
    expect(body).not.toHaveProperty("collapse_key");
  }
});

it("rejects the old fake acceptance, malformed responses and failed deliveries", async () => {
  for (const body of [
    {},
    { counts: 1, logs: [] },
    { success: "ok", counts: 1 },
    { success: "ok", counts: 0, logs: [] },
    { success: "ok", counts: 1, logs: [] },
    { success: "ok", counts: 3, logs: [] },
    { success: "ok", counts: 2, logs: [{ type: "unexpected", error: "" }] },
    { success: "ok", counts: 1, logs: null },
    { success: "error", counts: 1, logs: [] },
    { success: "ok", counts: 1, logs: [{ type: "failed", error: "ServiceUnavailable" }] },
  ]) {
    const provider = createGorushApnsProvider({
      url,
      topic: "app",
      sandbox: true,
      fetch: async () => Response.json(body),
    });
    expect(await provider.deliver(destination, payload, signal())).toEqual(unavailable);
  }
});

it("maps permanent APNs token errors without exposing provider details", async () => {
  for (const error of ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "device token not for topic"]) {
    const provider = createGorushApnsProvider({
      url,
      topic: "app",
      sandbox: true,
      fetch: async () => Response.json({ success: "ok", counts: 2, logs: [{ type: "failed", error }] }),
    });
    expect(await provider.deliver(destination, payload, signal())).toEqual({
      ok: false,
      error: { code: "not_found", retryable: false },
    });
  }
});

it("treats missing transport, HTTP failure and cancellation as failures, never receipts", async () => {
  for (const fetch of [
    async () => {
      throw new Error("connection refused");
    },
    async () => new Response(null, { status: 503 }),
    async () => new Response(null, { status: 429 }),
    async () => new Response("not json"),
  ]) {
    const provider = createGorushApnsProvider({ url, topic: "app", sandbox: true, fetch });
    expect(await provider.deliver(destination, payload, signal())).toEqual(unavailable);
  }
  const controller = new AbortController();
  controller.abort();
  const provider = createGorushApnsProvider({
    url,
    topic: "app",
    sandbox: true,
    fetch: async () => {
      throw new Error("aborted");
    },
  });
  expect(await provider.deliver(destination, payload, controller.signal)).toEqual({
    ok: false,
    error: { code: "closed", retryable: false },
  });
});
