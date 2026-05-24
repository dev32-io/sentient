/// <reference path="./audio-worklet.d.ts" />

/**
 * Capture processor: receives Float32 mic samples from the MediaStream source,
 * converts to Int16 PCM, and posts to the main thread as binary ArrayBuffers.
 *
 * Main thread -> this worklet:
 *   (no messages expected)
 * This worklet -> main thread:
 *   { type: "pcm", buffer: ArrayBuffer } -- Int16 PCM chunk
 */

/** Web Audio API render quantum -- fixed by spec, not configurable. */
const FRAME_SIZE = 128;

/**
 * Frames per outgoing batch: 4 x 128 = 512 samples. At the current capture
 * rate (48 kHz, see CAPTURE_SAMPLE_RATE) that's ~10.7 ms — the downstream
 * opus encoder buffers internally to 20 ms packets at its configured rate.
 */
const BATCH_FRAMES = 4;

/** Maximum positive value of a signed 16-bit integer. */
const INT16_MAX = 0x7fff;

/** Magnitude of the minimum value of a signed 16-bit integer (asymmetric). */
const INT16_MIN_MAGNITUDE = 0x8000;

class CaptureProcessor extends AudioWorkletProcessor {
  private batchBuffer: Int16Array;
  private batchOffset: number;

  constructor() {
    super();
    this.batchBuffer = new Int16Array(FRAME_SIZE * BATCH_FRAMES);
    this.batchOffset = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
      this.batchBuffer[this.batchOffset++] = sample < 0 ? sample * INT16_MIN_MAGNITUDE : sample * INT16_MAX;

      if (this.batchOffset >= this.batchBuffer.length) {
        const out = new Int16Array(this.batchBuffer.length);
        out.set(this.batchBuffer);
        this.port.postMessage({ type: "pcm", buffer: out.buffer }, [out.buffer]);
        this.batchOffset = 0;
      }
    }

    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
