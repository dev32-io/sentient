// Client projection (spec §3.2, §3.4) — entries → renderable feed items.
//
// Renders the FULL history: compaction shrinks what the MODEL replays, never
// what the user sees. Every assistant stretch of ONE reply folds into one
// bubble.
//
// This function is the ONLY path from stored state to client feed, for both
// live commits and replay — that single-path property is what makes the
// convergence contract (projection-convergence.test.ts) hold.

import { getLog } from "../logging/logger.js";
import type { CutoffKind, SessionEntry } from "./entry-types.js";
import { unscopePendingId } from "./pending-id-scope.js";

const log = getLog(["sentient", "store", "client-projection"]);

export type FeedItemKind = "user" | "trigger" | "assistant";

export interface FeedItem {
  /** Stable identity for the item — the seq of the entry that created it, or,
   *  on an assistant item, the `replyId` the whole reply folds under. */
  id: string;
  kind: FeedItemKind;
  text: string;
  cutoff: CutoffKind | null;
  createdAt: number;
  /** The client's own id for this message, on a `user` item that arrived with
   *  one. Carried through so the committed echo can settle the client's
   *  optimistic bubble — on the live entry AND on every later snapshot, which
   *  is what keeps `render(replay) == render(live)` true of it. */
  pendingId: string | null;
  /** The reply this item belongs to; null on user/trigger items. */
  replyId: string | null;
}

export function projectForClient(entries: readonly SessionEntry[]): FeedItem[] {
  const items: FeedItem[] = [];
  const replyItemIndexByReplyId = new Map<string, number>();

  for (const entry of entries) {
    // Tool entries are the MODEL's record of what it called, replayed to it by
    // the model projection. They are not user-facing artifacts: live tool
    // activity is the composer task strip (runtime/task-list.ts), which is
    // ephemeral by design. Keeping them here is what forced a tile to anchor to
    // a bubble, and that anchor is what broke once a steer could split a reply.
    if (entry.kind === "system" || entry.kind === "compaction") continue;
    if (entry.kind === "tool_call" || entry.kind === "tool_result") continue;

    let kind: "user" | "trigger" | "assistant";
    switch (entry.kind) {
      case "user":
        kind = "user";
        break;
      case "trigger":
        kind = "trigger";
        break;
      case "assistant":
        kind = "assistant";
        break;
      default:
        // Unrecognized kind. The store's read path casts `row.kind` with no
        // runtime validation (session-store.ts), so a foreign/corrupt row
        // can reach here. Never render it as an attributed user message.
        log.warn("projection.unknown-entry-kind", { kind: entry.kind, seq: entry.seq });
        continue;
    }

    // ONE REPLY, ONE ITEM. The store records a reply as several entries — a
    // ReAct turn narrates, calls a tool, then answers, and each stretch is its
    // own row so the MODEL projection can interleave them with the tool calls
    // in dispatch order. The person saw one bubble that grew. Folding here, at
    // the single path from stored state to a feed item, is what makes the
    // committed feed agree with the live stream instead of asking three
    // clients to re-derive the grouping and disagree about it.
    //
    // Keyed by `replyId`, NOT by adjacency: the stretches of one reply are not
    // adjacent in the store — the tool_call and tool_result entries that
    // separated them are still there, they simply no longer render. The key is
    // safe because the gateway ROTATES the id the moment a rendered row breaks
    // the bubble — a message the person sends mid-turn (session-runtime.ts) —
    // so two stretches sharing an id are, by construction, one bubble.
    //
    // ANCHORING: a later stretch folds BACKWARD into the first stretch's slot,
    // keeping its position and createdAt, which is what makes a replay agree
    // with what the live stream showed regardless of what landed between the
    // stretches.
    if (kind === "assistant" && entry.replyId !== null) {
      const foldIndex = replyItemIndexByReplyId.get(entry.replyId);
      const previous = foldIndex === undefined ? undefined : items[foldIndex];
      if (foldIndex !== undefined && previous !== undefined) {
        items[foldIndex] = {
          ...previous,
          text: previous.text + (entry.text ?? ""),
          // A cutoff is stamped on the FINAL partial of a cut-off reply, so the
          // last stretch that carries one wins.
          cutoff: entry.cutoff ?? previous.cutoff,
        };
        continue;
      }
      replyItemIndexByReplyId.set(entry.replyId, items.length);
    }

    items.push({
      // A reply's identity is its replyId, not the seq of whichever stretch
      // happened to be first: a window that attaches mid-turn projects the
      // reply so far, and the same reply must keep the same id when it grows,
      // or the client's dedupe-by-entryId appends a second bubble.
      id: kind === "assistant" && entry.replyId !== null ? entry.replyId : String(entry.seq),
      kind,
      text: entry.text ?? "",
      cutoff: entry.cutoff,
      createdAt: entry.createdAt,
      // The CLIENT's own value, not the store key. `pending_id` is namespaced
      // by issuing surface so two windows cannot dedup each other's message
      // away (spec §3.8, pending-id-scope.ts); the client reconciles its
      // optimistic bubble against what it SENT, so the namespace is stripped
      // here — at the single path from stored state to a feed item, which is
      // what keeps the live entry and every later snapshot saying the same
      // thing.
      pendingId: entry.pendingId === null ? null : unscopePendingId(entry.pendingId),
      replyId: entry.replyId,
    });
  }

  return items;
}
