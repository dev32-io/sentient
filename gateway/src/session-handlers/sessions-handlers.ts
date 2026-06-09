import type { AcpPerProfileConnection } from "../hermes-adapter-client/per-profile-connection.ts";
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
   */
  readonly acpConn: AcpPerProfileConnection;
}

type Inbound = { type: "session.new"; requestId: string } | { type: "conversation.activate"; sessionId: string };

export interface SessionsHandlers {
  handle(frame: Inbound): Promise<void>;
}

export function createSessionsHandlers(cfg: SessionsHandlersConfig): SessionsHandlers {
  const sendError = (
    requestId: string | undefined,
    code: "forbidden" | "not_found" | "internal" | "validation",
    message: string,
  ): void => {
    const frame: Record<string, unknown> = { type: "sessions.error", code, message };
    if (requestId !== undefined) frame.requestId = requestId;
    cfg.send(frame);
  };

  const enforceOwnership = async (sessionId: string, requestId: string | undefined): Promise<boolean> => {
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
          case "conversation.activate": {
            // Lightweight activation: enforce ownership then switch the live
            // stream to the target session. Gateway emits session.switched
            // only — history is REST now, no conversation.snapshot on activate.
            if (!(await enforceOwnership(frame.sessionId, undefined))) return;
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
        // conversation.activate has no requestId — omit it from the error frame.
        const requestId = (frame as { requestId?: string }).requestId;
        sendError(requestId, "internal", message);
      }
    },
  };
}
