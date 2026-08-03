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

const log = getLog(["sentient", "ws", "turn-emitter"]);

const TEXT_PREVIEW_LEN = 120;

/**
 * Where a built frame goes. Declared HERE, by the consumer, so this module owns
 * no edge to the fan-out that implements it — construction and delivery are two
 * responsibilities and only one of them is allowed to know about sockets.
 */
export interface SessionFrameSink {
  /** Allocate one seq from the SESSION journal for a session-lane frame and
   *  write its bytes to every delivering window.
   *  @returns how many windows received it. */
  broadcast(frame: GatewayMessage): number;
  /** Allocate one seq for an audio payload and write the same framed bytes to
   *  every delivering window. */
  broadcastAudio(payload: Uint8Array): void;
  /** Write a CONNECTION-lane frame to the one attachment the enclosing
   *  `directTo` names. @returns 1 when it landed, 0 otherwise. */
  directed(frame: GatewayMessage): number;
  /** Attached windows, delivering or held. */
  readonly size: number;
}

/**
 * [sink] is the session's delivery seam, not one socket: the runtime it serves
 * outlives any single connection, so a captured socket would strand every frame
 * the moment that window closed. [sessionId] is the DURABLE session id — spec
 * §7.3 requires every session-lane line to carry it alongside `turnId`, because
 * with N windows `turnId` alone no longer identifies who is watching.
 */
export function createWsTurnEmitter(sink: SessionFrameSink, sessionId: string): TurnEmitter {
  // Frames emitted this session — LOG ONLY. The wire seq is allocated ONCE per
  // frame from the session journal inside the sink (fan-out-emitter.ts), so
  // JSON and binary share one monotonic space per SESSION and every cursor
  // reads the same bytes.
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

  /** @returns how many windows the frame actually reached. */
  function emit(frame: GatewayMessage): number {
    return sink.broadcast(frame);
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
      //
      // DIRECTED, NOT BROADCAST, and the lane table enforces it: this frame
      // REPLACES a client's committed mirror, so it must reach exactly the
      // connection that attached. It is CONNECTION-lane (frame-lanes.ts), so
      // `sink.broadcast` would refuse it outright; `sink.directed` requires an
      // addressee. `delivered=1` with `windows=2` is the directed emission
      // working; `delivered=0` means the snapshot was emitted with nobody named.
      const delivered = sink.directed({ type: "conversation.snapshot", items });
      log.info("turn-emitter.conversation-snapshot", {
        sessionId,
        itemCount: items.length,
        windows: sink.size,
        delivered,
      });
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
      sink.broadcastAudio(bytes);
      audioFramesSent += 1;
      log.debug("turn-emitter.audio-frame", {
        sessionId,
        turnId,
        windows: sink.size,
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
