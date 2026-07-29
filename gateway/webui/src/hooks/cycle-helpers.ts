import type { ConversationToolStatus, ConversationUserChannel, TurnToolStatus } from "@sentient/protocol";
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
// Tool tiles — two sources, one rendered strip
//
// A tool call reaches this client TWICE: live as `turn.tool.update`
// (ToolStatusConnector) while it runs, and committed as a `kind:"tool"`
// conversation feed item once the gateway settles it. Only the committed one
// survives a reload, so a feed rebuilt from `conversation.snapshot` must
// render tiles too — otherwise `render(replay) == render(live)` (spec §3.2
// Invariant B) holds on the wire and fails at the rendered layer, which is the
// layer the reload-convergence E2E oracle reads.
//
// The two frames share NO tool-call id: the committed item's only id is its
// `entryId` (the store seq — the wire deliberately strips tool plumbing from
// the ITEM, see shared/protocol/src/conversation.ts), while the live frame
// carries the provider's `toolCallId`. What they DO share is `turnId`
// (frame-level on `conversation.entry`, item-level on `turn.tool.update`) and
// the gateway's dispatch order. So the join is per turn: a turn's committed
// tiles are its first N calls, and the live list's tail beyond N is the calls
// not yet committed. At every turn boundary the gateway publishes all
// outstanding tiles (conversation-feed.publishAll), so that tail empties and
// the rendered strip converges exactly on what a reload would show.
//
// Placement is feed order for both sources: a tile anchors to the assistant
// bubble that FOLLOWS it (the reply its result fed), and never crosses the
// next user entry.
// ---------------------------------------------------------------------------

/** Committed tool entries speak the feed's status union; the live tool frame
 *  speaks the loop's. Map committed → live so a replayed tile renders with the
 *  same pill styling as the live tile it stands in for. `cancelled` is the
 *  feed's word for "no tool_result was ever committed" (the turn ended first,
 *  or it was a background dispatch that settles later as its own trigger
 *  entry) — the live tile for exactly those calls is still "running". */
const COMMITTED_TOOL_STATUS: Record<ConversationToolStatus, TurnToolStatus> = {
  finished: "done",
  failed: "error",
  cancelled: "running",
};

/** Turn id used for a committed tile that arrived without one — every
 *  `conversation.snapshot` item, since the turnId rides the `conversation.entry`
 *  FRAME. It can never collide with a live tile's turnId, which is why a
 *  reloaded feed's tiles are always kept. */
const NO_TURN_ID = "";

function toCommittedTile(item: CommittedFeedItem & { kind: "tool" }): ToolCallSnapshotItem {
  return {
    // The gateway-owned entryId IS the tile identity — stable across the live
    // entry and every later snapshot. Never a position or a text hash.
    toolCallId: item.entryId,
    toolName: item.toolName,
    turnId: item.turnId ?? NO_TURN_ID,
    status: COMMITTED_TOOL_STATUS[item.status],
    argsPreview: item.summary,
    startedAtMs: item.ts,
  };
}

function countByTurnId(tiles: readonly ToolCallSnapshotItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tile of tiles) counts.set(tile.turnId, (counts.get(tile.turnId) ?? 0) + 1);
  return counts;
}

/** Merge tile groups onto one bubble: dedup by tile id, chronological order. */
function mergeTiles(
  existing: readonly ToolCallSnapshotItem[],
  extra: readonly ToolCallSnapshotItem[],
): ToolCallSnapshotItem[] {
  const byId = new Map<string, ToolCallSnapshotItem>();
  for (const tile of existing) byId.set(tile.toolCallId, tile);
  for (const tile of extra) byId.set(tile.toolCallId, tile);
  return [...byId.values()].sort((a, b) => a.startedAtMs - b.startedAtMs);
}

/**
 * The live tiles that have NOT been committed yet. Both lists are in gateway
 * dispatch order, so a turn's first N live tiles are exactly the N already
 * rendered from its committed feed entries; only the tail beyond N is still
 * live-only. Empty at every turn boundary — which is what makes the rendered
 * strip converge with a reload.
 */
function uncommittedLiveTiles(
  live: readonly ToolCallSnapshotItem[],
  committedByTurnId: ReadonlyMap<string, number>,
): ToolCallSnapshotItem[] {
  const seenByTurnId = new Map<string, number>();
  const remaining: ToolCallSnapshotItem[] = [];
  for (const tile of live) {
    const seen = seenByTurnId.get(tile.turnId) ?? 0;
    seenByTurnId.set(tile.turnId, seen + 1);
    if (seen < (committedByTurnId.get(tile.turnId) ?? 0)) continue; // already on screen from the feed
    remaining.push(tile);
  }
  return remaining;
}

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

/** Last assistant bubble per turnId — the single anchor a turn's live tiles
 *  attach to. Attaching to EVERY bubble of the turn would repeat the tile once
 *  per ReAct narration entry, which no replay can reproduce. */
function anchorIndexByTurnId(messages: readonly ChatMessage[]): Map<string, number> {
  const anchors = new Map<string, number>();
  messages.forEach((msg, index) => {
    if (msg.role === "assistant" && msg.turnId !== undefined) anchors.set(msg.turnId, index);
  });
  return anchors;
}

function forwardOrphans(messages: readonly ChatMessage[], orphans: readonly ToolCallSnapshotItem[]): ChatMessage[] {
  // Only turn-tracked messages participate — a message without a turnId came
  // from a turn we cannot correlate.
  const orphansByTargetId = new Map<string, ToolCallSnapshotItem[]>();
  for (const tile of orphans) {
    const target = findOrphanTarget(messages, tile.startedAtMs);
    if (!target) continue;
    const group = orphansByTargetId.get(target.id) ?? [];
    group.push(tile);
    orphansByTargetId.set(target.id, group);
  }
  if (orphansByTargetId.size === 0) return messages as ChatMessage[];

  return messages.map((msg): ChatMessage => {
    const extras = orphansByTargetId.get(msg.id);
    if (extras === undefined) return msg;
    return { ...msg, tools: mergeTiles(msg.tools ?? [], extras) };
  });
}

/**
 * Merges the LIVE tool list onto the messages `deriveMessages` produced, which
 * already carry their committed tiles. Live tiles whose call is already
 * committed are dropped; the rest attach to their turn's last assistant
 * bubble, or — for a turn that produced no text at all — are forwarded to the
 * next assistant bubble the way the committed tiles are.
 */
export function attachToolsToAssistantMessages(
  messages: readonly ChatMessage[],
  tasks: readonly ToolCallSnapshotItem[],
): ChatMessage[] {
  if (tasks.length === 0) return messages as ChatMessage[];

  const committedByTurnId = countByTurnId(messages.flatMap((m) => m.tools ?? []));
  const pending = uncommittedLiveTiles(tasks, committedByTurnId);
  if (pending.length === 0) return messages as ChatMessage[];

  const pendingByTurnId = new Map<string, ToolCallSnapshotItem[]>();
  for (const tile of pending) {
    const group = pendingByTurnId.get(tile.turnId) ?? [];
    group.push(tile);
    pendingByTurnId.set(tile.turnId, group);
  }

  const anchors = anchorIndexByTurnId(messages);
  const anchored = messages.map((msg, index): ChatMessage => {
    if (msg.turnId === undefined || anchors.get(msg.turnId) !== index) return msg;
    const group = pendingByTurnId.get(msg.turnId);
    if (group === undefined) return msg;
    return { ...msg, tools: mergeTiles(msg.tools ?? [], group) };
  });

  // A turn whose tool round-trips produced no text has no bubble of its own —
  // forward its tiles to the continuation reply that followed.
  const orphans = [...pendingByTurnId].filter(([turnId]) => !anchors.has(turnId)).flatMap(([, group]) => group);
  return orphans.length === 0 ? anchored : forwardOrphans(anchored, orphans);
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

/**
 * Accumulator for the committed-feed walk. `pendingTools` holds the tiles of
 * the turn currently being read — they anchor to the next assistant bubble
 * that follows them in feed order.
 */
interface FeedWalk {
  readonly out: ChatMessage[];
  pendingTools: ToolCallSnapshotItem[];
}

function anchorPendingTools(walk: FeedWalk, msg: ChatMessage): ChatMessage {
  if (walk.pendingTools.length === 0) return msg;
  const tools = walk.pendingTools;
  walk.pendingTools = [];
  return { ...msg, tools };
}

function appendCommittedItems(walk: FeedWalk, items: readonly CommittedFeedItem[], suppressAssistantTurnId?: string) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const stableId = `feed-${item.ts}-${i}`;

    if (item.kind === "tool") {
      walk.pendingTools.push(toCommittedTile(item));
      continue;
    }

    if (item.kind === "user") {
      // A user entry closes the previous turn: tiles still waiting here found
      // no reply to anchor to and must not cross the boundary — the same rule
      // `findOrphanTarget` applies to live tiles.
      walk.pendingTools = [];
      if (item.content.length === 0) continue; // barge-in markers don't render
      walk.out.push(buildUserMessage(stableId, item));
      continue;
    }

    // "trigger" is Phase-2 sensor events, ignored in Phase-1 UI.
    if (item.kind !== "assistant") continue;
    if (item.content.length === 0 && !item.cutoff) continue;
    const msg = buildAssistantMessage(stableId, item);
    // While the typewriter is draining a turn, suppress the committed
    // assistant entry for that turnId so the inflight (typewriter) bubble
    // stays the sole render until it catches up. Prevents the "chunk pop"
    // from committed text replacing a mid-reveal bubble. The turn's pending
    // tiles ride along to the inflight bubble instead of jumping a turn.
    if (suppressAssistantTurnId && msg.turnId === suppressAssistantTurnId) continue;
    walk.out.push(anchorPendingTools(walk, msg));
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
 *
 * A tool tile committed mid-turn has no reply to anchor to yet — the running
 * turn's streaming bubble is that anchor, so the walk's pending tiles flush
 * onto the first in-flight bubble.
 */
function appendInflightMessages(walk: FeedWalk, inflight: readonly InFlightMessage[], visibleOverride?: string): void {
  for (let i = 0; i < inflight.length; i++) {
    const entry = inflight[i];
    if (!entry) continue;
    const isNewest = i === inflight.length - 1;
    // Placeholder: the bubble appears as soon as turn.started fires, even
    // before the first delta. bubble-text renders a three-dot pulse when text
    // is empty AND isStreaming — so the user has feedback during LLM TTFB.
    const text = isNewest && visibleOverride !== undefined ? visibleOverride : entry.text;
    walk.out.push(
      anchorPendingTools(walk, {
        id: `inflight-${entry.turnId}`,
        role: "assistant",
        text,
        timestamp: Date.now(),
        isStreaming: true,
        turnId: entry.turnId,
      }),
    );
  }
}

/**
 * Derives the full chat message list from committed history + inflight turns,
 * with each turn's COMMITTED tool tiles already anchored to the bubble that
 * follows them. Call `attachToolsToAssistantMessages` after to merge in the
 * live tiles that are not committed yet.
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
  const walk: FeedWalk = { out: [], pendingTools: [] };
  appendCommittedItems(walk, items, suppressAssistantTurnId);
  appendInflightMessages(walk, inflight, visibleOverride);
  return walk.out;
}
