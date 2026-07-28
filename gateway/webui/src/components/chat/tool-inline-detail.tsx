import type { JSX } from "preact";
import type { ToolCallSnapshotItem } from "@sentient/web-sdk";

export interface ToolInlineDetailProps {
  task: ToolCallSnapshotItem;
  direction: "down" | "up";
}

export function ToolInlineDetail({ task, direction }: ToolInlineDetailProps): JSX.Element {
  return (
    <div class={`tool-inline-detail tool-inline-detail--${direction}`}>
      <code class="tool-inline-detail__preview">{task.argsPreview}</code>
    </div>
  );
}
