// FrameJournal — the per-surface outbound frame ring that makes reconnect
// gap-fill possible (spec §11 slice 6). Successor to the deleted
// session-replay-buffer.ts + frame-sequencer.ts pair.
//
// Every gateway → client frame — JSON and binary alike — draws its `seq`
// from ONE counter here and leaves its wire-ready bytes behind, so a
// reconnecting client can be handed back exactly the bytes it missed,
// byte-identical, in order.
//
// Two-phase allocation, fused: the prior art exposed `nextSeq()` and
// `store()` as a pair the caller had to keep balanced, and threw if they
// ever drifted apart. The two phases are unavoidable — the seq lives INSIDE
// the bytes (a JSON field / the 9-byte binary header), so it must exist
// before the bytes can be built — but the PAIRING is not: `allocateText` /
// `allocateBinary` take the builder as a callback, so a dangling pending
// seq is structurally impossible instead of a runtime assertion.
//
// Memory is bounded by TWO independent caps, exactly as before: this
// byte cap (evict-oldest, config `session.replay_journal_max_bytes`) and
// the registry's detach retention window (replay-registry.ts, config
// `session.replay_journal_retention_ms`). Audio journals one frame per
// Opus frame (~50/s), so the frame COUNT is bounded implicitly by the byte
// cap. Coalescing many Opus frames into one journal entry is deliberately
// NOT done — each Opus frame carries its own seq for client-side dedup.

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "ws", "journal"]);

export type JournaledFrameKind = "text" | "binary";

export interface JournaledFrame {
  readonly seq: number;
  readonly bytes: Uint8Array;
  readonly kind: JournaledFrameKind;
}

export interface AllocatedText {
  readonly seq: number;
  readonly text: string;
}

export interface AllocatedBinary {
  readonly seq: number;
  readonly bytes: Uint8Array;
}

export interface FrameJournal {
  /** Allocate the next seq, build the JSON text with it, journal the encoded
   *  bytes, and hand back both so the caller can write the very same string
   *  to the socket without re-encoding. */
  allocateText(build: (seq: number) => string): AllocatedText;
  /** Same contract for a binary frame whose 9-byte header embeds the seq. */
  allocateBinary(build: (seq: number) => Uint8Array): AllocatedBinary;
  /**
   * Frames the client still needs, given the highest seq it applied.
   *
   *   lastSeq === 0            → sentinel "send me everything retained".
   *   lastSeq > newestSeq      → null. The client claims a seq this journal
   *                              never issued (stale epoch that slipped the
   *                              epoch check, or a corrupted cursor) —
   *                              unfillable, force a fresh session.
   *   lastSeq < oldestSeq - 1  → null. The frame after the client's cursor
   *                              was evicted, so replay cannot be
   *                              contiguous. Note the `- 1`: a client whose
   *                              cursor sits EXACTLY one frame behind the
   *                              oldest retained frame is still contiguous
   *                              and resumes fine (the prior art's rule
   *                              lacked it and forced a needless refetch at
   *                              that boundary).
   *   otherwise                → every retained frame with seq > lastSeq,
   *                              possibly empty (client already at head).
   */
  since(lastSeq: number): readonly JournaledFrame[] | null;
  /** Lowest retained seq. `newestSeq + 1` when empty — "the oldest frame is
   *  in the future", so any real lastSeq trips the gap check. */
  readonly oldestSeq: number;
  /** Highest seq ever allocated (retained or evicted). 0 before the first. */
  readonly newestSeq: number;
  readonly byteLength: number;
  readonly frameCount: number;
}

export interface FrameJournalOptions {
  /** Maximum total retained bytes. Oldest frames evict first. */
  maxBytes: number;
}

const TEXT_ENCODER = new TextEncoder();

export function createFrameJournal(options: FrameJournalOptions): FrameJournal {
  const { maxBytes } = options;

  const frames: JournaledFrame[] = [];
  let totalBytes = 0;
  let seqCounter = 0;

  function retain(frame: JournaledFrame): void {
    frames.push(frame);
    totalBytes += frame.bytes.byteLength;

    // Evict oldest while over cap, but never evict the only remaining frame
    // — a journal holding nothing can answer no resume at all. The O(n)
    // shift is acceptable at family-assistant scale.
    while (totalBytes > maxBytes && frames.length > 1) {
      const evicted = frames.shift();
      if (evicted === undefined) break;
      totalBytes -= evicted.bytes.byteLength;
      log.debug("journal.evicted", {
        seq: evicted.seq,
        kind: evicted.kind,
        bytes: evicted.bytes.byteLength,
        totalBytes,
        frameCount: frames.length,
      });
    }
  }

  function allocateText(build: (seq: number) => string): AllocatedText {
    seqCounter += 1;
    const seq = seqCounter;
    const text = build(seq);
    retain({ seq, bytes: TEXT_ENCODER.encode(text), kind: "text" });
    return { seq, text };
  }

  function allocateBinary(build: (seq: number) => Uint8Array): AllocatedBinary {
    seqCounter += 1;
    const seq = seqCounter;
    const bytes = build(seq);
    retain({ seq, bytes, kind: "binary" });
    return { seq, bytes };
  }

  function oldestSeq(): number {
    return frames[0]?.seq ?? seqCounter + 1;
  }

  function since(lastSeq: number): readonly JournaledFrame[] | null {
    if (lastSeq === 0) return frames.slice();

    if (lastSeq > seqCounter) {
      log.warn("journal.gap.beyond-head", {
        lastSeq,
        newestSeq: seqCounter,
        reason: "client claims a seq this journal never issued",
      });
      return null;
    }

    const oldest = oldestSeq();
    if (lastSeq < oldest - 1) {
      log.warn("journal.gap.evicted", {
        lastSeq,
        oldestSeq: oldest,
        newestSeq: seqCounter,
        reason: "the frame after the client's cursor was evicted by the byte cap",
      });
      return null;
    }

    return frames.filter((f) => f.seq > lastSeq);
  }

  return {
    allocateText,
    allocateBinary,
    since,
    get oldestSeq() {
      return oldestSeq();
    },
    get newestSeq() {
      return seqCounter;
    },
    get byteLength() {
      return totalBytes;
    },
    get frameCount() {
      return frames.length;
    },
  };
}
