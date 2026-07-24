import type { ClientType } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";

/**
 * Per-connection WS state. Post-purge minimal form (spec §9 Task 1) — holds
 * only what auth (ws-auth-gate.ts) and the bare session-configure handshake
 * (ws-session-configure.ts) need. Every field that belonged to the deleted
 * Hermes-cycle pipeline (short-term context, task mirror, attention gate,
 * conversation mirror/mirror-feed unsub, input adapters, preference manager,
 * barge-in/interrupt controllers, PersonSession attachment, sessions
 * handlers, ACP wire/anchor teardown, activity clock) is gone along with the
 * Hermes-runtime-brain purge (this task's sibling-directory deletions) —
 * Plan 2 rebuilds this shape alongside the native orchestrator.
 */
export interface ClientData {
  sessionId: string | null;
  connectedAt: number;
  /** Auth gate state; transitions from pending → authed or pending → rejected. */
  authState: "pending" | "authed" | "rejected";
  /** Authenticated userId; null until auth gate succeeds. */
  userId: string | null;
  /** Handle for the auth timeout; cleared on auth success or rejection. */
  authTimeout: ReturnType<typeof setTimeout> | null;
  /** Capabilities the client declared in session.configure. */
  grantedCapabilities: Set<string>;
  /**
   * Client identity declared by the client in session.configure. Defaults to
   * "webui" when the client omits the field (legacy clients).
   */
  clientType: ClientType;
}

export function createEmptySessionData(): ClientData {
  return {
    sessionId: null,
    connectedAt: Date.now(),
    authState: "pending",
    userId: null,
    authTimeout: null,
    grantedCapabilities: new Set(),
    clientType: "webui",
  };
}

export function sendError(ws: ServerWebSocket<ClientData>, code: string, message: string): void {
  ws.send(JSON.stringify({ type: "error", code, message }));
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
