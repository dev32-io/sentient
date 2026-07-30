import type { Session } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "mcp-host", "active-session-lookup"]);

/**
 * Resolves "which live connection belongs to this user?" for the gateway-hosted
 * MCP tools. A tool call arrives carrying only a userId (each per-user MCP
 * socket is bound to one), but `pause_audio` / `resume_audio` /
 * `update_user_settings` all act on a *connection*.
 *
 * This used to be `SessionRouter.findActiveSessionFor`, whose real job was
 * mapping a user to their per-user Hermes ACP worker port. Nothing ever called
 * that router's `bind()` after the ACP purge, so the lookup returned `null`
 * unconditionally and these three tools were permanently unreachable. The
 * live registry of sessionId → userId is `SessionManager` (populated at
 * `auth.ok` via `bindUser`), so the lookup is rehomed onto it.
 */
export interface ActiveSessionLookup {
  /** The most recently created live session bound to `userId`, or `null` when
   *  the user has no connection open. */
  findActiveSessionFor(userId: string): string | null;
}

/** Narrow view of `SessionManager` this lookup needs — a full manager
 *  satisfies it structurally. */
export interface SessionRegistry {
  listSessions(): Session[];
}

export function createActiveSessionLookup(sessions: SessionRegistry): ActiveSessionLookup {
  return {
    findActiveSessionFor(userId) {
      let latest: Session | null = null;
      for (const s of sessions.listSessions()) {
        // `>=` so a later entry wins an exact createdAt tie, matching the
        // insertion-order preference the old bindSeq counter gave.
        if (s.userId === userId && (latest === null || s.createdAt >= latest.createdAt)) {
          latest = s;
        }
      }
      if (latest === null) {
        log.debug("no-active-session", { userId });
        return null;
      }
      log.debug("resolved", { userId, sessionId: latest.sessionId });
      return latest.sessionId;
    },
  };
}
