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
// same store entries, so `render(replay_from(seq)) == render(live_at(seq))`
// (Invariant B) is structural rather than a coincidence of two hand-written
// mappings. Note the qualifier — it holds for a seq a client GENUINELY
// reached. A window that JOINS mid-turn is a different, defined path
// (`snapshot ∪ replay_from(watermark)`, session-model spec §7.2) which
// converges with this projection once the in-flight turn commits; asserting
// the unqualified form for a joiner is false.
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
  conversationEntry(item: ConversationFeedItem, turnId?: string, replyId?: string): void;
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
  /** Re-emit an ALREADY-published entry, leaving the cursor untouched.
   *
   *  One caller: a client resend of a `pendingId` this session already
   *  committed (session-runtime.ts). The message must not be committed twice,
   *  but it must still be ANSWERED — a silent drop leaves the client's outbox
   *  retrying forever, which is worse than the duplicate it replaces. The
   *  re-emitted frame carries the same `entryId`, so the KMP connector's
   *  dedupe-by-entryId updates in place rather than appending a second
   *  bubble. */
  republish(entry: SessionEntry): void;
}

export interface ConversationFeedDeps {
  readonly store: SessionStore;
  readonly sessionId: string;
  readonly userId: UserId;
  readonly emitter: ConversationFeedSink;
}

function toWireCutoff(cutoff: CutoffKind): ConversationAssistantCutoff {
  // `cancelledTaskIds` is required by the frame and is ALWAYS empty now:
  // an interrupt cancels the turn and nothing else — a background task
  // outlives it, and nothing anywhere cancels one (tools/delegate-task.ts).
  // Empty is the accurate value, not a placeholder.
  return cutoff === "interrupt" ? { kind: "interrupt", cancelledTaskIds: [] } : { kind: "barge-in" };
}

function toWireItem(item: FeedItem, isUnresolvedTool: boolean): ConversationFeedItem {
  const base = { entryId: item.id, ts: item.createdAt };
  switch (item.kind) {
    case "user":
      return {
        ...base,
        kind: "user",
        channel: USER_CHANNEL,
        content: item.text,
        // Echoed ONLY when the client supplied one. A spoken turn has no
        // optimistic bubble to settle, so an empty-string placeholder would be
        // a value the client would then try to reconcile against.
        ...(item.pendingId === null ? {} : { pendingId: item.pendingId }),
      };
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

/**
 * Project committed entries into the EXACT wire shape the live path emits on
 * `conversation.snapshot` — `projectForClient` plus the same per-item
 * `toWireItem` status derivation `snapshot()` below uses.
 *
 * Exported so `api/handlers/sessions.ts` (`GET /sessions/:id/messages`) can
 * reuse it rather than re-deriving the shape: `render(replay) == render(live)`
 * is a protocol contract, and two hand-written projections is how it drifts.
 */
export function snapshotFeedItems(entries: readonly SessionEntry[]): ConversationFeedItem[] {
  const unresolved = unresolvedToolItemIds(entries);
  return projectForClient(entries).map((i) => toWireItem(i, unresolved.has(i.id)));
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
    // The reply id travels with the turn key: a committed entry and the live
    // bubble it replaces must group by the SAME value, or the swap at turn end
    // shows a different set of rows than the stream did.
    const replyIdBySeq = new Map<string, string>();
    for (const e of tail) {
      turnIdBySeq.set(String(e.seq), e.turnId);
      if (e.replyId !== null) replyIdBySeq.set(String(e.seq), e.replyId);
    }

    let published = 0;
    let heldBackAtSeq: number | null = null;
    for (const item of projectForClient(tail)) {
      const isUnresolvedTool = unresolved.has(item.id);
      if (isUnresolvedTool && !force) {
        heldBackAtSeq = Number(item.id);
        break;
      }
      emitter.conversationEntry(
        toWireItem(item, isUnresolvedTool),
        turnIdBySeq.get(item.id),
        replyIdBySeq.get(item.id),
      );
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
      const items = snapshotFeedItems(entries);
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
    republish(entry: SessionEntry): void {
      const item = projectForClient([entry])[0];
      if (item === undefined) {
        log.warn("conversation-feed.republish.not-renderable", {
          userId,
          sessionId,
          seq: entry.seq,
          kind: entry.kind,
          reason: "the projection renders no feed item for this entry kind",
        });
        return;
      }
      // `false`: only a tool tile can be unresolved, and republish is only
      // ever called with the `user` entry a resend matched.
      emitter.conversationEntry(toWireItem(item, false), entry.turnId, entry.replyId ?? undefined);
      log.info("conversation-feed.republished", { userId, sessionId, seq: entry.seq, turnId: entry.turnId });
    },
  };
}
