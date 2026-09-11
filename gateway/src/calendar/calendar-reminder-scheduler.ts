import type { ScheduleTimingInput } from "@sentient/protocol";
import type { AccessManager } from "../access/access-manager.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { AuthorizedScheduledExecution, SchedulingResult } from "../scheduling/contracts.js";
import { instantForScheduleLocal } from "../scheduling/recurrence.js";
import type { ScheduleService } from "../scheduling/service.js";
import { type CalendarPersistence, openCalendarPersistence } from "./calendar-store.js";
import { normalizeCalendarTime } from "./calendar-temporal.js";
import { canonicalOriginalKey, expandRecurrence } from "./expand-recurrence.js";
import type {
  CalendarConfig,
  CalendarEventId,
  CalendarPersistenceEvent,
  CalendarReminderCreateInput,
  CalendarScope,
  CalendarTime,
} from "./types.js";

const REMINDERS_KEY = "sentientPersonalReminders";

function reminderFor(
  event: { notification?: CalendarPersistenceEvent["notification"] },
  ownerUserId: string,
): CalendarReminderCreateInput | undefined {
  const notification = event.notification as Record<string, unknown> | undefined;
  const map = notification?.[REMINDERS_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  const value = (map as Record<string, unknown>)[ownerUserId];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.enabled !== true) return undefined;
  if (candidate.mode === "at-start") return { enabled: true, mode: "at-start" };
  if (candidate.mode === "lead" && Number.isInteger(candidate.leadMinutes) && Number(candidate.leadMinutes) > 0)
    return { enabled: true, mode: "lead", leadMinutes: Number(candidate.leadMinutes) };
  if (candidate.mode === "all-day" && typeof candidate.localTime === "string" && typeof candidate.timeZone === "string")
    return { enabled: true, mode: "all-day", localTime: candidate.localTime, timeZone: candidate.timeZone as never };
  return undefined;
}

function localParts(
  instant: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: string } {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  }).formatToParts(new Date(instant)))
    values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: String(values.weekday).toLowerCase(),
  };
}

function reminderInstant(start: CalendarTime, reminder: CalendarReminderCreateInput): number | undefined {
  if (start.kind === "timed") {
    const ms = Date.parse(start.instant);
    return reminder.mode === "lead" ? ms - reminder.leadMinutes * 60_000 : ms;
  }
  if (reminder.mode !== "all-day") return undefined;
  const parts = [...start.date.split("-").map(Number), ...reminder.localTime.split(":").map(Number)];
  if (parts.length !== 5 || parts.some((part) => !Number.isInteger(part))) return undefined;
  const [year, month, day, hour, minute] = parts as [number, number, number, number, number];
  return instantForScheduleLocal({ year, month, day, hour, minute, second: 0 }, reminder.timeZone);
}

function timingFor(
  event: CalendarPersistenceEvent,
  reminder: CalendarReminderCreateInput,
): ScheduleTimingInput | undefined {
  const first = reminderInstant(event.start, reminder);
  if (first === undefined) return undefined;
  if (!event.recurrence) return { kind: "once-at", at: new Date(first).toISOString() };
  const zone =
    reminder.mode === "all-day" ? reminder.timeZone : event.start.kind === "timed" ? event.start.timeZoneId : undefined;
  if (!zone) return undefined;
  const local = localParts(first, zone);
  const localTime = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
  const frequency = event.recurrence.rule.freq;
  if (frequency === "DAILY") return { kind: "recurring", frequency: "daily", localTime, timeZone: zone };
  if (frequency === "WEEKLY") {
    const names: Record<string, "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"> = {
      MO: "monday",
      TU: "tuesday",
      WE: "wednesday",
      TH: "thursday",
      FR: "friday",
      SA: "saturday",
      SU: "sunday",
    };
    const weekdays = event.recurrence.rule.byDay
      ?.map((day) => names[day])
      .filter((day): day is NonNullable<typeof day> => Boolean(day)) ?? [
      local.weekday as (typeof names)[keyof typeof names],
    ];
    return { kind: "recurring", frequency: "weekly", localTime, timeZone: zone, weekdays };
  }
  // Monthly is also used as a sparse wake-up for yearly events. Execution
  // authorization below rejects months that are not real event occurrences.
  return { kind: "recurring", frequency: "monthly", localTime, timeZone: zone, dayOfMonth: local.day };
}

export interface CalendarReminderScheduler {
  reconcile(
    persistence: CalendarPersistence,
    eventId: string,
    scope: CalendarScope,
    now?: Date,
    originalStart?: string,
  ): Promise<SchedulingResult<void>>;
}

export function createCalendarReminderScheduler(deps: {
  schedules: ScheduleService;
  accessManager: AccessManager;
  calendarConfig: CalendarConfig;
}): CalendarReminderScheduler {
  return {
    async reconcile(persistence, eventId, _scope, now = new Date(), originalStart?: string) {
      const owner = persistence.ownerUserId;
      if (!owner) return { ok: false, error: { code: "forbidden", retryable: false } };
      const principal = createUserPrincipal(owner as never, persistence.role ?? "adult", "home");
      const resource = new PrivateScheduleResource(deps.accessManager.grant(principal, "schedule-private"));
      const found = persistence.read(eventId as CalendarEventId);
      const baseReminderId = `${eventId}:${owner}`;
      if (!found.ok)
        return deps.schedules.reconcileCalendarReminder(
          resource,
          { eventId, reminderId: baseReminderId, enabled: false },
          now,
        );
      if (originalStart !== undefined) {
        const parsed = normalizeCalendarTime(originalStart, deps.calendarConfig);
        if (!parsed.ok) return { ok: false, error: { code: "validation", retryable: false } };
        const key = canonicalOriginalKey(parsed.value);
        const reminderId = `${baseReminderId}:${key}`;
        const exception = found.value.exceptions.find(
          (candidate) => canonicalOriginalKey(candidate.occurrence) === key,
        );
        const excluded = found.value.exclusions.some((candidate) => canonicalOriginalKey(candidate) === key);
        const notification =
          exception?.notification === null ? undefined : (exception?.notification ?? found.value.notification);
        const reminder = reminderFor({ notification }, owner);
        const start = exception?.start === null ? undefined : (exception?.start ?? parsed.value);
        const instant =
          start && reminder && !exception?.cancelled && !excluded ? reminderInstant(start, reminder) : undefined;
        const needsOverride = exception?.start !== undefined || exception?.notification !== undefined;
        return deps.schedules.reconcileCalendarReminder(
          resource,
          needsOverride && instant !== undefined
            ? {
                eventId,
                reminderId,
                enabled: true,
                message: `Remind me about my calendar event “${exception?.title ?? found.value.title}”.`,
                timing: { kind: "once-at", at: new Date(instant).toISOString() },
              }
            : { eventId, reminderId, enabled: false },
          now,
        );
      }
      const reminder = reminderFor(found.value, owner);
      const timing = reminder && timingFor(found.value, reminder);
      return deps.schedules.reconcileCalendarReminder(
        resource,
        reminder && timing
          ? {
              eventId,
              reminderId: baseReminderId,
              enabled: true,
              message: `Remind me about my calendar event “${found.value.title}”.`,
              timing,
            }
          : { eventId, reminderId: baseReminderId, enabled: false },
        now,
      );
    },
  };
}

export async function authorizeCalendarReminderExecution(
  execution: AuthorizedScheduledExecution,
  deps: { accessManager: AccessManager; calendarConfig: CalendarConfig },
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || execution.claim.source.kind !== "calendar-reminder") return false;
  const source = execution.claim.source;
  for (const resource of ["calendar-private", "calendar-household"] as const) {
    let store: CalendarPersistence | undefined;
    try {
      store = openCalendarPersistence(deps.accessManager.grant(execution.principal, resource), deps.calendarConfig);
      const found = store.read(source.eventId as CalendarEventId);
      if (!found.ok) continue;
      const reminder = reminderFor(found.value, execution.principal.userId);
      const baseReminderId = `${source.eventId}:${execution.principal.userId}`;
      if (!reminder || (source.reminderId !== baseReminderId && !source.reminderId.startsWith(`${baseReminderId}:`)))
        return false;
      const intended = Date.parse(execution.claim.intendedAt);
      if (!Number.isFinite(intended)) return false;
      const event = {
        ...found.value,
        exdates: found.value.exclusions,
        exceptions: found.value.exceptions,
        tags: new Set(found.value.tags),
      };
      const marginMs = 31 * 86_400_000;
      const window =
        event.start.kind === "timed"
          ? {
              from: { ...event.start, instant: new Date(intended - marginMs).toISOString() as never },
              to: { ...event.start, instant: new Date(intended + marginMs).toISOString() as never },
            }
          : (() => {
              const from = new Date(intended - marginMs).toISOString().slice(0, 10) as never;
              const to = new Date(intended + marginMs).toISOString().slice(0, 10) as never;
              return { from: { kind: "all-day" as const, date: from }, to: { kind: "all-day" as const, date: to } };
            })();
      const occurrences = expandRecurrence(event, window.from, window.to, {
        maxOccurrences: deps.calendarConfig.recurrence.maxOccurrences,
        maxDays: deps.calendarConfig.recurrence.maxDays,
        timeZoneId: deps.calendarConfig.defaultEventTimeZoneId,
      });
      if (!occurrences.ok) return false;
      return occurrences.value.some((occurrence) => {
        if (occurrence.visibility === "adults" && execution.principal.role === "child") return false;
        const key = canonicalOriginalKey(occurrence.originalStart);
        const exception = found.value.exceptions.find(
          (candidate) => canonicalOriginalKey(candidate.occurrence) === key,
        );
        const hasOverride = exception?.start !== undefined || exception?.notification !== undefined;
        if (hasOverride ? source.reminderId !== `${baseReminderId}:${key}` : source.reminderId !== baseReminderId)
          return false;
        const effectiveReminder = reminderFor(occurrence, execution.principal.userId);
        const instant = effectiveReminder && reminderInstant(occurrence.start, effectiveReminder);
        return instant !== undefined && Math.abs(instant - intended) < 60_000;
      });
    } catch {
      // Try the other capability scope without disclosing which store failed.
    } finally {
      store?.close();
    }
  }
  return false;
}
