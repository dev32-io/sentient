import { getLog } from "../logging/logger.js";
import { type AcpPerProfileConnection, createAcpPerProfileConnection } from "./per-profile-connection.js";

const log = getLog(["sentient", "hermes-adapter-client", "wire-bootstrap"]);

// ---------------------------------------------------------------------------
// AcpWireBootstrap — opens a Bun WebSocket to the overlay's `acp_ws_server.py`,
// pumps incoming raw frames into the AcpPerProfileConnection, and runs the
// initial `initialize` handshake.
//
// The overlay listens on the same per-profile port as Hermes' platform-adapter
// WS but on path `/acp` (custom-WS uses `/ws`). Bearer auth via the
// `Authorization: Bearer <token>` header — same scheme as the legacy wire.
// Reconnect / health-poll is intentionally OUT of scope here: the existing
// per-profile pool owns the legacy WS lifecycle and its supervision is
// orthogonal to the ACP wire path. Lifetime of the ACP connection is tied to
// the per-WS-session-configure call.
// ---------------------------------------------------------------------------

const READY_STATE_OPEN = 1;
const ACP_PATH_SUFFIX = "/acp";
const LEGACY_WS_PATH_SUFFIX = "/ws";
const OPEN_TIMEOUT_MS_DEFAULT = 5_000;

export interface AcpWireBootstrapInput {
  /** Existing per-profile WS URL (custom-WS, ends in `/ws`). The path is rewritten to `/acp` for the ACP wire. */
  readonly wsUrl: string;
  /** Bearer token for `Authorization` header — same secret the legacy WS uses. */
  readonly token: string;
  /** Optional WS factory — production uses Bun's WebSocket; tests inject a mock. */
  readonly wsFactory?: AcpWsFactory;
  /** Hard timeout for the WS open handshake. */
  readonly openTimeoutMs?: number;
}

export interface AcpWireBootstrapResult {
  readonly acpConn: AcpPerProfileConnection;
  /** Tear down the WS + the ACP connection. Idempotent. */
  dispose(): void;
}

export interface AcpWsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: (e: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (e: unknown) => void): void;
  addEventListener(type: "message", listener: (e: { data: string | ArrayBuffer | Blob }) => void): void;
}

export type AcpWsFactory = (url: string, token: string) => AcpWsLike;

/** Default factory — Bun's WebSocket honors a `headers` option for Bearer auth. */
const defaultWsFactory: AcpWsFactory = (url, token) => {
  // biome-ignore lint/suspicious/noExplicitAny: Bun supports headers param on WebSocket.
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as any);
  return ws as unknown as AcpWsLike;
};

/** Rewrite the legacy `/ws` suffix to `/acp` so the same per-profile port hosts both endpoints. */
export function deriveAcpUrl(wsUrl: string): string {
  if (wsUrl.endsWith(LEGACY_WS_PATH_SUFFIX)) {
    return `${wsUrl.slice(0, -LEGACY_WS_PATH_SUFFIX.length)}${ACP_PATH_SUFFIX}`;
  }
  return `${wsUrl.replace(/\/$/, "")}${ACP_PATH_SUFFIX}`;
}

/**
 * Open the ACP wire. Resolves once the underlying WS is open AND the ACP
 * `initialize` handshake has completed. On any failure (open timeout,
 * initialize rejection) the WS is closed and the returned promise rejects.
 */
export async function bootstrapAcpWire(input: AcpWireBootstrapInput): Promise<AcpWireBootstrapResult> {
  const url = deriveAcpUrl(input.wsUrl);
  const factory = input.wsFactory ?? defaultWsFactory;
  const openTimeoutMs = input.openTimeoutMs ?? OPEN_TIMEOUT_MS_DEFAULT;

  log.info("bootstrap.begin", { url });

  const ws = factory(url, input.token);

  await waitForOpen(ws, openTimeoutMs, url);

  let onIncomingCb: ((raw: string) => void) | null = null;
  ws.addEventListener("message", (evt) => {
    if (typeof evt.data !== "string") return;
    if (onIncomingCb) onIncomingCb(evt.data);
  });
  ws.addEventListener("close", (e) => {
    log.info("ws.close", { code: e.code, reason: e.reason });
  });
  ws.addEventListener("error", () => {
    log.warn("ws.error");
  });

  const acpConn = createAcpPerProfileConnection({
    send: async (raw: string) => {
      if (ws.readyState !== READY_STATE_OPEN) {
        throw new Error("acp-wire-bootstrap.send: WS not open");
      }
      ws.send(raw);
    },
    onIncoming: (cb) => {
      onIncomingCb = cb;
    },
  });

  try {
    await acpConn.initialize();
  } catch (err: unknown) {
    log.warn("bootstrap.initialize-failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
    safeClose(ws);
    acpConn.dispose();
    throw err;
  }

  log.info("bootstrap.done", { url });

  let disposed = false;
  return {
    acpConn,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      log.debug("dispose");
      acpConn.dispose();
      safeClose(ws);
    },
  };
}

function waitForOpen(ws: AcpWsLike, timeoutMs: number, url: string): Promise<void> {
  if (ws.readyState === READY_STATE_OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.warn("ws.open-timeout", { url, timeoutMs });
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      reject(new Error(`acp-wire-bootstrap.open-timeout: ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.debug("ws.open", { url });
      resolve();
    });
    ws.addEventListener("close", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn("ws.close-before-open", { url, code: e.code, reason: e.reason });
      reject(new Error(`acp-wire-bootstrap.closed-before-open: code=${e.code} reason=${e.reason}`));
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn("ws.error-before-open", { url });
      reject(new Error("acp-wire-bootstrap.error-before-open"));
    });
  });
}

function safeClose(ws: AcpWsLike): void {
  try {
    ws.close();
  } catch {
    /* already closed */
  }
}
