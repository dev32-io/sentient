import { describe, expect, it } from "vitest";
import { pcmToWav } from "./pcm-to-wav.ts";

describe("pcmToWav", () => {
  it("prepends a 44-byte mono/16-bit RIFF header with correct rate + sizes", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]); // 2 samples
    const wav = pcmToWav(pcm, 24000);
    const dv = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(dv.getUint16(22, true)).toBe(1); // channels
    expect(dv.getUint32(24, true)).toBe(24000); // sample rate
    expect(dv.getUint16(34, true)).toBe(16); // bits/sample
    expect(dv.getUint32(40, true)).toBe(4); // data bytes
    expect(wav.length).toBe(44 + 4);
  });
});
