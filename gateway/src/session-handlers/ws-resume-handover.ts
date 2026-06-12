/**
 * WS resume handshake helpers (Task 3.8).
 *
 * Extracted from ws-session-configure.ts (which is already over the size cap)
 * so the resume branch stays small and testable.
 *
 * Flow:
 *  - handleResumeOrFresh: the terminal decision after the pipeline is built.
 *    If the device buffer was resumed AND it still holds frames since the
 *    client's lastSeq, this is a recovered:true resume. It FIRST emits
 *    session.ready (via the injected sendReady thunk) so the client's connect
 *    handshake completes its ready-gate — the client FSM only ungates on
 *    session.ready and has no stream.resumed case — THEN emits
 *    stream.resumed{recovered:true} and replays the missed frames VERBATIM
 *    (they already carry seq + the 9-byte binary header — we do NOT
 *    re-sequence them). The ORDER is load-bearing: session.ready BEFORE
 *    stream.resumed so the client runs DEFER_TO_RESUME on READY (cursor has a
 *    seq) and PRESERVE_IN_FLIGHT on the resume ack, in that order. The empty
 *    conversation.snapshot and the session.preferences.changed seed stay
 *    suppressed — the client has history + prefs via the replay window (a
 *    re-seed would double-send). The caller suppresses those by skipping the
 *    fresh-only block when this returns true.
 *    Else (no buffer to resume) emit stream.resumed{recovered:false} and let
 *    the caller run the normal fresh setup (session.ready + prefs seed + empty
 *    snapshot). The client REST-refetches history on recovered:false.
 *
 * All resume frames bypass the FrameSequencer — the stream.resumed control
 * frame and the replayed frames are sent RAW on the socket. The control frame
 * is not journaled (it is a handshake ack, not replayable content); the
 * replayed frames are already in the buffer.
 */

import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionReplayBuffer, SessionReplayFrame } from "./session-replay-buffer.js";
import type { ClientData } from "./ws-helpers.js";

const log = getLog(["sentient", "ws", "resume"]);

const decoder = new TextDecoder();

export interface ResumeParams {
  readonly epoch: number;
  readonly lastSeq: number;
  /** The stable deviceId from session.configure — resume now rides in that frame. */
  readonly deviceId: string;
}

export interface HandleResumeOrFreshInput {
  readonly ws: ServerWebSocket<ClientData>;
  readonly sessionId: string;
  /** The stable deviceId that keys the per-device replay buffer. */
  readonly deviceId: string;
  readonly buffer: SessionReplayBuffer;
  readonly epoch: number;
  /** True when acquireDeviceBuffer reused an existing entry (matching epoch). */
  readonly resumed: boolean;
  /** Resume params from the session.configure `resume` object, or null (fresh connect). */
  readonly resumeParams: ResumeParams | null;
  /**
   * The session.ready payload. On the recovered:true path it is sent RAW (no
   * seq) BEFORE stream.resumed so the client handshake's ready-gate completes
   * (its FSM only ungates on session.ready) WITHOUT advancing the client resume
   * cursor — a seq-stamped session.ready would jump the cursor past the replay
   * window and the client would drop every replayed frame. On recovered:false /
   * fresh the caller sends session.ready itself (seq-stamped), so this is unused
   * there.
   */
  readonly readyFrame: Record<string, unknown>;
  /**
   * Make the new socket the device's live writer. On recovered:true this is
   * called AFTER the replay window is flushed, so the in-flight cycle's
   * continuation (final answer + cycle.done) streams to the new socket in seq
   * order behind the replay — never ahead of it.
   */
  readonly goLive: () => void;
}

/**
 * Terminal resume decision. Returns true when the caller should SUPPRESS the
 * fresh-only block (the prefs seed + empty snapshot) because a recovered:true
 * replay was emitted — session.ready was already sent here via sendReady, so
 * the caller must NOT send it again. Returns false when the caller should
 * proceed with the normal fresh setup (recovered:false was sent, or no resume;
 * the caller sends session.ready + prefs seed + snapshot and the client
 * REST-refetches on recovered:false).
 */
export function handleResumeOrFresh(input: HandleResumeOrFreshInput): boolean {
  const { ws, sessionId, deviceId, buffer, epoch, resumed, resumeParams, readyFrame, goLive } = input;

  // Fresh connect (no resume frame) OR epoch mismatch (acquire gave a new
  // buffer). Nothing to replay — but a client that asked to resume still needs
  // the recovered:false ack so it can REST-refetch. A client that never asked
  // (resumeParams === null) gets the plain fresh setup with no ack.
  if (!resumed || resumeParams === null) {
    if (resumeParams !== null) {
      sendRecoveredFalse(ws, sessionId, deviceId, epoch, "epoch-mismatch-or-no-prior-buffer");
    }
    return false;
  }

  const missed = buffer.since(resumeParams.lastSeq);
  // Gap: the frame at lastSeq was evicted (byte-cap) → contiguous replay
  // impossible. Fall back to recovered:false; client REST-refetches history.
  if (missed === null) {
    sendRecoveredFalse(ws, sessionId, deviceId, epoch, "gap-evicted");
    return false;
  }

  // recovered:true — ORDER IS LOAD-BEARING. RAW session.ready FIRST so the
  // client handshake's ready-gate completes (its FSM only ungates on
  // session.ready and has no stream.resumed case) WITHOUT advancing the resume
  // cursor; on READY the client runs DEFER_TO_RESUME (cursor has a seq) and
  // waits for the ack. THEN the stream.resumed ack + replay, which the client
  // handles as PRESERVE_IN_FLIGHT. Finally goLive() so the in-flight cycle's
  // continuation streams to the new socket BEHIND the replay (correct seq
  // order). The prefs seed + empty snapshot stay suppressed (caller skips its
  // fresh block) — the client has both via replay.
  sendRecoveredTrue(ws, sessionId, deviceId, buffer, epoch, resumeParams.lastSeq, readyFrame, goLive, missed);
  return true;
}

/**
 * recovered:true path — mirrors sendRecoveredFalse for symmetry.
 * ORDER IS LOAD-BEARING: RAW session.ready FIRST so the client handshake's
 * ready-gate completes WITHOUT advancing the resume cursor, THEN stream.resumed
 * ack, THEN verbatim frame replay, THEN goLive() so the live continuation
 * follows behind the replay in seq order.
 *
 * Everything here is SYNCHRONOUS — no await between snapshotting `missed`
 * (already done by the caller) and goLive() — so no in-flight cycle frame can
 * interleave between the replay and going live.
 */
function sendRecoveredTrue(
  ws: ServerWebSocket<ClientData>,
  sessionId: string,
  deviceId: string,
  buffer: SessionReplayBuffer,
  epoch: number,
  lastSeq: number,
  readyFrame: Record<string, unknown>,
  goLive: () => void,
  missed: SessionReplayFrame[],
): void {
  // RAW session.ready first — NO seq, so it ungates the client handshake
  // without advancing the resume cursor past the replay window. A seq-stamped
  // session.ready here would make the client drop every replayed frame.
  sendRawFrame(ws, JSON.stringify(readyFrame), "session.ready");
  // emit the ack with the replayed range, then replay each buffered frame
  // VERBATIM. fromSeq is lastSeq+1; toSeq is the buffer head (NOT bumped by the
  // raw session.ready — it bypasses the sequencer/buffer).
  const fromSeq = lastSeq + 1;
  const toSeq = buffer.newestSeq;
  sendRawFrame(
    ws,
    JSON.stringify({ type: "stream.resumed", recovered: true, epoch, fromSeq, toSeq }),
    "stream.resumed",
  );
  log.info("resume.recovered", {
    sessionId,
    deviceId,
    epoch,
    fromSeq,
    toSeq,
    replayCount: missed.length,
  });
  for (const frame of missed) {
    if (frame.kind === "text") {
      sendRawFrame(ws, decoder.decode(frame.bytes), "replay-text");
    } else {
      sendRawFrame(ws, frame.bytes, "replay-binary");
    }
  }
  // Replay flushed — NOW route the device's live socket to the new connection.
  // The in-flight cycle's next frame (seq > toSeq) streams here, behind the
  // replay, in order.
  goLive();
}

function sendRecoveredFalse(
  ws: ServerWebSocket<ClientData>,
  sessionId: string,
  deviceId: string,
  epoch: number,
  reason: string,
): void {
  sendRawFrame(ws, JSON.stringify({ type: "stream.resumed", recovered: false, epoch }), "stream.resumed");
  log.info("resume.recovered-false", { sessionId, deviceId, epoch, reason });
}

/**
 * Raw socket write (text or binary) that never throws — a dead/closed socket
 * on resume must not crash session.configure. These bypass the FrameSequencer:
 * the stream.resumed control frame is a handshake ack (not replayable content);
 * the replayed frames are already in the buffer with their original seq/header.
 */
function sendRawFrame(ws: ServerWebSocket<ClientData>, value: string | Uint8Array, tag: string): void {
  try {
    ws.send(value);
  } catch (err: unknown) {
    log.warn("resume.raw-send-failed", { tag, reason: err instanceof Error ? err.message : String(err) });
  }
}
