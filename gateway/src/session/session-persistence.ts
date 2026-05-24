import { type ReplayBuffer, type ReplayEntry, createReplayBuffer } from "./replay-buffer.ts";

export type SessionStatus = "active" | "suspended";

export interface SessionState {
  readonly sessionId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: number;
  lastActiveAt: number;
  status: SessionStatus;
}

export const SESSION_DEFAULTS = {
  suspendWindowMs: 120_000,
  replayBufferCapacity: 100,
} as const;

export interface ReconnectResult {
  readonly success: boolean;
  readonly missedMessages: ReplayEntry[];
}

export interface SessionPersistence {
  save(session: SessionState): void;
  get(sessionId: string): SessionState | null;
  touch(sessionId: string): void;
  suspend(sessionId: string): void;
  canResume(sessionId: string): boolean;
  resume(sessionId: string): boolean;
  destroy(sessionId: string): void;
  cleanup(): void;
  activeSessions(): SessionState[];
  totalCount(): number;
  addReplayMessage(sessionId: string, message: Record<string, unknown>): void;
  reconnect(sessionId: string, lastSeq: number): ReconnectResult;
}

interface StoredSession {
  state: SessionState;
  buffer: ReplayBuffer;
  suspendedAt: number | null;
}

const FAILED_RECONNECT: ReconnectResult = { success: false, missedMessages: [] };

export function createSessionPersistence(options?: {
  suspendWindowMs?: number;
  replayBufferCapacity?: number;
  now?: () => number;
}): SessionPersistence {
  const suspendWindowMs = options?.suspendWindowMs ?? SESSION_DEFAULTS.suspendWindowMs;
  const replayBufferCapacity = options?.replayBufferCapacity ?? SESSION_DEFAULTS.replayBufferCapacity;
  const now = options?.now ?? (() => Date.now());
  const sessions = new Map<string, StoredSession>();

  function copyState(state: SessionState): SessionState {
    return { ...state };
  }

  function isExpired(stored: StoredSession): boolean {
    if (stored.suspendedAt === null) return false;
    return now() - stored.suspendedAt > suspendWindowMs;
  }

  return {
    save(session: SessionState): void {
      sessions.set(session.sessionId, {
        state: copyState(session),
        buffer: createReplayBuffer(replayBufferCapacity),
        suspendedAt: null,
      });
    },

    get(sessionId: string): SessionState | null {
      const stored = sessions.get(sessionId);
      if (!stored) return null;
      return copyState(stored.state);
    },

    touch(sessionId: string): void {
      const stored = sessions.get(sessionId);
      if (!stored) return;
      stored.state.lastActiveAt = now();
    },

    suspend(sessionId: string): void {
      const stored = sessions.get(sessionId);
      if (!stored) return;
      stored.state.status = "suspended";
      stored.suspendedAt = now();
    },

    canResume(sessionId: string): boolean {
      const stored = sessions.get(sessionId);
      if (!stored) return false;
      if (stored.state.status !== "suspended") return false;
      return !isExpired(stored);
    },

    resume(sessionId: string): boolean {
      const stored = sessions.get(sessionId);
      if (!stored) return false;
      if (stored.state.status !== "suspended") return false;
      if (isExpired(stored)) return false;
      stored.state.status = "active";
      stored.suspendedAt = null;
      return true;
    },

    destroy(sessionId: string): void {
      sessions.delete(sessionId);
    },

    cleanup(): void {
      for (const [id, stored] of sessions) {
        if (stored.state.status === "suspended" && isExpired(stored)) {
          sessions.delete(id);
        }
      }
    },

    activeSessions(): SessionState[] {
      const result: SessionState[] = [];
      for (const stored of sessions.values()) {
        if (stored.state.status === "active") {
          result.push(copyState(stored.state));
        }
      }
      return result;
    },

    totalCount(): number {
      return sessions.size;
    },

    addReplayMessage(sessionId: string, message: Record<string, unknown>): void {
      const stored = sessions.get(sessionId);
      if (!stored) return;
      stored.buffer.add(message);
    },

    reconnect(sessionId: string, lastSeq: number): ReconnectResult {
      const stored = sessions.get(sessionId);
      if (!stored) return FAILED_RECONNECT;
      if (stored.state.status !== "suspended") return FAILED_RECONNECT;
      if (isExpired(stored)) return FAILED_RECONNECT;
      stored.state.status = "active";
      stored.state.lastActiveAt = now();
      stored.suspendedAt = null;
      return {
        success: true,
        missedMessages: stored.buffer.replayAfter(lastSeq),
      };
    },
  };
}
