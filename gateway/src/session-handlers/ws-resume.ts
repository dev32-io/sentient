// Resume handshake (Plan 3 Task 10, spec §11 slice 6).
//
// Successor to the deleted ws-resume-handover.ts, minus everything that
// served the ACP pipeline. The old file's `goLive()` callback existed so a
// STALE in-flight Hermes cycle could keep streaming into the NEW socket
// after a resumable reconnect. 2.0 has no such object: the old connection's
// SessionRuntime was disposed the moment its socket closed
// (ws-handlers.ts's cleanupSession → runtime.dispose(), which aborts the
// in-flight turn's signal and closes the store handle, idempotently). So
// this file replays what the client MISSED and nothing more — there is no
// handover, no deferred teardown, and no socket ref to re-point.
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
//                     then sends a normally-stamped session.ready. The
//                     client resets its cursor on recovered:false and
//                     REST-refetches history, so the stamped ready starts
//                     the new epoch cleanly.
//
//   no resume asked → nothing here; the caller just sends a stamped ready.
//
// Everything in this file is SYNCHRONOUS. There is no await between reading
// the replay window and returning, so no live frame can interleave into the
// middle of the replay.

import type { GatewayMessage, SessionConfigureResume } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { FrameJournal, JournaledFrame } from "./frame-journal.js";
import type { SessionData } from "./ws-helpers.js";
import { sendUnsequencedFrame } from "./ws-send.js";
// NOTE: ws-send.ts must NOT import this file back — the dependency is
// strictly one-way (resume → send), which is what keeps the send path free
// of any resume-specific branching.

const log = getLog(["sentient", "ws", "resume"]);

const decoder = new TextDecoder();

export interface HandleResumeInput {
  readonly ws: ServerWebSocket<SessionData>;
  readonly sessionId: string;
  /** `${userId}::${surfaceId}` — logging + correlation only. */
  readonly surfaceKey: string;
  readonly journal: FrameJournal;
  readonly epoch: number;
  /** True when the registry reused an existing journal at a matching epoch. */
  readonly resumed: boolean;
  /** The `resume` object carried inside session.configure, or undefined on a
   *  fresh connect. */
  readonly resumeParams: SessionConfigureResume | undefined;
  /** The session.ready payload. Sent RAW here on the recovered path; the
   *  caller sends it (stamped) itself on every other path. */
  readonly readyFrame: GatewayMessage;
}

/**
 * Terminal resume decision.
 *
 * @returns true when `session.ready` was already sent here (the recovered
 *          path) and the caller must NOT send it again; false when the caller
 *          should send its normal stamped `session.ready`.
 */
export function handleResumeOrFresh(input: HandleResumeInput): boolean {
  const { ws, sessionId, surfaceKey, journal, epoch, resumed, resumeParams, readyFrame } = input;

  // Fresh connect: the client carried no cursor, so there is nothing to ack.
  if (resumeParams === undefined) {
    log.debug("resume.fresh-connect", { sessionId, surfaceKey, epoch });
    return false;
  }

  // The registry handed back a fresh journal — no prior entry, the retention
  // window expired, or the epoch did not match. Either way there is nothing
  // to replay, but a client that ASKED still needs the ack so it knows to
  // REST-refetch instead of assuming it is caught up.
  if (!resumed) {
    sendRecoveredFalse(ws, sessionId, surfaceKey, epoch, "fresh-journal-or-epoch-mismatch", resumeParams);
    return false;
  }

  const missed = journal.since(resumeParams.lastSeq);
  if (missed === null) {
    // The frame after the client's cursor was evicted by the byte cap, so
    // contiguous replay is impossible.
    sendRecoveredFalse(ws, sessionId, surfaceKey, epoch, "gap-evicted", resumeParams);
    return false;
  }

  sendRecoveredTrue({ ws, sessionId, surfaceKey, journal, epoch, readyFrame, lastSeq: resumeParams.lastSeq, missed });
  return true;
}

interface RecoveredTrueInput {
  readonly ws: ServerWebSocket<SessionData>;
  readonly sessionId: string;
  readonly surfaceKey: string;
  readonly journal: FrameJournal;
  readonly epoch: number;
  readonly readyFrame: GatewayMessage;
  readonly lastSeq: number;
  readonly missed: readonly JournaledFrame[];
}

function sendRecoveredTrue(input: RecoveredTrueInput): void {
  const { ws, sessionId, surfaceKey, journal, epoch, readyFrame, lastSeq, missed } = input;

  // 1. RAW session.ready — no seq, so it ungates the client's connect
  //    handshake without advancing its resume cursor past the replay window.
  sendUnsequencedFrame(ws, readyFrame);

  // 2. The ack, also raw: a handshake ack is not replayable content, so it
  //    is neither stamped nor journaled. toSeq is the journal head; it is NOT
  //    bumped by the raw ready above, which bypassed the journal entirely.
  const fromSeq = lastSeq + 1;
  const toSeq = journal.newestSeq;
  sendUnsequencedFrame(ws, { type: "stream.resumed", recovered: true, epoch, fromSeq, toSeq });

  log.info("resume.recovered", {
    sessionId,
    surfaceKey,
    epoch,
    fromSeq,
    toSeq,
    replayCount: missed.length,
    replayBytes: missed.reduce((n, f) => n + f.bytes.byteLength, 0),
  });

  // 3. The missed frames, verbatim. They already carry their original seq
  //    (JSON field / binary header) — re-stamping would break client dedup.
  for (const frame of missed) {
    writeReplayFrame(ws, frame, sessionId, surfaceKey);
  }
}

function sendRecoveredFalse(
  ws: ServerWebSocket<SessionData>,
  sessionId: string,
  surfaceKey: string,
  epoch: number,
  reason: string,
  resumeParams: SessionConfigureResume,
): void {
  sendUnsequencedFrame(ws, { type: "stream.resumed", recovered: false, epoch });
  log.info("resume.not-recovered", {
    sessionId,
    surfaceKey,
    epoch,
    requestedEpoch: resumeParams.epoch,
    requestedLastSeq: resumeParams.lastSeq,
    reason,
  });
}

/**
 * Write one journaled frame back onto the socket exactly as it was first
 * written. Never throws — a socket that dies mid-replay must not take
 * session.configure down with it.
 */
function writeReplayFrame(
  ws: ServerWebSocket<SessionData>,
  frame: JournaledFrame,
  sessionId: string,
  surfaceKey: string,
): void {
  try {
    ws.send(frame.kind === "text" ? decoder.decode(frame.bytes) : frame.bytes);
  } catch (err) {
    log.warn("resume.replay-send-failed", {
      sessionId,
      surfaceKey,
      seq: frame.seq,
      kind: frame.kind,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
