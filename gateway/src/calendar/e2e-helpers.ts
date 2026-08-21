import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { CreateUserInput, UserProvisioner, UserSummary } from "../admin/user-provisioner.js";
import { getLog } from "../logging/logger.js";

/** Evidence is metadata-only; screenshots and traces are written by the harness. */
export const CALENDAR_E2E_EVIDENCE_ROOT = "qa/web/evidence/calendar-e2e";

const log = getLog(["sentient", "gateway", "calendar", "e2e"]);

type UserCreateResult = Awaited<ReturnType<UserProvisioner["createUser"]>>;
type UserDeleteResult = Awaited<ReturnType<UserProvisioner["deleteUser"]>>;

export interface CalendarE2EPaths {
  /** Run-owned namespace; never the production/local household name. */
  householdId: string;
  privateCalendarDb: string;
  householdCalendarDb: string;
}

export interface DisposableCalendarUsers {
  /** Unique ownership boundary used for path cleanup and fixture identity. */
  runNamespace: string;
  adult: UserSummary;
  child: UserSummary;
  paths: { adult: CalendarE2EPaths; child: CalendarE2EPaths };
}

export interface CalendarE2EHelperDeps {
  userProvisioner: Pick<UserProvisioner, "createUser" | "deleteUser">;
  userDataRoot: string;
  sharedDataRoot: string;
  /** Injectable filesystem operations keep helper tests hermetic. */
  remove?: (path: string) => Promise<void>;
  makeDirectory?: (path: string) => Promise<void>;
}

export interface DisposableCalendarInput {
  adult: Omit<CreateUserInput, "role">;
  child: Omit<CreateUserInput, "role">;
}

export interface CalendarCleanupReport {
  removed: string[];
  failures: Array<{ path: string; reason: string }>;
}

function safeChild(root: string, ...parts: string[]): string {
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, ...parts);
  const rel = relative(rootPath, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("calendar E2E path escapes configured root");
  }
  return candidate;
}

/** Derive only run-owned stores without opening them. CalendarStore owns creation/migration. */
export function calendarE2EPaths(
  userDataRoot: string,
  sharedDataRoot: string,
  userId: string,
  runNamespace = `calendar-e2e-principal-${userId}`,
): CalendarE2EPaths {
  const privateRoot = safeChild(userDataRoot, userId);
  const householdRoot = safeChild(sharedDataRoot, runNamespace);
  return {
    householdId: runNamespace,
    privateCalendarDb: safeChild(privateRoot, "calendar-v2", "calendar.db"),
    householdCalendarDb: safeChild(householdRoot, "calendar-v2", "calendar.db"),
  };
}

async function removeOne(path: string, deps: CalendarE2EHelperDeps, report: CalendarCleanupReport): Promise<void> {
  try {
    await (deps.remove ?? ((target) => rm(target, { force: true })))(path);
    report.removed.push(path);
  } catch (error) {
    report.failures.push({ path, reason: error instanceof Error ? error.message : "filesystem error" });
    log.warn("cleanup.failed", { path, reason: "filesystem error" });
  }
}

/** Remove only databases owned by this run. The fixed local household store is
 * deliberately never touched; seeded household rows are deleted by ID. */
export async function cleanupCalendarE2E(
  deps: CalendarE2EHelperDeps,
  users?: Pick<DisposableCalendarUsers, "adult" | "child" | "runNamespace">,
): Promise<CalendarCleanupReport> {
  const paths = users
    ? [
        calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, users.adult.userId, users.runNamespace).privateCalendarDb,
        calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, users.child.userId, users.runNamespace).privateCalendarDb,
        calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, users.adult.userId, users.runNamespace).householdCalendarDb,
      ]
    : [];
  const report: CalendarCleanupReport = { removed: [], failures: [] };
  for (const path of new Set(paths)) await removeOne(path, deps, report);
  return report;
}

async function deleteUser(userId: string, deps: CalendarE2EHelperDeps): Promise<string | undefined> {
  try {
    const result: UserDeleteResult = await deps.userProvisioner.deleteUser(userId);
    return result.ok ? undefined : result.error;
  } catch {
    return "provisioner exception";
  }
}

/** Teardown is best-effort and idempotent: every database and user is attempted. */
export async function teardownCalendarE2E(
  deps: CalendarE2EHelperDeps,
  users: DisposableCalendarUsers,
): Promise<CalendarCleanupReport> {
  const report = await cleanupCalendarE2E(deps, users);
  for (const user of [users.adult, users.child]) {
    const failure = await deleteUser(user.userId, deps);
    if (failure) {
      report.failures.push({ path: `user:${user.userId}`, reason: failure });
      log.warn("teardown.user-failed", { userId: user.userId, reason: "provisioner failure" });
    }
  }
  return report;
}

/** Provision one adult and one child. A partial setup is rolled back. */
export async function provisionCalendarE2E(
  deps: CalendarE2EHelperDeps,
  input: DisposableCalendarInput,
): Promise<DisposableCalendarUsers> {
  await (deps.makeDirectory ?? (async (path: string) => mkdir(path, { recursive: true })))(deps.userDataRoot);
  await (deps.makeDirectory ?? (async (path: string) => mkdir(path, { recursive: true })))(deps.sharedDataRoot);

  const runNamespace = fixtureNamespace();
  const adultResult: UserCreateResult = await deps.userProvisioner.createUser({ ...input.adult, role: "adult" });
  if (!adultResult.ok) throw new Error(`calendar E2E adult provisioning failed: ${adultResult.error}`);
  try {
    const childResult: UserCreateResult = await deps.userProvisioner.createUser({ ...input.child, role: "child" });
    if (!childResult.ok) throw new Error(`calendar E2E child provisioning failed: ${childResult.error}`);
    return {
      runNamespace,
      adult: adultResult.value,
      child: childResult.value,
      paths: {
        adult: calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, adultResult.value.userId, runNamespace),
        child: calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, childResult.value.userId, runNamespace),
      },
    };
  } catch (error) {
    await cleanupCalendarE2E(deps, {
      runNamespace,
      adult: adultResult.value,
      child: adultResult.value,
    });
    await deleteUser(adultResult.value.userId, deps);
    throw error;
  }
}

/** Run a case with cleanup guaranteed even when the case throws. */
export async function withCalendarE2E<T>(
  deps: CalendarE2EHelperDeps,
  input: DisposableCalendarInput,
  run: (users: DisposableCalendarUsers) => Promise<T>,
): Promise<T> {
  const users = await provisionCalendarE2E(deps, input);
  try {
    return await run(users);
  } finally {
    await teardownCalendarE2E(deps, users);
  }
}

export interface EvidenceItem {
  id: string;
  sizeBytes: number;
  type: string;
}

/** `<root>/<runId>/<caseId>`; callers write only sanitized artifacts there. */
export function calendarE2EDirectory(runId: string, caseId: string, root = CALENDAR_E2E_EVIDENCE_ROOT): string {
  const segment = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(root, segment(runId), segment(caseId));
}

/** Log evidence metadata only—never file contents, prompts, or credentials. */
export function recordCalendarE2EEvidence(item: EvidenceItem): void {
  log.info("evidence", { id: item.id, sizeBytes: item.sizeBytes, type: item.type });
}

/** Supported synthetic cases for the local web/native calendar evidence run. */
export type CalendarFixtureCase =
  | "timed"
  | "all-day"
  | "recurring"
  | "dense-day"
  | "conflict"
  | "visibility"
  | "timezone";

export interface CalendarFixtureEvent {
  readonly case: CalendarFixtureCase;
  readonly scope: "private" | "household";
  readonly title: string;
  readonly description: string;
  readonly start: string;
  readonly end?: string;
  readonly visibility: "everyone" | "adults";
  readonly importance: "normal" | "important" | "pinned";
  readonly group: string;
  readonly tags: readonly string[];
  readonly recurrence?: {
    readonly frequency: "weekly";
    readonly interval: 1;
    readonly weekdays: readonly ["monday"];
    readonly count: 4;
  };
  readonly eventTimeZoneId?: string;
}

export interface CalendarFixtureSeedResult {
  readonly eventId: string;
  readonly occurrenceIds?: readonly string[];
}

/**
 * The fixture adapter is deliberately callback based. The web and later
 * native evidence runners can seed through their authenticated REST seam
 * without making fixture behavior part of the production API surface.
 */
export interface CalendarFixtureHelperDeps extends CalendarE2EHelperDeps {
  /** Must be a loopback target; HTTPS requires the explicit local marker below. */
  readonly targetUrl: string;
  readonly targetEnvironment?: "local";
  readonly seedEvent: (principalId: string, event: CalendarFixtureEvent) => Promise<CalendarFixtureSeedResult>;
  readonly deleteEvent: (principalId: string, eventId: string, scope: "private" | "household") => Promise<void>;
}

export interface CalendarFixtureEventReference {
  readonly eventId: string;
  readonly occurrenceIds: readonly string[];
  readonly scope: "private" | "household";
}

/** IDs only: no display names, PINs, event fields, or database paths cross this seam. */
export interface DisposableCalendarFixture {
  readonly runId: string;
  readonly adultId: string;
  readonly childId: string;
  readonly eventIds: readonly string[];
  readonly cases: Readonly<Record<CalendarFixtureCase, readonly CalendarFixtureEventReference[]>>;
}

export interface CalendarFixtureCleanupReport {
  readonly eventFailures: readonly { eventId: string; reason: string }[];
  readonly userAndDatabase: CalendarCleanupReport;
}

/**
 * Fail closed before a callback can reach a server. HTTPS localhost is not
 * accepted without an explicit `targetEnvironment: "local"` marker: the
 * production observational URL is also localhost. Plain HTTP loopback remains
 * convenient for direct local test servers.
 */
export function assertLocalCalendarFixtureTarget(
  targetUrl: string,
  options: { readonly targetEnvironment?: "local" | undefined } = {},
): void {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error("calendar fixture target must be a local HTTP URL");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  const localProtocol =
    parsed.protocol === "http:" || (parsed.protocol === "https:" && options.targetEnvironment === "local");
  if (!localProtocol || !loopback || parsed.username || parsed.password) {
    throw new Error("calendar fixture writes are allowed only on a local loopback target");
  }
}

function fixtureNamespace(): string {
  return `calendar-e2e-${crypto.randomUUID()}`;
}

function fixtureId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !/^[A-Za-z0-9._:@/-]+$/.test(value)) {
    throw new Error(`calendar fixture returned an invalid ${label}`);
  }
  return value;
}

function fixtureCases(
  cases: ReadonlyMap<CalendarFixtureCase, readonly CalendarFixtureEventReference[]>,
): Readonly<Record<CalendarFixtureCase, readonly CalendarFixtureEventReference[]>> {
  return {
    timed: cases.get("timed") ?? [],
    "all-day": cases.get("all-day") ?? [],
    recurring: cases.get("recurring") ?? [],
    "dense-day": cases.get("dense-day") ?? [],
    conflict: cases.get("conflict") ?? [],
    visibility: cases.get("visibility") ?? [],
    timezone: cases.get("timezone") ?? [],
  };
}

function fixtureEvents(namespace: string): readonly CalendarFixtureEvent[] {
  const day = "2026-08-24";
  const timed = (
    caseName: CalendarFixtureCase,
    hour: number,
    scope: "private" | "household" = "private",
  ): CalendarFixtureEvent => ({
    case: caseName,
    scope,
    title: `${namespace}-${caseName}`,
    description: "synthetic calendar evidence event",
    start: `${day}T${String(hour).padStart(2, "0")}:00:00Z`,
    end: `${day}T${String(hour + 1).padStart(2, "0")}:00:00Z`,
    visibility: "everyone",
    importance: "normal",
    group: "evidence",
    tags: ["calendar-evidence"],
  });
  return [
    timed("timed", 9),
    {
      case: "all-day",
      scope: "household",
      title: `${namespace}-all-day`,
      description: "synthetic calendar evidence event",
      start: day,
      visibility: "everyone",
      importance: "important",
      group: "evidence",
      tags: ["calendar-evidence"],
    },
    {
      case: "recurring",
      scope: "household",
      title: `${namespace}-recurring`,
      description: "synthetic calendar evidence event",
      start: `${day}T10:00:00Z`,
      end: `${day}T11:00:00Z`,
      visibility: "everyone",
      importance: "normal",
      group: "evidence",
      tags: ["calendar-evidence", "recurrence"],
      recurrence: { frequency: "weekly", interval: 1, weekdays: ["monday"], count: 4 },
    },
    timed("conflict", 12),
    { ...timed("visibility", 13, "household"), visibility: "adults", importance: "pinned" },
    {
      case: "timezone",
      scope: "private",
      title: `${namespace}-timezone`,
      description: "synthetic calendar evidence event",
      start: `${day}T15:00:00-04:00`,
      end: `${day}T16:00:00-04:00`,
      visibility: "everyone",
      importance: "normal",
      group: "evidence",
      tags: ["calendar-evidence", "timezone"],
      eventTimeZoneId: "America/Toronto",
    },
    ...[14, 15, 16, 17].map((hour) => timed("dense-day", hour, hour % 2 === 0 ? "private" : "household")),
  ];
}

/** Seed unique synthetic cases after provisioning; failed setup rolls back every resource. */
export async function provisionLocalCalendarFixture(
  deps: CalendarFixtureHelperDeps,
  input: DisposableCalendarInput,
): Promise<DisposableCalendarFixture> {
  assertLocalCalendarFixtureTarget(deps.targetUrl, { targetEnvironment: deps.targetEnvironment });
  const users = await provisionCalendarE2E(deps, input);
  if (users.adult.userId === users.child.userId) {
    await teardownCalendarE2E(deps, users);
    throw new Error("calendar fixture principals must be unique");
  }
  const runId = users.runNamespace;
  const seeded: Array<{ eventId: string; scope: "private" | "household" }> = [];
  const cases = new Map<CalendarFixtureCase, CalendarFixtureEventReference[]>();
  try {
    const adultId = fixtureId(users.adult.userId, "adult id");
    const childId = fixtureId(users.child.userId, "child id");
    for (const event of fixtureEvents(runId)) {
      const principalId = users.adult.userId;
      const result = await deps.seedEvent(principalId, event);
      const eventId = fixtureId(result?.eventId, "event id");
      const occurrenceIds = (result.occurrenceIds ?? []).map((id) => fixtureId(id, "occurrence id"));
      if (seeded.some((entry) => entry.eventId === eventId))
        throw new Error("calendar fixture event ids must be unique");
      seeded.push({ eventId, scope: event.scope });
      const current = cases.get(event.case) ?? [];
      current.push({ eventId, occurrenceIds, scope: event.scope });
      cases.set(event.case, current);
    }
    // Dense-day is intentionally represented by several independent event IDs;
    // the returned object remains IDs-only and deterministic for cleanup.
    return {
      runId,
      adultId,
      childId,
      eventIds: seeded.map(({ eventId }) => eventId),
      cases: fixtureCases(cases),
    };
  } catch (error) {
    await cleanupLocalCalendarFixture(deps, { users, seeded });
    throw error;
  }
}

async function cleanupSeededEvents(
  deps: CalendarFixtureHelperDeps,
  users: Pick<DisposableCalendarUsers, "adult">,
  seeded: readonly { eventId: string; scope: "private" | "household" }[],
): Promise<CalendarFixtureCleanupReport["eventFailures"]> {
  const failures: Array<{ eventId: string; reason: string }> = [];
  for (const event of [...seeded].reverse()) {
    try {
      await deps.deleteEvent(users.adult.userId, event.eventId, event.scope);
    } catch {
      // Callback errors may contain server text or payload details. Evidence
      // cleanup reports remain structural and content-free.
      failures.push({ eventId: event.eventId, reason: "event cleanup failed" });
    }
  }
  return failures;
}

/** Cleanup is idempotent and always attempts events, databases, and both users. */
export async function cleanupLocalCalendarFixture(
  deps: CalendarFixtureHelperDeps,
  value:
    | DisposableCalendarFixture
    | {
        readonly users: DisposableCalendarUsers;
        readonly seeded: readonly { eventId: string; scope: "private" | "household" }[];
      },
): Promise<CalendarFixtureCleanupReport> {
  assertLocalCalendarFixtureTarget(deps.targetUrl, { targetEnvironment: deps.targetEnvironment });
  const sanitizedUsers: DisposableCalendarUsers = "users" in value
    ? value.users
    : {
        runNamespace: value.runId,
        adult: { userId: value.adultId } as DisposableCalendarUsers["adult"],
        child: { userId: value.childId } as DisposableCalendarUsers["child"],
        paths: {
          adult: calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, value.adultId, value.runId),
          child: calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, value.childId, value.runId),
        },
      };
  const seeded =
    "seeded" in value
      ? value.seeded
      : Object.values(value.cases)
          .flat()
          .map((event) => ({ eventId: event.eventId, scope: event.scope }));
  const eventFailures = await cleanupSeededEvents(deps, sanitizedUsers, seeded);
  const userAndDatabase = await cleanupCalendarE2E(deps, sanitizedUsers);
  for (const userId of [sanitizedUsers.adult.userId, sanitizedUsers.child.userId]) {
    const failure = await deleteUser(userId, deps);
    if (failure) userAndDatabase.failures.push({ path: `user:${userId}`, reason: "user cleanup failed" });
  }
  return { eventFailures, userAndDatabase };
}

/** Preferred wrapper: the internal user handles never cross the return seam. */
export async function withLocalCalendarFixture<T>(
  deps: CalendarFixtureHelperDeps,
  input: DisposableCalendarInput,
  run: (fixture: DisposableCalendarFixture) => Promise<T>,
): Promise<T> {
  assertLocalCalendarFixtureTarget(deps.targetUrl, { targetEnvironment: deps.targetEnvironment });
  const users = await provisionCalendarE2E(deps, input);
  if (users.adult.userId === users.child.userId) {
    await teardownCalendarE2E(deps, users);
    throw new Error("calendar fixture principals must be unique");
  }
  const runId = users.runNamespace;
  const seeded: Array<{ eventId: string; scope: "private" | "household" }> = [];
  const cases = new Map<CalendarFixtureCase, CalendarFixtureEventReference[]>();
  try {
    const adultId = fixtureId(users.adult.userId, "adult id");
    const childId = fixtureId(users.child.userId, "child id");
    for (const event of fixtureEvents(runId)) {
      const result = await deps.seedEvent(users.adult.userId, event);
      const eventId = fixtureId(result?.eventId, "event id");
      const occurrenceIds = (result.occurrenceIds ?? []).map((id) => fixtureId(id, "occurrence id"));
      if (seeded.some((entry) => entry.eventId === eventId))
        throw new Error("calendar fixture event ids must be unique");
      seeded.push({ eventId, scope: event.scope });
      const current = cases.get(event.case) ?? [];
      current.push({ eventId, occurrenceIds, scope: event.scope });
      cases.set(event.case, current);
    }
    const fixture: DisposableCalendarFixture = {
      runId,
      adultId,
      childId,
      eventIds: seeded.map(({ eventId }) => eventId),
      cases: fixtureCases(cases),
    };
    return await run(fixture);
  } finally {
    await cleanupSeededEvents(deps, users, seeded);
    await teardownCalendarE2E(deps, users);
  }
}

export const createLocalCalendarFixture = provisionLocalCalendarFixture;
export const teardownLocalCalendarFixture = cleanupLocalCalendarFixture;
