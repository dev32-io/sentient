import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHealthPoller } from "./health-poller.js";

describe("createHealthPoller().pollUntilHealthy", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy generic on fetch is awkward
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function okResponse(): Response {
    return new Response(null, { status: 200 });
  }
  function badResponse(): Response {
    return new Response(null, { status: 503 });
  }

  it("returns ok on first 200 response", async () => {
    fetchSpy.mockResolvedValue(okResponse());
    const poller = createHealthPoller();

    const r = await poller.pollUntilHealthy("http://hermes/health", { Authorization: "Bearer x" }, 5000, 100);

    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries after 5xx then succeeds", async () => {
    // Real timers: 10ms interval, 1000ms timeout. Three fetch attempts ≈30ms.
    fetchSpy
      .mockResolvedValueOnce(badResponse())
      .mockResolvedValueOnce(badResponse())
      .mockResolvedValueOnce(okResponse());
    const poller = createHealthPoller();

    const r = await poller.pollUntilHealthy("http://hermes/health", {}, 1000, 10);

    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("treats 4xx as healthy — server bound + responding (hermes worker has no /health route)", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    const poller = createHealthPoller();

    const r = await poller.pollUntilHealthy("http://hermes/health", {}, 50, 10);

    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns timeout error when /health never returns under 500", async () => {
    // Real timers: 10ms interval, 50ms timeout. ~5 iterations then timeout.
    fetchSpy.mockResolvedValue(badResponse());
    const poller = createHealthPoller();

    const r = await poller.pollUntilHealthy("http://hermes/health", {}, 50, 10);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("timeout");
      if (r.error.kind === "timeout") {
        expect(r.error.afterMs).toBe(50);
      }
    }
  });

  it("returns timeout when fetch always throws", async () => {
    // Real timers: 10ms interval, 50ms timeout. Inner errors swallowed; final timeout.
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const poller = createHealthPoller();

    const r = await poller.pollUntilHealthy("http://hermes/health", {}, 50, 10);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("timeout");
    }
  });
});
