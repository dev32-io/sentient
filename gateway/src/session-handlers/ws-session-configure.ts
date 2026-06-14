import { homedir } from "node:os";
import type { HermesAcpWire } from "@sentient/config";
import type { ClientType, SessionConfigureResume } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { Adapter } from "../adapters/adapter-types.js";
import type { STTAdapterConfig } from "../adapters/stt/stt-adapter-types.js";
import type { UserAudioInputAdapter } from "../adapters/user-audio-input-adapter.js";
import { createUserAudioInputAdapter } from "../adapters/user-audio-input-adapter.js";
import { createUserTextInputAdapter } from "../adapters/user-text-input-adapter.js";
import { DASHBOARD_PORT_OFFSET } from "../admin/supervisord-control.js";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { buildHttpBaseUrlForUser, buildWsUrlForUser } from "../bootstrap/hermes-connection-helpers.js";
import { createAttentionGate } from "../cerebrum/attention-gate.js";
import type { AttentionGateConfig } from "../cerebrum/attention-gate.js";
import { toFeed, toFeedItem } from "../cerebrum/conversation-feed.js";
import { createConversationMirror } from "../cerebrum/conversation-mirror.js";
import type { ConversationMirror } from "../cerebrum/conversation-mirror.js";
import type { HermesProfileBinding } from "../cerebrum/hermes-client.js";
import type { HermesDispatcherDeps } from "../cerebrum/hermes-dispatcher.js";
import { dispatchHermesCycle } from "../cerebrum/hermes-dispatcher.js";
import type { DispatchMode } from "../cerebrum/hermes-event-types.js";
import type { PreferenceLanguage, SessionPreferences } from "../cerebrum/preferences.js";
import { createPreferenceManager } from "../cerebrum/preferences.js";
import { createShortTermContext } from "../cerebrum/short-term-context.js";
import { createTaskMirror } from "../cerebrum/task-mirror.js";
import { createAcpHermesClient } from "../hermes-adapter-client/acp-hermes-client.js";
import type { AcpWireHandle, AcpWireRegistry } from "../hermes-adapter-client/acp-wire-registry.js";
import type { AcpPerProfileConnection } from "../hermes-adapter-client/per-profile-connection.js";
import type { SentientPluginClient } from "../hermes-adapter-client/plugin-client.js";
import { buildPluginBaseUrl, createSentientPluginClient } from "../hermes-adapter-client/plugin-client.js";
import { listSessionsViaAcp } from "../hermes-adapter-client/sessions-client.js";
import { bootstrapAcpWire } from "../hermes-adapter-client/wire-bootstrap.js";
import { getLog } from "../logging/logger.js";
import { createDeviceAttachment } from "../person-session/device-attachment.js";
import { hermesMessageToMirrorEntry } from "../sessions/hermes-message-to-mirror.js";
import { migrateLegacyTitles } from "../sessions/storage-migrator.js";
import { createSwitchFlow } from "../sessions/switch-flow.js";
import { createTitleStore } from "../sessions/title-store.js";
import { createEmojiStripper } from "../tts/stages/emoji-stripper.js";
import { createMarkdownStripper } from "../tts/stages/markdown-stripper.js";
import { type TtsChunk, composeTextStages } from "../tts/stages/stage-types.js";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.js";
import { createAbortSlot } from "./abort-slot.js";
import { drainAudioToWs } from "./audio-frame-sender.js";
import { createBargeInController } from "./barge-in-controller.js";
import { createInterruptController } from "./interrupt-controller.js";
import { buildMicSuppressionOptions, createMicEchoGuard } from "./mic-echo-guard.js";
import { createSessionAudioWire } from "./session-audio-wire.js";
import { createSessionsHandlers } from "./sessions-handlers.js";
import type { SurfaceCycleRegistry } from "./surface-cycle-registry.js";
import { ttsSkipReason } from "./tts-policy.js";
import type { ClientData } from "./ws-helpers.js";
import { errorMessage, sendError } from "./ws-helpers.js";
import { type ResumeParams, handleResumeOrFresh } from "./ws-resume-handover.js";

// Resolve a config-supplied path that may start with "~/" against the
// gateway user's $HOME. Tilde-prefixed values come straight from YAML;
// anything else is returned unchanged so absolute and env-derived paths
// work without surprise.
function expandHome(rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return `${homedir()}/${rawPath.slice(2)}`;
  return rawPath;
}

const log = getLog(["sentient", "ws", "session-configure"]);

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 48000;
const AUDIO_ENCODING = "pcm16";
// Normal WS closure code (RFC 6455 1000). Local copy to avoid a circular import
// from ws-handlers, which imports handleSessionConfigure from this file.
const WS_NORMAL_CLOSURE = 1000;

// ---------------------------------------------------------------------------
// Session configure — Hermes dispatch wiring
// ---------------------------------------------------------------------------

export async function handleSessionConfigure(
  ws: ServerWebSocket<ClientData>,
  capabilities: readonly string[],
  language: "en" | "zh",
  services: GatewayServices,
  clientType: ClientType,
  configureDeviceId: string,
  configureSurfaceId: string | undefined,
  configureResume: SessionConfigureResume | undefined,
  configureConversationId: string | undefined,
): Promise<void> {
  const sessionId = ws.data.sessionId;
  if (!sessionId) {
    sendError(ws, "protocol_error", "No active session");
    return;
  }
  const userId = ws.data.userId;
  if (!userId) {
    log.warn("session-configure-no-user", { sessionId, reason: "auth gate must set ws.data.userId" });
    sendError(ws, "protocol_error", "Session not authenticated");
    return;
  }

  const capSet = new Set(capabilities);
  ws.data.grantedCapabilities = capSet;
  ws.data.clientType = clientType;

  const salienceMap = services.salienceMap ?? { lookup: () => ({}) };
  const taskMirror = createTaskMirror();
  ws.data.taskManager = taskMirror;

  const taskTableWindow = services.cerebrum.task_table.window;
  const shortTermContext = createShortTermContext(sessionId, salienceMap, {
    taskMirror,
    taskTableWindow,
  });
  ws.data.shortTermContext = shortTermContext;

  const conversationMirror = createConversationMirror(services.cerebrum.conversation_history.max_entries);
  ws.data.conversationHistory = conversationMirror;

  // Egress proxy — all outbound push frames route through this pair of
  // closures. The inner target starts as a direct ws.send fallback so the
  // early setup paths (preferences seed, session.ready) that emit before
  // the FrameSequencer attachment is built still work. Once the attachment
  // is constructed (below), the target is replaced with attachment.send /
  // attachment.sendBinary so everything from that point is seq/epoch-stamped
  // and journaled into the per-device replay buffer.
  let egressSend: (msg: unknown) => void = (msg) => {
    ws.send(JSON.stringify(msg));
  };
  let egressSendBinary: (data: Uint8Array) => void = (data) => {
    ws.send(data);
  };
  // stable capture; egressSend/egressSendBinary are retargeted to attachment.send below
  const wsSend = (msg: unknown): void => egressSend(msg);
  const wsSendBinary = (data: Uint8Array): void => egressSendBinary(data);

  // Conversation feed: the HermesEventTranslator emits conversation.entry for
  // assistant/tool entries it produces. User and trigger entries (from
  // adapters + sensors) don't flow through the translator — mirror onAppend
  // fills that gap so the client's committed history stays in step with the
  // server's. AttentionGate also subscribes to the same mirror for wake logic.
  const conversationFeedUnsub = conversationMirror.onAppend((entry) => {
    if (entry.kind !== "user" && entry.kind !== "trigger") return;
    const preview = entry.kind === "user" ? entry.content.slice(0, 80) : entry.summary.slice(0, 80);
    log.debug("wire.conversation.entry", {
      sessionId,
      kind: entry.kind,
      preview,
    });
    wsSend({ type: "conversation.entry", item: toFeedItem(entry) });
  });
  ws.data.conversationFeedUnsub = conversationFeedUnsub;

  // Hermes dispatcher deps — wired below after the gate is created.
  // The gate's onCycle callback closes over these.
  const cycleSlot = createAbortSlot("cycle");
  const wire = createSessionAudioWire({ wsSend });

  // Gateway-minted session id awaiting attachment to the next outbound
  // user.message. Set by the `session.new` handler (see sessionsHandlers
  // wiring below); consumed-once in onCycle so subsequent cycles fall
  // back to Hermes' default per-tuple keying.
  let pendingNewSessionId: string | null = null;
  // Pre-warm path: when the user clicks "+ New chat", session.new kicks
  // `acpConn.newSession` as a background task and stashes the in-flight
  // Promise here. If the user types and sends BEFORE the Promise resolves,
  // onCycle awaits it once and consumes. Hides ACP cold-start latency
  // (model probe + MCP handshake) behind the user's typing time. Cleared
  // alongside pendingNewSessionId after consumption.
  let pendingNewSessionPromise: Promise<string> | null = null;

  // Bind session to the auth-derived userId at session start (instead of
  // per-cycle) so identify_user's findActiveSessionFor can resolve from
  // turn 1, and so the conversationId captured by a prior cycle is reused
  // by the next one.
  let initialBinding: HermesProfileBinding;
  try {
    initialBinding = await services.sessionRouter.bind(sessionId, userId);
  } catch (err) {
    log.error("session-bind-failed", { sessionId, userId, reason: errorMessage(err, "unknown") });
    sendError(ws, "protocol_error", "Session binding failed");
    return;
  }
  log.info("session-hermes-bound", {
    sessionId,
    userId: initialBinding.userId,
    hermesUrl: initialBinding.url,
  });

  // Attach this WS to the user's PersonSession. The registry creates one
  // per userId on first attachment; subsequent attachments reuse it. State
  // still lives per-WS today (B2 scope); attachment is bookkeeping that
  // gives B3/B4 a handle to migrate ownership to.
  const personSession = await services.personSessions.getOrCreate(initialBinding.userId);
  if (!personSession) {
    log.error("person-session-create-failed", { sessionId, userId });
    sendError(ws, "protocol_error", "Person session create failed");
    return;
  }
  // Task 3.8 — stable deviceId keys the per-device buffer across reconnects.
  // The client supplies it on session.configure; the resume request now rides
  // INSIDE that same frame (configureResume), so the resume decision is a
  // synchronous read off the parsed configure message — no separate frame, no
  // same-tick ordering race. When resumeParams carries a matching epoch,
  // acquire REUSES the prior buffer (resumed:true) so the new FrameSequencer
  // continues the same seq counter — seq continuity across reconnect.
  const resumeParams: ResumeParams | null = configureResume
    ? { epoch: configureResume.epoch, lastSeq: configureResume.lastSeq, deviceId: configureDeviceId }
    : null;
  const deviceId = configureDeviceId;
  // Surface key — the unit of session isolation. Old clients omit surfaceId →
  // fall back to deviceId (today's per-device behavior, spec §4).
  const surfaceId = configureSurfaceId ?? deviceId;
  log.info("session-configure.surface", {
    sessionId,
    surfaceId,
    deviceId,
    surfaceFromConfigure: configureSurfaceId !== undefined,
  });
  const acquired = personSession.acquireDeviceBuffer(surfaceId, {
    deviceId,
    ...(resumeParams ? { resumeEpoch: resumeParams.epoch } : {}),
  });
  const { buffer: deviceBuffer, epoch: deviceEpoch, resumed: deviceResumed, liveSocket: deviceLiveSocket } = acquired;

  // ACP WIRE — acquired BEFORE the handover (order is load-bearing). The wire
  // is pooled per-user and ref-counted; on a resume the OLD pipeline still holds
  // a ref (the in-flight Hermes cycle is streaming on it). Acquiring here REUSES
  // that wire (refcount 1→2) so when the handover below releases the old ref
  // (2→1) the wire never hits 0 — it is NOT disposed, and the in-flight cycle is
  // NOT killed. The gateway keeps receiving the cycle's output (final answer +
  // cycle.done) and streams it to the resumed socket. On a fresh connect there
  // is no handover, so this just dials/reuses normally — order is immaterial.
  let resolvedWsUrl: string;
  try {
    resolvedWsUrl = await buildWsUrlForUser(services.hermes, services.userPortStore, initialBinding.userId);
  } catch (err: unknown) {
    log.error("acp.ws-url-resolve-failed", {
      sessionId,
      userId: initialBinding.userId,
      reason: errorMessage(err, "unknown"),
    });
    sendError(ws, "protocol_error", "Cannot resolve Hermes WS URL");
    return;
  }
  const acpConn = await acquireAcpWireOrFail({
    sessionId,
    userId: initialBinding.userId,
    surfaceId,
    registry: services.acpWireRegistry,
    wsUrl: resolvedWsUrl,
    token: initialBinding.apiKey,
    acpWire: services.hermes?.acp_wire,
    setDispose: (fn) => {
      ws.data.acpWireDispose = fn;
    },
  });
  if (acpConn === null) {
    sendError(ws, "protocol_error", "Cannot reach Hermes ACP wire");
    return;
  }

  // HANDOVER (Task 3.8): a matching-epoch resume hands back the deferred
  // teardown stashed by the prior resumable disconnect (Task 3.7). Run it NOW
  // to dispose the orphaned OLD pipeline (gate / sessionManager entry /
  // translator) and RELEASE its wire ref. Because we acquired the wire ABOVE,
  // that release drops refcount 2→1 — the wire and the in-flight cycle on it
  // SURVIVE the handover (instead of being disposed mid-flight). acquire already
  // detached the teardown from the entry so the retention sweep can never re-run it.
  if (acquired.priorDeferredTeardown !== null) {
    log.info("resume.handover-old-pipeline", { sessionId, surfaceId, epoch: deviceEpoch });
    acquired.priorDeferredTeardown();
  }

  // attachmentId is the resolved surfaceId — it keys the per-surface replay
  // buffer (DeviceBufferStore is keyed by surfaceId), so the resumable-disconnect
  // path in ws-handlers (releaseDeviceBuffer / bufferFor / disposeDeviceBuffer
  // keyed by attachment.attachmentId) addresses the correct buffer across
  // reconnects. The carried deviceId is for device-presence tracking only.
  // sessionId stays the per-WS id used for sessionRouter / Manager / Controls.
  // Creating the attachment registers THIS socket as the surface's current live
  // writer (deviceLiveSocket.current). Runs AFTER the handover above, so on a
  // resume it deliberately takes over from the old attachment — the in-flight
  // cycle's old sequencer (sharing this ref) now writes to the new socket.
  const attachment = createDeviceAttachment<ClientData>({
    attachmentId: surfaceId,
    deviceId,
    ws,
    sessionId,
    profile: personSession.profile,
    buffer: deviceBuffer,
    epoch: deviceEpoch,
    liveSocket: deviceLiveSocket,
    clock: acquired.clock,
  });
  personSession.attach(attachment);
  personSession.setForceClose(surfaceId, () => ws.close(WS_NORMAL_CLOSURE, "idle-timeout"));
  ws.data.personSession = personSession;
  ws.data.attachment = attachment;
  ws.data.activityClock = acquired.clock;

  // Live-socket activation is DEFERRED on a matching-epoch resume: the new
  // socket must not receive any frame until AFTER the replay window flushes
  // (else an in-flight cycle frame outruns the replay and poisons the client
  // cursor). For every other path (fresh, no-resume, or epoch-mismatch fresh
  // buffer) there is no replay window, so go live now — the configure handshake
  // (session.ready / prefs / snapshot) writes through this socket.
  const isResumeAttempt = resumeParams !== null && deviceResumed;
  if (!isResumeAttempt) attachment.goLive();

  // Route all subsequent outbound push frames through the FrameSequencer so
  // they are seq/epoch-stamped and journaled before the socket write. Everything
  // after this point — preferences seed, session.ready, Hermes cycle frames,
  // audio frames — flows through the attachment. Frames emitted before this
  // point (auth-handshake, protocol errors) are raw ws.send; those happen
  // before the device buffer exists and cannot be replayed — acceptable.
  // one-time retarget: all push frames now flow through the per-device FrameSequencer
  egressSend = (msg) => attachment.send(msg);
  egressSendBinary = (data) => attachment.sendBinary(data);

  // Seed session preferences from the user's profile.audio so the entry-gate
  // ttsEnabled check (below) and the channel mid-stream gate honor the
  // user's saved settings. Falls through to schema defaults
  // ({ttsEnabled: true, channel: "voice"}) when profile is missing — safe
  // first-time-user behavior.
  const profileResult = await services.profileStore.get(initialBinding.userId);
  const audioPrefs = profileResult.ok ? profileResult.value.audio : { ttsEnabled: true, channel: "voice" as const };
  if (!profileResult.ok) {
    log.warn("preferences-init.profile-fallback", {
      sessionId,
      userId: initialBinding.userId,
      reason: "profile-read-failed",
    });
  }
  const preferenceManager = createPreferenceManager({
    initial: {
      language: language as PreferenceLanguage,
      channel: audioPrefs.channel,
      ttsEnabled: audioPrefs.ttsEnabled,
    },
  });
  ws.data.preferenceManager = preferenceManager;
  log.info("preferences-initial", {
    sessionId,
    preferences: preferenceManager.get(),
  });

  // Mirror audio-pref changes to the WS client so the UI can reflect state
  // without polling. Language is internal (drives STT reconfigure) — only
  // ttsEnabled + channel are part of the user-facing wire surface.
  const preferenceAudioUnsub = preferenceManager.onChange((next, _prev, changed) => {
    const audioChanged = changed.includes("ttsEnabled") || changed.includes("channel");
    if (!audioChanged) return;
    wsSend({
      type: "session.preferences.changed",
      preferences: {
        ttsEnabled: next.ttsEnabled,
        channel: next.channel,
      },
    });
    log.debug("preferences-emit", {
      sessionId,
      ttsEnabled: next.ttsEnabled,
      channel: next.channel,
    });
  });
  ws.data.preferenceAudioUnsub = preferenceAudioUnsub;

  // NOTE: the initial session.preferences.changed SEED is emitted in the
  // fresh-only block below (co-located with session.ready), NOT here.
  // On a successful resume (recovered:true), the prior connection's journaled
  // session.preferences.changed frame is already in the replay window and is
  // replayed verbatim — no re-seed needed. Seeding here would cause a
  // double-send: once live AND once via replay.

  // Register MCP control surface. MCP tools (update_user_settings, ...)
  // look up this session's controls by sessionId and mutate per-session
  // state directly — no global broadcasts, no cross-session reach.
  services.sessionControls.register(sessionId, {
    async updateUserSettings(_sid, settingsUserId, patch) {
      // 1. Persist to the profile store. ttsEnabled + channel land in
      //    profile.audio; voice/model are top-level. Persistent fields
      //    only — language is a session-scoped value (not on the profile).
      if (
        patch.ttsEnabled !== undefined ||
        patch.channel !== undefined ||
        patch.voice !== undefined ||
        patch.model !== undefined
      ) {
        const cur = await services.profileStore.get(settingsUserId);
        if (cur.ok) {
          const nextProfile = {
            ...cur.value,
            audio: {
              ttsEnabled: patch.ttsEnabled ?? cur.value.audio.ttsEnabled,
              channel: patch.channel ?? cur.value.audio.channel,
            },
            voice: patch.voice ?? cur.value.voice,
            model: patch.model ?? cur.value.model,
          };
          const saved = await services.profileStore.save(nextProfile);
          if (!saved.ok) {
            log.warn("update-user-settings.profile-save-failed", {
              sessionId,
              userId: settingsUserId,
              error: saved.error,
            });
          }
        } else {
          log.warn("update-user-settings.profile-read-failed", {
            sessionId,
            userId: settingsUserId,
            error: cur.error,
          });
        }
      }
      // 2. Apply audio fields to the live PreferenceManager so the next
      //    cycle's entry gate and the mid-stream channel gate see them.
      //    voice/model do NOT hot-swap mid-session — they take effect on
      //    next session (PreferenceManager doesn't carry them).
      const prefPatch: { channel?: "voice" | "text"; ttsEnabled?: boolean } = {};
      if (patch.channel !== undefined) prefPatch.channel = patch.channel;
      if (patch.ttsEnabled !== undefined) prefPatch.ttsEnabled = patch.ttsEnabled;
      if (Object.keys(prefPatch).length > 0) {
        preferenceManager.update(prefPatch);
      }
    },
  });

  // Forward-ref: InterruptController needs the gate, but the gate's onCycle
  // closes over interruptController. Proxy bridges the cycle.
  const attentionGateProxy = {
    _gate: null as { clearPendingConversationSalience(): void } | null,
    clearPendingConversationSalience(): void {
      this._gate?.clearPendingConversationSalience();
    },
  };

  // Holds the currently running TTS controller so bargeInController can cancel
  // TTS independently of the Hermes cycle.
  const currentTts: { cancel: (() => void) | null } = { cancel: null };

  // Mic echo guard: ramps STT energy threshold up/down around TTS playback.
  // Prevents own-audio from being picked up as phantom user speech.
  const micEchoGuard = createMicEchoGuard(() => ws.data.audioAdapter, buildMicSuppressionOptions(services), sessionId);

  const bargeInController = createBargeInController({
    taskMirror,
    wire,
    currentCycleId: () => cycleSlot.currentId(),
    cancelTts: () => currentTts.cancel?.(),
  });

  const interruptController = createInterruptController({
    cycleSlot,
    taskMirror,
    wire,
    attentionGate: attentionGateProxy,
  });

  ws.data.bargeInController = bargeInController;
  ws.data.interruptController = interruptController;

  // Build Hermes dispatcher deps. TTS is optional (null when no Fish Audio key).
  // The cycle's AbortController is owned by `onCycle` below; `startTts` uses a
  // LOCAL controller so barge-in can cut audio without aborting the Hermes
  // fetch (cycle survives a barge-in per spec v4 §5.9). Interrupt cancels the
  // cycle controller; we link it so the TTS controller also aborts.
  //
  // Per-user voice: PersonSession.voiceId is hydrated in the background by
  // the registry from profile.json#voice.id on getOrCreate. The getter
  // below re-evaluates per TTS turn, so by the time the user actually
  // speaks (≫ a profile-read ms), the right voiceId is in place. Falls
  // back to the gateway-wide default when null.
  const synthesizer: TextStreamSynthesizer | null = services.createSynthesizerFor(() => personSession.voiceId);
  const stripChain = composeTextStages(createMarkdownStripper(), createEmojiStripper());

  // Route `session/update` notifications carrying out-of-band SDK frames
  // (sessions.renamed, commands.available) directly to the client. The cycle
  // stream consumes the same notifications inside AcpHermesClient — multiple
  // subscribers per acpConn.onEvent is supported.
  //
  // The acpConn is now POOLED across attachments, so this per-WS handler must
  // be unsubscribed on cleanup — otherwise a detached client's closed socket
  // keeps receiving frames for the lifetime of the shared wire.
  const sdkFrameUnsub = acpConn.onEvent((evt) => {
    if (evt.type === "sessions.renamed") {
      wsSend({
        type: "sessions.renamed",
        sessionId: evt.sessionId,
        title: evt.title,
        source: evt.source,
      });
    } else if (evt.type === "commands.available") {
      wsSend({ type: "commands.available", commands: evt.commands });
    }
  });
  ws.data.acpSdkFrameUnsub = sdkFrameUnsub;

  const hermesDeps: HermesDispatcherDeps = {
    clientFor: () => createAcpHermesClient({ acpConn, onActivity: (source) => acquired.clock.touch(source) }),
    mirror: conversationMirror,
    tasks: taskMirror,
    emit: wsSend,
    ...(synthesizer
      ? {
          startTts: (deltas: AsyncIterable<TtsChunk>, cycleId: string) => {
            // Channel gate — checked PER chunk, not just at startTts entry.
            // Hermes' multi-cycle protocol (update_user_settings({channel:
            // "text"}) runs as a mid-cycle MCP tool call) means the agent
            // can flip the preference between text.delta frames; without
            // per-chunk gating, the post-flip messages of the same cycle
            // still flow to TTS. See gateway TTS UX bug 2026-04-26.
            //
            // Initial check at entry: if channel is already text, drain
            // and skip TTS pipeline init entirely (no audio context, no
            // mic-echo-guard cooldown).
            const initialPrefs = preferenceManager.get();
            const skipReason = ttsSkipReason({
              clientType: ws.data.clientType,
              channel: initialPrefs.channel,
              ttsEnabled: initialPrefs.ttsEnabled,
            });
            if (skipReason !== null) {
              log.info("tts.skip.audio-prefs", {
                sessionId,
                cycleId,
                when: "startTts-entry",
                reason: skipReason,
                clientType: ws.data.clientType,
                channel: initialPrefs.channel,
                ttsEnabled: initialPrefs.ttsEnabled,
              });
              const drain = (async () => {
                for await (const _ of deltas) {
                  /* drop */
                }
              })();
              return { done: drain, cancel: () => {} };
            }
            log.info("tts.start", { sessionId, cycleId });
            const ttsController = new AbortController();
            const cycleCtrl = cycleSlot.currentController();
            // Link cycle abort to TTS: interrupt cancels cycle, which also
            // cancels TTS. Barge-in cancels TTS only (local controller).
            if (cycleCtrl !== null) {
              cycleCtrl.signal.addEventListener(
                "abort",
                () => {
                  try {
                    ttsController.abort(cycleCtrl.signal.reason);
                    log.debug("tts.propagate-cycle-abort", { sessionId, cycleId });
                  } catch {
                    /* already aborted */
                  }
                },
                { once: true },
              );
            }
            currentTts.cancel = () => {
              log.info("tts.cancel", { sessionId, cycleId, reason: "barge-in" });
              ttsController.abort("barge-in");
            };

            // Mid-stream channel gate. Each chunk re-reads the preference
            // so an update_user_settings({channel:"text"}) call between
            // assistant.message frames immediately stops the rest of the
            // cycle from being spoken. Already-queued audio drains past
            // this point — to also kill in-flight playback the agent would
            // call pause_audio (separate tool, separate path).
            //
            // NOTE: ttsEnabled is intentionally NOT checked here. Per spec,
            // ttsEnabled is a "next time" setting — current cycle finishes,
            // next cycle's entry gate enforces the new value.
            async function* gateByChannel(src: AsyncIterable<TtsChunk>): AsyncIterable<TtsChunk> {
              for await (const chunk of src) {
                if (preferenceManager.get().channel !== "voice") {
                  log.info("tts.skip.channel-text", { sessionId, cycleId, when: "mid-stream" });
                  ttsController.abort("channel-text");
                  return;
                }
                yield chunk;
              }
            }
            const stripped = stripChain(gateByChannel(deltas), ttsController.signal);
            const audioStream = synthesizer.synthesize(stripped, ttsController.signal);
            const done = drainAudioToWs(
              audioStream,
              cycleId,
              sessionId,
              wsSend,
              wsSendBinary,
              ttsController.signal,
              micEchoGuard,
            ).finally(() => {
              if (currentTts.cancel !== null) currentTts.cancel = null;
            });
            return {
              done,
              cancel: () => {
                log.debug("tts.cancel-via-handle", { sessionId, cycleId });
                ttsController.abort("tts-cancel");
              },
            };
          },
        }
      : {}),
  };

  const gateConfig = buildGateConfig(services);
  const gate = createAttentionGate(
    shortTermContext,
    gateConfig,
    {
      onCycle: async (params) => {
        const binding = services.sessionRouter.get(sessionId);
        if (!binding) {
          log.error("onCycle-no-binding", {
            sessionId,
            cycleId: params.cycleId,
            reason: "session was released before cycle could dispatch",
          });
          return { aborted: true, shouldContinue: false };
        }
        log.debug("onCycle.begin", {
          sessionId,
          cycleId: params.cycleId,
          userId: binding.userId,
          forceFinal: params.forceFinal,
          triggerReason: params.triggerReason,
        });
        const mode: DispatchMode = params.forceFinal ? { bargedIn: () => true } : { bargedIn: () => false };

        const controller = new AbortController();

        // Per-surface ownership gate (D1). The first cycle on an idle surface
        // wins the lease and dispatches; a concurrent dispatch (an internal
        // save-skill cycle, OR a reconnecting transport's fresh cycle) is
        // REFUSED — it queues behind / adopts the in-flight cycle whose output
        // already streams to the surface's resume buffer. We do NOT register the
        // per-transport cycleSlot and do NOT dispatch a second session/prompt;
        // the incumbent is NEVER cancelled.
        const admission = admitCycle(services.surfaceCycles, surfaceId, params.cycleId, controller);
        if (!admission.dispatch) {
          log.info("onCycle.queued-behind-surface-cycle", {
            sessionId,
            surfaceKey: surfaceId,
            requestedCycleId: params.cycleId,
            activeCycleId: admission.activeCycleId,
          });
          return { aborted: false, shouldContinue: true };
        }

        cycleSlot.register(params.cycleId, controller);

        controller.signal.addEventListener(
          "abort",
          () => {
            cycleSlot.complete(params.cycleId);
          },
          { once: true },
        );

        // Consume the pending client-minted session id once. Subsequent
        // ReAct continuations within the same cycle (and the next cycle
        // after a normal turn) MUST NOT re-force the id — Hermes' default
        // keying takes over once the chain is established.
        //
        // Priority: eager pending id → in-flight session.new pre-warm Promise
        // → null (no mint; Hermes default keying). The only mint is an eager
        // client session.new. See resolveForcedSessionId for the full contract.
        const forcedSessionId = await resolveForcedSessionId({
          pendingNewSessionId,
          pendingNewSessionPromise,
          cycleId: params.cycleId,
        });
        pendingNewSessionId = null;
        pendingNewSessionPromise = null;

        try {
          const result = await dispatchHermesCycle(
            {
              sessionId,
              userId: binding.userId,
              cycleId: params.cycleId,
              userMessage: getLastUserMessage(conversationMirror),
              binding,
              maxOutputTokens: services.hermes?.defaults.max_output_tokens ?? 512,
              signal: controller.signal,
              mode,
              ...(forcedSessionId ? { forcedSessionId } : {}),
            },
            hermesDeps,
          );
          if (result.conversationId && result.conversationId !== binding.conversationId) {
            services.sessionRouter.updateConversationId(sessionId, result.conversationId);
          }
        } finally {
          cycleSlot.complete(params.cycleId);
          // Release the surface lease so the next cycle on this surface can win
          // ownership. Keyed-stale-safe: complete() no-ops if a newer cycle owns
          // the surface slot.
          services.surfaceCycles.complete(surfaceId, params.cycleId);
        }

        return { aborted: controller.signal.aborted, shouldContinue: false };
      },
    },
    conversationMirror,
    salienceMap,
  );
  attentionGateProxy._gate = gate;
  ws.data.attentionGate = gate;

  const adapters = registerAdapters(ws, capSet, services);
  ws.data.adapters = adapters;

  // Wire the mic's first-speech signal to the session-level bargeIn.
  ws.data.audioAdapter?.setOnSpeechOnset(() => bargeInController.trigger());

  const adapterAbortController = new AbortController();
  for (const adapter of adapters) {
    adapter
      .start({
        shortTermContext,
        conversationHistory: conversationMirror,
        abortSignal: adapterAbortController.signal,
        admitPendingId: (id: string) => personSession.admitPendingId(id),
      })
      .catch((err: unknown) => {
        log.error("adapter-start-failed", { id: adapter.id, error: errorMessage(err, "unknown") });
      });
  }

  const preferenceUnsub = preferenceManager.onChange((next, prev, changed) => {
    log.info("preference-change-received", { sessionId, prev, next, changed });
    if (changed.includes("language")) {
      handleLanguageChange(ws, services, next, prev.language).catch((err: unknown) => {
        log.error("stt-reconfigure-failed", {
          sessionId,
          error: errorMessage(err, "unknown"),
        });
      });
    }
    if (changed.includes("channel")) {
      log.info("channel-preference-takes-effect-next-cycle", {
        sessionId,
        channel: next.channel,
      });
    }
  });
  ws.data.preferenceUnsub = preferenceUnsub;

  log.info("session-configured", {
    sessionId,
    capabilities: [...capSet],
    adapterCount: adapters.length,
    language,
  });

  // -------------------------------------------------------------------------
  // Sessions wiring: PluginClient + TitleStore + SwitchFlow + handlers
  // -------------------------------------------------------------------------
  // The dashboard sidecar's sentient-plugin REST surface is the only path
  // for search / delete / get / getMessages — ACP doesn't cover those.
  // Derive the plugin base URL by swapping the ACP port for the dashboard
  // port (acpPort + DASHBOARD_PORT_OFFSET, same offset supervisord-control
  // bakes into each per-user program).
  let httpBaseUrl: string;
  try {
    httpBaseUrl = await buildHttpBaseUrlForUser(services.hermes, services.userPortStore, initialBinding.userId);
  } catch (err: unknown) {
    log.error("http-base-url-resolve-failed", {
      sessionId,
      userId: initialBinding.userId,
      reason: errorMessage(err, "unknown"),
    });
    sendError(ws, "protocol_error", "Cannot resolve Hermes HTTP base URL");
    return;
  }

  let pendingSwitchId: string | null = null;
  let snapshotUnsub: (() => void) | null = null;

  const sessionsConfig = services.sessions;

  const pluginBaseUrl = buildPluginBaseUrl(httpBaseUrl, DASHBOARD_PORT_OFFSET);
  if (pluginBaseUrl === null) {
    log.error("plugin-client.url-derive-failed", {
      sessionId,
      userId: initialBinding.userId,
      httpBaseUrl,
      reason: "could not derive plugin URL from httpBaseUrl",
    });
    sendError(ws, "protocol_error", "Cannot derive plugin sidecar URL");
    return;
  }
  const pluginClient: SentientPluginClient = createSentientPluginClient({
    baseUrl: pluginBaseUrl,
    token: initialBinding.apiKey,
    timeoutMs: sessionsConfig.hermes_http_timeout_ms,
  });
  log.info("plugin-client.constructed", {
    sessionId,
    userId: initialBinding.userId,
    pluginBaseUrl,
  });

  // Run the one-shot migrator before constructing the new-layout titleStore.
  // Idempotent; no-op once a profile has been migrated.
  await migrateLegacyTitles({
    legacyDir: expandHome(sessionsConfig.title_override_dir),
    newRoot: expandHome(sessionsConfig.user_data_root),
    userId: initialBinding.userId,
  });

  const titleStore = createTitleStore({
    userDataRoot: expandHome(sessionsConfig.user_data_root),
    userId: initialBinding.userId,
  });

  // Past-sessions list — ACP `session/list` is the only source.
  const profileSessionsLookup = async (): Promise<Set<string>> => {
    try {
      const result = await listSessionsViaAcp(acpConn);
      return new Set(result.sessions.map((r) => r.sessionId));
    } catch (err: unknown) {
      log.warn("profile-sessions-lookup-failed", {
        sessionId,
        userId: initialBinding.userId,
        message: errorMessage(err, "unknown"),
      });
      return new Set();
    }
  };

  const switchFlow = createSwitchFlow({
    mirror: { replaceAll: (entries) => conversationMirror.replaceAll(entries) },
    cancelCurrentCycle: () =>
      new Promise<void>((resolve) => {
        const activeId = cycleSlot.currentId();
        if (activeId === null) {
          resolve();
          return;
        }
        const unsub = cycleSlot.onComplete(() => {
          unsub();
          resolve();
        });
        interruptController.trigger();
      }),
    fetchHistory: async (targetSessionId, signal) => {
      // Empty target id == fresh chat (session.new). Skip the fetch and
      // let mirror.replaceAll([]) clear the buffer.
      if (targetSessionId === "") return [];
      const raw = await pluginClient.getMessages(targetSessionId);
      if (signal.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return raw
        .map((m, i) => hermesMessageToMirrorEntry(m, targetSessionId, i))
        .filter((e): e is NonNullable<typeof e> => e !== null);
    },
    teardownTimeoutMs: sessionsConfig.switch_teardown_timeout_ms,
  });

  // On conversation.activate the gateway emits session.switched only —
  // history is now REST (no conversation.snapshot on activate).
  const emitActivateSwitched = (switchedTo: string): void => {
    wsSend({ type: "session.switched", sessionId: switchedTo, ts: Date.now() });
    log.info("session.switched.emitted", { sessionId, switchedTo });
  };

  // switchFlow drives mirror.replaceAll, which fires onSnapshot.
  // pendingSwitchId latch correlates the snapshot with the originating activate.
  // On conversation.activate: emit session.switched only (history is REST).
  // On session.new: pendingSwitchId is null — nothing to emit here.
  snapshotUnsub = conversationMirror.onSnapshot((_entries) => {
    const switchedTo = pendingSwitchId;
    pendingSwitchId = null;
    if (switchedTo !== null) {
      emitActivateSwitched(switchedTo);
    }
  });
  ws.data.snapshotUnsub = snapshotUnsub;

  const sessionsHandlers = createSessionsHandlers({
    userId: initialBinding.userId,
    titleStore,
    send: (frame) => {
      wsSend(frame);
    },
    switchFlow,
    profileSessionsLookup,
    setPendingNewSessionId: (id) => {
      pendingNewSessionId = id;
    },
    setPendingNewSessionPromise: (promise) => {
      pendingNewSessionPromise = promise;
    },
    acpConn,
  });

  // Latch pendingSwitchId before delegating, so the upcoming mirror
  // snapshot fan-out is correlated with this activate. session.new clears
  // the latch — its empty-snapshot has nothing to pair against; Hermes
  // emits session.created on the first user.message of the new chain.
  ws.data.sessionsHandlers = {
    handle: async (frame) => {
      if (frame.type === "conversation.activate") pendingSwitchId = frame.sessionId;
      else if (frame.type === "session.new") pendingSwitchId = null;
      await sessionsHandlers.handle(frame);
    },
  };

  // session.ready builder — sent on BOTH paths. The client handshake's
  // ready-gate ONLY completes on session.ready (its FSM has no stream.resumed
  // case), so a warm resume MUST send it too or the handshake times out
  // (4002) → reconnect storm. handleResumeOrFresh invokes this thunk on the
  // recovered:true path BEFORE stream.resumed (order is load-bearing — see its
  // doc). On recovered:false / fresh, the thunk runs here in the fresh block.
  const playbackTunables = {
    minEagerEndMs: services.webui.playback.min_eager_end_ms,
    preemptFadeoutMs: services.webui.playback.preempt_fadeout_ms,
  };
  // The session.ready payload. On the fresh / recovered:false path it is sent
  // seq-stamped via wsSend (sendReady below). On recovered:true the handover
  // sends this SAME object RAW (seq-less) so it ungates the client without
  // poisoning the resume cursor — see ws-resume-handover.
  const readyFrame: Record<string, unknown> = {
    type: "session.ready",
    sessionId,
    audioEncoding: AUDIO_ENCODING,
    inputSampleRate: INPUT_SAMPLE_RATE,
    outputSampleRate: OUTPUT_SAMPLE_RATE,
    enabledEffects: [],
    playback: playbackTunables,
  };
  const sendReady = (): void => {
    log.debug("session-ready-playback-tunables", { sessionId, ...playbackTunables });
    wsSend(readyFrame);
  };

  // STREAM-RESUME decision (Task 3.8). When the device buffer was resumed AND
  // it still holds the frames since the client's lastSeq: send session.ready
  // (via sendReady) THEN stream.resumed{recovered:true} + replay those frames
  // VERBATIM (raw socket sends — they keep their original seq/header), then
  // SUPPRESS the fresh-only block below (prefs seed + the conversation.activate
  // rehydrate / empty snapshot). session.ready is NOT suppressed — it was sent
  // inside handleResumeOrFresh. Otherwise emit recovered:false (when a resume
  // was requested) and fall through to the normal fresh setup; the client
  // REST-refetches history.

  // Re-anchor the conversation thread for the NEXT user message. The client
  // declares the conversationId it is displaying (configure field, mobile) or
  // via the ?session_id= upgrade param (web). Seed it HERE — before the
  // recovered:true early-return below — so a warm buffer-resume reconnect still
  // continues the same Hermes thread instead of forking. The next cycle's
  // resolveForcedSessionId consumes this; an unknown id degrades to a fresh
  // Hermes session/load (per-user worker isolation makes a stale id harmless).
  // On the fresh / recovered:false path the conversation.activate block further
  // below re-seeds pendingNewSessionId to the same id — an idempotent no-op;
  // this early seed exists solely to cover the recovered:true path that returns
  // before that block.
  const reanchorConversationId = configureConversationId ?? ws.data.resumeSessionId;
  if (reanchorConversationId != null) {
    pendingNewSessionId = reanchorConversationId;
    log.info("resume.reanchor", {
      sessionId,
      conversationId: reanchorConversationId,
      source: configureConversationId ? "configure" : "url",
    });
  }

  const replayed = handleResumeOrFresh({
    ws,
    sessionId,
    surfaceId,
    buffer: deviceBuffer,
    epoch: deviceEpoch,
    resumed: deviceResumed,
    resumeParams,
    readyFrame,
    goLive: () => attachment.goLive(),
  });

  if (replayed) {
    // Successful resume: RAW session.ready + the missed frames were already sent
    // (session.ready first, then stream.resumed + replay), and the handover went
    // live AFTER the replay. The client has history + prefs from the replay
    // window. Suppress the fresh-only block (prefs seed + snapshot).
    log.info("session-configured.resumed", { sessionId, surfaceId, epoch: deviceEpoch });
    return;
  }

  // Fresh / recovered:false path. On a recovered:false resume the live socket
  // was deferred (isResumeAttempt) but there is no replay window, so go live now
  // before the fresh handshake writes session.ready / prefs / snapshot.
  if (isResumeAttempt) attachment.goLive();
  // Send session.ready now (the thunk the resume path would have called).
  sendReady();

  // Seed the client with the current audio preferences. Fresh path only — on
  // resume the prior connection's journaled session.preferences.changed is
  // replayed verbatim (no double-send). The onChange listener above only fires
  // on FUTURE changes, and session.ready carries no prefs — so without this
  // seed the client keeps its schema default (ttsEnabled: true). When the
  // saved profile differs, the toggle computes !current from the wrong value
  // → update() is a no-op → no echo → button appears stuck. Both webui and
  // the mobile SDK rely on this seed to reflect the real state and toggle
  // reliably.
  wsSend({
    type: "session.preferences.changed",
    preferences: {
      ttsEnabled: preferenceManager.get().ttsEnabled,
      channel: preferenceManager.get().channel,
    },
  });

  // Resume on connect: if `?session_id=` was at WS upgrade, run the activate
  // flow now. The mirror.onSnapshot listener emits session.switched only
  // (history is REST). On failure (404, network), fall through to the
  // empty-snapshot path below.
  const resumeSessionId = ws.data.resumeSessionId;
  let resumeHandled = false;
  if (resumeSessionId !== null && ws.data.sessionsHandlers !== null) {
    try {
      await ws.data.sessionsHandlers.handle({
        type: "conversation.activate",
        sessionId: resumeSessionId,
      });
      gate.clearConversationSalience();
      resumeHandled = true;
      log.info("resume.success", { sessionId, resumeSessionId });
    } catch (err: unknown) {
      log.warn("resume.failed", { sessionId, resumeSessionId, message: errorMessage(err, "unknown") });
      pendingSwitchId = null;
    }
  }

  if (!resumeHandled) {
    // Initial sync of the conversation mirror. Empty on fresh session.
    wsSend({
      type: "conversation.snapshot",
      items: toFeed(conversationMirror.snapshot()),
    });
  }
}

// ---------------------------------------------------------------------------
// Adapter registration
// ---------------------------------------------------------------------------

function registerAdapters(
  ws: ServerWebSocket<ClientData>,
  capabilities: ReadonlySet<string>,
  services: GatewayServices,
): Adapter[] {
  const adapters: Adapter[] = [];

  if (capabilities.has("text.input")) {
    const textAdapter = createUserTextInputAdapter();
    ws.data.textAdapter = textAdapter;
    adapters.push(textAdapter);
  }

  if (capabilities.has("audio.input") && services.stt) {
    const audioAdapter = createUserAudioInputAdapter(services.stt.adapterFactory, services.stt.adapterConfig);
    ws.data.audioAdapter = audioAdapter;
    adapters.push(audioAdapter);
  }

  return adapters;
}

// ---------------------------------------------------------------------------
// ACP wire acquire (pooled per surfaceId)
// ---------------------------------------------------------------------------

interface AcquireAcpWireOrFailInput {
  readonly sessionId: string;
  readonly userId: string;
  /** Surface key for the wire pool — one isolated Hermes child per surface. */
  readonly surfaceId: string;
  /** Per-surfaceId pool — reuses a live wire across transport reconnects for the same surface. */
  readonly registry: AcpWireRegistry;
  /** Per-profile WS URL ending in `/ws` — `bootstrapAcpWire` rewrites the suffix to `/acp`. */
  readonly wsUrl: string;
  /** Bearer token for the ACP WS handshake. */
  readonly token: string;
  /** ACP wire resilience tunables (open timeout + reconnect backoff). */
  readonly acpWire: HermesAcpWire | undefined;
  /** Stash the release fn on the WS so the close-handler can drop this attachment's ref. */
  readonly setDispose: (fn: () => void) => void;
}

/**
 * Acquire the surface's pooled ACP wire — dials on the first attachment, reuses
 * the live wire (refCount++) for every subsequent same-surface reconnect so the
 * overlay never evicts the in-flight connection. On failure, log + return null so
 * the caller can reject the session cleanly. ACP is the only wire — no legacy
 * fallback. The dial threads the reconnect config so the wire self-heals on
 * abnormal close. The stashed dispose releases ONE reference; the registry
 * tears the wire down only when the last attachment for this surface detaches.
 * userId is used for WS-URL resolution and logging only — the pool key is surfaceId.
 */
async function acquireAcpWireOrFail(input: AcquireAcpWireOrFailInput): Promise<AcpPerProfileConnection | null> {
  const dial = (): Promise<AcpWireHandle> => {
    const acpWire = input.acpWire;
    return bootstrapAcpWire({
      wsUrl: input.wsUrl,
      token: input.token,
      sessionId: input.sessionId,
      ...(acpWire
        ? {
            openTimeoutMs: acpWire.open_timeout_ms,
            reconnect: {
              baseMs: acpWire.reconnect_base_ms,
              maxMs: acpWire.reconnect_max_ms,
              jitterMs: acpWire.reconnect_jitter_ms,
              maxAttempts: acpWire.reconnect_max_attempts,
            },
          }
        : {}),
    });
  };
  try {
    const acpConn = await input.registry.acquire(input.surfaceId, dial);
    let released = false;
    input.setDispose(() => {
      if (released) return;
      released = true;
      input.registry.release(input.surfaceId);
    });
    log.info("acp-wire-acquire-ok", { sessionId: input.sessionId, userId: input.userId, surfaceId: input.surfaceId });
    return acpConn;
  } catch (err: unknown) {
    log.warn("acp-wire-acquire-failed", {
      sessionId: input.sessionId,
      userId: input.userId,
      surfaceId: input.surfaceId,
      reason: errorMessage(err, "unknown"),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Preference -> side-effect handlers
// ---------------------------------------------------------------------------

async function handleLanguageChange(
  ws: ServerWebSocket<ClientData>,
  services: GatewayServices,
  next: SessionPreferences,
  prevLanguage: SessionPreferences["language"],
): Promise<void> {
  const audioAdapter: UserAudioInputAdapter | null = ws.data.audioAdapter;
  if (!audioAdapter) {
    log.debug("language-change-ignored-no-audio-adapter", {
      prevLanguage,
      next: next.language,
      reason: "session is text-only",
    });
    return;
  }
  if (!services.stt) {
    log.warn("language-change-ignored-no-stt-service", { prevLanguage, next: next.language });
    return;
  }
  const newSttConfig: STTAdapterConfig = {
    ...services.stt.adapterConfig,
    language: next.language,
    pauseRenderLanguage: next.language === "auto" ? services.stt.adapterConfig.pauseRenderLanguage : next.language,
  };
  log.info("stt-reconfigure-start", {
    prevLanguage,
    nextLanguage: next.language,
    pauseRenderLanguage: newSttConfig.pauseRenderLanguage,
  });
  await audioAdapter.reconfigure(newSttConfig);
  log.info("stt-reconfigure-complete", { nextLanguage: next.language });
}

// ---------------------------------------------------------------------------
// Config builders
// ---------------------------------------------------------------------------

function buildGateConfig(services: GatewayServices): AttentionGateConfig {
  const cerebrum = services.cerebrum;
  return {
    debounceWindowMs: cerebrum?.cycle.debounce_window_ms ?? 80,
    standardThreshold: cerebrum?.cycle.standard_threshold ?? 50,
    immediateWakeThreshold: cerebrum?.cycle.immediate_wake_threshold ?? 100,
    maxPerHour: cerebrum?.cycle.max_per_hour ?? 120,
    maxIterations: cerebrum?.cycle.max_iterations ?? 10,
    maxIterWarnAhead: cerebrum?.cycle.max_iter_warn_ahead ?? 3,
  };
}

/**
 * Extract the text of the most recent user entry from the conversation mirror.
 * Returns empty string if no user entry exists.
 */
function getLastUserMessage(mirror: ConversationMirror): string {
  const entries = mirror.snapshot();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.kind === "user") {
      return entry.content;
    }
  }
  return "";
}

export interface ResolveForcedSessionIdInput {
  readonly pendingNewSessionId: string | null;
  readonly pendingNewSessionPromise: Promise<string> | null;
  readonly cycleId: string;
}

/**
 * Resolve which sessionId the upcoming cycle should force, in priority order:
 *
 *   1. An eager `pendingNewSessionId` (session.new pre-warm already resolved).
 *   2. An in-flight `pendingNewSessionPromise` (session.new pre-warm still
 *      racing the first message) — awaited once.
 *   3. No pending session.new: return null — the cycle falls through to Hermes
 *      default keying. The only mint is an eager client `session.new`
 *      (visible `session.created`). A fresh-chain message with no pending id
 *      does NOT trigger an invisible gateway mint.
 */
export async function resolveForcedSessionId(input: ResolveForcedSessionIdInput): Promise<string | null> {
  if (input.pendingNewSessionId !== null) return input.pendingNewSessionId;
  if (input.pendingNewSessionPromise !== null) {
    try {
      return await input.pendingNewSessionPromise;
    } catch (err) {
      log.warn("pending-new-session-failed", { cycleId: input.cycleId, reason: errorMessage(err, "unknown") });
      return null;
    }
  }
  // No pending session.new on a fresh chain: do NOT mint here. The client mints
  // eagerly via session.new (visible session.created); a fresh-chain message with
  // no pending id falls through to Hermes default keying (no invisible mint).
  return null;
}

export interface CycleAdmission {
  readonly dispatch: boolean;
  readonly activeCycleId: string;
}

/**
 * Per-surface cycle gate (D1). First cycle on an idle surface dispatches; any
 * concurrent dispatch (internal save-skill, or a reconnecting transport's fresh
 * cycle) is REFUSED — it queues behind / adopts the in-flight cycle whose output
 * already streams to the resume buffer. NEVER cancels the incumbent.
 */
export function admitCycle(
  registry: SurfaceCycleRegistry,
  surfaceKey: string,
  cycleId: string,
  controller: AbortController,
): CycleAdmission {
  const lease = registry.acquire(surfaceKey, cycleId, controller);
  return { dispatch: lease.owner, activeCycleId: lease.activeCycleId };
}
