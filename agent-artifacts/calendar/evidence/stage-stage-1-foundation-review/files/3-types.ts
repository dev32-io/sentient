import type { Result, UserRole } from "@sentient/protocol";
import { z } from "zod";

/** The household zone is deliberately a value, not the host's current zone. */
export type EventTimeZoneId = string & { readonly __eventTimeZoneId: unique symbol };
export const DEFAULT_EVENT_TIME_ZONE = "household" as EventTimeZoneId;

export type CalendarEventId = string & { readonly __calendarEventId: unique symbol };
export type LocalDate = `${number}-${number}-${number}`;
export type UtcInstant = string & { readonly __utcInstant: unique symbol };

export interface TimedValue {
  kind: "timed";
  instant: UtcInstant;
  timeZoneId: EventTimeZoneId;
}
export interface AllDayValue {
  kind: "all-day";
  date: LocalDate;
}
export type CalendarTime = TimedValue | AllDayValue;

export type Visibility = "everyone" | "adults";
export type Importance = "normal" | "important" | "pinned";
export type CalendarScope = "private" | "household";
export type Group = string;
export type Tags = ReadonlySet<string>;

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type RRuleFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export interface RRule {
  freq: RRuleFrequency;
  interval?: number;
  count?: number;
  until?: UtcInstant;
  byDay?: readonly Weekday[];
}
/** Stored recurrence is the original, canonical RRULE (without `RRULE:`). */
export interface Recurrence {
  rrule: string;
  rule: RRule;
}

export interface ExceptionOverride {
  /** The occurrence's original start, used as the stable exception key. */
  occurrence: CalendarTime;
  cancelled?: boolean;
  title?: string;
  start?: CalendarTime;
  end?: CalendarTime;
}

export interface CalendarEvent {
  id: CalendarEventId;
  title: string;
  description?: string;
  start: CalendarTime;
  end?: CalendarTime;
  recurrence?: Recurrence;
  exdates?: readonly CalendarTime[];
  exceptions?: readonly ExceptionOverride[];
  visibility: Visibility;
  importance: Importance;
  group?: Group;
  tags: Tags;
  /** Reserved for a future notifier; stores must preserve it. */
  notification?: CalendarNotification;
  createdAt: UtcInstant;
  updatedAt: UtcInstant;
}

export interface Occurrence extends CalendarEvent {
  occurrenceId: string;
  baseEventId: CalendarEventId;
  occurrenceStart: CalendarTime;
  occurrenceEnd?: CalendarTime;
}

export interface CalendarNotification {
  kind: string;
  [key: string]: unknown;
}
export interface CalendarNotifier {
  notify(_event: CalendarEvent | Occurrence): void | Promise<void>;
}

/** Admin is adult-equivalent for calendar visibility, not a bypass. */
export function isAdult(role: UserRole): boolean {
  return role === "adult" || role === "admin";
}

export interface CalendarConfig {
  recurrence: { maxOccurrences: number; maxDays: number };
  nudge: { maxPerDay: number };
}

export type CalendarStoreError =
  | "not-found"
  | "already-exists"
  | "invalid"
  | "forbidden"
  | "conflict"
  | "recurrence-limit"
  | "io-error"
  | "closed";
export type CalendarResult<T> = Result<T, CalendarStoreError>;
export interface CalendarStore {
  get(id: CalendarEventId): CalendarResult<CalendarEvent>;
  list(window: CalendarListWindow): CalendarResult<Occurrence[]>;
  create(event: CalendarEvent): CalendarResult<CalendarEvent>;
  update(event: CalendarEvent): CalendarResult<CalendarEvent>;
  delete(id: CalendarEventId): CalendarResult<void>;
  close(): void;
}

/** Both dates are included; a timed window compares UTC instants. */
export interface CalendarListWindow {
  from: CalendarTime;
  to: CalendarTime;
}

export interface CalendarRequest<T> {
  version: 1;
  requestId: string;
  operation: string;
  body: T;
}
export interface CalendarResponse<T> {
  version: 1;
  requestId: string;
  body: T;
}
export interface CalendarErrorResponse {
  version: 1;
  requestId: string;
  error: { code: CalendarStoreError; message: string };
}

const utcInstant = z.string().datetime({ offset: true }).brand<"UtcInstant">();
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .brand<"LocalDate">();
const eventTimeZoneId = z.string().min(1).brand<"EventTimeZoneId">();
export const wireCalendarTimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timed"), instant: utcInstant, timeZoneId: eventTimeZoneId }).strict(),
  z.object({ kind: z.literal("all-day"), date: localDate }).strict(),
]);
export const wireRRuleSchema = z
  .object({
    freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    interval: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
    until: utcInstant.optional(),
    byDay: z.array(z.enum(WEEKDAYS)).min(1).optional(),
  })
  .refine((r) => !(r.count !== undefined && r.until !== undefined), {
    message: "COUNT and UNTIL are mutually exclusive",
  });
const calendarStoreErrorSchema = z.enum([
  "not-found",
  "already-exists",
  "invalid",
  "forbidden",
  "conflict",
  "recurrence-limit",
  "io-error",
  "closed",
]);

const calendarEventId = z.string().min(1).brand<"CalendarEventId">();
const calendarEventSchema = z
  .object({
    id: calendarEventId,
    scope: z.enum(["private", "household"]),
    title: z.string(),
    description: z.string().optional(),
    start: wireCalendarTimeSchema,
    end: wireCalendarTimeSchema.optional(),
    recurrence: z
      .object({ rrule: z.string().min(1), rule: wireRRuleSchema })
      .strict()
      .superRefine((recurrence, ctx) => {
        const parsed = parseRRule(recurrence.rrule);
        if (!parsed.ok) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid recurrence rule" });
          return;
        }
        const rule = parsed.value;
        if (
          recurrence.rule.freq !== rule.freq ||
          recurrence.rule.interval !== rule.interval ||
          recurrence.rule.count !== rule.count ||
          recurrence.rule.until !== rule.until ||
          JSON.stringify(recurrence.rule.byDay) !== JSON.stringify(rule.byDay)
        ) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "raw and parsed recurrence rules disagree" });
        }
      })
      .optional(),
    exdates: z.array(wireCalendarTimeSchema).optional(),
    exceptions: z
      .array(
        z
          .object({
            occurrence: wireCalendarTimeSchema,
            cancelled: z.boolean().optional(),
            title: z.string().optional(),
            start: wireCalendarTimeSchema.optional(),
            end: wireCalendarTimeSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    visibility: z.enum(["everyone", "adults"]),
    importance: z.enum(["normal", "important", "pinned"]),
    group: z.string().optional(),
    tags: z.array(z.string()),
    notificationPolicy: z.object({ kind: z.string() }).catchall(z.unknown()).optional(),
    createdAt: utcInstant,
    updatedAt: utcInstant,
  })
  .strict();

const calendarListFilters = z
  .object({
    from: wireCalendarTimeSchema,
    to: wireCalendarTimeSchema,
    scope: z.enum(["private", "household"]).optional(),
    group: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.enum(["normal", "important", "pinned"]).optional(),
  })
  .strict();
const calendarGet = z.object({ id: calendarEventId }).strict();
const calendarSearch = z
  .object({
    query: z.string().min(1),
    scope: z.enum(["private", "household"]).optional(),
    group: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.enum(["normal", "important", "pinned"]).optional(),
  })
  .strict();

const calendarRequestBodySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), body: calendarEventSchema }).strict(),
  z.object({ operation: z.literal("update"), body: calendarEventSchema }).strict(),
  z.object({ operation: z.literal("list"), body: calendarListFilters }).strict(),
  z.object({ operation: z.literal("get"), body: calendarGet }).strict(),
  z.object({ operation: z.literal("search"), body: calendarSearch }).strict(),
  z.object({ operation: z.literal("delete"), body: calendarGet }).strict(),
]);
export const calendarRequestSchema = z
  .object({ version: z.literal(1), requestId: z.string().min(1), operation: z.string(), body: z.unknown() })
  .superRefine((request, ctx) => {
    const parsed = calendarRequestBodySchema.safeParse({ operation: request.operation, body: request.body });
    if (!parsed.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid calendar request body" });
  });
export const calendarErrorSchema = z.object({
  version: z.literal(1),
  requestId: z.string(),
  error: z.object({ code: calendarStoreErrorSchema, message: z.string() }),
});
const calendarResponseBodySchema = z.union([
  calendarEventSchema,
  z.object({ events: z.array(calendarEventSchema), more: z.number().int().nonnegative() }).strict(),
  z.object({ ok: z.literal(true) }).strict(),
]);
export const calendarResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string(),
  body: calendarResponseBodySchema,
});

export function parseRRule(raw: string): CalendarResult<RRule> {
  const parts = raw.split(";");
  if (parts.length === 0 || parts.some((part) => !/^[A-Z]+=[^;]+$/.test(part))) return { ok: false, error: "invalid" };
  const values = new Map(parts.map((part) => part.split("=", 2) as [string, string]));
  const allowedKeys = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY"]);
  if ([...values.keys()].some((key) => !allowedKeys.has(key))) return { ok: false, error: "invalid" };
  const freq = values.get("FREQ");
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return { ok: false, error: "invalid" };
  const interval = values.get("INTERVAL");
  const count = values.get("COUNT");
  const until = values.get("UNTIL");
  const byDay = values.get("BYDAY");
  if (values.size !== parts.length || (count && until) || (freq === "WEEKLY" ? !byDay : byDay))
    return { ok: false, error: "invalid" };
  if (interval && !/^[1-9]\d*$/.test(interval)) return { ok: false, error: "invalid" };
  if (count && !/^[1-9]\d*$/.test(count)) return { ok: false, error: "invalid" };
  if (until && !/^\d{8}T\d{6}Z$/.test(until)) return { ok: false, error: "invalid" };
  const days = byDay?.split(",");
  if (
    days &&
    (days.length === 0 || days.some((day) => !WEEKDAYS.includes(day as Weekday)) || new Set(days).size !== days.length)
  )
    return { ok: false, error: "invalid" };
  return {
    ok: true,
    value: {
      freq: freq as RRuleFrequency,
      ...(interval ? { interval: Number(interval) } : {}),
      ...(count ? { count: Number(count) } : {}),
      ...(until ? { until: until as unknown as UtcInstant } : {}),
      ...(days ? { byDay: days as Weekday[] } : {}),
    },
  };
}

/** JSON representation used by REST, tools, web, and SDK: sets become arrays. */
export interface WireCalendarEvent extends Omit<CalendarEvent, "tags" | "start" | "end" | "exdates" | "notification"> {
  scope: CalendarScope;
  start: CalendarTime;
  end?: CalendarTime;
  exdates?: readonly CalendarTime[];
  tags: readonly string[];
  notificationPolicy?: CalendarNotification;
}
export const goldenCalendarFixtures = {
  timed: { kind: "timed", instant: "2026-08-05T13:00:00.000Z", timeZoneId: "America/Toronto" },
  allDay: { kind: "all-day", date: "2026-08-05" },
  recurrence: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6",
} as const;
