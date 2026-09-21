// The SESSION's input floor (session-model spec §8.3).
//
// "A connection is a window onto the session, and the first window to talk
// wins." That rule is about SIMULTANEOUS CONTENTION and nothing else: two
// people pressing send at the same moment resolve to one, and the other is told
// `session_busy` rather than having their message silently interleaved into
// somebody else's sentence.
//
// IT IS NOT A LOCK FOR THE DURATION OF A TURN, and the difference is the whole
// design. A message arriving three seconds into a running reply is someone else
// talking into the room; it is absorbed by the existing stimulus seam
// (runtime/session-runtime.ts's steer path) and starts no second turn. A floor
// held until the turn ended would make one speaker own the session for as long
// as the assistant kept answering — which defeats multi-window entirely, and is
// the failure mode this module is shaped to avoid.
//
// So the floor is held for a fixed span from when it was taken, NOT until the
// work it triggered finishes, and NOT refreshed by the holder's own later
// input. Refreshing would let one window that keeps typing starve a peer
// indefinitely — the same lock, reached by a different route.
//
// WHY IT IS SESSION STATE. It hangs off `SessionHandles`, so it is built with
// the session and released with it. A module-level map keyed by session id
// would be ambient global state that outlives every session it ever saw.

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "ws", "input-arbiter"]);

export interface InputFloorReservation {
  /** Keep the floor through its normal arbitration window. */
  commit(): void;
  /** Release only this reservation; stale failures cannot release a newer claim. */
  release(): void;
}

export interface InputArbiter {
  /** Reserve before durable admission. Null means another attachment owns the floor. */
  reserve(attachmentId: string, nowMs: number): InputFloorReservation | null;
  /** Compatibility helper for callers that need an immediately committed claim. */
  claim(attachmentId: string, nowMs: number): boolean;
}

/**
 * [windowMs] is `session.input_arbitration_window_ms`. Zero disables
 * arbitration — every claim succeeds, which is the pre-§8.3 behaviour and the
 * operator's escape hatch, not a special case in the logic below (a zero-length
 * window is never "still open").
 */
export function createInputArbiter(sessionId: string, windowMs: number): InputArbiter {
  let floor: { attachmentId: string; atMs: number; reservations: Set<object>; committed: boolean } | null = null;

  function reserve(attachmentId: string, nowMs: number): InputFloorReservation | null {
    if (floor !== null && nowMs - floor.atMs < windowMs) {
      if (floor.attachmentId !== attachmentId) {
        log.info("input-arbiter.busy", {
          sessionId,
          attachmentId,
          holderAttachmentId: floor.attachmentId,
          elapsedMs: nowMs - floor.atMs,
          windowMs,
          reason: "another window claimed this session's input floor at this dispatch — first window to talk wins",
        });
        return null;
      }
    } else {
      floor = { attachmentId, atMs: nowMs, reservations: new Set(), committed: false };
      log.debug("input-arbiter.claimed", { sessionId, attachmentId, windowMs });
    }

    const claimedFloor = floor;
    const token = {};
    claimedFloor.reservations.add(token);
    return {
      commit() {
        claimedFloor.committed = true;
        claimedFloor.reservations.delete(token);
      },
      release() {
        claimedFloor.reservations.delete(token);
        if (floor === claimedFloor && !claimedFloor.committed && claimedFloor.reservations.size === 0) floor = null;
      },
    };
  }

  return {
    reserve,
    claim(attachmentId, nowMs) {
      const reservation = reserve(attachmentId, nowMs);
      reservation?.commit();
      return reservation !== null;
    },
  };
}
