import type { InternalSecretsStore } from "../admin/internal-secrets-store.js";
import type { UserPortStore } from "../admin/user-port-store.js";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.js";
import { createPersonSessionRegistry } from "../person-session/person-session-registry.js";
import type { PersonSessionRegistry } from "../person-session/person-session-registry.js";
import type { ProfileStore } from "../profile-store/profile-store.ts";

const log = getLog(["sentient", "bootstrap", "build-person-session-registry"]);

/**
 * Build the single, process-wide PersonSessionRegistry. Called once from
 * phase-services.ts (needs the freshly-built profileStore for the voice
 * loader) and threaded through unchanged to phase-routes.ts / applyDeps —
 * see phase-services.ts's PhaseServicesOutput.personSessions docstring for
 * why this MUST be one shared instance, not one per consumer.
 */
export function buildPersonSessionRegistry(
  cfg: StartupConfig,
  secrets: InternalSecretsStore,
  profileStore: ProfileStore,
  userPortStore: UserPortStore | null,
): PersonSessionRegistry {
  if (!cfg.hermes) {
    log.error("buildPersonSessionRegistry.missing-hermes-config");
    throw new Error("hermes config is required for person session registry");
  }
  if (!userPortStore) {
    log.error("buildPersonSessionRegistry.missing-user-port-store");
    throw new Error("user-port-store is required for person session registry");
  }
  const voiceLoader = async (userId: string): Promise<string | null> => {
    const r = await profileStore.get(userId);
    if (!r.ok) return null;
    return r.value.voice.id;
  };
  return createPersonSessionRegistry({
    hermes: cfg.hermes,
    userPortStore,
    apiKeyResolver: () => secrets.getHermesAuthTokenSync(),
    idleTimeoutMs: cfg.session.idle_timeout_ms,
    options: { voiceLoader },
  });
}
