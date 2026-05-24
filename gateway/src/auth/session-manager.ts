import type { Result, Session, UserRole } from "@sentient/protocol";

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
}

function generateSessionId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const timestamp = Date.now().toString(36);
  return `s-${timestamp}-${random}`;
}

export function createSessionManager(options: SessionManagerOptions = {}): SessionManager {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, Session>();

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
  };
}
