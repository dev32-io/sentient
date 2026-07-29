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

  // R9 deleted `connector.transcript.final`, which was the ONLY frame that
  // closed the web mic latch. `turn.started` is the 2.0 contract's signal that
  // the gateway took ownership of the utterance; without this binding the gate
  // stays open until its 20s failsafe and the browser streams mic audio through
  // the whole reply.
  it("calls onTurnStarted when the gateway opens a user turn", () => {
    const onTurnStarted = vi.fn();
    const connector = new UserAudioInputConnector({ onTurnStarted });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("turn.started")?.({ type: "turn.started", turnId: "t-1", trigger: "user" });

    expect(onTurnStarted).toHaveBeenCalledTimes(1);
  });

  it("ignores a background-completion turn — it is not an utterance boundary", () => {
    const onTurnStarted = vi.fn();
    const connector = new UserAudioInputConnector({ onTurnStarted });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("turn.started")?.({
      type: "turn.started",
      turnId: "t-2",
      trigger: "background-completion",
    });

    expect(onTurnStarted).not.toHaveBeenCalled();
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
