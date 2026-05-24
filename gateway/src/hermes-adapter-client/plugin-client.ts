import { getLog } from "../logging/logger.js";
import type { HermesRawMessage, HermesSearchHit, HermesSessionRow } from "./sessions-client.js";

const log = getLog(["sentient", "hermes-adapter-client", "plugin-client"]);

// ---------------------------------------------------------------------------
// SentientPluginClient — REST client for the per-profile sentient-plugin
// dashboard sidecar (F2). Mounted at:
//   http://<host>:<dashboardPort>/api/plugins/sentient-plugin/
//
// ACP doesn't cover past-sessions search / delete / get / getMessages, so the
// plugin exposes those over plain HTTP backed by Hermes' SessionDB. Auth is
// the shared SENTIENT_HERMES_BEARER (same token as the legacy custom-WS HTTP
// gate); the plugin verifies it before dashboard auth runs.
//
// Field-mapping decisions (verified against
// hermes/plugins/sentient-plugin/dashboard/plugin_api.py):
//   - /search response       — {sessions: [{sessionId, snippet, role, source,
//                                model, sessionStarted}], nextCursor}.
//                              Mapped back to HermesSearchHit (snake_case)
//                              so downstream sessions-handlers code can treat
//                              both wires identically.
//   - /sessions/{id} response — Hermes' _get_session_rich_row dict, already
//                               in HermesSessionRow shape. Pass-through.
//   - /sessions/{id}/messages — {sessionId, messages: [HermesRawMessage]}.
//                               Pass-through messages array.
//   - DELETE /sessions/{id}   — {ok, sessionId} on success, 404 on missing.
// ---------------------------------------------------------------------------

export interface SentientPluginClientConfig {
  /** Base URL ending in /api/plugins/sentient-plugin (no trailing slash). */
  readonly baseUrl: string;
  /** Bearer token shared with the plugin's auth gate (SENTIENT_HERMES_BEARER). */
  readonly token: string;
  /** Per-request timeout in ms. */
  readonly timeoutMs: number;
}

export interface SentientPluginClient {
  search(q: string, limit: number): Promise<HermesSearchHit[]>;
  get(sessionId: string): Promise<HermesSessionRow | null>;
  getMessages(sessionId: string): Promise<HermesRawMessage[]>;
  delete(sessionId: string): Promise<void>;
}

export class SentientPluginHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SentientPluginHttpError";
    this.status = status;
  }
}

interface PluginSearchSession {
  sessionId: string;
  snippet?: string;
  role?: string | null;
  source?: string | null;
  model?: string | null;
  sessionStarted?: number | null;
}

interface PluginSearchResponse {
  sessions?: PluginSearchSession[];
  nextCursor?: string | null;
}

interface PluginGetMessagesResponse {
  sessionId?: string;
  messages?: HermesRawMessage[];
}

const toSearchHit = (s: PluginSearchSession): HermesSearchHit => ({
  session_id: s.sessionId,
  snippet: s.snippet ?? "",
  role: s.role ?? null,
  source: s.source ?? null,
  model: s.model ?? null,
  session_started: s.sessionStarted ?? null,
});

export function createSentientPluginClient(cfg: SentientPluginClientConfig): SentientPluginClient {
  const fetchWithTimeout = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = `${cfg.baseUrl}${path}`;
    const headers = {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${cfg.token}`,
    };
    return fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  };

  const failOnAuth = (status: number, op: string): void => {
    if (status === 401 || status === 403) {
      log.warn(`${op}:auth-failed`, { status, reason: "plugin auth failed" });
      throw new SentientPluginHttpError(status, `plugin auth failed (${op})`);
    }
  };

  return {
    async search(q, limit) {
      const url = `/search?q=${encodeURIComponent(q)}&limit=${limit}`;
      log.debug("search:request", { url, q_len: q.length });
      const res = await fetchWithTimeout(url);
      failOnAuth(res.status, "search");
      if (!res.ok) {
        log.warn("search:non-ok", { status: res.status });
        throw new SentientPluginHttpError(res.status, `GET ${url} -> ${res.status}`);
      }
      const body = (await res.json()) as PluginSearchResponse;
      const hits = (body.sessions ?? []).map(toSearchHit);
      log.info("search:ok", { hits: hits.length });
      return hits;
    },

    async get(sessionId) {
      const url = `/sessions/${encodeURIComponent(sessionId)}`;
      log.debug("get:request", { url, sessionId });
      const res = await fetchWithTimeout(url);
      if (res.status === 404) {
        log.debug("get:not-found", { sessionId });
        return null;
      }
      failOnAuth(res.status, "get");
      if (!res.ok) {
        log.warn("get:non-ok", { status: res.status, sessionId });
        throw new SentientPluginHttpError(res.status, `GET ${url} -> ${res.status}`);
      }
      const row = (await res.json()) as HermesSessionRow;
      log.info("get:ok", { sessionId });
      return row;
    },

    async getMessages(sessionId) {
      const url = `/sessions/${encodeURIComponent(sessionId)}/messages`;
      log.debug("getMessages:request", { url, sessionId });
      const res = await fetchWithTimeout(url);
      failOnAuth(res.status, "getMessages");
      if (!res.ok) {
        log.warn("getMessages:non-ok", { status: res.status, sessionId });
        throw new SentientPluginHttpError(res.status, `GET ${url} -> ${res.status}`);
      }
      const body = (await res.json()) as PluginGetMessagesResponse;
      const msgs = body.messages ?? [];
      log.info("getMessages:ok", { sessionId, count: msgs.length });
      return msgs;
    },

    async delete(sessionId) {
      const url = `/sessions/${encodeURIComponent(sessionId)}`;
      log.debug("delete:request", { url, sessionId });
      const res = await fetchWithTimeout(url, { method: "DELETE" });
      failOnAuth(res.status, "delete");
      if (!res.ok) {
        log.warn("delete:non-ok", { status: res.status, sessionId });
        throw new SentientPluginHttpError(res.status, `DELETE ${url} -> ${res.status}`);
      }
      log.info("delete:ok", { sessionId });
    },
  };
}

// ---------------------------------------------------------------------------
// URL derivation: dashboardPort = acpPort + DASHBOARD_PORT_OFFSET
// ---------------------------------------------------------------------------

const PLUGIN_PATH = "/api/plugins/sentient-plugin";

/**
 * Derive the plugin base URL from the per-profile httpBaseUrl by replacing the
 * port with `port + offset`. Returns null when the input has no port (no-op
 * derivation impossible — caller falls back to the legacy REST path).
 *
 * Example:
 *   buildPluginBaseUrl("http://sentient-hermes:8650", 1000)
 *     -> "http://sentient-hermes:9650/api/plugins/sentient-plugin"
 */
export function buildPluginBaseUrl(httpBaseUrl: string, dashboardPortOffset: number): string | null {
  try {
    const u = new URL(httpBaseUrl);
    const port = u.port === "" ? null : Number.parseInt(u.port, 10);
    if (port === null || !Number.isFinite(port)) {
      log.warn("buildPluginBaseUrl:no-port", { httpBaseUrl });
      return null;
    }
    u.port = String(port + dashboardPortOffset);
    u.pathname = PLUGIN_PATH;
    return u.toString().replace(/\/$/, "");
  } catch (e: unknown) {
    log.warn("buildPluginBaseUrl:invalid-url", {
      httpBaseUrl,
      reason: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
