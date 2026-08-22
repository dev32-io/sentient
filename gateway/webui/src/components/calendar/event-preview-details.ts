import type { CalendarRecurrence, CalendarTime } from "../../services/calendar-api.ts";
import { projectCalendarOccurrence } from "./calendar-occurrence.ts";
import type { CalendarOccurrenceInput, ProjectedCalendarOccurrence } from "./calendar-projection-types.ts";
import { type CalendarDate, browserLocale, formatCalendarDate, formatCalendarTime } from "./calendar-time.ts";

export type EventPreviewOccurrence = ProjectedCalendarOccurrence | CalendarOccurrenceInput;

export interface EventPreviewFormatOptions {
  readonly locale?: string;
  /** Display zone for timed values. */
  readonly timeZone?: string;
  readonly deviceTimeZone?: string;
  readonly timeZoneId?: string;
}

export interface EventPreviewDetail {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface EventPreviewModel {
  readonly occurrence: ProjectedCalendarOccurrence;
  readonly description?: string;
  readonly details: readonly EventPreviewDetail[];
}

function isProjectedOccurrence(value: EventPreviewOccurrence): value is ProjectedCalendarOccurrence {
  return Boolean(
    value && typeof value === "object" && "source" in value && "action" in value && "accessibleName" in value,
  );
}

function sourceField(value: ProjectedCalendarOccurrence, name: string): unknown {
  return (value.source as unknown as Record<string, unknown>)[name];
}

function explicitTimeZone(value: ProjectedCalendarOccurrence): string | undefined {
  const sourceStart = sourceField(value, "start");
  if (sourceStart && typeof sourceStart === "object" && !Array.isArray(sourceStart)) {
    const timeZoneId = (sourceStart as { timeZoneId?: unknown }).timeZoneId;
    if (typeof timeZoneId === "string" && timeZoneId.trim()) return timeZoneId;
  }
  const sourceTimeZone = sourceField(value, "timeZoneId");
  return typeof sourceTimeZone === "string" && sourceTimeZone.trim() ? sourceTimeZone : undefined;
}

function offsetTimeZone(value: ProjectedCalendarOccurrence): string | undefined {
  const raw = value.start.raw;
  if (/Z$/i.test(raw)) return "UTC";
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(raw);
  if (!match) return undefined;
  const sign = match[1] === "+" ? "+" : "−";
  return `UTC${sign}${match[2]}:${match[3]}`;
}

function timeZoneValue(value: ProjectedCalendarOccurrence): string {
  return explicitTimeZone(value) ?? offsetTimeZone(value) ?? "Device local";
}

function displayTime(value: ProjectedCalendarOccurrence): string {
  const start = value.start.kind === "all-day" ? `All day · ${value.start.displayDate}` : value.start.label;
  if (!value.end) return start;
  return `${start} – ${value.end.label}`;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function recurrenceValue(value: unknown): CalendarRecurrence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CalendarRecurrence>;
  if (
    candidate.frequency !== "daily" &&
    candidate.frequency !== "weekly" &&
    candidate.frequency !== "monthly" &&
    candidate.frequency !== "yearly"
  )
    return null;
  return candidate as CalendarRecurrence;
}

function recurrenceText(value: CalendarRecurrence): string {
  const interval = typeof value.interval === "number" && value.interval > 0 ? value.interval : 1;
  const frequency = titleCase(value.frequency);
  const unit =
    value.frequency === "daily"
      ? "day"
      : value.frequency === "weekly"
        ? "week"
        : value.frequency === "monthly"
          ? "month"
          : "year";
  const cadence = interval === 1 ? frequency : `Every ${interval} ${unit}${interval === 1 ? "" : "s"}`;
  const weekdays = value.weekdays?.length ? ` · ${value.weekdays.map((weekday) => titleCase(weekday)).join(", ")}` : "";
  const count =
    typeof value.count === "number" && value.count > 0
      ? ` · ${value.count} occurrence${value.count === 1 ? "" : "s"}`
      : "";
  const until = typeof value.until === "string" && value.until.length > 0 ? ` · through ${value.until}` : "";
  return `${cadence}${weekdays}${count}${until}`;
}

function detail(key: string, label: string, value: string): EventPreviewDetail {
  return { key, label, value };
}

/**
 * Normalize an effective occurrence and expose only the supported V2 preview
 * fields. This deliberately reads no compatibility reminder/member/place or
 * color fields, even when a legacy source row happens to carry them.
 */
export function createEventPreviewModel(
  value: EventPreviewOccurrence,
  options: EventPreviewFormatOptions = {},
): EventPreviewModel {
  const projected = isProjectedOccurrence(value)
    ? value
    : projectCalendarOccurrence(value, {
        locale: options.locale ?? browserLocale(),
        ...(options.timeZone !== undefined ? { timeZone: options.timeZone } : {}),
        ...(options.deviceTimeZone !== undefined ? { deviceTimeZone: options.deviceTimeZone } : {}),
        ...(options.timeZoneId !== undefined ? { timeZoneId: options.timeZoneId } : {}),
      });
  const recurrence = recurrenceValue(sourceField(projected, "recurrence"));
  const details: EventPreviewDetail[] = [detail("when", "When", displayTime(projected))];
  if (projected.start.kind === "timed") details.push(detail("timezone", "Timezone", timeZoneValue(projected)));
  details.push(
    detail("scope", "Scope", projected.scope === "household" ? "Household" : "Private"),
    detail("visibility", "Visibility", projected.visibility === "adults" ? "Adults only" : "Everyone"),
    detail("importance", "Importance", projected.importance === "normal" ? "Normal" : titleCase(projected.importance)),
  );
  if (projected.group) details.push(detail("group", "Group", projected.group));
  if (projected.tags.length > 0) details.push(detail("tags", "Tags", projected.tags.join(", ")));
  if (recurrence) {
    details.push(detail("recurrence", "Recurrence", recurrenceText(recurrence)));
  } else if (projected.recurring) {
    details.push(detail("recurrence", "Recurrence", "Repeating"));
  }
  return {
    occurrence: projected,
    ...(projected.description !== undefined && projected.description.trim().length > 0
      ? { description: projected.description }
      : {}),
    details,
  };
}

/** Public name for consumers that already have an effective projected row. */
export const eventPreviewDetails = createEventPreviewModel;
export const mapEventPreviewDetails = createEventPreviewModel;

/** Format a source time for callers that need the same preview display contract. */
export function formatEventPreviewTime(value: CalendarTime, options: EventPreviewFormatOptions = {}): string {
  if (value.kind === "all-day") return `All day · ${formatCalendarDate(value.date as CalendarDate, options)}`;
  return formatCalendarTime(value, {
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
    ...((options.timeZone ?? options.deviceTimeZone ?? options.timeZoneId)
      ? { timeZone: options.timeZone ?? options.deviceTimeZone ?? options.timeZoneId }
      : {}),
  });
}
