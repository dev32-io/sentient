import type { JSX } from "preact";

export interface InterruptChipProps {
  variant: "inline" | "meta";
  cutoffKind: "interrupt" | "barge-in";
}

export function InterruptChip({ variant, cutoffKind }: InterruptChipProps): JSX.Element {
  const label = cutoffKind === "barge-in" ? "barge-in" : "interrupted";
  return <span class={`interrupt-chip interrupt-chip--${variant}`}>• {label}</span>;
}
