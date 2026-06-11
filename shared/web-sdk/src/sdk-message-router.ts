// ---------------------------------------------------------------------------
// sdk-message-router — JSON message dispatching for SentientSDK.
//
// Distinct from connector message subscriptions: this layer recognizes the
// SDK's own protocol frames (`auth.ok`, `auth.error`, `session.ready`,
// `connector.cancelled`) and dispatches everything else to per-type
// connector handlers.
//
// Binary frame format (Task 3.5+):
//   [8-byte BE u64 seq][1-byte type][payload]
//   type 0x01 = audio
//
// The router peels the 9-byte header, extracts the seq for cursor advancement,
// and delivers only the payload bytes to binary handlers.
//
// Extracted to keep `sentient-sdk.ts` under the 300-line clean-code budget.
// ---------------------------------------------------------------------------

import type { Connector, SDKStatus, SessionReadyPayload } from "./connector-types.ts";
import { sdkLog } from "./debug.ts";
import type { ResumeCursorState } from "./resume-cursor.ts";
import type { SdkTimers } from "./sdk-timers.ts";
import { handleSessionReady as readyDispatcher } from "./session-ready-handler.ts";

type ErrorKind = "auth" | "network" | "timeout" | null;

const BINARY_HEADER_BYTES = 9;
const BINARY_TYPE_AUDIO = 0x01;

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
  /** Resume cursor — updated by every seq-bearing frame. */
  cursor: ResumeCursorState;
  /** Handler called when stream.resumed arrives (after reconnect). */
  onStreamResumed: (recovered: boolean) => void;
}

export function dispatchMessage(
  deps: MessageRouterDeps,
  event: MessageEvent,
  resolve: () => void,
  reject: (err: Error) => void,
): void {
  if (event.data instanceof ArrayBuffer) {
    dispatchBinary(deps, event.data);
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

  // Seq/epoch dedup for JSON frames.
  const seq = typeof msg.seq === "number" ? msg.seq : 0;
  const epoch = typeof msg.epoch === "number" ? msg.epoch : undefined;
  if (seq !== 0 && !deps.cursor.tryApply(seq, epoch)) {
    sdkLog.debug("json-frame.dedup-dropped", { type, seq, epoch });
    return;
  }
  // Capture epoch even on frames that only carry it (e.g. auth.ok, session.ready).
  if (epoch !== undefined && seq === 0) {
    deps.cursor.tryApply(0, epoch);
  }

  sdkLog.debug(type, msg);
  deps.notifyPresence(type);
  routeByType(deps, type, msg, resolve, reject);
}

/**
 * Peel the 9-byte binary header and dispatch the payload to binary handlers.
 *
 * Header layout: [8-byte BE u64 seq][1-byte type]
 * Only type 0x01 (audio) is currently defined; unknown types are logged and
 * dropped to keep the audio pipeline clean.
 */
function dispatchBinary(deps: MessageRouterDeps, data: ArrayBuffer): void {
  if (data.byteLength < BINARY_HEADER_BYTES) {
    sdkLog.warn("binary-frame.too-short", { bytes: data.byteLength });
    return;
  }

  const view = new DataView(data);
  // u64 BE seq — safe for all seq < 2^53 (practical maximum for any
  // realistic stream). getBigUint64 is available in all modern runtimes.
  const seq = Number(view.getBigUint64(0, false));
  const frameType = view.getUint8(8);
  const payload = data.slice(BINARY_HEADER_BYTES);

  if (frameType !== BINARY_TYPE_AUDIO) {
    sdkLog.debug("binary-frame.unknown-type", { frameType, seq, bytes: data.byteLength });
    return;
  }

  // Dedup by seq.
  if (seq !== 0 && !deps.cursor.tryApply(seq)) {
    sdkLog.debug("binary-frame.dedup-dropped", { seq, bytes: payload.byteLength });
    return;
  }

  const handlers = deps.getBinaryHandlers();
  sdkLog.debug("binary-frame", { seq, payloadBytes: payload.byteLength, handlers: handlers.size });
  for (const handler of handlers) handler(payload);
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
  if (type === "stream.resumed") {
    handleStreamResumed(deps, msg);
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

function handleStreamResumed(deps: MessageRouterDeps, msg: Record<string, unknown>): void {
  const recovered = msg.recovered === true;
  sdkLog.info("stream.resumed", { recovered, fromSeq: msg.fromSeq, toSeq: msg.toSeq });
  deps.onStreamResumed(recovered);
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
