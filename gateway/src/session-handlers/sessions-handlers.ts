import type { SessionRow } from "@sentient/protocol";
import type { AcpPerProfileConnection } from "../hermes-adapter-client/per-profile-connection.ts";
import type { SentientPluginClient } from "../hermes-adapter-client/plugin-client.ts";
import { type HermesSessionRow, listSessionsViaAcp } from "../hermes-adapter-client/sessions-client.ts";
import { getLog } from "../logging/logger.js";
import type { SwitchFlow } from "../sessions/switch-flow.ts";
import type { TitleStore } from "../sessions/title-store.ts";

const log = getLog(["sentient", "session-handlers", "sessions-handlers"]);

export interface SessionsHandlersConfig {
  readonly userId: string;
  readonly titleStore: TitleStore;
  readonly send: (frame: Record<string, unknown>) => void;
  readonly switchFlow: SwitchFlow;
  /** Returns the set of session ids owned by the current profile (for ownership guard). */
  readonly profileSessionsLookup: () => Promise<Set<string>>;
  /**
   * Stash a gateway-minted session id so the next outbound user.message to
   * Hermes carries it (consumed once, then cleared by the caller).
   */
  readonly setPendingNewSessionId?: (sessionId: string) => void;
  /**
   * Pre-warm path: stash an in-flight `acpConn.newSession` Promise so the
   * next outbound user.message can await it before dispatching. Used by
   * `session.new` to kick session creation as a background task and let the
   * webui navigate to the empty chat input immediately. Resolves with the
   * minted sessionId; the user.message handler awaits it once and consumes.
   */
  readonly setPendingNewSessionPromise?: (promise: Promise<string>) => void;
  /**
   * Long-lived ACP per-profile connection — required under the ACP-only
   * wire. `session.new` calls `acpConn.newSession({})` to obtain the
   * server-minted session id (per ACP spec the agent owns id allocation).
   * `sessions.list` reads through `listSessionsViaAcp`.
   */
  readonly acpConn: AcpPerProfileConnection;
  /**
   * Sentient-plugin REST client for surfaces ACP doesn't cover: search,
   * get, getMessages, delete. Mounted on the per-profile dashboard sidecar
   * (see plugin-client.ts).
   */
  readonly pluginClient: SentientPluginClient;
}

type Inbound =
  | { type: "sessions.list"; requestId: string; limit: number; offset: number }
  | { type: "sessions.search"; requestId: string; q: string; limit: number }
  | { type: "sessions.delete"; requestId: string; sessionId: string }
  | { type: "sessions.rename"; requestId: string; sessionId: string; title: string }
  | { type: "session.new"; requestId: string }
  | { type: "session.switch"; requestId: string; sessionId: string };

export interface SessionsHandlers {
  handle(frame: Inbound): Promise<void>;
}

const toSessionRow = (raw: HermesSessionRow, override: string | undefined): SessionRow => ({
  sessionId: raw.id,
  rootId: raw.parent_session_id ?? raw.id,
  title: override ?? raw.title ?? "New chat",
  startedAt: Math.round(raw.started_at * 1000),
  lastActiveAt: Math.round((raw.last_active ?? raw.started_at) * 1000),
  messageCount: raw.message_count,
  isActive: raw.is_active,
});

export function createSessionsHandlers(cfg: SessionsHandlersConfig): SessionsHandlers {
  const sendError = (
    requestId: string,
    code: "forbidden" | "not_found" | "internal" | "validation",
    message: string,
  ): void => {
    cfg.send({ type: "sessions.error", requestId, code, message });
  };

  const enforceOwnership = async (sessionId: string, requestId: string): Promise<boolean> => {
    const owned = await cfg.profileSessionsLookup();
    if (!owned.has(sessionId)) {
      log.warn("ownership-reject", { userId: cfg.userId, sessionId });
      sendError(requestId, "forbidden", "session not owned by current profile");
      return false;
    }
    return true;
  };

  return {
    async handle(frame) {
      try {
        switch (frame.type) {
          case "sessions.list": {
            // ACP `session/list` is the only list source under the ACP-only
            // wire. The per-profile port scopes naturally to one Hermes
            // profile, so no source filter is applied here.
            const result = await listSessionsViaAcp(cfg.acpConn);
            const ids = result.sessions.map((r) => r.sessionId);
            const overrides = await cfg.titleStore.getTitlesFor(ids);
            const items = result.sessions.map((r) => ({
              ...r,
              title: overrides[r.sessionId] ?? r.title,
            }));
            cfg.send({
              type: "sessions.list.result",
              requestId: frame.requestId,
              items,
              total: items.length,
              hasMore: result.nextCursor !== null,
            });
            log.info("list:done", { count: items.length, requestId: frame.requestId });
            return;
          }
          case "sessions.search": {
            const hits = await cfg.pluginClient.search(frame.q, frame.limit);
            const owned = await cfg.profileSessionsLookup();
            const visible = hits.filter((h) => owned.has(h.session_id));
            const overrides = await cfg.titleStore.getTitlesFor(visible.map((h) => h.session_id));
            const rows = await Promise.all(visible.map((h) => cfg.pluginClient.get(h.session_id).catch(() => null)));
            // Under the ACP-only wire every session in the per-profile DB
            // belongs to the active profile by construction; no source
            // filter needed.
            const items: SessionRow[] = [];
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              const hit = visible[i];
              if (row && hit) {
                items.push(toSessionRow(row, overrides[hit.session_id]));
              }
            }
            cfg.send({ type: "sessions.search.result", requestId: frame.requestId, items });
            log.info("search:done", {
              hits: hits.length,
              returned: items.length,
              requestId: frame.requestId,
            });
            return;
          }
          // Mutating handlers emit a *.result frame (resolves the SDK request
          // Promise) AND a broadcast frame (drives live UI updates across tabs).
          case "sessions.delete": {
            if (!(await enforceOwnership(frame.sessionId, frame.requestId))) return;
            try {
              await cfg.pluginClient.delete(frame.sessionId);
              await cfg.titleStore.delete(frame.sessionId);
              cfg.send({ type: "sessions.delete.result", requestId: frame.requestId, sessionId: frame.sessionId });
              cfg.send({ type: "sessions.deleted", sessionId: frame.sessionId });
              log.info("delete:done", { sessionId: frame.sessionId });
            } catch (err: unknown) {
              const status = (err as { status?: number }).status;
              if (status === 404) {
                sendError(frame.requestId, "not_found", "session not found");
                return;
              }
              throw err;
            }
            return;
          }
          case "sessions.rename": {
            if (!(await enforceOwnership(frame.sessionId, frame.requestId))) return;
            await cfg.titleStore.setTitle(frame.sessionId, frame.title);
            cfg.send({
              type: "sessions.rename.result",
              requestId: frame.requestId,
              sessionId: frame.sessionId,
              title: frame.title,
            });
            cfg.send({ type: "sessions.renamed", sessionId: frame.sessionId, title: frame.title });
            log.info("rename:done", { sessionId: frame.sessionId });
            return;
          }
          case "session.new": {
            // Pre-warm: clear the chat pane synchronously so the webui sees
            // an empty conversation immediately, then kick `acpConn.newSession`
            // as a background task. The user.message handler awaits the
            // resulting Promise before dispatch (via setPendingNewSessionPromise)
            // — this hides the ACP cold-start latency (model probe + MCP
            // handshake) behind the user's typing time.
            //
            // Failure surfaces as `sessions.error` to the connector RPC AND
            // propagates through the stashed Promise so the user.message
            // handler rejects with a meaningful reason instead of dispatching
            // to a nonexistent session.
            await cfg.switchFlow.switchTo("");

            const requestId = frame.requestId;
            const promise: Promise<string> = (async () => {
              try {
                const result = await cfg.acpConn.newSession({});
                cfg.setPendingNewSessionId?.(result.sessionId);
                log.info("session.new:acp-minted", {
                  sessionId: result.sessionId,
                  requestId,
                });
                cfg.send({
                  type: "session.created",
                  sessionId: result.sessionId,
                  ts: Date.now(),
                });
                return result.sessionId;
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                log.warn("session.new:acp-failed", { requestId, reason: message });
                sendError(requestId, "internal", message);
                throw err;
              }
            })();
            cfg.setPendingNewSessionPromise?.(promise);
            // Swallow rejection at the dangling-Promise edge — user.message
            // is the consumer and will surface the error there. Without this,
            // a setPendingNewSessionPromise callback that no-ops (tests) leaves
            // an unhandled rejection if ACP fails.
            promise.catch(() => {
              /* handled via consumer or sendError above */
            });
            return;
          }
          case "session.switch": {
            if (!(await enforceOwnership(frame.sessionId, frame.requestId))) return;
            await cfg.switchFlow.switchTo(frame.sessionId);
            // Force the resumed id onto the next user.message — symmetric to
            // session.new. Without this, follow-up messages land on Hermes'
            // default tuple-keyed chain and the resumed row stays empty.
            cfg.setPendingNewSessionId?.(frame.sessionId);
            // session.switched is emitted by the snapshot listener once
            // mirror.replaceAll fires.
            return;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("handler:error", { type: (frame as { type: string }).type, message });
        sendError((frame as { requestId: string }).requestId ?? "", "internal", message);
      }
    },
  };
}
