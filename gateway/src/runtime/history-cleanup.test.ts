import { describe, expect, it } from "bun:test";
import type { DreamClock } from "../memory/dreamer/scheduler.js";
import { createHistoryCleanup } from "./history-cleanup.js";

function fixture(days = 90) {
  let now = new Date(2026, 8, 20, 2);
  const timers = new Map<object, () => void>();
  const clock: DreamClock = {
    now: () => now,
    setTimeout: (fn) => {
      const token = {};
      timers.set(token, fn);
      return token;
    },
    clearTimeout: (token) => timers.delete(token as object),
  };
  const calls: Array<{ userId: string; cutoff: number | null }> = [];
  const cleanup = createHistoryCleanup({
    config: { retention_days: days, cleanup_hour: 3, batch_size: 100 },
    listUsers: async () => ["u_first", "u_second"],
    cleanupUser: async (userId, cutoff) => {
      calls.push({ userId, cutoff });
      if (userId === "u_first") throw new Error("synthetic account failure");
    },
    clock,
  });
  return {
    cleanup,
    calls,
    timers,
    get now() {
      return now;
    },
    fire() {
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const next = [...timers.entries()][0];
      if (!next) throw new Error("expected scheduled cleanup");
      const [token, fn] = next;
      timers.delete(token);
      fn();
    },
  };
}

describe("history cleanup", () => {
  it("catches up at startup and each night, isolating account failures", async () => {
    const f = fixture();
    f.cleanup.start();
    f.cleanup.start();
    await f.cleanup.idle();
    expect(f.calls).toEqual([
      { userId: "u_first", cutoff: f.now.getTime() - 90 * 86400000 },
      { userId: "u_second", cutoff: f.now.getTime() - 90 * 86400000 },
    ]);
    expect(f.timers.size).toBe(1);
    f.fire();
    await f.cleanup.idle();
    expect(f.calls.length).toBe(4);
    f.cleanup.stop();
    expect(f.timers.size).toBe(0);
  });

  it("disables age deletion at zero but permits accepted file cleanup", async () => {
    const f = fixture(0);
    f.cleanup.start();
    await f.cleanup.idle();
    expect(f.calls.map((call) => call.cutoff)).toEqual([null, null]);
    f.cleanup.stop();
  });
});
