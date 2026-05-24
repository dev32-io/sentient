// ── Shared types: the only thing a developer needs to know ──

export type Encoding = "pcm16" | "opus";

/** What the SDK sends at connection time */
export interface AudioCapabilities {
  supportedEncodings: Encoding[];
  preferredEncoding: Encoding;
  captureSampleRate: number;   // mic native rate (e.g. 48000)
  playbackSampleRate: number;  // speaker native rate (e.g. 44100)
}

/** What the gateway confirms back */
export interface NegotiatedFormat {
  encoding: Encoding;
  captureSampleRate: number;   // rate client should send
  playbackSampleRate: number;  // rate gateway will send
}

/** Codec module — encode/decode audio. SDK picks the right one automatically. */
export interface AudioCodec {
  readonly encoding: Encoding;
  encode(samples: Float32Array): Uint8Array;
  decode(data: Uint8Array): Float32Array;
}

/** Resampler — convert between sample rates. Gateway uses this internally. */
export interface Resampler {
  resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array;
}
