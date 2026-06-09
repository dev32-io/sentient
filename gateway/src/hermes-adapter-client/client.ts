import { getLog } from "../logging/logger.js";
import { type JsonRpcEnvelope, type JsonRpcId, parseJsonRpcEnvelope } from "./jsonrpc.js";

// ---------------------------------------------------------------------------
// AcpClient — JSON-RPC 2.0 client for the ACP wire.
//
// Owns:
//   - id allocation (monotonic integer counter starting at 1).
//   - pending request registry (Map<id, {resolve, reject}>).
//   - notification dispatch (multi-handler per method, throw-isolated).
//   - clean shutdown (rejectAllPending).
//
// Request timeout: an optional `requestTimeoutMs` backstop rejects a pending
// request whose response never lands (a missed close event, a wedged child) so
// a `session/prompt` can never hang the dispatcher forever. The primary
// un-stick path is the WS layer's reject-on-abnormal-close (acp-wire-socket →
// per-profile-connection.rejectInflight); this timer is the belt-and-braces
// fallback for the case where the close event itself is dropped. Omit the
// option to disable (used by tests that drive responses synchronously).
//
// Out of scope (intentionally — caller responsibilities):
//   - method-specific schema validation: schemas.ts is the source of truth;
//     callers parse `result` / notification `params` themselves.
//   - transport: `cfg.send` is provided by the WS layer; this module is
//     transport-agnostic.
//
// Wire shape per https://www.jsonrpc.org/specification, mirroring upstream
// `acp/schema.py`. Cancel is NOT modeled here — ACP cancel is a plain
// `session/cancel` notification with `{sessionId}`, dispatched via `notify`.
// ---------------------------------------------------------------------------

const log = getLog(["sentient", "hermes-adapter-client", "acp"]);

const JSONRPC_VERSION = "2.0";
const PARSE_PREVIEW_LIMIT = 120;

type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** Timeout handle (when requestTimeoutMs is set); cleared on settle. */
  readonly timer?: ReturnType<typeof setTimeout>;
}

export interface AcpClientConfig {
  /** Outbound transport. The WS layer wraps this. */
  readonly send: (raw: string) => Promise<void>;
  /**
   * Optional hook fired immediately after a `request` allocates an id and
   * before its envelope is handed to `send`. Lets a higher layer (e.g. the
   * per-profile-connection) capture the id for cycle-id synthesis without
   * forcing a breaking signature change on `request`. Throwing handlers are
   * caught and logged so they cannot poison the request path.
   */
  readonly onRequestSent?: (id: JsonRpcId, method: string) => void;
  /**
   * Optional per-request deadline (ms). When set, a request whose response has
   * not arrived within the window is rejected with a timeout error and its
   * pending entry removed, so a missed close event can't wedge the caller
   * forever. Omit (or <= 0) to disable. Cleared on resolve/reject.
   */
  readonly requestTimeoutMs?: number;
}

export interface AcpClient {
  /**
   * Send a JSON-RPC request. Returns a promise that resolves with the
   * response `result` or rejects with `Error("ACP error <code>: <message>")`
   * if the server returns an error. The id is allocated internally;
   * callers never see it.
   */
  request(method: string, params?: unknown): Promise<unknown>;

  /** Send a JSON-RPC notification (no id, no response). Fire-and-forget. */
  notify(method: string, params?: unknown): Promise<void>;

  /**
   * Subscribe to notifications by method. Returns an unsubscribe fn.
   * Multiple handlers per method are allowed; each fires on every match.
   * A throwing handler is caught and logged so it cannot poison siblings.
   */
  onNotification(method: string, handler: NotificationHandler): () => void;

  /**
   * Inbound message dispatch — caller pumps this from the WS read loop.
   * Routes responses to pending requests and notifications to handlers.
   * Unexpected requests (server-initiated) are logged and dropped: ACP
   * does not require us to honor server-initiated requests in this role.
   * Parse failures log a preview and drop the frame; the bridge stays up.
   */
  handleIncoming(raw: string): void;

  /** Clean shutdown — rejects every pending request with the given error. */
  rejectAllPending(error: Error): void;
}

export function createAcpClient(cfg: AcpClientConfig): AcpClient {
  let nextId = 1;
  const pending = new Map<JsonRpcId, PendingRequest>();
  const handlers = new Map<string, Set<NotificationHandler>>();

  const send = async (frame: Record<string, unknown>): Promise<void> => {
    await cfg.send(JSON.stringify(frame));
  };

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    log.debug("request:send", { id, method });
    if (cfg.onRequestSent) {
      try {
        cfg.onRequestSent(id, method);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn("request:onRequestSent-threw", { id, method, reason });
      }
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = cfg.requestTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pending.delete(id)) {
            log.warn("request:timeout", { id, method, timeoutMs });
            reject(new Error(`ACP request timeout: ${method} after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      pending.set(id, { method, resolve, reject, ...(timer !== undefined ? { timer } : {}) });
      send({ jsonrpc: JSONRPC_VERSION, id, method, params: params ?? {} }).catch((err: unknown) => {
        // Send failed before the response window opens — bail out the
        // pending entry so the caller's promise is not orphaned.
        const entry = pending.get(id);
        if (entry && pending.delete(id)) {
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          const message = err instanceof Error ? err.message : String(err);
          log.warn("request:send-failed", { id, method, reason: message });
          reject(err instanceof Error ? err : new Error(message));
        }
      });
    });
  };

  const notify = async (method: string, params?: unknown): Promise<void> => {
    log.debug("notify:send", { method });
    await send({ jsonrpc: JSONRPC_VERSION, method, params: params ?? {} });
  };

  const onNotification = (method: string, handler: NotificationHandler): (() => void) => {
    let set = handlers.get(method);
    if (!set) {
      set = new Set();
      handlers.set(method, set);
    }
    set.add(handler);
    return (): void => {
      const current = handlers.get(method);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) handlers.delete(method);
    };
  };

  const dispatchNotification = (method: string, params: unknown): void => {
    const set = handlers.get(method);
    if (!set || set.size === 0) {
      log.debug("notification:no-handlers", { method });
      return;
    }
    log.debug("notification:dispatch", { method, handlers: set.size });
    // Snapshot so a handler that unsubscribes itself does not skip siblings.
    for (const handler of [...set]) {
      try {
        handler(params);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn("notification:handler-threw", { method, reason });
      }
    }
  };

  const resolvePending = (id: JsonRpcId, result: unknown): void => {
    const entry = pending.get(id);
    if (!entry) {
      log.warn("response:no-pending", { id });
      return;
    }
    pending.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    log.debug("response:resolve", { id, method: entry.method });
    entry.resolve(result);
  };

  const rejectPending = (id: JsonRpcId, error: { code: number; message: string }): void => {
    const entry = pending.get(id);
    if (!entry) {
      log.warn("response:no-pending", { id, code: error.code });
      return;
    }
    pending.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    log.debug("response:reject", { id, method: entry.method, code: error.code });
    entry.reject(new Error(`ACP error ${error.code}: ${error.message}`));
  };

  const handleIncoming = (raw: string): void => {
    let env: JsonRpcEnvelope;
    try {
      env = parseJsonRpcEnvelope(JSON.parse(raw) as unknown);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("incoming:parse-failed", {
        reason,
        preview: raw.slice(0, PARSE_PREVIEW_LIMIT),
      });
      return;
    }

    if (env.kind === "response") {
      if (env.error) {
        rejectPending(env.id, env.error);
        return;
      }
      resolvePending(env.id, env.result);
      return;
    }

    if (env.kind === "notification") {
      dispatchNotification(env.method, env.params);
      return;
    }

    // env.kind === "request" — server-initiated. Not expected in our usage.
    log.warn("incoming:unexpected-request", { id: env.id, method: env.method });
  };

  const rejectAllPending = (error: Error): void => {
    if (pending.size === 0) return;
    log.warn("shutdown:reject-all", { count: pending.size, reason: error.message });
    // Snapshot then clear FIRST so a `.reject` callback that itself triggers
    // re-entry (e.g. caller calls request() again) cannot double-reject.
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(error);
    }
  };

  return { request, notify, onNotification, handleIncoming, rejectAllPending };
}
