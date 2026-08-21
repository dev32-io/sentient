import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import {
  type CalendarE2EHelperDeps,
  assertLocalCalendarFixtureTarget,
  calendarE2EDirectory,
  calendarE2EPaths,
  cleanupCalendarE2E,
  cleanupLocalCalendarFixture,
  provisionCalendarE2E,
  provisionLocalCalendarFixture,
  teardownCalendarE2E,
  withCalendarE2E,
  withLocalCalendarFixture,
} from "./e2e-helpers.js";

const profile = { userId: "", schemaVersion: 1 } as ProfileV1;
const input = {
  adult: { displayName: "Adult", pin: "1234", profile },
  child: { displayName: "Child", pin: "5678", profile },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "calendar-e2e-"));
  const calls: string[] = [];
  let n = 0;
  const users = new Set<string>();
  const deps: CalendarE2EHelperDeps = {
    userDataRoot: join(root, "users"),
    sharedDataRoot: join(root, "shared"),
    userProvisioner: {
      createUser: async (value) => {
        const userId = `u_${++n}aaaaaaa`;
        users.add(userId);
        calls.push(`create:${value.role}:${userId}`);
        return {
          ok: true,
          value: {
            userId,
            displayName: value.displayName,
            role: value.role ?? "adult",
            isAdmin: false,
            avatarTint: "sage",
            createdAt: "now",
          },
        };
      },
      deleteUser: async (userId) => {
        calls.push(`delete:${userId}`);
        users.delete(userId);
        return { ok: true, value: undefined };
      },
    },
  };
  await mkdir(deps.userDataRoot, { recursive: true });
  await mkdir(deps.sharedDataRoot, { recursive: true });
  return { root, deps, calls, users };
}

describe("calendar E2E helpers", () => {
  it("provisions an adult and child and isolates their private database paths", async () => {
    const f = await fixture();
    try {
      const result = await provisionCalendarE2E(f.deps, input);
      expect(result.adult.role).toBe("adult");
      expect(result.child.role).toBe("child");
      expect(result.paths.adult.privateCalendarDb).not.toBe(result.paths.child.privateCalendarDb);
      expect(result.paths.adult.householdCalendarDb).toBe(result.paths.child.householdCalendarDb);
      expect(result.paths.adult.householdId).toBe("home");
      expect(f.calls.slice(0, 2).map((call) => call.split(":")[1])).toEqual(["adult", "child"]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("removes private and household databases, and is idempotent", async () => {
    const f = await fixture();
    try {
      const users = await provisionCalendarE2E(f.deps, input);
      for (const path of [
        users.paths.adult.privateCalendarDb,
        users.paths.child.privateCalendarDb,
        users.paths.adult.householdCalendarDb,
      ]) {
        await mkdir(join(path, ".."), { recursive: true });
        await Bun.write(path, "sqlite placeholder");
      }
      const first = await cleanupCalendarE2E(f.deps, users);
      const second = await cleanupCalendarE2E(f.deps, users);
      expect(first.failures).toHaveLength(0);
      expect(second.failures).toHaveLength(0);
      await expect(stat(users.paths.adult.privateCalendarDb)).rejects.toThrow();
      await expect(stat(users.paths.adult.householdCalendarDb)).rejects.toThrow();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("tears down all resources when the case fails, and repeated teardown is safe", async () => {
    const f = await fixture();
    try {
      const users = await provisionCalendarE2E(f.deps, input);
      await expect(
        withCalendarE2E(f.deps, input, async () => {
          throw new Error("case failed");
        }),
      ).rejects.toThrow("case failed");
      expect(f.calls.filter((call) => call.startsWith("delete:")).length).toBe(2);
      const report = await teardownCalendarE2E(f.deps, users);
      expect(report.failures).toHaveLength(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("uses a stable sanitized evidence directory and metadata-only evidence API", () => {
    expect(calendarE2EDirectory("run/one", "case secret")).toBe("qa/web/evidence/calendar-e2e/run_one/case_secret");
    expect(calendarE2EPaths("/tmp/users", "/tmp/shared", "u_abc12345").householdCalendarDb).toBe(
      "/tmp/shared/home/calendar-v2/calendar.db",
    );
  });

  it("fails closed for production and non-loopback fixture targets", () => {
    expect(() => assertLocalCalendarFixtureTarget("https://localhost/")).toThrow();
    expect(() => assertLocalCalendarFixtureTarget("http://gateway.example/")).toThrow();
    expect(() => assertLocalCalendarFixtureTarget("http://127.0.0.1:8799/")).not.toThrow();
    expect(() => assertLocalCalendarFixtureTarget("https://localhost/", { targetEnvironment: "local" })).not.toThrow();
  });

  it("seeds only sanitized IDs and always removes synthetic cases, users, and databases", async () => {
    const f = await fixture();
    const seeded: Array<{ case: string; eventId: string }> = [];
    const deleted: string[] = [];
    const deps = {
      ...f.deps,
      targetUrl: "http://127.0.0.1:8799",
      seedEvent: async (_principalId: string, event: { case: string }) => {
        const eventId = `event-${seeded.length + 1}`;
        seeded.push({ case: event.case, eventId });
        return { eventId, occurrenceIds: [`${eventId}@occurrence`] };
      },
      deleteEvent: async (_principalId: string, eventId: string) => {
        deleted.push(eventId);
      },
    };
    try {
      await withLocalCalendarFixture(deps, input, async (value) => {
        expect(value.adultId).toMatch(/^u_/);
        expect(value.childId).toMatch(/^u_/);
        expect(value.eventIds).toHaveLength(10);
        expect(value.cases["dense-day"]).toHaveLength(4);
        expect(JSON.stringify(value)).not.toContain("synthetic calendar evidence event");
        expect(JSON.stringify(value)).not.toContain("description");
      });
      expect(deleted).toHaveLength(10);
      expect(f.calls.filter((call) => call.startsWith("delete:")).length).toBe(2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("cleans a sanitized fixture returned for an external evidence runner", async () => {
    const f = await fixture();
    const deleted: string[] = [];
    let seededCount = 0;
    const deps = {
      ...f.deps,
      targetUrl: "http://localhost:8799",
      seedEvent: async () => ({ eventId: `event-${++seededCount}` }),
      deleteEvent: async (_principalId: string, eventId: string) => {
        deleted.push(eventId);
      },
    };
    try {
      const value = await provisionLocalCalendarFixture(deps, input);
      const report = await cleanupLocalCalendarFixture(deps, value);
      expect(report.eventFailures).toHaveLength(0);
      expect(report.userAndDatabase.failures).toHaveLength(0);
      expect(deleted).toHaveLength(10);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
