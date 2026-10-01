import type { JSX } from "preact";
import type { HistorySessionRow as Row } from "@sentient/web-sdk";
import { RowMenu } from "./row-menu.tsx";
import { OverflowActionRow } from "../common/overflow-action-row.tsx";

export interface SessionRowProps {
  row: Row;
  isCurrent: boolean;
  disabled?: boolean;
  inserted?: boolean;
  draft?: boolean;
  localDraft?: boolean;
  onSwitch(event: MouseEvent): void;
  onAskRename(): void;
  onAskDelete(): void;
}

export function SessionRow({ row, isCurrent, disabled = false, inserted = false, draft = false, localDraft = false, onSwitch, onAskRename, onAskDelete }: SessionRowProps): JSX.Element {
  return (
    <OverflowActionRow
      className={["session-row", isCurrent && "session-row--current", inserted && "session-row--inserted", draft && "session-row--draft"].filter(Boolean).join(" ")}
      title={draft ? `${row.title} — Draft` : row.provenance === "cube" ? `${row.currentPin ? "Pinned · " : ""}Cube · ${row.title}` : row.title}
      current={isCurrent}
      disabled={disabled}
      onActivate={onSwitch}
      overflow={localDraft ? undefined : <RowMenu onRename={onAskRename} onDelete={onAskDelete} />}
    />
  );
}
