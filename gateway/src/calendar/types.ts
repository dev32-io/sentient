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
  /** Sparse effective-event fields. Null is an explicit clear. */
  title?: string;
  description?: string | null;
  start?: CalendarTime | null;
  end?: CalendarTime | null;
  visibility?: Visibility | null;
  importance?: Importance | null;
  group?: Group | null;
  tags?: readonly string[] | Tags | null;
}

export interface StoredCalendarEvent {
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

export interface Occurrence extends StoredCalendarEvent {
  /** Stable identity of the persisted series, independent of displayed start. */
  eventId: CalendarEventId;
  occurrenceId: string;
  baseEventId: CalendarEventId;
  /** Legacy internal name retained for the store seam. */
  occurrenceStart: CalendarTime;
  /** Stable original recurrence slot, never the moved effective start. */
  originalStart: CalendarTime;
  occurrenceEnd?: CalendarTime;
}

export interface CalendarNotification {
  kind: string;
  [key: string]: unknown;
}
export interface CalendarNotifier {
  notify(_event: StoredCalendarEvent | Occurrence): void | Promise<void>;
}

/** Admin is adult-equivalent for calendar visibility, not a bypass. */
export function isAdult(role: UserRole): boolean {
  return role === "adult" || role === "admin";
}

/**
 * The resolved, immutable calendar configuration shared by every calendar
 * adapter. YAML snake_case is mapped to this camelCase domain shape at the
 * composition root; `defaultEventTimeZoneId` is concrete by then (the
 * `household` sentinel has already been resolved).
 */
export interface CalendarConfig {
  readonly query: Readonly<{
    readonly maxDays: number;
    readonly maxOccurrences: number;
    readonly pageSize: number;
  }>;
  readonly input: Readonly<{
    readonly maxTitleChars: number;
    readonly maxDescriptionChars: number;
    readonly maxQueryChars: number;
    readonly maxGroupChars: number;
    readonly maxTagChars: number;
    readonly maxTags: number;
  }>;
  readonly output: Readonly<{
    readonly maxResultChars: number;
  }>;
  readonly recurrence: Readonly<{ readonly maxOccurrences: number; readonly maxDays: number }>;
  readonly nudge: Readonly<{ readonly maxPerDay: number }>;
  readonly defaultEventTimeZoneId: string;
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
/** External V2 errors are stable snake_case codes; store errors do not cross this boundary. */
export type CalendarHttpErrorCode = CalendarErrorCode;
export type CalendarResult<T> = Result<T, CalendarStoreError>;
export type CalendarEventPatch = Partial<Omit<StoredCalendarEvent, "id" | "createdAt">>;
/** A normalized V2 row. Child state is deliberately stored separately. */
export interface CalendarPersistenceBaseEvent extends Omit<StoredCalendarEvent, "exdates" | "exceptions" | "tags"> {
  revision: CalendarRevision;
}
export interface CalendarPersistenceChildren {
  exceptions: readonly ExceptionOverride[];
  exclusions: readonly CalendarTime[];
  tags: readonly string[];
}
export interface CalendarPersistenceEvent extends CalendarPersistenceBaseEvent, CalendarPersistenceChildren {}

export interface CalendarStore {
  get(id: CalendarEventId): CalendarResult<StoredCalendarEvent>;
  list(window: CalendarListWindow): CalendarResult<Occurrence[]>;
  create(event: StoredCalendarEvent): CalendarResult<StoredCalendarEvent>;
  update(event: StoredCalendarEvent): CalendarResult<StoredCalendarEvent>;
  update(id: CalendarEventId, patch: CalendarEventPatch): CalendarResult<StoredCalendarEvent>;
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
  version: 2;
  requestId: string;
  operation: string;
  body: T;
}
export interface CalendarResponse<T> {
  version: 2;
  requestId: string;
  body: T;
}
export interface CalendarErrorResponse {
  version: 2;
  requestId: string;
  error: CalendarError;
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
  .strict()
  .refine((r) => !(r.count !== undefined && r.until !== undefined), {
    message: "COUNT and UNTIL are mutually exclusive",
  });
/**
 * Boundary time input is intentionally human/model-friendly.  CalendarTime is
 * kept above for normalized storage and recurrence expansion only.
 */
export type CalendarTimeInput = string & { readonly __calendarTimeInput: unique symbol };
const calendarTimeInputPattern = /^(?:\d{4}|\d{4}-\d{2}|\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))$/;
function isCalendarTimeInput(value: string): boolean {
  if (/^\d{4}$/.test(value)) return true;
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) return isValidCalendarDate(Number(month[1]), Number(month[2]), 1);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) return isValidCalendarDate(Number(date[1]), Number(date[2]), Number(date[3]));
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!dateTime || !isValidCalendarDate(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]))) return false;
  const hour = Number(dateTime[4]);
  const minute = Number(dateTime[5]);
  const second = dateTime[6] === undefined ? 0 : Number(dateTime[6]);
  const offsetHour = dateTime[9] === undefined ? 0 : Number(dateTime[9]);
  const offsetMinute = dateTime[10] === undefined ? 0 : Number(dateTime[10]);
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(Date.parse(value));
}
export const calendarTimeInputSchema = z
  .string()
  .regex(calendarTimeInputPattern, "expected YYYY, YYYY-MM, YYYY-MM-DD, or offset RFC 3339 time")
  .refine(isCalendarTimeInput, "invalid calendar time")
  .brand<"CalendarTimeInput">();

export type CalendarReadScope = CalendarScope | "all";
export type CalendarWriteScope = CalendarScope;
export type CalendarMutationScope = "this_occurrence" | "this_and_following" | "entire_series";
export type CalendarRevision = number & { readonly __calendarRevision: unique symbol };

export const calendarReadScopeSchema = z.enum(["private", "household", "all"]);
export const calendarWriteScopeSchema = z.enum(["private", "household"]);
export const calendarMutationScopeSchema = z.enum(["this_occurrence", "this_and_following", "entire_series"]);
export const calendarRevisionSchema = z.number().int().positive().brand<"CalendarRevision">();
const revisionSchema = calendarRevisionSchema;

export const calendarRecurrenceInputSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive().optional(),
    weekdays: z.array(z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])).min(1).optional(),
    count: z.number().int().positive().optional(),
    until: calendarTimeInputSchema.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if ((rule.count === undefined) === (rule.until === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one of count or until is required" });
    }
    if (rule.frequency === "weekly" && rule.weekdays === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "weekly recurrence requires weekdays" });
    }
    if (rule.frequency !== "weekly" && rule.weekdays !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "weekdays are only valid for weekly recurrence" });
    }
    if (rule.weekdays !== undefined && new Set(rule.weekdays).size !== rule.weekdays.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "weekdays must be unique" });
    }
  });
export type CalendarRecurrenceInput = z.infer<typeof calendarRecurrenceInputSchema>;
export type RecurrenceInput = CalendarRecurrenceInput;

const optionalDescription = z.string().min(1).optional();
const optionalGroup = z.string().min(1).optional();
const eventMetadataShape = {
  title: z.string().min(1),
  description: optionalDescription,
  start: calendarTimeInputSchema,
  end: calendarTimeInputSchema.optional(),
  visibility: z.enum(["everyone", "adults"]),
  importance: z.enum(["normal", "important", "pinned"]),
  group: optionalGroup,
  tags: z.array(z.string()),
  recurrence: calendarRecurrenceInputSchema.optional(),
};

/** Input used by create; scope is optional because adapters default it to private. */
export const calendarCreateInputSchema = z.object({
  ...eventMetadataShape,
  visibility: z.enum(["everyone", "adults"]).default("everyone"),
  importance: z.enum(["normal", "important", "pinned"]).default("normal"),
  tags: z.array(z.string()).default([]),
  notificationPolicy: z.record(z.unknown()).optional(),
  scope: calendarWriteScopeSchema.optional(),
}).strict();
export type CalendarCreateInput = z.infer<typeof calendarCreateInputSchema>;
export const calendarCreateEventSchema = calendarCreateInputSchema;

/** Revisioned event returned by V2 boundaries. */
export const calendarEventSchema = z.object({
  eventId: z.string().min(1),
  revision: revisionSchema,
  scope: calendarWriteScopeSchema,
  ...eventMetadataShape,
}).strict();
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export type CalendarEventV2 = CalendarEvent;

export const calendarOccurrenceProjectionSchema = z.object({
  eventId: z.string().min(1),
  occurrenceId: z.string().min(1),
  originalStart: calendarTimeInputSchema,
  recurring: z.boolean(),
  revision: revisionSchema,
  scope: calendarWriteScopeSchema,
  ...eventMetadataShape,
}).strict();
export type CalendarOccurrenceProjection = z.infer<typeof calendarOccurrenceProjectionSchema>;

export const calendarQueryInputSchema = z.object({
  from: calendarTimeInputSchema,
  to: calendarTimeInputSchema,
  // The resolved CalendarConfig input limit is authoritative; this wire
  // schema only validates the query's type and non-empty shape.
  query: z.string().min(1).optional(),
  scope: calendarReadScopeSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
  group: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  importance: z.enum(["normal", "important", "pinned"]).optional(),
}).strict();
export type CalendarQueryInput = z.infer<typeof calendarQueryInputSchema>;

export const calendarPageSchema = z.object({
  events: z.array(calendarOccurrenceProjectionSchema).max(100),
  nextCursor: z.string().min(1).optional(),
}).strict();
export type CalendarPage = z.infer<typeof calendarPageSchema>;
export type CalendarQueryPage = CalendarPage;

const updateChangeShape = {
  title: z.string().min(1).optional(),
  description: z.string().min(1).nullable().optional(),
  start: calendarTimeInputSchema.optional(),
  end: calendarTimeInputSchema.nullable().optional(),
  visibility: z.enum(["everyone", "adults"]).optional(),
  importance: z.enum(["normal", "important", "pinned"]).optional(),
  group: z.string().min(1).nullable().optional(),
  tags: z.array(z.string()).optional(),
  recurrence: calendarRecurrenceInputSchema.nullable().optional(),
};
const changesSchema = z.object(updateChangeShape).strict().refine((changes) => Object.keys(changes).length > 0, "at least one change is required");
const occurrenceChangesSchema = z.object({ ...updateChangeShape, recurrence: z.never().optional() }).strict()
  .refine((changes) => Object.keys(changes).length > 0, "at least one change is required");
const mutationTargetShape = {
  eventId: z.string().min(1),
  scope: calendarWriteScopeSchema.optional(),
  originalStart: calendarTimeInputSchema.optional(),
  expectedRevision: revisionSchema.optional(),
};
const updateCommandSchemas = [
  z.object({ operation: z.literal("update"), ...mutationTargetShape, applyTo: z.literal("this_occurrence"), changes: occurrenceChangesSchema }).strict(),
  z.object({ operation: z.literal("update"), ...mutationTargetShape, applyTo: z.literal("this_and_following"), changes: changesSchema }).strict(),
  z.object({ operation: z.literal("update"), ...mutationTargetShape, applyTo: z.literal("entire_series"), changes: changesSchema }).strict(),
] as const;
const deleteCommandSchemas = [
  z.object({ operation: z.literal("delete"), ...mutationTargetShape, applyTo: z.literal("this_occurrence") }).strict(),
  z.object({ operation: z.literal("delete"), ...mutationTargetShape, applyTo: z.literal("this_and_following") }).strict(),
  z.object({ operation: z.literal("delete"), ...mutationTargetShape, applyTo: z.literal("entire_series") }).strict(),
] as const;
export const calendarMutationCommandSchema = z.union([
  z.object({ operation: z.literal("create"), input: calendarCreateInputSchema }).strict(),
  ...updateCommandSchemas,
  ...deleteCommandSchemas,
]);
export type CalendarMutationCommand = z.infer<typeof calendarMutationCommandSchema>;
export const calendarUpdateChangesSchema = changesSchema;
export const calendarOccurrenceChangesSchema = occurrenceChangesSchema;

const survivingMutationResultSchema = z.object({
  operation: z.enum(["create", "update"]),
  appliedTo: calendarMutationScopeSchema,
  eventId: z.string().min(1),
  successorEventId: z.string().min(1).optional(),
  resultingRevision: revisionSchema,
}).strict();
const deletionMutationResultSchema = z.object({
  operation: z.literal("delete"),
  appliedTo: calendarMutationScopeSchema,
  eventId: z.string().min(1),
  successorEventId: z.string().min(1).optional(),
}).strict();
export const calendarMutationResultSchema = z.discriminatedUnion("operation", [
  survivingMutationResultSchema,
  deletionMutationResultSchema,
]);
export type CalendarMutationResult = z.infer<typeof calendarMutationResultSchema>;

export type CalendarErrorCode =
  | "invalid_time" | "invalid_range" | "range_too_wide" | "invalid_scope" | "forbidden"
  | "not_found" | "occurrence_not_found" | "result_too_large" | "recurrence_conflict"
  | "conflict" | "aborted" | "io_error"
  | "missing_token" | "malformed" | "expired" | "signature_invalid" | "wrong_purpose"
  | "user_not_found" | "invalid_user_record";
export interface CalendarError {
  code: CalendarErrorCode;
  message: string;
}
export const calendarErrorCodeSchema = z.enum([
  "invalid_time", "invalid_range", "range_too_wide", "invalid_scope", "forbidden", "not_found",
  "occurrence_not_found", "result_too_large", "recurrence_conflict", "conflict", "aborted", "io_error",
  "missing_token", "malformed", "expired", "signature_invalid", "wrong_purpose", "user_not_found", "invalid_user_record",
]);
export const calendarErrorBodySchema = z.object({
  code: calendarErrorCodeSchema,
  message: z.string().min(1),
}).strict();
export const calendarErrorSchema = z.object({
  version: z.literal(2),
  requestId: z.string().min(1),
  error: calendarErrorBodySchema,
}).strict();
export const calendarErrorResponseSchema = calendarErrorSchema;

const updateRequestSchemas = updateCommandSchemas.map((schema) => schema.omit({ operation: true }));
const deleteRequestSchemas = deleteCommandSchemas.map((schema) => schema.omit({ operation: true }));
export const calendarGetInputSchema = z.object({
  eventId: z.string().min(1),
  scope: calendarReadScopeSchema.optional(),
  originalStart: calendarTimeInputSchema.optional(),
}).strict();
const calendarRequestBodySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), body: calendarCreateInputSchema }).strict(),
  z.object({ operation: z.literal("list"), body: calendarQueryInputSchema }).strict(),
  z.object({ operation: z.literal("get"), body: calendarGetInputSchema }).strict(),
  z.object({ operation: z.literal("update"), body: z.union([updateRequestSchemas[0]!, updateRequestSchemas[1]!, updateRequestSchemas[2]!]) }).strict(),
  z.object({ operation: z.literal("delete"), body: z.union([deleteRequestSchemas[0]!, deleteRequestSchemas[1]!, deleteRequestSchemas[2]!]) }).strict(),
]);
export const calendarRequestSchema = z.object({
  version: z.literal(2),
  requestId: z.string().min(1),
  operation: z.string(),
  body: z.unknown(),
}).strict().superRefine((request, ctx) => {
  if (!calendarRequestBodySchema.safeParse({ operation: request.operation, body: request.body }).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid calendar request body" });
  }
});
export const calendarResponseSchema = z.object({
  version: z.literal(2),
  requestId: z.string().min(1),
  body: z.union([calendarEventSchema, calendarOccurrenceProjectionSchema, calendarPageSchema, calendarMutationResultSchema]),
}).strict();

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
  if (values.size !== parts.length || (count && until) || (freq === "WEEKLY" ? !byDay : byDay)) return { ok: false, error: "invalid" };
  if (interval && !/^[1-9]\d*$/.test(interval)) return { ok: false, error: "invalid" };
  if (count && !/^[1-9]\d*$/.test(count)) return { ok: false, error: "invalid" };
  if (until && (!/^\d{8}T\d{6}Z$/.test(until) || !isValidRfcUntil(until))) return { ok: false, error: "invalid" };
  const days = byDay?.split(",");
  if (days && (days.length === 0 || days.some((day) => !WEEKDAYS.includes(day as Weekday)) || new Set(days).size !== days.length)) return { ok: false, error: "invalid" };
  return { ok: true, value: { freq: freq as RRuleFrequency, ...(interval ? { interval: Number(interval) } : {}), ...(count ? { count: Number(count) } : {}), ...(until ? { until: rfcUntilToIso(until) } : {}), ...(days ? { byDay: days as Weekday[] } : {}) } };
}

/** Internal normalized values projected for the legacy store/tool seams. */
export interface WireCalendarEvent extends Omit<StoredCalendarEvent, "tags" | "start" | "end" | "exdates" | "notification"> {
  scope: CalendarScope;
  start: CalendarTime;
  end?: CalendarTime;
  exdates?: readonly CalendarTime[];
  tags: readonly string[];
  notificationPolicy?: CalendarNotification;
}
export interface WireCalendarOccurrence extends WireCalendarEvent {
  occurrenceId: string;
  baseEventId: CalendarEventId;
  occurrenceStart: CalendarTime;
  occurrenceEnd?: CalendarTime;
}
export const goldenCalendarFixtures = goldenCalendarFixture;
