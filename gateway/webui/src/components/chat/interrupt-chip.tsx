import type { JSX } from "preact";

export interface InterruptChipProps {
  variant: "inline" | "meta";
  cutoffKind: "interrupt" | "barge-in";
}

export function InterruptChip({ variant, cutoffKind }: InterruptChipProps): JSX.Element {
  const label = cutoffKind === "barge-in" ? "Interrupted by a new message" : "Interrupted";
  return <span class={`interrupt-chip interrupt-chip--${variant}`} role="note" aria-label={label}><span aria-hidden="true" />{label}</span>;
}
