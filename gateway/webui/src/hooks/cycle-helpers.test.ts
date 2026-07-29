// ---------------------------------------------------------------------------
// cycle-helpers — RENDERED-layer convergence for tool tiles.
//
// Pins Invariant B (spec §3.2) at the layer the E2E reload oracle actually
// reads: `render(replay) == render(live)`. The wire already guarantees the two
// feeds are identical; what these tests protect is that the webui derives the
// SAME tool tiles from a feed rebuilt out of `conversation.snapshot` (no live
// `turn.tool.update` at all) as it does from the live turn — none extra, none
// missing, same order, same owning bubble.
// ---------------------------------------------------------------------------

import type { CommittedFeedItem, InFlightMessage, ToolCallSnapshotItem } from "@sentient/web-sdk";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.ts";
import { attachToolsToAssistantMessages, deriveMessages } from "./cycle-helpers.ts";

const TURN = "turn-1";

function userEntry(content: string, ts: number): CommittedFeedItem {
  return { entryId: `e-${ts}`, ts, kind: "user", channel: "text", content };
}

function assistantEntry(content: string, ts: number, turnId?: string): CommittedFeedItem {
  const base: CommittedFeedItem = { entryId: `e-${ts}`, ts, kind: "assistant", content };
  return turnId === undefined ? base : { ...base, turnId };
}

function toolEntry(toolName: string, ts: number, turnId?: string, summary?: string): CommittedFeedItem {
  const base: CommittedFeedItem = {
    entryId: `e-${ts}`,
    ts,
    kind: "tool",
    toolName,
    status: "finished",
    summary: summary ?? `${toolName} result`,
  };
  return turnId === undefined ? base : { ...base, turnId };
}

function tilesOf(messages: readonly ChatMessage[]): ToolCallSnapshotItem[] {
  return messages.flatMap((m) => [...(m.tools ?? [])]);
}

function liveTool(toolName: string, toolCallId: string, startedAtMs: number, turnId = TURN): ToolCallSnapshotItem {
  return { toolCallId, toolName, turnId, status: "done", argsPreview: "{}", startedAtMs };
}

/** The E2E oracle, in code: which tiles render, in what order, on which bubble. */
function renderedTiles(messages: readonly ChatMessage[]): string[] {
  return messages.flatMap((m) => (m.tools ?? []).map((t) => `${m.text}::${t.toolName}`));
}

function render(
  committed: readonly CommittedFeedItem[],
  live: readonly ToolCallSnapshotItem[],
  inflight: readonly InFlightMessage[] = [],
): ChatMessage[] {
  return attachToolsToAssistantMessages(deriveMessages(committed, inflight), live);
}

describe("cycle-helpers — committed tool tiles", () => {
  it("renders a tile for a committed tool entry when no live tool status exists (reload path)", () => {
    const messages = render([userEntry("weather?", 1), toolEntry("get_weather", 2), assistantEntry("20°", 3)], []);

    expect(renderedTiles(messages)).toEqual(["20°::get_weather"]);
  });

  it("renders the committed tile once when the live connector shows the same call", () => {
    const messages = render(
      [userEntry("weather?", 1), toolEntry("get_weather", 2, TURN), assistantEntry("20°", 3, TURN)],
      [liveTool("get_weather", "call-1", 2)],
    );

    expect(renderedTiles(messages)).toEqual(["20°::get_weather"]);
  });

  it("renders live tiles that have no committed twin yet (tool still running)", () => {
    const messages = render(
      [userEntry("weather?", 1)],
      [liveTool("get_weather", "call-1", 2)],
      [{ turnId: TURN, text: "checking" }],
    );

    expect(renderedTiles(messages)).toEqual(["checking::get_weather"]);
  });

  it("renders the same tiles from a replayed snapshot as from the live turn", () => {
    // Live: committed entries carry the frame turnId and the live tool list is
    // still populated. Replay: the same feed arrives via conversation.snapshot,
    // which carries no turnId, and the live tool list is empty.
    const liveFeed = [
      userEntry("weather?", 1),
      assistantEntry("let me look", 2, TURN),
      toolEntry("get_weather", 3, TURN),
      assistantEntry("20°", 4, TURN),
    ];
    const replayFeed = [
      userEntry("weather?", 1),
      assistantEntry("let me look", 2),
      toolEntry("get_weather", 3),
      assistantEntry("20°", 4),
    ];

    const live = renderedTiles(render(liveFeed, [liveTool("get_weather", "call-1", 3)]));
    const replay = renderedTiles(render(replayFeed, []));

    expect(live).toEqual(replay);
    expect(replay).toEqual(["20°::get_weather"]);
  });

  it("keeps multi-call ReAct turns convergent — each tile stays on its own bubble", () => {
    const liveFeed = [
      userEntry("weather then lights", 1),
      assistantEntry("checking weather", 2, TURN),
      toolEntry("get_weather", 3, TURN),
      assistantEntry("now the lights", 4, TURN),
      toolEntry("set_lights", 5, TURN),
      assistantEntry("done", 6, TURN),
    ];
    const replayFeed = [
      userEntry("weather then lights", 1),
      assistantEntry("checking weather", 2),
      toolEntry("get_weather", 3),
      assistantEntry("now the lights", 4),
      toolEntry("set_lights", 5),
      assistantEntry("done", 6),
    ];

    const live = renderedTiles(
      render(liveFeed, [liveTool("get_weather", "call-1", 3), liveTool("set_lights", "call-2", 5)]),
    );
    const replay = renderedTiles(render(replayFeed, []));

    expect(live).toEqual(replay);
    expect(replay).toEqual(["now the lights::get_weather", "done::set_lights"]);
  });

  // The live/committed join is per turn and positional (the two frames share no
  // tool-call id), so it rests on the live list being COMPLETE for its turn.
  // ToolStatusConnector keeps its cache across a reconnect for exactly this
  // reason; this pins the case that used to break — a call dispatched after a
  // reconnect, in a turn whose earlier calls are already committed.
  it("renders a still-running call whose turn already has committed tiles", () => {
    const messages = render(
      [
        userEntry("weather then lights", 1),
        toolEntry("get_weather", 2, TURN),
        toolEntry("set_lights", 3, TURN),
        assistantEntry("checking one more thing", 4, TURN),
      ],
      [
        liveTool("get_weather", "call-1", 2),
        liveTool("set_lights", "call-2", 3),
        { ...liveTool("send_message", "call-3", 5), status: "running" },
      ],
    );

    expect(renderedTiles(messages)).toEqual([
      "checking one more thing::get_weather",
      "checking one more thing::set_lights",
      "checking one more thing::send_message",
    ]);
  });

  // Degraded path: the live list is SHORTER than the turn's committed list, so
  // the positional join cannot align the two (the client lost live frames the
  // gateway will not resend). The committed tiles stay — dropping the
  // unalignable live ones is what keeps a tile from rendering twice, once per
  // source, since their ids differ.
  it("keeps every committed tile and duplicates none when a turn's live list is truncated", () => {
    const messages = render(
      [
        userEntry("weather then lights", 1),
        toolEntry("get_weather", 2, TURN),
        toolEntry("set_lights", 3, TURN),
        assistantEntry("done", 4, TURN),
      ],
      [{ ...liveTool("send_message", "call-3", 5), status: "running" }],
    );

    expect(renderedTiles(messages)).toEqual(["done::get_weather", "done::set_lights"]);
  });

  it("never presents a committed tool result as the call's arguments", () => {
    const messages = render(
      [userEntry("weather?", 1), toolEntry("get_weather", 2, TURN, '{"tempC":20}'), assistantEntry("20°", 3, TURN)],
      [],
    );

    const tile = tilesOf(messages)[0];
    expect(tile?.argsPreview).toBe("");
    expect(tile?.resultPreview).toBe('{"tempC":20}');
  });

  it("bounds the committed result preview — the wire never truncates it", () => {
    const messages = render(
      [userEntry("weather?", 1), toolEntry("get_weather", 2, TURN, "x".repeat(5_000)), assistantEntry("20°", 3, TURN)],
      [],
    );

    expect(tilesOf(messages)[0]?.resultPreview).toHaveLength(120);
  });

  it("drops a committed tile that no reply follows — the next user turn is a hard boundary", () => {
    const messages = render(
      [userEntry("do it", 1), toolEntry("set_lights", 2), userEntry("never mind", 3), assistantEntry("ok", 4)],
      [],
    );

    expect(renderedTiles(messages)).toEqual([]);
  });
});
