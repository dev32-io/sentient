import { z } from "zod";
import type { Capability } from "../../access/capability.js";
import { createCalendarEvent, mutateCalendarEvent } from "../../calendar/calendar-mutations.js";
import { CalendarQueryService } from "../../calendar/calendar-query.js";
import type { CalendarReminderScheduler } from "../../calendar/calendar-reminder-scheduler.js";
import type { CalendarPersistence } from "../../calendar/calendar-store.js";
import {
  normalizeCalendarEventTimes,
  normalizeCalendarQuery,
  validateCalendarInputLimits,
} from "../../calendar/calendar-temporal.js";
import {
  type CalendarConfig,
  type CalendarMutationCommand,
  type CalendarReadScope,
  type CalendarScope,
  calendarOccurrenceChangesSchema,
  calendarReadScopeSchema,
  calendarRecurrenceInputSchema,
  calendarReminderEnabledInputSchema,
  calendarTimeInputSchema,
  calendarUpdateChangesSchema,
  calendarWriteScopeSchema,
} from "../../calendar/types.js";
import type { NativeToolRunner } from "../../tools/tool-broker.js";
import type { ToolResult } from "../../tools/tool-types.js";
import type { ProductToolProvider } from "../product-tool-providers.js";

const READ = "read" as const;
const WRITE = "write" as const;
const CONFIRM = "confirm" as const;
const schedulerFence =
  "This calendar stores durable dated/timed events only. Future assistant messages and standalone reminders belong to scheduled-message tools. An explicit event-plus-reminder request creates this event with one linked personal reminder, not a second independent schedule.";

export const CALENDAR_TOOL_SETTINGS = [
  { name: "calendar_list", description: `List durable dated/timed calendar events. ${schedulerFence}`, tier: READ },
  { name: "calendar_get", description: `Get one durable dated/timed calendar event. ${schedulerFence}`, tier: READ },
  { name: "calendar_search", description: `Search durable dated/timed calendar events. ${schedulerFence}`, tier: READ },
  {
    name: "calendar_create",
    description: `Create a durable dated/timed calendar event. ${schedulerFence}`,
    tier: WRITE,
  },
  {
    name: "calendar_update",
    description: `Update a durable dated/timed calendar event. ${schedulerFence}`,
    tier: WRITE,
  },
  {
    name: "calendar_delete",
    description: `Delete a durable dated/timed calendar event. ${schedulerFence}`,
    tier: CONFIRM,
  },
] as const;

export interface CalendarProductToolConfig extends Readonly<Record<string, unknown>> {
  /** V2 adapters use persistence handles and the shared domain services only. */
  readonly privatePersistence?: CalendarPersistence;
  readonly householdPersistence?: CalendarPersistence;
  readonly calendarConfig?: CalendarConfig;
  readonly queryService?: CalendarQueryService;
  readonly privateCap?: Capability;
  readonly householdCap?: Capability;
  readonly reminders?: CalendarReminderScheduler;
}

const time = calendarTimeInputSchema;
const readScope = calendarReadScopeSchema;
const writeScope = calendarWriteScopeSchema;
const filters = {
  group: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  importance: z.enum(["normal", "important", "pinned"]).optional(),
};

const listSchema = z.object({ from: time, to: time, scope: readScope.optional(), ...filters }).strict();
const searchSchema = z
  .object({ query: z.string().min(1), from: time, to: time, scope: readScope.optional(), ...filters })
  .strict();
const getSchema = z
  .object({ eventId: z.string().min(1), originalStart: time.optional(), scope: readScope.optional() })
  .strict();
const createSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    start: time,
    end: time.optional(),
    recurrence: calendarRecurrenceInputSchema.optional(),
    visibility: z.enum(["everyone", "adults"]).default("everyone"),
    importance: z.enum(["normal", "important", "pinned"]).default("normal"),
    group: z.string().min(1).optional(),
    tags: z.array(z.string()).default([]),
    reminder: calendarReminderEnabledInputSchema.optional(),
    scope: writeScope.optional(),
  })
  .strict();
const mutationTarget = {
  eventId: z.string().min(1),
  originalStart: time.optional(),
  expectedRevision: z.number().int().positive().optional(),
  scope: writeScope.optional(),
};
const updateSchemaBase = z.discriminatedUnion("applyTo", [
  z
    .object({ ...mutationTarget, applyTo: z.literal("this_occurrence"), changes: calendarOccurrenceChangesSchema })
    .strict(),
  z
    .object({ ...mutationTarget, applyTo: z.literal("this_and_following"), changes: calendarUpdateChangesSchema })
    .strict(),
  z.object({ ...mutationTarget, applyTo: z.literal("entire_series"), changes: calendarUpdateChangesSchema }).strict(),
]);
const deleteSchemaBase = z.discriminatedUnion("applyTo", [
  z.object({ ...mutationTarget, applyTo: z.literal("this_occurrence") }).strict(),
  z.object({ ...mutationTarget, applyTo: z.literal("this_and_following") }).strict(),
  z.object({ ...mutationTarget, applyTo: z.literal("entire_series") }).strict(),
]);
function validateMutationTarget(value: { applyTo: string; originalStart?: unknown }, ctx: z.RefinementCtx): void {
  if (value.applyTo === "entire_series" && value.originalStart !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["originalStart"],
      message: "must be omitted for entire_series",
    });
  }
  if (value.applyTo !== "entire_series" && value.originalStart === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["originalStart"],
      message: "is required for occurrence-scoped mutations",
    });
  }
}
const updateSchema = updateSchemaBase.superRefine(validateMutationTarget);
const deleteSchema = deleteSchemaBase.superRefine(validateMutationTarget);

const legacyMinuteReminderSchema = z.union([
  z.object({ minutes: z.number().int().min(0).max(43_200) }).strict(),
  z.object({ minutes_before: z.number().int().min(0).max(43_200) }).strict(),
  z.object({ offset_minutes: z.literal(0) }).strict(),
]);
const legacyWhenReminderSchema = z.object({ enabled: z.literal(true), when: z.string().min(1) }).strict();

function normalizeModelReminder(value: unknown, eventStart: unknown): unknown {
  const minuteReminder = legacyMinuteReminderSchema.safeParse(value);
  if (minuteReminder.success) {
    const minutes =
      "minutes" in minuteReminder.data
        ? minuteReminder.data.minutes
        : "minutes_before" in minuteReminder.data
          ? minuteReminder.data.minutes_before
          : minuteReminder.data.offset_minutes;
    return minutes === 0 ? { enabled: true, mode: "at-start" } : { enabled: true, mode: "lead", leadMinutes: minutes };
  }
  const whenReminder = legacyWhenReminderSchema.safeParse(value);
  if (whenReminder.success && typeof eventStart === "string" && whenReminder.data.when === eventStart) {
    return { enabled: true, mode: "at-start" };
  }
  return value;
}

/** Providers occasionally retain older reminder field names despite receiving
 * the canonical schema. Normalize only observed, unambiguous model-tool forms;
 * REST and shared calendar contracts remain strict. */
function parseCreateArgs(args: Record<string, unknown>): z.infer<typeof createSchema> | ToolResult {
  const canonical = createSchema.safeParse(args);
  if (canonical.success) return canonical.data;
  if (!("reminder" in args)) return invalidArguments(canonical.error);
  const normalized = createSchema.safeParse({
    ...args,
    reminder: normalizeModelReminder(args.reminder, args.start),
  });
  return normalized.success ? normalized.data : invalidArguments(normalized.error);
}

function parseUpdateArgs(args: Record<string, unknown>): z.infer<typeof updateSchema> | ToolResult {
  const canonical = updateSchema.safeParse(args);
  if (canonical.success) return canonical.data;
  const changes = args.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !("reminder" in changes)) {
    return invalidArguments(canonical.error);
  }
  const changeRecord = changes as Record<string, unknown>;
  const normalized = updateSchema.safeParse({
    ...args,
    changes: {
      ...changeRecord,
      reminder: normalizeModelReminder(changeRecord.reminder, changeRecord.start),
    },
  });
  return normalized.success ? normalized.data : invalidArguments(normalized.error);
}

function failure(code: string, message: string): ToolResult {
  return { content: JSON.stringify({ outcome: "error", code, message }), isError: true };
}
function aborted(): ToolResult {
  return failure("aborted", "The calendar operation was cancelled; retry it.");
}
const safeArgumentFields = new Set([
  "applyTo",
  "changes",
  "count",
  "description",
  "enabled",
  "end",
  "eventId",
  "expectedRevision",
  "frequency",
  "from",
  "group",
  "importance",
  "interval",
  "leadMinutes",
  "localTime",
  "mode",
  "originalStart",
  "query",
  "recurrence",
  "reminder",
  "scope",
  "start",
  "tags",
  "timeZone",
  "title",
  "to",
  "until",
  "visibility",
  "weekdays",
]);
function invalidArguments(error: z.ZodError): ToolResult {
  const issues: Array<{ path: string; code: string }> = [];
  const seen = new Set<string>();
  const pending = [...error.issues];
  while (pending.length > 0 && issues.length < 8) {
    const issue = pending.shift();
    if (!issue) break;
    if (issue.code === "invalid_union") {
      for (const unionError of issue.unionErrors) pending.push(...unionError.issues);
      continue;
    }
    const path =
      issue.path
        .map((part) => (typeof part === "number" ? "item" : safeArgumentFields.has(part) ? part : "field"))
        .join(".") || "arguments";
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
        "Use reminder {enabled:true,mode:'at-start'}, {enabled:true,mode:'lead',leadMinutes:15}, or for all-day events {enabled:true,mode:'all-day',localTime:'09:00',timeZone:'America/Toronto'}. Only calendar_update may use {enabled:false}. Occurrence-scoped mutations require originalStart; entire_series must omit it.",
    }),
    isError: true,
  };
}
function parse<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T | ToolResult {
  const parsed = schema.safeParse(args);
  return parsed.success ? parsed.data : invalidArguments(parsed.error);
}
function asResult(value: unknown, config: CalendarConfig): ToolResult {
  let content: string;
  try {
    content = JSON.stringify(value);
  } catch {
    return failure("io_error", "The calendar result could not be serialized; retry the request.");
  }
  if (content.length > config.output.maxResultChars) {
    return failure(
      "result_too_large",
      "The complete calendar result is too large. Narrow from/to or add scope, group, tags, or importance and retry.",
    );
  }
  return { content, isError: false };
}
function domainResult(
  value:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: { code: string; message: string } },
  config: CalendarConfig,
): ToolResult {
  return value.ok ? asResult(value.value, config) : failure(value.error.code, value.error.message);
}

const timeParameter = {
  type: "string",
  description: "YYYY, YYYY-MM, YYYY-MM-DD, or an RFC 3339 time with an offset",
};
const recurrenceParameter = {
  type: "object",
  properties: {
    frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
    interval: { type: "integer", minimum: 1 },
    weekdays: {
      type: "array",
      items: { type: "string", enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] },
    },
    count: { type: "integer", minimum: 1 },
    until: timeParameter,
  },
  required: ["frequency"],
  additionalProperties: false,
};
const visibilityParameter = { type: "string", enum: ["everyone", "adults"] };
const importanceParameter = { type: "string", enum: ["normal", "important", "pinned"] };
const readScopeParameter = { type: "string", enum: ["private", "household", "all"] };
const writeScopeParameter = { type: "string", enum: ["private", "household"] };
const filtersParameter = {
  group: { type: "string" },
  tags: { type: "array", items: { type: "string" } },
  importance: importanceParameter,
};
const reminderEnabledVariants = [
  {
    type: "object",
    properties: {
      enabled: { type: "boolean", enum: [true] },
      mode: { type: "string", enum: ["at-start"] },
    },
    required: ["enabled", "mode"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      enabled: { type: "boolean", enum: [true] },
      mode: { type: "string", enum: ["lead"] },
      leadMinutes: { type: "integer", minimum: 1, maximum: 43200 },
    },
    required: ["enabled", "mode", "leadMinutes"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      enabled: { type: "boolean", enum: [true] },
      mode: { type: "string", enum: ["all-day"] },
      localTime: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", description: "HH:mm" },
      timeZone: { type: "string", minLength: 1, description: "IANA timezone" },
    },
    required: ["enabled", "mode", "localTime", "timeZone"],
    additionalProperties: false,
  },
] as const;
const createReminderParameter = {
  description:
    "Optional acting-user reminder linked to this event. Omit it to create no reminder. Timed starts use {enabled:true,mode:'at-start'} or {enabled:true,mode:'lead',leadMinutes:15}; date-only/all-day starts require {enabled:true,mode:'all-day',localTime:'09:00',timeZone:'America/Toronto'}.",
  anyOf: reminderEnabledVariants,
};
const updateReminderParameter = {
  description:
    "Optional acting-user reminder change. Omit to preserve it; use {enabled:false} to remove it. Timed starts use {enabled:true,mode:'at-start'} or {enabled:true,mode:'lead',leadMinutes:15}; date-only/all-day starts require {enabled:true,mode:'all-day',localTime:'09:00',timeZone:'America/Toronto'}.",
  anyOf: [
    ...reminderEnabledVariants,
    {
      type: "object",
      properties: { enabled: { type: "boolean", enum: [false] } },
      required: ["enabled"],
      additionalProperties: false,
    },
  ],
};
const changesParameter = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    start: timeParameter,
    end: timeParameter,
    recurrence: recurrenceParameter,
    visibility: visibilityParameter,
    importance: importanceParameter,
    group: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    reminder: updateReminderParameter,
  },
  additionalProperties: false,
};
const createParameters = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    start: timeParameter,
    end: timeParameter,
    recurrence: recurrenceParameter,
    visibility: visibilityParameter,
    importance: importanceParameter,
    group: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    reminder: createReminderParameter,
    scope: writeScopeParameter,
  },
  required: ["title", "start"],
  additionalProperties: false,
};
const listParameters = {
  type: "object",
  properties: { from: timeParameter, to: timeParameter, scope: readScopeParameter, ...filtersParameter },
  required: ["from", "to"],
  additionalProperties: false,
};
const searchParameters = {
  type: "object",
  properties: {
    query: { type: "string" },
    from: timeParameter,
    to: timeParameter,
    scope: readScopeParameter,
    ...filtersParameter,
  },
  required: ["query", "from", "to"],
  additionalProperties: false,
};
const getParameters = {
  type: "object",
  properties: { eventId: { type: "string" }, originalStart: timeParameter, scope: readScopeParameter },
  required: ["eventId"],
  additionalProperties: false,
};
const mutationTargetParameters = {
  eventId: { type: "string" },
  applyTo: {
    type: "string",
    enum: ["this_occurrence", "this_and_following", "entire_series"],
    description:
      "Choose this_occurrence or this_and_following with originalStart; choose entire_series without originalStart.",
  },
  originalStart: {
    ...timeParameter,
    description:
      "Required when applyTo is this_occurrence or this_and_following; must be omitted when applyTo is entire_series.",
  },
  expectedRevision: { type: "integer", minimum: 1 },
  scope: writeScopeParameter,
};
const updateParameters = {
  type: "object",
  properties: { ...mutationTargetParameters, changes: changesParameter },
  required: ["eventId", "applyTo", "changes"],
  additionalProperties: false,
};
const deleteParameters = {
  type: "object",
  properties: mutationTargetParameters,
  required: ["eventId", "applyTo"],
  additionalProperties: false,
};

function runner(
  name: string,
  description: string,
  tier: typeof READ | typeof WRITE | typeof CONFIRM,
  parameters: Record<string, unknown>,
  validate: NativeToolRunner["validate"],
  run: NativeToolRunner["run"],
): NativeToolRunner {
  return {
    definition: {
      name,
      description,
      parameters,
      category: "foreground",
      tier,
      productGroup: "calendar",
      defaultExposure: "standard",
    },
    ...(validate ? { validate } : {}),
    run,
  };
}

export const calendarProductToolProvider: ProductToolProvider<"calendar"> = {
  group: "calendar",
  create(config) {
    const supplied = config as CalendarProductToolConfig;
    const privatePersistence = supplied.privatePersistence;
    const privateCap = supplied.privateCap;
    const householdPersistence = supplied.householdPersistence;
    const householdCap = supplied.householdCap;
    const calendarConfig = supplied.calendarConfig;
    if (!privatePersistence || !privateCap || !calendarConfig) return [];

    type Target = { persistence: CalendarPersistence; capability: Capability; scope: CalendarScope };
    const privateTarget: Target = { persistence: privatePersistence, capability: privateCap, scope: "private" };
    const householdTarget: Target | undefined =
      householdPersistence && householdCap
        ? { persistence: householdPersistence, capability: householdCap, scope: "household" }
        : undefined;
    const target = (scope: CalendarScope | undefined): Target | undefined =>
      scope === "household" ? householdTarget : privateTarget;
    const query =
      supplied.queryService ??
      new CalendarQueryService({
        private: privatePersistence,
        ...(householdPersistence ? { household: householdPersistence } : {}),
        role: privateCap.role,
        config: calendarConfig,
      });

    const readScopeGate = (scope: CalendarReadScope | undefined): ToolResult | null => {
      if (scope === "household" && !householdTarget)
        return failure("forbidden", "The household calendar is unavailable.");
      if (scope === "all" && !householdTarget)
        return failure("forbidden", "The household calendar is unavailable for an all-scope read.");
      return null;
    };
    const writeGate = (scope: CalendarScope | undefined): ToolResult | null => {
      const selected = target(scope);
      if (!selected) return failure("forbidden", "The household calendar is unavailable.");
      if (selected.scope === "household" && !isAdultRole(selected.capability.role))
        return failure("forbidden", "Only adult household members may write to the household calendar.");
      return null;
    };
    const validateRead =
      (schema: z.ZodType<unknown>, preflight?: (value: Record<string, unknown>) => ToolResult | null) =>
      (args: Record<string, unknown>): ToolResult | null => {
        const parsed = parse(schema, args);
        if (isToolResult(parsed)) return parsed;
        const value = parsed as Record<string, unknown>;
        const gate = readScopeGate(value.scope as CalendarReadScope | undefined);
        return gate ?? preflight?.(value) ?? null;
      };
    const validateQuery = (value: Record<string, unknown>): ToolResult | null => {
      const checked = normalizeCalendarQuery(value, calendarConfig);
      return checked.ok ? null : failure(checked.error.code, checked.error.message);
    };
    const validateCreate = (value: Record<string, unknown>): ToolResult | null => {
      const limits = validateCalendarInputLimits(
        {
          title: value.title as string,
          ...(value.description !== undefined ? { description: value.description as string } : {}),
          ...(value.group !== undefined ? { group: value.group as string } : {}),
          tags: value.tags as string[],
        },
        calendarConfig,
      );
      if (!limits.ok) return failure(limits.error.code, limits.error.message);
      const times = normalizeCalendarEventTimes(value.start as never, value.end as never, calendarConfig, {
        recurring: value.recurrence !== undefined,
      });
      return times.ok ? null : failure(times.error.code, times.error.message);
    };
    const validateChanges = (value: Record<string, unknown>): ToolResult | null => {
      const changes = value.changes as Record<string, unknown>;
      const limits = validateCalendarInputLimits(
        {
          ...(changes.title !== undefined ? { title: changes.title as string } : {}),
          ...(changes.description !== undefined && changes.description !== null
            ? { description: changes.description as string }
            : {}),
          ...(changes.group !== undefined && changes.group !== null ? { group: changes.group as string } : {}),
          ...(changes.tags !== undefined ? { tags: changes.tags as string[] } : {}),
        },
        calendarConfig,
      );
      return limits.ok ? null : failure(limits.error.code, limits.error.message);
    };
    const validateWrite =
      (schema: z.ZodType<unknown>, preflight?: (value: Record<string, unknown>) => ToolResult | null) =>
      (args: Record<string, unknown>): ToolResult | null => {
        const parsed = parse(schema, args);
        if (isToolResult(parsed)) return parsed;
        const value = parsed as Record<string, unknown>;
        const gate = writeGate(value.scope as CalendarScope | undefined);
        return gate ?? preflight?.(value) ?? null;
      };
    const validateParsedWrite =
      <T extends Record<string, unknown>>(
        parser: (args: Record<string, unknown>) => T | ToolResult,
        preflight?: (value: Record<string, unknown>) => ToolResult | null,
      ) =>
      (args: Record<string, unknown>): ToolResult | null => {
        const parsed = parser(args);
        if (isToolResult(parsed)) return parsed;
        const gate = writeGate(parsed.scope as CalendarScope | undefined);
        return gate ?? preflight?.(parsed) ?? null;
      };

    return [
      runner(
        "calendar_list",
        CALENDAR_TOOL_SETTINGS[0].description,
        READ,
        listParameters,
        validateRead(listSchema, validateQuery),
        async (args, ctx) => {
          if (ctx.signal.aborted) return aborted();
          const parsed = parse(listSchema, args);
          if (isToolResult(parsed)) return parsed;
          const p = parsed as z.infer<typeof listSchema>;
          const gate = readScopeGate(p.scope);
          if (gate) return gate;
          const result = query.listComplete(
            {
              from: p.from,
              to: p.to,
              scope: p.scope ?? "private",
              ...(p.group !== undefined ? { group: p.group } : {}),
              ...(p.tags !== undefined ? { tags: p.tags } : {}),
              ...(p.importance !== undefined ? { importance: p.importance } : {}),
            },
            { signal: ctx.signal },
          );
          return ctx.signal.aborted ? aborted() : domainResult(result, calendarConfig);
        },
      ),
      runner(
        "calendar_get",
        CALENDAR_TOOL_SETTINGS[1].description,
        READ,
        getParameters,
        validateRead(getSchema),
        async (args, ctx) => {
          if (ctx.signal.aborted) return aborted();
          const parsed = parse(getSchema, args);
          if (isToolResult(parsed)) return parsed;
          const p = parsed as z.infer<typeof getSchema>;
          const gate = readScopeGate(p.scope);
          if (gate) return gate;
          const result = query.get(
            {
              eventId: p.eventId,
              scope: p.scope ?? "private",
              ...(p.originalStart !== undefined ? { originalStart: p.originalStart as never } : {}),
            },
            undefined,
            undefined,
            { signal: ctx.signal },
          );
          return ctx.signal.aborted ? aborted() : domainResult(result, calendarConfig);
        },
      ),
      runner(
        "calendar_search",
        CALENDAR_TOOL_SETTINGS[2].description,
        READ,
        searchParameters,
        validateRead(searchSchema, validateQuery),
        async (args, ctx) => {
          if (ctx.signal.aborted) return aborted();
          const parsed = parse(searchSchema, args);
          if (isToolResult(parsed)) return parsed;
          const p = parsed as z.infer<typeof searchSchema>;
          const gate = readScopeGate(p.scope);
          if (gate) return gate;
          const result = query.searchComplete(
            {
              query: p.query,
              from: p.from,
              to: p.to,
              scope: p.scope ?? "private",
              ...(p.group !== undefined ? { group: p.group } : {}),
              ...(p.tags !== undefined ? { tags: p.tags } : {}),
              ...(p.importance !== undefined ? { importance: p.importance } : {}),
            },
            { signal: ctx.signal },
          );
          return ctx.signal.aborted ? aborted() : domainResult(result, calendarConfig);
        },
      ),
      runner(
        "calendar_create",
        CALENDAR_TOOL_SETTINGS[3].description,
        WRITE,
        createParameters,
        validateParsedWrite(parseCreateArgs, validateCreate),
        async (args, ctx) => {
          if (ctx.signal.aborted) return aborted();
          const parsed = parseCreateArgs(args);
          if (isToolResult(parsed)) return parsed;
          const p = parsed;
          const gate = writeGate(p.scope);
          if (gate) return gate;
          const selected = target(p.scope);
          if (!selected) return failure("forbidden", "The household calendar is unavailable.");
          const result = createCalendarEvent(
            { ...p, scope: p.scope ?? "private" },
            { persistence: selected.persistence, config: calendarConfig, signal: ctx.signal },
          );
          if (result.ok && supplied.reminders) {
            // Mutation and reminder intent are already durable. Best-effort
            // prompt reconciliation must never turn committed success into a
            // retryable tool failure that can duplicate calendar mutations.
            await supplied.reminders
              .reconcile(selected.persistence, result.value.eventId, p.scope ?? "private")
              .catch(() => undefined);
          }
          return domainResult(result, calendarConfig);
        },
      ),
      runner(
        "calendar_update",
        CALENDAR_TOOL_SETTINGS[4].description,
        WRITE,
        updateParameters,
        validateParsedWrite(parseUpdateArgs, validateChanges),
        async (args, ctx) => {
          if (ctx.signal.aborted) return aborted();
          const parsed = parseUpdateArgs(args);
          if (isToolResult(parsed)) return parsed;
          const p = parsed;
          const gate = writeGate(p.scope);
          if (gate) return gate;
          const selected = target(p.scope);
          if (!selected) return failure("forbidden", "The household calendar is unavailable.");
          const command = { ...p, operation: "update", scope: p.scope ?? "private" } as CalendarMutationCommand;
          const result = mutateCalendarEvent(command, {
            persistence: selected.persistence,
            config: calendarConfig,
            signal: ctx.signal,
          });
          if (result.ok && supplied.reminders) {
            const ids = new Set(
              [
                p.eventId,
                result.value.eventId,
                "successorEventId" in result.value ? result.value.successorEventId : undefined,
              ].filter((id): id is string => Boolean(id)),
            );
            for (const id of ids) {
              const original = id === p.eventId && p.applyTo === "this_occurrence" ? p.originalStart : undefined;
              await supplied.reminders
                .reconcile(selected.persistence, id, p.scope ?? "private", undefined, original)
                .catch(() => undefined);
            }
          }
          return domainResult(result, calendarConfig);
        },
      ),
      runner(
        "calendar_delete",
        CALENDAR_TOOL_SETTINGS[5].description,
        CONFIRM,
        deleteParameters,
        validateWrite(deleteSchema),
        async (args, ctx) => {
          if (ctx.signal.aborted) return aborted();
          const parsed = parse(deleteSchema, args);
          if (isToolResult(parsed)) return parsed;
          const p = parsed as z.infer<typeof deleteSchema>;
          const gate = writeGate(p.scope);
          if (gate) return gate;
          const selected = target(p.scope);
          if (!selected) return failure("forbidden", "The household calendar is unavailable.");
          const command = { ...p, operation: "delete", scope: p.scope ?? "private" } as CalendarMutationCommand;
          const result = mutateCalendarEvent(command, {
            persistence: selected.persistence,
            config: calendarConfig,
            signal: ctx.signal,
          });
          if (result.ok && supplied.reminders) {
            await supplied.reminders
              .reconcile(
                selected.persistence,
                p.eventId,
                p.scope ?? "private",
                undefined,
                p.applyTo === "this_occurrence" ? p.originalStart : undefined,
              )
              .catch(() => undefined);
          }
          return domainResult(result, calendarConfig);
        },
      ),
    ];
  },
};

function isAdultRole(role: Capability["role"]): boolean {
  return role === "adult" || role === "admin";
}
function isToolResult(value: unknown): value is ToolResult {
  return (
    Boolean(value) && typeof value === "object" && "content" in (value as object) && "isError" in (value as object)
  );
}
