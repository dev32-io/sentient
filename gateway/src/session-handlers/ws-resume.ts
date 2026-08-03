// Resume handshake (Plan 3 Task 10, spec §11 slice 6; session-scoped since
// session-model task 6).
//
// Replays what a reconnecting client MISSED and nothing more. The journal it
// reads is the SESSION's — one seq space, N cursors — so "reconnect" and "join"
// are the same primitive with two entry points: a reconnecter presents a seq it
// genuinely reached and is replayed from it, a joiner has no cursor in this
// epoch and takes a snapshot instead (fan-out-emitter.ts).
//
// The frame ORDER below is load-bearing client-FSM behaviour, verified
// against shared/web-sdk/src/{sdk-message-router,resume-cursor,
// stream-resume-handler}.ts and the KMP equivalents:
//
//   recovered:true  → RAW session.ready (ungates the client's connect
//                     handshake — its FSM has no stream.resumed case for
//                     that gate — WITHOUT a seq, so the resume cursor does
//                     not jump past the replay window)
//                   → RAW stream.resumed{recovered:true, epoch, fromSeq, toSeq}
//                   → the missed frames, VERBATIM (they already carry their
//                     original seq / 9-byte header; re-stamping them would
//                     break the client's dedup)
//
//   recovered:false → RAW stream.resumed{recovered:false, epoch}; the caller
//                     then sends a normal session.ready. The client resets its
//                     cursor on recovered:false and takes the snapshot the
//                     caller sends after it.
//
//   no resume asked → nothing here; the caller just sends ready + snapshot.
//
// Every frame this file writes is CONNECTION lane (frame-lanes.ts): a resume
// handshake is a conversation between this socket and the gateway, and
// journaling any of it would burn seq numbers in the space every OTHER window
// is reading.
//
// Everything here is SYNCHRONOUS. There is no await between reading the replay
// window and returning, so no live frame can interleave into the middle of the
// replay — and the attaching window is HELD for the whole of it, so a frame
// emitted meanwhile is buffered and drained after, exactly once.

import type { GatewayMessage, SessionConfigureResume } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { FrameJournal, JournaledFrame } from "./frame-journal.js";
import type { SessionData } from "./ws-helpers.js";
import { sendConnectionFrame, writeReplayFrame } from "./ws-send.js";
// NOTE: ws-send.ts must NOT import this file back — the dependency is
// strictly one-way (resume → send), which is what keeps the send path free
// of any resume-specific branching.

const log = getLog(["sentient", "ws", "resume"]);

export interface HandleResumeInput {
  readonly ws: ServerWebSocket<SessionData>;
  /** The CONNECTION id — log correlation. */
  readonly sessionId: string;
  /** The SESSION's journal, or null when this connection is on a draft (no
   *  session, therefore no journal and nothing to replay). */
  readonly journal: FrameJournal | null;
  readonly epoch: number;
  /** True when the client's `resume.epoch` names the epoch this journal is
   *  still allocating from — the precondition for any replay at all. */
  readonly epochMatches: boolean;
  /** The `resume` object carried inside session.configure, or undefined on a
   *  fresh connect. */
  readonly resumeParams: SessionConfigureResume | undefined;
  /** The session.ready payload. Sent here on the recovered path; the caller
   *  sends it itself on every other path. */
  readonly readyFrame: GatewayMessage;
}

/**
 * Terminal resume decision.
 *
 * @returns the seq the client has now been carried through on the RECOVERED
 *          path (so the caller can drain only what came after it), or null when
 *          nothing was replayed and the caller must send its own
 *          `session.ready` plus a snapshot.
 */
export function handleResumeOrFresh(input: HandleResumeInput): number | null {
  const { ws, sessionId, journal, epoch, epochMatches, resumeParams, readyFrame } = input;

  // Fresh connect: the client carried no cursor, so there is nothing to ack.
  if (resumeParams === undefined) {
    log.debug("resume.fresh-connect", { sessionId, epoch });
    return null;
  }

  // No journal (a draft), or a cursor from a different epoch — a fresh
  // journal was minted, the retention window expired, or this is a different
  // session. Either way there is nothing to replay, but a client that ASKED
  // still needs the ack so it knows not to assume it is caught up.
  if (journal === null || !epochMatches) {
    sendRecoveredFalse(ws, sessionId, epoch, journal === null ? "no-session-journal" : "epoch-mismatch", resumeParams);
    return null;
  }

  const missed = journal.since(resumeParams.lastSeq);
  if (missed === null) {
    // The frame after the client's cursor was evicted by the byte cap, so
    // contiguous replay is impossible.
    sendRecoveredFalse(ws, sessionId, epoch, "gap-evicted", resumeParams);
    return null;
  }

  return sendRecoveredTrue({ ws, sessionId, journal, epoch, readyFrame, lastSeq: resumeParams.lastSeq, missed });
}

interface RecoveredTrueInput {
  readonly ws: ServerWebSocket<SessionData>;
  readonly sessionId: string;
  readonly journal: FrameJournal;
  readonly epoch: number;
  readonly readyFrame: GatewayMessage;
  readonly lastSeq: number;
  readonly missed: readonly JournaledFrame[];
}

/** @returns the journal head the client has been replayed through. */
function sendRecoveredTrue(input: RecoveredTrueInput): number {
  const { ws, sessionId, journal, epoch, readyFrame, lastSeq, missed } = input;

  // 1. session.ready — connection lane, so no seq, so it ungates the client's
  //    connect handshake without advancing its resume cursor past the replay
  //    window.
  sendConnectionFrame(ws, readyFrame);

  // 2. The ack. toSeq is the journal head; it is NOT bumped by the ready above,
  //    which is connection-lane and never touches the journal.
  const fromSeq = lastSeq + 1;
  const toSeq = journal.newestSeq;
  sendConnectionFrame(ws, { type: "stream.resumed", recovered: true, epoch, fromSeq, toSeq });

  log.info("resume.recovered", {
    sessionId,
    epoch,
    fromSeq,
    toSeq,
    replayCount: missed.length,
    replayBytes: missed.reduce((n, f) => n + f.bytes.byteLength, 0),
  });

  // 3. The missed frames, verbatim. They already carry their original seq
  //    (JSON field / binary header) — re-stamping would break client dedup.
  for (const frame of missed) {
    if (!writeReplayFrame(ws, frame.bytes, frame.kind)) {
      log.warn("resume.replay-send-failed", {
        sessionId,
        seq: frame.seq,
        kind: frame.kind,
        reason: "socket write failed mid-replay",
      });
    }
  }
  return toSeq;
}

function sendRecoveredFalse(
  ws: ServerWebSocket<SessionData>,
  sessionId: string,
  epoch: number,
  reason: string,
  resumeParams: SessionConfigureResume,
): void {
  sendConnectionFrame(ws, { type: "stream.resumed", recovered: false, epoch });
  log.info("resume.not-recovered", {
    sessionId,
    epoch,
    requestedEpoch: resumeParams.epoch,
    requestedLastSeq: resumeParams.lastSeq,
    reason,
  });
}
