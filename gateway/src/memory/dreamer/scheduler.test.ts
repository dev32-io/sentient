// Dreamer scheduler — nightly timing, boot catch-up, per-user sequencing, and
// the toggle branch, all driven by an injected fake clock (no real timers).

import type { OrchestratorConfig } from "@sentient/config";
import { orchestratorConfigSchema } from "@sentient/config";
import { describe, expect, it, vi } from "vitest";
import type { DreamOutcome } from "./dream-transaction.js";
import { type DreamClock, type DreamTimer, createDreamScheduler, msUntilNextHour } from "./scheduler.js";

const memoryCfg: OrchestratorConfig["memory"] = orchestratorConfigSchema.shape.memory.parse({}); // dreamer.hour = 3

const OK: DreamOutcome = { result: "ok", sessions: 1, ops: 0, durationMs: 1 };
const SKIPPED: DreamOutcome = { result: "skipped", sessions: 0, ops: 0, durationMs: 1, reason: "dreaming-off" };

/** A fake clock: no time passes on its own. `fireNext` runs the earliest pending
 *  timer, advancing `now` to that timer's fire time (so a reschedule computes the
 *  next slot a full day out, not a zero-delay loop). */
function fakeClock(start: Date): DreamClock & { fireNext(): boolean; pending(): number } {
  let current = start.getTime();
  let nextId = 1;
  let timers: { id: number; fireAt: number; fn: () => void }[] = [];
  return {
    now: () => new Date(current),
    setTimeout(fn, ms): DreamTimer {
      const id = nextId++;
      timers.push({ id, fireAt: current + ms, fn });
      return id;
    },
    clearTimeout(timer): void {
      timers = timers.filter((t) => t.id !== timer);
    },
    fireNext(): boolean {
      if (timers.length === 0) return false;
      timers.sort((a, b) => a.fireAt - b.fireAt);
      const next = timers.shift();
      if (!next) return false;
      current = next.fireAt;
      next.fn();
      return true;
    },
    pending: () => timers.length,
  };
}

interface StubOverrides {
  users?: string[];
  enabled?: boolean;
  catchUpDue?: boolean;
  runDreamFor?: (userId: string) => Promise<DreamOutcome>;
  skipAndAdvance?: (userId: string) => Promise<DreamOutcome>;
}

function stubDeps(clock: DreamClock, o: StubOverrides = {}) {
  const runDreamFor = vi.fn(o.runDreamFor ?? (async () => OK));
  const skipAndAdvance = vi.fn(o.skipAndAdvance ?? (async () => SKIPPED));
  return {
    runDreamFor,
    skipAndAdvance,
    catchUpDueFor: vi.fn(async () => o.catchUpDue ?? false),
    listUsers: vi.fn(async () => o.users ?? ["u_a"]),
    dreamingEnabledFor: vi.fn(async () => o.enabled ?? true),
    cfg: memoryCfg,
    clock,
  };
}

describe("msUntilNextHour", () => {
  it("schedules today when now is before the hour", () => {
    const now = new Date(2026, 7, 9, 1, 0, 0); // 01:00 local
    expect(msUntilNextHour(now, 3)).toBe(2 * 60 * 60 * 1000);
  });

  it("rolls to tomorrow when now is at or past the hour", () => {
    const now = new Date(2026, 7, 9, 3, 0, 0); // exactly 03:00
    expect(msUntilNextHour(now, 3)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("createDreamScheduler", () => {
  it("fires exactly one pass per day at the configured hour", async () => {
    const clock = fakeClock(new Date(2026, 7, 9, 1, 0, 0)); // 01:00, hour=3
    const deps = stubDeps(clock, { catchUpDue: false });
    const scheduler = createDreamScheduler(deps);

    scheduler.start();
    await scheduler.idle(); // boot catch-up: not due ⇒ no dream
    expect(deps.runDreamFor).not.toHaveBeenCalled();

    clock.fireNext(); // 03:00 today
    await scheduler.idle();
    expect(deps.runDreamFor).toHaveBeenCalledTimes(1);

    clock.fireNext(); // 03:00 next day
    await scheduler.idle();
    expect(deps.runDreamFor).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("runs a boot catch-up dream when the user's mark is stale", async () => {
    const clock = fakeClock(new Date(2026, 7, 9, 1, 0, 0));
    const deps = stubDeps(clock, { catchUpDue: true });
    const scheduler = createDreamScheduler(deps);

    scheduler.start();
    await scheduler.idle();

    expect(deps.catchUpDueFor).toHaveBeenCalledWith("u_a");
    expect(deps.runDreamFor).toHaveBeenCalledWith("u_a");
    scheduler.stop();
  });

  it("skips a not-due user on boot catch-up without dreaming", async () => {
    const clock = fakeClock(new Date(2026, 7, 9, 1, 0, 0));
    const deps = stubDeps(clock, { catchUpDue: false });
    const scheduler = createDreamScheduler(deps);

    scheduler.start();
    await scheduler.idle();

    expect(deps.runDreamFor).not.toHaveBeenCalled();
    expect(deps.skipAndAdvance).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("processes users strictly sequentially — the second dream starts only after the first resolves", async () => {
    const clock = fakeClock(new Date(2026, 7, 9, 1, 0, 0));
    const started: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const deps = stubDeps(clock, {
      users: ["u_a", "u_b"],
      catchUpDue: true,
      runDreamFor: async (userId) => {
        started.push(userId);
        if (userId === "u_a") await gateA;
        return OK;
      },
    });
    const scheduler = createDreamScheduler(deps);

    scheduler.start();
    // Let the pass progress (through listUsers → catchUpDueFor → dreamingEnabledFor)
    // until it reaches u_a and blocks there. A real macrotask, not the fake clock.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual(["u_a"]); // u_b has NOT started while u_a is in flight

    releaseA();
    await scheduler.idle();
    expect(started).toEqual(["u_a", "u_b"]);
    scheduler.stop();
  });

  it("skips-and-advances a toggled-off user instead of dreaming (mark still moves)", async () => {
    const clock = fakeClock(new Date(2026, 7, 9, 1, 0, 0));
    const deps = stubDeps(clock, { catchUpDue: true, enabled: false });
    const scheduler = createDreamScheduler(deps);

    scheduler.start();
    await scheduler.idle();

    expect(deps.skipAndAdvance).toHaveBeenCalledWith("u_a");
    expect(deps.runDreamFor).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("stop disarms the nightly timer", async () => {
    const clock = fakeClock(new Date(2026, 7, 9, 1, 0, 0));
    const deps = stubDeps(clock);
    const scheduler = createDreamScheduler(deps);

    scheduler.start();
    await scheduler.idle();
    scheduler.stop();
    expect(clock.pending()).toBe(0);
  });
});
