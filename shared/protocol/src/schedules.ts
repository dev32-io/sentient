import { z } from "zod";
import goldenScheduleFixtures from "./fixtures/schedules-wire.json";

/** Frozen additive REST surface for user-owned scheduled messages. */
export const SCHEDULES_ROUTE = "/api/v1/schedules" as const;
export const SCHEDULE_CARDS_ROUTE = "/api/v1/scheduled-session-cards" as const;

export const utcInstantSchema = z.string().datetime({ offset: true });
export const timeZoneIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "invalid IANA time zone");

const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm local time");
const weekdaySchema = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

/** Absolute one-time input. `at` is retained exactly; it is not recomputed on retries. */
export const onceAtTimingInputSchema = z.object({ kind: z.literal("once-at"), at: utcInstantSchema }).strict();
/** Relative one-time input. The gateway resolves this once to `once.at` during create acceptance. */
export const onceAfterTimingInputSchema = z
  .object({ kind: z.literal("once-after"), afterSeconds: z.number().int().positive().max(31_536_000) })
  .strict();
/** Local-wall-clock recurrence: skip DST gaps, choose the first overlap, and skip absent monthly dates. */
export const recurringTimingInputSchema = z
  .object({
    kind: z.literal("recurring"),
    frequency: z.enum(["daily", "weekly", "monthly"]),
    localTime: localTimeSchema,
    timeZone: timeZoneIdSchema,
    weekdays: z.array(weekdaySchema).min(1).max(7).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.frequency === "weekly" && value.weekdays === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "weekly recurrence requires weekdays" });
    if (value.frequency !== "weekly" && value.weekdays !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["weekdays"],
        message: "weekdays are only valid for weekly recurrence",
      });
    if (value.frequency === "monthly" && value.dayOfMonth === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dayOfMonth"],
        message: "monthly recurrence requires dayOfMonth",
      });
    if (value.frequency !== "monthly" && value.dayOfMonth !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dayOfMonth"],
        message: "dayOfMonth is only valid for monthly recurrence",
      });
    if (value.weekdays && new Set(value.weekdays).size !== value.weekdays.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "weekdays must be unique" });
  });
export const scheduleTimingInputSchema = z.union([
  onceAtTimingInputSchema,
  onceAfterTimingInputSchema,
  recurringTimingInputSchema,
]);

const resolvedOnceTimingSchema = z.object({ kind: z.literal("once"), at: utcInstantSchema }).strict();
const resolvedRecurringTimingSchema = recurringTimingInputSchema;
export const scheduleTimingSchema = z.union([resolvedOnceTimingSchema, resolvedRecurringTimingSchema]);

export const scheduleSourceSchema = z.union([
  z.object({ kind: z.literal("user") }).strict(),
  z
    .object({
      kind: z.literal("calendar-reminder"),
      eventId: z.string().min(1),
      reminderId: z.string().min(1),
    })
    .strict(),
]);

export const scheduleSchema = z
  .object({
    scheduleId: z.string().min(1),
    revision: z.number().int().positive(),
    message: z.string().min(1).max(12_000),
    timing: scheduleTimingSchema,
    enabled: z.boolean(),
    source: scheduleSourceSchema,
    nextRunAt: utcInstantSchema.nullable(),
    createdAt: utcInstantSchema,
    updatedAt: utcInstantSchema,
  })
  .strict();

/** POST `/api/v1/schedules`. `idempotencyKey` identifies the logical create, including retries. */
export const scheduleCreateRequestSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    message: z.string().min(1).max(12_000),
    timing: scheduleTimingInputSchema,
    enabled: z.boolean().default(true),
  })
  .strict();
export const scheduleCreateResponseSchema = z.object({ schedule: scheduleSchema, replayed: z.boolean() }).strict();

const scheduleChangesSchema = z
  .object({
    message: z.string().min(1).max(12_000).optional(),
    timing: scheduleTimingInputSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one change is required");
/** PATCH `/api/v1/schedules/:scheduleId`; stale revisions return typed `conflict`. */
export const schedulePatchRequestSchema = z
  .object({ expectedRevision: z.number().int().positive(), changes: scheduleChangesSchema })
  .strict();
export const schedulePatchResponseSchema = z.object({ schedule: scheduleSchema }).strict();
/** DELETE `/api/v1/schedules/:scheduleId`; retrying the acknowledged delete is safe. */
export const scheduleDeleteRequestSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const scheduleDeleteResponseSchema = z
  .object({ scheduleId: z.string().min(1), deleted: z.literal(true) })
  .strict();

export const scheduleListQuerySchema = z
  .object({ cursor: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).optional() })
  .strict();
export const scheduleListResponseSchema = z
  .object({ schedules: z.array(scheduleSchema).max(100), nextCursor: z.string().min(1).optional() })
  .strict();

export const scheduleErrorCodeSchema = z.enum([
  "validation",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "limit_exceeded",
  "unavailable",
  "internal",
]);
export const scheduleErrorSchema = z
  .object({
    error: z
      .object({ code: scheduleErrorCodeSchema, message: z.string().min(1).max(500), retryable: z.boolean() })
      .strict(),
  })
  .strict();

export const scheduledSessionCardSchema = z
  .object({
    sessionId: z.string().min(1),
    scheduleId: z.string().min(1),
    occurrenceId: z.string().min(1),
    intendedAt: utcInstantSchema,
    completedAt: utcInstantSchema,
    status: z.enum(["completed", "failed", "interrupted"]),
    preview: z.string().min(1).max(280).optional(),
  })
  .strict()
  .superRefine((card, ctx) => {
    if (card.status === "completed" && card.preview === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["preview"], message: "completed cards require a preview" });
    if (card.status !== "completed" && card.preview !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preview"],
        message: "non-completed cards use their safe status",
      });
  });
/** GET `/api/v1/scheduled-session-cards`; results are newest-first and have no read state. */
export const scheduledSessionCardQuerySchema = scheduleListQuerySchema;
export const scheduledSessionCardPageSchema = z
  .object({ cards: z.array(scheduledSessionCardSchema).max(100), nextCursor: z.string().min(1).optional() })
  .strict();

export type ScheduleTimingInput = z.infer<typeof scheduleTimingInputSchema>;
export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type ScheduleCreateRequest = z.infer<typeof scheduleCreateRequestSchema>;
export type SchedulePatchRequest = z.infer<typeof schedulePatchRequestSchema>;
export type ScheduleListResponse = z.infer<typeof scheduleListResponseSchema>;
export type ScheduleErrorCode = z.infer<typeof scheduleErrorCodeSchema>;
export type ScheduledSessionCard = z.infer<typeof scheduledSessionCardSchema>;
export type ScheduledSessionCardPage = z.infer<typeof scheduledSessionCardPageSchema>;
export const goldenScheduleWireFixtures = goldenScheduleFixtures;
