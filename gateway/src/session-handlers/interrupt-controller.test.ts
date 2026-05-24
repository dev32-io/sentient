import { describe, expect, it, vi } from "vitest";
import { createAbortSlot } from "./abort-slot.js";
import { createInterruptController } from "./interrupt-controller.js";

function fakeWire() {
  return {
    sendPlaybackStop: vi.fn(),
  };
}

function fakeTaskMirror() {
  return {
    clearCycle: vi.fn(),
    snapshot: vi.fn(() => []),
  };
}

function fakeAttentionGate() {
  return {
    clearPendingConversationSalience: vi.fn(),
  };
}

describe("InterruptController", () => {
  it("aborts cycle + clears tasks + sends playback.stop", () => {
    const cycleSlot = createAbortSlot("cycle");
    const wire = fakeWire();
    const tm = fakeTaskMirror();
    const ag = fakeAttentionGate();
    const cycleCtrl = new AbortController();
    cycleSlot.register("cycle-1", cycleCtrl);

    const ctrl = createInterruptController({
      cycleSlot,
      taskMirror: tm,
      wire,
      attentionGate: ag,
    });

    ctrl.trigger();

    expect(cycleCtrl.signal.aborted).toBe(true);
    expect(tm.clearCycle).toHaveBeenCalledWith("cycle-1");
    expect(wire.sendPlaybackStop).toHaveBeenCalledWith("cycle-1", "interrupt", []);
  });

  it("emits playback.stop with empty cycleId even when no active cycle (browser flush)", () => {
    const cycleSlot = createAbortSlot("cycle");
    const wire = fakeWire();
    const tm = fakeTaskMirror();
    const ag = fakeAttentionGate();

    const ctrl = createInterruptController({
      cycleSlot,
      taskMirror: tm,
      wire,
      attentionGate: ag,
    });

    ctrl.trigger();

    // Always-fire playback.stop is intentional: it is the SDK's only kill
    // switch for a wedged playback queue. See comment in interrupt-controller.
    expect(wire.sendPlaybackStop).toHaveBeenCalledWith("", "interrupt", []);
    expect(tm.clearCycle).not.toHaveBeenCalled();
  });

  it("trigger() calls attentionGate.clearPendingConversationSalience exactly once", () => {
    const cycleSlot = createAbortSlot("cycle");
    const wire = fakeWire();
    const tm = fakeTaskMirror();
    const ag = fakeAttentionGate();
    cycleSlot.register("cycle-1", new AbortController());

    const ctrl = createInterruptController({
      cycleSlot,
      taskMirror: tm,
      wire,
      attentionGate: ag,
    });

    ctrl.trigger();

    expect(ag.clearPendingConversationSalience).toHaveBeenCalledTimes(1);
  });

  it("clearPendingConversationSalience is called even when no active cycle", () => {
    const cycleSlot = createAbortSlot("cycle");
    const wire = fakeWire();
    const tm = fakeTaskMirror();
    const ag = fakeAttentionGate();

    const ctrl = createInterruptController({
      cycleSlot,
      taskMirror: tm,
      wire,
      attentionGate: ag,
    });

    ctrl.trigger();

    expect(ag.clearPendingConversationSalience).toHaveBeenCalledTimes(1);
    expect(wire.sendPlaybackStop).toHaveBeenCalledWith("", "interrupt", []);
  });
});
