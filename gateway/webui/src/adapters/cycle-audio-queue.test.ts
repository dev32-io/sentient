import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCycleAudioQueue } from "./cycle-audio-queue.ts";
import type { FadeablePlaybackAdapter } from "./web-audio-playback.ts";

// ---------------------------------------------------------------------------
// Mock FadeablePlaybackAdapter
// ---------------------------------------------------------------------------

function makeMockPlayback(): FadeablePlaybackAdapter & {
  enqueuedSamples: Float32Array[];
  cleared: number;
  fadedAndCleared: Array<{ durationMs: number }>;
  triggerDrain: () => void;
} {
  const drainHandlers = new Set<() => void>();
  const enqueuedSamples: Float32Array[] = [];
  let cleared = 0;
  const fadedAndCleared: Array<{ durationMs: number }> = [];

  return {
    enqueuedSamples,
    get cleared() {
      return cleared;
    },
    fadedAndCleared,
    triggerDrain() {
      for (const h of drainHandlers) h();
    },

    // AudioPlaybackAdapter interface
    init: vi.fn().mockResolvedValue(true),
    enqueue(samples: Float32Array) {
      enqueuedSamples.push(samples);
    },
    clear() {
      cleared++;
    },
    destroy: vi.fn(),
    onStateChange: vi.fn().mockReturnValue(() => {}),
    onDrain(handler: () => void) {
      drainHandlers.add(handler);
      return () => drainHandlers.delete(handler);
    },
    async fadeOutAndClear(durationMs: number): Promise<void> {
      fadedAndCleared.push({ durationMs });
      cleared++;
      // Resolve immediately in tests (fake timers advance separately)
      await Promise.resolve();
    },
    setAecEnabled: vi.fn(),
    unlock: vi.fn(),
  };
}

function makeSamples(length: number): Float32Array {
  return new Float32Array(length).fill(0.5);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueue(overrides?: { minEagerEndMs?: number; preemptFadeoutMs?: number }) {
  const playback = makeMockPlayback();
  const queue = createCycleAudioQueue({
    playback,
    minEagerEndMs: overrides?.minEagerEndMs ?? 3000,
    preemptFadeoutMs: overrides?.preemptFadeoutMs ?? 30,
  });
  return { playback, queue };
}

// ---------------------------------------------------------------------------
// Scenario (a): single cycle plays end-to-end
// ---------------------------------------------------------------------------

describe("CycleAudioQueue — single cycle end-to-end", () => {
  it("all frames reach playback.enqueue for the active cycle", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    const f1 = makeSamples(512);
    const f2 = makeSamples(256);
    const f3 = makeSamples(128);
    queue.onAudioFrame("A", f1);
    queue.onAudioFrame("A", f2);
    queue.onAudioFrame("A", f3);
    queue.onAudioDone("A");

    expect(playback.enqueuedSamples).toHaveLength(3);
    expect(playback.enqueuedSamples[0]).toBe(f1);
    expect(playback.enqueuedSamples[1]).toBe(f2);
    expect(playback.enqueuedSamples[2]).toBe(f3);
  });

  it("does not call playback.clear during normal single-cycle flow", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.onAudioDone("A");

    expect(playback.cleared).toBe(0);
  });

  it("duplicate onAudioStart for the same cycleId is a no-op", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioStart("A"); // duplicate
    queue.onAudioFrame("A", makeSamples(512));
    queue.onAudioDone("A");

    expect(playback.enqueuedSamples).toHaveLength(1);
    expect(playback.cleared).toBe(0);
  });

  it("goes idle after drain fires when doneReceived=true", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.onAudioDone("A");

    playback.triggerDrain();

    // Post-drain: new cycle B can be claimed as active.
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    expect(playback.enqueuedSamples).toHaveLength(2);
  });

  it("drain before doneReceived does not promote or go idle", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    playback.triggerDrain(); // spurious early drain

    // A should still be active.
    queue.onAudioFrame("A", makeSamples(256));
    expect(playback.enqueuedSamples).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario (b): cancelAll clears everything
// ---------------------------------------------------------------------------

describe("CycleAudioQueue — cancelAll", () => {
  it("calls playback.clear() once (no fade)", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.cancelAll();

    expect(playback.cleared).toBe(1);
    expect(playback.fadedAndCleared).toHaveLength(0);
  });

  it("drops all buffered pending frames", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    queue.cancelAll();

    expect(playback.enqueuedSamples).toHaveLength(1);
    expect(playback.cleared).toBe(1);
  });

  it("after cancelAll, drain does not promote any pending cycle", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    queue.cancelAll();
    playback.triggerDrain(); // should be a no-op

    expect(playback.enqueuedSamples).toHaveLength(1);
  });

  it("cancelAll is safe to call when idle", () => {
    const { playback, queue } = makeQueue();

    expect(() => queue.cancelAll()).not.toThrow();
    expect(playback.cleared).toBe(1);
  });

  it("after cancelAll a fresh cycle can be started", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.cancelAll();

    queue.onAudioStart("C");
    queue.onAudioFrame("C", makeSamples(128));
    queue.onAudioDone("C");

    expect(playback.enqueuedSamples).toHaveLength(2);
    expect(playback.enqueuedSamples[1]).toHaveLength(128);
  });
});

// ---------------------------------------------------------------------------
// Scenario (c): frames for a non-active cycleId are held, not forwarded
// ---------------------------------------------------------------------------

describe("CycleAudioQueue — pending cycle buffering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("frames for a different cycleId are not forwarded while active cycle plays", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));
    queue.onAudioFrame("B", makeSamples(128));

    expect(playback.enqueuedSamples).toHaveLength(1);
    expect(playback.enqueuedSamples[0]).toHaveLength(512);
  });

  it("pending frames are replayed once active cycle drains and doneReceived", async () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));
    queue.onAudioFrame("B", makeSamples(128));

    queue.onAudioDone("A");
    playback.triggerDrain(); // A fully drained → promote B

    await vi.runAllTimersAsync();

    expect(playback.enqueuedSamples).toHaveLength(3);
    expect(playback.enqueuedSamples[1]).toHaveLength(256);
    expect(playback.enqueuedSamples[2]).toHaveLength(128);
  });

  it("frames arriving before onAudioStart for that cycleId are also buffered", async () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    // B frames arrive without a preceding onAudioStart for B
    queue.onAudioFrame("B", makeSamples(64));

    queue.onAudioDone("A");
    playback.triggerDrain();

    await vi.runAllTimersAsync();

    expect(playback.enqueuedSamples).toHaveLength(2);
    expect(playback.enqueuedSamples[1]).toHaveLength(64);
  });

  it("pending cycle is not promoted until doneReceived on active cycle", () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    // Drain fires but onAudioDone not yet received — should NOT promote B.
    playback.triggerDrain();

    expect(playback.enqueuedSamples).toHaveLength(1);
  });

  it("options fields minEagerEndMs and preemptFadeoutMs are accepted without error", () => {
    expect(() => makeQueue({ minEagerEndMs: 5000, preemptFadeoutMs: 50 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario (d): deadlock regression — pending cycle's full stream arrives
//               before active cycle drains
// ---------------------------------------------------------------------------

describe("CycleAudioQueue — deadlock regression (pending done-received)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes idle after promoted cycle fully drains when done arrived while pending", async () => {
    const { playback, queue } = makeQueue();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));
    queue.onAudioFrame("B", makeSamples(128));
    queue.onAudioDone("B");

    queue.onAudioDone("A");
    playback.triggerDrain(); // A drains → B is promoted with doneReceived=true

    await vi.runAllTimersAsync();

    expect(playback.enqueuedSamples).toHaveLength(3);

    playback.triggerDrain(); // B drains → queue goes idle

    // C can be claimed immediately
    queue.onAudioStart("C");
    queue.onAudioFrame("C", makeSamples(64));
    expect(playback.enqueuedSamples).toHaveLength(4);
    expect(playback.enqueuedSamples[3]).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// Scenario (e): done arrives before start (and before any frames) for a cycle
// ---------------------------------------------------------------------------

describe("CycleAudioQueue — done-before-start edge case", () => {
  it("onAudioDone for an untracked cycleId is silently ignored", () => {
    const { playback, queue } = makeQueue();

    expect(() => queue.onAudioDone("C")).not.toThrow();

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));
    queue.onAudioDone("A");
    playback.triggerDrain();

    expect(playback.enqueuedSamples).toHaveLength(1);
    expect(playback.cleared).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario (f): configure() updates tunables used by subsequent preempts
// ---------------------------------------------------------------------------

describe("CycleAudioQueue — configure()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("configure() updates minEagerEndMs and a subsequent preempt respects the new value", async () => {
    vi.setSystemTime(0);
    // Start with a large cap (5s) so B is buffered
    const { playback, queue } = makeQueue({ minEagerEndMs: 5000, preemptFadeoutMs: 30 });

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    // Reconfigure to 0ms cap — next preempt fires immediately
    queue.configure({ minEagerEndMs: 0, preemptFadeoutMs: 20 });

    // B arrives — with the new 0ms cap it should preempt immediately
    vi.setSystemTime(100);
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    await vi.runAllTimersAsync();

    // Fade was applied with the new preemptFadeoutMs (20)
    expect(playback.fadedAndCleared).toHaveLength(1);
    expect(playback.fadedAndCleared[0]?.durationMs).toBe(20);

    const bFrame = playback.enqueuedSamples.find((f) => f.length === 256);
    expect(bFrame).toBeDefined();
  });

  it("configure() is a no-op when no active or pending cycles exist", () => {
    const { queue } = makeQueue();
    expect(() => queue.configure({ minEagerEndMs: 500, preemptFadeoutMs: 15 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Step 7 test matrix — preempt cap + fade-out
// ---------------------------------------------------------------------------

describe("CycleAudioQueue — Step 7 preempt matrix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // --- 7.1: elapsed < cap on next arrival → buffered, promoted on natural drain, zero gap

  it("7.1 elapsed < cap: next cycle buffered and promoted on natural drain (no fade)", async () => {
    vi.setSystemTime(0);
    const { playback, queue } = makeQueue({ minEagerEndMs: 3000 });

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    // B arrives at t=1000ms — only 1s into cap of 3s
    vi.setSystemTime(1000);
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    // Active drains naturally before timer fires
    queue.onAudioDone("A");
    playback.triggerDrain();
    await vi.runAllTimersAsync();

    // B must have been promoted with zero fade
    expect(playback.enqueuedSamples).toHaveLength(2);
    expect(playback.enqueuedSamples[1]).toHaveLength(256);
    // No fade was called — natural drain = instant promotion
    expect(playback.fadedAndCleared).toHaveLength(0);
  });

  // --- 7.2: elapsed >= cap on next arrival → immediate fade + preempt

  it("7.2 elapsed >= cap: immediate fade + preempt on B arrival", async () => {
    vi.setSystemTime(0);
    const { playback, queue } = makeQueue({ minEagerEndMs: 2000, preemptFadeoutMs: 30 });

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    // B arrives at t=3000ms — well past the 2s cap
    vi.setSystemTime(3000);
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    // Flush the async fadeOutAndClear
    await vi.runAllTimersAsync();

    // B should be playing (fade was applied)
    expect(playback.fadedAndCleared).toHaveLength(1);
    expect(playback.fadedAndCleared[0]?.durationMs).toBe(30);

    // B's frame must have been forwarded to playback after the preempt
    const bFrame = playback.enqueuedSamples.find((f) => f.length === 256);
    expect(bFrame).toBeDefined();
  });

  // --- 7.3: elapsed < cap on arrival, cap fires while active still playing → fade + preempt at deadline

  it("7.3 timer fires at deadline: fade + preempt even if active not yet drained", async () => {
    vi.setSystemTime(0);
    const { playback, queue } = makeQueue({ minEagerEndMs: 2000, preemptFadeoutMs: 30 });

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    // B arrives at t=500ms — before cap
    vi.setSystemTime(500);
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    // No natural drain — advance time to the deadline (t=2000ms) and run the timer
    vi.setSystemTime(2000);
    await vi.runAllTimersAsync();

    // Timer should have fired and preempted
    expect(playback.fadedAndCleared).toHaveLength(1);
    expect(playback.fadedAndCleared[0]?.durationMs).toBe(30);

    const bFrame = playback.enqueuedSamples.find((f) => f.length === 256);
    expect(bFrame).toBeDefined();
  });

  // --- 7.4: pending replaced by newer cycleId → oldest discarded, newest played after preempt

  it("7.4 newer pending supersedes older pending — only newest cycle plays", async () => {
    vi.setSystemTime(0);
    const { playback, queue } = makeQueue({ minEagerEndMs: 5000, preemptFadeoutMs: 30 });

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    // B arrives at t=500ms
    vi.setSystemTime(500);
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    // C arrives at t=1000ms, superseding B
    vi.setSystemTime(1000);
    queue.onAudioStart("C");
    queue.onAudioFrame("C", makeSamples(128));

    // A drains naturally — should promote C (not B)
    queue.onAudioDone("A");
    playback.triggerDrain();
    await vi.runAllTimersAsync();

    // C's frames forwarded; B's frames dropped
    expect(playback.enqueuedSamples).toHaveLength(2); // A + C
    expect(playback.enqueuedSamples[0]).toHaveLength(512); // A
    expect(playback.enqueuedSamples[1]).toHaveLength(128); // C
    // B's 256-length frame must NOT appear
    const bFrame = playback.enqueuedSamples.find((f) => f.length === 256);
    expect(bFrame).toBeUndefined();
  });

  // --- 7.5: cancelAll mid-playback → both cleared (no fade)

  it("7.5 cancelAll mid-playback: both active and pending cleared, no fade", async () => {
    vi.setSystemTime(0);
    const { playback, queue } = makeQueue({ minEagerEndMs: 3000, preemptFadeoutMs: 30 });

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    vi.setSystemTime(500);
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    queue.cancelAll();

    await vi.runAllTimersAsync();

    expect(playback.cleared).toBe(1);
    expect(playback.fadedAndCleared).toHaveLength(0);
    // Only A's frame was forwarded before cancelAll
    expect(playback.enqueuedSamples).toHaveLength(1);
  });

  // --- 7.6: cancelAll while pending exists but active drained → pending dropped, no playback

  it("7.6 cancelAll while pending exists and active is done: pending dropped", async () => {
    vi.setSystemTime(0);
    const { playback, queue } = makeQueue({ minEagerEndMs: 3000, preemptFadeoutMs: 30 });

    queue.onAudioStart("A");
    queue.onAudioFrame("A", makeSamples(512));

    vi.setSystemTime(500);
    queue.onAudioStart("B");
    queue.onAudioFrame("B", makeSamples(256));

    // Mark A done (but don't drain yet)
    queue.onAudioDone("A");

    // Cancel before drain fires
    queue.cancelAll();

    // Drain fires after cancel — should be a no-op
    playback.triggerDrain();
    await vi.runAllTimersAsync();

    expect(playback.cleared).toBe(1);
    expect(playback.fadedAndCleared).toHaveLength(0);
    // B never played
    const bFrame = playback.enqueuedSamples.find((f) => f.length === 256);
    expect(bFrame).toBeUndefined();
  });
});
