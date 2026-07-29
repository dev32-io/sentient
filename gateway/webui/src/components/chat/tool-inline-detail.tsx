import type { JSX } from "preact";
import type { ToolCallSnapshotItem } from "@sentient/web-sdk";

export interface ToolInlineDetailProps {
  task: ToolCallSnapshotItem;
  direction: "down" | "up";
}

/** Shown when the tile's half of the round trip is empty — an unresolved
 *  committed tile (no tool_result was ever recorded) has no result text. */
const NO_DETAIL = "—";

/**
 * The two tile sources carry opposite halves of the round trip: a LIVE tile
 * (turn.tool.update) holds the call's arguments and never its result, a
 * COMMITTED tile (conversation feed) holds the result and never the arguments.
 * Render whichever half the tile has, labelled — putting the result in the
 * arguments block made a reloaded pill contradict the same pill live.
 */
export function ToolInlineDetail({ task, direction }: ToolInlineDetailProps): JSX.Element {
  const hasArgs = task.argsPreview.length > 0;
  const label = hasArgs ? "arguments" : "result";
  const text = (hasArgs ? task.argsPreview : task.resultPreview) || NO_DETAIL;
  return (
    <div class={`tool-inline-detail tool-inline-detail--${direction}`}>
      <span class="tool-inline-detail__label">{label}</span>
      <code class="tool-inline-detail__preview">{text}</code>
    </div>
  );
}
