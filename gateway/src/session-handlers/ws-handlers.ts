import { clientMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { handlePreferencesPatch } from "./handle-preferences-patch.js";
import { shouldAdmitSessionNew } from "./session-new-rate-limit.js";
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
      ws.data.activityClock?.touch("ws.in");
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
    await handleAuthMessage(ws, parsed, services.auth, services.sessionManager);
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
    // A preferences change is real session activity — touch before the early
    // return so a prefs-only session doesn't read as idle to the watchdog.
    ws.data.activityClock?.touch("ws.in");
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
    ws.data.activityClock?.touch("ws.in");
    log.debug("message-received", { type: msg.type });
  }

  switch (msg.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      return;

    case "session.configure":
      // Resume params ride INSIDE the configure frame (msg.resume) — read
      // synchronously by the handler, no separate stream.resume frame, no race.
      await handleSessionConfigure(
        ws,
        msg.capabilities.supports,
        msg.language,
        services,
        msg.clientType,
        msg.deviceId,
        msg.surfaceId,
        msg.resume,
        msg.conversationId,
      );
      return;

    case "text.input":
      handleTextInput(ws, msg.text, msg.pendingId);
      return;

    case "audio.start":
      ws.data.isStreaming = true;
      // Relay the turn-authority mode to STT (2026-07-17 hold/toggle-talk
      // split design §4/§6). zod defaults turnMode to "semantic" when the
      // client omits it, so old clients / webui are unaffected.
      ws.data.audioAdapter?.setTurnMode(msg.turnMode);
      return;

    case "audio.end":
      ws.data.isStreaming = false;
      // PTT release / mic off: flush STT so an open turn finalizes now.
      // The service's watchdogs are frame-clocked — without this, a turn
      // left open here would only complete at the next mic hold.
      ws.data.audioAdapter?.endUtterance();
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

    case "session.new":
    case "conversation.activate": {
      const handlers = ws.data.sessionsHandlers;
      if (!handlers) {
        sendError(ws, "protocol_error", "sessions handlers not configured for this session");
        return;
      }
      // Per-connection spam guard on explicit client session.new frames only.
      // The cycle path (user.message) is not rate-limited here — it runs through
      // a different handler.
      if (msg.type === "session.new" && !admitSessionNew(ws, msg.requestId, services)) {
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
// session.new spam guard (per-connection rate limit)
// ---------------------------------------------------------------------------

/**
 * Per-connection min-interval gate for explicit client `session.new` frames.
 * Rejects with a `sessions.error rate_limited` frame + WARN when the previous
 * `session.new` on this connection was less than `min_new_interval_ms` ago (does
 * NOT delegate), otherwise records `Date.now()` and returns true so the caller
 * delegates to the sessions handler. Blocks spam bursts / accidental
 * double-fires, never human-paced new chats. Per connection — NOT per user.
 */
export function admitSessionNew(
  ws: ServerWebSocket<ClientData>,
  requestId: string,
  services: GatewayServices,
): boolean {
  const now = Date.now();
  const { min_new_interval_ms: minIntervalMs } = services.sessions;
  if (!shouldAdmitSessionNew(ws.data.lastSessionNewAtMs, now, minIntervalMs)) {
    log.warn("session-new-rate-limited", {
      sessionId: ws.data.sessionId,
      requestId,
      reason: "session.new too frequent",
      minIntervalMs,
    });
    ws.send(JSON.stringify({ type: "sessions.error", requestId, code: "rate_limited", message: "too many new chats" }));
    return false;
  }
  ws.data.lastSessionNewAtMs = now;
  return true;
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

/** Capability advertised by clients that support stream resumption (Task 3.7+). */
const CAP_STREAM_RESUME = "stream.resume";

function handleSessionEnd(ws: ServerWebSocket<ClientData>, services: GatewayServices): void {
  if (!ws.data.sessionId) return;
  cleanupSession(ws, services, { full: true });
  ws.close(WS_NORMAL_CLOSURE, "Session ended");
}

export interface CleanupOptions {
  /**
   * true  → explicit session.end / logout: full teardown (dispose gate,
   *          ACP wire, remove session, dispose device buffer).
   * false → transport close: resumable if the client advertised stream.resume
   *          AND a device buffer is present; otherwise falls through to full.
   */
  full: boolean;
}

export function cleanupSession(
  ws: ServerWebSocket<ClientData>,
  services: GatewayServices,
  opts: CleanupOptions = { full: true },
): void {
  const sessionId = ws.data.sessionId;
  if (!sessionId) return;

  // Decide whether to run the RESUMABLE path. Conditions:
  //   - caller requested a non-full cleanup (transport close, not session.end)
  //   - the client advertised stream.resume capability
  //   - a device buffer entry exists for this attachment (so there's somewhere
  //     to keep journaling)
  const hasStreamResume = ws.data.grantedCapabilities.has(CAP_STREAM_RESUME);
  const hasPersonSession = ws.data.personSession !== null;
  const hasAttachment = ws.data.attachment !== null;
  const hasBuffer =
    ws.data.personSession !== null &&
    ws.data.attachment !== null &&
    ws.data.personSession.bufferFor(ws.data.attachment.attachmentId) !== undefined;
  const isResumable = !opts.full && hasStreamResume && hasPersonSession && hasAttachment && hasBuffer;

  log.info("session-cleanup.decision", {
    sessionId,
    full: opts.full,
    isResumable,
    hasStreamResume,
    hasPersonSession,
    hasAttachment,
    hasBuffer,
  });

  if (isResumable) {
    runResumableDisconnect(ws, services, sessionId);
  } else {
    runFullTeardown(ws, services, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Shared teardown helper
// ---------------------------------------------------------------------------

/**
 * Captured pipeline state that survives a resumable disconnect until the
 * deferred teardown fires (or is cancelled by a reconnect).
 */
interface CapturedPipelineResources {
  readonly attentionGate: ClientData["attentionGate"];
  readonly bargeInController: ClientData["bargeInController"];
  readonly conversationFeedUnsub: ClientData["conversationFeedUnsub"];
  readonly taskLifecycleUnsub: ClientData["taskLifecycleUnsub"];
  readonly preferenceUnsub: ClientData["preferenceUnsub"];
  readonly preferenceAudioUnsub: ClientData["preferenceAudioUnsub"];
  readonly snapshotUnsub: ClientData["snapshotUnsub"];
  readonly acpSdkFrameUnsub: ClientData["acpSdkFrameUnsub"];
  readonly acpWireDispose: ClientData["acpWireDispose"];
  readonly dropAnchor: ClientData["dropAnchor"];
  readonly personSession: ClientData["personSession"];
  readonly attachment: ClientData["attachment"];
}

/**
 * Disposes all shared pipeline resources: attention gate, barge-in controller,
 * subscription callbacks, ACP wire, person-session detach, and the three
 * service registration teardown calls.
 *
 * Called from BOTH the full-teardown path (immediately) and the deferred
 * teardown closure (on sweep expiry). This is the single place that lists
 * every shared disposable — the two paths cannot silently diverge.
 */
function teardownPipelineResources(
  captured: CapturedPipelineResources,
  services: GatewayServices,
  sessionId: string,
): void {
  // Relinquish the device's live socket if this attachment still holds it.
  // Identity-guarded inside releaseSocket: a resume handover where a newer
  // attachment already took over is a no-op here, so the in-flight cycle keeps
  // streaming to the new socket. On full teardown (no successor) it nulls.
  captured.attachment?.releaseSocket();
  captured.attentionGate?.dispose();
  captured.bargeInController?.dispose();
  captured.conversationFeedUnsub?.();
  captured.taskLifecycleUnsub?.();
  captured.preferenceUnsub?.();
  captured.preferenceAudioUnsub?.();
  captured.snapshotUnsub?.();
  // Unsubscribe SDK-frame listener BEFORE releasing the wire.
  captured.acpSdkFrameUnsub?.();
  // Release this attachment's ref on the pooled wire. The wire's lifetime is the
  // SURFACE's lifetime (D3): on a resumable disconnect this runs only from the
  // deferred teardown the buffer reap (sweepIdle @ session.idle_timeout_ms) fires
  // — never eagerly on transport close — so a reconnect within the grace window
  // reuses the warm child instead of respawning it. On full teardown it runs
  // immediately. The registry disposes the child when this drops the last ref.
  // Reuses the existing reap; no new TTL constant.
  captured.acpWireDispose?.();
  // Drop the surface's conversation anchor on the SAME reap that disposes the
  // wire (D3 invariant). Anchor lifetime == surface lifetime — without this the
  // anchors map grows unbounded as surfaces (web tabs / app installs) churn.
  captured.dropAnchor?.();

  if (captured.personSession && captured.attachment) {
    captured.personSession.detach(captured.attachment);
  }

  log.debug("session-hermes-release", { sessionId });
  services.sessionControls.unregister(sessionId);
  services.sessionRouter.release(sessionId);
  services.sessionManager.unbindUser(sessionId);
  services.sessionManager.removeSession(sessionId);
}

// ---------------------------------------------------------------------------
// Shared field helpers (capture / clear / stop)
// ---------------------------------------------------------------------------

/**
 * Stops all active adapters and clears the adapter slots on ws.data.
 * Called from both runResumableDisconnect and runFullTeardown.
 */
function stopAdapters(ws: ServerWebSocket<ClientData>, reason: string): void {
  for (const adapter of ws.data.adapters) {
    adapter.stop(reason).catch((err: unknown) => {
      log.error("adapter-stop-failed", { id: adapter.id, error: errorMessage(err, "unknown"), path: reason });
    });
  }
  ws.data.adapters = [];
  ws.data.audioAdapter = null;
  ws.data.textAdapter = null;
  ws.data.isStreaming = false;
}

/**
 * Snapshots the pipeline fields that teardownPipelineResources needs.
 * Called from BOTH runResumableDisconnect and runFullTeardown so the capture
 * list can never silently diverge between the two paths.
 */
function captureWsDataFields(ws: ServerWebSocket<ClientData>): CapturedPipelineResources {
  return {
    attentionGate: ws.data.attentionGate,
    bargeInController: ws.data.bargeInController,
    conversationFeedUnsub: ws.data.conversationFeedUnsub,
    taskLifecycleUnsub: ws.data.taskLifecycleUnsub,
    preferenceUnsub: ws.data.preferenceUnsub,
    preferenceAudioUnsub: ws.data.preferenceAudioUnsub,
    snapshotUnsub: ws.data.snapshotUnsub,
    acpSdkFrameUnsub: ws.data.acpSdkFrameUnsub,
    acpWireDispose: ws.data.acpWireDispose,
    dropAnchor: ws.data.dropAnchor,
    personSession: ws.data.personSession,
    attachment: ws.data.attachment,
  };
}

/**
 * Zeros out every ws.data field that belongs to the session pipeline.
 * Called from BOTH runResumableDisconnect and runFullTeardown after each path
 * has finished with (or handed off) the live references — prevents the dead
 * socket from holding stale captures.
 */
function clearWsDataFields(ws: ServerWebSocket<ClientData>): void {
  ws.data.attentionGate = null;
  ws.data.acpSdkFrameUnsub = null;
  ws.data.acpWireDispose = null;
  ws.data.dropAnchor = null;
  ws.data.bargeInController = null;
  ws.data.interruptController = null;
  ws.data.conversationFeedUnsub = null;
  ws.data.taskLifecycleUnsub = null;
  ws.data.preferenceUnsub = null;
  ws.data.preferenceAudioUnsub = null;
  ws.data.preferenceManager = null;
  ws.data.snapshotUnsub = null;
  ws.data.shortTermContext = null;
  ws.data.taskManager = null;
  ws.data.sessionsHandlers = null;
  ws.data.resumeSessionId = null;
  ws.data.conversationHistory?.clear();
  ws.data.conversationHistory = null;
  ws.data.personSession = null;
  ws.data.attachment = null;
  ws.data.activityClock = null;
  ws.data.sessionId = null;
}

// ---------------------------------------------------------------------------
// Resumable disconnect
// ---------------------------------------------------------------------------

/**
 * RESUMABLE DISCONNECT (transport close + stream.resume capability).
 *
 * - Stops input adapters (STT/mic) — dead socket, no more audio.
 * - Does NOT dispose the AttentionGate, ACP wire, session registrations, or
 *   the cycle-output pipeline — the in-flight Hermes cycle keeps running and
 *   its output frames keep flowing into the device buffer via the FrameSequencer
 *   (socket writes no-op on the dead socket per Task 3.5).
 * - Releases the device buffer (starts TTL clock) and stashes a deferred
 *   teardown closure that the retention sweep will run if the device never
 *   reconnects before the TTL expires.
 * - Clears the WS data fields for things we DID stop so the ws object is no
 *   longer a live reference to them (avoids stale captures after the socket
 *   is gone).
 */
function runResumableDisconnect(ws: ServerWebSocket<ClientData>, services: GatewayServices, sessionId: string): void {
  log.info("session-cleanup.resumable", { sessionId });

  // Clear auth timeout — no re-auth on dead socket.
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }

  // Stop INPUT adapters (STT / mic) — output-side pipeline stays alive.
  stopAdapters(ws, "resumable-disconnect");

  // Snapshot the live resources that must survive until the deferred teardown.
  // An idempotency guard (tornDown) ensures teardownPipelineResources runs at
  // most once even if the closure is somehow invoked twice.
  const captured = captureWsDataFields(ws);

  let tornDown = false;
  const deferredTeardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    log.info("session-cleanup.deferred-teardown", { sessionId });
    teardownPipelineResources(captured, services, sessionId);
  };

  // Release device buffer (start TTL) with the deferred teardown stashed.
  // If the device reconnects before the TTL, acquireDeviceBuffer clears the
  // deferredTeardown so it never fires.
  if (ws.data.personSession && ws.data.attachment) {
    ws.data.personSession.releaseDeviceBuffer(ws.data.attachment.attachmentId, deferredTeardown);
    // Keep personSession attached so the buffer retention check
    // (hasRetainedBuffers) correctly blocks session eviction during the TTL
    // window. Detach happens in teardownPipelineResources → deferredTeardown.
  }

  // The socket is dead — stop routing the device's live writes here. The
  // in-flight cycle keeps journaling into the buffer (replayed on resume); the
  // socket write no-ops until the next attachment re-registers on reconnect.
  ws.data.attachment?.releaseSocket();

  // Null out all pipeline fields so the dead socket holds no stale references.
  clearWsDataFields(ws);
}

// ---------------------------------------------------------------------------
// Full teardown
// ---------------------------------------------------------------------------

/**
 * FULL TEARDOWN (explicit session.end, or transport close without stream.resume).
 *
 * Disposes all session resources immediately: attention gate, ACP wire,
 * session registrations, and the device buffer entry.
 */
function runFullTeardown(ws: ServerWebSocket<ClientData>, services: GatewayServices, sessionId: string): void {
  log.info("session-cleanup.full", { sessionId });

  // Clear auth timeout if the session ends before auth completes.
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }

  stopAdapters(ws, "session-end");

  // Full teardown: dispose the device buffer entry immediately (no TTL).
  // This is the logout/session.end path — we don't want to retain the buffer.
  if (ws.data.personSession && ws.data.attachment) {
    ws.data.personSession.disposeDeviceBuffer(ws.data.attachment.attachmentId);
  }

  // Snapshot current ws.data fields and run the shared pipeline teardown
  // (gate, bargeIn, all unsubs, acp wire, personSession.detach, service calls).
  teardownPipelineResources(captureWsDataFields(ws), services, sessionId);

  // Null out all pipeline fields.
  clearWsDataFields(ws);
}
