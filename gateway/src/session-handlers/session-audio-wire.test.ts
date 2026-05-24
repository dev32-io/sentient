import { describe, expect, it, vi } from "vitest";
import { createSessionAudioWire } from "./session-audio-wire.js";

describe("SessionAudioWire", () => {
  it("sendPlaybackStop emits with barge-in reason and cancelledTaskIds", () => {
    const send = vi.fn();
    const wire = createSessionAudioWire({ wsSend: send });
    wire.sendPlaybackStop("cycle-1", "barge-in", ["t1", "t2"]);
    expect(send).toHaveBeenCalledWith({
      type: "playback.stop",
      cycleId: "cycle-1",
      reason: "barge-in",
      cancelledTaskIds: ["t1", "t2"],
    });
  });

  it("sendPlaybackStop emits with interrupt reason and cancelledTaskIds", () => {
    const send = vi.fn();
    const wire = createSessionAudioWire({ wsSend: send });
    wire.sendPlaybackStop("cycle-2", "interrupt", ["t3"]);
    expect(send).toHaveBeenCalledWith({
      type: "playback.stop",
      cycleId: "cycle-2",
      reason: "interrupt",
      cancelledTaskIds: ["t3"],
    });
  });
});
