import { beforeEach, describe, expect, it } from "vitest";
import { createSpeechGate } from "./speech-gate.ts";

let counter = 0;
beforeEach(() => {
  counter = 0;
});
function frame(): Float32Array {
  counter += 1;
  return new Float32Array([counter]);
}
function ids(frames: readonly Float32Array[]): number[] {
  return frames.map((f) => f[0] ?? -1);
}

const CFG = {
  openDebounceMs: 200,
  frameDurationMs: 10,
  gapToleranceFrames: 3,
  preRollFrames: 24,
  maxOpenMs: 20_000,
};

describe("SpeechGate latch", () => {
  it("stays closed and buffers while speech has not yet sustained", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = (): number => {
      now += 10;
      return now;
    };
    for (let i = 0; i < 19; i++) {
      const r = gate.process(frame(), true, tick());
      expect(r.opened).toBe(false);
      expect(r.forward).toEqual([]);
    }
    expect(gate.state()).toBe("closed");
  });

  it("opens on the frame that reaches the debounce and flushes the buffered onset", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = (): number => {
      now += 10;
      return now;
    };
    const sent: Float32Array[] = [];
    let opened = false;
    for (let i = 0; i < 20; i++) {
      const r = gate.process(frame(), true, tick());
      if (r.opened) opened = true;
      sent.push(...r.forward);
    }
    expect(opened).toBe(true);
    expect(gate.state()).toBe("open");
    // 200ms / 10ms = 20 frames to open; frame 20 triggers, frame 19 does not.
    expect(ids(sent)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("forwards every frame once open, including non-speech (trailing silence)", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = (): number => {
      now += 10;
      return now;
    };
    for (let i = 0; i < 20; i++) gate.process(frame(), true, tick());
    expect(gate.state()).toBe("open");
    const sp = frame();
    expect(ids(gate.process(sp, true, tick()).forward)).toEqual([sp[0]]);
    const sil = frame();
    expect(ids(gate.process(sil, false, tick()).forward)).toEqual([sil[0]]);
  });

  it("never opens on a transient shorter than the debounce (cough/knock)", () => {
    const gate = createSpeechGate(CFG); // 200ms debounce, gapTolerance 3
    let now = 0;
    const tick = (): number => {
      now += 10;
      return now;
    };
    for (let i = 0; i < 10; i++) expect(gate.process(frame(), true, tick()).opened).toBe(false);
    for (let i = 0; i < 4; i++) gate.process(frame(), false, tick()); // >gapTolerance → sustain resets
    for (let i = 0; i < 5; i++) expect(gate.process(frame(), true, tick()).opened).toBe(false);
    expect(gate.state()).toBe("closed");
  });

  it("tolerates a brief sub-threshold flicker and still reaches open", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = (): number => {
      now += 10;
      return now;
    };
    let opened = false;
    for (let i = 0; i < 18; i++) {
      if (gate.process(frame(), true, tick()).opened) opened = true;
    }
    gate.process(frame(), false, tick()); // flicker, gap=1 tolerated
    for (let i = 0; i < 3; i++) {
      if (gate.process(frame(), true, tick()).opened) opened = true;
    }
    expect(opened).toBe(true);
    expect(gate.state()).toBe("open");
  });

  it("close() resets an open gate and clears the ring", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = (): number => {
      now += 10;
      return now;
    };
    for (let i = 0; i < 20; i++) gate.process(frame(), true, tick());
    expect(gate.state()).toBe("open");
    gate.close();
    expect(gate.state()).toBe("closed");
  });

  it("reopens for a fresh utterance after close()", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = (): number => {
      now += 10;
      return now;
    };
    for (let i = 0; i < 20; i++) gate.process(frame(), true, tick());
    gate.close();
    let opened = false;
    for (let i = 0; i < 20; i++) {
      if (gate.process(frame(), true, tick()).opened) opened = true;
    }
    expect(opened).toBe(true);
    expect(gate.state()).toBe("open");
  });

  it("force-closes after maxOpenMs when no transcript arrives", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = (): number => {
      now += 10;
      return now;
    };
    for (let i = 0; i < 20; i++) gate.process(frame(), true, tick());
    expect(gate.state()).toBe("open");
    const r = gate.process(frame(), true, 100_000);
    expect(r.forward).toEqual([]);
    expect(gate.state()).toBe("closed");
  });
});
