import { getLog } from "../../logging/logger.ts";
import { type LocalTtsFrame, buildConnectUrl, parseServerFrame } from "./local-tts-protocol.ts";

const log = getLog(["sentient", "tts", "local-tts-socket"]);

export type LocalTtsSocketFactory = (url: string) => WebSocket;

export interface LocalTtsSocketConfig {
  readonly url: string;
  readonly format: string;
  readonly sampleRate: number;
  readonly voice?: string;
  readonly connectTimeoutMs: number;
  /** Production uses the global WebSocket; tests inject a fake. */
  readonly socketFactory?: LocalTtsSocketFactory;
}

export interface LocalTtsSocketHandlers {
  /** Fired for every parsed server frame, including binary `audio` frames. */
  readonly onFrame: (frame: LocalTtsFrame) => void;
  /** Fired on connect timeout, a WS-level error, or a synchronous socket-open failure. */
  readonly onError: (err: Error) => void;
  /** Fired when the WS closes, for any reason (local close() or remote). */
  readonly onClose: () => void;
}

export interface LocalTtsSocket {
  send(payload: string): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// openLocalTtsSocket — owns the raw WS: connect-time query params, the
// connect-timeout guard, and event wiring. Pure transport; synthesis
// lifecycle (ready/pushText/audioFrames bookkeeping) lives in
// local-tts-provider.ts, which supplies the handlers.
// ---------------------------------------------------------------------------

export function openLocalTtsSocket(cfg: LocalTtsSocketConfig, handlers: LocalTtsSocketHandlers): LocalTtsSocket {
  const socketFactory: LocalTtsSocketFactory = cfg.socketFactory ?? ((url) => new WebSocket(url));
  // Spread `voice` in only when defined — exactOptionalPropertyTypes forbids
  // passing `voice: undefined` for an optional `voice?: string` field.
  const connectUrl = buildConnectUrl(cfg.url, {
    format: cfg.format,
    sampleRate: cfg.sampleRate,
    ...(cfg.voice !== undefined ? { voice: cfg.voice } : {}),
  });

  const socket = openRawSocket(socketFactory, connectUrl);
  if (!socket) {
    // cfg.url is operator-supplied (config.yaml, wired by a later task) — a
    // malformed value throws SYNCHRONOUSLY out of `new WebSocket(url)`.
    // error-handling.md requires warmup()/adapter-open to resolve without
    // throwing on a transient/malformed dependency failure, so we degrade
    // instead of propagating: report through the same onError() path used
    // for connect-timeout/WS-error, which the provider wires to
    // rejectReadyIfPending() — a pending ready() rejects immediately rather
    // than hanging until the connect-timeout elapses.
    handlers.onError(new Error(`local-tts socket open failed for ${connectUrl}`));
    return deadSocket();
  }

  log.info("ws-open-requested", {
    format: cfg.format,
    sampleRate: cfg.sampleRate,
    voiceConfigured: cfg.voice !== undefined,
  });
  return wireSocket(socket, cfg, handlers);
}

/** Attempts the synchronous socket construction/setup; returns null (never throws) on failure. */
function openRawSocket(factory: LocalTtsSocketFactory, url: string): WebSocket | null {
  try {
    const socket = factory(url);
    socket.binaryType = "arraybuffer";
    return socket;
  } catch (err) {
    log.warn("ws-open-failed", { errorType: err instanceof Error ? "error" : "non-error" });
    return null;
  }
}

/** No-op socket returned when construction failed — keeps send()/close() callers crash-free. */
function deadSocket(): LocalTtsSocket {
  return {
    send(): void {
      log.debug("send-skipped-dead-socket");
    },
    close(): void {
      // Nothing was ever opened — nothing to close.
    },
  };
}

function wireSocket(socket: WebSocket, cfg: LocalTtsSocketConfig, handlers: LocalTtsSocketHandlers): LocalTtsSocket {
  const clearConnectTimer = armConnectTimeoutGuard(socket, cfg.connectTimeoutMs, handlers);
  attachSocketHandlers(socket, handlers, clearConnectTimer);
  return buildSocketApi(socket, clearConnectTimer);
}

/** Starts the connect-timeout guard; returns a function that clears it (called on open/close). */
function armConnectTimeoutGuard(socket: WebSocket, timeoutMs: number, handlers: LocalTtsSocketHandlers): () => void {
  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      log.error("ws-connect-timeout", { timeoutMs });
      socket.close();
      handlers.onError(new Error(`local-tts connect timeout after ${timeoutMs}ms`));
    }
  }, timeoutMs);

  return () => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  };
}

function attachSocketHandlers(
  socket: WebSocket,
  handlers: LocalTtsSocketHandlers,
  clearConnectTimer: () => void,
): void {
  socket.onopen = () => {
    clearConnectTimer();
    log.info("ws-opened");
    // No client handshake message needed — the server sends `ready` as the
    // first message once the connect-time query params are negotiated.
  };

  socket.onmessage = (event: MessageEvent) => {
    handlers.onFrame(parseServerFrame(event.data as string | ArrayBuffer));
  };

  socket.onclose = () => {
    log.info("ws-closed");
    clearConnectTimer();
    handlers.onClose();
  };

  socket.onerror = (event) => {
    const msg = (event as { message?: string }).message ?? "local-tts WebSocket error";
    log.error("ws-error", { errorCategory: "websocket-error", messageLength: msg.length });
    handlers.onError(new Error(msg));
  };
}

function buildSocketApi(socket: WebSocket, clearConnectTimer: () => void): LocalTtsSocket {
  return {
    send(payload: string): void {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else {
        log.debug("send-skipped-ws-not-open", { readyState: socket.readyState });
      }
    },
    close(): void {
      clearConnectTimer();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
  };
}
