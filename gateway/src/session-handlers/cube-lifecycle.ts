import { existsSync } from "node:fs";
import type { AccessManager } from "../access/access-manager.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import { openSessionStore } from "../store/session-store.js";
import { configuredUserDatabasePath } from "../store/user-database.js";
import type { AuthenticatedSockets } from "./authenticated-sockets.js";
import { closeWithAuthError } from "./credential-lifetime.js";
import { detachSession } from "./session-binding.js";
import type { SessionRegistry } from "./session-registry.js";

/** Durable fence first, then cooperative local teardown. Never cancels delegates. */
export function retireCubeExecutions(
  deps: {
    accessManager: AccessManager;
    dbFileName?: string;
    sessionRegistry: SessionRegistry;
    authenticatedSockets: AuthenticatedSockets;
  },
  principal: UserPrincipal,
): void {
  const cap = deps.accessManager.grant(principal, "session-store");
  let ids: string[] = [];
  // Retirement is not provisioning, including the post-delete authority fence.
  if (existsSync(configuredUserDatabasePath(cap, deps.dbFileName))) {
    const store = openSessionStore(cap, deps.dbFileName);
    try {
      ids = store.closeCubeExecutions("owner-changed");
    } finally {
      store.close();
    }
  }
  for (const id of ids) {
    const handles = deps.sessionRegistry.handlesFor(id);
    handles?.permissions.denyAll("Session execution is closed");
    handles?.runtime.revokeAuthority("device-authority-retired");
  }
  // Shared daily grant: conservative closure also ejects other physical Cubes.
  for (const ws of deps.authenticatedSockets.forUser(principal.userId)) {
    if (ws.data.authState !== "authed" || ws.data.principal?.origin?.kind !== "cube") continue;
    ws.data.authState = "rejected";
    detachSession(ws, deps);
    closeWithAuthError(ws, "expired", "device authority changed");
  }
}
