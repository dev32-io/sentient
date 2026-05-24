import { getLog } from "../../logging/logger.ts";
import { type AudioChunkQueue, createAudioChunkQueue } from "./audio-chunk-queue.ts";
import {
  buildFishAudioFlushMessage,
  buildFishAudioStartMessage,
  buildFishAudioStopMessage,
  buildFishAudioTextMessage,
  describeFishAudioResponse,
  parseFishAudioResponse,
} from "./fish-audio-protocol.ts";
import type { TTSAudioChunk, TTSConfig, TTSProvider } from "./tts-types.ts";
import { TTS_DEFAULTS } from "./tts-types.ts";

const log = getLog(["sentient", "tts", "fish-audio"]);

const FISH_AUDIO_URL = "wss://api.fish.audio/v1/tts/live";

interface BunWebSocketInit {
  headers?: Record<string, string>;
}
type BunWebSocketCtor = new (url: string, options?: BunWebSocketInit) => WebSocket;

// ---------------------------------------------------------------------------
// createFishAudioProvider — isolated per-task TTS provider.
//
// Each provider owns a single Fish Audio WebSocket for its entire
// lifetime. No sharing, no resets, no turn state. The speak effect
// handler constructs one provider per invocation and disposes it at
// the end — multiple concurrent handlers => multiple concurrent WS,
// each independent.
//
// Protocol (Fish Audio streaming WebSocket):
//   1. open WS with Bearer auth + `model` header
//   2. send StartEvent as the first message
//   3. send one or more TextEvent messages (optionally each followed
//      by a FlushEvent to force synthesis of what's buffered so far)
//   4. receive AudioEvent messages as audio is generated
//   5. send StopEvent (end-of-input)
//   6. server responds with FinishEvent then closes the WS
//
// Fish Audio docs: "StartEvent must be the first message after
// connecting — reusing a connection is undefined." So each provider
// really is one-shot.
// ---------------------------------------------------------------------------

export function createFishAudioProvider(config: TTSConfig): TTSProvider {
  const queue: AudioChunkQueue = createAudioChunkQueue();
  let ws: WebSocket | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  let readyPromise: Promise<void> | null = null;
  let warmupStarted = false;
  let disposed = false;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  function send(bytes: Uint8Array): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(bytes);
    } else {
      log.debug("send-skipped-ws-not-open", { readyState: ws?.readyState ?? "null" });
    }
  }

  function clearConnectTimer(): void {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function closeWs(): void {
    clearConnectTimer();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    ws = null;
  }

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

  function warmup(): void {
    if (warmupStarted || disposed) return;
    warmupStarted = true;

    readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // Attach a default no-op rejection handler so the unhandled rejection
    // isn't surfaced if the caller never awaits ready() before dispose().
    readyPromise.catch(() => {});

    const BunWebSocket = WebSocket as unknown as BunWebSocketCtor;
    const socket = new BunWebSocket(FISH_AUDIO_URL, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        model: config.modelId,
      },
    });
    socket.binaryType = "arraybuffer";
    ws = socket;

    log.info("ws-open-requested", { url: FISH_AUDIO_URL, modelId: config.modelId });

    connectTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) {
        log.error("ws-connect-timeout", { timeoutMs: config.connectTimeoutMs });
        socket.close();
        rejectReadyIfPending(new Error(`TTS connect timeout after ${config.connectTimeoutMs}ms`));
      }
    }, config.connectTimeoutMs);

    socket.onopen = () => {
      clearConnectTimer();
      log.info("ws-opened");
      socket.send(buildFishAudioStartMessage(config));
      log.debug("start-sent", { voiceId: config.voiceId, format: config.format });
      resolveReadyIfPending();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const raw = new Uint8Array(event.data);
      const parsed = parseFishAudioResponse(raw);
      if (!parsed) {
        // Diagnostic: surface dropped Fish events at DEBUG. Kept for when
        // DEBUG is enabled (e.g. investigating frameCount=0). Per logging
        // rule: DEBUG for high-volume tracing.
        log.debug("fish-event-dropped", { kind: describeFishAudioResponse(raw) });
        return;
      }

      if (parsed.event === "audio") {
        log.debug("audio-chunk-received", { bytes: parsed.audio.length, queueSize: queue.size() });
        queue.enqueue({
          data: parsed.audio,
          encoding: config.format ?? TTS_DEFAULTS.format,
          sampleRate: config.sampleRate ?? TTS_DEFAULTS.sampleRate,
          isFinal: false,
        });
      } else if (parsed.event === "finish") {
        log.debug("finish-received", { queueSize: queue.size() });
        queue.finish();
      }
    };

    socket.onclose = () => {
      log.info("ws-closed");
      // Don't reject ready() if it's already resolved — this is a natural
      // shutdown after finish or an abort. Just drain the queue.
      queue.finish();
      ws = null;
    };

    socket.onerror = (event) => {
      const msg = (event as { message?: string }).message ?? "TTS WebSocket error";
      log.error("ws-error", { message: msg });
      rejectReadyIfPending(new Error(msg));
      queue.finish();
    };
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
    // Send TextEvent only. Do NOT auto-flush: per Fish Audio docs, FlushEvent
    // "forces immediate synthesis of all buffered text" — flushing after
    // every block makes the server synthesize each block in isolation and
    // loses cross-block prosodic context (no natural inter-paragraph pause).
    // The server buffers text per StartEvent.chunk_length until that
    // threshold is reached or StopEvent is sent. StopEvent (in endInput)
    // triggers the final flush.
    send(buildFishAudioTextMessage(text));
  }

  function endInput(): void {
    if (disposed) return;
    // Flush before Stop. The LLM stream is complete and every block is
    // pushed — flush forces the server to synthesize exactly the text we
    // sent, then Stop closes the stream cleanly. Sending Stop alone has
    // produced sentence-level repetition and trailing nonsense in S2,
    // likely from the server processing an unflushed partial chunk in a
    // different state during shutdown.
    log.debug("end-input-flush-stop-sent");
    send(buildFishAudioFlushMessage());
    send(buildFishAudioStopMessage());
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    log.info("dispose");
    rejectReadyIfPending(new Error("TTSProvider disposed"));
    closeWs();
    queue.finish();
  }

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
