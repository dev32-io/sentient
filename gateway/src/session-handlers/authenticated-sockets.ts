// Every LIVE AUTHENTICATED SOCKET, reachable by `userId`.
//
// WHY THIS EXISTS AND WHY IT IS NOT THE ATTACHMENT MAP. A credential revocation
// (credential-revocation.ts) has to close every socket the revoked account
// holds, and until this module the only way to enumerate them was
// `SessionRegistry.attachmentsForUser` — a walk of the RESIDENT SESSIONS. A
// connection that authenticated but has not yet run `session.configure` is in
// none of them: it has a principal, an open socket and a logged-in UI, and no
// attachment. Demoting that person logged `closedWindows=0` and left their
// window rendering as if nothing had happened, which is not what the demotion
// dialog promises ("signs them out on every device, right now").
//
// It was never a privilege escalation — `stale-authority.ts` refuses that
// socket on its very next frame and no capability is ever minted from it — but
// immediacy is the whole job of the revoker's half of the mechanism, and a
// draft window is exactly the window a person leaves open.
//
// A SCAN, NOT AN INDEX, for the same reason `attachmentsForUser` is one: the
// question is asked when an admin edits a household member, and a userId→sockets
// index would have to be kept in step through every auth, close and abnormal
// disconnect, buying speed nobody needs against a divergence that would leave a
// revoked account live. ONE map, socket → owner, so a teardown is a single
// `delete` keyed on the object itself — it cannot be defeated by `ws.data`
// having been cleared by the time the close handler runs.
//
// This is NOT authorization state. It answers "which sockets belong to this
// account?" and nothing else; the role behind every decision is still read off
// the user record at the moment of that decision.

import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionData } from "./ws-helpers.js";

const log = getLog(["sentient", "ws", "authenticated-sockets"]);

export interface AuthenticatedSockets {
  /**
   * Record that [ws] is authenticated as [userId]. Called at the ONE place a
   * `UserPrincipal` is minted (ws-auth-gate.ts), so membership begins exactly
   * when the socket becomes authenticated. Idempotent: the map is keyed on the
   * socket, so a repeated add can never leave two entries for one connection.
   */
  add(userId: string, ws: ServerWebSocket<SessionData>): void;
  /**
   * Forget [ws]. Called from the connection-close path (`cleanupSession`,
   * ws-handlers.ts), which Bun runs for EVERY teardown — a clean close, a lost
   * network, the revoker's own close, and a socket that never authenticated at
   * all. A no-op for a socket that is not a member, so a duplicate close is
   * harmless.
   */
  remove(ws: ServerWebSocket<SessionData>): void;
  /** Every live socket authenticated as [userId]. A COPY — the caller closes
   *  what it gets back, and each close removes an entry through the close
   *  handler, so iterating the live map would skip sockets. */
  forUser(userId: string): readonly ServerWebSocket<SessionData>[];
  /** Live authenticated sockets. Exposed so teardown paths can assert no leak. */
  readonly size: number;
}

export function createAuthenticatedSockets(): AuthenticatedSockets {
  const owners = new Map<ServerWebSocket<SessionData>, string>();

  return {
    add(userId, ws) {
      owners.set(ws, userId);
      log.debug("authenticated-sockets.added", {
        userId,
        connectionId: ws.data.sessionId,
        liveSockets: owners.size,
      });
    },

    remove(ws) {
      const userId = owners.get(ws);
      if (userId === undefined) {
        log.debug("authenticated-sockets.remove-ignored", {
          connectionId: ws.data.sessionId,
          liveSockets: owners.size,
          reason: "socket is not a member — it never authenticated, or this is a duplicate close",
        });
        return;
      }
      owners.delete(ws);
      log.debug("authenticated-sockets.removed", {
        userId,
        connectionId: ws.data.sessionId,
        liveSockets: owners.size,
      });
    },

    forUser(userId) {
      const owned: ServerWebSocket<SessionData>[] = [];
      for (const [ws, owner] of owners) {
        if (owner === userId) owned.push(ws);
      }
      return owned;
    },

    get size() {
      return owners.size;
    },
  };
}
