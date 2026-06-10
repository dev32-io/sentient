import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import { BINARY_TYPE_AUDIO, type FrameSequencer, createFrameSequencer } from "../session-handlers/frame-sequencer.js";
import type { SessionReplayBuffer } from "../session-handlers/session-replay-buffer.js";
import type { PersonSessionAttachment } from "./person-session.js";

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

  const sequencer = createFrameSequencer({
    epoch: init.epoch,
    buffer: init.buffer,
    sendText,
    sendBinary: sendBinaryRaw,
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
  };
}
