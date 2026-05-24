import { getLog } from "../logging/logger.js";
import type { UpdateUserSettingsPatch } from "../mcp-host/tools/update-user-settings.js";

const log = getLog(["sentient", "session-controls-registry"]);

/**
 * Per-session control surface exposed to the MCP host. Each WS session
 * registers its handle on configure; MCP tools (update_user_settings,
 * pause_audio, etc.) look it up by sessionId and invoke directly — no
 * global state, no broadcast, no cross-session hazards.
 *
 * This is a stepping stone toward the SessionInstance refactor: once that
 * lands, the instance itself becomes the registered value and this interface
 * collapses into it.
 */
export interface SessionControls {
  /**
   * Apply a user-settings patch to this session. Persistent fields are
   * written to the profile store; live-applicable fields (channel,
   * ttsEnabled) are pushed into the session's PreferenceManager so the
   * next cycle's gates see them. voice/model do not hot-swap mid-session.
   */
  updateUserSettings(sessionId: string, userId: string, patch: UpdateUserSettingsPatch): Promise<void>;
}

export interface SessionControlsRegistry {
  register(sessionId: string, controls: SessionControls): void;
  unregister(sessionId: string): void;
  get(sessionId: string): SessionControls | null;
}

export function createSessionControlsRegistry(): SessionControlsRegistry {
  const map = new Map<string, SessionControls>();
  return {
    register(sessionId, controls) {
      if (map.has(sessionId)) {
        log.warn("register-replaces-existing", { sessionId });
      }
      map.set(sessionId, controls);
      log.debug("registered", { sessionId, size: map.size });
    },
    unregister(sessionId) {
      const removed = map.delete(sessionId);
      log.debug("unregistered", { sessionId, removed, size: map.size });
    },
    get(sessionId) {
      return map.get(sessionId) ?? null;
    },
  };
}
