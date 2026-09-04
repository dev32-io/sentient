import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebAudioCapture } from "./web-audio-capture.ts";

interface CaptureMocks {
  stream: MediaStream;
  trackStop: ReturnType<typeof vi.fn>;
  context: AudioContext;
  contextClose: ReturnType<typeof vi.fn>;
  sourceDisconnect: ReturnType<typeof vi.fn>;
  gainDisconnect: ReturnType<typeof vi.fn>;
  port: { onmessage: ((event: MessageEvent) => void) | null; close: ReturnType<typeof vi.fn> };
  workletDisconnect: ReturnType<typeof vi.fn>;
  worklet: AudioWorkletNode;
}

function makeCaptureMocks(close: () => Promise<void> = async () => undefined): CaptureMocks {
  const trackStop = vi.fn();
  const stream = { getTracks: vi.fn(() => [{ stop: trackStop }]) } as unknown as MediaStream;
  const sourceDisconnect = vi.fn();
  const gainDisconnect = vi.fn();
  const source = {
    connect: vi.fn((node: AudioNode) => node),
    disconnect: sourceDisconnect,
  } as unknown as MediaStreamAudioSourceNode;
  const gain = {
    gain: { value: 1 },
    connect: vi.fn((node: AudioNode) => node),
    disconnect: gainDisconnect,
  } as unknown as GainNode;
  const contextClose = vi.fn(close);
  const context = {
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    close: contextClose,
  } as unknown as AudioContext;
  const port = { onmessage: null, close: vi.fn() };
  const workletDisconnect = vi.fn();
  const worklet = { port, disconnect: workletDisconnect } as unknown as AudioWorkletNode;
  return {
    stream,
    trackStop,
    context,
    contextClose,
    sourceDisconnect,
    gainDisconnect,
    port,
    workletDisconnect,
    worklet,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWebAudioCapture lifecycle", () => {
  it("fully detaches one capture and waits for its AudioContext to close before reacquiring the mic", async () => {
    let finishClose: (() => void) | undefined;
    const first = makeCaptureMocks(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const second = makeCaptureMocks();
    const captures = [first, second];
    const getUserMedia = vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    let contextIndex = 0;
    let workletIndex = 0;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal(
      "AudioContext",
      vi.fn(() => captures[contextIndex++]?.context),
    );
    vi.stubGlobal(
      "AudioWorkletNode",
      vi.fn(() => captures[workletIndex++]?.worklet),
    );

    const adapter = createWebAudioCapture();
    await adapter.start();
    adapter.stop();

    expect(first.port.onmessage).toBeNull();
    expect(first.port.close).toHaveBeenCalledOnce();
    expect(first.workletDisconnect).toHaveBeenCalledOnce();
    expect(first.sourceDisconnect).toHaveBeenCalledOnce();
    expect(first.gainDisconnect).toHaveBeenCalledOnce();
    expect(first.trackStop).toHaveBeenCalledOnce();

    const restart = adapter.start();
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    finishClose?.();
    await restart;
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    adapter.stop();
  });

  it("fences a getUserMedia result that arrives after stop", async () => {
    let finishGetUserMedia: ((stream: MediaStream) => void) | undefined;
    const pendingStream = new Promise<MediaStream>((resolve) => {
      finishGetUserMedia = resolve;
    });
    const capture = makeCaptureMocks();
    const onError = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => pendingStream) } });
    const AudioContextMock = vi.fn(() => capture.context);
    vi.stubGlobal("AudioContext", AudioContextMock);
    vi.stubGlobal("AudioWorkletNode", vi.fn());

    const adapter = createWebAudioCapture();
    adapter.onError(onError);
    const start = adapter.start();
    await Promise.resolve();
    adapter.stop();
    finishGetUserMedia?.(capture.stream);

    await expect(start).rejects.toMatchObject({ name: "AbortError" });
    expect(capture.trackStop).toHaveBeenCalledOnce();
    expect(AudioContextMock).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
