import type { JSX } from "preact";

export interface WipBadgeProps {
  label?: string;
}

export function WipBadge({ label = "WIP" }: WipBadgeProps): JSX.Element {
  return <span class="wip-badge">{label}</span>;
}
