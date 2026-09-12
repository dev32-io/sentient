import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpCatalog, OrchestratorConfig } from "@sentient/config";
import { describe, expect, it } from "vitest";
import { createAccessManager } from "../../access/access-manager.js";
import type { Capability } from "../../access/capability.js";
import { PrivateScheduleResource } from "../../access/private-schedule-resource.js";
import { createCalendarReminderScheduler } from "../../calendar/calendar-reminder-scheduler.js";
import { openCalendarPersistence } from "../../calendar/calendar-store.js";
import type { CalendarConfig } from "../../calendar/types.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import { createScheduleService } from "../../scheduling/service.js";
import { openSessionStore } from "../../store/session-store.js";
import type { McpClient } from "../../tools/mcp-client.js";
import { createToolBroker } from "../../tools/tool-broker.js";
import { type CalendarProductToolConfig, calendarProductToolProvider } from "./calendar-provider.js";

const brokerToolsConfig: OrchestratorConfig["tools"] = {
  foreground_timeout_ms: 30_000,
  max_concurrent_background_tasks: 1,
  background_completion_request_echo_chars: 240,
  max_tool_result_chars: 20_000,
};
const emptyMcp: McpClient = {
  async listTools() {
    return [];
  },
  async callTool() {
    throw new Error("no MCP calls expected");
  },
  async close() {},
};

const config: CalendarConfig = {
  query: { maxDays: 366, maxOccurrences: 100, pageSize: 100 },
  input: {
    maxTitleChars: 80,
    maxDescriptionChars: 200,
    maxQueryChars: 40,
    maxGroupChars: 20,
    maxTagChars: 20,
    maxTags: 8,
  },
  output: { maxResultChars: 5000 },
  recurrence: { maxOccurrences: 100, maxDays: 366 },
  nudge: { maxPerDay: 10 },
  defaultEventTimeZoneId: "UTC",
};

function cap(rootPath: string, resource: Capability["resource"], role: Capability["role"]): Capability {
  return { ownerUserId: "user" as Capability["ownerUserId"], resource, role, rootPath };
}
function harness(role: Capability["role"] = "adult", reminders?: CalendarProductToolConfig["reminders"]) {
  const root = mkdtempSync(join(tmpdir(), "calendar-tool-v2-"));
  const privateCap = cap(root, "calendar-private", role);
  const householdCap = cap(root, "calendar-household", role);
  const privatePersistence = openCalendarPersistence(privateCap, config);
  const householdPersistence = openCalendarPersistence(householdCap, config);
  const tools = new Map(
    calendarProductToolProvider
      .create({
        privatePersistence,
        householdPersistence,
        calendarConfig: config,
        privateCap,
        householdCap,
        ...(reminders ? { reminders } : {}),
      })
      .map((tool) => [tool.definition.name, tool]),
  );
  return {
    tools,
    close: () => {
      privatePersistence.close();
      householdPersistence.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function args(
  tool: ReturnType<typeof harness>["tools"] extends Map<string, infer T> ? T : never,
  value: Record<string, unknown>,
) {
  const validation = tool.validate?.(value);
  expect(validation).toBeNull();
}

const timed = "2026-01-01T10:00:00Z";
type SchemaShape = {
  type?: string;
  const?: string | boolean;
  pattern?: string;
  properties?: Record<string, SchemaShape>;
  required?: string[];
  enum?: string[];
  oneOf?: SchemaShape[];
};
type CalendarTool = ReturnType<typeof calendarProductToolProvider.create>[number];
function tool(h: ReturnType<typeof harness>, name: string): CalendarTool {
  const value = h.tools.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

describe("calendar V2 product tools", () => {
  it("publishes concise string schemas, stable tiers, and no legacy aliases", () => {
    const h = harness();
    try {
      expect([...h.tools.keys()]).toEqual([
        "calendar_list",
        "calendar_get",
        "calendar_search",
        "calendar_create",
        "calendar_update",
        "calendar_delete",
      ]);
      const create = tool(h, "calendar_create");
      const list = tool(h, "calendar_list");
      const search = tool(h, "calendar_search");
      const update = tool(h, "calendar_update");
      const createProperties = (create.definition.parameters as SchemaShape).properties ?? {};
      const listProperties = (list.definition.parameters as SchemaShape).properties ?? {};
      const searchParameters = search.definition.parameters as SchemaShape;
      const updateVariants = (update.definition.parameters as SchemaShape).oneOf ?? [];
      expect(create.definition.tier).toBe("write");
      expect(createProperties.start?.type).toBe("string");
      expect(createProperties.recurrence?.properties?.frequency?.enum).toEqual([
        "daily",
        "weekly",
        "monthly",
        "yearly",
      ]);
      expect(createProperties).not.toHaveProperty("notificationPolicy");
      expect(createProperties).not.toHaveProperty("rrule");
      expect(listProperties.scope?.enum).toEqual(["private", "household", "all"]);
      expect(searchParameters.required).toEqual(["query", "from", "to"]);
      expect(updateVariants).toHaveLength(3);
      expect(
        updateVariants.find((variant) => variant.properties?.applyTo?.const === "this_occurrence")?.required,
      ).toContain("originalStart");
      expect(
        updateVariants.find((variant) => variant.properties?.applyTo?.const === "entire_series")?.properties,
      ).not.toHaveProperty("originalStart");
      const createReminder = createProperties.reminder?.oneOf ?? [];
      expect(createReminder.some((variant) => variant.properties?.enabled?.const === false)).toBe(false);
      expect(
        createReminder.find((variant) => variant.properties?.mode?.const === "all-day")?.properties?.localTime?.pattern,
      ).toBe("^(?:[01]\\d|2[0-3]):[0-5]\\d$");
      const updateReminder = updateVariants[0]?.properties?.changes?.properties?.reminder?.oneOf ?? [];
      expect(updateReminder.some((variant) => variant.properties?.enabled?.const === false)).toBe(true);
      expect(create.validate?.({ title: "Appointment", start: timed, reminder: { enabled: false } })).toMatchObject({
        isError: true,
      });
    } finally {
      h.close();
    }
  });

  it("defaults create scope, visibility, importance, and tags at validation", async () => {
    const h = harness();
    try {
      const create = tool(h, "calendar_create");
      args(create, { title: "Breakfast", start: timed });
      const result = await create.run({ title: "Breakfast", start: timed }, { signal: new AbortController().signal });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toMatchObject({
        scope: "private",
        visibility: "everyone",
        importance: "normal",
        tags: [],
      });
    } finally {
      h.close();
    }
  });

  it("normalizes observed model reminder spellings before validation and mutation", async () => {
    const h = harness();
    try {
      const signal = new AbortController().signal;
      const create = tool(h, "calendar_create");
      const update = tool(h, "calendar_update");

      for (const reminder of [{ minutes: 0 }, { enabled: true, when: timed }]) {
        const input = { title: "Appointment", start: timed, reminder };
        expect(create.validate?.(input)).toBeNull();
        const created = await create.run(input, { signal });
        expect(created.isError).toBe(false);
        expect(JSON.parse(created.content).reminder).toMatchObject({ enabled: true, mode: "at-start" });
      }

      const created = await create.run({ title: "Updated appointment", start: timed }, { signal });
      const createdBody = JSON.parse(created.content) as { eventId: string; revision: number };
      for (const reminder of [{ offset_minutes: 0 }, { minutes_before: 15 }]) {
        const input = {
          eventId: createdBody.eventId,
          applyTo: "entire_series",
          expectedRevision: createdBody.revision,
          changes: { reminder },
        };
        expect(update.validate?.(input)).toBeNull();
        const updated = await update.run(input, { signal });
        expect(updated.isError).toBe(false);
        const body = JSON.parse(updated.content) as { revision: number };
        const fetched = await tool(h, "calendar_get").run({ eventId: createdBody.eventId }, { signal });
        expect(JSON.parse(fetched.content).reminder).toMatchObject(
          "minutes_before" in reminder ? { mode: "lead", leadMinutes: 15 } : { mode: "at-start" },
        );
        createdBody.revision = body.revision;
      }

      const mismatchedWhen = {
        title: "Appointment",
        start: timed,
        reminder: { enabled: true, when: "2026-01-01T11:00:00Z" },
      };
      expect(create.validate?.(mismatchedWhen)).toMatchObject({ isError: true });
      expect((await create.run(mismatchedWhen, { signal })).isError).toBe(true);
    } finally {
      h.close();
    }
  });

  it("requires bounded search and occurrence mutation scope", () => {
    const h = harness();
    try {
      const search = tool(h, "calendar_search");
      const update = tool(h, "calendar_update");
      expect(search.validate?.({ query: "x" })).toMatchObject({ isError: true });
      expect(JSON.parse(search.validate?.({ query: "x" })?.content ?? "{}")).toMatchObject({
        outcome: "error",
        code: "invalid_arguments",
      });
      expect(update.validate?.({ eventId: "e", applyTo: "this_occurrence", changes: { title: "x" } })).toMatchObject({
        isError: true,
      });
      expect(
        update.validate?.({ eventId: "e", applyTo: "entire_series", originalStart: timed, changes: { title: "x" } }),
      ).toMatchObject({ isError: true });
    } finally {
      h.close();
    }
  });

  it("denies child household writes before mutation work and cancels before work", async () => {
    const h = harness("child");
    try {
      const update = tool(h, "calendar_update");
      const denied = update.validate?.({
        eventId: "e",
        applyTo: "entire_series",
        scope: "household",
        changes: { title: "x" },
      });
      expect(denied).toMatchObject({ isError: true });
      expect(JSON.parse(denied?.content ?? "{}")).toMatchObject({ outcome: "error", code: "forbidden" });

      const controller = new AbortController();
      controller.abort();
      const result = await update.run(
        { eventId: "e", applyTo: "entire_series", changes: { title: "x" } },
        { signal: controller.signal },
      );
      expect(JSON.parse(result.content)).toMatchObject({ outcome: "error", code: "aborted" });
    } finally {
      h.close();
    }
  });

  it("broker creates one actor-linked lead reminder, preserves omission, disables explicitly, and reconciles idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "calendar-model-broker-"));
    const principal = createUserPrincipal("u_aaaaaaaa", "adult", "household-1");
    const accessManager = createAccessManager({ userDataRoot: root });
    const privateCap = accessManager.grant(principal, "calendar-private");
    const persistence = openCalendarPersistence(privateCap, config);
    const schedules = createScheduleService({ userDataRoot: root });
    const scheduleResource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
    const reminders = createCalendarReminderScheduler({ schedules, accessManager, calendarConfig: config });
    const sessionStore = openSessionStore(accessManager.grant(principal, "session-store"));
    const nativeTools = new Map(
      calendarProductToolProvider
        .create({ privatePersistence: persistence, calendarConfig: config, privateCap, reminders })
        .map((nativeTool) => [nativeTool.definition.name, nativeTool]),
    );
    let approvals = 0;
    const broker = createToolBroker({
      mcp: emptyMcp,
      catalog: {} as McpCatalog,
      store: sessionStore,
      capability: accessManager.grant(principal, "tool-broker"),
      sessionId: "session-calendar-model",
      backgroundTools: new Map(),
      nativeTools,
      config: brokerToolsConfig,
      toolPermissions: async () => ({ native: { calendar_create: "ask", calendar_update: "ask" } }),
      requestConfirm: async () => {
        approvals += 1;
        return true;
      },
    });
    const dispatch = (toolCallId: string, name: string, args: Record<string, unknown>) =>
      broker.dispatch({ toolCallId, name, args, signal: new AbortController().signal, turnId: "turn-calendar-model" });
    try {
      const invalid = await dispatch("call-invalid", "calendar_create", {
        title: "Appointment",
        start: "2030-01-01T10:00:00Z",
        reminder: { enabled: true, mode: "lead" },
      });
      expect("isError" in invalid && invalid.isError).toBe(true);
      expect(approvals).toBe(0);

      const created = await dispatch("call-create", "calendar_create", {
        title: "Appointment",
        start: "2030-01-01T10:00:00Z",
        reminder: { enabled: true, mode: "lead", leadMinutes: 15 },
      });
      expect("isError" in created && created.isError).toBe(false);
      if (!("content" in created)) throw new Error("missing create result");
      const event = JSON.parse(created.content) as {
        eventId: string;
        revision: number;
        reminder: { reminderId: string };
      };
      expect(event.reminder.reminderId).toBe(`${event.eventId}:${principal.userId}`);
      const events = await nativeTools
        .get("calendar_list")
        ?.run({ from: "2029-12-31T00:00:00Z", to: "2030-01-02T00:00:00Z" }, { signal: new AbortController().signal });
      expect(JSON.parse(events?.content ?? "[]")).toHaveLength(1);
      expect((await reminders.reconcile(persistence, event.eventId, "private")).ok).toBe(true);
      expect((await reminders.reconcile(persistence, event.eventId, "private")).ok).toBe(true);
      let listed = await schedules.list(scheduleResource, undefined, 20);
      expect(listed.ok && listed.value.schedules).toHaveLength(1);
      expect(listed.ok && listed.value.schedules[0]).toMatchObject({
        timing: { kind: "once", at: "2030-01-01T09:45:00.000Z" },
        source: { kind: "calendar-reminder", eventId: event.eventId, reminderId: event.reminder.reminderId },
      });

      const omitted = await dispatch("call-omit", "calendar_update", {
        eventId: event.eventId,
        applyTo: "entire_series",
        expectedRevision: event.revision,
        changes: { title: "Updated appointment" },
      });
      expect("isError" in omitted && omitted.isError).toBe(false);
      const fetched = await nativeTools
        .get("calendar_get")
        ?.run({ eventId: event.eventId }, { signal: new AbortController().signal });
      const afterOmission = JSON.parse(fetched?.content ?? "{}") as {
        revision: number;
        reminder: { enabled: boolean; reminderId: string };
      };
      expect(afterOmission.reminder).toMatchObject({ enabled: true, reminderId: event.reminder.reminderId });
      listed = await schedules.list(scheduleResource, undefined, 20);
      expect(listed.ok && listed.value.schedules).toHaveLength(1);

      const disabled = await dispatch("call-disable", "calendar_update", {
        eventId: event.eventId,
        applyTo: "entire_series",
        expectedRevision: afterOmission.revision,
        changes: { reminder: { enabled: false } },
      });
      expect("isError" in disabled && disabled.isError).toBe(false);
      listed = await schedules.list(scheduleResource, undefined, 20);
      expect(listed.ok && listed.value.schedules).toHaveLength(0);
      expect(approvals).toBe(3);
    } finally {
      await reminders.close();
      schedules.close();
      persistence.close();
      sessionStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports committed mutations successful when prompt reminder reconciliation fails", async () => {
    const reminders = {
      reconcile: async () => ({ ok: false as const, error: { code: "unavailable" as const, retryable: true } }),
      reconcilePending: async () => ({ ok: true as const, value: undefined }),
      async close() {},
    };
    const h = harness("adult", reminders);
    try {
      const signal = new AbortController().signal;
      const created = await tool(h, "calendar_create").run({ title: "Durable event", start: timed }, { signal });
      expect(created.isError).toBe(false);
      const eventId = JSON.parse(created.content).eventId as string;

      const updated = await tool(h, "calendar_update").run(
        { eventId, applyTo: "entire_series", changes: { title: "Updated durable event" } },
        { signal },
      );
      expect(updated.isError).toBe(false);

      const deleted = await tool(h, "calendar_delete").run({ eventId, applyTo: "entire_series" }, { signal });
      expect(deleted.isError).toBe(false);
    } finally {
      h.close();
    }
  });

  it("flattens nested reminder issues into bounded canonical guidance without echoing content or arbitrary keys", () => {
    const h = harness();
    try {
      const create = tool(h, "calendar_create");
      const canary = "calendar-secret-canary";
      const invalid = create.validate?.({
        title: canary,
        start: timed,
        reminder: { enabled: true, mode: "lead", [canary]: canary },
      });
      expect(invalid).toMatchObject({ isError: true });
      const body = JSON.parse(invalid?.content ?? "{}") as {
        issues?: Array<{ path: string; code: string }>;
        expected?: string;
      };
      expect(body.issues).toContainEqual({ path: "reminder.leadMinutes", code: "invalid_type" });
      expect(body.issues?.length).toBeLessThanOrEqual(8);
      expect(body.expected).toContain("leadMinutes");
      expect(body.expected).toContain("Only calendar_update");
      expect(invalid?.content).not.toContain("Invalid input");
      expect(invalid?.content).not.toContain(canary);
    } finally {
      h.close();
    }
  });
});
