import { describe, expect, it } from "vitest";
import { createSessionReplayBuffer } from "./session-replay-buffer.js";

const b = (n: number) => new Uint8Array(n);

describe("SessionReplayBuffer", () => {
  it("nextSeq is monotonic from 1; store + append agree", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 1000 });
    expect(buf.nextSeq()).toBe(1);
    buf.store(1, b(10), "binary");
    expect(buf.append(b(10), "binary")).toBe(2);
    expect(buf.newestSeq).toBe(2);
    expect(buf.oldestSeq).toBe(1);
  });

  it("since() returns frames after lastSeq, [] at head, null on gap", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 1000 });
    buf.append(b(10), "binary");
    buf.append(b(10), "binary");
    buf.append(b(10), "binary"); // seq 1,2,3
    expect(buf.since(1)?.map((f) => f.seq)).toEqual([2, 3]);
    expect(buf.since(3)).toEqual([]); // at head
    expect(buf.since(0)?.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it("evicts oldest over the byte cap; since(evicted) → null", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 25 });
    buf.append(b(10), "binary"); // seq1
    buf.append(b(10), "binary"); // seq2
    buf.append(b(10), "binary"); // seq3 → 30 > 25 → evict seq1
    expect(buf.oldestSeq).toBe(2);
    expect(buf.since(1)).toBeNull(); // seq1 evicted → force refetch
    expect(buf.since(2)?.map((f) => f.seq)).toEqual([3]);
  });

  it("never evicts the only frame even if it exceeds the cap", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 5 });
    buf.append(b(100), "binary"); // seq1, 100 > 5 but it's the only one
    expect(buf.oldestSeq).toBe(1);
    expect(buf.newestSeq).toBe(1);
    expect(buf.since(0)?.length).toBe(1);
  });

  it("empty buffer sentinels: oldestSeq = 1, newestSeq = 0", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 1000 });
    // seqCounter=0 → oldestSeq = 0+1 = 1, newestSeq = 0
    expect(buf.oldestSeq).toBe(1);
    expect(buf.newestSeq).toBe(0);
  });

  it("store() with mismatched seq throws", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 1000 });
    buf.nextSeq(); // allocates seq 1
    expect(() => buf.store(2, b(10), "binary")).toThrow();
  });

  it("since(0) after eviction returns only retained frames, not full history", () => {
    const buf = createSessionReplayBuffer({ maxBytes: 25 });
    buf.append(b(10), "binary"); // seq1
    buf.append(b(10), "binary"); // seq2
    buf.append(b(10), "binary"); // seq3 → evicts seq1
    // since(0) returns what's retained (seq2, seq3), NOT null and NOT seq1
    const result = buf.since(0);
    expect(result).not.toBeNull();
    expect(result?.map((f) => f.seq)).toEqual([2, 3]);
  });
});
