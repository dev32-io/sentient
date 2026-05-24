import { getLog } from "../logging/logger.js";

export interface SessionAudioWire {
  /**
   * Send playback.stop wire message. Carries the cancelled task ids so the
   * client can mark the correct assistant entry with the cutoff reason.
   */
  sendPlaybackStop(cycleId: string, reason: "barge-in" | "interrupt", cancelledTaskIds: readonly string[]): void;
}

export interface SessionAudioWireDeps {
  readonly wsSend: (msg: unknown) => void;
}

/**
 * The only component that writes audio-related wire messages. Components
 * that want to emit audio/playback.stop go through this; they do NOT hold
 * a direct reference to the WebSocket send.
 */
export function createSessionAudioWire(deps: SessionAudioWireDeps): SessionAudioWire {
  const log = getLog(["sentient", "session-handlers", "audio-wire"]);
  return {
    sendPlaybackStop(cycleId, reason, cancelledTaskIds) {
      log.info("send-playback-stop", { cycleId, reason, cancelledTaskIds });
      deps.wsSend({ type: "playback.stop", cycleId, reason, cancelledTaskIds });
    },
  };
}
