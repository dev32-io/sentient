import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { type AudioPreferences, PreferencesConnector } from "./preferences-connector.ts";

function createMockInternal(): SentientSDKInternal & {
  messageHandlers: Map<string, (msg: unknown) => void>;
  sentMessages: unknown[];
} {
  const messageHandlers = new Map<string, (msg: unknown) => void>();
  const sentMessages: unknown[] = [];
  return {
    messageHandlers,
    sentMessages,
    send(m) {
      sentMessages.push(m);
    },
    sendBinary() {},
    onMessage(type, handler) {
      messageHandlers.set(type, handler);
      return () => {
        messageHandlers.delete(type);
      };
    },
    onBinary() {
      return () => {};
    },
  };
}

describe("PreferencesConnector", () => {
  it("has capability session.preferences", () => {
    const c = new PreferencesConnector();
    expect(c.capability).toBe("session.preferences");
  });

  it("starts at default {ttsEnabled:true, channel:'voice'}", () => {
    const c = new PreferencesConnector();
    expect(c.current()).toEqual({ ttsEnabled: true, channel: "voice" });
  });

  it("updates state on session.preferences.changed", () => {
    const onChange = vi.fn<(next: AudioPreferences) => void>();
    const c = new PreferencesConnector({ onChange });
    const sdk = createMockInternal();
    c.attach(sdk);
    sdk.messageHandlers.get("session.preferences.changed")?.({
      type: "session.preferences.changed",
      preferences: { ttsEnabled: false, channel: "text" },
    });
    expect(c.current()).toEqual({ ttsEnabled: false, channel: "text" });
    expect(onChange).toHaveBeenCalledWith({ ttsEnabled: false, channel: "text" });
  });

  it("emits user.preferences.patch on patch()", () => {
    const c = new PreferencesConnector();
    const sdk = createMockInternal();
    c.attach(sdk);
    c.patch({ ttsEnabled: false });
    expect(sdk.sentMessages).toEqual([{ type: "user.preferences.patch", payload: { ttsEnabled: false } }]);
  });

  it("seed() sets current without sending", () => {
    const c = new PreferencesConnector();
    const sdk = createMockInternal();
    c.attach(sdk);
    c.seed({ ttsEnabled: false, channel: "voice" });
    expect(c.current()).toEqual({ ttsEnabled: false, channel: "voice" });
    expect(sdk.sentMessages).toEqual([]);
  });
});
