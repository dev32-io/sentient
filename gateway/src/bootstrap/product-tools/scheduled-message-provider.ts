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
const timingParameters = {
  description: timingDescription,
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "once-at" }, at: { type: "string", description: "RFC 3339 instant with offset" } },
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
      properties: {
        kind: { const: "recurring" },
        frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
        localTime: { type: "string", description: "HH:mm local wall time" },
        timeZone: { type: "string", description: "IANA timezone, e.g. America/Toronto" },
        weekdays: {
          type: "array",
          items: {
            type: "string",
            enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
          },
        },
        dayOfMonth: { type: "integer", minimum: 1, maximum: 31 },
      },
      required: ["kind", "frequency", "localTime", "timeZone"],
      additionalProperties: false,
    },
  ],
};
const createParameters = {
  type: "object",
  properties: {
    idempotencyKey: {
      type: "string",
      description: "Stable unique key for this logical create; reuse it only when retrying the same request",
    },
    message: {
      type: "string",
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
  properties: { message: { type: "string" }, timing: timingParameters, enabled: { type: "boolean" } },
  additionalProperties: false,
};
const editParameters = {
  type: "object",
  properties: {
    scheduleId: { type: "string" },
    expectedRevision: { type: "integer", minimum: 1 },
    changes: changesParameters,
  },
  required: ["scheduleId", "expectedRevision", "changes"],
  additionalProperties: false,
};
const mutationParameters = {
  type: "object",
  properties: { scheduleId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 } },
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
const legacyCreateSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    message: z.string().min(1).max(12_000),
    timing: legacyOnceAfterTimingSchema,
    enabled: z.boolean().default(true),
  })
  .strict();

function legacyDelaySeconds(timing: z.infer<typeof legacyOnceAfterTimingSchema>): number {
  const amount = "seconds" in timing ? timing.seconds : "interval" in timing ? timing.interval : timing.value;
  const unit = "unit" in timing ? timing.unit : undefined;
  if (unit === "minute" || unit === "minutes") return amount * 60;
  if (unit === "hour" || unit === "hours") return amount * 3_600;
  return amount;
}

/** Some OpenAI-compatible providers emit their learned `once_after` spelling
 * despite receiving our canonical `kind: once-after` schema. Keep REST/KMP
 * contracts strict, but normalize these observed model-only shapes at this
 * tool boundary before authorization and execution. */
function parseCreateArgs(args: Record<string, unknown>): ScheduleCreateRequest | null {
  const canonical = scheduleCreateRequestSchema.safeParse(args);
  if (canonical.success) return canonical.data;
  const legacy = legacyCreateSchema.safeParse(args);
  if (!legacy.success) return null;
  const afterSeconds = legacyDelaySeconds(legacy.data.timing);
  const normalized = scheduleCreateRequestSchema.safeParse({
    idempotencyKey: legacy.data.idempotencyKey,
    message: legacy.data.message,
    timing: { kind: "once-after", afterSeconds },
    enabled: legacy.data.enabled,
  });
  return normalized.success ? normalized.data : null;
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
function invalid(): ToolResult {
  return { content: JSON.stringify({ outcome: "error", code: "invalid_arguments" }), isError: true };
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
          if (!request) return invalid();
          return output(await commands.create(resource, request, now()));
        },
        (args) => (parseCreateArgs(args) ? null : invalid()),
      ),
      runner(SCHEDULED_MESSAGE_TOOL_SETTINGS[2], editParameters, async (args, ctx) => {
        if (ctx.signal.aborted) return invalid();
        const p = editSchema.safeParse(args);
        if (!p.success) return invalid();
        return output(
          await commands.patch(
            resource,
            p.data.scheduleId,
            { expectedRevision: p.data.expectedRevision, changes: p.data.changes },
            now(),
          ),
        );
      }),
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
