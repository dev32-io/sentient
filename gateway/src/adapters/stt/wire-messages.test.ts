import { describe, expect, it } from "vitest";
import {
  readySchema,
  sttServerMessageSchema,
  transcriptReadySchema,
  turnRejectedSchema,
  vadStartSchema,
} from "./wire-messages.ts";

describe("readySchema", () => {
  it("parses the contract example", () => {
    const result = readySchema.safeParse({
      type: "ready",
      connId: "1a6614dab748",
      sampleRate: 16000,
      sileroChunkSamples: 512,
      pcmFormat: "int16_le_mono",
      stt: "sense-voice-small-int8",
    });
    expect(result.success).toBe(true);
  });
});

describe("vadStartSchema", () => {
  it("parses with turnIdx", () => {
    expect(vadStartSchema.safeParse({ type: "vad_start", turnIdx: 7 }).success).toBe(true);
  });
});

describe("transcriptReadySchema", () => {
  it("parses the contract example", () => {
    const result = transcriptReadySchema.safeParse({
      type: "transcript_ready",
      turnIdx: 5,
      text: "Hi [pause.0] there",
      emotion: "<|NEUTRAL|>",
      event: "<|Speech|>",
      decodeMs: 720.4,
      audioSeconds: 7.8,
      pauses: [1240],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty pauses array", () => {
    const result = transcriptReadySchema.safeParse({
      type: "transcript_ready",
      turnIdx: 1,
      text: "hello",
      emotion: "<|NEUTRAL|>",
      event: "<|Speech|>",
      decodeMs: 100,
      audioSeconds: 1.0,
      pauses: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("turnRejectedSchema", () => {
  it("parses with reason", () => {
    const result = turnRejectedSchema.safeParse({
      type: "turn_rejected",
      turnIdx: 2,
      reason: "empty_transcript",
    });
    expect(result.success).toBe(true);
  });
});

describe("sttServerMessageSchema", () => {
  it("discriminates on type", () => {
    expect(sttServerMessageSchema.safeParse({ type: "vad_start", turnIdx: 1 }).success).toBe(true);
    expect(sttServerMessageSchema.safeParse({ type: "unknown_type" }).success).toBe(false);
  });
});
