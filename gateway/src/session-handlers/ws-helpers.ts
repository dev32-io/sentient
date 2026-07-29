import type { ClientType } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { UserPrincipal } from "../identity/user-principal.js";
import type { PermissionBroker } from "../runtime/permission-broker.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { FrameJournal } from "./frame-journal.js";
import type { ReplayLease } from "./replay-registry.js";
import type { SttSession } from "./stt-session.js";
// ws-send.ts imports only the `SessionData` TYPE back from this file, which the
// transpiler erases — so this is a compile-time edge, never a runtime cycle.
import { sendGatewayFrame } from "./ws-send.js";

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
  /**
   * This connection's L3 permission round-trip (Plan 3 Task 6, spec §7.1).
   * Minted alongside `runtime` in `handleSessionConfigure`; null until then
   * and for the lifetime of a session whose orchestrator is unconfigured.
   * Connection-scoped ON PURPOSE — a `permission.response` frame can only
   * settle a prompt this same socket issued, which is what makes cross-user
   * resolution structurally impossible rather than a check to remember.
   * `cleanupSession` calls `denyAll()` so a dropped socket never strands a
   * ReAct turn awaiting an answer.
   */
  permissions: PermissionBroker | null;
  /**
   * The connection's STT uplink (Plan 3 Task 2, spec §6). Null until the
   * client's first `audio.start` — a text-only session never dials the STT
   * service. Owns one STTAdapter; inbound binary WS frames route into it
   * (ws-handlers.ts) and its transcript events land on `runtime.submit`.
   */
  stt: SttSession | null;
  /**
   * This connection's outbound frame journal (Plan 3 Task 10, spec §11
   * slice 6). Acquired from `services.replayRegistry` in
   * `handleSessionConfigure`, so it is null for every frame sent before
   * then (auth.ok, auth-gate errors) — those go out unstamped and
   * unjournaled, which is correct: the client has no cursor yet either.
   * The OBJECT is owned by the registry, not by this connection — a
   * resumed surface gets the same journal back and its seq counter simply
   * continues, which is what makes replay contiguous across the socket
   * boundary.
   */
  journal: FrameJournal | null;
  /**
   * Sequencing epoch for `journal`. Stamped on every outbound JSON frame so
   * the client can tell a genuine seq gap from a stream restart. 0 until
   * session.configure. Registry-global and never reused.
   */
  epoch: number;
  /**
   * This connection's ownership token for `journal` — the registry key
   * (`${userId}::${surfaceId}`) plus the per-acquisition lease id. Held here
   * so `cleanupSession` can release the journal into its retention window
   * without re-deriving the key from a principal that may already be gone,
   * and so a connection that has since been SUPERSEDED on that surface (a
   * reload whose new socket configured before this one's close landed)
   * cannot park or discard the journal the newer connection is filling — the
   * registry rejects a stale lease. null until session.configure.
   */
  replayLease: ReplayLease | null;
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
    permissions: null,
    stt: null,
    journal: null,
    epoch: 0,
    replayLease: null,
  };
}

/**
 * Send the shared `error` frame.
 *
 * Goes through `sendGatewayFrame`, so it is validated against
 * `gatewayMessageSchema`, seq-stamped and journaled like every other content
 * frame — an error is the gateway's substantive answer to a client action
 * (`orchestrator_unavailable` is the ONLY signal that a `text.input` went
 * nowhere), so a socket that drops before the client reads it must replay it.
 * Frames sent before session.configure have no journal yet and fall back to an
 * unstamped write inside that helper, which is correct: the client has no
 * resume cursor at that point either.
 */
export function sendError(ws: ServerWebSocket<SessionData>, code: string, message: string): void {
  sendGatewayFrame(ws, { type: "error", code, message });
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
