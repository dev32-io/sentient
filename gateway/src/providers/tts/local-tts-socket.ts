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
  /** Fired on connect timeout or a WS-level error. */
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
// local-tts-provider.ts, which supplies the handlers. Mirrors the
// socket/protocol split already used by
// hermes-adapter-client/acp-wire-socket.ts.
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

  const socket = socketFactory(connectUrl);
  socket.binaryType = "arraybuffer";
  log.info("ws-open-requested", { url: connectUrl });

  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      log.error("ws-connect-timeout", { timeoutMs: cfg.connectTimeoutMs });
      socket.close();
      handlers.onError(new Error(`local-tts connect timeout after ${cfg.connectTimeoutMs}ms`));
    }
  }, cfg.connectTimeoutMs);

  function clearConnectTimer(): void {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

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
    log.error("ws-error", { message: msg });
    handlers.onError(new Error(msg));
  };

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
