// Gateway-side negotiation under test
import type { AudioCapabilities, Encoding, NegotiatedFormat, Resampler, AudioCodec } from "./codec-types";
import { getCodec, LinearResampler } from "./codecs";

export interface GatewayAudioConfig {
  supportedEncodings?: Encoding[];
  sttSampleRate?: number;
  ttsSampleRate?: number;
}

export class GatewayNegotiator {
  private readonly supported: Set<Encoding>;
  private readonly sttRate: number;
  private readonly ttsRate: number;
  private readonly resampler: Resampler;

  private format: NegotiatedFormat | null = null;
  private codec: AudioCodec | null = null;
  private clientCaptureRate = 48_000;
  private clientPlaybackRate = 44_100;

  constructor(config: GatewayAudioConfig = {}) {
    this.supported = new Set(config.supportedEncodings ?? ["pcm16"]);
    this.sttRate = config.sttSampleRate ?? 16_000;
    this.ttsRate = config.ttsSampleRate ?? 48_000;
    this.resampler = new LinearResampler();
  }

  negotiate(caps: AudioCapabilities): NegotiatedFormat {
    let encoding: Encoding = "pcm16";
    if (this.supported.has(caps.preferredEncoding)) {
      encoding = caps.preferredEncoding;
    } else {
      for (const enc of caps.supportedEncodings) {
        if (this.supported.has(enc)) { encoding = enc; break; }
      }
    }

    this.clientCaptureRate = caps.captureSampleRate;
    this.clientPlaybackRate = caps.playbackSampleRate;
    this.codec = getCodec(encoding);

    this.format = {
      encoding,
      captureSampleRate: caps.captureSampleRate,
      playbackSampleRate: caps.playbackSampleRate,
    };
    return { ...this.format };
  }

  prepareForSTT(data: Uint8Array): Float32Array {
    if (!this.codec) throw new Error("Not negotiated");
    const decoded = this.codec.decode(data);
    return this.resampler.resample(decoded, this.clientCaptureRate, this.sttRate);
  }

  prepareForClient(samples: Float32Array): Uint8Array {
    if (!this.codec) throw new Error("Not negotiated");
    const resampled = this.resampler.resample(samples, this.ttsRate, this.clientPlaybackRate);
    return this.codec.encode(resampled);
  }

  get negotiatedFormat(): NegotiatedFormat | null {
    return this.format ? { ...this.format } : null;
  }
}
