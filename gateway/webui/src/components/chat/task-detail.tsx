import type { TaskListItem } from "@sentient/protocol";
import type { JSX } from "preact";

export interface TaskDetailProps {
  item: TaskListItem;
  direction: "down" | "up";
}

/**
 * Task activity is composer-owned, not a chronology item. This remains a
 * chat-local presentation boundary because the composer imports the legacy
 * ToolInlineDetail path.
 */
export function TaskDetail({ item, direction }: TaskDetailProps): JSX.Element {
  const text = item.argsPreview || "—";
  return (
    <div class={`tool-inline-detail tool-inline-detail--${direction}`}>
      <span class="tool-inline-detail__label">Arguments</span>
      <code class="tool-inline-detail__preview">{text}</code>
    </div>
  );
}
