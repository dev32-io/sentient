import { describe, expect, it } from "vitest";
import { float32ToPcm16, pcm16ToFloat32 } from "./audio-codec.ts";

describe("audio-codec", () => {
  it("converts Float32 to PCM16 and back (roundtrip)", () => {
    const original = new Float32Array([0, 0.5, -0.5, 1.0, -1.0]);
    const pcm16 = float32ToPcm16(original);
    expect(pcm16).toBeInstanceOf(Uint8Array);
    expect(pcm16.byteLength).toBe(original.length * 2);

    const restored = pcm16ToFloat32(pcm16.buffer as ArrayBuffer);
    // Allow ±1 LSB quantization error
    for (let i = 0; i < original.length; i++) {
      const value = restored[i];
      const originalValue = original[i];
      if (value !== undefined && originalValue !== undefined) {
        expect(value).toBeCloseTo(originalValue, 2);
      }
    }
  });

  it("pcm16ToFloat32 converts Int16 range to [-1, 1)", () => {
    const int16 = new Int16Array([0, 16384, -16384, 32767, -32768]);
    const result = pcm16ToFloat32(int16.buffer as ArrayBuffer);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeCloseTo(0.5, 2);
    expect(result[2]).toBeCloseTo(-0.5, 2);
    expect(result[3]).toBeCloseTo(1.0, 2);
    expect(result[4]).toBeCloseTo(-1.0, 2);
  });

  it("float32ToPcm16 clamps values outside [-1, 1]", () => {
    const input = new Float32Array([2.0, -2.0]);
    const pcm16 = float32ToPcm16(input);
    const view = new Int16Array(pcm16.buffer);
    // clamped to max
    expect(view[0]).toBe(32767);
    // clamped to min
    expect(view[1]).toBe(-32768);
  });
});
