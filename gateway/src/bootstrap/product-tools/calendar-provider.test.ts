import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capability } from "../../access/capability.js";
import { openCalendarPersistence } from "../../calendar/calendar-store.js";
import type { CalendarConfig } from "../../calendar/types.js";
import { type CalendarProductToolConfig, calendarProductToolProvider } from "./calendar-provider.js";

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
type SchemaShape = { type?: string; properties?: Record<string, SchemaShape>; required?: string[]; enum?: string[] };
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
      const updateProperties = (update.definition.parameters as SchemaShape).properties ?? {};
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
      expect(updateProperties).toHaveProperty("eventId");
      expect(updateProperties).not.toHaveProperty("id");
      expect(updateProperties).not.toHaveProperty("patch");
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

  it("aggregates paths without echoing supplied calendar content", () => {
    const h = harness();
    try {
      const create = tool(h, "calendar_create");
      const canary = "calendar-secret-canary";
      const invalid = create.validate?.({ title: canary, start: { kind: "timed", instant: canary } });
      expect(invalid).toMatchObject({ isError: true });
      expect(invalid?.content).toContain("start");
      expect(invalid?.content).not.toContain(canary);
    } finally {
      h.close();
    }
  });
});
