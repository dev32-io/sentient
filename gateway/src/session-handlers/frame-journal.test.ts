// FrameJournal invariants (Plan 3 Task 10, spec §11 slice 6).
//
// This pins the resume FSM's arithmetic, not an implementation detail: the
// gateway's "can I replay contiguously?" answer is the ONLY thing standing
// between a reconnecting client and a silently-truncated conversation. Two
// rules here are deliberate improvements over the deleted prior art
// (session-replay-buffer.ts) and would otherwise be re-broken by a future
// rewrite:
//   - a client sitting EXACTLY one frame behind the oldest retained frame
//     can still resume (old rule `lastSeq < oldestSeq → null` forced a
//     needless full refetch at that boundary);
//   - a client claiming a lastSeq the gateway never issued is a gap, not a
//     no-op (old rule returned [] for an empty ring regardless of lastSeq,
//     which would ack "you're caught up" to a client that had lost
//     everything).

import { describe, expect, it } from "bun:test";
import { createFrameJournal } from "./frame-journal.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function textJournal(maxBytes = 1_000_000) {
  const journal = createFrameJournal({ maxBytes });
  const put = (body: string) => journal.allocateText((seq) => JSON.stringify({ body, seq }));
  return { journal, put };
}

describe("FrameJournal — seq allocation", () => {
  it("allocates monotonic seqs starting at 1 across both frame kinds", () => {
    const journal = createFrameJournal({ maxBytes: 1_000_000 });
    const a = journal.allocateText((seq) => `a${seq}`);
    const b = journal.allocateBinary((seq) => enc.encode(`b${seq}`));
    const c = journal.allocateText((seq) => `c${seq}`);

    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a.text).toBe("a1");
    expect(dec.decode(b.bytes)).toBe("b2");
  });

  it("hands the allocated seq to the builder BEFORE journaling its bytes", () => {
    const { journal } = textJournal();
    const built = journal.allocateText((seq) => JSON.stringify({ seq }));

    expect(built.text).toBe('{"seq":1}');
    const replayed = journal.since(0);
    expect(replayed).not.toBeNull();
    expect(dec.decode((replayed ?? [])[0]?.bytes ?? new Uint8Array())).toBe('{"seq":1}');
  });

  it("reports an empty journal as oldestSeq=1, newestSeq=0", () => {
    const journal = createFrameJournal({ maxBytes: 1_000_000 });
    expect(journal.oldestSeq).toBe(1);
    expect(journal.newestSeq).toBe(0);
    expect(journal.frameCount).toBe(0);
  });
});

describe("FrameJournal — byte-cap eviction", () => {
  it("evicts oldest frames once the cap is exceeded", () => {
    // Each frame is 10 bytes; cap of 25 retains at most 2.
    const journal = createFrameJournal({ maxBytes: 25 });
    for (let i = 0; i < 5; i++) journal.allocateBinary(() => new Uint8Array(10));

    expect(journal.frameCount).toBe(2);
    expect(journal.oldestSeq).toBe(4);
    expect(journal.newestSeq).toBe(5);
    expect(journal.byteLength).toBe(20);
  });

  it("never evicts the last remaining frame, even when it alone exceeds the cap", () => {
    const journal = createFrameJournal({ maxBytes: 8 });
    journal.allocateBinary(() => new Uint8Array(64));

    expect(journal.frameCount).toBe(1);
    expect(journal.newestSeq).toBe(1);
  });
});

describe("FrameJournal — gap detection (since)", () => {
  it("returns every retained frame for the lastSeq=0 sentinel", () => {
    const { journal, put } = textJournal();
    put("one");
    put("two");

    expect((journal.since(0) ?? []).map((f) => f.seq)).toEqual([1, 2]);
  });

  it("returns only frames strictly after lastSeq", () => {
    const { journal, put } = textJournal();
    put("one");
    put("two");
    put("three");

    expect((journal.since(2) ?? []).map((f) => f.seq)).toEqual([3]);
  });

  it("returns an empty array (not null) when the client is already at the head", () => {
    const { journal, put } = textJournal();
    put("one");

    expect(journal.since(1)).toEqual([]);
  });

  it("returns null when the frame at lastSeq has been evicted", () => {
    const journal = createFrameJournal({ maxBytes: 25 });
    for (let i = 0; i < 5; i++) journal.allocateBinary(() => new Uint8Array(10));
    // oldestSeq is 4, so a client that last saw seq 1 has an unfillable gap.
    expect(journal.since(1)).toBeNull();
  });

  it("still resumes a client sitting exactly one frame behind the oldest retained frame", () => {
    const journal = createFrameJournal({ maxBytes: 25 });
    for (let i = 0; i < 5; i++) journal.allocateBinary(() => new Uint8Array(10));
    // oldestSeq is 4; a client at lastSeq 3 saw everything up to 3, so 4..5
    // is a contiguous continuation — NOT a gap.
    expect((journal.since(3) ?? []).map((f) => f.seq)).toEqual([4, 5]);
  });

  it("returns null when the client claims a lastSeq the journal never issued", () => {
    const { journal, put } = textJournal();
    put("one");

    expect(journal.since(99)).toBeNull();
  });

  it("returns null for any non-zero lastSeq against a journal that never wrote a frame", () => {
    const journal = createFrameJournal({ maxBytes: 1_000_000 });

    expect(journal.since(5)).toBeNull();
    expect(journal.since(0)).toEqual([]);
  });
});
