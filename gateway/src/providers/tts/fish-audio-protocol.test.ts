import { decode, encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import {
  buildFishAudioStartMessage,
  buildFishAudioStopMessage,
  buildFishAudioTextMessage,
  parseFishAudioResponse,
} from "./fish-audio-protocol.ts";
import { type TTSConfig, TTS_DEFAULTS } from "./tts-types.ts";

const TEST_API_KEY = "test-key-123";
const TEST_VOICE_ID = "voice-abc";

function makeConfig(overrides: Partial<TTSConfig> = {}): TTSConfig {
  return { ...TTS_DEFAULTS, apiKey: TEST_API_KEY, voiceId: TEST_VOICE_ID, ...overrides };
}

describe("buildFishAudioStartMessage", () => {
  it("produces valid MsgPack bytes", () => {
    const bytes = buildFishAudioStartMessage(makeConfig());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("includes event=start", () => {
    const bytes = buildFishAudioStartMessage(makeConfig());
    const msg = decode(bytes) as Record<string, unknown>;
    expect(msg.event).toBe("start");
  });

  it("sends empty text (streaming protocol uses separate text events)", () => {
    const bytes = buildFishAudioStartMessage(makeConfig());
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.text).toBe("");
  });

  it("does not include streaming flag (not in Fish Audio spec)", () => {
    const bytes = buildFishAudioStartMessage(makeConfig());
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.streaming).toBeUndefined();
  });

  it("includes reference_id from voiceId", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ voiceId: "my-voice" }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.reference_id).toBe("my-voice");
  });

  it("does not include model_id (model is in WS header per Fish Audio spec)", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ modelId: "speech-1.6" }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.model_id).toBeUndefined();
  });

  it("includes correct latency from config", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ latency: "normal" }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.latency).toBe("normal");
  });

  it("includes correct format from config", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ format: "opus" }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.format).toBe("opus");
  });

  it("includes sample_rate from config", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ sampleRate: 44100 }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.sample_rate).toBe(44100);
  });

  it("includes opus_bitrate (BPS) when format=opus and bitrate is in allowed set", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ format: "opus", bitrate: 32000 }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.opus_bitrate).toBe(32000);
    expect(req.mp3_bitrate).toBeUndefined();
    expect(req.bitrate).toBeUndefined();
  });

  it("falls back to opus_bitrate=32000 when format=opus and bitrate is outside allowed set", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ format: "opus", bitrate: 12345 }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.opus_bitrate).toBe(32000);
  });

  it("includes mp3_bitrate (kbps) when format=mp3 and bitrate is in allowed set", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ format: "mp3", bitrate: 128000 }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.mp3_bitrate).toBe(128);
    expect(req.opus_bitrate).toBeUndefined();
    expect(req.bitrate).toBeUndefined();
  });

  it("falls back to mp3_bitrate=128 when format=mp3 and bitrate is outside allowed set", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ format: "mp3", bitrate: 99000 }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.mp3_bitrate).toBe(128);
  });

  it("includes chunk_length from chunkLengthMs", () => {
    const bytes = buildFishAudioStartMessage(makeConfig({ chunkLengthMs: 300 }));
    const msg = decode(bytes) as Record<string, unknown>;
    const req = msg.request as Record<string, unknown>;
    expect(req.chunk_length).toBe(300);
  });
});

describe("buildFishAudioTextMessage", () => {
  it("produces MsgPack-encoded text event", () => {
    const bytes = buildFishAudioTextMessage("Hello world.");
    const msg = decode(bytes) as Record<string, unknown>;
    expect(msg.event).toBe("text");
    expect(msg.text).toBe("Hello world.");
  });
});

describe("buildFishAudioStopMessage", () => {
  it("produces MsgPack-encoded stop event", () => {
    const bytes = buildFishAudioStopMessage();
    expect(bytes).toBeInstanceOf(Uint8Array);
    const msg = decode(bytes) as Record<string, unknown>;
    expect(msg.event).toBe("stop");
  });
});

describe("parseFishAudioResponse", () => {
  it("returns audio event with Uint8Array data", () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    const bytes = encode({ event: "audio", audio: audioData });
    const result = parseFishAudioResponse(bytes);
    expect(result).not.toBeNull();
    expect(result?.event).toBe("audio");
    if (result?.event === "audio") {
      const audioEvent = result as { event: "audio"; audio: Uint8Array };
      expect(audioEvent.audio).toBeInstanceOf(Uint8Array);
    }
  });

  it("returns finish event", () => {
    const bytes = encode({ event: "finish", reason: "complete" });
    const result = parseFishAudioResponse(bytes);
    expect(result).toEqual({ event: "finish" });
  });

  it("returns null for log event", () => {
    const bytes = encode({ event: "log", message: "some log" });
    const result = parseFishAudioResponse(bytes);
    expect(result).toBeNull();
  });

  it("returns null for info event", () => {
    const bytes = encode({ event: "info" });
    const result = parseFishAudioResponse(bytes);
    expect(result).toBeNull();
  });

  it("returns null for unknown event type", () => {
    const bytes = encode({ event: "something_unknown" });
    const result = parseFishAudioResponse(bytes);
    expect(result).toBeNull();
  });

  it("returns null for malformed msgpack bytes", () => {
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd]);
    const result = parseFishAudioResponse(garbage);
    expect(result).toBeNull();
  });

  it("returns null when event field is missing", () => {
    const bytes = encode({ audio: new Uint8Array([1, 2]) });
    const result = parseFishAudioResponse(bytes);
    expect(result).toBeNull();
  });

  it("returns null for audio event without Uint8Array data", () => {
    const bytes = encode({ event: "audio", audio: "not-a-uint8array" });
    const result = parseFishAudioResponse(bytes);
    expect(result).toBeNull();
  });

  it("returns null for non-object msgpack value", () => {
    const bytes = encode(42);
    const result = parseFishAudioResponse(bytes);
    expect(result).toBeNull();
  });
});
