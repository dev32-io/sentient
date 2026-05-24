/**
 * Codec Negotiation Test Harness
 *
 * Tests every component in complete isolation with mock/synthetic audio inputs.
 * Zero API keys, zero real audio hardware, zero network.
 *
 * Sections:
 *   1. PCM16Codec — encode/decode roundtrip, edge cases, data integrity
 *   2. LinearResampler — rate conversion correctness, identity, edge cases
 *   3. GatewayNegotiator — negotiation logic, encoding selection, audio pipeline
 *   4. AudioSession (SDK-side) — lifecycle, encode/decode gating, capabilities
 *   5. End-to-end mock — SDK→Gateway→STT and TTS→Gateway→SDK full roundtrip
 *   6. Error paths — pre-negotiation errors, unsupported codecs, corrupt data
 */

import { describe, test, expect } from "bun:test";
import { PCM16Codec, OpusCodec, LinearResampler, getCodec } from "./codecs";
import { GatewayNegotiator } from "./gateway-negotiator";
import { AudioSession } from "./audio-session";
import type { AudioCapabilities, NegotiatedFormat } from "./codec-types";

// ─── Synthetic Audio Helpers ─────────────────────────────────────────

/** Generate a sine wave at given frequency and sample rate */
function generateSine(freq: number, sampleRate: number, durationSec: number): Float32Array {
  const len = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    samples[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
  }
  return samples;
}

/** Generate silence */
function generateSilence(sampleCount: number): Float32Array {
  return new Float32Array(sampleCount);
}

/** Generate max-amplitude square wave (stress test for clipping) */
function generateSquare(sampleCount: number): Float32Array {
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = i % 2 === 0 ? 1.0 : -1.0;
  }
  return samples;
}

/** Standard client capabilities for most tests */
function defaultCaps(): AudioCapabilities {
  return {
    supportedEncodings: ["pcm16"],
    preferredEncoding: "pcm16",
    captureSampleRate: 48_000,
    playbackSampleRate: 44_100,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. PCM16Codec
// ═══════════════════════════════════════════════════════════════════════

describe("PCM16Codec", () => {
  const codec = new PCM16Codec();

  test("encode produces correct byte length (2 bytes per sample)", () => {
    const samples = new Float32Array(100);
    const encoded = codec.encode(samples);
    expect(encoded.byteLength).toBe(200);
  });

  test("roundtrip preserves sine wave within quantization error", () => {
    const original = generateSine(440, 48_000, 0.01); // 480 samples
    const encoded = codec.encode(original);
    const decoded = codec.decode(encoded);

    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      // int16 quantization gives ~1/32768 error ≈ 0.0001
      expect(Math.abs(decoded[i]! - original[i]!)).toBeLessThan(0.001);
    }
  });

  test("roundtrip preserves silence exactly", () => {
    const silence = generateSilence(256);
    const decoded = codec.decode(codec.encode(silence));
    for (let i = 0; i < silence.length; i++) {
      expect(decoded[i]).toBe(0);
    }
  });

  test("clamps values outside [-1, 1]", () => {
    const overdriven = new Float32Array([2.0, -2.0, 1.5, -1.5]);
    const encoded = codec.encode(overdriven);
    const decoded = codec.decode(encoded);
    // Should be clamped to ±1.0 range
    for (const s of decoded) {
      expect(s).toBeGreaterThanOrEqual(-1.0);
      expect(s).toBeLessThanOrEqual(1.0);
    }
    // +2.0 should clamp to ~1.0
    expect(Math.abs(decoded[0]! - 1.0)).toBeLessThan(0.001);
    // -2.0 should clamp to ~-1.0
    expect(Math.abs(decoded[1]! + 1.0)).toBeLessThan(0.001);
  });

  test("roundtrip max-amplitude square wave (no distortion)", () => {
    const square = generateSquare(100);
    const decoded = codec.decode(codec.encode(square));
    for (let i = 0; i < square.length; i++) {
      expect(Math.abs(decoded[i]! - square[i]!)).toBeLessThan(0.001);
    }
  });

  test("empty array roundtrips to empty", () => {
    const empty = new Float32Array(0);
    const encoded = codec.encode(empty);
    expect(encoded.byteLength).toBe(0);
    const decoded = codec.decode(encoded);
    expect(decoded.length).toBe(0);
  });

  test("single sample roundtrip", () => {
    const single = new Float32Array([0.5]);
    const decoded = codec.decode(codec.encode(single));
    expect(decoded.length).toBe(1);
    expect(Math.abs(decoded[0]! - 0.5)).toBeLessThan(0.001);
  });

  test("encoding field is pcm16", () => {
    expect(codec.encoding).toBe("pcm16");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. LinearResampler
// ═══════════════════════════════════════════════════════════════════════

describe("LinearResampler", () => {
  const resampler = new LinearResampler();

  test("identity: same rate returns same data", () => {
    const input = generateSine(440, 48_000, 0.01);
    const output = resampler.resample(input, 48_000, 48_000);
    expect(output).toBe(input); // Should be same reference
  });

  test("downsample 48kHz → 16kHz produces correct length", () => {
    const input = new Float32Array(4800); // 0.1s at 48kHz
    const output = resampler.resample(input, 48_000, 16_000);
    expect(output.length).toBe(1600); // 0.1s at 16kHz
  });

  test("upsample 16kHz → 48kHz produces correct length", () => {
    const input = new Float32Array(1600); // 0.1s at 16kHz
    const output = resampler.resample(input, 16_000, 48_000);
    expect(output.length).toBe(4800); // 0.1s at 48kHz
  });

  test("downsample 48kHz → 44.1kHz produces correct length", () => {
    const input = new Float32Array(48_000); // 1s at 48kHz
    const output = resampler.resample(input, 48_000, 44_100);
    expect(output.length).toBe(44_100); // 1s at 44.1kHz
  });

  test("preserves DC offset through resampling", () => {
    // Constant signal should remain constant
    const dc = new Float32Array(4800).fill(0.7);
    const resampled = resampler.resample(dc, 48_000, 16_000);
    for (const s of resampled) {
      expect(Math.abs(s - 0.7)).toBeLessThan(0.001);
    }
  });

  test("preserves low-frequency sine through downsample", () => {
    // 100Hz sine at 48kHz → 16kHz. 100Hz is well below Nyquist for both rates.
    const sine48k = generateSine(100, 48_000, 0.1);
    const sine16k = resampler.resample(sine48k, 48_000, 16_000);
    // Check a few samples against expected sine values
    for (let i = 0; i < sine16k.length; i++) {
      const expected = Math.sin(2 * Math.PI * 100 * i / 16_000);
      expect(Math.abs(sine16k[i]! - expected)).toBeLessThan(0.05);
    }
  });

  test("empty input returns empty output", () => {
    const empty = new Float32Array(0);
    const output = resampler.resample(empty, 48_000, 16_000);
    expect(output.length).toBe(0);
  });

  test("single sample input", () => {
    const single = new Float32Array([0.42]);
    const output = resampler.resample(single, 48_000, 16_000);
    // Should produce 1 sample (ceil(1 / 3) = 1)
    expect(output.length).toBe(1);
    expect(Math.abs(output[0]! - 0.42)).toBeLessThan(0.01);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. GatewayNegotiator
// ═══════════════════════════════════════════════════════════════════════

describe("GatewayNegotiator", () => {
  describe("negotiation logic", () => {
    test("accepts client preferred encoding when supported", () => {
      const gw = new GatewayNegotiator({ supportedEncodings: ["pcm16", "opus"] });
      const format = gw.negotiate({
        supportedEncodings: ["pcm16", "opus"],
        preferredEncoding: "opus",
        captureSampleRate: 48_000,
        playbackSampleRate: 44_100,
      });
      expect(format.encoding).toBe("opus");
    });

    test("falls back to first mutual encoding when preferred not supported", () => {
      const gw = new GatewayNegotiator({ supportedEncodings: ["pcm16"] });
      const format = gw.negotiate({
        supportedEncodings: ["opus", "pcm16"],
        preferredEncoding: "opus",
        captureSampleRate: 48_000,
        playbackSampleRate: 44_100,
      });
      expect(format.encoding).toBe("pcm16");
    });

    test("defaults to pcm16 when no mutual encodings", () => {
      const gw = new GatewayNegotiator({ supportedEncodings: ["pcm16"] });
      const format = gw.negotiate({
        supportedEncodings: ["opus"],
        preferredEncoding: "opus",
        captureSampleRate: 48_000,
        playbackSampleRate: 44_100,
      });
      // Falls through both checks, defaults to pcm16
      expect(format.encoding).toBe("pcm16");
    });

    test("echoes client sample rates in negotiated format", () => {
      const gw = new GatewayNegotiator();
      const format = gw.negotiate({
        supportedEncodings: ["pcm16"],
        preferredEncoding: "pcm16",
        captureSampleRate: 44_100,
        playbackSampleRate: 22_050,
      });
      expect(format.captureSampleRate).toBe(44_100);
      expect(format.playbackSampleRate).toBe(22_050);
    });

    test("negotiatedFormat is null before negotiate()", () => {
      const gw = new GatewayNegotiator();
      expect(gw.negotiatedFormat).toBeNull();
    });

    test("negotiatedFormat is set after negotiate()", () => {
      const gw = new GatewayNegotiator();
      gw.negotiate(defaultCaps());
      expect(gw.negotiatedFormat).not.toBeNull();
      expect(gw.negotiatedFormat!.encoding).toBe("pcm16");
    });

    test("negotiatedFormat returns a copy (not mutable reference)", () => {
      const gw = new GatewayNegotiator();
      gw.negotiate(defaultCaps());
      const f1 = gw.negotiatedFormat!;
      const f2 = gw.negotiatedFormat!;
      expect(f1).not.toBe(f2); // Different objects
      expect(f1).toEqual(f2); // Same values
    });
  });

  describe("audio pipeline (prepareForSTT / prepareForClient)", () => {
    test("prepareForSTT throws before negotiation", () => {
      const gw = new GatewayNegotiator();
      const encoded = new PCM16Codec().encode(new Float32Array(100));
      expect(() => gw.prepareForSTT(encoded)).toThrow("Not negotiated");
    });

    test("prepareForClient throws before negotiation", () => {
      const gw = new GatewayNegotiator();
      expect(() => gw.prepareForClient(new Float32Array(100))).toThrow("Not negotiated");
    });

    test("prepareForSTT: decodes + resamples 48kHz client → 16kHz STT", () => {
      const gw = new GatewayNegotiator({ sttSampleRate: 16_000 });
      gw.negotiate(defaultCaps()); // client at 48kHz

      const clientAudio = generateSine(440, 48_000, 0.01); // 480 samples
      const encoded = new PCM16Codec().encode(clientAudio);
      const sttReady = gw.prepareForSTT(encoded);

      // 480 samples at 48kHz → 160 samples at 16kHz
      expect(sttReady.length).toBe(160);
    });

    test("prepareForClient: resamples 48kHz TTS → 44.1kHz client + encodes", () => {
      const gw = new GatewayNegotiator({ ttsSampleRate: 48_000 });
      gw.negotiate(defaultCaps()); // client playback at 44.1kHz

      const ttsAudio = generateSine(440, 48_000, 0.1); // 4800 samples
      const clientReady = gw.prepareForClient(ttsAudio);

      // 4800 samples at 48kHz → 4410 samples at 44.1kHz → 8820 bytes PCM16
      const codec = new PCM16Codec();
      const decoded = codec.decode(clientReady);
      expect(decoded.length).toBe(4410);
    });

    test("full roundtrip: client audio → STT-ready → preserves content", () => {
      const gw = new GatewayNegotiator({ sttSampleRate: 16_000 });
      gw.negotiate(defaultCaps());

      // 100Hz sine, well below Nyquist at all sample rates
      const clientAudio = generateSine(100, 48_000, 0.1);
      const encoded = new PCM16Codec().encode(clientAudio);
      const sttReady = gw.prepareForSTT(encoded);

      // Verify the 100Hz sine is still present at 16kHz
      for (let i = 10; i < sttReady.length - 10; i++) {
        const expected = Math.sin(2 * Math.PI * 100 * i / 16_000);
        expect(Math.abs(sttReady[i]! - expected)).toBeLessThan(0.1);
      }
    });

    test("prepareForSTT with same rate does no resampling", () => {
      const gw = new GatewayNegotiator({ sttSampleRate: 48_000 });
      gw.negotiate({
        ...defaultCaps(),
        captureSampleRate: 48_000,
      });

      const audio = generateSine(440, 48_000, 0.01);
      const encoded = new PCM16Codec().encode(audio);
      const result = gw.prepareForSTT(encoded);
      // Same rate → same sample count (identity resample)
      expect(result.length).toBe(audio.length);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. AudioSession (SDK-side)
// ═══════════════════════════════════════════════════════════════════════

describe("AudioSession", () => {
  test("not ready before negotiation", () => {
    const session = new AudioSession();
    expect(session.isReady).toBe(false);
    expect(session.encoding).toBeNull();
  });

  test("encode throws before negotiation", () => {
    const session = new AudioSession();
    expect(() => session.encode(new Float32Array(10))).toThrow("Session not negotiated yet");
  });

  test("decode throws before negotiation", () => {
    const session = new AudioSession();
    expect(() => session.decode(new Uint8Array(20))).toThrow("Session not negotiated yet");
  });

  test("ready after applyNegotiatedFormat", () => {
    const session = new AudioSession();
    session.applyNegotiatedFormat({
      encoding: "pcm16",
      captureSampleRate: 48_000,
      playbackSampleRate: 44_100,
    });
    expect(session.isReady).toBe(true);
    expect(session.encoding).toBe("pcm16");
  });

  test("encode/decode work after negotiation", () => {
    const session = new AudioSession();
    session.applyNegotiatedFormat({
      encoding: "pcm16",
      captureSampleRate: 48_000,
      playbackSampleRate: 44_100,
    });

    const original = generateSine(440, 48_000, 0.01);
    const encoded = session.encode(original);
    const decoded = session.decode(encoded);

    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(decoded[i]! - original[i]!)).toBeLessThan(0.001);
    }
  });

  test("getCapabilities returns defaults", () => {
    const session = new AudioSession();
    const caps = session.getCapabilities();
    expect(caps.preferredEncoding).toBe("pcm16");
    expect(caps.supportedEncodings).toEqual(["pcm16"]);
    expect(caps.captureSampleRate).toBe(48_000);
    expect(caps.playbackSampleRate).toBe(44_100);
  });

  test("getCapabilities respects constructor config", () => {
    const session = new AudioSession({
      preferredEncoding: "opus",
      supportedEncodings: ["opus", "pcm16"],
      captureSampleRate: 44_100,
      playbackSampleRate: 22_050,
    });
    const caps = session.getCapabilities();
    expect(caps.preferredEncoding).toBe("opus");
    expect(caps.supportedEncodings).toEqual(["opus", "pcm16"]);
    expect(caps.captureSampleRate).toBe(44_100);
    expect(caps.playbackSampleRate).toBe(22_050);
  });

  test("getCapabilities returns a copy", () => {
    const session = new AudioSession();
    const c1 = session.getCapabilities();
    const c2 = session.getCapabilities();
    expect(c1).not.toBe(c2);
    expect(c1).toEqual(c2);
  });

  test("applyNegotiatedFormat with unsupported encoding throws on use", () => {
    const session = new AudioSession();
    // Opus codec throws on encode/decode (not yet implemented)
    session.applyNegotiatedFormat({
      encoding: "opus",
      captureSampleRate: 48_000,
      playbackSampleRate: 44_100,
    });
    expect(session.isReady).toBe(true);
    expect(() => session.encode(new Float32Array(10))).toThrow("Opus encoding not yet implemented");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. End-to-End Mock: SDK ↔ Gateway roundtrip
// ═══════════════════════════════════════════════════════════════════════

describe("End-to-end: SDK ↔ Gateway", () => {
  test("full negotiation handshake + audio roundtrip", () => {
    // --- Setup ---
    const sdk = new AudioSession({ captureSampleRate: 48_000, playbackSampleRate: 44_100 });
    const gw = new GatewayNegotiator({ sttSampleRate: 16_000, ttsSampleRate: 48_000 });

    // --- Step 1: SDK sends capabilities ---
    const caps = sdk.getCapabilities();
    expect(caps.preferredEncoding).toBe("pcm16");

    // --- Step 2: Gateway negotiates ---
    const format = gw.negotiate(caps);
    expect(format.encoding).toBe("pcm16");

    // --- Step 3: SDK applies negotiated format ---
    sdk.applyNegotiatedFormat(format);
    expect(sdk.isReady).toBe(true);

    // --- Step 4: SDK encodes mic audio and sends to gateway ---
    const micAudio = generateSine(200, 48_000, 0.05); // 2400 samples
    const encodedForGateway = sdk.encode(micAudio);

    // --- Step 5: Gateway decodes + resamples for STT ---
    const sttAudio = gw.prepareForSTT(encodedForGateway);
    expect(sttAudio.length).toBe(800); // 2400 * (16000/48000)

    // --- Step 6: Gateway prepares TTS audio for client ---
    const ttsAudio = generateSine(300, 48_000, 0.05); // 2400 samples from TTS
    const encodedForClient = gw.prepareForClient(ttsAudio);

    // --- Step 7: SDK decodes gateway audio for playback ---
    const playbackAudio = sdk.decode(encodedForClient);
    // 2400 samples at 48kHz → 2205 samples at 44.1kHz
    expect(playbackAudio.length).toBe(2205);
  });

  test("negotiation with non-default rates", () => {
    const sdk = new AudioSession({ captureSampleRate: 44_100, playbackSampleRate: 48_000 });
    const gw = new GatewayNegotiator({ sttSampleRate: 16_000, ttsSampleRate: 24_000 });

    const format = gw.negotiate(sdk.getCapabilities());
    sdk.applyNegotiatedFormat(format);

    expect(format.captureSampleRate).toBe(44_100);
    expect(format.playbackSampleRate).toBe(48_000);

    // Client sends 44.1kHz audio
    const mic = generateSine(100, 44_100, 0.1); // 4410 samples
    const stt = gw.prepareForSTT(sdk.encode(mic));
    expect(stt.length).toBe(1600); // 4410 * (16000/44100) ≈ 1600

    // TTS at 24kHz → client at 48kHz
    const tts = generateSine(100, 24_000, 0.1); // 2400 samples
    const playback = sdk.decode(gw.prepareForClient(tts));
    expect(playback.length).toBe(4800); // 2400 * (48000/24000)
  });

  test("re-negotiation preserves ability to encode/decode", () => {
    const sdk = new AudioSession();
    const gw = new GatewayNegotiator();

    // First negotiation
    const format1 = gw.negotiate(sdk.getCapabilities());
    sdk.applyNegotiatedFormat(format1);

    const audio1 = generateSine(440, 48_000, 0.01);
    const encoded1 = sdk.encode(audio1);
    expect(encoded1.byteLength).toBeGreaterThan(0);

    // Second negotiation (simulating renegotiation)
    const format2 = gw.negotiate(sdk.getCapabilities());
    sdk.applyNegotiatedFormat(format2);

    const audio2 = generateSine(440, 48_000, 0.01);
    const encoded2 = sdk.encode(audio2);
    expect(encoded2.byteLength).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. getCodec registry
// ═══════════════════════════════════════════════════════════════════════

describe("getCodec", () => {
  test("returns PCM16Codec for 'pcm16'", () => {
    const codec = getCodec("pcm16");
    expect(codec.encoding).toBe("pcm16");
  });

  test("returns OpusCodec for 'opus'", () => {
    const codec = getCodec("opus");
    expect(codec.encoding).toBe("opus");
  });

  test("throws for unknown encoding", () => {
    expect(() => getCodec("mp3")).toThrow("Unsupported encoding: mp3");
  });

  test("throws for empty string", () => {
    expect(() => getCodec("")).toThrow("Unsupported encoding: ");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Error Paths & Edge Cases
// ═══════════════════════════════════════════════════════════════════════

describe("Error paths", () => {
  test("OpusCodec.encode throws (not implemented)", () => {
    const codec = new OpusCodec();
    expect(() => codec.encode(new Float32Array(10))).toThrow("Opus encoding not yet implemented");
  });

  test("OpusCodec.decode throws (not implemented)", () => {
    const codec = new OpusCodec();
    expect(() => codec.decode(new Uint8Array(10))).toThrow("Opus decoding not yet implemented");
  });

  test("PCM16Codec.decode with odd byte count truncates", () => {
    const codec = new PCM16Codec();
    // 5 bytes → 2 samples (4 bytes used, last byte ignored by DataView)
    const data = new Uint8Array([0, 0, 0, 0, 0xFF]);
    const decoded = codec.decode(data);
    expect(decoded.length).toBe(2); // floor(5/2) = 2
  });

  test("GatewayNegotiator default config is sensible", () => {
    const gw = new GatewayNegotiator();
    const format = gw.negotiate(defaultCaps());
    expect(format.encoding).toBe("pcm16");
    expect(format.captureSampleRate).toBe(48_000);
    expect(format.playbackSampleRate).toBe(44_100);
  });

  test("resampler handles very small input gracefully", () => {
    const resampler = new LinearResampler();
    const tiny = new Float32Array([0.5, -0.5]);
    const result = resampler.resample(tiny, 48_000, 16_000);
    // 2 samples * (16000/48000) = ceil(0.667) = 1 sample
    expect(result.length).toBe(1);
  });

  test("large audio buffer stress test", () => {
    // 5 seconds at 48kHz = 240,000 samples
    const codec = new PCM16Codec();
    const large = generateSine(440, 48_000, 5.0);
    const encoded = codec.encode(large);
    expect(encoded.byteLength).toBe(large.length * 2);
    const decoded = codec.decode(encoded);
    expect(decoded.length).toBe(large.length);
    // Spot-check a few values
    expect(Math.abs(decoded[1000]! - large[1000]!)).toBeLessThan(0.001);
    expect(Math.abs(decoded[100_000]! - large[100_000]!)).toBeLessThan(0.001);
  });

  test("resampler large buffer 48kHz → 16kHz", () => {
    const resampler = new LinearResampler();
    const large = generateSine(440, 48_000, 2.0); // 96,000 samples
    const result = resampler.resample(large, 48_000, 16_000);
    expect(result.length).toBe(32_000);
  });
});
