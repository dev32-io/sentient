import { getLog } from "../logging/logger.js";
import type { Adapter, AdapterContext } from "./adapter-types.js";
import type { STTAdapter, STTAdapterConfig, STTAdapterFactory, STTEvent } from "./stt/stt-adapter-types.js";

const log = getLog(["sentient", "adapters", "user-audio-input"]);

const ADAPTER_ID = "user-audio-input-v1";

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

// ---------------------------------------------------------------------------
// Reconnect supervisor
//
// STT runs as a separate container; at session start it may be down, and can
// disconnect mid-session. The supervisor keeps retrying adapter.open() with
// exponential backoff while the session is alive, so once STT comes online
// voice transparently starts working — no container restart required.
// ---------------------------------------------------------------------------

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 250;

function nextBackoff(prev: number): number {
  const base = Math.min(prev * 2, RECONNECT_MAX_MS);
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
  return base + jitter;
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  // Aborting this cancels only the current supervisor loop (used by
  // reconfigure() to tear down the in-flight retry cycle). The outer
  // ctx.abortSignal ends the session.
  let supervisorController: AbortController | null = null;

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

  /**
   * Background loop: watch the active adapter's event stream; when it ends
   * (STT ws closed), reconnect with exponential backoff. `alreadyConnected`
   * lets start() seed the loop with a freshly-opened adapter so the first
   * attempt doesn't duplicate what start() already did.
   */
  async function runSupervisor(
    ctx: AdapterContext,
    supervisorSignal: AbortSignal,
    alreadyConnected: STTAdapter | null,
  ): Promise<void> {
    let backoffMs = RECONNECT_INITIAL_MS;
    let attempt = alreadyConnected ? 1 : 0;
    let seeded = alreadyConnected;
    while (!ctx.abortSignal.aborted && !supervisorSignal.aborted) {
      let adapter = seeded;
      seeded = null;
      if (adapter === null) {
        attempt++;
        log.debug("stt-connect-attempt", { attempt, language: currentConfig.language, url: currentConfig.url });
        try {
          adapter = await openOnce(currentConfig, ctx);
          log.info("stt-connected", { attempt, language: currentConfig.language });
          sttAdapter = adapter;
          backoffMs = RECONNECT_INITIAL_MS;
        } catch (err: unknown) {
          if (ctx.abortSignal.aborted || supervisorSignal.aborted) break;
          log.warn("stt-connect-failed", {
            attempt,
            reason: err instanceof Error ? err.message : String(err),
            nextBackoffMs: backoffMs,
            url: currentConfig.url,
          });
          await sleepAbortable(backoffMs, AbortSignal.any([ctx.abortSignal, supervisorSignal]));
          backoffMs = nextBackoff(backoffMs);
          continue;
        }
      }

      try {
        await consumeEvents(adapter, ctx);
      } finally {
        if (sttAdapter === adapter) sttAdapter = null;
        try {
          await adapter.close();
        } catch {
          /* ignore */
        }
      }

      if (ctx.abortSignal.aborted || supervisorSignal.aborted) break;
      log.warn("stt-disconnected", {
        reason: "event stream ended — will reconnect with backoff",
        nextBackoffMs: backoffMs,
      });
      await sleepAbortable(backoffMs, AbortSignal.any([ctx.abortSignal, supervisorSignal]));
      backoffMs = nextBackoff(backoffMs);
    }
    log.debug("stt-supervisor-exit", {
      reason: ctx.abortSignal.aborted ? "session-ended" : "supervisor-replaced",
    });
  }

  function startSupervisor(ctx: AdapterContext, alreadyConnected: STTAdapter | null): void {
    if (supervisorController !== null) {
      supervisorController.abort();
    }
    const controller = new AbortController();
    supervisorController = controller;
    runSupervisor(ctx, controller.signal, alreadyConnected).catch((err: unknown) => {
      log.error("stt-supervisor-crashed", { error: err instanceof Error ? err.message : String(err) });
    });
  }

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
      } catch (err: unknown) {
        log.warn("stt-initial-connect-failed", {
          reason: err instanceof Error ? err.message : String(err),
          nextBackoffMs: RECONNECT_INITIAL_MS,
          url: currentConfig.url,
        });
      }
      startSupervisor(ctx, firstAdapter);
    },

    async stop(reason: string): Promise<void> {
      log.info("adapter-stop", { id: ADAPTER_ID, reason });
      supervisorController?.abort();
      supervisorController = null;
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
      supervisorController?.abort();
      supervisorController = null;
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
      } catch (err: unknown) {
        log.warn("stt-reconfigure-initial-connect-failed", {
          reason: err instanceof Error ? err.message : String(err),
          url: newConfig.url,
        });
      }
      startSupervisor(ctx, firstAdapter);
      log.info("adapter-reconfigure-done", { language: newConfig.language });
    },

    sendAudioFrame(bytes: Uint8Array): void {
      if (!sttAdapter) return;
      sttAdapter.send(bytes);
    },

    suppressInputFor(ms: number): void {
      sttAdapter?.suppressInputFor(ms);
    },

    setOnSpeechOnset(cb: (() => void) | null): void {
      onSpeechOnset = cb;
    },
  };
}
