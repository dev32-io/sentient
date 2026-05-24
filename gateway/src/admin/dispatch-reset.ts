import type { Log } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// dispatchReset — formerly fired `/reset` at the user's Hermes worker over a
// pooled custom-WS connection so a stale session_id rotated after a profile
// edit. The custom-WS pool was retired in the ACP cleanup; ACP has no
// equivalent "internal slash command" path today, so this is a logged
// no-op until an ACP-side rewrite lands.
//
// TODO(acp-rewire): re-implement under ACP — see
// docs/research/2026-05-08-apply-restart-acp-rewire-todo.md for the gap +
// required equivalents (acp ping/pong, /reset equivalent,
// connected-state observability).
//
// Practical effect today: after `apply` writes a fresh config + supervisord
// restarts the worker, the existing chat session keeps its cached
// system_prompt until session compression eventually rotates it. Operators
// who want immediate effect can `+ New chat` from the drawer.
// ---------------------------------------------------------------------------

export interface DispatchResetDeps {
  log: Log;
  /** Used for the log event prefix so each call site keeps its own breadcrumb. */
  source: string;
}

export function dispatchReset(deps: DispatchResetDeps, userId: string): void {
  deps.log.warn(`${deps.source}.reset-skipped-acp-no-equivalent`, {
    userId,
    reason: "ACP wire has no /reset equivalent — see acp-rewire-todo.md",
  });
}
