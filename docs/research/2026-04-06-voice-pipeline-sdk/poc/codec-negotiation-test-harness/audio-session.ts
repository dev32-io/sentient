// SDK-side audio session under test
import type { AudioCapabilities, AudioCodec, Encoding, NegotiatedFormat } from "./codec-types";
import { getCodec } from "./codecs";

export interface AudioSessionConfig {
  preferredEncoding?: Encoding;
  supportedEncodings?: Encoding[];
  captureSampleRate?: number;
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

  getCapabilities(): AudioCapabilities {
    return { ...this.capabilities };
  }

  applyNegotiatedFormat(format: NegotiatedFormat): void {
    this.format = format;
    this.codec = getCodec(format.encoding);
  }

  encode(samples: Float32Array): Uint8Array {
    if (!this.codec) throw new Error("Session not negotiated yet");
    return this.codec.encode(samples);
  }

  decode(data: Uint8Array): Float32Array {
    if (!this.codec) throw new Error("Session not negotiated yet");
    return this.codec.decode(data);
  }

  get encoding(): Encoding | null {
    return this.format?.encoding ?? null;
  }

  get isReady(): boolean {
    return this.format !== null;
  }
}
