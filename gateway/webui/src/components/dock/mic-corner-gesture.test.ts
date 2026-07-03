import { describe, expect, it } from "vitest";
import { clampDrag, isArmed, resolveRelease } from "./mic-corner-gesture.ts";

// FSM invariants for the corner mic: hold→lock and locked→release thresholds
// decide whether the mic stays on. A drifted threshold silently turns
// push-to-talk into stuck-open mic (or the reverse), so the boundaries are pinned.

const TRAVEL = 100;

describe("resolveRelease from a hold (origin idle)", () => {
  it("returns idle when released below the lock threshold", () => {
    expect(resolveRelease("idle", 39, TRAVEL)).toEqual({ mode: "idle", drag: 0 });
  });

  it("locks when released at the lock threshold", () => {
    expect(resolveRelease("idle", 40, TRAVEL)).toEqual({ mode: "locked", drag: TRAVEL });
  });

  it("locks when released past the lock threshold", () => {
    expect(resolveRelease("idle", 80, TRAVEL)).toEqual({ mode: "locked", drag: TRAVEL });
  });

  it("returns idle on a plain tap with no drag", () => {
    expect(resolveRelease("idle", 0, TRAVEL)).toEqual({ mode: "idle", drag: 0 });
  });
});

describe("resolveRelease from locked (origin locked)", () => {
  it("stays locked when barely dragged back", () => {
    expect(resolveRelease("locked", 80, TRAVEL)).toEqual({ mode: "locked", drag: TRAVEL });
  });

  it("releases when dragged back to the unlock threshold", () => {
    expect(resolveRelease("locked", 50, TRAVEL)).toEqual({ mode: "idle", drag: 0 });
  });

  it("releases when dragged fully back", () => {
    expect(resolveRelease("locked", 0, TRAVEL)).toEqual({ mode: "idle", drag: 0 });
  });

  it("stays locked on a plain tap (no drag from the locked end)", () => {
    expect(resolveRelease("locked", TRAVEL, TRAVEL)).toEqual({ mode: "locked", drag: TRAVEL });
  });
});

describe("clampDrag", () => {
  it("tracks leftward pointer movement from an idle origin", () => {
    expect(clampDrag(0, 200, 170, TRAVEL)).toBe(30);
  });

  it("clamps to zero when dragging rightward past the origin", () => {
    expect(clampDrag(0, 200, 260, TRAVEL)).toBe(0);
  });

  it("clamps to travel when dragging past the lock end", () => {
    expect(clampDrag(0, 200, 40, TRAVEL)).toBe(TRAVEL);
  });

  it("starts from the locked end when the origin is locked", () => {
    expect(clampDrag(TRAVEL, 200, 230, TRAVEL)).toBe(70);
  });
});

describe("isArmed", () => {
  it("arms exactly at the lock threshold", () => {
    expect(isArmed(39, TRAVEL)).toBe(false);
    expect(isArmed(40, TRAVEL)).toBe(true);
  });
});
