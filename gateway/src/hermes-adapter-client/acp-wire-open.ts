import { getLog } from "../logging/logger.js";
import type { AcpWsLike } from "./acp-ws.js";

const log = getLog(["sentient", "hermes-adapter-client", "acp-wire-open"]);

const READY_STATE_OPEN = 1;

/**
 * Resolve when the WS opens, reject (and close the socket) on timeout,
 * pre-open close, or pre-open error. Shared by the managed socket's first
 * open and every reconnect attempt.
 */
export function waitForOpen(ws: AcpWsLike, timeoutMs: number, url: string, sessionId: string): Promise<void> {
  if (ws.readyState === READY_STATE_OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.warn("ws.open-timeout", { sessionId, url, timeoutMs });
      safeClose(ws);
      reject(new Error(`acp-wire-socket.open-timeout: ${timeoutMs}ms`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.debug("ws.open", { sessionId, url });
      resolve();
    });
    ws.addEventListener("close", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn("ws.close-before-open", { sessionId, url, code: e.code, reason: e.reason });
      reject(new Error(`acp-wire-socket.closed-before-open: code=${e.code} reason=${e.reason}`));
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.warn("ws.error-before-open", { sessionId, url });
      reject(new Error("acp-wire-socket.error-before-open"));
    });
  });
}

/** Close a socket, swallowing any throw from an already-closed handle. */
export function safeClose(ws: AcpWsLike): void {
  try {
    ws.close();
  } catch {
    /* already closed */
  }
}
