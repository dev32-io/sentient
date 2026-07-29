// ConversationFeed (spec §3.2, §3.4, §7) — the COMMITTED-feed producer.
//
// The `turn.*` family is a live, disposable stream: the client renders it
// while it arrives and drops it on `turn.completed`. What survives is this
// feed — `conversation.snapshot` on connect, `conversation.entry` per commit.
// Without it the assistant's reply vanishes the instant the turn completes,
// the user's own message never renders at all, and every reload / reconnect
// with `recovered:false` yields an empty chat.
//
// Single-path property: BOTH frames come from `projectForClient` over the
// same store entries, so `render(replay) == render(live)` (Invariant B) is
// structural rather than a coincidence of two hand-written mappings.
//
// EXACTLY ONCE, IN FINAL FORM. The web connector appends every
// `conversation.entry` to its mirror with no dedupe, so an item emitted twice
// is a duplicate bubble, and an item emitted before its content settles is a
// permanently stale one. Two rules follow:
//
//   - A tool tile is not content-final until its `tool_result` folds in
//     (client-projection.ts anchors the tile at the tool_call's POSITION and
//     fills its text from the result). It is therefore HELD BACK.
//   - Held-back items block everything after them. A stimulus landing between
//     a tool_call and its result (the steer path, §4.5) would otherwise be
//     published ahead of the tile and diverge from every later snapshot.
//
// So each publish emits the longest PREFIX of not-yet-published items that is
// content-final, and stops. `publishAll` releases the rest at a turn
// boundary — a background `delegateTask` never produces a `tool_result`, so
// its tile would otherwise strand the whole feed behind it forever.

import type { ConversationAssistantCutoff, ConversationFeedItem } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { type FeedItem, projectForClient } from "../store/client-projection.js";
import type { CutoffKind, SessionEntry } from "../store/entry-types.js";
import type { SessionStore } from "../store/session-store.js";
import type { UserId } from "../user-auth/user-id.js";

const log = getLog(["sentient", "runtime", "conversation-feed"]);

// Neither the stimulus seam (runtime/stimulus.ts) nor the entry schema
// records HOW a user message arrived — speech and typing both land as a
// `conversational` stimulus and then a `user` entry. Every committed user
// item therefore declares the text channel; recovering the spoken/typed
// distinction needs a field on both, which is a contract change.
const USER_CHANNEL = "text";

// `trigger` entries exist for exactly one producer today: a background task
// completing (session-runtime.ts's `stimulusEntryKind`).
const TRIGGER_SOURCE = "background-completion";

/** Emitted when the tool's round trip is recorded complete in the store. */
const TOOL_STATUS_FINISHED = "finished";
/** Emitted when no `tool_result` was ever committed for the call — the turn
 *  ended first, or the call was a background dispatch whose completion
 *  arrives later as its own `trigger` entry. The wire's status union has no
 *  "running" member, so this is the closest truthful value. */
const TOOL_STATUS_UNRESOLVED = "cancelled";

/** The two frames this module produces. Declared here rather than as a
 *  `Pick<TurnEmitter, …>` so the module is testable against a two-method
 *  double; `TurnEmitter` satisfies it structurally. */
export interface ConversationFeedSink {
  conversationSnapshot(items: ConversationFeedItem[]): void;
  conversationEntry(item: ConversationFeedItem, turnId?: string): void;
}

export interface ConversationFeed {
  /** Publish the session's whole committed feed and arm the live cursor at
   *  its tail. One call per non-recovered `session.configure`. */
  snapshot(): void;
  /** Publish every newly committed item that has reached its final shape.
   *  Safe to call after any append. */
  publishSettled(): void;
  /** Publish everything outstanding, including tool tiles still waiting on a
   *  result that is never coming. Called at every turn boundary. */
  publishAll(): void;
}

export interface ConversationFeedDeps {
  readonly store: SessionStore;
  readonly sessionId: string;
  readonly userId: UserId;
  readonly emitter: ConversationFeedSink;
}

function toWireCutoff(cutoff: CutoffKind): ConversationAssistantCutoff {
  // `cancelledTaskIds` is required by the frame, but nothing records which
  // background tasks a specific interrupt killed (`background.cancelAll()`
  // is fire-and-forget). An empty list is the honest value, not a guess.
  return cutoff === "interrupt" ? { kind: "interrupt", cancelledTaskIds: [] } : { kind: "barge-in" };
}

function toWireItem(item: FeedItem, isUnresolvedTool: boolean): ConversationFeedItem {
  const base = { entryId: item.id, ts: item.createdAt };
  switch (item.kind) {
    case "user":
      return { ...base, kind: "user", channel: USER_CHANNEL, content: item.text };
    case "trigger":
      return { ...base, kind: "trigger", source: TRIGGER_SOURCE, summary: item.text };
    case "assistant":
      return {
        ...base,
        kind: "assistant",
        content: item.text,
        ...(item.cutoff === null ? {} : { cutoff: toWireCutoff(item.cutoff) }),
      };
    case "tool":
      return {
        ...base,
        kind: "tool",
        toolName: item.toolName ?? "",
        status: isUnresolvedTool ? TOOL_STATUS_UNRESOLVED : TOOL_STATUS_FINISHED,
        summary: item.text,
      };
  }
}

/** Feed-item ids (= the tool_call entry's seq) whose `tool_result` has not
 *  been committed. These are the items whose CONTENT is not final yet. */
function unresolvedToolItemIds(entries: readonly SessionEntry[]): Set<string> {
  const resolved = new Set<string>();
  for (const e of entries) {
    if (e.kind === "tool_result" && e.toolCallId !== null) resolved.add(e.toolCallId);
  }
  const unresolved = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "tool_call" || e.toolCallId === null) continue;
    if (!resolved.has(e.toolCallId)) unresolved.add(String(e.seq));
  }
  return unresolved;
}

function lastSeqOf(entries: readonly SessionEntry[], fallback: number): number {
  return entries[entries.length - 1]?.seq ?? fallback;
}

export function createConversationFeed(deps: ConversationFeedDeps): ConversationFeed {
  const { store, sessionId, userId, emitter } = deps;

  // High-water mark over ENTRY seqs, not feed indices: everything at or below
  // it has been published in its final form. Held-back items keep it parked
  // just below their own entry, so the next publish re-reads them.
  //
  // ARMED AT THE STORE'S TAIL, not at zero. A recovered resume mints a new
  // runtime (and so a new feed) over a session the client ALREADY has —
  // ws-resume.ts restored its mirror by replaying the journal verbatim and
  // deliberately sends no snapshot. Starting at zero would republish that
  // whole history as individual entries on the next commit, doubling every
  // bubble the client is already showing. `snapshot()` re-arms to the same
  // place after emitting, so the fresh-connect path is unaffected.
  let publishedThroughSeq = lastSeqOf(store.readSession(sessionId), 0);

  function publish(force: boolean): void {
    // A TAIL read, not the whole session: the held-back tool_call is always
    // inside the window (the cursor never advances past it), so its result
    // still folds into its own tile. store/projection-convergence.test.ts
    // pins that a tail projects the same ids as a full replay.
    const tail = store.readSince(sessionId, publishedThroughSeq);
    if (tail.length === 0) return;

    // `unresolved` decides BOTH what is held back and what status a released
    // tile carries — `force` only lifts the hold. Deriving status from the
    // same predicate the snapshot uses is what keeps a force-released tile
    // convergent with its replay.
    const unresolved = unresolvedToolItemIds(tail);
    const turnIdBySeq = new Map<string, string>();
    for (const e of tail) turnIdBySeq.set(String(e.seq), e.turnId);

    let published = 0;
    let heldBackAtSeq: number | null = null;
    for (const item of projectForClient(tail)) {
      const isUnresolvedTool = unresolved.has(item.id);
      if (isUnresolvedTool && !force) {
        heldBackAtSeq = Number(item.id);
        break;
      }
      emitter.conversationEntry(toWireItem(item, isUnresolvedTool), turnIdBySeq.get(item.id));
      published += 1;
    }

    publishedThroughSeq = heldBackAtSeq === null ? lastSeqOf(tail, publishedThroughSeq) : heldBackAtSeq - 1;

    if (published === 0 && heldBackAtSeq === null) return;
    log.debug("conversation-feed.published", {
      userId,
      sessionId,
      published,
      force,
      heldBackAtSeq,
      throughSeq: publishedThroughSeq,
    });
  }

  return {
    snapshot(): void {
      const entries = store.readSession(sessionId);
      const unresolved = unresolvedToolItemIds(entries);
      const items = projectForClient(entries).map((i) => toWireItem(i, unresolved.has(i.id)));
      emitter.conversationSnapshot(items);
      publishedThroughSeq = lastSeqOf(entries, publishedThroughSeq);
      log.info("conversation-feed.snapshot", {
        userId,
        sessionId,
        itemCount: items.length,
        throughSeq: publishedThroughSeq,
      });
    },
    publishSettled(): void {
      publish(false);
    },
    publishAll(): void {
      publish(true);
    },
  };
}
