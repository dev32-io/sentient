import type { ComponentChildren, JSX } from "preact";
import { SettingsCard } from "../../common/composites.tsx";

export interface CardProps { title?: string; sub?: string; action?: JSX.Element; children: ComponentChildren; padding?: boolean; }
export function Card({ title, sub, action, children, padding = true }: CardProps): JSX.Element {
  return <SettingsCard title={title} subtitle={sub} action={action} padded={padding}>{children}</SettingsCard>;
}
