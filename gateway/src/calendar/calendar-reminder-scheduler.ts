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
}

type ResolvedUser = Readonly<{ role: UserRole; householdId?: string }>;

export function createCalendarReminderScheduler(deps: {
  schedules: ScheduleService;
  accessManager: AccessManager;
  calendarConfig: CalendarConfig;
  resolveUser?: (userId: string) => Promise<ResolvedUser | null>;
  listUsers?: () => Promise<readonly (ResolvedUser & { userId: string })[]>;
}): CalendarReminderScheduler {
  const reconcile = async (
    persistence: CalendarPersistence,
    eventId: string,
    scope: CalendarScope,
    now = new Date(),
    _originalStart?: string,
  ): Promise<SchedulingResult<void>> => {
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
        const desired = new Map<string, { timing: ScheduleTimingInput; title: string }>();
        if (event && resource) {
          const occurrences = eventOccurrences(event, deps.calendarConfig);
          if (!occurrences.ok) return occurrences;
          for (const occurrence of occurrences.value) {
            if (occurrence.visibility === "adults" && resolved?.role === "child") continue;
            const reminder = reminderFor(occurrence, owner);
            const instant = reminder && reminderInstant(occurrence.start, reminder);
            if (instant === undefined || instant < now.getTime()) continue;
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
    const acknowledged = persistence.acknowledgeReminderReconciliation?.(eventId as CalendarEventId) ?? {
      ok: true as const,
      value: undefined,
    };
    return acknowledged.ok
      ? { ok: true, value: undefined }
      : { ok: false, error: { code: "unavailable", retryable: true } };
  };

  const scheduler: CalendarReminderScheduler = {
    reconcile,
    async reconcilePending(persistence, scope, limit = 25) {
      const pending = persistence.pendingReminderReconciliations?.(limit) ?? {
        ok: true as const,
        value: [],
      };
      if (!pending.ok) return { ok: false, error: { code: "unavailable", retryable: true } };
      for (const eventId of pending.value) {
        const result = await reconcile(persistence, eventId, scope);
        if (!result.ok) return result;
      }
      return { ok: true, value: undefined };
    },
  };

  // The process-level instance supplies listUsers. This bounded startup pass
  // repairs calendar commits whose separate schedule projection failed before
  // a restart; request-time drains remain the retry path for later outages.
  if (deps.listUsers) {
    queueMicrotask(async () => {
      let users: readonly (ResolvedUser & { userId: string })[] = [];
      try {
        users = (await deps.listUsers?.())?.slice(0, 100) ?? [];
      } catch {
        return;
      }
      for (const user of users) {
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
            await scheduler.reconcilePending(store, scope, 25);
          } catch {
            // Durable work remains queued for the next bounded retry.
          } finally {
            store?.close();
          }
        }
      }
    });
  }
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
        const expectedId = found.value.recurrence
          ? `${source.eventId}:${execution.principal.userId}:${canonicalOriginalKey(occurrence.originalStart)}`
          : `${source.eventId}:${execution.principal.userId}`;
        return source.reminderId === expectedId && instant !== undefined && Math.abs(instant - intended) < 60_000;
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
