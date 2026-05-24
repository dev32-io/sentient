// ---------------------------------------------------------------------------
// ReconnectController — drives the SDK's unexpected-close recovery loop.
//
// Owns:
//   - forceReconnect()      — tear down the current WS + restart connect()
//                             with bounded exponential backoff. Surfaces
//                             onConnectionLost after exhaustion.
//   - probeAndReconnect()   — verify the WS is actually alive (readyState +
//                             one ping/pong probe). Triggers forceReconnect
//                             if dead. Used by visibility/online events.
//
// Extracted from sentient-sdk.ts so the WS lifecycle file stays under the
// project's 300-line clean-code budget.
// ---------------------------------------------------------------------------

import type { ReconnectConfig, SDKStatus } from "./connector-types.ts";
import { sdkLog } from "./debug.ts";

const WS_READY_STATE_OPEN = 1;

// ---------------------------------------------------------------------------
// Per-tab "current session" pointer
//
// sessionStorage["sentient.currentSessionId"] anchors a tab to a Hermes chain
// across reloads + reconnects. The SDK appends it to the WS connect URL as
// `?session_id=`, the gateway runs the resume flow, and (on success) emits a
// session.switched frame that re-anchors the pointer.
//
// Exposed here (not in a separate module) because the URL builder + the
// snapshot/switched handlers in sentient-sdk.ts are the only call sites.
// ---------------------------------------------------------------------------

const CURRENT_SESSION_STORAGE_KEY = "sentient.currentSessionId";

// Set by buildConnectUrl when a stored session id is attached to the URL.
// Cleared by markResumeResolved (success) or clearStaleResumeId (404 fallback).
// Module-level state survives the URL-builder call → the message handlers in
// sentient-sdk.ts read it back when correlating snapshot/switched frames.
let pendingResume: string | null = null;

function readSessionStorage(key: string): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(key, value);
  } catch {
    /* storage disabled / quota — non-fatal */
  }
}

function removeSessionStorage(key: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(key);
  } catch {
    /* storage disabled — non-fatal */
  }
}

/**
 * Build the WS connect URL from the configured gateway URL plus the current
 * sessionStorage["sentient.currentSessionId"] (when present). Captures the id
 * into module-level pendingResume so the snapshot/switched correlation can
 * detect a 404 fallback later. Idempotent — safe to call on every connect.
 */
export function buildConnectUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // Non-URL gateway strings (rare; e.g. mock/test seams) — fall through
    // unmodified rather than throw mid-connect.
    pendingResume = null;
    return base;
  }
  const stored = readSessionStorage(CURRENT_SESSION_STORAGE_KEY);
  if (stored !== null && stored !== "") {
    url.searchParams.set("session_id", stored);
    pendingResume = stored;
  } else {
    pendingResume = null;
  }
  return url.toString();
}

/**
 * Update sessionStorage["sentient.currentSessionId"]. Called from the SDK
 * message router on session.created / session.switched. Also clears
 * pendingResume — the resume completed successfully, so a subsequent snapshot
 * is NOT a 404 fallback signal.
 */
export function setCurrentSessionId(sessionId: string): void {
  if (!sessionId) return;
  writeSessionStorage(CURRENT_SESSION_STORAGE_KEY, sessionId);
  pendingResume = null;
}

/**
 * Detect the "snapshot without preceding session.switched" 404 fallback.
 * Called from the SDK message router when conversation.snapshot arrives.
 * If a resume was pending and no switched cleared it first, the stored id
 * is stale → drop sessionStorage and pendingResume so the next reconnect
 * starts a fresh chain instead of hammering a deleted id forever.
 *
 * NOTE: on a successful resume the gateway sends `session.switched` BEFORE
 * `conversation.snapshot` (ws-session-configure.ts onSnapshot callback —
 * order required by the ConversationHistoryConnector's awaitingSnapshot
 * gate). `setCurrentSessionId` therefore clears `pendingResume` first; the
 * subsequent snapshot sees `hasPendingResume() === false` and never arms
 * the stale timer. The 404 fallback path sends snapshot only — no switched
 * — so `hasPendingResume()` is still true at snapshot time and the timer
 * arms; if no switched arrives within STALE_RESUME_CHECK_MS, the stored id
 * is dropped.
 */
export function clearStaleResumeId(): void {
  if (pendingResume === null) return;
  sdkLog.info("session-resume.fallback-cleared", {
    staleId: pendingResume,
    reason: "snapshot-without-switched",
  });
  removeSessionStorage(CURRENT_SESSION_STORAGE_KEY);
  pendingResume = null;
}

/** True iff a resume id is in flight (URL-attached, not yet acknowledged). */
export function hasPendingResume(): boolean {
  return pendingResume !== null;
}

/** Test helper — reset module state between tests. */
export function _resetResumeStateForTests(): void {
  pendingResume = null;
}

export interface ReconnectControllerDeps {
  /** Try a single connect/auth/session.ready cycle. Resolves on `ready`, rejects on auth/timeout/network failure. */
  connect: () => Promise<void>;
  /** Tear down the current WS without firing onclose. Idempotent. */
  teardownWs: () => void;
  /** Read the current WS (or null). */
  getWs: () => WebSocket | null;
  /** Read the current SDK status. */
  getStatus: () => SDKStatus;
  /** Set the SDK status. */
  setStatus: (next: SDKStatus) => void;
  /** Send a JSON message over the WS (no error if dead — caller is responsible). */
  rawSend: (payload: unknown) => void;
  /** Subscribe to a typed message; returns unsubscribe. */
  subscribe: (type: string, handler: (msg: unknown) => void) => () => void;
  /** True if the consumer has called disconnect() (no auto-reconnect). */
  isConsumerDisconnected: () => boolean;
  /** True if presence drove the close (PresenceCoordinator handles its own reconnect). */
  isIdleClosed: () => boolean;
  /** Read kind of the most recent connect() error, or null. */
  getLastErrorKind: () => "auth" | "network" | "timeout" | null;
  /** Optional consumer hooks. */
  onConnectionLost?: () => void;
  onAuthExpired?: () => void;
  /** Reconnect tunables. */
  config: ReconnectConfig;
  /** Sleep injection — tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ReconnectController {
  forceReconnect(): void;
  probeAndReconnect(): Promise<void>;
  isInFlight(): boolean;
  /** Clear in-flight state — called on consumer disconnect to abort any pending loop. */
  cancel(): void;
}

const PING_TYPE = "ping";
const PONG_TYPE = "pong";

export function createReconnectController(deps: ReconnectControllerDeps): ReconnectController {
  const sleep = deps.sleep ?? defaultSleep;
  let inFlight = false;
  let cancelled = false;

  function forceReconnect(): void {
    if (inFlight) {
      sdkLog.debug("reconnect: already in flight");
      return;
    }
    if (deps.isConsumerDisconnected()) {
      sdkLog.debug("reconnect: skipped (consumer-disconnected)");
      return;
    }
    inFlight = true;
    cancelled = false;
    void runReconnectLoop();
  }

  async function runReconnectLoop(): Promise<void> {
    let attempt = 0;
    while (!cancelled && attempt < deps.config.maxAttempts) {
      attempt += 1;
      sdkLog.info("reconnect: attempt", { attempt, max: deps.config.maxAttempts });
      deps.teardownWs();
      // teardownWs flips status to disconnected; flag the loop's intent so
      // downstream UI can render "Reconnecting…" instead of plain "connecting".
      deps.setStatus("reconnecting");
      try {
        await deps.connect();
        sdkLog.info("reconnect: success", { attempt });
        inFlight = false;
        return;
      } catch (err) {
        const kind = deps.getLastErrorKind();
        sdkLog.warn("reconnect: attempt failed", { attempt, kind, err: String(err) });
        if (kind === "auth") {
          // Auth-expired is terminal — the token won't get better with retries.
          inFlight = false;
          deps.setStatus("disconnected");
          deps.onAuthExpired?.();
          return;
        }
        if (cancelled) {
          inFlight = false;
          return;
        }
        if (attempt >= deps.config.maxAttempts) break;
        const delay = computeBackoffMs(attempt, deps.config);
        sdkLog.debug("reconnect: backoff", { delayMs: Math.round(delay) });
        await sleep(delay);
      }
    }
    sdkLog.warn("reconnect: exhausted", { attempts: attempt });
    inFlight = false;
    deps.setStatus("disconnected");
    if (!cancelled) deps.onConnectionLost?.();
  }

  async function probeAndReconnect(): Promise<void> {
    if (inFlight) {
      sdkLog.debug("probe: reconnect in flight, skipping probe");
      return;
    }
    if (deps.isConsumerDisconnected()) {
      sdkLog.debug("probe: skipped (consumer-disconnected)");
      return;
    }
    if (deps.isIdleClosed()) {
      sdkLog.debug("probe: idle-closed, deferring to presence path");
      return;
    }
    const status = deps.getStatus();
    if (status === "disconnected" || status === "error") {
      sdkLog.debug("probe: status is disconnected/error, forcing reconnect", { status });
      forceReconnect();
      return;
    }
    const ws = deps.getWs();
    if (!ws || ws.readyState !== WS_READY_STATE_OPEN) {
      sdkLog.warn("probe: ws not open, forcing reconnect", { readyState: ws?.readyState });
      forceReconnect();
      return;
    }
    if (status !== "ready") {
      // Mid-handshake — let it complete or fail on its own. Don't probe a
      // half-open auth flow.
      sdkLog.debug("probe: handshake in progress, skipping ping", { status });
      return;
    }
    const alive = await pingProbe();
    if (!alive) {
      sdkLog.warn("probe: pong timeout, forcing reconnect");
      forceReconnect();
    }
  }

  function pingProbe(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const unsub = deps.subscribe(PONG_TYPE, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(true);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        resolve(false);
      }, deps.config.probePingTimeoutMs);
      try {
        deps.rawSend({ type: PING_TYPE, at: Date.now() });
      } catch (err) {
        sdkLog.debug("probe: send failed", { err: String(err) });
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          unsub();
          resolve(false);
        }
      }
    });
  }

  return {
    forceReconnect,
    probeAndReconnect,
    isInFlight: () => inFlight,
    cancel() {
      cancelled = true;
      inFlight = false;
    },
  };
}

function computeBackoffMs(attempt: number, cfg: ReconnectConfig): number {
  const exponential = cfg.baseMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, cfg.maxMs);
  const jitter = Math.random() * cfg.jitterMs;
  return capped + jitter;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Pair of resolve/reject wrappers that fire at most once. Used by
 * SentientSDK.connect to make `onclose`-before-`session.ready` safely
 * reject the outer Promise so the reconnect loop can retry instead of
 * awaiting a hung connect.
 */
export function createSettlePair(
  resolve: () => void,
  reject: (err: Error) => void,
): { ok: () => void; fail: (err: Error) => void } {
  let settled = false;
  return {
    ok: () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    },
    fail: (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    },
  };
}
