import { getLog } from "../logging/logger.js";
import { safeClose, waitForOpen } from "./acp-wire-open.js";
import type { AcpWsFactory, AcpWsLike } from "./acp-ws.js";

const log = getLog(["sentient", "hermes-adapter-client", "acp-wire-socket"]);

// ---------------------------------------------------------------------------
// ManagedAcpSocket — a swappable raw WS behind a STABLE send/onIncoming pair.
//
// The per-profile connection (and the dispatcher referencing it) is built once,
// against the closures this module exposes. When the underlying WS dies on an
// ABNORMAL close (e.g. 1006 after a gateway restart / resume), the next `send`
// lazily re-opens a fresh socket and re-runs the ACP `initialize` handshake
// (the `reinitialize` callback) BEFORE the queued send proceeds. The stable
// `acpConn` reference never changes — only the socket underneath is replaced —
// so the cerebrum dispatcher keeps dispatching cycles transparently.
//
// Clean teardown (dispose) and a normal-closure (1000) close NEVER reconnect:
// we don't fight an intentional shutdown.
//
// Strategy is lazy-ensure (reconnect on the next send) rather than eager
// reconnect-on-close: it keeps the acpConn reference stable, avoids reconnect
// storms when no cycle is in flight, and recovers exactly when a dispatch needs
// the wire. Reconnect is bounded by maxAttempts with exponential backoff.
// ---------------------------------------------------------------------------

const READY_STATE_OPEN = 1;
const NORMAL_CLOSURE_CODE = 1000;

export interface AcpWireReconnectConfig {
  /** First backoff delay (ms). */
  readonly baseMs: number;
  /** Backoff ceiling (ms). */
  readonly maxMs: number;
  /** Random jitter added to each backoff (ms). */
  readonly jitterMs: number;
  /** Max re-open attempts before `ensureOpen` rejects. */
  readonly maxAttempts: number;
}

export const DEFAULT_ACP_WIRE_RECONNECT: AcpWireReconnectConfig = {
  baseMs: 500,
  maxMs: 5_000,
  jitterMs: 250,
  maxAttempts: 5,
};

export interface ManagedAcpSocketInput {
  /** Derived `/acp` URL. */
  readonly url: string;
  /** Bearer token for the handshake. */
  readonly token: string;
  /** WS factory — production uses Bun's WebSocket; tests inject a mock. */
  readonly wsFactory: AcpWsFactory;
  /** Hard timeout for each WS open handshake (ms). */
  readonly openTimeoutMs: number;
  /** Reconnect backoff tunables. */
  readonly reconnect: AcpWireReconnectConfig;
  /** sessionId for trace correlation. */
  readonly sessionId: string;
  /**
   * Re-run the ACP `initialize` handshake on a freshly opened socket. Wired by
   * the bootstrap to `acpConn.initialize`. MUST resolve before the socket is
   * considered usable for dispatch sends.
   */
  readonly reinitialize: () => Promise<void>;
  /** Sleep injection — tests pass a fake. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ManagedAcpSocket {
  /**
   * Open the first socket + run the initial handshake. Awaited once by the
   * bootstrap. Rejects (bounded) if the open / initialize fails. Idempotent —
   * a second call while open is a no-op.
   */
  open(): Promise<void>;
  /** Stable outbound transport. Lazily (re)opens + re-initializes on demand. */
  send(raw: string): Promise<void>;
  /** Register the inbound pump. Survives socket swaps. */
  onIncoming(cb: (raw: string) => void): void;
  /** Tear down the current socket and block all future reconnects. Idempotent. */
  dispose(): void;
}

const DISPOSED_ERROR = "acp-wire-socket: disposed";
const CLEAN_CLOSED_ERROR = "acp-wire-socket: wire closed cleanly (1000) — reconnect blocked";

export function createManagedAcpSocket(input: ManagedAcpSocketInput): ManagedAcpSocket {
  const sleep = input.sleep ?? defaultSleep;
  let ws: AcpWsLike | null = null;
  let disposed = false;
  // A normal-closure (1000) of the LIVE socket is a deliberate teardown
  // (server-side session end). Block reconnect — don't fight an intentional
  // shutdown. Distinct from `disposed` (consumer-driven local teardown).
  let cleanClosed = false;
  let onIncomingCb: ((raw: string) => void) | null = null;
  // In-flight (re)open promise — collapses concurrent sends into one handshake.
  let opening: Promise<void> | null = null;

  function attachListeners(socket: AcpWsLike): void {
    socket.addEventListener("message", (evt) => {
      if (typeof evt.data !== "string") return;
      if (onIncomingCb) onIncomingCb(evt.data);
    });
    socket.addEventListener("close", (e) => {
      const wasLive = ws === socket;
      const abnormal = e.code !== NORMAL_CLOSURE_CODE;
      // Drop the dead handle so the NEXT send triggers a re-open (abnormal) or
      // surfaces a clean-closed error (normal / deliberate). We never eagerly
      // reconnect here — lazy-ensure on send keeps the acpConn reference stable
      // and avoids storms when no cycle is in flight.
      if (wasLive) ws = null;
      if (disposed) {
        log.info("ws.close.clean", { sessionId: input.sessionId, code: e.code, reason: e.reason, cause: "disposed" });
        return;
      }
      if (abnormal) {
        log.warn("ws.close.abnormal", {
          sessionId: input.sessionId,
          code: e.code,
          reason: e.reason,
          willReconnectOnNextSend: true,
        });
        return;
      }
      // Normal closure of the live socket → deliberate teardown; latch off
      // reconnect. (A 1000 mid-handshake is handled by waitForOpen's reject and
      // must NOT latch — only a close of the established live socket counts.)
      if (wasLive) cleanClosed = true;
      log.info("ws.close.clean", {
        sessionId: input.sessionId,
        code: e.code,
        reason: e.reason,
        reconnectBlocked: wasLive,
      });
    });
    socket.addEventListener("error", () => {
      log.warn("ws.error", { sessionId: input.sessionId });
    });
  }

  async function openOnce(): Promise<void> {
    log.info("open.begin", { sessionId: input.sessionId, url: input.url });
    const socket = input.wsFactory(input.url, input.token);
    await waitForOpen(socket, input.openTimeoutMs, input.url, input.sessionId);
    attachListeners(socket);
    ws = socket;
    // Re-establish the ACP session binding on the fresh socket BEFORE any
    // dispatch send can proceed. A re-bootstrap re-runs `initialize`; the
    // per-conversation sessionId is owned by the dispatch layer and re-targeted
    // on the next prompt, so no Hermes resume call is needed here. On failure,
    // tear the half-open socket down so the next attempt starts clean.
    try {
      await input.reinitialize();
    } catch (err: unknown) {
      if (ws === socket) ws = null;
      safeClose(socket);
      throw err;
    }
    log.info("open.done", { sessionId: input.sessionId });
  }

  async function ensureOpenWithBackoff(): Promise<void> {
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < input.reconnect.maxAttempts) {
      attempt += 1;
      if (disposed) throw new Error(DISPOSED_ERROR);
      try {
        log.info("reconnect.attempt", { sessionId: input.sessionId, attempt, max: input.reconnect.maxAttempts });
        await openOnce();
        log.info("reconnect.success", { sessionId: input.sessionId, attempt });
        return;
      } catch (err: unknown) {
        lastErr = err;
        ws = null;
        const reason = err instanceof Error ? err.message : String(err);
        log.warn("reconnect.attempt-failed", { sessionId: input.sessionId, attempt, reason });
        if (attempt >= input.reconnect.maxAttempts) break;
        if (disposed) throw new Error(DISPOSED_ERROR);
        const delayMs = computeBackoffMs(attempt, input.reconnect);
        log.debug("reconnect.backoff", { sessionId: input.sessionId, delayMs });
        await sleep(delayMs);
      }
    }
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    log.warn("reconnect.exhausted", { sessionId: input.sessionId, attempts: attempt, reason });
    throw new Error(`acp-wire-socket.reconnect-exhausted: ${attempt} attempt(s); last=${reason}`);
  }

  function ensureOpen(opener: () => Promise<void>): Promise<void> {
    if (disposed) return Promise.reject(new Error(DISPOSED_ERROR));
    if (cleanClosed) return Promise.reject(new Error(CLEAN_CLOSED_ERROR));
    if (ws !== null && ws.readyState === READY_STATE_OPEN) return Promise.resolve();
    if (opening !== null) return opening;
    opening = opener().finally(() => {
      opening = null;
    });
    return opening;
  }

  return {
    open(): Promise<void> {
      // First open is a SINGLE attempt — a failed initial connect rejects the
      // session.configure (bootstrapAcpWireOrFail → null); the SDK's own
      // reconnect retries the whole handshake. Bounded backoff is reserved for
      // the post-healthy reconnect path (lazy ensure on send).
      return ensureOpen(openOnce);
    },
    async send(raw: string): Promise<void> {
      await ensureOpen(ensureOpenWithBackoff);
      if (ws === null || ws.readyState !== READY_STATE_OPEN) {
        throw new Error("acp-wire-socket.send: WS not open after ensure");
      }
      ws.send(raw);
    },
    onIncoming(cb: (raw: string) => void): void {
      onIncomingCb = cb;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      log.debug("dispose", { sessionId: input.sessionId });
      const socket = ws;
      ws = null;
      if (socket) safeClose(socket);
    },
  };
}

function computeBackoffMs(attempt: number, cfg: AcpWireReconnectConfig): number {
  const exponential = cfg.baseMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, cfg.maxMs);
  const jitter = Math.random() * cfg.jitterMs;
  return Math.round(capped + jitter);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
