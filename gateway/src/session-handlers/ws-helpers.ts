import type { ClientType } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { UserPrincipal } from "../identity/user-principal.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";

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
 *
 * Named `SessionData` (not `CerebrumSessionData`, the pre-purge name) since
 * the "cerebrum" construct it referred to no longer exists in this codebase.
 */
export interface SessionData {
  sessionId: string | null;
  /**
   * Auth gate state. pending → authenticating happens synchronously (no
   * await between the guard read and this write in ws-auth-gate.ts), so a
   * second `auth` frame arriving while the first is suspended on I/O always
   * sees "authenticating" and is dropped. authenticating → authed on
   * success; pending | authenticating → rejected on failure or timeout.
   */
  authState: "pending" | "authenticating" | "authed" | "rejected";
  /** Minted once at the auth gate; null until authenticated. Never reassigned after. */
  principal: UserPrincipal | null;
  /** Handle for the auth timeout; cleared on auth success or rejection. */
  authTimeout: ReturnType<typeof setTimeout> | null;
  /** Capabilities the client declared in session.configure. */
  grantedCapabilities: Set<string>;
  /**
   * Client identity declared by the client in session.configure. Defaults to
   * "webui" when the client omits the field (legacy clients).
   */
  clientType: ClientType;
  /**
   * The native orchestrator's per-session owner (Plan 2 Task 10). Minted in
   * `handleSessionConfigure` via `services.createSessionRuntime` once the
   * principal is known; null until then, and null for the lifetime of a
   * session if the orchestrator is unconfigured
   * (`services.createSessionRuntime === null`) or construction failed (no
   * active LLM key — see ws-session-configure.ts). `text.input` /
   * `interrupt` routing (ws-handlers.ts) both no-op safely against null.
   */
  runtime: SessionRuntime | null;
}

export function createEmptySessionData(): SessionData {
  return {
    sessionId: null,
    authState: "pending",
    principal: null,
    authTimeout: null,
    grantedCapabilities: new Set(),
    clientType: "webui",
    runtime: null,
  };
}

export function sendError(ws: ServerWebSocket<SessionData>, code: string, message: string): void {
  ws.send(JSON.stringify({ type: "error", code, message }));
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
