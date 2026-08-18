import { describe, expect, it } from "vitest";
import type { Capability } from "../../access/capability.js";
import type { CalendarStore } from "../../calendar/types.js";
import { calendarProductToolProvider } from "./calendar-provider.js";

function cap(resource: Capability["resource"], role: Capability["role"]): Capability {
  return { ownerUserId: "user" as Capability["ownerUserId"], resource, role, rootPath: "/tmp/calendar" };
}

function notFoundStore(overrides: Partial<CalendarStore> = {}): CalendarStore {
  return {
    get: () => ({ ok: false, error: "not-found" }),
    list: () => ({ ok: false, error: "not-found" }),
    create: () => ({ ok: false, error: "not-found" }),
    update: () => ({ ok: false, error: "not-found" }),
    delete: () => ({ ok: false, error: "not-found" }),
    close: () => {},
    ...overrides,
  } as CalendarStore;
}

function runners(role: Capability["role"], householdStore: CalendarStore) {
  const tools = calendarProductToolProvider.create({
    privateStore: notFoundStore(),
    privateCap: cap("calendar-private", role),
    householdStore,
    householdCap: cap("calendar-household", role),
  });
  return new Map(tools.map((tool) => [tool.definition.name, tool]));
}

const context = { signal: new AbortController().signal };

async function run(name: string, args: Record<string, unknown>, role: Capability["role"], householdStore: CalendarStore) {
  const tool = runners(role, householdStore).get(name);
  if (!tool) throw new Error(`missing ${name}`);
  const validation = tool.validate?.(args);
  if (validation) return validation;
  return tool.run(args, context);
}

describe("calendar product tool write routing", () => {
  for (const role of ["child", "guest"] as const) {
    it(`${role} omitted-scope update and delete never call the household store`, async () => {
      let updateCalls = 0;
      let deleteCalls = 0;
      const householdStore = notFoundStore({
        update: () => { updateCalls++; throw new Error("household update must not be called"); },
        delete: () => { deleteCalls++; throw new Error("household delete must not be called"); },
      });

      const update = await run("calendar_update", { id: "household-only", patch: { title: "changed" } }, role, householdStore);
      const remove = await run("calendar_delete", { id: "household-only" }, role, householdStore);
      expect(JSON.parse(update.content).code).toBe("not-found");
      expect(JSON.parse(remove.content).code).toBe("not-found");
      expect(updateCalls).toBe(0);
      expect(deleteCalls).toBe(0);
    });

    it(`${role} explicit household writes fail before any store call`, async () => {
      let calls = 0;
      const householdStore = notFoundStore({
        update: () => { calls++; throw new Error("unexpected update"); },
        delete: () => { calls++; throw new Error("unexpected delete"); },
      });
      const update = await run("calendar_update", { id: "id", scope: "household", patch: { title: "changed" } }, role, householdStore);
      const remove = await run("calendar_delete", { id: "id", scope: "household" }, role, householdStore);
      expect(JSON.parse(update.content).code).toBe("household-write-forbidden");
      expect(JSON.parse(remove.content).code).toBe("household-write-forbidden");
      expect(calls).toBe(0);
    });
  }
});
