import { describe, expect, it } from "vitest";
import { downsamplePcm16 } from "./pcm-resampler.ts";

function pcm16Of(samples: number[]): Uint8Array {
  const arr = new Int16Array(samples);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function toInt16(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

describe("downsamplePcm16", () => {
  it("returns input unchanged when rates match", () => {
    const input = pcm16Of([1, 2, 3, 4]);
    const output = downsamplePcm16(input, 16000, 16000);
    expect(Array.from(toInt16(output))).toEqual([1, 2, 3, 4]);
  });

  it("downsamples 48k → 16k by roughly 3×", () => {
    const samples = Array.from({ length: 48 }, (_, i) => i * 100);
    const output = downsamplePcm16(pcm16Of(samples), 48000, 16000);
    expect(toInt16(output).length).toBe(16);
  });

  it("handles empty input", () => {
    const output = downsamplePcm16(new Uint8Array(0), 48000, 16000);
    expect(output.byteLength).toBe(0);
  });

  it("preserves sample magnitude roughly (sanity check)", () => {
    const input = pcm16Of(new Array(48).fill(10_000));
    const output = downsamplePcm16(input, 48000, 16000);
    const outSamples = toInt16(output);
    for (const s of outSamples) {
      expect(Math.abs(s - 10_000)).toBeLessThan(10);
    }
  });
});
