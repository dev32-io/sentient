import type { ComponentChildren, JSX } from "preact";
import { CheckIcon } from "./icons/check.tsx";
import "./overflow-action-row.css";

export interface OverflowActionRowProps {
  title: string;
  current?: boolean;
  disabled?: boolean;
  onActivate(event: MouseEvent): void;
  overflow?: ComponentChildren;
  className?: string;
}

/** Broad primary target with a separate, optional action slot; never nested buttons. */
export function OverflowActionRow({ title, current, disabled, onActivate, overflow, className }: OverflowActionRowProps): JSX.Element {
  return (
    <div class={["snt-overflow-action-row", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        class="snt-overflow-action-row__main"
        title={title}
        aria-current={current ? "true" : undefined}
        disabled={disabled}
        onClick={onActivate}
      >
        <span class="snt-overflow-action-row__title">{title}</span>
        {current && <span class="snt-overflow-action-row__state"><span aria-hidden="true"><CheckIcon size={15} /></span>Current</span>}
      </button>
      {overflow && <div class="snt-overflow-action-row__overflow">{overflow}</div>}
    </div>
  );
}
