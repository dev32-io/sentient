// ---------------------------------------------------------------------------
// ConnectionMonitor — fires a single `onProbe` callback whenever the user
// returns to the tab or the network comes back. Used by the SDK to detect
// stale WebSockets after the browser kills them mid-background, after a
// network drop, or after a long sleep where the TCP layer never noticed
// the disconnect.
//
// We intentionally do NOT keepalive (server pings every N seconds) — that
// burns mobile battery and radio. Event-driven probing covers the same
// surface for far less cost.
//
// Signals:
//   visibilitychange (document), state==='visible' → onProbe
//   online (window)                                 → onProbe
//
// Disposal is idempotent. Removes every listener by reference.
// ---------------------------------------------------------------------------

import { createLogger } from "../logger.ts";

export interface ConnectionMonitorHooks {
  /** Called when the SDK should verify the WS is still alive. */
  onProbe(): void;
}

export interface ConnectionMonitor {
  dispose(): void;
}

export interface ConnectionMonitorConfig {
  readonly hooks: ConnectionMonitorHooks;
  /** EventTarget for `online`. Defaults to `globalThis.window`. */
  readonly windowTarget?: EventTarget;
  /** EventTarget for `visibilitychange`. Defaults to `globalThis.document`. */
  readonly documentTarget?: EventTarget;
  /** Returns the current document visibility. Defaults to reading `document.visibilityState`. */
  readonly visibilityState?: () => DocumentVisibilityState;
}

const log = createLogger(["sentient", "presence", "connection-monitor"]);

const EVT_VISIBILITYCHANGE = "visibilitychange";
const EVT_ONLINE = "online";

const NOOP_DISPOSE: ConnectionMonitor = { dispose: () => {} };

export function createConnectionMonitor(config: ConnectionMonitorConfig): ConnectionMonitor {
  const windowTarget = resolveOptional<EventTarget>(config.windowTarget, "window");
  const documentTarget = resolveOptional<EventTarget>(config.documentTarget, "document");
  if (!windowTarget || !documentTarget) {
    log.warn("no DOM — connection monitor disabled (non-browser runtime)");
    return NOOP_DISPOSE;
  }

  const visibilityState = config.visibilityState ?? defaultVisibilityState;

  let disposed = false;

  const onVisibility = (): void => {
    if (disposed) return;
    const state = visibilityState();
    log.debug("visibilitychange", { state });
    if (state === "visible") config.hooks.onProbe();
  };

  const onOnline = (): void => {
    if (disposed) return;
    log.debug("online");
    config.hooks.onProbe();
  };

  documentTarget.addEventListener(EVT_VISIBILITYCHANGE, onVisibility);
  windowTarget.addEventListener(EVT_ONLINE, onOnline);
  log.debug("subscribed");

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      log.debug("dispose");
      documentTarget.removeEventListener(EVT_VISIBILITYCHANGE, onVisibility);
      windowTarget.removeEventListener(EVT_ONLINE, onOnline);
    },
  };
}

function resolveOptional<T>(explicit: T | undefined, globalKey: "window" | "document"): T | null {
  if (explicit) return explicit;
  const value = (globalThis as Record<string, unknown>)[globalKey];
  return (value as T | undefined) ?? null;
}

function defaultVisibilityState(): DocumentVisibilityState {
  const doc = (globalThis as { document?: { visibilityState?: DocumentVisibilityState } }).document;
  return doc?.visibilityState ?? "visible";
}
