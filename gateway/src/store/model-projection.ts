// Model projection (spec §3.2, §3.4) — entries → OpenAI chat messages.
//
// Rules earned the hard way (see the pre-Hermes archive):
//  1. The tool round-trip must be COMPLETE. The assistant message carries
//     `tool_calls`; each result rides as a separate role:"tool" message with a
//     matching tool_call_id. Break this and the model never sees its own tool
//     result and re-issues the same call.
//  2. After compaction we replay from the last compaction entry forward.
//  3. The provider rejects orphans in BOTH directions, so this function emits
//     ONLY matched pairs: a role:"tool" with no parent is dropped, and a
//     tool_call with no reply (abort mid-call, suppressed call, truncation) is
//     dropped from the tool_calls array. Being a pure function, this is the one
//     place the invariant can be enforced without any caller remembering to.

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

export function projectForModel(entries: SessionEntry[]): ChatMessage[] {
  const { head, rest } = sliceFromLatestCompaction(entries);

  // Pass 1: within THIS slice, find which tool_calls actually have a reply and
  // which replies actually have a parent. Only two-way-matched ids are emitted.
  const callIdsInSlice = new Set<string>();
  const resultIdsInSlice = new Set<string>();
  for (const entry of rest) {
    if (entry.kind === "tool_call" && entry.toolCallId && entry.toolName) {
      callIdsInSlice.add(entry.toolCallId);
    } else if (entry.kind === "tool_result" && entry.toolCallId) {
      resultIdsInSlice.add(entry.toolCallId);
    }
  }
  const pairedIds = new Set([...callIdsInSlice].filter((id) => resultIdsInSlice.has(id)));

  const droppedCalls = [...callIdsInSlice].filter((id) => !pairedIds.has(id));
  const droppedResults = [...resultIdsInSlice].filter((id) => !pairedIds.has(id));
  if (droppedCalls.length > 0) {
    log.debug("projection.dropped-unreplied-tool-calls", { toolCallIds: droppedCalls });
  }
  if (droppedResults.length > 0) {
    log.debug("projection.dropped-parentless-tool-results", { toolCallIds: droppedResults });
  }

  // Pass 2: emit, skipping anything unpaired.
  const messages: ChatMessage[] = [...head];
  let pendingCalls: ChatToolCall[] = [];

  const flushPendingCalls = (): void => {
    if (pendingCalls.length === 0) return;
    messages.push({ role: "assistant", content: null, tool_calls: pendingCalls });
    pendingCalls = [];
  };

  for (const entry of rest) {
    if (entry.kind === "tool_call") {
      if (entry.toolCallId && entry.toolName && pairedIds.has(entry.toolCallId)) {
        pendingCalls.push({
          id: entry.toolCallId,
          type: "function",
          function: { name: entry.toolName, arguments: entry.toolArgs ?? "{}" },
        });
      }
      continue;
    }

    flushPendingCalls();

    if (entry.kind === "tool_result") {
      if (!entry.toolCallId || !pairedIds.has(entry.toolCallId)) continue;
      messages.push({
        role: "tool",
        tool_call_id: entry.toolCallId,
        content: entry.toolArgs ?? "",
      });
      continue;
    }

    if (entry.kind === "user" || entry.kind === "trigger") {
      messages.push({ role: "user", content: entry.text ?? "" });
      continue;
    }
    if (entry.kind === "assistant") {
      messages.push({ role: "assistant", content: entry.text ?? "" });
      continue;
    }
    if (entry.kind === "system" || entry.kind === "compaction") {
      messages.push({ role: "system", content: entry.text ?? "" });
    }
  }

  flushPendingCalls();
  return messages;
}
