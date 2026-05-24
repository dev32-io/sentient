# Phase 3 + 4 Bundled — Apply Orchestrator + Catalog Proxies

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Two phases bundled into one plan because they are file-orthogonal (no shared code, no shared types). Execute Phase 3 tasks first, then Phase 4 — they don't share dependencies but the apply path is what unblocks Phase 6 fastest.

**Goal:** Ship the gateway-side apply orchestrator (`POST /api/v1/profile/apply` → write configs + clear conversationId + docker restart + poll health) and the provider/voice catalog proxies (`/api/v1/providers/models`, `/api/v1/providers/voices`) with cache + stale-on-error fallback.

**Architecture (apply):** 5-state state machine in a pure orchestrator function. Hermes session-end RPC is **not** required (resolved 2026-04-24 — see spec §12.1). Apply writes new SOUL.md + Hermes config to the bind-mounted volume, clears `binding.conversationId` for the user's active sessions so the next turn starts a fresh chain (the only way new SOUL.md takes effect — Hermes bakes the system prompt into a chain at creation), `docker restart hermes-<user>`, polls `/health` until 200. Memory flush of the now-orphan chain is lazy via Hermes's idle-expiry watcher (≤1h).

**Architecture (catalogs):** Pure HTTP fetchers in `gateway/src/providers/catalogs/`. Shared TTL cache in `gateway/src/util/ttl-cache.ts`. Stale-on-error: every fetch wraps cache.get → fetch on miss → cache.set on success → return stale on error.

**Tech Stack:** Bun, TypeScript strict, Vitest, Zod, `Bun.spawn` for docker control (no external SDK), native `fetch` + `AbortController` for outbound HTTP.

**Branch:** `feature/multi-user-auth-and-settings` (continues from Phase 1+2). Commits should follow `feat(scope):` / `test(scope):` convention; one logical change per commit.

**Spec:** `docs/superpowers/specs/2026-04-24-multi-user-auth-and-settings-design.md` — §3.3, §6.6, §7.3, §10, §12.1.

---

## Hard Rules (apply to every task)

These are non-negotiable. Past plans where these were unclear produced bypass commits, scope creep, or test breakage. The Phase 1+2 bundle proved the ruleset works when stated explicitly.

1. **No `--no-verify` ever.** If lint or typecheck fails on commit, fix the underlying issue. Do not bypass hooks. If you find a failure that's *not yours* (a stale lint warning on `develop`), fix it cleanly with a one-line `biome-ignore` comment that names the rule and the reason — but never skip the hook.
2. **No out-of-scope edits.** This plan touches:
   - `gateway/src/apply/**`, `gateway/src/api/handlers/profile.ts`, `gateway/src/api/handlers/providers.ts`, `gateway/src/api/router.ts` (small additions only), `gateway/src/infrastructure/docker-control.ts`, `gateway/src/providers/catalogs/**`, `gateway/src/util/ttl-cache.ts`, `gateway/src/session-router.ts` (one method addition + tests).
   - `shared/config/src/schema.ts` (simplify `applyConfigSchema`).
   - `gateway/config.yaml` (simplify `apply:` block, no other changes).
   - `~/.sentient/gateway/shared/catalogs/ollama-models.json` is a **fixture** for Phase 4 tests; do not commit a real catalog into the repo.
   Do **not** edit: `lefthook.yml`, `package.json`, `tsconfig.json`, `docker-compose.yml`, anything under `gateway/webui/`, anything under `shared/` other than the noted schema file. If you find you need such an edit, stop and surface it to the controller — it's a sign the plan needs updating.
3. **camelCase for internal TS, snake_case for YAML/Hermes config keys.** All new TypeScript types, interfaces, function names, and field names use camelCase. YAML key names (in `gateway/config.yaml` and Hermes-rendered files) use snake_case. The Phase 0+1+2 reviewer flagged this convention mismatch; do not repeat it.
4. **No `vi.setSystemTime`.** Vitest under Bun ignores it silently. Use `vi.useFakeTimers()` + `vi.advanceTimersByTime(ms)` for time control.
5. **TDD with one behavior per `it()` block.** Name as `it("returns X when Y")`. Co-locate tests next to source: every `foo.ts` has a `foo.test.ts` in the same directory.
6. **Files <300 lines, functions <40 lines.** Per `.claude/rules/clean-code.md`. If a file approaches the limit, split it. Prefer small focused modules.
7. **Result types, no throws from business logic.** Per `.claude/rules/error-handling.md`. Catch only at boundaries (HTTP handlers).
8. **Tagged loggers.** Every new file imports `getLog` and uses a tagged logger (e.g. `getLog(["sentient", "apply", "orchestrator"])`). Log entry/exit, every state transition, every fallback decision. Per `gateway/.claude/rules/logging.md`.
9. **No magic numbers.** All thresholds/timeouts come from the parsed config. If a value is genuinely an internal constant, declare it `const X_Y_Z = 1234;` at file top with a comment.
10. **Run `bun run test` (not `bun test`) and `bun run typecheck` before committing.** The first runs vitest, the second runs `tsc --noEmit`. Both must be green.

---

## Status Reporting

When a task completes, report status with one of: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`. Concerns include things like "the spec says X but the existing code does Y; I picked X — please confirm." Don't silently resolve a discrepancy.

---

# Phase 3 — Apply Orchestrator

## Task 3.1: Simplify `applyConfigSchema`

**Why:** Phase 0 added `applyConfigSchema` with five fields, three of which (`flush_timeout_ms`, `docker_stop_grace_ms`, `docker_start_timeout_ms`, `idle_flush_ms`) assumed a session-end-RPC + grace-period design that we no longer need (resolved spec §12.1). The actual orchestrator only needs three: docker restart timeout, health-check timeout, health-poll interval.

**Files:**
- Modify: `shared/config/src/schema.ts`
- Modify: `gateway/config.yaml`
- Modify: `shared/config/src/schema.test.ts` (if there are existing tests for the apply block; otherwise add one)

- [ ] **Step 1: Inspect current schema**

Read `shared/config/src/schema.ts` and locate `applyConfigSchema`. Verify the current shape matches what Phase 0 landed.

- [ ] **Step 2: Write the failing test**

In `shared/config/src/schema.test.ts`, add a test for the simplified shape. If a test for `applyConfigSchema` already exists, replace it.

```ts
describe("applyConfigSchema", () => {
  it("parses the simplified apply block with defaults", () => {
    const result = applyConfigSchema.parse({});
    expect(result).toEqual({
      docker_restart_timeout_ms: 30000,
      health_check_timeout_ms: 30000,
      health_poll_interval_ms: 1000,
    });
  });

  it("rejects health_poll_interval_ms below 100", () => {
    expect(() => applyConfigSchema.parse({ health_poll_interval_ms: 50 })).toThrow();
  });

  it("rejects health_check_timeout_ms greater than docker_restart_timeout_ms + 60s", () => {
    // Sanity rule: health-check budget should not absurdly exceed restart budget.
    // Documented as informational; no .refine() required if it complicates downstream code.
    // Skip this test if the schema doesn't enforce it.
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run test shared/config/src/schema.test.ts
```

Expected: red (current schema doesn't match the new shape).

- [ ] **Step 4: Update the schema**

Replace `applyConfigSchema` in `shared/config/src/schema.ts`:

```ts
export const applyConfigSchema = z.object({
  // Max wall time for `docker restart hermes-<user>` to return.
  docker_restart_timeout_ms: z.number().int().min(5000).default(30000),
  // Max wall time for Hermes /health to return 200 after the restart command.
  health_check_timeout_ms: z.number().int().min(1000).default(30000),
  // Poll cadence for /health during the health-checking state.
  health_poll_interval_ms: z.number().int().min(100).default(1000),
});
```

Drop `flush_timeout_ms`, `docker_stop_grace_ms`, `docker_start_timeout_ms`, and `idle_flush_ms`. If `gatewayConfigSchema` references those fields anywhere downstream (it shouldn't yet — Phase 3 is the first consumer), update accordingly.

- [ ] **Step 5: Run the test, verify it passes**

```bash
bun run test shared/config/src/schema.test.ts
```

Expected: green.

- [ ] **Step 6: Update `gateway/config.yaml`**

Replace the `apply:` block with:

```yaml
apply:
  docker_restart_timeout_ms: 30000   # max wait for `docker restart` to return
  health_check_timeout_ms: 30000     # max wait for Hermes /health 200 after restart
  health_poll_interval_ms: 1000      # poll cadence during health-checking state
```

- [ ] **Step 7: Run the full gateway test suite + typecheck**

```bash
bun run typecheck && bun run test
```

Expected: all green. If any test references the old `apply.*` keys, those tests are stale — update them.

- [ ] **Step 8: Commit**

```bash
git add shared/config/src/schema.ts shared/config/src/schema.test.ts gateway/config.yaml
git commit -m "refactor(config): simplify apply schema for new orchestrator design

Resolves spec §12.1: no session-end RPC, no shutdown grace flush.
Apply only needs docker restart timeout, health-check timeout, poll interval."
```

---

## Task 3.2: Add `clearConversationIdForAllSessions(userId)` to SessionRouter

**Why:** Apply must clear `binding.conversationId` for *every* active session of the affected user (the user might have web + satellite open simultaneously). The existing `updateConversationId(sessionId, conversationId)` mutates a single session by ID. We need a userId-keyed bulk operation.

**Files:**
- Modify: `gateway/src/session-router.ts`
- Modify: `gateway/src/session-router.test.ts`

- [ ] **Step 1: Read the existing SessionRouter**

Read `gateway/src/session-router.ts` end-to-end so the addition matches the existing iteration patterns (see `findActiveSessionFor` at lines 154–160).

- [ ] **Step 2: Write the failing test**

Add to `gateway/src/session-router.test.ts`:

```ts
describe("clearConversationIdForAllSessions", () => {
  it("clears conversationId on every binding matching the userId", () => {
    const router = createSessionRouter(testProfileResolver);
    router.bind("session-a", "alice");
    router.bind("session-b", "alice");
    router.bind("session-c", "bob");
    router.updateConversationId("session-a", "resp_111");
    router.updateConversationId("session-b", "resp_222");
    router.updateConversationId("session-c", "resp_333");

    router.clearConversationIdForAllSessions("alice");

    expect(router.get("session-a")?.conversationId).toBeNull();
    expect(router.get("session-b")?.conversationId).toBeNull();
    expect(router.get("session-c")?.conversationId).toBe("resp_333");
  });

  it("is a no-op when the user has no active sessions", () => {
    const router = createSessionRouter(testProfileResolver);
    expect(() => router.clearConversationIdForAllSessions("ghost")).not.toThrow();
  });

  it("clears even when conversationId is already null", () => {
    const router = createSessionRouter(testProfileResolver);
    router.bind("session-a", "alice");
    router.clearConversationIdForAllSessions("alice");
    expect(router.get("session-a")?.conversationId).toBeNull();
  });
});
```

(Reuse the test fixture `testProfileResolver` already declared in the test file; if the existing tests use a different setup pattern, mirror that.)

- [ ] **Step 3: Run the test, verify it fails**

```bash
bun run test gateway/src/session-router.test.ts
```

Expected: red — method doesn't exist.

- [ ] **Step 4: Add the method to the SessionRouter interface**

In `gateway/src/session-router.ts`, append to the `SessionRouter` interface:

```ts
  /**
   * Clear conversationId on every binding for this userId.
   * Called by the apply orchestrator so the next turn starts a fresh Hermes
   * chain that reads the new SOUL.md / config.yaml.
   */
  clearConversationIdForAllSessions(userId: string): void;
```

- [ ] **Step 5: Implement the method**

Inside the `createSessionRouter` factory, mirror the iteration shape of `findActiveSessionFor`:

```ts
clearConversationIdForAllSessions(userId) {
  let cleared = 0;
  for (const [sessionId, b] of bindings.entries()) {
    if (b.userId !== userId) continue;
    if (b.conversationId === null) continue;
    log.info("conversation.cleared", {
      sessionId,
      userId,
      priorConversationId: b.conversationId,
      reason: "apply",
    });
    b.conversationId = null;
    cleared++;
  }
  log.debug("clearConversationIdForAllSessions.done", { userId, cleared });
},
```

- [ ] **Step 6: Run the test, verify it passes**

```bash
bun run test gateway/src/session-router.test.ts
```

Expected: green.

- [ ] **Step 7: Run typecheck**

```bash
bun run typecheck
```

Expected: green. (If a downstream consumer of `SessionRouter` doesn't implement the new method, address it here — but no consumer should need to change since this is purely additive.)

- [ ] **Step 8: Commit**

```bash
git add gateway/src/session-router.ts gateway/src/session-router.test.ts
git commit -m "feat(session-router): add clearConversationIdForAllSessions for apply flow"
```

---

## Task 3.3: Docker control adapter

**Why:** Apply must invoke `docker restart hermes-<user>` and poll Hermes `/health`. Wrap both as a typed interface so the orchestrator is testable without a real docker daemon. No external SDK — `Bun.spawn` is sufficient.

**Files:**
- Create: `gateway/src/infrastructure/docker-control.ts`
- Create: `gateway/src/infrastructure/docker-control.test.ts`

- [ ] **Step 1: Define the interface**

Create `gateway/src/infrastructure/docker-control.ts` with:

```ts
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "infrastructure", "docker-control"]);

export type DockerControlError =
  | { kind: "spawn-failed"; reason: string }
  | { kind: "non-zero-exit"; exitCode: number; stderr: string }
  | { kind: "timeout"; afterMs: number };

export type HealthPollError =
  | { kind: "timeout"; afterMs: number }
  | { kind: "fetch-failed"; reason: string };

// Result is imported from gateway/src/util/result.ts; create that file as part of this task
// if it does not yet exist. See "Note on Result type" at the bottom of this plan.
import type { Result } from "../util/result.js";

export interface DockerControl {
  /** Run `docker restart <containerName>`. Resolves when the command exits 0
   *  or rejects with a typed error. Rejects on non-zero exit; on timeout sends
   *  SIGKILL to the spawned `docker` process (not to the container). */
  restart(containerName: string, timeoutMs: number): Promise<Result<void, DockerControlError>>;
}

export interface HealthPoller {
  /** Poll `GET ${url}` with the given headers until status 200 or timeout.
   *  Polls every `intervalMs`. Returns ok on first 200; error on timeout. */
  pollUntilHealthy(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<Result<void, HealthPollError>>;
}
```

- [ ] **Step 2: Write the failing tests for `DockerControl`**

`gateway/src/infrastructure/docker-control.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDockerControl, createHealthPoller } from "./docker-control.js";

describe("createDockerControl().restart", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => { vi.restoreAllMocks(); });

  it("resolves ok when docker restart exits 0", async () => {
    spawnSpy = vi.spyOn(globalThis.Bun, "spawn").mockReturnValue(fakeProc(0, "", "") as never);
    const dc = createDockerControl();
    const r = await dc.restart("hermes-alice", 5000);
    expect(r.ok).toBe(true);
    expect(spawnSpy).toHaveBeenCalledWith(["docker", "restart", "hermes-alice"], expect.any(Object));
  });

  it("returns non-zero-exit error when docker exits non-zero", async () => {
    spawnSpy = vi.spyOn(globalThis.Bun, "spawn").mockReturnValue(fakeProc(1, "", "no such container") as never);
    const dc = createDockerControl();
    const r = await dc.restart("hermes-missing", 5000);
    expect(r).toEqual({ ok: false, error: { kind: "non-zero-exit", exitCode: 1, stderr: "no such container" } });
  });

  it("returns timeout error when docker exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    spawnSpy = vi.spyOn(globalThis.Bun, "spawn").mockReturnValue(fakeProc(0, "", "", 999_999) as never);
    const dc = createDockerControl();
    const promise = dc.restart("hermes-alice", 1000);
    vi.advanceTimersByTime(1500);
    const r = await promise;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("timeout");
    vi.useRealTimers();
  });
});

// Helper: build a fake Bun.spawn return shape for the test
function fakeProc(exitCode: number, stdout: string, stderr: string, exitDelayMs = 0) {
  const exited = exitDelayMs > 0
    ? new Promise<number>((resolve) => setTimeout(() => resolve(exitCode), exitDelayMs))
    : Promise.resolve(exitCode);
  return {
    exited,
    exitCode: exitDelayMs > 0 ? null : exitCode,
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    kill: vi.fn(),
  };
}
```

- [ ] **Step 3: Run, verify red**

```bash
bun run test gateway/src/infrastructure/docker-control.test.ts
```

- [ ] **Step 4: Implement `createDockerControl`**

Append to `gateway/src/infrastructure/docker-control.ts`:

```ts
const DEFAULT_DOCKER_BIN = "docker";

export function createDockerControl(): DockerControl {
  return {
    async restart(containerName, timeoutMs) {
      const startedAt = Date.now();
      log.info("restart.begin", { containerName, timeoutMs });
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([DEFAULT_DOCKER_BIN, "restart", containerName], {
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn("restart.spawnFailed", { containerName, reason });
        return { ok: false, error: { kind: "spawn-failed", reason } };
      }

      const timeoutHandle = setTimeout(() => {
        log.warn("restart.timeout", { containerName, timeoutMs });
        proc.kill();
      }, timeoutMs);

      const exitCode = await proc.exited;
      clearTimeout(timeoutHandle);

      const stderr = await new Response(proc.stderr).text();
      const elapsedMs = Date.now() - startedAt;

      if (exitCode === null || (exitCode !== 0 && elapsedMs >= timeoutMs)) {
        return { ok: false, error: { kind: "timeout", afterMs: elapsedMs } };
      }
      if (exitCode !== 0) {
        log.warn("restart.nonZeroExit", { containerName, exitCode, stderr: stderr.slice(0, 200) });
        return { ok: false, error: { kind: "non-zero-exit", exitCode, stderr } };
      }
      log.info("restart.done", { containerName, elapsedMs });
      return { ok: true, value: undefined };
    },
  };
}
```

- [ ] **Step 5: Add health-poller tests**

In the same test file:

```ts
describe("createHealthPoller().pollUntilHealthy", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("returns ok on first 200 response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const hp = createHealthPoller();
    const promise = hp.pollUntilHealthy("http://x/health", {}, 5000, 1000);
    await vi.runOnlyPendingTimersAsync();
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries after non-200 then succeeds", async () => {
    let calls = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return new Response("", { status: calls < 3 ? 503 : 200 });
    });
    const hp = createHealthPoller();
    const promise = hp.pollUntilHealthy("http://x/health", {}, 10_000, 500);
    await vi.advanceTimersByTimeAsync(2000);
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("returns timeout error when /health never returns 200", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const hp = createHealthPoller();
    const promise = hp.pollUntilHealthy("http://x/health", {}, 2000, 500);
    await vi.advanceTimersByTimeAsync(2500);
    const r = await promise;
    expect(r).toEqual({ ok: false, error: { kind: "timeout", afterMs: expect.any(Number) } });
  });

  it("returns fetch-failed when fetch throws", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const hp = createHealthPoller();
    const promise = hp.pollUntilHealthy("http://x/health", {}, 1500, 500);
    await vi.advanceTimersByTimeAsync(2000);
    const r = await promise;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("timeout"); // the inner fetch errors are swallowed; final state is timeout
  });
});
```

- [ ] **Step 6: Implement `createHealthPoller`**

Append:

```ts
export function createHealthPoller(): HealthPoller {
  return {
    async pollUntilHealthy(url, headers, timeoutMs, intervalMs) {
      const startedAt = Date.now();
      log.info("pollUntilHealthy.begin", { url, timeoutMs, intervalMs });
      let attempts = 0;
      while (Date.now() - startedAt < timeoutMs) {
        attempts++;
        try {
          const resp = await fetch(url, { headers, signal: AbortSignal.timeout(intervalMs) });
          if (resp.ok) {
            const elapsedMs = Date.now() - startedAt;
            log.info("pollUntilHealthy.healthy", { url, attempts, elapsedMs });
            return { ok: true, value: undefined };
          }
          log.debug("pollUntilHealthy.nonOk", { url, status: resp.status, attempts });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          log.debug("pollUntilHealthy.fetchError", { url, reason, attempts });
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      const afterMs = Date.now() - startedAt;
      log.warn("pollUntilHealthy.timeout", { url, attempts, afterMs });
      return { ok: false, error: { kind: "timeout", afterMs } };
    },
  };
}
```

- [ ] **Step 7: Run, verify all green**

```bash
bun run test gateway/src/infrastructure/docker-control.test.ts && bun run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add gateway/src/infrastructure/docker-control.ts gateway/src/infrastructure/docker-control.test.ts
git commit -m "feat(infrastructure): docker-control adapter (restart + health-poll)"
```

---

## Task 3.4: Apply orchestrator (pure function)

**Why:** This is the heart of the apply flow. Pure function: takes deps + userId, runs the 5-state machine, returns a `Result`. Testable without docker, without HTTP, without disk.

**Files:**
- Create: `gateway/src/apply/orchestrator.ts`
- Create: `gateway/src/apply/orchestrator.test.ts`

- [ ] **Step 1: Define the orchestrator types**

Create `gateway/src/apply/orchestrator.ts`:

```ts
import { getLog } from "../logging/logger.js";
import type { DockerControl, DockerControlError, HealthPoller, HealthPollError, Result } from "../infrastructure/docker-control.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { ProfileV1 } from "../profile-store/profile-types.js";
import type { SessionRouter } from "../session-router.js";

const log = getLog(["sentient", "apply", "orchestrator"]);

export type ApplyState =
  | "idle"
  | "writing-config"
  | "restarting"
  | "health-checking"
  | "ready"
  | "failed";

export type ApplyError =
  | { kind: "render-error"; reason: string }
  | { kind: "write-error"; reason: string }
  | { kind: "docker-restart-failed"; cause: DockerControlError }
  | { kind: "health-check-timeout"; cause: HealthPollError }
  | { kind: "user-not-found"; userId: string };

export interface ApplyDeps {
  profileStore: ProfileStore;
  sessionRouter: SessionRouter;
  dockerControl: DockerControl;
  healthPoller: HealthPoller;
  /** Pure render: profile → { soulMarkdown, hermesConfigYaml } */
  renderProfile: (profile: ProfileV1, templateBody: string) => { soulMarkdown: string; hermesConfigYaml: string };
  /** Atomic write of the rendered artifacts to ${profileDir}/.generated/{config.yaml, SOUL.md} */
  writeRendered: (userId: string, rendered: { soulMarkdown: string; hermesConfigYaml: string }) => Promise<void>;
  /** Resolve the shared template body (for renderProfile) */
  loadTemplate: () => Promise<string>;
  /** Resolve `hermes-<userId>` container name */
  resolveContainerName: (userId: string) => string;
  /** Resolve `http://hermes-<userId>:<port>/health` URL */
  resolveHealthUrl: (userId: string) => string;
  /** Resolve auth header for the user's Hermes container */
  resolveHealthHeaders: (userId: string) => Record<string, string>;
  /** Apply timeouts from gateway config */
  config: {
    dockerRestartTimeoutMs: number;
    healthCheckTimeoutMs: number;
    healthPollIntervalMs: number;
  };
}

export interface ApplyOutcome {
  state: ApplyState;
  elapsedMs: number;
}

export async function runApply(
  deps: ApplyDeps,
  userId: string,
): Promise<Result<ApplyOutcome, ApplyError>> {
  const startedAt = Date.now();
  log.info("apply.begin", { userId });

  // 1. writing-config
  log.debug("apply.state", { userId, state: "writing-config" });
  const profileR = await deps.profileStore.get(userId);
  if (!profileR.ok) {
    log.warn("apply.userNotFound", { userId, reason: profileR.error });
    return { ok: false, error: { kind: "user-not-found", userId } };
  }
  let rendered: { soulMarkdown: string; hermesConfigYaml: string };
  try {
    const tpl = await deps.loadTemplate();
    rendered = deps.renderProfile(profileR.value, tpl);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("apply.renderError", { userId, reason });
    return { ok: false, error: { kind: "render-error", reason } };
  }
  try {
    await deps.writeRendered(userId, rendered);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("apply.writeError", { userId, reason });
    return { ok: false, error: { kind: "write-error", reason } };
  }

  // 2. clear conversationId for all of this user's sessions BEFORE restart
  // (so any in-flight WS turn that races the restart will start a fresh chain
  // — same outcome we want, no special-casing needed.)
  deps.sessionRouter.clearConversationIdForAllSessions(userId);

  // 3. restarting
  log.debug("apply.state", { userId, state: "restarting" });
  const containerName = deps.resolveContainerName(userId);
  const restartR = await deps.dockerControl.restart(containerName, deps.config.dockerRestartTimeoutMs);
  if (!restartR.ok) {
    log.warn("apply.dockerRestartFailed", { userId, containerName, error: restartR.error });
    return { ok: false, error: { kind: "docker-restart-failed", cause: restartR.error } };
  }

  // 4. health-checking
  log.debug("apply.state", { userId, state: "health-checking" });
  const healthR = await deps.healthPoller.pollUntilHealthy(
    deps.resolveHealthUrl(userId),
    deps.resolveHealthHeaders(userId),
    deps.config.healthCheckTimeoutMs,
    deps.config.healthPollIntervalMs,
  );
  if (!healthR.ok) {
    log.warn("apply.healthCheckTimeout", { userId, error: healthR.error });
    return { ok: false, error: { kind: "health-check-timeout", cause: healthR.error } };
  }

  // 5. ready
  const elapsedMs = Date.now() - startedAt;
  log.info("apply.ready", { userId, elapsedMs });
  return { ok: true, value: { state: "ready", elapsedMs } };
}
```

- [ ] **Step 2: Write the orchestrator tests (one `it` per state/path)**

`gateway/src/apply/orchestrator.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runApply, type ApplyDeps } from "./orchestrator.js";

function makeDeps(overrides: Partial<ApplyDeps> = {}): ApplyDeps {
  const profile = { userId: "alice", schemaVersion: 1, displayName: "Alice", /* ... minimal valid */ } as never;
  return {
    profileStore: {
      get: vi.fn().mockResolvedValue({ ok: true, value: profile }),
      save: vi.fn(), remove: vi.fn(),
    },
    sessionRouter: {
      bind: vi.fn(), release: vi.fn(), rebind: vi.fn(), get: vi.fn(),
      updateConversationId: vi.fn(),
      clearConversationIdForAllSessions: vi.fn(),
      findActiveSessionFor: vi.fn(),
    } as never,
    dockerControl: { restart: vi.fn().mockResolvedValue({ ok: true, value: undefined }) },
    healthPoller: { pollUntilHealthy: vi.fn().mockResolvedValue({ ok: true, value: undefined }) },
    renderProfile: vi.fn().mockReturnValue({ soulMarkdown: "soul", hermesConfigYaml: "yaml" }),
    writeRendered: vi.fn().mockResolvedValue(undefined),
    loadTemplate: vi.fn().mockResolvedValue("tpl"),
    resolveContainerName: (u) => `hermes-${u}`,
    resolveHealthUrl: (u) => `http://hermes-${u}:8643/health`,
    resolveHealthHeaders: () => ({ Authorization: "Bearer test" }),
    config: { dockerRestartTimeoutMs: 30_000, healthCheckTimeoutMs: 30_000, healthPollIntervalMs: 1000 },
    ...overrides,
  };
}

describe("runApply", () => {
  it("happy path returns ready and calls each dependency once", async () => {
    const deps = makeDeps();
    const r = await runApply(deps, "alice");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.state).toBe("ready");
    expect(deps.profileStore.get).toHaveBeenCalledWith("alice");
    expect(deps.sessionRouter.clearConversationIdForAllSessions).toHaveBeenCalledWith("alice");
    expect(deps.dockerControl.restart).toHaveBeenCalledWith("hermes-alice", 30_000);
    expect(deps.healthPoller.pollUntilHealthy).toHaveBeenCalled();
  });

  it("returns user-not-found when profileStore.get fails", async () => {
    const deps = makeDeps({
      profileStore: {
        get: vi.fn().mockResolvedValue({ ok: false, error: "missing" }),
        save: vi.fn(), remove: vi.fn(),
      },
    });
    const r = await runApply(deps, "ghost");
    expect(r).toEqual({ ok: false, error: { kind: "user-not-found", userId: "ghost" } });
    expect(deps.dockerControl.restart).not.toHaveBeenCalled();
  });

  it("returns render-error when renderProfile throws", async () => {
    const deps = makeDeps({ renderProfile: vi.fn().mockImplementation(() => { throw new Error("bad template"); }) });
    const r = await runApply(deps, "alice");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("render-error");
    expect(deps.dockerControl.restart).not.toHaveBeenCalled();
  });

  it("returns write-error when writeRendered throws", async () => {
    const deps = makeDeps({ writeRendered: vi.fn().mockRejectedValue(new Error("EROFS")) });
    const r = await runApply(deps, "alice");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("write-error");
  });

  it("returns docker-restart-failed when docker exits non-zero", async () => {
    const deps = makeDeps({
      dockerControl: { restart: vi.fn().mockResolvedValue({ ok: false, error: { kind: "non-zero-exit", exitCode: 1, stderr: "no such container" } }) },
    });
    const r = await runApply(deps, "alice");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("docker-restart-failed");
    expect(deps.healthPoller.pollUntilHealthy).not.toHaveBeenCalled();
  });

  it("returns health-check-timeout when poller times out", async () => {
    const deps = makeDeps({
      healthPoller: { pollUntilHealthy: vi.fn().mockResolvedValue({ ok: false, error: { kind: "timeout", afterMs: 30_000 } }) },
    });
    const r = await runApply(deps, "alice");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("health-check-timeout");
  });

  it("clears conversationId BEFORE docker restart (order matters for race safety)", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      sessionRouter: {
        bind: vi.fn(), release: vi.fn(), rebind: vi.fn(), get: vi.fn(),
        updateConversationId: vi.fn(),
        clearConversationIdForAllSessions: vi.fn(() => { order.push("clear"); }),
        findActiveSessionFor: vi.fn(),
      } as never,
      dockerControl: { restart: vi.fn().mockImplementation(async () => { order.push("restart"); return { ok: true, value: undefined }; }) },
    });
    await runApply(deps, "alice");
    expect(order).toEqual(["clear", "restart"]);
  });
});
```

- [ ] **Step 3: Run, verify red**

```bash
bun run test gateway/src/apply/orchestrator.test.ts
```

- [ ] **Step 4: Iterate orchestrator until all tests pass**

The first run is red because the test imports a not-yet-built module path or the orchestrator's exact error shape doesn't match. Adjust `orchestrator.ts` until green. Do not change tests to match an incorrect implementation — fix the implementation.

- [ ] **Step 5: Verify file size + function size**

```bash
wc -l gateway/src/apply/orchestrator.ts
```

Expected: <300 lines. `runApply` should be <40 lines; if it's bigger, extract per-state helpers.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/apply/orchestrator.ts gateway/src/apply/orchestrator.test.ts
git commit -m "feat(apply): orchestrator pure function — 5-state machine, typed errors"
```

---

## Task 3.5: HTTP handler `POST /api/v1/profile/apply` + router wiring

**Why:** Boundary between HTTP and the orchestrator. Reads bearer token, resolves userId, calls `runApply`, returns 200 / 4xx / 5xx with typed error codes the UI can switch on.

**Files:**
- Create: `gateway/src/api/handlers/profile.ts`
- Create: `gateway/src/api/handlers/profile.test.ts`
- Modify: `gateway/src/api/router.ts` (add `/api/v1/profile/*` delegation)
- Modify: `gateway/src/api/router.test.ts` (route delegation test)

- [ ] **Step 1: Write the handler tests first**

`gateway/src/api/handlers/profile.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleProfile } from "./profile.js";

function deps(overrides: Partial<Parameters<typeof handleProfile>[0]> = {}) {
  return {
    auth: {
      tokens: { validate: vi.fn().mockResolvedValue({ ok: true, value: { userId: "alice", isAdmin: false } }) } as never,
      users: { get: vi.fn().mockResolvedValue({ ok: true, value: { userId: "alice", displayName: "Alice", isAdmin: false } }) } as never,
      authenticate: vi.fn(),
    },
    runApply: vi.fn().mockResolvedValue({ ok: true, value: { state: "ready", elapsedMs: 7000 } }),
    ...overrides,
  };
}

function req(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { method, headers });
}

describe("handleProfile", () => {
  it("POST /api/v1/profile/apply with valid token returns 200 ready", async () => {
    const d = deps();
    const r = await handleProfile(d as never, req("POST", "/api/v1/profile/apply", { authorization: "Bearer t" }));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json).toEqual({ status: "ready", elapsedMs: 7000 });
    expect(d.runApply).toHaveBeenCalledWith("alice");
  });

  it("returns 401 when authorization header missing", async () => {
    const d = deps();
    const r = await handleProfile(d as never, req("POST", "/api/v1/profile/apply"));
    expect(r.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const d = deps({ auth: { tokens: { validate: vi.fn().mockResolvedValue({ ok: false, error: "expired" }) } as never, users: {} as never, authenticate: vi.fn() } });
    const r = await handleProfile(d as never, req("POST", "/api/v1/profile/apply", { authorization: "Bearer t" }));
    expect(r.status).toBe(401);
  });

  it("returns 404 when user-not-found", async () => {
    const d = deps({ runApply: vi.fn().mockResolvedValue({ ok: false, error: { kind: "user-not-found", userId: "alice" } }) });
    const r = await handleProfile(d as never, req("POST", "/api/v1/profile/apply", { authorization: "Bearer t" }));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "user-not-found" });
  });

  it("returns 422 on render-error", async () => {
    const d = deps({ runApply: vi.fn().mockResolvedValue({ ok: false, error: { kind: "render-error", reason: "missing field" } }) });
    const r = await handleProfile(d as never, req("POST", "/api/v1/profile/apply", { authorization: "Bearer t" }));
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "render-error", reason: "missing field" });
  });

  it("returns 502 on docker-restart-failed", async () => {
    const d = deps({ runApply: vi.fn().mockResolvedValue({ ok: false, error: { kind: "docker-restart-failed", cause: { kind: "non-zero-exit", exitCode: 1, stderr: "..." } } }) });
    const r = await handleProfile(d as never, req("POST", "/api/v1/profile/apply", { authorization: "Bearer t" }));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "docker-restart-failed" });
  });

  it("returns 504 on health-check-timeout", async () => {
    const d = deps({ runApply: vi.fn().mockResolvedValue({ ok: false, error: { kind: "health-check-timeout", cause: { kind: "timeout", afterMs: 30_000 } } }) });
    const r = await handleProfile(d as never, req("POST", "/api/v1/profile/apply", { authorization: "Bearer t" }));
    expect(r.status).toBe(504);
  });

  it("returns 405 for non-POST", async () => {
    const d = deps();
    const r = await handleProfile(d as never, req("GET", "/api/v1/profile/apply", { authorization: "Bearer t" }));
    expect(r.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run, verify red**

```bash
bun run test gateway/src/api/handlers/profile.test.ts
```

- [ ] **Step 3: Implement the handler**

`gateway/src/api/handlers/profile.ts`:

```ts
import { getLog } from "../../logging/logger.js";
import type { TokenService } from "../../user-auth/token-service.js";
import type { UserStore } from "../../user-auth/user-store.js";
import type { ApplyError, ApplyOutcome } from "../../apply/orchestrator.js";
import type { Result } from "../../util/result.js"; // see Note on Result type at bottom of this plan

const log = getLog(["sentient", "api", "handlers", "profile"]);

const HTTP_OK = 200;
const HTTP_BAD = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_UNPROCESSABLE = 422;
const HTTP_BAD_GATEWAY = 502;
const HTTP_TIMEOUT = 504;

export interface ProfileHandlerDeps {
  auth: {
    tokens: Pick<TokenService, "validate">;
    users: Pick<UserStore, "get">;
  };
  runApply: (userId: string) => Promise<Result<ApplyOutcome, ApplyError>>;
}

export async function handleProfile(deps: ProfileHandlerDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/v1/profile/apply") return handleApply(deps, request);
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

async function handleApply(deps: ProfileHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: HTTP_METHOD });
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");
  const valid = await deps.auth.tokens.validate(token);
  if (!valid.ok) return jsonError(HTTP_UNAUTHORIZED, valid.error);
  const { userId } = valid.value;

  log.info("apply.request", { userId });
  const r = await deps.runApply(userId);

  if (r.ok) {
    return Response.json({ status: "ready", elapsedMs: r.value.elapsedMs }, { status: HTTP_OK });
  }
  switch (r.error.kind) {
    case "user-not-found":
      return jsonError(HTTP_NOT_FOUND, "user-not-found");
    case "render-error":
      return Response.json({ error: "render-error", reason: r.error.reason }, { status: HTTP_UNPROCESSABLE });
    case "write-error":
      return Response.json({ error: "write-error", reason: r.error.reason }, { status: HTTP_UNPROCESSABLE });
    case "docker-restart-failed":
      return jsonError(HTTP_BAD_GATEWAY, "docker-restart-failed");
    case "health-check-timeout":
      return jsonError(HTTP_TIMEOUT, "health-check-timeout");
  }
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
```

- [ ] **Step 4: Run handler tests, verify green**

```bash
bun run test gateway/src/api/handlers/profile.test.ts
```

- [ ] **Step 5: Wire into router**

In `gateway/src/api/router.ts`, add the `handleProfile` import and a delegation branch matching the existing pattern (e.g. between auth and admin):

```ts
import { handleProfile } from "./handlers/profile.js";
// ...
if (path.startsWith("/api/v1/profile/")) return handleProfile(deps, request);
```

Wire `runApply` into the deps shape — bootstrap-time composition (`gateway/src/main.ts` or wherever the router deps are constructed). Construct the orchestrator deps from existing services + new `createDockerControl()` + `createHealthPoller()`.

- [ ] **Step 6: Add a router-level delegation test**

In `gateway/src/api/router.test.ts`, add:

```ts
it("delegates /api/v1/profile/* to handleProfile", async () => {
  const handleProfileSpy = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
  const router = createApiRouter({ ...mockDeps(), handleProfile: handleProfileSpy } as never);
  const r = await router(new Request("http://localhost/api/v1/profile/apply", { method: "POST" }));
  expect(handleProfileSpy).toHaveBeenCalled();
  expect(r.status).toBe(200);
});
```

(If the existing router test pattern uses real handlers rather than spies, mirror that; the goal is the delegation path is covered.)

- [ ] **Step 7: Run all gateway tests + typecheck**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 8: Commit**

```bash
git add gateway/src/api/handlers/profile.ts gateway/src/api/handlers/profile.test.ts gateway/src/api/router.ts gateway/src/api/router.test.ts gateway/src/main.ts
git commit -m "feat(api): POST /api/v1/profile/apply — wire orchestrator to HTTP boundary"
```

---

## Task 3.6: Tagged `@live` integration smoke against `hermes-alice`

**Why:** Mocked tests prove the orchestrator's logic. One real-container run proves `Bun.spawn` actually invokes the `docker` binary correctly. Health-poll is NOT exercised here because `hermes-alice` runs on the `sentient-internal` network with no host port exposure — that path is verified manually in Phase 8 via the gateway container.

**Files:**
- Create: `gateway/tests/integration/docker-control-live.test.ts`

- [ ] **Step 1: Pre-check that `hermes-alice` is running**

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep hermes-alice
```

If not running, report `BLOCKED: hermes-alice not running. Start with: docker compose -f deploy/docker/docker-compose.yml up -d hermes-alice`.

- [ ] **Step 2: Write the integration test (docker restart only)**

```ts
// Tag: @live — only runs with HERMES_ALICE_LIVE=1
import { describe, expect, it } from "vitest";
import { createDockerControl } from "../../src/infrastructure/docker-control.js";

const RUN_LIVE = process.env.HERMES_ALICE_LIVE === "1";

describe.skipIf(!RUN_LIVE)("docker-control integration — real hermes-alice", () => {
  it("docker restart hermes-alice exits 0 within 15s", async () => {
    const dc = createDockerControl();
    const startedAt = Date.now();
    const r = await dc.restart("hermes-alice", 30_000);
    const elapsedMs = Date.now() - startedAt;
    expect(r.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 30_000);

  it("docker restart on a missing container returns non-zero-exit", async () => {
    const dc = createDockerControl();
    const r = await dc.restart("hermes-does-not-exist", 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("non-zero-exit");
  }, 10_000);
});
```

- [ ] **Step 3: Run only when explicitly requested**

```bash
HERMES_ALICE_LIVE=1 bun run test gateway/tests/integration/docker-control-live.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add gateway/tests/integration/docker-control-live.test.ts
git commit -m "test(infrastructure): @live docker-control smoke against hermes-alice"
```

---

# Phase 4 — Catalog Proxies

## Task 4.1: TTL cache utility

**Why:** Catalog responses are slow (OpenRouter ~600ms, Fish ~400ms) and rate-limited. Cache TTL is 1h for models, 10min for voices. Stale-on-error means the UI doesn't go blank if upstream blips.

**Files:**
- Create: `gateway/src/util/ttl-cache.ts`
- Create: `gateway/src/util/ttl-cache.test.ts`

- [ ] **Step 1: Write tests first**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTtlCache } from "./ttl-cache.js";

describe("createTtlCache", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns undefined for unknown key", () => {
    const c = createTtlCache<string>();
    expect(c.get("missing")).toBeUndefined();
  });

  it("returns value within TTL window", () => {
    const c = createTtlCache<string>();
    c.set("k", "v", 60_000);
    expect(c.get("k")).toBe("v");
  });

  it("returns undefined after TTL elapses", () => {
    const c = createTtlCache<string>();
    c.set("k", "v", 1000);
    vi.advanceTimersByTime(1500);
    expect(c.get("k")).toBeUndefined();
  });

  it("getStale returns last value even after TTL elapses", () => {
    const c = createTtlCache<string>();
    c.set("k", "v", 1000);
    vi.advanceTimersByTime(5000);
    expect(c.get("k")).toBeUndefined();
    expect(c.getStale("k")).toBe("v");
  });

  it("set overwrites prior value and resets TTL", () => {
    const c = createTtlCache<string>();
    c.set("k", "v1", 1000);
    vi.advanceTimersByTime(500);
    c.set("k", "v2", 2000);
    vi.advanceTimersByTime(1500);
    expect(c.get("k")).toBe("v2");
  });

  it("clear removes all entries", () => {
    const c = createTtlCache<string>();
    c.set("k1", "v1", 60_000);
    c.set("k2", "v2", 60_000);
    c.clear();
    expect(c.get("k1")).toBeUndefined();
    expect(c.getStale("k1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement**

```ts
export interface TtlCache<T> {
  get(key: string): T | undefined;
  /** Returns the last cached value for the key regardless of TTL. */
  getStale(key: string): T | undefined;
  set(key: string, value: T, ttlMs: number): void;
  clear(): void;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createTtlCache<T>(): TtlCache<T> {
  const map = new Map<string, Entry<T>>();
  return {
    get(key) {
      const e = map.get(key);
      if (e === undefined) return undefined;
      if (Date.now() >= e.expiresAt) return undefined;
      return e.value;
    },
    getStale(key) {
      return map.get(key)?.value;
    },
    set(key, value, ttlMs) {
      map.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    clear() {
      map.clear();
    },
  };
}
```

- [ ] **Step 3: Run, verify green**

```bash
bun run test gateway/src/util/ttl-cache.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add gateway/src/util/ttl-cache.ts gateway/src/util/ttl-cache.test.ts
git commit -m "feat(util): TTL cache with stale-on-miss accessor"
```

---

## Task 4.2: OpenRouter models fetcher

**Why:** Phase 6's My Agent dropdown needs OpenRouter's `GET /api/v1/models` normalized into `ModelEntry[]`. Cache 1h with stale-on-error.

**Files:**
- Create: `gateway/src/providers/catalogs/types.ts` (shared `ModelEntry`, `VoiceEntry`)
- Create: `gateway/src/providers/catalogs/openrouter-fetcher.ts`
- Create: `gateway/src/providers/catalogs/openrouter-fetcher.test.ts`

- [ ] **Step 1: Define `ModelEntry` shape**

`gateway/src/providers/catalogs/types.ts`:

```ts
export interface ModelEntry {
  id: string;
  provider: "openrouter" | "ollama-cloud";
  name: string;
  description: string;
  contextLength: number;
  pricingPer1mPrompt: number | "included";
  pricingPer1mCompletion: number | "included";
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface VoiceEntry {
  id: string;
  title: string;
  description: string;
  languages: string[];
  tags: string[];
  coverImageUrl: string | null;
  previewAudioUrl: string | null;
  visibility: "public" | "private";
}
```

(Note: camelCase per Hard Rule 3, even though spec sample showed snake_case — spec is illustrative.)

- [ ] **Step 2: Write fetcher tests with `fetch` mocked**

`gateway/src/providers/catalogs/openrouter-fetcher.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenRouterModels } from "./openrouter-fetcher.js";

afterEach(() => { vi.restoreAllMocks(); });

const sample = {
  data: [
    {
      id: "openai/gpt-4o-mini",
      name: "GPT-4o Mini",
      description: "Cheap and fast",
      context_length: 128000,
      pricing: { prompt: "0.00000015", completion: "0.0000006" },
      supported_parameters: ["tools", "tool_choice"],
      architecture: { modality: "text+image->text" },
    },
    {
      id: "deepseek/deepseek-chat",
      name: "DeepSeek Chat",
      description: "",
      context_length: 64000,
      pricing: { prompt: "0.0000001", completion: "0.0000002" },
      supported_parameters: [],
      architecture: { modality: "text->text" },
    },
  ],
};

describe("fetchOpenRouterModels", () => {
  it("normalizes upstream response into ModelEntry[] in camelCase", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(sample), { status: 200 }));
    const r = await fetchOpenRouterModels({ apiKey: "test", baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    const m0 = r.value[0]!;
    expect(m0.id).toBe("openai/gpt-4o-mini");
    expect(m0.provider).toBe("openrouter");
    expect(m0.contextLength).toBe(128000);
    expect(m0.supportsTools).toBe(true);
    expect(m0.supportsVision).toBe(true);
    expect(m0.pricingPer1mPrompt).toBeCloseTo(0.15, 5); // 0.00000015 * 1e6
  });

  it("returns fetch-error on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const r = await fetchOpenRouterModels({ apiKey: "test", baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("fetch-error");
  });

  it("returns timeout when fetch aborts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new DOMException("aborted", "AbortError")), 10);
    }));
    const r = await fetchOpenRouterModels({ apiKey: "test", baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("timeout");
  });

  it("returns parse-error on malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-json", { status: 200 }));
    const r = await fetchOpenRouterModels({ apiKey: "test", baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("parse-error");
  });
});
```

- [ ] **Step 3: Implement the fetcher**

```ts
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { Result } from "../../util/result.js"; // see Note on Result type at bottom of this plan
import type { ModelEntry } from "./types.js";

const log = getLog(["sentient", "providers", "catalogs", "openrouter"]);

export type OpenRouterFetchError =
  | { kind: "fetch-error"; status: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "parse-error"; reason: string };

export interface OpenRouterFetcherConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

const responseSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional().default(""),
    context_length: z.number().int().nonnegative().optional().default(0),
    pricing: z.object({
      prompt: z.string().or(z.number()),
      completion: z.string().or(z.number()),
    }).optional(),
    supported_parameters: z.array(z.string()).optional().default([]),
    architecture: z.object({
      modality: z.string().optional(),
    }).optional(),
  })),
});

export async function fetchOpenRouterModels(
  config: OpenRouterFetcherConfig,
): Promise<Result<ModelEntry[], OpenRouterFetchError>> {
  const startedAt = Date.now();
  log.info("fetchOpenRouterModels.begin", { baseUrl: config.baseUrl });
  let resp: Response;
  try {
    resp = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      const afterMs = Date.now() - startedAt;
      log.warn("fetchOpenRouterModels.timeout", { afterMs });
      return { ok: false, error: { kind: "timeout", afterMs } };
    }
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("fetchOpenRouterModels.fetchFailed", { reason });
    return { ok: false, error: { kind: "fetch-error", status: 0 } };
  }
  if (!resp.ok) {
    log.warn("fetchOpenRouterModels.nonOk", { status: resp.status });
    return { ok: false, error: { kind: "fetch-error", status: resp.status } };
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: "parse-error", reason } };
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    log.warn("fetchOpenRouterModels.parseFailed", { reason: parsed.error.message });
    return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
  }
  const models: ModelEntry[] = parsed.data.data.map((m) => ({
    id: m.id,
    provider: "openrouter" as const,
    name: m.name,
    description: m.description,
    contextLength: m.context_length,
    pricingPer1mPrompt: m.pricing ? Number(m.pricing.prompt) * 1_000_000 : 0,
    pricingPer1mCompletion: m.pricing ? Number(m.pricing.completion) * 1_000_000 : 0,
    supportsTools: m.supported_parameters.includes("tools"),
    supportsVision: m.architecture?.modality?.includes("image") ?? false,
  }));
  log.info("fetchOpenRouterModels.done", { count: models.length, elapsedMs: Date.now() - startedAt });
  return { ok: true, value: models };
}
```

- [ ] **Step 4: Run tests + typecheck**

```bash
bun run test gateway/src/providers/catalogs/ && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add gateway/src/providers/catalogs/types.ts gateway/src/providers/catalogs/openrouter-fetcher.ts gateway/src/providers/catalogs/openrouter-fetcher.test.ts
git commit -m "feat(providers): OpenRouter models fetcher with normalized ModelEntry"
```

---

## Task 4.3: Ollama Cloud models fetcher + hand-maintained catalog merge

**Why:** Ollama's `/api/tags` returns only id/size/digest. Rich metadata for the picker comes from a hand-maintained `~/.sentient/gateway/shared/catalogs/ollama-models.json`. The fetcher returns `ModelEntry[]` by joining the live tag list with the local catalog (catalog wins for description/context length; live list confirms which models are actually available).

**Files:**
- Create: `gateway/src/providers/catalogs/ollama-fetcher.ts`
- Create: `gateway/src/providers/catalogs/ollama-fetcher.test.ts`
- Create: `gateway/src/providers/catalogs/ollama-catalog-loader.ts`
- Create: `gateway/src/providers/catalogs/ollama-catalog-loader.test.ts`

- [ ] **Step 1: Define the local-catalog file shape**

The local catalog is a JSON array of:

```json
[
  {
    "id": "gpt-oss:120b-cloud",
    "name": "GPT-OSS 120B (Cloud)",
    "description": "...",
    "contextLength": 65536,
    "supportsTools": true,
    "supportsVision": false
  }
]
```

- [ ] **Step 2: Catalog loader test**

```ts
import { describe, expect, it, vi } from "vitest";
import { loadOllamaCatalog } from "./ollama-catalog-loader.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadOllamaCatalog", () => {
  it("returns catalog entries from a valid JSON file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ollama-cat-"));
    const path = join(dir, "ollama-models.json");
    writeFileSync(path, JSON.stringify([{ id: "x", name: "X", description: "", contextLength: 1024, supportsTools: false, supportsVision: false }]));
    const r = await loadOllamaCatalog(path);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(1);
  });

  it("returns empty array when file missing", async () => {
    const r = await loadOllamaCatalog("/nonexistent/path/ollama.json");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it("returns parse-error on malformed JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ollama-cat-"));
    const path = join(dir, "ollama-models.json");
    writeFileSync(path, "not-json");
    const r = await loadOllamaCatalog(path);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Implement loader**

```ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Result } from "../../util/result.js"; // see Note on Result type at bottom of this plan

export interface OllamaCatalogEntry {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const catalogSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  contextLength: z.number().int().nonnegative(),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
}));

export async function loadOllamaCatalog(path: string): Promise<Result<OllamaCatalogEntry[], { kind: "parse-error"; reason: string }>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { ok: true, value: [] };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: { kind: "parse-error", reason: err instanceof Error ? err.message : String(err) } };
  }
  const parsed = catalogSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
  return { ok: true, value: parsed.data };
}
```

- [ ] **Step 4: Ollama tags fetcher tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOllamaCloudModels } from "./ollama-fetcher.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("fetchOllamaCloudModels", () => {
  it("merges live /api/tags with the local catalog by id", async () => {
    const tagsResp = {
      models: [
        { name: "gpt-oss:120b-cloud", size: 1, digest: "x" },
        { name: "deepseek-v3.1:671b-cloud", size: 2, digest: "y" },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(tagsResp), { status: 200 }));
    const catalog = [
      { id: "gpt-oss:120b-cloud", name: "GPT-OSS 120B (Cloud)", description: "Big.", contextLength: 65536, supportsTools: true, supportsVision: false },
    ];
    const r = await fetchOllamaCloudModels({ baseUrl: "https://ollama.com/v1", timeoutMs: 5000 }, catalog);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    const known = r.value.find((m) => m.id === "gpt-oss:120b-cloud");
    expect(known?.name).toBe("GPT-OSS 120B (Cloud)");
    expect(known?.contextLength).toBe(65536);
    expect(known?.pricingPer1mPrompt).toBe("included");
    const unknown = r.value.find((m) => m.id === "deepseek-v3.1:671b-cloud");
    expect(unknown?.name).toBe("deepseek-v3.1:671b-cloud"); // fallback to id
    expect(unknown?.contextLength).toBe(0);
  });

  it("returns empty list when /api/tags returns 200 with no models", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const r = await fetchOllamaCloudModels({ baseUrl: "https://ollama.com/v1", timeoutMs: 5000 }, []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it("returns fetch-error on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const r = await fetchOllamaCloudModels({ baseUrl: "https://ollama.com/v1", timeoutMs: 5000 }, []);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 5: Implement Ollama fetcher**

```ts
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { Result } from "../../util/result.js"; // see Note on Result type at bottom of this plan
import type { ModelEntry } from "./types.js";
import type { OllamaCatalogEntry } from "./ollama-catalog-loader.js";

const log = getLog(["sentient", "providers", "catalogs", "ollama"]);

export type OllamaFetchError =
  | { kind: "fetch-error"; status: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "parse-error"; reason: string };

export interface OllamaFetcherConfig {
  baseUrl: string; // e.g. https://ollama.com/v1
  timeoutMs: number;
}

const tagsSchema = z.object({
  models: z.array(z.object({
    name: z.string(),
    size: z.number().nonnegative().optional(),
    digest: z.string().optional(),
  })),
});

export async function fetchOllamaCloudModels(
  config: OllamaFetcherConfig,
  catalog: OllamaCatalogEntry[],
): Promise<Result<ModelEntry[], OllamaFetchError>> {
  const startedAt = Date.now();
  log.info("fetchOllamaCloudModels.begin", { baseUrl: config.baseUrl, catalogSize: catalog.length });
  // /api/tags is on /api, not /v1 — see ollama docs
  const tagsUrl = config.baseUrl.replace(/\/v1$/, "") + "/api/tags";
  let resp: Response;
  try {
    resp = await fetch(tagsUrl, { signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: { kind: "timeout", afterMs: Date.now() - startedAt } };
    }
    return { ok: false, error: { kind: "fetch-error", status: 0 } };
  }
  if (!resp.ok) return { ok: false, error: { kind: "fetch-error", status: resp.status } };
  let body: unknown;
  try { body = await resp.json(); } catch (err) {
    return { ok: false, error: { kind: "parse-error", reason: err instanceof Error ? err.message : String(err) } };
  }
  const parsed = tagsSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };

  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const merged: ModelEntry[] = parsed.data.models.map((m) => {
    const local = catalogById.get(m.name);
    return {
      id: m.name,
      provider: "ollama-cloud" as const,
      name: local?.name ?? m.name,
      description: local?.description ?? "",
      contextLength: local?.contextLength ?? 0,
      pricingPer1mPrompt: "included" as const,
      pricingPer1mCompletion: "included" as const,
      supportsTools: local?.supportsTools ?? false,
      supportsVision: local?.supportsVision ?? false,
    };
  });
  log.info("fetchOllamaCloudModels.done", { count: merged.length, elapsedMs: Date.now() - startedAt });
  return { ok: true, value: merged };
}
```

- [ ] **Step 6: Run tests + typecheck + commit**

```bash
bun run test gateway/src/providers/catalogs/ && bun run typecheck
git add gateway/src/providers/catalogs/ollama-fetcher.ts gateway/src/providers/catalogs/ollama-fetcher.test.ts gateway/src/providers/catalogs/ollama-catalog-loader.ts gateway/src/providers/catalogs/ollama-catalog-loader.test.ts
git commit -m "feat(providers): Ollama Cloud fetcher with hand-maintained catalog merge"
```

---

## Task 4.4: Fish Audio voices fetcher

**Why:** Phase 6's voice picker needs Fish's `GET /model` normalized into `VoiceEntry[]` with preview URLs. Cache 10min.

**Files:**
- Create: `gateway/src/providers/catalogs/fish-fetcher.ts`
- Create: `gateway/src/providers/catalogs/fish-fetcher.test.ts`

- [ ] **Step 1: Tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFishVoices } from "./fish-fetcher.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("fetchFishVoices", () => {
  it("normalizes Fish /model response into VoiceEntry[]", async () => {
    const sample = {
      items: [
        {
          _id: "v1",
          title: "Bright Friendly",
          description: "Cheerful female",
          languages: ["en"],
          tags: ["female", "warm"],
          cover_image: "https://f.example/cover.jpg",
          samples: [{ audio: "https://f.example/preview.mp3" }],
          visibility: "public",
        },
        {
          _id: "v2",
          title: "Stoic Narrator",
          description: "",
          languages: ["en", "ja"],
          tags: [],
          cover_image: null,
          samples: [],
          visibility: "public",
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(sample), { status: 200 }));
    const r = await fetchFishVoices({ apiKey: "test", baseUrl: "https://api.fish.audio", timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value[0]!.previewAudioUrl).toBe("https://f.example/preview.mp3");
    expect(r.value[1]!.previewAudioUrl).toBeNull(); // no samples → null fallback
    expect(r.value[1]!.coverImageUrl).toBeNull();
  });

  it("returns fetch-error on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    const r = await fetchFishVoices({ apiKey: "bad", baseUrl: "https://api.fish.audio", timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("fetch-error");
  });

  it("returns timeout when fetch aborts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((_, rej) => setTimeout(() => rej(new DOMException("aborted", "AbortError")), 10)));
    const r = await fetchFishVoices({ apiKey: "test", baseUrl: "https://api.fish.audio", timeoutMs: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("timeout");
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { Result } from "../../util/result.js"; // see Note on Result type at bottom of this plan
import type { VoiceEntry } from "./types.js";

const log = getLog(["sentient", "providers", "catalogs", "fish"]);

export type FishFetchError =
  | { kind: "fetch-error"; status: number }
  | { kind: "timeout"; afterMs: number }
  | { kind: "parse-error"; reason: string };

export interface FishFetcherConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

const responseSchema = z.object({
  items: z.array(z.object({
    _id: z.string(),
    title: z.string(),
    description: z.string().optional().default(""),
    languages: z.array(z.string()).optional().default([]),
    tags: z.array(z.string()).optional().default([]),
    cover_image: z.string().nullable().optional(),
    samples: z.array(z.object({ audio: z.string() })).optional().default([]),
    visibility: z.enum(["public", "private"]).optional().default("public"),
  })),
});

export async function fetchFishVoices(
  config: FishFetcherConfig,
): Promise<Result<VoiceEntry[], FishFetchError>> {
  const startedAt = Date.now();
  log.info("fetchFishVoices.begin", { baseUrl: config.baseUrl });
  let resp: Response;
  try {
    resp = await fetch(`${config.baseUrl}/model`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error: { kind: "timeout", afterMs: Date.now() - startedAt } };
    }
    return { ok: false, error: { kind: "fetch-error", status: 0 } };
  }
  if (!resp.ok) return { ok: false, error: { kind: "fetch-error", status: resp.status } };
  let body: unknown;
  try { body = await resp.json(); } catch (err) {
    return { ok: false, error: { kind: "parse-error", reason: err instanceof Error ? err.message : String(err) } };
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: { kind: "parse-error", reason: parsed.error.message } };
  const voices: VoiceEntry[] = parsed.data.items.map((v) => ({
    id: v._id,
    title: v.title,
    description: v.description,
    languages: v.languages,
    tags: v.tags,
    coverImageUrl: v.cover_image ?? null,
    previewAudioUrl: v.samples[0]?.audio ?? null,
    visibility: v.visibility,
  }));
  log.info("fetchFishVoices.done", { count: voices.length, elapsedMs: Date.now() - startedAt });
  return { ok: true, value: voices };
}
```

- [ ] **Step 3: Test, typecheck, commit**

```bash
bun run test gateway/src/providers/catalogs/ && bun run typecheck
git add gateway/src/providers/catalogs/fish-fetcher.ts gateway/src/providers/catalogs/fish-fetcher.test.ts
git commit -m "feat(providers): Fish Audio voices fetcher with VoiceEntry normalization"
```

---

## Task 4.5: Providers HTTP handler + router wiring

**Why:** Boundary. `GET /api/v1/providers/models` merges OpenRouter + Ollama via cache. `GET /api/v1/providers/voices` returns Fish via cache. Both implement stale-on-error.

**Files:**
- Create: `gateway/src/api/handlers/providers.ts`
- Create: `gateway/src/api/handlers/providers.test.ts`
- Modify: `gateway/src/api/router.ts` (add `/api/v1/providers/*` delegation)
- Modify: `gateway/src/api/router.test.ts`

- [ ] **Step 1: Tests for handler**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleProviders } from "./providers.js";

afterEach(() => { vi.restoreAllMocks(); });

const m = (overrides: Record<string, unknown> = {}) => ({
  id: "x", provider: "openrouter", name: "X", description: "",
  contextLength: 0, pricingPer1mPrompt: 0, pricingPer1mCompletion: 0,
  supportsTools: false, supportsVision: false, ...overrides,
});

function deps(overrides: Partial<Parameters<typeof handleProviders>[0]> = {}) {
  return {
    auth: { tokens: { validate: vi.fn().mockResolvedValue({ ok: true, value: { userId: "alice", isAdmin: false } }) } as never },
    listModels: vi.fn().mockResolvedValue({ ok: true, value: [m()] }),
    listVoices: vi.fn().mockResolvedValue({ ok: true, value: [{ id: "v1", title: "T", description: "", languages: [], tags: [], coverImageUrl: null, previewAudioUrl: null, visibility: "public" }] }),
    ...overrides,
  };
}

function req(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { method, headers });
}

describe("handleProviders", () => {
  it("GET /api/v1/providers/models with valid token returns merged list", async () => {
    const d = deps();
    const r = await handleProviders(d as never, req("GET", "/api/v1/providers/models", { authorization: "Bearer t" }));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.models).toHaveLength(1);
  });

  it("GET /api/v1/providers/voices returns voice list", async () => {
    const d = deps();
    const r = await handleProviders(d as never, req("GET", "/api/v1/providers/voices", { authorization: "Bearer t" }));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.voices).toHaveLength(1);
  });

  it("returns 401 without token", async () => {
    const d = deps();
    const r = await handleProviders(d as never, req("GET", "/api/v1/providers/models"));
    expect(r.status).toBe(401);
  });

  it("returns 503 with stale=true when fetch fails and no cache available", async () => {
    const d = deps({ listModels: vi.fn().mockResolvedValue({ ok: false, error: { kind: "upstream-down" } }) });
    const r = await handleProviders(d as never, req("GET", "/api/v1/providers/models", { authorization: "Bearer t" }));
    expect(r.status).toBe(503);
  });

  it("returns 200 with stale=true when fetch fails but cache has stale entries", async () => {
    const d = deps({ listModels: vi.fn().mockResolvedValue({ ok: true, value: [m()], stale: true }) });
    const r = await handleProviders(d as never, req("GET", "/api/v1/providers/models", { authorization: "Bearer t" }));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.stale).toBe(true);
  });
});
```

- [ ] **Step 2: Handler implementation**

```ts
import { getLog } from "../../logging/logger.js";
import type { TokenService } from "../../user-auth/token-service.js";
import type { ModelEntry, VoiceEntry } from "../../providers/catalogs/types.js";
import type { Result } from "../../util/result.js"; // see Note on Result type at bottom of this plan

const log = getLog(["sentient", "api", "handlers", "providers"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_UNAVAILABLE = 503;

export interface ListResult<T> {
  ok: true;
  value: T;
  stale?: boolean;
}
export type ProvidersListResult<T> = ListResult<T> | { ok: false; error: { kind: string } };

export interface ProvidersHandlerDeps {
  auth: { tokens: Pick<TokenService, "validate"> };
  listModels: () => Promise<ProvidersListResult<ModelEntry[]>>;
  listVoices: () => Promise<ProvidersListResult<VoiceEntry[]>>;
}

export async function handleProviders(deps: ProvidersHandlerDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: HTTP_METHOD });
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");
  const valid = await deps.auth.tokens.validate(token);
  if (!valid.ok) return jsonError(HTTP_UNAUTHORIZED, valid.error);

  if (path === "/api/v1/providers/models") {
    const r = await deps.listModels();
    if (!r.ok) return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
    return Response.json({ models: r.value, stale: r.stale ?? false }, { status: HTTP_OK });
  }
  if (path === "/api/v1/providers/voices") {
    const r = await deps.listVoices();
    if (!r.ok) return jsonError(HTTP_UNAVAILABLE, "upstream-unavailable");
    return Response.json({ voices: r.value, stale: r.stale ?? false }, { status: HTTP_OK });
  }
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
```

- [ ] **Step 3: Compose `listModels` and `listVoices` in a dedicated file**

Do **not** inline this composition into `main.ts` — that file is already big. Create a new file `gateway/src/api/providers-deps.ts` that exports `createProvidersDeps(config, paths)` returning the `{ listModels, listVoices }` pair. `main.ts` imports + plugs it into `handleProviders` deps. Add a basic test for the composition in `providers-deps.test.ts` that mocks each fetcher and verifies caching behavior (cache hit, cache miss + populate, both fail + return stale).

Implementation sketch:

```ts
import { createTtlCache } from "./util/ttl-cache.js";
import { fetchOpenRouterModels } from "./providers/catalogs/openrouter-fetcher.js";
import { fetchOllamaCloudModels } from "./providers/catalogs/ollama-fetcher.js";
import { loadOllamaCatalog } from "./providers/catalogs/ollama-catalog-loader.js";
import { fetchFishVoices } from "./providers/catalogs/fish-fetcher.js";

const modelCache = createTtlCache<ModelEntry[]>();
const voiceCache = createTtlCache<VoiceEntry[]>();

async function listModels(): Promise<ProvidersListResult<ModelEntry[]>> {
  const cached = modelCache.get("all");
  if (cached) return { ok: true, value: cached };
  const orKey = process.env.OPENROUTER_API_KEY ?? "";
  const orR = await fetchOpenRouterModels({ apiKey: orKey, baseUrl: "https://openrouter.ai/api/v1", timeoutMs: config.providers.external_fetch_timeout_ms });
  const ollamaCatalog = await loadOllamaCatalog(getSharedCatalogsDir() + "/ollama-models.json");
  const ollamaR = await fetchOllamaCloudModels(
    { baseUrl: config.providers.ollama_cloud_base_url, timeoutMs: config.providers.external_fetch_timeout_ms },
    ollamaCatalog.ok ? ollamaCatalog.value : [],
  );
  const merged: ModelEntry[] = [];
  if (orR.ok) merged.push(...orR.value);
  if (ollamaR.ok) merged.push(...ollamaR.value);
  if (merged.length > 0) {
    modelCache.set("all", merged, config.providers.openrouter_cache_ttl_ms);
    return { ok: true, value: merged };
  }
  // both failed — try stale
  const stale = modelCache.getStale("all");
  if (stale) return { ok: true, value: stale, stale: true };
  return { ok: false, error: { kind: "upstream-down" } };
}

async function listVoices(): Promise<ProvidersListResult<VoiceEntry[]>> {
  const cached = voiceCache.get("all");
  if (cached) return { ok: true, value: cached };
  const fishKey = process.env.FISH_AUDIO_API_KEY ?? "";
  const r = await fetchFishVoices({ apiKey: fishKey, baseUrl: "https://api.fish.audio", timeoutMs: config.providers.external_fetch_timeout_ms });
  if (r.ok) {
    voiceCache.set("all", r.value, config.providers.fish_cache_ttl_ms);
    return { ok: true, value: r.value };
  }
  const stale = voiceCache.getStale("all");
  if (stale) return { ok: true, value: stale, stale: true };
  return { ok: false, error: { kind: "upstream-down" } };
}
```

- [ ] **Step 4: Wire `/api/v1/providers/*` into router**

```ts
if (path.startsWith("/api/v1/providers/")) return handleProviders(deps, request);
```

- [ ] **Step 5: Run all tests + typecheck**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 6: Commit**

```bash
git add gateway/src/api/handlers/providers.ts gateway/src/api/handlers/providers.test.ts gateway/src/api/providers-deps.ts gateway/src/api/providers-deps.test.ts gateway/src/api/router.ts gateway/src/api/router.test.ts gateway/src/main.ts
git commit -m "feat(api): /api/v1/providers/{models,voices} with TTL cache and stale-on-error"
```

---

## Note on Result type

The plan imports `Result<T, E>` from `gateway/src/util/result.js`. As of the start of this phase, that file may or may not exist:

- If a `Result<T, E>` type already lives somewhere else in the gateway (search: `grep -rn "type Result<" gateway/src/`), reuse that import path. Common candidates: `gateway/src/user-auth/types.ts`, or a re-export from `@sentient/protocol`.
- If no shared type exists, **create one** in `gateway/src/util/result.ts` as your very first action in Task 3.3:

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

Either way, every new file in this plan that needs `Result` should import from one consistent location. Do not redeclare it inside individual modules.

---

## Phase 3+4 Acceptance

When all 11 tasks above are complete, the controller verifies:

- [ ] `bun run typecheck` clean.
- [ ] `bun run test` clean. All tests pass; no skipped tests outside the documented `@live` tag.
- [ ] `wc -l` on every new file ≤300; every function ≤40 lines.
- [ ] Git log shows ~11 commits with the expected `type(scope):` prefixes.
- [ ] Handler shapes match the spec:
  - `POST /api/v1/profile/apply` → 200 `{status:"ready", elapsedMs}` on success; 401, 404, 422, 502, 504 with typed `{error}` payloads on failure.
  - `GET /api/v1/providers/models` → 200 `{models: ModelEntry[], stale: boolean}`; 401; 503 when no cache.
  - `GET /api/v1/providers/voices` → 200 `{voices: VoiceEntry[], stale: boolean}`; 401; 503 when no cache.
- [ ] Spec §3.3 / §6.6 / §7.3 / §10 / §12.1 are referenced and reflected in code (no leftover `flush_timeout_ms` / `idle_flush_ms` / `docker_stop_grace_ms` references).
- [ ] Manual smoke (controller, after autonomous run): hit `POST /api/v1/profile/apply` with a valid token; observe `docker restart` happens and `/health` polling waits before responding 200. Smoke takes ~7–10s.

---

## Out of Scope (do NOT touch)

- Any webui code (Phase 5+).
- Idle-flush scheduler in the gateway (Hermes's own watcher handles this).
- Hermes plugin development (see spec §11).
- Per-user provider API keys (system-wide secrets only this cycle).
- `~/.sentient/gateway/secrets.json` migration (Phase 4 reads from `process.env.OPENROUTER_API_KEY` and `process.env.FISH_AUDIO_API_KEY` — same as today).
- Admin endpoints (Phase 7).
- Apply scheduling / queue (single in-flight apply per user is fine for MVP — concurrency is a Phase 6 UI concern).

If you find yourself wanting to edit any of the above, stop and surface to the controller. The Phase 1+2 bundle proved that respecting these boundaries cleanly halves review effort.
