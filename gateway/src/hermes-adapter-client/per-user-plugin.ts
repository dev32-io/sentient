import type { HermesConfig } from "@sentient/config";
import { DASHBOARD_PORT_OFFSET } from "../admin/supervisord-control.js";
import type { UserPortStore } from "../admin/user-port-store.js";
import type { SessionListItem } from "../api/handlers/sessions.js";
import { buildHttpBaseUrlForUser, buildWsUrlForUser } from "../bootstrap/hermes-connection-helpers.js";
import { getLog } from "../logging/logger.js";
import { buildPluginBaseUrl, createSentientPluginClient } from "./plugin-client.js";
import type { SentientPluginClient } from "./plugin-client.js";
import { listSessionsViaAcp } from "./sessions-client.js";
import { bootstrapAcpWire } from "./wire-bootstrap.js";
import type { AcpWireBootstrapResult } from "./wire-bootstrap.js";

const log = getLog(["sentient", "hermes-adapter-client", "per-user-plugin"]);

// ---------------------------------------------------------------------------
// Per-user plugin-client + ACP session-list resolver.
//
// Shared by the WS session-configure path (already wires these manually) and
// the REST /api/v1/sessions handler, so both surfaces resolve the plugin URL
// and acquire the ACP wire in one place rather than duplicating the derivation.
//
// Only the REST path calls these helpers directly; the WS path keeps its own
// manual wiring for now because it also needs the ACP wire for cycle dispatch
// (not just for session list). These helpers are therefore additive — they
// don't replace any existing WS code.
// ---------------------------------------------------------------------------

export interface PerUserPluginDeps {
  readonly hermes: HermesConfig | null;
  readonly userPortStore: UserPortStore | null;
  readonly hermesApiKey: () => string;
  readonly timeoutMs: number;
  /** ACP WS open handshake timeout (ms). Sourced from hermes.acp_wire.open_timeout_ms. */
  readonly acpOpenTimeoutMs: number;
  /** Test seam — defaults to bootstrapAcpWire. */
  readonly wireFactory?: (args: {
    wsUrl: string;
    token: string;
    openTimeoutMs: number;
  }) => Promise<AcpWireBootstrapResult>;
}

/**
 * Build a SentientPluginClient for the given userId.
 * Resolves the per-profile HTTP base URL (via hermes + userPortStore),
 * derives the dashboard sidecar URL, and constructs the client.
 *
 * Throws if hermes config / userPortStore are absent or if the user has no
 * port binding — callers should surface this as a 503 / "service unavailable".
 */
export async function resolvePluginClientForUser(
  userId: string,
  deps: PerUserPluginDeps,
): Promise<SentientPluginClient> {
  const httpBaseUrl = await buildHttpBaseUrlForUser(deps.hermes, deps.userPortStore, userId);
  const pluginBaseUrl = buildPluginBaseUrl(httpBaseUrl, DASHBOARD_PORT_OFFSET);
  if (pluginBaseUrl === null) {
    throw new Error(`per-user-plugin: could not derive plugin URL from httpBaseUrl=${httpBaseUrl}`);
  }
  log.debug("resolvePluginClient", { userId, pluginBaseUrl });
  return createSentientPluginClient({
    baseUrl: pluginBaseUrl,
    token: deps.hermesApiKey(),
    timeoutMs: deps.timeoutMs,
  });
}

/**
 * List sessions for a userId via ACP session/list.
 *
 * Dials a DEDICATED ephemeral ACP wire directly — NOT a surface wire and
 * never pooled or shared with one — calls listSessionsViaAcp, then disposes
 * in finally. Every call opens and tears down its own overlay child; there is
 * no reuse across REST-list calls or with live surface wires. Maps
 * SessionRow → SessionListItem (the shape the sessions HTTP handler expects).
 */
export async function listSessionsForUser(userId: string, deps: PerUserPluginDeps): Promise<SessionListItem[]> {
  const wsUrl = await buildWsUrlForUser(deps.hermes, deps.userPortStore, userId);
  const token = deps.hermesApiKey();
  const dial = deps.wireFactory ?? ((args) => bootstrapAcpWire(args));
  // REST list is not a surface — dedicated ephemeral wire, disposed immediately.
  const wire = await dial({ wsUrl, token, openTimeoutMs: deps.acpOpenTimeoutMs });
  try {
    const result = await listSessionsViaAcp(wire.acpConn);
    return result.sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      lastActiveAt: s.lastActiveAt,
    }));
  } finally {
    wire.dispose();
  }
}
