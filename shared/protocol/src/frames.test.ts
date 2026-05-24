import { describe, expect, it } from "vitest";
import { framePriority, isDataFrame, isSystemFrame } from "./frames.ts";
import type { AudioFrame, InterruptionFrame, StartFrame } from "./frames.ts";

describe("framePriority", () => {
  it("returns 1 for system frames", () => {
    const frame: InterruptionFrame = {
      kind: "system",
      type: "interruption",
      sessionId: "s1",
      timestamp: Date.now(),
    };
    expect(framePriority(frame)).toBe(1);
  });

  it("returns 2 for data frames", () => {
    const frame: AudioFrame = {
      kind: "data",
      type: "audio",
      data: new Uint8Array(0),
      encoding: "opus",
      sampleRate: 48000,
    };
    expect(framePriority(frame)).toBe(2);
  });

  it("returns 2 for control frames", () => {
    const frame: StartFrame = {
      kind: "control",
      type: "start",
      sessionId: "s1",
    };
    expect(framePriority(frame)).toBe(2);
  });
});

describe("type guards", () => {
  it("identifies system frames", () => {
    const frame: InterruptionFrame = {
      kind: "system",
      type: "interruption",
      sessionId: "s1",
      timestamp: Date.now(),
    };
    expect(isSystemFrame(frame)).toBe(true);
    expect(isDataFrame(frame)).toBe(false);
  });
});
