// One allocation, N cursors — and an attach that cannot lose a frame
// (session-model spec §2.1, §7.1, §7.2).
//
// SUCCEEDS `session-windows.ts`, which task 5 had to add so the emitter could
// learn a JOINER's socket, and which deliberately stopped short: each window
// still stamped its own seq from its own `ws.data.journal`, so two windows
// watching one conversation held two seq spaces over the same bytes. This
// module moves the seq into the SESSION's space. A session frame is validated,
// allocated and encoded ONCE; every attached window is written the same string.
// Cursors differ; bytes do not.
//
// WHY THE ATTACH LIVES HERE TOO. The linearization point is a property of the
// DELIVERY set, not of the handshake that triggers it: an attachment is born
// HELD (buffering, delivering nothing) and stays held until its snapshot has
// been sent and its buffer drained. Putting `hold` in this file and `release`
// in another would let the two drift, and the whole invariant is that they are
// one mechanism.
//
// THE LINEARIZATION POINT, precisely. The first spec draft said "send the feed,
// then place the cursor at head"; a frame emitted between those two steps is
// lost SILENTLY. Instead:
//
//   1. `hold(attachmentId)` — synchronously, in the same block as the registry
//      attach. From this instant the window receives nothing and every session
//      frame is buffered for it.
//   2. `{ journal.newestSeq, store projection, turn state }` are captured in
//      ONE synchronous block (`attachWithSnapshot`). No emission can interleave,
//      so a frame at seq ≤ watermark is by construction already reflected in
//      what the joiner is being sent: a committed entry is in the store
//      projection, a transient prerequisite is in the turn-state snapshot.
//   3. `release(attachmentId, watermark)` — drain the buffer, keeping only
//      `seq > watermark`, in order, then go live.
//
// Nothing between the watermark and the cursor is dropped (it is buffered),
// nothing is delivered twice (the watermark filter), and the drain preserves
// order (the buffer is an array).
//
// A DEAD SUBSCRIBER CANNOT SILENCE THE SESSION. A window whose `send` throws is
// dropped from the registry with a WARN, and its peers still receive the frame
// they were mid-fan-out on. One wedged socket must never stop a conversation
// for everyone.
//
// SLOW WINDOWS ARE DISCONNECTED, NOT RE-SNAPSHOTTED — see `maxLagBytes` and
// `gateway/config.yaml`'s `session.max_window_lag_bytes` for the decision and
// its reasoning.

import type { GatewayMessage } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { TurnEmitter } from "../runtime/turn-emitter.js";
import { EMPTY_TURN_STATE, type TurnStateSnapshot, captureTurnStateSnapshot } from "../runtime/turn-state-snapshot.js";
import { AUDIO_FRAME_TYPE, type FrameJournal } from "./frame-journal.js";
import { frameLane } from "./frame-lanes.js";
import type { SessionRegistry } from "./session-registry.js";
import type { SessionData } from "./ws-helpers.js";
import {
  encodeAudioFrame,
  sendAttachReplayFrame,
  sendConnectionFrame,
  validateGatewayFrame,
  writeJournaledBinary,
  writeJournaledText,
} from "./ws-send.js";
import { type SessionFrameSink, createWsTurnEmitter } from "./ws-turn-emitter.js";

const log = getLog(["sentient", "ws", "fan-out"]);

/** Placeholder for a text frame's unused binary half. Allocated once — a
 *  per-frame `new Uint8Array(0)` would run a delta per token. */
const EMPTY_BYTES = new Uint8Array(0);

/** `ServerWebSocket.readyState` OPEN. The other three (CONNECTING, CLOSING,
 *  CLOSED) all mean this window can no longer be served. */
const WS_READY_STATE_OPEN = 1;

/** RFC 6455 1013 "Try Again Later" — what a window disconnected for lag is
 *  told, so both SDKs treat it as retryable and reconnect with their cursor. */
const WS_CLOSE_TRY_AGAIN_LATER = 1013;

/** One buffered frame, held for an attachment that has not been released yet. */
interface HeldFrame {
  readonly seq: number;
  readonly kind: "text" | "binary";
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly frameType: string;
}

interface HeldWindow {
  /** Journal head at the instant the hold began. Log correlation only — the
   *  drain filters on the watermark `release` is given, which is captured
   *  later, atomically with the projection. */
  readonly heldAtSeq: number;
  readonly frames: HeldFrame[];
  bufferedBytes: number;
}

export interface FanOutTurnEmitter extends TurnEmitter {
  /**
   * Start buffering for [attachmentId]. MUST be called synchronously in the
   * same block as `SessionRegistry.attach`, so no frame can be delivered to a
   * window before its snapshot.
   */
  hold(attachmentId: string): void;
  /**
   * Deliver everything buffered for [attachmentId] with `seq > deliveredThrough`
   * and go live. Idempotent; a release for an unknown attachment is a no-op.
   */
  release(attachmentId: string, deliveredThrough: number): void;
  /**
   * Route everything [emit] writes to ONE attachment.
   *
   * EXISTS FOR `conversation.snapshot`, which is an ANSWER to the connection
   * that just attached, not an event in the conversation: both SDKs REPLACE
   * their committed mirror on it, so fanning it out overwrites every peer's
   * mirror with no paired `session.switched` — a peer inside its own resume
   * window then arms the stale-resume timer and drops its stored session id.
   * The frame is connection-lane (frame-lanes.ts) precisely so it CANNOT be
   * broadcast; this names its addressee.
   *
   * SYNCHRONOUS ONLY, and the type says so: [emit] returns void, not a promise,
   * so an `await` inside it cannot silently extend the redirect over another
   * turn's frames.
   */
  directTo(attachmentId: string, emit: () => void): void;
  /** Every attached window's socket, in attach order. Callers that need
   *  per-connection state (the mic echo guard's `SttSession`) read it here
   *  rather than capturing one socket at build time. */
  readonly sockets: readonly ServerWebSocket<SessionData>[];
  readonly size: number;
}

export interface FanOutEmitterDeps {
  /** Where the session's attachments live. Read at WRITE time, so a window
   *  that joined a millisecond ago is already served. */
  readonly registry: SessionRegistry;
  readonly sessionId: string;
  /** This session's journal — one seq space for every window. */
  readonly journal: FrameJournal;
  /** The journal's epoch, stamped on every session frame. */
  readonly epoch: number;
  /** `session.max_window_lag_bytes`. A window whose transport backlog (or
   *  attach buffer) passes this is disconnected. */
  readonly maxLagBytes: number;
}

export function createFanOutTurnEmitter(deps: FanOutEmitterDeps): FanOutTurnEmitter {
  const { registry, sessionId, journal, epoch, maxLagBytes } = deps;

  /** Attachments still buffering. Absent = delivering. */
  const held = new Map<string, HeldWindow>();
  /** Attachments this fan-out has given up on but whose registry detach has not
   *  run yet — see `departWindow`. Delivery skips them from the instant they
   *  are added; the set is emptied by the microtask that does the detaching. */
  const departed = new Set<string>();
  /** Set for the duration of a `directTo` call; see its doc. */
  let directedTo: string | null = null;
  /** Whether the previous broadcast reached anyone. Turns "this session has
   *  gone dark" into ONE warn on the transition instead of one per frame — a
   *  cut-off reply is ~50 audio frames and a delta per token, and the e2e gate
   *  fails on unexpected WARNs. */
  let wasDelivering = true;

  /** A copy: a write that closes a socket must not perturb the iteration that
   *  is still delivering to its peers. */
  function attachments() {
    return registry.subscribers(sessionId);
  }

  /**
   * Stop delivering to [attachmentId] NOW, and detach it from the registry on
   * the next microtask.
   *
   * TWO STEPS, NOT ONE, and the split is the point. `registry.detach` runs the
   * session's disposal policy synchronously, so on the LAST window it disposes
   * the runtime and closes the store handle — inside the `emitter.textDelta()`
   * the ReAct loop is executing at that instant. The loop would then run
   * against a closed `bun:sqlite` handle until it observed the abort. (The
   * object this replaced left a failed write attached, so it never had this
   * shape to get wrong.)
   *
   * Deferring alone is not enough: the window has to stop receiving
   * immediately, or the rest of this fan-out and every frame until the
   * microtask runs keeps writing to a socket already known to be gone. So
   * `departed` gates delivery synchronously and the lifecycle change waits.
   */
  function departWindow(attachmentId: string): void {
    held.delete(attachmentId);
    departed.add(attachmentId);
    queueMicrotask(() => {
      departed.delete(attachmentId);
      registry.detach(sessionId, attachmentId);
    });
  }

  function dropWindow(attachmentId: string, connectionId: string, frameType: string, reason: string): void {
    departWindow(attachmentId);
    log.warn("fan-out.window-dropped", { sessionId, attachmentId, connectionId, frameType, reason });
  }

  /**
   * Close a window that cannot keep up.
   *
   * DISCONNECT, NOT A FORCED RE-SNAPSHOT — the decision recorded in
   * config.yaml. Writing MORE to a socket that cannot drain does not make it
   * drain, and both SDKs already own a tested recovery for a dropped socket:
   * reconnect, present the cursor, take a contiguous replay or a
   * `recovered:false` + fresh snapshot. A bespoke re-snapshot path would be a
   * second recovery mechanism for the same condition, reachable only under
   * load, and therefore the one that is never exercised.
   */
  function disconnectLaggingWindow(attachmentId: string, ws: ServerWebSocket<SessionData>, backlogBytes: number): void {
    log.warn("fan-out.window-lagging", {
      sessionId,
      attachmentId,
      connectionId: ws.data.sessionId,
      backlogBytes,
      maxLagBytes,
      reason: "window backlog passed session.max_window_lag_bytes — closing so it reconnects and re-snapshots",
    });
    departWindow(attachmentId);
    try {
      ws.close(WS_CLOSE_TRY_AGAIN_LATER, "window too far behind");
    } catch (err) {
      log.debug("fan-out.close-failed", {
        sessionId,
        attachmentId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** One WARN when the session stops reaching anyone, one INFO when it starts
   *  again; DEBUG for every frame in between. */
  function noteDelivery(frameType: string, turnId: string | null, delivered: number, windows: number): void {
    if (delivered > 0) {
      if (!wasDelivering) log.info("fan-out.delivering", { sessionId, turnId, frameType, windows });
      wasDelivering = true;
      return;
    }
    if (wasDelivering) {
      log.warn("fan-out.undelivered", {
        sessionId,
        turnId,
        frameType,
        windows,
        reason: "no open window received this frame — every attached socket is closing/closed",
      });
    } else {
      log.debug("fan-out.undelivered", { sessionId, turnId, frameType, windows });
    }
    wasDelivering = false;
  }

  /** Buffer [frame] for a held window, or disconnect it when the buffer alone
   *  passes the lag bound. */
  function bufferFor(attachmentId: string, ws: ServerWebSocket<SessionData>, frame: HeldFrame): void {
    const window = held.get(attachmentId);
    if (window === undefined) return;
    const bytes = frame.kind === "binary" ? frame.bytes.byteLength : frame.text.length;
    if (window.bufferedBytes + bytes > maxLagBytes) {
      disconnectLaggingWindow(attachmentId, ws, window.bufferedBytes + bytes);
      return;
    }
    window.frames.push(frame);
    window.bufferedBytes += bytes;
  }

  /** Deliver one already-allocated frame to every attached window: buffered
   *  while held, written when delivering, skipped when the socket is gone.
   *  @returns how many windows the bytes reached RIGHT NOW. */
  function deliver(frame: HeldFrame, turnId: string | null): number {
    let delivered = 0;
    const windows = attachments();
    for (const attachment of windows) {
      const ws = attachment.ws;
      if (departed.has(attachment.attachmentId)) continue;
      if (held.has(attachment.attachmentId)) {
        bufferFor(attachment.attachmentId, ws, frame);
        continue;
      }
      if (ws.readyState !== WS_READY_STATE_OPEN) {
        log.debug("fan-out.skipped", {
          sessionId,
          attachmentId: attachment.attachmentId,
          frameType: frame.frameType,
          reason: "window socket is closing/closed — its detach has not been processed yet",
        });
        continue;
      }
      if (!writeTo(ws, frame)) {
        dropWindow(attachment.attachmentId, attachment.connectionId, frame.frameType, "socket write threw");
        continue;
      }
      delivered += 1;
      const backlog = ws.getBufferedAmount();
      if (backlog > maxLagBytes) disconnectLaggingWindow(attachment.attachmentId, ws, backlog);
    }
    noteDelivery(frame.frameType, turnId, delivered, windows.length);
    return delivered;
  }

  function writeTo(ws: ServerWebSocket<SessionData>, frame: HeldFrame): boolean {
    if (frame.kind === "binary") return writeJournaledBinary(ws, frame.bytes, frame.seq);
    return writeJournaledText(ws, frame.text, frame.frameType);
  }

  const sink: SessionFrameSink = {
    broadcast(frame: GatewayMessage): number {
      if (frameLane(frame.type) !== "session") {
        log.error("fan-out.lane-violation", {
          sessionId,
          frameType: frame.type,
          reason: "connection-lane frame reached the session fan-out — it must never leave this session's journal",
        });
        return 0;
      }
      // Validate BEFORE allocating: a rejected frame that consumed a seq would
      // tear a permanent hole in the journal, which EVERY cursor then reads as
      // an unfillable gap. Once per frame, not once per window — the bytes are
      // built once too.
      const validated = validateGatewayFrame(sessionId, frame);
      if (validated === null) return 0;
      const allocated = journal.allocateText(frame.type, (seq) => JSON.stringify({ ...validated, seq, epoch }));
      const turnId = (frame as { turnId?: string }).turnId ?? null;
      log.debug("fan-out.sequenced", {
        sessionId,
        turnId,
        frameType: frame.type,
        seq: allocated.seq,
        epoch,
        journalBytes: journal.byteLength,
      });
      return deliver(
        { seq: allocated.seq, kind: "text", text: allocated.text, bytes: EMPTY_BYTES, frameType: frame.type },
        turnId,
      );
    },

    broadcastAudio(payload: Uint8Array): void {
      const allocated = journal.allocateBinary((seq) => encodeAudioFrame(seq, payload));
      deliver(
        { seq: allocated.seq, kind: "binary", text: "", bytes: allocated.bytes, frameType: AUDIO_FRAME_TYPE },
        null,
      );
    },

    directed(frame: GatewayMessage): number {
      if (directedTo === null) {
        log.error("fan-out.undirected", {
          sessionId,
          frameType: frame.type,
          reason: "connection-lane frame emitted with no addressee — it would reach nobody, or everybody",
        });
        return 0;
      }
      const attachment = attachments().find((a) => a.attachmentId === directedTo);
      if (attachment === undefined) return 0;
      return sendConnectionFrame(attachment.ws, frame) ? 1 : 0;
    },

    get size() {
      return attachments().length;
    },
  };

  const emitter = createWsTurnEmitter(sink, sessionId);

  return {
    ...emitter,

    hold(attachmentId: string): void {
      held.set(attachmentId, { heldAtSeq: journal.newestSeq, frames: [], bufferedBytes: 0 });
      log.debug("fan-out.held", { sessionId, attachmentId, heldAtSeq: journal.newestSeq });
    },

    release(attachmentId: string, deliveredThrough: number): void {
      const window = held.get(attachmentId);
      if (window === undefined) return;
      // Deleted BEFORE the drain, so a frame emitted re-entrantly by one of
      // these writes takes the live path rather than landing behind them.
      held.delete(attachmentId);
      const attachment = attachments().find((a) => a.attachmentId === attachmentId);
      if (attachment === undefined) return;

      let drained = 0;
      let skipped = 0;
      for (const frame of window.frames) {
        if (frame.seq <= deliveredThrough) {
          skipped += 1;
          continue;
        }
        if (!writeTo(attachment.ws, frame)) {
          dropWindow(attachmentId, attachment.connectionId, frame.frameType, "socket write threw during attach drain");
          return;
        }
        drained += 1;
      }
      log.info("fan-out.released", {
        sessionId,
        attachmentId,
        connectionId: attachment.connectionId,
        heldAtSeq: window.heldAtSeq,
        deliveredThrough,
        drained,
        // Frames already reflected in the snapshot this window was just sent.
        skipped,
      });
    },

    directTo(attachmentId: string, emit: () => void): void {
      directedTo = attachmentId;
      try {
        emit();
      } finally {
        directedTo = null;
      }
    },

    get sockets() {
      return attachments().map((a) => a.ws);
    },

    get size() {
      return attachments().length;
    },
  };
}

/**
 * Where a joining window's COMMITTED history comes from. The turn-state
 * reconstruction is not optional and is not affected by this choice — a window
 * that lands mid-turn needs the transient prerequisites either way, and no REST
 * route carries them.
 */
export type CommittedFeedSource =
  /** `conversation.snapshot`, directed at this window (the handshake, a late
   *  bind, a replayed mint — the client's mirror is empty and this fills it). */
  | "snapshot"
  /** The client refetches `GET /sessions/:id/messages` itself, which is what
   *  `session.switched` tells it to do — so sending a snapshot as well would be
   *  a second, racing source of truth for the same mirror
   *  (ws-conversation-activate.ts). */
  | "client-refetch";

/**
 * Give a joining window everything it needs to render coherently, and let it
 * start receiving.
 *
 * The window must already be attached (`SessionRegistry.attach`) and HELD
 * (`FanOutTurnEmitter.hold`), both done synchronously by `bindSessionRuntime`.
 * This is the second half: publish the committed feed, reconstruct the
 * in-flight turn, then drain everything that arrived while it was held.
 *
 * SYNCHRONOUS, AND THE SIGNATURE IS THE ENFORCEMENT. The plan sketched this as
 * `async`, which reads naturally and is exactly the shape that breaks the
 * linearization point: an `await` anywhere between the watermark read and the
 * projection lets a frame land in NEITHER the snapshot nor the drain. There is
 * nothing to await — the store read, the projection and the turn-state capture
 * are all synchronous — so the function is not a promise, and a future
 * contributor who needs one has to re-derive the watermark discipline
 * deliberately rather than by adding a keyword.
 *
 * @returns the turn state the joiner was given. Empty when no runtime is
 *          resident — by definition there is no in-flight turn to describe.
 */
export function attachWithSnapshot(
  registry: SessionRegistry,
  sessionId: string,
  ws: ServerWebSocket<SessionData>,
  committedFeed: CommittedFeedSource = "snapshot",
): TurnStateSnapshot {
  const attachment = ws.data.attachment;
  const handles = registry.handlesFor(sessionId);
  if (attachment === null || handles === null) {
    log.warn("fan-out.attach.no-session", {
      sessionId,
      connectionId: ws.data.sessionId,
      reason: "attach snapshot requested for a connection that is not attached to a resident session",
    });
    return EMPTY_TURN_STATE;
  }

  // ── The atomic capture. Nothing below may await until `watermark`, the
  // ── projection and the turn state have all been read: an emission
  // ── interleaving here is a frame that is in neither the snapshot nor the
  // ── drain, which is precisely the silent loss this design exists to prevent.
  const watermark = handles.journal.newestSeq;
  if (committedFeed === "snapshot") {
    handles.fanOut.directTo(attachment.attachmentId, () => handles.runtime.emitConversationSnapshot());
  }
  const turnState = captureTurnStateSnapshot(handles.runtime);
  // ── End of the atomic block.

  emitTurnStateTo(ws, sessionId, attachment.attachmentId, turnState);
  handles.fanOut.release(attachment.attachmentId, watermark);
  log.info("fan-out.attached", {
    sessionId,
    connectionId: ws.data.sessionId,
    attachmentId: attachment.attachmentId,
    turnId: turnState.activeTurnId,
    committedFeed,
    watermark,
    windows: handles.fanOut.size,
  });
  return turnState;
}

/**
 * Rebuild the transient prerequisites a joining window is missing, on ONE
 * socket.
 *
 * Order is `turn.started` → running tool tiles → the accumulated text → the
 * audio bracket → open prompts. The exact live INTERLEAVING of text and tiles
 * is not recoverable from the tracker and is deliberately not reconstructed:
 * the committed projection carries the settled order, and the live bubble is
 * transient — the two converge the moment this turn commits (spec §7.2).
 *
 * THE AUDIO BRACKET IS EMITTED INDEPENDENTLY OF THE TURN, because speech
 * outlives its turn and this is the seam where that stops being an abstract
 * claim. `session-runtime.ts` emits `turnCompleted` as soon as the loop
 * settles, while turn-voice.ts's detached drain is still yielding frames — so
 * "no active turn, audio still playing" is a window seconds wide on every
 * spoken reply, not an edge case. `createTurnStateTracker` deliberately RETAINS
 * `audio` past `endTurn` for exactly this; an early return here would have made
 * that retention an invariant with no consumer, and the joiner would take the
 * remaining binary frames with no bracket to hang them on — which the web
 * connector SILENTLY DROPS (`if (!this.isReceiving) return`), followed by a
 * `turn.audio.done` for a stream it never opened.
 */
function emitTurnStateTo(
  ws: ServerWebSocket<SessionData>,
  sessionId: string,
  attachmentId: string,
  state: TurnStateSnapshot,
): void {
  const turnId = state.activeTurnId;
  if (turnId !== null && state.trigger !== null) {
    sendAttachReplayFrame(ws, { type: "turn.started", turnId, trigger: state.trigger });
    for (const tool of state.tools) {
      sendAttachReplayFrame(ws, {
        type: "turn.tool.update",
        turnId,
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        status: tool.status,
        ...(tool.taskId === undefined ? {} : { taskId: tool.taskId }),
        argsPreview: tool.argsPreview ?? "",
        startedAtMs: Date.now(),
      });
    }
    if (state.textSoFar.length > 0) {
      sendAttachReplayFrame(ws, { type: "turn.text.delta", turnId, text: state.textSoFar });
    }
  }
  if (state.audio !== null) {
    // The BRACKET, never the bytes: binary frames carry no turnId, so the
    // client attributes them to the most recent `turn.audio.start`. Without
    // this the joiner drops the rest of the utterance on the floor.
    sendAttachReplayFrame(ws, {
      type: "turn.audio.start",
      turnId: state.audio.turnId,
      encoding: state.audio.encoding,
      sampleRate: state.audio.sampleRate,
    });
    noteAudioSkip(sessionId, attachmentId, state.audio.turnId);
  }
  for (const prompt of state.prompts) {
    sendAttachReplayFrame(ws, { type: "permission.request", ...prompt });
  }
  if (turnId === null && state.audio === null && state.prompts.length === 0) return;
  log.info("fan-out.turn-state-sent", {
    sessionId,
    attachmentId,
    turnId,
    trigger: state.trigger,
    textLength: state.textSoFar.length,
    runningTools: state.tools.length,
    openPrompts: state.prompts.length,
    audioTurnId: state.audio?.turnId ?? null,
  });
}

/** The one line that makes "a joiner does not re-hear what the room already
 *  heard" visible in a log rather than inferred from silence. */
function noteAudioSkip(sessionId: string, attachmentId: string, turnId: string): void {
  log.info("fan-out.audio-skipped", {
    sessionId,
    attachmentId,
    turnId,
    "audio.skip-reason": "midturn-join",
  });
}
