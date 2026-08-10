import { getLog } from "../logging/logger.js";
import type { UpdateUserSettingsPatch } from "../mcp-host/tools/update-user-settings.js";

const log = getLog(["sentient", "session-controls-registry"]);

/**
 * Per-session control surface exposed to the MCP host. Intended usage: each
 * WS session registers its handle here on configure, and MCP tools
 * (update_user_settings, pause_audio, etc.) look it up by sessionId and
 * invoke directly — no global state, no broadcast, no cross-session hazards.
 *
 * Producer side is currently UNWIRED: the legacy-brain purge stripped
 * ws-session-configure.ts to auth+hold, so nothing calls `register()` today
 * and this registry is permanently empty. `update_user_settings` /
 * `pause_audio` / `resume_audio` therefore always resolve "no session" until
 * Plan 2's `SessionRuntime` registers here (or replaces this registry
 * outright). Not a stub to remove — the interface is the intended shape,
 * just missing its producer.
 */
export interface SessionControls {
  /**
   * Apply a user-settings patch to this session. Persistent fields are
   * written to the profile store; live-applicable fields would be pushed to
   * the session's live runtime so the next turn's gates see them — but see
   * the unwired-producer note above; today nothing consumes this in
   * production. voice/model are not intended to hot-swap mid-session.
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
