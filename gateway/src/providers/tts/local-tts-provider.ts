import { getLog } from "../../logging/logger.ts";
import { type AudioChunkQueue, createAudioChunkQueue } from "./audio-chunk-queue.ts";
import { type LocalTtsFrame, cancelMsg, endMsg, textMsg } from "./local-tts-protocol.ts";
import { type LocalTtsSocket, type LocalTtsSocketFactory, openLocalTtsSocket } from "./local-tts-socket.ts";
import type { TTSAudioChunk, TTSProvider, TTSProviderOverrides } from "./tts-types.ts";

const log = getLog(["sentient", "tts", "local-tts"]);

/** Fallback when `cfg.connectTimeoutMs` is omitted — real value is wired via config.yaml (T10/T11). */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

// Live-path audio contract: today the local ChatterboxTTSService's only
// supported live streaming shape is opus @ 48kHz — these are fixed, not
// derived from `cfg.sampleRate`/`cfg.format` (those only shape the
// connect-time negotiation query string; the server always echoes back what
// it ACTUALLY negotiated on the `ready` frame — logged, not yet branched on).
const LIVE_ENCODING: TTSAudioChunk["encoding"] = "opus";
const LIVE_SAMPLE_RATE = 48000;

export type { LocalTtsSocketFactory };

/**
 * Small, self-contained config this provider consumes — a local-tts config
 * section with its own keys, mapped in by the bootstrap tts-factory.
 */
export interface LocalTtsProviderConfig {
  /** e.g. "ws://host.docker.internal:8770" */
  readonly url: string;
  /** e.g. "opus" — the only supported live-path format today. */
  readonly format: string;
  /** e.g. 48000 */
  readonly sampleRate: number;
  readonly defaultVoice?: string;
  readonly connectTimeoutMs?: number;
  /** WS constructor — production uses the global WebSocket; tests inject a fake. */
  readonly socketFactory?: LocalTtsSocketFactory;
}

// ---------------------------------------------------------------------------
// createLocalTtsProvider — isolated per-synthesis-run TTS provider, speaking
// T7's JSON+binary codec (local-tts-protocol.ts). Raw WS plumbing lives in
// local-tts-socket.ts; this module owns only synthesis lifecycle bookkeeping
// (ready/pushText/audioFrames/dispose).
//
// Protocol (capabilityServices/ChatterboxTTSService/CONTRACT.md):
//   1. open WS with format/sample_rate/voice as connect-time query params
//   2. server sends `ready` as the first message
//   3. client sends one or more `text` messages (buffered, not yet
//      synthesized), then `end` (== `flush`: synthesize what's buffered)
//   4. server replies `started`, then binary audio frames, then `done`
//   5. the connection is NOT closed by `end` — it's reusable for further
//      requests (§1.2) — so this provider (one WS per synthesis run) drives
//      the close itself, via dispose().
//
// CONTRACT — dispose-after-completion (cross-task leak prevention):
//   The ChatterboxTTSService NEVER closes the connection on its own
//   initiative, on `done` or otherwise (§1.2/§5 above). The consumer MUST
//   call dispose() once it is done pulling from audioFrames() — after the
//   loop completes normally, NOT only on abort — or the socket leaks for the
//   lifetime of the process. audioFrames() deliberately does NOT auto-close
//   on the `done` frame: a single run may push multiple text/end request
//   cycles (multiple `done` frames) before the consumer is actually
//   finished, so a premature close on the first `done` would break a
//   multi-block run. See audioFrames()'s docstring below for the exact exit
//   points this applies to.
// ---------------------------------------------------------------------------

export function createLocalTtsProvider(cfg: LocalTtsProviderConfig, overrides?: TTSProviderOverrides): TTSProvider {
  const queue: AudioChunkQueue = createAudioChunkQueue();
  let socket: LocalTtsSocket | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  let readyPromise: Promise<void> | null = null;
  let warmupStarted = false;
  let disposed = false;

  function rejectReadyIfPending(err: Error): void {
    if (readyReject) {
      const r = readyReject;
      readyReject = null;
      readyResolve = null;
      r(err);
    }
  }

  function resolveReadyIfPending(): void {
    if (readyResolve) {
      const r = readyResolve;
      readyResolve = null;
      readyReject = null;
      r();
    }
  }

  function handleFrame(frame: LocalTtsFrame): void {
    switch (frame.kind) {
      case "ready":
        log.info("ready-received", { format: frame.format, sampleRate: frame.sampleRate, voice: frame.voice });
        resolveReadyIfPending();
        return;
      case "audio":
        log.debug("audio-chunk-received", { bytes: frame.data.length, queueSize: queue.size() });
        queue.enqueue({ data: frame.data, encoding: LIVE_ENCODING, sampleRate: LIVE_SAMPLE_RATE, isFinal: false });
        return;
      case "done":
        log.debug("done-received", { requestId: frame.requestId, ttfaMs: frame.ttfaMs, rtf: frame.rtf });
        queue.finish();
        return;
      case "error":
        log.error("server-error", { reason: frame.reason });
        rejectReadyIfPending(new Error(frame.reason));
        queue.finish();
        return;
      case "warning":
        log.warn("server-warning", { reason: frame.reason });
        return;
      default:
        log.debug("frame-ignored", { kind: frame.kind });
    }
  }

  function warmup(): void {
    if (warmupStarted || disposed) return;
    warmupStarted = true;

    readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // Default no-op rejection handler so an unhandled rejection isn't surfaced
    // if the caller never awaits ready() before dispose().
    readyPromise.catch(() => {});

    const voice = overrides?.voiceId ?? cfg.defaultVoice;
    socket = openLocalTtsSocket(
      {
        url: cfg.url,
        format: cfg.format,
        sampleRate: cfg.sampleRate,
        connectTimeoutMs: cfg.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        // exactOptionalPropertyTypes: only spread optional keys when defined.
        ...(voice !== undefined ? { voice } : {}),
        ...(cfg.socketFactory !== undefined ? { socketFactory: cfg.socketFactory } : {}),
      },
      {
        onFrame: handleFrame,
        onError: (err) => {
          rejectReadyIfPending(err);
          queue.finish();
        },
        onClose: () => {
          // Don't reject ready() if already resolved — natural shutdown after
          // dispose() or a remote close. Just drain the queue so
          // audioFrames() doesn't hang forever on a dead connection.
          queue.finish();
          socket = null;
        },
      },
    );
  }

  function send(payload: string): void {
    if (disposed || !socket) {
      log.debug("send-skipped", { disposed, hasSocket: socket !== null });
      return;
    }
    socket.send(payload);
  }

  function ready(signal: AbortSignal): Promise<void> {
    if (disposed) return Promise.reject(new Error("TTSProvider disposed"));
    if (!warmupStarted) warmup();
    const p = readyPromise ?? Promise.resolve();

    if (signal.aborted) return Promise.reject(new Error("aborted"));

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  function pushText(text: string): void {
    if (disposed) {
      log.debug("push-text-skipped-disposed", { textLength: text.length });
      return;
    }
    if (text.length === 0) return;
    log.debug("push-text", { chars: text.length, preview: text.length <= 80 ? text : `${text.slice(0, 80)}…` });
    // `text` only buffers server-side — nothing is synthesized until
    // `end`/`flush`. endInput() sends `end`.
    send(textMsg(text));
  }

  function endInput(): void {
    if (disposed) return;
    // `end` behaves identically to `flush`: it synthesizes whatever text is
    // buffered since the last flush. One WS per synthesis run means this is
    // the single trigger for this provider's request — no separate flush
    // call needed.
    log.debug("end-input-sent");
    send(endMsg());
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    log.info("dispose");
    rejectReadyIfPending(new Error("TTSProvider disposed"));
    // The service never closes the connection on its own initiative — cancel
    // the in-flight request, then force-close.
    socket?.send(cancelMsg());
    socket?.close();
    socket = null;
    queue.finish();
  }

  /**
   * Streams synthesized audio chunks until the queue drains past a `done`
   * frame, the signal aborts, or the underlying wait returns no item (e.g.
   * the socket closed/errored out from under the run).
   *
   * CONTRACT: none of these exits close the WS — see the module-level
   * "dispose-after-completion" note above. The caller MUST call dispose()
   * once this generator is done (return or throw-free completion alike),
   * not only on abort, or the connection leaks — this service does not
   * self-close.
   */
  async function* audioFrames(signal: AbortSignal): AsyncGenerator<TTSAudioChunk> {
    log.debug("audio-frames-start");
    let emitted = 0;
    while (!signal.aborted) {
      if (queue.isDone() && queue.isEmpty()) {
        log.debug("audio-frames-end", { emitted, reason: "queue-done" });
        return;
      }

      while (!queue.isEmpty()) {
        if (signal.aborted) {
          log.debug("audio-frames-end", { emitted, reason: "aborted-mid-drain" });
          return;
        }
        const chunk = queue.dequeue();
        if (chunk) {
          emitted += 1;
          yield chunk;
        }
      }

      if (queue.isDone()) {
        log.debug("audio-frames-end", { emitted, reason: "queue-done-after-drain" });
        return;
      }

      const hasItem = await queue.waitForItem(signal);
      if (!hasItem) {
        log.debug("audio-frames-end", { emitted, reason: "wait-returned-no-item" });
        return;
      }
    }
    log.debug("audio-frames-end", { emitted, reason: "signal-aborted" });
  }

  return { warmup, ready, pushText, audioFrames, endInput, dispose };
}
