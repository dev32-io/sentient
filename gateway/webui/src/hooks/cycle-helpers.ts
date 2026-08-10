import type { ConversationUserChannel } from "@sentient/protocol";
import type { CommittedFeedItem, InFlightMessage } from "@sentient/web-sdk";
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
    ...(item.replyId ? { replyId: item.replyId } : {}),
    ...(item.cutoff ? { cutoff: item.cutoff } : {}),
  };
}

/** Accumulator for the committed-feed walk. */
interface FeedWalk {
  readonly out: ChatMessage[];
}

function appendCommittedItems(walk: FeedWalk, items: readonly CommittedFeedItem[], suppressAssistantReplyId?: string) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const stableId = `feed-${item.ts}-${i}`;

    // There is no `kind: "tool"` item on the wire any more: tool activity is
    // the composer task strip (`tasklist.state`), which is ephemeral by design.

    if (item.kind === "user") {
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
      continue;
    }

    if (item.kind !== "assistant") continue;
    if (item.content.length === 0 && !item.cutoff) continue;
    const msg = buildAssistantMessage(stableId, item);

    // Hide ONLY the committed row this live bubble is painting, matched on the
    // reply and nothing else. Prevents the "chunk pop" of committed text
    // replacing a mid-reveal bubble.
    //
    // THE TURN FALLBACK THIS REPLACES WAS THE BUG. The gateway rotates
    // `replyId` INSIDE one turnId (a message the person types mid-reply draws
    // a line), so one turn can commit two assistant rows sharing a turnId —
    // and a turn-keyed predicate matched BOTH, blanking the first stretch of
    // the reply for the length of the reveal. Mobile fixed exactly this in
    // `ObserveChatUseCase`; there is one row to hide and no reason to guess.
    if (suppressAssistantReplyId && msg.replyId === suppressAssistantReplyId) continue;
    walk.out.push(msg);
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
function appendInflightMessages(walk: FeedWalk, inflight: readonly InFlightMessage[], visibleOverride?: string): void {
  for (let i = 0; i < inflight.length; i++) {
    const entry = inflight[i];
    if (!entry) continue;
    const isNewest = i === inflight.length - 1;
    // Placeholder: the bubble appears as soon as turn.started fires, even
    // before the first delta. bubble-text renders a three-dot pulse when text
    // is empty AND isStreaming — so the user has feedback during LLM TTFB.
    const text = isNewest && visibleOverride !== undefined ? visibleOverride : entry.text;
    walk.out.push({
      // Keyed by REPLY, falling back to the turn only against a gateway that
      // does not stamp deltas. A rotation puts two open bubbles under one
      // turnId, and a turn-keyed render id makes those two Preact siblings
      // with the same key.
      id: `inflight-${entry.replyId ?? entry.turnId}`,
      role: "assistant",
      text,
      timestamp: Date.now(),
      isStreaming: true,
      turnId: entry.turnId,
      ...(entry.replyId ? { replyId: entry.replyId } : {}),
    });
  }
}

/**
 * Derives the full chat message list from committed history + inflight turns.
 * One reply is one `conversation.entry` (the gateway folds it), so this walk
 * never merges consecutive rows itself — it renders exactly what the feed and
 * the inflight buffer say.
 *
 * `visibleOverride` substitutes the newest inflight bubble's text with the
 * typewriter's partial reveal. `suppressAssistantReplyId` hides the committed
 * assistant entry for the REPLY that is still mid-drain — keeping the
 * typewriter bubble onscreen until it catches up, instead of letting the
 * committed full-text bubble pop in. Both ids are the gateway-owned ones off
 * the frame; nothing here derives either.
 */
export function deriveMessages(
  items: readonly CommittedFeedItem[],
  inflight: readonly InFlightMessage[],
  visibleOverride?: string,
  suppressAssistantReplyId?: string,
): ChatMessage[] {
  const walk: FeedWalk = { out: [] };
  appendCommittedItems(walk, items, suppressAssistantReplyId);
  appendInflightMessages(walk, inflight, visibleOverride);
  return walk.out;
}
