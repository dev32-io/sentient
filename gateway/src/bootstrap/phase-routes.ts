import { createSessionManager } from "../auth/session-manager.ts";
import type { SessionManager } from "../auth/session-manager.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { type AcpWireRegistry, createAcpWireRegistry } from "../hermes-adapter-client/acp-wire-registry.js";
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
  readonly acpWireRegistry: AcpWireRegistry;
  readonly sessionControls: SessionControlsRegistry;
}

export function runPhaseRoutes(input: PhaseRoutesInput): PhaseRoutesOutput {
  const { cfg, personSessions } = input;

  const sessionManager = createSessionManager({
    maxSessions: cfg.maxSessions,
    perUserMaxSessions: cfg.session.per_user_max_sessions,
  });
  // One pooled ACP wire per SURFACE (chat tab / app instance), ref-counted
  // across that surface's transport reconnects — each surface gets its own
  // isolated Hermes child, so concurrent cycles on different surfaces can't
  // cross-wire (the fork root cause). Reconnect reuses the warm child.
  const acpWireRegistry = createAcpWireRegistry();
  const sessionControls = createSessionControlsRegistry();

  log.info("phase-routes-complete");

  return { sessionManager, personSessions, acpWireRegistry, sessionControls };
}
