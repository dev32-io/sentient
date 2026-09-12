import {
  type ScheduleCreateRequest,
  scheduleCreateRequestSchema,
  scheduleListQuerySchema,
  schedulePatchRequestSchema,
} from "@sentient/protocol";
import { z } from "zod";
import type { PrivateScheduleResource } from "../../access/private-schedule-resource.js";
import type { ScheduleCommands, SchedulingResult } from "../../scheduling/contracts.js";
import type { NativeToolRunner } from "../../tools/tool-broker.js";
import type { ToolResult } from "../../tools/tool-types.js";
import type { ProductToolProvider } from "../product-tool-providers.js";

const distinction =
  "Scheduled messages ask Sentient to start an ordinary future chat; they do not create real-world calendar events such as appointments.";
const cleanup =
  "A one-time entry runs once and is then cleaned up automatically by the gateway; recurring entries remain until deleted.";
export const SCHEDULED_MESSAGE_TOOL_SETTINGS = [
  {
    name: "scheduled_message_list",
    description: `View pending one-time and recurring messages and their next run. ${distinction}`,
    tier: "read",
  },
  {
    name: "scheduled_message_create",
    description: `Schedule a future chat, for example “chat about that in 30 minutes” (once-after) or “send me my daily news every morning” (daily recurring with a timezone). ${distinction} ${cleanup}`,
    tier: "write",
  },
  {
    name: "scheduled_message_edit",
    description: `Edit the message or timing of a one-time or recurring future chat. ${distinction} ${cleanup}`,
    tier: "write",
  },
  {
    name: "scheduled_message_pause",
    description: "Pause a recurring or pending one-time message without deleting it.",
    tier: "write",
  },
  {
    name: "scheduled_message_resume",
    description: "Resume a paused recurring or pending one-time message and calculate its next future run.",
    tier: "write",
  },
  { name: "scheduled_message_delete", description: `Delete a pending scheduled message. ${cleanup}`, tier: "confirm" },
] as const;

export interface ScheduledMessageProductToolConfig extends Readonly<Record<string, unknown>> {
  readonly schedules?: ScheduleCommands;
  readonly resource?: PrivateScheduleResource;
  readonly clock?: () => Date;
}

const timingDescription =
  "Choose once-at for one future instant, once-after for a relative delay resolved once when accepted, or recurring for daily/weekly/monthly local wall time. This schedules chat, not a calendar event.";
const localTimeParameter = {
  type: "string",
  pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$",
  description: "HH:mm local wall time",
};
const timeZoneParameter = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  description: "IANA timezone, e.g. America/Toronto; runtime validation checks the identifier",
};
const weekdayItems = {
  type: "string",
  enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
};
const recurringProperties = {
  kind: { const: "recurring" },
  localTime: localTimeParameter,
  timeZone: timeZoneParameter,
};
const timingParameters = {
  description: timingDescription,
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "once-at" },
        at: { type: "string", format: "date-time", description: "RFC 3339 instant with an explicit offset" },
      },
      required: ["kind", "at"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "once-after" },
        afterSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 31_536_000,
          description: "Positive delay resolved once at acceptance; e.g. 1800 means chat in 30 minutes",
        },
      },
      required: ["kind", "afterSeconds"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { ...recurringProperties, frequency: { const: "daily" } },
      required: ["kind", "frequency", "localTime", "timeZone"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...recurringProperties,
        frequency: { const: "weekly" },
        weekdays: { type: "array", items: weekdayItems, minItems: 1, maxItems: 7, uniqueItems: true },
      },
      required: ["kind", "frequency", "localTime", "timeZone", "weekdays"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ...recurringProperties,
        frequency: { const: "monthly" },
        dayOfMonth: { type: "integer", minimum: 1, maximum: 31 },
      },
      required: ["kind", "frequency", "localTime", "timeZone", "dayOfMonth"],
      additionalProperties: false,
    },
  ],
};
const createParameters = {
  type: "object",
  properties: {
    idempotencyKey: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Stable unique key for this logical create; reuse it only when retrying the same request",
    },
    message: {
      type: "string",
      minLength: 1,
      maxLength: 12_000,
      description:
        "The complete ordinary user instruction Sentient will submit later; do not rely on replaying this conversation",
    },
    timing: timingParameters,
    enabled: { type: "boolean" },
  },
  required: ["idempotencyKey", "message", "timing"],
  additionalProperties: false,
};
const changesParameters = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1, maxLength: 12_000 },
    timing: timingParameters,
    enabled: { type: "boolean" },
  },
  minProperties: 1,
  additionalProperties: false,
};
const editParameters = {
  type: "object",
  properties: {
    scheduleId: { type: "string", minLength: 1 },
    expectedRevision: { type: "integer", minimum: 1 },
    changes: changesParameters,
  },
  required: ["scheduleId", "expectedRevision", "changes"],
  additionalProperties: false,
};
const mutationParameters = {
  type: "object",
  properties: { scheduleId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 1 } },
  required: ["scheduleId", "expectedRevision"],
  additionalProperties: false,
};
const listParameters = {
  type: "object",
  properties: { cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } },
  additionalProperties: false,
};
const legacyOnceAfterTimingSchema = z.union([
  z.object({ type: z.literal("once_after"), seconds: z.number().int().positive() }).strict(),
  z
    .object({
      type: z.literal("once_after"),
      value: z.number().int().positive(),
      unit: z.enum(["second", "seconds", "minute", "minutes", "hour", "hours"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("once_after"),
      interval: z.number().int().positive(),
      unit: z.enum(["second", "seconds", "minute", "minutes", "hour", "hours"]),
    })
    .strict(),
]);
const legacyRecurringFieldsSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly"]),
    time: z.string().min(1),
    timezone: z.string().min(1),
    weekdays: z
      .array(z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]))
      .optional(),
    dayOfMonth: z.number().int().optional(),
  })
  .strict();
const legacyRecurringTimingSchema = z.union([
  legacyRecurringFieldsSchema.extend({ type: z.literal("recurring") }).strict(),
  legacyRecurringFieldsSchema,
  z.object({ recurring: legacyRecurringFieldsSchema }).strict(),
  z.object({ recurrence: legacyRecurringFieldsSchema }).strict(),
  z
    .object({
      daily: z.object({ time: z.string().min(1), timezone: z.string().min(1) }).strict(),
    })
    .strict(),
]);
const legacyTimingSchema = z.union([legacyOnceAfterTimingSchema, legacyRecurringTimingSchema]);
const legacyCreateSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    message: z.string().min(1).max(12_000),
    timing: legacyTimingSchema,
    enabled: z.boolean().default(true),
  })
  .strict();

function normalizeLegacyTiming(timing: z.infer<typeof legacyTimingSchema>): Record<string, unknown> {
  if ("type" in timing && timing.type === "once_after") {
    const amount = "seconds" in timing ? timing.seconds : "interval" in timing ? timing.interval : timing.value;
    const unit = "unit" in timing ? timing.unit : undefined;
    const afterSeconds =
      unit === "minute" || unit === "minutes"
        ? amount * 60
        : unit === "hour" || unit === "hours"
          ? amount * 3_600
          : amount;
    return { kind: "once-after", afterSeconds };
  }
  const recurring = "recurring" in timing ? timing.recurring : "recurrence" in timing ? timing.recurrence : timing;
  if ("daily" in recurring) {
    return {
      kind: "recurring",
      frequency: "daily",
      localTime: recurring.daily.time,
      timeZone: recurring.daily.timezone,
    };
  }
  const { frequency, time, timezone, weekdays, dayOfMonth } = recurring;
  return {
    kind: "recurring",
    frequency,
    localTime: time,
    timeZone: timezone,
    ...(weekdays === undefined ? {} : { weekdays }),
    ...(dayOfMonth === undefined ? {} : { dayOfMonth }),
  };
}

/** Some OpenAI-compatible providers emit learned timing spellings despite
 * receiving our canonical discriminated schema. Keep REST/KMP contracts strict,
 * but normalize only observed model shapes at this tool boundary before
 * authorization and execution. */
type CreateArgsResult =
  | { readonly ok: true; readonly value: ScheduleCreateRequest }
  | { readonly ok: false; readonly error: z.ZodError };

function parseCreateArgs(args: Record<string, unknown>): CreateArgsResult {
  const canonical = scheduleCreateRequestSchema.safeParse(args);
  if (canonical.success) return { ok: true, value: canonical.data };
  const legacy = legacyCreateSchema.safeParse(args);
  if (!legacy.success) return { ok: false, error: canonical.error };
  const normalized = scheduleCreateRequestSchema.safeParse({
    idempotencyKey: legacy.data.idempotencyKey,
    message: legacy.data.message,
    timing: normalizeLegacyTiming(legacy.data.timing),
    enabled: legacy.data.enabled,
  });
  return normalized.success ? { ok: true, value: normalized.data } : { ok: false, error: normalized.error };
}

const editSchema = z
  .object({
    scheduleId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    changes: schedulePatchRequestSchema.shape.changes,
  })
  .strict();
const mutationSchema = z
  .object({ scheduleId: z.string().min(1), expectedRevision: z.number().int().positive() })
  .strict();

function output<T>(result: SchedulingResult<T>): ToolResult {
  return result.ok
    ? { content: JSON.stringify(result.value ?? { deleted: true }), isError: false }
    : {
        content: JSON.stringify({ outcome: "error", code: result.error.code, retryable: result.error.retryable }),
        isError: true,
      };
}
function invalid(error?: z.ZodError): ToolResult {
  const issues: Array<{ path: string; code: string }> = [];
  const seen = new Set<string>();
  const pending = error ? [...error.issues] : [];
  while (pending.length > 0 && issues.length < 8) {
    const issue = pending.shift();
    if (!issue) break;
    if (issue.code === "invalid_union") {
      for (const unionError of issue.unionErrors) pending.push(...unionError.issues);
      continue;
    }
    const path = issue.path.map((part) => (typeof part === "number" ? "item" : part)).join(".") || "arguments";
    const key = `${path}:${issue.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ path, code: issue.code });
  }
  return {
    content: JSON.stringify({
      outcome: "error",
      code: "invalid_arguments",
      ...(issues.length > 0 ? { issues } : {}),
      expected:
        "Use canonical timing: once-at {at}, once-after {afterSeconds}, or recurring {frequency, localTime, timeZone}; weekly also requires weekdays and monthly also requires dayOfMonth.",
    }),
    isError: true,
  };
}
function runner(
  setting: (typeof SCHEDULED_MESSAGE_TOOL_SETTINGS)[number],
  parameters: Record<string, unknown>,
  run: NativeToolRunner["run"],
  validate?: NativeToolRunner["validate"],
): NativeToolRunner {
  return {
    definition: {
      ...setting,
      parameters,
      category: "foreground",
      productGroup: "scheduled",
      defaultExposure: "standard",
    },
    run,
    ...(validate ? { validate } : {}),
  };
}

export const scheduledMessageProductToolProvider: ProductToolProvider<"scheduled"> = {
  group: "scheduled",
  create(config) {
    const supplied = config as ScheduledMessageProductToolConfig;
    if (!supplied.schedules || !supplied.resource) return [];
    const commands = supplied.schedules;
    const resource = supplied.resource;
    const now = supplied.clock ?? (() => new Date());
    return [
      runner(SCHEDULED_MESSAGE_TOOL_SETTINGS[0], listParameters, async (args, ctx) => {
        if (ctx.signal.aborted) return invalid();
        const p = scheduleListQuerySchema.safeParse(args);
        if (!p.success) return invalid();
        return output(await commands.list(resource, p.data.cursor, p.data.limit ?? 50));
      }),
      runner(
        SCHEDULED_MESSAGE_TOOL_SETTINGS[1],
        createParameters,
        async (args, ctx) => {
          if (ctx.signal.aborted) return invalid();
          const request = parseCreateArgs(args);
          if (!request.ok) return invalid(request.error);
          return output(await commands.create(resource, request.value, now()));
        },
        (args) => {
          const request = parseCreateArgs(args);
          return request.ok ? null : invalid(request.error);
        },
      ),
      runner(
        SCHEDULED_MESSAGE_TOOL_SETTINGS[2],
        editParameters,
        async (args, ctx) => {
          if (ctx.signal.aborted) return invalid();
          const p = editSchema.safeParse(args);
          if (!p.success) return invalid(p.error);
          return output(
            await commands.patch(
              resource,
              p.data.scheduleId,
              { expectedRevision: p.data.expectedRevision, changes: p.data.changes },
              now(),
            ),
          );
        },
        (args) => {
          const parsed = editSchema.safeParse(args);
          return parsed.success ? null : invalid(parsed.error);
        },
      ),
      runner(SCHEDULED_MESSAGE_TOOL_SETTINGS[3], mutationParameters, async (args, ctx) => {
        if (ctx.signal.aborted) return invalid();
        const p = mutationSchema.safeParse(args);
        if (!p.success) return invalid();
        return output(
          await commands.patch(
            resource,
            p.data.scheduleId,
            { expectedRevision: p.data.expectedRevision, changes: { enabled: false } },
            now(),
          ),
        );
      }),
      runner(SCHEDULED_MESSAGE_TOOL_SETTINGS[4], mutationParameters, async (args, ctx) => {
        if (ctx.signal.aborted) return invalid();
        const p = mutationSchema.safeParse(args);
        if (!p.success) return invalid();
        return output(
          await commands.patch(
            resource,
            p.data.scheduleId,
            { expectedRevision: p.data.expectedRevision, changes: { enabled: true } },
            now(),
          ),
        );
      }),
      runner(SCHEDULED_MESSAGE_TOOL_SETTINGS[5], mutationParameters, async (args, ctx) => {
        if (ctx.signal.aborted) return invalid();
        const p = mutationSchema.safeParse(args);
        if (!p.success) return invalid();
        return output(await commands.delete(resource, p.data.scheduleId, p.data.expectedRevision));
      }),
    ];
  },
};
