import { createSessionManager } from "../auth/session-manager.ts";
import type { SessionManager } from "../auth/session-manager.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import type { PersonSessionRegistry } from "../person-session/person-session-registry.js";
import { createSessionControlsRegistry } from "../session-handlers/session-controls-registry.js";
import type { SessionControlsRegistry } from "../session-handlers/session-controls-registry.js";

const log = getLog(["sentient", "bootstrap", "phase-routes"]);

export interface PhaseRoutesInput {
  readonly cfg: StartupConfig;
  /** Built in phase-services.ts (needs profileStore) and passed through here
   *  unchanged, so WS-handler-facing routes and applyDeps resolve the SAME
   *  PersonSession per userId — see phase-services.ts's
   *  PhaseServicesOutput.personSessions docstring. */
  readonly personSessions: PersonSessionRegistry;
}

export interface PhaseRoutesOutput {
  readonly sessionManager: SessionManager;
  readonly personSessions: PersonSessionRegistry;
  readonly sessionControls: SessionControlsRegistry;
}

export function runPhaseRoutes(input: PhaseRoutesInput): PhaseRoutesOutput {
  const { cfg, personSessions } = input;

  const sessionManager = createSessionManager({
    maxSessions: cfg.maxSessions,
    perUserMaxSessions: cfg.session.per_user_max_sessions,
  });
  const sessionControls = createSessionControlsRegistry();

  log.info("phase-routes-complete");

  return { sessionManager, personSessions, sessionControls };
}
