import { z } from "zod";
import type { Capability } from "../../access/capability.js";
import type {
  StoredCalendarEvent,
  CalendarEventId,
  CalendarEventPatch,
  CalendarListWindow,
  CalendarScope,
  CalendarStore,
  CalendarTime,
  Occurrence,
} from "../../calendar/types.js";
import { parseRRule, wireCalendarTimeSchema, wireRRuleSchema } from "../../calendar/types.js";
import { isAdult } from "../../calendar/types.js";
import type { NativeToolRunner } from "../../tools/tool-broker.js";
import type { ToolResult } from "../../tools/tool-types.js";
import type { ProductToolProvider } from "../product-tool-providers.js";

const READ = "read" as const;
const WRITE = "write" as const;
const CONFIRM = "confirm" as const;
const schedulerFence =
  "This calendar stores durable dated/timed events only. Relative reminders (for example, 'remind me tomorrow morning'), recurring briefings (for example, '9am every Monday'), and interval reminders (for example, 'every 4h') belong to a future scheduler, not the calendar.";

export const CALENDAR_TOOL_SETTINGS = [
  { name: "calendar_list", description: `List durable dated/timed calendar events. ${schedulerFence}`, tier: READ },
  { name: "calendar_get", description: `Get one durable dated/timed calendar event. ${schedulerFence}`, tier: READ },
  { name: "calendar_search", description: `Search durable dated/timed calendar events. ${schedulerFence}`, tier: READ },
  {
    name: "calendar_create",
    description:
      "Create a durable dated/timed calendar event. Do not file relative reminders, recurring briefings, or interval reminders here; those belong to a future scheduler.",
    tier: WRITE,
  },
  {
    name: "calendar_update",
    description:
      "Update a durable dated/timed calendar event. Do not file relative reminders, recurring briefings, or interval reminders here; those belong to a future scheduler.",
    tier: WRITE,
  },
  {
    name: "calendar_delete",
    description:
      "Delete a durable dated/timed calendar event. Do not use the calendar for relative reminders, recurring briefings, or interval reminders; those belong to a future scheduler.",
    tier: CONFIRM,
  },
] as const;

export interface CalendarProductToolConfig extends Readonly<Record<string, unknown>> {
  readonly privateStore?: CalendarStore;
  readonly privateCap?: Capability;
  readonly householdStore?: CalendarStore;
  readonly householdCap?: Capability;
  // Transitional aliases for callers outside the bootstrap seam.
  readonly store?: CalendarStore;
  readonly calendarStore?: CalendarStore;
  readonly capability?: Capability;
  readonly cap?: Capability;
}

const time = wireCalendarTimeSchema;
const scope = z.enum(["private", "household"]);
const recurrenceSchema = z
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
  });
const eventFields = {
  title: z.string().min(1),
  description: z.string().optional(),
  start: time,
  end: time.optional(),
  recurrence: recurrenceSchema.optional(),
  visibility: z.enum(["everyone", "adults"]).default("everyone"),
  importance: z.enum(["normal", "important", "pinned"]).default("normal"),
  group: z.string().optional(),
  tags: z.array(z.string()).default([]),
  notificationPolicy: z.record(z.unknown()).optional(),
  scope,
};
const createSchema = z.object(eventFields).strict();
const updateSchema = z
  .object({
    id: z.string().min(1),
    scope: scope.optional(),
    patch: z.object(eventFields).partial().strict().or(z.object(eventFields).partial().strict()),
  })
  .strict();
const updateAlternativeSchema = z
  .object({ id: z.string().min(1), scope: scope.optional(), event: z.object(eventFields).partial().strict() })
  .strict();
const idSchema = z.object({ id: z.string().min(1), scope: scope.optional() }).strict();
const listSchema = z
  .object({
    from: time,
    to: time,
    scope: scope.optional(),
    group: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.enum(["normal", "important", "pinned"]).optional(),
  })
  .strict();
const searchSchema = z
  .object({
    query: z.string().min(1),
    scope: scope.optional(),
    from: time.optional(),
    to: time.optional(),
    group: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.enum(["normal", "important", "pinned"]).optional(),
  })
  .strict();

function defaultSearchWindows(): CalendarListWindow[] {
  // Search has no caller-supplied date bounds, but recurrence expansion still
  // needs a bounded window. Query both time kinds so timed events are included;
  // one-off events remain searchable across the supported wire date range.
  return [
    {
      from: { kind: "all-day", date: "0001-01-01" },
      to: { kind: "all-day", date: "9999-12-31" },
    },
    {
      from: { kind: "timed", instant: "0001-01-01T00:00:00.000Z" as never, timeZoneId: "UTC" as never },
      to: { kind: "timed", instant: "9999-12-31T23:59:59.999Z" as never, timeZoneId: "UTC" as never },
    },
  ];
}

function result(value: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(value), isError };
}
function failure(code: string, message: string): ToolResult {
  return result({ outcome: "error", code, message }, true);
}
function parse<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T | ToolResult {
  const p = schema.safeParse(args);
  return p.success ? p.data : failure("invalid-arguments", p.error.issues[0]?.message ?? "invalid arguments");
}
function wire(event: StoredCalendarEvent | Occurrence, scope: CalendarScope): Record<string, unknown> {
  const occurrence = "occurrenceId" in event ? event : undefined;
  return {
    id: occurrence?.occurrenceId ?? event.id,
    ...(occurrence ? { baseEventId: occurrence.baseEventId, occurrenceId: occurrence.occurrenceId, occurrenceStart: occurrence.occurrenceStart, ...(occurrence.occurrenceEnd !== undefined ? { occurrenceEnd: occurrence.occurrenceEnd } : {}) } : {}),
    scope,
    title: event.title,
    ...(event.description !== undefined ? { description: event.description } : {}),
    start: event.start,
    ...(event.end !== undefined ? { end: event.end } : {}),
    ...(event.recurrence !== undefined ? { recurrence: event.recurrence } : {}),
    ...(event.exdates !== undefined ? { exdates: event.exdates } : {}),
    ...(event.exceptions !== undefined ? { exceptions: event.exceptions } : {}),
    visibility: event.visibility,
    importance: event.importance,
    ...(event.group !== undefined ? { group: event.group } : {}),
    tags: [...event.tags],
    ...(event.notification !== undefined ? { notificationPolicy: event.notification } : {}),
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}
function storeFailure(error: string): ToolResult {
  return failure(error, `Calendar operation failed: ${error}.`);
}
function calendarTime(value: unknown): CalendarTime {
  return value as CalendarTime;
}
function validateRecurrence(value: { rrule: string; rule?: unknown } | undefined): ToolResult | null {
  if (!value) return null;
  const parsed = parseRRule(value.rrule);
  return parsed.ok ? null : failure("malformed-rrule", "The recurrence rule is malformed.");
}
const calendarTimeParameter = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["timed"] },
        instant: { type: "string", format: "date-time" },
        timeZoneId: { type: "string" },
      },
      required: ["kind", "instant", "timeZoneId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["all-day"] },
        date: { type: "string", format: "date" },
      },
      required: ["kind", "date"],
      additionalProperties: false,
    },
  ],
};
const recurrenceRuleParameter = {
  type: "object",
  properties: {
    freq: { type: "string", enum: ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] },
    interval: { type: "integer", minimum: 1 },
    count: { type: "integer", minimum: 1 },
    until: { type: "string", format: "date-time" },
    byDay: { type: "array", items: { type: "string", enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] } },
  },
  required: ["freq"],
  additionalProperties: false,
};
const recurrenceParameter = {
  type: "object",
  properties: { rrule: { type: "string" }, rule: recurrenceRuleParameter },
  required: ["rrule", "rule"],
  additionalProperties: false,
};
const visibilityParameter = { type: "string", enum: ["everyone", "adults"] };
const importanceParameter = { type: "string", enum: ["normal", "important", "pinned"] };
const scopeParameter = { type: "string", enum: ["private", "household"] };
const calendarEventParameters = {
  title: { type: "string" },
  description: { type: "string" },
  start: calendarTimeParameter,
  end: calendarTimeParameter,
  recurrence: recurrenceParameter,
  visibility: visibilityParameter,
  importance: importanceParameter,
  group: { type: "string" },
  tags: { type: "array", items: { type: "string" } },
  notificationPolicy: { type: "object", additionalProperties: true },
  scope: scopeParameter,
};
const patchParameter = { type: "object", properties: calendarEventParameters, additionalProperties: false };
const createParameters = {
  type: "object",
  properties: calendarEventParameters,
  required: ["title", "start", "scope"],
  additionalProperties: false,
};
const updateParameters = {
  type: "object",
  properties: {
    id: { type: "string" },
    scope: scopeParameter,
    patch: patchParameter,
    event: patchParameter,
  },
  required: ["id", "patch"],
  additionalProperties: false,
};
const listParameters = {
  type: "object",
  properties: {
    from: calendarTimeParameter,
    to: calendarTimeParameter,
    scope: scopeParameter,
    group: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    importance: importanceParameter,
  },
  required: ["from", "to"],
  additionalProperties: false,
};
const searchParameters = {
  type: "object",
  properties: {
    query: { type: "string" },
    scope: scopeParameter,
    from: calendarTimeParameter,
    to: calendarTimeParameter,
    group: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    importance: importanceParameter,
  },
  required: ["query"],
  additionalProperties: false,
};
const idParameters = {
  type: "object",
  properties: { id: { type: "string" }, scope: scopeParameter },
  required: ["id"],
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
    const privateStore = supplied.privateStore ?? supplied.store ?? supplied.calendarStore;
    const privateCap = supplied.privateCap ?? supplied.capability ?? supplied.cap;
    const householdStore = supplied.householdStore;
    const householdCap = supplied.householdCap;
    if (!privateStore || !privateCap) return [];

    type Target = { store: CalendarStore; capability: Capability; scope: CalendarScope };
    const privateTarget: Target = { store: privateStore, capability: privateCap, scope: "private" };
    const householdTarget: Target | null = householdStore && householdCap
      ? { store: householdStore, capability: householdCap, scope: "household" }
      : null;
    const targetFor = (requested?: CalendarScope): Target | null =>
      requested === "household" ? householdTarget : requested === "private" ? privateTarget : null;
    const targetsFor = (requested?: CalendarScope): Target[] => {
      const target = targetFor(requested);
      return target ? [target] : householdTarget ? [privateTarget, householdTarget] : [privateTarget];
    };
    const writeTargetsFor = (requested?: CalendarScope): Target[] =>
      targetsFor(requested).filter((target) => target.scope !== "household" || isAdult(target.capability.role));
    const scopeGate = (requested: CalendarScope | undefined): ToolResult | null =>
      requested !== undefined && !targetFor(requested)
        ? failure("forbidden", `The ${requested} calendar is unavailable.`)
        : null;
    const householdWriteBlocked = (tier: typeof READ | typeof WRITE | typeof CONFIRM, requested?: CalendarScope) =>
      tier !== READ && requested === "household" && householdCap && !isAdult(householdCap.role)
        ? failure("household-write-forbidden", "Only adult household members may write to the household calendar.")
        : null;
    const common =
      (tier: typeof READ | typeof WRITE | typeof CONFIRM, schema: z.ZodType<unknown>, recurrence = false) =>
      (args: Record<string, unknown>) => {
        const parsed = parse(schema, args);
        if (typeof parsed === "object" && parsed !== null && "content" in parsed) return parsed as ToolResult;
        const data = parsed as Record<string, unknown>;
        const requested = data.scope as CalendarScope | undefined;
        const gate = scopeGate(requested) ?? householdWriteBlocked(tier, requested);
        if (gate) return gate;
        if (recurrence && "recurrence" in data) {
          const invalid = validateRecurrence(data.recurrence as { rrule: string } | undefined);
          if (invalid) return invalid;
        }
        return null;
      };
    const runResult = (r: { ok: boolean; value?: unknown; error?: string }, eventScope: CalendarScope): ToolResult =>
      r.ok ? result(Array.isArray(r.value)
        ? r.value.map((e) => wire(e as StoredCalendarEvent, eventScope))
        : r.value && typeof r.value === "object" && "tags" in (r.value as object)
          ? wire(r.value as StoredCalendarEvent, eventScope) : r.value) : storeFailure(r.error ?? "io-error");

    return [
      runner("calendar_list", CALENDAR_TOOL_SETTINGS[0].description, READ, listParameters, common(READ, listSchema), async (args) => {
        const p = listSchema.parse(args);
        const results = targetsFor(p.scope).map(({ store, scope: eventScope }) => ({ result: store.list({ from: calendarTime(p.from), to: calendarTime(p.to), ...(p.group !== undefined ? { group: p.group } : {}), ...(p.tags !== undefined ? { tags: p.tags } : {}), ...(p.importance !== undefined ? { importance: p.importance } : {}) }), eventScope }));
        const failed = results.find(({ result }) => !result.ok);
        if (failed && !failed.result.ok) return storeFailure(failed.result.error);
        return result(results.flatMap(({ result: r, eventScope }) => r.ok ? r.value.map((e) => wire(e, eventScope)) : []));
      }),
      runner("calendar_get", CALENDAR_TOOL_SETTINGS[1].description, READ, idParameters, common(READ, idSchema), async (args) => {
        const p = idSchema.parse(args);
        for (const target of targetsFor(p.scope)) {
          const r = target.store.get(p.id as CalendarEventId);
          if (r.ok) return runResult(r, target.scope);
          if (r.error !== "not-found") return storeFailure(r.error);
        }
        return storeFailure("not-found");
      }),
      runner("calendar_search", CALENDAR_TOOL_SETTINGS[2].description, READ, searchParameters, common(READ, searchSchema), async (args) => {
        const p = searchSchema.parse(args); const q = p.query.toLowerCase();
        if ((p.from && !p.to) || (!p.from && p.to)) return failure("invalid-arguments", "from and to must be supplied together.");
        const windows: CalendarListWindow[] = p.from && p.to
          ? [{
              from: calendarTime(p.from),
              to: calendarTime(p.to),
            }]
          : defaultSearchWindows();
        const results = targetsFor(p.scope).flatMap(({ store, scope: eventScope }) => windows.map((window) => ({
          result: store.list({
            ...window,
            ...(p.group !== undefined ? { group: p.group } : {}),
            ...(p.tags !== undefined ? { tags: p.tags } : {}),
            ...(p.importance !== undefined ? { importance: p.importance } : {}),
          }),
          eventScope,
        })));
        const failed = results.find(({ result: searchResult }) => !searchResult.ok); if (failed && !failed.result.ok) return storeFailure(failed.result.error);
        const seen = new Set<string>();
        return result(results.flatMap(({ result: r, eventScope }) => r.ok ? r.value
          .filter((e) => `${e.title} ${e.description ?? ""}`.toLowerCase().includes(q))
          .filter((e) => { const key = `${eventScope}:${e.occurrenceId}`; if (seen.has(key)) return false; seen.add(key); return true; })
          .map((e) => wire(e, eventScope)) : []));
      }),
      runner("calendar_create", CALENDAR_TOOL_SETTINGS[3].description, WRITE, createParameters, common(WRITE, createSchema, true), async (args, ctx) => {
        if (ctx.signal.aborted) return failure("aborted", "The calendar operation was cancelled.");
        const p = createSchema.parse(args); const target = targetFor(p.scope)!;
        const now = new Date().toISOString() as StoredCalendarEvent["createdAt"];
        const event = { ...p, id: crypto.randomUUID() as CalendarEventId, createdAt: now, updatedAt: now, tags: new Set(p.tags), notification: p.notificationPolicy } as unknown as StoredCalendarEvent;
        return runResult(target.store.create(event), target.scope);
      }),
      runner("calendar_update", CALENDAR_TOOL_SETTINGS[4].description, WRITE, updateParameters, common(WRITE, updateSchema.or(updateAlternativeSchema), true), async (args, ctx) => {
        if (ctx.signal.aborted) return failure("aborted", "The calendar operation was cancelled.");
        const p = updateSchema.safeParse(args); const value = p.success ? p.data : updateAlternativeSchema.parse(args);
        const patch = ("patch" in value ? value.patch : value.event) as unknown as CalendarEventPatch;
        for (const target of writeTargetsFor(value.scope)) {
          if (ctx.signal.aborted) return failure("aborted", "The calendar operation was cancelled.");
          const r = target.store.update(value.id as CalendarEventId, { ...patch, ...(patch.tags ? { tags: new Set(patch.tags) } : {}) } as CalendarEventPatch);
          if (r.ok) return runResult(r, target.scope);
          if (r.error !== "not-found") return storeFailure(r.error);
        }
        return storeFailure("not-found");
      }),
      runner("calendar_delete", CALENDAR_TOOL_SETTINGS[5].description, CONFIRM, idParameters, common(CONFIRM, idSchema), async (args, ctx) => {
        if (ctx.signal.aborted) return failure("aborted", "The calendar operation was cancelled.");
        const p = idSchema.parse(args);
        for (const target of writeTargetsFor(p.scope)) {
          if (ctx.signal.aborted) return failure("aborted", "The calendar operation was cancelled.");
          const r = target.store.delete(p.id as CalendarEventId);
          if (r.ok) return result({ ok: true });
          if (r.error !== "not-found") return storeFailure(r.error);
        }
        return storeFailure("not-found");
      }),
    ];
  },
};
