import { describe, expect, it } from "vitest";
import { ttsSkipReason } from "./tts-policy.js";

// Pins the clientType→TTS policy contract at the session-configure boundary.
// Each case arm in the exhaustive switch must be tested so new client types
// can't silently fall through with wrong policy.

describe("ttsSkipReason — webui", () => {
  it("returns null when channel is voice and ttsEnabled", () => {
    expect(ttsSkipReason({ clientType: "webui", channel: "voice", ttsEnabled: true })).toBeNull();
  });

  it("returns channel-text when channel is text", () => {
    expect(ttsSkipReason({ clientType: "webui", channel: "text", ttsEnabled: true })).toBe("channel-text");
  });

  it("returns tts-disabled when ttsEnabled is false and channel is voice", () => {
    expect(ttsSkipReason({ clientType: "webui", channel: "voice", ttsEnabled: false })).toBe("tts-disabled");
  });
});

describe("ttsSkipReason — cube", () => {
  it("returns null when channel is voice (ttsEnabled bypassed)", () => {
    expect(ttsSkipReason({ clientType: "cube", channel: "voice", ttsEnabled: false })).toBeNull();
  });

  it("returns channel-text when channel is text", () => {
    expect(ttsSkipReason({ clientType: "cube", channel: "text", ttsEnabled: true })).toBe("channel-text");
  });
});

describe("ttsSkipReason — mobile", () => {
  it("returns null when channel is voice and ttsEnabled (same policy as webui)", () => {
    expect(ttsSkipReason({ clientType: "mobile", channel: "voice", ttsEnabled: true })).toBeNull();
  });

  it("returns channel-text when channel is text", () => {
    expect(ttsSkipReason({ clientType: "mobile", channel: "text", ttsEnabled: true })).toBe("channel-text");
  });

  it("returns tts-disabled when ttsEnabled is false and channel is voice", () => {
    expect(ttsSkipReason({ clientType: "mobile", channel: "voice", ttsEnabled: false })).toBe("tts-disabled");
  });
});
