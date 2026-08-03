// The auth gate's two frames — `auth.ok` and `auth.error` — are the only ones
// a client sees before `session.configure`, and the whole session depends on
// them. They used to be hand-serialized object literals passed straight to
// `ws.send`, which is exactly the bypass the branch's "every outbound frame is
// constructed and validated through `gatewayMessageSchema`" constraint forbids;
// the schema's `auth.ok` had drifted to a `{ sessionId, role }` stub nothing
// sent and nothing read, and `auth.error` was not in the union at all.
// Both now go out through `sendGatewayFrame` (ws-send.ts) like every other
// frame. They are still UNSEQUENCED — `ws.data.journal` is null until
// session.configure, and sendGatewayFrame writes unstamped in that case — so
// this changed validation, not sequencing.
//
// SIGNATURE: the socket is typed `ServerWebSocket<SessionData>` rather than the
// narrow local `WsLike` this file used to declare. `sendGatewayFrame` reads
// `ws.data.journal` / `ws.data.epoch` and writes through `ws.send`, so a
// three-member structural stand-in is not assignable to it; duplicating a
// second socket type to work around that would just re-create the drift this
// commit is removing. Callers already hold the real Bun socket; the tests pass
// a cast fake, which is the normal cost of typing on the real transport.

import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { SessionManager } from "../auth/session-manager.js";
import { type PrincipalRole, type UserPrincipal, createUserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { AuthService } from "../user-auth/auth-service.js";
import type { SessionData } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "gateway", "session-handlers", "ws-auth-gate"]);

const WS_CLOSE_POLICY = 1008; // RFC 6455 — policy violation

// The user record doesn't carry role/householdId yet — default them here.
// The real role model (system/operator/household scopes) lands with the
// ambient re-architecture spec. Logged once at module init (not per login,
// which would be log spam) so the gap stays visible.
const DEFAULT_PRINCIPAL_ROLE: PrincipalRole = "adult";
const DEFAULT_HOUSEHOLD_ID = "home";
log.warn("principal.role-model-not-implemented", { reason: "user record carries no role/householdId" });

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
    principal = createUserPrincipal(userId, DEFAULT_PRINCIPAL_ROLE, DEFAULT_HOUSEHOLD_ID);
  } catch {
    // assertUserId throws on a stored userId that doesn't match the
    // canonical shape (legacy install, hand-edited users.json). Reject
    // cleanly instead of letting the throw escape — an unhandled rejection
    // out of a Bun websocket.message handler kills the whole process.
    log.warn("auth.malformed-user-record", { sessionId, reason: "stored userId fails assertUserId" });
    return reject(ws, "invalid-user-record", "stored user record has a malformed userId");
  }
  ws.data.principal = principal;
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
      isAdmin: userR.value.isAdmin,
      avatarTint: userR.value.avatarTint,
    },
  });
  log.info("auth.ok", { sessionId, userId });
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
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }
  sendConnectionFrame(ws, { type: "auth.error", code, message: reason });
  log.info("auth.reject", { sessionId: ws.data.sessionId, code, reason });
  ws.close(WS_CLOSE_POLICY, reason);
}
