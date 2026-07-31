import type { AudioPrefsPatch } from "@sentient/audio-prefs";
import { clientMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { handlePreferencesPatch } from "./handle-preferences-patch.js";
import { createSttSession } from "./stt-session.js";
import type { SttSession } from "./stt-session.js";
import { handleAuthMessage, scheduleAuthTimeout } from "./ws-auth-gate.js";
import type { SessionData } from "./ws-helpers.js";
import { sendError } from "./ws-helpers.js";
import { sendUnsequencedFrame } from "./ws-send.js";
import { handleSessionConfigure } from "./ws-session-configure.js";
import { handleSessionNew } from "./ws-session-new.js";

export type { SessionData };

export interface GatewayTlsMaterial {
  readonly cert: string;
  readonly key: string;
}

const log = getLog(["sentient", "ws"]);
const WS_NORMAL_CLOSURE = 1000;

// ---------------------------------------------------------------------------
// Session open — auth + session registration
// ---------------------------------------------------------------------------

// `sessionId` here is the CONNECTION id and nothing else — it dies with this
// socket. The durable conversation the store partitions on is resolved later,
// in `handleSessionConfigure`, and parked on `ws.data.conversationId`.
export function openSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
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
// Message routing.
//
// `text.input` and `interrupt` route to `ws.data.runtime` (a SessionRuntime,
// minted in ws-session-configure.ts), which drives the native ReAct loop and
// streams replies back through `WsTurnEmitter` (ws-turn-emitter.ts).
//
// Voice (Plan 3 Task 2, spec §6) adds the audio path: `audio.start` /
// `audio.end` drive this connection's `SttSession` (stt-session.ts), and
// INBOUND binary frames are mic audio forwarded to it. Inbound and outbound
// binary are separate paths — outbound TTS frames leave through the turn
// emitter, never through this router.
//
// Permission (Plan 3 Task 6, spec §7.1) adds the L3 confirm answer:
// `permission.response` routes into `ws.data.permissions`, the broker minted
// for THIS connection in ws-session-configure.ts. Connection scoping is the
// isolation boundary — a frame can only ever settle a prompt this same
// socket issued.
//
// `session.new` (defect D12) answers with `session.created` naming this
// connection's durable conversation — ws-session-new.ts. `conversation.activate`
// stays received-but-unhandled on purpose; the `default:` arm says why.
// ---------------------------------------------------------------------------

export async function handleWebSocketMessage(
  ws: ServerWebSocket<SessionData>,
  message: string | Buffer,
  services: GatewayServices,
): Promise<void> {
  // Inbound binary = mic audio → STT (spec §6). Never routed through the
  // outbound emitter. Dropped before auth completes: unauthenticated bytes
  // must not reach the STT service running on the operator's host.
  if (typeof message !== "string") {
    if (ws.data.authState !== "authed") {
      log.warn("binary-frame-preauth", {
        sessionId: ws.data.sessionId,
        byteSize: message.byteLength,
        reason: "audio frame arrived before auth completed",
      });
      return;
    }
    ws.data.stt?.pushFrame(message);
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
      // Validated, but deliberately NEITHER seq-stamped NOR journaled. A pong
      // is a transport-liveness ack with no payload: replaying a stale one
      // tells a reconnected client nothing (it re-pings on its own schedule),
      // and journaling a periodic keepalive would burn seq numbers and evict
      // real replayable content from the byte-capped journal. Same class as
      // `stream.resumed` — see ws-send.ts's header.
      sendUnsequencedFrame(ws, { type: "pong" });
      return;

    case "session.configure":
      // Resume params ride INSIDE the configure frame (msg.resume) — the
      // handler acquires this surface's frame journal and answers with the
      // stream.resumed decision (Plan 3 Task 10, see ws-session-configure.ts).
      // `msg.conversationId` is the client's optional anchor for the DURABLE
      // conversation; the handler validates it against this principal and
      // resolves the store partition from it (or from the surface).
      handleSessionConfigure(
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

    case "session.end":
      handleSessionEnd(ws, services);
      return;

    case "text.input":
      if (!ws.data.runtime) {
        log.warn("text.input.no-runtime", {
          sessionId: ws.data.sessionId,
          reason: "orchestrator unconfigured, or session.configure has not run / failed to mint a runtime",
        });
        sendError(ws, "orchestrator_unavailable", "Native orchestrator is not available for this session");
        return;
      }
      // `pendingId` is threaded, NOT acted on here: the idempotency decision
      // belongs where the store append happens (SessionRuntime), so a resend
      // is recorded and re-echoed rather than silently swallowed by the router.
      ws.data.runtime.submit({
        kind: "conversational",
        text: msg.text,
        ...(msg.pendingId === undefined ? {} : { pendingId: msg.pendingId }),
      });
      return;

    case "interrupt":
      // No-op (not an error) if idle or the orchestrator is unconfigured —
      // interrupt is idempotent and there is nothing to cancel.
      ws.data.runtime?.interrupt();
      return;

    case "audio.start":
      // The mic opened. Lazily dial STT (a text-only session never does) and
      // relay the client's turn authority (manual = hold-to-talk).
      ensureSttSession(ws, services)?.start(msg.turnMode);
      return;

    case "audio.end":
      // PTT release / mic off — force-finalize any open STT turn now.
      ws.data.stt?.end();
      return;

    case "permission.response":
      // Fail-closed by construction: an unknown/duplicate/expired requestId
      // just returns false here — the PDP already denied (or is about to
      // auto-deny) and nothing is re-opened. Only a prompt THIS connection
      // issued can be settled, so a frame naming another user's requestId
      // resolves nothing.
      if (!ws.data.permissions?.resolve(msg.requestId, msg.approved)) {
        log.warn("permission.response.unmatched", {
          sessionId: ws.data.sessionId,
          requestId: msg.requestId,
          reason: "no pending permission prompt on this connection for that requestId",
        });
      }
      return;

    case "session.new":
      // Answered with this connection's DURABLE conversation id, not a freshly
      // minted partition — see ws-session-new.ts for why forking here would
      // hand every mobile relaunch an empty conversation.
      handleSessionNew(ws, msg.requestId);
      return;

    case "user.preferences.patch":
      // The in-chat mute toggle. Detached on purpose: the frame is
      // fire-and-forget on all three SDKs (none reads a reply), and a profile
      // write must not hold the router. The handler never throws — see
      // handle-preferences-patch.ts.
      applyPreferencesPatch(ws, services, msg.payload);
      return;

    default:
      // `conversation.activate` is deliberately LEFT UNANSWERED, and it is not
      // the same call as session.new above.
      //
      // Its only reply frame is `session.switched`, and both client SDKs read
      // that frame as "your conversation changed — refetch history over
      // `GET /sessions/:id/messages`". This gateway does not serve that route
      // (sessions CRUD is deferred with multi-conversation, docs/native-todo.md
      // § 2), and mobile's fetch-failure branch is
      // `SdkConnectors.loadHistoryForSession` → `replaceMirror(emptyList())`.
      // So answering would WIPE THE VISIBLE CHAT — and not only on a user's
      // switch: `SentientSdk.reestablishAnchoredSession` fires an activate on
      // every reconnect that carries an anchor without a resume cursor, so the
      // wipe would land on ordinary reconnects too.
      //
      // Unhandled costs nothing here: the gateway re-anchors the conversation
      // from `session.configure.conversationId` on that same reconnect, which
      // is the path that actually restores the thread. This arm becomes
      // answerable when the history route lands, not before.
      log.debug("message-unhandled", {
        type: msg.type,
        reason: "session.switched would trigger a client history refetch against an unserved REST route",
      });
      return;
  }
}

/**
 * Lazily mints this connection's STT uplink on the first `audio.start`.
 * Returns null when the gateway has no `stt:` config block at all — a
 * text-capable deployment, not an error. The runtime is read through a
 * getter, not captured, so a re-`session.configure` that re-mints
 * `ws.data.runtime` cannot strand transcripts on a dead runtime.
 */
function ensureSttSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): SttSession | null {
  if (ws.data.stt) return ws.data.stt;
  if (!services.stt) {
    log.warn("audio.start.no-stt", { sessionId: ws.data.sessionId, reason: "no stt: block in config.yaml" });
    return null;
  }
  const session = createSttSession({
    sessionId: ws.data.sessionId ?? "unbound",
    factory: services.stt.adapterFactory,
    config: services.stt.adapterConfig,
    getRuntime: () => ws.data.runtime,
  });
  ws.data.stt = session;
  log.info("stt-session-created", { sessionId: ws.data.sessionId });
  return session;
}

/**
 * Persist + live-apply one audio-preference patch for THIS connection's user.
 *
 * The router already gated on `authState === "authed"`, so the principal is
 * set; the guard exists so a future reordering can never turn a missing
 * principal into a write against an empty user id.
 */
function applyPreferencesPatch(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  patch: AudioPrefsPatch,
): void {
  const principal = ws.data.principal;
  if (!principal) {
    log.warn("user.preferences.patch.no-principal", {
      sessionId: ws.data.sessionId,
      reason: "authed connection without a principal — refusing to write a profile",
    });
    return;
  }
  void handlePreferencesPatch(
    {
      profileStore: services.profileStore,
      voicePrefs: ws.data.voicePrefs,
      userId: principal.userId,
      sessionId: ws.data.sessionId ?? "unbound",
    },
    patch,
  );
}

// ---------------------------------------------------------------------------
// Session end + cleanup
// ---------------------------------------------------------------------------

function handleSessionEnd(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
  if (!ws.data.sessionId) return;
  // Explicit end: discard rather than park. Clearing the lease here also
  // stops cleanupSession below from re-releasing an entry that no longer
  // exists. The registry ignores the discard outright if a newer connection
  // has since taken this surface over.
  if (ws.data.replayLease !== null) {
    services.replayRegistry.discard(ws.data.replayLease);
    ws.data.replayLease = null;
  }
  cleanupSession(ws, services);
  ws.close(WS_NORMAL_CLOSURE, "Session ended");
}

/**
 * Tears down the connection-tracking state this file owns: the auth
 * timeout, the SessionManager registration, the per-session `SessionRuntime`
 * and `PermissionBroker` minted in ws-session-configure.ts, and (Plan 3
 * Task 2) this connection's `SttSession` — closing it aborts its event
 * stream and releases the socket to the STT service, which no other owner
 * would ever do.
 * `runtime.dispose()` aborts any in-flight turn's AbortSignal and closes
 * the session's store handle — idempotent, so a socket that never reached
 * session.configure (runtime still null) is unaffected.
 * A fresh connection always mints a fresh runtime over the SAME durable
 * conversation partition — `ws.data.conversationId` is derived from the
 * principal + the client's surface id, so the next connection re-derives it
 * and the store hands the committed feed and the model's history straight
 * back (ws-session-configure.ts). Only the handle is torn down here; nothing
 * in the store is. That shared partition is why this connection's claim on
 * `services.conversationRuntimes` goes back here too.
 * The other thing that survives the disconnect is this surface's outbound
 * frame journal, parked in
 * `services.replayRegistry` for `session.replay_journal_retention_ms` so a
 * reconnect carrying `resume: {epoch, lastSeq}` can replay the frames the
 * client missed (Plan 3 Task 10). The in-flight turn is not resumed — it is
 * aborted by `dispose()` — only the already-emitted frames are.
 */
export function cleanupSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
  const sessionId = ws.data.sessionId;
  if (!sessionId) return;

  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }

  // Settle every open permission prompt BEFORE disposing the runtime: each
  // one is a promise the ReAct loop is awaiting inside `broker.dispatch`,
  // and an unsettled one would keep that turn parked for the full
  // permission timeout after the socket is already gone.
  ws.data.permissions?.denyAll();
  ws.data.permissions = null;

  ws.data.runtime?.dispose();
  ws.data.runtime = null;

  // Hand this conversation's live-runtime claim back. Connection-guarded
  // inside the registry: a socket that was already SUPERSEDED on this
  // conversation (a reload whose new session.configure beat this close) must
  // not deregister — or tear down — the connection that replaced it.
  if (ws.data.conversationId !== null) {
    services.conversationRuntimes.release(ws.data.conversationId, sessionId);
  }

  // Detach the frame journal LAST, after the runtime has been disposed:
  // dispose() is synchronous, and anything it still writes to this socket
  // must land in the journal so a reconnecting client replays it. The
  // journal OBJECT survives in the registry for the retention window; only
  // this connection's handle on it is cleared. Lease-guarded: if a newer
  // connection already took this surface over (a reload whose configure beat
  // this close), the release is a no-op instead of starting a retention
  // countdown under the live connection's journal.
  if (ws.data.replayLease !== null) {
    services.replayRegistry.release(ws.data.replayLease);
    ws.data.replayLease = null;
  }
  ws.data.journal = null;
  ws.data.epoch = 0;

  ws.data.stt?.close();
  ws.data.stt = null;

  services.sessionManager.unbindUser(sessionId);
  services.sessionManager.removeSession(sessionId);
  const conversationId = ws.data.conversationId;
  ws.data.sessionId = null;
  ws.data.conversationId = null;

  log.info("session-cleanup", { sessionId, conversationId });
}
