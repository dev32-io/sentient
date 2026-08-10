import { describe, expect, it } from "vitest";
import { type TurnAudioPlayback, createTurnAudioQueue } from "./turn-audio-queue.ts";

function makeMockPlayback(): TurnAudioPlayback & {
  enqueued: Float32Array[];
  clearCalls: number;
  triggerDrain: () => void;
} {
  const drainHandlers = new Set<() => void>();
  const enqueued: Float32Array[] = [];
  let clearCalls = 0;
  return {
    enqueued,
    get clearCalls() {
      return clearCalls;
    },
    triggerDrain() {
      for (const h of [...drainHandlers]) h();
    },
    enqueue(samples: Float32Array) {
      enqueued.push(samples);
    },
    clear() {
      clearCalls++;
      enqueued.length = 0;
    },
    onDrain(handler: () => void) {
      drainHandlers.add(handler);
      return () => drainHandlers.delete(handler);
    },
  };
}

function frame(marker: number): Float32Array {
  return new Float32Array([marker]);
}

function markers(samples: readonly Float32Array[]): number[] {
  return samples.map((s) => s[0] ?? Number.NaN);
}

describe("TurnAudioQueue", () => {
  it("plays the head turn's frames straight through in arrival order", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioFrame("turn-a", frame(2));

    expect(markers(playback.enqueued)).toEqual([1, 2]);
    expect(playback.clearCalls).toBe(0);
  });

  it("queues a second turn BEHIND the first instead of preempting it (spec 7.2)", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioStart("turn-b");
    queue.onAudioFrame("turn-b", frame(9));

    // turn-b is buffered, NOT played, and turn-a was never cut.
    expect(markers(playback.enqueued)).toEqual([1]);
    expect(playback.clearCalls).toBe(0);
    expect(queue.depth()).toBe(2);

    queue.onAudioDone("turn-a");
    playback.triggerDrain();

    expect(markers(playback.enqueued)).toEqual([1, 9]);
    expect(queue.depth()).toBe(1);
  });

  it("never clears playback when a new turnId arrives — the gateway never stops its own audio", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioStart("turn-b");
    queue.onAudioFrame("turn-b", frame(2));
    queue.onAudioStart("turn-c");
    queue.onAudioFrame("turn-c", frame(3));

    expect(playback.clearCalls).toBe(0);
  });

  it("retires the head when turn.audio.done arrives AFTER playback already drained", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioStart("turn-b");
    queue.onAudioFrame("turn-b", frame(2));

    playback.triggerDrain(); // drains before done — head must NOT be retired yet
    expect(queue.depth()).toBe(2);

    queue.onAudioDone("turn-a"); // no further drain will ever fire; retire from here
    expect(markers(playback.enqueued)).toEqual([1, 2]);
    expect(queue.depth()).toBe(1);
  });

  it("cancelAll drops every queued turn and clears playback with no fade (barge-in / interrupt only)", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.onAudioStart("turn-b");
    queue.onAudioFrame("turn-b", frame(2));

    queue.cancelAll();

    expect(playback.clearCalls).toBe(1);
    expect(queue.depth()).toBe(0);
    expect(playback.enqueued).toHaveLength(0);
  });

  it("dispose releases the drain subscription and empties the queue", () => {
    const playback = makeMockPlayback();
    const queue = createTurnAudioQueue({ playback });

    queue.onAudioStart("turn-a");
    queue.onAudioFrame("turn-a", frame(1));
    queue.dispose();
    playback.triggerDrain(); // must not throw or resurrect a disposed queue

    expect(queue.depth()).toBe(0);
  });
});
