// FrameJournal — ONE session's outbound frame ring: one monotonic seq space,
// N cursors reading it (session-model spec §2.1/§2.2).
//
// It was per-surface (`${userId}::${surfaceId}`) while a connection was the
// unit of state. The session is the unit now and a connection is a window onto
// it, so the seq lives in the SESSION's space: a session frame is allocated
// ONCE, its wire bytes are built once, and every attached window is handed the
// same bytes. Cursors differ; bytes do not. Two windows that both read seq 41
// read identical bytes, which is what makes "reconnect" and "join" the same
// primitive — `replay-from(seq)` — rather than two mechanisms that must be kept
// in agreement.
//
// LANE-AWARE BY CONSTRUCTION. Only SESSION-lane frames may be journaled
// (frame-lanes.ts). A connection-lane frame — an auth result, a pong, resume
// coordination, session-ready, the attach answer — belongs to one socket, so
// journaling it would replay one window's private frame into another window's
// resume. `allocateText` takes the frame type and refuses, rather than trusting
// every call site to have checked.
//
// Two-phase allocation, fused: the seq lives INSIDE the bytes (a JSON field /
// the 9-byte binary header), so it must exist before the bytes can be built —
// but the PAIRING is not the caller's problem. `allocateText` / `allocateBinary`
// take the builder as a callback, so a dangling pending seq is structurally
// impossible instead of a runtime assertion.
//
// Memory is bounded by TWO independent caps: this byte cap (evict-oldest,
// config `session.replay_journal_max_bytes`) and the registry's detach
// retention window (replay-registry.ts, config
// `session.replay_journal_retention_ms`). Audio journals one frame per Opus
// frame (~50/s) for a session several windows may watch for an hour, so the
// frame COUNT is bounded implicitly by the byte cap. Coalescing many Opus
// frames into one journal entry is deliberately NOT done — each Opus frame
// carries its own seq for client-side dedup.
//
// EVICTION MAY EMPTY THE RING, and that is the fix rather than the bug. The
// per-surface predecessor refused to evict the LAST retained frame, on the
// reasoning that "a journal holding nothing can answer no resume at all". With
// a shared journal that rule lets a stale `turn.started` pin itself as the sole
// survivor and be replayed as the client's whole world. It is also false:
// `since()` answers an EMPTY ring correctly — a client at head gets `[]` (it is
// caught up) and a client behind gets `null` (a real gap → `recovered:false` →
// a fresh snapshot), which is exactly the truth in both cases.

import type { GatewayMessage } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { frameLane } from "./frame-lanes.js";

const log = getLog(["sentient", "ws", "journal"]);

export type JournaledFrameKind = "text" | "binary";

/** Binary audio carries no `type` field; this is the label its log lines and
 *  its lane check use. Audio is session-lane content by definition. */
export const AUDIO_FRAME_TYPE = "audio";

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
  /**
   * Allocate the next seq, build the JSON text with it, journal the encoded
   * bytes, and hand back both so the caller can write the very same string to
   * every attached window without re-encoding.
   *
   * @throws when [frameType] is not a SESSION-lane type. A connection-lane
   *         frame in the session journal is the leak this lane split exists to
   *         prevent; refusing is the only safe answer (see frame-lanes.ts).
   */
  allocateText(frameType: GatewayMessage["type"], build: (seq: number) => string): AllocatedText;
  /** Same contract for a binary frame whose 9-byte header embeds the seq.
   *  Audio is session-lane by definition, so there is no type to check. */
  allocateBinary(build: (seq: number) => Uint8Array): AllocatedBinary;
  /**
   * Frames the client still needs, given the highest seq it applied.
   *
   *   lastSeq === 0            → sentinel "send me everything retained".
   *   lastSeq > newestSeq      → null. The client claims a seq this journal
   *                              never issued (stale epoch that slipped the
   *                              epoch check, or a corrupted cursor) —
   *                              unfillable, force a fresh snapshot.
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
   *  in the future", so a client at head still resumes and any client behind
   *  trips the gap check. */
  readonly oldestSeq: number;
  /** Highest seq ever allocated (retained or evicted). 0 before the first. */
  readonly newestSeq: number;
  readonly byteLength: number;
  readonly frameCount: number;
}

export interface FrameJournalOptions {
  /** The session this journal belongs to. Log correlation — every session-lane
   *  line carries it (spec §7.3). */
  sessionId: string;
  /** Maximum total retained bytes. Oldest frames evict first. */
  maxBytes: number;
}

const TEXT_ENCODER = new TextEncoder();

export function createFrameJournal(options: FrameJournalOptions): FrameJournal {
  const { sessionId, maxBytes } = options;

  const frames: JournaledFrame[] = [];
  let totalBytes = 0;
  let seqCounter = 0;
  /** Whether the ring is currently at its cap. Turns "this session's replay
   *  window is now bounded by the byte cap" into ONE INFO on the transition
   *  instead of one line per evicted Opus frame (~50/s). */
  let wasEvicting = false;

  function retain(frame: JournaledFrame): void {
    frames.push(frame);
    totalBytes += frame.bytes.byteLength;
    if (totalBytes <= maxBytes) {
      wasEvicting = false;
      return;
    }

    if (!wasEvicting) {
      log.info("journal.evicting", {
        sessionId,
        maxBytes,
        totalBytes,
        frameCount: frames.length,
        oldestSeq: frames[0]?.seq ?? seqCounter + 1,
        newestSeq: seqCounter,
        reason: "the session journal reached its byte cap — the replay window is now bounded by eviction",
      });
    }
    wasEvicting = true;

    // Evict oldest while over cap, down to and including empty. The O(n) shift
    // is acceptable at family-assistant scale.
    while (totalBytes > maxBytes && frames.length > 0) {
      const evicted = frames.shift();
      if (evicted === undefined) break;
      totalBytes -= evicted.bytes.byteLength;
      log.debug("journal.evicted", {
        sessionId,
        seq: evicted.seq,
        kind: evicted.kind,
        bytes: evicted.bytes.byteLength,
        totalBytes,
        frameCount: frames.length,
      });
    }
  }

  function allocateText(frameType: GatewayMessage["type"], build: (seq: number) => string): AllocatedText {
    if (frameLane(frameType) !== "session") {
      throw new Error(`refusing to journal connection-lane frame "${frameType}" in a session journal`);
    }
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
        sessionId,
        lastSeq,
        newestSeq: seqCounter,
        reason: "client claims a seq this journal never issued",
      });
      return null;
    }

    const oldest = oldestSeq();
    if (lastSeq < oldest - 1) {
      log.warn("journal.gap.evicted", {
        sessionId,
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
