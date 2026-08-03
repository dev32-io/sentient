// Where a session's outbound frames actually go, now that the runtime outlives
// any one socket.
//
// WHY THIS EXISTS AT ALL. `createWsTurnEmitter` used to capture the ONE socket
// that built the runtime, which was sound while the runtime was
// connection-scoped and a second connection evicted the first. Under
// attach/detach the runtime belongs to the SESSION, so a captured socket is a
// wedge waiting to happen: the window that built the handles closes, another
// window is still attached (so retention keeps the handles resident), and every
// frame that session ever emits again is written to a dead socket — including
// across a reload, since the survivor's reconnect attaches to those same
// handles rather than rebuilding them.
//
// DELIBERATELY THE SIMPLEST THING THAT IS NOT WRONG. This is not task 6's
// fan-out: there is no session journal, no lane table, no per-cursor seq space
// and no atomic-attach linearization here. Each window still stamps the frame
// from its OWN `ws.data.journal`, exactly as it did when it was the only one.
// Task 6 replaces this object with `fan-out-emitter.ts` and moves the seq into
// the session's space; what this module owns until then is only "which sockets
// are currently listening", which cannot wait for task 6 without shipping the
// wedge above.
//
// LIVENESS IS READ AT WRITE TIME, not latched at attach time. A CLOSING/CLOSED
// socket whose close event has not been processed yet is still in the set, and
// writing to it would log a failure per frame; skipping it is one comparison.
// This is the same predicate the deleted `ConversationOwnerHandle.isAlive` used
// — kept for delivery, where it is a routing question, and gone from lifecycle,
// where it used to authorize a teardown.

import type { GatewayMessage } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionData } from "./ws-helpers.js";
import { sendAudioFrame, sendGatewayFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "session-windows"]);

/** `ServerWebSocket.readyState` OPEN. The other three (CONNECTING, CLOSING,
 *  CLOSED) all mean this window can no longer be served. */
const WS_READY_STATE_OPEN = 1;

export interface SessionWindows {
  /** Start delivering this session's frames to [ws]. Keyed on the
   *  ATTACHMENT id, so a connection that re-attaches replaces its own entry
   *  and a late close cannot remove the one that replaced it. */
  add(attachmentId: string, ws: ServerWebSocket<SessionData>): void;
  /** Stop delivering to this attachment. No-op when it is already gone. */
  remove(attachmentId: string): void;
  /** Write one JSON frame to every open window. Returns how many received it. */
  broadcast(frame: GatewayMessage): number;
  /** Write one audio frame to every open window, each stamped from its own
   *  journal. Returns the allocated seqs, in window order. */
  broadcastAudio(payload: Uint8Array): readonly number[];
  readonly size: number;
}

export function createSessionWindows(sessionId: string): SessionWindows {
  const windows = new Map<string, ServerWebSocket<SessionData>>();

  /** Open windows, as a snapshot — a write that closes a socket must not
   *  perturb the iteration that is still delivering to its peers. */
  function openWindows(frameType: string): ServerWebSocket<SessionData>[] {
    const open: ServerWebSocket<SessionData>[] = [];
    for (const [attachmentId, ws] of windows) {
      if (ws.readyState === WS_READY_STATE_OPEN) {
        open.push(ws);
        continue;
      }
      log.debug("session-windows.skipped", {
        sessionId,
        attachmentId,
        frameType,
        reason: "window socket is closing/closed — its detach has not been processed yet",
      });
    }
    return open;
  }

  return {
    add(attachmentId, ws) {
      windows.set(attachmentId, ws);
      log.info("session-windows.added", { sessionId, attachmentId, windows: windows.size });
    },

    remove(attachmentId) {
      if (!windows.delete(attachmentId)) return;
      log.info("session-windows.removed", { sessionId, attachmentId, windows: windows.size });
    },

    broadcast(frame) {
      const targets = openWindows(frame.type);
      let delivered = 0;
      for (const ws of targets) {
        if (sendGatewayFrame(ws, frame)) delivered += 1;
      }
      if (delivered === 0) {
        log.warn("session-windows.undelivered", {
          sessionId,
          frameType: frame.type,
          windows: windows.size,
          reason: "no open window received this frame",
        });
      }
      return delivered;
    },

    broadcastAudio(payload) {
      return openWindows("audio").map((ws) => sendAudioFrame(ws, payload));
    },

    get size() {
      return windows.size;
    },
  };
}
