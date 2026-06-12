import { getLog } from "../logging/logger.js";
import { type AcpClient, createAcpClient } from "./client.js";
import { type InternalEvent, translateSessionUpdate } from "./event-translator.js";
import { sessionPromptResultSchema } from "./schemas.js";
import { createSessionAttachmentLedger } from "./session-attachment-ledger.js";
import {
  type SessionRpcDeps,
  failValidation,
  initialize as rpcInitialize,
  listSessions as rpcListSessions,
  loadSession as rpcLoadSession,
  newSession as rpcNewSession,
} from "./session-rpc.js";

// ---------------------------------------------------------------------------
// AcpPerProfileConnection — one ACP client per Hermes profile.
//
// Wraps the bare AcpClient (T4.3) with:
//   - method-specific zod validation (T4.2 schemas)
//   - ACP session/update → InternalEvent translation (T4.4)
//   - cycle.done synthesis from the session/prompt JSON-RPC response
//
// At most one in-flight prompt per session; the connection captures the
// JSON-RPC request id of the active prompt via an additive onRequestSent
// hook on AcpClient (T4.3) so cancelInflight has the sessionId to issue
// `session/cancel` (per upstream ACP — NOT LSP-style $/cancelRequest) and
// so cycle.done carries the request id stringified as the cycleId.
// ---------------------------------------------------------------------------

const log = getLog(["sentient", "hermes-adapter-client", "acp", "per-profile-connection"]);

const DISPOSED_REASON = "connection-disposed";

export interface AcpPerProfileConnectionConfig {
  /** Outbound transport — owned by the WS layer in T4.7. */
  readonly send: (raw: string) => Promise<void>;
  /** Subscribe to incoming raw WS messages. Pumped into AcpClient.handleIncoming. */
  readonly onIncoming: (cb: (raw: string) => void) => void;
  /** Socket generation; bumps per (re)open onto a fresh child. Drives re-attach (see SessionAttachmentLedger). Defaults to constant 0 in tests. */
  readonly currentEpoch?: () => number;
  /** Open the wire (lazy reconnect) WITHOUT sending; awaited before reading the epoch so the re-attach decision sees the final generation. */
  readonly ensureReady?: () => Promise<void>;
  /** Optional override — testing only. */
  readonly client?: AcpClient;
}

export interface SendUserMessageArgs {
  readonly sessionId: string;
  readonly text: string;
  /** Pass-through to params._meta.internal for parity with custom-WS adapter. */
  readonly internal?: boolean;
}

export interface SendUserMessageResult {
  /** Synthesized — stringified JSON-RPC id of the session/prompt request. */
  readonly cycleId: string;
  readonly stopReason: string;
  readonly usage?: unknown;
}

export interface CycleDoneEvent {
  readonly cycleId: string;
  readonly stopReason: string;
}

export interface AcpPerProfileConnection {
  initialize(): Promise<void>;
  sendUserMessage(args: SendUserMessageArgs): Promise<SendUserMessageResult>;
  cancelInflight(): Promise<void>;
  newSession(args: { mcpServers?: unknown[] }): Promise<{ sessionId: string }>;
  loadSession(args: { sessionId: string; mcpServers?: unknown[] }): Promise<void>;
  listSessions(args: {
    cwd?: string;
    cursor?: string;
  }): Promise<{ sessions: unknown[]; nextCursor: string | null }>;
  onEvent(cb: (e: InternalEvent) => void): () => void;
  onCycleDone(cb: (e: CycleDoneEvent) => void): () => void;
  /**
   * Reject every in-flight JSON-RPC request with `error`. The WS layer calls
   * this on an ABNORMAL close so a `session/prompt` mid-flight rejects (→ the
   * dispatch surfaces a terminal `error`) instead of hanging. Does NOT dispose
   * — the wire may re-open and serve later prompts.
   */
  rejectInflight(error: Error): void;
  dispose(): void;
}

interface InflightPrompt {
  readonly id: number | string;
  readonly sessionId: string;
}

export function createAcpPerProfileConnection(cfg: AcpPerProfileConnectionConfig): AcpPerProfileConnection {
  let nextRequestId: number | string | null = null;
  let inflight: InflightPrompt | null = null;
  let disposed = false;
  const currentEpoch = cfg.currentEpoch ?? ((): number => 0);
  const ensureReady = cfg.ensureReady ?? ((): Promise<void> => Promise.resolve());
  // Tracks which sessions are attached to the CURRENT child (by socket epoch).
  // A reconnect bumps the epoch → stale entries → re-attach before the prompt.
  const ledger = createSessionAttachmentLedger();

  const eventHandlers = new Set<(e: InternalEvent) => void>();
  const cycleDoneHandlers = new Set<(e: CycleDoneEvent) => void>();

  const client: AcpClient =
    cfg.client ??
    createAcpClient({
      send: cfg.send,
      onRequestSent: (id) => {
        nextRequestId = id;
      },
    });

  cfg.onIncoming((raw) => client.handleIncoming(raw));

  client.onNotification("session/update", (params) => {
    const events = translateSessionUpdate(params);
    if (events.length === 0) return;
    log.debug("session-update.fan-out", { count: events.length, handlers: eventHandlers.size });
    for (const handler of [...eventHandlers]) {
      try {
        for (const event of events) handler(event);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn("session-update.handler-threw", { reason });
      }
    }
  });

  function fireCycleDone(event: CycleDoneEvent): void {
    log.info("cycle.done", { cycleId: event.cycleId, stopReason: event.stopReason });
    for (const handler of [...cycleDoneHandlers]) {
      try {
        handler(event);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn("cycle-done.handler-threw", { reason });
      }
    }
  }

  function ensureNotDisposed(): void {
    if (disposed) throw new Error(DISPOSED_REASON);
  }

  const rpcDeps: SessionRpcDeps = { client, ledger, currentEpoch };

  async function initialize(): Promise<void> {
    ensureNotDisposed();
    await rpcInitialize(rpcDeps);
  }

  async function newSession(args: { mcpServers?: unknown[] }): Promise<{ sessionId: string }> {
    ensureNotDisposed();
    return rpcNewSession(rpcDeps, args);
  }

  async function loadSession(args: { sessionId: string; mcpServers?: unknown[] }): Promise<void> {
    ensureNotDisposed();
    await rpcLoadSession(rpcDeps, args);
  }

  async function listSessions(args: { cwd?: string; cursor?: string }): Promise<{
    sessions: unknown[];
    nextCursor: string | null;
  }> {
    ensureNotDisposed();
    return rpcListSessions(rpcDeps, args);
  }

  /**
   * Re-attach the target session to the CURRENT child before a prompt if a
   * reconnect left it unattached — `session/load` restores the persisted Hermes
   * session so the first post-reconnect prompt does not 404 "session not found".
   * See SessionAttachmentLedger for the why.
   */
  async function ensureSessionAttached(sessionId: string): Promise<void> {
    // Open the wire FIRST (may reconnect onto a fresh child + bump the epoch),
    // THEN read the epoch — otherwise the load decision races the reconnect.
    await ensureReady();
    const epoch = currentEpoch();
    if (ledger.isAttached(sessionId, epoch)) return;
    log.info("session.reattach", { sessionId, currentEpoch: epoch });
    await loadSession({ sessionId });
  }

  async function sendUserMessage(args: SendUserMessageArgs): Promise<SendUserMessageResult> {
    ensureNotDisposed();
    await ensureSessionAttached(args.sessionId);
    const params: Record<string, unknown> = {
      sessionId: args.sessionId,
      prompt: [{ type: "text", text: args.text }],
    };
    if (args.internal) params._meta = { internal: true };

    nextRequestId = null;
    log.debug("session.prompt.send", { sessionId: args.sessionId, internal: args.internal === true });
    const promise = client.request("session/prompt", params);

    // The onRequestSent hook fires synchronously inside `client.request` BEFORE
    // it returns the promise, so nextRequestId is already populated here.
    const id = nextRequestId;
    if (id === null) {
      throw new Error("ACP session/prompt: failed to capture request id");
    }
    inflight = { id, sessionId: args.sessionId };
    log.info("cycle.start", { cycleId: String(id), sessionId: args.sessionId });

    let raw: unknown;
    try {
      raw = await promise;
    } finally {
      // Clear inflight regardless — a rejected prompt is no longer cancellable.
      if (inflight !== null && inflight.id === id) inflight = null;
    }

    const parsed = sessionPromptResultSchema.safeParse(raw);
    if (!parsed.success) failValidation("session/prompt", parsed.error.issues);
    const cycleId = String(id);
    const result: SendUserMessageResult = {
      cycleId,
      stopReason: parsed.data.stopReason,
      ...(parsed.data.usage !== undefined ? { usage: parsed.data.usage } : {}),
    };
    fireCycleDone({ cycleId, stopReason: parsed.data.stopReason });
    return result;
  }

  async function cancelInflight(): Promise<void> {
    if (inflight === null) {
      log.debug("cancel.noop");
      return;
    }
    const { id, sessionId } = inflight;
    log.info("cancel.send", { sessionId });
    // ACP cancel is a session/cancel notification keyed by sessionId — NOT
    // LSP-style $/cancelRequest. The agent will resolve the in-flight prompt
    // with stopReason="cancelled" of its own accord.
    try {
      await client.notify("session/cancel", { sessionId });
    } catch (err: unknown) {
      // Best-effort: a failed cancel send (dead/hung wire) does not matter for
      // local cleanup — cancelPending below settles the in-flight prompt. Log
      // and swallow so cancelInflight never rejects (its caller fire-and-forgets).
      log.warn("cancel.send-failed", { sessionId, reason: err instanceof Error ? err.message : String(err) });
    } finally {
      // Settle the in-flight session/prompt promise regardless of whether the
      // cancel send reached Hermes — a dead wire must not leak a pending entry.
      // cancelPending is a no-op if the prompt already resolved (e.g. Hermes
      // answered before the cancel notification arrived).
      client.cancelPending(id, "cycle aborted");
    }
  }

  function onEvent(cb: (e: InternalEvent) => void): () => void {
    eventHandlers.add(cb);
    return (): void => {
      eventHandlers.delete(cb);
    };
  }

  function onCycleDone(cb: (e: CycleDoneEvent) => void): () => void {
    cycleDoneHandlers.add(cb);
    return (): void => {
      cycleDoneHandlers.delete(cb);
    };
  }

  function rejectInflight(error: Error): void {
    if (disposed) return;
    // Clear the (no-longer-cancellable) inflight marker, then reject pending so
    // the caller's send promise rejects instead of hanging. Connection survives.
    log.warn("reject-inflight", { reason: error.message });
    inflight = null;
    client.rejectAllPending(error);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    log.info("dispose");
    eventHandlers.clear();
    cycleDoneHandlers.clear();
    inflight = null;
    client.rejectAllPending(new Error(DISPOSED_REASON));
  }

  return {
    initialize,
    sendUserMessage,
    cancelInflight,
    newSession,
    loadSession,
    listSessions,
    onEvent,
    onCycleDone,
    rejectInflight,
    dispose,
  };
}
