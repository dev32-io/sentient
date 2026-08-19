import type { Result, UserRole } from "@sentient/protocol";
import { z } from "zod";
import goldenCalendarFixture from "./fixtures/calendar-wire.json";

/** The household zone is deliberately a value, not the host's current zone. */
export type EventTimeZoneId = string & { readonly __eventTimeZoneId: unique symbol };
export const DEFAULT_EVENT_TIME_ZONE = "household" as EventTimeZoneId;

export type CalendarEventId = string & { readonly __calendarEventId: unique symbol };
export type LocalDate = `${number}-${number}-${number}`;
export type UtcInstant = string & { readonly __utcInstant: unique symbol };

/** Return whether the components name a real proleptic Gregorian calendar date. */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  // Date.UTC treats years 0..99 as 1900..1999, so restore the requested year
  // before checking the round-trip components.
  const value = new Date(Date.UTC(year, month - 1, day));
  if (year >= 0 && year <= 99) value.setUTCFullYear(year);
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

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
  defaultEventTimeZoneId?: string;
}

export type CalendarStoreError =
  | "not-found"
  | "already-exists"
  | "invalid"
  | "forbidden"
  | "conflict"
  | "recurrence-limit"
  | "io-error"
  | "closed"
  | "not-implemented";
export type CalendarHttpErrorCode =
  | CalendarStoreError
  | "missing-token"
  | "malformed"
  | "expired"
  | "signature-invalid"
  | "wrong-purpose"
  | "user-not-found"
  | "invalid-user-record"
  | "method-not-allowed";
export type CalendarResult<T> = Result<T, CalendarStoreError>;
export type CalendarEventPatch = Partial<Omit<CalendarEvent, "id" | "createdAt">>;
export interface CalendarStore {
  get(id: CalendarEventId): CalendarResult<CalendarEvent>;
  list(window: CalendarListWindow): CalendarResult<Occurrence[]>;
  create(event: CalendarEvent): CalendarResult<CalendarEvent>;
  update(event: CalendarEvent): CalendarResult<CalendarEvent>;
  update(id: CalendarEventId, patch: CalendarEventPatch): CalendarResult<CalendarEvent>;
  delete(id: CalendarEventId): CalendarResult<void>;
  close(): void;
}

/** Both dates are included; a timed window compares UTC instants. */
export interface CalendarListWindow {
  from: CalendarTime;
  to: CalendarTime;
  /** Optional metadata filters are applied to the base event before expansion. */
  group?: Group;
  tags?: readonly string[];
  importance?: Importance;
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
  error: { code: CalendarHttpErrorCode; message: string };
}

const utcInstant = z.string().datetime({ offset: true }).brand<"UtcInstant">();
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    return isValidCalendarDate(year ?? NaN, month ?? NaN, day ?? NaN);
  }, { message: "invalid calendar date" })
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
  "not-implemented",
]);
const calendarHttpErrorSchema = z.enum([
  ...calendarStoreErrorSchema.options,
  "missing-token",
  "malformed",
  "expired",
  "signature-invalid",
  "wrong-purpose",
  "user-not-found",
  "invalid-user-record",
  "method-not-allowed",
]);

const calendarEventId = z.string().min(1).brand<"CalendarEventId">();
export const calendarEventSchema = z
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
          (recurrence.rule.until === undefined) !== (rule.until === undefined) ||
          (recurrence.rule.until !== undefined &&
            rule.until !== undefined &&
            new Date(recurrence.rule.until).getTime() !== new Date(rule.until).getTime()) ||
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

/** Create requests do not require server-owned timestamps; the REST handler assigns them. */
export const calendarCreateEventSchema = calendarEventSchema
  .omit({ createdAt: true, updatedAt: true })
  .extend({ createdAt: utcInstant.optional(), updatedAt: utcInstant.optional() });

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
  z.object({ operation: z.literal("create"), body: calendarCreateEventSchema }).strict(),
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
  error: z.object({ code: calendarHttpErrorSchema, message: z.string() }),
});
const calendarOccurrenceSchema = calendarEventSchema.extend({
  occurrenceId: z.string().min(1),
  baseEventId: calendarEventId,
  occurrenceStart: wireCalendarTimeSchema,
  occurrenceEnd: wireCalendarTimeSchema.optional(),
}).strict();
const calendarResponseBodySchema = z.union([
  calendarEventSchema,
  z.object({ events: z.array(calendarOccurrenceSchema), more: z.number().int().nonnegative() }).strict(),
  z.object({ ok: z.literal(true) }).strict(),
]);
export const calendarResponseSchema = z.object({
  version: z.literal(1),
  requestId: z.string(),
  body: calendarResponseBodySchema,
});

function rfcUntilToIso(until: string): UtcInstant {
  return `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}.000Z` as UtcInstant;
}

function isValidRfcUntil(until: string): boolean {
  const year = Number(until.slice(0, 4));
  const month = Number(until.slice(4, 6));
  const day = Number(until.slice(6, 8));
  const hour = Number(until.slice(9, 11));
  const minute = Number(until.slice(11, 13));
  const second = Number(until.slice(13, 15));
  return isValidCalendarDate(year, month, day) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

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
  if (until && (!/^\d{8}T\d{6}Z$/.test(until) || !isValidRfcUntil(until))) return { ok: false, error: "invalid" };
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
      ...(until ? { until: rfcUntilToIso(until) } : {}),
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

/** LIST entries retain the identity and expanded times of recurring occurrences. */
export interface WireCalendarOccurrence extends WireCalendarEvent {
  occurrenceId: string;
  baseEventId: CalendarEventId;
  occurrenceStart: CalendarTime;
  occurrenceEnd?: CalendarTime;
}
/** The cross-client wire fixture is the source of truth, not a second literal. */
export const goldenCalendarFixtures = goldenCalendarFixture;
