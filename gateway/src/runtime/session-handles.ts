// The per-session runtime factory's CONTRACT (Plan 3 Task 6): what the
// composition root is asked for, and the pair it hands back. Both returned
// objects are connection-scoped and torn down together: `runtime.dispose()`
// aborts the in-flight turn and closes the store handle;
// `permissions.denyAll()` settles any open permission prompt so a dropped
// socket cannot leave a ReAct turn awaiting an answer that will never come.

import type { UserPrincipal } from "../identity/user-principal.js";
import type { PermissionBroker } from "./permission-broker.js";
import type { SessionRuntime } from "./session-runtime.js";
import type { TurnEmitter } from "./turn-emitter.js";
import type { TurnVoice } from "./turn-voice.js";

export interface SessionHandles {
  runtime: SessionRuntime;
  permissions: PermissionBroker;
}

/**
 * Everything the factory needs for one session. Named fields, not positional
 * arguments, for one reason: `conversationId` and `connectionId` are BOTH
 * opaque strings and mixing them up is exactly the bug this shape exists to
 * make unrepresentable — the store partitioned on the connection id opened a
 * brand-new empty conversation on every reload, reconnect and gateway restart.
 */
export interface SessionRuntimeRequest {
  principal: UserPrincipal;
  /**
   * The DURABLE conversation id — the session store's partition key, resolved
   * in `handleSessionConfigure` from the principal plus the client's stable
   * surface id. Survives every socket. Reaches `SessionRuntimeDeps.sessionId`
   * (the store's own vocabulary for a partition) and NOTHING else.
   */
  conversationId: string;
  /**
   * The CONNECTION id (`ws.data.sessionId`), minted per WebSocket and dead
   * with it. Log correlation ONLY — it is what makes a tool dispatch or a
   * permission prompt traceable to the one socket that issued it, so a
   * before-reload and an after-reload connection on the same conversation stay
   * distinguishable in the logs. Never a durable key.
   */
  connectionId: string;
  emitter: TurnEmitter;
  /** This session's TTS fork, or null/absent for a text-only session. */
  voice?: TurnVoice | null;
}

/**
 * Per-session runtime factory. `null` at the service level when
 * `orchestrator:` is absent from config; present-but-no-provider is a
 * different state — the factory exists and throws when actually invoked.
 */
export type CreateSessionRuntime = (request: SessionRuntimeRequest) => SessionHandles;
