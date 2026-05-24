import type { SessionRow } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";

const DEFAULT_TIMEOUT_MS = 5000;

export type SessionsChangeEvent =
  | { kind: "created"; sessionId: string; title?: string; ts: number }
  | { kind: "switched"; sessionId: string; title?: string; ts: number }
  | { kind: "deleted"; sessionId: string }
  | { kind: "renamed"; sessionId: string; title: string };

export interface SessionsConnectorConfig {
  readonly timeoutMs?: number;
}

interface PendingRequest {
  requestId: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const newId = (): string => globalThis.crypto.randomUUID();

export class SessionsConnector implements Connector {
  readonly capability = "sessions";
  readonly kind = "status" as const;

  private readonly timeoutMs: number;
  private pending: Map<string, PendingRequest> = new Map();
  private listeners: Set<(e: SessionsChangeEvent) => void> = new Set();
  private unsubs: (() => void)[] = [];
  private send: (msg: Record<string, unknown>) => void = () => {};

  constructor(cfg: SessionsConnectorConfig = {}) {
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  attach(sdk: SentientSDKInternal): void {
    this.send = (msg) => sdk.send(msg);

    const matchToPending = (msg: { requestId?: string }): PendingRequest | undefined => {
      const id = msg.requestId;
      if (!id) return undefined;
      const p = this.pending.get(id);
      if (p) this.pending.delete(id);
      return p;
    };

    this.unsubs.push(
      sdk.onMessage("sessions.list.result", (raw: unknown) => {
        const m = raw as { requestId: string; items: SessionRow[]; total: number; hasMore: boolean };
        const p = matchToPending(m);
        if (!p) return;
        clearTimeout(p.timer);
        p.resolve({ items: m.items, total: m.total, hasMore: m.hasMore });
      }),
    );

    this.unsubs.push(
      sdk.onMessage("sessions.search.result", (raw: unknown) => {
        const m = raw as { requestId: string; items: SessionRow[] };
        const p = matchToPending(m);
        if (!p) return;
        clearTimeout(p.timer);
        p.resolve(m.items);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("sessions.error", (raw: unknown) => {
        const m = raw as { requestId: string; code: string; message: string };
        const p = matchToPending(m);
        if (!p) return;
        clearTimeout(p.timer);
        p.reject(new Error(`${m.code}: ${m.message}`));
      }),
    );

    // Request-correlated result for sessions.delete: resolves the
    // request<void> Promise. The broadcast `sessions.deleted` fan-out
    // below drives the live UI list update.
    this.unsubs.push(
      sdk.onMessage("sessions.delete.result", (raw: unknown) => {
        const m = raw as { requestId: string; sessionId: string };
        const p = matchToPending(m);
        if (!p) return;
        clearTimeout(p.timer);
        p.resolve(undefined);
      }),
    );

    // Request-correlated result for sessions.rename: same split as delete.
    this.unsubs.push(
      sdk.onMessage("sessions.rename.result", (raw: unknown) => {
        const m = raw as { requestId: string; sessionId: string; title: string };
        const p = matchToPending(m);
        if (!p) return;
        clearTimeout(p.timer);
        p.resolve(undefined);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("sessions.deleted", (raw: unknown) => {
        const m = raw as { sessionId: string };
        this.dispatch({ kind: "deleted", sessionId: m.sessionId });
      }),
    );

    this.unsubs.push(
      sdk.onMessage("sessions.renamed", (raw: unknown) => {
        const m = raw as { sessionId: string; title: string };
        this.dispatch({ kind: "renamed", sessionId: m.sessionId, title: m.title });
      }),
    );

    const dispatchLifecycle = (kind: "created" | "switched") => (raw: unknown) => {
      const m = raw as { sessionId: string; title?: string; ts: number };
      this.dispatch(
        m.title === undefined
          ? { kind, sessionId: m.sessionId, ts: m.ts }
          : { kind, sessionId: m.sessionId, title: m.title, ts: m.ts },
      );
    };
    this.unsubs.push(sdk.onMessage("session.created", dispatchLifecycle("created")));
    this.unsubs.push(sdk.onMessage("session.switched", dispatchLifecycle("switched")));
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("connector detached"));
    }
    this.pending.clear();
    // NOTE: do NOT clear `this.listeners` — those are user-registered
    // handlers (e.g. the webui's use-sessions hook subscribes once at
    // create), and they must survive WS reconnect. The SDK calls
    // detach()→attach() on every reconnect; clearing listeners here
    // silently drops every subscription so live `sessions.deleted` /
    // `sessions.renamed` broadcasts after the first reconnect never
    // reach the UI. Only `unsubs` (internal sdk.onMessage bindings)
    // and `pending` (in-flight requests) are reset.
  }

  private dispatch(e: SessionsChangeEvent): void {
    for (const l of this.listeners) l(e);
  }

  private request<T>(frame: Record<string, unknown>): Promise<T> {
    const requestId = newId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(`timeout waiting for ${frame.type}`));
        }
      }, this.timeoutMs);
      this.pending.set(requestId, {
        requestId,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.send({ ...frame, requestId });
    });
  }

  list(opts: { limit: number; offset: number }): Promise<{ items: SessionRow[]; total: number; hasMore: boolean }> {
    return this.request({ type: "sessions.list", ...opts });
  }
  search(q: string, limit = 20): Promise<SessionRow[]> {
    return this.request({ type: "sessions.search", q, limit });
  }
  delete(sessionId: string): Promise<void> {
    return this.request<void>({ type: "sessions.delete", sessionId });
  }
  rename(sessionId: string, title: string): Promise<void> {
    return this.request<void>({ type: "sessions.rename", sessionId, title });
  }
  switchTo(sessionId: string): Promise<void> {
    // session.switched arrives without requestId — special-cased.
    return new Promise((resolve, reject) => {
      const onSwitched = (e: SessionsChangeEvent): void => {
        if (e.kind === "switched" && e.sessionId === sessionId) {
          cleanup();
          resolve();
        }
      };
      this.listeners.add(onSwitched);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout waiting for session.switched"));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(onSwitched);
      };
      this.send({ type: "session.switch", sessionId, requestId: newId() });
    });
  }
  newChat(): Promise<{ sessionId: string }> {
    return new Promise((resolve, reject) => {
      const onCreated = (e: SessionsChangeEvent): void => {
        if (e.kind === "created") {
          cleanup();
          resolve({ sessionId: e.sessionId });
        }
      };
      this.listeners.add(onCreated);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout waiting for session.created"));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(onCreated);
      };
      this.send({ type: "session.new", requestId: newId() });
    });
  }
  onSessionsChanged(fn: (e: SessionsChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
