import type { JSX } from "preact";
import type { ToolCallSnapshotItem } from "@sentient/web-sdk";
import { Icon } from "../common/icon.tsx";
import { ToolInlineDetail } from "./tool-inline-detail.tsx";

export interface ToolPillStripProps {
  tools: readonly ToolCallSnapshotItem[];
  expandDirection: "down" | "up";
  openToolCallId: string | null;
  onToggleTool(toolCallId: string): void;
}

function statusClass(s: ToolCallSnapshotItem["status"]): string {
  return `tool-pill--${s}`;
}

// Tool names ship with redundant routing prefixes that don't fit on
// phone-width pills. Real examples seen in the wild:
//   `mcp_home_assistant_ha_get_state`     → strip mcp_home_, then assistant_ha_
//   `mcp_duckduckgo_web_search`           → strip mcp_duckduckgo_
//   `assistant_ha_search_entities`        → strip assistant_ha_
// Iterate so layered prefixes (gateway MCP route → Hermes adapter route) all
// peel off. Original name is preserved as the pill's `title` for hover.
const PREFIX_RE = /^(mcp|assistant)_[^_]+_/;
function shortToolName(name: string): string {
  let n = name;
  while (true) {
    const next = n.replace(PREFIX_RE, "");
    if (next === n) break;
    n = next;
  }
  return n.length > 0 ? n : name;
}

type ToolIconName = "lamp" | "music" | "globe" | "check" | "phone" | "spark" | "thermo" | "sliders" | "x";

function iconForTool(toolName: string): ToolIconName {
  const n = toolName.toLowerCase();
  if (n.includes("light") || n.includes("scene")) return "lamp";
  if (n.includes("music") || n.includes("play")) return "music";
  if (n.includes("search") || n.includes("web")) return "globe";
  if (n.includes("message") || n.includes("send")) return "phone";
  if (n.includes("list") || n.includes("add")) return "check";
  if (n.includes("thermostat")) return "thermo";
  if (n.includes("configure") || n.includes("setting") || n.includes("preference")) return "sliders";
  if (n.includes("cancel")) return "x";
  return "spark";
}

interface ToolPillButtonProps {
  task: ToolCallSnapshotItem;
  isOpen: boolean;
  onToggle(toolCallId: string): void;
}

function ToolPillButton({ task, isOpen, onToggle }: ToolPillButtonProps): JSX.Element {
  const openClass = isOpen ? "tool-pill--open" : "";
  return (
    <button
      type="button"
      class={`tool-pill ${statusClass(task.status)} ${openClass}`}
      onClick={() => onToggle(task.toolCallId)}
    >
      <span class="tool-pill__icon">
        <Icon name={iconForTool(task.toolName)} size={14} />
      </span>
      <code class="tool-pill__name" title={task.toolName}>{shortToolName(task.toolName)}</code>
      <span class={`tool-pill__dot tool-pill__dot--${task.status}`} />
      <span class="tool-pill__chev"><Icon name="chevron" size={10} /></span>
    </button>
  );
}

export function ToolPillStrip({
  tools,
  expandDirection,
  openToolCallId,
  onToggleTool,
}: ToolPillStripProps): JSX.Element {
  const open = openToolCallId !== null ? tools.find((t) => t.toolCallId === openToolCallId) : undefined;
  return (
    <div class={`tool-strip tool-strip--${expandDirection}`}>
      {expandDirection === "up" && open && <ToolInlineDetail task={open} direction="up" />}
      <div class="tool-strip__pills">
        {tools.map((t) => (
          <ToolPillButton
            key={t.toolCallId}
            task={t}
            isOpen={openToolCallId === t.toolCallId}
            onToggle={onToggleTool}
          />
        ))}
      </div>
      {expandDirection === "down" && open && <ToolInlineDetail task={open} direction="down" />}
    </div>
  );
}
