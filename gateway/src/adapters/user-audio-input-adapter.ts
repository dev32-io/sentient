import type { TurnMode } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { Adapter, AdapterContext } from "./adapter-types.js";
import { RECONNECT_INITIAL_MS, createSttReconnectSupervisor } from "./stt-reconnect-supervisor.js";
import type { STTAdapter, STTAdapterConfig, STTAdapterFactory, STTEvent } from "./stt/stt-adapter-types.js";

const log = getLog(["sentient", "adapters", "user-audio-input"]);

const ADAPTER_ID = "user-audio-input-v1";
// Matches audioStartSchema's zod default (@sentient/protocol) — the mode
// assumed until the first audio.start says otherwise.
const DEFAULT_TURN_MODE: TurnMode = "semantic";

export interface UserAudioInputAdapter extends Adapter {
  /** Forward one binary audio frame to the STT adapter. The codec is whichever
   *  this adapter was configured with (`STTAdapterConfig.audioFormat`). For
   *  `pcm16`, the bytes are int16_le mono samples. For `opus`, one raw opus
   *  packet per call. The adapter does not interpret the bytes — STT decodes
   *  server-side based on the URL query param set at connect time. */
  sendAudioFrame(bytes: Uint8Array): void;
  /** Drop mic frames for `ms` ms — used to mute the mic while TTS plays
   *  so the browser's WebRTC AEC has time to converge. `ms=0` clears it. */
  suppressInputFor(ms: number): void;
  /** Client ended the audio stream (`audio.end`). Forwards a flush to STT
   *  so an open turn finalizes immediately instead of hanging until the
   *  next mic hold delivers frames to the frame-clocked watchdogs. */
  endUtterance(): void;
  /** Swap the STT adapter to a new config mid-session (e.g., language
   *  preference change). Closes the current STT connection and opens a
   *  fresh one. Safe to call with a fully-identical config (no-op branch
   *  lives at the call site). A brief gap (≤ connectTimeoutMs) is
   *  expected during which audio frames are dropped. */
  reconfigure(newConfig: STTAdapterConfig): Promise<void>;
  /** Register a hook fired the moment STT reports `turn_started`. Used
   *  by the session to trigger barge-in (stop playback + abort TTS
   *  controller). Pass null to clear. Called at most once per turn. */
  setOnSpeechOnset(cb: (() => void) | null): void;
  /** Relay the mode carried on an `audio.start` frame to STT (2026-07-17
   *  hold/toggle-talk split design §6). Remembered across STT reconnects —
   *  a fresh STT connection defaults to "semantic" server-side, so this is
   *  replayed immediately after every (re)connect in addition to firing on
   *  the live audio.start that changed it. */
  setTurnMode(mode: TurnMode): void;
}

function logSttEvent(event: STTEvent): void {
  switch (event.type) {
    case "turn_started":
      log.info("speech-start", { turnIdx: event.turnIdx });
      break;
    case "transcript":
      log.info("speech-final", { turnIdx: event.turnIdx, text: event.text });
      break;
    case "turn_dropped":
      log.debug("speech-dropped", { turnIdx: event.turnIdx });
      break;
  }
}

export function createUserAudioInputAdapter(
  sttAdapterFactory: STTAdapterFactory,
  initialSttConfig: STTAdapterConfig,
): UserAudioInputAdapter {
  let sttAdapter: STTAdapter | null = null;
  let currentConfig: STTAdapterConfig = initialSttConfig;
  // Stored so reconfigure() can rebuild the STT adapter using the same
  // session abort signal + output sinks as the original start().
  let startCtx: AdapterContext | null = null;
  let onSpeechOnset: (() => void) | null = null;
  // Last mode requested via an audio.start frame. Survives STT reconnects —
  // replayed into every freshly-connected STT adapter (see replayTurnMode).
  let currentTurnMode: TurnMode = DEFAULT_TURN_MODE;

  // A freshly (re)connected STT adapter always defaults to "semantic"
  // server-side, so every successful connect must replay the last known
  // mode. setTurnMode() on the STT adapter dedupes internally — this is a
  // safe no-op for sessions that never left "semantic".
  function replayTurnMode(adapter: STTAdapter): void {
    adapter.setTurnMode(currentTurnMode);
  }

  async function consumeEvents(adapter: STTAdapter, ctx: AdapterContext): Promise<void> {
    for await (const event of adapter.events(ctx.abortSignal)) {
      logSttEvent(event);
      if (event.type === "turn_started") {
        // Barge-in trigger: STT's first-speech signal. We fire the hook
        // synchronously BEFORE the transcript lands so the session can stop
        // playback as early as possible. Hook failures must not break the event loop.
        log.debug("speech-onset-dispatch", { turnIdx: event.turnIdx, hasHook: onSpeechOnset !== null });
        try {
          onSpeechOnset?.();
        } catch (err: unknown) {
          log.warn("speech-onset-hook-error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (event.type === "transcript") {
        log.debug("speech-append-history", { turnIdx: event.turnIdx, language: currentConfig.language });
        ctx.conversationHistory.append({
          entryId: crypto.randomUUID(),
          kind: "user",
          ts: Date.now(),
          channel: "speech",
          content: event.text,
        });
      }
    }
  }

  async function openOnce(config: STTAdapterConfig, ctx: AdapterContext): Promise<STTAdapter> {
    const adapter = sttAdapterFactory(config);
    await adapter.open(ctx.abortSignal);
    return adapter;
  }

  // The reconnect supervisor owns its own AbortController; the closures below
  // give it live access to this adapter's mutable state (active adapter,
  // current config) without it reaching into module-private variables.
  const supervisor = createSttReconnectSupervisor({
    log,
    getConfig: () => currentConfig,
    openOnce,
    setActiveAdapter: (adapter) => {
      sttAdapter = adapter;
    },
    clearActiveAdapterIf: (adapter) => {
      if (sttAdapter === adapter) sttAdapter = null;
    },
    replayTurnMode,
    consumeEvents,
  });

  return {
    id: ADAPTER_ID,
    eventKinds: [],

    async start(ctx: AdapterContext): Promise<void> {
      log.info("adapter-start", { id: ADAPTER_ID, language: currentConfig.language });
      startCtx = ctx;
      // Try the first connect synchronously so callers see normal behavior
      // when STT is up. If it fails, we still resolve cleanly and let the
      // supervisor retry in the background — a session with no STT shouldn't
      // crash the whole voice path. The supervisor takes over for reconnects.
      let firstAdapter: STTAdapter | null = null;
      try {
        firstAdapter = await openOnce(currentConfig, ctx);
        sttAdapter = firstAdapter;
        log.info("stt-connected", { attempt: 1, language: currentConfig.language });
        replayTurnMode(firstAdapter);
      } catch (err: unknown) {
        log.warn("stt-initial-connect-failed", {
          reason: err instanceof Error ? err.message : String(err),
          nextBackoffMs: RECONNECT_INITIAL_MS,
          url: currentConfig.url,
        });
      }
      supervisor.start(ctx, firstAdapter);
    },

    async stop(reason: string): Promise<void> {
      log.info("adapter-stop", { id: ADAPTER_ID, reason });
      supervisor.abort();
      const adapter = sttAdapter;
      sttAdapter = null;
      startCtx = null;
      if (adapter) {
        await adapter.close();
      }
    },

    async reconfigure(newConfig: STTAdapterConfig): Promise<void> {
      const prevLanguage = currentConfig.language;
      currentConfig = newConfig;
      log.info("adapter-reconfigure", {
        id: ADAPTER_ID,
        prevLanguage,
        language: newConfig.language,
        pauseRenderLanguage: newConfig.pauseRenderLanguage,
      });
      // Abort the current supervisor and its inner connect. If a live adapter
      // exists, close it. Then spin up a fresh supervisor using the new config.
      supervisor.abort();
      const prevAdapter = sttAdapter;
      sttAdapter = null;
      if (prevAdapter) {
        try {
          await prevAdapter.close();
        } catch (err: unknown) {
          log.warn("reconfigure-close-failed", { reason: String(err) });
        }
      }
      const ctx = startCtx;
      if (!ctx) {
        log.warn("reconfigure-before-start", {
          reason: "no active session — new config stored; takes effect at next start()",
        });
        return;
      }
      if (ctx.abortSignal.aborted) {
        log.warn("reconfigure-skipped-aborted", { reason: "session already aborted" });
        return;
      }
      // Try a quick first connect with the new config; on failure, supervisor
      // takes over with backoff.
      let firstAdapter: STTAdapter | null = null;
      try {
        firstAdapter = await openOnce(newConfig, ctx);
        sttAdapter = firstAdapter;
        log.info("stt-connected", { attempt: 1, language: newConfig.language });
        replayTurnMode(firstAdapter);
      } catch (err: unknown) {
        log.warn("stt-reconfigure-initial-connect-failed", {
          reason: err instanceof Error ? err.message : String(err),
          url: newConfig.url,
        });
      }
      supervisor.start(ctx, firstAdapter);
      log.info("adapter-reconfigure-done", { language: newConfig.language });
    },

    sendAudioFrame(bytes: Uint8Array): void {
      if (!sttAdapter) return;
      sttAdapter.send(bytes);
    },

    suppressInputFor(ms: number): void {
      sttAdapter?.suppressInputFor(ms);
    },

    endUtterance(): void {
      sttAdapter?.endUtterance();
    },

    setOnSpeechOnset(cb: (() => void) | null): void {
      onSpeechOnset = cb;
    },

    setTurnMode(mode: TurnMode): void {
      const prev = currentTurnMode;
      currentTurnMode = mode;
      log.debug("turn-mode-relay", { from: prev, to: mode, hasLiveSttAdapter: sttAdapter !== null });
      sttAdapter?.setTurnMode(mode);
    },
  };
}
