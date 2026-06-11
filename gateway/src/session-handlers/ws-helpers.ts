import type { ClientType } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { Adapter } from "../adapters/adapter-types.js";
import type { UserAudioInputAdapter } from "../adapters/user-audio-input-adapter.js";
import type { UserTextInputAdapter } from "../adapters/user-text-input-adapter.js";
import type { AttentionGateHandle } from "../cerebrum/attention-gate.js";
import type { ConversationMirror } from "../cerebrum/conversation-mirror.js";
import type { PreferenceManager } from "../cerebrum/preferences.js";
import type { ShortTermContext } from "../cerebrum/short-term-context-types.js";
import type { TaskMirror } from "../cerebrum/task-mirror.js";
import type { DeviceAttachment } from "../person-session/device-attachment.js";
import type { PersonSession } from "../person-session/person-session.js";
import type { BargeInController } from "./barge-in-controller.js";
import type { InterruptController } from "./interrupt-controller.js";
import type { SessionsHandlers } from "./sessions-handlers.js";

export interface CerebrumSessionData {
  sessionId: string | null;
  connectedAt: number;
  /** Auth gate state; transitions from pending → authed or pending → rejected. */
  authState: "pending" | "authed" | "rejected";
  /** Authenticated userId; null until auth gate succeeds. */
  userId: string | null;
  /** Handle for the auth timeout; cleared on auth success or rejection. */
  authTimeout: ReturnType<typeof setTimeout> | null;
  shortTermContext: ShortTermContext | null;
  taskManager: TaskMirror | null;
  attentionGate: AttentionGateHandle | null;
  adapters: Adapter[];
  conversationHistory: ConversationMirror | null;
  conversationFeedUnsub: (() => void) | null;
  taskLifecycleUnsub: (() => void) | null;
  audioAdapter: UserAudioInputAdapter | null;
  textAdapter: UserTextInputAdapter | null;
  grantedCapabilities: Set<string>;
  /**
   * Client identity declared by the client in session.configure. Used by
   * policy gates (e.g. TTS) to differentiate device behaviour from webui.
   * Defaults to "webui" when the client omits the field (legacy clients).
   */
  clientType: ClientType;
  isStreaming: boolean;
  preferenceManager: PreferenceManager | null;
  preferenceUnsub: (() => void) | null;
  preferenceAudioUnsub: (() => void) | null;
  /** Handles mic-onset barge-in: cancels TTS + sends playback.stop. */
  bargeInController: BargeInController | null;
  /** Handles UI/tool interrupt: cancels cycle + TTS + tasks + sends playback.stop. */
  interruptController: InterruptController | null;
  /**
   * The profile's PersonSession this WS is attached to. Populated during
   * session.configure; null until then and after cleanup. B3 migrates
   * conversation state into this object; for now it's bookkeeping only.
   */
  personSession: PersonSession | null;
  /** DeviceAttachment wrapping this WS; null outside an attached lifetime. */
  attachment: DeviceAttachment<ClientData> | null;
  /**
   * Session id captured from the `?session_id=` query param at WS upgrade.
   * If set, session.configure runs `switchFlow.switchTo(resumeSessionId)`
   * before sending the initial conversation snapshot — this rehydrates the
   * mirror from Hermes' message history. null when the client didn't ask
   * to resume a specific chain.
   */
  resumeSessionId: string | null;
  /** Sessions wire-frame handler: dispatches sessions.* / session.new / conversation.activate. */
  sessionsHandlers: SessionsHandlers | null;
  /**
   * `Date.now()` of the last accepted `session.new` frame on THIS connection,
   * or null before the first. The min-interval gate admits the next frame only
   * once `min_new_interval_ms` has elapsed since this. Per connection (one
   * client) — NOT per user; a user with web + app open gets a separate gate for
   * each. Blocks spam / double-fire; the cycle path (user.message) is not
   * gated here — it runs through a different handler.
   */
  lastSessionNewAtMs: number | null;
  /** Cleanup for the mirror.onSnapshot subscription created in session.configure. */
  snapshotUnsub: (() => void) | null;
  /**
   * Release this attachment's reference on the user's pooled ACP wire. The
   * registry tears the underlying WS down only when the last reference is
   * released (last attachment detaches) — a second client for the same user
   * reuses the wire instead of re-dialing (which the overlay would evict for).
   */
  acpWireDispose: (() => void) | null;
  /**
   * Unsubscribe for this WS's out-of-band SDK-frame listener
   * (sessions.renamed / commands.available) on the pooled acpConn. Must run on
   * cleanup so a detached client's closed socket stops receiving frames for the
   * shared wire's lifetime.
   */
  acpSdkFrameUnsub: (() => void) | null;
}

/** Alias for compatibility with server.ts and ws-handlers.ts */
export type ClientData = CerebrumSessionData;

export function createEmptySessionData(): CerebrumSessionData {
  return {
    sessionId: null,
    connectedAt: Date.now(),
    authState: "pending",
    userId: null,
    authTimeout: null,
    shortTermContext: null,
    taskManager: null,
    attentionGate: null,
    adapters: [],
    conversationHistory: null,
    conversationFeedUnsub: null,
    taskLifecycleUnsub: null,
    audioAdapter: null,
    textAdapter: null,
    grantedCapabilities: new Set(),
    clientType: "webui",
    isStreaming: false,
    preferenceManager: null,
    preferenceUnsub: null,
    preferenceAudioUnsub: null,
    bargeInController: null,
    interruptController: null,
    personSession: null,
    attachment: null,
    resumeSessionId: null,
    sessionsHandlers: null,
    lastSessionNewAtMs: null,
    snapshotUnsub: null,
    acpWireDispose: null,
    acpSdkFrameUnsub: null,
  };
}

export function sendError(ws: ServerWebSocket<ClientData>, code: string, message: string): void {
  ws.send(JSON.stringify({ type: "error", code, message }));
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
