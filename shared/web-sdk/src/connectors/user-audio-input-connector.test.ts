import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { UserAudioInputConnector } from "./user-audio-input-connector.ts";

// ---------------------------------------------------------------------------
// Mock SDK Internal
// ---------------------------------------------------------------------------

function createMockInternal(): SentientSDKInternal & {
  messageHandlers: Map<string, (msg: unknown) => void>;
  sentMessages: unknown[];
  sentBinary: (ArrayBuffer | Uint8Array)[];
} {
  const messageHandlers = new Map<string, (msg: unknown) => void>();
  const sentMessages: unknown[] = [];
  const sentBinary: (ArrayBuffer | Uint8Array)[] = [];

  return {
    messageHandlers,
    sentMessages,
    sentBinary,
    send(message: unknown) {
      sentMessages.push(message);
    },
    sendBinary(data: ArrayBuffer | Uint8Array) {
      sentBinary.push(data);
    },
    onMessage(type: string, handler: (msg: unknown) => void) {
      messageHandlers.set(type, handler);
      return () => {
        messageHandlers.delete(type);
      };
    },
    onBinary(_handler: (data: ArrayBuffer) => void) {
      return () => {};
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserAudioInputConnector", () => {
  it("has capability audio.input and kind input", () => {
    const connector = new UserAudioInputConnector();
    expect(connector.capability).toBe("audio.input");
    expect(connector.kind).toBe("input");
  });

  it("sends audio.start on startStreaming", () => {
    const connector = new UserAudioInputConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    connector.startStreaming();

    expect(internal.sentMessages).toEqual([{ type: "audio.start" }]);
  });

  it("sends audio.end on stopStreaming", () => {
    const connector = new UserAudioInputConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    connector.startStreaming();
    connector.stopStreaming();

    expect(internal.sentMessages).toEqual([{ type: "audio.start" }, { type: "audio.end" }]);
  });

  it("sends binary audio frames when streaming", () => {
    const connector = new UserAudioInputConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    connector.startStreaming();
    const frame = new Uint8Array([1, 2, 3]);
    connector.sendAudioFrame(frame);

    expect(internal.sentBinary).toHaveLength(1);
    expect(internal.sentBinary[0]).toBe(frame);
  });

  it("does not send binary frames when not streaming", () => {
    const connector = new UserAudioInputConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    const frame = new Uint8Array([1, 2, 3]);
    connector.sendAudioFrame(frame);

    expect(internal.sentBinary).toHaveLength(0);
  });

  it("calls onTranscript when connector.transcript.final arrives", () => {
    const onTranscript = vi.fn();
    const connector = new UserAudioInputConnector({ onTranscript });
    const internal = createMockInternal();
    connector.attach(internal);

    const handler = internal.messageHandlers.get("connector.transcript.final");
    handler?.({ type: "connector.transcript.final", text: "hello world" });

    expect(onTranscript).toHaveBeenCalledWith("hello world");
  });

  it("stops streaming on detach", () => {
    const connector = new UserAudioInputConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    connector.startStreaming();
    connector.detach();

    // audio.end should have been sent
    expect(internal.sentMessages).toContainEqual({ type: "audio.end" });
  });

  it("does not send after detach", () => {
    const connector = new UserAudioInputConnector();
    const internal = createMockInternal();
    connector.attach(internal);
    connector.detach();

    connector.startStreaming();
    expect(internal.sentMessages).toHaveLength(0);
  });
});
