import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { UserAudioInputConnector } from "./user-audio-input-connector.ts";

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
    send: (message) => sentMessages.push(message),
    sendBinary: (data) => sentBinary.push(data),
    onMessage(type, handler) {
      messageHandlers.set(type, handler);
      return () => messageHandlers.delete(type);
    },
    onBinary: () => () => {},
  };
}

function attached(): { connector: UserAudioInputConnector; internal: ReturnType<typeof createMockInternal> } {
  let next = 0;
  const connector = new UserAudioInputConnector({ createCaptureId: () => `cap-${++next}` });
  const internal = createMockInternal();
  connector.attach(internal);
  return { connector, internal };
}

describe("UserAudioInputConnector", () => {
  it("starts a capture with a generated stable id and explicit semantic mode", () => {
    const { connector, internal } = attached();
    expect(connector.startStreaming()).toBe("cap-1");
    expect(internal.sentMessages).toEqual([{ type: "audio.start", captureId: "cap-1", turnMode: "semantic" }]);
  });

  it("accepts an id/mode and sends the same id on commit", () => {
    const { connector, internal } = attached();
    expect(connector.startStreaming({ captureId: "held", turnMode: "manual" })).toBe("held");
    connector.commitCapture("held");
    expect(internal.sentMessages).toEqual([
      { type: "audio.start", captureId: "held", turnMode: "manual" },
      { type: "audio.end", captureId: "held" },
    ]);
  });

  it("enforces first-terminal-wins and stale terminals cannot stop a newer capture", () => {
    const { connector, internal } = attached();
    connector.startStreaming({ captureId: "old" });
    connector.cancelCapture("old");
    connector.commitCapture("old");
    connector.startStreaming({ captureId: "new" });
    connector.cancelCapture("old");
    connector.commitCapture("new");
    expect(internal.sentMessages.map((m) => (m as { type: string }).type)).toEqual([
      "audio.start",
      "audio.cancel",
      "audio.start",
      "audio.end",
    ]);
  });

  it("latches producer callbacks and sends no binary after terminal or into a newer capture", () => {
    const { connector, internal } = attached();
    connector.startStreaming({ captureId: "old" });
    const staleProducer = connector.frameSender("old");
    staleProducer(new Uint8Array([1]));
    connector.commitCapture("old");
    staleProducer(new Uint8Array([2]));
    connector.startStreaming({ captureId: "new" });
    const currentProducer = connector.frameSender("new");
    staleProducer(new Uint8Array([3]));
    currentProducer(new Uint8Array([4]));
    expect(internal.sentBinary.map((b) => [...new Uint8Array(b)])).toEqual([[1], [4]]);
  });

  it("does not allow overlapping captures or reuse a retired identity", () => {
    const { connector, internal } = attached();
    expect(connector.startStreaming({ captureId: "one" })).toBe("one");
    expect(connector.startStreaming({ captureId: "two" })).toBeNull();
    connector.commitCapture("one");
    expect(connector.startStreaming({ captureId: "one" })).toBeNull();
    expect(internal.sentMessages).toHaveLength(2);
  });

  it("cancels rather than commits an active capture on detach", () => {
    const { connector, internal } = attached();
    connector.startStreaming({ captureId: "cap" });
    connector.detach();
    expect(internal.sentMessages.at(-1)).toEqual({ type: "audio.cancel", captureId: "cap" });
    connector.sendAudioFrame(new Uint8Array([1]), "cap");
    expect(internal.sentBinary).toHaveLength(0);
  });

  it("calls onTurnStarted only for user turns", () => {
    const onTurnStarted = vi.fn();
    const connector = new UserAudioInputConnector({ onTurnStarted });
    const internal = createMockInternal();
    connector.attach(internal);
    internal.messageHandlers.get("turn.started")?.({ trigger: "background-completion" });
    internal.messageHandlers.get("turn.started")?.({ trigger: "user" });
    expect(onTurnStarted).toHaveBeenCalledTimes(1);
  });
});
