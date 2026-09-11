import type { JSX } from "preact";
import type { SessionRow as Row } from "@sentient/protocol";
import { RowMenu } from "./row-menu.tsx";
import { OverflowActionRow } from "../common/overflow-action-row.tsx";

export interface SessionRowProps {
  row: Row;
  isCurrent: boolean;
  disabled?: boolean;
  onSwitch(event: MouseEvent): void;
  onAskRename(): void;
  onAskDelete(): void;
}

export function SessionRow({ row, isCurrent, disabled = false, onSwitch, onAskRename, onAskDelete }: SessionRowProps): JSX.Element {
  return (
    <OverflowActionRow
      className={isCurrent ? "session-row session-row--current" : "session-row"}
      title={row.title}
      current={isCurrent}
      disabled={disabled}
      onActivate={onSwitch}
      overflow={<RowMenu onRename={onAskRename} onDelete={onAskDelete} />}
    />
  );
}
