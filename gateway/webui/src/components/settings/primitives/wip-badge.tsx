import type { JSX } from "preact";

export interface WipBadgeProps {
  label?: string;
}

export function WipBadge({ label = "In progress" }: WipBadgeProps): JSX.Element {
  return <span class="wip-badge">{label}</span>;
}
