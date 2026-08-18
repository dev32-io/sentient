import type { UserRole } from "@sentient/protocol";
import { formatStamp } from "../context/message-time.js";
import type { CalendarStore, Occurrence } from "./types.js";
import { isAdult } from "./types.js";

export interface CalendarNudgeBudget {
  maxChars: number;
  maxLines: number;
}

const DEFAULT_BUDGET: CalendarNudgeBudget = { maxChars: 4000, maxLines: 40 };

function localDate(ms: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(ms));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function dateAdd(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Approximate UTC bounds are deliberately wider than a week. Classification
 * below is in the household zone, while the store's recurrence expansion is
 * still performed in each event's own zone. */
function queryBounds(nowMs: number): { from: string; to: string } {
  const day = localDate(nowMs, "UTC");
  return { from: new Date(`${dateAdd(day, -10)}T00:00:00.000Z`).toISOString(), to: new Date(`${dateAdd(day, 10)}T23:59:59.999Z`).toISOString() };
}

function occurrenceMs(occurrence: Occurrence): number {
  return occurrence.start.kind === "timed" ? Date.parse(occurrence.start.instant) : Date.parse(`${occurrence.start.date}T00:00:00Z`);
}

function renderLine(occurrence: Occurrence, zone: string): string {
  const stamp = occurrence.start.kind === "timed"
    ? formatStamp(Date.parse(occurrence.start.instant), zone)
    : occurrence.start.date;
  return `- ${stamp} ${occurrence.title}`;
}

function fit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

/** Compose the immutable calendar snapshot placed in a session's system
 * prompt. The store is the visibility boundary: its capability role filters
 * adults-only events; the defensive check also keeps alternate store
 * implementations honest. */
export function composeCalendarNudge(
  store: CalendarStore,
  role: UserRole,
  householdTz: string,
  now: number | Date,
  budget: CalendarNudgeBudget = DEFAULT_BUDGET,
): string | null {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = localDate(nowMs, householdTz);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: householdTz, weekday: "short" }).format(new Date(nowMs));
  const mondayDelta = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  const weekStart = dateAdd(today, -(mondayDelta < 0 ? 0 : mondayDelta === 0 ? 6 : mondayDelta - 1));
  const weekEnd = dateAdd(weekStart, 6);
  const bounds = queryBounds(nowMs);
  const timedResult = store.list({
    from: { kind: "timed", instant: bounds.from as never, timeZoneId: householdTz as never },
    to: { kind: "timed", instant: bounds.to as never, timeZoneId: householdTz as never },
  });
  const allDayResult = store.list({
    from: { kind: "all-day", date: dateAdd(today, -10) as never },
    to: { kind: "all-day", date: dateAdd(today, 10) as never },
  });
  if (!timedResult.ok && !allDayResult.ok) return null;
  const occurrences = [...(timedResult.ok ? timedResult.value : []), ...(allDayResult.ok ? allDayResult.value : [])]
    .filter((item) => isAdult(role) || item.visibility !== "adults")
    .filter((item, index, all) => all.findIndex((candidate) => candidate.occurrenceId === item.occurrenceId) === index);
  if (occurrences.length === 0) return null;

  const todayItems = occurrences.filter((item) => item.start.kind === "all-day" ? item.start.date === today : localDate(occurrenceMs(item), householdTz) === today);
  const weeklyItems = occurrences.filter((item) => {
    const date = item.start.kind === "all-day" ? item.start.date : localDate(occurrenceMs(item), householdTz);
    return date >= weekStart && date <= weekEnd && !todayItems.includes(item) && (item.importance === "important" || item.importance === "pinned");
  });
  const sort = (a: Occurrence, b: Occurrence) => occurrenceMs(a) - occurrenceMs(b) || a.occurrenceId.localeCompare(b.occurrenceId);
  todayItems.sort(sort); weeklyItems.sort(sort);
  // The store may contain only events outside this week; those do not create a
  // block. Normal weekly items are overflow-only: they are never allowed to
  // displace today's events or important/pinned weekly events.
  const allWeekly = occurrences.filter((item) => {
    const date = item.start.kind === "all-day" ? item.start.date : localDate(occurrenceMs(item), householdTz);
    return date >= weekStart && date <= weekEnd && !todayItems.includes(item);
  });
  const droppedNormal = allWeekly.filter((item) => item.importance === "normal");
  if (todayItems.length === 0 && weeklyItems.length === 0) return null;

  const title = `Calendar (today ${today})`;
  const visibleToday = [...todayItems];
  const visibleWeekly = [...weeklyItems];
  let omitted = droppedNormal.length;
  const maxLines = Math.max(1, budget.maxLines);
  const renderLines = (): string[] => {
    const next: string[] = [title];
    if (visibleToday.length) {
      next.push("Today:");
      next.push(...visibleToday.map((item) => renderLine(item, householdTz)));
    }
    if (visibleWeekly.length) {
      next.push("Important this week:");
      next.push(...visibleWeekly.map((item) => renderLine(item, householdTz)));
    }
    if (omitted > 0) next.push(`...and ${omitted} more`);
    return next;
  };

  let lines = renderLines();
  // Normal weekly items were dropped before rendering. Only when the
  // mandatory sections themselves cannot fit do we remove an oldest mandatory
  // occurrence, and that is a last resort across both sections rather than a
  // policy of dropping important weekly items before today's events.
  while (lines.length > maxLines) {
    const mandatory = [
      ...visibleToday.map((item) => ({ item, section: "today" as const })),
      ...visibleWeekly.map((item) => ({ item, section: "weekly" as const })),
    ].sort((a, b) => sort(a.item, b.item));
    const oldest = mandatory[0];
    if (!oldest) break;
    const items = oldest.section === "today" ? visibleToday : visibleWeekly;
    const index = items.findIndex((item) => item.occurrenceId === oldest.item.occurrenceId);
    if (index < 0) break;
    items.splice(index, 1);
    omitted++;
    lines = renderLines();
  }
  // A very small line budget can be smaller than the title plus overflow
  // marker. Preserve the marker when possible while still respecting the cap.
  if (lines.length > maxLines) {
    const marker = omitted > 0 ? `...and ${omitted} more` : undefined;
    if (marker && maxLines === 1) lines = [marker];
    else if (marker) {
      const body = lines[lines.length - 1] === marker ? lines.slice(0, -1) : lines;
      lines = [...body.slice(0, maxLines - 1), marker];
    } else lines = lines.slice(0, maxLines);
  }
  let output = lines.join("\n");
  if (output.length > budget.maxChars) {
    const marker = omitted > 0 ? `...and ${omitted} more` : undefined;
    if (!marker) {
      output = fit(output, budget.maxChars);
    } else if (budget.maxChars <= marker.length) {
      output = fit(marker, budget.maxChars);
    } else {
      const body = lines[lines.length - 1] === marker ? lines.slice(0, -1).join("\n") : output;
      const bodyBudget = budget.maxChars - marker.length - 1;
      output = bodyBudget > 0 ? `${fit(body, bodyBudget)}\n${marker}` : marker;
      if (output.length > budget.maxChars) output = fit(output, budget.maxChars);
    }
  }
  return output;
}
