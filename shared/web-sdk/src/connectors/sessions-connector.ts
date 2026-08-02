import type { SessionRow } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";
import { createLogger } from "../logger.ts";
import type { SessionsListResult, SessionsRest } from "../sessions-rest.ts";

const log = createLogger(["sentient", "sdk", "connectors", "sessions"]);

const DEFAULT_TIMEOUT_MS = 5000;

export type SessionsChangeEvent =
  | { kind: "created"; sessionId: string; title?: string; ts: number }
  | { kind: "switched"; sessionId: string; title?: string; ts: number }
  /** No session yet. `draftKey` is the opaque handle the gateway minted for
   *  this draft: the client holds it as its current pointer, re-presents it on
   *  `session.configure`, and the gateway spends it as the mint key when the
   *  first message arrives. A draft is NOT a session — it has no row and must
   *  never appear in the session list. */
  | { kind: "draft"; draftKey: string; ts: number }
  | { kind: "deleted"; sessionId: string }
  | { kind: "renamed"; sessionId: string; title: string };

export interface SessionsConnectorConfig {
  readonly rest: SessionsRest;
  readonly timeoutMs?: number;
}

const newId = (): string => globalThis.crypto.randomUUID();

export class SessionsConnector implements Connector {
  readonly capability = "sessions";
  readonly kind = "status" as const;

  private readonly rest: SessionsRest;
  private readonly timeoutMs: number;
  private listeners: Set<(e: SessionsChangeEvent) => void> = new Set();
  private unsubs: (() => void)[] = [];
  private send: (msg: Record<string, unknown>) => void = () => {};

  constructor(cfg: SessionsConnectorConfig) {
    this.rest = cfg.rest;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  attach(sdk: SentientSDKInternal): void {
    this.send = (msg) => sdk.send(msg);

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
    this.unsubs.push(
      sdk.onMessage("session.draft", (raw: unknown) => {
        const m = raw as { draftKey: string; ts: number };
        this.dispatch({ kind: "draft", draftKey: m.draftKey, ts: m.ts });
      }),
    );
    // The gateway's own titling push. Folded into the `renamed` event rather
    // than given its own kind: every consumer's behaviour is identical — put
    // this title on this row — and the provenance guard that decides WHETHER a
    // generated title may land is enforced in the store (compare-and-set on
    // `title_provenance`), never re-litigated on the client.
    this.unsubs.push(
      sdk.onMessage("session.title", (raw: unknown) => {
        const m = raw as { sessionId: string; title: string };
        this.dispatch({ kind: "renamed", sessionId: m.sessionId, title: m.title });
      }),
    );
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // NOTE: do NOT clear `this.listeners` — those are user-registered
    // handlers (e.g. the webui's use-sessions hook subscribes once at
    // create), and they must survive WS reconnect. The SDK calls
    // detach()→attach() on every reconnect; clearing listeners here
    // silently drops every subscription so live session events after the
    // first reconnect never reach the UI. Only `unsubs` (internal
    // sdk.onMessage bindings) are reset.
  }

  private dispatch(e: SessionsChangeEvent): void {
    for (const l of this.listeners) l(e);
  }

  // ---------------------------------------------------------------------------
  // REST-backed query methods
  // ---------------------------------------------------------------------------

  list(opts: { limit?: number; offset?: number } = {}): Promise<SessionsListResult> {
    return this.rest.list(opts);
  }

  search(q: string, limit = 20): Promise<SessionRow[]> {
    return this.rest.search(q, limit);
  }

  async delete(sessionId: string): Promise<void> {
    await this.rest.delete(sessionId);
    this.dispatch({ kind: "deleted", sessionId });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.rest.rename(sessionId, title);
    this.dispatch({ kind: "renamed", sessionId, title });
  }

  // ---------------------------------------------------------------------------
  // WS-backed session lifecycle methods
  // ---------------------------------------------------------------------------

  /**
   * Activate a conversation. Sends `conversation.activate` over WS and
   * resolves when the gateway broadcasts `session.switched`.
   */
  switchTo(sessionId: string): Promise<void> {
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
        log.warn("switchTo.timeout", { reason: "timeout waiting for session.switched", sessionId });
        reject(new Error("timeout waiting for session.switched"));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(onSwitched);
      };
      this.send({ type: "conversation.activate", sessionId });
    });
  }

  /**
   * The "+" button: abandon the current session and start a draft.
   *
   * Resolves with the DRAFT KEY, not a session id — pressing "+" mints
   * nothing, so ten presses leave the session list unchanged (spec §4.2). The
   * real id arrives later, as a `created` event, when the first message
   * allocates it.
   *
   * `intent: "explicit"` is what separates this from the `session.new` a client
   * fires on launch. Without it the gateway cannot tell "the person asked for a
   * new chat" from "the app started with no route id" and would abandon the
   * bound session on every launch.
   */
  newChat(): Promise<{ draftKey: string }> {
    return new Promise((resolve, reject) => {
      const onAnswer = (e: SessionsChangeEvent): void => {
        if (e.kind !== "draft") return;
        cleanup();
        resolve({ draftKey: e.draftKey });
      };
      this.listeners.add(onAnswer);
      const timer = setTimeout(() => {
        cleanup();
        log.warn("newChat.timeout", { reason: "timeout waiting for session.draft" });
        reject(new Error("timeout waiting for session.draft"));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(onAnswer);
      };
      this.send({ type: "session.new", requestId: newId(), intent: "explicit" });
    });
  }

  onSessionsChanged(fn: (e: SessionsChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
