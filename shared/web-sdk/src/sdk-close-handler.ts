// ---------------------------------------------------------------------------
// sdk-close-handler — WS lifecycle closing logic for SentientSDK.
//
// Three close paths the SDK must distinguish:
//   1. Consumer-driven (`disconnect()`) — no reconnect.
//   2. Presence-driven idle close — PresenceCoordinator reopens on return.
//   3. Unexpected (browser kill, network drop, server restart) — kick the
//      reconnect controller's bounded-backoff loop.
//
// The functions here are pure delegates: they read/write SDK state through
// the deps interface so the main `sentient-sdk.ts` stays under the 300-line
// clean-code budget.
// ---------------------------------------------------------------------------

import type { SDKStatus } from "./connector-types.ts";
import { sdkLog } from "./debug.ts";

const WS_NORMAL_CLOSURE = 1000;
const IDLE_CLOSE_REASON = "idle-timeout";
const RECONNECT_TEARDOWN_REASON = "reconnect";

type ErrorKind = "auth" | "network" | "timeout" | null;

export interface CloseHandlerDeps {
  getWs: () => WebSocket | null;
  setWs: (ws: WebSocket | null) => void;
  getStatus: () => SDKStatus;
  setStatus: (s: SDKStatus) => void;
  /** True if presence is configured. */
  hasPresence: () => boolean;
  /** True if the last close was presence-driven. */
  isIdleClosed: () => boolean;
  /** True if `disconnect()` was called by the consumer. */
  isConsumerDisconnected: () => boolean;
  /** True when an idle-close raced with a presence-return. */
  isPendingPresenceReconnect: () => boolean;
  setPendingPresenceReconnect: (v: boolean) => void;
  setLastErrorKind: (k: ErrorKind) => void;
  getLastErrorKind: () => ErrorKind;
  clearTimers: () => void;
  detachAll: () => void;
  /** Re-open after an idle-close race. Returns the connect promise. */
  presenceReconnect: () => Promise<void>;
  /** Kick the unexpected-close reconnect loop. */
  forceReconnect: () => void;
}

/**
 * Tear down the current WS without firing onclose. Used by the reconnect
 * controller before each retry. Idempotent.
 */
export function teardownWsForReconnect(deps: CloseHandlerDeps): void {
  const ws = deps.getWs();
  if (ws !== null) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.onerror = null;
    try {
      ws.close(WS_NORMAL_CLOSURE, RECONNECT_TEARDOWN_REASON);
    } catch {
      /* already closing — ignore */
    }
    deps.setWs(null);
  }
  deps.clearTimers();
  deps.detachAll();
  if (deps.getStatus() !== "disconnected") deps.setStatus("disconnected");
}

/**
 * Presence-driven idle close. Drops the WS politely and clears handlers but
 * leaves onclose attached so handleSocketClose still fires for status flip.
 */
export function softCloseForIdle(deps: CloseHandlerDeps): void {
  const ws = deps.getWs();
  if (ws === null) return;
  if (deps.getStatus() === "disconnected") return;
  sdkLog.debug("presence-idle close", { status: deps.getStatus() });
  deps.clearTimers();
  deps.detachAll();
  ws.onmessage = null;
  ws.close(WS_NORMAL_CLOSURE, IDLE_CLOSE_REASON);
  deps.setWs(null);
}

/**
 * Bridge for the presence coordinator's onPresenceReturn → SDK.connect call.
 * Buffers the request when an in-flight close hasn't yet flipped status to
 * disconnected; handleSocketClose fires the deferred connect once it does.
 */
export function reconnectAfterIdle(deps: CloseHandlerDeps): void {
  if (deps.getStatus() !== "disconnected") {
    sdkLog.debug("race: reconnect-deferred", { status: deps.getStatus() });
    deps.setPendingPresenceReconnect(true);
    return;
  }
  sdkLog.debug("presence-return reconnect");
  deps
    .presenceReconnect()
    .catch((err: unknown) => sdkLog.warn("presence-return reconnect failed", { err: String(err) }));
}

/**
 * Triggered on every WS close. Decides between three actions:
 *   - presence-driven race: continue the deferred presence-return reconnect
 *   - consumer / idle close: no-op (the appropriate path already owns recovery)
 *   - everything else: kick the unexpected-close reconnect loop
 */
export function handleSocketClose(deps: CloseHandlerDeps): void {
  deps.clearTimers();
  const prevStatus = deps.getStatus();
  const wasLive = prevStatus !== "disconnected" && prevStatus !== "error";
  if (prevStatus !== "disconnected") deps.setStatus("disconnected");

  if (deps.isPendingPresenceReconnect()) {
    deps.setPendingPresenceReconnect(false);
    if (deps.isIdleClosed()) {
      sdkLog.debug("race: rapid idle-return-idle, suppressing reconnect");
      return;
    }
    sdkLog.debug("race: deferred-reconnect-firing-now");
    deps
      .presenceReconnect()
      .catch((err: unknown) => sdkLog.warn("presence-return reconnect failed", { err: String(err) }));
    return;
  }

  if (deps.isConsumerDisconnected()) return;
  if (deps.hasPresence() && deps.isIdleClosed()) return; // PresenceCoordinator handles the reopen.

  if (wasLive) {
    sdkLog.info("unexpected-close → forceReconnect");
    if (deps.getLastErrorKind() === null) deps.setLastErrorKind("network");
    deps.forceReconnect();
  }
}
