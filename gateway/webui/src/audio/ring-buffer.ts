import { RING_BUFFER_SAMPLES } from "../constants.ts";

/**
 * Float32 ring buffer for AudioWorklet playback.
 * Drop-oldest on overflow. Clear on barge-in.
 *
 * Uses a plain Float32Array (no SharedArrayBuffer) for the unit-testable core.
 * The AudioWorklet processor wraps this with SharedArrayBuffer for cross-thread use.
 */
export class RingBuffer {
  private readonly buffer: Float32Array;
  private readonly capacity: number;
  private readIndex: number;
  private writeIndex: number;
  private count: number;

  constructor(capacity: number = RING_BUFFER_SAMPLES) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.count = 0;
  }

  /** Write samples into the buffer. On overflow, oldest samples are dropped. */
  write(samples: Float32Array): number {
    const toWrite = samples.length;

    if (toWrite >= this.capacity) {
      // If writing more than capacity, only keep the last `capacity` samples
      const offset = toWrite - this.capacity;
      this.buffer.set(samples.subarray(offset));
      this.readIndex = 0;
      this.writeIndex = 0;
      this.count = this.capacity;
      return this.capacity;
    }

    // Drop oldest if needed
    if (this.count + toWrite > this.capacity) {
      const overflow = this.count + toWrite - this.capacity;
      this.readIndex = (this.readIndex + overflow) % this.capacity;
      this.count -= overflow;
    }

    // Write in up to two segments (wrap-around)
    const firstChunk = Math.min(toWrite, this.capacity - this.writeIndex);
    this.buffer.set(samples.subarray(0, firstChunk), this.writeIndex);

    if (firstChunk < toWrite) {
      this.buffer.set(samples.subarray(firstChunk), 0);
    }

    this.writeIndex = (this.writeIndex + toWrite) % this.capacity;
    this.count += toWrite;

    return toWrite;
  }

  /** Read up to `output.length` samples from the buffer. Returns actual samples read. */
  read(output: Float32Array): number {
    const toRead = Math.min(output.length, this.count);

    if (toRead === 0) {
      output.fill(0);
      return 0;
    }

    const firstChunk = Math.min(toRead, this.capacity - this.readIndex);
    output.set(this.buffer.subarray(this.readIndex, this.readIndex + firstChunk));

    if (firstChunk < toRead) {
      output.set(this.buffer.subarray(0, toRead - firstChunk), firstChunk);
    }

    // Zero-fill remainder of output
    if (toRead < output.length) {
      output.fill(0, toRead);
    }

    this.readIndex = (this.readIndex + toRead) % this.capacity;
    this.count -= toRead;

    return toRead;
  }

  /** Clear the buffer (barge-in). Completes in O(1). */
  clear(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.count = 0;
  }

  /** Number of samples currently buffered */
  get available(): number {
    return this.count;
  }

  /** Total capacity in samples */
  get size(): number {
    return this.capacity;
  }

  /** True if no samples are buffered */
  get isEmpty(): boolean {
    return this.count === 0;
  }

  /** True if buffer is at capacity */
  get isFull(): boolean {
    return this.count === this.capacity;
  }
}
