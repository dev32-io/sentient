// ---------------------------------------------------------------------------
// resume-cursor — in-memory seq/epoch cursor for WS stream resumption.
//
// Tracks the highest-seen seq per gateway epoch so that:
//   1. Binary frames can be deduped by their header seq (replay protection).
//   2. JSON frames with a `seq` field can be deduped similarly.
//   3. On reconnect, the cursor is sent via `stream.resume` so the gateway can
//      replay any frames the client missed during the outage.
//
// Design notes:
//   - In-memory only (Slice 3). Slice 4 will persist to IndexedDB/localStorage.
//   - A fresh session (first connect) has cursor {epoch: 0, lastSeq: 0}.
//     The first real seq from the gateway will be 1 > 0, so it is applied.
//   - On `stream.resumed {recovered: false}` the caller MUST reset the cursor
//     to {epoch: 0, lastSeq: 0} and REST-refetch history.
//   - On epoch change (gateway restarted mid-connection) seq resets; we track
//     the new epoch and reset lastSeq.
// ---------------------------------------------------------------------------

export interface ResumeCursor {
  /** Gateway epoch for the current connection. 0 = not yet received. */
  epoch: number;
  /** Highest seq seen in the current epoch. 0 = none yet. */
  lastSeq: number;
}

/**
 * Create a new mutable cursor. All methods mutate in place and return `this`
 * so call sites read cleanly.
 */
export interface ResumeCursorState {
  /** The current cursor snapshot (read-only view for callers). */
  readonly cursor: ResumeCursor;
  /**
   * Attempt to apply a frame with the given seq (and optional epoch).
   * Returns true if the frame should be processed; false if it should be
   * dropped as a duplicate or already-applied replay.
   *
   * Rules:
   *   - If epoch is provided and differs from cursor.epoch, reset lastSeq to 0
   *     and update epoch. Then apply normally.
   *   - seq === 0 means "no seq" — always pass through (legacy or non-seq frame).
   *   - seq <= lastSeq → DROP (already applied or replay overlap).
   *   - seq > lastSeq → APPLY, advance lastSeq.
   */
  tryApply(seq: number, epoch?: number): boolean;
  /** Overwrite the cursor. Used on fresh-session load (recovered:false). */
  reset(epoch?: number, lastSeq?: number): void;
}

export function createResumeCursor(): ResumeCursorState {
  let epoch = 0;
  let lastSeq = 0;

  return {
    get cursor(): ResumeCursor {
      return { epoch, lastSeq };
    },

    tryApply(seq: number, incomingEpoch?: number): boolean {
      // No seq field — always pass through.
      if (seq === 0) return true;

      // Epoch transition: new gateway epoch resets the sequence space.
      if (incomingEpoch !== undefined && incomingEpoch !== 0 && incomingEpoch !== epoch) {
        epoch = incomingEpoch;
        lastSeq = 0;
      }

      if (seq <= lastSeq) return false; // duplicate / replay
      lastSeq = seq;
      return true;
    },

    reset(newEpoch = 0, newLastSeq = 0): void {
      epoch = newEpoch;
      lastSeq = newLastSeq;
    },
  };
}
