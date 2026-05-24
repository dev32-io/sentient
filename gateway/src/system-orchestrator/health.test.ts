import { expect, test } from "bun:test";
import { type HealthIO, pollHealthy } from "./health.js";

const fakeIO = (responses: Array<boolean | "error">): HealthIO => {
  let i = 0;
  return {
    fetch: async () => {
      const r = responses[i++];
      if (r === undefined) return { ok: false };
      if (r === "error") throw new Error("boom");
      return { ok: r };
    },
    tcpProbe: async () => responses[i++] === true,
    execProbe: async () => (responses[i++] === true ? 0 : 1),
    sleep: async () => {},
    now: (() => {
      let t = 0;
      return () => {
        t += 100;
        return t;
      };
    })(),
  };
};

test("pollHealthy returns ready on first ok response", async () => {
  const r = await pollHealthy({
    healthcheck: { url: "http://x/health", timeout_ms: 1000 },
    pollIntervalMs: 50,
    io: fakeIO([true]),
  });
  expect(r.ok).toBe(true);
});

test("pollHealthy keeps polling until timeout when never healthy", async () => {
  const r = await pollHealthy({
    healthcheck: { url: "http://x/health", timeout_ms: 200 },
    pollIntervalMs: 50,
    io: fakeIO([false, false, false, false, false]),
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("timeout");
});

test("pollHealthy returns timeout (with last error captured) on persistent fetch failure", async () => {
  const r = await pollHealthy({
    healthcheck: { url: "http://x/health", timeout_ms: 200 },
    pollIntervalMs: 50,
    io: fakeIO(["error", "error", "error", "error"]),
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("timeout");
  expect(r.error.lastError).toContain("boom");
});
