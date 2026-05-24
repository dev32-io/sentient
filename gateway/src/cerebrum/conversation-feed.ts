import type { ConversationFeedItem } from "@sentient/protocol";
import type { MirrorEntry } from "./conversation-mirror.js";

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

export function toFeedItem(entry: MirrorEntry): ConversationFeedItem {
  switch (entry.kind) {
    case "user":
      return {
        ts: entry.ts,
        kind: "user",
        channel: entry.channel,
        content: entry.content,
      };
    case "trigger":
      return {
        ts: entry.ts,
        kind: "trigger",
        source: entry.source,
        summary: entry.summary,
      };
    case "assistant":
      return {
        ts: entry.ts,
        kind: "assistant",
        content: entry.content,
        // Only include wire-protocol cutoff types (barge-in, interrupt).
        // Internal-only types like "length-cap" are filtered out.
        ...(entry.cutoff && entry.cutoff.kind !== "length-cap" ? { cutoff: entry.cutoff } : {}),
      };
    case "tool":
      return {
        ts: entry.ts,
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
