import type { JSX } from "preact";

export interface RolePillProps {
  role: "owner" | "admin" | "kid" | "staff" | "guest";
  label: string;
}

export function RolePill({ role, label }: RolePillProps): JSX.Element {
  return <span class={`role-pill role-pill--${role}`}>{label}</span>;
}
