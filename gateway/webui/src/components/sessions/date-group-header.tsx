import type { JSX } from "preact";

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

export function dateGroupLabel(nowMs: number, lastActiveMs: number): string {
  const today = Math.floor(nowMs / DAY_MS);
  const day = Math.floor(lastActiveMs / DAY_MS);
  if (day === today) return "Today";
  if (day === today - 1) return "Yesterday";
  if (today - day < WEEK_DAYS) return "Last 7 days";
  return "Older";
}

export interface DateGroupHeaderProps {
  label: string;
}

export function DateGroupHeader({ label }: DateGroupHeaderProps): JSX.Element {
  return (
    <div class="sessions-date-group" role="presentation">
      {label}
    </div>
  );
}
