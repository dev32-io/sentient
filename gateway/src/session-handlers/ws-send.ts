// Validated outbound-frame writer (Plan 3 Task 1, spec §7).
//
// Every gateway → client JSON frame goes through `sendGatewayFrame`, which
// parses it against `gatewayMessageSchema` BEFORE it hits the socket. Parsing
// here also strips any stray key an object spread picked up, so the bytes on
// the wire are exactly the contract and nothing else.
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
// Plan 3 Task 10 adds sequencing on top, without touching a single call site:
//
//   - `sendGatewayFrame` stamps `seq` (monotonic, from this connection's
//     FrameJournal) + `epoch` and journals the wire bytes, so a reconnecting
//     client can be handed back exactly what it missed.
//   - `sendAudioFrame` draws its 9-byte-header seq from the SAME journal.
//     One seq space for JSON and binary, because both client SDKs feed one
//     resume cursor from both paths (reconciliation R7).
//   - `sendUnsequencedFrame` is the deliberate escape hatch used ONLY by the
//     resume handshake (ws-resume.ts): still validated, but neither stamped
//     nor journaled. A seq-stamped `session.ready` on the recovered path
//     would advance the client's cursor past the replay window and it would
//     drop every replayed frame; `stream.resumed` is a handshake ack, not
//     replayable content.
//
// ORDER MATTERS: validate FIRST, stamp SECOND. Stamping before validation
// would let a rejected frame consume a seq and tear a permanent hole in the
// journal's contiguity.

import { type GatewayMessage, gatewayMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionData } from "./ws-helpers.js";

const log = getLog(["sentient", "ws", "send"]);

/** Binary frame header: 8-byte BE u64 seq + 1-byte type. See the layout
 *  comment at the top of shared/protocol/src/messages.ts. */
const BINARY_HEADER_BYTES = 9;
const BINARY_TYPE_AUDIO = 0x01;
/** Header seq for an audio frame written before a journal exists. Both SDKs
 *  treat seq 0 as "unsequenced" and pass it through without dedup, so the
 *  audio still plays — it just cannot be replayed. Should be unreachable:
 *  session.configure mints the journal before any emitter can run. */
const UNSEQUENCED = 0;

function writeText(ws: ServerWebSocket<SessionData>, text: string, frameType: string): boolean {
  try {
    ws.send(text);
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

function writeBinary(ws: ServerWebSocket<SessionData>, framed: Uint8Array, seq: number): boolean {
  try {
    ws.send(framed);
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

function validate(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): GatewayMessage | null {
  const parsed = gatewayMessageSchema.safeParse(frame);
  if (parsed.success) return parsed.data;
  log.error("ws-send.schema-violation", {
    sessionId: ws.data.sessionId,
    frameType: (frame as { type?: string }).type,
    reason: "outbound frame does not satisfy gatewayMessageSchema — dropped",
    issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  });
  return null;
}

/**
 * Validate `frame` against the gateway → client contract, stamp it with this
 * connection's `seq`/`epoch`, journal the wire bytes, and write. Falls back to
 * an unstamped, unjournaled write when the connection has no journal yet
 * (every frame before session.configure).
 *
 * Returns true when the bytes actually left; false on a schema violation or a
 * dead socket, so callers that care (audio drains) can stop early.
 */
export function sendGatewayFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean {
  const validated = validate(ws, frame);
  if (validated === null) return false;

  const journal = ws.data.journal;
  if (journal === null) return writeText(ws, JSON.stringify(validated), frame.type);

  const epoch = ws.data.epoch;
  const allocated = journal.allocateText((seq) => JSON.stringify({ ...validated, seq, epoch }));
  log.debug("ws-send.sequenced", {
    sessionId: ws.data.sessionId,
    frameType: frame.type,
    seq: allocated.seq,
    epoch,
    journalBytes: journal.byteLength,
  });
  return writeText(ws, allocated.text, frame.type);
}

/**
 * Validate and write WITHOUT a seq stamp and WITHOUT journaling. Resume
 * handshake only (ws-resume.ts) — see this file's header for why.
 *
 * @returns true if the frame reached the socket.
 */
export function sendUnsequencedFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean {
  const validated = validate(ws, frame);
  if (validated === null) return false;
  return writeText(ws, JSON.stringify(validated), frame.type);
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

/**
 * Allocate the next seq from this connection's journal, frame the audio
 * payload with it, journal the framed bytes, and write.
 *
 * Binary frames carry no `turnId` — the client attributes bytes to the most
 * recent `turn.audio.start`. The gateway therefore MUST bracket each turn's
 * audio (start → frames → done) before starting the next turn's (plan
 * reconciliation R4); this function cannot enforce that and does not try.
 *
 * SIGNATURE CHANGED in Task 10: the caller no longer supplies `seq`. The
 * emitter's own counter is gone precisely so JSON and binary cannot drift
 * into two seq spaces (reconciliation R7).
 *
 * @returns the allocated seq, or 0 when the frame was written unsequenced
 *          (no journal) or failed to reach the socket.
 */
export function sendAudioFrame(ws: ServerWebSocket<SessionData>, payload: Uint8Array): number {
  const journal = ws.data.journal;

  if (journal === null) {
    log.warn("ws-send.audio-unsequenced", {
      sessionId: ws.data.sessionId,
      payloadBytes: payload.byteLength,
      reason: "no frame journal on this connection — audio before session.configure",
    });
    writeBinary(ws, encodeAudioFrame(UNSEQUENCED, payload), UNSEQUENCED);
    return UNSEQUENCED;
  }

  const allocated = journal.allocateBinary((seq) => encodeAudioFrame(seq, payload));
  return writeBinary(ws, allocated.bytes, allocated.seq) ? allocated.seq : UNSEQUENCED;
}
