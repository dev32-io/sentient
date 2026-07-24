// TurnEmitter (spec §7) — the outbound-frame seam between the ReAct loop's
// per-turn callbacks and whatever transport sits on top of them. Task 6's
// `onTextDelta`/`onToolUpdate` map onto `emitter.textDelta`/`emitter.toolUpdate`;
// `SessionRuntime` (this task) additionally drives `turnStarted`/`turnCompleted`
// around each `runTurn` call. Plan 3 (Task 10) gives this interface a real
// client wire (WS frames to the browser/mobile SDK) without touching the
// interface or any caller of it. Plan 2 ships `createLoggingTurnEmitter`, a
// minimal logging-only default for the dev harness.

import { getLog } from "../logging/logger.js";
import type { CutoffKind } from "../store/entry-types.js";
import type { ToolUpdate } from "./react-loop.js";

const log = getLog(["sentient", "runtime", "turn-emitter"]);

const TEXT_PREVIEW_LEN = 120;

export interface TurnEmitter {
  turnStarted(turnId: string): void;
  textDelta(turnId: string, text: string): void;
  toolUpdate(turnId: string, u: ToolUpdate): void;
  turnCompleted(turnId: string): void;
  turnAborted(turnId: string, cutoff: CutoffKind): void;
}

/**
 * Minimal logging-only impl for the dev harness (Plan 2). Never dumps full
 * text (logging rule: previews only, ≤120 chars) — the store already holds
 * the durable record; this is a lifecycle trace, not a transport.
 */
export function createLoggingTurnEmitter(): TurnEmitter {
  return {
    turnStarted(turnId) {
      log.info("turn-emitter.turn-started", { turnId });
    },
    textDelta(turnId, text) {
      log.debug("turn-emitter.text-delta", {
        turnId,
        length: text.length,
        preview: text.slice(0, TEXT_PREVIEW_LEN),
      });
    },
    toolUpdate(turnId, u) {
      log.debug("turn-emitter.tool-update", {
        turnId,
        toolCallId: u.toolCallId,
        toolName: u.toolName,
        status: u.status,
        taskId: u.taskId,
      });
    },
    turnCompleted(turnId) {
      log.info("turn-emitter.turn-completed", { turnId });
    },
    turnAborted(turnId, cutoff) {
      log.info("turn-emitter.turn-aborted", { turnId, cutoff });
    },
  };
}
