import type { ConversationFeedItem, SessionRow } from "@sentient/protocol";
import { createLogger } from "./logger.ts";

const log = createLogger(["sentient", "sdk", "sessions", "rest"]);

const HTTP_NO_CONTENT = 204;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;
// Matches gateway DEFAULT_MESSAGES_LIMIT — returns the most-recent 200 messages (tail).
const DEFAULT_MESSAGES_LIMIT = 200;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class SessionsRestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SessionsRestError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// REST response shapes
// ---------------------------------------------------------------------------

export interface SessionsListResult {
  items: SessionRow[];
  total: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// GET /api/v1/sessions wire shape (gateway/src/api/handlers/sessions.ts) —
// SessionMetadata (gateway/src/store/session-metadata.ts) serialized as JSON.
// Deliberately NOT `SessionRow`: that is this SDK's client-facing row shape,
// carrying fields (rootId, messageCount, isActive) the gateway's session
// metadata table does not track. Mapped below rather than shared across the
// server/client boundary — a gateway-internal type has no business in a
// browser bundle.
// ---------------------------------------------------------------------------

interface SessionMetadataDTO {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  titleProvenance: "generated" | "user" | null;
  version: number;
}

// Matches use-sessions.ts's DEFAULT_NEW_CHAT_TITLE — a session with no title
// yet (nothing has generated or set one) still needs row text to render.
const UNTITLED_SESSION_TITLE = "New chat";

function toSessionRow(dto: SessionMetadataDTO): SessionRow {
  return {
    sessionId: dto.sessionId,
    rootId: dto.sessionId,
    title: dto.title ?? UNTITLED_SESSION_TITLE,
    startedAt: dto.createdAt,
    lastActiveAt: dto.updatedAt,
    // Not tracked by SessionMetadata yet, and unread by every current
    // consumer (session-list.tsx / session-row.tsx key off sessionId, title,
    // lastActiveAt only) — honest placeholders, not a lossy mapping of a
    // value that exists elsewhere.
    messageCount: 0,
    isActive: false,
  };
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface SessionsRest {
  list(opts?: { limit?: number; offset?: number }): Promise<SessionsListResult>;
  search(q: string, limit?: number): Promise<SessionRow[]>;
  getMessages(sessionId: string, opts?: { limit?: number; offset?: number }): Promise<ConversationFeedItem[]>;
  rename(sessionId: string, title: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionsRestConfig {
  /** Base URL for the gateway API, e.g. "https://host/api/v1". No trailing slash. */
  baseUrl: string;
  /** Returns the current auth token. Called on each request so refreshed tokens are used. */
  token: () => string;
  /** Injectable fetch function — defaults to globalThis.fetch. Test seam. */
  fetchFn?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bearerHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function jsonHeaders(extra: Record<string, string>): Record<string, string> {
  return { "content-type": "application/json", ...extra };
}

function errorFromBody(body: unknown, status: number): SessionsRestError {
  if (typeof body === "object" && body !== null && "error" in body) {
    const code = (body as Record<string, unknown>).error;
    if (typeof code === "string") {
      return new SessionsRestError(status, code, `sessions REST error: ${code} (${status})`);
    }
  }
  return new SessionsRestError(status, "unknown-error", `sessions REST error: unknown (${status})`);
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SessionsRestError(response.status, "unknown-error", `sessions REST error: ${response.status}`);
    }
    throw errorFromBody(body, response.status);
  }
  if (response.status === HTTP_NO_CONTENT) {
    return undefined as T;
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new SessionsRestError(response.status, "invalid-json", "sessions REST error: invalid JSON response");
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionsRest(config: SessionsRestConfig): SessionsRest {
  const { baseUrl, token, fetchFn = globalThis.fetch } = config;

  async function doFetch<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch (err: unknown) {
      log.warn("network-error", { url, error: String(err) });
      throw new SessionsRestError(0, "network-error", `sessions REST network error: ${String(err)}`);
    }
    return parseResponse<T>(response);
  }

  return {
    async list(opts = {}) {
      // The gateway does not paginate yet (task 4: it returns the caller's
      // whole list, newest-updated first) — limit/offset still ride along on
      // the URL for forward compatibility (an unknown query param is a no-op
      // server-side) but are not honoured client-side either.
      const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
      const offset = opts.offset ?? 0;
      const url = `${baseUrl}/sessions?limit=${limit}&offset=${offset}`;
      log.debug("list", { limit, offset });
      const result = await doFetch<{ sessions: SessionMetadataDTO[] }>(url, {
        method: "GET",
        headers: bearerHeaders(token()),
      });
      const items = result.sessions.map(toSessionRow);
      // total/hasMore are honest derivations, not server-reported pagination
      // state — there is none yet.
      return { items, total: items.length, hasMore: false };
    },

    async search(q, limit = DEFAULT_SEARCH_LIMIT) {
      const url = `${baseUrl}/sessions/search?q=${encodeURIComponent(q)}&limit=${limit}`;
      log.debug("search", { q, limit });
      const result = await doFetch<{ items: SessionRow[] }>(url, {
        method: "GET",
        headers: bearerHeaders(token()),
      });
      return result.items;
    },

    async getMessages(sessionId, opts = {}) {
      const limit = opts.limit ?? DEFAULT_MESSAGES_LIMIT;
      const offset = opts.offset ?? 0;
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=${offset}`;
      log.debug("getMessages", { sessionId, limit, offset });
      const result = await doFetch<{ items: ConversationFeedItem[] }>(url, {
        method: "GET",
        headers: bearerHeaders(token()),
      });
      return result.items;
    },

    async rename(sessionId, title) {
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}`;
      log.debug("rename", { sessionId });
      await doFetch<void>(url, {
        method: "PATCH",
        headers: jsonHeaders(bearerHeaders(token())),
        body: JSON.stringify({ title }),
      });
    },

    async delete(sessionId) {
      const url = `${baseUrl}/sessions/${encodeURIComponent(sessionId)}`;
      log.debug("delete", { sessionId });
      await doFetch<void>(url, {
        method: "DELETE",
        headers: bearerHeaders(token()),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// URL derivation helper — wss://host/api/v1/ws → https://host/api/v1
// ---------------------------------------------------------------------------

export function deriveRestBaseUrl(gatewayWsUrl: string): string {
  const parsed = new URL(gatewayWsUrl);
  // Swap ws→http / wss→https
  const scheme = parsed.protocol === "wss:" ? "https:" : "http:";
  // Drop query and fragment; strip trailing /ws path segment
  const pathname = parsed.pathname.replace(/\/ws$/, "");
  return `${scheme}//${parsed.host}${pathname}`;
}
