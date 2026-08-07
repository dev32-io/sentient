import type { TaskListItem } from "@sentient/protocol";
import type { JSX } from "preact";

export interface ToolInlineDetailProps {
  item: TaskListItem;
  direction: "down" | "up";
}

/** Shown when the row has no arguments preview to display. */
const NO_DETAIL = "—";

/**
 * A `tasklist.state` row carries only the call's arguments — never a result
 * (results are the model's to narrate, not a card the UI shows). Rendered
 * verbatim: `argsPreview` is user content and must never be logged.
 */
export function ToolInlineDetail({ item, direction }: ToolInlineDetailProps): JSX.Element {
  const text = item.argsPreview || NO_DETAIL;
  return (
    <div class={`tool-inline-detail tool-inline-detail--${direction}`}>
      <span class="tool-inline-detail__label">arguments</span>
      <code class="tool-inline-detail__preview">{text}</code>
    </div>
  );
}
