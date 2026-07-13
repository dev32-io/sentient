import { describe, expect, it } from "vitest";
import {
  buildConnectUrl,
  cancelMsg,
  endMsg,
  flushMsg,
  parseServerFrame,
  pingMsg,
  textMsg,
} from "./local-tts-protocol.ts";

describe("buildConnectUrl", () => {
  it("produces base/?format=..&sample_rate=..&voice=.. with all opts present", () => {
    const url = buildConnectUrl("ws://h:8770", { format: "opus", sampleRate: 48000, voice: "v1" });
    expect(url).toBe("ws://h:8770/?format=opus&sample_rate=48000&voice=v1");
  });

  it("omits absent opts", () => {
    const url = buildConnectUrl("ws://h:8770", { voice: "v2" });
    expect(url).toBe("ws://h:8770/?voice=v2");
  });

  it("produces base/ with no query string when no opts are given", () => {
    const url = buildConnectUrl("ws://h:8770", {});
    expect(url).toBe("ws://h:8770/");
  });

  it("produces base/ with no query string when opts is omitted entirely", () => {
    const url = buildConnectUrl("ws://h:8770");
    expect(url).toBe("ws://h:8770/");
  });

  it("normalizes a base that already ends with a trailing slash", () => {
    const url = buildConnectUrl("ws://h:8770/", { format: "pcm" });
    expect(url).toBe("ws://h:8770/?format=pcm");
  });
});

describe("client message builders", () => {
  it("textMsg produces {type:text, text}", () => {
    expect(textMsg("Hello, world.")).toBe(JSON.stringify({ type: "text", text: "Hello, world." }));
  });

  it("flushMsg produces {type:flush}", () => {
    expect(flushMsg()).toBe(JSON.stringify({ type: "flush" }));
  });

  it("endMsg produces {type:end}", () => {
    expect(endMsg()).toBe(JSON.stringify({ type: "end" }));
  });

  it("cancelMsg produces {type:cancel}", () => {
    expect(cancelMsg()).toBe(JSON.stringify({ type: "cancel" }));
  });

  it("pingMsg produces {type:ping}", () => {
    expect(pingMsg()).toBe(JSON.stringify({ type: "ping" }));
  });
});

describe("parseServerFrame", () => {
  it("parses a ready frame, mapping sample_rate -> sampleRate", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "ready", format: "opus", sample_rate: 48000, voice: null }));
    expect(frame).toEqual({ kind: "ready", format: "opus", sampleRate: 48000, voice: null });
  });

  it("parses a ready frame with a negotiated voice id", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "ready", format: "pcm", sample_rate: 24000, voice: "3f9b" }));
    expect(frame).toEqual({ kind: "ready", format: "pcm", sampleRate: 24000, voice: "3f9b" });
  });

  it("parses a started frame", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "started", requestId: "a1b2c3" }));
    expect(frame).toEqual({ kind: "started", requestId: "a1b2c3" });
  });

  it("parses a done frame, mapping ttfa_ms/rtf/audio_seconds", () => {
    const frame = parseServerFrame(
      JSON.stringify({ type: "done", requestId: "a1b2c3", ttfa_ms: 187.42, rtf: 0.31, audio_seconds: 2.75 }),
    );
    expect(frame).toEqual({ kind: "done", requestId: "a1b2c3", ttfaMs: 187.42, rtf: 0.31, audioSeconds: 2.75 });
  });

  it("parses a warning frame", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "warning", reason: "unexpected_binary_frame" }));
    expect(frame).toEqual({ kind: "warning", reason: "unexpected_binary_frame" });
  });

  it("parses an error frame", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "error", reason: "reference clip too short" }));
    expect(frame).toEqual({ kind: "error", reason: "reference clip too short" });
  });

  it("parses a pong frame", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "pong" }));
    expect(frame).toEqual({ kind: "pong" });
  });

  it("parses a voice.created frame", () => {
    const frame = parseServerFrame(
      JSON.stringify({ type: "voice.created", voiceId: "3f9b", name: "Dad", createdAt: 1752400000.0 }),
    );
    expect(frame).toEqual({ kind: "voiceCreated", voiceId: "3f9b", name: "Dad", createdAt: 1752400000.0 });
  });

  it("parses a voice.list frame with voices array", () => {
    const frame = parseServerFrame(
      JSON.stringify({
        type: "voice.list",
        voices: [{ voiceId: "3f9b", name: "Dad", createdAt: 1752400000.0, refDurationMs: 12000 }],
      }),
    );
    expect(frame).toEqual({
      kind: "voiceList",
      voices: [{ voiceId: "3f9b", name: "Dad", createdAt: 1752400000.0, refDurationMs: 12000 }],
    });
  });

  it("parses an empty voice.list frame", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "voice.list", voices: [] }));
    expect(frame).toEqual({ kind: "voiceList", voices: [] });
  });

  it("parses a voice.deleted frame", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "voice.deleted", voiceId: "3f9b" }));
    expect(frame).toEqual({ kind: "voiceDeleted", voiceId: "3f9b" });
  });

  it("parses an ArrayBuffer as an audio frame", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const frame = parseServerFrame(bytes.buffer);
    expect(frame.kind).toBe("audio");
    if (frame.kind === "audio") {
      expect(frame.data).toBeInstanceOf(Uint8Array);
      expect(Array.from(frame.data)).toEqual([1, 2, 3, 4]);
    }
  });

  it("falls back to unknown for an unrecognized type", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "future.frame", foo: "bar" }));
    expect(frame.kind).toBe("unknown");
  });

  it("falls back to unknown for malformed JSON", () => {
    const frame = parseServerFrame("not json{");
    expect(frame.kind).toBe("unknown");
  });

  it("falls back to unknown for a JSON value with no type field", () => {
    const frame = parseServerFrame(JSON.stringify({ foo: "bar" }));
    expect(frame.kind).toBe("unknown");
  });
});
