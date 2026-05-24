import { describe, expect, it } from "vitest";
import type { ReplayEntry } from "./replay-buffer.ts";
import { createReplayBuffer } from "./replay-buffer.ts";

function first(entries: ReplayEntry[]): ReplayEntry {
  const e = entries[0];
  if (!e) throw new Error("Expected at least one entry");
  return e;
}

function at(entries: ReplayEntry[], i: number): ReplayEntry {
  const e = entries[i];
  if (!e) throw new Error(`Expected entry at index ${i}`);
  return e;
}

describe("ReplayBuffer", () => {
  it("stores entries with auto-incrementing seq starting at 1", () => {
    const buf = createReplayBuffer(10);
    const s1 = buf.add({ type: "a" });
    const s2 = buf.add({ type: "b" });
    const s3 = buf.add({ type: "c" });
    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(s3).toBe(3);
  });

  it("returns correct lastSeq after each add", () => {
    const buf = createReplayBuffer(10);
    expect(buf.lastSeq()).toBe(0);
    buf.add({ type: "a" });
    expect(buf.lastSeq()).toBe(1);
    buf.add({ type: "b" });
    expect(buf.lastSeq()).toBe(2);
  });

  it("returns 0 for lastSeq when empty", () => {
    const buf = createReplayBuffer(10);
    expect(buf.lastSeq()).toBe(0);
  });

  it("replayAfter(0) returns all entries", () => {
    const buf = createReplayBuffer(10);
    buf.add({ type: "a" });
    buf.add({ type: "b" });
    buf.add({ type: "c" });
    const entries = buf.replayAfter(0);
    expect(entries).toHaveLength(3);
    expect(at(entries, 0).seq).toBe(1);
    expect(at(entries, 1).seq).toBe(2);
    expect(at(entries, 2).seq).toBe(3);
  });

  it("replayAfter(1) returns entries with seq > 1", () => {
    const buf = createReplayBuffer(10);
    buf.add({ type: "a" });
    buf.add({ type: "b" });
    buf.add({ type: "c" });
    const entries = buf.replayAfter(1);
    expect(entries).toHaveLength(2);
    expect(at(entries, 0).seq).toBe(2);
    expect(at(entries, 1).seq).toBe(3);
  });

  it("replayAfter(latestSeq) returns empty array", () => {
    const buf = createReplayBuffer(10);
    buf.add({ type: "a" });
    buf.add({ type: "b" });
    expect(buf.replayAfter(2)).toHaveLength(0);
  });

  it("replayAfter(999) returns empty array when seq is beyond buffer", () => {
    const buf = createReplayBuffer(10);
    buf.add({ type: "a" });
    expect(buf.replayAfter(999)).toHaveLength(0);
  });

  it("evicts oldest entries when capacity is exceeded", () => {
    const buf = createReplayBuffer(3);
    buf.add({ type: "a" }); // seq 1
    buf.add({ type: "b" }); // seq 2
    buf.add({ type: "c" }); // seq 3
    buf.add({ type: "d" }); // seq 4, evicts seq 1
    expect(buf.size()).toBe(3);
    const entries = buf.replayAfter(0);
    expect(at(entries, 0).seq).toBe(2);
    expect(at(entries, 1).seq).toBe(3);
    expect(at(entries, 2).seq).toBe(4);
  });

  it("replayAfter with evicted items returns only available entries", () => {
    const buf = createReplayBuffer(2);
    buf.add({ type: "a" }); // seq 1
    buf.add({ type: "b" }); // seq 2
    buf.add({ type: "c" }); // seq 3, evicts seq 1
    buf.add({ type: "d" }); // seq 4, evicts seq 2
    const entries = buf.replayAfter(1);
    expect(entries).toHaveLength(2);
    expect(at(entries, 0).seq).toBe(3);
    expect(at(entries, 1).seq).toBe(4);
  });

  it("reset clears all entries and resets lastSeq to 0", () => {
    const buf = createReplayBuffer(10);
    buf.add({ type: "a" });
    buf.add({ type: "b" });
    buf.reset();
    expect(buf.size()).toBe(0);
    expect(buf.lastSeq()).toBe(0);
  });

  it("reset causes nextSeq to restart at 1", () => {
    const buf = createReplayBuffer(10);
    buf.add({ type: "a" });
    buf.reset();
    expect(buf.add({ type: "b" })).toBe(1);
  });

  it("replayAfter returns empty array after reset", () => {
    const buf = createReplayBuffer(10);
    buf.add({ type: "a" });
    buf.reset();
    expect(buf.replayAfter(0)).toHaveLength(0);
  });

  it("add returns the assigned seq number", () => {
    const buf = createReplayBuffer(10);
    expect(buf.add({ type: "x" })).toBe(1);
    expect(buf.add({ type: "y" })).toBe(2);
  });

  it("preserves message content exactly", () => {
    const buf = createReplayBuffer(10);
    const msg = { type: "chat", text: "hello", nested: { value: 42 } };
    buf.add(msg);
    expect(first(buf.replayAfter(0)).message).toEqual(msg);
  });

  it("handles large capacity without issues", () => {
    const buf = createReplayBuffer(1000);
    for (let i = 0; i < 500; i++) {
      buf.add({ index: i });
    }
    expect(buf.size()).toBe(500);
    expect(buf.lastSeq()).toBe(500);
    expect(buf.replayAfter(0)).toHaveLength(500);
  });

  it("size returns current count capped at capacity", () => {
    const buf = createReplayBuffer(3);
    buf.add({ type: "a" });
    expect(buf.size()).toBe(1);
    buf.add({ type: "b" });
    buf.add({ type: "c" });
    buf.add({ type: "d" });
    expect(buf.size()).toBe(3);
  });
});
