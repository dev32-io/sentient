import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { PersonSessionAttachment } from "./person-session.js";

const log = getLog(["sentient", "device-attachment"]);

/**
 * One DeviceAttachment per WebSocket connection. Each attachment is a
 * window into its parent PersonSession's conversation — same history,
 * same cycle stream, different physical device (web tab, phone, ESP32).
 *
 * B2 (this commit) gives DeviceAttachment send/sendBinary wrappers +
 * identity. B4 gives it a ttsTarget flag and participates in output
 * fan-out; B6 routes its input through the PersonSession cycle queue.
 */

export interface DeviceAttachmentInit<TData> {
  readonly attachmentId: string;
  readonly ws: ServerWebSocket<TData>;
  readonly sessionId: string;
  /** Profile this attachment is a window into. Logged for tracing. */
  readonly profile: string;
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
}

export function createDeviceAttachment<TData>(init: DeviceAttachmentInit<TData>): DeviceAttachment<TData> {
  let ttsTarget = true;
  log.debug("created", {
    attachmentId: init.attachmentId,
    sessionId: init.sessionId,
    profile: init.profile,
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
    send(msg) {
      init.ws.send(JSON.stringify(msg));
    },
    sendBinary(data) {
      init.ws.send(data);
    },
  };
}
