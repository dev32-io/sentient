import type { JSX } from "preact";

export interface DayDividerProps {
  label: string;
}

export function DayDivider({ label }: DayDividerProps): JSX.Element {
  return <div class="day-divider" role="separator" aria-label={`Conversation divider: ${label}`}><span>{label}</span></div>;
}
