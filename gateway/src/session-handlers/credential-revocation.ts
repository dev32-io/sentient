// Credential revocation — the IMMEDIACY half of "a role change revokes the
// account's credentials" (plan 2026-08-07-tool-permissions task 2c).
//
// The authoritative half is the credential floor
// (user-auth/credential-floor.ts): once the record's `credentialsValidFrom`
// moves, every token issued before it stops validating at all 17 `validate()`
// call sites. That is complete for anything that presents a token per request.
// A WEBSOCKET DOES NOT. It is validated exactly once, at connect, and its
// `UserPrincipal` is minted there and never rebound — so a demoted admin with
// an open socket would keep the old authority until they happened to
// reconnect.
//
// REVOKE AND REBUILD, NEVER REBIND (owner ruling). Nothing here reaches into a
// principal to change its role: a settable principal is mutable authority, and
// every holder of one would have to be re-checked. The socket dies instead. The
// client sees `auth.error`, routes to its login screen, signs in, and the new
// connection mints a fresh token AND a fresh principal from the record as it
// stands. Same end state, nothing mutable in between.
//
// DELETION TAKES THE IDENTICAL PATH, and had the identical hole: `emitDeleted`
// was wired only to the MCP host, so a deleted account kept a working session
// until its token expired on the clock.
//
// WHAT IT DELIBERATELY DOES NOT DO: detach. A socket's attachment is dropped by
// the connection-close handler (`cleanupSession`, ws-handlers.ts), which is the
// one owner of that teardown — detaching here too would race it and could
// dispose a session's handles from underneath its own close path.

import type { SessionManager } from "../auth/session-manager.js";
import { getLog } from "../logging/logger.js";
import { closeWithAuthError } from "./credential-lifetime.js";
import type { SessionRegistry } from "./session-registry.js";

const log = getLog(["sentient", "ws", "credential-revocation"]);

/**
 * The refusal code every closed socket is told.
 *
 * `expired` and NOT a new code, deliberately: all three clients already route
 * it to the login screen (web classifies any `auth.error` frame as terminal;
 * mobile's `TERMINAL_AUTH_CODES` lists `expired`). A new code would be terminal
 * on the `auth.error` path but fall off mobile's sessions allow-list and retry
 * forever — a revoked account stuck in a reconnect loop instead of at a login
 * prompt. Same code `token-service.ts` refuses the revoked token with.
 */
const REVOKED_CODE = "expired";

const REVOKED_MESSAGE = "your account changed — please sign in again";

/** Why the credentials were revoked. Log-only: the client is told the same
 *  thing either way, because "sign in again" is the whole remedy for both. */
export type RevocationReason = "role-changed" | "user-deleted";

export interface CredentialRevoker {
  /** Close every live socket belonging to `userId` and drop its bound sessions. */
  revokeUser(userId: string, reason: RevocationReason): Promise<void>;
}

export interface CredentialRevokerDeps {
  /** Owns the attachment map, so it is the only thing that can answer "which
   *  windows belong to this user?". */
  registry: Pick<SessionRegistry, "attachmentsForUser">;
  /** Owns the per-user connection bookkeeping the closed sockets held. */
  sessions: Pick<SessionManager, "revokeUser">;
}

export function createCredentialRevoker(deps: CredentialRevokerDeps): CredentialRevoker {
  return {
    async revokeUser(userId, reason) {
      const attachments = deps.registry.attachmentsForUser(userId);
      for (const attachment of attachments) {
        log.warn("credential.revoked", {
          userId,
          connectionId: attachment.connectionId,
          sessionId: attachment.sessionId,
          attachmentId: attachment.attachmentId,
          reason,
        });
        closeWithAuthError(attachment.ws, REVOKED_CODE, REVOKED_MESSAGE);
      }
      deps.sessions.revokeUser(userId);
      log.info("credential.revocation-complete", {
        userId,
        closedWindows: attachments.length,
        reason,
      });
    },
  };
}
