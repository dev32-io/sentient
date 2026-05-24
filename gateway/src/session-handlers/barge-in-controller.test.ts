import { describe, expect, it, vi } from "vitest";
import { createBargeInController } from "./barge-in-controller.js";

describe("BargeInController", () => {
  it("no-ops when no cycle id available", () => {
    const taskMirror = {
      snapshot: vi.fn(() => []),
      clearCycle: vi.fn(),
    };
    const wire = { sendPlaybackStop: vi.fn() };
    const currentCycleId = vi.fn(() => null);

    const cancelTts = vi.fn();
    const ctrl = createBargeInController({ taskMirror, wire, currentCycleId, cancelTts });
    ctrl.trigger();

    expect(wire.sendPlaybackStop).not.toHaveBeenCalled();
  });

  it("sends playback.stop on barge-in with current cycle id", () => {
    const taskMirror = {
      snapshot: vi.fn(() => []),
      clearCycle: vi.fn(),
    };
    const wire = { sendPlaybackStop: vi.fn() };
    const currentCycleId = vi.fn(() => "cycle-1");

    const cancelTts = vi.fn();
    const ctrl = createBargeInController({ taskMirror, wire, currentCycleId, cancelTts });
    ctrl.trigger();

    expect(wire.sendPlaybackStop).toHaveBeenCalledWith("cycle-1", "barge-in", []);
    expect(cancelTts).toHaveBeenCalled();
  });

  it("dispose prevents trigger from running", () => {
    const taskMirror = {
      snapshot: vi.fn(() => []),
      clearCycle: vi.fn(),
    };
    const wire = { sendPlaybackStop: vi.fn() };
    const currentCycleId = vi.fn(() => "cycle-1");

    const cancelTts = vi.fn();
    const ctrl = createBargeInController({ taskMirror, wire, currentCycleId, cancelTts });
    ctrl.dispose();
    ctrl.trigger();

    expect(wire.sendPlaybackStop).not.toHaveBeenCalled();
  });
});
