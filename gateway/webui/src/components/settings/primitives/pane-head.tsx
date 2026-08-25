import type { JSX } from "preact";
export interface PaneHeadProps { title: string; sub?: string; action?: JSX.Element; }
export function PaneHead({ title, sub, action }: PaneHeadProps): JSX.Element {
  return <header class="snt-page-head"><div><h2 class="snt-page-title">{title}</h2>{sub && <p class="snt-page-subtitle">{sub}</p>}</div>{action}</header>;
}
