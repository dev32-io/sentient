// Validated outbound-frame writer (Plan 3 Task 1, spec §7).
//
// Every gateway → client frame goes through here. Plan 2's emitter hand-built
// object literals and called `ws.send(JSON.stringify(...))` directly, so
// `gatewayMessageSchema` described the wire without ever constraining it —
// the schema and the bytes could drift silently and only a client would
// notice. This module makes the schema load-bearing: a frame that does not
// parse never reaches the socket.
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

import { type GatewayMessage, gatewayMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionData } from "./ws-helpers.js";

const log = getLog(["sentient", "ws", "send"]);

/** Binary frame header: 8-byte BE u64 seq + 1-byte type. See the layout
 *  comment at the top of shared/protocol/src/messages.ts. */
const BINARY_HEADER_BYTES = 9;
const BINARY_TYPE_AUDIO = 0x01;

/**
 * Validate `frame` against the gateway → client contract and write it.
 * Returns true when the bytes actually left; false on a schema violation or a
 * dead socket, so callers that care (audio drains) can stop early.
 */
export function sendGatewayFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean {
  const parsed = gatewayMessageSchema.safeParse(frame);
  if (!parsed.success) {
    log.error("ws-send.schema-violation", {
      sessionId: ws.data.sessionId,
      frameType: (frame as { type?: string }).type,
      reason: "outbound frame does not satisfy gatewayMessageSchema — dropped",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
    return false;
  }

  try {
    ws.send(JSON.stringify(parsed.data));
    return true;
  } catch (err) {
    log.warn("ws-send.write-failed", {
      sessionId: ws.data.sessionId,
      frameType: frame.type,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Write one audio payload as a BINARY frame with the 9-byte header.
 *
 * Binary frames carry no `turnId` — the client attributes bytes to the most
 * recent `turn.audio.start`. The gateway therefore MUST bracket each turn's
 * audio (start → frames → done) before starting the next turn's (plan
 * reconciliation R4); this function cannot enforce that and does not try.
 *
 * `seq` is supplied by the caller rather than counted here: JSON and binary
 * frames share ONE sequence space so a resuming client can feed both paths
 * into a single cursor (reconciliation R7). Task 10 owns that allocator.
 */
export function encodeAudioFrame(seq: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(BINARY_HEADER_BYTES + payload.byteLength);
  new DataView(buf.buffer).setBigUint64(0, BigInt(seq), false); // big-endian
  buf[8] = BINARY_TYPE_AUDIO;
  buf.set(payload, BINARY_HEADER_BYTES);
  return buf;
}

export function sendAudioFrame(ws: ServerWebSocket<SessionData>, seq: number, payload: Uint8Array): boolean {
  try {
    ws.send(encodeAudioFrame(seq, payload));
    return true;
  } catch (err) {
    log.warn("ws-send.audio-write-failed", {
      sessionId: ws.data.sessionId,
      seq,
      payloadBytes: payload.byteLength,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
