import type { ConversationFeedItem, ConversationUserChannel } from "@sentient/protocol";
import type { InFlightMessage, TaskSnapshotItem } from "@sentient/web-sdk";
import type { ChatMessage } from "../types.ts";

// ---------------------------------------------------------------------------
// CycleStatus — coarser UI state derived from cognition + audio + tasks
// ---------------------------------------------------------------------------

export type CycleStatus = "idle" | "streaming" | "speaking" | "awaiting-tasks";

export interface CycleStatusInputs {
  /**
   * Cognition state string. The connector produces "idle" | "thinking" | "acting"
   * but this is kept as string so the pure function remains easy to unit-test
   * with plan-spec labels like "responding" / "planning" (any non-"idle" value
   * maps to streaming).
   */
  cognition: string;
  /**
   * True while the audio playback queue is physically running (chunk-level).
   * Caller is expected to debounce `false` transitions upstream so Fish
   * prosody gaps that briefly drain the WebAudio queue don't strobe the
   * speaking state.
   */
  audioPlaying: boolean;
  /** Number of tasks in non-terminal state. */
  runningTasks: number;
  /**
   * Client-side optimistic flag. True from the moment the user hits Send
   * until the gateway emits cycle.completed for the resulting turn. Covers
   * the network RTT window where cognition is still "idle" server-side but
   * the user already expects interrupt/stop to be available. Claude-Code-
   * style ESC: available the instant you hit Send.
   */
  awaitingResponse?: boolean;
}

/**
 * Maps raw runtime state to a coarse CycleStatus for the UI.
 *
 * Priority order: speaking > streaming > awaiting-tasks > idle.
 *
 * "Speaking" tracks the chunk-level `audioPlaying` flag so the avatar
 * pulse and interrupt button respond to actual audio activity, not the
 * cycle boundary. `audioPlaying` is fed by the playback adapter with a
 * short debounce upstream (use-voice-client.ts) — long enough to bridge
 * Fish prosody gaps, short enough to feel snappy when the stream
 * actually stops.
 */
export function deriveCycleStatus(inputs: CycleStatusInputs): CycleStatus {
  if (inputs.audioPlaying) return "speaking";
  if (inputs.cognition !== "idle" || inputs.awaitingResponse) return "streaming";
  if (inputs.runningTasks > 0) return "awaiting-tasks";
  return "idle";
}

// ---------------------------------------------------------------------------
// attachToolsToAssistantMessages
//
// Groups TaskSnapshotItems onto assistant ChatMessages that share a cycleId.
// Orphaned tasks (no assistant bubble with that cycleId — typical of ReAct
// tool-only cycles that produced no text) are forwarded to the first
// subsequent assistant message that has a cycleId. Tasks with no valid
// continuation bubble are dropped. Preserves message order; sorts attached
// tasks by startedAtMs ascending.
// ---------------------------------------------------------------------------

/**
 * Finds the first assistant message (with a cycleId) that could receive an
 * orphaned task. Iterates `messages` in order, skipping entries before
 * `startedAtMs`. Stops (returns null) upon hitting a user message, which
 * marks a turn boundary the orphan must not cross.
 */
function findOrphanTarget(messages: readonly ChatMessage[], startedAtMs: number): ChatMessage | null {
  for (const msg of messages) {
    if (msg.timestamp < startedAtMs) continue;
    if (msg.role === "user") return null;
    if (msg.role === "assistant" && msg.cycleId !== undefined) return msg;
  }
  return null;
}

export function attachToolsToAssistantMessages(
  messages: readonly ChatMessage[],
  tasks: readonly TaskSnapshotItem[],
): ChatMessage[] {
  if (tasks.length === 0) return messages as ChatMessage[];

  // Index tasks by cycleId for O(n) grouping.
  const tasksByCycleId = new Map<string, TaskSnapshotItem[]>();
  for (const task of tasks) {
    const group = tasksByCycleId.get(task.cycleId) ?? [];
    group.push(task);
    tasksByCycleId.set(task.cycleId, group);
  }

  // Track which cycleIds were matched to a message for orphan detection.
  const matchedCycleIds = new Set<string>();

  const result = messages.map((msg): ChatMessage => {
    if (msg.role !== "assistant" || !msg.cycleId) return msg;
    const group = tasksByCycleId.get(msg.cycleId);
    if (!group || group.length === 0) return msg;
    matchedCycleIds.add(msg.cycleId);
    const sorted = [...group].sort((a, b) => a.startedAtMs - b.startedAtMs);
    return { ...msg, tools: sorted };
  });

  // Orphaned tasks: their cycleId had no text content in that cycle, so no
  // message bubble was created for them. Attach them to the next chronological
  // assistant message (the continuation reply that followed the tool call).
  // This covers ReAct chains where tool-call cycles produce no text.
  const orphanedTasks: TaskSnapshotItem[] = [];
  for (const [cycleId, group] of tasksByCycleId) {
    if (!matchedCycleIds.has(cycleId)) {
      for (const task of group) orphanedTasks.push(task);
    }
  }
  if (orphanedTasks.length === 0) return result;

  // For each orphaned task, find the first subsequent assistant message (in
  // commit order) that has a cycleId and timestamp >= the task's startedAtMs.
  // Stop at the first user message — orphans must not cross a user-turn boundary.
  // Merge orphaned tasks onto that message. Only cycle-tracked messages
  // participate — messages without a cycleId came from cycles we cannot correlate.
  const orphansByTarget = new Map<string, TaskSnapshotItem[]>();
  for (const task of orphanedTasks) {
    const target = findOrphanTarget(result, task.startedAtMs);
    if (!target) continue;
    const group = orphansByTarget.get(target.id) ?? [];
    group.push(task);
    orphansByTarget.set(target.id, group);
  }

  return result.map((msg): ChatMessage => {
    const extras = orphansByTarget.get(msg.id);
    if (!extras || extras.length === 0) return msg;
    const merged = [...(msg.tools ?? []), ...extras].sort((a, b) => a.startedAtMs - b.startedAtMs);
    return { ...msg, tools: merged };
  });
}

// ---------------------------------------------------------------------------
// cycleId preservation — simpler fallback strategy:
// Track the last inflight (timestamp → cycleId). When a committed assistant
// entry arrives within CYCLE_ID_WINDOW_MS of that timestamp, stamp it with
// the inflight's cycleId. Good enough for single-cycle-at-a-time sessions.
// ---------------------------------------------------------------------------

/**
 * Max ms difference between committed assistant entry ts and inflight capture ts.
 *
 * Used to stamp the committed assistant entry with its originating cycleId so
 * the drain-suppression logic can hide the committed entry while the
 * typewriter is still revealing the inflight copy. Too tight → stamping fails
 * and both bubbles briefly co-exist ("phantom double bubble"). Hermes's
 * `response.output_text.done` sits between the last `response.output_text.delta`
 * and `response.completed`, widening the real gap to ~500ms in practice — so
 * 2s gives plenty of margin without risking cross-cycle confusion (lastInflight
 * is always the most recent cycle's id).
 */
export const CYCLE_ID_WINDOW_MS = 2000;

export interface LastInflightStamp {
  ts: number;
  cycleId: string;
}

// ---------------------------------------------------------------------------
// Feed → UI derivation
// ---------------------------------------------------------------------------

function buildUserMessage(
  id: string,
  item: { ts: number; content: string; channel: ConversationUserChannel },
): ChatMessage {
  return {
    id,
    role: "user",
    text: item.content,
    timestamp: item.ts,
    isStreaming: false,
    channel: item.channel,
  };
}

function buildAssistantMessage(
  id: string,
  item: ConversationFeedItem & { kind: "assistant" },
  lastInflight: LastInflightStamp | null,
): ChatMessage {
  const cycleId =
    lastInflight && Math.abs(item.ts - lastInflight.ts) <= CYCLE_ID_WINDOW_MS ? lastInflight.cycleId : undefined;
  return {
    id,
    role: "assistant",
    text: item.content,
    timestamp: item.ts,
    isStreaming: false,
    ...(cycleId ? { cycleId } : {}),
    ...(item.cutoff ? { cutoff: item.cutoff } : {}),
  };
}

/**
 * Stamps cycleId onto committed assistant messages that fall within the
 * CYCLE_ID_WINDOW_MS window of the last known inflight timestamp.
 */
export function stampCycleIdFromLastInflight(
  messages: ChatMessage[],
  lastInflight: LastInflightStamp | null,
): ChatMessage[] {
  if (!lastInflight) return messages;
  return messages.map((msg) => {
    if (msg.role !== "assistant" || msg.cycleId || msg.isStreaming) return msg;
    if (Math.abs(msg.timestamp - lastInflight.ts) > CYCLE_ID_WINDOW_MS) return msg;
    return { ...msg, cycleId: lastInflight.cycleId };
  });
}

function appendCommittedItems(
  out: ChatMessage[],
  items: readonly ConversationFeedItem[],
  lastInflight: LastInflightStamp | null,
  suppressAssistantCycleId?: string,
): void {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const stableId = `feed-${item.ts}-${i}`;

    if (item.kind === "user") {
      if (item.content.length === 0) continue; // barge-in markers don't render
      out.push(buildUserMessage(stableId, item));
      continue;
    }

    if (item.kind === "assistant") {
      if (item.content.length === 0 && !item.cutoff) continue;
      const msg = buildAssistantMessage(stableId, item, lastInflight);
      // While the typewriter is draining a cycle, suppress the committed
      // assistant entry for that cycleId so the inflight (typewriter) bubble
      // stays the sole render until it catches up. Prevents the "chunk pop"
      // from committed text replacing a mid-reveal bubble.
      if (suppressAssistantCycleId && msg.cycleId === suppressAssistantCycleId) continue;
      out.push(msg);
    }
    // "tool" entries ignored — driven by TaskStatusConnector.
    // "trigger" is Phase-2 sensor events, ignored in Phase-1 UI.
  }
}

function appendInflightMessage(out: ChatMessage[], inflight: InFlightMessage | null, visibleOverride?: string): void {
  if (!inflight) return;
  // Phase 1 placeholder: the bubble appears as soon as cycle.started fires,
  // even before the first delta. bubble-text renders a three-dot pulse when
  // text is empty AND isStreaming — so the user has feedback during LLM TTFB.
  const text = visibleOverride ?? inflight.text;
  out.push({
    id: `inflight-${inflight.cycleId}`,
    role: "assistant",
    text,
    timestamp: Date.now(),
    isStreaming: true,
    cycleId: inflight.cycleId,
  });
}

/**
 * Derives the full chat message list from committed history + inflight.
 * Does NOT attach tools — call `attachToolsToAssistantMessages` after.
 *
 * `visibleOverride` substitutes the inflight bubble's text with the typewriter's
 * partial reveal. `suppressAssistantCycleId` hides the committed assistant entry
 * for a cycle that is still mid-drain — keeping the typewriter bubble onscreen
 * until it catches up, instead of letting the committed full-text bubble pop in.
 */
export function deriveMessages(
  items: readonly ConversationFeedItem[],
  inflight: InFlightMessage | null,
  lastInflight: LastInflightStamp | null,
  visibleOverride?: string,
  suppressAssistantCycleId?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  appendCommittedItems(messages, items, lastInflight, suppressAssistantCycleId);
  appendInflightMessage(messages, inflight, visibleOverride);
  return messages;
}
