import { describe, expect, it } from "bun:test";
import { createHealthWatch } from "./health-watch.js";

// No fake-timer library is in play here — the watchdog schedules real
// `setTimeout`s, so advancing it means actually waiting. `+5` per tick
// absorbs scheduling jitter without inflating a 6-tick wait meaningfully.
async function advanceTicks(ticks: number, intervalMs: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ticks * intervalMs + 5));
}

/**
 * Wait for an observable watchdog outcome rather than assuming an overloaded
 * CI runner delivered every 10 ms timer by a particular wall-clock instant.
 * The deadline remains below the uncapped seventh dispatch (640 ms), so this
 * still distinguishes a real plateau from an exponentially growing backoff.
 */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
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

  it("INVARIANT: a neverGiveUp service keeps re-applying past maxAttempts", async () => {
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

  it("INVARIANT: a non-neverGiveUp service still gives up at maxAttempts", async () => {
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
      // neverGiveUp omitted — exercises the `?? (() => false)` default path,
      // not an explicit `() => false` that would never touch the default.
    });

    watch.start();
    await advanceTicks(6, 10);
    watch.stop();

    expect(reapplied.length).toBe(2);
  });

  it("INVARIANT: a neverGiveUp service's backoff plateaus at maxAttempts instead of growing forever", async () => {
    const dispatchedAt: number[] = [];
    const start = Date.now();
    const intervalMs = 10;
    const backoffFactor = 2;
    const maxAttempts = 3;
    const watch = createHealthWatch({
      intervalMs,
      listServices: () => ["inbound-proxy"],
      probe: async () => false,
      reapply: async () => {
        dispatchedAt.push(Date.now() - start);
      },
      maxAttempts,
      backoffFactor,
      neverGiveUp: () => true,
    });

    watch.start();
    // Capped dispatch times are 10,20,40,80,160,240,320,400. An uncapped
    // backoff's seventh dispatch is at 640ms, so 600ms still rejects a deleted
    // or off-by-one cap while not assuming GitHub Actions wakes every timer at
    // its nominal millisecond.
    await waitFor(() => dispatchedAt.length >= 7, 600);
    watch.stop();

    const gaps: number[] = [];
    let previousDispatch: number | undefined;
    for (const dispatchTime of dispatchedAt) {
      if (previousDispatch !== undefined) gaps.push(dispatchTime - previousDispatch);
      previousDispatch = dispatchTime;
    }
    expect(gaps.length).toBeGreaterThanOrEqual(6);

    // gaps[3] is where the exponent FIRST reaches maxAttempts (capped and
    // uncapped agree here). gaps[4] and gaps[5] are the first two where a cap
    // and no cap diverge — capped holds at the plateau, uncapped keeps
    // doubling (2x, then 4x the plateau). Range checks absorb real-timer
    // jitter while staying far from the uncapped values.
    const plateauMs = intervalMs * backoffFactor ** maxAttempts;
    for (const gap of gaps.slice(4, 6)) {
      expect(gap).toBeGreaterThan(plateauMs * 0.5);
      expect(gap).toBeLessThan(plateauMs * 1.5);
    }
  });
});
