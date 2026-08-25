import type { JSX } from "preact";
import type { SessionRow as Row } from "@sentient/protocol";
import { RowMenu } from "./row-menu.tsx";
import { ActionButton } from "../common/foundation.tsx";

export interface SessionRowProps {
  row: Row;
  isCurrent: boolean;
  onSwitch(): void;
  onAskRename(): void;
  onAskDelete(): void;
}

export function SessionRow({
  row,
  isCurrent,
  onSwitch,
  onAskRename,
  onAskDelete,
}: SessionRowProps): JSX.Element {
  const cls = ["session-row", isCurrent && "session-row--current"]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={cls}>
      <ActionButton
        variant="quiet"
        className="session-row__main"
        onClick={onSwitch}
        title={row.title}
      >
        <span class="session-row__title">{row.title}</span>
      </ActionButton>
      <RowMenu onRename={onAskRename} onDelete={onAskDelete} />
    </div>
  );
}
