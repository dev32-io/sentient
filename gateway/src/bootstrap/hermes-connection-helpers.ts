import type { HermesConfig } from "@sentient/config";
import type { UserPortStore } from "../admin/user-port-store.js";
import { renderWorkerUrl } from "../session-router.js";

// ---------------------------------------------------------------------------
// WS / HTTP URL resolution helpers
// ---------------------------------------------------------------------------
// Used by ws-session-configure to derive per-profile WS + HTTP base URLs at
// session bootstrap. The ACP wire dials these on demand — there is no
// long-lived gateway-owned connection pool.
// ---------------------------------------------------------------------------

export async function buildWsUrlForUser(
  hermes: HermesConfig | null,
  userPortStore: UserPortStore | null,
  userId: string,
): Promise<string> {
  if (!hermes || !userPortStore) {
    throw new Error("buildWsUrlForUser: hermes config + userPortStore required");
  }
  const port = await userPortStore.resolvePort(userId);
  if (port === null) throw new Error(`buildWsUrlForUser: no port binding for ${userId}`);
  const base = renderWorkerUrl(hermes.worker.url_template, port);
  const ws = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${ws.replace(/\/$/, "")}/ws`;
}

/** HTTP base URL (no trailing slash) of a per-profile Hermes web_server. */
export async function buildHttpBaseUrlForUser(
  hermes: HermesConfig | null,
  userPortStore: UserPortStore | null,
  userId: string,
): Promise<string> {
  if (!hermes || !userPortStore) {
    throw new Error("buildHttpBaseUrlForUser: hermes config + userPortStore required");
  }
  const port = await userPortStore.resolvePort(userId);
  if (port === null) throw new Error(`buildHttpBaseUrlForUser: no port binding for ${userId}`);
  const base = renderWorkerUrl(hermes.worker.url_template, port);
  return base.replace(/\/$/, "");
}
