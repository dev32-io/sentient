// Client projection (spec §3.2, §3.4) — entries → renderable feed items.
//
// Renders the FULL history: compaction shrinks what the MODEL replays, never
// what the user sees. A tool_call and its tool_result fold into one tile.
//
// This function is the ONLY path from stored state to client feed, for both
// live commits and replay — that single-path property is what makes the
// convergence contract (projection-convergence.test.ts) hold.

import { getLog } from "../logging/logger.js";
import type { CutoffKind, SessionEntry } from "./entry-types.js";

const log = getLog(["sentient", "store", "client-projection"]);

export type FeedItemKind = "user" | "trigger" | "assistant" | "tool";

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
      if (!entry.toolCallId) {
        log.warn("projection.dropped-malformed-tool-call", {
          reason: "malformed-tool-call",
          seq: entry.seq,
        });
        continue;
      }
      if (toolItemIndexByCallId.has(entry.toolCallId)) {
        // First tile wins; a repeat call id would otherwise overwrite the
        // index and orphan the first tile's result fold.
        log.warn("projection.dropped-duplicate-tool-call", {
          reason: "duplicate-tool-call-id",
          toolCallId: entry.toolCallId,
          seq: entry.seq,
        });
        continue;
      }
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
      // Anchoring rule: the tile keeps the POSITION and createdAt of its
      // tool_call — a late-arriving result folds BACKWARD into that
      // original slot rather than appending a new tile at its own position.
      // This is what makes convergence hold regardless of how much later
      // the result lands relative to the call.
      const idx = entry.toolCallId ? toolItemIndexByCallId.get(entry.toolCallId) : undefined;
      if (idx === undefined) {
        log.warn("projection.dropped-tool-result-without-tile", {
          reason: "tool-result-without-tile",
          toolCallId: entry.toolCallId,
          seq: entry.seq,
        });
        continue;
      }
      const existing = items[idx];
      if (existing) items[idx] = { ...existing, text: entry.toolArgs ?? "" };
      continue;
    }

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

    items.push({
      id: String(entry.seq),
      kind,
      text: entry.text ?? "",
      toolName: null,
      cutoff: entry.cutoff,
      createdAt: entry.createdAt,
    });
  }

  return items;
}
