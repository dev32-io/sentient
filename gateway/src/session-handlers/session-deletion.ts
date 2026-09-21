import type { UserPrincipal } from "../identity/user-principal.js";
import type { AuthenticatedSockets } from "./authenticated-sockets.js";
import type { ReplayRegistry } from "./replay-registry.js";
import { sendDraftHandshake, unbindDeletedSession } from "./session-binding.js";
import type { SessionRegistry } from "./session-registry.js";
import { sendConnectionFrame } from "./ws-send.js";

export interface SessionDeletionDeps {
  sessionRegistry: SessionRegistry;
  replayRegistry: ReplayRegistry;
  authenticatedSockets: AuthenticatedSockets;
}

/** Call synchronously after the store transaction fences/deletes a session. */
export function finishSessionDeletion(deps: SessionDeletionDeps, principal: UserPrincipal, sessionId: string): void {
  const detached = deps.sessionRegistry.disposeDeletedSession(principal.userId, sessionId);
  deps.replayRegistry.invalidate(sessionId);
  // Include currently configuring/draft sockets and other sessions, so every
  // connected history list learns the deletion, not only the active chat.
  const windows = new Set([
    ...deps.authenticatedSockets.forUser(principal.userId),
    ...detached.map((attachment) => attachment.ws),
  ]);
  for (const ws of windows) {
    const draftKey = unbindDeletedSession(ws, sessionId);
    sendConnectionFrame(ws, { type: "sessions.deleted", sessionId });
    if (draftKey !== null) sendDraftHandshake(ws, draftKey, undefined);
  }
}
