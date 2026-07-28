import type { ConversationUserChannel } from "@sentient/protocol";
import type { CommittedFeedItem, InFlightMessage, ToolCallSnapshotItem } from "@sentient/web-sdk";
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
   * Caller is expected to debounce `false` transitions upstream so TTS
   * prosody gaps that briefly drain the WebAudio queue don't strobe the
   * speaking state.
   */
  audioPlaying: boolean;
  /** Number of tasks in non-terminal state. */
  runningTasks: number;
  /**
   * Client-side optimistic flag. True from the moment the user hits Send
   * until the gateway emits turn.completed for the resulting turn. Covers
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
 * turn boundary. `audioPlaying` is fed by the playback adapter with a
 * short debounce upstream (use-voice-client.ts) — long enough to bridge
 * TTS prosody gaps, short enough to feel snappy when the stream
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
// Groups ToolCallSnapshotItems onto assistant ChatMessages that share a turnId.
// Orphaned tool calls (no assistant bubble with that turnId — typical of ReAct
// turns whose tool round-trips produced no text) are forwarded to the first
// subsequent assistant message that has a turnId. Tool calls with no valid
// continuation bubble are dropped. Preserves message order; sorts attached
// tool calls by startedAtMs ascending.
// ---------------------------------------------------------------------------

/**
 * Finds the first assistant message (with a turnId) that could receive an
 * orphaned tool call. Iterates `messages` in order, skipping entries before
 * `startedAtMs`. Stops (returns null) upon hitting a user message, which
 * marks a turn boundary the orphan must not cross.
 */
function findOrphanTarget(messages: readonly ChatMessage[], startedAtMs: number): ChatMessage | null {
  for (const msg of messages) {
    if (msg.timestamp < startedAtMs) continue;
    if (msg.role === "user") return null;
    if (msg.role === "assistant" && msg.turnId !== undefined) return msg;
  }
  return null;
}

export function attachToolsToAssistantMessages(
  messages: readonly ChatMessage[],
  tasks: readonly ToolCallSnapshotItem[],
): ChatMessage[] {
  if (tasks.length === 0) return messages as ChatMessage[];

  // Index tool calls by turnId for O(n) grouping.
  const tasksByTurnId = new Map<string, ToolCallSnapshotItem[]>();
  for (const task of tasks) {
    const group = tasksByTurnId.get(task.turnId) ?? [];
    group.push(task);
    tasksByTurnId.set(task.turnId, group);
  }

  // Track which turnIds were matched to a message for orphan detection.
  const matchedTurnIds = new Set<string>();

  const result = messages.map((msg): ChatMessage => {
    if (msg.role !== "assistant" || !msg.turnId) return msg;
    const group = tasksByTurnId.get(msg.turnId);
    if (!group || group.length === 0) return msg;
    matchedTurnIds.add(msg.turnId);
    const sorted = [...group].sort((a, b) => a.startedAtMs - b.startedAtMs);
    return { ...msg, tools: sorted };
  });

  // Orphaned tool calls: their turnId produced no text content, so no message
  // bubble was created for them. Attach them to the next chronological
  // assistant message (the continuation reply that followed the tool call).
  // This covers ReAct chains where a turn's tool round-trips produce no text.
  const orphanedTasks: ToolCallSnapshotItem[] = [];
  for (const [turnId, group] of tasksByTurnId) {
    if (!matchedTurnIds.has(turnId)) {
      for (const task of group) orphanedTasks.push(task);
    }
  }
  if (orphanedTasks.length === 0) return result;

  // For each orphaned tool call, find the first subsequent assistant message
  // (in commit order) that has a turnId and timestamp >= its startedAtMs.
  // Stop at the first user message — orphans must not cross a user-turn boundary.
  // Merge orphaned tool calls onto that message. Only turn-tracked messages
  // participate — messages without a turnId came from turns we cannot correlate.
  const orphansByTarget = new Map<string, ToolCallSnapshotItem[]>();
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

function buildAssistantMessage(id: string, item: CommittedFeedItem & { kind: "assistant" }): ChatMessage {
  return {
    id,
    role: "assistant",
    text: item.content,
    timestamp: item.ts,
    isStreaming: false,
    // turnId is the gateway-owned join key carried on the conversation.entry
    // frame (CommittedFeedItem) — read straight through, never invented client-side.
    ...(item.turnId ? { turnId: item.turnId } : {}),
    ...(item.cutoff ? { cutoff: item.cutoff } : {}),
  };
}

function appendCommittedItems(
  out: ChatMessage[],
  items: readonly CommittedFeedItem[],
  suppressAssistantTurnId?: string,
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
      const msg = buildAssistantMessage(stableId, item);
      // While the typewriter is draining a turn, suppress the committed
      // assistant entry for that turnId so the inflight (typewriter) bubble
      // stays the sole render until it catches up. Prevents the "chunk pop"
      // from committed text replacing a mid-reveal bubble.
      if (suppressAssistantTurnId && msg.turnId === suppressAssistantTurnId) continue;
      out.push(msg);
    }
    // "tool" entries ignored — driven by ToolStatusConnector.
    // "trigger" is Phase-2 sensor events, ignored in Phase-1 UI.
  }
}

/**
 * Renders ONE streaming bubble per in-flight turn (spec §7.2). The SDK's
 * `InFlightMessageConnector.list()` is a list, not a single slot, so a
 * self-initiated follow-up turn never clobbers a still-open bubble.
 *
 * `visibleOverride` is the typewriter's partial reveal and applies to the
 * NEWEST bubble only — the typewriter tracks exactly one turn (the one
 * currently producing tokens); anything older already has its full text.
 */
function appendInflightMessages(
  out: ChatMessage[],
  inflight: readonly InFlightMessage[],
  visibleOverride?: string,
): void {
  for (let i = 0; i < inflight.length; i++) {
    const entry = inflight[i];
    if (!entry) continue;
    const isNewest = i === inflight.length - 1;
    // Placeholder: the bubble appears as soon as turn.started fires, even
    // before the first delta. bubble-text renders a three-dot pulse when text
    // is empty AND isStreaming — so the user has feedback during LLM TTFB.
    const text = isNewest && visibleOverride !== undefined ? visibleOverride : entry.text;
    out.push({
      id: `inflight-${entry.turnId}`,
      role: "assistant",
      text,
      timestamp: Date.now(),
      isStreaming: true,
      turnId: entry.turnId,
    });
  }
}

/**
 * Derives the full chat message list from committed history + inflight turns.
 * Does NOT attach tools — call `attachToolsToAssistantMessages` after.
 *
 * `visibleOverride` substitutes the newest inflight bubble's text with the
 * typewriter's partial reveal. `suppressAssistantTurnId` hides the committed
 * assistant entry for a turn that is still mid-drain — keeping the typewriter
 * bubble onscreen until it catches up, instead of letting the committed
 * full-text bubble pop in. The committed entry's turnId is the gateway-owned
 * one off its frame.
 */
export function deriveMessages(
  items: readonly CommittedFeedItem[],
  inflight: readonly InFlightMessage[],
  visibleOverride?: string,
  suppressAssistantTurnId?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  appendCommittedItems(messages, items, suppressAssistantTurnId);
  appendInflightMessages(messages, inflight, visibleOverride);
  return messages;
}
