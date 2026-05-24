import { RingBuffer, FrameAccumulator } from "./ring-buffer";

/** Events posted from audio thread to consumer via Channel */
export type AudioEvent =
  | { type: "wake_word"; pretriggerData: Uint8Array; pretriggerMs: number }
  | { type: "audio_frame"; data: Uint8Array }
  | { type: "silence_detected" };

/** Mock Porcupine — returns keyword index for a given frame */
export interface WakeWordDetector {
  process(frame: Int16Array): number; // -1 = not detected, >= 0 = keyword index
}

/**
 * Simulates the Android AudioCaptureThread pipeline:
 * - Receives variable-size audio chunks (as AudioRecord.read() would deliver)
 * - Accumulates into 512-sample frames for Porcupine
 * - Writes all audio into ring buffer
 * - On wake word detection: drains ring buffer, emits event
 * - Posts events to channel (async queue) for consumer coroutine
 *
 * KEY DESIGN: Ring buffer is only accessed from this "thread" (same execution context).
 * Channel is the only cross-thread boundary. ByteArrays are COPIED before posting.
 */
export class AudioPipeline {
  private ringBuffer: RingBuffer;
  private accumulator: FrameAccumulator;
  private detector: WakeWordDetector;
  private channel: AudioEvent[] = [];
  private streaming: boolean = false;
  private lastDetectionTime: number = 0;
  private debounceMs: number;

  constructor(
    detector: WakeWordDetector,
    ringCapacity: number = 64_000,
    debounceMs: number = 500
  ) {
    this.ringBuffer = new RingBuffer(ringCapacity);
    this.accumulator = new FrameAccumulator(512);
    this.detector = detector;
    this.debounceMs = debounceMs;
  }

  /**
   * Called from audio capture thread with each chunk from AudioRecord.read().
   * The chunk may be any size (typically 1024 bytes = 512 samples = 32ms).
   */
  onAudioData(chunk: Uint8Array, now: number = Date.now()): void {
    // Always write to ring buffer (continuous circular recording)
    this.ringBuffer.write(chunk);

    // Accumulate into 512-sample frames for Porcupine
    const frames = this.accumulator.feed(chunk);

    for (const frame of frames) {
      // Convert Uint8Array to Int16Array for Porcupine
      const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
      const keywordIndex = this.detector.process(samples);

      if (keywordIndex >= 0 && !this.streaming) {
        // Debounce: ignore rapid re-triggers
        if (now - this.lastDetectionTime < this.debounceMs) continue;
        this.lastDetectionTime = now;

        // Drain ring buffer — COPY the data (ByteArray race condition fix)
        const pretrigger = this.ringBuffer.drain();
        const pretriggerMs = pretrigger.length / 32;

        this.channel.push({
          type: "wake_word",
          pretriggerData: new Uint8Array(pretrigger), // defensive copy
          pretriggerMs,
        });
        this.streaming = true;
      } else if (this.streaming) {
        // Forward live audio frames while streaming
        this.channel.push({
          type: "audio_frame",
          data: new Uint8Array(frame), // COPY — never share mutable buffer
        });
      }
    }
  }

  /** Called when VAD detects end of speech */
  onSilence(): void {
    if (this.streaming) {
      this.channel.push({ type: "silence_detected" });
      this.streaming = false;
    }
  }

  /** Consumer reads events (simulates Kotlin Channel<AudioEvent>) */
  drainEvents(): AudioEvent[] {
    const events = this.channel;
    this.channel = [];
    return events;
  }

  get isStreaming(): boolean { return this.streaming; }
  get bufferSize(): number { return this.ringBuffer.size; }
  get pendingFrameBytes(): number { return this.accumulator.pending; }
}

/**
 * Simulates the WebSocket consumer coroutine that reads from the channel
 * and constructs the wire protocol messages.
 */
export function buildWireMessages(events: AudioEvent[]): Array<{
  type: "json" | "binary";
  data: any;
}> {
  const messages: Array<{ type: "json" | "binary"; data: any }> = [];

  for (const event of events) {
    switch (event.type) {
      case "wake_word":
        // Step 1: JSON control message
        messages.push({
          type: "json",
          data: {
            type: "session.start",
            encoding: "pcm_s16le",
            sample_rate: 16000,
            pretrigger_ms: event.pretriggerMs,
          },
        });
        // Step 2: Binary pre-trigger frame
        if (event.pretriggerData.length > 0) {
          messages.push({ type: "binary", data: event.pretriggerData });
        }
        break;
      case "audio_frame":
        // Step 3: Live binary frames
        messages.push({ type: "binary", data: event.data });
        break;
      case "silence_detected":
        // Step 4: End of speech
        messages.push({ type: "json", data: { type: "audio.end" } });
        break;
    }
  }

  return messages;
}
