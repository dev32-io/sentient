import { describe, expect, it } from "vitest";
import { createAudioChunkQueue } from "./audio-chunk-queue.ts";
import type { TTSAudioChunk } from "./tts-types.ts";

function makeChunk(id: number): TTSAudioChunk {
  return { data: new Uint8Array([id]), encoding: "opus", sampleRate: 48000, isFinal: false };
}

describe("AudioChunkQueue", () => {
  it("enqueues and dequeues in FIFO order", () => {
    const queue = createAudioChunkQueue(10);
    queue.enqueue(makeChunk(1));
    queue.enqueue(makeChunk(2));
    expect(queue.dequeue()?.data[0]).toBe(1);
    expect(queue.dequeue()?.data[0]).toBe(2);
  });

  it("returns undefined when dequeuing empty queue", () => {
    const queue = createAudioChunkQueue(10);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("reports size correctly", () => {
    const queue = createAudioChunkQueue(10);
    expect(queue.size()).toBe(0);
    queue.enqueue(makeChunk(1));
    expect(queue.size()).toBe(1);
    queue.dequeue();
    expect(queue.size()).toBe(0);
  });

  it("reports isEmpty correctly", () => {
    const queue = createAudioChunkQueue(10);
    expect(queue.isEmpty()).toBe(true);
    queue.enqueue(makeChunk(1));
    expect(queue.isEmpty()).toBe(false);
  });

  it("doubles capacity when reaching 50% fill", () => {
    const queue = createAudioChunkQueue(4);
    queue.enqueue(makeChunk(1));
    queue.enqueue(makeChunk(2)); // 50% — triggers grow to 8
    queue.enqueue(makeChunk(3));
    queue.enqueue(makeChunk(4));
    queue.enqueue(makeChunk(5));
    expect(queue.dequeue()?.data[0]).toBe(1);
    expect(queue.dequeue()?.data[0]).toBe(2);
    expect(queue.dequeue()?.data[0]).toBe(3);
    expect(queue.dequeue()?.data[0]).toBe(4);
    expect(queue.dequeue()?.data[0]).toBe(5);
  });

  it("handles wraparound correctly", () => {
    const queue = createAudioChunkQueue(4);
    queue.enqueue(makeChunk(1));
    queue.enqueue(makeChunk(2));
    queue.dequeue();
    queue.dequeue();
    queue.enqueue(makeChunk(3));
    queue.enqueue(makeChunk(4));
    expect(queue.dequeue()?.data[0]).toBe(3);
    expect(queue.dequeue()?.data[0]).toBe(4);
  });

  it("resets to initial capacity", () => {
    const queue = createAudioChunkQueue(4);
    for (let i = 0; i < 10; i++) queue.enqueue(makeChunk(i));
    queue.reset();
    expect(queue.size()).toBe(0);
    expect(queue.isEmpty()).toBe(true);
    queue.enqueue(makeChunk(99));
    expect(queue.dequeue()?.data[0]).toBe(99);
  });

  it("supports finish/isDone semantics", () => {
    const queue = createAudioChunkQueue(4);
    expect(queue.isDone()).toBe(false);
    queue.finish();
    expect(queue.isDone()).toBe(true);
    queue.reset();
    expect(queue.isDone()).toBe(false);
  });

  it("waitForItem resolves immediately when items available", async () => {
    const queue = createAudioChunkQueue(4);
    queue.enqueue(makeChunk(1));
    const hasItem = await queue.waitForItem(new AbortController().signal);
    expect(hasItem).toBe(true);
  });

  it("waitForItem resolves false when finished and empty", async () => {
    const queue = createAudioChunkQueue(4);
    queue.finish();
    const hasItem = await queue.waitForItem(new AbortController().signal);
    expect(hasItem).toBe(false);
  });

  it("waitForItem resolves false when aborted", async () => {
    const queue = createAudioChunkQueue(4);
    const ac = new AbortController();
    ac.abort();
    const hasItem = await queue.waitForItem(ac.signal);
    expect(hasItem).toBe(false);
  });

  it("waitForItem resolves when item enqueued later", async () => {
    const queue = createAudioChunkQueue(4);
    const promise = queue.waitForItem(new AbortController().signal);
    queue.enqueue(makeChunk(1));
    const hasItem = await promise;
    expect(hasItem).toBe(true);
  });
});
