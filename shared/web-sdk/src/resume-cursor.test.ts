// ---------------------------------------------------------------------------
// resume-cursor — wire-contract tests for seq dedup and epoch tracking.
//
// Pins: FSM/invariant (seq cursor advance + dedup rule), protocol contract
// (first seq 1 > 0 applied; replay seq <= lastSeq dropped).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { createResumeCursor } from "./resume-cursor.ts";

describe("createResumeCursor — initial state", () => {
  it("starts with epoch 0 and lastSeq 0", () => {
    const c = createResumeCursor();
    expect(c.cursor).toEqual({ epoch: 0, lastSeq: 0 });
  });
});

describe("createResumeCursor — tryApply seq=0 (no seq)", () => {
  it("always passes through seq=0 frames (no seq field)", () => {
    const c = createResumeCursor();
    expect(c.tryApply(0)).toBe(true);
    expect(c.tryApply(0)).toBe(true);
    expect(c.cursor.lastSeq).toBe(0); // unchanged
  });
});

describe("createResumeCursor — seq dedup", () => {
  it("applies the first seq (1 > 0) and advances lastSeq", () => {
    const c = createResumeCursor();
    expect(c.tryApply(1)).toBe(true);
    expect(c.cursor.lastSeq).toBe(1);
  });

  it("applies seq strictly greater than lastSeq", () => {
    const c = createResumeCursor();
    c.tryApply(5);
    expect(c.tryApply(6)).toBe(true);
    expect(c.cursor.lastSeq).toBe(6);
  });

  it("drops a seq equal to lastSeq (duplicate / replay)", () => {
    const c = createResumeCursor();
    c.tryApply(3);
    expect(c.tryApply(3)).toBe(false);
    expect(c.cursor.lastSeq).toBe(3); // unchanged
  });

  it("drops a seq less than lastSeq (already applied)", () => {
    const c = createResumeCursor();
    c.tryApply(10);
    expect(c.tryApply(7)).toBe(false);
    expect(c.cursor.lastSeq).toBe(10);
  });

  it("applies seq after a gap (non-consecutive)", () => {
    const c = createResumeCursor();
    c.tryApply(1);
    c.tryApply(2);
    // Simulate a gap — seq 5 received without 3/4.
    expect(c.tryApply(5)).toBe(true);
    expect(c.cursor.lastSeq).toBe(5);
  });
});

describe("createResumeCursor — epoch handling", () => {
  it("records epoch from the first epoch-bearing frame", () => {
    const c = createResumeCursor();
    c.tryApply(1, 42);
    expect(c.cursor.epoch).toBe(42);
  });

  it("epoch=0 is treated as absent (does not reset)", () => {
    const c = createResumeCursor();
    c.tryApply(5, 7);
    expect(c.cursor.epoch).toBe(7);
    c.tryApply(6, 0); // epoch=0 → ignored
    expect(c.cursor.epoch).toBe(7);
    expect(c.cursor.lastSeq).toBe(6);
  });

  it("epoch change resets lastSeq and applies the new epoch's first seq", () => {
    const c = createResumeCursor();
    c.tryApply(100, 1);
    // Gateway restarted — new epoch, seq resets from 1.
    expect(c.tryApply(1, 2)).toBe(true);
    expect(c.cursor.epoch).toBe(2);
    expect(c.cursor.lastSeq).toBe(1);
  });

  it("same epoch: dedup still works after epoch is set", () => {
    const c = createResumeCursor();
    c.tryApply(3, 5);
    expect(c.tryApply(3, 5)).toBe(false);
    expect(c.tryApply(4, 5)).toBe(true);
  });
});

describe("createResumeCursor — reset", () => {
  it("reset clears both epoch and lastSeq", () => {
    const c = createResumeCursor();
    c.tryApply(50, 9);
    c.reset();
    expect(c.cursor).toEqual({ epoch: 0, lastSeq: 0 });
  });

  it("after reset, first seq (1) is applied again", () => {
    const c = createResumeCursor();
    c.tryApply(50, 9);
    c.reset();
    expect(c.tryApply(1)).toBe(true);
    expect(c.cursor.lastSeq).toBe(1);
  });

  it("reset accepts custom epoch and lastSeq", () => {
    const c = createResumeCursor();
    c.reset(7, 99);
    expect(c.cursor).toEqual({ epoch: 7, lastSeq: 99 });
  });
});
