import type { AudioCaptureAdapter } from "@sentient/web-sdk";
import captureWorkletUrl from "../audio/capture-worklet.ts?worker&url";
import { CAPTURE_GAIN, CAPTURE_SAMPLE_RATE } from "../constants.ts";

export interface WebAudioCaptureOptions {
  sampleRate?: number;
  gain?: number;
}

/** PCM message from capture worklet. */
interface PcmMessage {
  type: "pcm";
  buffer: ArrayBuffer;
}

type WorkletMessage = PcmMessage;

interface CaptureResources {
  readonly mediaStream: MediaStream;
  audioContext: AudioContext | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  workletNode: AudioWorkletNode | null;
  cleaned: boolean;
}

class CaptureStartCancelled extends Error {
  constructor() {
    super("Voice capture was stopped while starting.");
    this.name = "AbortError";
  }
}

function isWorkletMessage(value: unknown): value is WorkletMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

/**
 * Web Audio API implementation of AudioCaptureAdapter.
 * Requests mic access, runs the PCM16 capture worklet, and
 * emits pcm chunks to registered handlers.
 */
export function createWebAudioCapture(options?: WebAudioCaptureOptions): AudioCaptureAdapter {
  const sampleRate = options?.sampleRate ?? CAPTURE_SAMPLE_RATE;
  const gainValue = options?.gain ?? CAPTURE_GAIN;

  let resources: CaptureResources | null = null;
  let generation = 0;
  let startPending = false;
  // AudioContext.close() is asynchronous. A fresh getUserMedia/AudioContext
  // pair must not race Firefox's CoreAudio teardown from the preceding use.
  let closeBarrier: Promise<void> = Promise.resolve();

  const audioHandlers = new Set<(data: ArrayBuffer) => void>();
  const errorHandlers = new Set<(message: string) => void>();

  function handleWorkletMessage(event: MessageEvent): void {
    if (!isWorkletMessage(event.data)) return;
    const msg = event.data;
    if (msg.type === "pcm") {
      for (const h of audioHandlers) h(msg.buffer);
    }
  }

  function isCurrent(candidate: CaptureResources, expectedGeneration: number): boolean {
    return resources === candidate && generation === expectedGeneration;
  }

  function cleanup(candidate: CaptureResources | null): void {
    if (candidate === null || candidate.cleaned) return;
    candidate.cleaned = true;
    if (resources === candidate) resources = null;

    if (candidate.workletNode) {
      candidate.workletNode.port.onmessage = null;
      candidate.workletNode.port.close();
      candidate.workletNode.disconnect();
    }
    candidate.sourceNode?.disconnect();
    candidate.gainNode?.disconnect();
    for (const track of candidate.mediaStream.getTracks()) track.stop();

    const context = candidate.audioContext;
    candidate.workletNode = null;
    candidate.sourceNode = null;
    candidate.gainNode = null;
    candidate.audioContext = null;
    if (context) {
      const closing = context.close().catch(() => undefined);
      closeBarrier = Promise.all([closeBarrier, closing]).then(() => undefined);
    }
  }

  function assertCurrent(candidate: CaptureResources, expectedGeneration: number): void {
    if (!isCurrent(candidate, expectedGeneration)) throw new CaptureStartCancelled();
  }

  return {
    async start() {
      if (startPending || resources !== null) throw new Error("Voice capture is already starting or active.");
      startPending = true;
      const expectedGeneration = ++generation;
      let candidate: CaptureResources | null = null;
      try {
        // stop() releases tracks synchronously, but Firefox completes the
        // underlying AudioDSP/CoreAudio shutdown with close() asynchronously.
        await closeBarrier;
        if (generation !== expectedGeneration) throw new CaptureStartCancelled();

        const mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        candidate = {
          mediaStream,
          audioContext: null,
          sourceNode: null,
          gainNode: null,
          workletNode: null,
          cleaned: false,
        };
        resources = candidate;
        assertCurrent(candidate, expectedGeneration);

        const audioContext = new AudioContext({ sampleRate });
        candidate.audioContext = audioContext;
        await audioContext.audioWorklet.addModule(captureWorkletUrl);
        assertCurrent(candidate, expectedGeneration);

        candidate.sourceNode = audioContext.createMediaStreamSource(mediaStream);
        candidate.gainNode = audioContext.createGain();
        candidate.gainNode.gain.value = gainValue;
        candidate.workletNode = new AudioWorkletNode(audioContext, "capture-processor");
        candidate.workletNode.port.onmessage = handleWorkletMessage;

        // Chain: source -> gain -> worklet (no output to destination -- avoids feedback).
        candidate.sourceNode.connect(candidate.gainNode).connect(candidate.workletNode);
      } catch (error) {
        cleanup(candidate);
        if (!(error instanceof CaptureStartCancelled)) {
          const message = error instanceof Error ? error.message : "Mic access failed";
          for (const h of errorHandlers) h(message);
        }
        throw error;
      } finally {
        startPending = false;
      }
    },

    stop() {
      ++generation;
      cleanup(resources);
    },

    onAudioData(handler) {
      audioHandlers.add(handler);
      return () => audioHandlers.delete(handler);
    },

    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
  };
}
