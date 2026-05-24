import type { ComponentChildren, JSX } from "preact";

export interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: ComponentChildren;
  disabled?: boolean;
}

export function Chip({ active, onClick, children, disabled }: ChipProps): JSX.Element {
  return (
    <button
      type="button"
      class={["pill-chip", active && "on"].filter(Boolean).join(" ")}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
