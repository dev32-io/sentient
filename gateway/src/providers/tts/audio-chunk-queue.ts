import type { TTSAudioChunk } from "./tts-types.ts";

const GROW_THRESHOLD = 0.5;

/** Default: 600 chunks = 120s at 200ms chunk rate */
export const DEFAULT_AUDIO_QUEUE_CAPACITY = 600;

export interface AudioChunkQueue {
  enqueue(chunk: TTSAudioChunk): void;
  dequeue(): TTSAudioChunk | undefined;
  size(): number;
  isEmpty(): boolean;
  isDone(): boolean;
  finish(): void;
  reset(): void;
  waitForItem(signal: AbortSignal): Promise<boolean>;
}

export function createAudioChunkQueue(initialCapacity: number = DEFAULT_AUDIO_QUEUE_CAPACITY): AudioChunkQueue {
  let buffer: (TTSAudioChunk | undefined)[] = new Array(initialCapacity);
  let head = 0;
  let tail = 0;
  let count = 0;
  let done = false;
  let waitResolve: ((hasItem: boolean) => void) | null = null;

  function capacity(): number {
    return buffer.length;
  }

  function grow(): void {
    const newCap = capacity() * 2;
    const newBuffer: (TTSAudioChunk | undefined)[] = new Array(newCap);
    for (let i = 0; i < count; i++) {
      newBuffer[i] = buffer[(head + i) % capacity()];
    }
    buffer = newBuffer;
    head = 0;
    tail = count;
  }

  function wake(hasItem: boolean): void {
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r(hasItem);
    }
  }

  return {
    enqueue(chunk: TTSAudioChunk): void {
      if (count >= capacity() * GROW_THRESHOLD) {
        grow();
      }
      buffer[tail] = chunk;
      tail = (tail + 1) % capacity();
      count++;
      wake(true);
    },

    dequeue(): TTSAudioChunk | undefined {
      if (count === 0) return undefined;
      const item = buffer[head];
      buffer[head] = undefined;
      head = (head + 1) % capacity();
      count--;
      return item;
    },

    size: () => count,
    isEmpty: () => count === 0,
    isDone: () => done,

    finish(): void {
      done = true;
      wake(false);
    },

    reset(): void {
      buffer = new Array(initialCapacity);
      head = 0;
      tail = 0;
      count = 0;
      done = false;
      waitResolve = null;
    },

    waitForItem(signal: AbortSignal): Promise<boolean> {
      if (count > 0) return Promise.resolve(true);
      if (done || signal.aborted) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        waitResolve = resolve;
        signal.addEventListener(
          "abort",
          () => {
            if (waitResolve === resolve) {
              waitResolve = null;
              resolve(false);
            }
          },
          { once: true },
        );
      });
    },
  };
}
