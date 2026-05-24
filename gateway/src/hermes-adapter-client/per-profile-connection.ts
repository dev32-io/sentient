import { getLog } from "../logging/logger.js";
import { type AcpClient, createAcpClient } from "./client.js";
import { type InternalEvent, translateSessionUpdate } from "./event-translator.js";
import {
  initializeResultSchema,
  sessionListResultSchema,
  sessionNewResultSchema,
  sessionPromptResultSchema,
} from "./schemas.js";

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

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_CWD = "/";
const DISPOSED_REASON = "connection-disposed";

export interface AcpPerProfileConnectionConfig {
  /** Outbound transport — owned by the WS layer in T4.7. */
  readonly send: (raw: string) => Promise<void>;
  /** Subscribe to incoming raw WS messages. Pumped into AcpClient.handleIncoming. */
  readonly onIncoming: (cb: (raw: string) => void) => void;
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

  function failValidation(method: string, issues: ReadonlyArray<unknown>): never {
    const summary = issues.length === 0 ? "no-issues" : `${issues.length} issue(s)`;
    throw new Error(`ACP ${method} response validation failed: ${summary}`);
  }

  async function initialize(): Promise<void> {
    ensureNotDisposed();
    log.info("initialize.begin");
    const raw = await client.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { sessionList: true },
    });
    const parsed = initializeResultSchema.safeParse(raw);
    if (!parsed.success) failValidation("initialize", parsed.error.issues);
    log.info("initialize.done");
  }

  async function newSession(args: { mcpServers?: unknown[] }): Promise<{ sessionId: string }> {
    ensureNotDisposed();
    const params = { cwd: DEFAULT_CWD, mcpServers: args.mcpServers ?? [] };
    log.debug("session.new.send", { mcpServers: params.mcpServers.length });
    const raw = await client.request("session/new", params);
    const parsed = sessionNewResultSchema.safeParse(raw);
    if (!parsed.success) failValidation("session/new", parsed.error.issues);
    log.info("session.new.done", { sessionId: parsed.data.sessionId });
    return { sessionId: parsed.data.sessionId };
  }

  async function loadSession(args: { sessionId: string; mcpServers?: unknown[] }): Promise<void> {
    ensureNotDisposed();
    const params = {
      sessionId: args.sessionId,
      cwd: DEFAULT_CWD,
      mcpServers: args.mcpServers ?? [],
    };
    log.debug("session.load.send", { sessionId: args.sessionId });
    await client.request("session/load", params);
    log.info("session.load.done", { sessionId: args.sessionId });
  }

  async function listSessions(args: { cwd?: string; cursor?: string }): Promise<{
    sessions: unknown[];
    nextCursor: string | null;
  }> {
    ensureNotDisposed();
    const params: Record<string, unknown> = {};
    if (args.cwd !== undefined) params.cwd = args.cwd;
    if (args.cursor !== undefined) params.cursor = args.cursor;
    log.debug("session.list.send", { hasCursor: args.cursor !== undefined });
    const raw = await client.request("session/list", params);
    const parsed = sessionListResultSchema.safeParse(raw);
    if (!parsed.success) failValidation("session/list", parsed.error.issues);
    const sessions = [...parsed.data.sessions];
    const nextCursor = parsed.data.nextCursor ?? null;
    log.debug("session.list.done", { count: sessions.length, hasNext: nextCursor !== null });
    return { sessions, nextCursor };
  }

  async function sendUserMessage(args: SendUserMessageArgs): Promise<SendUserMessageResult> {
    ensureNotDisposed();
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
    const { sessionId } = inflight;
    log.info("cancel.send", { sessionId });
    // ACP cancel is a session/cancel notification keyed by sessionId — NOT
    // LSP-style $/cancelRequest. The agent will resolve the in-flight prompt
    // with stopReason="cancelled" of its own accord.
    await client.notify("session/cancel", { sessionId });
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
    dispose,
  };
}
