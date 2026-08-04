import { describe, expect, it } from "bun:test";
import { createHealthWatch } from "./health-watch.js";

// No fake-timer library is in play here — the watchdog schedules real
// `setTimeout`s, so advancing it means actually waiting. `+5` per tick
// absorbs scheduling jitter without inflating a 6-tick wait meaningfully.
async function advanceTicks(ticks: number, intervalMs: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ticks * intervalMs + 5));
}

describe("health-watch", () => {
  it("INVARIANT: an unhealthy service triggers exactly one re-apply", async () => {
    const applied: string[] = [];
    let healthy = false;
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["local-tts"],
      probe: async () => healthy,
      reapply: async (name) => {
        applied.push(name);
        healthy = true;
      },
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 60));
    watch.stop();
    expect(applied).toEqual(["local-tts"]); // recovered, and NOT re-applied once healthy
  });

  it("INVARIANT: a healthy service is never re-applied", async () => {
    const applied: string[] = [];
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["local-tts"],
      probe: async () => true,
      reapply: async (name) => {
        applied.push(name);
      },
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 60));
    watch.stop();
    expect(applied).toEqual([]);
  });

  it("INVARIANT: stop() ends the loop — no re-apply after shutdown", async () => {
    const applied: string[] = [];
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["local-tts"],
      probe: async () => false,
      reapply: async (name) => {
        applied.push(name);
      },
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 25));
    watch.stop();
    const countAtStop = applied.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(applied.length).toBe(countAtStop);
  });

  it("keeps re-applying a neverGiveUp service past maxAttempts", async () => {
    const reapplied: string[] = [];
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["inbound-proxy"],
      probe: async () => false,
      reapply: async (n) => {
        reapplied.push(n);
      },
      maxAttempts: 2,
      backoffFactor: 1,
      neverGiveUp: (n) => n === "inbound-proxy",
    });

    watch.start();
    // Six intervals is three times the give-up budget.
    await advanceTicks(6, 10);
    watch.stop();

    expect(reapplied.length).toBeGreaterThan(2);
  });

  it("still gives up on a service that is not neverGiveUp", async () => {
    const reapplied: string[] = [];
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["ha-mcp"],
      probe: async () => false,
      reapply: async (n) => {
        reapplied.push(n);
      },
      maxAttempts: 2,
      backoffFactor: 1,
      neverGiveUp: () => false,
    });

    watch.start();
    await advanceTicks(6, 10);
    watch.stop();

    expect(reapplied.length).toBe(2);
  });
});
