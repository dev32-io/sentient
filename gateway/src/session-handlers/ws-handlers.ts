import { clientMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { handlePreferencesPatch } from "./handle-preferences-patch.js";
import { handleAuthMessage, scheduleAuthTimeout } from "./ws-auth-gate.js";
import type { ClientData } from "./ws-helpers.js";
import { errorMessage, sendError } from "./ws-helpers.js";
import { handleSessionConfigure } from "./ws-session-configure.js";

export type { ClientData };

export interface GatewayTlsMaterial {
  readonly cert: string;
  readonly key: string;
}

const log = getLog(["sentient", "ws"]);
const WS_NORMAL_CLOSURE = 1000;

// ---------------------------------------------------------------------------
// Session open — auth + session registration
// ---------------------------------------------------------------------------

export function openSession(ws: ServerWebSocket<ClientData>, services: GatewayServices): void {
  const result = services.sessionManager.createSession();
  if (!result.ok) {
    sendError(ws, "session_limit", result.error);
    ws.close(WS_NORMAL_CLOSURE, "Session limit reached");
    return;
  }

  ws.data.sessionId = result.value.sessionId;
  ws.data.authTimeout = scheduleAuthTimeout(ws, services.authConfig.ws_auth_timeout_ms);
  log.info("session-opened", { sessionId: result.value.sessionId });
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

export async function handleWebSocketMessage(
  ws: ServerWebSocket<ClientData>,
  message: string | Buffer,
  services: GatewayServices,
): Promise<void> {
  // Binary frames -> audio adapter. Forward bytes raw; the adapter is
  // codec-agnostic and the wire format (pcm16 | opus) is set on the STT
  // adapter config (see STTAdapterConfig.audioFormat).
  if (typeof message !== "string") {
    if (ws.data.audioAdapter && ws.data.isStreaming) {
      ws.data.audioAdapter.sendAudioFrame(message);
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    sendError(ws, "protocol_error", "Malformed JSON");
    return;
  }

  if (ws.data.authState !== "authed") {
    await handleAuthMessage(ws, parsed, services.auth);
    return;
  }

  // user.preferences.patch is dispatched before strict clientMessageSchema
  // validation because (a) its payload schema lives in @sentient/audio-prefs
  // (not in the protocol union) and (b) the spec is "silent reject on
  // malformed payload" — running it through clientMessageSchema would emit
  // a protocol_error frame instead.
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: unknown }).type === "user.preferences.patch"
  ) {
    await dispatchPreferencesPatch(ws, parsed, services);
    return;
  }

  const msgResult = clientMessageSchema.safeParse(parsed);
  if (!msgResult.success) {
    sendError(ws, "protocol_error", `Invalid message: ${msgResult.error.message}`);
    return;
  }
  const msg = msgResult.data;

  if (msg.type !== "ping") {
    log.debug("message-received", { type: msg.type });
  }

  switch (msg.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      return;

    case "session.configure":
      await handleSessionConfigure(ws, msg.capabilities.supports, msg.language, services, msg.clientType);
      return;

    case "text.input":
      handleTextInput(ws, msg.text, msg.pendingId);
      return;

    case "audio.start":
      ws.data.isStreaming = true;
      return;

    case "audio.end":
      ws.data.isStreaming = false;
      return;

    case "session.end":
      handleSessionEnd(ws, services);
      return;

    case "tool.confirm":
      // Tool-confirm handling is not yet wired; receiving one is a no-op.
      return;

    case "interrupt":
      ws.data.interruptController?.trigger();
      return;

    case "sessions.list":
    case "sessions.search":
    case "sessions.delete":
    case "sessions.rename":
    case "session.new":
    case "session.switch": {
      const handlers = ws.data.sessionsHandlers;
      if (!handlers) {
        sendError(ws, "protocol_error", "sessions handlers not configured for this session");
        return;
      }
      try {
        await handlers.handle(msg);
      } catch (err: unknown) {
        log.warn("sessions-handler-failed", {
          type: msg.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// user.preferences.patch -> PreferenceManager + profile.audio
// ---------------------------------------------------------------------------

async function dispatchPreferencesPatch(
  ws: ServerWebSocket<ClientData>,
  parsed: unknown,
  services: GatewayServices,
): Promise<void> {
  const sessionId = ws.data.sessionId;
  const userId = ws.data.userId;
  const preferenceManager = ws.data.preferenceManager;
  if (!sessionId || !userId || !preferenceManager) {
    log.warn("preferences-patch.session-not-ready", {
      hasSession: sessionId !== null,
      hasUser: userId !== null,
      hasPm: preferenceManager !== null,
    });
    return;
  }
  await handlePreferencesPatch({
    raw: parsed,
    preferenceManager,
    persistAudioPatch: async (uid, p) => {
      const cur = await services.profileStore.get(uid);
      if (!cur.ok) {
        log.warn("user.preferences.patch.profile-read-failed", { sessionId, userId: uid });
        return;
      }
      const saveResult = await services.profileStore.save({
        ...cur.value,
        audio: {
          ttsEnabled: p.ttsEnabled ?? cur.value.audio.ttsEnabled,
          channel: p.channel ?? cur.value.audio.channel,
        },
      });
      if (!saveResult.ok) {
        log.warn("user.preferences.patch.profile-save-failed", { sessionId, userId: uid });
      }
    },
    sessionId,
    userId,
  });
}

// ---------------------------------------------------------------------------
// Text input -> adapter injection
// ---------------------------------------------------------------------------

function handleTextInput(ws: ServerWebSocket<ClientData>, text: string, pendingId?: string): void {
  const textAdapter = ws.data.textAdapter;
  if (!textAdapter) {
    sendError(ws, "protocol_error", "Text input not configured for this session");
    return;
  }
  textAdapter.handleTextInput(text, pendingId);
}

// ---------------------------------------------------------------------------
// Session end + cleanup
// ---------------------------------------------------------------------------

function handleSessionEnd(ws: ServerWebSocket<ClientData>, services: GatewayServices): void {
  if (!ws.data.sessionId) return;
  cleanupSession(ws, services);
  ws.close(WS_NORMAL_CLOSURE, "Session ended");
}

export function cleanupSession(ws: ServerWebSocket<ClientData>, services: GatewayServices): void {
  const sessionId = ws.data.sessionId;
  if (!sessionId) return;

  log.info("session-cleanup", { sessionId });

  // Clear auth timeout if the session ends before auth completes
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }

  // Dispose attention gate (also cancels any in-flight cycle via cycleSlot)
  ws.data.attentionGate?.dispose();
  ws.data.attentionGate = null;

  // Stop all adapters
  for (const adapter of ws.data.adapters) {
    adapter.stop("session-end").catch((err: unknown) => {
      log.error("adapter-stop-failed", { id: adapter.id, error: errorMessage(err, "unknown") });
    });
  }
  ws.data.adapters = [];
  ws.data.audioAdapter = null;
  ws.data.textAdapter = null;

  // Clear cerebrum state
  ws.data.shortTermContext = null;
  ws.data.taskManager = null;
  ws.data.conversationFeedUnsub?.();
  ws.data.conversationFeedUnsub = null;
  ws.data.taskLifecycleUnsub?.();
  ws.data.taskLifecycleUnsub = null;
  ws.data.preferenceUnsub?.();
  ws.data.preferenceUnsub = null;
  ws.data.preferenceAudioUnsub?.();
  ws.data.preferenceAudioUnsub = null;
  ws.data.preferenceManager = null;
  ws.data.bargeInController?.dispose();
  ws.data.bargeInController = null;
  ws.data.interruptController = null;
  ws.data.snapshotUnsub?.();
  ws.data.snapshotUnsub = null;
  // Stop this WS's out-of-band SDK-frame listener on the (pooled) acpConn
  // BEFORE releasing the wire ref — the closed socket must not keep receiving
  // frames if the wire stays alive for another attachment.
  ws.data.acpSdkFrameUnsub?.();
  ws.data.acpSdkFrameUnsub = null;
  // Release this attachment's ref on the pooled wire. Disposes the underlying
  // WS only when the last attachment for this user detaches.
  ws.data.acpWireDispose?.();
  ws.data.acpWireDispose = null;
  ws.data.sessionsHandlers = null;
  ws.data.resumeSessionId = null;
  ws.data.conversationHistory?.clear();
  ws.data.conversationHistory = null;
  ws.data.isStreaming = false;

  // Detach this device from the person session (PersonSession itself stays
  // alive; B1/B2 scope is bookkeeping only, no archive timer yet).
  if (ws.data.personSession && ws.data.attachment) {
    ws.data.personSession.detach(ws.data.attachment);
  }
  ws.data.personSession = null;
  ws.data.attachment = null;

  // Unregister session + release Hermes binding
  log.debug("session-hermes-release", { sessionId });
  services.sessionControls.unregister(sessionId);
  services.sessionRouter.release(sessionId);
  services.sessionManager.removeSession(sessionId);
  ws.data.sessionId = null;
}
