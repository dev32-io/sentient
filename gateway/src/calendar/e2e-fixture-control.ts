#!/usr/bin/env bun
/**
 * Direct local-only fixture control for agent-driven Calendar E2E.
 *
 * This is not a test runner: it provisions/cleans the approved fixture through
 * the existing authenticated local REST controls and writes an IDs-only state
 * file. Maestro/Playwright remain directly owned by the E2E agent.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { profileV1Schema } from "../profile-store/profile-types.ts";
import {
  type CalendarFixtureEvent,
  type CalendarFixtureHelperDeps,
  type DisposableCalendarFixture,
  assertLocalCalendarFixtureTarget,
  calendarFixtureEvents,
  cleanupLocalCalendarFixture,
  provisionLocalCalendarFixture,
} from "./e2e-helpers.ts";

const fixtureReferenceSchema = z.object({
  eventId: z.string().min(1).max(256),
  occurrenceIds: z.array(z.string().min(1).max(256)),
  eventTags: z.array(z.string().regex(/^calendar-event-[a-f0-9]{24}$/)).optional(),
  scope: z.enum(["private", "household"]),
});

const occurrenceIdentitySchema = z.object({
  eventId: z.string().min(1).max(256),
  occurrenceId: z.string().min(1).max(256),
  originalStart: z.string().min(1).max(128),
  scope: z.enum(["private", "household"]),
});
const calendarPageSchema = z.object({
  body: z.object({
    events: z.array(occurrenceIdentitySchema),
    nextCursor: z.string().min(1).max(4096).nullable().optional(),
  }),
});

const RECOVERY_WINDOW = { from: "2026-07-26", to: "2026-09-06" } as const;
const fixtureSchema = z.object({
  runId: z.string().startsWith("calendar-e2e-").max(128),
  adultId: z.string().min(1).max(64),
  childId: z.string().min(1).max(64),
  eventIds: z.array(z.string().min(1).max(256)),
  cases: z.object({
    timed: z.array(fixtureReferenceSchema),
    "all-day": z.array(fixtureReferenceSchema),
    recurring: z.array(fixtureReferenceSchema),
    "dense-day": z.array(fixtureReferenceSchema),
    conflict: z.array(fixtureReferenceSchema),
    visibility: z.array(fixtureReferenceSchema),
    cache: z.array(fixtureReferenceSchema),
    recovery: z.array(fixtureReferenceSchema),
    temporal: z.array(fixtureReferenceSchema),
    timezone: z.array(fixtureReferenceSchema),
  }),
});

type LocalFetchInit = RequestInit & { tls?: { rejectUnauthorized: boolean } };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required local fixture input: ${name}`);
  return value;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function localFetch(target: string, path: string, init: RequestInit = {}): Promise<Response> {
  assertLocalCalendarFixtureTarget(target, { targetEnvironment: "local" });
  const url = new URL(path, target);
  const options: LocalFetchInit = { ...init };
  if (url.protocol === "https:") options.tls = { rejectUnauthorized: false };
  return fetch(url, options);
}

async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = z.union([
      z.object({ body: z.object({ code: z.string() }) }).transform((value) => value.body.code),
      z.object({ error: z.object({ code: z.string() }) }).transform((value) => value.error.code),
    ]).safeParse(body);
    throw new Error(
      `local fixture control failed with HTTP ${response.status}${code.success ? ` (${code.data})` : ""}`,
    );
  }
  return schema.parse(body);
}

const authSchema = z.object({ token: z.string().min(1), user: z.object({ userId: z.string().min(1) }).passthrough() });
const userSchema = z.object({
  user: z.object({
    userId: z.string().min(1),
    displayName: z.string(),
    role: z.enum(["admin", "adult", "child", "guest"]),
    isAdmin: z.boolean(),
    avatarTint: z.enum(["terra", "sage", "amber", "clay"]),
    createdAt: z.string(),
  }).passthrough(),
});
const calendarCreateSchema = z.object({ body: z.object({ eventId: z.string().min(1) }).passthrough() }).passthrough();

async function login(target: string, userId: string, pin: string): Promise<string> {
  const result = await json(
    await localFetch(target, "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, pin }),
    }),
    authSchema,
  );
  return result.token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function occurrenceTag(identity: z.infer<typeof occurrenceIdentitySchema>): string {
  const values = [identity.eventId, identity.occurrenceId, identity.originalStart, identity.scope.toUpperCase()];
  const stableKey = values.map((value) => `${value.length}:${value}`).join("");
  return `calendar-event-${createHash("sha256").update(stableKey).digest("hex").slice(0, 24)}`;
}

async function listRecoveryIdentities(
  target: string,
  token: string,
  eventId: string,
): Promise<readonly z.infer<typeof occurrenceIdentitySchema>[]> {
  const occurrences: z.infer<typeof occurrenceIdentitySchema>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ ...RECOVERY_WINDOW, scope: "all" });
    if (cursor) query.set("cursor", cursor);
    const result = await json(
      await localFetch(target, `/api/v1/calendar/events?${query}`, { headers: bearer(token) }),
      calendarPageSchema,
    );
    occurrences.push(...result.body.events.filter((event) => event.eventId === eventId));
    const next = result.body.nextCursor ?? undefined;
    if (!next) return occurrences;
    if (seen.has(next)) throw new Error("recovery fixture query returned a cursor loop");
    seen.add(next);
    cursor = next;
  }
  throw new Error("recovery fixture query exceeded its page bound");
}

function profileBody(profile: z.infer<typeof profileV1Schema>): Record<string, unknown> {
  const { userId: _userId, schemaVersion: _schemaVersion, ...body } = profile;
  // Reuse only valid local model/voice selections. Never copy the admin's
  // content or named permission overrides into disposable adult/child users;
  // the admin handler seeds each fixture principal from its own role.
  return {
    ...body,
    persona: { ...body.persona, overrides: "" },
    advanced: { ...body.advanced, extraSystemPrompt: "" },
    tools: { ...(body.tools.toolsets ? { toolsets: body.tools.toolsets } : {}) },
  };
}

async function dependencies(target: string): Promise<{
  deps: CalendarFixtureHelperDeps;
  profile: z.infer<typeof profileV1Schema>;
}> {
  const adminToken = await login(target, required("CALENDAR_E2E_ADMIN_USER_ID"), required("CALENDAR_E2E_ADMIN_PIN"));
  const profile = profileV1Schema.parse(
    await json(
      await localFetch(target, "/api/v1/profile/me", { headers: bearer(adminToken) }),
      profileV1Schema,
    ),
  );
  const adultPin = required("CALENDAR_E2E_ADULT_PIN");
  let adultId: string | null = null;
  let adultToken: string | null = null;
  const tokenForAdult = async (principalId: string): Promise<string> => {
    if (adultId !== principalId || adultToken === null) {
      adultId = principalId;
      adultToken = await login(target, principalId, adultPin);
    }
    return adultToken;
  };
  const deps: CalendarFixtureHelperDeps = {
    targetUrl: target,
    targetEnvironment: "local",
    // User deletion owns private profile/calendar paths; household fixture rows
    // are deleted explicitly by event ID. These roots are run-local metadata only.
    userDataRoot: resolve("/tmp/sentient-calendar-fixture-control/users"),
    sharedDataRoot: resolve("/tmp/sentient-calendar-fixture-control/shared"),
    makeDirectory: async (path) => { await mkdir(path, { recursive: true }); },
    remove: async (path) => { await rm(path, { force: true }); },
    userProvisioner: {
      createUser: async (input) => {
        const response = await localFetch(target, "/api/v1/admin/users", {
          method: "POST",
          headers: { ...bearer(adminToken), "content-type": "application/json" },
          body: JSON.stringify({
            displayName: input.displayName,
            pin: input.pin,
            role: input.role,
            profile: profileBody(profile),
          }),
        });
        if (!response.ok) return { ok: false as const, error: "io-error" as const };
        const result = userSchema.parse(await response.json());
        return { ok: true as const, value: result.user };
      },
      deleteUser: async (userId) => {
        const response = await localFetch(target, `/api/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: "DELETE",
          headers: bearer(adminToken),
        });
        return response.ok || response.status === 404
          ? { ok: true as const, value: undefined }
          : { ok: false as const, error: "io-error" as const };
      },
    },
    seedEvent: async (principalId: string, event: CalendarFixtureEvent) => {
      const token = await tokenForAdult(principalId);
      const { case: _case, eventTimeZoneId: _eventTimeZoneId, ...payload } = event;
      try {
        const result = await json(
          await localFetch(target, "/api/v1/calendar/events", {
            method: "POST",
            headers: { ...bearer(token), "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
          calendarCreateSchema,
        );
        return { eventId: result.body.eventId };
      } catch (error) {
        throw new Error(`fixture case ${_case} failed`, { cause: error });
      }
    },
    deleteEvent: async (principalId, eventId, scope) => {
      // A prior interrupted cleanup may already have removed the disposable
      // principal. Household cleanup can still use the local admin authority;
      // the archived private store then correctly reads as not found.
      const token = await tokenForAdult(principalId).catch(() => adminToken);
      const eventResponse = await localFetch(
        target,
        `/api/v1/calendar/events/${encodeURIComponent(eventId)}?scope=${scope}`,
        { headers: bearer(token) },
      );
      if (eventResponse.status === 404) return;
      const event = await json(
        eventResponse,
        z.object({ body: z.object({ revision: z.number().int().nonnegative() }).passthrough() }).passthrough(),
      );
      const response = await localFetch(target, `/api/v1/calendar/events/${encodeURIComponent(eventId)}/mutations`, {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({
          operation: "delete",
          eventId,
          applyTo: "entire_series",
          expectedRevision: event.body.revision,
          scope,
        }),
      });
      if (!response.ok && response.status !== 404) throw new Error("event cleanup failed");
    },
  };
  return { deps, profile };
}

async function readFixture(path: string): Promise<DisposableCalendarFixture> {
  return fixtureSchema.parse(JSON.parse(await readFile(path, "utf8"))) as DisposableCalendarFixture;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const target = argument("--target");
  const statePath = resolve(argument("--state"));
  assertLocalCalendarFixtureTarget(target, { targetEnvironment: "local" });
  const local = await dependencies(target);
  const deps = local.deps;

  if (command === "provision") {
    await stat(statePath).then(
      () => { throw new Error("fixture state file already exists"); },
      () => undefined,
    );
    const suffix = crypto.randomUUID().slice(0, 8);
    const value = await provisionLocalCalendarFixture(deps, {
      adult: {
        displayName: `Calendar Adult ${suffix}`,
        pin: required("CALENDAR_E2E_ADULT_PIN"),
        profile: local.profile,
      },
      child: {
        displayName: `Calendar Child ${suffix}`,
        pin: required("CALENDAR_E2E_CHILD_PIN"),
        profile: local.profile,
      },
    }, { deferredCases: ["recovery"] });
    try {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      await cleanupLocalCalendarFixture(deps, value);
      throw error;
    }
    process.stdout.write(`${statePath}\n`);
    return;
  }

  if (command === "seed-recovery") {
    const value = await readFixture(statePath);
    if (value.cases.recovery.length > 0) {
      process.stdout.write(`${statePath}\n`);
      return;
    }
    const event = calendarFixtureEvents(value.runId).find((candidate) => candidate.case === "recovery");
    if (!event) throw new Error("recovery fixture definition is unavailable");
    const seeded = await deps.seedEvent(value.adultId, event);
    let identities: readonly z.infer<typeof occurrenceIdentitySchema>[];
    try {
      const adultToken = await login(target, value.adultId, required("CALENDAR_E2E_ADULT_PIN"));
      identities = await listRecoveryIdentities(target, adultToken, seeded.eventId);
      if (identities.length !== 1 || identities[0]?.scope !== event.scope) {
        throw new Error("recovery fixture was not returned by the authenticated all-scope window query");
      }
    } catch (error) {
      await deps.deleteEvent(value.adultId, seeded.eventId, event.scope);
      throw error;
    }
    const reference = {
      eventId: seeded.eventId,
      occurrenceIds: identities.map((identity) => identity.occurrenceId),
      eventTags: identities.map(occurrenceTag),
      scope: event.scope,
    };
    const updated: DisposableCalendarFixture = {
      ...value,
      eventIds: [...value.eventIds, seeded.eventId],
      cases: { ...value.cases, recovery: [reference] },
    };
    const temporary = `${statePath}.tmp-${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx" });
      await rename(temporary, statePath);
    } catch (error) {
      await rm(temporary, { force: true });
      await deps.deleteEvent(value.adultId, seeded.eventId, event.scope);
      throw error;
    }
    process.stdout.write(`${statePath}\n`);
    return;
  }

  if (command === "verify-recovery") {
    const value = await readFixture(statePath);
    const reference = value.cases.recovery[0];
    if (!reference) throw new Error("recovery fixture has not been seeded");
    const adultToken = await login(target, value.adultId, required("CALENDAR_E2E_ADULT_PIN"));
    const identities = await listRecoveryIdentities(target, adultToken, reference.eventId);
    const occurrenceIds = identities.map((identity) => identity.occurrenceId).sort();
    const expectedIds = [...reference.occurrenceIds].sort();
    const eventTags = identities.map(occurrenceTag).sort();
    const expectedTags = [...(reference.eventTags ?? [])].sort();
    if (JSON.stringify(occurrenceIds) !== JSON.stringify(expectedIds) ||
        JSON.stringify(eventTags) !== JSON.stringify(expectedTags)) {
      throw new Error("recovery fixture identity changed in the authenticated all-scope window query");
    }
    process.stdout.write(`${statePath}\n`);
    return;
  }

  if (command === "cleanup") {
    const value = await readFixture(statePath);
    const report = await cleanupLocalCalendarFixture(deps, value);
    if (report.eventFailures.length > 0 || report.userAndDatabase.failures.length > 0) {
      throw new Error(
        `fixture cleanup did not settle (events=${report.eventFailures.length}, resources=${report.userAndDatabase.failures.length})`,
      );
    }
    await rm(statePath, { force: true });
    process.stdout.write(`${statePath}\n`);
    return;
  }

  throw new Error("usage: calendar:fixture <provision|seed-recovery|verify-recovery|cleanup> --target <loopback-url> --state <file>");
}

await main();
