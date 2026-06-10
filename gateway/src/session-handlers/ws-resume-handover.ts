/**
 * WS resume handshake helpers (Task 3.8).
 *
 * Extracted from ws-session-configure.ts (which is already over the size cap)
 * so the resume branch stays small and testable.
 *
 * Flow:
 *  - handleResumeOrFresh: the terminal decision after the pipeline is built.
 *    If the device buffer was resumed AND it still holds frames since the
 *    client's lastSeq, emit stream.resumed{recovered:true} and replay those
 *    frames VERBATIM (they already carry seq + the 9-byte binary header — we
 *    do NOT re-sequence them), then suppress the fresh-connect frames. Else
 *    emit stream.resumed{recovered:false} and let the caller run the normal
 *    fresh setup (session.ready + empty snapshot). The client REST-refetches
 *    history on recovered:false.
 *
 * All resume frames bypass the FrameSequencer — the stream.resumed control
 * frame and the replayed frames are sent RAW on the socket. The control frame
 * is not journaled (it is a handshake ack, not replayable content); the
 * replayed frames are already in the buffer.
 */

import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionReplayBuffer } from "./session-replay-buffer.js";
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
}

/**
 * Terminal resume decision. Returns true when the caller should SUPPRESS the
 * fresh-connect frames (session.ready + empty snapshot) because a successful
 * replay was emitted; false when the caller should proceed with the normal
 * fresh setup (recovered:false was sent, client will REST-refetch).
 */
export function handleResumeOrFresh(input: HandleResumeOrFreshInput): boolean {
  const { ws, sessionId, deviceId, buffer, epoch, resumed, resumeParams } = input;

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

  // recovered:true — emit the ack with the replayed range, then replay each
  // buffered frame VERBATIM. fromSeq is lastSeq+1; toSeq is the buffer head.
  const fromSeq = resumeParams.lastSeq + 1;
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
  return true;
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
