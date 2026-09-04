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

function displayToolName(name: string): string {
  const words = shortToolName(name)
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words.length > 0 ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : name;
}

interface ToolPillButtonProps {
  task: TaskListItem;
  isOpen: boolean;
  onToggle(id: string): void;
}

function ToolPillButton({ task, isOpen, onToggle }: ToolPillButtonProps): JSX.Element {
  return (
    <button
      type="button"
      class={`dock-task-pill ${statusClass(task.status)}`}
      title={task.toolName}
      aria-label={`Task ${shortToolName(task.toolName)}`}
      aria-expanded={isOpen}
      onClick={() => onToggle(task.id)}
    >
      <span class={`dock-task-pill__dot dock-task-pill__dot--${task.status}`} aria-hidden="true" />
      <span class="dock-task-pill__name">{displayToolName(task.toolName)}</span>
    </button>
  );
}

/**
 * Owns its own `openId` — no bubble to coordinate an anchor with any more.
 * The shelf is joined above the composer. Its detail follows the selected
 * pill row, so an anchored dock grows the combined surface upward.
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
      <div class="dock-task-shelf__pills">
        {items.map((t) => (
          <ToolPillButton key={t.id} task={t} isOpen={openId === t.id} onToggle={toggle} />
        ))}
      </div>
      {open && <ToolInlineDetail item={open} direction="up" />}
    </div>
  );
}
