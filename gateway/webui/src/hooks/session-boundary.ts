import type { CommittedFeedItem, InFlightMessage } from "@sentient/web-sdk";

/** What the conversation pane is showing that belongs to ONE conversation. */
export type SessionBoundaryKind = "switched" | "created" | "draft";

/** A `useRef`-shaped cell, structurally — this module never imports preact. */
export interface MutableRef<T> {
  current: T;
}

/** The mid-drain typewriter bubble, held open past `turn.completed`. */
export interface DrainBubble {
  readonly turnId: string;
  readonly replyId?: string;
  readonly snapshot: InFlightMessage;
}

/** Everything the pane holds that is scoped to the conversation it is showing. */
export interface ConversationScopedState {
  readonly drain: MutableRef<DrainBubble | null>;
  readonly inflight: MutableRef<readonly InFlightMessage[]>;
  readonly committed: MutableRef<readonly CommittedFeedItem[]>;
  readonly typewriterBubbleId: MutableRef<string | null>;
  readonly typewriter: { reset(): void };
  readonly taskList: { clear(): void };
}

/**
 * Drop everything scoped to the conversation the pane just left.
 *
 * The typewriter half: a mid-turn session switch aborts the running turn
 * server-side, but the drain machinery would keep revealing the OLD turn's
 * buffered text as a synthetic bubble in the NEW pane until catch-up.
 *
 * The strip half: `tasklist.state` is a per-session projector that only
 * re-emits on its own mutations. `switched` is answered with a fresh full-state
 * frame (ws-conversation-activate.ts), but `draft` / `created` are NOT — the
 * draft handshake sends an empty `conversation.snapshot` and no strip frame,
 * and the socket then unbinds, so the old runtime's clearing frame can never
 * arrive. A background `delegateTask` row is keyed by taskId and retained by
 * design, so nothing else ever retires it: without this call it sits on the
 * composer strip of every later chat, permanently. Mobile clears the same
 * mirror at the same boundary (`SentientSdk.clearConversationScopedState`).
 * Clearing on `switched` too is not redundancy for its own sake — it closes the
 * window between the switch and the server's frame landing.
 *
 * `deleted` / `renamed` are NOT boundaries: the pane keeps showing what it was.
 */
export function clearConversationScopedState(kind: SessionBoundaryKind, state: ConversationScopedState): void {
  state.drain.current = null;
  state.inflight.current = [];
  state.typewriterBubbleId.current = null;
  state.typewriter.reset();
  state.taskList.clear();

  // `switched` refetches: ConversationHistoryConnector is subscribed to the
  // SAME session.switched frame and will replace the committed mirror with the
  // new session's REST-loaded history moments after this runs. Leave it alone.
  //
  // `draft` and `created` are TWO DIFFERENT MECHANISMS, verified live and
  // separately — do not read them as one case:
  //
  //   - `draft`: session-binding.ts's `sendDraftHandshake` sends an empty
  //     `conversation.snapshot` (`items: []`) on the SAME socket immediately
  //     before the `session.draft` frame. WS preserves per-socket order, and
  //     ConversationHistoryConnector's snapshot handler is an unconditional
  //     mirror REPLACE, so the mirror is already `[]` by the time this runs.
  //     Verified by pulling this assignment and re-running "+" against a
  //     loaded session: the console showed `conversation.snapshot {items:[]}`
  //     land (not dedup-dropped) strictly before `session.draft`.
  //
  //   - `created` (the common, non-replayed path — typing the first message of
  //     a fresh draft): NO snapshot precedes it. `ensureBoundRuntime`'s mint
  //     path (ws-handlers.ts) sends `session.created` directly — its own
  //     comment: "A fresh mint needs no snapshot: an empty feed is the truth
  //     there." Verified by driving the flow with a full frame trace:
  //     `session.created` followed `session.draft` with NO
  //     `conversation.snapshot` in between, and with this assignment pulled the
  //     mirror was ALREADY empty — not because `created` cleared it, but
  //     transitively, because the EARLIER `draft` frame's own snapshot cleared
  //     it and nothing since had touched it. The user's own
  //     `conversation.entry` for the fresh message arrives only AFTER this
  //     runs (once `runtime.submit` starts the turn), so it cannot race.
  //     A REPLAYED mint (a dropped-ack retry) is the one sub-case this
  //     reasoning does not cover directly — there,
  //     `runtime.emitConversationSnapshot()` sends a REAL, non-empty snapshot
  //     moments after `session.created`, which unconditionally overwrites
  //     whatever this line does either way.
  //
  // Net: on every path this fires for, something OTHER than this assignment
  // already produces the correct mirror. Kept as cheap, harmless
  // defense-in-depth against either mechanism changing without this file's own
  // test catching it — not because either is unverified.
  if (kind !== "switched") {
    state.committed.current = [];
  }
}
