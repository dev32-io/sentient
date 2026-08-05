import type { ConversationToolStatus, ConversationUserChannel, TurnToolStatus } from "@sentient/protocol";
import type { CommittedFeedItem, InFlightMessage, ToolCallSnapshotItem } from "@sentient/web-sdk";
import { createLogger } from "@sentient/web-sdk";
import type { ChatMessage } from "../types.ts";

const log = createLogger(["sentient", "webui", "cycle-helpers"]);

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
// THE JOIN IS POSITIONAL, AND THAT IS A COMPROMISE — read this before changing
// it. The two frames share NO tool-call id: the committed item's only id is its
// `entryId` (the store seq — the wire deliberately strips tool plumbing from
// the ITEM, see shared/protocol/src/conversation.ts), while the live frame
// carries the provider's `toolCallId`. An id-based join is what this merge
// wants and it is not available without a wire change: adding `toolCallId` to
// `conversationFeedToolItemSchema` + `conversation-feed.toWireItem`, which is a
// change to a frozen contract.
//
// What the two DO share is `turnId` (frame-level on `conversation.entry`,
// item-level on `turn.tool.update`) and the gateway's dispatch order. So the
// join is per turn: a turn's committed tiles are its first N calls, and the
// live list's tail beyond N is the calls not yet committed. At every turn
// boundary the gateway publishes all outstanding tiles
// (conversation-feed.publishAll), so that tail empties and the rendered strip
// converges exactly on what a reload would show.
//
// TWO CROSS-PACKAGE INVARIANTS HOLD IT UP. Neither is expressible as a type,
// so both are pinned by cycle-helpers.test.ts / tool-status-connector.test.ts
// instead:
//
//   1. SEQUENTIAL DISPATCH — gateway/src/runtime/react-loop.ts's
//      `dispatchToolCalls` is a `for` loop with `await` inside, so a turn's
//      calls are dispatched, and their store entries appended, strictly one at
//      a time in the order `startedAtMs` reflects. Make tool dispatch
//      concurrent (parallel `tool_calls`, or a commit that beats its own
//      dispatch) and this join silently desyncs: a running call gets skipped as
//      "already committed" while a committed one is re-added as live and
//      renders twice. That change REQUIRES the id-based join above.
//   2. COMPLETE LIVE LIST — ToolStatusConnector keeps its cache across a
//      reconnect (its CACHE LIFETIME header), so a turn's live list is never a
//      partial suffix of its dispatch sequence. If it ever is,
//      `uncommittedLiveTiles` degrades loudly rather than duplicating tiles.
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

/** Upper bound on the result text a committed tile shows. Mirrors the 120-char
 *  bound the gateway puts on the LIVE tile's argsPreview (react-loop.ts's
 *  ARGS_PREVIEW_LEN); the committed `summary` is a raw tool result and is NOT
 *  truncated anywhere on the wire, so an unbounded JSON blob would otherwise
 *  land in a UI element sized for a one-line preview. */
const RESULT_PREVIEW_LEN = 120;

function toCommittedTile(item: CommittedFeedItem & { kind: "tool" }): ToolCallSnapshotItem {
  return {
    // The gateway-owned entryId IS the tile identity — stable across the live
    // entry and every later snapshot. Never a position or a text hash.
    toolCallId: item.entryId,
    toolName: item.toolName,
    turnId: item.turnId ?? NO_TURN_ID,
    status: COMMITTED_TOOL_STATUS[item.status],
    // The committed item carries the tool's RESULT and never its arguments:
    // `summary` is the tool_result's stored content, folded into the tile by
    // gateway/src/store/client-projection.ts. Feeding it to `argsPreview` put
    // the output in the field the UI renders as the call's input, so tapping a
    // pill showed arguments live and a raw result blob after a reload.
    argsPreview: "",
    resultPreview: item.summary.slice(0, RESULT_PREVIEW_LEN),
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

/** Truncations already reported, keyed `${turnId}:${live}/${committed}`.
 *  `attachToolsToAssistantMessages` re-runs on every token, so an unguarded
 *  warn would repeat for the whole turn. Cleared wholesale past the cap so a
 *  long-lived tab cannot grow it without bound. */
const reportedTruncations = new Set<string>();
const MAX_REPORTED_TRUNCATIONS = 100;

/**
 * A turn holding FEWER live tiles than committed ones breaks the positional
 * join's premise (invariant 2 in this file's header): the live list is a
 * partial suffix of the turn's dispatch sequence, so nothing here can tell
 * which live tile lines up with which committed one. Report it once per
 * distinct shape — the caller then keeps the committed tiles and drops the
 * unalignable live ones, which is the choice that cannot render one call twice.
 */
function reportTruncatedLiveList(
  live: readonly ToolCallSnapshotItem[],
  committedByTurnId: ReadonlyMap<string, number>,
): void {
  const liveByTurnId = countByTurnId(live);
  for (const [turnId, committed] of committedByTurnId) {
    const liveCount = liveByTurnId.get(turnId) ?? 0;
    if (liveCount === 0 || liveCount >= committed) continue;
    const key = `${turnId}:${liveCount}/${committed}`;
    if (reportedTruncations.has(key)) continue;
    if (reportedTruncations.size >= MAX_REPORTED_TRUNCATIONS) reportedTruncations.clear();
    reportedTruncations.add(key);
    log.warn("tool-tiles.live-list-truncated", {
      reason: "fewer live tiles than committed for this turn — the dispatch-position join cannot align them",
      turnId,
      liveCount,
      committedCount: committed,
    });
  }
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
  reportTruncatedLiveList(live, committedByTurnId);
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
    ...(item.messageId ? { messageId: item.messageId } : {}),
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

    if (item.kind === "trigger") {
      // A stimulus nobody typed — today a delegated task's settled result — is
      // CONTEXT FOR THE MODEL, not a user-facing artifact (owner, 2026-07-31).
      // The model synthesises its reply from it and that reply is what the user
      // sees and hears; it is also the only shape that works in voice, where
      // there is no card to render. So the walk skips it deliberately, which is
      // a different thing from the "Phase-2 sensor events, ignored in Phase-1
      // UI" that used to sit here and dropped it by accident.
      //
      // pendingTools is deliberately NOT cleared, unlike the `user` branch
      // above: a completion can land mid-dispatch via the steer seam, and it
      // is not a person taking the floor. Closing the turn here would orphan
      // tiles that still have a reply to anchor to.
      continue;
    }

    if (item.kind !== "assistant") continue;
    if (item.content.length === 0 && !item.cutoff) continue;
    const msg = buildAssistantMessage(stableId, item);

    // ONE BUBBLE PER REPLY. A ReAct turn commits a row per stretch of text —
    // narration, then the answer after a tool round trip — and the live stream
    // showed them as one bubble that grew. Merging the consecutive rows that
    // share a `messageId` is what makes the replay agree with it, rather than
    // splitting a finished reply into two bubbles the user never saw. The
    // gateway breaks the run itself (a new messageId) when the person speaks
    // mid-turn, so an interjection still splits the reply exactly where it
    // visibly belongs.
    const previous = walk.out[walk.out.length - 1];
    if (
      msg.messageId !== undefined &&
      previous?.role === "assistant" &&
      previous.messageId === msg.messageId &&
      walk.pendingTools.length === 0
    ) {
      walk.out[walk.out.length - 1] = {
        ...previous,
        text: previous.text + msg.text,
        ...(msg.cutoff ? { cutoff: msg.cutoff } : {}),
      };
      continue;
    }
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
