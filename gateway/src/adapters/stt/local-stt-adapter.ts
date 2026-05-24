import { getLog } from "../../logging/logger.ts";
import { renderPauses } from "./pause-renderer.ts";
import { downsamplePcm16 } from "./pcm-resampler.ts";
import type { STTAdapter, STTAdapterConfig, STTEvent, SttAudioFormat, SttDecodeLanguage } from "./stt-adapter-types.ts";
import { sttServerMessageSchema } from "./wire-messages.ts";

const log = getLog(["sentient", "stt"]);

const STT_TARGET_SAMPLE_RATE = 16000;

/** Append `?language=<lang>` to the base STT URL. Preserves any
 * pre-existing query string the operator may have supplied. */
export function appendLanguageQuery(baseUrl: string, language: SttDecodeLanguage): string {
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}language=${encodeURIComponent(language)}`;
}

/** Append `?audioFormat=<fmt>` (or `&audioFormat=…`) to the URL. Per STT
 * CONTRACT.md §1.2 — the server reads this query param to switch the
 * binary-frame decoder between raw PCM16 and opus packets. */
export function appendAudioFormatQuery(baseUrl: string, audioFormat: SttAudioFormat): string {
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}audioFormat=${encodeURIComponent(audioFormat)}`;
}

interface EventQueue {
  enqueue(event: STTEvent): void;
  waitForEvent(signal: AbortSignal): Promise<STTEvent | null>;
  close(): void;
}

function createEventQueue(): EventQueue {
  const pending: STTEvent[] = [];
  let waitResolve: ((event: STTEvent | null) => void) | null = null;
  let removeAbortListener: (() => void) | null = null;
  let closed = false;

  return {
    enqueue(event) {
      if (closed) return;
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        removeAbortListener?.();
        removeAbortListener = null;
        r(event);
      } else {
        pending.push(event);
      }
    },
    waitForEvent(signal) {
      const next = pending.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed || signal.aborted) return Promise.resolve(null);
      return new Promise<STTEvent | null>((res) => {
        waitResolve = res;
        const onAbort = () => {
          if (waitResolve === res) {
            waitResolve = null;
            removeAbortListener = null;
            res(null);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      });
    },
    close() {
      closed = true;
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        removeAbortListener?.();
        removeAbortListener = null;
        r(null);
      }
    },
  };
}

export function createLocalSttAdapter(config: STTAdapterConfig): STTAdapter {
  let ws: WebSocket | null = null;
  let suppressUntil = 0;
  let disposed = false;
  const queue = createEventQueue();

  function handleTextFrame(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn("malformed-json", { length: raw.length });
      return;
    }
    const result = sttServerMessageSchema.safeParse(parsed);
    if (!result.success) {
      log.debug("unhandled-wire-type", {
        type: (parsed as { type?: unknown })?.type ?? "unknown",
      });
      return;
    }
    const msg = result.data;
    switch (msg.type) {
      case "ready":
        return; // consumed only during open()
      case "vad_start":
        log.info("turn-started", { turnIdx: msg.turnIdx });
        queue.enqueue({ type: "turn_started", turnIdx: msg.turnIdx });
        return;
      case "transcript_ready": {
        const rendered = renderPauses(msg.text, msg.pauses, config.pauseRenderLanguage);
        log.info("transcript", {
          turnIdx: msg.turnIdx,
          length: rendered.length,
          decodeLanguage: config.language,
          renderLanguage: config.pauseRenderLanguage,
        });
        queue.enqueue({ type: "transcript", turnIdx: msg.turnIdx, text: rendered });
        return;
      }
      case "turn_rejected":
        log.info("turn-dropped", { turnIdx: msg.turnIdx, reason: msg.reason ?? "unknown" });
        queue.enqueue({ type: "turn_dropped", turnIdx: msg.turnIdx });
        return;
    }
  }

  return {
    async open(signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const urlWithLanguage = appendLanguageQuery(config.url, config.language);
        const connectUrl = appendAudioFormatQuery(urlWithLanguage, config.audioFormat);
        log.debug("ws-connect", {
          url: connectUrl,
          decodeLanguage: config.language,
          pauseRenderLanguage: config.pauseRenderLanguage,
          audioFormat: config.audioFormat,
        });
        const socket = new WebSocket(connectUrl);
        socket.binaryType = "arraybuffer";
        ws = socket;
        let isSettled = false;

        // Cleared on any terminal outcome (ready, close, error, abort, timeout).
        // Declared with let so finishOpen (defined below) can reference it by the time it is called.
        // biome-ignore lint/style/useConst: forward-reference — assigned after finishOpen closure is defined
        let timeout: ReturnType<typeof setTimeout>;

        const abortHandler = () => {
          clearTimeout(timeout);
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          reject(new Error("aborted"));
        };

        const finishOpen = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abortHandler);
        };

        timeout = setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) {
            isSettled = true;
            finishOpen();
            try {
              socket.close();
            } catch {
              /* ignore */
            }
            reject(new Error(`localSTT connect timeout after ${config.connectTimeoutMs}ms`));
          }
        }, config.connectTimeoutMs);

        signal.addEventListener("abort", abortHandler, { once: true });

        socket.onopen = () => {
          log.info("ws-opening", { url: connectUrl });
        };

        socket.onmessage = (event) => {
          if (typeof event.data === "string") {
            // During open(), peek for {type:'ready'}. After open() resolves,
            // the onmessage handler is swapped to handleTextFrame.
            try {
              const parsed = JSON.parse(event.data) as { type?: string };
              if (parsed.type === "ready") {
                isSettled = true;
                finishOpen();
                log.info("ws-ready", { url: connectUrl });
                socket.onmessage = (e) => {
                  if (typeof e.data === "string") handleTextFrame(e.data);
                  // binary frames (WAV payloads) are discarded silently
                };
                resolve();
                return;
              }
            } catch {
              /* not our ready frame — ignore */
            }
          }
        };

        socket.onclose = () => {
          log.info("ws-closed", { url: config.url });
          queue.close();
          if (!isSettled) {
            finishOpen();
            reject(new Error("localSTT closed before ready"));
          }
        };

        socket.onerror = () => {
          log.error("ws-error", { url: config.url });
          isSettled = true;
          finishOpen();
          reject(new Error("localSTT websocket error"));
        };
      });
    },

    send(bytes: Uint8Array): void {
      if (suppressUntil !== 0 && Date.now() < suppressUntil) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Opus path: forward raw — server decodes opus → PCM16 internally.
      // The resampler would corrupt compressed bytes.
      if (config.audioFormat === "opus") {
        ws.send(bytes);
        return;
      }
      const downsampled = downsamplePcm16(bytes, config.inputSampleRate, STT_TARGET_SAMPLE_RATE);
      ws.send(downsampled);
    },

    async *events(signal: AbortSignal): AsyncGenerator<STTEvent> {
      while (true) {
        const next = await queue.waitForEvent(signal);
        if (next === null) return;
        yield next;
      }
    },

    async close(): Promise<void> {
      if (disposed) return;
      disposed = true;
      queue.close();
      if (ws) {
        try {
          ws.close(1000, "client-close");
        } catch {
          /* ignore */
        }
        ws = null;
      }
    },

    suppressInputFor(ms: number): void {
      suppressUntil = ms <= 0 ? 0 : Date.now() + ms;
    },
  };
}
