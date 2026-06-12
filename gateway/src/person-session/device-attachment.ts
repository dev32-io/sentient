import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import { BINARY_TYPE_AUDIO, type FrameSequencer, createFrameSequencer } from "../session-handlers/frame-sequencer.js";
import type { SessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";
import type { ActivityClock } from "../session/activity/activity-clock.js";
import type { DeviceSocketRef, DeviceSocketSink, PersonSessionAttachment } from "./person-session.js";

const log = getLog(["sentient", "device-attachment"]);

/**
 * One DeviceAttachment per WebSocket connection. Each attachment is a
 * window into its parent PersonSession's conversation — same history,
 * same cycle stream, different physical device (web tab, phone, ESP32).
 *
 * All outbound push frames flow through the FrameSequencer so they are
 * seq/epoch-stamped and journaled into the per-device replay buffer
 * before the socket write. A closed/dead socket that throws on write
 * never crashes the cycle — the frame is already buffered.
 */

export interface DeviceAttachmentInit<TData> {
  readonly attachmentId: string;
  readonly ws: ServerWebSocket<TData>;
  readonly sessionId: string;
  /** Profile this attachment is a window into. Logged for tracing. */
  readonly profile: string;
  /** Per-device replay buffer (acquired from PersonSession). */
  readonly buffer: SessionReplayBuffer;
  /** Epoch for the current buffer. Stamped on every JSON frame. */
  readonly epoch: number;
  /**
   * Shared per-device live-socket ref (acquired from PersonSession). This
   * attachment registers its own raw socket writer as `current` on creation,
   * and its sequencer resolves `current` at send time. A stale attachment that
   * is still draining an in-flight cycle after a resumable reconnect therefore
   * writes to whatever socket is currently live, not the dead one it captured.
   */
  readonly liveSocket: DeviceSocketRef;
  /** The device's activity clock (from the buffer entry). Touched "ws.out" on
   *  every outbound frame so the idle sweep sees server→client traffic. */
  readonly clock: ActivityClock;
}

export interface DeviceAttachment<TData = unknown> extends PersonSessionAttachment {
  readonly sessionId: string;
  readonly profile: string;
  /**
   * True iff this attachment should receive TTS audio frames. Flipped at
   * input time by PersonSession ("last-to-speak wins") in B4. Defaults
   * true so single-device sessions behave as today.
   */
  ttsTarget: boolean;
  send(msg: unknown): void;
  sendBinary(data: Uint8Array): void;
  /** Underlying WS, exposed for legacy code paths during migration. */
  readonly ws: ServerWebSocket<TData>;
  /** The frame sequencer — exposed for testing. */
  readonly sequencer: FrameSequencer;
  /**
   * Make THIS attachment's socket the device's current live writer. Deferred
   * (not done at construction) so a resume can flush its replay window FIRST,
   * then go live — otherwise an in-flight cycle frame could outrun the replay
   * and poison the client's resume cursor. Idempotent.
   */
  goLive(): void;
  /**
   * Stop routing the device's live socket writes to THIS attachment's socket.
   * Identity-guarded: only clears the shared ref when it still points at this
   * attachment's writer, so a newer attachment that already took over (the
   * resume handover case) is never clobbered. Called on resumable disconnect
   * (socket dead → frames journal only) and on full teardown.
   */
  releaseSocket(): void;
}

export function createDeviceAttachment<TData>(init: DeviceAttachmentInit<TData>): DeviceAttachment<TData> {
  let ttsTarget = true;

  // Shared warn-once flag for socket write failures. The FIRST failed write
  // (JSON or binary) on this attachment logs at WARN so the disconnect is
  // visible in prod logs. Subsequent failures log at DEBUG to avoid flooding
  // — a disconnect produces one failure per audio frame, which is very high
  // volume and adds no diagnostic value beyond the first.
  let socketWriteFailed = false;

  // sendText / sendBinary wrap ws.send in a try/catch that NEVER throws.
  // The frame is already journaled by the sequencer BEFORE the send —
  // a dead or closed socket must not crash the cycle.
  const sendText = (s: string): void => {
    try {
      init.ws.send(s);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!socketWriteFailed) {
        socketWriteFailed = true;
        log.warn("send.socket-write-failed", { attachmentId: init.attachmentId, reason });
      } else {
        log.debug("send.socket-write-failed", { attachmentId: init.attachmentId, reason });
      }
    }
  };

  const sendBinaryRaw = (b: Uint8Array): void => {
    try {
      init.ws.send(b);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!socketWriteFailed) {
        socketWriteFailed = true;
        log.warn("send.socket-write-failed", { attachmentId: init.attachmentId, reason });
      } else {
        log.debug("send.socket-write-failed", { attachmentId: init.attachmentId, reason });
      }
    }
  };

  // This attachment's raw writer pair. Becomes the device's CURRENT live socket
  // only when goLive() runs, so every sequencer (this one AND any stale one
  // still draining an in-flight cycle) resolves it at send time. On a resume the
  // caller DEFERS goLive() until AFTER the replay window is flushed — otherwise
  // an in-flight frame could reach the new socket with a seq above the replay
  // window and poison the client's resume cursor (dropping the replay).
  const myWriter: DeviceSocketSink = { sendText, sendBinary: sendBinaryRaw };

  // The sequencer journals to the buffer, then writes to whatever socket is
  // CURRENTLY live for the device (resolved per-call), not a captured one. A
  // null ref (device disconnected, or not yet live) still journals — the socket
  // write no-ops.
  const sequencer = createFrameSequencer({
    epoch: init.epoch,
    buffer: init.buffer,
    sendText: (s) => {
      init.clock.touch("ws.out");
      init.liveSocket.current?.sendText(s);
    },
    sendBinary: (b) => {
      init.clock.touch("ws.out");
      init.liveSocket.current?.sendBinary(b);
    },
  });

  log.debug("created", {
    attachmentId: init.attachmentId,
    sessionId: init.sessionId,
    profile: init.profile,
    epoch: init.epoch,
  });

  return {
    attachmentId: init.attachmentId,
    sessionId: init.sessionId,
    profile: init.profile,
    get ttsTarget() {
      return ttsTarget;
    },
    set ttsTarget(v: boolean) {
      ttsTarget = v;
    },
    ws: init.ws,
    sequencer,
    send(msg) {
      sequencer.json(msg as Record<string, unknown>);
    },
    sendBinary(data) {
      sequencer.binary(data, BINARY_TYPE_AUDIO);
    },
    goLive() {
      init.liveSocket.current = myWriter;
      log.debug("goLive", { attachmentId: init.attachmentId, sessionId: init.sessionId });
    },
    releaseSocket() {
      // Identity guard: only relinquish the live ref if it still points at this
      // attachment. After a resume handover a newer attachment has already
      // claimed it — the old attachment's teardown must NOT clobber it.
      if (init.liveSocket.current === myWriter) {
        init.liveSocket.current = null;
        log.debug("releaseSocket", { attachmentId: init.attachmentId, sessionId: init.sessionId });
      }
    },
  };
}
