# Multi-User Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the gateway-owned stores and auth primitives (config schema, user store, PIN hashing, token service, auth secret key management) so later phases have testable, typed dependencies. No user-visible behavior yet.

**Architecture:** Files under `~/.sentient/gateway/` become the single source of truth for per-user config and secrets. New `gateway/src/user-auth/` directory owns PIN hashing (Bun built-in argon2id), PASETO v4.local token issuance, and atomic file I/O for `users.json`. New config sections `auth:`, `apply:`, `providers:` live in `shared/config/src/schema.ts` alongside existing sections.

**Tech Stack:** Bun (native `Bun.password`), Zod (schema), `paseto-ts` v2.0.5 (already in `shared/testing`), Vitest.

**Overview:** [2026-04-24-multi-user-overview.md](2026-04-24-multi-user-overview.md)

**Spec:** [2026-04-24-multi-user-auth-and-settings-design.md](../specs/2026-04-24-multi-user-auth-and-settings-design.md)

---

## File Structure

**New files (create):**
- `gateway/src/user-auth/user-store.ts` — CRUD for `users.json` with atomic rename
- `gateway/src/user-auth/user-store.test.ts`
- `gateway/src/user-auth/pin-service.ts` — `hashPin()` / `verifyPin()` over Bun argon2id
- `gateway/src/user-auth/pin-service.test.ts`
- `gateway/src/user-auth/auth-secret.ts` — load-or-generate 32-byte PASETO key at `~/.sentient/gateway/auth-secret.key`
- `gateway/src/user-auth/auth-secret.test.ts`
- `gateway/src/user-auth/token-service.ts` — PASETO v4.local issue + validate
- `gateway/src/user-auth/token-service.test.ts`
- `gateway/src/user-auth/types.ts` — shared typed unions (`UserRecord`, `UserStoreError`, `TokenError`, `Argon2Params`)
- `gateway/src/user-auth/paths.ts` — centralize `~/.sentient/gateway/**` path resolution (so tests can override via env)
- `gateway/src/user-auth/paths.test.ts`

**Modified files:**
- `shared/config/src/schema.ts` — add `authConfigSchema`, `applyConfigSchema`, `providersConfigSchema` + root wiring
- `gateway/package.json` — add `paseto-ts` dep (promote from `shared/testing`)
- `gateway/config.yaml` — seed new config sections with defaults (commented)

**Not touched in Phase 0:** HTTP routes, WS handlers, webui, SessionRouter, Hermes client. Those come in Phases 1+.

---

## Task 0.1: Add paseto-ts to gateway + promote shared types

**Files:**
- Modify: `gateway/package.json` (add `paseto-ts` to dependencies)
- Create: `gateway/src/user-auth/types.ts`
- Create: `gateway/src/user-auth/types.test.ts`

- [ ] **Step 1: Add dependency**

```bash
cd /Users/kevinye/Development/sentient && bun add paseto-ts@^2.0.5 --cwd gateway
```

Expected: `gateway/package.json` gains `"paseto-ts": "^2.0.5"` under `dependencies`. Bun lockfile updates.

- [ ] **Step 2: Write shared types file**

Create `gateway/src/user-auth/types.ts`:

```typescript
import type { Result } from "@sentient/protocol";

/** Tint color for user avatar circles; matches webui avatar palette. */
export type AvatarTint = "terra" | "sage" | "amber" | "clay";

/** Persisted per-user record. `pinHash` is argon2id; never log it. */
export interface UserRecord {
  userId: string;
  displayName: string;
  pinHash: string;
  isAdmin: boolean;
  avatarTint: AvatarTint;
  createdAt: string; // ISO-8601 UTC
}

export type UserStoreError =
  | "not-found"
  | "already-exists"
  | "io-error"
  | "corrupt-file"
  | "last-admin-demotion"; // guard used in later phases

export type TokenError =
  | "malformed"
  | "expired"
  | "signature-invalid"
  | "wrong-purpose";

/** Argon2id tunables sourced from gateway config `auth:` section. */
export interface Argon2Params {
  memoryKb: number;
  iterations: number;
  parallelism: number;
}

export interface TokenPayload {
  userId: string;
  isAdmin: boolean;
  issuedAt: number; // unix seconds
  expiresAt: number; // unix seconds
}

export type StoreResult<T> = Result<T, UserStoreError>;
export type TokenResult<T> = Result<T, TokenError>;
```

- [ ] **Step 3: Write type-surface test**

Create `gateway/src/user-auth/types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { UserRecord, AvatarTint, Argon2Params, TokenPayload, StoreResult, TokenResult } from "./types.js";

describe("user-auth types", () => {
  it("constructs a UserRecord with all required fields", () => {
    const rec: UserRecord = {
      userId: "kevin",
      displayName: "Kevin",
      pinHash: "$argon2id$...",
      isAdmin: true,
      avatarTint: "terra",
      createdAt: "2026-04-24T00:00:00.000Z",
    };
    expect(rec.userId).toBe("kevin");
  });

  it("enforces AvatarTint as a discrete union", () => {
    const tints: AvatarTint[] = ["terra", "sage", "amber", "clay"];
    expect(tints).toHaveLength(4);
  });

  it("Argon2Params has three numeric tunables", () => {
    const p: Argon2Params = { memoryKb: 65536, iterations: 3, parallelism: 1 };
    expect(p.memoryKb).toBe(65536);
  });

  it("TokenPayload carries issuedAt + expiresAt as unix seconds", () => {
    const now = Math.floor(Date.now() / 1000);
    const p: TokenPayload = { userId: "kevin", isAdmin: true, issuedAt: now, expiresAt: now + 3600 };
    expect(p.expiresAt - p.issuedAt).toBe(3600);
  });

  it("StoreResult and TokenResult round-trip ok + err shapes", () => {
    const ok: StoreResult<number> = { ok: true, value: 42 };
    const err: TokenResult<never> = { ok: false, error: "expired" };
    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/types
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/package.json gateway/src/user-auth/types.ts gateway/src/user-auth/types.test.ts
git commit -m "feat(user-auth): add paseto-ts dep and user-auth type surface"
```

---

## Task 0.2: Path resolution helper

Centralize `~/.sentient/gateway/` path construction so tests can redirect to a temp dir via env var.

**Files:**
- Create: `gateway/src/user-auth/paths.ts`
- Create: `gateway/src/user-auth/paths.test.ts`

- [ ] **Step 1: Write failing test**

Create `gateway/src/user-auth/paths.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { getGatewayRoot, getUsersJsonPath, getAuthSecretPath, getUserProfileDir, getSecretsJsonPath } from "./paths.js";

describe("gateway paths", () => {
  const originalEnv = process.env.SENTIENT_GATEWAY_ROOT;

  beforeEach(() => {
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SENTIENT_GATEWAY_ROOT = originalEnv;
    else delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("returns ~/.sentient/gateway by default", () => {
    expect(getGatewayRoot()).toBe(join(homedir(), ".sentient", "gateway"));
  });

  it("honors SENTIENT_GATEWAY_ROOT override for tests", () => {
    process.env.SENTIENT_GATEWAY_ROOT = "/tmp/sentient-test-42";
    expect(getGatewayRoot()).toBe("/tmp/sentient-test-42");
  });

  it("derives users.json under the root", () => {
    process.env.SENTIENT_GATEWAY_ROOT = "/tmp/g";
    expect(getUsersJsonPath()).toBe("/tmp/g/users.json");
  });

  it("derives auth-secret.key under the root", () => {
    process.env.SENTIENT_GATEWAY_ROOT = "/tmp/g";
    expect(getAuthSecretPath()).toBe("/tmp/g/auth-secret.key");
  });

  it("derives secrets.json under the root", () => {
    process.env.SENTIENT_GATEWAY_ROOT = "/tmp/g";
    expect(getSecretsJsonPath()).toBe("/tmp/g/secrets.json");
  });

  it("derives per-user profile dir under the root", () => {
    process.env.SENTIENT_GATEWAY_ROOT = "/tmp/g";
    expect(getUserProfileDir("kevin")).toBe("/tmp/g/kevin");
  });
});
```

- [ ] **Step 2: Run test — expect fail (no impl)**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/paths
```

Expected: module not found / import error.

- [ ] **Step 3: Implement paths.ts**

Create `gateway/src/user-auth/paths.ts`:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the gateway-owned storage root.
 * Defaults to ~/.sentient/gateway. Override via SENTIENT_GATEWAY_ROOT (tests, custom deploy).
 */
export function getGatewayRoot(): string {
  const override = process.env.SENTIENT_GATEWAY_ROOT;
  if (override && override.length > 0) return override;
  return join(homedir(), ".sentient", "gateway");
}

export function getUsersJsonPath(): string {
  return join(getGatewayRoot(), "users.json");
}

export function getSecretsJsonPath(): string {
  return join(getGatewayRoot(), "secrets.json");
}

export function getAuthSecretPath(): string {
  return join(getGatewayRoot(), "auth-secret.key");
}

export function getUserProfileDir(userId: string): string {
  return join(getGatewayRoot(), userId);
}

export function getSharedTemplatesDir(): string {
  return join(getGatewayRoot(), "shared", "templates");
}

export function getSharedCatalogsDir(): string {
  return join(getGatewayRoot(), "shared", "catalogs");
}

export function getArchiveDir(): string {
  return join(getGatewayRoot(), "_archive");
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/paths
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/user-auth/paths.ts gateway/src/user-auth/paths.test.ts
git commit -m "feat(user-auth): gateway path resolution with env override for tests"
```

---

## Task 0.3: Config schema additions

Add `auth:`, `apply:`, `providers:` sections to the config schema per spec §10.

**Files:**
- Modify: `shared/config/src/schema.ts`
- Modify: `gateway/config.yaml` (seed commented defaults)
- Create: `shared/config/src/schema.test.ts` (add tests if file exists, else new; check first)

- [ ] **Step 1: Check existing schema test file**

```bash
ls shared/config/src/*.test.ts 2>/dev/null
```

If `schema.test.ts` exists, append to it; else create.

- [ ] **Step 2: Write failing test**

Append to `shared/config/src/schema.test.ts` (create if absent):

```typescript
import { describe, expect, it } from "vitest";
import { gatewayConfigSchema } from "./schema.js";

describe("gateway config — auth/apply/providers sections", () => {
  const minimal = {
    stt: { provider: "local-stt" },
    llm: { provider: "openrouter" },
    tts: { provider: "fish-audio" },
  };

  it("defaults auth.token_ttl_seconds to 7 days", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.auth.token_ttl_seconds).toBe(604800);
  });

  it("defaults auth.ws_auth_timeout_ms to 5000", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.auth.ws_auth_timeout_ms).toBe(5000);
  });

  it("defaults argon2 params to memory=65536 iterations=3 parallelism=1", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.auth.argon2_memory_kb).toBe(65536);
    expect(cfg.auth.argon2_iterations).toBe(3);
    expect(cfg.auth.argon2_parallelism).toBe(1);
  });

  it("defaults apply.flush_timeout_ms to 30000 and stop_grace to 60000", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.apply.flush_timeout_ms).toBe(30000);
    expect(cfg.apply.docker_stop_grace_ms).toBe(60000);
  });

  it("requires docker_stop_grace_ms > flush_timeout_ms (per spec §3.2)", () => {
    const bad = { ...minimal, apply: { flush_timeout_ms: 30000, docker_stop_grace_ms: 10000 } };
    expect(() => gatewayConfigSchema.parse(bad)).toThrow(/docker_stop_grace_ms/);
  });

  it("defaults providers.ollama_cloud_base_url to https://ollama.com/v1", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.providers.ollama_cloud_base_url).toBe("https://ollama.com/v1");
  });

  it("defaults providers.fish_cache_ttl_ms to 600000 (10min)", () => {
    const cfg = gatewayConfigSchema.parse(minimal);
    expect(cfg.providers.fish_cache_ttl_ms).toBe(600000);
  });
});
```

- [ ] **Step 3: Run test — expect fail**

```bash
source scripts/env.sh && bun run --filter '@sentient/config' test
```

Expected: property access on `cfg.auth` fails (undefined), schema keys don't exist.

- [ ] **Step 4: Extend schema**

Modify `shared/config/src/schema.ts`. Insert the three new schemas before the "Root" comment block, and wire them into `gatewayConfigSchema`.

Insert before root:

```typescript
// ---------------------------------------------------------------------------
// Auth — user-facing login (PIN + token)
// ---------------------------------------------------------------------------

export const authConfigSchema = z.object({
  // Lifetime (seconds) for issued PASETO tokens. Rolling-refreshed on each
  // auth-check. Default 7 days (604800).
  token_ttl_seconds: z.number().int().min(60).default(604800),
  // Window (ms) for the WS client to send its auth message after connect.
  // Connection closed if not received in time. Default 5000.
  ws_auth_timeout_ms: z.number().int().min(100).default(5000),
  // argon2id parameters — increase memory/iterations if Pi-5 can spare the CPU.
  argon2_memory_kb: z.number().int().min(8192).default(65536),
  argon2_iterations: z.number().int().min(1).default(3),
  argon2_parallelism: z.number().int().min(1).default(1),
});

export type AuthConfig = z.output<typeof authConfigSchema>;

// ---------------------------------------------------------------------------
// Apply — settings-change orchestration (flush + restart)
// ---------------------------------------------------------------------------

export const applyConfigSchema = z
  .object({
    // Hermes memory-flush timeout (ms). Matches Hermes's
    // auxiliary.flush_memories.timeout. Default 30000.
    flush_timeout_ms: z.number().int().min(1000).default(30000),
    // Docker stop grace period (ms) — MUST exceed flush_timeout_ms so SIGTERM
    // path completes before SIGKILL.
    docker_stop_grace_ms: z.number().int().min(5000).default(60000),
    // Docker start timeout (ms) before considering the restart failed.
    docker_start_timeout_ms: z.number().int().min(5000).default(60000),
    // How long to poll the container's health endpoint after start.
    health_check_timeout_ms: z.number().int().min(1000).default(30000),
    // PersonSession idle window (ms) before gateway triggers Hermes
    // session-end + memory flush. Default 30 minutes.
    idle_flush_ms: z.number().int().min(60_000).default(1_800_000),
  })
  .refine((v) => v.docker_stop_grace_ms > v.flush_timeout_ms, {
    message: "docker_stop_grace_ms MUST be greater than flush_timeout_ms",
  });

export type ApplyConfig = z.output<typeof applyConfigSchema>;

// ---------------------------------------------------------------------------
// Providers — external catalog endpoints + cache TTLs
// ---------------------------------------------------------------------------

export const providersConfigSchema = z.object({
  openrouter_cache_ttl_ms: z.number().int().min(10_000).default(3_600_000),
  ollama_cloud_base_url: z.string().url().default("https://ollama.com/v1"),
  ollama_cache_ttl_ms: z.number().int().min(10_000).default(3_600_000),
  fish_cache_ttl_ms: z.number().int().min(10_000).default(600_000),
  external_fetch_timeout_ms: z.number().int().min(1000).default(5000),
});

export type ProvidersConfig = z.output<typeof providersConfigSchema>;
```

Then extend `gatewayConfigSchema`:

```typescript
export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8888),
  host: z.string().default("0.0.0.0"),
  max_sessions: z.number().int().min(1).max(100).default(10),
  auth_timeout_ms: z.number().int().min(1000).default(5000),
  session_persist_ms: z.number().int().min(0).default(120000),
  tls: tlsConfigSchema.default({}),
  session: sessionConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
  stt: sttConfigSchema,
  llm: llmConfigSchema,
  tts: ttsConfigSchema,
  cerebrum: cerebrumConfigSchema.default({}),
  webui: webuiConfigSchema.default({}),
  hermes: hermesConfigSchema.optional(),
  auth: authConfigSchema.default({}),
  apply: applyConfigSchema.default({}),
  providers: providersConfigSchema.default({}),
});
```

- [ ] **Step 5: Run test — expect pass**

```bash
source scripts/env.sh && bun run --filter '@sentient/config' test
```

Expected: 7 new tests pass; existing tests unaffected.

- [ ] **Step 6: Add commented defaults to gateway/config.yaml**

Append to `gateway/config.yaml` (at the bottom, separated by a blank line):

```yaml

auth:
  # Lifetime of issued PASETO tokens (seconds). Rolling-refreshed on each auth-check.
  token_ttl_seconds: 604800       # 7 days
  # How long the server waits for the WS client to send its auth message before closing.
  ws_auth_timeout_ms: 5000
  # argon2id tunables — raise if Pi-5 has CPU to spare.
  argon2_memory_kb: 65536
  argon2_iterations: 3
  argon2_parallelism: 1

apply:
  # Hermes memory-flush timeout. MUST match Hermes's auxiliary.flush_memories.timeout.
  flush_timeout_ms: 30000
  # MUST exceed flush_timeout_ms. Docker sends SIGKILL after this elapses.
  docker_stop_grace_ms: 60000
  docker_start_timeout_ms: 60000
  health_check_timeout_ms: 30000
  # Idle window before gateway triggers Hermes session-end + memory flush.
  idle_flush_ms: 1800000          # 30 minutes

providers:
  openrouter_cache_ttl_ms: 3600000
  ollama_cloud_base_url: https://ollama.com/v1
  ollama_cache_ttl_ms: 3600000
  fish_cache_ttl_ms: 600000       # Fish rate limits undocumented — keep short.
  external_fetch_timeout_ms: 5000
```

- [ ] **Step 7: Verify config loads**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' typecheck
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add shared/config/src/schema.ts shared/config/src/schema.test.ts gateway/config.yaml
git commit -m "feat(config): add auth, apply, providers config sections"
```

---

## Task 0.4: User store — atomic write helper

The store pattern is small enough to keep in one file. Extract the atomic-write primitive first because it's used by the secrets store later.

**Files:**
- Create: `gateway/src/user-auth/atomic-write.ts`
- Create: `gateway/src/user-auth/atomic-write.test.ts`

- [ ] **Step 1: Write failing test**

Create `gateway/src/user-auth/atomic-write.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "./atomic-write.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentient-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes contents to the target path", async () => {
    const path = join(dir, "a.json");
    await writeFileAtomic(path, '{"x":1}');
    expect(readFileSync(path, "utf8")).toBe('{"x":1}');
  });

  it("leaves no .tmp sibling after success", async () => {
    const path = join(dir, "b.json");
    await writeFileAtomic(path, "hello");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("overwrites an existing file", async () => {
    const path = join(dir, "c.json");
    await writeFileAtomic(path, "old");
    await writeFileAtomic(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("respects the requested file mode", async () => {
    const path = join(dir, "d.json");
    await writeFileAtomic(path, "secret", { mode: 0o600 });
    const { statSync } = await import("node:fs");
    const stat = statSync(path);
    // Linux / macOS: the low 9 bits are permission; mask and compare.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/atomic-write
```

Expected: import error.

- [ ] **Step 3: Implement**

Create `gateway/src/user-auth/atomic-write.ts`:

```typescript
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "user-auth", "atomic-write"]);

export interface AtomicWriteOptions {
  mode?: number;
}

/**
 * Atomic file write: write to `<path>.tmp`, fsync, then rename.
 * No torn files on crash. Mode (if given) is applied before rename.
 */
export async function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  const handle = await fs.open(tmp, "w", opts.mode ?? 0o644);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (opts.mode !== undefined) {
    await fs.chmod(tmp, opts.mode);
  }
  await fs.rename(tmp, path);
  log.debug("write-atomic", { path, bytes: content.length, mode: opts.mode });
}
```

- [ ] **Step 4: Run — expect pass**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/atomic-write
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/user-auth/atomic-write.ts gateway/src/user-auth/atomic-write.test.ts
git commit -m "feat(user-auth): atomic file write helper (write to .tmp + fsync + rename)"
```

---

## Task 0.5: User store CRUD

**Files:**
- Create: `gateway/src/user-auth/user-store.ts`
- Create: `gateway/src/user-auth/user-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `gateway/src/user-auth/user-store.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUserStore } from "./user-store.js";
import type { UserRecord } from "./types.js";

function sample(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: "kevin",
    displayName: "Kevin",
    pinHash: "$argon2id$fake",
    isAdmin: true,
    avatarTint: "terra",
    createdAt: "2026-04-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("createUserStore", () => {
  let root: string;
  let store: ReturnType<typeof createUserStore>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-users-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
    store = createUserStore();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("returns empty list when users.json missing", async () => {
    const r = await store.list();
    expect(r).toEqual({ ok: true, value: [] });
  });

  it("adds a user and reads it back", async () => {
    const add = await store.add(sample());
    expect(add).toEqual({ ok: true, value: undefined });
    const list = await store.list();
    expect(list).toEqual({ ok: true, value: [sample()] });
  });

  it("returns already-exists on duplicate userId", async () => {
    await store.add(sample());
    const dup = await store.add(sample({ displayName: "Other" }));
    expect(dup).toEqual({ ok: false, error: "already-exists" });
  });

  it("get returns null for unknown userId", async () => {
    const r = await store.get("ghost");
    expect(r).toEqual({ ok: true, value: null });
  });

  it("get returns the record", async () => {
    await store.add(sample());
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: true, value: sample() });
  });

  it("update patches fields and keeps userId intact", async () => {
    await store.add(sample());
    const upd = await store.update("kevin", { displayName: "Kevin Ye" });
    expect(upd).toEqual({ ok: true, value: undefined });
    const got = await store.get("kevin");
    expect(got.ok && got.value?.displayName).toBe("Kevin Ye");
  });

  it("update returns not-found for missing user", async () => {
    const upd = await store.update("ghost", { displayName: "x" });
    expect(upd).toEqual({ ok: false, error: "not-found" });
  });

  it("remove deletes the user", async () => {
    await store.add(sample());
    const rm = await store.remove("kevin");
    expect(rm).toEqual({ ok: true, value: undefined });
    const list = await store.list();
    expect(list).toEqual({ ok: true, value: [] });
  });

  it("remove returns not-found for missing user", async () => {
    const rm = await store.remove("ghost");
    expect(rm).toEqual({ ok: false, error: "not-found" });
  });

  it("returns corrupt-file when users.json is not an array", async () => {
    writeFileSync(join(root, "users.json"), '{"not":"an array"}', "utf8");
    const r = await store.list();
    expect(r).toEqual({ ok: false, error: "corrupt-file" });
  });

  it("persists via atomic rename — no .tmp sibling after add", async () => {
    await store.add(sample());
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(root, "users.json.tmp"))).toBe(false);
    expect(existsSync(join(root, "users.json"))).toBe(true);
  });

  it("round-trips non-ASCII display names", async () => {
    await store.add(sample({ displayName: "凯文" }));
    const got = await store.get("kevin");
    expect(got.ok && got.value?.displayName).toBe("凯文");
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/user-store
```

Expected: import error.

- [ ] **Step 3: Implement**

Create `gateway/src/user-auth/user-store.ts`:

```typescript
import { promises as fs } from "node:fs";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "./atomic-write.js";
import { getUsersJsonPath } from "./paths.js";
import type { StoreResult, UserRecord } from "./types.js";

const log = getLog(["sentient", "gateway", "user-auth", "user-store"]);

export interface UserStore {
  list(): Promise<StoreResult<UserRecord[]>>;
  get(userId: string): Promise<StoreResult<UserRecord | null>>;
  add(rec: UserRecord): Promise<StoreResult<void>>;
  update(userId: string, patch: Partial<Omit<UserRecord, "userId" | "createdAt">>): Promise<StoreResult<void>>;
  remove(userId: string): Promise<StoreResult<void>>;
}

async function readAll(): Promise<StoreResult<UserRecord[]>> {
  const path = getUsersJsonPath();
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      log.debug("list.empty", { reason: "users.json missing", path });
      return { ok: true, value: [] };
    }
    log.warn("list.io-error", { path, reason: (e as Error).message });
    return { ok: false, error: "io-error" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    log.warn("list.corrupt", { path, reason: (e as Error).message });
    return { ok: false, error: "corrupt-file" };
  }
  if (!Array.isArray(parsed)) {
    log.warn("list.corrupt", { path, reason: "not an array" });
    return { ok: false, error: "corrupt-file" };
  }
  return { ok: true, value: parsed as UserRecord[] };
}

async function writeAll(users: UserRecord[]): Promise<StoreResult<void>> {
  try {
    await writeFileAtomic(getUsersJsonPath(), JSON.stringify(users, null, 2), { mode: 0o600 });
    log.info("write-all", { count: users.length });
    return { ok: true, value: undefined };
  } catch (e: unknown) {
    log.warn("write-all.io-error", { reason: (e as Error).message });
    return { ok: false, error: "io-error" };
  }
}

export function createUserStore(): UserStore {
  return {
    async list() {
      return readAll();
    },

    async get(userId) {
      const r = await readAll();
      if (!r.ok) return r;
      const found = r.value.find((u) => u.userId === userId) ?? null;
      return { ok: true, value: found };
    },

    async add(rec) {
      const r = await readAll();
      if (!r.ok) return r;
      if (r.value.some((u) => u.userId === rec.userId)) {
        log.warn("add.already-exists", { userId: rec.userId });
        return { ok: false, error: "already-exists" };
      }
      return writeAll([...r.value, rec]);
    },

    async update(userId, patch) {
      const r = await readAll();
      if (!r.ok) return r;
      const idx = r.value.findIndex((u) => u.userId === userId);
      if (idx === -1) {
        log.warn("update.not-found", { userId });
        return { ok: false, error: "not-found" };
      }
      const existing = r.value[idx];
      if (!existing) return { ok: false, error: "not-found" };
      const next: UserRecord = { ...existing, ...patch, userId: existing.userId, createdAt: existing.createdAt };
      const updated = [...r.value];
      updated[idx] = next;
      log.info("update", { userId, fields: Object.keys(patch) });
      return writeAll(updated);
    },

    async remove(userId) {
      const r = await readAll();
      if (!r.ok) return r;
      const next = r.value.filter((u) => u.userId !== userId);
      if (next.length === r.value.length) {
        log.warn("remove.not-found", { userId });
        return { ok: false, error: "not-found" };
      }
      log.info("remove", { userId });
      return writeAll(next);
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/user-store
```

Expected: 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/user-auth/user-store.ts gateway/src/user-auth/user-store.test.ts
git commit -m "feat(user-auth): user-store CRUD with atomic write"
```

---

## Task 0.6: PIN service (Bun argon2id)

Bun's built-in `Bun.password.hash` supports argon2id natively — no extra dependency.

**Files:**
- Create: `gateway/src/user-auth/pin-service.ts`
- Create: `gateway/src/user-auth/pin-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `gateway/src/user-auth/pin-service.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { hashPin, verifyPin } from "./pin-service.js";

const PARAMS = { memoryKb: 8192, iterations: 1, parallelism: 1 }; // fast-for-test

describe("pin-service", () => {
  it("hashPin returns an argon2id-formatted string", async () => {
    const hash = await hashPin("1234", PARAMS);
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it("verifyPin returns true for the original pin", async () => {
    const hash = await hashPin("1234", PARAMS);
    const ok = await verifyPin("1234", hash);
    expect(ok).toBe(true);
  });

  it("verifyPin returns false for a wrong pin", async () => {
    const hash = await hashPin("1234", PARAMS);
    const ok = await verifyPin("9999", hash);
    expect(ok).toBe(false);
  });

  it("hashPin yields different hashes for the same pin (random salt)", async () => {
    const a = await hashPin("1234", PARAMS);
    const b = await hashPin("1234", PARAMS);
    expect(a).not.toBe(b);
  });

  it("verifyPin returns false for a malformed hash", async () => {
    const ok = await verifyPin("1234", "not-a-hash");
    expect(ok).toBe(false);
  });

  it("verifyPin returns false on empty pin", async () => {
    const hash = await hashPin("1234", PARAMS);
    const ok = await verifyPin("", hash);
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/pin-service
```

Expected: import error.

- [ ] **Step 3: Implement**

Create `gateway/src/user-auth/pin-service.ts`:

```typescript
import { getLog } from "../logging/logger.js";
import type { Argon2Params } from "./types.js";

const log = getLog(["sentient", "gateway", "user-auth", "pin-service"]);

/** Hash a PIN with argon2id. Rejects empty pin. */
export async function hashPin(pin: string, params: Argon2Params): Promise<string> {
  if (pin.length === 0) {
    throw new Error("hashPin: empty pin");
  }
  const hash = await Bun.password.hash(pin, {
    algorithm: "argon2id",
    memoryCost: params.memoryKb,
    timeCost: params.iterations,
  });
  log.debug("hash", { memoryKb: params.memoryKb, iterations: params.iterations });
  return hash;
}

/** Verify a PIN against a stored argon2id hash. Returns false on any error. */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  if (pin.length === 0) return false;
  try {
    return await Bun.password.verify(pin, hash);
  } catch (e: unknown) {
    log.debug("verify.reject", { reason: (e as Error).message });
    return false;
  }
}
```

- [ ] **Step 4: Run — expect pass**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/pin-service
```

Expected: 6 tests pass, each under 100ms (low argon2 params).

- [ ] **Step 5: Commit**

```bash
git add gateway/src/user-auth/pin-service.ts gateway/src/user-auth/pin-service.test.ts
git commit -m "feat(user-auth): PIN service with Bun argon2id hash/verify"
```

---

## Task 0.7: Auth secret key (load-or-generate)

PASETO v4.local needs a 32-byte symmetric key. Gateway generates one at first boot and persists it under `~/.sentient/gateway/auth-secret.key` (chmod 600). Override via `SENTIENT_AUTH_SECRET_KEY_BASE64` env var.

**Files:**
- Create: `gateway/src/user-auth/auth-secret.ts`
- Create: `gateway/src/user-auth/auth-secret.test.ts`

- [ ] **Step 1: Write failing tests**

Create `gateway/src/user-auth/auth-secret.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrCreateAuthSecret } from "./auth-secret.js";

describe("loadOrCreateAuthSecret", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-secret-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
    delete process.env.SENTIENT_AUTH_SECRET_KEY_BASE64;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.SENTIENT_GATEWAY_ROOT;
    delete process.env.SENTIENT_AUTH_SECRET_KEY_BASE64;
  });

  it("generates a new 32-byte key when none exists", async () => {
    const key = await loadOrCreateAuthSecret();
    expect(key.length).toBe(32);
    expect(existsSync(join(root, "auth-secret.key"))).toBe(true);
  });

  it("the persisted key file is chmod 0600", async () => {
    await loadOrCreateAuthSecret();
    const mode = statSync(join(root, "auth-secret.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns the same key across calls", async () => {
    const a = await loadOrCreateAuthSecret();
    const b = await loadOrCreateAuthSecret();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("honors SENTIENT_AUTH_SECRET_KEY_BASE64 env override", async () => {
    const override = Buffer.alloc(32, 0xab);
    process.env.SENTIENT_AUTH_SECRET_KEY_BASE64 = override.toString("base64");
    const key = await loadOrCreateAuthSecret();
    expect(Buffer.from(key).equals(override)).toBe(true);
    // Env override should NOT create the on-disk file.
    expect(existsSync(join(root, "auth-secret.key"))).toBe(false);
  });

  it("rejects a base64 env key that isn't 32 bytes", async () => {
    process.env.SENTIENT_AUTH_SECRET_KEY_BASE64 = Buffer.alloc(16).toString("base64");
    await expect(loadOrCreateAuthSecret()).rejects.toThrow(/32 bytes/);
  });

  it("rejects a malformed base64 env value", async () => {
    process.env.SENTIENT_AUTH_SECRET_KEY_BASE64 = "not-valid-base64-at-all!!!!";
    await expect(loadOrCreateAuthSecret()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/auth-secret
```

Expected: import error.

- [ ] **Step 3: Implement**

Create `gateway/src/user-auth/auth-secret.ts`:

```typescript
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "./atomic-write.js";
import { getAuthSecretPath } from "./paths.js";

const log = getLog(["sentient", "gateway", "user-auth", "auth-secret"]);

const SECRET_KEY_BYTES = 32;
const ENV_OVERRIDE = "SENTIENT_AUTH_SECRET_KEY_BASE64";

function decodeBase64Strict(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  // Buffer.from is lenient — re-encode and compare to detect malformed input.
  if (buf.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
    throw new Error(`${ENV_OVERRIDE}: not valid base64`);
  }
  return new Uint8Array(buf);
}

/**
 * Load the PASETO v4.local symmetric key.
 * Order of precedence:
 *   1. SENTIENT_AUTH_SECRET_KEY_BASE64 env var (32-byte base64).
 *   2. ~/.sentient/gateway/auth-secret.key (chmod 0600).
 *   3. Generate new 32 random bytes and persist at (2).
 */
export async function loadOrCreateAuthSecret(): Promise<Uint8Array> {
  const envValue = process.env[ENV_OVERRIDE];
  if (envValue !== undefined && envValue.length > 0) {
    const decoded = decodeBase64Strict(envValue);
    if (decoded.length !== SECRET_KEY_BYTES) {
      throw new Error(`${ENV_OVERRIDE}: expected ${SECRET_KEY_BYTES} bytes, got ${decoded.length}`);
    }
    log.info("load.env-override");
    return decoded;
  }

  const path = getAuthSecretPath();
  try {
    const raw = await fs.readFile(path);
    if (raw.length !== SECRET_KEY_BYTES) {
      throw new Error(`${path}: expected ${SECRET_KEY_BYTES} bytes, got ${raw.length}`);
    }
    log.info("load.from-disk", { path });
    return new Uint8Array(raw);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  }

  const fresh = new Uint8Array(randomBytes(SECRET_KEY_BYTES));
  await writeFileAtomic(path, fresh, { mode: 0o600 });
  log.info("generate.persisted", { path });
  return fresh;
}
```

- [ ] **Step 4: Run — expect pass**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/auth-secret
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/user-auth/auth-secret.ts gateway/src/user-auth/auth-secret.test.ts
git commit -m "feat(user-auth): load-or-generate 32-byte PASETO secret key"
```

---

## Task 0.8: Token service (PASETO v4.local)

**Files:**
- Create: `gateway/src/user-auth/token-service.ts`
- Create: `gateway/src/user-auth/token-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `gateway/src/user-auth/token-service.test.ts`:

```typescript
import { describe, expect, it, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createTokenService } from "./token-service.js";

describe("createTokenService", () => {
  const secret = new Uint8Array(randomBytes(32));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
  });

  it("issues a token and round-trips the payload", async () => {
    const svc = createTokenService({ secret, ttl_seconds: 3600 });
    const token = await svc.issue({ userId: "kevin", isAdmin: true });
    const r = await svc.validate(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.userId).toBe("kevin");
      expect(r.value.isAdmin).toBe(true);
    }
  });

  it("embeds issuedAt and expiresAt", async () => {
    const svc = createTokenService({ secret, ttl_seconds: 60 });
    const token = await svc.issue({ userId: "a", isAdmin: false });
    const r = await svc.validate(token);
    if (!r.ok) throw new Error("expected ok");
    const now = Math.floor(Date.now() / 1000);
    expect(r.value.issuedAt).toBe(now);
    expect(r.value.expiresAt).toBe(now + 60);
  });

  it("rejects an expired token", async () => {
    const svc = createTokenService({ secret, ttl_seconds: 10 });
    const token = await svc.issue({ userId: "a", isAdmin: false });
    vi.advanceTimersByTime(15_000);
    const r = await svc.validate(token);
    expect(r).toEqual({ ok: false, error: "expired" });
  });

  it("rejects a token signed with a different secret", async () => {
    const svc1 = createTokenService({ secret, ttl_seconds: 60 });
    const svc2 = createTokenService({ secret: new Uint8Array(randomBytes(32)), ttl_seconds: 60 });
    const token = await svc1.issue({ userId: "a", isAdmin: false });
    const r = await svc2.validate(token);
    expect(r).toEqual({ ok: false, error: "signature-invalid" });
  });

  it("rejects a malformed token string", async () => {
    const svc = createTokenService({ secret, ttl_seconds: 60 });
    const r = await svc.validate("not-a-token");
    expect(r).toEqual({ ok: false, error: "malformed" });
  });

  it("refresh extends the expiry without changing userId", async () => {
    const svc = createTokenService({ secret, ttl_seconds: 60 });
    const first = await svc.issue({ userId: "a", isAdmin: true });
    vi.advanceTimersByTime(30_000);
    const refreshed = await svc.refresh(first);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    const parsed = await svc.validate(refreshed.value);
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.value.userId).toBe("a");
    // New expiresAt should be > original (fresh TTL from "now").
    const now = Math.floor(Date.now() / 1000);
    expect(parsed.value.expiresAt).toBe(now + 60);
  });

  it("refresh refuses to extend an already-expired token", async () => {
    const svc = createTokenService({ secret, ttl_seconds: 10 });
    const token = await svc.issue({ userId: "a", isAdmin: false });
    vi.advanceTimersByTime(15_000);
    const r = await svc.refresh(token);
    expect(r).toEqual({ ok: false, error: "expired" });
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/token-service
```

Expected: import error.

- [ ] **Step 3: Implement**

Create `gateway/src/user-auth/token-service.ts`:

```typescript
import { V4 } from "paseto-ts";
import { getLog } from "../logging/logger.js";
import type { TokenPayload, TokenResult } from "./types.js";

const log = getLog(["sentient", "gateway", "user-auth", "token-service"]);

export interface TokenServiceOptions {
  secret: Uint8Array; // 32 bytes
  ttl_seconds: number;
}

export interface TokenService {
  issue(subject: { userId: string; isAdmin: boolean }): Promise<string>;
  validate(token: string): Promise<TokenResult<TokenPayload>>;
  refresh(token: string): Promise<TokenResult<string>>;
}

const PURPOSE = "sentient.user-session.v1";

interface PasetoClaims {
  sub: string;
  isAdmin: boolean;
  purpose: string;
  iat: string; // ISO
  exp: string; // ISO
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createTokenService(opts: TokenServiceOptions): TokenService {
  if (opts.secret.length !== 32) {
    throw new Error(`token-service: secret MUST be 32 bytes, got ${opts.secret.length}`);
  }
  // paseto-ts expects the k4.local key as a base64url string with a "k4.local." prefix.
  // Construct it from the raw 32-byte secret.
  const keyRaw = Buffer.from(opts.secret).toString("base64url");
  const localKey = `k4.local.${keyRaw}`;

  return {
    async issue(subject) {
      const iat = nowSeconds();
      const exp = iat + opts.ttl_seconds;
      const claims: PasetoClaims = {
        sub: subject.userId,
        isAdmin: subject.isAdmin,
        purpose: PURPOSE,
        iat: new Date(iat * 1000).toISOString(),
        exp: new Date(exp * 1000).toISOString(),
      };
      const token = V4.encrypt(claims, localKey);
      log.debug("issue", { userId: subject.userId, isAdmin: subject.isAdmin, exp });
      return token;
    },

    async validate(token) {
      let claims: PasetoClaims;
      try {
        const decoded = V4.decrypt<PasetoClaims>(token, localKey);
        claims = decoded.payload;
      } catch (e: unknown) {
        const msg = (e as Error).message.toLowerCase();
        if (msg.includes("invalid") && msg.includes("format")) {
          log.debug("validate.malformed");
          return { ok: false, error: "malformed" };
        }
        log.debug("validate.signature-invalid", { reason: (e as Error).message });
        return { ok: false, error: "signature-invalid" };
      }
      if (claims.purpose !== PURPOSE) {
        log.warn("validate.wrong-purpose", { got: claims.purpose });
        return { ok: false, error: "wrong-purpose" };
      }
      const iat = Math.floor(new Date(claims.iat).getTime() / 1000);
      const exp = Math.floor(new Date(claims.exp).getTime() / 1000);
      if (nowSeconds() >= exp) {
        log.debug("validate.expired", { exp, userId: claims.sub });
        return { ok: false, error: "expired" };
      }
      return {
        ok: true,
        value: {
          userId: claims.sub,
          isAdmin: claims.isAdmin,
          issuedAt: iat,
          expiresAt: exp,
        },
      };
    },

    async refresh(token) {
      const r = await this.validate(token);
      if (!r.ok) return r;
      const fresh = await this.issue({ userId: r.value.userId, isAdmin: r.value.isAdmin });
      return { ok: true, value: fresh };
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/token-service
```

Expected: 7 tests pass. If `malformed` vs `signature-invalid` classification doesn't match (paseto-ts error messages vary by version), adjust the `validate` error classifier to match observed output — prefer broad catch with specific sub-string match; log once, tune.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/user-auth/token-service.ts gateway/src/user-auth/token-service.test.ts
git commit -m "feat(user-auth): PASETO v4.local token service (issue + validate + refresh)"
```

---

## Task 0.9: Integration verification

Wire everything together in a single smoke test that proves the primitives compose.

**Files:**
- Create: `gateway/src/user-auth/integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `gateway/src/user-auth/integration.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUserStore } from "./user-store.js";
import { hashPin, verifyPin } from "./pin-service.js";
import { loadOrCreateAuthSecret } from "./auth-secret.js";
import { createTokenService } from "./token-service.js";
import type { UserRecord } from "./types.js";

describe("phase-0 primitives compose end-to-end", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-p0-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("create user → login with correct PIN → issue token → validate token", async () => {
    const store = createUserStore();
    const secret = await loadOrCreateAuthSecret();
    const tokens = createTokenService({ secret, ttl_seconds: 3600 });

    // 1. Create user (simulates admin-add-user)
    const pinHash = await hashPin("1234", { memoryKb: 8192, iterations: 1, parallelism: 1 });
    const kevin: UserRecord = {
      userId: "kevin",
      displayName: "Kevin",
      pinHash: pinHash,
      isAdmin: true,
      avatarTint: "terra",
      createdAt: new Date().toISOString(),
    };
    const add = await store.add(kevin);
    expect(add.ok).toBe(true);

    // 2. Login: look up user, verify PIN, issue token
    const fetched = await store.get("kevin");
    expect(fetched.ok && fetched.value).not.toBeNull();
    if (!fetched.ok || !fetched.value) throw new Error("unreachable");
    const pinOk = await verifyPin("1234", fetched.value.pinHash);
    expect(pinOk).toBe(true);
    const token = await tokens.issue({
      userId: fetched.value.userId,
      isAdmin: fetched.value.isAdmin,
    });

    // 3. Validate token on subsequent request
    const valid = await tokens.validate(token);
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error("unreachable");
    expect(valid.value.userId).toBe("kevin");
    expect(valid.value.isAdmin).toBe(true);
  });

  it("login with wrong PIN does not issue a token", async () => {
    const store = createUserStore();
    const pinHash = await hashPin("1234", { memoryKb: 8192, iterations: 1, parallelism: 1 });
    await store.add({
      userId: "kevin",
      displayName: "Kevin",
      pinHash: pinHash,
      isAdmin: true,
      avatarTint: "terra",
      createdAt: "2026-04-24T00:00:00.000Z",
    });
    const got = await store.get("kevin");
    if (!got.ok || !got.value) throw new Error("unreachable");
    const ok = await verifyPin("9999", got.value.pinHash);
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth/integration
```

Expected: 2 tests pass.

- [ ] **Step 3: Full test sweep**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test -- user-auth
```

Expected: all user-auth tests pass; no unrelated failures.

- [ ] **Step 4: Typecheck + lint the whole gateway**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' typecheck && bun run --filter '@sentient/gateway' lint
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/user-auth/integration.test.ts
git commit -m "test(user-auth): integration smoke — create user → login → token"
```

---

## Task 0.10: Phase-0 acceptance run

Full CI-style sweep to close out the phase.

- [ ] **Step 1: Run full gateway test suite**

```bash
source scripts/env.sh && bun run --filter '@sentient/gateway' test
```

Expected: all tests pass, no regressions.

- [ ] **Step 2: Run full repo CI**

```bash
source scripts/env.sh && bun run ci
```

Expected: lint + typecheck + test all pass.

- [ ] **Step 3: Verify docker containers aren't holding ports (per user's stored feedback)**

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '(gateway|hermes)' || echo "no conflicting containers"
```

If any `sentient-*` containers are running and bind 8888 (gateway) or similar, stop them before the tests ran — rerun step 1.

- [ ] **Step 4: Commit any follow-up fixes, then tag phase-0 complete**

```bash
git log --oneline -n 20 | head
```

Expected to see (in reverse chronological order):
- `test(user-auth): integration smoke...`
- `feat(user-auth): PASETO v4.local token service...`
- `feat(user-auth): load-or-generate 32-byte PASETO secret key`
- `feat(user-auth): PIN service with Bun argon2id...`
- `feat(user-auth): user-store CRUD...`
- `feat(user-auth): atomic file write helper...`
- `feat(config): add auth, apply, providers config sections`
- `feat(user-auth): gateway path resolution...`
- `feat(user-auth): add paseto-ts dep and user-auth type surface`

Nine task commits in total for Phase 0.

---

## Phase-0 Exit Criteria

- [ ] All tests under `gateway/src/user-auth/**` pass (51+ tests).
- [ ] `bun run ci` green on the branch.
- [ ] `~/.sentient/gateway/auth-secret.key` generated on a fresh boot (0600), not world-readable.
- [ ] `~/.sentient/gateway/users.json` round-trips non-ASCII display names.
- [ ] `gateway/config.yaml` validates against new schema; existing sections unchanged.
- [ ] No changes to `gateway/src/session-router.ts`, `gateway/src/session-handlers/**`, or webui.

## What Phase 1 Will Build On

- `createUserStore()` → backing for `GET /api/auth/users`, `POST /api/admin/users`, etc.
- `hashPin`, `verifyPin` → backing for login flow and create-user flow.
- `loadOrCreateAuthSecret`, `createTokenService` → backing for `/api/auth/login`, `/api/auth/me`, and WS auth gate.
- `getUserProfileDir`, `getArchiveDir` → backing for profile renderer (Phase 2) and soft-delete (Phase 7).
- `auth.*`, `apply.*`, `providers.*` config sections → injected wherever Phase 1+ code needs tunables.

---

## Self-Review Notes

- **Spec coverage:** this phase covers spec §4.1 (PIN argon2id), §4.3 partial (token issuance), §10 (config additions), and §3.1 partial (canonical store for `users.json`). Remaining spec sections are wired in subsequent phases per the overview dependency graph.
- **No placeholders:** every step contains complete code or exact commands.
- **Type consistency:** `UserRecord`, `TokenPayload`, `Argon2Params`, and `StoreResult<T>` / `TokenResult<T>` share identical shapes across all tasks.
- **Size budget:** every new source file is ≤130 lines; no file approaches the 300-line limit.
