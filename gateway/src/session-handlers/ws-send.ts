// Validated outbound-frame writers — one per LANE, and the lane is asserted
// rather than assumed (session-model spec §2.1).
//
// Every gateway → client JSON frame is parsed against `gatewayMessageSchema`
// BEFORE it hits the socket. Parsing also strips any stray key an object spread
// picked up, so the bytes on the wire are exactly the contract and nothing else.
//
// Failure policy is deliberate and asymmetric:
//   - A schema violation is a GATEWAY BUG. Log it at error with the offending
//     frame type and the zod issues, then DROP the frame. Never throw — the
//     turn's promise chain runs detached from the WS message handler
//     (session-runtime.ts's `startTurn` never awaits `runTurn`), so throwing
//     here would surface as an unhandled rejection and take down more than
//     this one frame.
//   - A socket write failure is EXPECTED (client vanished mid-turn). Log warn
//     once with a reason, drop, continue.
//
// WHAT CHANGED, AND WHY IT IS A SPLIT RATHER THAN A RENAME. This file used to
// expose `sendGatewayFrame` (stamp a seq from THIS CONNECTION's journal +
// journal the bytes) and `sendUnsequencedFrame` (neither), and the difference
// between them was a judgement call made per call site — the header even
// argued, case by case, why `pong` and the resume ack qualified and `error`
// did not. That distinction is now the LANE, decided once per frame TYPE in
// frame-lanes.ts and enforced here:
//
//   - `sendConnectionFrame` — connection lane. One socket, never a seq, never
//     journaled. Auth results, session-ready, pong, resume coordination, the
//     sessions-list acks, errors, and the attach answer. Asserted: a session-
//     lane frame written this way would be silently absent from every OTHER
//     window and from the replay window.
//   - `sendAttachReplayFrame` — the ONE sanctioned exception, and it is not a
//     content path: the transient prerequisite frames a joining window needs
//     to render an in-flight turn (turn-state-snapshot.ts). Session-lane types,
//     ONE socket, unsequenced and unjournaled, because they RECONSTRUCT frames
//     that were already allocated once for the windows that were there.
//   - `writeJournaledText` / `writeJournaledBinary` — the raw writes for bytes
//     that were already allocated from the SESSION journal: the fan-out
//     emitter's per-window write, and ws-resume.ts's verbatim replay. They do
//     not validate, because the bytes they carry were validated when they were
//     allocated, and re-encoding them would break client dedup.
//
// A session frame is allocated ONCE, in fan-out-emitter.ts, and its bytes are
// written to every attached window. There is deliberately no "send a session
// frame to a socket" entry point here: that shape is what let a per-connection
// seq space exist in the first place.

import { type GatewayMessage, gatewayMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import { frameLane } from "./frame-lanes.js";
import type { SessionData } from "./ws-helpers.js";

const log = getLog(["sentient", "ws", "send"]);

/** Binary frame header: 8-byte BE u64 seq + 1-byte type. See the layout
 *  comment at the top of shared/protocol/src/messages.ts. */
const BINARY_HEADER_BYTES = 9;
const BINARY_TYPE_AUDIO = 0x01;

const decoder = new TextDecoder();

/**
 * `ServerWebSocket.send()` returning 0 — Bun DROPPED the message because the
 * socket's buffer is past `backpressureLimit` (16 MB by default; the gateway
 * sets none). Not an error and not a throw: the call returns normally and the
 * bytes are simply gone.
 *
 * This is the return value spec §8.1 named as ignored, and ignoring it is the
 * residual silent-loss path under a SHARED journal: the frame carried a seq
 * every other cursor advanced past, so the window that lost it has a hole it
 * will never learn about. Treating it as a failed write is what routes it into
 * the same recovery as a dead socket — dropped from the session, client
 * reconnects, gap-fill or a fresh snapshot.
 *
 * `-1` means "queued behind backpressure", which is a real delivery: the bytes
 * are Bun's now and the lag check on the next write is what bounds it.
 */
const SEND_DROPPED = 0;

function writeText(ws: ServerWebSocket<SessionData>, text: string, frameType: string): boolean {
  try {
    if (ws.send(text) === SEND_DROPPED) {
      log.warn("ws-send.backpressure-dropped", {
        sessionId: ws.data.sessionId,
        frameType,
        frameBytes: text.length,
        bufferedAmount: ws.getBufferedAmount(),
        reason: "the transport dropped this frame past its backpressure limit — the window has an unfillable hole",
      });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("ws-send.write-failed", {
      sessionId: ws.data.sessionId,
      frameType,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Parse [frame] against the gateway → client contract, or drop it.
 *
 * Exported because the SESSION lane validates in a different place: the fan-out
 * allocates one seq and encodes ONCE for every window, so validation has to
 * happen before that allocation rather than per socket. ORDER MATTERS —
 * validate FIRST, stamp SECOND. Stamping before validation would let a rejected
 * frame consume a seq and tear a permanent hole in the journal's contiguity,
 * which every attached cursor would then read as an unfillable gap.
 *
 * [scopeId] names whatever the caller can attribute the drop to — a connection
 * id on the connection lane, a session id on the session lane.
 */
export function validateGatewayFrame(scopeId: string | null, frame: GatewayMessage): GatewayMessage | null {
  const parsed = gatewayMessageSchema.safeParse(frame);
  if (parsed.success) return parsed.data;
  log.error("ws-send.schema-violation", {
    scopeId,
    frameType: (frame as { type?: string }).type,
    reason: "outbound frame does not satisfy gatewayMessageSchema — dropped",
    issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  });
  return null;
}

function validate(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): GatewayMessage | null {
  return validateGatewayFrame(ws.data.sessionId, frame);
}

/**
 * Write a CONNECTION-lane frame to the socket it answers. Validated, never
 * seq-stamped, never journaled.
 *
 * @returns true when the bytes actually left; false on a schema violation, a
 *          lane violation, or a dead socket.
 */
export function sendConnectionFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean {
  if (frameLane(frame.type) !== "connection") {
    log.error("ws-send.lane-violation", {
      sessionId: ws.data.sessionId,
      frameType: frame.type,
      reason: "session-lane frame written to one socket — it must be allocated once and fanned out",
    });
    return false;
  }
  const validated = validate(ws, frame);
  if (validated === null) return false;
  return writeText(ws, JSON.stringify(validated), frame.type);
}

/**
 * Write a SESSION-lane frame to ONE socket, unsequenced and unjournaled — the
 * attach reconstruction and nothing else.
 *
 * A window joining mid-turn needs the transient prerequisites it was not there
 * for (`turn.started` before deltas, an audio bracket before audio, a prompt
 * before its resolution). Those frames were already allocated once, for the
 * windows that WERE there; re-allocating them would advance every peer's cursor
 * and re-deliver them. So they are rebuilt live and written here — outside the
 * seq space, exactly like the committed snapshot they arrive with.
 */
export function sendAttachReplayFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean {
  if (frameLane(frame.type) !== "session") {
    log.error("ws-send.lane-violation", {
      sessionId: ws.data.sessionId,
      frameType: frame.type,
      reason: "connection-lane frame written as an attach replay — use sendConnectionFrame",
    });
    return false;
  }
  const validated = validate(ws, frame);
  if (validated === null) return false;
  return writeText(ws, JSON.stringify(validated), frame.type);
}

/**
 * Write bytes that were already allocated from the session journal.
 *
 * No validation and no re-encoding by design: the frame was validated when it
 * was allocated, and its `seq` lives inside the bytes — re-stamping or
 * re-serialising would break the client's dedup.
 */
export function writeJournaledText(ws: ServerWebSocket<SessionData>, text: string, frameType: string): boolean {
  return writeText(ws, text, frameType);
}

/** Binary half of `writeJournaledText`. `seq` is for the failure log only; it
 *  is already inside `framed`. */
export function writeJournaledBinary(ws: ServerWebSocket<SessionData>, framed: Uint8Array, seq: number): boolean {
  try {
    if (ws.send(framed) === SEND_DROPPED) {
      log.warn("ws-send.backpressure-dropped", {
        sessionId: ws.data.sessionId,
        seq,
        frameBytes: framed.byteLength,
        bufferedAmount: ws.getBufferedAmount(),
        reason: "the transport dropped this audio frame past its backpressure limit",
      });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("ws-send.audio-write-failed", {
      sessionId: ws.data.sessionId,
      seq,
      frameBytes: framed.byteLength,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Replay one journaled frame verbatim (ws-resume.ts). Text and binary share
 *  one entry point because a replay window interleaves both. */
export function writeReplayFrame(
  ws: ServerWebSocket<SessionData>,
  bytes: Uint8Array,
  kind: "text" | "binary",
): boolean {
  if (kind === "binary") return writeJournaledBinary(ws, bytes, 0);
  return writeText(ws, decoder.decode(bytes), "replay");
}

/**
 * Prepends the 9-byte binary header the client SDKs peel:
 *   [8-byte BE u64 seq][1-byte type = 0x01 audio][payload]
 * Clients dedupe by `seq` and treat `seq === 0` as unsequenced, so real
 * frames start at 1.
 */
export function encodeAudioFrame(seq: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(BINARY_HEADER_BYTES + payload.byteLength);
  new DataView(buf.buffer).setBigUint64(0, BigInt(seq), false); // big-endian
  buf[8] = BINARY_TYPE_AUDIO;
  buf.set(payload, BINARY_HEADER_BYTES);
  return buf;
}
