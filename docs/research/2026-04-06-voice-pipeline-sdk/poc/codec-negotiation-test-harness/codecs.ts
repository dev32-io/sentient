// Codec implementations under test
import type { AudioCodec, Resampler } from "./codec-types";

export class PCM16Codec implements AudioCodec {
  readonly encoding = "pcm16" as const;

  encode(samples: Float32Array): Uint8Array {
    const buf = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buf);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]!));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }

  decode(data: Uint8Array): Float32Array {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const samples = new Float32Array(data.byteLength / 2);
    for (let i = 0; i < samples.length; i++) {
      const int16 = view.getInt16(i * 2, true);
      samples[i] = int16 / (int16 < 0 ? 0x8000 : 0x7fff);
    }
    return samples;
  }
}

export class OpusCodec implements AudioCodec {
  readonly encoding = "opus" as const;
  encode(_samples: Float32Array): Uint8Array {
    throw new Error("Opus encoding not yet implemented");
  }
  decode(_data: Uint8Array): Float32Array {
    throw new Error("Opus decoding not yet implemented");
  }
}

export class LinearResampler implements Resampler {
  resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const len = Math.ceil(input.length / ratio);
    const output = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const src = i * ratio;
      const floor = Math.floor(src);
      const frac = src - floor;
      const a = input[floor] ?? 0;
      const b = input[Math.min(floor + 1, input.length - 1)] ?? 0;
      output[i] = a + frac * (b - a);
    }
    return output;
  }
}

const CODECS: Record<string, () => AudioCodec> = {
  pcm16: () => new PCM16Codec(),
  opus: () => new OpusCodec(),
};

export function getCodec(encoding: string): AudioCodec {
  const factory = CODECS[encoding];
  if (!factory) throw new Error(`Unsupported encoding: ${encoding}`);
  return factory();
}
