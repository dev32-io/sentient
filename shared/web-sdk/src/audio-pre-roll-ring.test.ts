import { describe, expect, it } from "vitest";
import { createAudioPreRollRing } from "./audio-pre-roll-ring.ts";

let counter = 0;
function frame(): ArrayBuffer {
  counter += 1;
  return new Uint8Array([counter & 0xff]).buffer;
}

function tags(buffers: readonly ArrayBuffer[]): number[] {
  return buffers.map((b) => new Uint8Array(b)[0] ?? -1);
}

describe("AudioPreRollRing FSM", () => {
  it("buffers rejected frames silently while idle and emits nothing", () => {
    const ring = createAudioPreRollRing({ preRollFrames: 3, hangoverFrames: 2 });
    expect(ring.push(frame(), false)).toEqual([]);
    expect(ring.push(frame(), false)).toEqual([]);
    expect(ring.push(frame(), false)).toEqual([]);
    expect(ring.push(frame(), false)).toEqual([]);
  });

  it("flushes the buffered pre-roll ahead of the first accepted frame", () => {
    const ring = createAudioPreRollRing({ preRollFrames: 3, hangoverFrames: 2 });
    const a = frame();
    const b = frame();
    const c = frame();
    const speech = frame();
    ring.push(a, false);
    ring.push(b, false);
    ring.push(c, false);
    const out = ring.push(speech, true);
    expect(tags(out)).toEqual([tags([a])[0], tags([b])[0], tags([c])[0], tags([speech])[0]]);
  });

  it("trims the pre-roll ring to the configured size (drops oldest)", () => {
    const ring = createAudioPreRollRing({ preRollFrames: 2, hangoverFrames: 0 });
    const dropped = frame();
    const b = frame();
    const c = frame();
    const speech = frame();
    ring.push(dropped, false);
    ring.push(b, false);
    ring.push(c, false);
    const out = ring.push(speech, true);
    expect(tags(out)).toEqual([tags([b])[0], tags([c])[0], tags([speech])[0]]);
    expect(tags(out)).not.toContain(tags([dropped])[0]);
  });

  it("emits each accepted frame as-is while active", () => {
    const ring = createAudioPreRollRing({ preRollFrames: 2, hangoverFrames: 2 });
    ring.push(frame(), true);
    const second = frame();
    const out = ring.push(second, true);
    expect(out.length).toBe(1);
    expect(tags(out)).toEqual([tags([second])[0]]);
  });

  it("emits hangover frames after speech ends, then falls silent", () => {
    const ring = createAudioPreRollRing({ preRollFrames: 3, hangoverFrames: 2 });
    ring.push(frame(), true);
    const tail1 = frame();
    const tail2 = frame();
    const afterTail = frame();
    expect(tags(ring.push(tail1, false))).toEqual([tags([tail1])[0]]);
    expect(tags(ring.push(tail2, false))).toEqual([tags([tail2])[0]]);
    expect(ring.push(afterTail, false)).toEqual([]); // counter exhausted, frame buffered
  });

  it("re-arms the hangover counter on accept-during-hangover", () => {
    const ring = createAudioPreRollRing({ preRollFrames: 3, hangoverFrames: 2 });
    ring.push(frame(), true);
    expect(ring.push(frame(), false).length).toBe(1); // hangover 1/2 used
    ring.push(frame(), true); // re-arm to 2
    expect(ring.push(frame(), false).length).toBe(1); // hangover 1/2 used
    expect(ring.push(frame(), false).length).toBe(1); // hangover 2/2 used
    expect(ring.push(frame(), false).length).toBe(0); // exhausted
  });

  it("reset clears the ring and returns to idle", () => {
    const ring = createAudioPreRollRing({ preRollFrames: 2, hangoverFrames: 2 });
    ring.push(frame(), false);
    ring.push(frame(), true);
    ring.reset();
    const afterReset = frame();
    const out = ring.push(afterReset, true);
    expect(out.length).toBe(1);
    expect(tags(out)).toEqual([tags([afterReset])[0]]);
  });

  it("with zero pre-roll and zero hangover behaves like a pass-through gate", () => {
    const ring = createAudioPreRollRing({ preRollFrames: 0, hangoverFrames: 0 });
    expect(ring.push(frame(), false)).toEqual([]);
    const speech = frame();
    expect(tags(ring.push(speech, true))).toEqual([tags([speech])[0]]);
    expect(ring.push(frame(), false)).toEqual([]);
  });

  it("works with a non-ArrayBuffer frame type (Float32Array)", () => {
    const ring = createAudioPreRollRing<Float32Array>({ preRollFrames: 2, hangoverFrames: 0 });
    const a = new Float32Array([1]);
    const b = new Float32Array([2]);
    const c = new Float32Array([3]);
    expect(ring.push(a, false)).toEqual([]); // buffered
    expect(ring.push(b, false)).toEqual([]); // buffered (ring full: [a,b])
    expect(ring.push(c, true)).toEqual([a, b, c]); // accept → flush pre-roll [a,b] + current c
  });
});
