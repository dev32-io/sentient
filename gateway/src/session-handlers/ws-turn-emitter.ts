// WsTurnEmitter (spec §7) — the REAL `TurnEmitter`, writing the 2.0 wire
// contract to a client socket. `turn-emitter.ts` ships the headless
// `createLoggingTurnEmitter`; this is the implementation that reaches a client.
//
// Every method maps 1:1 onto exactly one frame in
// shared/protocol/src/messages.ts and is constructed as a typed
// `GatewayMessage`, then validated by `sendGatewayFrame` before any bytes leave
// (see ws-send.ts for the drop-never-throw policy). Nothing here hand-builds an
// object literal or calls `ws.send` directly.
//
// Two Plan-2 behaviours are deliberately GONE:
//   - `toolUpdate` and `turnAborted` are no longer log-only. They emit
//     `turn.tool.update` and `turn.aborted`; without them the client could
//     never render a tool tile and could never learn a turn was cut off (its
//     stream would simply stall).
//   - `turn.text.delta` now carries `turnId`. Plan 2's `response.text.delta`
//     omitted it, which made §7.2's back-to-back follow-up turns impossible to
//     route to the correct bubble.
//
// A cut-off turn emits BOTH `turn.aborted` (the feed marker, carrying the
// cutoff kind) and `playback.stop` (the audio-flush command) — but through
// TWO emitter methods, not one. They drive separate client subsystems AND
// have separate lifetimes: speech outlives its turn, so a cancel landing
// while the audio still drains must be able to flush playback for a turn that
// is no longer abortable (see runtime/cancellation.ts). `playback.stop` is
// the ONLY frame that may flush the client's audio queue — a new turnId must
// never do so (spec §4.6/§7.2, Global Constraint 5).
//
// `conversation.snapshot` / `conversation.entry` are the COMMITTED feed: the
// store projected through `projectForClient` (store/client-projection.ts) by
// runtime/conversation-feed.ts. Everything on the `turn.*` family is a live,
// disposable stream — without these two the client's assistant bubble
// vanishes the moment `turn.completed` lands, and the user's own message
// never renders at all.

import type { ConversationFeedItem, GatewayMessage, TurnAudioEncoding, TurnTrigger } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ToolUpdate } from "../runtime/react-loop.js";
import type {
  DelegationProgress,
  PermissionRequest,
  PermissionResolution,
  TurnEmitter,
} from "../runtime/turn-emitter.js";
import type { CutoffKind } from "../store/entry-types.js";
import type { SessionWindows } from "./session-windows.js";

const log = getLog(["sentient", "ws", "turn-emitter"]);

const TEXT_PREVIEW_LEN = 120;

/**
 * [windows] is the session's delivery set, not one socket (session-model plan
 * task 5): the runtime it serves outlives any single connection, so a captured
 * socket would strand every frame the moment that window closed. [sessionId] is
 * the DURABLE session id, which is what a session-lane log line must carry now
 * that these frames belong to a session rather than a connection.
 */
export function createWsTurnEmitter(windows: SessionWindows, sessionId: string): TurnEmitter {
  // Frames emitted this session — LOG ONLY. The wire seq comes from each
  // window's own `ws.data.journal` inside `sendAudioFrame` (ws-send.ts) so
  // JSON and binary share one monotonic space per connection, which is what
  // both client resume cursors assume. Task 6 moves that seq into the
  // SESSION's space.
  let audioFramesSent = 0;

  // A tool call's start time, stamped on its FIRST update and read back by the
  // terminal one so `endedAtMs - startedAtMs` is a real duration. Without this
  // both fields get the same `Date.now()` and every tile renders 0ms — each
  // frame is individually schema-valid, so nothing else catches it.
  //
  // An entry is dropped on its call's terminal status. A BACKGROUND call never
  // reaches one through this callback (its completion arrives as
  // `delegation.progress`), so `endTurn` also clears the whole map — this
  // emitter lives for the WHOLE SESSION, not one turn, so without that sweep
  // every delegated call would leak an entry for the life of the session.
  // Safe because a SessionRuntime runs at most one turn at a time, so no live
  // call's stamp can still be needed once the turn has settled.
  const toolStartedAtMs = new Map<string, number>();

  function endTurn(): void {
    toolStartedAtMs.clear();
  }

  function emit(frame: GatewayMessage): void {
    windows.broadcast(frame);
  }

  return {
    turnStarted(turnId: string, trigger: TurnTrigger) {
      log.info("turn-emitter.turn-started", { sessionId, turnId, trigger });
      emit({ type: "turn.started", turnId, trigger });
    },

    textDelta(turnId: string, text: string) {
      log.debug("turn-emitter.text-delta", {
        sessionId,
        turnId,
        length: text.length,
        preview: text.slice(0, TEXT_PREVIEW_LEN),
      });
      emit({ type: "turn.text.delta", turnId, text });
    },

    toolUpdate(turnId: string, u: ToolUpdate) {
      const now = Date.now();
      const startedAtMs = toolStartedAtMs.get(u.toolCallId) ?? now;
      if (!toolStartedAtMs.has(u.toolCallId)) toolStartedAtMs.set(u.toolCallId, now);
      const isTerminal = u.status !== "running";
      if (isTerminal) toolStartedAtMs.delete(u.toolCallId);

      log.debug("turn-emitter.tool-update", {
        sessionId,
        turnId,
        toolCallId: u.toolCallId,
        toolName: u.toolName,
        status: u.status,
        taskId: u.taskId,
        elapsedMs: now - startedAtMs,
      });

      emit({
        type: "turn.tool.update",
        turnId,
        toolCallId: u.toolCallId,
        toolName: u.toolName,
        status: u.status,
        // `taskId` is present only on a background dispatch's "running"
        // update; omit the key entirely rather than sending undefined.
        ...(u.taskId === undefined ? {} : { taskId: u.taskId }),
        // Already truncated upstream by react-loop.ts; "" when the loop had no
        // argument data to preview.
        argsPreview: u.argsPreview ?? "",
        startedAtMs,
        ...(isTerminal ? { endedAtMs: now } : {}),
      });
    },

    turnCompleted(turnId: string) {
      endTurn();
      log.info("turn-emitter.turn-completed", { sessionId, turnId });
      emit({ type: "turn.completed", turnId });
    },

    turnAborted(turnId: string, cutoff: CutoffKind) {
      endTurn();
      log.info("turn-emitter.turn-aborted", { sessionId, turnId, cutoff });
      emit({ type: "turn.aborted", turnId, cutoff });
    },

    playbackStop(turnId: string, reason: CutoffKind) {
      log.info("turn-emitter.playback-stop", { sessionId, turnId, reason });
      emit({ type: "playback.stop", turnId, reason });
    },

    conversationSnapshot(items: ConversationFeedItem[]) {
      // Item CONTENT is chat content — never logged. Count only.
      log.info("turn-emitter.conversation-snapshot", { sessionId, itemCount: items.length });
      emit({ type: "conversation.snapshot", items });
    },

    conversationEntry(item: ConversationFeedItem, turnId?: string) {
      log.debug("turn-emitter.conversation-entry", {
        sessionId,
        entryId: item.entryId,
        kind: item.kind,
        turnId: turnId ?? null,
      });
      // Omit the key entirely rather than sending an explicit undefined.
      emit({ type: "conversation.entry", item, ...(turnId === undefined ? {} : { turnId }) });
    },

    audioStart(turnId: string, encoding: TurnAudioEncoding, sampleRate: number) {
      log.info("turn-emitter.audio-start", { sessionId, turnId, encoding, sampleRate });
      emit({ type: "turn.audio.start", turnId, encoding, sampleRate });
    },

    audioFrame(turnId: string, bytes: Uint8Array) {
      // One seq PER WINDOW — each connection stamps from its own journal, so
      // there are as many as there are open windows (task 6 collapses them
      // into the session's single seq space).
      const seqs = windows.broadcastAudio(bytes);
      audioFramesSent += 1;
      log.debug("turn-emitter.audio-frame", {
        sessionId,
        turnId,
        seqs,
        payloadBytes: bytes.byteLength,
      });
    },

    audioDone(turnId: string) {
      log.info("turn-emitter.audio-done", { sessionId, turnId, framesSent: audioFramesSent });
      emit({ type: "turn.audio.done", turnId });
    },

    permissionRequest(req: PermissionRequest) {
      // Argument VALUES go on the wire (the user must approve what will really
      // happen) but never into the log — only which keys were mediated.
      log.info("turn-emitter.permission-request", {
        sessionId,
        requestId: req.requestId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        argKeys: Object.keys(req.args),
        expiresAtMs: req.expiresAtMs,
      });
      emit({ type: "permission.request", ...req });
    },

    permissionResolved(res: PermissionResolution) {
      log.info("turn-emitter.permission-resolved", {
        sessionId,
        requestId: res.requestId,
        outcome: res.outcome,
      });
      emit({ type: "permission.resolved", ...res });
    },

    delegationProgress(p: DelegationProgress) {
      log.info("turn-emitter.delegation-progress", {
        sessionId,
        taskId: p.taskId,
        turnId: p.turnId,
        agent: p.agent,
        status: p.status,
      });
      emit({ type: "delegation.progress", ...p });
    },
  };
}
