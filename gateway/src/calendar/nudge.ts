import type { UserRole } from "@sentient/protocol";
import { formatStamp } from "../context/message-time.js";
import type { CalendarQueryService } from "./calendar-query.js";
import { queryEffectiveOccurrences } from "./calendar-query.js";
import type { CalendarOccurrenceProjection, CalendarStore, CalendarTime, Occurrence } from "./types.js";
import { isAdult } from "./types.js";

export interface CalendarNudgeBudget {
  maxChars: number;
  maxLines: number;
}

const DEFAULT_BUDGET: CalendarNudgeBudget = { maxChars: 4000, maxLines: 40 };

function localDate(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateAdd(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Convert a household-local date boundary to an instant without using the
 * host timezone. This is only for the legacy CalendarStore compatibility path;
 * the V2 query service performs the same conversion at its seam. */
function localMidnight(date: string, zone: string): number {
  const guess = Date.parse(`${date}T00:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(guess))) parts[part.type] = part.value;
  const represented = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return guess + (guess - represented);
}

/** Ask the normalized query seam for exactly the household-local current
 * date period. It converts that period to event-zone candidate bounds and
 * handles recurrence/offset details internally without widening this request. */
function queryBounds(nowMs: number, householdTz: string): { from: string; to: string } {
  const today = localDate(nowMs, householdTz);
  return { from: today, to: today };
}

type NudgeOccurrence = Pick<Occurrence, "occurrenceId" | "title" | "visibility" | "importance"> & {
  start: CalendarTime;
};

function occurrenceMs(occurrence: NudgeOccurrence): number {
  return occurrence.start.kind === "timed"
    ? Date.parse(occurrence.start.instant)
    : Date.parse(`${occurrence.start.date}T00:00:00Z`);
}

function renderLine(occurrence: NudgeOccurrence, zone: string): string {
  const stamp =
    occurrence.start.kind === "timed" ? formatStamp(Date.parse(occurrence.start.instant), zone) : occurrence.start.date;
  return `- ${stamp} ${occurrence.title}`;
}

function projectionTime(value: CalendarOccurrenceProjection["start"]): CalendarTime {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? { kind: "all-day", date: value as never }
    : { kind: "timed", instant: value as never, timeZoneId: "UTC" as never };
}

function nudgeOccurrence(value: CalendarOccurrenceProjection): NudgeOccurrence {
  return {
    occurrenceId: value.occurrenceId,
    title: value.title,
    visibility: value.visibility,
    importance: value.importance,
    start: projectionTime(value.start),
  };
}

function fit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

/** Apply one aggregate cap after private and household blocks have been
 * composed. Existing overflow summaries are discarded first; only then are
 * event lines dropped, preserving the same deterministic order as the per-store
 * composer. */
export function capCalendarNudge(text: string | null, budget: CalendarNudgeBudget): string | null {
  if (!text) return null;
  const maxLines = Math.max(1, budget.maxLines);
  const maxChars = Math.max(1, budget.maxChars);
  let lines = text.split("\n");
  let omitted = 0;

  for (let index = lines.length - 1; index >= 0; index--) {
    const marker = /^\.\.\.and (\d+) more$/.exec(lines[index] ?? "");
    if (!marker) continue;
    omitted += Number(marker[1] ?? 0);
    lines.splice(index, 1);
  }

  const removeLastEvent = (): boolean => {
    const index = lines.findLastIndex((line) => line.startsWith("- "));
    if (index < 0) return false;
    lines.splice(index, 1);
    omitted++;
    return true;
  };
  while (lines.length > maxLines && removeLastEvent()) {
    // Keep removing the lowest-priority tail until the aggregate line cap fits.
  }
  while (lines.length > maxLines) {
    lines.pop();
    omitted++;
  }
  if (omitted > 0) {
    const marker = `...and ${omitted} more`;
    if (maxLines === 1) lines = [marker];
    else {
      while (lines.length >= maxLines && !removeLastEvent()) lines.pop();
      lines.push(marker);
    }
  }

  let output = lines.join("\n");
  if (output.length <= maxChars) return output;
  const marker = omitted > 0 ? `...and ${omitted} more` : undefined;
  if (!marker) return fit(output, maxChars);
  if (maxChars <= marker.length) return fit(marker, maxChars);
  const body = lines.filter((line) => line !== marker).join("\n");
  const bodyBudget = maxChars - marker.length - 1;
  output = bodyBudget > 0 ? `${fit(body, bodyBudget)}\n${marker}` : marker;
  return output.length <= maxChars ? output : fit(output, maxChars);
}

/** Compose the immutable calendar snapshot placed in a session's system
 * prompt. The store is the visibility boundary: its capability role filters
 * adults-only events; the defensive check also keeps alternate store
 * implementations honest. */
export function composeCalendarNudge(
  source: CalendarStore | CalendarQueryService,
  role: UserRole,
  householdTz: string,
  now: number | Date,
  budget: CalendarNudgeBudget = DEFAULT_BUDGET,
  scope: "private" | "household" = "private",
): string | null {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = localDate(nowMs, householdTz);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: householdTz, weekday: "short" }).format(new Date(nowMs));
  const mondayDelta = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  const weekStart = dateAdd(today, -(mondayDelta < 0 ? 0 : mondayDelta === 0 ? 6 : mondayDelta - 1));
  const weekEnd = dateAdd(weekStart, 6);
  const bounds = queryBounds(nowMs, householdTz);
  let occurrences: NudgeOccurrence[];
  if ("listComplete" in source) {
    // The query service expands effective occurrences with the same recurrence
    // and candidate bounds as tools/REST. Nudge asks for one explicit scope so
    // it cannot accidentally become an all-scope or mutation path.
    const result = queryEffectiveOccurrences(source, {
      from: bounds.from,
      to: bounds.to,
      scope,
    });
    if (!result.ok) return null;
    occurrences = result.value.map(nudgeOccurrence);
  } else {
    // Compatibility stores expose separate timed/all-day list calls rather
    // than the normalized query seam. Keep both calls to this one local date;
    // the V2 query service above remains the authoritative production path.
    const timedStart = localMidnight(today, householdTz);
    const nextMidnight = localMidnight(dateAdd(today, 1), householdTz);
    const timedResult = source.list({
      from: { kind: "timed", instant: new Date(timedStart).toISOString() as never, timeZoneId: householdTz as never },
      to: {
        kind: "timed",
        instant: new Date(nextMidnight - 1).toISOString() as never,
        timeZoneId: householdTz as never,
      },
    });
    const allDayResult = source.list({
      from: { kind: "all-day", date: today as never },
      to: { kind: "all-day", date: today as never },
    });
    if (!timedResult.ok && !allDayResult.ok) return null;
    occurrences = [...(timedResult.ok ? timedResult.value : []), ...(allDayResult.ok ? allDayResult.value : [])];
  }
  occurrences = occurrences
    .filter((item) => isAdult(role) || item.visibility !== "adults")
    .filter((item, index, all) => all.findIndex((candidate) => candidate.occurrenceId === item.occurrenceId) === index);
  if (occurrences.length === 0) return null;

  const todayItems = occurrences.filter((item) =>
    item.start.kind === "all-day" ? item.start.date === today : localDate(occurrenceMs(item), householdTz) === today,
  );
  const weeklyItems = occurrences.filter((item) => {
    const date = item.start.kind === "all-day" ? item.start.date : localDate(occurrenceMs(item), householdTz);
    return (
      date >= weekStart &&
      date <= weekEnd &&
      !todayItems.includes(item) &&
      (item.importance === "important" || item.importance === "pinned")
    );
  });
  const sort = (a: NudgeOccurrence, b: NudgeOccurrence) =>
    occurrenceMs(a) - occurrenceMs(b) || a.occurrenceId.localeCompare(b.occurrenceId);
  todayItems.sort(sort);
  weeklyItems.sort(sort);
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
