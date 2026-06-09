import { getLog } from "../logging/logger.js";
import { safeClose, waitForOpen } from "./acp-wire-open.js";
import type { AcpWsFactory, AcpWsLike } from "./acp-ws.js";

const log = getLog(["sentient", "hermes-adapter-client", "acp-wire-socket"]);

// ---------------------------------------------------------------------------
// ManagedAcpSocket — a swappable raw WS behind a STABLE send/onIncoming pair.
//
// The per-profile connection (and the dispatcher referencing it) is built once,
// against the closures this module exposes. When the underlying WS dies on a
// REMOTE close — abnormal (e.g. 1006 after a gateway restart / resume) OR a
// remote normal-closure (1000, e.g. an overlay restart) — the next `send`
// lazily re-opens a fresh socket and re-runs the ACP `initialize` handshake
// (the `reinitialize` callback) BEFORE the queued send proceeds. The stable
// `acpConn` reference never changes — only the socket underneath is replaced —
// so the cerebrum dispatcher keeps dispatching cycles transparently.
//
// The ONLY genuinely-terminal path is local `dispose()` (consumer disconnect):
// it sets `disposed` BEFORE closing, so the close listener can tell its own
// teardown apart from a remote close. A remote 1000 is NOT terminal — the
// overlay closing the wire must not permanently strand an active client; it
// flows through the same lazy-reconnect path as an abnormal close.
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
  /**
   * Fired when a LIVE socket closes REMOTELY — abnormal (code !== 1000) OR a
   * remote normal-closure (1000, e.g. overlay restart). Either way the wire is
   * gone and any in-flight `session/prompt` will never be answered, so the
   * connection layer rejects pending requests and the dispatcher's queue can't
   * hang forever. NOT fired on local `dispose` (that rejects pending via its own
   * path). Throwing handlers are caught and logged.
   */
  readonly onRemoteClose?: () => void;
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
  /**
   * Ensure the wire is open (lazily reconnecting + re-initializing on the same
   * bounded-backoff path `send` uses), without sending anything. The connection
   * layer awaits this BEFORE reading `epoch()` so the load-or-not decision sees
   * the FINAL post-reconnect generation — otherwise a `send`-triggered reconnect
   * would bump the epoch after the decision, landing a prompt on an unloaded
   * fresh child.
   */
  ensureReady(): Promise<void>;
  /** Register the inbound pump. Survives socket swaps. */
  onIncoming(cb: (raw: string) => void): void;
  /**
   * Monotonic generation counter — bumps once per successful socket open.
   * Lets the connection layer detect a fresh-since-reconnect child so it can
   * re-attach (`session/load`) a captured conversation before the next prompt.
   * Starts at 0 before the first open; the first open makes it 1.
   */
  epoch(): number;
  /** Tear down the current socket and block all future reconnects. Idempotent. */
  dispose(): void;
}

const DISPOSED_ERROR = "acp-wire-socket: disposed";

export function createManagedAcpSocket(input: ManagedAcpSocketInput): ManagedAcpSocket {
  const sleep = input.sleep ?? defaultSleep;
  let ws: AcpWsLike | null = null;
  // The ONLY terminal local-intent flag. `dispose()` sets this BEFORE closing
  // the socket, so the close listener can tell its own teardown apart from a
  // remote close. A remote close (any code, including 1000) is NOT terminal —
  // it flows through the lazy-reconnect path.
  let disposed = false;
  let onIncomingCb: ((raw: string) => void) | null = null;
  // In-flight (re)open promise — collapses concurrent sends into one handshake.
  let opening: Promise<void> | null = null;
  // Bumps once per successful open. The connection layer reads this to detect a
  // fresh-since-reconnect child (re-attach the captured session before prompt).
  let epoch = 0;

  function attachListeners(socket: AcpWsLike): void {
    socket.addEventListener("message", (evt) => {
      // Guard against cross-talk from a stale socket after a swap: only the
      // live socket's frames are pumped. An old handle whose `close` lagged the
      // swap could otherwise inject frames against the wrong epoch.
      if (ws !== socket) return;
      if (typeof evt.data !== "string") return;
      if (onIncomingCb) onIncomingCb(evt.data);
    });
    socket.addEventListener("close", (e) => {
      const wasLive = ws === socket;
      // Drop the dead handle so the NEXT send lazily re-opens. We never eagerly
      // reconnect here — lazy-ensure on send keeps the acpConn reference stable
      // and avoids storms when no cycle is in flight.
      if (wasLive) ws = null;
      // Local `dispose()` is the ONLY terminal path: it sets `disposed` BEFORE
      // closing, so this close is our own teardown. Don't reconnect, don't
      // reject in-flight (dispose handles that via acpConn.dispose).
      if (disposed) {
        log.info("ws.close.terminal", {
          sessionId: input.sessionId,
          code: e.code,
          reason: e.reason,
          cause: "disposed",
        });
        return;
      }
      // Any REMOTE close is reconnectable (the next send re-dials); paths differ
      // only in log LEVEL — a remote 1000 (overlay restart) is an expected clean
      // drop (INFO), anything else is a degraded flap (WARN).
      const closeFields = {
        sessionId: input.sessionId,
        code: e.code,
        reason: e.reason,
        willReconnectOnNextSend: true,
        notifyRemoteClose: wasLive,
      };
      if (e.code === NORMAL_CLOSURE_CODE) log.info("ws.close.remote-clean", closeFields);
      else log.warn("ws.close.abnormal", closeFields);
      // Only the LIVE socket's remote close rejects in-flight requests: a request
      // on a stale (already-swapped) socket has already been retried or rejected.
      // A pre-open close is handled by waitForOpen, not here.
      if (wasLive && input.onRemoteClose) {
        try {
          input.onRemoteClose();
        } catch (err: unknown) {
          log.warn("ws.close.remote.notify-threw", {
            sessionId: input.sessionId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
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
    // Mark the fresh child live ONLY after initialize succeeds. The bump tells
    // the connection layer this is a new epoch with empty in-process session
    // state, so it re-attaches (session/load) the captured conversation before
    // the next prompt.
    epoch += 1;
    log.info("open.done", { sessionId: input.sessionId, epoch });
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
      // session.configure (acquireAcpWireOrFail → null); the SDK's own
      // reconnect retries the whole handshake. Bounded backoff is reserved for
      // the post-healthy reconnect path (lazy ensure on send).
      return ensureOpen(openOnce);
    },
    ensureReady(): Promise<void> {
      return ensureOpen(ensureOpenWithBackoff);
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
    epoch(): number {
      return epoch;
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
