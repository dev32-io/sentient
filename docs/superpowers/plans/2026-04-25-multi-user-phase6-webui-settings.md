# Phase 6 — Webui My Agent + My Account + Apply UX

> **For agentic workers:** REQUIRED SUB-SKILLS:
> - `superpowers:using-git-worktrees` — Task 6.0 invokes this to create the isolated worktree.
> - `superpowers:subagent-driven-development` — drives the implementation tasks task-by-task.
>
> Steps use checkbox (`- [ ]`) syntax. **READ TASK 6.0 FIRST** — set up the worktree before any other task.

**Goal:** Ship the per-user settings tabs (My Agent + My Account), the missing self-service profile/auth endpoints, the spinner-overlay + toast UI primitives, and end-to-end apply-flow integration. After this phase, a logged-in user can edit their persona / voice / model / tools, click "Apply & Restart", watch a spinner overlay, see a "Agent updated" toast, and chat with their re-rendered Hermes — all from the browser.

**Architecture:** Phase 6 is mostly UI. Two small backend additions fill prerequisite gaps (`GET`/`PUT /api/v1/profile/me` for the form data; self-service `PUT /api/v1/auth/me` and `PUT /api/v1/auth/me/pin` for My Account). All apply orchestration already exists from Phase 3+4; UI just calls `POST /api/v1/profile/apply` after `PUT /api/v1/profile/me` succeeds. The webui adds two services (`profile-api`, `providers-api`), two shared primitives (`spinner-overlay`, `toast`), and the two new tabs.

**Test doctrine:** Per the 2026-04-25 test-lean cutover (`.claude/rules/testing.md`, spec `2026-04-25-test-lean-doctrine-and-audit-design.md`), this plan writes **contract tests for new HTTP endpoints**, one **state-machine test for the apply-overlay UI flow**, and **no per-component UI render tests**. Browser smoke is the primary regression net for tab UI behavior.

**Tech Stack:** Bun + TypeScript strict (gateway), Preact + TypeScript strict (webui), Vitest, Zod. Browser logging via `createLogger` from `@sentient/web-sdk`. BEM CSS with existing tokens (no new framework, no new tokens unless explicitly noted).

**Branch:** `feature/multi-user-phase6-webui-settings` (NEW — created in a git worktree by Task 6.0).

**Spec:** `docs/superpowers/specs/2026-04-24-multi-user-auth-and-settings-design.md` — §3.3 (apply behavior, verified), §4 (auth model), §5.1 (model picker), §5.2 (voice picker), §6.4 (settings tab restructure), §6.5 (My Agent tab), §6.6 (Apply & Restart), §6.7 (new shared UI primitives), §7.3 (apply runtime flow), §8 (error handling).

**Parent branch:** `feature/multi-user-auth-and-settings` (Phase 0 + 1+2 + 3+4 + 5 all merged + test-lean cutover).

---

## Hard Rules (apply to every task)

These are non-negotiable. Phase 1+2 / 3+4 / 5 plans proved they keep autonomous execution clean. Anything not on this list that you change is out-of-scope and should be surfaced to the controller.

1. **No `--no-verify` ever.** Lint, typecheck, and existing tests must stay green per commit. If a hook fails on something pre-existing on `develop`, fix it cleanly with a one-line `biome-ignore` comment naming the rule and reason — never bypass.
2. **No out-of-scope edits.** This plan touches only:
   - `gateway/src/api/handlers/profile.ts` (extend with GET/PUT /me)
   - `gateway/src/api/handlers/auth.ts` (extend with PUT /me + PUT /me/pin)
   - `gateway/src/api/handlers/profile.test.ts`, `auth.test.ts` (contract tests for the new endpoints)
   - `gateway/src/user-auth/auth-service.ts` and its test (small additions for displayName + PIN change methods if not already present — verify first)
   - `gateway/webui/src/services/auth-api.ts` (extend, do NOT rewrite)
   - `gateway/webui/src/services/profile-api.ts` (NEW)
   - `gateway/webui/src/services/providers-api.ts` (NEW)
   - `gateway/webui/src/components/common/spinner-overlay.tsx` (NEW)
   - `gateway/webui/src/components/common/toast.tsx` (NEW)
   - `gateway/webui/src/components/settings/my-agent-tab.tsx` and helpers (NEW)
   - `gateway/webui/src/components/settings/my-account-tab.tsx` (NEW)
   - `gateway/webui/src/components/settings/settings-view.tsx`, `settings-tabs.tsx` (extend, mostly the union + admin gate)
   - `gateway/webui/src/styles/components.css` (append BEM blocks; never remove existing rules)
   - `gateway/webui/src/app.tsx` (one toast-host insertion)
   Do **not** edit: `lefthook.yml`, `package.json`, `tsconfig*.json`, `vite.config.ts`, anything under `deploy/`, anything under `gateway/webui/src/components/auth/`, anything under `gateway/src/apply/`. If you find you need such an edit, surface it.
3. **Test-lean doctrine (`.claude/rules/testing.md`, 2026-04-25):** keep tests only if they pin (1) a wire/protocol contract, (2) an FSM/invariant, (3) a security boundary, or (4) are an `@live` / browser-smoke flow. **For Phase 6 specifically:** write contract tests for the four new HTTP endpoints; write one FSM test for the apply-overlay client-side state machine; write **no** per-component render tests. Manual smoke (Task 6.13) is the primary regression net.
4. **Browser logging via `createLogger` only.** Never `console.log/debug/warn/error` in shipped code. Tag: `createLogger(["sentient", "webui", "<area>"])`.
5. **BEM + existing CSS tokens only.** Use `--color-*`, `--space-*`, `--radius-*`, `--motion-*` tokens already declared in `gateway/webui/src/styles/tokens/*.css`. One exception: Task 6.5 may add a single new token `--color-overlay-scrim` (rgba) for the spinner overlay scrim — that's the only token addition allowed.
6. **camelCase for TS field names; snake_case for YAML/Hermes config keys.** Existing code is consistent; new code must match.
7. **Files <300 lines, components <150 lines, functions <40 lines.** If a file approaches the limit, split it. The My Agent tab in particular WILL split into sub-components (persona-section, voice-section, model-section, tools-section, advanced-section).
8. **Result types from `@sentient/protocol` for new HTTP services.** No throws from gateway business logic. Webui surfaces `Result<T, E>` to components; components unwrap and render error state.
9. **`bun run test` (Vitest), not `bun test`.**
10. **No new test fixtures.** Mock at the boundary (mock `fetch` for webui clients; mock the AuthService / ProfileStore for handler tests). Reuse existing test setups.

---

## Status Reporting

`DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`. Surface discrepancies between this plan and the actual code (e.g., a method name that doesn't exist on AuthService); don't silently rename or invent.

---

## Task 6.0: Worktree setup (one-time, before any other task)

**Why:** Phase 6 may run alongside other work; isolate in a worktree so commits don't interleave with the main checkout.

- [ ] **Step 1: Invoke the worktrees skill**

Use the `superpowers:using-git-worktrees` skill (via the `Skill` tool, name `superpowers:using-git-worktrees`) with this argument:

> Set up an isolated worktree for Phase 6 of multi-user. Branch name: `feature/multi-user-phase6-webui-settings`. Branch base: current `HEAD` of `feature/multi-user-auth-and-settings` (the parent branch this plan is designed against). Project root: `/Users/kevinye/Development/sentient`.

The skill will pick the worktree directory automatically. The repo already has `.worktrees/` (project-local, hidden, gitignored) — the skill should select that and create `<repo>/.worktrees/<name>/` for this branch.

When the skill returns, **`cd` into the new worktree path** for all subsequent tasks. Verify with `pwd` + `git branch --show-current` before continuing.

- [ ] **Step 2: Confirm Phase 5 + Phase 3+4 + test-lean cutover are in HEAD**

```bash
git log --oneline | grep -E "Phase 5|Merge branch 'feature/multi-user-phase5|test-lean doctrine" | head -3
ls gateway/webui/src/components/auth/login-screen.tsx \
   gateway/src/api/handlers/profile.ts \
   gateway/src/providers/catalogs/types.ts \
   .claude/rules/testing.md
```

Expected: log mentions Phase 5 + test-lean; all four files exist. If not, report `BLOCKED: predecessor work not present at HEAD — the worktree was branched off the wrong commit`.

- [ ] **Step 3: Baseline green**

```bash
source scripts/env.sh && bun run typecheck && bun run test
```

Expected: green. If anything fails, report `BLOCKED: parent-branch baseline not green` and stop — that means the baseline drifted upstream and must be fixed there before Phase 6 can start.

- [ ] **Step 4: Report `DONE: worktree set up at <path>, baseline green`**

No commits in this task.

---

# Backend prereqs

These two tasks add the missing endpoints. They unblock the entire UI layer; ship them first.

## Task 6.1: `GET /api/v1/profile/me` and `PUT /api/v1/profile/me`

**Why:** The My Agent tab has to load the current profile to populate the form, then write edits before triggering apply. Phase 3+4 only landed `POST /api/v1/profile/apply`. The new endpoints are token-authed; userId is resolved from the bearer claim, never trusted from the body.

**Files:**
- Modify: `gateway/src/api/handlers/profile.ts` (add `handleMe` for GET + PUT under same path)
- Modify: `gateway/src/api/handlers/profile.test.ts` (contract tests for the new methods)
- Modify: `gateway/src/server.ts` if needed — likely the dep shape grows (new `profileStore` dep)

- [ ] **Step 1: Inspect existing handler shape + ProfileStore interface**

Read `gateway/src/api/handlers/profile.ts` end-to-end. Read `gateway/src/profile-store/profile-store.ts` to confirm the `get(userId)` and `save(profile)` method signatures. Read `gateway/src/profile-store/profile-types.ts` for `ProfileV1`. **Do not change any of these — only call them.**

- [ ] **Step 2: Write the failing contract tests (one `it` per branch)**

Add to `gateway/src/api/handlers/profile.test.ts` (mirror the existing apply tests' shape — mock `tokens.validate`, mock the profileStore):

```ts
describe("GET /api/v1/profile/me", () => {
  it("returns the user's profile on 200 with a valid bearer token", async () => { /* … */ });
  it("returns 401 when the bearer token is missing or invalid", async () => { /* … */ });
  it("returns 404 when the user has no profile yet (ProfileStore returns ok:false 'not-found')", async () => { /* … */ });
  it("returns 405 for non-GET methods (only GET and PUT are accepted)", async () => { /* … */ });
});

describe("PUT /api/v1/profile/me", () => {
  it("validates the body against ProfileV1 schema and returns 422 on parse failure", async () => { /* … */ });
  it("forces the body's userId to match the bearer claim (rejects mismatched userId with 422)", async () => { /* … */ });
  it("persists via profileStore.save and returns the saved profile on 200", async () => { /* … */ });
  it("returns 401 when token is invalid", async () => { /* … */ });
});
```

Each test mocks fetch-equivalent inputs and asserts the typed `Response` shape (status, JSON body).

- [ ] **Step 3: Run, verify red**

```bash
bun run test gateway/src/api/handlers/profile.test.ts
```

- [ ] **Step 4: Implement**

Extend `ProfileHandlerDeps` to include `profileStore: ProfileStore`. Add a `handleMe(deps, request)` dispatch in the existing path-switch:

```ts
async function handleProfile(deps, request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/profile/apply") return handleApply(deps, request);
  if (url.pathname === "/api/v1/profile/me") return handleMe(deps, request);
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}
```

`handleMe` reads the bearer, validates the token, then:
- on `GET` → `profileStore.get(userId)` → 200 JSON or 404
- on `PUT` → `profileV1Schema.safeParse(body)` → if `userId` in body !== bearer's userId, 422 — otherwise `profileStore.save(profile)` → 200 with the saved profile
- on anything else → 405

Always log `me.request | method userId` at INFO. Errors at WARN with `reason`.

- [ ] **Step 5: Wire profileStore through `gateway/src/server.ts`**

In `createGatewayServer`, the `createProfileHandler` call needs the profileStore. Confirm it's already on `services` (`gateway/src/bootstrap/create-gateway-services.ts`) — it should be from Phase 1+2. Pass it through.

- [ ] **Step 6: Run all gateway tests + typecheck**

```bash
bun run typecheck && bun run test
```

- [ ] **Step 7: Commit**

```bash
git add gateway/src/api/handlers/profile.ts gateway/src/api/handlers/profile.test.ts gateway/src/server.ts
git commit -m "feat(api): GET/PUT /api/v1/profile/me — bearer-authed self-profile read/write"
```

---

## Task 6.2: Self-service `PUT /api/v1/auth/me` and `PUT /api/v1/auth/me/pin`

**Why:** The My Account tab needs to change displayName and PIN. Phase 1+2 shipped `GET /api/v1/auth/me` (read) and admin-only `reset-pin` (out of scope this phase). Add the two self-service mutations now. Both are token-authed; userId comes from the bearer.

**Endpoints:**
- `PUT /api/v1/auth/me` — body `{displayName: string}` (1–64 chars). Returns updated user (no token rotation needed).
- `PUT /api/v1/auth/me/pin` — body `{currentPin: string, newPin: string}` (both 4 digits). Verifies `currentPin` matches; rejects 401 on mismatch.

**Files:**
- Modify: `gateway/src/api/handlers/auth.ts` (two new dispatch branches + handlers)
- Modify: `gateway/src/api/handlers/auth.test.ts`
- Modify: `gateway/src/user-auth/auth-service.ts` (add `updateDisplayName(userId, displayName)` and `changePin(userId, currentPin, newPin)` if not present — check first; the user-store probably already has primitive write paths)
- Modify: `gateway/src/user-auth/auth-service.test.ts` (contract for the two new methods)

- [ ] **Step 1: Verify which methods exist on AuthService**

```bash
grep -nE "updateDisplayName|changePin|setPin" gateway/src/user-auth/auth-service.ts
```

If `updateDisplayName` / `changePin` already exist, skip the AuthService work and only add HTTP handlers. Otherwise add them in step 4.

- [ ] **Step 2: Write the failing handler tests**

```ts
describe("PUT /api/v1/auth/me", () => {
  it("updates displayName on 200, persists via authService", async () => { /* … */ });
  it("returns 401 without bearer", async () => { /* … */ });
  it("returns 422 when displayName is empty or too long (>64)", async () => { /* … */ });
  it("returns 405 for non-PUT", async () => { /* … */ });
});

describe("PUT /api/v1/auth/me/pin", () => {
  it("returns 200 when currentPin matches and newPin is valid", async () => { /* … */ });
  it("returns 401 when currentPin is wrong", async () => { /* … */ });
  it("returns 422 when newPin doesn't match /^\\d{4}$/", async () => { /* … */ });
  it("returns 401 without bearer", async () => { /* … */ });
});
```

- [ ] **Step 3: Run, verify red**

- [ ] **Step 4: Implement AuthService methods (only if missing)**

Pure additions; don't modify existing methods. Mirror existing patterns (atomic write via UserStore). Add tests in `auth-service.test.ts` covering the happy path + each failure mode.

- [ ] **Step 5: Implement HTTP handlers**

Path-switch additions:

```ts
if (path === "/api/v1/auth/me" && request.method === "PUT") return handleUpdateMe(deps, request);
if (path === "/api/v1/auth/me/pin") return handleChangePin(deps, request);
```

Both use the same `readBearer` + `tokens.validate` pattern as `handleMe`. Return updated user on success.

- [ ] **Step 6: Run all gateway tests + typecheck**

- [ ] **Step 7: Commit**

```bash
git add gateway/src/api/handlers/auth.ts gateway/src/api/handlers/auth.test.ts gateway/src/user-auth/auth-service.ts gateway/src/user-auth/auth-service.test.ts
git commit -m "feat(api): self-service PUT /api/v1/auth/me + /me/pin"
```

---

# Webui clients

## Task 6.3: Extend `auth-api.ts` and add `profile-api.ts` + `providers-api.ts`

**Why:** Webui needs typed wrappers for the new endpoints. Mirror the existing `auth-api.ts` shape exactly — same Result<T, E> envelope, same `createLogger` tag, same `bearerHeaders`/`jsonHeaders` helpers.

**Files:**
- Modify: `gateway/webui/src/services/auth-api.ts` (add `updateMe(token, displayName)` and `changePin(token, currentPin, newPin)`)
- Create: `gateway/webui/src/services/profile-api.ts`
- Create: `gateway/webui/src/services/providers-api.ts`

Per the test-lean doctrine, **no unit tests** for these wrappers — they're thin fetch+JSON utilities. Smoke + contract tests on the gateway side cover the wire shape.

- [ ] **Step 1: Read `auth-api.ts` end-to-end**

You're going to mirror its shape across two new files plus extend it.

- [ ] **Step 2: Extend `auth-api.ts`**

Add to the `AuthApi` interface and the factory:

```ts
updateMe(token: string, input: { displayName: string }): Promise<Result<{ user: AuthUser }, AuthApiError>>;
changePin(token: string, input: { currentPin: string; newPin: string }): Promise<Result<{ ok: true }, AuthApiError>>;
```

- [ ] **Step 3: Create `profile-api.ts`**

```ts
import { createLogger } from "@sentient/web-sdk";
import type { ProfileV1 } from "@sentient/...";  // pick the actual export path; if ProfileV1 isn't exported from a shared package, redeclare its shape here as ProfileV1 and add a TODO to deduplicate later — DO NOT import gateway internals from the webui

const log = createLogger(["sentient", "webui", "profile", "api"]);

export interface ProfileApiError { status: number; code: string; }
type Result<T> = { ok: true; value: T } | { ok: false; error: ProfileApiError };

export interface ProfileApi {
  getMe(token: string): Promise<Result<ProfileV1>>;
  updateMe(token: string, profile: ProfileV1): Promise<Result<ProfileV1>>;
  apply(token: string): Promise<Result<{ status: "ready"; elapsedMs: number }>>;
}

export function createProfileApi(config?: { baseUrl?: string }): ProfileApi { /* … */ }
```

**Important:** the webui must NOT import `gateway/src/profile-store/profile-types.ts`. If `ProfileV1` lives only in gateway-internals, declare a webui-local `ProfileV1` mirror in `gateway/webui/src/services/profile-api.ts` (camelCase, identical shape). The contract tests on the gateway side enforce that the wire format matches. Don't try to share types across the gateway / webui boundary in this phase — that's a separate refactor.

- [ ] **Step 4: Create `providers-api.ts`**

Mirror shape:

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
export interface ProvidersApi {
  listModels(token: string): Promise<Result<{ models: ModelEntry[]; stale: boolean }>>;
  listVoices(token: string): Promise<Result<{ voices: VoiceEntry[]; stale: boolean }>>;
}
```

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/services/
git commit -m "feat(webui): profile-api + providers-api clients; auth-api self-service mutations"
```

---

# UI primitives

## Task 6.4: `spinner-overlay.tsx`

**Why:** Apply flow needs a full-screen lock. Spec §6.7: Fraunces heading, DM Sans body, motion-normal fade-in, dismiss only when explicitly toggled (NOT on click).

**Files:**
- Create: `gateway/webui/src/components/common/spinner-overlay.tsx`
- Append to: `gateway/webui/src/styles/components.css`

No unit test. Smoke test catches it.

- [ ] **Step 1: Component**

```tsx
import type { JSX } from "preact";

export interface SpinnerOverlayProps {
  open: boolean;
  heading: string;
  body?: string;
}

export function SpinnerOverlay({ open, heading, body }: SpinnerOverlayProps): JSX.Element | null {
  if (!open) return null;
  return (
    <div class="spinner-overlay" role="alertdialog" aria-modal="true" aria-live="assertive">
      <div class="spinner-overlay__card">
        <div class="spinner-overlay__spinner" aria-hidden="true" />
        <h2 class="spinner-overlay__heading">{heading}</h2>
        {body && <p class="spinner-overlay__body">{body}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CSS — add a single new token + BEM block**

In `gateway/webui/src/styles/tokens/colors.css`, append:

```css
  --color-overlay-scrim: rgba(20, 17, 15, 0.78);
```

In `components.css`, append:

```css
.spinner-overlay {
  position: fixed; inset: 0; z-index: 100;
  display: grid; place-items: center;
  background: var(--color-overlay-scrim);
  animation: spinner-overlay-fade-in var(--motion-normal);
}
.spinner-overlay__card {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-md);
  background: var(--color-paper);
  padding: var(--space-2xl) var(--space-xl);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-2);
  min-width: 320px;
}
.spinner-overlay__spinner {
  width: 40px; height: 40px;
  border-radius: 50%;
  border: 3px solid var(--color-line-soft);
  border-top-color: var(--color-accent);
  animation: spinner-overlay-spin 0.8s linear infinite;
}
.spinner-overlay__heading {
  font-family: var(--font-display); font-weight: 400;
  font-size: var(--font-size-lg); color: var(--color-ink);
  margin: 0;
}
.spinner-overlay__body {
  font-family: var(--font-ui); font-size: var(--font-size-sm);
  color: var(--color-ink-3); margin: 0;
}
@keyframes spinner-overlay-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes spinner-overlay-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
git add gateway/webui/src/components/common/spinner-overlay.tsx gateway/webui/src/styles/{components.css,tokens/colors.css}
git commit -m "feat(webui): spinner-overlay primitive for apply flow"
```

---

## Task 6.5: `toast.tsx` + ToastHost

**Why:** Apply success → "Agent updated" toast, terra accent, auto-dismiss 4s. Spec §6.7. Need both the `Toast` element and a `ToastHost` that lives in the app shell so any tab can fire a toast via a context.

**Files:**
- Create: `gateway/webui/src/components/common/toast.tsx`
- Create: `gateway/webui/src/hooks/use-toast.tsx` (context + hook)
- Modify: `gateway/webui/src/app.tsx` (mount `<ToastHost>` once, near the top of the tree)
- Append to: `components.css`

- [ ] **Step 1: Hook + provider**

`use-toast.tsx`:

```tsx
import { createContext } from "preact";
import { useCallback, useContext, useState } from "preact/hooks";

interface ToastEntry { id: number; message: string; tone: "success" | "error"; }
interface ToastContextValue {
  show(message: string, tone?: "success" | "error"): void;
  toasts: ToastEntry[];
  dismiss(id: number): void;
}
const Ctx = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: preact.ComponentChildren }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const show = useCallback((message: string, tone: "success" | "error" = "success") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, message, tone }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  return <Ctx.Provider value={{ show, toasts, dismiss }}>{children}</Ctx.Provider>;
}
export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast must be used inside ToastProvider");
  return v;
}
```

- [ ] **Step 2: Toast + ToastHost components**

`toast.tsx`:

```tsx
import type { JSX } from "preact";
import { useToast } from "../../hooks/use-toast.js";

export function ToastHost(): JSX.Element {
  const { toasts, dismiss } = useToast();
  return (
    <div class="toast-host" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" class={`toast toast--${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Wire into `app.tsx`**

Wrap `<AppInner />` with `<ToastProvider>` (alongside the existing `<AuthProvider>`). Add `<ToastHost />` inside the auth-gated branch (or unconditionally near the root) so any descendant can fire toasts.

- [ ] **Step 4: CSS**

```css
.toast-host {
  position: fixed; bottom: var(--space-xl); right: var(--space-xl);
  display: flex; flex-direction: column-reverse; gap: var(--space-sm);
  z-index: 50; pointer-events: none;
}
.toast {
  pointer-events: auto;
  background: var(--color-paper);
  border: 1px solid var(--color-line-soft);
  border-left-width: 3px;
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  color: var(--color-ink);
  font-family: var(--font-ui);
  font-size: var(--font-size-sm);
  box-shadow: var(--shadow-1);
  animation: toast-slide-in var(--motion-fast);
  cursor: pointer;
  text-align: left;
}
.toast--success { border-left-color: var(--color-accent); }
.toast--error   { border-left-color: var(--color-stop); }
@keyframes toast-slide-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
```

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add gateway/webui/src/components/common/toast.tsx gateway/webui/src/hooks/use-toast.tsx gateway/webui/src/app.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): toast + ToastHost primitive (auto-dismiss 4s)"
```

---

# Settings restructure

## Task 6.6: Extend SettingsTab union, admin gate `SettingsView`, add tab placeholders

**Why:** Adding two new tabs. Per spec §6.4, non-admin users see only My Agent + My Account; admins see all. The existing `MembersPanel` / `PermissionsPanel` / etc. stay (per spec, repurposed but visible to admin only).

**Files:**
- Modify: `gateway/webui/src/components/settings/settings-tabs.tsx`
- Modify: `gateway/webui/src/components/settings/settings-view.tsx`
- Append to: `components.css` (only if needed)

- [ ] **Step 1: Read both files end-to-end**

- [ ] **Step 2: Extend `SettingsTab` union**

```ts
export type SettingsTab =
  | "my-agent"
  | "my-account"
  | "members"
  | "permissions"
  | "voices"
  | "sessions"
  | "invites";
```

Reorder the visible tabs so My Agent and My Account come first. Update labels accordingly.

- [ ] **Step 3: Admin-gate non-self tabs in `SettingsView`**

Inside SettingsView, call `useAuth()`. From `auth.user.isAdmin`, derive a filtered tab list:

```ts
const tabs: SettingsTab[] = auth.status === "authenticated" && auth.user.isAdmin
  ? ["my-agent", "my-account", "members", "permissions", "voices", "sessions", "invites"]
  : ["my-agent", "my-account"];
```

Pass `tabs` to `<SettingsTabs>`. Render the corresponding panel. For "my-agent" and "my-account", import the new tabs from `./my-agent-tab.js` / `./my-account-tab.js` (created in Tasks 6.7–6.10).

For now, render placeholder stubs returning `<section class="settings-panel"><h2>My Agent</h2></section>` etc., so this task doesn't depend on the others. Replace stubs in subsequent tasks.

- [ ] **Step 4: Default tab**

Default `activeTab` is now `"my-agent"`, not `"members"`.

- [ ] **Step 5: Typecheck + manual smoke**

```bash
bun run typecheck
# manual: open https://localhost:8888 logged-in as admin → see all tabs
# manual: open as non-admin (would need a second account) → see only My Agent + My Account
```

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/components/settings/{settings-tabs.tsx,settings-view.tsx}
git commit -m "feat(webui): settings tabs — admin-gated, default to My Agent"
```

---

## Task 6.7: My Account tab

**Why:** The simpler of the two new tabs — three actions: change displayName, change PIN, log out. Knocks out a smaller surface before tackling My Agent.

**Files:**
- Create: `gateway/webui/src/components/settings/my-account-tab.tsx`
- Append to: `components.css`

No unit test. Smoke covers it.

- [ ] **Step 1: Component shape**

```tsx
import { useState } from "preact/hooks";
import { useAuth } from "../../hooks/use-auth.js";
import { useToast } from "../../hooks/use-toast.js";
import { createAuthApi } from "../../services/auth-api.js";
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "settings", "my-account"]);
const api = createAuthApi();

export function MyAccountTab(): preact.JSX.Element {
  const auth = useAuth();
  const toast = useToast();
  if (auth.status !== "authenticated") return <></>;

  return (
    <section class="settings-panel">
      <header class="settings-panel__header">
        <h2 class="settings-panel__title">My Account</h2>
      </header>
      <DisplayNameSection auth={auth} api={api} toast={toast} />
      <ChangePinSection auth={auth} api={api} toast={toast} />
      <LogoutSection auth={auth} />
    </section>
  );
}
```

Each subsection is its own small component (≤80 lines):
- `DisplayNameSection` — `<input>` + Save button → `api.updateMe(token, {displayName})` → toast on success
- `ChangePinSection` — three `<input type="password">` (current PIN, new PIN, confirm) → `api.changePin(token, {currentPin, newPin})` → on 401 show "Current PIN is wrong" inline; on success toast + clear inputs
- `LogoutSection` — single button calling `auth.logout()`

Use sane validation: displayName 1–64 chars (disable Save when invalid); PIN /^\d{4}$/ (disable Save when invalid).

- [ ] **Step 2: CSS**

Reuse `.settings-panel*` classes that already exist. If you need new ones for stacked sections, add a `.account-section` block.

- [ ] **Step 3: Wire into `SettingsView`**

Replace the My Account stub from Task 6.6 with `<MyAccountTab />`.

- [ ] **Step 4: Typecheck + manual smoke**

```bash
bun run typecheck
# manual: change display name → topbar updates
# manual: change PIN → logout → login with new PIN succeeds
# manual: wrong current PIN → inline error
```

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/components/settings/my-account-tab.tsx gateway/webui/src/components/settings/settings-view.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): My Account tab (display name, change PIN, logout)"
```

---

# My Agent tab

The largest piece. Split into four tasks: the framework + persona section first, then voice picker, then model picker, then tools/advanced/sticky-footer/apply.

## Task 6.8: My Agent tab framework + persona section

**Why:** Establish the dirty-state pattern, the `<MyAgentTab>` shell, and the simplest section first. The remaining sections plug into the same shell.

**Files:**
- Create: `gateway/webui/src/components/settings/my-agent-tab.tsx`
- Create: `gateway/webui/src/components/settings/my-agent/persona-section.tsx`
- Create: `gateway/webui/src/components/settings/my-agent/dirty-state.ts` (small utility — diff a draft against the original profile, return a list of dirty restart-fields)
- Append CSS as needed.

- [ ] **Step 1: Dirty-state utility**

```ts
// my-agent/dirty-state.ts
import type { ProfileV1 } from "../../../services/profile-api.js";

export type DirtyField =
  | "persona.template" | "persona.overrides"
  | "voice.id" | "model.provider" | "model.id"
  | "tools.enabled" | "advanced.extraSystemPrompt" | "advanced.maxTokens"
  | "compression.threshold";

/** Compare a draft profile against the original; return the list of fields that changed.
 *  Every field listed is "restart-required" — we don't have any "live" fields in this MVP. */
export function diffProfile(original: ProfileV1, draft: ProfileV1): DirtyField[] {
  const dirty: DirtyField[] = [];
  if (original.persona.template !== draft.persona.template) dirty.push("persona.template");
  if (original.persona.overrides !== draft.persona.overrides) dirty.push("persona.overrides");
  if (original.voice.id !== draft.voice.id) dirty.push("voice.id");
  if (original.model.provider !== draft.model.provider) dirty.push("model.provider");
  if (original.model.id !== draft.model.id) dirty.push("model.id");
  if (JSON.stringify(original.tools.enabled) !== JSON.stringify(draft.tools.enabled)) dirty.push("tools.enabled");
  if (original.advanced.extraSystemPrompt !== draft.advanced.extraSystemPrompt) dirty.push("advanced.extraSystemPrompt");
  if (original.advanced.maxTokens !== draft.advanced.maxTokens) dirty.push("advanced.maxTokens");
  if (original.compression.threshold !== draft.compression.threshold) dirty.push("compression.threshold");
  return dirty;
}
```

(No unit test — pure utility, smoke catches regressions.)

- [ ] **Step 2: Tab shell**

`my-agent-tab.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../hooks/use-auth.js";
import { createProfileApi, type ProfileV1 } from "../../services/profile-api.js";
import { PersonaSection } from "./my-agent/persona-section.js";
import { diffProfile, type DirtyField } from "./my-agent/dirty-state.js";

const log = createLogger(["sentient", "webui", "settings", "my-agent"]);
const api = createProfileApi();

export function MyAgentTab(): preact.JSX.Element {
  const auth = useAuth();
  const [original, setOriginal] = useState<ProfileV1 | null>(null);
  const [draft, setDraft] = useState<ProfileV1 | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    (async () => {
      const r = await api.getMe(auth.token);
      if (r.ok) {
        setOriginal(r.value);
        setDraft(r.value);
      } else {
        log.warn("getMe.failed", { code: r.error.code });
        setError("Couldn't load your profile.");
      }
    })();
  }, [auth.status]);

  if (error) return <section class="settings-panel"><p class="settings-panel__desc">{error}</p></section>;
  if (!original || !draft) return <section class="settings-panel"><p class="settings-panel__desc">Loading…</p></section>;

  const dirty: DirtyField[] = diffProfile(original, draft);

  return (
    <div class="my-agent">
      <PersonaSection draft={draft} onChange={(next) => setDraft({ ...draft, persona: next })} />
      {/* voice, model, tools, advanced sections inserted by Tasks 6.9–6.11 */}
      <ApplyFooter dirty={dirty} draft={draft} original={original} setOriginal={setOriginal} setDraft={setDraft} auth={auth} api={api} />
    </div>
  );
}

function ApplyFooter(props: { dirty: DirtyField[]; /* ... */ }): preact.JSX.Element | null {
  // Implemented in Task 6.11 — render null for now (no dirty fields can exist if only persona section is wired)
  return null;
}
```

- [ ] **Step 3: Persona section**

```tsx
import type { ProfileV1 } from "../../../services/profile-api.js";

interface Props {
  draft: ProfileV1;
  onChange(next: ProfileV1["persona"]): void;
}

export function PersonaSection({ draft, onChange }: Props): preact.JSX.Element {
  return (
    <section class="settings-panel my-agent__section">
      <header class="settings-panel__header">
        <h3 class="settings-panel__title">Persona</h3>
      </header>
      <p class="settings-panel__desc">
        Your agent's personality and tone. Loaded from a shared template; you can override below.
      </p>
      <label class="my-agent__label">
        <span>Template</span>
        <input type="text" value={draft.persona.template} onInput={(e) => onChange({ ...draft.persona, template: (e.target as HTMLInputElement).value })} />
      </label>
      <label class="my-agent__label">
        <span>Overrides (added after the template)</span>
        <textarea rows={6} maxLength={8192} value={draft.persona.overrides} onInput={(e) => onChange({ ...draft.persona, overrides: (e.target as HTMLTextAreaElement).value })} />
      </label>
    </section>
  );
}
```

(In a later task you can replace the bare `<input>` template field with a dropdown that lists shared templates from disk — for MVP, a free-text field is fine.)

- [ ] **Step 4: CSS**

```css
.my-agent { display: flex; flex-direction: column; gap: var(--space-lg); padding-bottom: 80px; /* leave room for sticky footer */ }
.my-agent__section { /* inherits .settings-panel */ }
.my-agent__label { display: flex; flex-direction: column; gap: var(--space-xs); font-size: var(--font-size-sm); color: var(--color-ink-2); }
.my-agent__label input,
.my-agent__label textarea {
  padding: var(--space-md);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-bg-elev);
  color: var(--color-ink);
  font-family: var(--font-ui);
  resize: vertical;
}
.my-agent__label input:focus,
.my-agent__label textarea:focus { outline: none; border-color: var(--color-accent); }
```

- [ ] **Step 5: Wire into `SettingsView`**

Replace the My Agent stub with `<MyAgentTab />`.

- [ ] **Step 6: Typecheck + smoke**

```bash
bun run typecheck
# manual: open My Agent → persona section loads with current values; editing dirties (visible only after Task 6.11 wires the footer)
```

- [ ] **Step 7: Commit**

```bash
git add gateway/webui/src/components/settings/my-agent-tab.tsx gateway/webui/src/components/settings/my-agent/ gateway/webui/src/components/settings/settings-view.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): My Agent tab framework + persona section"
```

---

## Task 6.9: Voice picker section + audio preview

**Why:** Voice picker per spec §5.2 — search/filter, language chip, "My voices only" toggle, cover thumb + title + tags + ▶ preview.

**Files:**
- Create: `gateway/webui/src/components/settings/my-agent/voice-section.tsx`
- Create: `gateway/webui/src/components/common/audio-preview.tsx` (small reusable: an `<audio>` element + play/stop button)
- Append CSS.

- [ ] **Step 1: AudioPreview component**

```tsx
import { useEffect, useRef, useState } from "preact/hooks";

export function AudioPreview({ src }: { src: string | null }): preact.JSX.Element {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onEnd = () => setPlaying(false);
    el.addEventListener("ended", onEnd);
    return () => el.removeEventListener("ended", onEnd);
  }, []);
  if (!src) return <span class="audio-preview audio-preview--unavailable" aria-label="No preview">·</span>;
  const toggle = () => {
    const el = ref.current; if (!el) return;
    if (playing) { el.pause(); el.currentTime = 0; setPlaying(false); }
    else { el.play(); setPlaying(true); }
  };
  return (
    <button type="button" class="audio-preview" onClick={toggle} aria-label={playing ? "Stop preview" : "Play preview"}>
      {playing ? "⏸" : "▶"}
      <audio ref={ref} src={src} preload="none" />
    </button>
  );
}
```

CSS: `.audio-preview { width: 32px; height: 32px; border-radius: 50%; ... }`. Inactive state for `--unavailable`.

- [ ] **Step 2: VoiceSection**

Loads voice list once via `providersApi.listVoices(token)`, holds search + language-filter state, renders rows. Each row: cover thumb, title, description preview, tag chips, AudioPreview, radio-style click-to-select. Selected row visually highlighted (use `--color-accent-50` background).

Keep it under 200 lines. If it gets larger, factor out a `<VoiceRow>` subcomponent.

- [ ] **Step 3: Wire into MyAgentTab**

Insert `<VoiceSection draft={draft} onChange={(next) => setDraft({ ...draft, voice: next })} token={auth.token} />` after PersonaSection.

- [ ] **Step 4: Smoke**

Open My Agent → voice section loads list (network tab shows `GET /api/v1/providers/voices`). Search "warm" filters. Click ▶ → preview plays. Click row → selection updates. Network tab shows no PUT yet (apply is Task 6.11).

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/components/settings/my-agent/voice-section.tsx gateway/webui/src/components/common/audio-preview.tsx gateway/webui/src/components/settings/my-agent-tab.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): voice picker section with inline audio preview"
```

---

## Task 6.10: Model picker section (OpenRouter + Ollama-Cloud)

**Why:** Model picker per spec §5.1 — provider segmented control, then a rich model dropdown with name, context length, pricing, capability flags.

**Files:**
- Create: `gateway/webui/src/components/settings/my-agent/model-section.tsx`
- Append CSS.

- [ ] **Step 1: Component**

Top of card: segmented control for provider (`openrouter` / `ollama-cloud`). Below: filtered model list — show only models matching the chosen provider. Each model row: name, brief description, badges for `supportsTools` / `supportsVision`, context length, pricing (or "Included" for ollama).

When the user changes the provider, automatically pick the first model in the new provider's list as the new selection (so the form is never in a "no model selected" state).

- [ ] **Step 2: Wire into MyAgentTab**

Insert `<ModelSection ...>` after VoiceSection.

- [ ] **Step 3: Smoke**

Open My Agent → model section loads merged list from `GET /api/v1/providers/models`. Switch providers → list filters and selection auto-updates.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/settings/my-agent/model-section.tsx gateway/webui/src/components/settings/my-agent-tab.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): model picker section (OpenRouter + Ollama-Cloud)"
```

---

## Task 6.11: Tools + Advanced sections + sticky footer + apply integration

**Why:** Last piece. Tools toggle rows (one per MCP server in `profile.tools.enabled`), Advanced collapsed accordion (compression threshold, max tokens, extra system prompt), and the sticky footer with "Discard" + "Apply & Restart". Apply triggers PUT /me → POST /apply, with spinner overlay + toast on success.

**Files:**
- Create: `gateway/webui/src/components/settings/my-agent/tools-section.tsx`
- Create: `gateway/webui/src/components/settings/my-agent/advanced-section.tsx`
- Create: `gateway/webui/src/components/settings/my-agent/apply-footer.tsx`
- Modify: `gateway/webui/src/components/settings/my-agent-tab.tsx`
- Append CSS.

This is the only place a state-machine test belongs (per the test-lean doctrine). Add a small FSM test that exercises the apply flow's state transitions in isolation.

- [ ] **Step 1: ToolsSection**

For MVP, the list of available MCP server IDs is hardcoded in webui (or fetched via a small future endpoint). For now, render whatever's in `draft.tools.enabled` as toggleable rows — the user can remove items but not add (adding is admin territory in Phase 7). If the list is empty, show "No tools enabled." with a hint that the admin can add tools in System settings (Phase 7).

- [ ] **Step 2: AdvancedSection**

Collapsible (`<details>` works fine). Inside: number input for `compression.threshold` (0.0–1.0), number input for `advanced.maxTokens` (1–8192), textarea for `advanced.extraSystemPrompt` (max 8192). Validate inline; clamp to range.

- [ ] **Step 3: ApplyFooter — the FSM**

```tsx
type ApplyState =
  | { kind: "idle" }
  | { kind: "saving-profile" }
  | { kind: "applying"; startedAt: number }
  | { kind: "success" }
  | { kind: "error"; message: string };
```

Transitions:
1. `idle` → user clicks "Apply & Restart" → `saving-profile` → `api.updateMe(token, draft)`
2. on save success → `applying` → `api.apply(token)` (spinner overlay shown from this point)
3. on apply success → `success` → toast "Agent updated" + `setOriginal(draft)` (clears dirty) → `idle`
4. on save failure or apply failure → `error` (clear spinner, show error toast with the error code copy)

Discard button: `setDraft(original)` → `idle` (no API call).

- [ ] **Step 4: Render the spinner overlay during `applying`**

```tsx
<SpinnerOverlay
  open={state.kind === "applying"}
  heading="Updating your agent…"
  body="Do not close this tab"
/>
```

- [ ] **Step 5: Footer markup**

Sticky footer fixed at the bottom of the tab card. Amber `--color-warn` background. Label `"N pending changes"`. Buttons: Discard (secondary), Apply & Restart (primary, terra accent).

- [ ] **Step 6: Apply-FSM test (one file, one `describe`, ~6 `it` blocks)**

`gateway/webui/src/components/settings/my-agent/apply-footer.test.tsx`:

```tsx
describe("apply FSM", () => {
  it("idle → saving-profile → applying → success on happy path", async () => { /* … */ });
  it("idle → saving-profile → error when updateMe fails", async () => { /* … */ });
  it("saving-profile → error when network-error from updateMe", async () => { /* … */ });
  it("applying → error when apply fails (502 docker-restart-failed)", async () => { /* … */ });
  it("applying → error when apply times out (504 health-check-timeout)", async () => { /* … */ });
  it("Discard returns draft to original and stays idle without any network call", async () => { /* … */ });
});
```

Mock the two API calls; assert state transitions + the toasts fired.

- [ ] **Step 7: Smoke**

Open My Agent → make a change → footer appears with "1 pending change" → Apply & Restart → spinner appears → docker restart happens (~7s) → toast "Agent updated" → footer disappears → original is updated to draft. Reload page → form reflects the new values.

Send a chat message → confirm the new persona/model is in effect (e.g., if you swapped model, the response style changes; if you tweaked persona, the response reflects the override).

- [ ] **Step 8: Commit**

```bash
git add gateway/webui/src/components/settings/my-agent/{tools-section,advanced-section,apply-footer}.tsx gateway/webui/src/components/settings/my-agent/apply-footer.test.tsx gateway/webui/src/components/settings/my-agent-tab.tsx gateway/webui/src/styles/components.css
git commit -m "feat(webui): tools + advanced sections + apply footer with end-to-end FSM"
```

---

## Task 6.12: End-to-end manual smoke checklist (no commit)

**Why:** Per test-lean doctrine, browser smoke is the primary regression net. Run this checklist before reporting Phase 6 complete.

Bring up the stack: `cd deploy/docker && docker compose up -d`. Open `https://localhost:8888/`. Login as your existing user.

- [ ] **Settings tab gating:**
  1. As admin: all 7 tabs visible (My Agent, My Account, Members, Permissions, Voices, Sessions, Invites).
  2. As non-admin (create a second user via Phase 7 once shipped, or temporarily flip `isAdmin` in `users.json` for the test): only My Agent + My Account.

- [ ] **My Account flows:**
  3. Change displayName → topbar avatar label updates → toast.
  4. Change PIN → logout → login with new PIN succeeds.
  5. Wrong current-PIN → inline error, PIN not changed.

- [ ] **My Agent — voice:**
  6. Open voice section → list loads from `GET /api/v1/providers/voices`.
  7. Search "warm" → list filters.
  8. ▶ preview plays a sample without changing the selection.
  9. Click a different voice → footer shows "1 pending change".
  10. Apply & Restart → spinner → toast → next chat uses the new voice.

- [ ] **My Agent — model:**
  11. Switch provider OpenRouter → Ollama-Cloud → list filters.
  12. Pick a different model → apply → next chat answers from the new model.

- [ ] **My Agent — persona:**
  13. Edit overrides ("Always end your replies with 'cheers!'") → apply → next reply ends with "cheers!".

- [ ] **Apply error paths:**
  14. Stop hermes-alice (`docker stop hermes-alice`) → apply → spinner runs `health_check_timeout_ms` (30s) → error toast "Agent didn't come back in time".
  15. Restart hermes-alice → apply succeeds.

- [ ] **Discard:**
  16. Make a change → click Discard → form reverts; footer disappears.

Report `DONE` with each row of the checklist confirmed.

---

## Phase 6 Acceptance

When the 12 tasks above are complete the controller verifies:

- [ ] `bun run typecheck` clean.
- [ ] `bun run test` clean. New tests: 4 contract endpoints + 1 apply-FSM test. No new per-component render tests (per test-lean doctrine).
- [ ] Git log on `feature/multi-user-phase6-webui-settings` shows ~10 commits with `feat(...)` prefixes, no `--no-verify`.
- [ ] No edits outside the scope listed in Hard Rule #2.
- [ ] Manual smoke (Task 6.12) passes.

When green, the operator merges `feature/multi-user-phase6-webui-settings` into `feature/multi-user-auth-and-settings`. Phase 6 unblocks Phase 7 (admin Members + System tabs). The `confirm-dialog` primitive (deferred from §6.7) lands in Phase 7 alongside its first consumer (typed-confirmation delete-user).

---

## Out of Scope (do NOT touch)

- Admin user management (Members tab interactivity, create/delete/reset-PIN — Phase 7).
- System settings tab (provider key replace, shared templates editor — Phase 7).
- `confirm-dialog` primitive (Phase 7 builds it alongside delete-user).
- Periodic safety memory flush, idle-flush scheduler (Hermes' own watcher handles it; spec §3.3).
- Live model switching without restart (out of scope by design — apply-restart is the only path).
- Voice cloning upload (deferred per spec §11).
- Per-user provider API keys (system-wide only this cycle).
- Permissions / Voice Profiles / Invites / Sessions panels (still WIP placeholders; do not wire to real data).

If you find yourself wanting to edit any of the above, stop and surface to the controller.
