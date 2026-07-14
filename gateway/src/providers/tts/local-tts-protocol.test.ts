import { describe, expect, it } from "vitest";
import {
  buildConnectUrl,
  cancelMsg,
  endMsg,
  flushMsg,
  parseServerFrame,
  pingMsg,
  textMsg,
  voiceCreateMsg,
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

  it("voiceCreateMsg includes description and tags", () => {
    const parsed = JSON.parse(voiceCreateMsg("Nova", "Warm", ["warm", "calm"]));
    expect(parsed).toEqual({ type: "voice.create", name: "Nova", description: "Warm", tags: ["warm", "calm"] });
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
        voices: [
          {
            voiceId: "3f9b",
            name: "Dad",
            description: "Warm, low register",
            tags: ["family", "warm"],
            source: "user",
            createdAt: 1752400000.0,
            refDurationMs: 12000,
          },
        ],
      }),
    );
    expect(frame).toEqual({
      kind: "voiceList",
      voices: [
        {
          voiceId: "3f9b",
          name: "Dad",
          description: "Warm, low register",
          tags: ["family", "warm"],
          source: "user",
          createdAt: 1752400000.0,
          refDurationMs: 12000,
        },
      ],
    });
  });

  it("parses a voiceList frame with source/description/tags", () => {
    const frame = parseServerFrame(
      JSON.stringify({
        type: "voice.list",
        voices: [
          {
            voiceId: "nova",
            name: "Nova",
            description: "Warm",
            tags: ["warm"],
            source: "builtin",
            createdAt: 0,
            refDurationMs: 0,
          },
        ],
      }),
    );
    expect(frame.kind).toBe("voiceList");
    if (frame.kind === "voiceList") {
      expect(frame.voices[0]?.source).toBe("builtin");
      expect(frame.voices[0]?.tags).toEqual(["warm"]);
    }
  });

  it("defaults description/tags/source for a legacy voice.list entry missing those fields", () => {
    const frame = parseServerFrame(
      JSON.stringify({
        type: "voice.list",
        voices: [{ voiceId: "3f9b", name: "Dad", createdAt: 1752400000.0, refDurationMs: 12000 }],
      }),
    );
    expect(frame).toEqual({
      kind: "voiceList",
      voices: [
        {
          voiceId: "3f9b",
          name: "Dad",
          description: "",
          tags: [],
          source: "user",
          createdAt: 1752400000.0,
          refDurationMs: 12000,
        },
      ],
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

describe("parseServerFrame — malformed/adversarial input degrades to unknown, never coerces", () => {
  it("degrades a started frame missing requestId to unknown instead of fabricating requestId:''", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "started" }));
    expect(frame).toEqual({ kind: "unknown", raw: { type: "started" } });
  });

  it("degrades a started frame with a non-string requestId to unknown", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "started", requestId: 123 }));
    expect(frame.kind).toBe("unknown");
  });

  it("degrades a done frame with a non-numeric ttfa_ms to unknown", () => {
    const frame = parseServerFrame(
      JSON.stringify({ type: "done", requestId: "a1b2c3", ttfa_ms: "not-a-number", rtf: 0.31, audio_seconds: 2.75 }),
    );
    expect(frame.kind).toBe("unknown");
  });

  it("degrades a done frame missing requestId to unknown instead of fabricating requestId:''", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "done", ttfa_ms: 187.42, rtf: 0.31, audio_seconds: 2.75 }));
    expect(frame.kind).toBe("unknown");
  });

  it("degrades a ready frame missing sampleRate to unknown", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "ready", format: "opus", voice: null }));
    expect(frame.kind).toBe("unknown");
  });

  it("degrades a ready frame missing format to unknown", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "ready", sample_rate: 48000, voice: null }));
    expect(frame.kind).toBe("unknown");
  });

  it("degrades a warning frame missing reason to unknown", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "warning" }));
    expect(frame.kind).toBe("unknown");
  });

  it("degrades an error frame missing reason to unknown", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "error" }));
    expect(frame.kind).toBe("unknown");
  });

  it("degrades a voice.created frame missing voiceId to unknown instead of fabricating voiceId:''", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "voice.created", name: "Dad", createdAt: 1752400000.0 }));
    expect(frame.kind).toBe("unknown");
  });

  it("degrades a voice.deleted frame missing voiceId to unknown instead of fabricating voiceId:''", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "voice.deleted" }));
    expect(frame.kind).toBe("unknown");
  });

  it("degrades a voice.list frame whose voices field is not an array to unknown", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "voice.list", voices: "not-an-array" }));
    expect(frame.kind).toBe("unknown");
  });

  it("drops (never fabricates) a voice.list entry missing voiceId, keeping well-formed entries", () => {
    const frame = parseServerFrame(
      JSON.stringify({
        type: "voice.list",
        voices: [{ name: "no-id" }, { voiceId: "3f9b", name: "Dad", createdAt: 1752400000.0, refDurationMs: 12000 }],
      }),
    );
    expect(frame).toEqual({
      kind: "voiceList",
      voices: [
        {
          voiceId: "3f9b",
          name: "Dad",
          description: "",
          tags: [],
          source: "user",
          createdAt: 1752400000.0,
          refDurationMs: 12000,
        },
      ],
    });
  });

  it("degrades a type of '__proto__' to unknown without throwing", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "__proto__" }));
    expect(frame).toEqual({ kind: "unknown", raw: { type: "__proto__" } });
  });

  it("degrades a type of 'constructor' to unknown without throwing or invoking Object's constructor", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "constructor" }));
    expect(frame).toEqual({ kind: "unknown", raw: { type: "constructor" } });
  });

  it("still parses a well-formed done frame identically (regression)", () => {
    const frame = parseServerFrame(
      JSON.stringify({ type: "done", requestId: "a1b2c3", ttfa_ms: 187.42, rtf: 0.31, audio_seconds: 2.75 }),
    );
    expect(frame).toEqual({ kind: "done", requestId: "a1b2c3", ttfaMs: 187.42, rtf: 0.31, audioSeconds: 2.75 });
  });
});
