# Phase 7 — Webui Admin Panels (Members + System)

> **For agentic workers:** REQUIRED SUB-SKILLS:
> - `superpowers:using-git-worktrees` — Task 7.0 invokes this to create the isolated worktree.
> - `superpowers:subagent-driven-development` — drives the implementation tasks task-by-task.
>
> Steps use checkbox (`- [ ]`) syntax. **READ TASK 7.0 FIRST** — set up the worktree before any other task.

**Goal:** Ship admin-only Members + System tabs so the admin can (a) create / delete / reset-PIN / promote users from the browser without touching the host, and (b) replace API keys (OpenRouter, Ollama, Fish) without restarting the gateway. After this phase, Kevin can sit down with his wife, click "Add member", give her a PIN, and she logs in on her own avatar tile with her own Hermes container — no SSH required.

**Architecture:** The gateway already has the apply orchestrator + profile renderer + per-user Hermes container restart from Phase 3+4. What's missing is **runtime user provisioning** — currently `cfg.hermes.profiles[userId]` is keyed by the userId in `gateway/config.yaml`, but setup-flow userIds are auto-generated (`u_<random>`) and have no entry. Phase 7 pivots that map: `cfg.hermes.profiles` becomes a **slot pool** keyed by short slot ids (`alice`, `bob`, `family`), and a new `~/.sentient/gateway/slot-bindings.json` maps `userId → slotKey`. Admin "create user" claims the next free slot. Admin "delete user" releases it. The pool size is fixed by docker-compose (3 today: alice/bob/family) — pool full = 422 to UI. Secrets live in `~/.sentient/gateway/secrets.json` (chmod 0600); admin UI never sees the values, only `{configured: true|false}` status. The OpenRouter and Fish catalog fetchers read keys via a getter so a PUT to `/admin/secrets/:provider` takes effect on the next call (plus the cached catalog is invalidated to force a refresh). On gateway boot, a one-time **migration** auto-binds any user in `users.json` that has no entry in `slot-bindings.json` to the next free slot — this handles the existing Phase 6 user (Kevin) who pre-dates the slot-binding store.

**Spec coverage gap (deferred):** §6.4 lists "shared templates editor" as part of the System tab MVP. This plan does **NOT** ship it — the family demo only has 2 users and no one is editing a shared system-prompt fragment. Templates editor is captured in Optional Follow-Ons. If the user later wants it before the demo, it's an additive feature: `~/.sentient/gateway/shared/templates/default-system.md` is already loaded by `template-loader.ts`; an admin endpoint pair (`GET/PUT /admin/templates/:name`) plus a textarea in `SystemPanel` would close the gap.

**Test doctrine:** Per `.claude/rules/testing.md` (test-lean, 2026-04-25), this plan writes **contract tests for the new HTTP endpoints**, **one FSM test for the slot-allocator**, and **no per-component UI render tests**. Manual browser smoke is the primary regression net.

**Tech Stack:** Bun + TypeScript strict (gateway), Preact + TypeScript strict (webui), Vitest, Zod. Browser logging via `createLogger` from `@sentient/web-sdk`. BEM CSS with existing tokens.

**Branch:** `feature/multi-user-phase7-webui-admin` (NEW — created in a git worktree by Task 7.0).

**Spec:** `docs/superpowers/specs/2026-04-24-multi-user-auth-and-settings-design.md` — §3.1 (storage layout), §4.5 (admin operations), §5.3 (API key security wall), §6.4 (settings tab restructure — Members + System are MVP), §11 (out of scope).

**Parent branch:** `feature/multi-user-auth-and-settings` (Phase 0–6 + smoke polish all merged).

---

## Hard Rules (apply to every task)

1. **No `--no-verify` ever.** Lint, typecheck, and existing tests must stay green per commit. Pre-existing hook failures get a one-line `biome-ignore` with rule + reason — never bypass.
2. **No out-of-scope edits.** This plan touches only:
   - `gateway/src/api/handlers/admin.ts` (extend, not rewrite)
   - `gateway/src/api/handlers/admin.test.ts` (NEW)
   - `gateway/src/admin/slot-binding-store.ts` (NEW)
   - `gateway/src/admin/slot-binding-store.test.ts` (NEW)
   - `gateway/src/admin/slot-allocator.ts` (NEW — pure FSM around the store)
   - `gateway/src/admin/slot-allocator.test.ts` (NEW)
   - `gateway/src/admin/secrets-store.ts` (NEW)
   - `gateway/src/admin/secrets-store.test.ts` (NEW)
   - `gateway/src/admin/user-provisioner.ts` (NEW — wires create/delete to renderer + docker)
   - `gateway/src/apply/apply-deps.ts` (small change: lookup userId via slot binding)
   - `gateway/src/apply/apply-deps.test.ts` (extend test for new path)
   - `gateway/src/bootstrap/create-gateway-services.ts` (wire new stores into services)
   - `gateway/src/api/router.ts` (no change expected — admin is already routed)
   - `gateway/src/providers/catalogs/openrouter-fetcher.ts` (one-line change: `apiKey: string` → `apiKey: () => string | null` for lazy resolution; rebuilds with whatever the secrets store currently holds)
   - `gateway/src/providers/catalogs/fish-fetcher.ts` (same one-line change)
   - `gateway/src/providers/catalogs/openrouter-fetcher.test.ts`, `fish-fetcher.test.ts` (update test signature; pass an inline `() => "key"` instead of `"key"`)
   - `gateway/src/api/providers-deps.ts` (wire fetcher creation through the secrets store + expose a cache-invalidation callback the secrets handler can call)
   - `gateway/src/api/handlers/providers.ts` (only if the cache-invalidation hook lives there — read first to decide)
   - `gateway/webui/src/services/admin-api.ts` (NEW)
   - `gateway/webui/src/components/settings/system-panel.tsx` (NEW)
   - `gateway/webui/src/components/settings/members-panel.tsx` (REWRITE — fixture → real API)
   - `gateway/webui/src/components/settings/member-row.tsx` (REWRITE — accept real shape)
   - `gateway/webui/src/components/settings/settings-view.tsx` (add `system` tab to ADMIN_TABS)
   - `gateway/webui/src/components/settings/settings-tabs.tsx` (add `system` to the tab union)
   - `gateway/webui/src/styles/components.css` (append BEM blocks; never remove)
   - `gateway/webui/src/data/household-fixtures.ts` (DELETE — only fixture data lives here, only Members consumed it)
   Do **not** edit: `lefthook.yml`, `package.json`, `tsconfig*.json`, `vite.config.ts`, anything under `gateway/webui/src/components/auth/`, anything under `gateway/src/profile-store/` (renderer is correct as-is), the docker-compose hermes-* services (3-slot pool is fine for the demo), the existing config schema beyond what Task 7.2 requires. If you find you need such an edit, surface it.
3. **Test-lean doctrine:** keep tests only if they pin (1) a wire/protocol contract, (2) an FSM/invariant, (3) a security boundary, or (4) are an `@live`/browser-smoke flow. Specifically: contract tests for the four new admin handler routes, FSM test for slot-allocator, security test that secrets PUT never echoes the key in any response. **No per-component render tests for Members/System.** Browser smoke (Task 7.11) is the primary regression net.
4. **Browser logging via `createLogger` only.** Never `console.*` in shipped code. Tag: `createLogger(["sentient", "webui", "<area>"])`.
5. **BEM + existing CSS tokens only.** Use `--color-*`, `--space-*`, `--radius-*`, `--motion-*` from `gateway/webui/src/styles/tokens/*.css`. No new tokens.
6. **camelCase for TS field names; snake_case for YAML/Hermes config keys.**
7. **Files <300 lines, components <150 lines, functions <40 lines.** Split early.
8. **Result types from `@sentient/protocol` for new HTTP services.** No throws from gateway business logic.
9. **`bun run test` (Vitest), not `bun test`.**
10. **Never log secret values.** PIN strings, API keys, hashes, tokens — all redacted at log boundaries. Log fingerprints (`fp=sk_***abcd`) only.
11. **Never restart hermes-* containers from production code paths added in this phase.** The apply orchestrator already owns docker restarts. The user-provisioner reuses it via dependency injection — do **not** spawn a separate `docker` exec path.

---

## Status Reporting

`DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`. Surface discrepancies between this plan and actual code (e.g., a method name that doesn't exist on AuthService); don't silently rename or invent.

---

## Task 7.0: Worktree setup (one-time, before any other task)

**Why:** Phase 7 may run alongside other work; isolate in a worktree so commits don't interleave with the main checkout.

- [ ] **Step 1: Invoke the worktrees skill**

Use the `superpowers:using-git-worktrees` skill (via the `Skill` tool, name `superpowers:using-git-worktrees`) with this argument:

> Set up an isolated worktree for Phase 7 of multi-user. Branch name: `feature/multi-user-phase7-webui-admin`. Branch base: current `HEAD` of `feature/multi-user-auth-and-settings` (the parent branch this plan is designed against). Project root: `/Users/kevinye/Development/sentient`.

The skill picks the worktree directory automatically. The repo already has `.worktrees/` (project-local, hidden, gitignored) — the skill should select that and create `<repo>/.worktrees/<name>/` for this branch.

When the skill returns, **`cd` into the new worktree path** for all subsequent tasks. Verify with `pwd` + `git branch --show-current` before continuing.

- [ ] **Step 2: Confirm Phase 6 is in HEAD**

```bash
git log --oneline | grep -E "Phase 6|Merge branch 'feature/multi-user-phase6|smoke polish" | head -3
ls gateway/webui/src/components/settings/my-agent-tab.tsx \
   gateway/webui/src/components/settings/my-account-tab.tsx \
   gateway/src/api/handlers/admin.ts \
   gateway/src/apply/apply-deps.ts
```

Expected: log mentions Phase 6 / smoke polish; all four files exist. If not, report `BLOCKED: predecessor work not present at HEAD`.

- [ ] **Step 3: Baseline green**

```bash
source scripts/env.sh
bun run lint
bun run typecheck
bun run test
```

Expected: all green. If any fail on something pre-existing, report `BLOCKED: baseline red on parent branch — fix on parent first`.

---

## Task 7.1: Slot-binding store

**Files:**
- Create: `gateway/src/admin/slot-binding-store.ts`
- Create: `gateway/src/admin/slot-binding-store.test.ts`

**Why:** Decouples userId (auto-generated) from slot-key (`alice`/`bob`/`family` — fixed by config + compose). Stored separately from `users.json` so a slot rebinding never touches credential data.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/admin/slot-binding-store.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlotBindingStore } from "./slot-binding-store.ts";

describe("SlotBindingStore", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "sb-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns empty list when file does not exist", async () => {
    const store = createSlotBindingStore(dir);
    const r = await store.list();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it("round-trips a binding through write -> read", async () => {
    const store = createSlotBindingStore(dir);
    await store.bind("u_abc", "alice");
    const r = await store.list();
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toEqual([{ userId: "u_abc", slotKey: "alice" }]);
  });

  it("unbind removes the entry by userId", async () => {
    const store = createSlotBindingStore(dir);
    await store.bind("u_abc", "alice");
    await store.bind("u_def", "bob");
    await store.unbind("u_abc");
    const r = await store.list();
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toEqual([{ userId: "u_def", slotKey: "bob" }]);
  });

  it("rejects double-binding the same slotKey", async () => {
    const store = createSlotBindingStore(dir);
    await store.bind("u_abc", "alice");
    const r = await store.bind("u_def", "alice");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("slot-already-bound");
  });
});
```

Run: `cd gateway/src && bun test ./admin/slot-binding-store.test.ts` → expect FAIL ("Cannot find module").

- [ ] **Step 2: Implement the store**

```ts
// gateway/src/admin/slot-binding-store.ts
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "../user-auth/atomic-write.js";

const log = getLog(["sentient", "gateway", "admin", "slot-binding-store"]);

const BindingSchema = z.object({
  userId: z.string().min(1),
  slotKey: z.string().min(1),
});
const FileSchema = z.array(BindingSchema);
type Binding = z.infer<typeof BindingSchema>;

export type SlotBindingError = "io-error" | "corrupt-file" | "slot-already-bound";

export interface SlotBindingStore {
  list(): Promise<Result<Binding[], SlotBindingError>>;
  bind(userId: string, slotKey: string): Promise<Result<void, SlotBindingError>>;
  unbind(userId: string): Promise<Result<void, SlotBindingError>>;
  resolveSlot(userId: string): Promise<string | null>;
}

export function createSlotBindingStore(rootDir: string): SlotBindingStore {
  const path = join(rootDir, "slot-bindings.json");

  async function read(): Promise<Result<Binding[], SlotBindingError>> {
    try {
      const raw = await fs.readFile(path, "utf8");
      const parsed = FileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        log.warn("read.corrupt", { reason: parsed.error.message });
        return { ok: false, error: "corrupt-file" };
      }
      return { ok: true, value: parsed.data };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: [] };
      log.warn("read.io-error", { reason: (e as Error).message });
      return { ok: false, error: "io-error" };
    }
  }

  async function write(items: Binding[]): Promise<Result<void, SlotBindingError>> {
    try {
      await writeFileAtomic(path, JSON.stringify(items, null, 2), { mode: 0o600 });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      log.warn("write.io-error", { reason: (e as Error).message });
      return { ok: false, error: "io-error" };
    }
  }

  return {
    list: read,
    async bind(userId, slotKey) {
      const r = await read();
      if (!r.ok) return r;
      if (r.value.some((b) => b.slotKey === slotKey)) {
        return { ok: false, error: "slot-already-bound" };
      }
      const next = [...r.value.filter((b) => b.userId !== userId), { userId, slotKey }];
      log.info("bind", { userId, slotKey });
      return write(next);
    },
    async unbind(userId) {
      const r = await read();
      if (!r.ok) return r;
      log.info("unbind", { userId });
      return write(r.value.filter((b) => b.userId !== userId));
    },
    async resolveSlot(userId) {
      const r = await read();
      if (!r.ok) return null;
      return r.value.find((b) => b.userId === userId)?.slotKey ?? null;
    },
  };
}
```

Run the test → expect 4/4 pass. Commit:

```bash
git add gateway/src/admin/slot-binding-store.ts gateway/src/admin/slot-binding-store.test.ts
git commit -m "feat(admin): slot-binding store (userId ↔ slotKey persistence)"
```

---

## Task 7.2: Slot allocator + apply-deps pivot

**Files:**
- Create: `gateway/src/admin/slot-allocator.ts`
- Create: `gateway/src/admin/slot-allocator.test.ts`
- Modify: `gateway/src/apply/apply-deps.ts:31-65` (the three `containerNameFor` / `healthUrlFor` / `healthHeadersFor` functions — they currently look up `services.hermes?.profiles[userId]`; change to `services.hermes?.profiles[slotBindingStore.resolveSlot(userId) ?? userId]` so legacy direct-keyed configs still work for `alice`)
- Modify: `gateway/src/apply/apply-deps.test.ts` (add a test for the slot-binding lookup path)

**Why:** Pure-function slot allocator picks the next free slotKey from the configured pool. apply-deps gains the indirection so a userId in `users.json` can find its hermes profile via slot binding rather than via direct config-key match. Back-compat: if no binding exists for a userId, fall through to `cfg.hermes.profiles[userId]` (preserves alice's current behavior).

- [ ] **Step 1: Write the allocator test**

```ts
// gateway/src/admin/slot-allocator.test.ts
import { describe, expect, it } from "vitest";
import { allocateSlot } from "./slot-allocator.ts";

describe("allocateSlot", () => {
  const POOL = ["alice", "bob", "family"];

  it("returns first slot when no bindings exist", () => {
    const r = allocateSlot(POOL, []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("alice");
  });

  it("returns next free slot in pool order", () => {
    const r = allocateSlot(POOL, [{ userId: "u_1", slotKey: "alice" }]);
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toBe("bob");
  });

  it("returns pool-full when all slots are bound", () => {
    const r = allocateSlot(POOL, [
      { userId: "u_1", slotKey: "alice" },
      { userId: "u_2", slotKey: "bob" },
      { userId: "u_3", slotKey: "family" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("pool-full");
  });

  it("ignores bindings whose slotKey is not in the pool", () => {
    const r = allocateSlot(POOL, [{ userId: "u_1", slotKey: "ghost-slot" }]);
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toBe("alice");
  });
});
```

Run: expect FAIL.

- [ ] **Step 2: Implement the allocator**

```ts
// gateway/src/admin/slot-allocator.ts
import type { Result } from "@sentient/protocol";

export type SlotAllocatorError = "pool-full";

export interface SlotBinding {
  userId: string;
  slotKey: string;
}

/**
 * Pure function: returns the first slotKey from `pool` that has no entry in
 * `bindings`. Returns `pool-full` when every slot is already bound.
 */
export function allocateSlot(
  pool: readonly string[],
  bindings: readonly SlotBinding[],
): Result<string, SlotAllocatorError> {
  const used = new Set(bindings.map((b) => b.slotKey));
  for (const slot of pool) {
    if (!used.has(slot)) return { ok: true, value: slot };
  }
  return { ok: false, error: "pool-full" };
}
```

Run: expect 4/4 pass.

- [ ] **Step 3: Pivot apply-deps**

Read `gateway/src/apply/apply-deps.ts`. Change the three resolve helpers so they call `slotBindingStore.resolveSlot(userId)` first, then look up `services.hermes?.profiles[slotKey ?? userId]`. The `?? userId` keeps the existing `alice` direct-key path working (because the userId in users.json today is `u_<random>`, but legacy installs may still have `alice` directly).

Add `slotBindingStore: SlotBindingStore` to `GatewayServices` (Task 7.6 will wire the actual instance). Pass it into `createApplyDeps` so the resolvers can use it.

- [ ] **Step 4: Extend apply-deps test**

Add one test that constructs apply-deps with a stub slot-binding store returning `"bob"` for a fake `userId`, and a `cfg.hermes.profiles.bob` entry, and asserts `resolveContainerName(userId) === "hermes-bob"`.

- [ ] **Step 5: Run full gateway tests, commit**

```bash
cd gateway/src && bun test
git add -A && git commit -m "feat(admin): slot-allocator + apply-deps lookup via slot binding"
```

---

## Task 7.3: Secrets store

**Files:**
- Create: `gateway/src/admin/secrets-store.ts`
- Create: `gateway/src/admin/secrets-store.test.ts`

**Why:** §5.3 — keys are written by the gateway, never read by webui. UI sees only `{configured: bool}` per provider. File mode 0600.

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/admin/secrets-store.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretsStore } from "./secrets-store.ts";

describe("SecretsStore", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ss-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("status() returns all-false when file does not exist", async () => {
    const store = createSecretsStore(dir);
    const r = await store.status();
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toEqual({ openrouter: false, ollama: false, fish: false });
  });

  it("set() then status() flips configured to true for that provider", async () => {
    const store = createSecretsStore(dir);
    await store.set("openrouter", "sk-or-test-1234567890");
    const r = await store.status();
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toEqual({ openrouter: true, ollama: false, fish: false });
  });

  it("getValue() returns the raw value (gateway-internal use only)", async () => {
    const store = createSecretsStore(dir);
    await store.set("openrouter", "sk-or-secret");
    const r = await store.getValue("openrouter");
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toBe("sk-or-secret");
  });

  it("file is written with mode 0600", async () => {
    const store = createSecretsStore(dir);
    await store.set("openrouter", "sk-or");
    const s = await stat(join(dir, "secrets.json"));
    // eslint-disable-next-line no-bitwise
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("set() with an empty string clears that provider", async () => {
    const store = createSecretsStore(dir);
    await store.set("openrouter", "sk-or");
    await store.set("openrouter", "");
    const r = await store.status();
    if (!r.ok) throw new Error(r.error);
    expect(r.value.openrouter).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// gateway/src/admin/secrets-store.ts
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "../user-auth/atomic-write.js";

const log = getLog(["sentient", "gateway", "admin", "secrets-store"]);

export const PROVIDERS = ["openrouter", "ollama", "fish"] as const;
export type Provider = (typeof PROVIDERS)[number];

const FileSchema = z.record(z.string(), z.string()).default({});
export type SecretsStoreError = "io-error" | "corrupt-file";

export type ProviderStatus = Record<Provider, boolean>;

export interface SecretsStore {
  status(): Promise<Result<ProviderStatus, SecretsStoreError>>;
  set(provider: Provider, value: string): Promise<Result<void, SecretsStoreError>>;
  getValue(provider: Provider): Promise<Result<string | null, SecretsStoreError>>;
}

export function createSecretsStore(rootDir: string): SecretsStore {
  const path = join(rootDir, "secrets.json");

  async function read(): Promise<Result<Record<string, string>, SecretsStoreError>> {
    try {
      const raw = await fs.readFile(path, "utf8");
      const parsed = FileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return { ok: false, error: "corrupt-file" };
      return { ok: true, value: parsed.data };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: {} };
      log.warn("read.io-error", { reason: (e as Error).message });
      return { ok: false, error: "io-error" };
    }
  }

  async function write(data: Record<string, string>): Promise<Result<void, SecretsStoreError>> {
    try {
      await writeFileAtomic(path, JSON.stringify(data, null, 2), { mode: 0o600 });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      log.warn("write.io-error", { reason: (e as Error).message });
      return { ok: false, error: "io-error" };
    }
  }

  return {
    async status() {
      const r = await read();
      if (!r.ok) return r;
      const out = { openrouter: false, ollama: false, fish: false } as ProviderStatus;
      for (const p of PROVIDERS) out[p] = (r.value[p] ?? "").length > 0;
      return { ok: true, value: out };
    },
    async set(provider, value) {
      const r = await read();
      if (!r.ok) return r;
      const next = { ...r.value };
      if (value === "") delete next[provider];
      else next[provider] = value;
      log.info("set", { provider, configured: value !== "" });
      return write(next);
    },
    async getValue(provider) {
      const r = await read();
      if (!r.ok) return r;
      return { ok: true, value: r.value[provider] ?? null };
    },
  };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
cd gateway/src && bun test ./admin/
git add -A && git commit -m "feat(admin): secrets store (openrouter / ollama / fish, mode 0600)"
```

---

## Task 7.4: User provisioner

**Files:**
- Create: `gateway/src/admin/user-provisioner.ts`
- Create: `gateway/src/admin/user-provisioner.test.ts`
- Modify: `gateway/src/bootstrap/create-gateway-services.ts` (wire the provisioner + run the boot-migration helper added in Task 7.4.5)

**Why:** Wraps the multi-step create/delete/reset/promote flows so the admin handler stays thin. All filesystem and docker operations are injected dependencies — unit test stays hermetic.

### Operations

#### `createUser({displayName, pin, isAdmin}) → Result<UserSummary, CreateError>`

Steps in order. Each step, if it fails, **rolls back exactly the steps listed below it in the rollback column** (reverse order). No step has a no-op rollback — any rollback that's omitted on a step means that step succeeded irreversibly OR failed before any state was touched.

| # | Action | Failure mode | Rollback if step N+1 fails |
|---|---|---|---|
| 1 | `slotAllocator.allocate(pool, bindings)` (pure function from Task 7.2) | `pool-full` → return 422 | (no state changed) |
| 2 | `pinHash = await hashPin(pin, deps.argon2Params)` (from `gateway/src/user-auth/pin-service.ts`; `argon2Params` injected by `createGatewayServices` from the auth-service config — same params already used by setup/login) | hash error → 500 | (no state changed) |
| 3 | `userStore.add({userId: makeUserId(), displayName, pinHash, isAdmin, avatarTint, createdAt})` | `io-error` → 500 | (no rollback needed; step 1 was pure) |
| 4 | `slotBindingStore.bind(userId, slotKey)` | `slot-already-bound` (race) → 500 + roll back step 3 | `userStore.remove(userId)` |
| 5 | `profileStore.save(buildDefaultProfile(userId))` | `io-error` → 500 + roll back 4, 3 | `slotBindingStore.unbind` + `userStore.remove` |
| 6 | `runApply(userId)` | any apply error → 500 + roll back 5, 4, 3 | best-effort: try `profileStore.remove`, `slotBindingStore.unbind`, `userStore.remove`. Log warn if any rollback step itself fails (don't throw — caller already gets the original failure). |

Returns `{userId, displayName, isAdmin, avatarTint, slotKey, createdAt}` — never the pin or pinHash.

#### `deleteUser(userId) → Result<void, DeleteError>`

| # | Action | Failure mode |
|---|---|---|
| 1 | `slotBindingStore.resolveSlot(userId)` | null → 404 |
| 2 | `userStore.list()` → check admin invariant | if `users.filter(u => u.isAdmin).length === 1 && targetUser.isAdmin` → 422 `last-admin` |
| 3 | `archiveUserDir(userId)`: atomic `rename(~/.sentient/gateway/<userId>, ~/.sentient/gateway/_archive/<userId>-<isoTs>)` | io-error → 500 |
| 4 | `slotBindingStore.unbind(userId)` | io-error → 500 (warn — user dir already archived; admin can re-bind manually if this happens) |
| 5 | `userStore.remove(userId)` | io-error → 500 (warn — both archive + unbind succeeded; users.json now lies about the user, requires manual cleanup) |

**Explicitly NOT done in deleteUser:** no docker stop, no "stub profile + runApply on the slot". The freed Hermes container keeps running with stale config until a new user creates and triggers their own runApply, which rewrites the bind-mounted volume and restarts the container. The container's idle behavior + old conversationId is harmless — no one is bound to it. Skipping the cleanup avoids an avoidable failure mode (apply against a userId that no longer exists).

#### `resetPin(userId, newPin) → Result<void, ResetError>`

1. `pinHash = await hashPin(newPin, deps.argon2Params)`
2. `userStore.update(userId, { pinHash })` — 404 if user not found (UserStore.update returns `{ok: false, error: "not-found"}` for missing users).

#### `setIsAdmin(userId, isAdmin) → Result<void, AdminToggleError>`

1. `users = await userStore.list()`
2. If `isAdmin === false` and the target is the only admin (`users.filter(u => u.isAdmin && u.userId !== userId).length === 0`) → 422 `last-admin`.
3. `userStore.update(userId, { isAdmin })` — 404 if user not found.

UserStore's actual interface (verified — `gateway/src/user-auth/user-store.ts`): `list()`, `get(userId)`, `add(rec)`, `update(userId, patch)`, `remove(userId)`. Provisioner uses these only — no new UserStore methods are added.

### Tests (happy + failure FSM)

Use `vi.mock` for every dependency. Assert call order via `vi.fn()` invocation counts on a shared mock-call-log array. Required cases:

1. **createUser happy** — all 6 steps called once, in order; returns `UserSummary` matching the input.
2. **createUser pool-full** — step 1 fails; steps 2–6 never called; rollback log empty.
3. **createUser bind-race** — step 4 fails (slot taken between allocate and bind); step 5–6 never called; `userStore.remove(userId)` called exactly once.
4. **createUser save-fails** — step 5 fails; `slotBindingStore.unbind` and `userStore.remove` each called exactly once, in that order.
5. **createUser apply-fails** — step 6 fails; rollback runs `profileStore.remove`, `slotBindingStore.unbind`, `userStore.remove` in that order; if any rollback throws, the others still run.
6. **deleteUser happy** — steps 1–5 all called; returns `ok: true`.
7. **deleteUser 404** — step 1 returns null; steps 2–5 never called.
8. **deleteUser last-admin** — step 2 trips the guard; steps 3–5 never called.
9. **setIsAdmin demote-only-admin** — returns 422 `last-admin`; userStore.updateIsAdmin never called.

- [ ] **Step 1: Write all 9 tests in `user-provisioner.test.ts`** with the matrix above. They will fail.

- [ ] **Step 2: Implement `user-provisioner.ts`.** Sketch:

```ts
// gateway/src/admin/user-provisioner.ts
import type { Result } from "@sentient/protocol";
import { allocateSlot } from "./slot-allocator.js";
import type { ApplyError, ApplyOutcome } from "../apply/orchestrator.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import { buildDefaultProfile } from "../profile-store/profile-defaults.js";
import type { SlotBindingStore } from "./slot-binding-store.js";
import type { UserStore } from "../user-auth/user-store.js";
import { hashPin } from "../user-auth/pin-service.js";
import type { Argon2Params } from "../user-auth/types.js";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "user-provisioner"]);

export type CreateError =
  | { kind: "pool-full" }
  | { kind: "io-error"; reason: string }
  | { kind: "apply-error"; reason: string };

export type DeleteError =
  | { kind: "not-found" }
  | { kind: "last-admin" }
  | { kind: "io-error"; reason: string };

export interface UserProvisionerDeps {
  userStore: UserStore;
  profileStore: ProfileStore;
  slotBindingStore: SlotBindingStore;
  pool: readonly string[];
  argon2Params: Argon2Params;
  runApply: (userId: string) => Promise<Result<ApplyOutcome, ApplyError>>;
  archiveUserDir: (userId: string) => Promise<Result<void, "io-error">>;
  makeUserId: () => string;
  randomAvatarTint: () => string;
  now: () => Date;
}

export interface UserProvisioner {
  createUser(input: { displayName: string; pin: string; isAdmin: boolean }): Promise<Result<UserSummary, CreateError>>;
  deleteUser(userId: string): Promise<Result<void, DeleteError>>;
  resetPin(userId: string, newPin: string): Promise<Result<void, "not-found" | "io-error">>;
  setIsAdmin(userId: string, isAdmin: boolean): Promise<Result<void, "not-found" | "last-admin" | "io-error">>;
}

export interface UserSummary {
  userId: string;
  displayName: string;
  isAdmin: boolean;
  avatarTint: string;
  slotKey: string;
  createdAt: string;
}

export function createUserProvisioner(deps: UserProvisionerDeps): UserProvisioner {
  return { createUser, deleteUser, resetPin, setIsAdmin };

  async function createUser(input: { displayName: string; pin: string; isAdmin: boolean }) {
    const bindingsRes = await deps.slotBindingStore.list();
    if (!bindingsRes.ok) return { ok: false as const, error: { kind: "io-error" as const, reason: bindingsRes.error } };
    const slot = allocateSlot(deps.pool, bindingsRes.value);
    if (!slot.ok) return { ok: false as const, error: { kind: "pool-full" as const } };
    const slotKey = slot.value;

    const pinHash = await hashPin(input.pin, deps.argon2Params);
    const userId = deps.makeUserId();
    const avatarTint = deps.randomAvatarTint();
    const createdAt = deps.now().toISOString();

    const addRes = await deps.userStore.add({ userId, displayName: input.displayName, pinHash, isAdmin: input.isAdmin, avatarTint, createdAt });
    if (!addRes.ok) return { ok: false as const, error: { kind: "io-error" as const, reason: addRes.error } };

    const bindRes = await deps.slotBindingStore.bind(userId, slotKey);
    if (!bindRes.ok) {
      await rollback("bind", [() => deps.userStore.remove(userId)]);
      return { ok: false as const, error: { kind: "io-error" as const, reason: bindRes.error } };
    }

    const saveRes = await deps.profileStore.save(buildDefaultProfile(userId));
    if (!saveRes.ok) {
      await rollback("save", [
        () => deps.slotBindingStore.unbind(userId),
        () => deps.userStore.remove(userId),
      ]);
      return { ok: false as const, error: { kind: "io-error" as const, reason: saveRes.error } };
    }

    const applyRes = await deps.runApply(userId);
    if (!applyRes.ok) {
      await rollback("apply", [
        () => deps.profileStore.remove(userId),
        () => deps.slotBindingStore.unbind(userId),
        () => deps.userStore.remove(userId),
      ]);
      return { ok: false as const, error: { kind: "apply-error" as const, reason: applyRes.error.kind } };
    }

    return { ok: true as const, value: { userId, displayName: input.displayName, isAdmin: input.isAdmin, avatarTint, slotKey, createdAt } };
  }

  async function rollback(stage: string, fns: ReadonlyArray<() => Promise<unknown>>): Promise<void> {
    for (const fn of fns) {
      try { await fn(); } catch (e) { log.warn("rollback.step-failed", { stage, reason: (e as Error).message }); }
    }
  }

  // deleteUser, resetPin, setIsAdmin follow the matrix above; keep each function <40 lines.
}
```

(The skeleton compiles against existing `UserStore`/`ProfileStore`/`SlotBindingStore` interfaces. `archiveUserDir` is injected because file-system rename is the only docker-adjacent op the provisioner does — the test passes a no-op stub.)

- [ ] **Step 3: `archiveUserDir` helper.** Tiny pure helper at `gateway/src/admin/archive-user-dir.ts`: `fs.rename` with `ENOENT` mapped to `io-error`. Test it directly with a tmpdir.

- [ ] **Step 4: Wire into `createGatewayServices`.** Construct `secretsStore`, `slotBindingStore`, `userProvisioner` once at boot. `pool` comes from `Object.keys(cfg.hermes.profiles).filter(k => cfg.hermes.profiles[k].enabled !== false)`. Inject `runApply` from the existing apply factory.

- [ ] **Step 5: Run all gateway tests, commit.**

---

## Task 7.4.5: Boot migration (auto-bind unbound users)

**Files:**
- Create: `gateway/src/admin/boot-migration.ts`
- Create: `gateway/src/admin/boot-migration.test.ts`
- Modify: `gateway/src/bootstrap/create-gateway-services.ts` (call the migration once after stores are constructed, before the HTTP server starts)

**Why:** The existing setup-flow user (Kevin in Phase 6) has an entry in `users.json` but **no entry in `slot-bindings.json`** (the file is brand-new in Phase 7). Without migration, every apply call for Kevin will route to `cfg.hermes.profiles[u_6ae26974]` — which doesn't exist. We need to bind him on first boot.

**Behavior:**

```ts
async function migrateUnboundUsers(deps: { userStore, slotBindingStore, pool }): Promise<void> {
  const users = (await deps.userStore.list()).ok ? (await deps.userStore.list()).value! : [];
  const bindings = (await deps.slotBindingStore.list()).ok ? (await deps.slotBindingStore.list()).value! : [];
  const boundUserIds = new Set(bindings.map(b => b.userId));
  const usedSlots = new Set(bindings.map(b => b.slotKey));

  for (const user of users) {
    if (boundUserIds.has(user.userId)) continue;
    const freeSlot = deps.pool.find(s => !usedSlots.has(s));
    if (!freeSlot) {
      log.warn("migration.pool-full", { userId: user.userId });
      break;
    }
    await deps.slotBindingStore.bind(user.userId, freeSlot);
    usedSlots.add(freeSlot);
    log.info("migration.bound", { userId: user.userId, slotKey: freeSlot });
  }
}
```

This is a **one-shot, idempotent** function — re-running it is a no-op once everyone has a binding.

**Important:** the migration does NOT trigger an apply for the migrated user. Their existing Hermes container keeps running with whatever config was last rendered. Apply happens naturally the next time the user clicks Apply in My Agent, or when the admin deletes/recreates them.

- [ ] **Step 1: Test cases:**
  1. Empty users.json → no-op.
  2. One user, no binding → that user is bound to the first slot in pool.
  3. Two users, one already bound → only the unbound user gets a slot; the bound user is untouched.
  4. Pool full → unbound users get logged but not bound (warn, no throw).

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Wire into `createGatewayServices`** so it runs after both stores are loaded.

- [ ] **Step 4: Tests + commit.**

---

## Task 7.5: Admin handlers — users CRUD

**Files:**
- Modify: `gateway/src/api/handlers/admin.ts` (extend; current file only handles `/admin/ping`)
- Create: `gateway/src/api/handlers/admin.test.ts`

**Why:** The four user-management endpoints from §4.5 plus a list endpoint the Members panel needs.

### Route table

All routes are gated by the existing `requireAdminAuth` middleware. URL params are parsed off `url.pathname` with a small regex helper; bodies are parsed with zod.

| Method + path | Body schema | Success | Failures |
|---|---|---|---|
| `GET /api/v1/admin/users` | — | 200 `{users: UserSummary[]}` | 500 io-error |
| `POST /api/v1/admin/users` | `{displayName: string.min(1).max(64), pin: /^\d{4}$/, isAdmin: boolean}` | 201 `{user: UserSummary}` | 422 schema, 422 `pool-full`, 500 io-error, 502 apply-error |
| `DELETE /api/v1/admin/users/:id` | — | 204 | 404 not-found, 422 last-admin, 500 io-error |
| `POST /api/v1/admin/users/:id/reset-pin` | `{pin: /^\d{4}$/}` | 204 | 404, 422 schema, 500 io-error |
| `PATCH /api/v1/admin/users/:id` | `{isAdmin: boolean}` | 200 `{user: UserSummary}` | 404, 422 last-admin, 500 io-error |

`UserSummary` shape (camelCase, matches provisioner return type):
```ts
{ userId, displayName, isAdmin, avatarTint, slotKey, createdAt }
```
**Never include `pinHash` or any secret value in any response, success or failure.**

### Handler skeleton

```ts
// gateway/src/api/handlers/admin.ts
import { z } from "zod";
import { type AdminAuthDeps, requireAdminAuth } from "../middleware/require-admin-auth.ts";
import type { UserProvisioner } from "../../admin/user-provisioner.ts";
import type { UserStore } from "../../user-auth/user-store.ts";

const createSchema = z.object({
  displayName: z.string().min(1).max(64),
  pin: z.string().regex(/^\d{4}$/),
  isAdmin: z.boolean(),
});
const resetPinSchema = z.object({ pin: z.string().regex(/^\d{4}$/) });
const patchSchema = z.object({ isAdmin: z.boolean() });

export interface AdminDeps extends AdminAuthDeps {
  provisioner: UserProvisioner;
  userStore: UserStore;
  slotBindingStore: SlotBindingStore;
}

const USER_ID_RE = /^\/api\/v1\/admin\/users\/([^/]+)$/;
const RESET_PIN_RE = /^\/api\/v1\/admin\/users\/([^/]+)\/reset-pin$/;

export function createAdminHandler(deps: AdminDeps): (req: Request) => Promise<Response> {
  const guard = requireAdminAuth(deps);
  return async (req) => {
    const unauthorized = await guard(req);
    if (unauthorized) return unauthorized;

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/api/v1/admin/ping") return Response.json({ status: "pong" });

    if (path === "/api/v1/admin/users" && method === "GET") return handleListUsers(deps);
    if (path === "/api/v1/admin/users" && method === "POST") return handleCreateUser(deps, req);

    const resetMatch = path.match(RESET_PIN_RE);
    if (resetMatch && method === "POST") return handleResetPin(deps, req, resetMatch[1]);

    const userIdMatch = path.match(USER_ID_RE);
    if (userIdMatch && method === "DELETE") return handleDeleteUser(deps, userIdMatch[1]);
    if (userIdMatch && method === "PATCH") return handlePatchUser(deps, req, userIdMatch[1]);

    return new Response("Not Found", { status: 404 });
  };
}
```

Each `handle*` function (one per route, kept <40 lines) reads the body, runs the schema, calls the provisioner / store, and maps the typed `Result` to a `Response`. `handleListUsers` joins users + slot-bindings to produce the slotKey field per row. Use a tiny `mapError(error): Response` helper to keep mapping centralized.

### Contract tests

```ts
// gateway/src/api/handlers/admin.test.ts (sketch — fill in with real Vi imports + mock factories)
describe("POST /api/v1/admin/users", () => {
  it("returns 201 with the new user (no pinHash) when provisioner succeeds", async () => { /* ... */ });
  it("returns 422 with code 'pool-full' when provisioner returns pool-full", async () => { /* ... */ });
  it("returns 422 'schema' when displayName is empty", async () => { /* ... */ });
  it("returns 401 when caller is not admin", async () => { /* ... */ });
  it("response body never echoes the input pin (regex check)", async () => {
    const pin = "9988";
    /* call with pin, capture body text, assert !text.includes(pin) for both 201 and 422 paths */
  });
});

describe("DELETE /api/v1/admin/users/:id", () => {
  it("returns 204 on success", /* ... */);
  it("returns 404 when slotBindingStore returns null", /* ... */);
  it("returns 422 'last-admin' when guard trips", /* ... */);
});

describe("PATCH /api/v1/admin/users/:id", () => {
  it("returns 422 'last-admin' when demoting the only admin", /* ... */);
});

describe("GET /api/v1/admin/users", () => {
  it("returns users joined with slot bindings", /* ... */);
});
```

The 422-pool-full + 422-last-admin + 422-schema responses MUST use a stable error code field (`{error: "pool-full"}`, etc.) so the webui can switch on it for toast messages.

- [ ] **Step 1: Write contract tests** — `vi.mock` for provisioner, userStore, slotBindingStore, tokens. Cover each row of the route table and the security regex check.
- [ ] **Step 2: Extend admin.ts** with the route table + handlers above. Keep functions <40 lines.
- [ ] **Step 3: Run tests, commit.**

---

## Task 7.6: Admin handlers — secrets

**Files:**
- Modify: `gateway/src/api/handlers/admin.ts`
- Modify: `gateway/src/api/handlers/admin.test.ts`

Routes:

| Method + path | Body | Success | Failures |
|---|---|---|---|
| `GET /api/v1/admin/secrets` | — | 200 `{openrouter: {configured: bool}, ollama: {configured: bool}, fish: {configured: bool}}` | 500 io-error |
| `PUT /api/v1/admin/secrets/:provider` | `{value: string}` (empty string clears the key) | 204 (empty body) | 422 unknown provider, 500 io-error |

The PUT handler ALSO calls `deps.invalidateCatalogCache(provider)` after a successful `secretsStore.set(...)` so the next `/api/v1/providers/models` (or `/voices`) call refetches with the new key. (Cache invalidation is wired in Task 7.6.5.)

```ts
async function handlePutSecret(deps, req, providerParam: string): Promise<Response> {
  if (!PROVIDERS.includes(providerParam as Provider)) {
    return Response.json({ error: "unknown-provider" }, { status: 422 });
  }
  const body = await req.json();
  const parsed = z.object({ value: z.string() }).safeParse(body);
  if (!parsed.success) return Response.json({ error: "schema" }, { status: 422 });

  const result = await deps.secretsStore.set(providerParam as Provider, parsed.data.value);
  if (!result.ok) return Response.json({ error: "io-error" }, { status: 500 });

  deps.invalidateCatalogCache(providerParam as Provider);
  log.info("secret.replaced", { provider: providerParam, configured: parsed.data.value !== "" });
  return new Response(null, { status: 204 });
}
```

The handler **must** sit under the `requireAdminAuth` guard — same one as the user routes.

### Contract + security tests

1. **Status shape.** GET returns `{openrouter: {configured: bool}, ollama: {configured: bool}, fish: {configured: bool}}`. Body never contains a string longer than ~30 chars (sanity: rules out an accidental key leak).
2. **Round-trip.** PUT `{value: "sk-or-test-1234"}` then GET → openrouter configured=true.
3. **Clear.** PUT `{value: ""}` → openrouter configured=false.
4. **Unknown provider.** PUT `/api/v1/admin/secrets/anthropic` → 422 `unknown-provider`.
5. **Security log redaction (MANDATORY).** Intercept the logger sink (the project's `getLog` writes through a configurable sink — the test installs a memory sink at the top, captures all output, restores in afterEach). PUT `{value: "sk-or-test-SECRET-VALUE-12345"}`. Assert the captured log lines contain `"secret.replaced"` and `"openrouter"` but **never** the literal `"SECRET-VALUE-12345"`. Same assertion for any 4xx/5xx response body.
6. **Cache invalidation.** Mock `invalidateCatalogCache`. PUT openrouter → assert `invalidateCatalogCache` called with `"openrouter"` exactly once after the store write.

- [ ] **Step 1: Tests** including the log-redaction check.
- [ ] **Step 2: Extend admin.ts** with the two routes + the dependency wiring for `invalidateCatalogCache`.
- [ ] **Step 3: Tests pass, commit.**

---

## Task 7.6.5: Wire secrets store into catalog fetchers

**Files:**
- Modify: `gateway/src/providers/catalogs/openrouter-fetcher.ts` (signature change: `apiKey: string` → `apiKey: () => string | null`)
- Modify: `gateway/src/providers/catalogs/fish-fetcher.ts` (same signature change)
- Modify: their test files (pass `() => "key"` instead of `"key"`)
- Modify: `gateway/src/api/providers-deps.ts` (resolve key via `() => secretsStore.getValueSync("openrouter") ?? envFallback` and expose `invalidateCatalogCache(provider)` that clears the cached catalog response for that provider so the next request refetches)

**Why:** Spec acceptance for the System tab is "Replace OpenRouter key → next /api/v1/providers/models call uses new key". Without this step, the secrets store is a black hole — keys saved but never read.

The simplest design: the fetchers no longer hold a static key; they call `apiKey()` at request time. The secrets-store gains a sync read (`getValueSync`) backed by an in-memory mirror that's hydrated at boot and updated on every `set`. The mirror is a `Record<Provider, string | null>` in the store closure — no extra file IO per fetch.

```ts
// addition to secrets-store.ts — keep the existing async API; add a sync mirror
let mirror: Record<Provider, string | null> | null = null;

async function loadMirror() {
  const r = await read();
  if (r.ok) mirror = mapToMirror(r.value);
}

return {
  // ... existing async methods ...
  getValueSync(provider: Provider) {
    if (mirror === null) return null; // not yet hydrated; caller falls back
    return mirror[provider];
  },
  // wrap set() to update mirror after successful write
};
```

`createGatewayServices` calls `await secretsStore.loadMirror()` once at boot.

`providers-deps.ts` builds fetchers with:

```ts
const openRouterFetcher = createOpenRouterFetcher({
  apiKey: () => secretsStore.getValueSync("openrouter") ?? env("OPENROUTER_API_KEY") ?? null,
  baseUrl: cfg.providers.openrouter.base_url,
  timeoutMs: cfg.providers.openrouter.timeout_ms,
});
```

The fetcher then evaluates `apiKey()` at fetch time:

```ts
const key = config.apiKey();
if (!key) return { ok: false, error: { kind: "no-api-key" } };
const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
```

Cache invalidation in `providers-deps.ts`:

```ts
function invalidateCatalogCache(provider: Provider) {
  if (provider === "openrouter") openRouterCache.clear();
  if (provider === "fish") fishCache.clear();
  // ollama-cloud has no key-bound fetch path today; no-op
}
```

- [ ] **Step 1: Update fetcher signatures + their tests** (just the `apiKey: () => "key"` change; existing assertions still pass).
- [ ] **Step 2: Add `getValueSync` + `loadMirror` to secrets-store** + tests for both.
- [ ] **Step 3: Wire `apiKey: () => ...` in `providers-deps.ts`** + add `invalidateCatalogCache(provider)` exported callback. Pass it through to `createAdminHandler` deps in `createGatewayServices`.
- [ ] **Step 4: Run all gateway tests + commit.**

---

## Task 7.7: Webui admin-api client

**Files:**
- Create: `gateway/webui/src/services/admin-api.ts`

`createAdminApi()` mirrors the route table from Tasks 7.5/7.6. All methods return `Result<T, ApiError>` via the existing `handleFetch` helper.

```ts
// gateway/webui/src/services/admin-api.ts
import { createLogger } from "@sentient/web-sdk";
import { bearerHeaders, jsonHeaders, handleFetch, NETWORK_ERROR } from "./_helpers.ts";
import type { Result } from "@sentient/protocol";

const log = createLogger(["sentient", "webui", "services", "admin-api"]);

export type Provider = "openrouter" | "ollama" | "fish";

export interface UserSummary {
  userId: string;
  displayName: string;
  isAdmin: boolean;
  avatarTint: string;
  slotKey: string;
  createdAt: string;
}

export interface ProviderStatus {
  openrouter: { configured: boolean };
  ollama: { configured: boolean };
  fish: { configured: boolean };
}

export interface AdminApi {
  listUsers(token: string): Promise<Result<{ users: UserSummary[] }, ApiError>>;
  createUser(token: string, input: { displayName: string; pin: string; isAdmin: boolean }): Promise<Result<{ user: UserSummary }, ApiError>>;
  deleteUser(token: string, userId: string): Promise<Result<void, ApiError>>;
  resetPin(token: string, userId: string, pin: string): Promise<Result<void, ApiError>>;
  setIsAdmin(token: string, userId: string, isAdmin: boolean): Promise<Result<{ user: UserSummary }, ApiError>>;
  getSecretsStatus(token: string): Promise<Result<ProviderStatus, ApiError>>;
  replaceSecret(token: string, provider: Provider, value: string): Promise<Result<void, ApiError>>;
}

export interface ApiError { code: string; status: number }

export function createAdminApi(base = ""): AdminApi {
  return {
    listUsers: (token) => handleFetch(fetch(`${base}/api/v1/admin/users`, { headers: bearerHeaders(token) })),
    createUser: (token, input) => handleFetch(fetch(`${base}/api/v1/admin/users`, { method: "POST", headers: jsonHeaders(bearerHeaders(token)), body: JSON.stringify(input) })),
    deleteUser: (token, userId) => handleFetch(fetch(`${base}/api/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE", headers: bearerHeaders(token) })),
    resetPin: (token, userId, pin) => handleFetch(fetch(`${base}/api/v1/admin/users/${encodeURIComponent(userId)}/reset-pin`, { method: "POST", headers: jsonHeaders(bearerHeaders(token)), body: JSON.stringify({ pin }) })),
    setIsAdmin: (token, userId, isAdmin) => handleFetch(fetch(`${base}/api/v1/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", headers: jsonHeaders(bearerHeaders(token)), body: JSON.stringify({ isAdmin }) })),
    getSecretsStatus: (token) => handleFetch(fetch(`${base}/api/v1/admin/secrets`, { headers: bearerHeaders(token) })),
    replaceSecret: (token, provider, value) => handleFetch(fetch(`${base}/api/v1/admin/secrets/${provider}`, { method: "PUT", headers: jsonHeaders(bearerHeaders(token)), body: JSON.stringify({ value }) })),
  };
}
```

`handleFetch` already maps non-2xx responses to `{ok: false, error: {code, status}}` and `fetch` rejections to `NETWORK_ERROR`. The error-code field comes straight from the gateway's JSON body (e.g., `pool-full`, `last-admin`, `schema`) — Members and System panels switch on these codes for toast text.

- [ ] **Step 1: Implement.** No tests (pure plumbing; smoke + handler contract tests already cover the wire shape).
- [ ] **Step 2: Commit.**

---

## Task 7.8: SystemPanel (replace API keys)

**Files:**
- Create: `gateway/webui/src/components/settings/system-panel.tsx`
- Append: `gateway/webui/src/styles/components.css` (BEM block `.system-panel`)

**Layout:**

```
┌─ System ──────────────────────────────────────────────────┐
│ Provider keys                                              │
│ Used by the gateway to talk to OpenRouter, Ollama Cloud,  │
│ and Fish Audio. Keys are written to                        │
│ ~/.sentient/gateway/secrets.json (chmod 600) and never    │
│ leave the gateway.                                         │
│                                                            │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ OpenRouter                       Configured          │ │
│ │ ••••••••                           [Replace]         │ │
│ └──────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ Ollama Cloud                  Not configured         │ │
│ │ —                                  [Add key]         │ │
│ └──────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ Fish Audio                       Configured          │ │
│ │ ••••••••                           [Replace]         │ │
│ └──────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

Click [Replace]/[Add key] → row expands inline into a single password-type input + "Save"/"Cancel" buttons. On Save → `replaceSecret(provider, value)` → toast "OpenRouter key replaced" / "OpenRouter key added". On 422 → toast "That doesn't look like a valid key". The input MUST be `type="password"` and **must clear** on blur or save (no DOM persistence of the value beyond submit).

```tsx
// gateway/webui/src/components/settings/system-panel.tsx (skeleton)
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../hooks/use-auth.tsx";
import { useToast } from "../../hooks/use-toast.tsx";
import { createAdminApi, type Provider, type ProviderStatus } from "../../services/admin-api.ts";

const log = createLogger(["sentient", "webui", "settings", "system"]);
const api = createAdminApi();

const PROVIDERS: ReadonlyArray<{ id: Provider; label: string; description: string }> = [
  { id: "openrouter", label: "OpenRouter", description: "Hosted LLMs (GPT, Claude, Gemini, DeepSeek, …)." },
  { id: "ollama", label: "Ollama Cloud", description: "Open-weight models on Ollama's hosted runtime." },
  { id: "fish", label: "Fish Audio", description: "Voice synthesis (TTS)." },
];

export function SystemPanel(): preact.JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [editing, setEditing] = useState<Provider | null>(null);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    (async () => {
      const r = await api.getSecretsStatus(auth.token);
      if (r.ok) setStatus(r.value);
      else log.warn("status.failed", { code: r.error.code });
    })();
  }, [auth.status]);

  if (auth.status !== "authenticated") return <></>;
  if (!status) return <section class="settings-panel"><p class="settings-panel__desc">Loading…</p></section>;

  return (
    <section class="settings-panel">
      <header class="settings-panel__header">
        <h2 class="settings-panel__title">System</h2>
      </header>
      <p class="settings-panel__desc">
        Provider keys. Stored in <code>~/.sentient/gateway/secrets.json</code> (chmod 600). Never sent in any UI response.
      </p>
      <div class="system-panel__list">
        {PROVIDERS.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            configured={status[p.id].configured}
            isEditing={editing === p.id}
            onEdit={() => setEditing(p.id)}
            onCancel={() => setEditing(null)}
            onSave={async (value) => {
              const r = await api.replaceSecret(auth.token, p.id, value);
              if (!r.ok) {
                toast.show(r.error.code === "schema" ? "That doesn't look like a valid key" : "Couldn't save key", "error");
                return;
              }
              setEditing(null);
              setStatus({ ...status, [p.id]: { configured: value !== "" } });
              toast.show(value === "" ? `${p.label} key cleared` : `${p.label} key replaced`);
            }}
          />
        ))}
      </div>
    </section>
  );
}

interface ProviderRowProps {
  provider: { id: Provider; label: string; description: string };
  configured: boolean;
  isEditing: boolean;
  onEdit(): void;
  onCancel(): void;
  onSave(value: string): Promise<void>;
}

function ProviderRow(props: ProviderRowProps): preact.JSX.Element {
  const [draft, setDraft] = useState("");
  // Clear draft on cancel / save
  useEffect(() => { if (!props.isEditing) setDraft(""); }, [props.isEditing]);
  return (
    <div class="system-panel__row">
      <div class="system-panel__row-meta">
        <p class="system-panel__row-label">{props.provider.label}</p>
        <p class="system-panel__row-desc">{props.provider.description}</p>
      </div>
      <div class="system-panel__row-status">
        {props.configured ? <span class="system-panel__chip system-panel__chip--ok">Configured</span> : <span class="system-panel__chip">Not configured</span>}
      </div>
      {!props.isEditing ? (
        <button class="settings-ghost-btn" type="button" onClick={props.onEdit}>
          {props.configured ? "Replace" : "Add key"}
        </button>
      ) : (
        <form class="system-panel__edit" onSubmit={(e) => { e.preventDefault(); void props.onSave(draft); }}>
          <input
            type="password"
            class="system-panel__input"
            placeholder="paste key…"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            autoFocus
          />
          <button class="settings-ghost-btn" type="submit">Save</button>
          <button class="settings-ghost-btn" type="button" onClick={props.onCancel}>Cancel</button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 1: Implement.** Component file <200 lines including `ProviderRow`. Add BEM block `.system-panel` to `components.css` (rows in a vertical flex stack, label + description on the left, status chip + button on the right, edit form replaces button when active).
- [ ] **Step 2: Commit.**

---

## Task 7.9: MembersPanel rewrite

**Files:**
- Modify: `gateway/webui/src/components/settings/members-panel.tsx` (rewrite — fixture → real)
- Modify: `gateway/webui/src/components/settings/member-row.tsx` (rewrite signature to accept the real shape from `admin-api.listUsers`)
- Append: `gateway/webui/src/styles/components.css` (extend `.member-list`/`.member-row` if needed; reuse what's there)
- Delete: `gateway/webui/src/data/household-fixtures.ts` (and remove import from members-panel)

**Layout:**

```
┌─ Members ────────────────────────────────────────────────┐
│ Everyone who can talk to Sentient. Admins can manage     │
│ users; everyone else is read-only on this list.          │
│                                                            │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ K  Kevin                  Admin · alice              │ │
│ │                           [Reset PIN] [⋯]            │ │
│ └──────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ S  Sam                    Member · bob               │ │
│ │                           [Reset PIN] [⋯]            │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                            │
│ ┌─ Add member ───────────────────────────────────────┐   │
│ │ Display name  [_____________________]               │   │
│ │ PIN           [____]   Confirm  [____]              │   │
│ │ ☐ Admin                                             │   │
│ │ <slot status: 1 of 3 slots free>      [Add member] │   │
│ └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

The `[⋯]` overflow menu shows: Promote/Demote · Delete. Delete opens a typed-confirmation modal:

```
┌─ Delete Sam? ────────────────────────────────────────┐
│                                                       │
│ This stops Sam's Hermes container, archives their    │
│ profile + memory to ~/.sentient/gateway/_archive/,   │
│ and removes them from the login screen. The slot     │
│ becomes available for a new member.                   │
│                                                       │
│ Type "delete sam" to confirm:                        │
│ [_____________________________]                      │
│                                                       │
│                       [Cancel] [Delete member]       │
└───────────────────────────────────────────────────────┘
```

The Delete button is disabled until the confirm string matches `delete <displayName.toLowerCase()>` exactly. On click → `deleteUser(userId)`; on success: toast + refresh list; on 422 last-admin → toast "Can't delete the only admin".

Slot-status footer: compute `free = poolSize - currentUserCount`. Disable the form when free === 0 with a hint ("All slots in use. Delete a member first or expand the pool in docker-compose.").

The "Add member" form, on submit:
1. Client-side validate displayName.length >= 1 / pin matches /^\d{4}$/ / pins match.
2. POST → on 201, toast + clear form + refresh list. On 422 `pool-full`, toast "All slots in use. Delete a member first or expand the pool."
3. **Brief delay until the new container is healthy** — the request stays open until apply completes (provisioner blocks on runApply), so render the spinner-overlay primitive from Phase 6 over the panel during the await.

### Skeleton

Split into three files to stay under the size limits:

```tsx
// members-panel.tsx
export function MembersPanel(): preact.JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UserSummary | null>(null);

  const refresh = useCallback(async () => {
    if (auth.status !== "authenticated") return;
    const r = await api.listUsers(auth.token);
    if (r.ok) setUsers(r.value.users);
    else toast.show("Couldn't load members", "error");
  }, [auth]);

  useEffect(() => { void refresh(); }, [refresh]);
  if (auth.status !== "authenticated") return <></>;

  const slotsFree = users ? Math.max(0, POOL_SIZE - users.length) : 0;

  return (
    <section class="settings-panel">
      <SpinnerOverlay open={busy} heading="Provisioning member…" body="Do not close this tab" />
      <header class="settings-panel__header"><h2 class="settings-panel__title">Members</h2></header>
      <p class="settings-panel__desc">Everyone who can talk to Sentient. Admins manage; everyone else is read-only.</p>

      {users === null ? <p class="settings-panel__desc">Loading…</p> : (
        <div class="member-list">
          {users.map((u) => (
            <MemberRow
              key={u.userId}
              member={u}
              isSelf={u.userId === auth.user.userId}
              onResetPin={async (newPin) => { /* POST resetPin, toast, refresh */ }}
              onToggleAdmin={async () => { /* PATCH isAdmin, toast (handle last-admin), refresh */ }}
              onDelete={() => setDeleteTarget(u)}
            />
          ))}
        </div>
      )}

      <MemberAddForm
        slotsFree={slotsFree}
        disabled={busy || slotsFree === 0}
        onSubmit={async ({ displayName, pin, isAdmin }) => {
          setBusy(true);
          const r = await api.createUser(auth.token, { displayName, pin, isAdmin });
          setBusy(false);
          if (!r.ok) {
            toast.show(
              r.error.code === "pool-full" ? "All slots in use" :
              r.error.code === "schema" ? "Check the form fields" :
              r.error.code === "apply-error" ? "Member created but their agent failed to start" :
              "Couldn't add member",
              "error",
            );
            return;
          }
          toast.show(`Welcome, ${r.value.user.displayName}`);
          await refresh();
        }}
      />

      {deleteTarget && (
        <MemberDeleteModal
          member={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            const target = deleteTarget;
            setDeleteTarget(null);
            setBusy(true);
            const r = await api.deleteUser(auth.token, target.userId);
            setBusy(false);
            if (!r.ok) {
              toast.show(r.error.code === "last-admin" ? "Can't delete the only admin" : "Couldn't delete member", "error");
              return;
            }
            toast.show(`${target.displayName} removed`);
            await refresh();
          }}
        />
      )}
    </section>
  );
}
```

`MemberRow` (separate file `member-row.tsx`, <100 lines) accepts `{member, isSelf, onResetPin, onToggleAdmin, onDelete}` — renders avatar tile, display name, role + slotKey badge, and a `[⋯]` overflow menu (button + popover) with Promote/Demote, Reset PIN (opens an inline 4-digit input), Delete. Disable Promote/Demote/Delete when `isSelf` is true (admin can't delete or demote themselves through the UI; the gateway enforces last-admin separately).

`MemberAddForm` (separate file `member-add-form.tsx`, <120 lines) — display name input, PIN + confirm PIN inputs, `<input type="checkbox">` for isAdmin, submit button. Disable when `slotsFree === 0` and show the hint above the button.

`MemberDeleteModal` (separate file `member-delete-modal.tsx`, <80 lines) — render to `document.body` via Preact portal. Form input + Delete button gated on `inputValue === \`delete ${member.displayName.toLowerCase()}\``. Cancel button closes.

```tsx
// member-delete-modal.tsx (sketch)
const expected = `delete ${member.displayName.toLowerCase()}`;
const canConfirm = input.trim().toLowerCase() === expected;

return createPortal(
  <div class="modal-scrim" onClick={onCancel}>
    <div class="modal" onClick={(e) => e.stopPropagation()}>
      <h2>Delete {member.displayName}?</h2>
      <p class="modal__body">
        This stops their Hermes container, archives their profile and memory to
        <code>~/.sentient/gateway/_archive/</code>, and removes them from the login screen.
        The slot becomes available for a new member.
      </p>
      <label class="modal__label">
        Type "{expected}" to confirm:
        <input class="modal__input" value={input} onInput={(e) => setInput(e.target.value)} />
      </label>
      <div class="modal__actions">
        <button class="settings-ghost-btn" onClick={onCancel}>Cancel</button>
        <button class="settings-ghost-btn settings-ghost-btn--danger" disabled={!canConfirm} onClick={onConfirm}>Delete member</button>
      </div>
    </div>
  </div>,
  document.body,
);
```

`POOL_SIZE` is exported from `admin-api.ts` (or a shared constants file) — start with `3` to match the current compose. Surface a friendly hint when `slotsFree === 0`.

- [ ] **Step 1: Implement the four files** (`members-panel.tsx`, `member-row.tsx`, `member-add-form.tsx`, `member-delete-modal.tsx`).
- [ ] **Step 2: Append BEM blocks to `components.css`:** `.member-list`, `.member-row`, `.member-row__overflow`, `.member-add`, `.modal-scrim`, `.modal`, `.modal__*`. Reuse existing tokens — no new colors / radii / shadows.
- [ ] **Step 3: Delete `gateway/webui/src/data/household-fixtures.ts`** and remove the import. Verify with `bun run typecheck` that nothing else referenced it.
- [ ] **Step 4: Commit.**

---

## Task 7.10: settings-view + settings-tabs integration

**Files:**
- Modify: `gateway/webui/src/components/settings/settings-tabs.tsx` (add `"system"` to the `SettingsTab` union)
- Modify: `gateway/webui/src/components/settings/settings-view.tsx` (add `system` to `ADMIN_TABS`; add `case "system": return <SystemPanel />;` to the switch; remove `<WipBadge />` from `MembersPanel` since it's now real)

After this task, an admin sees: My Agent · My Account · **Members** · **System** · Permissions · Voices · Sessions · Invites — first four are functional, last four still show WIP badges (deferred per §11).

- [ ] **Step 1: Implement.** Order in the array: `["my-agent", "my-account", "members", "system", "permissions", "voices", "sessions", "invites"]` so Members + System sit next to each other and the WIP badges trail.
- [ ] **Step 2: Tab labels.** `settings-tabs.tsx` already has a label map; add `"system": "System"`.
- [ ] **Step 3: Commit.**

---

## Task 7.11: Manual smoke (browser, Chrome devtools MCP if available; otherwise manual checklist)

**Goal:** Walk through every Phase 7 acceptance criterion from `docs/superpowers/plans/2026-04-24-multi-user-overview.md`:

> - Members tab: add user → new avatar shows on login screen; delete user → `_archive/` directory exists → container stopped.
> - System tab: Replace OpenRouter key → next `/api/models` call uses new key; keys never exposed in responses.
> - Non-admin user cannot see Members/System tabs.

**Procedure:**

- [ ] **Stack up.** From the worktree root: `source scripts/env.sh && cd deploy/docker && docker compose build gateway && docker compose up -d`. Verify `docker ps` shows `sentient-gateway` healthy and at minimum `hermes-alice` (also `hermes-bob` and `hermes-family` if compose has them enabled — if they're disabled by default, enable them via `docker compose up -d hermes-bob hermes-family` so the slot pool actually has 3 slots).

- [ ] **Login as Kevin (admin) on https://127.0.0.1:8888.** PIN-pad login should work as before.

- [ ] **Verify Kevin's slot binding was migrated.** Inspect `~/.sentient/gateway/slot-bindings.json` (the bind-mounted host path). Expect one entry: `[{userId: "u_6ae26974", slotKey: "alice"}]` (or whatever Kevin's actual userId is). If empty → `BLOCKED: boot migration (Task 7.4.5) didn't run`. Verify the gateway logs at startup show `[admin:boot-migration] migration.bound | userId=… slotKey=alice`.

- [ ] **Open Settings → Members.** Verify Kevin appears with role=Admin and slotKey=alice.

- [ ] **Add member.** Display name `Sam`, PIN `4242`, isAdmin off. Click Add member. Watch for the spinner overlay during apply, then toast. Members list now shows Sam · Member · bob.

- [ ] **Verify Sam landed end-to-end:**
  - `~/.sentient/gateway/<sam-userId>/profile.json` exists.
  - `~/.sentient/gateway/<sam-userId>/.generated/SOUL.md` and `config.yaml` exist.
  - `docker ps` shows `hermes-bob` healthy.
  - Logout → login screen now shows Kevin AND Sam as avatars.

- [ ] **Login as Sam (incognito window), PIN 4242.** Should land in chat. Open Settings → only My Agent + My Account visible (no Members, no System, no admin tabs).

- [ ] **Send Sam a chat turn ("hi sam").** Should hit hermes-bob. Verify with `docker logs hermes-bob | tail` showing the request.

- [ ] **Back to Kevin's window, Settings → System.** Confirm OpenRouter shows "Configured", click Replace, paste a new key, Save. Toast appears. Then trigger a model fetch via the My Agent tab's model picker; gateway logs should show `OPENROUTER_API_KEY` fingerprint changing (or at least no auth error).

- [ ] **Members → ⋯ on Sam → Delete.** Type the confirmation `delete sam`, click Delete. Toast. Sam disappears from the list. `~/.sentient/gateway/_archive/<sam-userId>-<ts>/` exists with Sam's old `profile.json` inside. `docker ps` shows `hermes-bob` still running (Phase 7's deleteUser does NOT stop the container — see Task 7.4 design note: the freed slot keeps its container running with stale config until the next user is bound to it). Login screen no longer shows Sam.

- [ ] **Pool-full smoke.** Create users until the pool fills (3 slots → add 2 more after Kevin). Try to add a 4th. Expect 422 + toast "All slots in use".

- [ ] **Last-admin guard.** With Kevin as the only admin, try to PATCH yourself to non-admin via the ⋯ menu. Expect 422 + toast "Can't demote the only admin".

- [ ] **Cleanup.** Delete the test users created during smoke (or note them as smoke artifacts — the user can reset users.json manually).

- [ ] **Commit nothing.** Smoke test produces no code changes. If it surfaces bugs, dispatch fix tasks.

---

## Optional Follow-Ons (Out of Scope — list only)

If the executor finishes Phase 7 with time remaining, surface these as candidates rather than implementing silently:

- **Shared templates editor** (§6.4 lists it as System MVP). Requires: `~/.sentient/gateway/shared/templates/default-system.md` GET/PUT admin endpoints, a textarea section in `SystemPanel`, and a flag that re-render-on-next-apply uses the latest template (already true — `template-loader.ts` re-reads on each render). Surface, don't implement silently.
- Pool expansion: bump compose from 3 to 6 slots (hermes-1..hermes-6 with generic names). Requires renaming the existing `alice`/`bob`/`family` keys, which is a non-trivial migration — defer.
- Reset-PIN UX: today the admin types the new PIN; consider a "let user set their own next time" flag in the future.
- Display-name change for other users (admin operates on others) — out of scope per §11.
- Audit log of admin operations — defer.

---

## Self-Review Checklist (run before declaring DONE on the whole plan)

- [ ] Spec coverage: §4.5 (4 admin endpoints) ✓, §5.3 (key wall + secrets-store wired into catalog fetchers) ✓, §6.4 Members/System rows ✓ (templates editor explicitly deferred). Boot migration covers the existing-user back-compat case.
- [ ] Test-lean: contract tests for admin user CRUD + admin secrets, FSM tests for slot-allocator + user-provisioner, store unit tests for slot-binding-store + secrets-store + boot-migration, one security log-redaction assertion. **No** render tests for SystemPanel / MembersPanel / member-row / member-add-form / member-delete-modal.
- [ ] No edits outside the allowlist in Hard Rules §2.
- [ ] No `--no-verify`, no skipped hooks.
- [ ] All commits run lint + typecheck + test green.
- [ ] Browser smoke walked end-to-end on a fresh stack including: boot-migration check, add-user (Sam→bob) end-to-end, login as Sam (incognito) sees only My Agent + My Account, key-replace updates next /providers/models call, delete Sam moves dir to `_archive/`, pool-full guard, last-admin guard.
