import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { CreateUserInput, UserProvisioner, UserSummary } from "../admin/user-provisioner.js";
import { getLog } from "../logging/logger.js";

/** The only household used by the calendar V2 E2E harness. */
export const CALENDAR_E2E_HOUSEHOLD_ID = "home";
/** Evidence is metadata-only; screenshots and traces are written by the harness. */
export const CALENDAR_E2E_EVIDENCE_ROOT = "qa/web/evidence/calendar-e2e";

const log = getLog(["sentient", "gateway", "calendar", "e2e"]);

type UserCreateResult = Awaited<ReturnType<UserProvisioner["createUser"]>>;
type UserDeleteResult = Awaited<ReturnType<UserProvisioner["deleteUser"]>>;

export interface CalendarE2EPaths {
  householdId: typeof CALENDAR_E2E_HOUSEHOLD_ID;
  privateCalendarDb: string;
  householdCalendarDb: string;
}

export interface DisposableCalendarUsers {
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

/** Derive both stores without opening them. CalendarStore owns creation/migration. */
export function calendarE2EPaths(userDataRoot: string, sharedDataRoot: string, userId: string): CalendarE2EPaths {
  const privateRoot = safeChild(userDataRoot, userId);
  const householdRoot = safeChild(sharedDataRoot, CALENDAR_E2E_HOUSEHOLD_ID);
  return {
    householdId: CALENDAR_E2E_HOUSEHOLD_ID,
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

/** Remove both private V2 databases and the shared V2 database. Safe to call repeatedly. */
export async function cleanupCalendarE2E(
  deps: CalendarE2EHelperDeps,
  users?: Pick<DisposableCalendarUsers, "adult" | "child">,
): Promise<CalendarCleanupReport> {
  const ids = users ? [users.adult.userId, users.child.userId] : [];
  const paths = ids.flatMap((id) => [calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, id).privateCalendarDb]);
  paths.push(safeChild(deps.sharedDataRoot, CALENDAR_E2E_HOUSEHOLD_ID, "calendar-v2", "calendar.db"));
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

  const adultResult: UserCreateResult = await deps.userProvisioner.createUser({ ...input.adult, role: "adult" });
  if (!adultResult.ok) throw new Error(`calendar E2E adult provisioning failed: ${adultResult.error}`);
  try {
    const childResult: UserCreateResult = await deps.userProvisioner.createUser({ ...input.child, role: "child" });
    if (!childResult.ok) throw new Error(`calendar E2E child provisioning failed: ${childResult.error}`);
    return {
      adult: adultResult.value,
      child: childResult.value,
      paths: {
        adult: calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, adultResult.value.userId),
        child: calendarE2EPaths(deps.userDataRoot, deps.sharedDataRoot, childResult.value.userId),
      },
    };
  } catch (error) {
    await cleanupCalendarE2E(deps, { adult: adultResult.value, child: adultResult.value });
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
