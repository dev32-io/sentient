import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { AssistantAudioResponseConnector } from "./assistant-audio-response-connector.ts";

// ---------------------------------------------------------------------------
// Mock SDK Internal
// ---------------------------------------------------------------------------

function createMockInternal(): SentientSDKInternal & {
  messageHandlers: Map<string, (msg: unknown) => void>;
  binaryHandler: ((data: ArrayBuffer) => void) | null;
} {
  const messageHandlers = new Map<string, (msg: unknown) => void>();
  let binaryHandler: ((data: ArrayBuffer) => void) | null = null;

  return {
    messageHandlers,
    get binaryHandler() {
      return binaryHandler;
    },
    send() {},
    sendBinary() {},
    onMessage(type: string, handler: (msg: unknown) => void) {
      messageHandlers.set(type, handler);
      return () => {
        messageHandlers.delete(type);
      };
    },
    onBinary(handler: (data: ArrayBuffer) => void) {
      binaryHandler = handler;
      return () => {
        binaryHandler = null;
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AssistantAudioResponseConnector", () => {
  it("has capability audio.output and kind output", () => {
    const connector = new AssistantAudioResponseConnector();
    expect(connector.capability).toBe("audio.output");
    expect(connector.kind).toBe("output");
  });

  it("calls onAudioStart when connector.audio.start arrives", () => {
    const onAudioStart = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioStart });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
      cycleId: "cycle-abc",
    });

    expect(onAudioStart).toHaveBeenCalledOnce();
  });

  it("passes cycleId from connector.audio.start to onAudioStart", () => {
    const onAudioStart = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioStart });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
      cycleId: "cycle-xyz",
    });

    expect(onAudioStart).toHaveBeenCalledWith("cycle-xyz");
  });

  it("calls onAudioFrame for binary data during active stream", () => {
    const onAudioFrame = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioFrame });
    const internal = createMockInternal();
    connector.attach(internal);

    // Start audio stream
    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
      cycleId: "cycle-abc",
    });

    const buffer = new ArrayBuffer(16);
    internal.binaryHandler?.(buffer);

    expect(onAudioFrame).toHaveBeenCalledOnce();
    expect(onAudioFrame.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
  });

  it("passes cycleId from audio.start to each onAudioFrame call", () => {
    const onAudioFrame = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioFrame });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
      cycleId: "cycle-123",
    });

    const buffer = new ArrayBuffer(16);
    internal.binaryHandler?.(buffer);

    expect(onAudioFrame.mock.calls[0]?.[1]).toBe("cycle-123");
  });

  it("does not call onAudioFrame for binary data before audio.start", () => {
    const onAudioFrame = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioFrame });
    const internal = createMockInternal();
    connector.attach(internal);

    const buffer = new ArrayBuffer(16);
    internal.binaryHandler?.(buffer);

    expect(onAudioFrame).not.toHaveBeenCalled();
  });

  it("calls onAudioDone when connector.audio.done arrives", () => {
    const onAudioDone = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioDone });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
      cycleId: "cycle-abc",
    });
    internal.messageHandlers.get("connector.audio.done")?.({
      type: "connector.audio.done",
      cycleId: "cycle-abc",
    });

    expect(onAudioDone).toHaveBeenCalledOnce();
  });

  it("passes cycleId from connector.audio.done to onAudioDone", () => {
    const onAudioDone = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioDone });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
      cycleId: "cycle-abc",
    });
    internal.messageHandlers.get("connector.audio.done")?.({
      type: "connector.audio.done",
      cycleId: "cycle-abc",
    });

    expect(onAudioDone).toHaveBeenCalledWith("cycle-abc");
  });

  it("stops calling onAudioFrame after onCancelled", () => {
    const onAudioFrame = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioFrame });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
    });

    connector.onCancelled();

    const buffer = new ArrayBuffer(16);
    internal.binaryHandler?.(buffer);

    expect(onAudioFrame).not.toHaveBeenCalled();
  });

  it("does not call onAudioDone after onCancelled", () => {
    const onAudioDone = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioDone });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
    });

    connector.onCancelled();

    internal.messageHandlers.get("connector.audio.done")?.({
      type: "connector.audio.done",
    });

    expect(onAudioDone).not.toHaveBeenCalled();
  });

  it("resets cancelled state on new audio.start", () => {
    const onAudioFrame = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioFrame });
    const internal = createMockInternal();
    connector.attach(internal);

    // First stream
    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
    });
    connector.onCancelled();

    // Second stream — cancelled flag should be cleared
    internal.messageHandlers.get("connector.audio.start")?.({
      type: "connector.audio.start",
    });

    const buffer = new ArrayBuffer(16);
    internal.binaryHandler?.(buffer);

    expect(onAudioFrame).toHaveBeenCalledOnce();
  });
});
