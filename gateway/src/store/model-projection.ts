// Model projection (spec §3.2, §3.4) — entries → OpenAI chat messages.
//
// Rules earned the hard way (see the pre-Hermes archive):
//  1. The tool round-trip must be COMPLETE. The assistant message carries
//     `tool_calls`; each result rides as a separate role:"tool" message with a
//     matching tool_call_id. Break this and the model never sees its own tool
//     result and re-issues the same call.
//  2. After compaction we replay from the last compaction entry forward.
//  3. OpenAI requires role:"tool" messages to immediately follow the assistant
//     message that declared them, and every id declared in one run to be
//     answered by that SAME run. Set-membership pairing (any call id in the
//     slice intersected with any result id in the slice) is not enough — it
//     lets a tool_result that arrived out of position (before its call, or
//     separated from it by an intervening user/assistant/system entry) pair
//     with a call it doesn't structurally follow, producing a message array
//     the provider 400s on. This function pairs by BLOCK ADJACENCY instead: a
//     run of tool_call entries is paired only with the immediately-following
//     run of tool_result entries. Anything unmatched in either direction is
//     dropped and logged — a dropped-but-computed result is real context
//     loss, so it must never be silent.

import { getLog } from "../logging/logger.js";
import type { SessionEntry } from "./entry-types.js";

const log = getLog(["sentient", "store", "model-projection"]);

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

/** Slice from the latest compaction entry forward; that entry becomes a system summary. */
function sliceFromLatestCompaction(entries: SessionEntry[]): {
  head: ChatMessage[];
  rest: SessionEntry[];
} {
  let lastCompactionIdx = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.kind === "compaction") {
      lastCompactionIdx = i;
      break;
    }
  }
  if (lastCompactionIdx === -1) return { head: [], rest: entries };

  const marker = entries[lastCompactionIdx];
  log.debug("projection.compacted", {
    compactedThroughSeq: marker?.compactedThroughSeq ?? null,
    droppedEntries: lastCompactionIdx + 1,
  });
  return {
    head: [{ role: "system", content: marker?.text ?? "" }],
    rest: entries.slice(lastCompactionIdx + 1),
  };
}

/**
 * Pairs one run of tool_call entries with the immediately-following run of
 * tool_result entries and pushes the resulting assistant + tool messages.
 * A call with no reply in this run, or a result with no matching call in
 * this run, is dropped (and logged) rather than emitted out of position.
 */
function emitToolBlock(messages: ChatMessage[], callEntries: SessionEntry[], resultEntries: SessionEntry[]): void {
  const resultById = new Map<string, SessionEntry>();
  for (const r of resultEntries) {
    if (r.toolCallId && !resultById.has(r.toolCallId)) resultById.set(r.toolCallId, r); // first wins
  }

  const seen = new Set<string>();
  const toolCalls: ChatToolCall[] = [];
  const droppedCallIds: string[] = [];
  for (const c of callEntries) {
    const id = c.toolCallId;
    if (!id || !c.toolName || seen.has(id)) continue; // malformed entry or duplicate id; first wins
    seen.add(id);
    if (!resultById.has(id)) {
      droppedCallIds.push(id);
      continue;
    }
    toolCalls.push({ id, type: "function", function: { name: c.toolName, arguments: c.toolArgs ?? "{}" } });
  }
  const droppedResultIds = [...resultById.keys()].filter((id) => !seen.has(id));

  if (droppedCallIds.length > 0) {
    log.warn("projection.dropped-unreplied-tool-calls", {
      reason: "unreplied-in-block",
      toolCallIds: droppedCallIds,
    });
  }
  if (droppedResultIds.length > 0) {
    log.warn("projection.dropped-parentless-tool-results", {
      reason: "no-parent-in-block",
      toolCallIds: droppedResultIds,
    });
  }

  if (toolCalls.length === 0) return; // never emit an empty tool_calls array
  messages.push({ role: "assistant", content: null, tool_calls: toolCalls });
  for (const tc of toolCalls) {
    messages.push({ role: "tool", tool_call_id: tc.id, content: resultById.get(tc.id)?.toolArgs ?? "" });
  }
}

export function projectForModel(entries: SessionEntry[]): ChatMessage[] {
  const { head, rest } = sliceFromLatestCompaction(entries);
  const messages: ChatMessage[] = [...head];

  let i = 0;
  while (i < rest.length) {
    const entry = rest[i];
    if (!entry) {
      i += 1;
      continue;
    }

    if (entry.kind === "tool_call") {
      const callStart = i;
      while (rest[i]?.kind === "tool_call") i += 1;
      const resultStart = i;
      while (rest[i]?.kind === "tool_result") i += 1;
      emitToolBlock(messages, rest.slice(callStart, resultStart), rest.slice(resultStart, i));
      continue;
    }

    if (entry.kind === "tool_result") {
      // Not immediately preceded by its call block (arrived early, or
      // separated by an intervening entry) — pairing it here would put the
      // tool message out of position. Drop it; the caller already has the
      // computed result on record elsewhere, but the model never sees it.
      log.warn("projection.dropped-parentless-tool-results", {
        reason: "no-parent-in-block",
        toolCallIds: entry.toolCallId ? [entry.toolCallId] : [],
      });
      i += 1;
      continue;
    }

    if (entry.kind === "user" || entry.kind === "trigger") {
      messages.push({ role: "user", content: entry.text ?? "" });
      i += 1;
      continue;
    }
    if (entry.kind === "assistant") {
      messages.push({ role: "assistant", content: entry.text ?? "" });
      i += 1;
      continue;
    }
    if (entry.kind === "system") {
      messages.push({ role: "system", content: entry.text ?? "" });
      i += 1;
      continue;
    }

    // Unrecognized kind. The store's read path casts `row.kind` with no
    // runtime validation (session-store.ts), so a foreign/corrupt row can
    // reach here. Never drop it silently.
    log.warn("projection.unknown-entry-kind", { kind: entry.kind, seq: entry.seq });
    i += 1;
  }

  return messages;
}
