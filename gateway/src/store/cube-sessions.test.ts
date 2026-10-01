import { Database } from "bun:sqlite";
import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../access/capability.js";
import { cubePeriodStart } from "./cube-sessions.js";
import { ClosedSessionExecutionError, DeletedSessionError, openSessionStore } from "./session-store.js";

const root = mkdtempSync(join(tmpdir(), "cube-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function capability(): Capability {
  return { ownerUserId: "u_cube", role: "adult", resource: "session-store", rootPath: join(root, String(sequence++)) };
}
function input(inputId: string, now = new Date(2026, 7, 1, 12).getTime(), expectedFence = 0) {
  return {
    inputId,
    now,
    expectedFence,
    dreamerHour: 3,
    entry: {
      kind: "user" as const,
      turnId: `turn-${inputId}`,
      replyId: null,
      createdAt: now,
      text: "synthetic",
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      cutoff: null,
      compactedThroughSeq: null,
    },
  };
}

it("mints only on input, retries across restart/rollover, pins latest actual session and leaves old execution open", () => {
  const cap = capability();
  let store = openSessionStore(cap);
  expect(store.listSessionsWithMetadata()).toEqual([]);
  expect(store.getCubeAdmissionFence()).toBe(0);
  const first = store.admitCubeInput(input("one"));
  if (first.status !== "accepted") throw new Error(first.status);
  expect(first.sessionId).toMatch(/^s_[0-9a-f]{32}$/);
  expect(store.getSession(first.sessionId)).toMatchObject({
    provenance: "cube",
    readOnly: true,
    currentPin: true,
    executionClosed: false,
  });
  const second = store.admitCubeInput(input("two"));
  expect(second).toMatchObject({ status: "accepted", sessionId: first.sessionId });
  store.close();
  store = openSessionStore(cap);
  const nextDay = new Date(2026, 7, 2, 3).getTime();
  expect(store.admitCubeInput(input("one", nextDay))).toMatchObject({
    status: "accepted",
    replayed: true,
    sessionId: first.sessionId,
  });
  expect(store.readSession(first.sessionId)).toHaveLength(2);
  const next = store.admitCubeInput(input("three", nextDay));
  if (next.status !== "accepted") throw new Error(next.status);
  expect(next.sessionId).not.toBe(first.sessionId);
  expect(store.getSession(first.sessionId)?.currentPin).toBe(false);
  expect(store.getSession(next.sessionId)?.currentPin).toBe(true);
  expect(store.getSessionExecutionStatus(first.sessionId)).toBe("open");
  // Delayed receipt time / clock rewind cannot switch the association back and fork a day.
  expect(store.admitCubeInput(input("delayed"))).toMatchObject({ status: "accepted", sessionId: next.sessionId });

  store.setTitle(first.sessionId, "synthetic", "user", 1);
  expect(store.getSession(first.sessionId)?.currentPin).toBe(false);
  expect(store.setScheduledProvenance?.(first.sessionId, "schedule", "occurrence", "time", "time")).toBe(false);
  const conflicting = input("one");
  conflicting.entry.text = "different synthetic";
  expect(store.admitCubeInput(conflicting)).toEqual({ status: "input-conflict" });
  store.close();
});

it("closure fences all writers and late mints across handles/restart; deletion never reuses old receipts or mint keys", () => {
  const cap = capability();
  const store = openSessionStore(cap);
  const late = openSessionStore(cap);
  const first = store.admitCubeInput(input("one"));
  if (first.status !== "accepted") throw new Error(first.status);
  const oldMintKey = `cube:${first.sessionId}`;
  expect(store.closeCubeExecutions("revoked")).toEqual([first.sessionId]);
  expect(late.getSessionExecutionStatus(first.sessionId)).toBe("closed");
  expect(late.admitCubeInput(input("late"))).toEqual({ status: "stale-fence" });
  expect(late.admitCubeInput(input("one", undefined, late.getCubeAdmissionFence()))).toEqual({ status: "closed" });
  const entry = { ...input("late").entry, sessionId: first.sessionId, pendingId: null };
  expect(() => late.append(entry)).toThrow(ClosedSessionExecutionError);
  expect(() => late.admitUserMessage({ ...entry, pendingId: "one" }, [], { maxAttachments: 0 })).toThrow(
    ClosedSessionExecutionError,
  );
  expect(store.readSession(first.sessionId)).toHaveLength(1);
  expect(store.getSession(first.sessionId)).toMatchObject({ currentPin: true, executionClosed: true });
  late.close();
  store.close();
  const reopened = openSessionStore(cap);
  expect(reopened.getSessionExecutionStatus(first.sessionId)).toBe("closed");
  const fresh = reopened.admitCubeInput(input("fresh", undefined, reopened.getCubeAdmissionFence()));
  if (fresh.status !== "accepted") throw new Error(fresh.status);
  expect(fresh.sessionId).not.toBe(first.sessionId);
  const beforeDelete = reopened.getCubeAdmissionFence();
  const db = new Database(join(cap.rootPath, "sessions.db"));
  db.exec(
    "CREATE TRIGGER reject_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END",
  );
  expect(() => reopened.deleteSession(fresh.sessionId)).toThrow("synthetic delete failure");
  expect(reopened.getCubeAdmissionFence()).toBe(beforeDelete);
  expect(reopened.getSessionExecutionStatus(fresh.sessionId)).toBe("open");
  expect(reopened.getSession(fresh.sessionId)?.currentPin).toBe(true);
  db.exec("DROP TRIGGER reject_delete");
  db.close();
  expect(reopened.deleteSession(fresh.sessionId).status).toBe("deleted");
  expect(reopened.admitCubeInput(input("queued", undefined, beforeDelete))).toEqual({ status: "stale-fence" });
  expect(reopened.admitCubeInput(input("fresh", undefined, reopened.getCubeAdmissionFence()))).toEqual({
    status: "deleted",
  });
  expect(reopened.getSession(first.sessionId)?.currentPin).toBe(true);
  expect(reopened.deleteSession(first.sessionId).status).toBe("deleted");
  expect(() => reopened.createSession("replacement", oldMintKey)).toThrow(DeletedSessionError);
  expect(() => reopened.append(entry)).toThrow(DeletedSessionError);
  expect(reopened.listSessionsWithMetadata()).toEqual([]);
  expect(reopened.getSessionExecutionStatus(first.sessionId)).toBe("deleted");
  expect(reopened.getSessionExecutionStatus("unknown")).toBe("absent");
  const fence = reopened.getCubeAdmissionFence();
  reopened.closeCubeExecutions("owner-changed");
  expect(reopened.admitCubeInput(input("preauthorization", undefined, fence))).toEqual({ status: "stale-fence" });
  reopened.close();
  const afterDelete = openSessionStore(cap);
  const currentFence = afterDelete.getCubeAdmissionFence();
  expect(afterDelete.admitCubeInput(input("fresh", undefined, currentFence))).toEqual({ status: "deleted" });
  const replacement = afterDelete.admitCubeInput(input("new-after-delete", undefined, currentFence));
  if (replacement.status !== "accepted") throw new Error(replacement.status);
  expect(replacement.sessionId).not.toBe(fresh.sessionId);
  expect(afterDelete.listSessionsWithMetadata()).toHaveLength(1);
  expect(afterDelete.getSession(replacement.sessionId)?.currentPin).toBe(true);
  afterDelete.close();
});

it("rolls back metadata, association and receipt when first append fails", () => {
  const cap = capability();
  const store = openSessionStore(cap);
  // Concrete SQLite failure after metadata creation, before receipt commit.
  const db = new Database(join(cap.rootPath, "sessions.db"));
  db.exec(
    "CREATE TRIGGER reject_cube_entry BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
  );
  expect(() => store.admitCubeInput(input("retry"))).toThrow("synthetic failure");
  expect(store.listSessionsWithMetadata()).toEqual([]);
  db.exec("DROP TRIGGER reject_cube_entry");
  expect(store.admitCubeInput(input("retry"))).toMatchObject({ status: "accepted", replayed: false });
  expect(store.listSessionsWithMetadata()).toHaveLength(1);
  db.close();
  store.close();
});

it("serializes competing first inputs from independent processes into one daily session", async () => {
  const cap = capability();
  const modulePath = new URL("./session-store.ts", import.meta.url).pathname;
  const workers = Array.from({ length: 6 }, (_, index) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `
    import { openSessionStore } from ${JSON.stringify(modulePath)};
    try {
    const store = openSessionStore(${JSON.stringify(cap)});
    const result = store.admitCubeInput(${JSON.stringify(input(index < 3 ? "retry" : `input-${index}`))});
    if (result.status !== "accepted") throw new Error(result.status);
    store.close();
    } catch (error) { console.error(String(error)); process.exitCode = 1; }
  `,
      ],
      { stdout: "inherit", stderr: "inherit" },
    ),
  );
  expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual([0, 0, 0, 0, 0, 0]);
  const store = openSessionStore(cap);
  const sessions = store.listSessionsWithMetadata();
  expect(sessions).toHaveLength(1);
  expect(store.readSession(sessions[0]?.sessionId ?? "missing")).toHaveLength(4);
  store.close();
});

it("uses dreamer local-hour boundaries through spring gap and repeated fall hour", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const period = (iso: string, hour: number) => new Date(cubePeriodStart(Date.parse(iso), hour)).toISOString();
    expect(period("2026-03-08T06:59:59.999Z", 2)).toBe("2026-03-07T07:00:00.000Z");
    expect(period("2026-03-08T07:00:00.000Z", 2)).toBe("2026-03-08T07:00:00.000Z");
    expect(period("2026-03-09T05:59:59.999Z", 2)).toBe("2026-03-08T07:00:00.000Z");
    expect(period("2026-03-09T06:00:00.000Z", 2)).toBe("2026-03-09T06:00:00.000Z");
    expect(period("2026-11-01T04:59:59.999Z", 1)).toBe("2026-10-31T05:00:00.000Z");
    expect(period("2026-11-01T05:00:00.000Z", 1)).toBe("2026-11-01T05:00:00.000Z");
    expect(period("2026-11-01T06:30:00.000Z", 1)).toBe("2026-11-01T05:00:00.000Z");
    expect(period("2026-11-02T06:00:00.000Z", 1)).toBe("2026-11-02T06:00:00.000Z");
    expect(() => cubePeriodStart(Date.now(), 24)).toThrow(RangeError);
  } finally {
    // biome-ignore lint/performance/noDelete: assigning undefined sets an environment string rather than removing it.
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
