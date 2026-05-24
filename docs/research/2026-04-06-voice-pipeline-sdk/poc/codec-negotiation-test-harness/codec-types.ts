// Re-export types from consumer-api PoC (in real project these would be shared)
export type Encoding = "pcm16" | "opus";

export interface AudioCapabilities {
  supportedEncodings: Encoding[];
  preferredEncoding: Encoding;
  captureSampleRate: number;
  playbackSampleRate: number;
}

export interface NegotiatedFormat {
  encoding: Encoding;
  captureSampleRate: number;
  playbackSampleRate: number;
}

export interface AudioCodec {
  readonly encoding: Encoding;
  encode(samples: Float32Array): Uint8Array;
  decode(data: Uint8Array): Float32Array;
}

export interface Resampler {
  resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array;
}
