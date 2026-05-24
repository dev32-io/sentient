import { z } from "zod";
import { getLog } from "../logging/logger.js";
import type { AuthService } from "../user-auth/auth-service.js";
import type { ClientData } from "./ws-helpers.js";

const log = getLog(["sentient", "gateway", "session-handlers", "ws-auth-gate"]);

const WS_CLOSE_POLICY = 1008; // RFC 6455 — policy violation

const authMsgSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});

interface WsLike {
  data: ClientData;
  send: (s: string) => void;
  close: (code: number, reason?: string) => void;
}

/**
 * Process the very first WS message. Closes the connection on any failure.
 * Idempotent: if already authed or rejected, drops silently.
 */
export async function handleAuthMessage(ws: WsLike, message: unknown, auth: AuthService): Promise<void> {
  if (ws.data.authState !== "pending") {
    log.debug("auth.ignored", { sessionId: ws.data.sessionId, state: ws.data.authState });
    return;
  }

  const parsed = authMsgSchema.safeParse(message);
  if (!parsed.success) {
    return reject(ws, "auth-required", "first message must be type:auth");
  }

  const r = await auth.tokens.validate(parsed.data.token);
  if (!r.ok) {
    return reject(ws, r.error, "token validation failed");
  }

  const userR = await auth.users.get(r.value.userId);
  if (!userR.ok || !userR.value) {
    return reject(ws, "user-not-found", "token valid but user gone");
  }

  ws.data.userId = userR.value.userId;
  ws.data.authState = "authed";
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }
  ws.send(
    JSON.stringify({
      type: "auth.ok",
      user: {
        userId: userR.value.userId,
        displayName: userR.value.displayName,
        isAdmin: userR.value.isAdmin,
        avatarTint: userR.value.avatarTint,
      },
    }),
  );
  log.info("auth.ok", { sessionId: ws.data.sessionId, userId: userR.value.userId });
}

/**
 * Schedule the auth timeout; returns the handle to store in ws.data.authTimeout.
 * Fires reject if authState is still pending after timeoutMs.
 */
export function scheduleAuthTimeout(ws: WsLike, timeoutMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (ws.data.authState === "pending") {
      reject(ws, "auth-timeout", `no auth message within ${timeoutMs}ms`);
    }
  }, timeoutMs);
}

function reject(ws: WsLike, code: string, reason: string): void {
  ws.data.authState = "rejected";
  ws.data.userId = null;
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }
  ws.send(JSON.stringify({ type: "auth.error", code, message: reason }));
  log.info("auth.reject", { sessionId: ws.data.sessionId, code, reason });
  ws.close(WS_CLOSE_POLICY, reason);
}
