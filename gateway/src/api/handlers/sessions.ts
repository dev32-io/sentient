import type { ConversationFeedItem } from "@sentient/protocol";
import { toFeedItem } from "../../cerebrum/conversation-feed.js";
import type { HermesRawMessage } from "../../hermes-adapter-client/sessions-client.js";
import { getLog } from "../../logging/logger.js";
import { hermesMessageToMirrorEntry } from "../../sessions/hermes-message-to-mirror.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";

const log = getLog(["sentient", "api", "sessions"]);

// --- HTTP status constants ---------------------------------------------------

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_INTERNAL = 500;

// --- Pagination constants ----------------------------------------------------

const DEFAULT_SEARCH_LIMIT = 20;
// Returns the most-recent N messages (tail). Slice 4 adds proper cursor pagination.
const DEFAULT_MESSAGES_LIMIT = 200;

// --- Route patterns ----------------------------------------------------------

const SESSION_ID_RE = /^\/api\/v1\/sessions\/([^/]+)$/;
const SESSION_MESSAGES_RE = /^\/api\/v1\/sessions\/([^/]+)\/messages$/;

// --- Dep interface -----------------------------------------------------------

export interface PluginClientLike {
  getMessages(id: string): Promise<unknown[]>;
  search(q: string, limit: number): Promise<unknown[]>;
  get(id: string): Promise<unknown | null>;
  delete(id: string): Promise<void>;
}

export interface TitleStoreLike {
  getTitlesFor(ids: string[]): Promise<Record<string, string>>;
  setTitle(id: string, t: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SessionListItem {
  sessionId: string;
  title: string;
  lastActiveAt: number;
}

export interface SessionsHttpDeps {
  tokens: { validate: (token: string) => Promise<TokenResult<TokenPayload>> };
  resolvePluginClient: (userId: string) => Promise<PluginClientLike>;
  listSessions: (userId: string) => Promise<SessionListItem[]>;
  /** Returns a per-user title store. Implementations must be file-backed /
   *  side-effect-free; a fresh instance per call is correct (no shared
   *  in-memory cache is required). */
  resolveTitleStore: (userId: string) => TitleStoreLike;
}

// --- Handler -----------------------------------------------------------------

export function createSessionsHttpHandler(deps: SessionsHttpDeps): (request: Request) => Promise<Response> {
  return (request) => handleSessions(deps, request);
}

async function handleSessions(deps: SessionsHttpDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Auth gate — all routes require a valid bearer
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token", "Bearer token required");

  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    log.debug("sessions.token-rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error, "Invalid token");
  }

  const userId = valid.value.userId;
  log.debug("sessions.request", { method, path, userId });

  if (path === "/api/v1/sessions" && method === "GET") return handleList(deps, userId);
  if (path === "/api/v1/sessions/search" && method === "GET") return handleSearch(deps, userId, url);

  const messagesMatch = path.match(SESSION_MESSAGES_RE);
  if (messagesMatch?.[1] && method === "GET") return handleGetMessages(deps, userId, messagesMatch[1], url);

  const sessionMatch = path.match(SESSION_ID_RE);
  if (sessionMatch?.[1]) return handleSessionById(deps, userId, sessionMatch[1], method, request);

  return jsonError(HTTP_NOT_FOUND, "not-found", "Route not found");
}

async function handleSessionById(
  deps: SessionsHttpDeps,
  userId: string,
  sessionId: string,
  method: string,
  request: Request,
): Promise<Response> {
  if (method === "PATCH") return handleRename(deps, userId, sessionId, request);
  if (method === "DELETE") return handleDelete(deps, userId, sessionId);
  return new Response("Method Not Allowed", { status: HTTP_METHOD_NOT_ALLOWED });
}

// --- Route handlers ----------------------------------------------------------

async function handleList(deps: SessionsHttpDeps, userId: string): Promise<Response> {
  log.info("sessions.list", { userId });
  try {
    const sessions = await deps.listSessions(userId);
    const ids = sessions.map((s) => s.sessionId);
    const titleOverrides = await deps.resolveTitleStore(userId).getTitlesFor(ids);
    const items = sessions.map((s) => ({
      ...s,
      title: titleOverrides[s.sessionId] ?? s.title,
    }));
    log.debug("sessions.list.ok", { userId, count: items.length });
    return Response.json({ items, total: items.length, hasMore: false }, { status: HTTP_OK });
  } catch (e: unknown) {
    log.warn("sessions.list.error", { userId, reason: errorMessage(e) });
    return jsonError(HTTP_INTERNAL, "list-failed", "Failed to list sessions");
  }
}

async function handleSearch(deps: SessionsHttpDeps, userId: string, url: URL): Promise<Response> {
  const q = url.searchParams.get("q") ?? "";
  const limit = Number.parseInt(url.searchParams.get("limit") ?? String(DEFAULT_SEARCH_LIMIT), 10);
  log.info("sessions.search", { userId, q_len: q.length, limit });
  // HermesSearchHit has no title field, so no titleStore override is applied here (unlike handleList).
  try {
    const client = await deps.resolvePluginClient(userId);
    const items = await client.search(q, Number.isFinite(limit) ? limit : DEFAULT_SEARCH_LIMIT);
    log.debug("sessions.search.ok", { userId, count: items.length });
    return Response.json({ items }, { status: HTTP_OK });
  } catch (e: unknown) {
    log.warn("sessions.search.error", { userId, reason: errorMessage(e) });
    return jsonError(HTTP_INTERNAL, "search-failed", "Failed to search sessions");
  }
}

async function handleGetMessages(
  deps: SessionsHttpDeps,
  userId: string,
  sessionId: string,
  url: URL,
): Promise<Response> {
  const limit = Number.parseInt(url.searchParams.get("limit") ?? String(DEFAULT_MESSAGES_LIMIT), 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  log.info("sessions.getMessages", { userId, sessionId, limit, offset });

  const owned = await checkOwnership(deps, userId, sessionId);
  if (!owned) {
    log.debug("sessions.getMessages.not-owned", { userId, sessionId });
    return jsonError(HTTP_NOT_FOUND, "not-found", "Session not found");
  }

  try {
    const client = await deps.resolvePluginClient(userId);
    const all = await client.getMessages(sessionId);
    const safeLimit = Number.isFinite(limit) ? limit : DEFAULT_MESSAGES_LIMIT;
    const safeOffset = Number.isFinite(offset) ? offset : 0;
    const { items, total } = mapMessagesToFeed(all, safeOffset, safeLimit, sessionId);
    log.debug("sessions.getMessages.ok", { userId, sessionId, total, returned: items.length });
    return Response.json({ items, total, offset: safeOffset, limit: safeLimit }, { status: HTTP_OK });
  } catch (e: unknown) {
    log.warn("sessions.getMessages.error", { userId, sessionId, reason: errorMessage(e) });
    return jsonError(HTTP_INTERNAL, "getMessages-failed", "Failed to fetch messages");
  }
}

async function handleRename(
  deps: SessionsHttpDeps,
  userId: string,
  sessionId: string,
  request: Request,
): Promise<Response> {
  log.info("sessions.rename", { userId, sessionId });

  const owned = await checkOwnership(deps, userId, sessionId);
  if (!owned) {
    log.debug("sessions.rename.not-owned", { userId, sessionId });
    return jsonError(HTTP_NOT_FOUND, "not-found", "Session not found");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(HTTP_BAD_REQUEST, "invalid-json", "Request body must be JSON");
  }

  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).title !== "string") {
    return jsonError(HTTP_BAD_REQUEST, "missing-title", "Body must include { title: string }");
  }

  const title = (body as Record<string, unknown>).title as string;
  try {
    await deps.resolveTitleStore(userId).setTitle(sessionId, title);
    log.info("sessions.rename.ok", { userId, sessionId, title_len: title.length });
    return Response.json({ sessionId, title }, { status: HTTP_OK });
  } catch (e: unknown) {
    log.warn("sessions.rename.error", { userId, sessionId, reason: errorMessage(e) });
    return jsonError(HTTP_INTERNAL, "rename-failed", "Failed to rename session");
  }
}

async function handleDelete(deps: SessionsHttpDeps, userId: string, sessionId: string): Promise<Response> {
  log.info("sessions.delete", { userId, sessionId });

  const owned = await checkOwnership(deps, userId, sessionId);
  if (!owned) {
    log.debug("sessions.delete.not-owned", { userId, sessionId });
    return jsonError(HTTP_NOT_FOUND, "not-found", "Session not found");
  }

  try {
    const client = await deps.resolvePluginClient(userId);
    await client.delete(sessionId);
    await deps.resolveTitleStore(userId).delete(sessionId);
    log.info("sessions.delete.ok", { userId, sessionId });
    return Response.json({ sessionId }, { status: HTTP_OK });
  } catch (e: unknown) {
    log.warn("sessions.delete.error", { userId, sessionId, reason: errorMessage(e) });
    return jsonError(HTTP_INTERNAL, "delete-failed", "Failed to delete session");
  }
}

// --- Ownership enforcement ---------------------------------------------------
// A session belongs to the user when it appears in their ACP-listed session set.
// Returns false if the session is missing from the list (→ 404; don't leak existence).

async function checkOwnership(deps: SessionsHttpDeps, userId: string, sessionId: string): Promise<boolean> {
  try {
    const sessions = await deps.listSessions(userId);
    return sessions.some((s) => s.sessionId === sessionId);
  } catch (e: unknown) {
    log.warn("sessions.ownership-check.error", { userId, sessionId, reason: errorMessage(e) });
    return false;
  }
}

// --- Feed mapper -------------------------------------------------------------

/**
 * Map raw Hermes message rows to ConversationFeedItem[].
 * Non-mappable roles (tool/system) are filtered out — same policy as
 * SwitchFlow.fetchHistory.
 *
 * When no offset is supplied (offset=0), returns the most-recent `limit`
 * messages (the TAIL) so opening a past chat shows recent context rather than
 * the oldest messages. Explicit offset>0 slices from the start (legacy path;
 * Slice 4 adds proper cursor pagination).
 */
function mapMessagesToFeed(
  rows: unknown[],
  offset: number,
  limit: number,
  conversationId: string,
): { items: ConversationFeedItem[]; total: number } {
  const mapped = (rows as HermesRawMessage[])
    .map((m, i) => hermesMessageToMirrorEntry(m, conversationId, i))
    .filter((e) => e !== null)
    .map(toFeedItem);
  if (offset === 0) {
    // Tail slice: return the most-recent `limit` messages in chronological order.
    return { items: mapped.slice(-limit), total: mapped.length };
  }
  return { items: mapped.slice(offset, offset + limit), total: mapped.length };
}

// --- Helpers -----------------------------------------------------------------

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

function jsonError(status: number, code: string, detail: string): Response {
  return Response.json({ error: code, detail }, { status });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
