// The per-session runtime factory's CONTRACT (Plan 3 Task 6): what the
// composition root is asked for, and the pair it hands back.
//
// SESSION-scoped, not connection-scoped (session-model plan task 5). Both
// returned objects belong to the session and are torn down together, by the
// session registry's disposal policy rather than by any one socket's close:
// `runtime.dispose()` aborts the in-flight turn and closes the store handle,
// and `permissions.denyAll(reason)` settles any open permission prompt so the
// LAST window leaving cannot strand a ReAct turn awaiting an answer that will
// never come. A window closing while others remain attached settles nothing —
// a prompt it issued is still answerable from any of them, which since task 7
// is a property of the broker itself (session-permission-broker.ts) rather
// than of which socket happens to hold a reference to it.
//
// The pair is one member of `SessionHandles`
// (session-handlers/session-registry.ts), which is what the registry stores
// and hands to every attaching connection.

import type { UserPrincipal } from "../identity/user-principal.js";
import type { SessionPermissionBroker } from "./session-permission-broker.js";
import type { SessionWorkSignals } from "./session-retention.js";
import type { SessionRuntime } from "./session-runtime.js";
import type { TurnEmitter } from "./turn-emitter.js";
import type { TurnVoice } from "./turn-voice.js";

/** What the factory returns. Named apart from `SessionHandles` because that
 *  is the strictly larger set the registry keeps — this trio plus the voice
 *  preferences, the window set and the disposal that ties them together. */
export interface SessionRuntimeHandles {
  runtime: SessionRuntime;
  permissions: SessionPermissionBroker;
  /**
   * What this session is currently DOING, as getters (task 8). Built here
   * because this factory is the only scope holding all three producers — the
   * runtime's turn, the broker's foreground call and background registry, and
   * the permission broker's open prompts. The registry's disposal policy reads
   * it to decide residency; nothing else does.
   */
  work: SessionWorkSignals;
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
   * The DURABLE session id — the session store's partition key. Server-minted,
   * opaque and CSPRNG (session-handlers/session-id.ts); a client-presented one
   * is honoured only after a membership lookup. It is NOT derived from the
   * principal and a surface id — that derivation was deleted with the
   * `c::<userId>::<surfaceId>` shape. Survives every socket, and is the key the
   * runtime itself is registered under. Reaches `SessionRuntimeDeps.sessionId`
   * (the store's own vocabulary for a partition) and NOTHING else.
   */
  conversationId: string;
  /**
   * The CONNECTION id (`ws.data.sessionId`) of the connection whose attach
   * BUILT this session — minted per WebSocket and dead with it. Log
   * correlation ONLY — it is what makes a tool dispatch or a
   * permission prompt traceable to the one socket that issued it, so a
   * before-reload and an after-reload connection on the same conversation stay
   * distinguishable in the logs. Never a durable key.
   */
  connectionId: string;
  emitter: TurnEmitter;
  /**
   * How many windows are attached to this session RIGHT NOW.
   *
   * A GETTER, read at the moment a permission prompt is raised rather than
   * captured here: the count at construction time is always zero (the first
   * attachment is recorded after the handles are built) and a session outlives
   * every one of its windows. It is what makes "a prompt no window can see is
   * denied at once" a decision rather than a two-minute park — see
   * `SessionPermissionBroker`.
   */
  attachedWindows: () => number;
  /** This session's audio authority (session-handlers/user-audio-policy.ts).
   *  Read to tell the model whether its reply will actually be spoken — the
   *  `<situation>` block's `delivery:` line. Optional: a text-only or headless
   *  composition root has none, and the line is simply omitted. */
  audioPolicy?: { shouldSpeak(): Promise<boolean> } | null;
  /** This session's TTS fork, or null/absent for a text-only session. */
  voice?: TurnVoice | null;
  /**
   * Fired when a unit of this session's work finishes — today, whenever a turn
   * settles, which is the point every background completion, tool result and
   * answered prompt the turn was waiting on has resolved through.
   *
   * The composition root binds it to `SessionRegistry.reevaluate(sessionId)`.
   * Retention is derived from work, and work COMPLETING is not an attach or a
   * detach, so without this seam a session whose last window left mid-work
   * would stay resident until the retention policy's own re-check timer
   * noticed. Optional: a headless harness has no registry to tell.
   */
  onWorkSettled?: () => void;
}

/**
 * Per-session runtime factory. `null` at the service level when
 * `orchestrator:` is absent from config; present-but-no-provider is a
 * different state — the factory exists and throws when actually invoked.
 */
export type CreateSessionRuntime = (request: SessionRuntimeRequest) => SessionRuntimeHandles;
