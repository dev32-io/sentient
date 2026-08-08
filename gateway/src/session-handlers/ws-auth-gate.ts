// The auth gate's two frames — `auth.ok` and `auth.error` — are the only ones
// a client sees before `session.configure`, and the whole session depends on
// them. They used to be hand-serialized object literals passed straight to
// `ws.send`, which is exactly the bypass the branch's "every outbound frame is
// constructed and validated through `gatewayMessageSchema`" constraint forbids;
// the schema's `auth.ok` had drifted to a `{ sessionId, role }` stub nothing
// sent and nothing read, and `auth.error` was not in the union at all.
// Both now go out through `sendConnectionFrame` (ws-send.ts) like every other
// frame. They are UNSEQUENCED and unjournaled — not incidentally, as they were
// when that fell out of `ws.data.journal` still being null, but because the
// lane table says so (frame-lanes.ts): an auth result belongs to ONE socket and
// must never reach another window or enter a session's replay window.
//
// SIGNATURE: the socket is typed `ServerWebSocket<SessionData>` rather than the
// narrow local `WsLike` this file used to declare. `sendConnectionFrame` reads
// `ws.data.sessionId` and writes through `ws.send`, so a three-member
// structural stand-in is not assignable to it; duplicating a second socket type
// to work around that would just re-create the drift this commit is removing.
// Callers already hold the real Bun socket; the tests pass a cast fake, which
// is the normal cost of typing on the real transport.

import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { SessionManager } from "../auth/session-manager.js";
import { type UserPrincipal, createUserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { AuthService } from "../user-auth/auth-service.js";
import type { SessionData } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "gateway", "session-handlers", "ws-auth-gate"]);

const WS_CLOSE_POLICY = 1008; // RFC 6455 — policy violation
const MS_PER_SECOND = 1000;

// The principal's ROLE now comes off the user record (plan
// 2026-08-07-tool-permissions task 2b) — it is a real per-user value, and
// `AccessManager.grant` bakes it into every capability this session mints.
// HOUSEHOLDS are still not modelled, so that half keeps its placeholder; it
// gates nothing today.
const DEFAULT_HOUSEHOLD_ID = "home";

const authMsgSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});

/**
 * Process the very first WS message. Closes the connection on any failure.
 * Idempotent: if already authed or rejected, drops silently.
 */
export async function handleAuthMessage(
  ws: ServerWebSocket<SessionData>,
  message: unknown,
  auth: AuthService,
  sessionManager: SessionManager,
): Promise<void> {
  if (ws.data.authState !== "pending") {
    log.debug("auth.ignored", { sessionId: ws.data.sessionId, state: ws.data.authState });
    return;
  }
  // Claim the gate SYNCHRONOUSLY — no await between the guard above and this
  // write. Bun does not serialize async WS message handlers, so without this
  // a second `auth` frame can enter the gate while this call is suspended on
  // an await below and rebind an already-minted principal.
  ws.data.authState = "authenticating";

  // Capture before any await: cleanupSession (on socket close) nulls
  // ws.data.sessionId, so reading it after an await can silently bind "".
  const sessionId = ws.data.sessionId ?? "";

  const parsed = authMsgSchema.safeParse(message);
  if (!parsed.success) {
    return reject(ws, "auth-required", "first message must be type:auth");
  }

  const r = await auth.tokens.validate(parsed.data.token);
  if (ws.data.authState !== "authenticating") {
    log.warn("auth.abandoned", {
      sessionId,
      state: ws.data.authState,
      reason: "socket left the authenticating state mid-flight (e.g. auth-timeout fired)",
    });
    return;
  }
  if (!r.ok) {
    return reject(ws, r.error, "token validation failed");
  }

  const userR = await auth.users.get(r.value.userId);
  if (ws.data.authState !== "authenticating") {
    log.warn("auth.abandoned", {
      sessionId,
      state: ws.data.authState,
      reason: "socket left the authenticating state mid-flight (e.g. auth-timeout fired)",
    });
    return;
  }
  if (!userR.ok || !userR.value) {
    return reject(ws, "user-not-found", "token valid but user gone");
  }

  const userId = userR.value.userId;
  const bindResult = sessionManager.bindUser(sessionId, userId);
  if (!bindResult.ok) {
    log.warn("auth.per-user-cap-reached", { sessionId, userId, reason: bindResult.error });
    return reject(ws, "session-limit", bindResult.error);
  }

  let principal: UserPrincipal;
  try {
    principal = createUserPrincipal(userId, userR.value.role, DEFAULT_HOUSEHOLD_ID);
  } catch {
    // assertUserId throws on a stored userId that doesn't match the
    // canonical shape (legacy install, hand-edited users.json). Reject
    // cleanly instead of letting the throw escape — an unhandled rejection
    // out of a Bun websocket.message handler kills the whole process.
    log.warn("auth.malformed-user-record", { sessionId, reason: "stored userId fails assertUserId" });
    return reject(ws, "invalid-user-record", "stored user record has a malformed userId");
  }
  ws.data.principal = principal;
  // The credential's OWN lifetime, kept off the principal because the principal
  // is an immutable identity anchor (spec §3.6). `TokenPayload.expiresAt` is in
  // SECONDS — the PASETO claim is an ISO instant floored to a second in
  // token-service.ts — and every consumer compares it against `Date.now()`, so
  // it is converted here, once, rather than at each comparison.
  ws.data.tokenExpiresAtMs = r.value.expiresAt * MS_PER_SECOND;
  ws.data.authState = "authed";
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }
  sendConnectionFrame(ws, {
    type: "auth.ok",
    user: {
      userId: userR.value.userId,
      displayName: userR.value.displayName,
      role: principal.role,
      // DERIVED, never stored. Kept beside `role` so webui / Android / iOS keep
      // working while they migrate to reading the role (plan tasks 6–9).
      isAdmin: principal.role === "admin",
      avatarTint: userR.value.avatarTint,
    },
  });
  log.info("auth.ok", { sessionId, userId, role: principal.role });
}

/**
 * Schedule the auth timeout; returns the handle to store in ws.data.authTimeout.
 * Fires reject if authState is still pending OR authenticating (a token/user
 * lookup in flight) after timeoutMs — handleAuthMessage's post-await
 * re-checks then see "rejected" and bail instead of reviving the socket.
 */
export function scheduleAuthTimeout(
  ws: ServerWebSocket<SessionData>,
  timeoutMs: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (ws.data.authState === "pending" || ws.data.authState === "authenticating") {
      reject(ws, "auth-timeout", `no auth message within ${timeoutMs}ms`);
    }
  }, timeoutMs);
}

/**
 * Idempotent: callable from "pending" or "authenticating". A no-op if the
 * socket is already "rejected" (e.g. the auth-timeout fired first) so a
 * racing caller can never double-close / double-send.
 */
function reject(ws: ServerWebSocket<SessionData>, code: string, reason: string): void {
  if (ws.data.authState === "rejected") {
    return;
  }
  ws.data.authState = "rejected";
  ws.data.principal = null;
  ws.data.tokenExpiresAtMs = null;
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }
  sendConnectionFrame(ws, { type: "auth.error", code, message: reason });
  log.info("auth.reject", { sessionId: ws.data.sessionId, code, reason });
  ws.close(WS_CLOSE_POLICY, reason);
}
