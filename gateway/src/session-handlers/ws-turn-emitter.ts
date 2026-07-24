// WsTurnEmitter (Plan 2 Task 10, spec §7) — the REAL `TurnEmitter` that
// writes to the client's WebSocket. `turn-emitter.ts` (Task 7) ships only
// `createLoggingTurnEmitter`, a logging-only default for headless use; this
// is the first implementation that actually reaches a client.
//
// Plan 2 emits ONLY the minimal text-only frame set the dev harness
// (gateway/scripts/try-chat.ts:41-73) already consumes:
//   - textDelta     → { type: "response.text.delta", text }
//   - turnCompleted → { type: "response.text.done", turnId }
// `turnStarted` gets its own lifecycle frame (harmless if a client ignores
// it — try-chat.ts's `default` case just logs unknown frame types).
// `toolUpdate` / `turnAborted` are intentionally LOG-ONLY here — tool tiles,
// permission-prompt UI, and cutoff/cancellation frames are the full
// client-facing wire contract, which is Plan 3's job on top of this same
// `TurnEmitter` interface, without touching any caller of it.

import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { ToolUpdate } from "../runtime/react-loop.js";
import type { TurnEmitter } from "../runtime/turn-emitter.js";
import type { CutoffKind } from "../store/entry-types.js";
import type { SessionData } from "./ws-helpers.js";

const log = getLog(["sentient", "ws", "turn-emitter"]);

const TEXT_PREVIEW_LEN = 120;

export function createWsTurnEmitter(ws: ServerWebSocket<SessionData>): TurnEmitter {
  function send(frame: Record<string, unknown>): void {
    // The turn's promise chain runs detached from the WS message handler
    // (session-runtime.ts's `startTurn` never awaits `runTurn`), so a frame
    // can still be in flight after the socket closes (session.end, network
    // drop). Bun's `ws.send` on a closed socket does not throw, but guard
    // anyway per the error-handling rule (never let a boundary write take
    // down the turn) and to log the degraded path once, not per delta.
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      log.warn("turn-emitter.send-failed", {
        sessionId: ws.data.sessionId,
        frameType: frame.type,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    turnStarted(turnId) {
      log.info("turn-emitter.turn-started", { sessionId: ws.data.sessionId, turnId });
      send({ type: "response.turn.started", turnId });
    },

    textDelta(turnId, text) {
      log.debug("turn-emitter.text-delta", {
        sessionId: ws.data.sessionId,
        turnId,
        length: text.length,
        preview: text.slice(0, TEXT_PREVIEW_LEN),
      });
      send({ type: "response.text.delta", text });
    },

    toolUpdate(turnId, u: ToolUpdate) {
      // No client-facing tool-tile frame in Plan 2 — see file header.
      log.debug("turn-emitter.tool-update", {
        sessionId: ws.data.sessionId,
        turnId,
        toolCallId: u.toolCallId,
        toolName: u.toolName,
        status: u.status,
        taskId: u.taskId,
      });
    },

    turnCompleted(turnId) {
      log.info("turn-emitter.turn-completed", { sessionId: ws.data.sessionId, turnId });
      send({ type: "response.text.done", turnId });
    },

    turnAborted(turnId, cutoff: CutoffKind) {
      // No client-facing cutoff/cancellation frame in Plan 2 — see file header.
      log.info("turn-emitter.turn-aborted", { sessionId: ws.data.sessionId, turnId, cutoff });
    },
  };
}
