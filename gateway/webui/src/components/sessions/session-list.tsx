import type { JSX } from "preact";
import type { SessionRow as Row } from "@sentient/protocol";
import { dateGroupLabel, DateGroupHeader } from "./date-group-header.tsx";
import { SessionRow } from "./session-row.tsx";

export interface SessionListProps {
  rows: readonly Row[];
  currentId: string | null;
  pending?: boolean;
  onSwitch(id: string, event: MouseEvent): void;
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
  currentId,
  pending = false,
  onSwitch,
  onAskDelete,
  onAskRename,
  emptyMessage = "No past chats yet.",
}: SessionListProps): JSX.Element {
  if (rows.length === 0) {
    return <div class="session-list session-list--empty">{emptyMessage}</div>;
  }
  const now = Date.now();
  const groups: { label: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const label = dateGroupLabel(now, row.lastActiveAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return (
    <div class="session-list">
      {groups.map((g) => (
        <div key={g.label} class="session-list__group">
          <DateGroupHeader label={g.label} />
          {g.rows.map((row) => (
            <SessionRow
              key={row.sessionId}
              row={row}
              disabled={pending}
              isCurrent={row.sessionId === currentId}
              onSwitch={(event) => onSwitch(row.sessionId, event)}
              onAskRename={() => onAskRename(row.sessionId, row.title)}
              onAskDelete={() => onAskDelete(row.sessionId, row.title)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
