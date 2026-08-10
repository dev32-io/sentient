import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { AssistantAudioResponseConnector } from "./assistant-audio-response-connector.ts";

function createMockSDK(): {
  sdk: SentientSDKInternal;
  emit: (type: string, msg: unknown) => void;
  emitBinary: (data: ArrayBuffer) => void;
} {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  const binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  return {
    sdk: {
      send: () => {},
      sendBinary: () => {},
      onMessage: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {};
      },
      onBinary: (handler) => {
        binaryHandlers.add(handler);
        return () => binaryHandlers.delete(handler);
      },
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
    emitBinary: (data) => {
      for (const h of binaryHandlers) h(data);
    },
  };
}

function audioBytes(marker: number): ArrayBuffer {
  return new Uint8Array([marker]).buffer;
}

describe("AssistantAudioResponseConnector", () => {
  it("tags binary frames with the turnId from the preceding turn.audio.start", () => {
    const onAudioFrame = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioFrame });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.audio.start", { type: "turn.audio.start", turnId: "t-1", encoding: "opus", sampleRate: 48000 });
    mock.emitBinary(audioBytes(7));

    expect(onAudioFrame).toHaveBeenCalledTimes(1);
    expect(onAudioFrame.mock.calls[0]?.[1]).toBe("t-1");
  });

  it("passes encoding + sampleRate through from turn.audio.start", () => {
    const onAudioStart = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioStart });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.audio.start", { type: "turn.audio.start", turnId: "t-1", encoding: "pcm", sampleRate: 24000 });

    expect(onAudioStart).toHaveBeenCalledWith("t-1", { encoding: "pcm", sampleRate: 24000 });
  });

  it("reports turn.audio.done with its turnId", () => {
    const onAudioDone = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioDone });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.audio.start", { type: "turn.audio.start", turnId: "t-1", encoding: "opus", sampleRate: 48000 });
    mock.emit("turn.audio.done", { type: "turn.audio.done", turnId: "t-1" });

    expect(onAudioDone).toHaveBeenCalledWith("t-1");
  });

  it("suppresses frames after playback.stop until the next turn.audio.start re-enables them", () => {
    const onAudioFrame = vi.fn();
    const onPlaybackStop = vi.fn();
    const connector = new AssistantAudioResponseConnector({ onAudioFrame, onPlaybackStop });
    const mock = createMockSDK();
    connector.attach(mock.sdk);

    mock.emit("turn.audio.start", { type: "turn.audio.start", turnId: "t-1", encoding: "opus", sampleRate: 48000 });
    mock.emitBinary(audioBytes(1));
    mock.emit("playback.stop", { type: "playback.stop", turnId: "t-1", reason: "barge-in" });
    mock.emitBinary(audioBytes(2));

    expect(onPlaybackStop).toHaveBeenCalledWith("barge-in", "t-1");
    expect(onAudioFrame).toHaveBeenCalledTimes(1);

    mock.emit("turn.audio.start", { type: "turn.audio.start", turnId: "t-2", encoding: "opus", sampleRate: 48000 });
    mock.emitBinary(audioBytes(3));
    expect(onAudioFrame).toHaveBeenCalledTimes(2);
    expect(onAudioFrame.mock.calls[1]?.[1]).toBe("t-2");
  });
});
