// ComposerTaskShelf — the live tool/task rows, flush with the top edge of the
// composer, inside its border (design v2, `sentient-webui-design-v2/screenshots/
// 00-chat-reference.png`; spec `docs/superpowers/specs/2026-04-18-cerebrum-ux-refresh-design.md`
// §4.9).
//
// It replaced pills attached to a chat bubble. Those forced every client to
// answer "which bubble does this pill belong to", which has no stable answer
// once a mid-turn steer can split a reply. The strip has no anchor: the gateway
// says which rows exist and when they leave (`tasklist.state`), and this
// renders them.

import type { TaskListItem } from "@sentient/protocol";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { ToolInlineDetail } from "../chat/tool-inline-detail.tsx";
import { ActionButton } from "../common/foundation.tsx";
import { Icon } from "../common/icon.tsx";

export interface ComposerTaskShelfProps {
  items: readonly TaskListItem[];
}

function statusClass(s: TaskListItem["status"]): string {
  return `dock-task-pill--${s}`;
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
  task: TaskListItem;
  isOpen: boolean;
  onToggle(id: string): void;
}

function ToolPillButton({ task, isOpen, onToggle }: ToolPillButtonProps): JSX.Element {
  return (
    <ActionButton
      variant="quiet"
      className={`dock-task-pill ${statusClass(task.status)}`}
      title={task.toolName}
      ariaLabel={`Task ${shortToolName(task.toolName)}`}
      expanded={isOpen}
      onClick={() => onToggle(task.id)}
    >
      <span class="dock-task-pill__icon" aria-hidden="true">
        <Icon name={iconForTool(task.toolName)} size={14} />
      </span>
      <code class="dock-task-pill__name">{shortToolName(task.toolName)}</code>
      <span class={`dock-task-pill__dot dock-task-pill__dot--${task.status}`} aria-hidden="true" />
      <span class="dock-task-pill__chevron" aria-hidden="true"><Icon name="chevron" size={10} /></span>
    </ActionButton>
  );
}

/**
 * Owns its own `openId` — no bubble to coordinate an anchor with any more.
 * Detail renders ABOVE the pills (spec §4.9: "click pill to expand detail
 * upward") because the strip sits at the very top of the composer card; an
 * expansion has nowhere to grow but up.
 */
export function ComposerTaskShelf({ items }: ComposerTaskShelfProps): JSX.Element | null {
  const [openId, setOpenId] = useState<string | null>(null);

  if (items.length === 0) return null;

  function toggle(id: string): void {
    setOpenId((prev) => (prev === id ? null : id));
  }

  const open = openId !== null ? items.find((t) => t.id === openId) : undefined;

  return (
    <div class="dock-task-shelf">
      {open && <ToolInlineDetail item={open} direction="up" />}
      <div class="dock-task-shelf__pills">
        {items.map((t) => (
          <ToolPillButton key={t.id} task={t} isOpen={openId === t.id} onToggle={toggle} />
        ))}
      </div>
    </div>
  );
}
