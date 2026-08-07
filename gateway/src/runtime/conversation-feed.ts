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
// permanently stale one. ONE rule follows, and it is now the only hold-back
// this module has:
//
//   - An assistant item for the OPEN reply is not content-final: the
//     projection folds every stretch of one reply into one item, and the loop
//     may still append another stretch to it. It is held back until the turn
//     ends or a steer rotates the reply id — which is exactly when the reply
//     stops growing.
//   - A held-back item blocks everything after it. A stimulus landing mid-turn
//     (the steer path, §4.5) would otherwise be published ahead of the reply it
//     interrupted and diverge from every later snapshot.
//
// So each publish emits the longest PREFIX of not-yet-published items that is
// content-final, and stops. `publishAll` releases the rest at a turn boundary —
// `force` means exactly that and nothing else: release the still-open reply
// because the turn it belonged to is over.
//
// The tool half of this used to live here too: a tile was held until its
// `tool_result` folded in. Tool items no longer reach the client feed at all
// (store/client-projection.ts) — live tool activity is the composer task strip,
// which is ephemeral — so the tool hold-back, its unresolved-call bookkeeping,
// and the "cancelled" status a force-released tile carried are all gone.

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
  /** Publish everything outstanding, including the reply that was still open.
   *  Called at every turn boundary — which is precisely when "still open" stops
   *  being true. */
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
  /** The replyId the runtime is currently writing into, or null when no turn
   *  is in flight. An item carrying it is still GROWING and must not publish:
   *  the client appends `conversation.entry` to its mirror, so an item emitted
   *  before its content settles is a permanently stale bubble. */
  readonly currentReplyId: () => string | null;
}

function toWireCutoff(cutoff: CutoffKind): ConversationAssistantCutoff {
  // `cancelledTaskIds` is required by the frame and is ALWAYS empty now:
  // an interrupt cancels the turn and nothing else — a background task
  // outlives it, and nothing anywhere cancels one (tools/delegate-task.ts).
  // Empty is the accurate value, not a placeholder.
  return cutoff === "interrupt" ? { kind: "interrupt", cancelledTaskIds: [] } : { kind: "barge-in" };
}

function toWireItem(item: FeedItem): ConversationFeedItem {
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
        ...(item.replyId === null ? {} : { replyId: item.replyId }),
        ...(item.cutoff === null ? {} : { cutoff: toWireCutoff(item.cutoff) }),
      };
  }
}

function lastSeqOf(entries: readonly SessionEntry[], fallback: number): number {
  return entries[entries.length - 1]?.seq ?? fallback;
}

/** The seq the cursor must park just below to re-read [item] next publish.
 *  A folded assistant item's id is its replyId, so its seq is the FIRST entry
 *  of the fold — parking below that is what makes the next publish see the
 *  whole reply again rather than only its tail. */
function firstSeqOf(entries: readonly SessionEntry[], item: FeedItem): number {
  if (item.replyId !== null) {
    for (const e of entries) if (e.replyId === item.replyId) return e.seq;
  }
  return Number(item.id);
}

/**
 * Is [item]'s content still going to change?
 *
 * THE ONE PLACE THE QUESTION IS ASKED. Both cursor writers consult it —
 * `publish()` parks just below the first item that answers yes, `snapshot()`
 * re-arms to the same boundary. Asking it in two places is how they drift, and
 * a drifted cursor silently drops an item out of every attached window's feed
 * for good.
 */
function isStillGrowing(item: FeedItem, openReplyId: string | null): boolean {
  return openReplyId !== null && item.replyId === openReplyId;
}

/** The seq of the first not-yet-final item in [entries], or null when every one
 *  of them has settled. The cursor parks one below it.
 *
 *  [entries] must be the PENDING window (everything above the cursor), never
 *  the whole session — the answer is a seq to rewind the cursor TO, and asking
 *  it of the full history would rewind across the whole conversation. */
function heldBackFromSeq(entries: readonly SessionEntry[], openReplyId: string | null): number | null {
  for (const item of projectForClient(entries)) {
    if (isStillGrowing(item, openReplyId)) return firstSeqOf(entries, item);
  }
  return null;
}

/**
 * Project committed entries into the EXACT wire shape the live path emits on
 * `conversation.snapshot` — `projectForClient` plus the same per-item
 * `toWireItem` mapping `snapshot()` below uses.
 *
 * Exported so `api/handlers/sessions.ts` (`GET /sessions/:id/messages`) can
 * reuse it rather than re-deriving the shape: `render(replay) == render(live)`
 * is a protocol contract, and two hand-written projections is how it drifts.
 */
export function snapshotFeedItems(entries: readonly SessionEntry[]): ConversationFeedItem[] {
  return projectForClient(entries).map(toWireItem);
}

export function createConversationFeed(deps: ConversationFeedDeps): ConversationFeed {
  const { store, sessionId, userId, emitter, currentReplyId } = deps;

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
    // A TAIL read, not the whole session: the held-back reply's first stretch
    // is always inside the window (the cursor never advances past it), so the
    // whole reply still folds into one item.
    // store/projection-convergence.test.ts pins that a tail projects the same
    // ids as a full replay.
    const tail = store.readSince(sessionId, publishedThroughSeq);
    if (tail.length === 0) return;

    // Keyed by FEED-ITEM id, not by seq: a folded assistant item is named by
    // its replyId, and every stretch of one reply belongs to one turn anyway.
    const turnIdByItemId = new Map<string, string>();
    for (const e of tail) {
      turnIdByItemId.set(String(e.seq), e.turnId);
      if (e.replyId !== null) turnIdByItemId.set(e.replyId, e.turnId);
    }

    // The OPEN reply — the one the loop is still writing into — is the only
    // thing held back: its text is not final until the turn ends or a steer
    // rotates the id. `force` (a turn boundary) lifts it.
    const openReplyId = force ? null : currentReplyId();

    let published = 0;
    let heldBackAtSeq: number | null = null;
    for (const item of projectForClient(tail)) {
      if (isStillGrowing(item, openReplyId)) {
        heldBackAtSeq = firstSeqOf(tail, item);
        break;
      }
      // The reply id travels with the turn key: a committed entry and the live
      // bubble it replaces must group by the SAME value, or the swap at turn
      // end shows a different set of rows than the stream did.
      emitter.conversationEntry(toWireItem(item), turnIdByItemId.get(item.id), item.replyId ?? undefined);
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
      // Re-armed at the tail — but NEVER above an item that is still growing.
      // A snapshot is written to the ONE window that just attached, while the
      // cursor is shared by every window on this session: parking it past the
      // still-open reply would drop that item out of every OTHER window's feed
      // for good, and would later emit a reply's own id carrying nothing but
      // its tail.
      // Parking just below it costs the joiner one re-send of an item it
      // already has under the same id.
      //
      // Asked of the PENDING window only, exactly as `publish` asks it — see
      // `heldBackFromSeq` for why the full history is the wrong question.
      const pending = entries.filter((e) => e.seq > publishedThroughSeq);
      const heldFrom = heldBackFromSeq(pending, currentReplyId());
      publishedThroughSeq = heldFrom === null ? lastSeqOf(entries, publishedThroughSeq) : heldFrom - 1;
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
      emitter.conversationEntry(toWireItem(item), entry.turnId, entry.replyId ?? undefined);
      log.info("conversation-feed.republished", { userId, sessionId, seq: entry.seq, turnId: entry.turnId });
    },
  };
}
