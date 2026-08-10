// GET /api/v1/sessions and GET /api/v1/sessions/:id/messages (spec §3.5 #3,
// §1; session-model plan task 4) — the REST surface that lets a reload or a
// second window list a user's own sessions and re-open one's full history.
//
// AUTHORIZATION: principal -> capability -> membership, same chain as the WS
// path (spec §3.4). The route NEVER reads a userId from the caller — it
// resolves the principal from the validated bearer token and opens THAT
// principal's own store. A userId in the query string selects nothing; its
// presence is logged and otherwise ignored, because a client sending one is
// either broken or probing.
//
// membership, not shape, decides whether an id 404s: `resolveSession`
// (session-id.ts) looks the presented id up in the caller's own store, which
// was already selected by their capability. That makes "not yours" and "not
// there" the SAME answer for free — another user's real session id can never
// even be compared against, because it lives in a different SQLite file this
// capability was never granted access to. The same membership check refuses a
// draft key (`d_...`): it fails `isWellFormedSessionId` (neither the minted
// `s_` prefix nor the legacy `c::` one), which is the sessionDraftSchema doc's
// MUST-requirement — "the sessions REST surface MUST 404 it" — holding
// structurally rather than by a bolted-on check here.

import type { AccessManager } from "../../access/access-manager.js";
import { type UserPrincipal, createUserPrincipal } from "../../identity/user-principal.js";
import { getLog } from "../../logging/logger.js";
import { snapshotFeedItems } from "../../runtime/conversation-feed.js";
import { withSessionStore } from "../../session-handlers/session-binding.js";
import { resolveSession } from "../../session-handlers/session-id.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";

const log = getLog(["sentient", "api", "sessions"]);

// --- HTTP status constants ---------------------------------------------------

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;

// --- Principal defaults -------------------------------------------------------
// The ROLE comes off the USER RECORD, resolved on this request — never off the
// token, which identifies and nothing more (owner ruling, 2026-08-07). It
// matters here more than anywhere else on the REST surface: this is where a
// `UserPrincipal` is minted, and `AccessManager.grant` bakes that principal's
// role into a `Capability`. A stale claim reaching this line would become a
// frozen authority object, which is the one thing the ruling exists to prevent.
// Same record `ws-auth-gate.ts` reads for that user's WS sessions, so the two
// entry points agree by construction rather than by convention.
// HOUSEHOLDS are still not modelled; that half keeps its placeholder.
const REST_HOUSEHOLD_ID = "home";

const SESSIONS_PATH = "/api/v1/sessions";
const MESSAGES_PATH_RE = /^\/api\/v1\/sessions\/([^/]+)\/messages$/;

export interface SessionsHandlerDeps {
  tokens: { validate: (token: string) => Promise<TokenResult<TokenPayload>> };
  /** Resolves the caller's CURRENT role for the principal minted below. */
  users: Pick<UserStore, "get">;
  accessManager: AccessManager;
  /** `store.db_filename` (config.yaml#store) — threaded into `withSessionStore`
   *  so this REST readback opens the same db the runtime does. */
  dbFileName: string;
}

export function createSessionsHandler(deps: SessionsHandlerDeps): (request: Request) => Promise<Response> {
  return (request) => handleSessions(deps, request);
}

async function handleSessions(deps: SessionsHandlerDeps, request: Request): Promise<Response> {
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");

  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    log.debug("sessions.token-rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error);
  }

  const { pathname, searchParams } = new URL(request.url);

  // BINDING CONSTRAINT: the route never accepts a userId from the request.
  // Log-and-ignore, not honour-then-log — the value below never reaches a
  // capability grant.
  const suppliedUserId = searchParams.get("userId");
  if (suppliedUserId !== null) {
    log.warn("sessions.userId-param-ignored", {
      userId: valid.value.userId,
      suppliedUserId,
      reason: "client supplied a userId in the request; only the authenticated principal selects the store",
    });
  }

  const stored = await deps.users.get(valid.value.userId);
  if (!stored.ok || stored.value === null) {
    // FAIL CLOSED. A token naming a user who is not there identifies nobody,
    // so it is an invalid credential — never a defaulted role.
    log.warn("sessions.no-record", {
      userId: valid.value.userId,
      reason: stored.ok ? "token names a user with no record" : stored.error,
    });
    return jsonError(HTTP_UNAUTHORIZED, "user-not-found");
  }

  let principal: UserPrincipal;
  try {
    principal = createUserPrincipal(valid.value.userId, stored.value.role, REST_HOUSEHOLD_ID);
  } catch {
    // assertUserId throws on a stored/claimed userId that doesn't match the
    // canonical shape. Reject cleanly rather than let the throw escape.
    log.warn("sessions.malformed-user-record", { reason: "token subject fails assertUserId" });
    return jsonError(HTTP_UNAUTHORIZED, "invalid-user-record");
  }

  if (pathname === SESSIONS_PATH) {
    if (request.method !== "GET") return jsonError(HTTP_METHOD_NOT_ALLOWED, "method-not-allowed");
    return handleList(deps, principal);
  }

  const messagesMatch = MESSAGES_PATH_RE.exec(pathname);
  if (messagesMatch) {
    if (request.method !== "GET") return jsonError(HTTP_METHOD_NOT_ALLOWED, "method-not-allowed");
    // A malformed percent-encoding (`%ZZ`) throws in decodeURIComponent —
    // degrade to this route's normal not-found shape rather than an
    // unhandled 500 (mirrors voices.ts's safeDecode).
    const presented = safeDecode(messagesMatch[1] ?? "");
    if (presented === null) return jsonError(HTTP_NOT_FOUND, "not-found");
    return handleMessages(deps, principal, presented);
  }

  return jsonError(HTTP_NOT_FOUND, "not-found");
}

function handleList(deps: SessionsHandlerDeps, principal: UserPrincipal): Response {
  // Already newest-updated-first (session-metadata.ts) — do not re-sort here.
  const sessions = withSessionStore(deps, principal, (store) => store.listSessionsWithMetadata());
  log.info("sessions.list", { userId: principal.userId, count: sessions.length });
  return Response.json({ sessions }, { status: HTTP_OK });
}

function handleMessages(deps: SessionsHandlerDeps, principal: UserPrincipal, presented: string): Response {
  return withSessionStore(deps, principal, (store) => {
    const resolution = resolveSession({ store, presented });
    if ("rejected" in resolution) {
      log.warn("sessions.messages.not-found", { userId: principal.userId, reason: resolution.rejected });
      return jsonError(HTTP_NOT_FOUND, "not-found");
    }
    const entries = store.readSession(resolution.sessionId);
    // The SAME projection the live path emits on conversation.snapshot /
    // conversation.entry — reusing it (not re-deriving the shape here) is
    // what keeps render(replay) == render(live) a structural fact.
    const items = snapshotFeedItems(entries);
    log.info("sessions.messages", { userId: principal.userId, sessionId: resolution.sessionId, count: items.length });
    return Response.json({ items }, { status: HTTP_OK });
  });
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
