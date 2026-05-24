/**
 * RingBuffer — port of the Android ByteArray-based circular buffer.
 * Capacity: 64,000 bytes (2 seconds at 16kHz/16-bit/mono).
 * Write policy: oldest data silently overwritten when full.
 * Thread-safety model: single-thread access (audio capture thread only).
 * Drain: returns contiguous oldest->newest bytes, resets buffer.
 */
export class RingBuffer {
  private buffer: Uint8Array;
  private head: number = 0;
  private filled: number = 0;
  readonly capacity: number;

  constructor(capacity: number = 64_000) {
    this.capacity = capacity;
    this.buffer = new Uint8Array(capacity);
  }

  write(data: Uint8Array, offset: number = 0, length?: number): void {
    const len = length ?? data.length - offset;
    if (len <= 0) return;

    if (len >= this.capacity) {
      const startOffset = offset + len - this.capacity;
      this.buffer.set(data.subarray(startOffset, startOffset + this.capacity));
      this.head = 0;
      this.filled = this.capacity;
      return;
    }

    const spaceToEnd = this.capacity - this.head;
    if (len <= spaceToEnd) {
      this.buffer.set(data.subarray(offset, offset + len), this.head);
    } else {
      this.buffer.set(data.subarray(offset, offset + spaceToEnd), this.head);
      this.buffer.set(data.subarray(offset + spaceToEnd, offset + len), 0);
    }

    this.head = (this.head + len) % this.capacity;
    this.filled = Math.min(this.filled + len, this.capacity);
  }

  drain(): Uint8Array {
    if (this.filled === 0) return new Uint8Array(0);

    const result = new Uint8Array(this.filled);

    if (this.filled < this.capacity) {
      result.set(this.buffer.subarray(0, this.filled));
    } else {
      const start = this.head;
      const firstChunkLen = this.capacity - start;
      result.set(this.buffer.subarray(start, start + firstChunkLen), 0);
      result.set(this.buffer.subarray(0, start), firstChunkLen);
    }

    this.head = 0;
    this.filled = 0;
    return result;
  }

  get size(): number { return this.filled; }
  get durationMs(): number { return this.filled / 32; }
}

/**
 * FrameAccumulator — accumulates variable-sized audio chunks into
 * exact fixed-size frames (512 samples = 1024 bytes for Porcupine).
 */
export class FrameAccumulator {
  private buffer: Uint8Array;
  private writePos: number = 0;
  readonly frameSize: number;

  constructor(frameSamples: number = 512) {
    this.frameSize = frameSamples * 2;
    this.buffer = new Uint8Array(this.frameSize);
  }

  feed(data: Uint8Array, offset: number = 0, length?: number): Uint8Array[] {
    const len = length ?? data.length - offset;
    const frames: Uint8Array[] = [];
    let pos = offset;
    const end = offset + len;

    while (pos < end) {
      const remaining = this.frameSize - this.writePos;
      const available = end - pos;
      const toCopy = Math.min(remaining, available);

      this.buffer.set(data.subarray(pos, pos + toCopy), this.writePos);
      this.writePos += toCopy;
      pos += toCopy;

      if (this.writePos === this.frameSize) {
        // CRITICAL: copy the buffer, not reference it (ByteArray race fix)
        frames.push(new Uint8Array(this.buffer));
        this.writePos = 0;
      }
    }

    return frames;
  }

  get pending(): number { return this.writePos; }
}
