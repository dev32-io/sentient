import type { ScheduleTimingInput, UserRole } from "@sentient/protocol";
import type { AccessManager } from "../access/access-manager.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { AuthorizedScheduledExecution, SchedulingResult } from "../scheduling/contracts.js";
import { instantForScheduleLocal } from "../scheduling/recurrence.js";
import type { ScheduleService } from "../scheduling/service.js";
import { type CalendarPersistence, openCalendarPersistence } from "./calendar-store.js";
import { canonicalOriginalKey, expandRecurrence, verifyGeneratedSlot } from "./expand-recurrence.js";
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
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: (typeof WEEKDAYS)[number];
} {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  }).formatToParts(new Date(instant)))
    parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    millisecond: new Date(instant).getUTCMilliseconds(),
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
  // Only use the compact recurring schedule when it is calendar-equivalent.
  // Interval/yearly rules and lead offsets need actual occurrence instants;
  // transforming only the first slot can drift across month lengths or DST.
  if ((rule.interval ?? 1) !== 1 || (reminder.mode !== "at-start" && reminder.mode !== "all-day")) return undefined;
  const local = localDateParts(first, zone);
  const eventLocal =
    event.start.kind === "timed"
      ? localDateParts(Date.parse(event.start.instant), zone)
      : allDayParts(event.start.date);
  if (rule.freq === "MONTHLY" && local.day !== eventLocal.day) return undefined;
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
    return {
      kind: "recurring",
      frequency: "weekly",
      localTime,
      timeZone: zone,
      weekdays: [...new Set(weekdays)],
    };
  }
  if (rule.freq === "MONTHLY")
    return {
      kind: "recurring",
      frequency: "monthly",
      localTime,
      timeZone: zone,
      dayOfMonth: local.day,
    };
  return undefined;
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

function recurrenceMayStillWake(
  event: CalendarPersistenceEvent,
  reminder: CalendarReminderCreateInput,
  now: number,
): boolean {
  const rule = event.recurrence?.rule;
  const first = reminderInstant(event.start, reminder);
  if (!rule || first === undefined) return false;
  if (rule.until) return Date.parse(rule.until) >= now;
  const count = rule.count ?? 1;
  const interval = rule.interval ?? 1;
  // This is deliberately a conservative upper bound. The recurring schedule
  // is cheap to retain slightly beyond the final slot; authorization still
  // admits only a real occurrence, and the periodic reconciliation removes it.
  const daysPerOccurrence =
    rule.freq === "DAILY"
      ? interval
      : rule.freq === "WEEKLY"
        ? interval * 7
        : rule.freq === "MONTHLY"
          ? interval * 31
          : interval * 366;
  return first + Math.max(0, count - 1) * daysPerOccurrence * 86_400_000 >= now;
}

function sameCalendarTime(a: CalendarTime, b: CalendarTime): boolean {
  return a.kind === b.kind && canonicalOriginalKey(a) === canonicalOriginalKey(b);
}

function allDayParts(date: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: (typeof WEEKDAYS)[number];
} {
  const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = date.split("-").map(Number);
  return {
    year,
    month,
    day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
    weekday: WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "monday",
  };
}

function effectiveOccurrenceAt(
  event: CalendarPersistenceEvent,
  original: CalendarTime,
  zone: string,
  limits: CalendarConfig["recurrence"],
  membershipVerified = false,
): Pick<CalendarPersistenceEvent, "start" | "title" | "visibility" | "notification"> | undefined {
  const isGenerated =
    !event.recurrence || membershipVerified || verifyGeneratedSlot(event, original, { ...limits, timeZoneId: zone }).ok;
  if (
    !isGenerated ||
    (!event.recurrence && !sameCalendarTime(event.start, original)) ||
    event.exclusions.some((excluded) => sameCalendarTime(excluded, original))
  )
    return undefined;
  const exception = event.exceptions.find((candidate) => sameCalendarTime(candidate.occurrence, original));
  if (exception?.cancelled) return undefined;
  const notification = exception?.notification === null ? undefined : (exception?.notification ?? event.notification);
  return {
    start: exception?.start ?? original,
    title: exception?.title ?? event.title,
    visibility: exception?.visibility ?? event.visibility,
    ...(notification ? { notification } : {}),
  };
}

function parseCanonicalOriginalKey(event: CalendarPersistenceEvent, key: string): CalendarTime | undefined {
  if (event.start.kind === "timed") {
    const instant = Date.parse(key);
    if (!Number.isFinite(instant) || new Date(instant).toISOString() !== key) return undefined;
    return { kind: "timed", instant: key as never, timeZoneId: event.start.timeZoneId };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.toISOString().slice(0, 10) !== key
  )
    return undefined;
  return { kind: "all-day", date: key as never };
}

function originalForReminderWake(
  event: CalendarPersistenceEvent,
  reminder: CalendarReminderCreateInput,
  intended: number,
): CalendarTime | undefined {
  if (event.start.kind === "timed") {
    const start = reminder.mode === "lead" ? intended + reminder.leadMinutes * 60_000 : intended;
    return { ...event.start, instant: new Date(start).toISOString() as never };
  }
  if (reminder.mode !== "all-day") return undefined;
  const local = localDateParts(intended, reminder.timeZone);
  return {
    kind: "all-day",
    date: `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}` as never,
  };
}

function eventOccurrences(
  event: CalendarPersistenceEvent,
  config: CalendarConfig,
  now: Date,
  reminder: CalendarReminderCreateInput | undefined,
  graceMs: number,
): SchedulingResult<Occurrence[]> {
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
  // Replenish a rolling reminder-time horizon. Map its bounds back to source
  // event time so lead reminders crossing a month/day boundary are expanded
  // from their true DTSTART phase rather than a transformed first occurrence.
  const rule = event.recurrence.rule;
  const interval = rule.interval ?? 1;
  const boundedOccurrences = Math.max(1, config.recurrence.maxOccurrences - 3);
  const occurrenceBoundDays =
    rule.freq === "DAILY"
      ? Math.max(0, boundedOccurrences - 1) * interval
      : rule.freq === "WEEKLY"
        ? Math.max(1, Math.floor(boundedOccurrences / Math.max(1, rule.byDay?.length ?? 1))) * 7 * interval
        : rule.freq === "MONTHLY"
          ? boundedOccurrences * 31 * interval
          : boundedOccurrences * 366 * interval;
  const days = Math.max(0, Math.min(config.recurrence.maxDays - 1, occurrenceBoundDays));
  const leadMs = reminder?.mode === "lead" ? reminder.leadMinutes * 60_000 : 0;
  const reminderFrom = now.getTime() - graceMs;
  const reminderTo = now.getTime() + days * 86_400_000;
  const window =
    event.start.kind === "timed"
      ? {
          from: {
            ...event.start,
            instant: new Date(reminderFrom + leadMs).toISOString() as never,
          },
          to: {
            ...event.start,
            instant: new Date(reminderTo + leadMs).toISOString() as never,
          },
        }
      : (() => {
          const zone = reminder?.mode === "all-day" ? reminder.timeZone : config.defaultEventTimeZoneId;
          const from = localDateParts(reminderFrom, zone);
          const to = localDateParts(reminderTo, zone);
          const date = (parts: { year: number; month: number; day: number }) =>
            `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}` as never;
          return {
            from: { kind: "all-day" as const, date: date(from) },
            to: { kind: "all-day" as const, date: date(to) },
          };
        })();
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
  close(): Promise<void>;
}

type ResolvedUser = Readonly<{ role: UserRole; householdId?: string }>;

export function createCalendarReminderScheduler(deps: {
  schedules: ScheduleService;
  accessManager: AccessManager;
  calendarConfig: CalendarConfig;
  dbFileName?: string;
  resolveUser?: (userId: string) => Promise<ResolvedUser | null>;
  listUsers?: () => Promise<readonly (ResolvedUser & { userId: string })[]>;
}): CalendarReminderScheduler {
  const storeDeps = deps.dbFileName ? { dbFileName: deps.dbFileName } : {};
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
            storeDeps,
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
          const occurrences = eventOccurrences(event, deps.calendarConfig, now, baseReminder, deps.schedules.graceMs);
          if (!occurrences.ok) return occurrences;
          const occurrenceValues = occurrences.value;
          const hasFutureOccurrence = occurrenceValues.some((occurrence) => {
            const occurrenceReminder = reminderFor(occurrence, owner);
            const instant = occurrenceReminder && reminderInstant(occurrence.start, occurrenceReminder);
            return instant !== undefined && instant >= now.getTime() - deps.schedules.graceMs;
          });
          if (
            event.recurrence &&
            recurringTiming &&
            baseReminder &&
            (hasFutureOccurrence || recurrenceMayStillWake(event, baseReminder, now.getTime()))
          ) {
            const first = reminderInstant(event.start, baseReminder);
            desired.set(`${eventId}:${owner}`, {
              timing: recurringTiming,
              title: event.title,
              ...(first !== undefined && first > now.getTime() ? { notBefore: new Date(first) } : {}),
            });
          }
          for (const occurrence of occurrenceValues) {
            if (occurrence.visibility === "adults" && resolved?.role === "child") continue;
            const reminder = reminderFor(occurrence, owner);
            const instant = reminder && reminderInstant(occurrence.start, reminder);
            if (instant === undefined || instant < now.getTime() - deps.schedules.graceMs) continue;
            // A canonical recurring subscription owns ordinary slots. Moved
            // occurrences need a one-time companion at their effective start;
            // authorization rejects the stale base wake.
            if (
              recurringTiming &&
              occurrence.title === event.title &&
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
          if (event.recurrence) {
            const zone =
              event.start.kind === "timed"
                ? event.start.timeZoneId
                : baseReminder?.mode === "all-day"
                  ? baseReminder.timeZone
                  : deps.calendarConfig.defaultEventTimeZoneId;
            for (const exception of event.exceptions) {
              const occurrence = effectiveOccurrenceAt(
                event,
                exception.occurrence,
                zone,
                deps.calendarConfig.recurrence,
              );
              if (!occurrence || (occurrence.visibility === "adults" && resolved?.role === "child")) continue;
              const reminder = reminderFor(occurrence, owner);
              const instant = reminder && reminderInstant(occurrence.start, reminder);
              if (instant === undefined || instant < now.getTime() - deps.schedules.graceMs) continue;
              if (
                recurringTiming &&
                occurrence.title === event.title &&
                canonicalOriginalKey(occurrence.start) === canonicalOriginalKey(exception.occurrence) &&
                recurringTimingMatchesInstant(recurringTiming, instant)
              )
                continue;
              desired.set(`${eventId}:${owner}:${canonicalOriginalKey(exception.occurrence)}`, {
                timing: {
                  kind: "once-at",
                  at: new Date(instant).toISOString(),
                },
                title: occurrence.title,
              });
            }
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
    async close() {
      closed = true;
      if (retryTimer) clearInterval(retryTimer);
      await recoveryPromise;
    },
  };

  const recoverAll = async (): Promise<void> => {
    if (closed || !deps.listUsers) return;
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
            storeDeps,
          );
          await scheduler.reconcilePending(store, scope);
        } catch {
          // The durable row remains due and the periodic worker retries it.
        } finally {
          store?.close();
        }
      }
    }
  };
  let recoveryPromise: Promise<void> | undefined;
  const startRecovery = (): void => {
    if (closed || recoveryPromise || !deps.listUsers) return;
    recoveryPromise = recoverAll().finally(() => {
      recoveryPromise = undefined;
    });
  };
  const retryTimer = deps.listUsers ? setInterval(startRecovery, RECONCILIATION_INTERVAL_MS) : undefined;
  retryTimer?.unref();
  if (deps.listUsers) queueMicrotask(startRecovery);
  return scheduler;
}

export async function authorizeCalendarReminderExecution(
  execution: AuthorizedScheduledExecution,
  deps: { accessManager: AccessManager; calendarConfig: CalendarConfig; dbFileName?: string },
  signal: AbortSignal,
): Promise<SchedulingResult<void>> {
  const storeDeps = deps.dbFileName ? { dbFileName: deps.dbFileName } : {};
  const denied = (): SchedulingResult<void> => ({
    ok: false,
    error: { code: "forbidden", retryable: false },
  });
  if (signal.aborted) return { ok: false, error: { code: "closed", retryable: false } };
  if (execution.claim.source.kind !== "calendar-reminder") return denied();
  const source = execution.claim.source;
  let unavailable = false;
  for (const resource of ["calendar-private", "calendar-household"] as const) {
    let store: CalendarPersistence | undefined;
    try {
      store = openCalendarPersistence(
        deps.accessManager.grant(execution.principal, resource),
        deps.calendarConfig,
        storeDeps,
      );
      const consented = store.trustedReminderOwners?.(source.eventId as CalendarEventId) ?? {
        ok: true as const,
        value: [],
      };
      if (!consented.ok) {
        unavailable ||= consented.error === "io-error" || consented.error === "closed";
        continue;
      }
      if (!consented.value.includes(execution.principal.userId)) continue;
      const found = store.read(source.eventId as CalendarEventId);
      if (!found.ok) {
        unavailable ||= found.error === "io-error" || found.error === "closed";
        continue;
      }
      const event = found.value;
      const intended = Date.parse(execution.claim.intendedAt);
      const baseReminder = reminderFor(event, execution.principal.userId);
      const zone =
        event.start.kind === "timed"
          ? event.start.timeZoneId
          : baseReminder?.mode === "all-day"
            ? baseReminder.timeZone
            : deps.calendarConfig.defaultEventTimeZoneId;
      const seriesId = `${source.eventId}:${execution.principal.userId}`;
      const originals: CalendarTime[] = [];
      if (source.reminderId === seriesId && baseReminder) {
        const original = originalForReminderWake(event, baseReminder, intended);
        if (original) originals.push(original);
      } else {
        const occurrencePrefix = `${seriesId}:`;
        if (event.recurrence && source.reminderId.startsWith(occurrencePrefix)) {
          // ISO keys contain colons. Remove only exact trusted prefix, then
          // parse and canonicalize full suffix before recurrence validation.
          const original = parseCanonicalOriginalKey(event, source.reminderId.slice(occurrencePrefix.length));
          if (original) originals.push(original);
        }
      }
      for (const original of originals) {
        const membership = verifyGeneratedSlot(event, original, {
          ...deps.calendarConfig.recurrence,
          timeZoneId: zone,
        });
        if (!membership.ok) {
          if (membership.error.code === "recurrence-limit")
            return { ok: false, error: { code: "unavailable", retryable: true } };
          continue;
        }
        const occurrence = effectiveOccurrenceAt(event, original, zone, deps.calendarConfig.recurrence, true);
        if (!occurrence || (occurrence.visibility === "adults" && execution.principal.role === "child")) continue;
        // Title-edited slots are owned by occurrence companion schedule. Deny
        // base recurring wake to prevent duplicate stale-title conversation.
        if (source.reminderId === seriesId && occurrence.title !== event.title) continue;
        const reminder = reminderFor(occurrence, execution.principal.userId);
        const instant = reminder && reminderInstant(occurrence.start, reminder);
        if (instant !== undefined && Math.abs(instant - intended) < 60_000) return { ok: true, value: undefined };
      }
    } catch {
      unavailable = true;
    } finally {
      store?.close();
    }
  }
  return unavailable ? { ok: false, error: { code: "unavailable", retryable: true } } : denied();
}
