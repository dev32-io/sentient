import type { ScheduleTiming } from "@sentient/protocol";

const DAY_MS = 86_400_000;
const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

type Recurring = Extract<ScheduleTiming, { kind: "recurring" }>;
type Local = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localParts(ms: number, zone: string): Local {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms)))
    values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function stamp(p: Local): string {
  return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}-${p.second}`;
}

/** Resolve a local wall time. A gap has no result; an overlap chooses its first instant. */
export function instantForScheduleLocal(local: Local, zone: string): number | undefined {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const candidates = new Set<number>();
  for (let day = -2; day <= 2; day++) {
    const probe = naive + day * DAY_MS;
    const p = localParts(probe, zone);
    const candidate = naive + probe - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (stamp(localParts(candidate, zone)) === stamp(local)) candidates.add(candidate);
  }
  return candidates.size ? Math.min(...candidates) : undefined;
}

function matches(timing: Recurring, date: Date): boolean {
  if (timing.frequency === "daily") return true;
  if (timing.frequency === "weekly") {
    const day = weekday[date.getUTCDay()];
    return day !== undefined && timing.weekdays?.includes(day) === true;
  }
  return date.getUTCDate() === timing.dayOfMonth;
}

function occurrenceOn(timing: Recurring, date: Date): number | undefined {
  if (!matches(timing, date)) return undefined;
  const [hour, minute] = timing.localTime.split(":").map(Number) as [number, number];
  return instantForScheduleLocal(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour,
      minute,
      second: 0,
    },
    timing.timeZone,
  );
}

function candidates(timing: Recurring, fromMs: number, throughMs: number): number[] {
  const around = localParts(fromMs, timing.timeZone);
  const start = Date.UTC(around.year, around.month - 1, around.day) - DAY_MS;
  const output: number[] = [];
  // The caller supplies a bounded horizon. The extra two days cover large offsets.
  const days = Math.ceil((throughMs - fromMs) / DAY_MS) + 4;
  for (let i = 0; i <= days; i++) {
    const instant = occurrenceOn(timing, new Date(start + i * DAY_MS));
    if (instant !== undefined && instant >= fromMs && instant <= throughMs) output.push(instant);
  }
  return output.sort((a, b) => a - b);
}

/** First valid wall-clock occurrence strictly after the supplied instant. */
export function nextScheduleOccurrence(timing: Recurring, after: Date): Date {
  const around = localParts(after.getTime(), timing.timeZone);
  const start = Date.UTC(around.year, around.month - 1, around.day) - DAY_MS;
  // 370 days covers a monthly day through a leap/non-leap boundary and DST gaps.
  for (let day = 0; day <= 372; day++) {
    const found = occurrenceOn(timing, new Date(start + day * DAY_MS));
    if (found !== undefined && found > after.getTime()) return new Date(found);
  }
  throw new Error("unable to resolve recurring schedule occurrence");
}

/** Latest valid occurrence in the inclusive bounded catch-up window. */
export function latestScheduleOccurrence(timing: Recurring, from: Date, through: Date): Date | undefined {
  const found = candidates(timing, from.getTime(), through.getTime()).at(-1);
  return found === undefined ? undefined : new Date(found);
}
