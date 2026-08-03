import type { ClientType } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { UserPrincipal } from "../identity/user-principal.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { FrameJournal } from "./frame-journal.js";
import type { Attachment } from "./session-registry.js";
import type { SessionVoicePrefs } from "./session-voice-prefs.js";
import type { SttSession } from "./stt-session.js";
// ws-send.ts imports only the `SessionData` TYPE back from this file, which the
// transpiler erases — so this is a compile-time edge, never a runtime cycle.
import { sendConnectionFrame } from "./ws-send.js";

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
  /**
   * CONNECTION-scoped id, minted per WebSocket in `openSession`
   * (ws-handlers.ts) by `SessionManager.createSession()`. It dies with the
   * socket, and it is ONLY for connection bookkeeping: the SessionManager
   * registry, the per-user concurrent-connection cap, and log correlation.
   *
   * It is NOT the conversation — see `conversationId` below. Keying anything
   * durable on this field re-partitions that thing on every reload,
   * reconnect and gateway restart.
   */
  sessionId: string | null;
  /**
   * DURABLE session id — the session store's partition key (its `session_id`
   * column). Server-minted, opaque and unguessable (session-id.ts); a client
   * that presents one gets it only after a MEMBERSHIP lookup in the store its
   * own capability opens. Stable across reload / reconnect / gateway restart,
   * which is what makes the committed feed and the model's history survive
   * them (spec §10 acceptance #9).
   *
   * Null on a DRAFT — a connection that presented nothing, presented a draft
   * key, or presented an id this user's store does not hold. A draft has no
   * row and no id until its first message mints one, which is why ten opened
   * tabs leave the session list unchanged. `draftKey` below is what it holds
   * meanwhile.
   */
  conversationId: string | null;
  /**
   * This connection's draft key — the mint key its first message allocates a
   * session under, and the value the client re-presents as
   * `session.configure.conversationId` while it is still on a draft.
   *
   * Always set after session.configure, even when `conversationId` is bound:
   * an explicit "+" (ws-session-new.ts) unbinds the session and the connection
   * must have a fresh key ready to hand back on the same frame. Null before
   * session.configure.
   */
  draftKey: string | null;
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
   * This connection's membership in `conversationId`'s subscriber set
   * (session-model plan task 5). Minted by `bindSessionRuntime` on every
   * attach — a fresh id and generation each time, so a duplicate or late
   * close event detaches nothing.
   *
   * NON-NULL IFF `runtime` IS. Both are set by one attach and cleared by one
   * detach, and `conversationId` names the session the attachment is in for
   * exactly that window — `detachSession` reads the pair together.
   *
   * Task 9 validates every command frame against `generation`; the logging
   * contract (spec §7.3) carries `attachmentId` on every command, permission
   * and cancellation line, because with N windows an unattributed Stop cannot
   * be traced.
   */
  attachment: Attachment | null;
  /**
   * The session's ReAct loop (Plan 2 Task 10) — SHARED with every other
   * connection attached to `conversationId`, not owned by this one. Handed
   * over by the registry in `bindSessionRuntime`; null until then, and null
   * for the lifetime of a connection whose orchestrator is unconfigured
   * (`services.createSessionRuntime === null`) or whose session failed to
   * construct (no active LLM key — see ws-session-configure.ts). `text.input`
   * / `interrupt` routing (ws-handlers.ts) both no-op safely against null.
   *
   * Clearing this field is NOT disposal: the runtime dies with the SESSION,
   * when the registry's disposal policy says so.
   */
  runtime: SessionRuntime | null;
  // NO `permissions` FIELD, DELIBERATELY (task 7). The L3 permission
  // round-trip used to be parked here, one broker per socket, and that
  // placement WAS the resolution rule: a `permission.response` could only
  // settle a prompt minted on the same connection. With N windows on one
  // session that rule strands a prompt the moment its window closes, so the
  // prompt map moved to the session's handles
  // (runtime/session-permission-broker.ts) and `permission.response` is routed
  // by the session this connection is ATTACHED to (ws-handlers.ts). Re-adding
  // a per-connection handle here would re-introduce exactly the scoping that
  // move deleted.
  /**
   * The connection's STT uplink (Plan 3 Task 2, spec §6). Null until the
   * client's first `audio.start` — a text-only session never dials the STT
   * service. Owns one STTAdapter; inbound binary WS frames route into it
   * (ws-handlers.ts) and its transcript events land on `runtime.submit`.
   */
  stt: SttSession | null;
  /**
   * This connection's live audio/voice preferences (spec §6). Minted with the
   * runtime in `handleSessionConfigure` and held here so
   * `user.preferences.patch` (handle-preferences-patch.ts) can apply a mute
   * toggle to the SESSION, not just to profile.json — `TurnVoice.begin`
   * re-reads `shouldSpeak` per turn, but the profile is read once at
   * session.configure. Null when the orchestrator is unconfigured or the
   * runtime failed to construct; the patch is still persisted then.
   */
  voicePrefs: SessionVoicePrefs | null;
  /**
   * The SESSION's outbound frame journal — one monotonic seq space that every
   * window attached to `conversationId` reads from (session-model spec §2.1).
   *
   * A REFERENCE, not ownership: the object belongs to the session's handles
   * (which hold the lease) and outlives them in `services.replayRegistry`. This
   * field is set by the bind and cleared by the detach, so it is null on a
   * DRAFT and before session.configure — correct in both cases, since a
   * connection with no session has no conversation to replay and the client has
   * no cursor yet either. It exists here for exactly one reader: the resume
   * handshake (ws-resume.ts), which asks it what this client missed.
   */
  journal: FrameJournal | null;
  /**
   * Sequencing epoch for `journal`. Stamped on every session-lane frame so the
   * client can tell a genuine seq gap from a stream restart, and compared
   * against `resume.epoch` to decide whether a replay is even meaningful. 0
   * while unattached. Registry-global and never reused.
   */
  epoch: number;
}

export function createEmptySessionData(): SessionData {
  return {
    sessionId: null,
    conversationId: null,
    draftKey: null,
    authState: "pending",
    principal: null,
    authTimeout: null,
    grantedCapabilities: new Set(),
    clientType: "webui",
    attachment: null,
    runtime: null,
    stt: null,
    voicePrefs: null,
    journal: null,
    epoch: 0,
  };
}

/**
 * Send the shared `error` frame.
 *
 * CONNECTION lane (frame-lanes.ts), so validated but never journaled and never
 * fanned out. An error is the gateway's substantive answer to ONE connection's
 * action — `orchestrator_unavailable` is the only signal that THIS socket's
 * `text.input` went nowhere — and telling a peer window that someone else's
 * request failed is noise it cannot act on. It used to be journaled, on the
 * reasoning that a client which drops before reading it must replay it; under a
 * shared journal that reasoning inverts, because the replay would reach the
 * wrong window.
 */
export function sendError(ws: ServerWebSocket<SessionData>, code: string, message: string): void {
  sendConnectionFrame(ws, { type: "error", code, message });
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
