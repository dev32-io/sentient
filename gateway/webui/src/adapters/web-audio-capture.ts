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

  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let mediaStream: MediaStream | null = null;
  let gainNode: GainNode | null = null;

  const audioHandlers = new Set<(data: ArrayBuffer) => void>();
  const errorHandlers = new Set<(message: string) => void>();

  function handleWorkletMessage(event: MessageEvent): void {
    if (!isWorkletMessage(event.data)) return;
    const msg = event.data;
    if (msg.type === "pcm") {
      for (const h of audioHandlers) h(msg.buffer);
    }
  }

  function cleanup(): void {
    workletNode?.disconnect();
    gainNode?.disconnect();
    for (const t of mediaStream?.getTracks() ?? []) t.stop();
    audioContext?.close().catch(() => {});
    workletNode = null;
    gainNode = null;
    mediaStream = null;
    audioContext = null;
  }

  return {
    async start() {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });

        audioContext = new AudioContext({ sampleRate });
        await audioContext.audioWorklet.addModule(captureWorkletUrl);

        const source = audioContext.createMediaStreamSource(mediaStream);
        gainNode = audioContext.createGain();
        gainNode.gain.value = gainValue;
        workletNode = new AudioWorkletNode(audioContext, "capture-processor");
        workletNode.port.onmessage = handleWorkletMessage;

        // Chain: source -> gain -> worklet (no output to destination -- avoids feedback).
        source.connect(gainNode).connect(workletNode);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Mic access failed";
        for (const h of errorHandlers) h(message);
        cleanup();
        throw error;
      }
    },

    stop() {
      cleanup();
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
