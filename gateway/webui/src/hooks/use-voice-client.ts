import { useSignal } from "@preact/signals";
import type { TaskListItem } from "@sentient/protocol";
import {
  AssistantAudioResponseConnector,
  type AudioPreferences,
  type CognitionState,
  CognitionStatusConnector,
  type CommittedFeedItem,
  ConversationHistoryConnector,
  DelegationProgressConnector,
  type DelegationProgressItem,
  type EchoGate,
  type InFlightMessage,
  InFlightMessageConnector,
  PermissionConfirmConnector,
  type PermissionRequestItem,
  PreferencesConnector,
  type SDKStatus,
  SentientSDK,
  SessionsConnector,
  TaskListConnector,
  UserAudioInputConnector,
  UserTextInputConnector,
  createEchoGate,
  createLogger,
  createSessionsRest,
  createSpeechGate,
  createTurnAudioQueue,
  deriveRestBaseUrl,
} from "@sentient/web-sdk";
import type { VoiceStatus } from "@sentient/web-sdk";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { currentBrowserAudioPolicy, setCaptureAecEnabled } from "../adapters/browser-audio-policy.ts";
import { createWebAudioCapture } from "../adapters/web-audio-capture.ts";
import { createWebAudioPlayback } from "../adapters/web-audio-playback.ts";
import { int16ToFloat32 } from "../audio/int16-float32.ts";
import { createOpusDecoder } from "../audio/opus-decoder.ts";
import { createOpusEncoder } from "../audio/opus-encoder.ts";
import { createRnNoiseDenoiser } from "../audio/rnnoise-denoiser.ts";
import {
  AUDIO_SAMPLE_RATE,
  CAPTURE_SAMPLE_RATE,
  DENOISE_BYPASS,
  ECHO_GATE_BASELINE_THRESHOLD,
  ECHO_GATE_PLAYBACK_THRESHOLD,
  ECHO_GATE_TAIL_HOLD_MS,
  IDLE_THRESHOLD_MS,
  IDLE_TICK_INTERVAL_MS,
  OPUS_UPLINK_BITRATE_BPS,
  RNNOISE_BASELINE_SPEECH_PROB,
  RNNOISE_PLAYBACK_SPEECH_PROB,
  SPEECH_GATE_FRAME_MS,
  SPEECH_GATE_GAP_TOLERANCE_FRAMES,
  SPEECH_GATE_MAX_OPEN_MS,
  SPEECH_GATE_OPEN_DEBOUNCE_MS,
  SPEECH_GATE_PREROLL_FRAMES,
} from "../constants.ts";
// The webui's OWN display model, not the SDK's — it is what every chat
// component already takes.
import type { ChatMessage } from "../types.ts";
import { createAwaitingTracker } from "./awaiting-tracker.ts";
import { deriveCycleStatus, deriveMessages } from "./cycle-helpers.ts";
import { reducePermissionPrompt } from "./permission-helpers.ts";
import { type DrainBubble, clearConversationScopedState } from "./session-boundary.ts";
import { useTypewriterBuffer } from "./use-typewriter-buffer.ts";
import { buildVoiceStatus, resolveGatewayUrl } from "./voice-status.ts";

export type { CycleStatus } from "./cycle-helpers.ts";

const log = createLogger(["sentient", "webui", "voice-client"]);

/**
 * What a refused command says to the person who issued it (gateway spec §3.7).
 *
 * Each reason gets its own line because the right NEXT ACTION differs: retry a
 * busy race, do not retry a stale one (it belonged to the conversation you
 * left), sign in again on an expired credential.
 */
const COMMAND_REJECTION_COPY: Readonly<Record<string, string>> = {
  session_busy: "Someone else was sending at the same moment — try again.",
  stale_generation: "That message was meant for the previous chat, so it wasn't sent.",
  not_attached: "That chat isn't open any more — reopen it and try again.",
  credential_expired: "Your session expired. Please sign in again.",
};
const COMMAND_REJECTION_FALLBACK = "That didn't go through. Please try again.";

// ---------------------------------------------------------------------------
// Hook public interface
// ---------------------------------------------------------------------------

export interface UseVoiceClientOptions {
  /** Override the default gateway URL. Defaults to `wss://<same origin>/api/v1/ws`. */
  wsUrl?: string;
  token: string;
  /**
   * Fires after a reconnect when the gateway returns an empty conversation
   * snapshot but we had committed entries pre-disconnect. The PersonSession
   * archive (~30 min idle) likely cycled. App can surface a soft toast so
   * the empty chat doesn't read as a bug.
   */
  onHistoryArchived?: () => void;
}

// ---------------------------------------------------------------------------
// useVoiceClient — connector-based hook
// ---------------------------------------------------------------------------

export function useVoiceClient(options: UseVoiceClientOptions) {
  const status = useSignal<VoiceStatus>({ state: "inactive", label: "Ready", canSpeak: false, isActive: false });
  const messages = useSignal<readonly ChatMessage[]>([]);
  // tasks signal exposed to UI — the gateway's full-state tasklist.state list.
  const tasks = useSignal<readonly TaskListItem[]>([]);
  /**
   * Live user-speech preview. ALWAYS EMPTY under the 2.0 contract: R9 deleted
   * the partial-transcript frame, so spoken text now appears only once the
   * gateway commits it as a conversation entry. Kept because ChatView still
   * binds it; retiring the signal means retiring that UI too, which is a
   * webui-wide change, not this fix's.
   */
  const transcript = useSignal<string>("");
  const cycleStatus = useSignal(deriveCycleStatus({ cognition: "idle", audioPlaying: false, runningTasks: 0 }));
  const currentTurnId = useSignal<string | null>(null);
  const voiceMode = useSignal<"off" | "active">("off");
  /**
   * The L3 `confirm` prompt currently awaiting a user decision, or null.
   * Bound purely to `permission.request` / `permission.resolved` wire frames
   * via PermissionConfirmConnector — the oldest pending request is the one
   * rendered, and the connector (not this signal) owns the pending set.
   */
  const permissionRequest = useSignal<PermissionRequestItem | null>(null);
  /**
   * Background `delegateTask` work, in dispatch order. Joins to a composer
   * task-strip row through `TaskListItem.id` — same id on both frames.
   */
  const delegations = useSignal<readonly DelegationProgressItem[]>([]);
  // Audio preferences (TTS on/off, channel). Seeded from the persisted
  // profile via `seedPreferences` once the app loads it; updated server-side
  // via the PreferencesConnector's `session.preferences.changed` frame.
  const prefs = useSignal<AudioPreferences>({ ttsEnabled: true, channel: "voice" });

  // Connection signals exposed to UI. `sdkStatus` mirrors the SDK's raw
  // status; `connectionLost` flips true after the SDK exhausts its
  // reconnect attempts and waits for the user to manually retry.
  // `authExpired` flips true when the gateway rejects the token on
  // reconnect — the app routes to the login screen.
  const sdkStatus = useSignal<SDKStatus>("disconnected");
  const connectionLost = useSignal(false);
  const authExpired = useSignal(false);
  // The gateway REFUSED the last command this tab sent (gateway spec §3.7) —
  // human-readable, or null once nothing is outstanding. There is no optimistic
  // echo in this UI: a message that is refused simply never appears, so without
  // surfacing this the person sees their text vanish and nothing else happens.
  const commandRejection = useSignal<string | null>(null);

  const sdkStatusRef = useRef<SDKStatus>("disconnected");
  const cognitionRef = useRef<CognitionState>("idle");
  const isAudioPlayingRef = useRef(false);

  const typewriter = useTypewriterBuffer();
  /** WHICH BUBBLE the typewriter is currently revealing — the reply, falling
   *  back to the turn only against a gateway that does not stamp deltas. It
   *  cannot be the turn: `setBuffer` is append-only and refuses to shrink, so
   *  a reply rotating inside one turn would leave the reveal stuck on the
   *  previous stretch's text while rendering it into the new bubble. */
  const typewriterBubbleIdRef = useRef<string | null>(null);
  const typewriterRef = useRef(typewriter);
  typewriterRef.current = typewriter;

  // biome-ignore lint/correctness/useExhaustiveDependencies: options deps are stable per wsUrl/token
  const resources = useMemo(() => {
    const gatewayUrl = resolveGatewayUrl(options.wsUrl);
    const audioPolicy = currentBrowserAudioPolicy();
    const capture = createWebAudioCapture({ audioPolicy });
    const playback = createWebAudioPlayback({ audioPolicy });
    // Strict sequential FIFO keyed by turnId (spec §7.2). A follow-up turn's
    // audio queues BEHIND the turn already sounding; nothing preempts or
    // fades. `cancelAll()` (barge-in / interrupt) is the only flush path, so
    // the queue has no tunables to configure.
    const turnQueue = createTurnAudioQueue({ playback });

    // Client-side echo gate — suppresses mic frames while the assistant is
    // speaking. The playback adapter's onDrain event is the authoritative
    // "audio actually finished" signal; the gate holds an elevated energy
    // threshold through playback + tail, then falls back to baseline.
    const echoGate: EchoGate = createEchoGate({
      baselineThreshold: ECHO_GATE_BASELINE_THRESHOLD,
      playbackThreshold: ECHO_GATE_PLAYBACK_THRESHOLD,
      tailHoldMs: ECHO_GATE_TAIL_HOLD_MS,
    });
    echoGate.onStateChange((snap) => {
      log.debug("echo-gate.state", { state: snap.state, threshold: snap.threshold });
    });

    // Every turn still mid-stream, oldest first — one streaming bubble each
    // (spec §7.2). Empty when idle.
    const inflightRef: { current: readonly InFlightMessage[] } = { current: [] };
    const committedRef: { current: readonly CommittedFeedItem[] } = { current: [] };
    // Post-stream drain state: when turn.completed fires, the connector drops
    // the turn's buffer but the typewriter may still be mid-reveal. We keep
    // rendering a synthetic inflight bubble (driven by the typewriter) until
    // its visible catches up to the final buffered text. During drain, the
    // committed assistant entry for THIS REPLY is suppressed to prevent a pop —
    // by `replyId`, never by turn: a turn that a person typed through commits
    // two assistant rows under one turnId and a turn-keyed match hides both.
    const drainTurnRef: { current: DrainBubble | null } = { current: null };
    // Empty-history detection: snapshot committed-count when leaving `ready`
    // status; on next conversation snapshot post-reconnect, compare. Empty
    // result + nonzero prior == server-side PersonSession archive cycled.
    const priorCommittedCountRef: { current: number } = { current: 0 };
    const awaitingHistoryAfterReconnectRef: { current: boolean } = { current: false };

    function refreshStatus(): void {
      // Compare by field values before writing — avoids re-renders when
      // nothing derivable changed (refreshStatus is called on every audio
      // frame, cognition tick, task list update, etc.).
      const nextStatus = buildVoiceStatus(
        sdkStatusRef.current,
        cognitionRef.current,
        isAudioPlayingRef.current,
        voiceMode.peek() === "active",
      );
      const prevStatus = status.peek();
      if (
        prevStatus.state !== nextStatus.state ||
        prevStatus.label !== nextStatus.label ||
        prevStatus.canSpeak !== nextStatus.canSpeak ||
        prevStatus.isActive !== nextStatus.isActive
      ) {
        status.value = nextStatus;
      }

      const runningCount = tasks.value.filter((t) => t.status === "running").length;
      const nextCycleStatus = deriveCycleStatus({
        cognition: cognitionRef.current,
        audioPlaying: isAudioPlayingRef.current,
        runningTasks: runningCount,
        awaitingResponse: awaiting.isAwaiting(),
      });
      if (cycleStatus.peek() !== nextCycleStatus) {
        cycleStatus.value = nextCycleStatus;
      }
    }

    function refreshMessages(): void {
      // During drain, render a synthetic inflight bubble from the drain snapshot.
      const drain = drainTurnRef.current;
      const live = inflightRef.current;
      const effectiveInflight = live.length > 0 ? live : drain ? [drain.snapshot] : [];
      // Committed assistant entries already carry their gateway turnId
      // (CommittedFeedItem) — read it straight through. No ts-window stamping,
      // no per-message cache: the gateway is the source of truth for the id.
      const base = deriveMessages(
        committedRef.current,
        effectiveInflight,
        effectiveInflight.length > 0 ? typewriterRef.current.visible.value : undefined,
        drain?.replyId,
      );
      messages.value = base;
    }

    const speechGate = createSpeechGate({
      openDebounceMs: SPEECH_GATE_OPEN_DEBOUNCE_MS,
      frameDurationMs: SPEECH_GATE_FRAME_MS,
      gapToleranceFrames: SPEECH_GATE_GAP_TOLERANCE_FRAMES,
      preRollFrames: SPEECH_GATE_PREROLL_FRAMES,
      maxOpenMs: SPEECH_GATE_MAX_OPEN_MS,
    });

    // `turn.started` (user trigger) is the mic latch's close signal: the
    // gateway has taken ownership of the utterance, so stop streaming until
    // sustained speech reopens the gate. This replaces the deleted
    // `connector.transcript.final` (R9) — without it the only thing that ever
    // closed the latch was SPEECH_GATE_MAX_OPEN_MS, so every utterance was
    // followed by up to 20s of continuous mic uplink and STT load, with a wide
    // window for residual TTS echo to re-trigger barge-in.
    const audioInputConnector = new UserAudioInputConnector({
      onTurnStarted: () => {
        log.debug("speech-gate.close", { reason: "turn.started", stateBefore: speechGate.state() });
        speechGate.close();
        denoiser?.reset();
      },
    });

    // Opus encoder for mic uplink. Lives in the same lifecycle bundle as the
    // echo gate + decoder; runs AFTER the echo gate so the gate's PCM-domain
    // RMS check stays meaningful (opus bytes ≠ PCM samples). The `onPacket`
    // callback forwards raw opus packets to the WS connector, which already
    // accepts ArrayBuffer (the SDK treats binary as opaque).
    let opusEncoderUnavailable = false;
    // Rebound for every identified capture. Clearing this callback is the
    // local generation fence: delayed encoder packets cannot cross a terminal
    // or enter a newer capture.
    let sendEncodedPacket: ((packet: ArrayBuffer) => void) | null = null;
    const opusEncoder = createOpusEncoder({
      sampleRate: CAPTURE_SAMPLE_RATE,
      channels: 1,
      bitrate: OPUS_UPLINK_BITRATE_BPS,
      onPacket: (packet) => {
        // packet is Uint8Array. Always copy into a fresh ArrayBuffer — the
        // underlying buffer may be a larger pool reused by AudioEncoder, and
        // typing it as `ArrayBuffer` (rather than `ArrayBufferLike`, which
        // covers SharedArrayBuffer) keeps the connector's BufferSource happy.
        const ab = new ArrayBuffer(packet.byteLength);
        new Uint8Array(ab).set(packet);
        sendEncodedPacket?.(ab);
      },
      onUnsupported: () => {
        opusEncoderUnavailable = true;
        log.error("opus-encoder-unsupported", {
          reason: "AudioEncoder rejected opus config — mic uplink cannot start",
        });
      },
    });
    if (opusEncoder === null) {
      opusEncoderUnavailable = true;
      log.error("opus-encoder-create-failed", {
        reason: "createOpusEncoder returned null — AudioEncoder unavailable in this browser",
      });
    }

    // RNNoise denoiser — replaces the legacy RMS-based echo-gate `acceptFrame`
    // check as the client-side speech gate. RNNoise's neural classifier emits
    // per-10ms-frame speech_prob; frames below the threshold are dropped
    // entirely (no encode, no WS, no server-side STT). Cleaned PCM is what
    // the opus encoder ingests, so any TTS leak that wasn't fully cancelled
    // by getUserMedia AEC still gets a second pass of suppression before it
    // can reach the wire. Server-side Silero VAD then sees clean speech.
    //
    // Threshold selection: read `echoGate.snapshot().state` per frame —
    // baseline cutoff when no TTS is active, elevated cutoff during
    // playback / tail so residual TTS leak doesn't trigger phantom
    // barge-in. EchoGate's state machine is driven by playback events
    // (start/drain/cancel), NOT by `acceptFrame` — so we no longer need
    // to call `acceptFrame` on every capture frame.
    let isRnNoiseUnavailable = false;
    // Throttle drop logs — RNNoise fires onFrame every 10 ms, so dropped
    // frames during silence would flood DEBUG without this guard.
    const DENOISE_DROP_LOG_EVERY = 50;
    let denoiseDroppedFrames = 0;
    let denoiseTotalFrames = 0;
    function handleDenoisedFrame(cleanedSamples: Float32Array, speechProb: number): void {
      denoiseTotalFrames += 1;
      const gateState = echoGate.snapshot().state;
      const threshold = gateState === "baseline" ? RNNOISE_BASELINE_SPEECH_PROB : RNNOISE_PLAYBACK_SPEECH_PROB;
      const isSpeech = speechProb >= threshold;
      // Copy before handing to the gate: the denoiser reuses ONE output buffer
      // across calls, so frames the gate buffers during the debounce window
      // would be overwritten before the flush. encode() copies synchronously.
      const frameCopy = cleanedSamples.slice();
      const { forward, opened } = speechGate.process(frameCopy, isSpeech, Date.now());
      if (opened) {
        log.debug("speech-gate.open", {
          gateState,
          speechProb: Number(speechProb.toFixed(3)),
          flushedFrames: forward.length,
        });
      }
      if (forward.length === 0) {
        denoiseDroppedFrames += 1;
        if (denoiseDroppedFrames % DENOISE_DROP_LOG_EVERY === 0) {
          log.debug("speech-gate.buffering", {
            speechProb: Number(speechProb.toFixed(3)),
            gateState,
            droppedFrames: denoiseDroppedFrames,
            totalFrames: denoiseTotalFrames,
          });
        }
        return;
      }
      for (const f of forward) opusEncoder?.encode(f);
    }

    const denoiser = createRnNoiseDenoiser({
      bypass: DENOISE_BYPASS,
      onFrame: ({ samples, speechProb }) => {
        handleDenoisedFrame(samples, speechProb);
      },
      onUnsupported: () => {
        isRnNoiseUnavailable = true;
        log.error("rnnoise-unsupported", {
          reason: "RNNoise WASM unavailable or init failed — mic uplink cannot start",
        });
      },
    });
    if (denoiser === null) {
      isRnNoiseUnavailable = true;
      log.error("rnnoise-create-failed", {
        reason: "createRnNoiseDenoiser returned null — WebAssembly unavailable in this browser",
      });
    }

    const textInputConnector = new UserTextInputConnector();

    let activeCaptureId: string | null = null;
    let captureAcceptingStarts = true;
    let captureQueue: Promise<unknown> = Promise.resolve();

    function serializeCapture<T>(operation: () => Promise<T>): Promise<T> {
      const next = captureQueue.then(operation, operation);
      captureQueue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    }

    async function stopLocalCapture(): Promise<void> {
      // Invalidate encoded and worklet callbacks before stopping hardware.
      // Connector terminal follows only after this local fence is accepted.
      sendEncodedPacket = null;
      capture.stop();
      speechGate.close();
      denoiser?.reset();
      setCaptureAecEnabled(playback, audioPolicy, false);
      voiceMode.value = "off";
      refreshStatus();
      // Drain packets produced before the generation fence. They are dropped
      // locally because the sender is already null; awaiting the drain keeps a
      // fresh capture from inheriting delayed output from this encoder epoch.
      await opusEncoder?.flush();
    }

    async function startCapture(turnMode: "manual" | "semantic"): Promise<string> {
      return serializeCapture(async () => {
        if (!captureAcceptingStarts || sdkStatusRef.current !== "ready")
          throw new Error("Voice input is unavailable while reconnecting.");
        if (activeCaptureId !== null) throw new Error("A voice capture is already active.");
        if (!opusEncoder || opusEncoderUnavailable || !denoiser || isRnNoiseUnavailable) {
          throw new Error("Voice input requires a recent browser (Chrome 98+, Firefox 130+, Safari 17.2+).");
        }
        setCaptureAecEnabled(playback, audioPolicy, true);
        try {
          await capture.start();
          if (!captureAcceptingStarts || sdkStatusRef.current !== "ready") {
            capture.stop();
            setCaptureAecEnabled(playback, audioPolicy, false);
            throw new Error("Voice input disconnected while starting.");
          }
          const captureId = audioInputConnector.startStreaming({ turnMode });
          if (captureId === null) {
            capture.stop();
            setCaptureAecEnabled(playback, audioPolicy, false);
            throw new Error("Voice capture could not be opened.");
          }
          activeCaptureId = captureId;
          sendEncodedPacket = audioInputConnector.frameSender(captureId);
          voiceMode.value = "active";
          refreshStatus();
          return captureId;
        } catch (error) {
          await stopLocalCapture();
          throw error;
        }
      });
    }

    function finishCapture(captureId: string, outcome: "commit" | "cancel"): Promise<void> {
      return serializeCapture(async () => {
        if (activeCaptureId !== captureId) return;
        activeCaptureId = null;
        await stopLocalCapture();
        if (outcome === "commit") audioInputConnector.commitCapture(captureId);
        else audioInputConnector.cancelCapture(captureId);
      });
    }

    function cancelCaptureForTeardown(): void {
      captureAcceptingStarts = false;
      const captureId = activeCaptureId;
      activeCaptureId = null;
      void stopLocalCapture();
      if (captureId !== null) audioInputConnector.cancelCapture(captureId);
    }

    const awaiting = createAwaitingTracker({ onChange: () => refreshStatus() });

    // The local-tts service ships opus packets in TTS frames. Decode via
    // WebCodecs AudioDecoder; downsample 48kHz → playback's sample rate. The
    // decoder output is async, so we capture the active turnId in a ref and
    // attribute each decoded chunk to the latest turn. Acceptable for verify
    // (turnId mismatch only on a rapid turn boundary, recoverable on the next frame).
    let activeTurnId = "";
    const opusDecoder = createOpusDecoder({
      targetSampleRate: AUDIO_SAMPLE_RATE,
      onFrame: (samples) => {
        if (activeTurnId) turnQueue.onAudioFrame(activeTurnId, samples);
      },
    });

    const audioResponseConnector = new AssistantAudioResponseConnector({
      onAudioStart: (turnId: string) => {
        isAudioPlayingRef.current = true;
        awaiting.onAudioStart();
        turnQueue.onAudioStart(turnId);
        echoGate.onPlaybackStart(turnId);
        refreshStatus();
        // Each turn is a fresh OGG-Opus stream from the TTS service — reset decoder so
        // the second turn's OpusHead doesn't get interpreted as mid-stream
        // garbage (caused TTS to cut short after ~1 s on turn 2+).
        void opusDecoder.reset();
      },
      onAudioFrame: (frame: Uint8Array, turnId: string) => {
        activeTurnId = turnId;
        opusDecoder.decode(frame);
      },
      onAudioDone: (turnId: string) => {
        // Flush the decoder's final buffered frame(s) into the turn queue
        // BEFORE marking the turn done. The OGG-Opus decoder holds the tail
        // until end-of-stream (see opus-decoder.flush()), so without this the
        // last ~word of every reply was cut. flush() emits via onFrame ->
        // turnQueue.onAudioFrame while the turn is still active (playback has
        // ~250ms buffered ahead, so it hasn't drained yet); only then mark the
        // turn done so playback drains the tail too. flush() never rejects
        // (errors caught inside), so `.then` always marks done.
        void opusDecoder.flush().then(() => {
          turnQueue.onAudioDone(turnId);
          // isAudioPlaying stays true until playback physically drains (via onStateChange).
          // echoGate moves to tail on playback adapter's onDrain — see `unsubPlaybackDrain`.
          refreshStatus();
        });
      },
      onPlaybackStop: (reason, turnId) => {
        log.debug("playback-stop", { reason, turnId });
        isAudioPlayingRef.current = false;
        awaiting.onPlaybackEnded();
        turnQueue.cancelAll();
        echoGate.onPlaybackCancel(turnId);
        refreshStatus();
        void opusDecoder.reset();
      },
    });

    audioResponseConnector.onCancelled = () => {
      isAudioPlayingRef.current = false;
      awaiting.onPlaybackEnded();
      turnQueue.cancelAll();
      // Best-effort: no turnId here, but the gate accepts any id — it just
      // drops to baseline. The signal name is enough.
      echoGate.onPlaybackCancel("");
      refreshStatus();
    };

    const cognitionConnector = new CognitionStatusConnector({
      onStateChange: (state) => {
        cognitionRef.current = state;
        if (state === "idle") awaiting.onCognitionIdle(isAudioPlayingRef.current);
        else awaiting.onCognitionActive();
        refreshStatus();
      },
    });

    // SessionsRest is created early so both ConversationHistoryConnector and
    // SessionsConnector can share the same REST client instance. The REST client
    // only needs the gateway base URL + token, both available at this point.
    const restBaseUrl = deriveRestBaseUrl(gatewayUrl);
    const sessionsRest = createSessionsRest({
      baseUrl: restBaseUrl,
      token: () => options.token,
    });

    // Committed conversation + live streaming bubble come from two connectors.
    // `turn.completed` clears the inflight buffer just before the committed
    // entry arrives — UI swaps cleanly without a visible double-render.
    // `sessionsRest` is passed as the 2nd arg so that after `session.switched`
    // the connector can fetch the new session's history via REST (instead of
    // clearing awaitingSnapshot with an empty mirror).
    const conversationConnector = new ConversationHistoryConnector(
      {
        onUpdate: (items) => {
          // Empty-history-after-reconnect detection — runs once per reconnect.
          // The first snapshot after a session.ready is the authoritative
          // server-of-record state; if it's empty but we had entries before
          // the disconnect, the gateway archived our PersonSession.
          if (awaitingHistoryAfterReconnectRef.current) {
            awaitingHistoryAfterReconnectRef.current = false;
            if (items.length === 0 && priorCommittedCountRef.current > 0) {
              log.warn("history-archived", { priorCount: priorCommittedCountRef.current });
              options.onHistoryArchived?.();
            }
            priorCommittedCountRef.current = 0;
          }
          committedRef.current = items;
          refreshMessages();
        },
      },
      sessionsRest,
    );

    const inflightMessageConnector = new InFlightMessageConnector({
      onUpdate: (inflight) => {
        // The typewriter reveals exactly ONE turn: the newest still-producing
        // one. Older still-open turns (§7.2's second bubble) render their full
        // buffered text — they are no longer the turn emitting tokens.
        const newest = inflight[inflight.length - 1] ?? null;
        if (newest) {
          // New BUBBLE: reset the typewriter before feeding the first buffer.
          // This also clears any stale drain state from the previous one. A
          // rotation inside one turn is a new bubble by the same rule.
          const bubbleId = newest.replyId ?? newest.turnId;
          if (typewriterBubbleIdRef.current !== bubbleId) {
            typewriterRef.current.reset();
            typewriterBubbleIdRef.current = bubbleId;
            drainTurnRef.current = null;
          }
          typewriterRef.current.setBuffer(newest.text);
          currentTurnId.value = newest.turnId;
        } else {
          // turn.completed or turn.aborted for the last open turn — drain
          // whatever's buffered at MAX_RATE. Snapshot the last inflight so we
          // keep rendering the typewriter bubble until it catches up, instead
          // of letting the committed entry pop in. If the typewriter is already
          // caught up (visible === full text), skip drain — no subscription
          // will fire so we'd otherwise get stuck suppressing the committed entry.
          const last = inflightRef.current[inflightRef.current.length - 1];
          if (last) {
            const alreadyDrained = typewriterRef.current.visible.value.length >= last.text.length;
            if (!alreadyDrained) {
              drainTurnRef.current = {
                turnId: last.turnId,
                ...(last.replyId === undefined ? {} : { replyId: last.replyId }),
                snapshot: last,
              };
            }
          }
          typewriterRef.current.markComplete();
        }
        inflightRef.current = inflight;
        refreshMessages();
      },
    });

    const taskListConnector = new TaskListConnector({
      onUpdate: (turnId, items) => {
        tasks.value = items;
        // Expose the turn's id when no turn is streaming text yet — e.g. the
        // first tool call of a turn dispatches before any narration token
        // lands, so there is no inflight bubble to carry it. `null` means only
        // background rows survive a finished turn; leave currentTurnId alone
        // rather than clobbering it with "no active turn".
        if (turnId !== null && inflightRef.current.length === 0) currentTurnId.value = turnId;
        refreshStatus();
      },
    });

    // L3 `confirm` prompts (spec §5.3 / §7.1). The connector owns the pending
    // set; `reducePermissionPrompt` is the ONLY function that moves the signal,
    // so every open/close is one auditable, fail-closed transition.
    const permissionConnector = new PermissionConfirmConnector({
      onPending: (pending) => {
        const head = pending[0];
        // An empty set means the connector dropped everything — the request
        // was answered, the gateway resolved it, or the socket detached. No
        // decision can be inferred from that, so the dialog closes without
        // ever implying an approval.
        permissionRequest.value =
          head === undefined
            ? null
            : reducePermissionPrompt(permissionRequest.peek(), { type: "request", request: head });
      },
      onResolved: (requestId, outcome) => {
        // The gateway decided first — answered on another surface, or the
        // fail-closed 2-minute timeout. The reducer dismisses the dialog only
        // when the id matches the one on screen, so a stale or mismatched
        // `permission.resolved` can never clobber a newer request.
        log.info("permission.resolved", { requestId, outcome });
        permissionRequest.value = reducePermissionPrompt(permissionRequest.peek(), {
          type: "resolved",
          requestId,
          outcome,
        });
      },
    });

    // Background delegated work (delegateTask). Registered so the capability
    // is advertised in `session.configure` and progress frames are consumed
    // rather than dropped by the router. `delegations` joins to a composer
    // task-strip row through `TaskListItem.id`, which is the same id.
    const delegationConnector = new DelegationProgressConnector({
      onList: (items) => {
        delegations.value = items;
      },
    });

    // Presence-driven WS lifecycle. Client disconnects after ~1h idle and
    // reopens on presence return. Composes with the gateway's ~30-min
    // PersonSession archive for a ~1.5h total memory window.
    log.debug("sdk.presence.config", {
      idleThresholdMs: IDLE_THRESHOLD_MS,
      tickIntervalMs: IDLE_TICK_INTERVAL_MS,
    });
    const sdk = new SentientSDK({
      gatewayUrl,
      token: options.token,
      idlePresence: {
        idleThresholdMs: IDLE_THRESHOLD_MS,
        tickIntervalMs: IDLE_TICK_INTERVAL_MS,
      },
      onStatusChange: (status) => {
        log.debug("sdk.status.change", { status });
        const prev = sdkStatusRef.current;
        sdkStatusRef.current = status;
        sdkStatus.value = status;
        // Snapshot committed-count when leaving `ready` so we can detect a
        // server-side archive cycle on the next reconnect.
        if (prev === "ready" && status !== "ready") {
          priorCommittedCountRef.current = committedRef.current.length;
          awaitingHistoryAfterReconnectRef.current = priorCommittedCountRef.current > 0;
          log.debug("history-watch armed", { priorCount: priorCommittedCountRef.current });
        }
        // Visibility-driven reconnect on success clears any stale "lost" flag
        // so the banner disappears once we're back to ready.
        if (status === "ready" && connectionLost.value) {
          log.info("connection-lost cleared (sdk back to ready)");
          connectionLost.value = false;
        }
        refreshStatus();
      },
      onConnectionLost: () => {
        log.warn("connection-lost (reconnect attempts exhausted)");
        connectionLost.value = true;
      },
      onAuthExpired: () => {
        log.warn("auth-expired (gateway rejected token on reconnect)");
        authExpired.value = true;
      },
      onCommandRejected: ({ command, reason }) => {
        log.warn("command-rejected", { command, reason });
        commandRejection.value = COMMAND_REJECTION_COPY[reason] ?? COMMAND_REJECTION_FALLBACK;
      },
    });
    const sessionsConnector = new SessionsConnector({ rest: sessionsRest });

    // Audio preferences mirror. Server pushes `session.preferences.changed`
    // when the model calls `update_user_settings`; the connector calls back
    // here so the UI signal tracks server-of-record state. The app seeds the
    // initial value from the persisted profile via `seedPreferences`.
    const preferencesConnector = new PreferencesConnector({
      onChange: (next) => {
        prefs.value = next;
      },
    });

    // Every conversation boundary drops what the pane holds for the
    // conversation it is leaving — the typewriter's drain state AND the
    // composer task strip. `created`, `switched` and `draft` all signal one;
    // `deleted` / `renamed` do not. The rule itself lives in session-boundary.ts.
    sessionsConnector.onSessionsChanged((e) => {
      if (e.kind !== "switched" && e.kind !== "created" && e.kind !== "draft") return;
      log.debug("session-boundary.clear-scope", {
        kind: e.kind,
        sessionId: e.kind === "draft" ? e.draftKey : e.sessionId,
      });
      clearConversationScopedState(e.kind, {
        drain: drainTurnRef,
        inflight: inflightRef,
        committed: committedRef,
        typewriterBubbleId: typewriterBubbleIdRef,
        typewriter: typewriterRef.current,
        taskList: taskListConnector,
      });
      refreshMessages();
    });

    sdk.register(audioInputConnector);
    sdk.register(textInputConnector);
    sdk.register(audioResponseConnector);
    sdk.register(cognitionConnector);
    sdk.register(conversationConnector);
    sdk.register(inflightMessageConnector);
    sdk.register(taskListConnector);
    sdk.register(permissionConnector);
    sdk.register(delegationConnector);
    sdk.register(sessionsConnector);
    sdk.register(preferencesConnector);

    // Capture → RNNoise speech-prob gate → opus encoder → WS. The denoiser
    // emits one cleaned 10 ms Float32 frame per `onFrame` callback along
    // with a [0, 1] speech probability; `handleDenoisedFrame` consults
    // `echoGate.snapshot().state` to pick the threshold (baseline vs
    // playback/tail) and either encodes the cleaned PCM or drops the frame
    // entirely. EchoGate's state machine is driven by playback start/drain/
    // cancel events (not by per-frame energy reads), so we no longer call
    // `acceptFrame` here. Gateway-side MicEchoGuard still runs as a second
    // line of defense.
    const unsubCapture = capture.onAudioData((data: ArrayBuffer) => {
      const pcm = new Int16Array(data);
      denoiser?.push(int16ToFloat32(pcm));
    });
    const unsubCaptureError = capture.onError(() => {
      const captureId = activeCaptureId;
      if (captureId === null) return;
      log.warn("capture-error", { captureId, reason: "audio-adapter-error" });
      void finishCapture(captureId, "cancel");
    });
    // Debounce playing→false so TTS prosody gaps (WebAudio queue draining
    // for ~50-200ms between chunks) don't strobe the speaking state. Fast
    // path on playing→true so the avatar pulse + button respond as soon as
    // the next chunk arrives.
    const PLAYING_GRACE_MS = 250;
    let playingFalseTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelPendingFalse = (): void => {
      if (playingFalseTimer !== null) {
        clearTimeout(playingFalseTimer);
        playingFalseTimer = null;
      }
    };
    const unsubPlayback = playback.onStateChange((playing) => {
      if (playing) {
        cancelPendingFalse();
        if (!isAudioPlayingRef.current) {
          isAudioPlayingRef.current = true;
          refreshStatus();
        }
        return;
      }
      if (playingFalseTimer !== null) return;
      playingFalseTimer = setTimeout(() => {
        playingFalseTimer = null;
        if (!isAudioPlayingRef.current) return;
        isAudioPlayingRef.current = false;
        awaiting.onPlaybackEnded();
        refreshStatus();
      }, PLAYING_GRACE_MS);
    });
    // Authoritative "audio actually finished" signal — the playback adapter
    // fires this after the last scheduled WebAudio source ends + one frame
    // of debounce. This is the only reliable moment to start the tail hold.
    const unsubPlaybackDrain = playback.onDrain(() => {
      log.debug("echo-gate.drain-received");
      echoGate.onPlaybackDrain("");
    });

    const unsubTypewriter = typewriterRef.current.visible.subscribe((visibleText) => {
      // Active stream: re-render the inflight bubbles with the new visible substring.
      if (inflightRef.current.length > 0) {
        refreshMessages();
        return;
      }
      // Drain mode: hold the synthetic inflight bubble until the typewriter has
      // revealed the full snapshot text, then clear drain state and let the
      // committed entry take over.
      const drain = drainTurnRef.current;
      if (drain) {
        if (visibleText.length >= drain.snapshot.text.length) {
          drainTurnRef.current = null;
          log.debug("typewriter-drain-complete", { turnId: drain.turnId, finalLen: visibleText.length });
        }
        refreshMessages();
      }
    });

    return {
      sdk,
      capture,
      playback,
      turnQueue,
      speechGate,
      audioInputConnector,
      textInputConnector,
      sessionsConnector,
      preferencesConnector,
      permissionConnector,
      awaiting,
      refreshStatus,
      startCapture,
      commitCapture: (captureId: string) => finishCapture(captureId, "commit"),
      cancelCapture: (captureId: string) => finishCapture(captureId, "cancel"),
      cancelCaptureForTeardown,
      cleanup() {
        cancelPendingFalse();
        unsubCapture();
        unsubCaptureError();
        unsubPlayback();
        unsubPlaybackDrain();
        unsubTypewriter();
        turnQueue.dispose();
        echoGate.dispose();
        awaiting.dispose();
        // Close order matters: denoiser's `onFrame` may still be in-flight
        // and would call into opusEncoder. Drop the denoiser first so no new
        // frames can arrive; then opusEncoder; then opusDecoder. All close()
        // calls are idempotent (see W1 / W2).
        void denoiser?.close();
        void opusEncoder?.close();
        // Free WASM memory + terminate decoder worker. Idempotent; safe pre-ready.
        void opusDecoder.close();
      },
    };
  }, [options.wsUrl, options.token]);

  useEffect(() => {
    const { sdk, playback, refreshStatus } = resources;

    sdkStatusRef.current = "connecting";
    refreshStatus();

    playback.init().catch(() => {
      /* Non-fatal: needs prior user gesture */
    });

    // AudioContext unlock is bound STRICTLY to user actions that expect a TTS
    // response: `sendText` (Send button) and `startCapture` (voice control).
    // They run directly from the activating click/pointer event before capture
    // serialization yields, preserving the browser's transient activation.
    // Document-wide listeners were tried earlier, but they also ran for passive
    // actions (textarea focus, edge swipe); iOS Safari then ghosts the context
    // (`state`
    // reports "running" but routing is dead), and every later `unlock()` finds
    // the AC already exists and short-circuits — leaving the player wedged.
    // No path produces TTS without a prior Send or Voice toggle, so this rule
    // is sufficient.

    sdk
      .connect()
      .then(() => {
        sdkStatusRef.current = "ready";
        refreshStatus();
      })
      .catch(() => {
        sdkStatusRef.current = "error";
        refreshStatus();
      });

    return () => {
      // View disappearance is always discard. Fence producers and stop the
      // AudioWorklet before connector detach/disconnect can terminalize it.
      resources.cancelCaptureForTeardown();
      playback.destroy();
      sdk.disconnect();
      sdkStatusRef.current = "disconnected";
      cognitionRef.current = "idle";
      isAudioPlayingRef.current = false;
      resources.cleanup();
    };
  }, [resources]);

  return {
    status,
    sdkStatus,
    connectionLost,
    authExpired,
    /** Copy for the last refused command, or null. Cleared by the consumer once shown. */
    commandRejection,
    cycleStatus,
    currentTurnId,
    voiceMode,
    messages,
    tasks,
    transcript,
    /** L3 confirm prompt awaiting a decision, or null. Drives PermissionDialog. */
    permissionRequest,
    /** Background delegateTask progress, in dispatch order. */
    delegations,
    /** Audio preferences (TTS on/off, channel) — mirrors profile + server-of-record state. */
    prefs,
    /** Seed the preferences state from the persisted profile. Call once after the profile loads. */
    seedPreferences: (next: AudioPreferences) => {
      resources.preferencesConnector.seed(next);
      prefs.value = next;
    },
    /** Send a preferences patch to the gateway. Server echoes via `session.preferences.changed`. */
    patchPreferences: (patch: { ttsEnabled?: boolean; channel?: "voice" | "text" }) => {
      resources.preferencesConnector.patch(patch);
    },
    /**
     * Answer the pending L3 confirm prompt. The connector clears the request
     * and re-emits its pending set, which nulls `permissionRequest` — this
     * function never mutates the signal itself, so the wire remains the only
     * thing that can open or close the dialog (state-bound UX). A click that
     * races the gateway's own resolution is dropped by the connector.
     */
    respondToPermission: (approved: boolean) => {
      const current = permissionRequest.peek();
      if (!current) return;
      log.info("permission.respond", { requestId: current.requestId, approved });
      resources.permissionConnector.respond(current.requestId, approved);
    },
    /** Sessions connector — wired for past-chats drawer + cross-tab sync. */
    sessionsConnector: resources.sessionsConnector,
    /** Manually trigger a reconnect attempt. Used by the "Tap to reconnect" UI. */
    reconnect: () => {
      log.info("manual reconnect requested");
      connectionLost.value = false;
      resources.sdk.forceReconnect();
    },
    startCapture: (mode: "manual" | "semantic") => {
      // Must stay synchronous with the originating pointer/click event. Moving
      // unlock behind capture serialization can ghost iOS audio routing.
      resources.playback.unlock();
      return resources.startCapture(mode);
    },
    commitCapture: (captureId: string) => resources.commitCapture(captureId),
    cancelCapture: (captureId: string) => resources.cancelCapture(captureId),
    sendText: (text: string) => {
      // TTS-expecting action: the gateway will reply with audio. Unlock
      // synchronously inside this onClick frame so the AudioContext is
      // constructed during a `click` event (the only activation-eligible
      // path on iOS Safari). Every later TTS frame schedules cleanly.
      resources.playback.unlock();
      // Arm the Interrupt bridge from the moment Send is clicked.
      // The awaiting-tracker handles its own disarm transitions.
      resources.awaiting.arm();
      resources.textInputConnector.sendText(text);
      resources.refreshStatus();
    },
    /**
     * Hard interrupt. UI button + Escape key both call this. Idempotent —
     * the gateway no-ops if nothing is currently active.
     *
     * Stops local playback first, then tells the server. We cannot wait for
     * the server's `playback.stop` round-trip: if the gateway already
     * finished emitting `turn.audio.done`, it has nothing to abort and
     * will never send one, so the client would otherwise keep draining its
     * buffered audio.
     */
    interrupt: () => {
      // Interrupt cancels TTS — no audio response is expected from this
      // action, so it does NOT call playback.unlock(). turnQueue.cancelAll
      // → playback.clear() rebuilds the AudioContext synchronously inside
      // this onClick frame; iOS counts the click as transient activation,
      // so the rebuilt AC routes properly without an explicit unlock.
      isAudioPlayingRef.current = false;
      resources.awaiting.onPlaybackEnded();
      resources.turnQueue.cancelAll();
      resources.refreshStatus();
      resources.sdk.interrupt();
    },
  };
}
