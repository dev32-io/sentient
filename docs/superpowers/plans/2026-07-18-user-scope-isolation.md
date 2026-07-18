# User-Scope Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `PersonSession` the gateway's outermost per-user scope so a client-supplied `surfaceId` can never address another user's Hermes wire, cycle lease, or conversation anchor — closing the cross-account identity leak.

**Architecture:** Move the three `surfaceId`-keyed process-global registries (ACP wire pool, surface cycle registry, conversation anchors) *into* `PersonSession` (one instance per `userId`, obtained via `personSessions.getOrCreate(authUserId)`). Reuse the registry classes verbatim — change only their instantiation site. Preserve the existing buffer-reap sweep as the single reap clock; add lifecycle guards so a wire/lease can never outlive its `PersonSession`.

**Tech Stack:** Bun, TypeScript (strict), Vitest, zod. Gateway `gateway/`.

## Global Constraints

- Gateway version: `gateway/package.json` is `1.13.1` (already bumped on this branch). Do not change further.
- Files stay under 300 lines; functions under 40 lines; max nesting depth 3 (`.claude/rules/clean-code.md`).
- Tagged logger only, no bare `console.*`. Log state changes with prev/next + trigger, IDs (`userId`, `surfaceId`, `sessionId`, `cycleId`) where available (`.claude/rules/logging.md`).
- Never log user/chat content (message text, transcripts, raw frames) at any level — ids/lengths/types only.
- Tests pin wire/protocol contracts, FSM/invariants, security boundaries only (`.claude/rules/testing.md`). No factory-wiring/DI-plumbing tests.
- `bun run` requires `source scripts/env.sh` first.
- Work stays on `feature/user-scope-isolation`. Atomic commits, `type(scope): description`.
- No client, Hermes, or config-schema changes. `surfaceId` wire field unchanged.

**Spec:** `docs/superpowers/specs/2026-07-18-user-scope-isolation-design.md`

---

## File Structure

**Modified:**
- `gateway/src/hermes-adapter-client/acp-wire-registry.ts` — add `ownerUserId` stamp/assert + `hasLiveWires()` + `disposeAll()`.
- `gateway/src/session-handlers/surface-cycle-registry.ts` — add `hasActiveLease()` + `abortAll()`.
- `gateway/src/person-session/person-session.ts` — own `wires`, `cycles`, anchors; retention guard; `dispose()`.
- `gateway/src/person-session/person-session-registry.ts` — call `dispose()` on removal; retention includes wires/cycles.
- `gateway/src/session-router.ts` — remove anchors; binding drops `conversationId`.
- `gateway/src/session-handlers/ws-session-configure.ts` — route wire/cycle/anchor through `personSession`; Tier-3 assertion; source `conversationId` from anchor.
- `gateway/src/session-handlers/ws-handlers.ts` — `dropAnchor` closure targets `personSession`.
- `gateway/src/apply/orchestrator.ts` + `gateway/src/apply/apply-deps.ts` — `personSessions` dep; `clearAllAnchors()`.
- `gateway/src/hermes-adapter-client/per-user-plugin.ts` — `listSessionsForUser` dials ephemeral wire directly; drop `acpWireRegistry` dep.
- `gateway/src/bootstrap/phase-routes.ts`, `gateway/src/bootstrap/create-gateway-services.ts`, `gateway/src/server.ts` — remove global `acpWireRegistry` + `surfaceCycles`.

**Test files:** co-located `*.test.ts` next to each modified unit; new isolation regression test in `acp-wire-registry.test.ts` / `person-session.test.ts`.

---

## Task 1: Extend AcpWireRegistry (owner stamp + lifecycle methods)

**Files:**
- Modify: `gateway/src/hermes-adapter-client/acp-wire-registry.ts`
- Test: `gateway/src/hermes-adapter-client/acp-wire-registry.test.ts`

**Interfaces:**
- Consumes: existing `AcpWireHandle { acpConn, dispose }`, `AcpWireDialFn`.
- Produces:
  - `createAcpWireRegistry(ownerUserId: string): AcpWireRegistry`
  - `AcpWireRegistry.hasLiveWires(): boolean` — true iff any pooled entry exists.
  - `AcpWireRegistry.disposeAll(): void` — force-dispose every pooled handle regardless of refCount; clears the pool.
  - `acquire` stamps `ownerUserId` on the resolved handle and, on cache-hit reuse, asserts the stored owner equals `ownerUserId` (logs `error` + refuses by re-throwing if not — the regression canary).

- [ ] **Step 1: Write failing tests**

Append to `acp-wire-registry.test.ts`:

```ts
it("hasLiveWires reflects pooled entries", async () => {
  const reg = createAcpWireRegistry("u_00000001");
  expect(reg.hasLiveWires()).toBe(false);
  const handle = { acpConn: {} as never, dispose: () => {} };
  await reg.acquire("surface-a", async () => handle);
  expect(reg.hasLiveWires()).toBe(true);
  reg.release("surface-a");
  expect(reg.hasLiveWires()).toBe(false);
});

it("disposeAll force-disposes every pooled handle and clears the pool", async () => {
  const reg = createAcpWireRegistry("u_00000001");
  let disposedA = 0;
  let disposedB = 0;
  await reg.acquire("a", async () => ({ acpConn: {} as never, dispose: () => { disposedA++; } }));
  await reg.acquire("b", async () => ({ acpConn: {} as never, dispose: () => { disposedB++; } }));
  reg.disposeAll();
  expect(disposedA).toBe(1);
  expect(disposedB).toBe(1);
  expect(reg.hasLiveWires()).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL** (`hasLiveWires`/`disposeAll` not a function, arity mismatch)

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- acp-wire-registry`
Expected: FAIL.

- [ ] **Step 3: Implement**

Change the factory signature and internals in `acp-wire-registry.ts`:

```ts
const log = getLog(["sentient", "hermes-adapter-client", "acp-wire-registry"]);

export interface AcpWireHandle {
  readonly acpConn: AcpPerProfileConnection;
  dispose(): void;
}

interface PoolEntry {
  readonly dialPromise: Promise<AcpWireHandle>;
  handle: AcpWireHandle | null;
  refCount: number;
  /** Owner stamped at dial resolution — the regression canary (§4.3). */
  ownerUserId: string;
}

export interface AcpWireRegistry {
  acquire(surfaceId: string, dial: AcpWireDialFn): Promise<AcpPerProfileConnection>;
  release(surfaceId: string): void;
  refCount(surfaceId: string): number;
  /** True iff any wire is still pooled (retention guard input). */
  hasLiveWires(): boolean;
  /** Force-dispose every pooled handle (PersonSession.dispose backstop). */
  disposeAll(): void;
}

export function createAcpWireRegistry(ownerUserId: string): AcpWireRegistry {
  const pool = new Map<string, PoolEntry>();

  async function acquire(surfaceId: string, dial: AcpWireDialFn): Promise<AcpPerProfileConnection> {
    const existing = pool.get(surfaceId);
    if (existing) {
      existing.refCount += 1;
      log.info("acquire.reuse", { ownerUserId, surfaceId, refCount: existing.refCount });
      const handle = await existing.dialPromise;
      // Regression canary: within a per-user pool this is always true. If it
      // ever fires, a shared pool was reintroduced — fail closed.
      if (existing.ownerUserId !== ownerUserId) {
        log.error("acquire.owner-mismatch", { surfaceId, stored: existing.ownerUserId, expected: ownerUserId });
        throw new Error("acp-wire-registry: owner mismatch on cache hit");
      }
      return handle.acpConn;
    }

    log.info("acquire.dial", { ownerUserId, surfaceId });
    const dialPromise = dial();
    const entry: PoolEntry = { dialPromise, handle: null, refCount: 1, ownerUserId };
    pool.set(surfaceId, entry);

    try {
      const handle = await dialPromise;
      entry.handle = handle;
      log.info("acquire.dial-ok", { ownerUserId, surfaceId, refCount: entry.refCount });
      return handle.acpConn;
    } catch (err: unknown) {
      if (pool.get(surfaceId) === entry) pool.delete(surfaceId);
      log.warn("acquire.dial-failed", { ownerUserId, surfaceId, reason: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  function release(surfaceId: string): void {
    const entry = pool.get(surfaceId);
    if (!entry) {
      log.debug("release.noop", { ownerUserId, surfaceId, reason: "no-pooled-wire" });
      return;
    }
    entry.refCount -= 1;
    log.info("release", { ownerUserId, surfaceId, refCount: entry.refCount });
    if (entry.refCount > 0) return;
    pool.delete(surfaceId);
    if (entry.handle !== null) {
      log.info("release.dispose", { ownerUserId, surfaceId });
      entry.handle.dispose();
      return;
    }
    log.info("release.dispose-pending-dial", { ownerUserId, surfaceId });
    entry.dialPromise.then((handle) => handle.dispose()).catch(() => {});
  }

  function refCount(surfaceId: string): number {
    return pool.get(surfaceId)?.refCount ?? 0;
  }

  function hasLiveWires(): boolean {
    return pool.size > 0;
  }

  function disposeAll(): void {
    if (pool.size === 0) return;
    log.warn("disposeAll", { ownerUserId, count: pool.size });
    for (const [surfaceId, entry] of pool) {
      if (entry.handle !== null) {
        entry.handle.dispose();
      } else {
        entry.dialPromise.then((h) => h.dispose()).catch(() => {});
      }
      log.debug("disposeAll.entry", { ownerUserId, surfaceId, refCount: entry.refCount });
    }
    pool.clear();
  }

  return { acquire, release, refCount, hasLiveWires, disposeAll };
}
```

- [ ] **Step 4: Run — expect PASS** (all `acp-wire-registry` tests, including the existing ones — update any existing test that called `createAcpWireRegistry()` with no arg to pass a `userId` string).

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- acp-wire-registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/hermes-adapter-client/acp-wire-registry.ts gateway/src/hermes-adapter-client/acp-wire-registry.test.ts
git commit -m "feat(gateway): AcpWireRegistry owner stamp + hasLiveWires + disposeAll"
```

---

## Task 2: Extend SurfaceCycleRegistry (active-lease query + abortAll)

**Files:**
- Modify: `gateway/src/session-handlers/surface-cycle-registry.ts`
- Test: `gateway/src/session-handlers/surface-cycle-registry.test.ts`

**Interfaces:**
- Produces:
  - `SurfaceCycleRegistry.hasActiveLease(): boolean` — true iff any surface slot is held.
  - `SurfaceCycleRegistry.abortAll(): void` — abort every slot's controller, wake every `whenReleased` waiter, clear slots.

- [ ] **Step 1: Write failing tests**

Append to `surface-cycle-registry.test.ts`:

```ts
it("hasActiveLease reflects held slots", () => {
  const reg = createSurfaceCycleRegistry();
  expect(reg.hasActiveLease()).toBe(false);
  reg.acquire("s", "c1", new AbortController());
  expect(reg.hasActiveLease()).toBe(true);
  reg.complete("s", "c1");
  expect(reg.hasActiveLease()).toBe(false);
});

it("abortAll aborts controllers and wakes waiters", async () => {
  const reg = createSurfaceCycleRegistry();
  const ctrl = new AbortController();
  reg.acquire("s", "c1", ctrl);
  let released = false;
  const wait = reg.whenReleased("s").then(() => { released = true; });
  reg.abortAll();
  await wait;
  expect(ctrl.signal.aborted).toBe(true);
  expect(released).toBe(true);
  expect(reg.hasActiveLease()).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL** (`hasActiveLease`/`abortAll` not a function)

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- surface-cycle-registry`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to the returned object in `createSurfaceCycleRegistry` (after `currentController`):

```ts
    hasActiveLease(): boolean {
      return slots.size > 0;
    },

    abortAll(): void {
      if (slots.size === 0 && waiters.size === 0) return;
      log.warn("abortAll", { slots: slots.size, waiterKeys: waiters.size });
      for (const [surfaceKey, slot] of slots) {
        try {
          slot.controller.abort("person-session-dispose");
        } catch {
          /* already aborted */
        }
        log.debug("abortAll.slot", { surfaceKey, cycleId: slot.cycleId });
      }
      slots.clear();
      for (const [, arr] of waiters) {
        for (const r of arr) r();
      }
      waiters.clear();
    },
```

Add the two methods to the `SurfaceCycleRegistry` interface:

```ts
  /** True iff any surface slot is currently held (retention guard input). */
  hasActiveLease(): boolean;
  /** Abort every held slot + wake every waiter (PersonSession.dispose backstop). */
  abortAll(): void;
```

- [ ] **Step 4: Run — expect PASS**

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- surface-cycle-registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session-handlers/surface-cycle-registry.ts gateway/src/session-handlers/surface-cycle-registry.test.ts
git commit -m "feat(gateway): SurfaceCycleRegistry hasActiveLease + abortAll"
```

---

## Task 3: PersonSession owns wires, cycles, anchors + dispose()

**Files:**
- Modify: `gateway/src/person-session/person-session.ts`
- Test: `gateway/src/person-session/person-session.test.ts`

**Interfaces:**
- Consumes: `createAcpWireRegistry(ownerUserId)` (Task 1), `createSurfaceCycleRegistry()` (Task 2).
- Produces on `PersonSession`:
  - `readonly wires: AcpWireRegistry`
  - `readonly cycles: SurfaceCycleRegistry`
  - `conversationIdFor(surfaceId: string): string | null`
  - `updateConversationId(surfaceId: string, conversationId: string): void`
  - `dropAnchor(surfaceId: string): void`
  - `clearAllAnchors(): void`
  - `hasLiveResources(): boolean` — `hasRetainedBuffers() || wires.hasLiveWires() || cycles.hasActiveLease()`
  - `dispose(): void` — `wires.disposeAll()`, `cycles.abortAll()`, clear anchors; warn if any residual existed.

Note: `PersonSession.userId` is `string | null` today. The registry needs a non-null owner id; use `this.userId ?? this.profile` as `ownerUserId` (profile is always set). Add this at construction.

- [ ] **Step 1: Write failing tests**

Append to `person-session.test.ts`:

```ts
function makeSession(): PersonSession {
  return new PersonSession({
    profile: "u_00000001",
    hermesUrl: "http://localhost:1/ws",
    hermesApiKey: "k",
    userId: "u_00000001",
    replayBufferMaxBytes: 1024,
  });
}

it("owns per-user wire and cycle registries", () => {
  const s = makeSession();
  expect(s.wires.hasLiveWires()).toBe(false);
  expect(s.cycles.hasActiveLease()).toBe(false);
});

it("anchors are per-surface read/write/drop", () => {
  const s = makeSession();
  expect(s.conversationIdFor("surf")).toBeNull();
  s.updateConversationId("surf", "conv-1");
  expect(s.conversationIdFor("surf")).toBe("conv-1");
  s.dropAnchor("surf");
  expect(s.conversationIdFor("surf")).toBeNull();
});

it("clearAllAnchors drops every anchor", () => {
  const s = makeSession();
  s.updateConversationId("a", "c1");
  s.updateConversationId("b", "c2");
  s.clearAllAnchors();
  expect(s.conversationIdFor("a")).toBeNull();
  expect(s.conversationIdFor("b")).toBeNull();
});

it("hasLiveResources is true while a wire is pooled even with no buffers", async () => {
  const s = makeSession();
  expect(s.hasLiveResources()).toBe(false);
  await s.wires.acquire("surf", async () => ({ acpConn: {} as never, dispose: () => {} }));
  expect(s.hasLiveResources()).toBe(true);
  s.wires.release("surf");
  expect(s.hasLiveResources()).toBe(false);
});

it("dispose force-disposes wires, aborts cycles, clears anchors", async () => {
  const s = makeSession();
  let disposed = 0;
  await s.wires.acquire("surf", async () => ({ acpConn: {} as never, dispose: () => { disposed++; } }));
  const ctrl = new AbortController();
  s.cycles.acquire("surf", "c1", ctrl);
  s.updateConversationId("surf", "c1");
  s.dispose();
  expect(disposed).toBe(1);
  expect(ctrl.signal.aborted).toBe(true);
  expect(s.conversationIdFor("surf")).toBeNull();
  expect(s.hasLiveResources()).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- person-session.test`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `person-session.ts`, add imports:

```ts
import { type AcpWireRegistry, createAcpWireRegistry } from "../hermes-adapter-client/acp-wire-registry.js";
import { type SurfaceCycleRegistry, createSurfaceCycleRegistry } from "../session-handlers/surface-cycle-registry.js";
```

Add fields + construction (inside the class, near `_deviceBuffers`):

```ts
  readonly wires: AcpWireRegistry;
  readonly cycles: SurfaceCycleRegistry;
  /** surfaceId → conversationId. Moved out of SessionRouter: anchor lifetime is
   *  the surface's lifetime WITHIN this user's scope (never global). */
  private readonly _anchors = new Map<string, string>();
```

In the constructor (after `this._deviceBuffers = ...`):

```ts
    const ownerUserId = init.userId ?? init.profile;
    this.wires = createAcpWireRegistry(ownerUserId);
    this.cycles = createSurfaceCycleRegistry();
```

Add methods (before `get isIdle`):

```ts
  conversationIdFor(surfaceId: string): string | null {
    return this._anchors.get(surfaceId) ?? null;
  }

  updateConversationId(surfaceId: string, conversationId: string): void {
    const prev = this._anchors.get(surfaceId) ?? null;
    this._anchors.set(surfaceId, conversationId);
    log.debug("updateConversationId", { profile: this.profile, surfaceId, prev, next: conversationId });
  }

  dropAnchor(surfaceId: string): void {
    if (!this._anchors.delete(surfaceId)) return;
    log.debug("dropAnchor", { profile: this.profile, surfaceId });
  }

  clearAllAnchors(): void {
    const count = this._anchors.size;
    if (count === 0) return;
    this._anchors.clear();
    log.info("clearAllAnchors", { profile: this.profile, count });
  }

  /**
   * Retention input for the registry sweep. A live wire or held cycle lease
   * blocks eviction just as a retained buffer does — belt-and-suspenders so a
   * wire/lease can never outlive its PersonSession (§5.2).
   */
  hasLiveResources(): boolean {
    return this.hasRetainedBuffers() || this.wires.hasLiveWires() || this.cycles.hasActiveLease();
  }

  /**
   * Final teardown when the registry removes this PersonSession. Force-disposes
   * any residual wire (cancels its lazy reconnect), aborts any residual cycle
   * lease (wakes waiters so no onCycle hangs), and drops anchors. Residuals are
   * a leak-in-the-making — disposeAll/abortAll already warn.
   */
  dispose(): void {
    log.info("dispose", { profile: this.profile, userId: this.userId });
    this.wires.disposeAll();
    this.cycles.abortAll();
    this._anchors.clear();
  }
```

- [ ] **Step 4: Run — expect PASS**

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- person-session.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/person-session/person-session.ts gateway/src/person-session/person-session.test.ts
git commit -m "feat(gateway): PersonSession owns wires/cycles/anchors + dispose()"
```

---

## Task 4: PersonSessionRegistry — dispose on removal, retention includes wires/cycles

**Files:**
- Modify: `gateway/src/person-session/person-session-registry.ts` (sweep block, lines 120-137)
- Test: `gateway/src/person-session/person-session-registry.test.ts`

**Interfaces:**
- Consumes: `PersonSession.hasLiveResources()`, `PersonSession.dispose()` (Task 3).
- Produces: sweep uses `hasLiveResources()` (not raw `hasRetainedBuffers()`) as the eviction guard and calls `session.dispose()` immediately before `sessions.delete`.

- [ ] **Step 1: Write failing test**

Append to `person-session-registry.test.ts` (follow the file's existing construction helper for `createPersonSessionRegistry`; a live wire must block eviction and removal must dispose):

```ts
it("a live wire blocks eviction; removal disposes the session", async () => {
  const registry = createPersonSessionRegistry({
    hermes: FAKE_HERMES,             // reuse the file's existing fixture
    userPortStore: FAKE_PORT_STORE,  // reuse the file's existing fixture
    apiKeyResolver: () => "k",
    idleTimeoutMs: 1000,
    replayBufferMaxBytes: 1024,
  });
  const s = await registry.getOrCreate("u_00000001");
  if (!s) throw new Error("expected session");

  // Acquire a wire but NO buffer → hasRetainedBuffers() false, hasLiveWires() true.
  let disposed = 0;
  await s.wires.acquire("surf", async () => ({ acpConn: {} as never, dispose: () => { disposed++; } }));

  // Sweep far past the idle timeout — must NOT remove (wire still live).
  registry.sweep(Date.now() + 10_000);
  expect(registry.get("u_00000001")).not.toBeNull();

  // Release the wire, then sweep — now removable, and dispose() runs.
  s.wires.release("surf");
  registry.sweep(Date.now() + 10_000);
  expect(registry.get("u_00000001")).toBeNull();
  expect(disposed).toBe(1); // disposeAll on an empty pool is a no-op; the release already disposed
});
```

Note: the release already disposed the wire (refCount 0), so `disposed === 1` from the release path; `dispose()` on removal finds an empty pool and no-ops. The assertion pins that removal does not double-dispose and that a live wire blocks eviction.

- [ ] **Step 2: Run — expect FAIL** (session removed while wire live; or `hasLiveResources`/`dispose` not called)

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- person-session-registry`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `person-session-registry.ts`, change the `sweep` loop body (currently lines 125-133):

```ts
    for (const [userId, session] of sessions) {
      sessionsChecked += 1;
      buffersEvicted += session.sweepIdle(nowMs, idleTimeoutMs);
      if (!session.hasLiveResources()) {
        session.dispose();
        sessions.delete(userId);
        sessionsRemoved += 1;
        log.info("sweep.session-removed", { userId, ageMs: session.ageMs });
      }
    }
```

- [ ] **Step 4: Run — expect PASS** (this test + the full `person-session-registry` suite)

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- person-session-registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/person-session/person-session-registry.ts gateway/src/person-session/person-session-registry.test.ts
git commit -m "feat(gateway): registry sweep guards on live wires/cycles + disposes session"
```

---

## Task 5: SessionRouter — remove anchors, binding drops conversationId

**Files:**
- Modify: `gateway/src/session-router.ts`
- Test: `gateway/src/session-router.test.ts` (if present; otherwise assert via the callers' tests)

**Interfaces:**
- Produces: `SessionRouter` no longer exposes `updateConversationId`, `dropAnchor`, `clearConversationIdForAllSessions`. `HermesProfileBinding.conversationId` returned by `get()`/`bind()`/`rebind()` is always `null` (the anchor now lives on `PersonSession`). `rebind` no longer touches anchors.

- [ ] **Step 1: Write/adjust failing test**

In `session-router.test.ts`, remove/adjust any test asserting anchor behavior on the router; add:

```ts
it("get() returns a binding with null conversationId (anchors moved to PersonSession)", async () => {
  const router = createSessionRouter({ hermes: FAKE_HERMES, userPortStore: FAKE_PORT_STORE, apiKeyResolver: () => "k" });
  await router.bind("sid", "u_00000001", "surf");
  expect(router.get("sid")?.conversationId).toBeNull();
});
```

- [ ] **Step 2: Run — expect FAIL** (compile error: methods still reference `anchors`, or the anchor-behavior tests still exist)

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- session-router`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `session-router.ts`:
- Delete the `anchors` map (line 62).
- Delete `updateConversationId`, `dropAnchor`, `clearConversationIdForAllSessions` from the interface (lines 25-38) and the implementation (lines 153-192).
- `get()` returns `conversationId: null`:

```ts
    get(sessionId) {
      const b = bindings.get(sessionId) ?? null;
      if (b === null) return null;
      return { userId: b.userId, url: b.url, apiKey: b.apiKey, conversationId: null };
    },
```

- In `rebind`, delete the `anchors.delete(prior.surfaceId)` line (the anchor drop now happens via `PersonSession` in the caller; rebind only rewrites the binding).
- `InternalBinding.surfaceId` is now unused for anchors but keep it — `release`/`rebind`/`findActiveSessionFor` logging still references surface; it is harmless. (If lint flags it unused, keep it: it is read in `release` log at line 111.)

- [ ] **Step 4: Run — expect PASS** (`session-router` suite)

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- session-router`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session-router.ts gateway/src/session-router.test.ts
git commit -m "refactor(gateway): move conversation anchors off SessionRouter"
```

---

## Task 6: Migrate ws-session-configure to personSession-owned registries + Tier-3 assertion

**Files:**
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`
- Modify: `gateway/src/session-handlers/ws-handlers.ts` (the `dropAnchor` closure capture only — see below)

**Interfaces:**
- Consumes: `personSession.wires`, `personSession.cycles`, `personSession.conversationIdFor/updateConversationId/dropAnchor` (Task 3); `SessionRouter.get` returning `conversationId: null` (Task 5).

- [ ] **Step 1: Add the Tier-3 boundary assertion**

Right after `personSession` is resolved (`ws-session-configure.ts` ~line 201-206), add:

```ts
  if (personSession.userId !== userId) {
    log.error("person-session.owner-mismatch", { sessionId, expected: userId, got: personSession.userId });
    sendError(ws, "protocol_error", "Session identity mismatch");
    return;
  }
```

- [ ] **Step 2: Route the ACP wire acquire through personSession.wires**

Change the `acquireAcpWireOrFail` call (line ~250-261): replace `registry: services.acpWireRegistry` with `registry: personSession.wires`. The `AcquireAcpWireOrFailInput.registry` type is `AcpWireRegistry` — unchanged.

- [ ] **Step 3: Route the anchor drop through personSession**

Replace line 269:

```ts
  ws.data.dropAnchor = () => personSession.dropAnchor(surfaceId);
```

(`ws-handlers.ts` `teardownPipelineResources` already invokes `captured.dropAnchor?.()` — no change there beyond the closure target, which is captured from `ws.data.dropAnchor`.)

- [ ] **Step 4: Route the surface-cycle gate through personSession.cycles**

In `onCycle`, replace the four `services.surfaceCycles` references (lines 657, 668, 672, 724) with `personSession.cycles`:

```ts
        let admission = admitCycle(personSession.cycles, surfaceId, params.cycleId, controller);
        // ...
          await waitForReleaseOrAbort(personSession.cycles.whenReleased(surfaceId), controller.signal);
        // ...
          admission = admitCycle(personSession.cycles, surfaceId, params.cycleId, controller);
        // ...
          personSession.cycles.complete(surfaceId, params.cycleId);
```

- [ ] **Step 5: Source conversationId from the anchor + write it back to the anchor**

In `onCycle`, after `const binding = services.sessionRouter.get(sessionId)` (line ~625) and the null-check, source the anchor into the binding passed to the dispatcher:

```ts
        const anchoredConversationId = personSession.conversationIdFor(surfaceId);
        const bindingWithAnchor = { ...binding, conversationId: anchoredConversationId };
```

Pass `binding: bindingWithAnchor` into `dispatchHermesCycle` (replace `binding,` in the dispatch args, line ~708). Replace the write-back (lines 716-718):

```ts
          if (result.conversationId && result.conversationId !== anchoredConversationId) {
            personSession.updateConversationId(surfaceId, result.conversationId);
          }
```

- [ ] **Step 6: Run gateway typecheck + the session-configure-adjacent suites**

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' typecheck && bun run --filter '@sentient/gateway' test -- ws-session-configure`
Expected: PASS (typecheck clean; existing behavior tests green).

- [ ] **Step 7: Commit**

```bash
git add gateway/src/session-handlers/ws-session-configure.ts gateway/src/session-handlers/ws-handlers.ts
git commit -m "feat(gateway): route wire/cycle/anchor through PersonSession + owner assert"
```

---

## Task 7: Migrate apply orchestrator to clearAllAnchors via personSessions

**Files:**
- Modify: `gateway/src/apply/orchestrator.ts` (line 174), `gateway/src/apply/apply-deps.ts`
- Test: `gateway/src/apply/*.test.ts`

**Interfaces:**
- Consumes: `PersonSessionRegistry.get(userId)`, `PersonSession.clearAllAnchors()` (Task 3).
- Produces: `ApplyDeps` gains `personSessions: PersonSessionRegistry`; the apply flow clears anchors on the resolved PersonSession.

- [ ] **Step 1: Write/adjust failing test**

In the apply orchestrator test, assert `clearAllAnchors` is called on the user's PersonSession instead of `sessionRouter.clearConversationIdForAllSessions`:

```ts
it("apply clears the user's conversation anchors", async () => {
  const cleared: string[] = [];
  const fakeSession = { clearAllAnchors: () => cleared.push("u_00000001") };
  const deps = makeApplyDeps({ personSessions: { get: () => fakeSession } as never });
  await runApply(deps, "u_00000001");
  expect(cleared).toEqual(["u_00000001"]);
});
```

- [ ] **Step 2: Run — expect FAIL** (`personSessions` not on deps; `clearConversationIdForAllSessions` gone)

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- apply`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `apply-deps.ts`: add `readonly personSessions: PersonSessionRegistry;` to `ApplyDepsServices` (import the type) and pass `personSessions: services.personSessions` in the deps builder (line ~71).
- `orchestrator.ts`: add `personSessions: PersonSessionRegistry;` to `ApplyDeps` (line ~25, import the type). Replace line 174:

```ts
  deps.personSessions.get(userId)?.clearAllAnchors();
```

- [ ] **Step 4: Run — expect PASS**

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- apply`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/apply/orchestrator.ts gateway/src/apply/apply-deps.ts gateway/src/apply/*.test.ts
git commit -m "refactor(gateway): apply clears anchors via PersonSession"
```

---

## Task 8: Migrate listSessionsForUser to a direct ephemeral wire; drop pool dep

**Files:**
- Modify: `gateway/src/hermes-adapter-client/per-user-plugin.ts`
- Test: `gateway/src/hermes-adapter-client/per-user-plugin.test.ts` (if present)

**Interfaces:**
- Produces: `PerUserPluginDeps` no longer has `acpWireRegistry`. `listSessionsForUser` dials `bootstrapAcpWire` directly (ephemeral), uses it, and `dispose()`s in `finally`.

- [ ] **Step 1: Adjust/write test**

If a test injects `acpWireRegistry`, switch it to inject a `wireFactory` (or assert the dial+dispose via a stubbed `bootstrapAcpWire`). Minimal test — assert dispose runs after list:

```ts
it("listSessionsForUser disposes the ephemeral wire after listing", async () => {
  let disposed = 0;
  const deps = makePerUserDeps({
    wireFactory: async () => ({ acpConn: FAKE_CONN_WITH_EMPTY_LIST, dispose: () => { disposed++; } }),
  });
  await listSessionsForUser("u_00000001", deps);
  expect(disposed).toBe(1);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- per-user-plugin`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `per-user-plugin.ts`:
- Remove `acpWireRegistry: AcpWireRegistry` from `PerUserPluginDeps`; remove the `AcpWireRegistry` import.
- Add an optional injectable factory for tests, defaulting to `bootstrapAcpWire`:

```ts
import { bootstrapAcpWire, type AcpWireBootstrapResult } from "./wire-bootstrap.js";

export interface PerUserPluginDeps {
  readonly hermes: HermesConfig | null;
  readonly userPortStore: UserPortStore | null;
  readonly hermesApiKey: () => string;
  readonly timeoutMs: number;
  readonly acpOpenTimeoutMs: number;
  /** Test seam — defaults to bootstrapAcpWire. */
  readonly wireFactory?: (args: { wsUrl: string; token: string; openTimeoutMs: number }) => Promise<AcpWireBootstrapResult>;
}

export async function listSessionsForUser(userId: string, deps: PerUserPluginDeps): Promise<SessionListItem[]> {
  const wsUrl = await buildWsUrlForUser(deps.hermes, deps.userPortStore, userId);
  const token = deps.hermesApiKey();
  const dial = deps.wireFactory ?? ((a) => bootstrapAcpWire(a));
  // REST list is not a surface — dedicated ephemeral wire, disposed immediately.
  const wire = await dial({ wsUrl, token, openTimeoutMs: deps.acpOpenTimeoutMs });
  try {
    const result = await listSessionsViaAcp(wire.acpConn);
    return result.sessions.map((s) => ({ sessionId: s.sessionId, title: s.title, lastActiveAt: s.lastActiveAt }));
  } finally {
    wire.dispose();
  }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- per-user-plugin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/hermes-adapter-client/per-user-plugin.ts gateway/src/hermes-adapter-client/per-user-plugin.test.ts
git commit -m "refactor(gateway): listSessionsForUser dials ephemeral wire directly"
```

---

## Task 9: Remove global acpWireRegistry + surfaceCycles from bootstrap

**Files:**
- Modify: `gateway/src/bootstrap/phase-routes.ts`, `gateway/src/bootstrap/create-gateway-services.ts`, `gateway/src/server.ts`
- Test: gateway typecheck + full gateway suite (this task is deletion — its correctness is "everything still compiles and passes").

**Interfaces:**
- Produces: `GatewayServices` no longer exposes `acpWireRegistry` or `surfaceCycles`. Nothing references them (all consumers migrated in Tasks 6-8).

- [ ] **Step 1: Delete the global instantiations + fields**

- `phase-routes.ts`: remove `createAcpWireRegistry` import + call (line 42) + `acpWireRegistry` from the return (line 47) and the `PhaseRoutes`/return interface (line 26).
- `create-gateway-services.ts`: remove `acpWireRegistry` (lines 88, 206) and `surfaceCycles` (lines 90, 185, 207) from the `GatewayServices` interface, the `createSurfaceCycleRegistry` import/call, and the returned object. Remove now-unused imports (`AcpWireRegistry`, `SurfaceCycleRegistry`, `createSurfaceCycleRegistry`).
- `server.ts`: remove `acpWireRegistry: services.acpWireRegistry` from `pluginDeps` (line 334).

- [ ] **Step 2: Run gateway typecheck — expect PASS** (all references gone)

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' typecheck`
Expected: PASS. If it reports an unreferenced consumer, that consumer was missed in Tasks 6-8 — fix it there, not here.

- [ ] **Step 3: Run the full gateway unit suite — expect PASS**

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/bootstrap/phase-routes.ts gateway/src/bootstrap/create-gateway-services.ts gateway/src/server.ts
git commit -m "refactor(gateway): drop process-global acpWireRegistry + surfaceCycles"
```

---

## Task 10: Cross-user isolation regression test (the security pin)

**Files:**
- Test: `gateway/src/person-session/person-session-registry.test.ts` (integration-level: two userIds, same surfaceId → distinct wires)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the regression test**

```ts
it("two users with the SAME surfaceId get distinct wires (no cross-account leak)", async () => {
  const registry = createPersonSessionRegistry({
    hermes: FAKE_HERMES,
    userPortStore: FAKE_PORT_STORE_TWO_USERS, // resolvePort returns distinct ports per userId
    apiKeyResolver: () => "k",
    idleTimeoutMs: 1000,
    replayBufferMaxBytes: 1024,
  });

  const dialed: Array<{ owner: string; surfaceId: string }> = [];
  const sA = await registry.getOrCreate("u_00000001");
  const sB = await registry.getOrCreate("u_00000002");
  if (!sA || !sB) throw new Error("expected sessions");

  const SHARED_SURFACE = "device-xyz"; // same surfaceId (mobile: surfaceId == deviceId)

  const connA = await sA.wires.acquire(SHARED_SURFACE, async () => {
    dialed.push({ owner: "u_00000001", surfaceId: SHARED_SURFACE });
    return { acpConn: { id: "A" } as never, dispose: () => {} };
  });
  const connB = await sB.wires.acquire(SHARED_SURFACE, async () => {
    dialed.push({ owner: "u_00000002", surfaceId: SHARED_SURFACE });
    return { acpConn: { id: "B" } as never, dispose: () => {} };
  });

  // Both dials ran (no cross-user cache hit); connections are distinct.
  expect(dialed).toHaveLength(2);
  expect((connA as { id: string }).id).toBe("A");
  expect((connB as { id: string }).id).toBe("B");
});

it("same user, same surfaceId reuses one wire (fork fix preserved)", async () => {
  const registry = createPersonSessionRegistry({
    hermes: FAKE_HERMES, userPortStore: FAKE_PORT_STORE, apiKeyResolver: () => "k",
    idleTimeoutMs: 1000, replayBufferMaxBytes: 1024,
  });
  const s = await registry.getOrCreate("u_00000001");
  if (!s) throw new Error("expected session");
  let dials = 0;
  const handle = { acpConn: {} as never, dispose: () => {} };
  await s.wires.acquire("surf", async () => { dials++; return handle; });
  await s.wires.acquire("surf", async () => { dials++; return handle; });
  expect(dials).toBe(1); // second acquire reuses (refCount 2)
  expect(s.wires.refCount("surf")).toBe(2);
});
```

- [ ] **Step 2: Run — expect PASS** (behavior already implemented; this pins it)

Run: `source scripts/env.sh && bun run --filter '@sentient/gateway' test -- person-session-registry`
Expected: PASS. If the first test FAILS, a cross-user cache hit exists — stop and re-check Task 3's per-user `createAcpWireRegistry`.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/person-session/person-session-registry.test.ts
git commit -m "test(gateway): pin cross-user surfaceId isolation + same-user fork reuse"
```

---

## Task 11: Full local CI + local-stack E2E smoke

**Files:** none (verification).

- [ ] **Step 1: Full local CI**

Run: `source scripts/env.sh && bun run ci`
Expected: lint + typecheck + all tests PASS.

- [ ] **Step 2: Boot the local Docker stack**

Run: `docker compose -f deploy/macos/docker-compose.yml ps` then bring it up per `deploy/macos/` (build gateway image, `docker compose up -d`). Confirm gateway healthy via `curl`. (Local dev stack only — never prod.)

- [ ] **Step 3: Execute the E2E matrix** (web via Playwright MCP, native via Maestro `qa/mobile/run-e2e.sh --tags`), per the spec §6.2 table. The critical case:

  - Login as user A (has history) → logout → login as user B on the **same tab/device** → send a new chat.
  - **Expected user-visible:** reply reflects B's identity/memory only, never A's.
  - **Expected log trail:** gateway shows `getOrCreate` for B's userId and `acquire.dial` (fresh) under B's ownerUserId; **no** `acquire.reuse` bridging A→B; no A worker URL in B's cycle trace.

  Also run: same-user reconnect resume (chat continues), same-user multi-tab (independent chats), idle-reap ordering (`sweepIdle.evicted` → wire dispose → `sweep.session-removed`).

- [ ] **Step 4: Capture evidence** under the Playwright/Maestro output dirs (screenshots + gateway log excerpts) per `.claude/rules/e2e-testing.md`.

- [ ] **Step 5: Update the reusable case library**

Add the cross-account no-leak case to `agents/docs/testing-knowledge.md`, indexed by surface.

- [ ] **Step 6: Commit evidence notes / case-library update**

```bash
git add agents/docs/testing-knowledge.md
git commit -m "test(qa): cross-account isolation smoke case + evidence"
```

---

## Self-Review

**Spec coverage:**
- §1 root cause (wire pool keyed by surfaceId) → Tasks 1, 3, 6, 9 (pool moves per-user).
- §1.3 latent siblings (cycles, anchors) → Tasks 2/6 (cycles), 3/5/6/7 (anchors).
- §2 invariant → structurally enforced by Tasks 3+9 (no global surfaceId map remains).
- §3 scope (sessionId-keyed stay global) → SessionManager/SessionControls/bindings untouched.
- §4.1 reuse-don't-rewrite → Tasks 1-2 extend classes; Task 3 instantiates per-user.
- §4.2 SessionRouter split → Task 5.
- §4.3 Tier-3 assertions → Task 1 (wire canary), Task 6 (boundary owner assert).
- §5 lifecycle (single reap clock, retention guard, force-dispose canary, no new timer) → Tasks 3-4.
- §6.1 unit pins → Tasks 1-8, 10. §6.2 e2e matrix → Task 11.
- §7 version → global constraint (already 1.13.1). §8 anchor-relocation risk → Task 6 enumerates every `binding.conversationId` reader (dispatcher sourced at call site).

**Placeholder scan:** No TBD/TODO. Test fixtures reference the target files' existing fakes (`FAKE_HERMES`, `FAKE_PORT_STORE`) — the implementer reuses the fixtures already present in each `*.test.ts`; where a two-user port store is needed (Task 10), `FAKE_PORT_STORE_TWO_USERS` returns distinct ports per userId.

**Type consistency:** `createAcpWireRegistry(ownerUserId: string)` (Task 1) used with `init.userId ?? init.profile` (Task 3). `hasLiveWires()`/`disposeAll()` (Task 1), `hasActiveLease()`/`abortAll()` (Task 2), `hasLiveResources()`/`dispose()`/`conversationIdFor()`/`updateConversationId()`/`dropAnchor()`/`clearAllAnchors()` (Task 3) — names used identically in Tasks 4, 6, 7, 10. `PerUserPluginDeps.wireFactory` (Task 8) matches `bootstrapAcpWire` signature.
