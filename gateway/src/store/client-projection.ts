// Client projection (spec §3.2, §3.4) — entries → renderable feed items.
//
// Renders the FULL history: compaction shrinks what the MODEL replays, never
// what the user sees. A tool_call and its tool_result fold into one tile.
//
// This function is the ONLY path from stored state to client feed, for both
// live commits and replay — that single-path property is what makes the
// convergence contract (projection-convergence.test.ts) hold.

import type { CutoffKind, SessionEntry } from "./entry-types.js";

export type FeedItemKind = "user" | "assistant" | "tool" | "notice";

export interface FeedItem {
  /** Stable identity for the item — the seq of the entry that created it. */
  id: string;
  kind: FeedItemKind;
  text: string;
  toolName: string | null;
  cutoff: CutoffKind | null;
  createdAt: number;
}

export function projectForClient(entries: SessionEntry[]): FeedItem[] {
  const items: FeedItem[] = [];
  const toolItemIndexByCallId = new Map<string, number>();

  for (const entry of entries) {
    if (entry.kind === "system" || entry.kind === "compaction") continue;

    if (entry.kind === "tool_call") {
      if (!entry.toolCallId) continue;
      toolItemIndexByCallId.set(entry.toolCallId, items.length);
      items.push({
        id: String(entry.seq),
        kind: "tool",
        text: "",
        toolName: entry.toolName,
        cutoff: null,
        createdAt: entry.createdAt,
      });
      continue;
    }

    if (entry.kind === "tool_result") {
      // Fold into the existing tile so replay cannot produce an extra one.
      const idx = entry.toolCallId ? toolItemIndexByCallId.get(entry.toolCallId) : undefined;
      if (idx === undefined) continue;
      const existing = items[idx];
      if (existing) items[idx] = { ...existing, text: entry.toolArgs ?? "" };
      continue;
    }

    items.push({
      id: String(entry.seq),
      kind: entry.kind === "assistant" ? "assistant" : "user",
      text: entry.text ?? "",
      toolName: null,
      cutoff: entry.cutoff,
      createdAt: entry.createdAt,
    });
  }

  return items;
}
