// ── AudioSession — the SDK's codec negotiation surface ──
// Developer creates this, SDK handles negotiation + codec selection internally.

import type { AudioCapabilities, AudioCodec, Encoding, NegotiatedFormat } from "./codec-types";
import { getCodec } from "./codecs";

export interface AudioSessionConfig {
  /** Preferred encoding. Default: "pcm16" */
  preferredEncoding?: Encoding;
  /** Extra encodings the client can handle. Default: ["pcm16"] */
  supportedEncodings?: Encoding[];
  /** Mic sample rate. Default: auto-detected from AudioContext */
  captureSampleRate?: number;
  /** Playback sample rate. Default: auto-detected from AudioContext */
  playbackSampleRate?: number;
}

export class AudioSession {
  private format: NegotiatedFormat | null = null;
  private codec: AudioCodec | null = null;
  private readonly capabilities: AudioCapabilities;

  constructor(config: AudioSessionConfig = {}) {
    this.capabilities = {
      supportedEncodings: config.supportedEncodings ?? ["pcm16"],
      preferredEncoding: config.preferredEncoding ?? "pcm16",
      captureSampleRate: config.captureSampleRate ?? 48_000,
      playbackSampleRate: config.playbackSampleRate ?? 44_100,
    };
  }

  /** Called internally by SDK transport on connect. Returns session.start payload. */
  getCapabilities(): AudioCapabilities {
    return { ...this.capabilities };
  }

  /** Called internally when gateway sends session.ready. */
  applyNegotiatedFormat(format: NegotiatedFormat): void {
    this.format = format;
    this.codec = getCodec(format.encoding);
  }

  /** Encode mic samples for sending to gateway. */
  encode(samples: Float32Array): Uint8Array {
    if (!this.codec) throw new Error("Session not negotiated yet");
    return this.codec.encode(samples);
  }

  /** Decode gateway audio for playback. */
  decode(data: Uint8Array): Float32Array {
    if (!this.codec) throw new Error("Session not negotiated yet");
    return this.codec.decode(data);
  }

  /** Current negotiated encoding, or null if not yet negotiated. */
  get encoding(): Encoding | null {
    return this.format?.encoding ?? null;
  }

  /** Whether negotiation is complete and encode/decode are safe to call. */
  get isReady(): boolean {
    return this.format !== null;
  }
}
