import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WARNING_FRACTION,
  type IdleDetectorConfig,
  MINIMUM_IDLE_THRESHOLD_MS,
  createIdleDetector,
} from "./idle-detector.ts";

// ---------------------------------------------------------------------------
// A one-hour default is still too long for a snappy unit test. Use a tight
// synthetic threshold (slightly above the 30 s floor) everywhere. The 30 s
// floor itself is tested via its own dedicated block.
// ---------------------------------------------------------------------------

const BASE_CONFIG: IdleDetectorConfig = {
  idleThresholdMs: 60_000, // 60 s
  // warningThresholdMs omitted → defaults to 90% of idleThresholdMs (54 s).
};

/** Expected warning boundary for BASE_CONFIG: 60_000 * 0.9 = 54_000. */
const BASE_WARNING_MS = BASE_CONFIG.idleThresholdMs * DEFAULT_WARNING_FRACTION;

describe("createIdleDetector — config validation", () => {
  it("rejects idleThresholdMs below the 30 s floor", () => {
    expect(() => createIdleDetector({ idleThresholdMs: MINIMUM_IDLE_THRESHOLD_MS - 1 })).toThrow(/idleThresholdMs/);
  });

  it("accepts idleThresholdMs at exactly the 30 s floor", () => {
    expect(() => createIdleDetector({ idleThresholdMs: MINIMUM_IDLE_THRESHOLD_MS })).not.toThrow();
  });

  it("rejects warningThresholdMs >= idleThresholdMs", () => {
    expect(() => createIdleDetector({ idleThresholdMs: 60_000, warningThresholdMs: 60_000 })).toThrow(
      /warningThresholdMs/,
    );
    expect(() => createIdleDetector({ idleThresholdMs: 60_000, warningThresholdMs: 61_000 })).toThrow(
      /warningThresholdMs/,
    );
  });

  it("rejects negative warningThresholdMs", () => {
    expect(() => createIdleDetector({ idleThresholdMs: 60_000, warningThresholdMs: -1 })).toThrow(/warningThresholdMs/);
  });
});

describe("createIdleDetector — initial state", () => {
  it("starts in active state", () => {
    const det = createIdleDetector(BASE_CONFIG);
    expect(det.snapshot().state).toBe("active");
  });

  it("exposes the configured thresholds in the snapshot", () => {
    const det = createIdleDetector(BASE_CONFIG);
    const snap = det.snapshot();
    expect(snap.idleThresholdMs).toBe(60_000);
    expect(snap.warningThresholdMs).toBe(BASE_WARNING_MS);
  });

  it("starts with all suppression flags cleared", () => {
    const det = createIdleDetector(BASE_CONFIG);
    const snap = det.snapshot();
    expect(snap.cycleActive).toBe(false);
    expect(snap.ttsActive).toBe(false);
    expect(snap.demandStayCount).toBe(0);
  });
});

describe("createIdleDetector — tick transitions (no events)", () => {
  it("stays active before the warning threshold elapses", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "tick", nowMs: BASE_WARNING_MS - 1 });
    expect(det.snapshot().state).toBe("active");
  });

  it("transitions active → warning exactly at the warning threshold", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "tick", nowMs: BASE_WARNING_MS });
    expect(det.snapshot().state).toBe("warning");
  });

  it("stays warning until the idle threshold elapses", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs - 1 });
    expect(det.snapshot().state).toBe("warning");
  });

  it("transitions warning → idle exactly at the idle threshold", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs });
    expect(det.snapshot().state).toBe("idle");
  });

  it("skips warning when a single tick passes idle threshold directly", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 1_000 });
    expect(det.snapshot().state).toBe("idle");
  });

  it("stays idle on further ticks", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs });
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs * 2 });
    expect(det.snapshot().state).toBe("idle");
  });
});

describe("createIdleDetector — event resets", () => {
  for (const kind of ["interaction", "cycle.start", "cycle.end", "tts.start", "tts.end"] as const) {
    it(`${kind} resets timer from warning back to active`, () => {
      const det = createIdleDetector(BASE_CONFIG);
      det.handle({ kind: "tick", nowMs: BASE_WARNING_MS });
      expect(det.snapshot().state).toBe("warning");
      det.handle({ kind, nowMs: BASE_WARNING_MS });
      expect(det.snapshot().state).toBe("active");
    });

    it(`${kind} resets timer from idle back to active`, () => {
      const det = createIdleDetector(BASE_CONFIG);
      det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs });
      expect(det.snapshot().state).toBe("idle");
      det.handle({ kind, nowMs: BASE_CONFIG.idleThresholdMs });
      expect(det.snapshot().state).toBe("active");
    });

    it(`${kind} re-anchors the timer — idle no longer fires at previous boundary`, () => {
      const det = createIdleDetector(BASE_CONFIG);
      // Reset at t=10s; idle should now fire at 10s + 60s = 70s, not 60s.
      det.handle({ kind, nowMs: 10_000 });
      det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs });
      expect(det.snapshot().state).toBe("active");
      det.handle({ kind: "tick", nowMs: 10_000 + BASE_CONFIG.idleThresholdMs });
      // cycle.start / tts.start leave their flag set, which suppresses idle;
      // the other kinds do not — so we only assert the timer re-anchored,
      // not the state at the post-reset boundary.
      expect(det.snapshot().lastResetAtMs).toBe(10_000);
    });
  }

  it("multiple events in sequence keep active and re-anchor each time", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "interaction", nowMs: 5_000 });
    det.handle({ kind: "tts.end", nowMs: 20_000 });
    det.handle({ kind: "cycle.end", nowMs: 40_000 });
    // 40s + warning (54s) = 94s — still active at 90s.
    det.handle({ kind: "tick", nowMs: 90_000 });
    expect(det.snapshot().state).toBe("active");
    // 40s + 54s = 94s — warning.
    det.handle({ kind: "tick", nowMs: 94_000 });
    expect(det.snapshot().state).toBe("warning");
    // 40s + 60s = 100s — idle.
    det.handle({ kind: "tick", nowMs: 100_000 });
    expect(det.snapshot().state).toBe("idle");
  });
});

describe("createIdleDetector — cycle suppression", () => {
  it("sets cycleActive on cycle.start and clears on cycle.end", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "cycle.start", nowMs: 0 });
    expect(det.snapshot().cycleActive).toBe(true);
    det.handle({ kind: "cycle.end", nowMs: 1_000 });
    expect(det.snapshot().cycleActive).toBe(false);
  });

  it("blocks idle transition while cycleActive is set", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "cycle.start", nowMs: 0 });
    // Tick well past idle threshold.
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 30_000 });
    // Idle would fire naturally, but suppression clamps to warning.
    expect(det.snapshot().state).toBe("warning");
  });

  it("resumes idle transition after cycle.end clears the flag", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "cycle.start", nowMs: 0 });
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 10_000 });
    expect(det.snapshot().state).toBe("warning");
    // Cycle ends at 100s, re-anchoring the timer.
    det.handle({ kind: "cycle.end", nowMs: 100_000 });
    expect(det.snapshot().state).toBe("active");
    // Tick 60s later — idle fires now that the flag is clear.
    det.handle({ kind: "tick", nowMs: 160_000 });
    expect(det.snapshot().state).toBe("idle");
  });
});

describe("createIdleDetector — tts suppression", () => {
  it("sets ttsActive on tts.start and clears on tts.end", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "tts.start", nowMs: 0 });
    expect(det.snapshot().ttsActive).toBe(true);
    det.handle({ kind: "tts.end", nowMs: 1_000 });
    expect(det.snapshot().ttsActive).toBe(false);
  });

  it("blocks idle transition while ttsActive is set", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "tts.start", nowMs: 0 });
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 30_000 });
    expect(det.snapshot().state).toBe("warning");
  });

  it("resumes idle transition after tts.end clears the flag", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "tts.start", nowMs: 0 });
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 10_000 });
    expect(det.snapshot().state).toBe("warning");
    det.handle({ kind: "tts.end", nowMs: 100_000 });
    det.handle({ kind: "tick", nowMs: 160_000 });
    expect(det.snapshot().state).toBe("idle");
  });
});

describe("createIdleDetector — independent cycle + tts flags", () => {
  it("still blocks idle while only ttsActive is set (cycle cleared first)", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "cycle.start", nowMs: 0 });
    det.handle({ kind: "tts.start", nowMs: 0 });
    det.handle({ kind: "cycle.end", nowMs: 10_000 });
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 30_000 });
    // Cycle cleared, TTS still active → suppression still holds.
    expect(det.snapshot().state).toBe("warning");
  });

  it("still blocks idle while only cycleActive is set (tts cleared first)", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "cycle.start", nowMs: 0 });
    det.handle({ kind: "tts.start", nowMs: 0 });
    det.handle({ kind: "tts.end", nowMs: 10_000 });
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 30_000 });
    expect(det.snapshot().state).toBe("warning");
  });

  it("resumes idle only after both flags clear", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "cycle.start", nowMs: 0 });
    det.handle({ kind: "tts.start", nowMs: 0 });
    det.handle({ kind: "tts.end", nowMs: 10_000 });
    det.handle({ kind: "cycle.end", nowMs: 20_000 });
    det.handle({ kind: "tick", nowMs: 20_000 + BASE_CONFIG.idleThresholdMs });
    expect(det.snapshot().state).toBe("idle");
  });
});

describe("createIdleDetector — demandStay suppression", () => {
  it("increments demandStayCount on acquire and decrements on release", () => {
    const det = createIdleDetector(BASE_CONFIG);
    const rel = det.acquireDemandStay();
    expect(det.snapshot().demandStayCount).toBe(1);
    rel();
    expect(det.snapshot().demandStayCount).toBe(0);
  });

  it("blocks idle transition while any demand is held", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.acquireDemandStay();
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 30_000 });
    expect(det.snapshot().state).toBe("warning");
  });

  it("resumes idle after the last demand is released", () => {
    const det = createIdleDetector(BASE_CONFIG);
    const rel = det.acquireDemandStay();
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 10_000 });
    expect(det.snapshot().state).toBe("warning");
    rel();
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 20_000 });
    expect(det.snapshot().state).toBe("idle");
  });

  it("requires every parallel demand to release before suppression lifts", () => {
    const det = createIdleDetector(BASE_CONFIG);
    const a = det.acquireDemandStay();
    const b = det.acquireDemandStay();
    expect(det.snapshot().demandStayCount).toBe(2);
    a();
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 10_000 });
    expect(det.snapshot().state).toBe("warning");
    b();
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs + 20_000 });
    expect(det.snapshot().state).toBe("idle");
  });

  it("release is idempotent — calling it twice does not underflow the counter", () => {
    const det = createIdleDetector(BASE_CONFIG);
    const rel = det.acquireDemandStay();
    rel();
    rel();
    expect(det.snapshot().demandStayCount).toBe(0);
  });
});

describe("createIdleDetector — suppressed warning still observable", () => {
  it("enters warning while suppressed, so instrumentation can still fire", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "cycle.start", nowMs: 0 });
    det.handle({ kind: "tick", nowMs: BASE_WARNING_MS });
    // Naturally warning, suppression doesn't downgrade.
    expect(det.snapshot().state).toBe("warning");
  });
});

describe("createIdleDetector — custom warning threshold", () => {
  it("honours an explicit warningThresholdMs instead of the default fraction", () => {
    const det = createIdleDetector({ idleThresholdMs: 60_000, warningThresholdMs: 10_000 });
    det.handle({ kind: "tick", nowMs: 9_999 });
    expect(det.snapshot().state).toBe("active");
    det.handle({ kind: "tick", nowMs: 10_000 });
    expect(det.snapshot().state).toBe("warning");
  });

  it("allows warningThresholdMs=0 — enters warning on the first tick at or after the anchor", () => {
    // With warningThresholdMs=0, elapsed>=0 classifies as warning. The initial
    // state is still 'active' (machine starts there before any event is seen);
    // the very first tick transitions it.
    const det = createIdleDetector({ idleThresholdMs: 60_000, warningThresholdMs: 0 });
    expect(det.snapshot().state).toBe("active");
    det.handle({ kind: "tick", nowMs: 0 });
    expect(det.snapshot().state).toBe("warning");
  });
});

describe("createIdleDetector — onStateChange subscribers", () => {
  it("fires listeners on each transition with the current snapshot", () => {
    const listener = vi.fn();
    const det = createIdleDetector(BASE_CONFIG);
    det.onStateChange(listener);
    det.handle({ kind: "tick", nowMs: BASE_WARNING_MS });
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs });
    det.handle({ kind: "interaction", nowMs: BASE_CONFIG.idleThresholdMs });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[0]?.[0].state).toBe("warning");
    expect(listener.mock.calls[1]?.[0].state).toBe("idle");
    expect(listener.mock.calls[2]?.[0].state).toBe("active");
  });

  it("does not fire on same-state ticks", () => {
    const listener = vi.fn();
    const det = createIdleDetector(BASE_CONFIG);
    det.onStateChange(listener);
    det.handle({ kind: "tick", nowMs: 1_000 });
    det.handle({ kind: "tick", nowMs: 2_000 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe stops future notifications", () => {
    const listener = vi.fn();
    const det = createIdleDetector(BASE_CONFIG);
    const unsub = det.onStateChange(listener);
    det.handle({ kind: "tick", nowMs: BASE_WARNING_MS });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    det.handle({ kind: "tick", nowMs: BASE_CONFIG.idleThresholdMs });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("createIdleDetector — monotonic clock discipline", () => {
  it("ignores a tick whose nowMs is before the last anchor (non-monotonic)", () => {
    const det = createIdleDetector(BASE_CONFIG);
    det.handle({ kind: "interaction", nowMs: 10_000 });
    // A late / out-of-order tick before the anchor should not retroactively
    // drive the detector into warning/idle.
    det.handle({ kind: "tick", nowMs: 5_000 });
    expect(det.snapshot().state).toBe("active");
  });
});
