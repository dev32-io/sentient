import type { ConversationFeedItem } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { MirrorEntry } from "./conversation-mirror.js";

const log = getLog(["sentient", "cerebrum", "conversation-feed"]);

// ---------------------------------------------------------------------------
// Transformer — gateway-internal `MirrorEntry` -> wire `ConversationFeedItem`.
//
// Strips internal plumbing and keeps only what the client needs to render
// chat bubbles + the task sidebar. See `@sentient/protocol/conversation.ts`
// for the wire shape.
//
// Kept as a small pure module so it has ONE responsibility and is trivial
// to test/audit for accidental leaks of internal state into the DTO.
// ---------------------------------------------------------------------------

// Backstop fallback for a feed item whose MirrorEntry.ts is non-numeric /
// non-finite / negative. The protocol requires `ts` to be a non-negative int
// (shared/protocol/src/conversation.ts); a NaN/null here serialises to `null`
// on the wire and crashes strict SDK clients. 0 sorts the entry to the start
// of history. The upstream rehydration path already coerces ts, so a fallback
// firing HERE signals a bug — hence the WARN.
const TS_BACKSTOP = 0;

function safeTs(ts: number, kind: MirrorEntry["kind"]): number {
  if (Number.isInteger(ts) && ts >= 0) return ts;
  log.warn("ts-backstop", {
    reason: "non-negative-int-violated",
    rawTs: Number.isFinite(ts) ? ts : String(ts),
    kind,
    fallback: TS_BACKSTOP,
  });
  return TS_BACKSTOP;
}

export function toFeedItem(entry: MirrorEntry): ConversationFeedItem {
  const ts = safeTs(entry.ts, entry.kind);
  switch (entry.kind) {
    case "user":
      return {
        ts,
        kind: "user",
        channel: entry.channel,
        content: entry.content,
        ...(entry.pendingId !== undefined ? { pendingId: entry.pendingId } : {}),
      };
    case "trigger":
      return {
        ts,
        kind: "trigger",
        source: entry.source,
        summary: entry.summary,
      };
    case "assistant":
      return {
        ts,
        kind: "assistant",
        content: entry.content,
        // Only include wire-protocol cutoff types (barge-in, interrupt).
        // Internal-only types like "length-cap" are filtered out.
        ...(entry.cutoff && entry.cutoff.kind !== "length-cap" ? { cutoff: entry.cutoff } : {}),
      };
    case "tool":
      return {
        ts,
        kind: "tool",
        toolName: entry.toolName,
        status: entry.status,
        summary: entry.summary,
      };
  }
}

export function toFeed(entries: readonly MirrorEntry[]): ConversationFeedItem[] {
  return entries.map(toFeedItem);
}
