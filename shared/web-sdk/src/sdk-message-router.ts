// ---------------------------------------------------------------------------
// sdk-message-router — JSON message dispatching for SentientSDK.
//
// Distinct from connector message subscriptions: this layer recognizes the
// SDK's own protocol frames (`auth.ok`, `auth.error`, `session.ready`,
// `connector.cancelled`) and dispatches everything else to per-type
// connector handlers.
//
// Extracted to keep `sentient-sdk.ts` under the 300-line clean-code budget.
// ---------------------------------------------------------------------------

import type { Connector, SDKStatus, SessionReadyPayload } from "./connector-types.ts";
import { sdkLog } from "./debug.ts";
import type { SdkTimers } from "./sdk-timers.ts";
import { handleSessionReady as readyDispatcher } from "./session-ready-handler.ts";

type ErrorKind = "auth" | "network" | "timeout" | null;

export interface MessageRouterDeps {
  getStatus: () => SDKStatus;
  setStatus: (s: SDKStatus) => void;
  setLastErrorKind: (k: ErrorKind) => void;
  timers: SdkTimers;
  /** Send `session.configure` after auth.ok. */
  sendSessionConfigure: () => void;
  /** Hand off session.ready payload + run consumer's onSessionReady config callback. */
  onSessionReady: ((payload: SessionReadyPayload) => void) | undefined;
  /** Attach all registered connectors after session.ready. */
  attachAll: () => void;
  /** Notify presence coordinator of an incoming message type. */
  notifyPresence: (type: string) => void;
  /** Per-type subscriber map (set by connectors via internal.onMessage). */
  getMessageHandlers: () => Map<string, Set<(msg: unknown) => void>>;
  /** Binary-frame subscribers. */
  getBinaryHandlers: () => Set<(data: ArrayBuffer) => void>;
  /** Connectors registered with the SDK; used for routing connector.cancelled. */
  getConnectors: () => readonly Connector[];
}

export function dispatchMessage(
  deps: MessageRouterDeps,
  event: MessageEvent,
  resolve: () => void,
  reject: (err: Error) => void,
): void {
  if (event.data instanceof ArrayBuffer) {
    const handlers = deps.getBinaryHandlers();
    sdkLog.debug("binary-frame", { bytes: event.data.byteLength, handlers: handlers.size });
    for (const handler of handlers) handler(event.data);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data as string);
  } catch {
    return;
  }
  const msg = parsed as Record<string, unknown>;
  const type = msg.type as string | undefined;
  if (type === undefined) return;
  sdkLog.debug(type, msg);
  deps.notifyPresence(type);
  routeByType(deps, type, msg, resolve, reject);
}

function routeByType(
  deps: MessageRouterDeps,
  type: string,
  msg: Record<string, unknown>,
  resolve: () => void,
  reject: (err: Error) => void,
): void {
  const status = deps.getStatus();
  if (type === "auth.ok" && status === "authenticating") {
    handleAuthOk(deps, reject);
    return;
  }
  if (type === "error" && status === "authenticating") {
    handleAuthError(deps, msg, reject);
    return;
  }
  if (type === "session.ready" && status === "authenticating") {
    handleReady(deps, msg, resolve);
    return;
  }
  if (type === "connector.cancelled") {
    routeCancelled(deps, msg);
    return;
  }
  routeMessage(deps, type, msg);
}

function handleAuthOk(deps: MessageRouterDeps, reject: (err: Error) => void): void {
  deps.timers.clearAuthTimer();
  deps.sendSessionConfigure();
  deps.timers.startReadyTimeout(reject);
}

function handleAuthError(deps: MessageRouterDeps, msg: Record<string, unknown>, reject: (err: Error) => void): void {
  deps.timers.clearAll();
  deps.setLastErrorKind("auth");
  const reason = (msg.message as string) ?? "Auth failed";
  deps.setStatus("error");
  reject(new Error(reason));
}

function handleReady(deps: MessageRouterDeps, msg: Record<string, unknown>, resolve: () => void): void {
  deps.timers.clearReadyTimer();
  deps.setStatus("ready");
  readyDispatcher(msg, deps.onSessionReady, (tag, detail) => sdkLog.warn(tag, { detail }));
  deps.attachAll();
  resolve();
}

function routeCancelled(deps: MessageRouterDeps, msg: Record<string, unknown>): void {
  const capability = msg.capability as string | undefined;
  for (const connector of deps.getConnectors()) {
    if (capability === undefined || connector.capability === capability) connector.onCancelled?.();
  }
}

function routeMessage(deps: MessageRouterDeps, type: string, msg: unknown): void {
  const handlers = deps.getMessageHandlers().get(type);
  if (handlers === undefined) return;
  for (const handler of handlers) handler(msg);
}
