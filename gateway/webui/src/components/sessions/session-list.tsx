import type { JSX } from "preact";
import type { SessionRow as Row } from "@sentient/protocol";
import type { DraftRecord } from "@sentient/web-sdk";
import { dateGroupLabel, DateGroupHeader } from "./date-group-header.tsx";
import { SessionRow } from "./session-row.tsx";

export interface SessionListProps {
  rows: readonly Row[];
  drafts?: readonly DraftRecord[];
  currentId: string | null;
  insertedIds?: ReadonlySet<string>;
  pending?: boolean;
  onSwitch(id: string, event: MouseEvent): void;
  onOpenDraft?(id: string, event: MouseEvent): void;
  onAskDelete(id: string, title: string): void;
  onAskRename(id: string, title: string): void;
  /**
   * Copy shown when `rows` is empty. Drawer picks the variant based on
   * search active / load failed / genuinely empty. Default keeps the
   * component usable without a caller-supplied string.
   */
  emptyMessage?: string;
}

export function SessionList({
  rows,
  drafts = [],
  currentId,
  insertedIds = new Set(),
  pending = false,
  onSwitch,
  onOpenDraft,
  onAskDelete,
  onAskRename,
  emptyMessage = "No past chats yet.",
}: SessionListProps): JSX.Element {
  const localDraftIds = new Set(drafts.filter((draft) => draft.sessionId === null).map((draft) => draft.id));
  const draftSessionIds = new Set(drafts.flatMap((draft) => draft.sessionId ? [draft.sessionId] : []));
  const draftRows: Row[] = drafts.filter((draft) => draft.sessionId === null).map((draft) => ({
    sessionId: draft.id,
    rootId: draft.id,
    title: draft.text.trim().split("\n", 1)[0]?.slice(0, 48) || "New draft",
    startedAt: draft.createdAt,
    lastActiveAt: draft.updatedAt,
    messageCount: 0,
    isActive: false,
  }));
  const allRows = [...draftRows, ...rows].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  if (allRows.length === 0) {
    return <div class="session-list session-list--empty">{emptyMessage}</div>;
  }
  const now = Date.now();
  const insertedCount = rows.filter((row) => insertedIds.has(row.sessionId)).length;
  const groups: { label: string; rows: Row[] }[] = [];
  for (const row of allRows) {
    const label = dateGroupLabel(now, row.lastActiveAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return (
    <div class="session-list">
      <span class="session-list__announcement" aria-live="polite">
        {insertedCount > 0 ? `${insertedCount} new ${insertedCount === 1 ? "chat" : "chats"} loaded` : ""}
      </span>
      {groups.map((g) => (
        <div key={g.label} class="session-list__group">
          <DateGroupHeader label={g.label} />
          {g.rows.map((row) => (
            <SessionRow
              key={row.sessionId}
              row={row}
              disabled={pending}
              inserted={insertedIds.has(row.sessionId)}
              isCurrent={row.sessionId === currentId}
              draft={localDraftIds.has(row.sessionId) || draftSessionIds.has(row.sessionId)}
              localDraft={localDraftIds.has(row.sessionId)}
              onSwitch={(event) => localDraftIds.has(row.sessionId)
                ? onOpenDraft?.(row.sessionId, event)
                : onSwitch(row.sessionId, event)}
              onAskRename={() => onAskRename(row.sessionId, row.title)}
              onAskDelete={() => onAskDelete(row.sessionId, row.title)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
