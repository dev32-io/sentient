# Multi-User Phase 1+2 — Auth Endpoints + Profile Store/Renderer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Phase 0 (`docs/superpowers/plans/2026-04-24-multi-user-phase0-foundation.md`) MUST be complete and merged before starting.

**Goal:** Stand up the gateway's user-auth surface (REST + WS) and the canonical per-user profile store + renderer. After this phase the gateway can authenticate users, isolate per-user state, save changes to per-user `profile.json`, and render Hermes-compatible artifacts (`config.yaml`, `SOUL.md`) — but the apply-restart loop (Phase 3) is still missing, so changes don't take effect on a running container yet.

**Architecture:** `gateway/src/user-auth/` (Phase 0) is composed into a thin `auth-service.ts` factory that the new HTTP `/api/v1/auth/*` handlers use. WS handler gains a one-shot auth-message gate. PersonSession + ClientData get a `userId` field bound from the validated token. `gateway/src/profile-store/` is a new module owning `profile.json` CRUD, default seeding, shared-template loading, and the pure-function renderer. `identify_user` MCP tool gains a `channel === "satellite"` gate.

**Tech stack:** Bun, Zod, paseto-ts (Phase 0), Vitest (run via `bun test`).

**Spec:** `docs/superpowers/specs/2026-04-24-multi-user-auth-and-settings-design.md`, §3.1, §4.2-§4.5, §6.5.
**Overview:** `docs/superpowers/plans/2026-04-24-multi-user-overview.md`.

---

## Hard Rules (every implementer subagent must obey)

- **Never use `--no-verify`** on commit. If a pre-commit hook flags issues in YOUR new files, fix with `bunx biome check --write <files>` and re-commit. If it flags anything outside your task's file list, STOP and report `BLOCKED` — do NOT modify other files or `lefthook.yml` to make it pass.
- **Never edit `lefthook.yml`, `package.json` (dep additions), `docker-compose.yml`, or any CI/scripts** unless the task explicitly says so. Touch ONLY the files listed in the task's `Files:` section.
- **Tests use `bun test` runtime, not vitest CLI.** `vi.useFakeTimers()` works; `vi.setSystemTime` does NOT — use `vi.advanceTimersByTime` instead, or accept real time and write tests that don't depend on absolute clock values.
- **Field names in TypeScript types are camelCase.** Field names in YAML/Hermes config keys are snake_case. The renderer translates between them.
- **`UserRecord`, `Argon2Params`, `TokenPayload`, `StoreResult<T>`, `TokenResult<T>` are already defined** in `gateway/src/user-auth/types.ts` — import from there, never redefine.
- **Functions ≤ 40 lines. Files ≤ 300 lines.** If you find yourself approaching either, split.
- Source env before any Bun command: `source /Users/kevinye/Development/sentient/scripts/env.sh`.
- Branch is `feature/multi-user-auth-and-settings`. Do not switch branches.
- After every task: `bun test src/<your-new-area>/` must pass clean before commit.

---

## File Structure

**New (this phase):**

| Path | Purpose |
|---|---|
| `gateway/src/user-auth/auth-service.ts` | Factory composing user-store + pin + token services for handler injection |
| `gateway/src/user-auth/auth-service.test.ts` | |
| `gateway/src/api/handlers/auth.ts` | All `/api/v1/auth/*` handlers (setup, users, login, me, logout) |
| `gateway/src/api/handlers/auth.test.ts` | |
| `gateway/src/profile-store/profile-types.ts` | `ProfileV1` zod schema + types |
| `gateway/src/profile-store/profile-types.test.ts` | |
| `gateway/src/profile-store/profile-store.ts` | CRUD over `<root>/<userId>/profile.json` |
| `gateway/src/profile-store/profile-store.test.ts` | |
| `gateway/src/profile-store/profile-defaults.ts` | Build a default `ProfileV1` for new users |
| `gateway/src/profile-store/profile-defaults.test.ts` | |
| `gateway/src/profile-store/template-loader.ts` | Read `<root>/shared/templates/*.md` with caching |
| `gateway/src/profile-store/template-loader.test.ts` | |
| `gateway/src/profile-store/profile-renderer.ts` | Pure function `renderProfile(profile, templates)` returning `{hermesConfigYaml, soulMarkdown}` + a `writeRendered(userId, rendered)` side-effect helper |
| `gateway/src/profile-store/profile-renderer.test.ts` | |
| `gateway/src/session-handlers/ws-auth-gate.ts` | Auth-message handler + timeout helper |
| `gateway/src/session-handlers/ws-auth-gate.test.ts` | |

**Modified:**

| Path | Change |
|---|---|
| `gateway/src/api/router.ts` | Dispatch `/api/v1/auth/*` to new auth handler |
| `gateway/src/session-handlers/ws-helpers.ts` | Add `userId: string \| null` to `ClientData` |
| `gateway/src/session-handlers/ws-handlers.ts` | One-shot `{type:"auth", token}` gate before any other message; close on timeout/invalid token; populate `ws.data.userId` on success |
| `gateway/src/person-session/person-session.ts` | Add `userId: string \| null` field + getter |
| `gateway/src/person-session/person-session-registry.ts` | Thread `userId` through `getOrCreate` |
| `gateway/src/mcp-host/tools/identify-user.ts` | Add `ctx.channel === "satellite"` guard before existing user-id check |
| `gateway/src/server.ts` | Construct `authService` at boot; pass to router + WS services |

**Out of scope (Phase 3+):**
- Apply-restart FSM, Hermes session-end RPC, docker stop/start, container provisioning.
- Generating gateway-side `hermes.profiles[userId]` map dynamically (still hand-listed in `gateway/config.yaml` after this phase).
- Webui changes.
- Token revocation list (per spec §4.1 noted but deferred — logout = client-side localStorage clear for now; document in a code comment).

---

# Phase 1 — Auth Endpoints + WS Gate

## Task 1.1: auth-service factory

A thin composition layer that bundles `userStore + tokenService + pinService + authConfig` for handler injection. Keeps handlers from constructing primitives themselves.

**Files:**
- Create: `gateway/src/user-auth/auth-service.ts`
- Create: `gateway/src/user-auth/auth-service.test.ts`

- [ ] **Step 1: Write failing test**

Create `gateway/src/user-auth/auth-service.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthConfig } from "@sentient/config";
import { createAuthService } from "./auth-service.js";

const AUTH_CONFIG: AuthConfig = {
  token_ttl_seconds: 3600,
  ws_auth_timeout_ms: 5000,
  argon2_memory_kb: 8192,
  argon2_iterations: 1,
  argon2_parallelism: 1,
};

describe("createAuthService", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-authsvc-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("createUser stores the user with hashed pin", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    const r = await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    expect(r.ok).toBe(true);
    const got = await svc.users.get("kevin");
    expect(got.ok).toBe(true);
    if (!got.ok || !got.value) throw new Error("unreachable");
    expect(got.value.pinHash).toMatch(/^\$argon2id\$/);
    expect(got.value.pinHash).not.toBe("1234");
  });

  it("authenticate with correct pin issues a valid token", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: false,
      avatarTint: "sage",
    });
    const r = await svc.authenticate("kevin", "1234");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const valid = await svc.tokens.validate(r.value.token);
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error("unreachable");
    expect(valid.value.userId).toBe("kevin");
    expect(valid.value.isAdmin).toBe(false);
  });

  it("authenticate with wrong pin returns invalid-credentials", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await svc.authenticate("kevin", "9999");
    expect(r).toEqual({ ok: false, error: "invalid-credentials" });
  });

  it("authenticate with unknown user returns invalid-credentials", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    const r = await svc.authenticate("ghost", "1234");
    expect(r).toEqual({ ok: false, error: "invalid-credentials" });
  });

  it("createUser rejects duplicate userId", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    const a: Parameters<typeof svc.createUser>[0] = {
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    };
    await svc.createUser(a);
    const r = await svc.createUser(a);
    expect(r).toEqual({ ok: false, error: "already-exists" });
  });

  it("listUsersPublic returns userId/displayName/avatarTint without pinHash", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await svc.listUsersPublic();
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value).toEqual([
      { userId: "kevin", displayName: "Kevin", avatarTint: "terra" },
    ]);
    for (const u of r.value as Array<Record<string, unknown>>) {
      expect("pinHash" in u).toBe(false);
      expect("isAdmin" in u).toBe(false);
    }
  });

  it("isFirstRun is true when users.json is empty, false after createUser", async () => {
    const svc = await createAuthService(AUTH_CONFIG);
    expect(await svc.isFirstRun()).toBe(true);
    await svc.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    expect(await svc.isFirstRun()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect import error**

```bash
bun test src/user-auth/auth-service.test.ts
```

- [ ] **Step 3: Implement**

Create `gateway/src/user-auth/auth-service.ts`:

```typescript
import type { AuthConfig } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { loadOrCreateAuthSecret } from "./auth-secret.js";
import { hashPin, verifyPin } from "./pin-service.js";
import { createTokenService, type TokenService } from "./token-service.js";
import type { AvatarTint, StoreResult, UserRecord } from "./types.js";
import { createUserStore, type UserStore } from "./user-store.js";

const log = getLog(["sentient", "gateway", "user-auth", "auth-service"]);

export interface CreateUserInput {
  userId: string;
  displayName: string;
  pin: string;
  isAdmin: boolean;
  avatarTint: AvatarTint;
}

export type CreateUserError = "already-exists" | "io-error";
export type AuthError = "invalid-credentials";

export interface PublicUser {
  userId: string;
  displayName: string;
  avatarTint: AvatarTint;
}

export interface AuthService {
  users: UserStore;
  tokens: TokenService;
  config: AuthConfig;
  createUser(input: CreateUserInput): Promise<Result<UserRecord, CreateUserError>>;
  authenticate(userId: string, pin: string): Promise<Result<{ token: string; user: UserRecord }, AuthError>>;
  listUsersPublic(): Promise<StoreResult<PublicUser[]>>;
  isFirstRun(): Promise<boolean>;
}

export async function createAuthService(authConfig: AuthConfig): Promise<AuthService> {
  const secret = await loadOrCreateAuthSecret();
  const tokens = createTokenService({ secret, ttlSeconds: authConfig.token_ttl_seconds });
  const users = createUserStore();

  const argon2Params = {
    memoryKb: authConfig.argon2_memory_kb,
    iterations: authConfig.argon2_iterations,
    parallelism: authConfig.argon2_parallelism,
  };

  return {
    users,
    tokens,
    config: authConfig,

    async createUser(input) {
      const pinHash = await hashPin(input.pin, argon2Params);
      const rec: UserRecord = {
        userId: input.userId,
        displayName: input.displayName,
        pinHash,
        isAdmin: input.isAdmin,
        avatarTint: input.avatarTint,
        createdAt: new Date().toISOString(),
      };
      const r = await users.add(rec);
      if (!r.ok) {
        if (r.error === "already-exists") return { ok: false, error: "already-exists" };
        return { ok: false, error: "io-error" };
      }
      log.info("createUser", { userId: rec.userId, isAdmin: rec.isAdmin });
      return { ok: true, value: rec };
    },

    async authenticate(userId, pin) {
      const r = await users.get(userId);
      if (!r.ok || r.value === null) {
        log.debug("authenticate.no-user", { userId });
        return { ok: false, error: "invalid-credentials" };
      }
      const ok = await verifyPin(pin, r.value.pinHash);
      if (!ok) {
        log.debug("authenticate.wrong-pin", { userId });
        return { ok: false, error: "invalid-credentials" };
      }
      const token = await tokens.issue({ userId: r.value.userId, isAdmin: r.value.isAdmin });
      log.info("authenticate.ok", { userId: r.value.userId });
      return { ok: true, value: { token, user: r.value } };
    },

    async listUsersPublic() {
      const r = await users.list();
      if (!r.ok) return r;
      return {
        ok: true,
        value: r.value.map((u) => ({
          userId: u.userId,
          displayName: u.displayName,
          avatarTint: u.avatarTint,
        })),
      };
    },

    async isFirstRun() {
      const r = await users.list();
      return r.ok && r.value.length === 0;
    },
  };
}
```

- [ ] **Step 4: Run, expect 7 tests pass**

```bash
bun test src/user-auth/auth-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add gateway/src/user-auth/auth-service.ts gateway/src/user-auth/auth-service.test.ts
git commit -m "feat(user-auth): auth-service factory composing store + tokens + pin"
```

---

## Task 1.2: HTTP handler — POST /api/v1/auth/setup (first-run admin)

**Files:**
- Create: `gateway/src/api/handlers/auth.ts` (initial — setup endpoint only; later tasks extend it)
- Create: `gateway/src/api/handlers/auth.test.ts` (initial)

- [ ] **Step 1: Write failing test**

Create `gateway/src/api/handlers/auth.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthConfig } from "@sentient/config";
import { createAuthService } from "../../user-auth/auth-service.js";
import { createAuthHandler } from "./auth.js";

const AUTH_CONFIG: AuthConfig = {
  token_ttl_seconds: 3600,
  ws_auth_timeout_ms: 5000,
  argon2_memory_kb: 8192,
  argon2_iterations: 1,
  argon2_parallelism: 1,
};

function url(path: string): string {
  return `http://localhost${path}`;
}

describe("auth handler — POST /api/v1/auth/setup", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-authh-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("creates the first admin and returns a token", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    const res = await handler(
      new Request(url("/api/v1/auth/setup"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "kevin",
          displayName: "Kevin",
          pin: "1234",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { userId: string; isAdmin: boolean } };
    expect(body.user).toEqual({ userId: "kevin", displayName: "Kevin", isAdmin: true, avatarTint: "terra" });
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
  });

  it("returns 409 when called a second time", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    const body = JSON.stringify({ userId: "kevin", displayName: "Kevin", pin: "1234" });
    const headers = { "content-type": "application/json" };
    await handler(new Request(url("/api/v1/auth/setup"), { method: "POST", headers, body }));
    const res = await handler(new Request(url("/api/v1/auth/setup"), { method: "POST", headers, body }));
    expect(res.status).toBe(409);
  });

  it("returns 400 on missing required fields", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    const res = await handler(
      new Request(url("/api/v1/auth/setup"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "kevin" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on PIN that is not 4 digits", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    const res = await handler(
      new Request(url("/api/v1/auth/setup"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "kevin", displayName: "Kevin", pin: "abc" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 405 for non-POST methods", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    const res = await handler(new Request(url("/api/v1/auth/setup"), { method: "GET" }));
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test src/api/handlers/auth.test.ts
```

- [ ] **Step 3: Implement**

Create `gateway/src/api/handlers/auth.ts`:

```typescript
import { z } from "zod";
import { getLog } from "../../logging/logger.js";
import type { AuthService } from "../../user-auth/auth-service.js";

const log = getLog(["sentient", "gateway", "api", "auth"]);

const HTTP_OK = 200;
const HTTP_BAD = 400;
const HTTP_METHOD = 405;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL = 500;
const HTTP_NOT_FOUND = 404;

export interface AuthHandlerDeps {
  auth: AuthService;
}

const setupSchema = z.object({
  userId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  displayName: z.string().min(1).max(64),
  pin: z.string().regex(/^\d{4}$/),
});

export function createAuthHandler(deps: AuthHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/v1/auth/setup") return handleSetup(deps, request);
    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}

async function handleSetup(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(HTTP_BAD, "invalid-json");
  }
  const parsed = setupSchema.safeParse(body);
  if (!parsed.success) {
    log.debug("setup.bad-input", { reason: parsed.error.message });
    return jsonError(HTTP_BAD, "validation-error");
  }

  if (!(await deps.auth.isFirstRun())) {
    return jsonError(HTTP_CONFLICT, "setup-already-completed");
  }

  const r = await deps.auth.createUser({
    userId: parsed.data.userId,
    displayName: parsed.data.displayName,
    pin: parsed.data.pin,
    isAdmin: true,
    avatarTint: "terra",
  });
  if (!r.ok) {
    if (r.error === "already-exists") return jsonError(HTTP_CONFLICT, "user-exists");
    log.warn("setup.io-error");
    return jsonError(HTTP_INTERNAL, "io-error");
  }

  const auth = await deps.auth.authenticate(parsed.data.userId, parsed.data.pin);
  if (!auth.ok) {
    log.warn("setup.auth-after-create-failed", { reason: auth.error });
    return jsonError(HTTP_INTERNAL, "auth-after-create-failed");
  }

  log.info("setup.first-admin-created", { userId: parsed.data.userId });
  return Response.json(
    {
      token: auth.value.token,
      user: {
        userId: auth.value.user.userId,
        displayName: auth.value.user.displayName,
        isAdmin: auth.value.user.isAdmin,
        avatarTint: auth.value.user.avatarTint,
      },
    },
    { status: HTTP_OK },
  );
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}
```

- [ ] **Step 4: Run, expect 5 tests pass**

```bash
bun test src/api/handlers/auth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add gateway/src/api/handlers/auth.ts gateway/src/api/handlers/auth.test.ts
git commit -m "feat(api): POST /api/v1/auth/setup creates first admin"
```

---

## Task 1.3: HTTP handler — GET /api/v1/auth/users (public list)

Extends the same `auth.ts` file. Returns only userId/displayName/avatarTint — never pinHash or isAdmin.

**Files:**
- Modify: `gateway/src/api/handlers/auth.ts`
- Modify: `gateway/src/api/handlers/auth.test.ts`

- [ ] **Step 1: Append failing test**

Append to `gateway/src/api/handlers/auth.test.ts` (inside file, new `describe` block at end):

```typescript
describe("auth handler — GET /api/v1/auth/users", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-authl-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("returns empty array when no users exist", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    const res = await handler(new Request(url("/api/v1/auth/users")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns public user fields only", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    await auth.createUser({
      userId: "wife",
      displayName: "Wife",
      pin: "5678",
      isAdmin: false,
      avatarTint: "sage",
    });
    const handler = createAuthHandler({ auth });
    const res = await handler(new Request(url("/api/v1/auth/users")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    for (const u of body) {
      expect(Object.keys(u).sort()).toEqual(["avatarTint", "displayName", "userId"]);
    }
  });

  it("returns 405 for non-GET methods", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    const res = await handler(new Request(url("/api/v1/auth/users"), { method: "POST" }));
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test src/api/handlers/auth.test.ts
```

- [ ] **Step 3: Extend handler**

Modify `gateway/src/api/handlers/auth.ts`. Add the route in the dispatcher and the function:

```typescript
// In the createAuthHandler return body, add BEFORE the Not Found return:
if (path === "/api/v1/auth/users") return handleListUsers(deps, request);
```

Append to bottom of file:

```typescript
async function handleListUsers(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const r = await deps.auth.listUsersPublic();
  if (!r.ok) {
    log.warn("listUsers.io-error", { reason: r.error });
    return jsonError(HTTP_INTERNAL, "io-error");
  }
  return Response.json(r.value, { status: HTTP_OK });
}
```

- [ ] **Step 4: Run, expect pass**

- [ ] **Step 5: Commit**

```bash
git add gateway/src/api/handlers/auth.ts gateway/src/api/handlers/auth.test.ts
git commit -m "feat(api): GET /api/v1/auth/users public listing (no secrets)"
```

---

## Task 1.4: HTTP handler — POST /api/v1/auth/login

**Files:**
- Modify: `gateway/src/api/handlers/auth.ts`
- Modify: `gateway/src/api/handlers/auth.test.ts`

- [ ] **Step 1: Append test**

Append to `gateway/src/api/handlers/auth.test.ts`:

```typescript
describe("auth handler — POST /api/v1/auth/login", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-authli-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  async function seed(auth: Awaited<ReturnType<typeof createAuthService>>): Promise<void> {
    await auth.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
  }

  it("issues a token on correct credentials", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    await seed(auth);
    const res = await handler(
      new Request(url("/api/v1/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "kevin", pin: "1234" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { userId: string; isAdmin: boolean } };
    expect(body.user).toEqual({ userId: "kevin", displayName: "Kevin", isAdmin: true, avatarTint: "terra" });
    expect(typeof body.token).toBe("string");
  });

  it("returns 401 on wrong pin", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    await seed(auth);
    const res = await handler(
      new Request(url("/api/v1/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "kevin", pin: "9999" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 on unknown user (no enumeration)", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    const res = await handler(
      new Request(url("/api/v1/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "ghost", pin: "1234" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing fields", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const handler = createAuthHandler({ auth });
    const res = await handler(
      new Request(url("/api/v1/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "kevin" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Extend handler**

In `gateway/src/api/handlers/auth.ts`, add constant:

```typescript
const HTTP_UNAUTHORIZED = 401;
```

Add schema near `setupSchema`:

```typescript
const loginSchema = z.object({
  userId: z.string().min(1).max(64),
  pin: z.string().min(1).max(16),
});
```

Add route to the dispatcher:

```typescript
if (path === "/api/v1/auth/login") return handleLogin(deps, request);
```

Append function:

```typescript
async function handleLogin(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(HTTP_BAD, "invalid-json");
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return jsonError(HTTP_BAD, "validation-error");

  const r = await deps.auth.authenticate(parsed.data.userId, parsed.data.pin);
  if (!r.ok) {
    log.debug("login.rejected", { userId: parsed.data.userId, reason: r.error });
    return jsonError(HTTP_UNAUTHORIZED, "invalid-credentials");
  }
  return Response.json(
    {
      token: r.value.token,
      user: {
        userId: r.value.user.userId,
        displayName: r.value.user.displayName,
        isAdmin: r.value.user.isAdmin,
        avatarTint: r.value.user.avatarTint,
      },
    },
    { status: HTTP_OK },
  );
}
```

- [ ] **Step 4: Run, expect pass**

- [ ] **Step 5: Commit**

```bash
git add gateway/src/api/handlers/auth.ts gateway/src/api/handlers/auth.test.ts
git commit -m "feat(api): POST /api/v1/auth/login (PIN-based)"
```

---

## Task 1.5: HTTP handler — GET /api/v1/auth/me + POST /api/v1/auth/logout

`/me` validates the bearer token in `Authorization: Bearer <token>` and returns the user record (and a refreshed token, since spec §4.1 says rolling-refresh on each auth-check).

`/logout` is a no-op on the server in MVP (no revocation list, per scope notes). It exists as an endpoint so the client can call it during logout for symmetry and future revocation support.

**Files:**
- Modify: `gateway/src/api/handlers/auth.ts`
- Modify: `gateway/src/api/handlers/auth.test.ts`

- [ ] **Step 1: Append tests**

Append to `gateway/src/api/handlers/auth.test.ts`:

```typescript
describe("auth handler — GET /api/v1/auth/me + POST /api/v1/auth/logout", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-authm-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  async function loginAndGetToken(): Promise<{
    handler: ReturnType<typeof createAuthHandler>;
    token: string;
  }> {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const handler = createAuthHandler({ auth });
    const res = await handler(
      new Request(url("/api/v1/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "kevin", pin: "1234" }),
      }),
    );
    const body = (await res.json()) as { token: string };
    return { handler, token: body.token };
  }

  it("/me returns user when bearer token is valid + a refreshed token", async () => {
    const { handler, token } = await loginAndGetToken();
    const res = await handler(
      new Request(url("/api/v1/auth/me"), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { userId: string }; token: string };
    expect(body.user.userId).toBe("kevin");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
  });

  it("/me returns 401 when no Authorization header", async () => {
    const { handler } = await loginAndGetToken();
    const res = await handler(new Request(url("/api/v1/auth/me")));
    expect(res.status).toBe(401);
  });

  it("/me returns 401 on bad token", async () => {
    const { handler } = await loginAndGetToken();
    const res = await handler(
      new Request(url("/api/v1/auth/me"), {
        headers: { authorization: "Bearer not-a-token" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("/logout returns 200 unconditionally (server-side noop in MVP)", async () => {
    const { handler } = await loginAndGetToken();
    const res = await handler(new Request(url("/api/v1/auth/logout"), { method: "POST" }));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Extend handler**

Add routes to dispatcher:

```typescript
if (path === "/api/v1/auth/me") return handleMe(deps, request);
if (path === "/api/v1/auth/logout") return handleLogout(deps, request);
```

Append helpers + handlers:

```typescript
function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ?? null;
}

async function handleMe(deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  const token = readBearer(request);
  if (!token) return jsonError(HTTP_UNAUTHORIZED, "missing-token");
  const valid = await deps.auth.tokens.validate(token);
  if (!valid.ok) {
    log.debug("me.rejected", { reason: valid.error });
    return jsonError(HTTP_UNAUTHORIZED, valid.error);
  }
  const userR = await deps.auth.users.get(valid.value.userId);
  if (!userR.ok || !userR.value) {
    log.warn("me.user-vanished", { userId: valid.value.userId });
    return jsonError(HTTP_UNAUTHORIZED, "user-not-found");
  }
  const refreshed = await deps.auth.tokens.refresh(token);
  if (!refreshed.ok) return jsonError(HTTP_UNAUTHORIZED, refreshed.error);
  return Response.json(
    {
      token: refreshed.value,
      user: {
        userId: userR.value.userId,
        displayName: userR.value.displayName,
        isAdmin: userR.value.isAdmin,
        avatarTint: userR.value.avatarTint,
      },
    },
    { status: HTTP_OK },
  );
}

async function handleLogout(_deps: AuthHandlerDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: HTTP_METHOD });
  }
  // MVP: server-side logout is a noop. Token revocation deferred per spec scope.
  return Response.json({ ok: true }, { status: HTTP_OK });
}
```

- [ ] **Step 4: Run, expect pass**

- [ ] **Step 5: Commit**

```bash
git add gateway/src/api/handlers/auth.ts gateway/src/api/handlers/auth.test.ts
git commit -m "feat(api): GET /api/v1/auth/me + POST /api/v1/auth/logout"
```

---

## Task 1.6: Wire auth handler into router

The router currently dispatches to `handleAdmin`, `handleHealth`, `handleReady`, `handleWsUpgrade`, `handleStatic`. Add `handleAuth` before admin so admin-only routes still work.

**Files:**
- Modify: `gateway/src/api/router.ts`
- Modify: `gateway/src/api/router.test.ts` (or create if missing)
- Modify: `gateway/src/server.ts`

- [ ] **Step 1: Check router test file exists**

```bash
ls gateway/src/api/router.test.ts 2>/dev/null
```

If missing, create with the test below; if present, append the test.

- [ ] **Step 2: Write/append test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { createApiRouter } from "./router.js";

function noopUpgrade(): undefined {
  return undefined;
}

describe("createApiRouter — /api/v1/auth/* dispatch", () => {
  it("routes /api/v1/auth/users to handleAuth", async () => {
    const handleAuth = vi.fn(async () => Response.json({ from: "auth" }));
    const router = createApiRouter({
      handleHealth: vi.fn(),
      handleReady: vi.fn(),
      handleWsUpgrade: noopUpgrade,
      handleAdmin: vi.fn(async () => new Response("admin")),
      handleAuth,
      handleStatic: vi.fn(async () => null),
    });
    const res = await router(new Request("http://x/api/v1/auth/users"));
    expect(res?.status).toBe(200);
    expect(handleAuth).toHaveBeenCalledTimes(1);
  });

  it("routes /api/v1/auth/login to handleAuth", async () => {
    const handleAuth = vi.fn(async () => Response.json({ ok: true }));
    const router = createApiRouter({
      handleHealth: vi.fn(),
      handleReady: vi.fn(),
      handleWsUpgrade: noopUpgrade,
      handleAdmin: vi.fn(),
      handleAuth,
      handleStatic: vi.fn(async () => null),
    });
    await router(new Request("http://x/api/v1/auth/login", { method: "POST" }));
    expect(handleAuth).toHaveBeenCalledTimes(1);
  });

  it("does NOT route /api/v1/admin/* to handleAuth", async () => {
    const handleAuth = vi.fn();
    const handleAdmin = vi.fn(async () => new Response("admin"));
    const router = createApiRouter({
      handleHealth: vi.fn(),
      handleReady: vi.fn(),
      handleWsUpgrade: noopUpgrade,
      handleAdmin,
      handleAuth,
      handleStatic: vi.fn(async () => null),
    });
    await router(new Request("http://x/api/v1/admin/users"));
    expect(handleAuth).not.toHaveBeenCalled();
    expect(handleAdmin).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run, expect fail**

```bash
bun test src/api/router.test.ts
```

- [ ] **Step 4: Edit router**

Modify `gateway/src/api/router.ts`. Add `handleAuth` to `ApiRouterDeps` and wire dispatch:

```typescript
const HTTP_NOT_FOUND = 404;
const API_V1 = "/api/v1";

export interface ApiRouterDeps {
  handleHealth: (request: Request) => Promise<Response>;
  handleReady: (request: Request) => Promise<Response>;
  handleWsUpgrade: (request: Request) => Response | undefined;
  handleAdmin: (request: Request) => Promise<Response>;
  handleAuth: (request: Request) => Promise<Response>;
  handleStatic: (request: Request) => Promise<Response | null>;
}

export type ApiRouter = (request: Request) => Promise<Response | undefined>;

export function createApiRouter(deps: ApiRouterDeps): ApiRouter {
  return async (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname.startsWith(`${API_V1}/admin/`)) return deps.handleAdmin(request);
    if (pathname.startsWith(`${API_V1}/auth/`)) return deps.handleAuth(request);
    if (pathname === `${API_V1}/health`) return deps.handleHealth(request);
    if (pathname === `${API_V1}/ready`) return deps.handleReady(request);
    if (pathname === `${API_V1}/ws`) return deps.handleWsUpgrade(request);

    const staticResponse = await deps.handleStatic(request);
    if (staticResponse) return staticResponse;

    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}
```

- [ ] **Step 5: Wire bootstrap**

Find where `createApiRouter` is called (likely `gateway/src/server.ts` or a bootstrap file). Run:

```bash
grep -rn "createApiRouter" gateway/src/ --include='*.ts'
```

In each call site (typically one), add `handleAuth: createAuthHandler({ auth: authService }),` to the deps object. The `authService` is a top-level singleton — construct it during bootstrap with `createAuthService(config.auth)` (already in config from Phase 0).

If the bootstrap currently doesn't have `authService`, add the construction step right after config is loaded:

```typescript
import { createAuthService } from "./user-auth/auth-service.js";
import { createAuthHandler } from "./api/handlers/auth.js";

const authService = await createAuthService(config.auth);
// ... later in deps construction:
const router = createApiRouter({
  // ... existing deps
  handleAuth: createAuthHandler({ auth: authService }),
});
```

- [ ] **Step 6: Run all router + auth tests**

```bash
bun test src/api/
```

Expected: all pass. If the bootstrap update broke compile, run typecheck and fix.

```bash
bun run --filter '@sentient/gateway' typecheck
```

- [ ] **Step 7: Commit**

```bash
git add gateway/src/api/router.ts gateway/src/api/router.test.ts gateway/src/server.ts
git commit -m "feat(api): wire /api/v1/auth/* routing and authService bootstrap"
```

---

## Task 1.7: WS auth handshake — first-message gate + timeout

**Files:**
- Modify: `gateway/src/session-handlers/ws-helpers.ts` (add `userId` to `ClientData`, plus auth state fields)
- Modify: `gateway/src/session-handlers/ws-handlers.ts` (gate logic in `openSession` + `handleWebSocketMessage`)
- Create: `gateway/src/session-handlers/ws-auth-gate.ts`
- Create: `gateway/src/session-handlers/ws-auth-gate.test.ts`

**Approach:** On `openSession`, set `data.authState = "pending"` and start a `setTimeout(authConfig.ws_auth_timeout_ms)` that closes the WS if state is still pending. The first message must be `{type: "auth", token}`. On valid token: set `data.userId`, `data.authState = "authed"`, clear timeout, emit `{type: "auth.ok", user: {...}}`. On invalid/missing/timeout: emit `{type: "auth.error", code}` and close.

- [ ] **Step 1: Inspect current ws-helpers and ws-handlers**

Read these to confirm the exact struct shape and the message dispatcher pattern (the recon notes show `handleWebSocketMessage` switches on `msg.type` around line 79):

```bash
sed -n '1,120p' gateway/src/session-handlers/ws-helpers.ts
sed -n '1,140p' gateway/src/session-handlers/ws-handlers.ts
```

- [ ] **Step 2: Extend `ClientData`**

In `ws-helpers.ts`, the existing `ClientData` interface (around lines 15–43) gains:

```typescript
authState: "pending" | "authed" | "rejected";
userId: string | null;
authTimeout: ReturnType<typeof setTimeout> | null;
```

Update `createEmptySessionData()` to set `authState: "pending"`, `userId: null`, `authTimeout: null`.

- [ ] **Step 3: Write the failing test**

Create `gateway/src/session-handlers/ws-auth-gate.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthConfig } from "@sentient/config";
import { createAuthService } from "../user-auth/auth-service.js";
import { handleAuthMessage } from "./ws-auth-gate.js";
import type { ClientData } from "./ws-helpers.js";

const AUTH_CONFIG: AuthConfig = {
  token_ttl_seconds: 3600,
  ws_auth_timeout_ms: 5000,
  argon2_memory_kb: 8192,
  argon2_iterations: 1,
  argon2_parallelism: 1,
};

interface FakeWs {
  data: ClientData;
  sent: unknown[];
  closeCode: number | null;
  send: (s: string) => void;
  close: (code: number, reason?: string) => void;
}

function fakeWs(): FakeWs {
  const data: ClientData = {
    sessionId: "test-session",
    connectedAt: Date.now(),
    personSession: null,
    attachment: null,
    authState: "pending",
    userId: null,
    authTimeout: null,
  } as ClientData;
  const ws: FakeWs = {
    data,
    sent: [],
    closeCode: null,
    send(s) {
      ws.sent.push(JSON.parse(s));
    },
    close(code) {
      ws.closeCode = code;
    },
  };
  return ws;
}

describe("ws auth gate", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-wsg-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("authes the WS on a valid token, sets userId, sends auth.ok", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await auth.authenticate("kevin", "1234");
    if (!r.ok) throw new Error("seed failed");

    const ws = fakeWs();
    await handleAuthMessage(
      ws as unknown as { data: ClientData; send: (s: string) => void; close: (c: number) => void },
      { type: "auth", token: r.value.token },
      auth,
    );
    expect(ws.data.authState).toBe("authed");
    expect(ws.data.userId).toBe("kevin");
    expect(ws.sent).toEqual([
      {
        type: "auth.ok",
        user: { userId: "kevin", displayName: "Kevin", isAdmin: true, avatarTint: "terra" },
      },
    ]);
    expect(ws.closeCode).toBeNull();
  });

  it("rejects + closes on invalid token", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const ws = fakeWs();
    await handleAuthMessage(
      ws as unknown as { data: ClientData; send: (s: string) => void; close: (c: number) => void },
      { type: "auth", token: "garbage" },
      auth,
    );
    expect(ws.data.authState).toBe("rejected");
    expect(ws.data.userId).toBeNull();
    expect(ws.sent[0]).toMatchObject({ type: "auth.error" });
    expect(ws.closeCode).not.toBeNull();
  });

  it("rejects + closes when first message is not type:auth", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    const ws = fakeWs();
    await handleAuthMessage(
      ws as unknown as { data: ClientData; send: (s: string) => void; close: (c: number) => void },
      { type: "session.configure" },
      auth,
    );
    expect(ws.data.authState).toBe("rejected");
    expect(ws.sent[0]).toMatchObject({ type: "auth.error", code: "auth-required" });
    expect(ws.closeCode).not.toBeNull();
  });

  it("rejects token whose user no longer exists", async () => {
    const auth = await createAuthService(AUTH_CONFIG);
    await auth.createUser({
      userId: "kevin",
      displayName: "Kevin",
      pin: "1234",
      isAdmin: true,
      avatarTint: "terra",
    });
    const r = await auth.authenticate("kevin", "1234");
    if (!r.ok) throw new Error("seed");
    await auth.users.remove("kevin");

    const ws = fakeWs();
    await handleAuthMessage(
      ws as unknown as { data: ClientData; send: (s: string) => void; close: (c: number) => void },
      { type: "auth", token: r.value.token },
      auth,
    );
    expect(ws.data.authState).toBe("rejected");
    expect(ws.sent[0]).toMatchObject({ type: "auth.error" });
    expect(ws.closeCode).not.toBeNull();
  });
});
```

- [ ] **Step 4: Run, expect fail**

```bash
bun test src/session-handlers/ws-auth-gate.test.ts
```

- [ ] **Step 5: Implement the gate**

Create `gateway/src/session-handlers/ws-auth-gate.ts`:

```typescript
import { z } from "zod";
import { getLog } from "../logging/logger.js";
import type { AuthService } from "../user-auth/auth-service.js";
import type { ClientData } from "./ws-helpers.js";

const log = getLog(["sentient", "gateway", "session-handlers", "ws-auth-gate"]);

const WS_CLOSE_POLICY = 1008; // RFC 6455 — policy violation

const authMsgSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});

interface WsLike {
  data: ClientData;
  send: (s: string) => void;
  close: (code: number, reason?: string) => void;
}

/**
 * Process the very first WS message. Closes the connection on any failure.
 * Idempotent: if already authed, drops; if already rejected, drops.
 */
export async function handleAuthMessage(
  ws: WsLike,
  message: unknown,
  auth: AuthService,
): Promise<void> {
  if (ws.data.authState !== "pending") {
    log.debug("auth.ignored", { sessionId: ws.data.sessionId, state: ws.data.authState });
    return;
  }

  const parsed = authMsgSchema.safeParse(message);
  if (!parsed.success) {
    return reject(ws, "auth-required", "first message must be type:auth");
  }

  const r = await auth.tokens.validate(parsed.data.token);
  if (!r.ok) {
    return reject(ws, r.error, "token validation failed");
  }
  const userR = await auth.users.get(r.value.userId);
  if (!userR.ok || !userR.value) {
    return reject(ws, "user-not-found", "token valid but user gone");
  }

  ws.data.userId = userR.value.userId;
  ws.data.authState = "authed";
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }
  ws.send(
    JSON.stringify({
      type: "auth.ok",
      user: {
        userId: userR.value.userId,
        displayName: userR.value.displayName,
        isAdmin: userR.value.isAdmin,
        avatarTint: userR.value.avatarTint,
      },
    }),
  );
  log.info("auth.ok", { sessionId: ws.data.sessionId, userId: userR.value.userId });
}

function reject(ws: WsLike, code: string, reason: string): void {
  ws.data.authState = "rejected";
  ws.data.userId = null;
  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }
  ws.send(JSON.stringify({ type: "auth.error", code, message: reason }));
  log.info("auth.reject", { sessionId: ws.data.sessionId, code, reason });
  ws.close(WS_CLOSE_POLICY, reason);
}

/**
 * Schedule the timeout in openSession; cancels itself when authState changes.
 * Returns the timeout handle (caller stores in ws.data.authTimeout).
 */
export function scheduleAuthTimeout(
  ws: WsLike,
  timeoutMs: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (ws.data.authState === "pending") {
      reject(ws, "auth-timeout", `no auth message within ${timeoutMs}ms`);
    }
  }, timeoutMs);
}
```

- [ ] **Step 6: Run unit test, expect 4 pass**

```bash
bun test src/session-handlers/ws-auth-gate.test.ts
```

- [ ] **Step 7: Wire gate into ws-handlers.ts**

In `gateway/src/session-handlers/ws-handlers.ts`:

In `openSession(ws, services)`:
1. After existing setup that sets `data.sessionId`, ALSO call:
   ```typescript
   ws.data.authTimeout = scheduleAuthTimeout(ws, services.authConfig.ws_auth_timeout_ms);
   ```
2. Remove any existing `auth.ok` send from `openSession` (the gate sends it on auth message receipt).

In `handleWebSocketMessage(ws, raw, services)`:
1. Parse `msg = JSON.parse(raw)` as today.
2. BEFORE the existing switch on `msg.type`, add:
   ```typescript
   if (ws.data.authState !== "authed") {
     await handleAuthMessage(ws, msg, services.auth);
     return;
   }
   ```
3. Pass `services.auth` (an `AuthService`) and `services.authConfig` through `services` (extend the services type used by ws-handlers).

Look in ws-handlers.ts for the `services` type and add the two new fields. Then update the bootstrap (`gateway/src/server.ts`) to populate them when constructing services.

- [ ] **Step 8: Run gateway tests for ws + integration**

```bash
bun test src/session-handlers/
```

Several existing tests will likely fail because they don't pass `services.auth` — fix them by adding a stub `auth` to their service mock. Use `createAuthService(AUTH_CONFIG)` in test setup; do NOT make tests bypass auth via flags.

- [ ] **Step 9: Run full gateway test suite**

```bash
bun test
```

User-auth + new ws-auth-gate must pass. Pre-existing failures in unrelated areas can stay (per Phase 0 acceptance note).

- [ ] **Step 10: Commit**

```bash
git add gateway/src/session-handlers/ws-helpers.ts gateway/src/session-handlers/ws-handlers.ts gateway/src/session-handlers/ws-auth-gate.ts gateway/src/session-handlers/ws-auth-gate.test.ts gateway/src/server.ts
# include any updated session-handler tests:
git add -u gateway/src/session-handlers/
git commit -m "feat(ws): one-shot auth-message gate; bind userId to ClientData"
```

---

## Task 1.8: PersonSession + registry — userId field

Thread `userId` (from authenticated WS) into `PersonSession`. The session registry currently keys by `profile` (string). After this task, sessions are still keyed by profile, but the PersonSession carries `userId` for downstream use (Phase 3 idle-flush, Phase 6 per-user UI).

**Files:**
- Modify: `gateway/src/person-session/person-session.ts` — add `userId` field
- Modify: `gateway/src/person-session/person-session-registry.ts` — accept `userId` in `getOrCreate`
- Modify: `gateway/src/person-session/person-session.test.ts` (existing) — update fixtures
- Modify: `gateway/src/person-session/person-session-registry.test.ts` (existing) — update fixtures

- [ ] **Step 1: Read both files**

```bash
sed -n '1,120p' gateway/src/person-session/person-session.ts
sed -n '1,120p' gateway/src/person-session/person-session-registry.ts
```

- [ ] **Step 2: Update PersonSession**

In `person-session.ts`, in the `PersonSessionInit` interface and the class:
1. Add `userId: string | null` to `PersonSessionInit`.
2. Add `readonly userId: string | null` field on the class, initialized from `init.userId`.
3. Add nothing else — no methods.

- [ ] **Step 3: Update existing PersonSession tests**

`person-session.test.ts` — wherever `new PersonSession({...})` is called, add `userId: null` (default) or `userId: "kevin"` where appropriate. Run:

```bash
bun test src/person-session/person-session.test.ts
```

Add a new test case:

```typescript
it("exposes userId from init", () => {
  const ps = new PersonSession({
    profile: "kevin",
    hermesUrl: "http://h:1",
    hermesApiKey: "k",
    userId: "kevin",
  });
  expect(ps.userId).toBe("kevin");
});
```

- [ ] **Step 4: Update PersonSessionRegistry**

In `person-session-registry.ts`, change `getOrCreate(profile: string)` to `getOrCreate(profile: string, userId: string | null)`. Pass `userId` through to the `new PersonSession({...})` constructor call.

- [ ] **Step 5: Update registry tests**

Add `userId` arg to all `getOrCreate(...)` calls. Add a test:

```typescript
it("threads userId into the created PersonSession", () => {
  const reg = createPersonSessionRegistry(testConfig, () => "fake-key");
  const ps = reg.getOrCreate("kevin", "kevin");
  expect(ps.userId).toBe("kevin");
});
```

- [ ] **Step 6: Update call sites**

Find and update every caller of `getOrCreate` to pass `userId`:

```bash
grep -rn "getOrCreate" gateway/src --include='*.ts'
```

In WS handlers, the `userId` comes from `ws.data.userId` (set by Task 1.7). For other call sites (e.g. boot-time provisioning), pass `null` or the appropriate user.

- [ ] **Step 7: Run all person-session + ws tests**

```bash
bun test src/person-session/ src/session-handlers/
```

- [ ] **Step 8: Commit**

```bash
git add gateway/src/person-session/ gateway/src/session-handlers/
git commit -m "feat(person-session): thread userId from authed WS"
```

---

## Task 1.9: Channel-gate identify_user MCP tool

Per spec §4.4, `identify_user` is callable only from satellite-channel sessions. Web sessions (channel = "web" or similar) get an error.

**Files:**
- Modify: `gateway/src/mcp-host/tools/identify-user.ts` (add channel check)
- Modify: `gateway/src/mcp-host/tools/identify-user.test.ts` (add channel-gate test)

- [ ] **Step 1: Read current implementation**

```bash
cat gateway/src/mcp-host/tools/identify-user.ts
```

The recon report shows the existing user check at lines 52–58. The `ctx.channel` value is set elsewhere; verify it exists by:

```bash
grep -rn "channel:" gateway/src/mcp-host/ --include='*.ts' | head -10
```

- [ ] **Step 2: Add failing test**

In `identify-user.test.ts`, add:

```typescript
it("rejects when channel is web — only satellite may call identify_user", async () => {
  const ctx = makeCtx({ userId: "kevin", channel: "web" });
  const r = await identifyUserTool.handler({ name: "wife" }, ctx);
  expect(r.isError).toBe(true);
  expect(r.content[0]?.text).toMatch(/satellite/i);
});

it("allows the call when channel is satellite", async () => {
  const ctx = makeCtx({ userId: "kevin", channel: "satellite" });
  const r = await identifyUserTool.handler({ name: "wife" }, ctx);
  // existing happy path: succeeds (or at least passes the channel gate).
  // The test should assert it does NOT immediately error with the satellite-gate message.
  if (r.isError) {
    expect(r.content[0]?.text).not.toMatch(/satellite/i);
  }
});
```

(Adapt `makeCtx` to whatever the existing test helper is — read the test file first to see the conventions.)

- [ ] **Step 3: Run, expect fail**

```bash
bun test src/mcp-host/tools/identify-user.test.ts
```

- [ ] **Step 4: Add the gate**

In `identify-user.ts`, BEFORE the existing `if (!ctx.userId)` check, add:

```typescript
if (ctx.channel !== "satellite") {
  log.debug("identify_user.wrong-channel", { channel: ctx.channel });
  return {
    isError: true,
    content: [{ type: "text", text: "identify_user is only available on satellite devices" }],
  };
}
```

- [ ] **Step 5: Run, expect pass**

- [ ] **Step 6: Commit**

```bash
git add gateway/src/mcp-host/tools/identify-user.ts gateway/src/mcp-host/tools/identify-user.test.ts
git commit -m "feat(mcp): channel-gate identify_user to satellite channel only"
```

---

# Phase 2 — Profile Store + Renderer

## Task 2.1: Profile schema (`ProfileV1`)

Defines the canonical shape stored in `<root>/<userId>/profile.json`. Zod-validated; `schemaVersion: 1` for future migrations.

**Files:**
- Create: `gateway/src/profile-store/profile-types.ts`
- Create: `gateway/src/profile-store/profile-types.test.ts`

- [ ] **Step 1: Write failing test**

Create `gateway/src/profile-store/profile-types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { profileV1Schema } from "./profile-types.js";

const valid = {
  schemaVersion: 1,
  userId: "kevin",
  model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
  voice: { provider: "fish-audio", id: "abc123" },
  persona: { template: "default", overrides: "" },
  tools: { enabled: ["home_assistant", "memory_search"] },
  compression: { threshold: 0.5 },
  advanced: { extraSystemPrompt: "", maxTokens: 1024 },
};

describe("profileV1Schema", () => {
  it("accepts a valid profile", () => {
    expect(profileV1Schema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown provider", () => {
    expect(() => profileV1Schema.parse({ ...valid, model: { provider: "anthropic", id: "x" } })).toThrow();
  });

  it("rejects schemaVersion != 1", () => {
    expect(() => profileV1Schema.parse({ ...valid, schemaVersion: 2 })).toThrow();
  });

  it("rejects compression.threshold > 1 or < 0", () => {
    expect(() => profileV1Schema.parse({ ...valid, compression: { threshold: 1.5 } })).toThrow();
    expect(() => profileV1Schema.parse({ ...valid, compression: { threshold: -0.1 } })).toThrow();
  });

  it("rejects empty userId", () => {
    expect(() => profileV1Schema.parse({ ...valid, userId: "" })).toThrow();
  });

  it("accepts both openrouter and ollama-cloud providers", () => {
    expect(profileV1Schema.parse({ ...valid, model: { provider: "ollama-cloud", id: "gpt-oss:120b" } }).model.provider).toBe("ollama-cloud");
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test src/profile-store/profile-types.test.ts
```

- [ ] **Step 3: Implement**

Create `gateway/src/profile-store/profile-types.ts`:

```typescript
import { z } from "zod";

export const PROFILE_SCHEMA_VERSION = 1;

export const modelProviderSchema = z.enum(["openrouter", "ollama-cloud"]);
export type ModelProvider = z.output<typeof modelProviderSchema>;

export const voiceProviderSchema = z.enum(["fish-audio"]);
export type VoiceProvider = z.output<typeof voiceProviderSchema>;

export const profileV1Schema = z.object({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  userId: z.string().min(1).max(64),
  model: z.object({
    provider: modelProviderSchema,
    id: z.string().min(1),
  }),
  voice: z.object({
    provider: voiceProviderSchema,
    id: z.string().min(1),
  }),
  persona: z.object({
    template: z.string().min(1),
    overrides: z.string().max(8192),
  }),
  tools: z.object({
    enabled: z.array(z.string().min(1)),
  }),
  compression: z.object({
    threshold: z.number().min(0).max(1),
  }),
  advanced: z.object({
    extraSystemPrompt: z.string().max(8192),
    maxTokens: z.number().int().min(1).max(8192),
  }),
});

export type ProfileV1 = z.output<typeof profileV1Schema>;
```

- [ ] **Step 4: Run, expect 6 tests pass**

- [ ] **Step 5: Commit**

```bash
git add gateway/src/profile-store/profile-types.ts gateway/src/profile-store/profile-types.test.ts
git commit -m "feat(profile-store): ProfileV1 zod schema + types"
```

---

## Task 2.2: profile-store CRUD

Per-user `profile.json` store using existing `writeFileAtomic` (Phase 0).

**Files:**
- Create: `gateway/src/profile-store/profile-store.ts`
- Create: `gateway/src/profile-store/profile-store.test.ts`

- [ ] **Step 1: Failing tests**

Create `gateway/src/profile-store/profile-store.test.ts`:

```typescript
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProfileStore } from "./profile-store.js";
import type { ProfileV1 } from "./profile-types.js";

function sample(userId = "kevin"): ProfileV1 {
  return {
    schemaVersion: 1,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "fish-audio", id: "voice-abc" },
    persona: { template: "default", overrides: "" },
    tools: { enabled: ["home_assistant"] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024 },
  };
}

describe("createProfileStore", () => {
  let root: string;
  let store: ReturnType<typeof createProfileStore>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-pstore-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
    store = createProfileStore();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("get returns not-found when no file exists", async () => {
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: false, error: "not-found" });
  });

  it("save then get round-trips", async () => {
    const p = sample();
    const w = await store.save(p);
    expect(w).toEqual({ ok: true, value: undefined });
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: true, value: p });
  });

  it("save uses atomic rename — no .tmp sibling after success", async () => {
    await store.save(sample());
    const dir = join(root, "kevin");
    expect(existsSync(join(dir, "profile.json"))).toBe(true);
    expect(existsSync(join(dir, "profile.json.tmp"))).toBe(false);
  });

  it("returns corrupt-file when JSON is invalid", async () => {
    const dir = join(root, "kevin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profile.json"), "not json", "utf8");
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: false, error: "corrupt-file" });
  });

  it("returns corrupt-file when JSON fails schema validation", async () => {
    const dir = join(root, "kevin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profile.json"), JSON.stringify({ schemaVersion: 99 }), "utf8");
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: false, error: "corrupt-file" });
  });

  it("save rejects when input fails schema validation", async () => {
    const bad = { ...sample(), model: { provider: "anthropic", id: "x" } } as unknown as ProfileV1;
    const r = await store.save(bad);
    expect(r).toEqual({ ok: false, error: "validation-error" });
  });

  it("remove deletes the profile.json", async () => {
    await store.save(sample());
    const r = await store.remove("kevin");
    expect(r).toEqual({ ok: true, value: undefined });
    const g = await store.get("kevin");
    expect(g).toEqual({ ok: false, error: "not-found" });
  });

  it("remove returns not-found when nothing to remove", async () => {
    const r = await store.remove("ghost");
    expect(r).toEqual({ ok: false, error: "not-found" });
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test src/profile-store/profile-store.test.ts
```

- [ ] **Step 3: Implement**

Create `gateway/src/profile-store/profile-store.ts`:

```typescript
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "../user-auth/atomic-write.js";
import { getUserProfileDir } from "../user-auth/paths.js";
import { profileV1Schema, type ProfileV1 } from "./profile-types.js";

const log = getLog(["sentient", "gateway", "profile-store"]);

export type ProfileStoreError = "not-found" | "io-error" | "corrupt-file" | "validation-error";

export interface ProfileStore {
  get(userId: string): Promise<Result<ProfileV1, ProfileStoreError>>;
  save(profile: ProfileV1): Promise<Result<void, ProfileStoreError>>;
  remove(userId: string): Promise<Result<void, ProfileStoreError>>;
}

function profilePath(userId: string): string {
  return join(getUserProfileDir(userId), "profile.json");
}

export function createProfileStore(): ProfileStore {
  return {
    async get(userId) {
      const path = profilePath(userId);
      let raw: string;
      try {
        raw = await fs.readFile(path, "utf8");
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: false, error: "not-found" };
        }
        log.warn("get.io-error", { userId, reason: (e as Error).message });
        return { ok: false, error: "io-error" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log.warn("get.corrupt-json", { userId });
        return { ok: false, error: "corrupt-file" };
      }
      const v = profileV1Schema.safeParse(parsed);
      if (!v.success) {
        log.warn("get.corrupt-schema", { userId, reason: v.error.message });
        return { ok: false, error: "corrupt-file" };
      }
      return { ok: true, value: v.data };
    },

    async save(profile) {
      const v = profileV1Schema.safeParse(profile);
      if (!v.success) {
        log.warn("save.validation-error", { userId: profile.userId, reason: v.error.message });
        return { ok: false, error: "validation-error" };
      }
      try {
        await writeFileAtomic(profilePath(profile.userId), JSON.stringify(v.data, null, 2), {
          mode: 0o600,
        });
        log.info("save", { userId: profile.userId });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        log.warn("save.io-error", { userId: profile.userId, reason: (e as Error).message });
        return { ok: false, error: "io-error" };
      }
    },

    async remove(userId) {
      try {
        await fs.unlink(profilePath(userId));
        log.info("remove", { userId });
        return { ok: true, value: undefined };
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: false, error: "not-found" };
        }
        log.warn("remove.io-error", { userId, reason: (e as Error).message });
        return { ok: false, error: "io-error" };
      }
    },
  };
}
```

- [ ] **Step 4: Run, expect 8 tests pass**

- [ ] **Step 5: Commit**

```bash
git add gateway/src/profile-store/profile-store.ts gateway/src/profile-store/profile-store.test.ts
git commit -m "feat(profile-store): ProfileV1 CRUD with atomic writes"
```

---

## Task 2.3: Default profile factory

Builds a sensible default `ProfileV1` for a newly-created user.

**Files:**
- Create: `gateway/src/profile-store/profile-defaults.ts`
- Create: `gateway/src/profile-store/profile-defaults.test.ts`

- [ ] **Step 1: Failing test**

Create `gateway/src/profile-store/profile-defaults.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildDefaultProfile } from "./profile-defaults.js";
import { profileV1Schema } from "./profile-types.js";

describe("buildDefaultProfile", () => {
  it("returns a schema-valid ProfileV1 keyed by userId", () => {
    const p = buildDefaultProfile("kevin");
    expect(profileV1Schema.parse(p)).toEqual(p);
    expect(p.userId).toBe("kevin");
  });

  it("defaults to openrouter + a small/cheap model", () => {
    const p = buildDefaultProfile("kevin");
    expect(p.model.provider).toBe("openrouter");
    expect(p.model.id.length).toBeGreaterThan(0);
  });

  it("defaults persona.template to 'default'", () => {
    expect(buildDefaultProfile("kevin").persona.template).toBe("default");
  });

  it("seeds tools.enabled with a non-empty list", () => {
    expect(buildDefaultProfile("kevin").tools.enabled.length).toBeGreaterThan(0);
  });

  it("compression.threshold defaults to 0.5", () => {
    expect(buildDefaultProfile("kevin").compression.threshold).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement**

Create `gateway/src/profile-store/profile-defaults.ts`:

```typescript
import { PROFILE_SCHEMA_VERSION, type ProfileV1 } from "./profile-types.js";

const DEFAULT_MODEL_ID = "google/gemini-2.5-flash";
const DEFAULT_VOICE_ID = "default";
const DEFAULT_TOOLS = ["home_assistant", "memory_search", "time"];
const DEFAULT_COMPRESSION_THRESHOLD = 0.5;
const DEFAULT_MAX_TOKENS = 1024;

export function buildDefaultProfile(userId: string): ProfileV1 {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    userId,
    model: { provider: "openrouter", id: DEFAULT_MODEL_ID },
    voice: { provider: "fish-audio", id: DEFAULT_VOICE_ID },
    persona: { template: "default", overrides: "" },
    tools: { enabled: [...DEFAULT_TOOLS] },
    compression: { threshold: DEFAULT_COMPRESSION_THRESHOLD },
    advanced: { extraSystemPrompt: "", maxTokens: DEFAULT_MAX_TOKENS },
  };
}
```

- [ ] **Step 4: Run, expect 5 tests pass**

- [ ] **Step 5: Commit**

```bash
git add gateway/src/profile-store/profile-defaults.ts gateway/src/profile-store/profile-defaults.test.ts
git commit -m "feat(profile-store): buildDefaultProfile factory for new users"
```

---

## Task 2.4: Shared template loader

Reads `<root>/shared/templates/*.md` with a small in-process cache.

**Files:**
- Create: `gateway/src/profile-store/template-loader.ts`
- Create: `gateway/src/profile-store/template-loader.test.ts`

- [ ] **Step 1: Failing test**

Create `gateway/src/profile-store/template-loader.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTemplateLoader } from "./template-loader.js";

describe("createTemplateLoader", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-tpl-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
    mkdirSync(join(root, "shared", "templates"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("loads an existing template", async () => {
    writeFileSync(join(root, "shared", "templates", "default.md"), "Hello {{userId}}", "utf8");
    const loader = createTemplateLoader();
    const r = await loader.load("default");
    expect(r).toEqual({ ok: true, value: "Hello {{userId}}" });
  });

  it("returns not-found for missing template", async () => {
    const loader = createTemplateLoader();
    const r = await loader.load("nonexistent");
    expect(r).toEqual({ ok: false, error: "not-found" });
  });

  it("returns the seeded built-in 'default' template if no on-disk file exists", async () => {
    const loader = createTemplateLoader();
    const r = await loader.loadOrBuiltinDefault();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBeGreaterThan(0);
  });

  it("caches subsequent loads of the same name", async () => {
    writeFileSync(join(root, "shared", "templates", "x.md"), "v1", "utf8");
    const loader = createTemplateLoader();
    const a = await loader.load("x");
    writeFileSync(join(root, "shared", "templates", "x.md"), "v2", "utf8");
    const b = await loader.load("x");
    expect(a.ok && a.value).toBe("v1");
    expect(b.ok && b.value).toBe("v1"); // cached
  });

  it("invalidate(name) drops the cache for that name", async () => {
    writeFileSync(join(root, "shared", "templates", "y.md"), "v1", "utf8");
    const loader = createTemplateLoader();
    await loader.load("y");
    writeFileSync(join(root, "shared", "templates", "y.md"), "v2", "utf8");
    loader.invalidate("y");
    const after = await loader.load("y");
    expect(after.ok && after.value).toBe("v2");
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement**

Create `gateway/src/profile-store/template-loader.ts`:

```typescript
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { getSharedTemplatesDir } from "../user-auth/paths.js";

const log = getLog(["sentient", "gateway", "profile-store", "template-loader"]);

export type TemplateError = "not-found" | "io-error";

const BUILTIN_DEFAULT = `You are a helpful, kind, family-oriented assistant.
Speak concisely. Refuse harmful requests. Maintain context across turns.`;

export interface TemplateLoader {
  load(name: string): Promise<Result<string, TemplateError>>;
  loadOrBuiltinDefault(): Promise<Result<string, TemplateError>>;
  invalidate(name: string): void;
}

export function createTemplateLoader(): TemplateLoader {
  const cache = new Map<string, string>();

  async function readTemplate(name: string): Promise<Result<string, TemplateError>> {
    if (cache.has(name)) return { ok: true, value: cache.get(name) ?? "" };
    const path = join(getSharedTemplatesDir(), `${name}.md`);
    try {
      const raw = await fs.readFile(path, "utf8");
      cache.set(name, raw);
      log.debug("load.from-disk", { name, bytes: raw.length });
      return { ok: true, value: raw };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, error: "not-found" };
      }
      log.warn("load.io-error", { name, reason: (e as Error).message });
      return { ok: false, error: "io-error" };
    }
  }

  return {
    load: readTemplate,

    async loadOrBuiltinDefault() {
      const r = await readTemplate("default");
      if (r.ok) return r;
      log.debug("loadOrBuiltinDefault.using-builtin");
      return { ok: true, value: BUILTIN_DEFAULT };
    },

    invalidate(name) {
      cache.delete(name);
      log.debug("invalidate", { name });
    },
  };
}
```

- [ ] **Step 4: Run, expect 5 tests pass**

- [ ] **Step 5: Commit**

```bash
git add gateway/src/profile-store/template-loader.ts gateway/src/profile-store/template-loader.test.ts
git commit -m "feat(profile-store): shared template loader with cache + builtin default"
```

---

## Task 2.5: Profile renderer (SOUL.md + Hermes config.yaml)

Pure function `renderProfile(profile, templateText)` returning `{ soulMarkdown, hermesConfigYaml }`. Plus a thin `writeRendered(userId, rendered)` helper that puts both files under `<root>/<userId>/.generated/` with chmod 0644 (these are read by Hermes).

The Hermes per-instance `config.yaml` shape comes from the upstream Hermes docs; for v1 we render only the fields Hermes reads at startup: model + provider, persona path (SOUL.md), MCP servers list, compression threshold, max tokens. Hand-construct the YAML as a string (no extra deps) to keep the renderer pure and inspection-friendly.

**Files:**
- Create: `gateway/src/profile-store/profile-renderer.ts`
- Create: `gateway/src/profile-store/profile-renderer.test.ts`

- [ ] **Step 1: Failing tests**

Create `gateway/src/profile-store/profile-renderer.test.ts`:

```typescript
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDefaultProfile } from "./profile-defaults.js";
import { renderProfile, writeRendered } from "./profile-renderer.js";

describe("renderProfile (pure function)", () => {
  it("produces a non-empty SOUL.md and config.yaml", () => {
    const p = buildDefaultProfile("kevin");
    const r = renderProfile(p, "TEMPLATE_BODY");
    expect(r.soulMarkdown.length).toBeGreaterThan(0);
    expect(r.hermesConfigYaml.length).toBeGreaterThan(0);
  });

  it("includes the template body in SOUL.md", () => {
    const p = buildDefaultProfile("kevin");
    const r = renderProfile(p, "MY_TEMPLATE_TEXT");
    expect(r.soulMarkdown).toContain("MY_TEMPLATE_TEXT");
  });

  it("includes persona overrides after the template body", () => {
    const p = { ...buildDefaultProfile("kevin"), persona: { template: "default", overrides: "USER_OVERRIDE" } };
    const r = renderProfile(p, "TEMPLATE_BODY");
    const idxTpl = r.soulMarkdown.indexOf("TEMPLATE_BODY");
    const idxOv = r.soulMarkdown.indexOf("USER_OVERRIDE");
    expect(idxTpl).toBeGreaterThanOrEqual(0);
    expect(idxOv).toBeGreaterThan(idxTpl);
  });

  it("renders model.provider + model.id in the YAML for openrouter", () => {
    const p = buildDefaultProfile("kevin");
    const r = renderProfile(p, "x");
    expect(r.hermesConfigYaml).toMatch(/provider:\s*openrouter/);
    expect(r.hermesConfigYaml).toMatch(/model:\s*google\/gemini-2\.5-flash/);
  });

  it("renders OpenAI-compat shape for ollama-cloud", () => {
    const p = { ...buildDefaultProfile("kevin"), model: { provider: "ollama-cloud" as const, id: "gpt-oss:120b" } };
    const r = renderProfile(p, "x");
    expect(r.hermesConfigYaml).toMatch(/provider:\s*openai/);
    expect(r.hermesConfigYaml).toMatch(/base_url:\s*https:\/\/ollama\.com\/v1/);
    expect(r.hermesConfigYaml).toMatch(/model:\s*gpt-oss:120b/);
    expect(r.hermesConfigYaml).toMatch(/api_key_env:\s*OLLAMA_API_KEY/);
  });

  it("renders compression.threshold and advanced.maxTokens", () => {
    const p = { ...buildDefaultProfile("kevin"), compression: { threshold: 0.42 }, advanced: { extraSystemPrompt: "", maxTokens: 4096 } };
    const r = renderProfile(p, "x");
    expect(r.hermesConfigYaml).toMatch(/threshold:\s*0\.42/);
    expect(r.hermesConfigYaml).toMatch(/max_output_tokens:\s*4096/);
  });

  it("renders the enabled tools list", () => {
    const p = { ...buildDefaultProfile("kevin"), tools: { enabled: ["home_assistant", "time"] } };
    const r = renderProfile(p, "x");
    expect(r.hermesConfigYaml).toMatch(/home_assistant/);
    expect(r.hermesConfigYaml).toMatch(/time/);
  });

  it("is deterministic — same inputs yield byte-identical outputs", () => {
    const p = buildDefaultProfile("kevin");
    const a = renderProfile(p, "T");
    const b = renderProfile(p, "T");
    expect(a.soulMarkdown).toBe(b.soulMarkdown);
    expect(a.hermesConfigYaml).toBe(b.hermesConfigYaml);
  });
});

describe("writeRendered (side-effect helper)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-rend-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("writes both files under <root>/<userId>/.generated/", async () => {
    const r = renderProfile(buildDefaultProfile("kevin"), "T");
    await writeRendered("kevin", r);
    const dir = join(root, "kevin", ".generated");
    expect(existsSync(join(dir, "config.yaml"))).toBe(true);
    expect(existsSync(join(dir, "SOUL.md"))).toBe(true);
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe(r.hermesConfigYaml);
    expect(readFileSync(join(dir, "SOUL.md"), "utf8")).toBe(r.soulMarkdown);
  });

  it("uses chmod 0644 (Hermes container reads it)", async () => {
    const r = renderProfile(buildDefaultProfile("kevin"), "T");
    await writeRendered("kevin", r);
    const mode = statSync(join(root, "kevin", ".generated", "config.yaml")).mode & 0o777;
    expect(mode).toBe(0o644);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
bun test src/profile-store/profile-renderer.test.ts
```

- [ ] **Step 3: Implement**

Create `gateway/src/profile-store/profile-renderer.ts`:

```typescript
import { join } from "node:path";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "../user-auth/atomic-write.js";
import { getUserProfileDir } from "../user-auth/paths.js";
import type { ProfileV1 } from "./profile-types.js";

const log = getLog(["sentient", "gateway", "profile-store", "renderer"]);

const OLLAMA_BASE_URL = "https://ollama.com/v1";
const OLLAMA_API_KEY_ENV = "OLLAMA_API_KEY";
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

export interface RenderedProfile {
  soulMarkdown: string;
  hermesConfigYaml: string;
}

export function renderProfile(profile: ProfileV1, templateBody: string): RenderedProfile {
  const soulMarkdown = renderSoul(profile, templateBody);
  const hermesConfigYaml = renderHermesYaml(profile);
  log.debug("render", {
    userId: profile.userId,
    soulBytes: soulMarkdown.length,
    yamlBytes: hermesConfigYaml.length,
  });
  return { soulMarkdown, hermesConfigYaml };
}

function renderSoul(profile: ProfileV1, templateBody: string): string {
  const head = `# ${profile.userId}\n\n`;
  const overrides = profile.persona.overrides.trim();
  const overrideBlock = overrides.length > 0 ? `\n\n## User overrides\n\n${overrides}\n` : "\n";
  return `${head}${templateBody.trim()}\n${overrideBlock}`;
}

function renderHermesYaml(profile: ProfileV1): string {
  const model = renderModelSection(profile);
  const tools = profile.tools.enabled.map((t) => `  - ${t}`).join("\n");
  const extra = profile.advanced.extraSystemPrompt.trim();
  const extraBlock = extra.length > 0 ? `extra_system_prompt: |\n${indent(extra, 2)}\n` : "";

  return [
    `# Generated by gateway profile-renderer; do not edit by hand.`,
    `model:`,
    model,
    `compression:`,
    `  enabled: true`,
    `  threshold: ${profile.compression.threshold}`,
    `mcp_servers:`,
    tools.length > 0 ? tools : `  []`,
    `max_output_tokens: ${profile.advanced.maxTokens}`,
    extraBlock,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

function renderModelSection(profile: ProfileV1): string {
  if (profile.model.provider === "openrouter") {
    return [
      `  provider: openrouter`,
      `  model: ${profile.model.id}`,
      `  api_key_env: ${OPENROUTER_API_KEY_ENV}`,
    ].join("\n");
  }
  return [
    `  provider: openai`,
    `  base_url: ${OLLAMA_BASE_URL}`,
    `  model: ${profile.model.id}`,
    `  api_key_env: ${OLLAMA_API_KEY_ENV}`,
  ].join("\n");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => `${pad}${l}`)
    .join("\n");
}

export async function writeRendered(userId: string, rendered: RenderedProfile): Promise<void> {
  const dir = join(getUserProfileDir(userId), ".generated");
  await writeFileAtomic(join(dir, "config.yaml"), rendered.hermesConfigYaml, { mode: 0o644 });
  await writeFileAtomic(join(dir, "SOUL.md"), rendered.soulMarkdown, { mode: 0o644 });
  log.info("writeRendered", { userId, dir });
}
```

- [ ] **Step 4: Run, expect 10 tests pass**

```bash
bun test src/profile-store/profile-renderer.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add gateway/src/profile-store/profile-renderer.ts gateway/src/profile-store/profile-renderer.test.ts
git commit -m "feat(profile-store): renderProfile (pure) + writeRendered (atomic)"
```

---

## Task 2.6: Phase 1+2 acceptance run

- [ ] **Step 1: Run focused area sweeps**

```bash
bun test src/user-auth/ src/profile-store/ src/api/handlers/auth.test.ts src/api/router.test.ts src/session-handlers/ws-auth-gate.test.ts src/person-session/ src/mcp-host/tools/identify-user.test.ts
```

Expected: every listed test passes.

- [ ] **Step 2: Typecheck across all packages**

```bash
bun run --filter '*' typecheck
```

Expected: pass.

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Expected: pass. If a Biome auto-fix is needed in YOUR code, apply with `bunx biome check --write <file>`.

- [ ] **Step 4: Container check (per stored feedback)**

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '(gateway|hermes|sentient)' || echo 'no conflicts'
```

If any `sentient-*` container holds port 8888 (gateway port) AND you plan to do an in-process integration test, stop it first. Pure unit tests above don't bind ports.

- [ ] **Step 5: Smoke the bootstrap manually (in-place)**

Start the gateway dev server briefly to verify `authService` constructs without error:

```bash
cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run --filter '@sentient/gateway' dev &
sleep 8
curl -s http://localhost:8888/api/v1/auth/users
# expect: 200 with [] (or current users) — confirms wiring
kill %1 2>/dev/null || true
```

- [ ] **Step 6: Tag commits**

Branch should now have ~14 new commits since Phase 0 ended. List them:

```bash
git log --oneline $(git merge-base HEAD develop)..HEAD | grep -E "(user-auth|profile-store|auth-service|api/handlers/auth|ws-auth-gate|person-session|identify_user)"
```

---

## Phase 1+2 Exit Criteria

- [ ] All `gateway/src/user-auth/`, `gateway/src/profile-store/`, `gateway/src/api/handlers/auth.test.ts`, `gateway/src/api/router.test.ts`, `gateway/src/session-handlers/ws-auth-gate.test.ts` tests pass.
- [ ] `bun run --filter '@sentient/gateway' typecheck` clean.
- [ ] `bun run lint` clean.
- [ ] No changes to `lefthook.yml`, `docker-compose.yml`, `package.json` (deps), webui, or anything in `gateway/src/` outside the listed scope.
- [ ] Manual curl smoke: `GET /api/v1/auth/users` returns 200 with an empty array on a fresh `~/.sentient/gateway/`.
- [ ] WS connections without an `{type: "auth", token: ...}` first message are closed within `auth.ws_auth_timeout_ms`.

## What Phase 3 Will Build On

- `AuthService` is the dependency the apply-flow orchestrator uses to identify the calling user.
- `ProfileStore` + `renderProfile()` + `writeRendered()` are the inputs to the apply-restart sequence: gateway loads profile.json, renders new files, restarts container, polls health.
- `PersonSession.userId` is the binding the idle-flush scheduler keys off (per spec §3.3).

---

## Self-Review Notes

- **Spec coverage:** Phase 1 covers spec §4.2 (setup), §4.3 (login, /me, /logout), §4.4 (WS auth handshake + identify_user channel-gate), §4.5 partial (admin operations are Phase 7). Phase 2 covers §3.1 partial (`profile.json` canonical store + renderer), §6.5 (My Agent layout-relevant fields). Remaining sections in later phases per overview.
- **No placeholders:** every step has complete code, exact commands, exact file paths.
- **Type consistency:** `UserRecord`, `Argon2Params`, `TokenPayload`, `Result<>`, `StoreResult<>`, `TokenResult<>` reused from Phase 0 verbatim. New types (`ProfileV1`, `AuthService`, `ProfileStore`, `TemplateLoader`, `RenderedProfile`, `ProfileStoreError`, `TemplateError`, `CreateUserError`, `AuthError`) all camelCase, all referenced consistently across tasks.
- **Size budget:** every new source file ≤ 230 lines; auth.ts is ~180 after all four endpoints land.
- **Hard rules baked into every implementer prompt:** no `--no-verify`, no out-of-scope files, `vi.setSystemTime` banned.
