// TurnEmitter (spec §7) — the outbound-frame seam between a turn's runtime
// callbacks and whatever transport sits on top of them. `SessionRuntime`
// drives turnStarted/textDelta/taskList/turnCompleted; `cancellation.ts`
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
  ConversationFeedItem,
  DelegationProgressMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  TaskListItem,
  TurnAudioEncoding,
  TurnTrigger,
} from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { CutoffKind } from "../store/entry-types.js";
import type { TitleProvenance } from "../store/session-metadata.js";

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
  textDelta(turnId: string, text: string, replyId?: string): void;
  turnCompleted(turnId: string): void;
  /** The feed marker for a cut-off turn. Carries the cutoff kind and NOTHING
   *  about audio — `playbackStop` is a separate method because speech
   *  outlives its turn and the two are cancelled in different windows. */
  turnAborted(turnId: string, cutoff: CutoffKind): void;
  /** Tells the client to drop everything it has queued for playback. The ONLY
   *  sanctioned audio flush: a USER cancel gesture (spec §4.6/§7.2, Global
   *  Constraint 5). A new turnId must never produce it. */
  playbackStop(turnId: string, reason: CutoffKind): void;
  /**
   * The session's whole committed feed (spec §3.2), sent once per non-recovered
   * attach — and DIRECTED at the connection that attached, never fanned out
   * (session-model spec §7.2): both SDKs replace their committed mirror on it.
   *
   * THE REPLAY INVARIANT, IN ITS TRUE FORM. Both projections read the same
   * store, which gives `render(replay_from(seq)) == render(live_at(seq))` for
   * any seq a client GENUINELY reached. It does NOT give the unqualified
   * `render(replay) == render(live)` this comment used to claim: a fresh joiner
   * is `snapshot ∪ replay_from(watermark)` — a different, defined path that
   * converges with the committed projection once the in-flight turn commits.
   * Conflating the two is what made the original claim false.
   */
  conversationSnapshot(items: ConversationFeedItem[]): void;
  /** One newly committed feed item. `turnId` is the entry's OWN originating
   *  turn — the gateway-owned join key the client uses to fold the committed
   *  twin into its live streaming bubble. Omitted when unknown. */
  conversationEntry(item: ConversationFeedItem, turnId?: string, replyId?: string): void;
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
  /**
   * The session's whole live task list (runtime/task-list.ts) — every row, every
   * time. FULL STATE by design: last-one-wins makes replay, fan-out and a late
   * joiner all the same operation, and leaves the client with nothing to
   * reconcile. `turnId` is null when only background rows outlive their turn.
   *
   * REQUIRED, like every sibling on this interface (see this file's header:
   * "an emitter method with no frame ... is a contract break, not a
   * feature"). Every implementer — including hand-rolled test fixtures —
   * must provide it; a missing one is a compile-time TS2741, which is the
   * point: this interface has already shipped one silently-dropped-field bug
   * from a hand-rolled full-emitter literal (192c6dbd), and an optional
   * method here would remove exactly the compiler guard that class of bug
   * needs.
   */
  taskList(turnId: string | null, items: TaskListItem[]): void;
  /**
   * This session's title changed (spec §6) — the gateway's OWN titling push,
   * not the echo of a client's rename (`sessions.renamed`).
   *
   * SESSION LANE: it renames the conversation for everyone looking at it, so
   * it goes to every attached window and is journaled for a resume.
   *
   * TAKES NO `sessionId`. The frame carries one, and the implementation fills
   * in the session it was built for — a caller-supplied id would let one
   * session's title be broadcast on another session's lane, which is a leak
   * this seam should not be able to express.
   */
  sessionTitle(title: string, provenance: TitleProvenance): void;
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
    textDelta(turnId, text, replyId) {
      log.debug("turn-emitter.text-delta", {
        turnId,
        replyId: replyId ?? null,
        length: text.length,
        preview: text.slice(0, TEXT_PREVIEW_LEN),
      });
    },
    turnCompleted(turnId) {
      log.info("turn-emitter.turn-completed", { turnId });
    },
    turnAborted(turnId, cutoff) {
      log.info("turn-emitter.turn-aborted", { turnId, cutoff });
    },
    playbackStop(turnId, reason) {
      log.info("turn-emitter.playback-stop", { turnId, reason });
    },
    conversationSnapshot(items) {
      log.info("turn-emitter.conversation-snapshot", { itemCount: items.length });
    },
    conversationEntry(item, turnId, replyId) {
      log.debug("turn-emitter.conversation-entry", {
        entryId: item.entryId,
        kind: item.kind,
        turnId: turnId ?? null,
        replyId: replyId ?? null,
      });
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
    taskList(turnId, items) {
      // Row COUNT and statuses only — `argsPreview` is user content.
      log.debug("turn-emitter.task-list", {
        turnId,
        count: items.length,
        statuses: items.map((i) => i.status),
      });
    },
    sessionTitle(title, provenance) {
      // The title IS user-derived content — length and provenance only.
      log.info("turn-emitter.session-title", { titleChars: title.length, provenance });
    },
  };
}
