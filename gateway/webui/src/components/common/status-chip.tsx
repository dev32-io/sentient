import type { JSX } from "preact";

export interface StatusChipProps {
  label: string;
  indicator?: "live" | "idle" | "off";
}

export function StatusChip({ label, indicator }: StatusChipProps): JSX.Element {
  return (
    <span class="status-chip">
      {indicator && (
        <span class={`status-chip__dot status-chip__dot--${indicator}`} />
      )}
      {label}
    </span>
  );
}
