import { getLog } from "../logging/logger.js";
import { type AcpWireReconnectConfig, DEFAULT_ACP_WIRE_RECONNECT, createManagedAcpSocket } from "./acp-wire-socket.js";
import { type AcpWsFactory, defaultWsFactory, deriveAcpUrl } from "./acp-ws.js";
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
//
// Resilience: the socket is owned by a ManagedAcpSocket (acp-wire-socket.ts)
// that swaps a dead WS for a fresh one — re-running `initialize` — on the next
// dispatch send after an ABNORMAL close (e.g. 1006 after a gateway restart /
// resumed-session flap). A resumed session therefore stays able to dispatch
// cycles across a wire flap. A clean teardown (`dispose`) or a normal-closure
// (1000) close never reconnects. The per-conversation Hermes sessionId is owned
// by the dispatch layer (acp-hermes-client.ts re-targets it per prompt), so a
// re-bootstrap fully restores dispatch capability — no Hermes resume call.
// ---------------------------------------------------------------------------

const OPEN_TIMEOUT_MS_DEFAULT = 5_000;

export interface AcpWireBootstrapInput {
  /** Existing per-profile WS URL (custom-WS, ends in `/ws`). The path is rewritten to `/acp` for the ACP wire. */
  readonly wsUrl: string;
  /** Bearer token for `Authorization` header — same secret the legacy WS uses. */
  readonly token: string;
  /** Optional WS factory — production uses Bun's WebSocket; tests inject a mock. */
  readonly wsFactory?: AcpWsFactory;
  /** Hard timeout for each WS open handshake. */
  readonly openTimeoutMs?: number;
  /** Reconnect backoff tunables; defaults to DEFAULT_ACP_WIRE_RECONNECT. */
  readonly reconnect?: AcpWireReconnectConfig;
  /** sessionId for trace correlation across reconnects. */
  readonly sessionId?: string;
  /** Sleep injection for reconnect backoff — tests pass a fake. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AcpWireBootstrapResult {
  readonly acpConn: AcpPerProfileConnection;
  /** Tear down the WS + the ACP connection. Idempotent. Blocks future reconnects. */
  dispose(): void;
}

export type { AcpWsLike, AcpWsFactory } from "./acp-ws.js";
export { deriveAcpUrl } from "./acp-ws.js";

/**
 * Open the ACP wire. Resolves once the underlying WS is open AND the ACP
 * `initialize` handshake has completed. On any failure (open timeout,
 * initialize rejection) the WS is closed and the returned promise rejects.
 *
 * After the first successful open the wire self-heals: an abnormal close drops
 * the socket and the next dispatch send re-opens + re-initializes it (bounded
 * by `reconnect.maxAttempts`). A failed re-bootstrap surfaces as a rejected
 * send → the dispatcher emits a terminal `error` so the client is never left
 * silently dead.
 */
export async function bootstrapAcpWire(input: AcpWireBootstrapInput): Promise<AcpWireBootstrapResult> {
  const url = deriveAcpUrl(input.wsUrl);
  const factory = input.wsFactory ?? defaultWsFactory;
  const openTimeoutMs = input.openTimeoutMs ?? OPEN_TIMEOUT_MS_DEFAULT;
  const reconnect = input.reconnect ?? DEFAULT_ACP_WIRE_RECONNECT;
  const sessionId = input.sessionId ?? "unknown";

  log.info("bootstrap.begin", { sessionId, url });

  // Late-bound so the socket's `reinitialize` can call acpConn.initialize once
  // acpConn exists. The first open below awaits this — by which point the ref
  // is set.
  let acpConn: AcpPerProfileConnection | null = null;

  const socket = createManagedAcpSocket({
    url,
    token: input.token,
    wsFactory: factory,
    openTimeoutMs,
    reconnect,
    sessionId,
    reinitialize: async () => {
      if (acpConn === null) {
        throw new Error("acp-wire-bootstrap: reinitialize before acpConn bound");
      }
      await acpConn.initialize();
    },
    ...(input.sleep ? { sleep: input.sleep } : {}),
  });

  acpConn = createAcpPerProfileConnection({
    send: (raw: string) => socket.send(raw),
    onIncoming: (cb) => socket.onIncoming(cb),
  });

  try {
    // Drive the first open + initialize. `open()` runs `openOnce`, which opens
    // the WS, sets it live, then calls `reinitialize` (= acpConn.initialize).
    // initialize's own send sees the now-open socket and goes out directly —
    // no reentrancy. On reconnect the same path re-runs from the next send.
    await socket.open();
  } catch (err: unknown) {
    log.warn("bootstrap.initialize-failed", {
      sessionId,
      reason: err instanceof Error ? err.message : String(err),
    });
    acpConn.dispose();
    socket.dispose();
    throw err;
  }

  log.info("bootstrap.done", { sessionId, url });

  let disposed = false;
  return {
    acpConn,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      log.debug("dispose", { sessionId });
      acpConn?.dispose();
      socket.dispose();
    },
  };
}
