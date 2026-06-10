/**
 * SessionReplayBuffer — two-phase seq allocation, byte-cap eviction ring.
 *
 * Design:
 *  - nextSeq() allocates and returns the next monotonic sequence number (starts at 1).
 *  - store(seq, bytes) appends a frame then evicts oldest until totalBytes ≤ maxBytes,
 *    but never evicts the last remaining frame. Caller MUST pass the seq that was
 *    returned by the immediately preceding nextSeq() call.
 *  - append(bytes) = nextSeq() + store(seq, bytes); returns seq.
 *  - since(lastSeq) returns frames with seq > lastSeq, [] if at head,
 *    null if lastSeq is older than the oldest retained frame (gap detected).
 *
 * Gap detection rule:
 *   lastSeq === 0 is a sentinel meaning "give me everything from the start".
 *   Note: if eviction has occurred, since(0) returns only what is retained —
 *   it does NOT guarantee full history from seq 1.
 *   Otherwise, if lastSeq < oldestSeq, the frame at lastSeq was evicted and
 *   contiguous replay is impossible — return null to signal a full refetch.
 *
 * Empty-buffer sentinels:
 *   oldestSeq: seqCounter+1 when empty ("oldest is in the future, so any
 *              real lastSeq forces a refetch").
 *   newestSeq: seqCounter when empty (0 before any allocation).
 */

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "session", "replay-buffer"]);

export interface SessionReplayFrame {
  readonly seq: number;
  readonly bytes: Uint8Array;
  readonly kind: "text" | "binary";
}

export interface SessionReplayBuffer {
  nextSeq(): number;
  store(seq: number, bytes: Uint8Array, kind: "text" | "binary"): void;
  append(bytes: Uint8Array, kind: "text" | "binary"): number;
  since(lastSeq: number): SessionReplayFrame[] | null;
  readonly oldestSeq: number;
  readonly newestSeq: number;
}

export interface SessionReplayBufferOptions {
  /** Maximum total bytes retained. Oldest frames are evicted when exceeded. */
  maxBytes: number;
}

export function createSessionReplayBuffer(options: SessionReplayBufferOptions): SessionReplayBuffer {
  const { maxBytes } = options;

  const frames: SessionReplayFrame[] = [];
  let totalBytes = 0;
  let seqCounter = 0;
  /** The seq most recently allocated by nextSeq() but not yet stored. null when none pending. */
  let pendingSeq: number | null = null;

  function nextSeq(): number {
    seqCounter += 1;
    pendingSeq = seqCounter;
    return seqCounter;
  }

  function store(seq: number, bytes: Uint8Array, kind: "text" | "binary"): void {
    if (seq !== pendingSeq) {
      throw new Error(
        `store(${seq}) does not match the most recently allocated seq (${pendingSeq}). Call nextSeq() immediately before store() and use the returned value.`,
      );
    }
    pendingSeq = null;

    frames.push({ seq, bytes, kind });
    totalBytes += bytes.byteLength;

    // Evict oldest while over cap, but never evict the only remaining frame.
    // O(n) shift is acceptable at family-assistant scale; a ring/deque would give O(1).
    while (totalBytes > maxBytes && frames.length > 1) {
      const evicted = frames.shift();
      // frames.length > 1 guard above guarantees shift() is defined.
      if (evicted === undefined) break;
      totalBytes -= evicted.bytes.byteLength;
      log.debug("evicted frame from replay buffer", {
        seq: evicted.seq,
        bytes: evicted.bytes.byteLength,
        totalBytes,
      });
    }
  }

  function append(bytes: Uint8Array, kind: "text" | "binary"): number {
    const seq = nextSeq();
    store(seq, bytes, kind);
    return seq;
  }

  function since(lastSeq: number): SessionReplayFrame[] | null {
    if (frames.length === 0) {
      return [];
    }

    const oldest = frames[0]?.seq ?? 0;

    // lastSeq === 0 means "give me everything from the start" — not a gap.
    // Note: if eviction has occurred, only retained frames are returned.
    // Otherwise: if the frame at lastSeq was evicted (lastSeq < oldest), we cannot
    // guarantee contiguous replay, so return null to force a full refetch.
    if (lastSeq > 0 && lastSeq < oldest) {
      return null;
    }

    return frames.filter((f) => f.seq > lastSeq);
  }

  return {
    nextSeq,
    store,
    append,
    since,
    get oldestSeq() {
      // Empty: seqCounter+1 means "oldest is in the future, so any real lastSeq forces refetch".
      return frames[0]?.seq ?? seqCounter + 1;
    },
    get newestSeq() {
      // Empty: seqCounter (0 before any allocation).
      return frames[frames.length - 1]?.seq ?? seqCounter;
    },
  };
}
