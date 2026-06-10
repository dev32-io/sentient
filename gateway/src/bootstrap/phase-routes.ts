import type { InternalSecretsStore } from "../admin/internal-secrets-store.js";
import type { UserPortStore } from "../admin/user-port-store.js";
import { createSessionManager } from "../auth/session-manager.ts";
import type { SessionManager } from "../auth/session-manager.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { type AcpWireRegistry, createAcpWireRegistry } from "../hermes-adapter-client/acp-wire-registry.js";
import { getLog } from "../logging/logger.ts";
import { createPersonSessionRegistry } from "../person-session/person-session-registry.js";
import type { PersonSessionRegistry } from "../person-session/person-session-registry.js";
import type { ProfileStore } from "../profile-store/profile-store.ts";
import { createSessionControlsRegistry } from "../session-handlers/session-controls-registry.js";
import type { SessionControlsRegistry } from "../session-handlers/session-controls-registry.js";

const log = getLog(["sentient", "bootstrap", "phase-routes"]);

export interface PhaseRoutesInput {
  readonly cfg: StartupConfig;
  readonly internalSecretsStore: InternalSecretsStore;
  readonly profileStore: ProfileStore;
  readonly userPortStore: UserPortStore | null;
}

export interface PhaseRoutesOutput {
  readonly sessionManager: SessionManager;
  readonly personSessions: PersonSessionRegistry;
  readonly acpWireRegistry: AcpWireRegistry;
  readonly sessionControls: SessionControlsRegistry;
}

export function runPhaseRoutes(input: PhaseRoutesInput): PhaseRoutesOutput {
  const { cfg, internalSecretsStore, profileStore, userPortStore } = input;

  const sessionManager = createSessionManager({ maxSessions: cfg.maxSessions });
  const personSessions = buildPersonSessionRegistry(cfg, internalSecretsStore, profileStore, userPortStore);
  // One pooled ACP wire per userId, ref-counted across PersonSession
  // attachments — keeps a second client (webui + mobile) from dialing a
  // second wire, which the overlay would evict the first one for.
  const acpWireRegistry = createAcpWireRegistry();
  const sessionControls = createSessionControlsRegistry();

  log.info("phase-routes-complete");

  return { sessionManager, personSessions, acpWireRegistry, sessionControls };
}

function buildPersonSessionRegistry(
  cfg: StartupConfig,
  secrets: InternalSecretsStore,
  profileStore: ProfileStore,
  userPortStore: UserPortStore | null,
): PersonSessionRegistry {
  if (!cfg.hermes) throw new Error("hermes config is required for person session registry");
  if (!userPortStore) throw new Error("user-port-store is required for person session registry");
  const voiceLoader = async (userId: string): Promise<string | null> => {
    const r = await profileStore.get(userId);
    if (!r.ok) return null;
    return r.value.voice.id;
  };
  return createPersonSessionRegistry({
    hermes: cfg.hermes,
    userPortStore,
    apiKeyResolver: () => secrets.getHermesAuthTokenSync(),
    retentionTtlMs: cfg.session.retention_ttl_ms,
    replayBufferMaxBytes: cfg.session.replay_buffer_max_bytes,
    options: { voiceLoader },
  });
}
