import type { Result, Session, UserRole } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "auth", "session-manager"]);

// ---------------------------------------------------------------------------
// SessionManager — tracks active connections.
//
// The gateway no longer requires per-user auth on the web-facing WebSocket
// (home LAN, no login yet). Sessions are created on WS open with a fixed
// anonymous identity. When a proper login flow lands, `createSession` will
// gain back its claims parameter; the surrounding code already depends on
// `Session` shape, so this path is stable.
// ---------------------------------------------------------------------------

export interface SessionManagerOptions {
  maxSessions?: number;
  /**
   * Maximum concurrent WS sessions one user may hold simultaneously.
   * Enforced at auth.ok (bind time), not at session creation.
   * Defaults to Number.MAX_SAFE_INTEGER (unlimited) so existing callers
   * that omit the option are unaffected.
   */
  perUserMaxSessions?: number;
}

const DEFAULT_MAX_SESSIONS = 10;

export const ANONYMOUS_USER_ID = "anonymous";
export const ANONYMOUS_DEVICE_ID = "unknown-device";
export const ANONYMOUS_ROLE: UserRole = "adult";

// Home-LAN sessions never expire (they live as long as the WS connection).
// Use a far-future timestamp so downstream code that compares against Date.now()
// never flips them to "expired".
const NEVER_EXPIRES_AT = 8_640_000_000_000_000; // max safe Date value

export interface SessionManager {
  createSession(): Result<Session>;
  getSession(sessionId: string): Session | undefined;
  removeSession(sessionId: string): boolean;
  activeCount(): number;
  listSessions(): Session[];
  /**
   * Bind a session to a real userId after auth.ok.
   * Returns ok:false if the user already has >= perUserMaxSessions live sessions.
   */
  bindUser(sessionId: string, userId: string): Result<void>;
  /**
   * Release the per-user session slot on disconnect / teardown.
   * No-op if the sessionId was never bound (e.g. session torn down before auth).
   */
  unbindUser(sessionId: string): void;
  /**
   * Forget every connection bound to [userId] — the registry entry AND the
   * per-user slot, across all three maps.
   *
   * Called when that account's credentials are REVOKED (a role change or a
   * deletion, session-handlers/credential-revocation.ts). The sockets are
   * closed separately; this is what stops a revoked account's dead connections
   * from holding its concurrent-connection budget against the fresh sign-in
   * that follows. A no-op for a user with nothing bound.
   */
  revokeUser(userId: string): void;
}

/**
 * Mints a CONNECTION id, one per WebSocket. It is ephemeral by design — the
 * SessionManager registry, the per-user concurrent-connection cap, and log
 * correlation are all connection-scoped concerns. Nothing durable may be
 * keyed on it; the conversation the session store partitions on is resolved
 * separately, in `handleSessionConfigure`.
 */
function generateSessionId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const timestamp = Date.now().toString(36);
  return `s-${timestamp}-${random}`;
}

export function createSessionManager(options: SessionManagerOptions = {}): SessionManager {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const perUserMaxSessions = options.perUserMaxSessions ?? Number.MAX_SAFE_INTEGER;
  const sessions = new Map<string, Session>();
  // userId → set of bound sessionIds
  const userSessions = new Map<string, Set<string>>();
  // sessionId → userId (reverse index for unbindUser)
  const sessionToUser = new Map<string, string>();

  return {
    createSession(): Result<Session> {
      if (sessions.size >= maxSessions) {
        return {
          ok: false,
          error: `Session limit reached (${maxSessions}). Cannot create new session.`,
        };
      }

      const session: Session = {
        sessionId: generateSessionId(),
        userId: ANONYMOUS_USER_ID,
        role: ANONYMOUS_ROLE,
        deviceId: ANONYMOUS_DEVICE_ID,
        createdAt: Date.now(),
        expiresAt: NEVER_EXPIRES_AT,
      };

      sessions.set(session.sessionId, session);
      return { ok: true, value: session };
    },

    getSession(sessionId: string): Session | undefined {
      return sessions.get(sessionId);
    },

    removeSession(sessionId: string): boolean {
      return sessions.delete(sessionId);
    },

    activeCount(): number {
      return sessions.size;
    },

    listSessions(): Session[] {
      return Array.from(sessions.values());
    },

    bindUser(sessionId: string, userId: string): Result<void> {
      const existing = userSessions.get(userId);
      const count = existing?.size ?? 0;
      if (count >= perUserMaxSessions) {
        return {
          ok: false,
          error: `Per-user session limit reached (${perUserMaxSessions}) for user ${userId}.`,
        };
      }
      if (!existing) {
        userSessions.set(userId, new Set([sessionId]));
      } else {
        existing.add(sessionId);
      }
      sessionToUser.set(sessionId, userId);
      return { ok: true, value: undefined };
    },

    unbindUser(sessionId: string): void {
      const userId = sessionToUser.get(sessionId);
      if (!userId) return;
      sessionToUser.delete(sessionId);
      const set = userSessions.get(userId);
      if (set) {
        set.delete(sessionId);
        if (set.size === 0) {
          userSessions.delete(userId);
        }
      }
    },

    revokeUser(userId: string): void {
      const bound = userSessions.get(userId);
      if (!bound) return;
      for (const sessionId of bound) {
        sessions.delete(sessionId);
        sessionToUser.delete(sessionId);
      }
      userSessions.delete(userId);
      log.info("session-manager.revoked", {
        userId,
        connections: bound.size,
        reason: "this account's credentials were revoked — dropping its bound connections",
      });
    },
  };
}
