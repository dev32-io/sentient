import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserRole } from "@sentient/protocol";
import { createAccessManager } from "../access/access-manager.js";
import { PrivateScheduleResource } from "../access/private-schedule-resource.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { TurnTerminalRecord } from "../runtime/session-runtime.js";
import type { DueClaim } from "../scheduling/contracts.js";
import { createScheduleService } from "../scheduling/service.js";
import type { SessionHandles } from "../session-handlers/session-registry.js";
import { createSessionRegistry } from "../session-handlers/session-registry.js";
import { openSessionStore } from "../store/session-store.js";
import { createScheduledExecutionAuthorizer, createScheduledMessageSubmitter } from "./executor.js";
import { createScheduledChatRunner } from "./runner.js";

const roots: string[] = [];
// The harness may schedule test cases concurrently. Per-test cleanup through a
// shared roots array can delete another still-running case's SQLite database,
// which Bun reports only as an unhandled error for every loaded test module.
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inertHandles(runtime: object): SessionHandles {
  return {
    runtime,
    work: {
      get isTurnInFlight() {
        return false;
      },
      hasPendingForegroundTool: false,
      hasOutstandingPrompt: false,
      hasAuxiliaryTaskInFlight: false,
      newestBackgroundTaskStartedAtMs: null,
    },
    dispose() {},
  } as unknown as SessionHandles;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "scheduled-executor-"));
  roots.push(root);
  const accessManager = createAccessManager({ userDataRoot: root });
  const principal = createUserPrincipal("u_aaaaaaaa", "adult", "actual-home");
  const resource = new PrivateScheduleResource(accessManager.grant(principal, "schedule-private"));
  const service = createScheduleService({
    userDataRoot: root,
    id: () => crypto.randomUUID(),
    clock: () => new Date("2026-08-01T15:02:00Z"),
  });
  return { root, accessManager, principal, resource, service };
}

async function createOneTime(service: ReturnType<typeof createScheduleService>, resource: PrivateScheduleResource) {
  const created = await service.create(
    resource,
    {
      idempotencyKey: crypto.randomUUID(),
      message: "Continue our conversation",
      enabled: true,
      timing: { kind: "once-at", at: "2026-08-01T15:00:00Z" },
    },
    new Date("2026-08-01T14:00:00Z"),
  );
  if (!created.ok) throw new Error("create failed");
  return created.value;
}

describe("scheduled chat consumer boundary", () => {
  test("reconciles the session commit after a finalization crash without allocating or appending twice", async () => {
    const { root, accessManager, principal, resource, service } = setup();
    const schedule = await createOneTime(service, resource);
    const registry = createSessionRegistry(() => {});
    let runtimeSubmissions = 0;
    let builtHandles: SessionHandles | undefined;
    let role: UserRole = "adult";
    const authorizedRoles: UserRole[] = [];
    const authorizer = createScheduledExecutionAuthorizer({
      users: {
        get: async () => ({
          ok: true as const,
          value: {
            userId: principal.userId,
            role,
            displayName: "A",
            pinHash: "test-only",
            avatarTint: "sage" as const,
            createdAt: "2026-01-01T00:00:00Z",
            credentialsValidFrom: "2026-01-01T00:00:00Z",
          },
        }),
      },
      accessManager,
      householdId: "actual-home",
    });
    const trackingAuthorizer = {
      async authorize(claim: DueClaim, signal: AbortSignal) {
        const result = await authorizer.authorize(claim, signal);
        if (result.ok) authorizedRoles.push(result.value.principal.role);
        return result;
      },
    };
    const submitter = createScheduledMessageSubmitter({
      accessManager,
      registry,
      associateSession: (claim, sessionId) => service.associateSession(claim, sessionId),
      settleStaleAssociation: (claim, completedAt) =>
        service.finalizeClaim(claim, { outcome: "expired", completedAt }, undefined),
      reauthorize: (claim, signal) => trackingAuthorizer.authorize(claim, signal),
      makeSessionId: () => "s_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now: () => new Date("2026-08-01T15:01:01Z"),
      buildHandles(current, sessionId) {
        const runtime = {
          userId: current.userId,
          running: false,
          async submitAndObserve(stimulus: { text: string; pendingId?: string }): Promise<TurnTerminalRecord> {
            runtimeSubmissions++;
            const store = openSessionStore(accessManager.grant(current, "session-store"));
            try {
              const turnId = "turn-original";
              if (!stimulus.pendingId || !store.setScheduledTurn?.(sessionId, stimulus.pendingId, turnId))
                throw new Error("missing provenance");
              store.append({
                sessionId,
                turnId,
                replyId: null,
                kind: "user",
                createdAt: 1,
                text: stimulus.text,
                toolCallId: null,
                toolName: null,
                toolArgs: null,
                cutoff: null,
                compactedThroughSeq: null,
                pendingId: stimulus.pendingId,
              });
              const answer = store.append({
                sessionId,
                turnId,
                replyId: "reply-1",
                kind: "assistant",
                createdAt: 2,
                text: "Saved response",
                toolCallId: null,
                toolName: null,
                toolArgs: null,
                cutoff: null,
                compactedThroughSeq: null,
                pendingId: null,
              });
              const terminal = {
                turnId,
                outcome: "completed" as const,
                completedAt: "2026-08-01T15:01:02.000Z",
                entryId: String(answer.seq),
              };
              store.recordScheduledTerminal?.(
                sessionId,
                turnId,
                terminal.outcome,
                terminal.completedAt,
                terminal.entryId,
              );
              return terminal;
            } finally {
              store.close();
            }
          },
          interrupt() {},
        };
        builtHandles = inertHandles(runtime);
        return builtHandles;
      },
    });

    let simulateCrash = true;
    const runner = createScheduledChatRunner({
      claims: service,
      authorizer: trackingAuthorizer,
      submitter,
      finalizer: {
        finalizeClaim: (claim, receipt, outbox) =>
          simulateCrash
            ? Promise.resolve({ ok: false as const, error: { code: "unavailable" as const, retryable: true } })
            : service.finalizeClaim(claim, receipt, outbox),
      },
      claimLimit: 1,
      leaseMs: 1_000,
      pollMs: 10,
      now: () => new Date(simulateCrash ? "2026-08-01T15:01:00Z" : "2026-08-01T15:01:02Z"),
    });

    expect((await runner.runOnce()).ok).toBe(false);
    expect(runtimeSubmissions).toBe(1);
    const sessionId = "s_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(registry.handlesFor(sessionId)).toBe(builtHandles ?? null);
    const fakeSocket = { data: { principal } } as never;
    registry.attach(sessionId, "connection-1", fakeSocket, () => {
      throw new Error("must reuse resident handles");
    });
    expect(registry.handlesFor(sessionId)).toBe(builtHandles ?? null);

    role = "child";
    simulateCrash = false;
    expect(await runner.runOnce()).toEqual({ ok: true, value: { claimed: 1, finalized: 1 } });
    expect(authorizedRoles).toEqual(["adult", "adult", "child"]);
    expect(runtimeSubmissions).toBe(1);

    const store = openSessionStore(accessManager.grant(principal, "session-store"));
    const metadata = store.getSession(sessionId);
    expect(store.readSession(sessionId).filter((entry) => entry.kind === "user")).toHaveLength(1);
    expect(metadata?.scheduled).toMatchObject({
      scheduleId: schedule.scheduleId,
      intendedAt: "2026-08-01T15:00:00.000Z",
      actualAt: "2026-08-01T15:01:01.000Z",
      outcome: "completed",
    });
    store.close();
    expect(await service.list(resource, undefined, 10)).toEqual({ ok: true, value: { schedules: [] } });
    const queued = await service.claim(new Date("2026-08-01T15:02:00Z"), 10, 1_000);
    expect(queued.ok && queued.value).toHaveLength(1);
    const schedulingDb = new Database(join(root, principal.userId, "sessions.db"));
    expect(
      schedulingDb.query<{ count: number }, []>("SELECT count(*) count FROM notification_cards").get()?.count,
    ).toBe(1);
    schedulingDb.close();
    service.close();
  });

  test("fences an edited generation, then advances the current recurring generation after interruption", async () => {
    const { accessManager, principal, resource, service } = setup();
    const created = await service.create(
      resource,
      {
        idempotencyKey: "recurring-race",
        message: "Daily check-in",
        enabled: true,
        timing: { kind: "recurring", frequency: "daily", localTime: "09:00", timeZone: "UTC" },
      },
      new Date("2026-08-01T08:00:00Z"),
    );
    if (!created.ok) throw new Error("create failed");
    let submissions = 0;
    const runner = createScheduledChatRunner({
      claims: service,
      authorizer: {
        authorize: async (claim) => ({
          ok: true as const,
          value: { claim, principal, resource },
        }),
      },
      submitter: {
        async submit(execution) {
          submissions++;
          const sessionId = `session-${submissions}`;
          const associated = await service.associateSession(execution.claim, sessionId);
          if (!associated.ok) return associated;
          const store = openSessionStore(accessManager.grant(principal, "session-store"));
          store.createSession(sessionId, `scheduled:${execution.claim.occurrenceId}`);
          store.close();
          if (submissions === 1) {
            const edited = await service.patch(
              resource,
              created.value.scheduleId,
              {
                expectedRevision: 1,
                changes: {
                  timing: { kind: "recurring", frequency: "daily", localTime: "10:00", timeZone: "UTC" },
                },
              },
              new Date("2026-08-01T09:01:01Z"),
            );
            if (!edited.ok) throw new Error("edit failed");
            return {
              ok: true as const,
              value: {
                outcome: "completed" as const,
                sessionId,
                completedAt: "2026-08-01T09:01:02.000Z",
                content: {
                  ownerUserId: principal.userId,
                  sessionId,
                  occurrenceId: execution.claim.occurrenceId,
                  entryId: "1",
                },
              },
            };
          }
          return {
            ok: true as const,
            value: { outcome: "interrupted" as const, sessionId, completedAt: "2026-08-01T10:01:02.000Z" },
          };
        },
      },
      finalizer: service,
      claimLimit: 1,
      leaseMs: 1_000,
      pollMs: 10,
      now: () => new Date(submissions === 0 ? "2026-08-01T09:01:00Z" : "2026-08-01T10:01:00Z"),
    });

    expect(await runner.runOnce()).toEqual({ ok: true, value: { claimed: 1, finalized: 1 } });
    let listed = await service.list(resource, undefined, 10);
    expect(listed.ok && listed.value.schedules[0]?.nextRunAt).toBe("2026-08-01T10:00:00.000Z");
    expect(await runner.runOnce()).toEqual({ ok: true, value: { claimed: 1, finalized: 1 } });
    listed = await service.list(resource, undefined, 10);
    expect(listed.ok && listed.value.schedules[0]?.nextRunAt).toBe("2026-08-02T10:00:00.000Z");
    const queued = await service.claim(new Date("2026-08-01T11:00:00Z"), 10, 1_000);
    expect(queued.ok && queued.value).toHaveLength(1);
    expect(submissions).toBe(2);
    service.close();
  });

  test("fences mutation committed after initial association but before append", async () => {
    const { accessManager, principal, resource, service } = setup();
    const schedule = await createOneTime(service, resource);
    const valid = await service.create(
      resource,
      {
        idempotencyKey: crypto.randomUUID(),
        message: "Still valid",
        enabled: true,
        timing: { kind: "once-at", at: "2026-08-01T15:00:30Z" },
      },
      new Date("2026-08-01T14:00:00Z"),
    );
    if (!valid.ok) throw new Error("valid create failed");
    const due = await service.claimDue(new Date("2026-08-01T15:01:00Z"), 1, 60_000);
    expect(due.ok).toBe(true);
    if (!due.ok || !due.value[0]) return;
    const claim = due.value[0];
    let associations = 0;
    let runtimeBuilt = false;
    const submitter = createScheduledMessageSubmitter({
      accessManager,
      registry: createSessionRegistry(() => {}),
      makeSessionId: () => "s_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      associateSession: async (candidate, sessionId) => {
        const result = await service.associateSession(candidate, sessionId);
        associations++;
        if (associations === 1) {
          const paused = await service.patch(
            resource,
            schedule.scheduleId,
            { expectedRevision: schedule.revision, changes: { enabled: false } },
            new Date("2026-08-01T15:01:01Z"),
          );
          expect(paused.ok).toBe(true);
        }
        return result;
      },
      reauthorize: async (candidate) => ({ ok: true, value: { claim: candidate, principal, resource } }),
      settleStaleAssociation: (candidate, completedAt) =>
        service.finalizeClaim(candidate, { outcome: "expired", completedAt }, undefined),
      buildHandles: () => {
        runtimeBuilt = true;
        throw new Error("stale occurrence must not allocate runtime");
      },
    });

    const result = await submitter.submit({ claim, principal, resource }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { outcome: "expired" } });
    if (!result.ok) return;
    expect(associations).toBe(2);
    expect(runtimeBuilt).toBe(false);

    const next = await service.claimDue(new Date("2026-08-01T15:01:02Z"), 1, 60_000);
    expect(next.ok && next.value.map((candidate) => candidate.scheduleId)).toEqual([valid.value.scheduleId]);
    service.close();
  });

  test("settles final authority denial and does not starve valid work", async () => {
    const { accessManager, principal, resource, service } = setup();
    await createOneTime(service, resource);
    const valid = await service.create(
      resource,
      {
        idempotencyKey: crypto.randomUUID(),
        message: "Still authorized",
        enabled: true,
        timing: { kind: "once-at", at: "2026-08-01T15:00:30Z" },
      },
      new Date("2026-08-01T14:00:00Z"),
    );
    if (!valid.ok) throw new Error("valid create failed");
    const due = await service.claimDue(new Date("2026-08-01T15:01:00Z"), 1, 60_000);
    expect(due.ok).toBe(true);
    if (!due.ok || !due.value[0]) return;
    const claim = due.value[0];
    let runtimeBuilt = false;
    const submitter = createScheduledMessageSubmitter({
      accessManager,
      registry: createSessionRegistry(() => {}),
      makeSessionId: () => "s_cccccccccccccccccccccccccccccccc",
      associateSession: (candidate, sessionId) => service.associateSession(candidate, sessionId),
      reauthorize: async () => ({ ok: false, error: { code: "forbidden", retryable: false } }),
      settleStaleAssociation: (candidate, completedAt) =>
        service.finalizeClaim(candidate, { outcome: "expired", completedAt }, undefined),
      buildHandles: () => {
        runtimeBuilt = true;
        throw new Error("denied occurrence must not allocate runtime");
      },
    });

    const result = await submitter.submit({ claim, principal, resource }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { outcome: "expired" } });
    expect(runtimeBuilt).toBe(false);
    const next = await service.claimDue(new Date("2026-08-01T15:01:02Z"), 1, 60_000);
    expect(next.ok && next.value.map((candidate) => candidate.scheduleId)).toEqual([valid.value.scheduleId]);
    service.close();
  });

  test("does not overlap concurrent runner acquisitions", async () => {
    let claims = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = createScheduledChatRunner({
      claims: {
        async claimDue() {
          claims++;
          await blocked;
          return { ok: true as const, value: [] };
        },
      },
      authorizer: { authorize: async () => ({ ok: false as const, error: { code: "forbidden", retryable: false } }) },
      submitter: { submit: async () => ({ ok: false as const, error: { code: "unavailable", retryable: true } }) },
      finalizer: {
        finalizeClaim: async () => ({ ok: false as const, error: { code: "unavailable", retryable: true } }),
      },
      claimLimit: 1,
      leaseMs: 1_000,
      pollMs: 10,
    });
    const first = runner.runOnce();
    const second = runner.runOnce();
    expect(first).toBe(second);
    expect(claims).toBe(1);
    release();
    expect(await first).toEqual({ ok: true, value: { claimed: 0, finalized: 0 } });
  });
});
