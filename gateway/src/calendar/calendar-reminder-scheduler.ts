import type { ScheduleTimingInput, UserRole } from "@sentient/protocol";
import type { AccessManager } from "../access/access-manager.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { AuthorizedScheduledExecution, SchedulingResult } from "../scheduling/contracts.js";
import { instantForScheduleLocal } from "../scheduling/recurrence.js";
import type { ScheduleService } from "../scheduling/service.js";
import { type CalendarPersistence, openCalendarPersistence } from "./calendar-store.js";
import { canonicalOriginalKey, expandRecurrence } from "./expand-recurrence.js";
import type {
  CalendarConfig,
  CalendarEventId,
  CalendarPersistenceEvent,
  CalendarReminderCreateInput,
  CalendarScope,
  CalendarTime,
  Occurrence,
} from "./types.js";

const REMINDERS_KEY = "sentientPersonalReminders";
const RECONCILIATION_BATCH = 100;
const RECONCILIATION_INTERVAL_MS = 30_000;
const RECURRING_RECHECK_MS = 6 * 60 * 60_000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

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
    return {
      enabled: true,
      mode: "lead",
      leadMinutes: Number(candidate.leadMinutes),
    };
  if (candidate.mode === "all-day" && typeof candidate.localTime === "string" && typeof candidate.timeZone === "string")
    return {
      enabled: true,
      mode: "all-day",
      localTime: candidate.localTime,
      timeZone: candidate.timeZone as never,
    };
  return undefined;
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

function localDateParts(
  instant: number,
  timeZone: string,
): { day: number; hour: number; minute: number; weekday: (typeof WEEKDAYS)[number] } {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  }).formatToParts(new Date(instant)))
    parts[part.type] = part.value;
  return {
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: (parts.weekday?.toLowerCase() ?? "monday") as (typeof WEEKDAYS)[number],
  };
}

function recurringReminderTiming(
  event: CalendarPersistenceEvent,
  reminder: CalendarReminderCreateInput,
): Extract<ScheduleTimingInput, { kind: "recurring" }> | undefined {
  const rule = event.recurrence?.rule;
  if (!rule) return undefined;
  const zone =
    event.start.kind === "timed" ? event.start.timeZoneId : reminder.mode === "all-day" ? reminder.timeZone : undefined;
  const first = reminderInstant(event.start, reminder);
  if (!zone || first === undefined) return undefined;
  const local = localDateParts(first, zone);
  const localTime = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
  if (rule.freq === "DAILY") return { kind: "recurring", frequency: "daily", localTime, timeZone: zone };
  if (rule.freq === "WEEKLY") {
    // Derive the reminder weekdays from actual expanded slots so a lead that
    // crosses midnight shifts the wake day along with the event.
    const weekdays = rule.byDay?.map((day) => {
      const index = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].indexOf(day);
      const eventWeekday =
        event.start.kind === "timed"
          ? localDateParts(Date.parse(event.start.instant), zone).weekday
          : (WEEKDAYS[new Date(`${event.start.date}T00:00:00Z`).getUTCDay()] ?? "monday");
      const reminderIndex = WEEKDAYS.indexOf(local.weekday);
      const eventIndex = WEEKDAYS.indexOf(eventWeekday);
      return WEEKDAYS[(index + reminderIndex - eventIndex + 7) % 7] ?? "monday";
    }) ?? [local.weekday];
    return { kind: "recurring", frequency: "weekly", localTime, timeZone: zone, weekdays: [...new Set(weekdays)] };
  }
  // The public schedule contract intentionally has no yearly/interval rule.
  // Use its monthly/daily/weekly superset as a durable wake subscription;
  // execution authorization below admits only real event occurrences.
  return { kind: "recurring", frequency: "monthly", localTime, timeZone: zone, dayOfMonth: local.day };
}

function recurringTimingMatchesInstant(
  timing: Extract<ScheduleTimingInput, { kind: "recurring" }>,
  instant: number,
): boolean {
  const local = localDateParts(instant, timing.timeZone);
  const localTime = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
  if (localTime !== timing.localTime) return false;
  if (timing.frequency === "weekly") return timing.weekdays?.includes(local.weekday) === true;
  if (timing.frequency === "monthly") return timing.dayOfMonth === local.day;
  return true;
}

function eventOccurrences(event: CalendarPersistenceEvent, config: CalendarConfig): SchedulingResult<Occurrence[]> {
  const materialized = {
    ...event,
    exdates: event.exclusions,
    tags: new Set(event.tags),
  };
  if (!event.recurrence) {
    return {
      ok: true,
      value: [
        {
          ...materialized,
          eventId: event.id,
          baseEventId: event.id,
          occurrenceId: `${event.id}:${canonicalOriginalKey(event.start)}`,
          occurrenceStart: event.start,
          originalStart: event.start,
        } as unknown as Occurrence,
      ],
    };
  }
  // Keep the expansion window strictly within the configured span even when
  // a DST offset makes equal local dates differ by an hour in UTC.
  const days = Math.max(0, config.recurrence.maxDays - 1);
  const window =
    event.start.kind === "timed"
      ? {
          from: event.start,
          to: {
            ...event.start,
            instant: new Date(Date.parse(event.start.instant) + days * 86_400_000).toISOString() as never,
          },
        }
      : {
          from: event.start,
          to: {
            kind: "all-day" as const,
            date: new Date(Date.parse(`${event.start.date}T00:00:00Z`) + days * 86_400_000)
              .toISOString()
              .slice(0, 10) as never,
          },
        };
  const expanded = expandRecurrence(materialized, window.from, window.to, {
    maxOccurrences: config.recurrence.maxOccurrences,
    maxDays: config.recurrence.maxDays,
    timeZoneId: config.defaultEventTimeZoneId,
  });
  return expanded.ok
    ? { ok: true, value: expanded.value }
    : { ok: false, error: { code: "unavailable", retryable: true } };
}

export interface CalendarReminderScheduler {
  reconcile(
    persistence: CalendarPersistence,
    eventId: string,
    scope: CalendarScope,
    now?: Date,
    originalStart?: string,
  ): Promise<SchedulingResult<void>>;
  reconcilePending(
    persistence: CalendarPersistence,
    scope: CalendarScope,
    limit?: number,
  ): Promise<SchedulingResult<void>>;
  close(): void;
}

type ResolvedUser = Readonly<{ role: UserRole; householdId?: string }>;

export function createCalendarReminderScheduler(deps: {
  schedules: ScheduleService;
  accessManager: AccessManager;
  calendarConfig: CalendarConfig;
  resolveUser?: (userId: string) => Promise<ResolvedUser | null>;
  listUsers?: () => Promise<readonly (ResolvedUser & { userId: string })[]>;
}): CalendarReminderScheduler {
  let closed = false;
  const reconcile = async (
    persistence: CalendarPersistence,
    eventId: string,
    scope: CalendarScope,
    now = new Date(),
    _originalStart?: string,
  ): Promise<SchedulingResult<void>> => {
    const pending = persistence.reminderReconciliation?.(eventId as CalendarEventId);
    if (pending && !pending.ok) return { ok: false, error: { code: "unavailable", retryable: true } };
    const generation = pending?.value?.generation;
    const actor = persistence.ownerUserId;
    if (!actor) return { ok: false, error: { code: "forbidden", retryable: false } };
    const consented = persistence.trustedReminderOwners?.(eventId as CalendarEventId) ?? {
      ok: true as const,
      value: [],
    };
    if (!consented.ok) return { ok: false, error: { code: "unavailable", retryable: true } };
    const scheduled = await deps.schedules.calendarReminderOwners(eventId);
    if (!scheduled.ok) return scheduled;
    const owners = new Set([...consented.value, ...scheduled.value]);

    for (const owner of owners) {
      const hasConsent = consented.value.includes(owner);
      const resolved =
        owner === actor && !deps.resolveUser
          ? { role: persistence.role ?? "adult", householdId: "home" }
          : await deps.resolveUser?.(owner);
      let ownerStore: CalendarPersistence | undefined;
      let event: CalendarPersistenceEvent | undefined;
      try {
        if (hasConsent && resolved && (resolved.householdId === undefined || resolved.householdId === "home")) {
          const principal = createUserPrincipal(owner as never, resolved.role, "home");
          ownerStore = openCalendarPersistence(
            deps.accessManager.grant(principal, scope === "household" ? "calendar-household" : "calendar-private"),
            deps.calendarConfig,
          );
          const found = ownerStore.read(eventId as CalendarEventId);
          if (found.ok) event = found.value;
        }

        if (!resolved) {
          const removed = await deps.schedules.removeCalendarRemindersForOwner(owner as never, eventId, now);
          if (!removed.ok) return removed;
          continue;
        }
        const principal = createUserPrincipal(owner as never, resolved.role, "home");
        const resource = principal
          ? new PrivateScheduleResource(deps.accessManager.grant(principal, "schedule-private"))
          : undefined;
        const existing = await deps.schedules.calendarReminderIds(owner as never, eventId);
        if (!existing.ok) return existing;
        const desired = new Map<string, { timing: ScheduleTimingInput; title: string; notBefore?: Date }>();
        if (event && resource) {
          const baseReminder = reminderFor(event, owner);
          const recurringTiming = baseReminder && recurringReminderTiming(event, baseReminder);
          const occurrences = eventOccurrences(event, deps.calendarConfig);
          if (!occurrences.ok) return occurrences;
          const hasFutureOccurrence = occurrences.value.some((occurrence) => {
            const occurrenceReminder = reminderFor(occurrence, owner);
            const instant = occurrenceReminder && reminderInstant(occurrence.start, occurrenceReminder);
            return instant !== undefined && instant >= now.getTime();
          });
          if (event.recurrence && recurringTiming && baseReminder && hasFutureOccurrence) {
            const first = reminderInstant(event.start, baseReminder);
            desired.set(`${eventId}:${owner}`, {
              timing: recurringTiming,
              title: event.title,
              ...(first !== undefined && first > now.getTime() ? { notBefore: new Date(first) } : {}),
            });
          }
          for (const occurrence of occurrences.value) {
            if (occurrence.visibility === "adults" && resolved?.role === "child") continue;
            const reminder = reminderFor(occurrence, owner);
            const instant = reminder && reminderInstant(occurrence.start, reminder);
            if (instant === undefined || instant < now.getTime()) continue;
            // A canonical recurring subscription owns ordinary slots. Moved
            // occurrences need a one-time companion at their effective start;
            // authorization rejects the stale base wake.
            if (
              recurringTiming &&
              canonicalOriginalKey(occurrence.start) === canonicalOriginalKey(occurrence.originalStart) &&
              recurringTimingMatchesInstant(recurringTiming, instant)
            )
              continue;
            const id = event.recurrence
              ? `${eventId}:${owner}:${canonicalOriginalKey(occurrence.originalStart)}`
              : `${eventId}:${owner}`;
            desired.set(id, {
              timing: { kind: "once-at", at: new Date(instant).toISOString() },
              title: occurrence.title,
            });
          }
        }
        if (!resource) continue;
        for (const [reminderId, value] of desired) {
          const result = await deps.schedules.reconcileCalendarReminder(
            resource,
            {
              eventId,
              reminderId,
              enabled: true,
              message: `Remind me about my calendar event “${value.title}”.`,
              timing: value.timing,
              ...(value.notBefore ? { notBefore: value.notBefore } : {}),
            },
            now,
          );
          if (!result.ok) return result;
        }
        for (const reminderId of existing.value) {
          if (desired.has(reminderId)) continue;
          const result = await deps.schedules.reconcileCalendarReminder(
            resource,
            { eventId, reminderId, enabled: false },
            now,
          );
          if (!result.ok) return result;
        }
      } catch {
        return { ok: false, error: { code: "unavailable", retryable: true } };
      } finally {
        ownerStore?.close();
      }
    }
    if (generation !== undefined) {
      const current = persistence.read(eventId as CalendarEventId);
      const completion =
        current.ok && current.value.recurrence
          ? persistence.deferReminderReconciliation?.(
              eventId as CalendarEventId,
              generation,
              new Date(now.getTime() + RECURRING_RECHECK_MS),
            )
          : persistence.acknowledgeReminderReconciliation?.(eventId as CalendarEventId, generation);
      if (completion && !completion.ok) return { ok: false, error: { code: "unavailable", retryable: true } };
    }
    return { ok: true, value: undefined };
  };

  const scheduler: CalendarReminderScheduler = {
    reconcile,
    async reconcilePending(persistence, scope, limit = RECONCILIATION_BATCH) {
      if (!Number.isInteger(limit) || limit < 1 || limit > RECONCILIATION_BATCH)
        return { ok: false, error: { code: "validation", retryable: false } };
      for (;;) {
        const pending = persistence.pendingReminderReconciliations?.(limit, new Date()) ?? {
          ok: true as const,
          value: [],
        };
        if (!pending.ok) return { ok: false, error: { code: "unavailable", retryable: true } };
        for (const work of pending.value) {
          const result = await reconcile(persistence, work.eventId, scope);
          if (!result.ok) return result;
        }
        if (pending.value.length < limit) return { ok: true, value: undefined };
      }
    },
    close() {
      closed = true;
      if (retryTimer) clearInterval(retryTimer);
    },
  };

  let recoveryRunning = false;
  const recoverAll = async (): Promise<void> => {
    if (closed || recoveryRunning || !deps.listUsers) return;
    recoveryRunning = true;
    try {
      let users: readonly (ResolvedUser & { userId: string })[];
      try {
        users = await deps.listUsers();
      } catch {
        return;
      }
      for (const user of users) {
        if (closed) return;
        let principal: ReturnType<typeof createUserPrincipal>;
        try {
          principal = createUserPrincipal(user.userId as never, user.role, "home");
        } catch {
          continue;
        }
        for (const scope of ["private", "household"] as const) {
          let store: CalendarPersistence | undefined;
          try {
            store = openCalendarPersistence(
              deps.accessManager.grant(principal, scope === "private" ? "calendar-private" : "calendar-household"),
              deps.calendarConfig,
            );
            await scheduler.reconcilePending(store, scope);
          } catch {
            // The durable row remains due and the periodic worker retries it.
          } finally {
            store?.close();
          }
        }
      }
    } finally {
      recoveryRunning = false;
    }
  };
  const retryTimer = deps.listUsers ? setInterval(() => void recoverAll(), RECONCILIATION_INTERVAL_MS) : undefined;
  retryTimer?.unref();
  if (deps.listUsers) queueMicrotask(() => void recoverAll());
  return scheduler;
}

export async function authorizeCalendarReminderExecution(
  execution: AuthorizedScheduledExecution,
  deps: { accessManager: AccessManager; calendarConfig: CalendarConfig },
  signal: AbortSignal,
): Promise<SchedulingResult<void>> {
  const denied = (): SchedulingResult<void> => ({
    ok: false,
    error: { code: "forbidden", retryable: false },
  });
  if (signal.aborted) return { ok: false, error: { code: "closed", retryable: false } };
  if (execution.claim.source.kind !== "calendar-reminder") return denied();
  const source = execution.claim.source;
  for (const resource of ["calendar-private", "calendar-household"] as const) {
    let store: CalendarPersistence | undefined;
    try {
      store = openCalendarPersistence(deps.accessManager.grant(execution.principal, resource), deps.calendarConfig);
      const consented = store.trustedReminderOwners?.(source.eventId as CalendarEventId) ?? {
        ok: true as const,
        value: [],
      };
      if (!consented.ok || !consented.value.includes(execution.principal.userId)) continue;
      const found = store.read(source.eventId as CalendarEventId);
      if (!found.ok) continue;
      const occurrences = eventOccurrences(found.value, deps.calendarConfig);
      if (!occurrences.ok) return occurrences;
      const intended = Date.parse(execution.claim.intendedAt);
      const allowed = occurrences.value.some((occurrence) => {
        if (occurrence.visibility === "adults" && execution.principal.role === "child") return false;
        const reminder = reminderFor(occurrence, execution.principal.userId);
        const instant = reminder && reminderInstant(occurrence.start, reminder);
        const seriesId = `${source.eventId}:${execution.principal.userId}`;
        const occurrenceId = `${seriesId}:${canonicalOriginalKey(occurrence.originalStart)}`;
        return (
          (source.reminderId === seriesId || source.reminderId === occurrenceId) &&
          instant !== undefined &&
          Math.abs(instant - intended) < 60_000
        );
      });
      if (allowed) return { ok: true, value: undefined };
    } catch {
      // Fail closed without disclosing which calendar scope exists.
    } finally {
      store?.close();
    }
  }
  return denied();
}
