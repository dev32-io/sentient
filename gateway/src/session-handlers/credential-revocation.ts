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
// CLOSING THE SOCKETS IS NOT THE WHOLE JOB, because the SESSION outlives them.
// `session-retention.ts` keeps a session resident while a background task is
// unfinished — deliberately, since nothing cancels one and disposal closes the
// store handle its result must land through. That retained `SessionRuntime`
// holds a `ToolBroker` whose `Capability` was minted with the old role frozen
// into it, and `submit` guards only on `disposed`. So a `delegateTask` settling
// after the demotion started a HEADLESS follow-up turn: a full ReAct loop
// dispatching tools at the pre-demotion role, with no window attached and
// nobody to see it. Every resident runtime of the account is therefore
// `revokeAuthority`-ed here, which stops the next turn without disposing the
// session — the completed task's result still becomes durable, which is the
// entire reason the session was retained.
//
// THE RUNTIME WALK IS WIDER THAN THE ATTACHMENT WALK, and must be: a session
// retained by a background task has zero attachments and zero sockets, so
// neither enumeration below would reach it. `runtimesForUser` is the only one
// that does.
//
// WHAT IT DELIBERATELY DOES NOT DO: detach. A socket's attachment is dropped by
// the connection-close handler (`cleanupSession`, ws-handlers.ts), which is the
// one owner of that teardown — detaching here too would race it and could
// dispose a session's handles from underneath its own close path.
//
// AND: dispose. See `SessionRuntime.revokeAuthority` — disposing would throw
// away the very work retention exists to preserve. A turn already RUNNING when
// the revocation lands also finishes under the capability it started with; that
// exposure is bounded by one turn, and the doc comment there says why closing
// it would cost a third cancellation gesture.
//
// TWO ENUMERATIONS, ONE EJECTION EACH. The attachment walk answers "which
// WINDOWS of a live conversation belong to this account?"; the
// authenticated-socket set (authenticated-sockets.ts) answers "which SOCKETS
// do?", which is the strictly larger question and the one that matters here. An
// end-to-end run found the gap: a target who was signed in but had not started
// a conversation held a socket in no session's subscriber set, so demoting them
// logged `closedWindows=0` and left their window rendering a logged-in UI. Both
// are read because the attachment carries the session/attachment ids the
// revocation line is traced by, and an attached window appears in BOTH — hence
// the dedup on socket identity below. It is closed once, or the client sees a
// second `auth.error` and a close after its socket already went.

import type { ServerWebSocket } from "bun";
import type { SessionManager } from "../auth/session-manager.js";
import { getLog } from "../logging/logger.js";
import type { AuthenticatedSockets } from "./authenticated-sockets.js";
import { closeWithAuthError } from "./credential-lifetime.js";
import type { SessionRegistry } from "./session-registry.js";
import type { SessionData } from "./ws-helpers.js";

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
  /** Owns the attachment map AND the resident-session map, so it is the only
   *  thing that can answer either "which windows of a live conversation belong
   *  to this user?" or "which of their sessions are still resident?" — and the
   *  second set is not a subset of the first. */
  registry: Pick<SessionRegistry, "attachmentsForUser" | "runtimesForUser">;
  /** Owns every live authenticated socket, attached or not — the enumeration
   *  that reaches a window which has not run `session.configure` yet. */
  sockets: Pick<AuthenticatedSockets, "forUser">;
  /** Owns the per-user connection bookkeeping the closed sockets held. */
  sessions: Pick<SessionManager, "revokeUser">;
}

/** One socket to eject, with whatever session context it had. `sessionId` /
 *  `attachmentId` are null for a socket that never attached — that IS the
 *  distinction, so it is carried rather than papered over. */
interface RevocationTarget {
  readonly ws: ServerWebSocket<SessionData>;
  readonly connectionId: string | null;
  readonly sessionId: string | null;
  readonly attachmentId: string | null;
}

/**
 * Every socket of [userId], each appearing exactly ONCE.
 *
 * Attachments first, so a window of a live conversation is logged with the
 * session and attachment ids that trace it; the authenticated-socket set then
 * contributes only what the attachment walk did not already reach. Both
 * enumerations hand back copies, so a socket whose close handler runs while the
 * caller is closing its peers cannot make this skip one.
 */
function targetsFor(deps: CredentialRevokerDeps, userId: string): readonly RevocationTarget[] {
  const seen = new Set<ServerWebSocket<SessionData>>();
  const targets: RevocationTarget[] = [];
  for (const attachment of deps.registry.attachmentsForUser(userId)) {
    if (seen.has(attachment.ws)) continue;
    seen.add(attachment.ws);
    targets.push({
      ws: attachment.ws,
      connectionId: attachment.connectionId,
      sessionId: attachment.sessionId,
      attachmentId: attachment.attachmentId,
    });
  }
  for (const ws of deps.sockets.forUser(userId)) {
    if (seen.has(ws)) continue;
    seen.add(ws);
    targets.push({ ws, connectionId: ws.data.sessionId, sessionId: null, attachmentId: null });
  }
  return targets;
}

export function createCredentialRevoker(deps: CredentialRevokerDeps): CredentialRevoker {
  return {
    async revokeUser(userId, reason) {
      const targets = targetsFor(deps, userId);
      let attachedWindows = 0;
      for (const target of targets) {
        if (target.attachmentId !== null) attachedWindows += 1;
        log.warn("credential.revoked", {
          userId,
          connectionId: target.connectionId,
          sessionId: target.sessionId,
          attachmentId: target.attachmentId,
          reason,
        });
        closeWithAuthError(target.ws, REVOKED_CODE, REVOKED_MESSAGE);
      }
      // AFTER the sockets, before the bookkeeping drop. The runtimes outlive
      // both — this is what stops a retained session starting a turn under the
      // capability the closed sockets were minted with.
      const runtimes = deps.registry.runtimesForUser(userId);
      for (const runtime of runtimes) runtime.revokeAuthority(reason);
      deps.sessions.revokeUser(userId);
      log.info("credential.revocation-complete", {
        userId,
        // Every socket closed, deduplicated — an attached window is in both
        // enumerations and is counted (and closed) once.
        closedWindows: targets.length,
        // How many of them were windows on a live conversation. The rest were
        // signed in and had not started one, which is the case that used to be
        // missed entirely.
        attachedWindows,
        // Resident sessions this account still owns. Can EXCEED closedWindows:
        // a session retained by an unfinished background task has no window at
        // all, and is exactly the one that could still have run a turn.
        revokedRuntimes: runtimes.length,
        reason,
      });
    },
  };
}
