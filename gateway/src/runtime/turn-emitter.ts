// TurnEmitter (spec §7) — the outbound-frame seam between a turn's runtime
// callbacks and whatever transport sits on top of them. `SessionRuntime`
// drives turnStarted/textDelta/toolUpdate/turnCompleted; `cancellation.ts`
// drives turnAborted; the voice pipeline (Plan 3 Task 2) drives the audio
// three; the permission PDP and the delegation guard (Plan 3 Task 6) drive
// permissionRequest/permissionResolved/delegationProgress.
//
// This interface is the FINAL 2.0 shape, frozen alongside the wire contract
// in shared/protocol/src/messages.ts. Every method maps 1:1 onto exactly one
// frame in that contract — an emitter method with no frame, or a frame with
// no emitter method, is a contract break, not a feature.
//
// Two implementations exist: `createLoggingTurnEmitter` (below — a headless
// lifecycle trace for the dev harness and `@live` tests) and
// `createWsTurnEmitter` (session-handlers/ws-turn-emitter.ts — the real
// client socket).

import type {
  DelegationProgressMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  TurnAudioEncoding,
  TurnTrigger,
} from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { CutoffKind } from "../store/entry-types.js";
import type { ToolUpdate } from "./react-loop.js";

const log = getLog(["sentient", "runtime", "turn-emitter"]);

const TEXT_PREVIEW_LEN = 120;

/** Wire payloads minus the `type` discriminator — the emitter owns the frame
 *  type; callers supply only the domain fields. Derived from the protocol
 *  schemas by construction so a wire change can never silently diverge from
 *  the seam callers program against. */
export type PermissionRequest = Omit<PermissionRequestMessage, "type">;
export type PermissionResolution = Omit<PermissionResolvedMessage, "type">;
export type DelegationProgress = Omit<DelegationProgressMessage, "type">;

export interface TurnEmitter {
  turnStarted(turnId: string, trigger: TurnTrigger): void;
  textDelta(turnId: string, text: string): void;
  toolUpdate(turnId: string, u: ToolUpdate): void;
  turnCompleted(turnId: string): void;
  turnAborted(turnId: string, cutoff: CutoffKind): void;
  /** Announces the outbound TTS stream for `turnId`. Does NOT stop any
   *  previous turn's audio — per spec §4.6/§7.2 the gateway never interrupts
   *  its own playback; the client queues. */
  audioStart(turnId: string, encoding: TurnAudioEncoding, sampleRate: number): void;
  /** One encoded TTS chunk. Travels as a BINARY frame, not JSON. */
  audioFrame(turnId: string, bytes: Uint8Array): void;
  audioDone(turnId: string): void;
  permissionRequest(req: PermissionRequest): void;
  /** Fires on EVERY resolution path — user answer, 2-minute timeout
   *  auto-deny, or turn abort — so a client dialog is never orphaned. */
  permissionResolved(res: PermissionResolution): void;
  delegationProgress(p: DelegationProgress): void;
}

/**
 * Logging-only impl for headless use (dev harness, `@live` walks). Never
 * dumps full text or argument values (logging rule: previews only, ≤120
 * chars, no user content) — the store already holds the durable record; this
 * is a lifecycle trace, not a transport.
 */
export function createLoggingTurnEmitter(): TurnEmitter {
  return {
    turnStarted(turnId, trigger) {
      log.info("turn-emitter.turn-started", { turnId, trigger });
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
    audioStart(turnId, encoding, sampleRate) {
      log.info("turn-emitter.audio-start", { turnId, encoding, sampleRate });
    },
    audioFrame(turnId, bytes) {
      log.debug("turn-emitter.audio-frame", { turnId, payloadBytes: bytes.byteLength });
    },
    audioDone(turnId) {
      log.info("turn-emitter.audio-done", { turnId });
    },
    permissionRequest(req) {
      // Argument VALUES are never logged — only which keys were mediated.
      log.info("turn-emitter.permission-request", {
        requestId: req.requestId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        argKeys: Object.keys(req.args),
        expiresAtMs: req.expiresAtMs,
      });
    },
    permissionResolved(res) {
      log.info("turn-emitter.permission-resolved", { requestId: res.requestId, outcome: res.outcome });
    },
    delegationProgress(p) {
      log.info("turn-emitter.delegation-progress", {
        taskId: p.taskId,
        turnId: p.turnId,
        agent: p.agent,
        status: p.status,
      });
    },
  };
}
