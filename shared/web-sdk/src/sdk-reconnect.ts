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
// sessionStorage["sentient.currentSessionId"] anchors a tab to one conversation
// across reloads + reconnects. The tab PRESENTS it as `conversationId` on
// `session.configure`, and the gateway answers with exactly one of two frames
// (ws-session-configure.ts): `session.attached` when the id resolved to a
// session this caller's store holds, or `session.draft` when it refused it and
// started a fresh draft instead. Those two frames are the only inputs here.
//
// THE POINTER IS DROPPED ON AN EXPLICIT REFUSAL, NEVER ON A CLOCK. An earlier
// shape armed a ~200ms timer on `conversation.snapshot` and deleted the id
// unless a `session.switched` disarmed it. Only the drawer path sends
// `switched`; a plain reload confirms with `session.attached`, so the timer
// deleted an id that had just resolved CORRECTLY — and the tab, now presenting
// nothing, landed in a new empty chat on the next reconnect and fragmented one
// conversation into several. A timer fires on SILENCE, which is why a correct
// resume tripped it; only the server can say no.
//
// Exposed here (not in a separate module) because the session-pointer handlers
// in sentient-sdk.ts are the only call sites.
// ---------------------------------------------------------------------------

export const CURRENT_SESSION_STORAGE_KEY = "sentient.currentSessionId";

// The id this connection PRESENTED on `session.configure` — a session id or an
// unspent draft key — held until the gateway answers it. Set by
// `markSessionPresented`, cleared by `setCurrentSessionId` (honoured) or
// `clearRefusedSessionId` (refused). `null` means this connection presented
// NOTHING, which is a first-ever connect and not a refusal: it is the left half
// of the conjunction `clearRefusedSessionId` guards on.
let presentedSessionId: string | null = null;

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
 * Record the id `session.configure` is about to present, so a later refusal can
 * be told apart from a first-ever connect. Called from the one place that reads
 * the pointer for the wire, so "what was presented" cannot drift from what
 * actually went out. An empty value presents nothing.
 */
export function markSessionPresented(sessionId: string | null): void {
  presentedSessionId = sessionId === "" ? null : sessionId;
}

/**
 * Anchor this tab to [sessionId] — the gateway HONOURED an id, or named a new
 * one. Called on session.attached / session.created / session.switched, and on
 * the draft key a `session.draft` carries. Clears the presented marker: the
 * answer has arrived, so nothing later on this connection is a refusal of it.
 */
export function setCurrentSessionId(sessionId: string): void {
  if (!sessionId) return;
  writeSessionStorage(CURRENT_SESSION_STORAGE_KEY, sessionId);
  presentedSessionId = null;
}

/**
 * Drop the pointer because the gateway did NOT honour the id this tab
 * presented — it answered `session.draft` where `session.attached` was the
 * honouring answer (ws-session-configure.ts logs
 * `session-configure.session.refused`). Without this the tab re-presents a
 * session its store cannot resolve on every reconnect, forever.
 *
 * THE CONDITION IS A CONJUNCTION — presented AND not honoured. A first-ever
 * connect presents nothing and is answered with `session.draft` too; reading
 * that as a refusal would have it delete a pointer it never had. Pressing "+"
 * is NOT an exception to write around: it also answers `session.draft`, and
 * dropping the pointer there is exactly right — the user asked for a new chat.
 *
 * [answeredDraftKey] is for the LOG, never for the decision: a tab that
 * reloaded mid-draft presents its draft key and gets the SAME key back, which
 * the gateway records as `draft.resumed`. The drop still runs (the caller
 * re-anchors on that key immediately, so the net effect is identical), but a
 * line reading "refused" there would contradict the gateway's own trail for a
 * case it honoured. `null` means the answer was not a draft frame at all.
 */
export function clearRefusedSessionId(answeredDraftKey: string | null): void {
  if (presentedSessionId === null) return;
  sdkLog.info("session-pointer.dropped", {
    presentedId: presentedSessionId,
    answeredDraftKey,
    reason:
      answeredDraftKey === presentedSessionId
        ? "gateway resumed the draft this tab presented — re-anchoring on the same key"
        : "gateway did not honour the presented id — dropping it so the next connect starts clean",
  });
  removeSessionStorage(CURRENT_SESSION_STORAGE_KEY);
  presentedSessionId = null;
}

/** Test helper — reset module state between tests. */
export function _resetSessionPointerForTests(): void {
  presentedSessionId = null;
}

/**
 * Read the current tab's session id from sessionStorage.
 * Shared by `sentient-sdk.ts` (the id presented on session.configure) and
 * `stream-resume-handler.ts` to avoid inlining the storage key literal.
 */
export function getCurrentSessionId(): string | null {
  return readSessionStorage(CURRENT_SESSION_STORAGE_KEY);
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
