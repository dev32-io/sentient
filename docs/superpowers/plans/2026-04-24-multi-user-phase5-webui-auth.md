# Phase 5 — Webui Auth UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **READ TASK 5.0 FIRST** — this plan executes inside a git worktree, not the main checkout.

**Goal:** Ship the per-user login + first-run-setup screens, an auth context with localStorage token store, the topbar user menu, and the WebSocket auth handshake. After this phase, the webui:
- Empty `users.json` → setup screen → creates admin → token in `localStorage` → chat.
- Existing users → login screen → avatar pick → PIN pad → token in `localStorage` → chat.
- Topbar shows the current user's avatar + display name with a popover for "My Account" / "Log out". Logout clears the token and returns to login.
- WS connects with `{type:"auth", token}` as the very first message; gateway confirms `{type:"auth.ok"}` before any cycles dispatch.

**Architecture:** State-based routing in `app.tsx` (no router lib). Auth state lives in a Preact context backed by `localStorage["sentient:auth"]`. New `services/auth-api.ts` wraps the four Phase 1+2 endpoints. SDK gets one upstream change in `shared/web-sdk/` to send the auth frame first. All visual styling reuses existing CSS tokens + `.settings-panel` BEM idiom.

**Tech Stack:** Preact, TypeScript strict, Vitest + `@testing-library/preact`, raw HTML/BEM CSS (no UI library), `createLogger` from `@sentient/web-sdk`.

**Branch:** `feature/multi-user-phase5-webui-auth` (NEW — created in a git worktree by Task 5.0).

**Spec:** `docs/superpowers/specs/2026-04-24-multi-user-auth-and-settings-design.md` — §4.3 (Login Flow), §4.4 (WebSocket Binding), §6.1 (App Shell), §6.2 (Login + Setup Screens), §6.3 (Topbar User Menu).

**Parent branch:** `feature/multi-user-auth-and-settings` — has Phase 1+2 (REST + WS auth) merged. Phase 3+4 (apply orchestrator + catalogs) may be running in parallel on a separate branch; this plan does NOT depend on 3+4.

---

## Hard Rules (apply to every task)

1. **No `--no-verify` ever.** If lint, typecheck, or tests fail, fix the underlying issue. The Phase 1+2 bundle proved the rule works.
2. **No out-of-scope edits.** This plan touches only:
   - `gateway/webui/src/services/**` (new dir)
   - `gateway/webui/src/hooks/use-auth.tsx` (new)
   - `gateway/webui/src/components/auth/**` (new dir: login-screen, setup-screen, pin-pad, avatar-tile)
   - `gateway/webui/src/components/shell/topbar.tsx` (modify — append user menu)
   - `gateway/webui/src/components/shell/user-menu.tsx` (new)
   - `gateway/webui/src/components/auth-gate.tsx` (DELETE — replaced by the new login flow)
   - `gateway/webui/src/components/auth-gate.test.tsx` (DELETE)
   - `gateway/webui/src/app.tsx` (modify — extend route union + gate on auth)
   - `gateway/webui/src/types.ts` (modify — extend `AuthState`, add `AuthUser`)
   - `gateway/webui/src/styles/components.css` (modify — append BEM classes for new components)
   - `gateway/webui/src/constants.ts` (modify — add `AUTH_STORAGE_KEY`)
   - `shared/web-sdk/src/**` (Task 5.8 only — minimal change to send `{type:"auth", token}` first frame)
   Do **not** edit: `gateway/src/**` (server-side is Phase 1+2 territory), `lefthook.yml`, `package.json`, `tsconfig.json`, `vite.config.ts`, anything under `gateway/webui/src/components/settings/`. If you find you need such an edit, surface it.
3. **Browser logging via `createLogger` only.** Never `console.log/debug/warn/error` in shipped code. Tag: `createLogger(["sentient", "webui", "auth", <subarea>])`.
4. **BEM + existing CSS tokens only.** Use `--color-*`, `--space-*`, `--radius-*`, `--motion-*` tokens already declared in `gateway/webui/src/styles/tokens/*.css`. No new tokens. No CSS framework. Class names follow `.block`, `.block__element`, `.block--modifier`.
5. **Files <300 lines, components <150 lines, functions <40 lines.** Browser code drifts large fast — split early.
6. **TDD with `@testing-library/preact`.** Co-locate tests: every `foo.tsx` has `foo.test.tsx` alongside. One behavior per `it()` block, named `it("does X when Y")`.
7. **`bun run test` (Vitest), not `bun test`.** The latter breaks the jsdom + RTL setup.
8. **Result types from the existing protocol/auth modules; no throws from business logic.** Boundary: HTTP fetch → returns `{ ok: true; value: T } | { ok: false; error: E }` typed shape. Component code unwraps and renders error state, never throws.
9. **camelCase for TS field names.** REST/JSON request and response shapes match what Phase 1+2 actually returns (camelCase for the gateway's API per Phase 1+2's convention — verify by inspecting `gateway/src/api/handlers/auth.ts`).
10. **No `vi.setSystemTime`.** Use `vi.useFakeTimers` + `vi.advanceTimersByTime`.

---

## Status Reporting

When a task completes, report `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`. Concerns include things like "the spec says X but the existing component does Y; I picked X — please confirm." Don't silently resolve a discrepancy.

---

## Task 5.0: Worktree setup (one-time, before any other task)

**Why:** Phase 3+4 may be running autonomously on `feature/multi-user-auth-and-settings`. To keep both phases parallel and prevent commit interleaving, Phase 5 runs in a sibling worktree with its own branch.

**You (the autonomous executor) are running inside the worktree.** This task verifies that and aborts if not.

- [ ] **Step 1: Confirm working directory and branch**

```bash
pwd
git branch --show-current
git worktree list
```

Expected:
- `pwd` ends in `sentient-phase5` (or whatever the operator named it; the key is it is NOT the main checkout `sentient`).
- `git branch --show-current` returns `feature/multi-user-phase5-webui-auth`.
- `git worktree list` shows at least two entries — the main one and this one.

If any of those don't match, report `BLOCKED: not in a Phase 5 worktree. Operator must run: git worktree add ../sentient-phase5 -b feature/multi-user-phase5-webui-auth HEAD` and stop.

- [ ] **Step 2: Confirm Phase 1+2 endpoints are in this worktree's HEAD**

```bash
ls gateway/src/api/handlers/auth.ts && grep -c "handleLogin\|handleSetup\|handleUsers" gateway/src/api/handlers/auth.ts
```

Expected: file exists and grep count ≥ 3. If not, the worktree was branched off the wrong commit — report `BLOCKED: Phase 1+2 not present at HEAD; rebase the worktree onto the correct commit.`

- [ ] **Step 3: Sanity-check the test suite is green before adding anything**

```bash
source scripts/env.sh && bun run typecheck && bun run test
```

Expected: green. If anything fails, that's pre-existing breakage in the parent branch — report `BLOCKED: parent-branch tests not green. Operator must fix on parent before Phase 5 starts.` Do not try to fix it inside this worktree.

- [ ] **Step 4: Note for the operator**

There are no commits in this task. Report `DONE: worktree verified at feature/multi-user-phase5-webui-auth, Phase 1+2 present, baseline tests green.`

---

## Task 5.1: Auth API client

**Why:** Phase 5 calls four auth endpoints. Wrap them in one tiny module so components don't reimplement fetch + bearer-header + JSON parsing each time.

**Endpoints (verify exact shapes by reading `gateway/src/api/handlers/auth.ts` first):**
- `GET /api/v1/auth/users` — returns `{ users: Array<{ userId, displayName, avatarTint, isAdmin }> }`. No auth required.
- `POST /api/v1/auth/setup` — body `{ displayName, pin }`. Returns `{ token, user }`. 409 if users already exist. No auth required.
- `POST /api/v1/auth/login` — body `{ userId, pin }`. Returns `{ token, user }` on match; 401 on miss.
- `GET /api/v1/auth/me` — bearer auth. Returns `{ user }`. 401 if token invalid.

**Files:**
- Create: `gateway/webui/src/services/auth-api.ts`
- Create: `gateway/webui/src/services/auth-api.test.ts`

- [ ] **Step 1: Verify endpoint shapes**

Open `gateway/src/api/handlers/auth.ts` and confirm each endpoint's exact request/response JSON. If anything differs from the description above (different field name, different status code), use what the handler actually returns — Phase 5 follows reality, not the description.

- [ ] **Step 2: Define types and the failing tests**

`gateway/webui/src/services/auth-api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthApi } from "./auth-api.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("createAuthApi", () => {
  it("listUsers GET /api/v1/auth/users returns the users array on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      users: [{ userId: "alice", displayName: "Alice", avatarTint: "terra", isAdmin: true }],
    }), { status: 200 }));
    const api = createAuthApi("https://x");
    const r = await api.listUsers();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(1);
  });

  it("listUsers returns network-error on fetch throw", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const r = await createAuthApi("https://x").listUsers();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("network-error");
  });

  it("login posts userId+pin and returns token+user on 200", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      token: "v4.local.abc",
      user: { userId: "alice", displayName: "Alice", isAdmin: true },
    }), { status: 200 }));
    const r = await createAuthApi("https://x").login("alice", "1234");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.token).toBe("v4.local.abc");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://x/api/v1/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userId: "alice", pin: "1234" }),
      }),
    );
  });

  it("login returns invalid-credentials on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "invalid-credentials" }), { status: 401 }));
    const r = await createAuthApi("https://x").login("alice", "0000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid-credentials");
  });

  it("setup returns conflict when 409", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "users-already-exist" }), { status: 409 }));
    const r = await createAuthApi("https://x").setup("Alice", "1234");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("conflict");
  });

  it("me returns user when token valid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      user: { userId: "alice", displayName: "Alice", isAdmin: true },
    }), { status: 200 }));
    const r = await createAuthApi("https://x").me("v4.local.abc");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.userId).toBe("alice");
  });

  it("me returns invalid-token on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "expired" }), { status: 401 }));
    const r = await createAuthApi("https://x").me("expired-token");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid-token");
  });
});
```

- [ ] **Step 3: Run, verify red**

```bash
bun run test gateway/webui/src/services/auth-api.test.ts
```

- [ ] **Step 4: Implement**

`gateway/webui/src/services/auth-api.ts`:

```ts
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "auth", "api"]);

export interface AuthUser {
  userId: string;
  displayName: string;
  isAdmin: boolean;
  avatarTint?: string;
}

export interface PublicUser {
  userId: string;
  displayName: string;
  avatarTint: string;
  isAdmin: boolean;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type ListUsersError = { kind: "network-error" } | { kind: "server-error"; status: number };
export type LoginError =
  | { kind: "network-error" }
  | { kind: "invalid-credentials" }
  | { kind: "server-error"; status: number };
export type SetupError =
  | { kind: "network-error" }
  | { kind: "conflict" }
  | { kind: "validation-error"; reason: string }
  | { kind: "server-error"; status: number };
export type MeError = { kind: "network-error" } | { kind: "invalid-token" } | { kind: "server-error"; status: number };

export interface AuthApi {
  listUsers(): Promise<Result<PublicUser[], ListUsersError>>;
  login(userId: string, pin: string): Promise<Result<{ token: string; user: AuthUser }, LoginError>>;
  setup(displayName: string, pin: string): Promise<Result<{ token: string; user: AuthUser }, SetupError>>;
  me(token: string): Promise<Result<AuthUser, MeError>>;
}

export function createAuthApi(baseUrl: string): AuthApi {
  return {
    async listUsers() {
      try {
        const r = await fetch(`${baseUrl}/api/v1/auth/users`);
        if (r.ok) {
          const body = await r.json();
          return { ok: true, value: body.users as PublicUser[] };
        }
        log.warn("listUsers.nonOk", { status: r.status });
        return { ok: false, error: { kind: "server-error", status: r.status } };
      } catch (err) {
        log.warn("listUsers.fetchError", { reason: err instanceof Error ? err.message : String(err) });
        return { ok: false, error: { kind: "network-error" } };
      }
    },
    async login(userId, pin) {
      try {
        const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, pin }),
        });
        if (r.ok) return { ok: true, value: await r.json() };
        if (r.status === 401) return { ok: false, error: { kind: "invalid-credentials" } };
        return { ok: false, error: { kind: "server-error", status: r.status } };
      } catch {
        return { ok: false, error: { kind: "network-error" } };
      }
    },
    async setup(displayName, pin) {
      try {
        const r = await fetch(`${baseUrl}/api/v1/auth/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName, pin }),
        });
        if (r.ok) return { ok: true, value: await r.json() };
        if (r.status === 409) return { ok: false, error: { kind: "conflict" } };
        if (r.status === 400) {
          const body = await r.json().catch(() => ({}));
          return { ok: false, error: { kind: "validation-error", reason: body.error ?? "invalid" } };
        }
        return { ok: false, error: { kind: "server-error", status: r.status } };
      } catch {
        return { ok: false, error: { kind: "network-error" } };
      }
    },
    async me(token) {
      try {
        const r = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) {
          const body = await r.json();
          return { ok: true, value: body.user as AuthUser };
        }
        if (r.status === 401) return { ok: false, error: { kind: "invalid-token" } };
        return { ok: false, error: { kind: "server-error", status: r.status } };
      } catch {
        return { ok: false, error: { kind: "network-error" } };
      }
    },
  };
}
```

- [ ] **Step 5: Run, verify green**

```bash
bun run test gateway/webui/src/services/auth-api.test.ts && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/services/auth-api.ts gateway/webui/src/services/auth-api.test.ts
git commit -m "feat(webui): auth-api client wrapping /api/v1/auth/* endpoints"
```

---

## Task 5.2: Auth context + localStorage token store

**Why:** App-wide auth state. One source of truth. On boot, hydrate from `localStorage`; if a token is present, validate via `/me` and either restore the session or clear and prompt re-login.

**Files:**
- Create: `gateway/webui/src/hooks/use-auth.tsx` (provider + hook in one file; <200 lines)
- Create: `gateway/webui/src/hooks/use-auth.test.tsx`
- Modify: `gateway/webui/src/constants.ts` — add `export const AUTH_STORAGE_KEY = "sentient:auth";`
- Modify: `gateway/webui/src/types.ts` — replace placeholder `AuthState` with the new shape

- [ ] **Step 1: Define `AuthState` (in `types.ts`)**

Replace the existing placeholder with:

```ts
import type { AuthUser } from "./services/auth-api.js";

export type AuthState =
  | { status: "boot" }                       // hydrating from localStorage
  | { status: "anonymous" }                   // no token, login required
  | { status: "authenticating" }              // fetch in flight
  | { status: "authenticated"; token: string; user: AuthUser }
  | { status: "failed"; reason: string };
```

If any other file imports the old `AuthState` shape, update those call sites. (The existing `auth-gate.tsx` is going to be deleted in Task 5.7 anyway; touch only what compiles.)

- [ ] **Step 2: Add the storage key constant**

```ts
// gateway/webui/src/constants.ts (append)
export const AUTH_STORAGE_KEY = "sentient:auth";
```

- [ ] **Step 3: Tests for the provider + hook**

`gateway/webui/src/hooks/use-auth.test.tsx`:

```tsx
/** @jsxImportSource preact */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/preact";
import { AuthProvider, useAuth } from "./use-auth.js";

const fakeApi = {
  listUsers: vi.fn(),
  login: vi.fn(),
  setup: vi.fn(),
  me: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  fakeApi.listUsers.mockReset();
  fakeApi.login.mockReset();
  fakeApi.setup.mockReset();
  fakeApi.me.mockReset();
});
afterEach(() => { localStorage.clear(); });

const wrapper = ({ children }: { children: any }) => (
  <AuthProvider api={fakeApi}>{children}</AuthProvider>
);

describe("useAuth", () => {
  it("starts in boot, transitions to anonymous when no token in storage", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.state.status).toBe("boot");
    await vi.waitFor(() => expect(result.current.state.status).toBe("anonymous"));
  });

  it("hydrates from localStorage and validates via /me", async () => {
    localStorage.setItem("sentient:auth", JSON.stringify({ token: "tok" }));
    fakeApi.me.mockResolvedValue({ ok: true, value: { userId: "alice", displayName: "Alice", isAdmin: true } });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await vi.waitFor(() => expect(result.current.state.status).toBe("authenticated"));
    if (result.current.state.status === "authenticated") {
      expect(result.current.state.token).toBe("tok");
      expect(result.current.state.user.userId).toBe("alice");
    }
  });

  it("clears localStorage and transitions to anonymous when stored token is invalid", async () => {
    localStorage.setItem("sentient:auth", JSON.stringify({ token: "bad" }));
    fakeApi.me.mockResolvedValue({ ok: false, error: { kind: "invalid-token" } });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await vi.waitFor(() => expect(result.current.state.status).toBe("anonymous"));
    expect(localStorage.getItem("sentient:auth")).toBeNull();
  });

  it("login success transitions to authenticated and persists token", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await vi.waitFor(() => expect(result.current.state.status).toBe("anonymous"));
    fakeApi.login.mockResolvedValue({ ok: true, value: { token: "tok", user: { userId: "alice", displayName: "Alice", isAdmin: true } } });
    await act(() => result.current.login("alice", "1234"));
    expect(result.current.state.status).toBe("authenticated");
    expect(JSON.parse(localStorage.getItem("sentient:auth")!).token).toBe("tok");
  });

  it("login failure stays anonymous and surfaces error", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await vi.waitFor(() => expect(result.current.state.status).toBe("anonymous"));
    fakeApi.login.mockResolvedValue({ ok: false, error: { kind: "invalid-credentials" } });
    const r = await act(() => result.current.login("alice", "0000"));
    expect(r.ok).toBe(false);
    expect(result.current.state.status).toBe("anonymous");
  });

  it("logout clears state and storage", async () => {
    localStorage.setItem("sentient:auth", JSON.stringify({ token: "tok" }));
    fakeApi.me.mockResolvedValue({ ok: true, value: { userId: "alice", displayName: "Alice", isAdmin: true } });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await vi.waitFor(() => expect(result.current.state.status).toBe("authenticated"));
    act(() => result.current.logout());
    expect(result.current.state.status).toBe("anonymous");
    expect(localStorage.getItem("sentient:auth")).toBeNull();
  });
});
```

- [ ] **Step 4: Run, verify red**

```bash
bun run test gateway/webui/src/hooks/use-auth.test.tsx
```

- [ ] **Step 5: Implement**

`gateway/webui/src/hooks/use-auth.tsx`:

```tsx
import { createContext } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { AUTH_STORAGE_KEY } from "../constants.js";
import type { AuthApi, AuthUser, LoginError, SetupError, Result } from "../services/auth-api.js";
import type { AuthState } from "../types.js";

const log = createLogger(["sentient", "webui", "auth", "context"]);

interface StoredAuth {
  token: string;
}

interface AuthContextValue {
  state: AuthState;
  login: (userId: string, pin: string) => Promise<Result<void, LoginError>>;
  setup: (displayName: string, pin: string) => Promise<Result<void, SetupError>>;
  logout: () => void;
}

const Ctx = createContext<AuthContextValue | null>(null);

interface ProviderProps {
  api: AuthApi;
  children: preact.ComponentChildren;
}

export function AuthProvider({ api, children }: ProviderProps) {
  const [state, setState] = useState<AuthState>({ status: "boot" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (raw === null) {
        if (!cancelled) setState({ status: "anonymous" });
        return;
      }
      let stored: StoredAuth;
      try {
        stored = JSON.parse(raw);
      } catch {
        log.warn("hydrate.parseFailed");
        localStorage.removeItem(AUTH_STORAGE_KEY);
        if (!cancelled) setState({ status: "anonymous" });
        return;
      }
      const r = await api.me(stored.token);
      if (cancelled) return;
      if (r.ok) {
        log.info("hydrate.ok", { userId: r.value.userId });
        setState({ status: "authenticated", token: stored.token, user: r.value });
      } else {
        log.info("hydrate.invalidToken", { reason: r.error.kind });
        localStorage.removeItem(AUTH_STORAGE_KEY);
        setState({ status: "anonymous" });
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const value: AuthContextValue = useMemo(() => ({
    state,
    async login(userId, pin) {
      setState({ status: "authenticating" });
      const r = await api.login(userId, pin);
      if (r.ok) {
        const token = r.value.token;
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token }));
        setState({ status: "authenticated", token, user: r.value.user });
        log.info("login.ok", { userId: r.value.user.userId });
        return { ok: true, value: undefined };
      }
      setState({ status: "anonymous" });
      log.warn("login.failed", { reason: r.error.kind });
      return { ok: false, error: r.error };
    },
    async setup(displayName, pin) {
      setState({ status: "authenticating" });
      const r = await api.setup(displayName, pin);
      if (r.ok) {
        const token = r.value.token;
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token }));
        setState({ status: "authenticated", token, user: r.value.user });
        log.info("setup.ok", { userId: r.value.user.userId });
        return { ok: true, value: undefined };
      }
      setState({ status: "anonymous" });
      log.warn("setup.failed", { reason: r.error.kind });
      return { ok: false, error: r.error };
    },
    logout() {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      setState({ status: "anonymous" });
      log.info("logout.done");
    },
  }), [state, api]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
```

- [ ] **Step 6: Run, verify green + typecheck**

```bash
bun run test gateway/webui/src/hooks/use-auth.test.tsx && bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add gateway/webui/src/hooks/use-auth.tsx gateway/webui/src/hooks/use-auth.test.tsx gateway/webui/src/constants.ts gateway/webui/src/types.ts
git commit -m "feat(webui): AuthProvider context + localStorage-backed token store"
```

---

## Task 5.3: Avatar tile + PIN pad primitives

**Why:** Both used in login. Avatar tile shows display name + tint dot; PIN pad is a 3×4 numpad with 4 ink circles above and auto-submit on the 4th digit.

**Files:**
- Create: `gateway/webui/src/components/auth/avatar-tile.tsx`
- Create: `gateway/webui/src/components/auth/avatar-tile.test.tsx`
- Create: `gateway/webui/src/components/auth/pin-pad.tsx`
- Create: `gateway/webui/src/components/auth/pin-pad.test.tsx`
- Modify: `gateway/webui/src/styles/components.css` (append `.avatar-tile`, `.pin-pad` blocks)

- [ ] **Step 1: Find any existing Avatar component**

```bash
grep -rln "function Avatar\|export.*Avatar" gateway/webui/src/components/
```

If an `Avatar` component already exists (the spec §6.2 mentions reusing one), import + reuse it inside `AvatarTile`. If not, the avatar visualization can be a simple round div with the user's first initial centered, background = `var(--color-{tint})` looked up from a small map. Either way, `AvatarTile` is the *clickable card* wrapper, not the avatar primitive itself.

- [ ] **Step 2: AvatarTile tests**

`gateway/webui/src/components/auth/avatar-tile.test.tsx`:

```tsx
/** @jsxImportSource preact */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { AvatarTile } from "./avatar-tile.js";

describe("AvatarTile", () => {
  it("renders display name and is keyboard-focusable", () => {
    render(<AvatarTile userId="alice" displayName="Alice" avatarTint="terra" onSelect={() => {}} />);
    const btn = screen.getByRole("button", { name: /alice/i });
    expect(btn).toBeTruthy();
    expect(btn.tabIndex).toBe(0);
  });

  it("calls onSelect with userId when clicked", () => {
    const onSelect = vi.fn();
    render(<AvatarTile userId="alice" displayName="Alice" avatarTint="terra" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /alice/i }));
    expect(onSelect).toHaveBeenCalledWith("alice");
  });

  it("calls onSelect on Enter key", () => {
    const onSelect = vi.fn();
    render(<AvatarTile userId="alice" displayName="Alice" avatarTint="terra" onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /alice/i }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("alice");
  });
});
```

- [ ] **Step 3: AvatarTile implementation**

```tsx
import type { JSX } from "preact";

interface Props {
  userId: string;
  displayName: string;
  avatarTint: string;
  onSelect: (userId: string) => void;
}

export function AvatarTile({ userId, displayName, avatarTint, onSelect }: Props): JSX.Element {
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  const handle = () => onSelect(userId);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handle();
    }
  };
  return (
    <button
      type="button"
      class="avatar-tile"
      onClick={handle}
      onKeyDown={onKey}
      aria-label={displayName}
    >
      <span class={`avatar-tile__circle avatar-tile__circle--tint-${avatarTint}`} aria-hidden="true">
        {initial}
      </span>
      <span class="avatar-tile__name">{displayName}</span>
    </button>
  );
}
```

- [ ] **Step 4: PinPad tests**

`gateway/webui/src/components/auth/pin-pad.test.tsx`:

```tsx
/** @jsxImportSource preact */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { PinPad } from "./pin-pad.js";

describe("PinPad", () => {
  it("renders 10 digit buttons (0-9) plus delete", () => {
    render(<PinPad onSubmit={() => {}} />);
    for (let i = 0; i < 10; i++) {
      expect(screen.getByRole("button", { name: String(i) })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: /delete/i })).toBeTruthy();
  });

  it("auto-submits when the 4th digit is entered", () => {
    const onSubmit = vi.fn();
    render(<PinPad onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    expect(onSubmit).toHaveBeenCalledWith("1234");
  });

  it("delete removes the last digit and does not submit", () => {
    const onSubmit = vi.fn();
    render(<PinPad onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ignores additional digit presses after submit until reset", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<PinPad onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    rerender(<PinPad onSubmit={onSubmit} resetSignal={1} />);
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    expect(onSubmit).toHaveBeenCalledTimes(1); // still 1 — pin starts at "9", not yet submitted
  });

  it("renders 4 ink circles, filled per typed digit count", () => {
    render(<PinPad onSubmit={() => {}} />);
    const dots = document.querySelectorAll(".pin-pad__dot");
    expect(dots.length).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(document.querySelectorAll(".pin-pad__dot--filled").length).toBe(2);
  });
});
```

- [ ] **Step 5: PinPad implementation**

```tsx
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";

const PIN_LENGTH = 4;
const KEYPAD: Array<string | "delete" | null> = [
  "1", "2", "3",
  "4", "5", "6",
  "7", "8", "9",
  null, "0", "delete",
];

interface Props {
  onSubmit: (pin: string) => void;
  /** Bump this number to clear the entered digits (e.g. after a wrong-PIN error). */
  resetSignal?: number;
}

export function PinPad({ onSubmit, resetSignal = 0 }: Props): JSX.Element {
  const [pin, setPin] = useState("");

  useEffect(() => { setPin(""); }, [resetSignal]);

  useEffect(() => {
    if (pin.length === PIN_LENGTH) {
      onSubmit(pin);
    }
  }, [pin, onSubmit]);

  const press = (key: string | "delete") => {
    if (pin.length >= PIN_LENGTH && key !== "delete") return;
    if (key === "delete") {
      setPin((p) => p.slice(0, -1));
    } else {
      setPin((p) => p + key);
    }
  };

  return (
    <div class="pin-pad" role="group" aria-label="PIN entry">
      <div class="pin-pad__dots" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} class={`pin-pad__dot ${i < pin.length ? "pin-pad__dot--filled" : ""}`} />
        ))}
      </div>
      <div class="pin-pad__keys">
        {KEYPAD.map((key, i) => key === null ? (
          <span key={i} class="pin-pad__key pin-pad__key--blank" aria-hidden="true" />
        ) : (
          <button
            key={i}
            type="button"
            class={`pin-pad__key ${key === "delete" ? "pin-pad__key--delete" : ""}`}
            onClick={() => press(key)}
            aria-label={key === "delete" ? "Delete" : key}
          >
            {key === "delete" ? "⌫" : key}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Append CSS to `gateway/webui/src/styles/components.css`**

Add (using existing tokens; sample values illustrative — pick what matches the warm palette):

```css
.avatar-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-md);
  background: var(--color-bg-elev);
  border: 0;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: transform var(--motion-fast), background var(--motion-fast);
}
.avatar-tile:hover { transform: translateY(-2px); background: var(--color-paper); }
.avatar-tile__circle {
  display: grid;
  place-items: center;
  width: 64px; height: 64px;
  border-radius: 50%;
  font-family: var(--font-display);
  font-size: 1.5rem;
  color: var(--color-ink);
}
.avatar-tile__circle--tint-terra { background: var(--color-accent); }
.avatar-tile__circle--tint-sage { background: var(--color-sage); }
.avatar-tile__circle--tint-amber { background: var(--color-amber); }
.avatar-tile__circle--tint-clay { background: var(--color-clay); }
.avatar-tile__name {
  font-family: var(--font-body);
  color: var(--color-ink);
  font-size: 0.95rem;
}

.pin-pad { display: flex; flex-direction: column; align-items: center; gap: var(--space-lg); }
.pin-pad__dots { display: flex; gap: var(--space-sm); }
.pin-pad__dot {
  width: 14px; height: 14px;
  border-radius: 50%;
  background: var(--color-bg);
  border: 2px solid var(--color-ink);
}
.pin-pad__dot--filled { background: var(--color-ink); }
.pin-pad__keys {
  display: grid;
  grid-template-columns: repeat(3, 80px);
  gap: var(--space-sm);
}
.pin-pad__key {
  height: 80px;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-bg-elev);
  color: var(--color-ink);
  font-family: var(--font-body);
  font-size: 1.5rem;
  cursor: pointer;
}
.pin-pad__key:hover { background: var(--color-paper); }
.pin-pad__key--blank { background: transparent; pointer-events: none; }
.pin-pad__key--delete { font-size: 1.2rem; }
.pin-pad--shake { animation: pin-pad-shake var(--motion-fast) 2; }
@keyframes pin-pad-shake { 0%,100% {transform: translateX(0);} 50% {transform: translateX(8px);} }
```

If a token name doesn't exist in `tokens/*.css`, use the closest one that does — do not invent new tokens.

- [ ] **Step 7: Run, verify green**

```bash
bun run test gateway/webui/src/components/auth/ && bun run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add gateway/webui/src/components/auth/ gateway/webui/src/styles/components.css
git commit -m "feat(webui): AvatarTile + PinPad primitives for login flow"
```

---

## Task 5.4: Login screen (avatar grid → PIN pad)

**Why:** Two-stage login per spec §6.2. Stage 1 picks an avatar, stage 2 enters the PIN. Wrong PIN shakes the pad and clears it; no lockout.

**Files:**
- Create: `gateway/webui/src/components/auth/login-screen.tsx`
- Create: `gateway/webui/src/components/auth/login-screen.test.tsx`

- [ ] **Step 1: Tests**

```tsx
/** @jsxImportSource preact */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { LoginScreen } from "./login-screen.js";

const fakeApi = { listUsers: vi.fn(), login: vi.fn(), setup: vi.fn(), me: vi.fn() };
const fakeAuth = {
  state: { status: "anonymous" } as any,
  login: vi.fn(),
  setup: vi.fn(),
  logout: vi.fn(),
};

beforeEach(() => {
  fakeApi.listUsers.mockReset();
  fakeAuth.login.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

const SAMPLE = [
  { userId: "alice", displayName: "Alice", avatarTint: "terra", isAdmin: true },
  { userId: "bob", displayName: "Bob", avatarTint: "sage", isAdmin: false },
];

describe("LoginScreen", () => {
  it("fetches and renders the avatar grid on mount", async () => {
    fakeApi.listUsers.mockResolvedValue({ ok: true, value: SAMPLE });
    render(<LoginScreen api={fakeApi} auth={fakeAuth as any} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /alice/i })).toBeTruthy());
    expect(screen.getByRole("button", { name: /bob/i })).toBeTruthy();
  });

  it("clicking an avatar reveals the PIN pad", async () => {
    fakeApi.listUsers.mockResolvedValue({ ok: true, value: SAMPLE });
    render(<LoginScreen api={fakeApi} auth={fakeAuth as any} />);
    await waitFor(() => screen.getByRole("button", { name: /alice/i }));
    fireEvent.click(screen.getByRole("button", { name: /alice/i }));
    expect(screen.getByRole("group", { name: /pin entry/i })).toBeTruthy();
  });

  it("submits PIN to auth.login, on success the screen unmounts (auth state changes)", async () => {
    fakeApi.listUsers.mockResolvedValue({ ok: true, value: SAMPLE });
    fakeAuth.login.mockResolvedValue({ ok: true, value: undefined });
    render(<LoginScreen api={fakeApi} auth={fakeAuth as any} />);
    await waitFor(() => screen.getByRole("button", { name: /alice/i }));
    fireEvent.click(screen.getByRole("button", { name: /alice/i }));
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    await waitFor(() => expect(fakeAuth.login).toHaveBeenCalledWith("alice", "1234"));
  });

  it("on invalid-credentials, surfaces wrong-PIN message and triggers shake reset", async () => {
    fakeApi.listUsers.mockResolvedValue({ ok: true, value: SAMPLE });
    fakeAuth.login.mockResolvedValue({ ok: false, error: { kind: "invalid-credentials" } });
    render(<LoginScreen api={fakeApi} auth={fakeAuth as any} />);
    await waitFor(() => screen.getByRole("button", { name: /alice/i }));
    fireEvent.click(screen.getByRole("button", { name: /alice/i }));
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    await waitFor(() => expect(screen.getByText(/wrong pin/i)).toBeTruthy());
  });

  it("Back link returns to avatar grid", async () => {
    fakeApi.listUsers.mockResolvedValue({ ok: true, value: SAMPLE });
    render(<LoginScreen api={fakeApi} auth={fakeAuth as any} />);
    await waitFor(() => screen.getByRole("button", { name: /alice/i }));
    fireEvent.click(screen.getByRole("button", { name: /alice/i }));
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.queryByRole("group", { name: /pin entry/i })).toBeNull();
    expect(screen.getByRole("button", { name: /alice/i })).toBeTruthy();
  });

  it("renders an empty-state when listUsers returns []", async () => {
    fakeApi.listUsers.mockResolvedValue({ ok: true, value: [] });
    render(<LoginScreen api={fakeApi} auth={fakeAuth as any} />);
    await waitFor(() => expect(screen.getByText(/no accounts/i)).toBeTruthy());
  });

  it("renders network-error state when listUsers fails", async () => {
    fakeApi.listUsers.mockResolvedValue({ ok: false, error: { kind: "network-error" } });
    render(<LoginScreen api={fakeApi} auth={fakeAuth as any} />);
    await waitFor(() => expect(screen.getByText(/can't reach the gateway/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Implementation**

```tsx
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { JSX } from "preact";
import type { AuthApi, PublicUser } from "../../services/auth-api.js";
import { AvatarTile } from "./avatar-tile.js";
import { PinPad } from "./pin-pad.js";

const log = createLogger(["sentient", "webui", "auth", "login-screen"]);

interface AuthLike {
  login: (userId: string, pin: string) => Promise<{ ok: boolean; error?: { kind: string } }>;
}

interface Props {
  api: AuthApi;
  auth: AuthLike;
}

type View =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; reason: "network" | "server" }
  | { kind: "avatars"; users: PublicUser[] }
  | { kind: "pin"; user: PublicUser; wrongPinSignal: number; busy: boolean };

export function LoginScreen({ api, auth }: Props): JSX.Element {
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await api.listUsers();
      if (cancelled) return;
      if (!r.ok) {
        setView({ kind: "error", reason: r.error.kind === "network-error" ? "network" : "server" });
        return;
      }
      if (r.value.length === 0) {
        setView({ kind: "empty" });
        return;
      }
      setView({ kind: "avatars", users: r.value });
    })();
    return () => { cancelled = true; };
  }, [api]);

  const onPinSubmit = async (pin: string) => {
    if (view.kind !== "pin") return;
    const userId = view.user.userId;
    setView({ ...view, busy: true });
    const r = await auth.login(userId, pin);
    if (r.ok) {
      log.info("login.submit.ok", { userId });
      // Component will unmount when AuthProvider state flips to authenticated.
      return;
    }
    log.warn("login.submit.failed", { userId, reason: r.error?.kind });
    setView({ ...view, wrongPinSignal: view.wrongPinSignal + 1, busy: false });
  };

  if (view.kind === "loading") return <Card><p>Loading…</p></Card>;
  if (view.kind === "empty") return <Card><h1>No accounts</h1><p>The gateway has no users yet. Run setup to create the first one.</p></Card>;
  if (view.kind === "error") return <Card><h1>Connection problem</h1><p>{view.reason === "network" ? "Can't reach the gateway." : "The gateway returned an error. Try again."}</p></Card>;

  if (view.kind === "avatars") {
    return (
      <Card>
        <h1 class="login-screen__title">Who's signing in?</h1>
        <div class="login-screen__grid">
          {view.users.map((u) => (
            <AvatarTile key={u.userId} userId={u.userId} displayName={u.displayName} avatarTint={u.avatarTint}
              onSelect={(id) => setView({ kind: "pin", user: view.users.find((x) => x.userId === id)!, wrongPinSignal: 0, busy: false })} />
          ))}
        </div>
      </Card>
    );
  }

  // pin view
  return (
    <Card>
      <h1 class="login-screen__title">Hi, {view.user.displayName}</h1>
      <PinPad onSubmit={onPinSubmit} resetSignal={view.wrongPinSignal} />
      {view.wrongPinSignal > 0 && <p class="login-screen__error">Wrong PIN</p>}
      <button type="button" class="login-screen__back" onClick={() => setView({ kind: "avatars", users: [view.user] /* dummy; refetch happens on remount if needed */ })}>← Back</button>
    </Card>
  );
}

function Card({ children }: { children: preact.ComponentChildren }): JSX.Element {
  return (
    <div class="login-screen">
      <section class="settings-panel login-screen__card">
        {children}
      </section>
    </div>
  );
}
```

(The `Back` handler above is intentionally simple; if needed, persist the original users list in state instead of the dummy one.)

- [ ] **Step 3: Append CSS**

```css
.login-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--color-bg);
}
.login-screen__card { width: 420px; max-width: 90vw; padding: var(--space-xl); text-align: center; }
.login-screen__title { font-family: var(--font-display); margin-bottom: var(--space-lg); }
.login-screen__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-md); }
.login-screen__error { color: var(--color-stop, var(--color-clay)); margin-top: var(--space-sm); }
.login-screen__back { background: none; border: 0; color: var(--color-ink); margin-top: var(--space-md); cursor: pointer; }
```

- [ ] **Step 4: Run, verify green**

```bash
bun run test gateway/webui/src/components/auth/login-screen.test.tsx && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/components/auth/login-screen.tsx gateway/webui/src/components/auth/login-screen.test.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): LoginScreen with avatar grid + PIN pad stages"
```

---

## Task 5.5: Setup screen (first-run only)

**Why:** Empty `users.json` → setup. Single form: display name + PIN + confirm PIN → calls `/api/v1/auth/setup` → seeds first admin.

**Files:**
- Create: `gateway/webui/src/components/auth/setup-screen.tsx`
- Create: `gateway/webui/src/components/auth/setup-screen.test.tsx`

- [ ] **Step 1: Tests**

```tsx
/** @jsxImportSource preact */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { SetupScreen } from "./setup-screen.js";

const auth = { setup: vi.fn(), login: vi.fn(), logout: vi.fn(), state: { status: "anonymous" } as any };

describe("SetupScreen", () => {
  it("renders display name + PIN + confirm fields", () => {
    render(<SetupScreen auth={auth as any} />);
    expect(screen.getByLabelText(/display name/i)).toBeTruthy();
    expect(screen.getByLabelText(/^pin$/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm pin/i)).toBeTruthy();
  });

  it("disables submit until name + matching 4-digit PINs", () => {
    render(<SetupScreen auth={auth as any} />);
    const submit = screen.getByRole("button", { name: /create/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(screen.getByLabelText(/display name/i), { target: { value: "Alice" } });
    fireEvent.input(screen.getByLabelText(/^pin$/i), { target: { value: "1234" } });
    fireEvent.input(screen.getByLabelText(/confirm pin/i), { target: { value: "1233" } });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(screen.getByLabelText(/confirm pin/i), { target: { value: "1234" } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls auth.setup on submit and surfaces conflict error", async () => {
    auth.setup.mockResolvedValue({ ok: false, error: { kind: "conflict" } });
    render(<SetupScreen auth={auth as any} />);
    fireEvent.input(screen.getByLabelText(/display name/i), { target: { value: "Alice" } });
    fireEvent.input(screen.getByLabelText(/^pin$/i), { target: { value: "1234" } });
    fireEvent.input(screen.getByLabelText(/confirm pin/i), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(auth.setup).toHaveBeenCalledWith("Alice", "1234"));
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Implementation**

```tsx
import { useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { JSX } from "preact";

const log = createLogger(["sentient", "webui", "auth", "setup-screen"]);

interface AuthLike {
  setup: (displayName: string, pin: string) => Promise<{ ok: boolean; error?: { kind: string; reason?: string } }>;
}

interface Props { auth: AuthLike; }

const PIN_DIGITS_RE = /^\d{4}$/;

export function SetupScreen({ auth }: Props): JSX.Element {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = name.trim().length > 0 && PIN_DIGITS_RE.test(pin) && pin === confirm;

  const onSubmit = async (ev: Event) => {
    ev.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setErr(null);
    const r = await auth.setup(name.trim(), pin);
    setBusy(false);
    if (!r.ok) {
      log.warn("setup.failed", { kind: r.error?.kind });
      if (r.error?.kind === "conflict") setErr("An admin already exists. Reload and use Login.");
      else if (r.error?.kind === "validation-error") setErr(r.error.reason ?? "Invalid input.");
      else setErr("Couldn't reach the gateway. Try again.");
    }
  };

  return (
    <div class="setup-screen">
      <section class="settings-panel setup-screen__card">
        <h1>Welcome</h1>
        <p>Create the first account. This account will be an admin.</p>
        <form onSubmit={onSubmit} class="setup-screen__form">
          <label>
            <span>Display name</span>
            <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={32} required />
          </label>
          <label>
            <span>PIN</span>
            <input type="password" inputMode="numeric" pattern="\d{4}" value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value)} maxLength={4} />
          </label>
          <label>
            <span>Confirm PIN</span>
            <input type="password" inputMode="numeric" pattern="\d{4}" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} maxLength={4} />
          </label>
          {err !== null && <p class="setup-screen__error">{err}</p>}
          <button type="submit" disabled={!valid || busy}>{busy ? "Creating…" : "Create account"}</button>
        </form>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Append CSS**

```css
.setup-screen { min-height: 100vh; display: grid; place-items: center; background: var(--color-bg); }
.setup-screen__card { width: 420px; max-width: 90vw; padding: var(--space-xl); }
.setup-screen__form { display: flex; flex-direction: column; gap: var(--space-md); }
.setup-screen__form label { display: flex; flex-direction: column; gap: var(--space-xs); }
.setup-screen__form input { padding: var(--space-sm); border-radius: var(--radius-md); border: 1px solid var(--color-paper); background: var(--color-bg-elev); color: var(--color-ink); font-family: var(--font-body); }
.setup-screen__error { color: var(--color-stop, var(--color-clay)); }
```

- [ ] **Step 4: Run, verify green**

```bash
bun run test gateway/webui/src/components/auth/setup-screen.test.tsx && bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/components/auth/setup-screen.tsx gateway/webui/src/components/auth/setup-screen.test.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): SetupScreen for first-run admin creation"
```

---

## Task 5.6: Topbar user menu (avatar + popover)

**Why:** Spec §6.3 — "Avatar + display name on right side of topbar; click → popover with My Account + Log out." Phase 5 wires Log out only; My Account routes to settings (Phase 6 builds that tab).

**Files:**
- Create: `gateway/webui/src/components/shell/user-menu.tsx`
- Create: `gateway/webui/src/components/shell/user-menu.test.tsx`
- Modify: `gateway/webui/src/components/shell/topbar.tsx` — append `<UserMenu>` after the existing icon buttons (or wherever the spec card-line implies; right-aligned).
- Append CSS to `components.css`.

- [ ] **Step 1: UserMenu tests**

```tsx
/** @jsxImportSource preact */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { UserMenu } from "./user-menu.js";

const user = { userId: "alice", displayName: "Alice", isAdmin: true, avatarTint: "terra" } as any;

describe("UserMenu", () => {
  it("renders the trigger button with the display name", () => {
    render(<UserMenu user={user} onLogout={() => {}} onOpenAccount={() => {}} />);
    expect(screen.getByRole("button", { name: /alice/i })).toBeTruthy();
  });

  it("opens the popover on click and shows logout + my-account", () => {
    render(<UserMenu user={user} onLogout={() => {}} onOpenAccount={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /alice/i }));
    expect(screen.getByRole("menuitem", { name: /my account/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /log out/i })).toBeTruthy();
  });

  it("invokes onLogout and closes popover on Log out click", () => {
    const onLogout = vi.fn();
    render(<UserMenu user={user} onLogout={onLogout} onOpenAccount={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /alice/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /log out/i }));
    expect(onLogout).toHaveBeenCalled();
    expect(screen.queryByRole("menuitem", { name: /log out/i })).toBeNull();
  });

  it("closes when Escape is pressed", () => {
    render(<UserMenu user={user} onLogout={() => {}} onOpenAccount={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /alice/i }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: /log out/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Implementation**

```tsx
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { AuthUser } from "../../services/auth-api.js";

interface Props {
  user: AuthUser;
  onLogout: () => void;
  onOpenAccount: () => void;
}

export function UserMenu({ user, onLogout, onOpenAccount }: Props): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const initial = user.displayName.charAt(0).toUpperCase();
  const tintClass = user.avatarTint ? ` user-menu__avatar--tint-${user.avatarTint}` : "";

  return (
    <div class="user-menu">
      <button type="button" class="user-menu__trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span class={`user-menu__avatar${tintClass}`} aria-hidden="true">{initial}</span>
        <span class="user-menu__name">{user.displayName}</span>
      </button>
      {open && (
        <div class="user-menu__popover" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenAccount(); }}>My Account</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onLogout(); }}>Log out</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Topbar wiring**

In `gateway/webui/src/components/shell/topbar.tsx`, accept `user`, `onLogout`, `onOpenAccount` props (optional — when absent, omit the `<UserMenu>`). Render after the existing icon buttons. Do NOT remove or refactor any of the existing topbar elements.

- [ ] **Step 4: CSS**

```css
.user-menu { position: relative; }
.user-menu__trigger { display: inline-flex; align-items: center; gap: var(--space-sm); background: none; border: 0; cursor: pointer; color: var(--color-ink); }
.user-menu__avatar {
  display: grid; place-items: center;
  width: 32px; height: 32px;
  border-radius: 50%;
  font-family: var(--font-display);
}
.user-menu__avatar--tint-terra { background: var(--color-accent); }
.user-menu__avatar--tint-sage { background: var(--color-sage); }
.user-menu__avatar--tint-amber { background: var(--color-amber); }
.user-menu__avatar--tint-clay { background: var(--color-clay); }
.user-menu__popover {
  position: absolute; right: 0; top: calc(100% + var(--space-xs));
  background: var(--color-paper);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-elev);
  min-width: 160px;
  display: flex; flex-direction: column;
}
.user-menu__popover button { background: none; border: 0; padding: var(--space-sm) var(--space-md); text-align: left; color: var(--color-ink); cursor: pointer; }
.user-menu__popover button:hover { background: var(--color-bg-elev); }
```

- [ ] **Step 5: Run, verify green**

```bash
bun run test gateway/webui/src/components/shell/ && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/components/shell/user-menu.tsx gateway/webui/src/components/shell/user-menu.test.tsx gateway/webui/src/components/shell/topbar.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): topbar user menu (avatar + popover with My Account + Log out)"
```

---

## Task 5.7: App shell — extend route union, gate on auth state, delete `auth-gate.tsx`

**Why:** This is where everything composes. `app.tsx` wraps in `<AuthProvider>`, decides between setup / login / chat / settings based on auth state, hides topbar on setup/login, and deletes the obsolete `auth-gate.tsx`.

**Files:**
- Modify: `gateway/webui/src/app.tsx`
- Modify: `gateway/webui/src/main.tsx` (to wrap `<AuthProvider>`)
- Delete: `gateway/webui/src/components/auth-gate.tsx` and `auth-gate.test.tsx`
- Add: `gateway/webui/src/app.test.tsx` (smoke test for the routing decision)

- [ ] **Step 1: Plan the routing decision**

```ts
type Route = "setup" | "login" | "chat" | "settings";

function chooseRoute(authState: AuthState, hasAnyUser: boolean | null): Route {
  if (authState.status === "boot") return "login"; // hide topbar; show loading inside login
  if (authState.status === "authenticated") return loadStoredRoute() ?? "chat";
  // anonymous
  if (hasAnyUser === false) return "setup";
  return "login";
}
```

`hasAnyUser` is determined by a single `api.listUsers()` call at boot, cached in app state.

- [ ] **Step 2: Smoke test for `App`**

`gateway/webui/src/app.test.tsx`:

```tsx
/** @jsxImportSource preact */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/preact";
import { App } from "./app.js";

// helper: mocked api
const apiWithUsers = (users: any[]) => ({
  listUsers: vi.fn().mockResolvedValue({ ok: true, value: users }),
  login: vi.fn(), setup: vi.fn(),
  me: vi.fn().mockResolvedValue({ ok: false, error: { kind: "invalid-token" } }),
});

describe("App routing", () => {
  it("renders SetupScreen when users.json is empty and no token", async () => {
    localStorage.clear();
    render(<App apiOverride={apiWithUsers([])} />);
    await waitFor(() => expect(screen.getByText(/welcome/i)).toBeTruthy());
  });

  it("renders LoginScreen when users exist and no token", async () => {
    localStorage.clear();
    render(<App apiOverride={apiWithUsers([{ userId: "alice", displayName: "Alice", avatarTint: "terra", isAdmin: true }])} />);
    await waitFor(() => expect(screen.getByText(/who's signing in/i)).toBeTruthy());
  });

  it("renders ChatView when token present and valid", async () => {
    localStorage.setItem("sentient:auth", JSON.stringify({ token: "tok" }));
    const api = apiWithUsers([]);
    api.me = vi.fn().mockResolvedValue({ ok: true, value: { userId: "alice", displayName: "Alice", isAdmin: true } });
    render(<App apiOverride={api} />);
    await waitFor(() => expect(screen.queryByText(/who's signing in/i)).toBeNull());
    // Smoke: ChatView's existing content should be visible. Pick one stable element from ChatView.
  });
});
```

(If `ChatView` doesn't expose a stable test landmark, just assert the absence of the login screen — that's sufficient as a routing smoke.)

- [ ] **Step 3: Implementation outline**

`app.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import { AuthProvider, useAuth } from "./hooks/use-auth.js";
import { createAuthApi, type AuthApi } from "./services/auth-api.js";
import { LoginScreen } from "./components/auth/login-screen.js";
import { SetupScreen } from "./components/auth/setup-screen.js";
import { Topbar } from "./components/shell/topbar.js";
import { ChatView } from "./components/chat/chat-view.js"; // existing
import { SettingsView } from "./components/settings/settings-view.js"; // existing

const apiSingleton = createAuthApi(`${window.location.protocol}//${window.location.host}`);

interface AppProps { apiOverride?: AuthApi; }

export function App({ apiOverride }: AppProps = {}) {
  const api = apiOverride ?? apiSingleton;
  return (
    <AuthProvider api={api}>
      <AppInner api={api} />
    </AuthProvider>
  );
}

function AppInner({ api }: { api: AuthApi }) {
  const auth = useAuth();
  const [hasAnyUser, setHasAnyUser] = useState<boolean | null>(null);
  const [route, setRoute] = useState<"chat" | "settings">("chat");

  useEffect(() => {
    if (hasAnyUser !== null) return;
    if (auth.state.status !== "anonymous") return;
    (async () => {
      const r = await api.listUsers();
      setHasAnyUser(r.ok ? r.value.length > 0 : true); // default to login on error
    })();
  }, [auth.state.status, api, hasAnyUser]);

  if (auth.state.status === "boot") return <LoginScreen api={api} auth={auth} />;
  if (auth.state.status !== "authenticated") {
    if (hasAnyUser === false) return <SetupScreen auth={auth} />;
    return <LoginScreen api={api} auth={auth} />;
  }

  return (
    <div class="app-shell">
      <Topbar
        route={route}
        onRouteChange={setRoute}
        user={auth.state.user}
        onLogout={() => auth.logout()}
        onOpenAccount={() => setRoute("settings")}
        /* existing topbar props pass through unchanged */
      />
      {route === "chat" ? <ChatView /> : <SettingsView />}
    </div>
  );
}
```

(Adjust to match the actual `Topbar` and `ChatView` prop signatures already in `app.tsx`.)

- [ ] **Step 4: Wrap in `main.tsx`**

`main.tsx` already mounts `<App />`; nothing to do here unless `AuthProvider` needs to wrap something outside `<App />`. Default is to keep `AuthProvider` inside `App` per the implementation above.

- [ ] **Step 5: Delete `auth-gate.tsx`**

```bash
git rm gateway/webui/src/components/auth-gate.tsx gateway/webui/src/components/auth-gate.test.tsx
grep -rn "auth-gate\|AuthGate" gateway/webui/src/ || echo "no references — safe"
```

If grep finds references, remove them too (they're stale).

- [ ] **Step 6: Run all webui tests + typecheck**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 7: Commit**

```bash
git add -A gateway/webui/src/
git commit -m "feat(webui): app shell gates on auth state; routes setup/login/chat; remove auth-gate"
```

---

## Task 5.8: SDK — send `{type:"auth", token}` as the first WS frame

**Why:** Phase 1+2 added the gateway-side WS auth gate (close on missing/invalid first message within 5s). The web SDK currently receives a token but doesn't send the auth frame. This is the only file outside `gateway/webui/` we touch.

**Files (read first to scope your changes):**
- `shared/web-sdk/src/sdk.ts` (or wherever the SDK's WS connect lives — confirm via `grep -rn "new WebSocket\|class SentientSDK" shared/web-sdk/src/`)
- The matching test file in `shared/web-sdk/src/`

- [ ] **Step 1: Locate the WS open handler**

```bash
grep -rn "WebSocket\|connect\|onopen\|on('open')\|addEventListener('open'" shared/web-sdk/src/ | head -20
```

Identify the single function that owns the WS lifecycle. The change is local to that function.

- [ ] **Step 2: Write the failing test**

If a test for the SDK's WS connect already exists, add a new `it` block. Otherwise create a new test file colocated with the SDK source.

```ts
import { describe, expect, it, vi } from "vitest";
import { SentientSDK } from "./sdk.js";

describe("SentientSDK auth handshake", () => {
  it("sends {type:'auth', token} as the first WS message after open", async () => {
    const sent: string[] = [];
    const fakeWs = {
      readyState: 0,
      send: vi.fn((data: string) => { sent.push(data); }),
      close: vi.fn(),
      addEventListener: vi.fn((ev: string, fn: any) => {
        if (ev === "open") setTimeout(() => fn(), 0);
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("WebSocket", vi.fn(() => fakeWs));
    const sdk = new SentientSDK({ url: "wss://x", token: "v4.local.abc" /* …other required opts */ });
    await sdk.connect();
    expect(sent[0]).toBe(JSON.stringify({ type: "auth", token: "v4.local.abc" }));
  });

  it("resolves connect() only after receiving {type:'auth.ok'}", async () => {
    // Use a controlled message stream; assert connect() promise pends until auth.ok arrives.
    // Implementation detail: depending on the SDK shape this may be a separate ready event.
    // If the existing SDK doesn't expose this, document the gap and propose a follow-up.
  });
});
```

(The second test is aspirational — if the SDK currently resolves `connect()` synchronously after WS open, the spec §4.4 implies it should wait for `auth.ok`. If implementing that requires invasive changes, scope this task to send-the-frame only and surface "wait-for-ack" as a follow-up.)

- [ ] **Step 3: Implement the minimal change**

In the SDK's open handler, immediately before any other application traffic, send:

```ts
ws.send(JSON.stringify({ type: "auth", token: this.token }));
```

Add a `log.info("ws.auth.sent", { tokenPreview: this.token.slice(0, 8) })` call.

- [ ] **Step 4: Run SDK tests + typecheck (root)**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 5: Verify the gateway accepts the handshake (manual smoke)**

If `hermes-alice`/gateway containers are running locally, open the browser at `https://localhost:8888/` (or wherever the dev server serves the webui), open DevTools network tab, observe the first WS message contains `{"type":"auth","token":"…"}` and that the gateway responds `{"type":"auth.ok"}`.

If the manual step can't be performed in the autonomous run, mark `DONE_WITH_CONCERNS: implementation complete + unit tests green; manual browser verification deferred to operator`.

- [ ] **Step 6: Commit**

```bash
git add shared/web-sdk/src/
git commit -m "feat(web-sdk): send {type:auth,token} as first WS frame for gateway auth gate"
```

---

## Task 5.9: End-to-end manual smoke checklist (no commit)

**Why:** Vitest can't drive a real browser end-to-end with a live gateway. Run this checklist by hand before reporting Phase 5 complete.

- [ ] Setup flow:
  1. `mv ~/.sentient/gateway/users.json ~/.sentient/gateway/users.json.bak` (preserve)
  2. Restart gateway: `docker compose restart gateway`
  3. Open `https://localhost:8888/`. Expect setup screen (no topbar).
  4. Enter display name "Alice", PIN "1234", confirm "1234". Submit.
  5. Expect transition to chat view; topbar shows "A" avatar + "Alice".
  6. DevTools → Application → Local Storage → key `sentient:auth` exists with a token.

- [ ] Login flow:
  1. Click avatar → "Log out" → expect login screen with avatar grid.
  2. Click Alice → PIN pad appears.
  3. Type wrong PIN "9999" → shake animation + "Wrong PIN" text.
  4. Type correct PIN "1234" → chat view appears.

- [ ] WS auth handshake:
  1. DevTools → Network → WS → `wss://localhost:8888/api/v1/ws`.
  2. First frame from client: `{"type":"auth","token":"v4.local…"}`.
  3. First frame from gateway: `{"type":"auth.ok"}`.
  4. Then normal cycle dispatches.

- [ ] Restore: `mv ~/.sentient/gateway/users.json.bak ~/.sentient/gateway/users.json` (only if you preserved). Otherwise leave the new admin in place.

Report `DONE` with the checklist results pasted into the status message.

---

## Phase 5 Acceptance

When all 9 tasks are complete the controller verifies:

- [ ] `bun run typecheck` clean.
- [ ] `bun run test` clean.
- [ ] Git log on `feature/multi-user-phase5-webui-auth` shows roughly 8 feat/test commits, no `--no-verify`.
- [ ] No edits to `gateway/src/`, `lefthook.yml`, `package.json`, `tsconfig.json`, or `gateway/webui/src/components/settings/`.
- [ ] `auth-gate.tsx` and `auth-gate.test.tsx` are deleted.
- [ ] Manual browser smoke (Task 5.9) passes the three flows: setup, login, WS auth.

When green, the operator merges `feature/multi-user-phase5-webui-auth` into `feature/multi-user-auth-and-settings` (or the integration branch agreed for the demo). Phase 5 unblocks Phase 6 (My Agent + My Account settings tabs).

---

## Out of Scope (do NOT touch)

- Any code under `gateway/webui/src/components/settings/` (Phase 6 territory).
- The apply-flow UI / spinner-overlay / toast components (Phase 6).
- Any catalog dropdown (model picker, voice picker — Phase 6).
- Admin panel UI (Phase 7).
- Per-user settings persistence (Phase 6).
- Replacing the SDK's WS reconnect logic (only the first-message change is in scope).
- New CSS framework or design tokens.

If you find yourself wanting to edit any of the above, stop and surface to the controller.
