# Wizard Step Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bespoke wizard router with a declarative step chain shared between server and client, plus add an explicit `admin` cursor and split the bootstrap into phased init files.

**Architecture:** A single `shared/wizard` workspace package owns the step chain (cursor enumeration, transitions, body schemas, stepper labels). Server-side dispatch becomes a thin pipeline that runs `parse → apply → advance` per step file. Client-side `wizard-shell.tsx` reduces to a registry-driven component dispatcher. The `complete` cursor splits into `admin` (AccountWizard mounted) and `finish` (StepFinish mounted), driven by an explicit `auth/setup` → cursor advance hook. `gateway/src/bootstrap/create-gateway-services.ts` (797 lines) splits into five phase files orchestrated by a thin `index.ts`.

**Tech Stack:** TypeScript (strict), Bun runtime, Vitest for tests, zod for schemas, Preact for the webui, YAML state file. Workspace packages via Bun workspaces (`shared/*`).

**Spec:** `docs/superpowers/specs/2026-05-03-wizard-step-registry-design.md`

---

## File structure

### Created files

```
shared/wizard/
  package.json
  tsconfig.json
  src/
    index.ts                  ← re-exports steps.ts
    steps.ts                  ← WIZARD_STEPS + WizardStepId + body schemas
    steps.test.ts             ← chain integrity tests

gateway/src/api/wizard/
  index.ts                    ← createWizardHandler (replaces handlers/wizard.ts)
  router.ts                   ← URL → meta-handler | step-handler dispatch
  step-pipeline.ts            ← shared validate → side-effects → advance flow
  step-pipeline.test.ts
  steps/
    provider.ts               ← StepHandler + side-effects
    voice.ts
    secrets.ts
    bringup.ts                ← retry + complete-bringup helpers
    admin.ts                  ← cursor-only marker (advance lives in auth.ts)
    finish.ts                 ← finalize flips bootstrap_complete
  steps/__tests__/            ← one .test.ts per step file
  meta/
    unlock.ts
    back.ts
    test-provider.ts
    catalog.ts                ← active-llm + models + voices

gateway/webui/src/components/wizard/
  step-registry.tsx           ← WizardStepId → component map

gateway/src/bootstrap/
  phase-config.ts             ← loadStartupConfig + logging init
  phase-state.ts              ← install-state, secrets, internal-secrets, unlock-code
  phase-orchestrator.ts       ← system orchestrator + boot-reconcile gate
  phase-services.ts           ← TTS, STT, cerebrum, LLM, MCP host
  phase-routes.ts             ← handler instantiation + router build
```

### Modified files

```
gateway/package.json                            ← add @sentient/wizard workspace dep
gateway/webui/package.json                      ← add @sentient/wizard workspace dep
gateway/templates/wizard/state.yaml.tmpl        ← schema_version 0.1.0 → 0.2.0; cursor enum
gateway/src/admin/install-state.ts              ← cursor union; migration; transition sets from shared
gateway/src/admin/install-state.test.ts         ← cover migration + new cursors
gateway/src/api/handlers/auth.ts                ← handleSetup advances admin → finish
gateway/src/api/handlers/auth.test.ts           ← assert cursor side effect
gateway/src/server.ts                           ← swap import: handlers/wizard → api/wizard
gateway/src/bootstrap/create-gateway-services.ts ← becomes bootstrap/index.ts (slim orchestrator)
gateway/webui/src/hooks/use-install-state.ts    ← import WizardStepId from shared
gateway/webui/src/components/wizard/wizard-shell.tsx ← registry dispatch; drop adminDone + visualStep
gateway/webui/src/components/wizard/wizard-stepper.tsx ← consume WIZARD_STEPS labels
agents/docs/testing-knowledge.md                ← smoke procedure for fresh wizard walk
```

### Deleted files

```
gateway/src/api/handlers/wizard.ts              ← superseded by api/wizard/
gateway/src/api/handlers/wizard.test.ts         ← per-step contract tests replace
```

---

## Task ordering rationale

Phases 1–2 are additive (new shared package, new install-state cursors with migration). Phase 3 builds the new server tree alongside the old. Phase 4 cuts over the wiring and deletes old code. Phases 5–7 are independent of each other and can run in any order — choose the listed order to keep diff size manageable.

---

## Phase 1: Shared registry package

### Task 1: Create `shared/wizard` workspace package

**Files:**
- Create: `shared/wizard/package.json`
- Create: `shared/wizard/tsconfig.json`
- Create: `shared/wizard/src/index.ts`

- [ ] **Step 1: Create `shared/wizard/package.json`**

```json
{
  "name": "@sentient/wizard",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run",
    "test:int": "echo 'No integration tests'",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "bun-types": "latest",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `shared/wizard/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {},
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create placeholder `shared/wizard/src/index.ts`**

```ts
export * from "./steps.ts";
```

- [ ] **Step 4: Install workspace dependency**

Run: `bun install`
Expected: `@sentient/wizard` resolves locally; no errors.

- [ ] **Step 5: Commit**

```bash
git add shared/wizard/package.json shared/wizard/tsconfig.json shared/wizard/src/index.ts bun.lock
git commit -m "feat(shared): add @sentient/wizard workspace package"
```

---

### Task 2: Implement `WIZARD_STEPS` + cursor types

**Files:**
- Create: `shared/wizard/src/steps.ts`
- Create: `shared/wizard/src/steps.test.ts`

- [ ] **Step 1: Write failing test `shared/wizard/src/steps.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { WIZARD_STEPS, VALID_FORWARD, VALID_REVERSE, type WizardStepId } from "./steps.ts";

describe("WIZARD_STEPS", () => {
  it("has exactly six steps in order: provider, voice, secrets, bringup, admin, finish", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual([
      "provider",
      "voice",
      "secrets",
      "bringup",
      "admin",
      "finish",
    ]);
  });

  it("every advanceTo points at a valid step id (or null for terminal)", () => {
    const ids = new Set<WizardStepId>(WIZARD_STEPS.map((s) => s.id));
    for (const s of WIZARD_STEPS) {
      if (s.advanceTo === null) continue;
      expect(ids.has(s.advanceTo)).toBe(true);
    }
  });

  it("VALID_FORWARD covers each non-terminal step's advance pair", () => {
    expect(VALID_FORWARD.has("provider→voice")).toBe(true);
    expect(VALID_FORWARD.has("voice→secrets")).toBe(true);
    expect(VALID_FORWARD.has("secrets→bringup")).toBe(true);
    expect(VALID_FORWARD.has("bringup→admin")).toBe(true);
    expect(VALID_FORWARD.has("admin→finish")).toBe(true);
    expect(VALID_FORWARD.size).toBe(5);
  });

  it("VALID_REVERSE only covers steps with explicit backTo", () => {
    expect(VALID_REVERSE.has("voice→provider")).toBe(true);
    expect(VALID_REVERSE.has("secrets→voice")).toBe(true);
    expect(VALID_REVERSE.size).toBe(2);
  });

  it("terminal step has advanceTo=null", () => {
    const finish = WIZARD_STEPS.find((s) => s.id === "finish");
    expect(finish?.advanceTo).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `cd shared/wizard && bunx vitest run src/steps.test.ts`
Expected: FAIL — "Cannot find module './steps.ts'".

- [ ] **Step 3: Implement `shared/wizard/src/steps.ts`**

```ts
import { z } from "zod";

export type WizardStepId =
  | "provider"
  | "voice"
  | "secrets"
  | "bringup"
  | "admin"
  | "finish";

// --- Body schemas (lifted verbatim from gateway/src/api/handlers/wizard.ts) ---

export const ProviderBody = z.object({
  provider: z.enum(["ollama-cloud", "openrouter", "custom"]),
  api_key: z.string().min(1).optional().nullable(),
  base_url: z.string().url().optional().nullable(),
});
export type ProviderBody = z.infer<typeof ProviderBody>;

export const VoiceBody = z.union([
  z.object({ skip: z.literal(true) }),
  z.object({ api_key: z.string().min(1) }),
]);
export type VoiceBody = z.infer<typeof VoiceBody>;

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null));

export const SecretsBody = z.object({
  home_assistant: z
    .object({
      url: optionalString,
      local_ip: optionalString,
      observe_token: optionalString,
      mcp_server_token: optionalString,
    })
    .optional(),
  music_assistant: z
    .object({
      url: optionalString,
      local_ip: optionalString,
      token: optionalString,
    })
    .optional(),
});
export type SecretsBody = z.infer<typeof SecretsBody>;

// --- Step chain ---

export interface WizardStepDef<Body = unknown> {
  id: WizardStepId;
  /** Next step in the chain. null = terminal step (finish). */
  advanceTo: WizardStepId | null;
  /** Previous step user can retreat to. null = no Back button. */
  backTo: WizardStepId | null;
  /** Zod schema for the POST body. null = step has no advance POST
   *  (e.g. bringup polls; admin delegates to /auth/setup). */
  bodySchema: z.ZodType<Body> | null;
  /** Stepper label. */
  label: string;
}

export const WIZARD_STEPS: ReadonlyArray<WizardStepDef> = [
  { id: "provider", advanceTo: "voice",   backTo: null,       bodySchema: ProviderBody, label: "Provider" },
  { id: "voice",    advanceTo: "secrets", backTo: "provider", bodySchema: VoiceBody,    label: "Voice"    },
  { id: "secrets",  advanceTo: "bringup", backTo: "voice",    bodySchema: SecretsBody,  label: "Services" },
  { id: "bringup",  advanceTo: "admin",   backTo: null,       bodySchema: null,         label: "Bringup"  },
  { id: "admin",    advanceTo: "finish",  backTo: null,       bodySchema: null,         label: "Account"  },
  { id: "finish",   advanceTo: null,      backTo: null,       bodySchema: null,         label: "Finish"   },
];

// --- Derived transition sets ---

export const VALID_FORWARD: ReadonlySet<string> = new Set(
  WIZARD_STEPS.filter((s) => s.advanceTo !== null).map((s) => `${s.id}→${s.advanceTo}`),
);

export const VALID_REVERSE: ReadonlySet<string> = new Set(
  WIZARD_STEPS.filter((s) => s.backTo !== null).map((s) => `${s.id}→${s.backTo}`),
);

/** Look up a step definition by id. Returns undefined for unknown ids. */
export function findStep(id: WizardStepId): WizardStepDef | undefined {
  return WIZARD_STEPS.find((s) => s.id === id);
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `cd shared/wizard && bunx vitest run src/steps.test.ts`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add shared/wizard/src/steps.ts shared/wizard/src/steps.test.ts
git commit -m "feat(shared/wizard): declarative step chain with body schemas"
```

---

### Task 3: Wire `@sentient/wizard` into gateway + webui packages

**Files:**
- Modify: `gateway/package.json`
- Modify: `gateway/webui/package.json`

- [ ] **Step 1: Add dep to `gateway/package.json`**

Add to `dependencies` block (alphabetical position between `@sentient/tls` and `@types/dockerode`):

```json
"@sentient/wizard": "workspace:*",
```

- [ ] **Step 2: Add dep to `gateway/webui/package.json`**

Add to `dependencies` block (alphabetical position):

```json
"@sentient/wizard": "workspace:*",
```

- [ ] **Step 3: Re-resolve workspace**

Run: `bun install`
Expected: lock updates; no errors.

- [ ] **Step 4: Verify import resolves**

Run: `cd gateway && bun -e "import('@sentient/wizard').then(m => console.log(Object.keys(m)))"`
Expected: prints exported names including `WIZARD_STEPS`, `VALID_FORWARD`, `VALID_REVERSE`, `findStep`, `ProviderBody`, `VoiceBody`, `SecretsBody`.

- [ ] **Step 5: Commit**

```bash
git add gateway/package.json gateway/webui/package.json bun.lock
git commit -m "build(gateway,webui): depend on @sentient/wizard workspace"
```

---

## Phase 2: install-state cursor migration

### Task 4: Update `state.yaml.tmpl` schema and add migration

**Files:**
- Modify: `gateway/templates/wizard/state.yaml.tmpl`
- Modify: `gateway/src/admin/install-state.ts`
- Modify: `gateway/src/admin/install-state.test.ts`

- [ ] **Step 1: Bump template schema_version**

Open `gateway/templates/wizard/state.yaml.tmpl` and change `schema_version: 0.1.0` to `schema_version: 0.2.0`. The default `wizard_cursor` value (for fresh installs) is unchanged: stays `provider`.

- [ ] **Step 2: Write failing migration test**

Add to `gateway/src/admin/install-state.test.ts` (under existing describe block):

```ts
describe("install-state migration v0.1.0 → v0.2.0", () => {
  it("rewrites cursor='complete' + bootstrap_complete=false → cursor='admin'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-state-mig-"));
    const statePath = join(dir, "state.yaml");
    await writeFile(
      statePath,
      [
        'schema_version: "0.1.0"',
        'installed_version: "0.4.0"',
        "last_upgraded_from: null",
        "last_upgraded_at: null",
        "bootstrap_complete: false",
        'wizard_cursor: "complete"',
        "unlock_verified: true",
      ].join("\n"),
    );
    const state = createInstallState({
      statePath,
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "0.4.0",
    });
    const data = await state.load();
    expect(data.schema_version).toBe("0.2.0");
    expect(data.wizard_cursor).toBe("admin");
    expect(data.bootstrap_complete).toBe(false);
  });

  it("rewrites cursor='complete' + bootstrap_complete=true → cursor='finish'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-state-mig-"));
    const statePath = join(dir, "state.yaml");
    await writeFile(
      statePath,
      [
        'schema_version: "0.1.0"',
        'installed_version: "0.4.0"',
        "last_upgraded_from: null",
        "last_upgraded_at: null",
        "bootstrap_complete: true",
        'wizard_cursor: "complete"',
        "unlock_verified: true",
      ].join("\n"),
    );
    const state = createInstallState({
      statePath,
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "0.4.0",
    });
    const data = await state.load();
    expect(data.schema_version).toBe("0.2.0");
    expect(data.wizard_cursor).toBe("finish");
  });

  it("leaves v0.2.0 state unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-state-mig-"));
    const statePath = join(dir, "state.yaml");
    await writeFile(
      statePath,
      [
        'schema_version: "0.2.0"',
        'installed_version: "0.4.0"',
        "last_upgraded_from: null",
        "last_upgraded_at: null",
        "bootstrap_complete: false",
        'wizard_cursor: "voice"',
        "unlock_verified: true",
      ].join("\n"),
    );
    const state = createInstallState({
      statePath,
      templateDir: TEMPLATE_DIR,
      gatewayVersion: "0.4.0",
    });
    const data = await state.load();
    expect(data.schema_version).toBe("0.2.0");
    expect(data.wizard_cursor).toBe("voice");
  });
});
```

- [ ] **Step 3: Run test, verify failure**

Run: `cd gateway/src && bun test admin/install-state.test.ts`
Expected: FAIL — `expect(data.wizard_cursor).toBe("admin")` got `"complete"` (no migration logic yet).

- [ ] **Step 4: Update `gateway/src/admin/install-state.ts`**

Replace the `WizardCursor` type and the transition sets to match the new chain. Keep the file imports as-is otherwise.

```ts
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { Result } from "@sentient/protocol";
import { VALID_FORWARD, VALID_REVERSE, type WizardStepId } from "@sentient/wizard";
import { parse, stringify } from "yaml";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "install-state"]);

export type WizardCursor = WizardStepId;

const CURRENT_SCHEMA_VERSION = "0.2.0";

export interface InstallStateData {
  schema_version: string;
  installed_version: string;
  last_upgraded_from: string | null;
  last_upgraded_at: string | null;
  bootstrap_complete: boolean;
  wizard_cursor: WizardCursor;
  unlock_verified: boolean;
}

// Rest of the type exports unchanged. Replace VALID_TRANSITIONS and
// VALID_REVERSE_TRANSITIONS in this file with the imports above.
```

Replace the existing `VALID_TRANSITIONS` and `VALID_REVERSE_TRANSITIONS` const declarations with usage of the imported sets (rename references inside `advanceCursor` / `retreatCursor`):

```ts
// Before:
//   if (!VALID_TRANSITIONS.has(transitionKey(from, to))) {...}
// After:
   if (!VALID_FORWARD.has(transitionKey(from, to))) {...}

// Before:
//   if (!VALID_REVERSE_TRANSITIONS.has(transitionKey(from, to))) {...}
// After:
   if (!VALID_REVERSE.has(transitionKey(from, to))) {...}
```

Add a `migrate` function and call it inside `readFromDisk`:

```ts
function migrate(raw: unknown): InstallStateData {
  const data = raw as Record<string, unknown>;
  if (data.schema_version === CURRENT_SCHEMA_VERSION) {
    return data as unknown as InstallStateData;
  }
  if (data.schema_version === "0.1.0" && data.wizard_cursor === "complete") {
    // The "complete" cursor in v0.1.0 covered both the AccountWizard
    // step (when bootstrap_complete=false) and the post-finalize state
    // (when bootstrap_complete=true). v0.2.0 splits these into "admin"
    // and "finish" respectively.
    data.wizard_cursor = data.bootstrap_complete ? "finish" : "admin";
    log.info("install-state.migrated", {
      from: "0.1.0",
      to: CURRENT_SCHEMA_VERSION,
      newCursor: data.wizard_cursor,
    });
  }
  data.schema_version = CURRENT_SCHEMA_VERSION;
  return data as unknown as InstallStateData;
}

async function readFromDisk(): Promise<InstallStateData | null> {
  try {
    const raw = await fs.readFile(cfg.statePath, "utf8");
    const parsed = parse(raw) as unknown;
    const migrated = migrate(parsed);
    if ((parsed as Record<string, unknown>).schema_version !== CURRENT_SCHEMA_VERSION) {
      // Persist the migration result so subsequent boots skip migrate().
      await writeAtomic(migrated);
    }
    return migrated;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}
```

Update the `finish()` method to require cursor `"finish"` (the new terminal pre-bootstrap_complete cursor):

```ts
async finish() {
  try {
    const state = cached ?? (await readFromDisk()) ?? (await bootstrap());
    if (state.wizard_cursor !== "finish") {
      return { ok: false, error: { kind: "cursor-mismatch", expected: "finish", actual: state.wizard_cursor } };
    }
    if (state.bootstrap_complete) return { ok: true, value: undefined };
    const next = { ...state, bootstrap_complete: true };
    await writeAtomic(next);
    cached = next;
    log.info("install-state.bootstrap-complete");
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    return { ok: false, error: { kind: "io-failed", reason: (err as Error).message } };
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd gateway/src && bun test admin/install-state.test.ts`
Expected: PASS — all tests including new migration block.

- [ ] **Step 6: Commit**

```bash
git add gateway/templates/wizard/state.yaml.tmpl gateway/src/admin/install-state.ts gateway/src/admin/install-state.test.ts
git commit -m "feat(install-state): add admin+finish cursors with v0.1.0→v0.2.0 migration"
```

---

### Task 5: `/auth/setup` advances cursor `admin → finish`

**Files:**
- Modify: `gateway/src/api/handlers/auth.ts`
- Modify: `gateway/src/api/handlers/auth.test.ts`

- [ ] **Step 1: Write failing test**

Add to `gateway/src/api/handlers/auth.test.ts`:

```ts
it("handleSetup advances install-state cursor admin → finish on success", async () => {
  const installState = createMockInstallState({ wizard_cursor: "admin", unlock_verified: true });
  const deps = makeDeps({ installState, ... });
  const req = new Request("http://localhost/api/v1/auth/setup", {
    method: "POST",
    body: JSON.stringify({ displayName: "Kevin", pin: "1234", profile: defaultProfile }),
    headers: { "Content-Type": "application/json" },
  });
  const res = await handler(req);
  expect(res.status).toBe(200);
  const data = await installState.load();
  expect(data.wizard_cursor).toBe("finish");
});

it("handleSetup leaves cursor untouched if cursor !== admin", async () => {
  const installState = createMockInstallState({ wizard_cursor: "voice", unlock_verified: true });
  // ... same setup, then assert cursor stays "voice"
});
```

(Use the existing test-helper pattern in this file. If `createMockInstallState` doesn't exist, build a minimal one inline that holds state and exposes `advanceCursor` + `load`.)

- [ ] **Step 2: Run test, verify failure**

Run: `cd gateway/src && bun test api/handlers/auth.test.ts`
Expected: FAIL — cursor doesn't change.

- [ ] **Step 3: Update `gateway/src/api/handlers/auth.ts` `handleSetup`**

Add `installState` to `AuthDeps` interface (if not already present). After the provisioner success block but before returning the response, add:

```ts
const stateBefore = await deps.installState.load();
if (stateBefore.wizard_cursor === "admin") {
  const advance = await deps.installState.advanceCursor("admin", "finish");
  if (!advance.ok) {
    log.warn("setup.cursor-advance-failed", { error: advance.error.kind });
    // Non-fatal: user is created. Wizard can recover via /wizard/finalize
    // which will surface a cursor-mismatch UI error.
  } else {
    log.info("setup.cursor-advanced", { from: "admin", to: "finish" });
  }
}
```

Update `server.ts` (or wherever `AuthDeps` is wired) to pass `installState` into the auth handler factory. Verify by reading the existing `createAuthHandler` call site and adding `installState: services.installState` to the deps object.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd gateway/src && bun test api/handlers/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/api/handlers/auth.ts gateway/src/api/handlers/auth.test.ts gateway/src/server.ts
git commit -m "feat(auth): advance wizard cursor admin → finish on /auth/setup success"
```

---

## Phase 3: Server step files

### Task 6: Implement `step-pipeline.ts`

**Files:**
- Create: `gateway/src/api/wizard/step-pipeline.ts`
- Create: `gateway/src/api/wizard/step-pipeline.test.ts`

- [ ] **Step 1: Define `StepHandler` and `WizardDeps` shapes**

Create `gateway/src/api/wizard/step-pipeline.ts`:

```ts
import type { WizardStepDef, WizardStepId } from "@sentient/wizard";
import type { Result } from "@sentient/protocol";
import type { InstallState, WizardCursor } from "../../admin/install-state.js";
import type { LlmProvider, SecretsStore } from "../../admin/secrets-store.js";
import type { UnlockCode } from "../../admin/unlock-code.js";
import type { ModelEntry } from "../../providers/catalogs/types.js";
import type { OrchestratorStatus } from "../../system-orchestrator/types.js";
import type { ProvidersListResult, VoicePage } from "../handlers/providers.js";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "pipeline"]);

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_INTERNAL_ERROR = 500;

export interface SystemOrchestratorHandle {
  getStatus(): OrchestratorStatus;
  applyAll(): Promise<OrchestratorStatus>;
}

export interface ListVoicesOptions {
  title?: string;
  page?: number;
}

export interface TestProviderResult {
  ok: boolean;
  modelCount?: number;
  sampleModels?: string[];
  error?: string;
}

export interface WizardDeps {
  installState: InstallState;
  unlockCode: UnlockCode;
  secretsStore: SecretsStore;
  testProvider: (provider: LlmProvider, apiKey: string | null, baseUrl: string | null) => Promise<TestProviderResult>;
  listModels?: () => Promise<ProvidersListResult<ModelEntry[]>>;
  listVoices?: (opts?: ListVoicesOptions) => Promise<ProvidersListResult<VoicePage>>;
  systemOrchestrator?: SystemOrchestratorHandle | null;
}

export type StepError = { kind: string; reason?: string };

export interface StepHandler<Body> {
  id: WizardStepId;
  /** Pure: read JSON, zod-validate. Returns "invalid-body" on failure. */
  parse(req: Request): Promise<Result<Body, "invalid-body">>;
  /** Atomic side-effect application. Returns a step error on failure. */
  apply(deps: WizardDeps, body: Body): Promise<Result<void, StepError>>;
  /** Optional fire-and-forget hook fired AFTER cursor advance. */
  postAdvance?(deps: WizardDeps): void;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function assertWizardOpen(state: InstallState, expectedCursor: WizardCursor): Promise<Response | null> {
  const data = await state.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });
  if (data.wizard_cursor !== expectedCursor) {
    return jsonResponse(HTTP_CONFLICT, {
      error: "wizard-cursor-mismatch",
      current_cursor: data.wizard_cursor,
      expected_cursor: expectedCursor,
    });
  }
  return null;
}

export async function assertUnlockVerified(state: InstallState): Promise<Response | null> {
  const data = await state.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });
  return null;
}

export async function runStep<B>(
  deps: WizardDeps,
  handler: StepHandler<B>,
  def: WizardStepDef,
  req: Request,
): Promise<Response> {
  const gate = await assertWizardOpen(deps.installState, def.id);
  if (gate) return gate;

  const parsed = await handler.parse(req);
  if (!parsed.ok) {
    log.warn(`wizard.${def.id}.invalid-body`, {});
    return jsonResponse(HTTP_BAD_REQUEST, { error: "invalid-body" });
  }

  const applied = await handler.apply(deps, parsed.value);
  if (!applied.ok) {
    log.warn(`wizard.${def.id}.apply-failed`, { error: applied.error.kind });
    return jsonResponse(HTTP_INTERNAL_ERROR, {
      error: "step-apply-failed",
      kind: applied.error.kind,
    });
  }

  if (def.advanceTo !== null) {
    const advance = await deps.installState.advanceCursor(def.id, def.advanceTo);
    if (!advance.ok) {
      log.warn(`wizard.${def.id}.advance-failed`, { error: advance.error.kind });
      return jsonResponse(HTTP_CONFLICT, { error: "transition", kind: advance.error.kind });
    }
  }

  try {
    handler.postAdvance?.(deps);
  } catch (err: unknown) {
    log.warn(`wizard.${def.id}.post-advance-throw`, { reason: String(err) });
  }

  log.info(`wizard.${def.id}.success`, { cursor: def.advanceTo });
  return jsonResponse(HTTP_OK, { ok: true, cursor: def.advanceTo });
}

export { jsonResponse };
```

- [ ] **Step 2: Write failing test**

Create `gateway/src/api/wizard/step-pipeline.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runStep, type StepHandler } from "./step-pipeline.ts";
import type { WizardStepDef } from "@sentient/wizard";

function makeInstallState(initial: { wizard_cursor: string; bootstrap_complete?: boolean; unlock_verified?: boolean }) {
  let cursor = initial.wizard_cursor;
  return {
    load: async () => ({
      bootstrap_complete: initial.bootstrap_complete ?? false,
      unlock_verified: initial.unlock_verified ?? true,
      wizard_cursor: cursor,
      schema_version: "0.2.0",
      installed_version: "0.4.0",
      last_upgraded_from: null,
      last_upgraded_at: null,
    }),
    advanceCursor: async (_from: string, to: string) => {
      cursor = to;
      return { ok: true as const, value: undefined };
    },
    retreatCursor: async () => ({ ok: true as const, value: undefined }),
    setUnlockVerified: async () => ({ ok: true as const, value: undefined }),
    finish: async () => ({ ok: true as const, value: undefined }),
  };
}

describe("runStep", () => {
  const def: WizardStepDef = {
    id: "provider",
    advanceTo: "voice",
    backTo: null,
    bodySchema: null,
    label: "Provider",
  };

  it("returns 410 when wizard is closed", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider", bootstrap_complete: true });
    const handler: StepHandler<{ x: number }> = {
      id: "provider",
      parse: async () => ({ ok: true, value: { x: 1 } }),
      apply: async () => ({ ok: true, value: undefined }),
    };
    const res = await runStep({ installState } as any, handler, def, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(410);
  });

  it("returns 400 when parse fails", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider" });
    const handler: StepHandler<unknown> = {
      id: "provider",
      parse: async () => ({ ok: false, error: "invalid-body" }),
      apply: async () => ({ ok: true, value: undefined }),
    };
    const res = await runStep({ installState } as any, handler, def, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("advances cursor on success and returns { ok, cursor }", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider" });
    const advanceSpy = vi.spyOn(installState, "advanceCursor");
    const handler: StepHandler<{}> = {
      id: "provider",
      parse: async () => ({ ok: true, value: {} }),
      apply: async () => ({ ok: true, value: undefined }),
    };
    const res = await runStep({ installState } as any, handler, def, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, cursor: "voice" });
    expect(advanceSpy).toHaveBeenCalledWith("provider", "voice");
  });

  it("fires postAdvance after cursor write succeeds", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider" });
    const postAdvance = vi.fn();
    const handler: StepHandler<{}> = {
      id: "provider",
      parse: async () => ({ ok: true, value: {} }),
      apply: async () => ({ ok: true, value: undefined }),
      postAdvance,
    };
    await runStep({ installState } as any, handler, def, new Request("http://x/", { method: "POST" }));
    expect(postAdvance).toHaveBeenCalledOnce();
  });

  it("returns 500 when apply fails", async () => {
    const installState = makeInstallState({ wizard_cursor: "provider" });
    const handler: StepHandler<{}> = {
      id: "provider",
      parse: async () => ({ ok: true, value: {} }),
      apply: async () => ({ ok: false, error: { kind: "io-failed" } }),
    };
    const res = await runStep({ installState } as any, handler, def, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.kind).toBe("io-failed");
  });
});
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd gateway/src && bun test api/wizard/step-pipeline.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/api/wizard/step-pipeline.ts gateway/src/api/wizard/step-pipeline.test.ts
git commit -m "feat(wizard): step-pipeline runs gate→parse→apply→advance"
```

---

### Task 7: Implement `steps/provider.ts`

**Files:**
- Create: `gateway/src/api/wizard/steps/provider.ts`
- Create: `gateway/src/api/wizard/steps/__tests__/provider.test.ts`

- [ ] **Step 1: Implement step handler**

Create `gateway/src/api/wizard/steps/provider.ts`:

```ts
import { ProviderBody } from "@sentient/wizard";
import type { Result } from "@sentient/protocol";
import type { StepHandler, WizardDeps, StepError } from "../step-pipeline.ts";
import { getLog } from "../../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "provider"]);

type Body = import("zod").infer<typeof ProviderBody>;

async function parse(req: Request): Promise<Result<Body, "invalid-body">> {
  const raw = await req.json().catch(() => null);
  const parsed = ProviderBody.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid-body" };
  return { ok: true, value: parsed.data };
}

async function apply(deps: WizardDeps, body: Body): Promise<Result<void, StepError>> {
  const { provider, api_key, base_url } = body;
  const patch = { api_key: api_key ?? null, base_url: base_url ?? null };

  const keyResult = await deps.secretsStore.setLlmProviderKey(provider, patch);
  if (!keyResult.ok) {
    log.warn("set-key-failed", { provider, error: keyResult.error.kind });
    return { ok: false, error: { kind: "secrets-write-failed" } };
  }

  const activeResult = await deps.secretsStore.setActiveLlmProvider(provider);
  if (!activeResult.ok) {
    log.warn("set-active-failed", { provider, error: activeResult.error.kind });
    return { ok: false, error: { kind: "secrets-write-failed" } };
  }

  return { ok: true, value: undefined };
}

export const providerStep: StepHandler<Body> = {
  id: "provider",
  parse,
  apply,
};
```

- [ ] **Step 2: Write contract test**

Create `gateway/src/api/wizard/steps/__tests__/provider.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { providerStep } from "../provider.ts";
import type { WizardDeps } from "../../step-pipeline.ts";

function makeDeps(overrides: Partial<WizardDeps> = {}): WizardDeps {
  return {
    secretsStore: {
      setLlmProviderKey: vi.fn(async () => ({ ok: true, value: undefined })),
      setActiveLlmProvider: vi.fn(async () => ({ ok: true, value: undefined })),
    },
    ...overrides,
  } as unknown as WizardDeps;
}

describe("providerStep", () => {
  it("parses valid body { provider, api_key }", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ provider: "openrouter", api_key: "sk-test" }),
    });
    const result = await providerStep.parse(req);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.provider).toBe("openrouter");
  });

  it("rejects missing provider", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ api_key: "x" }) });
    const result = await providerStep.parse(req);
    expect(result.ok).toBe(false);
  });

  it("apply writes provider key and active provider", async () => {
    const deps = makeDeps();
    const result = await providerStep.apply(deps, {
      provider: "openrouter",
      api_key: "sk-test",
      base_url: null,
    });
    expect(result.ok).toBe(true);
    expect(deps.secretsStore.setLlmProviderKey).toHaveBeenCalledWith("openrouter", {
      api_key: "sk-test",
      base_url: null,
    });
    expect(deps.secretsStore.setActiveLlmProvider).toHaveBeenCalledWith("openrouter");
  });

  it("apply returns secrets-write-failed when set-key fails", async () => {
    const deps = makeDeps({
      secretsStore: {
        setLlmProviderKey: async () => ({ ok: false, error: { kind: "io-error" } }),
        setActiveLlmProvider: async () => ({ ok: true, value: undefined }),
      } as any,
    });
    const result = await providerStep.apply(deps, { provider: "openrouter", api_key: "sk", base_url: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("secrets-write-failed");
  });
});
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cd gateway/src && bun test api/wizard/steps/__tests__/provider.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/api/wizard/steps/provider.ts gateway/src/api/wizard/steps/__tests__/provider.test.ts
git commit -m "feat(wizard): provider step file"
```

---

### Task 8: Implement `steps/voice.ts`

**Files:**
- Create: `gateway/src/api/wizard/steps/voice.ts`
- Create: `gateway/src/api/wizard/steps/__tests__/voice.test.ts`

- [ ] **Step 1: Implement step handler**

```ts
// gateway/src/api/wizard/steps/voice.ts
import { VoiceBody } from "@sentient/wizard";
import type { Result } from "@sentient/protocol";
import type { StepHandler, WizardDeps, StepError } from "../step-pipeline.ts";
import { getLog } from "../../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "voice"]);

type Body = import("zod").infer<typeof VoiceBody>;

async function parse(req: Request): Promise<Result<Body, "invalid-body">> {
  const raw = await req.json().catch(() => null);
  const parsed = VoiceBody.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid-body" };
  return { ok: true, value: parsed.data };
}

async function apply(deps: WizardDeps, body: Body): Promise<Result<void, StepError>> {
  if ("skip" in body) {
    log.info("skipped", {});
    return { ok: true, value: undefined };
  }
  const result = await deps.secretsStore.setFishAudioKey(body.api_key);
  if (!result.ok) {
    log.warn("set-key-failed", { error: result.error.kind });
    return { ok: false, error: { kind: "secrets-write-failed" } };
  }
  return { ok: true, value: undefined };
}

export const voiceStep: StepHandler<Body> = {
  id: "voice",
  parse,
  apply,
};
```

- [ ] **Step 2: Write contract test**

```ts
// gateway/src/api/wizard/steps/__tests__/voice.test.ts
import { describe, expect, it, vi } from "vitest";
import { voiceStep } from "../voice.ts";
import type { WizardDeps } from "../../step-pipeline.ts";

function makeDeps(setFishAudioKey: any = vi.fn(async () => ({ ok: true, value: undefined }))): WizardDeps {
  return { secretsStore: { setFishAudioKey } } as unknown as WizardDeps;
}

describe("voiceStep", () => {
  it("parses { skip: true }", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ skip: true }) });
    const result = await voiceStep.parse(req);
    expect(result.ok).toBe(true);
  });

  it("parses { api_key }", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ api_key: "k" }) });
    const result = await voiceStep.parse(req);
    expect(result.ok).toBe(true);
  });

  it("apply with skip:true does NOT write key", async () => {
    const setFishAudioKey = vi.fn();
    const deps = makeDeps(setFishAudioKey);
    await voiceStep.apply(deps, { skip: true });
    expect(setFishAudioKey).not.toHaveBeenCalled();
  });

  it("apply with api_key writes the key", async () => {
    const setFishAudioKey = vi.fn(async () => ({ ok: true, value: undefined }));
    const deps = makeDeps(setFishAudioKey);
    await voiceStep.apply(deps, { api_key: "fish-key" });
    expect(setFishAudioKey).toHaveBeenCalledWith("fish-key");
  });
});
```

- [ ] **Step 3: Run, pass, commit**

```bash
cd gateway/src && bun test api/wizard/steps/__tests__/voice.test.ts
git add gateway/src/api/wizard/steps/voice.ts gateway/src/api/wizard/steps/__tests__/voice.test.ts
git commit -m "feat(wizard): voice step file"
```

---

### Task 9: Implement `steps/secrets.ts`

**Files:**
- Create: `gateway/src/api/wizard/steps/secrets.ts`
- Create: `gateway/src/api/wizard/steps/__tests__/secrets.test.ts`

- [ ] **Step 1: Implement step handler**

```ts
// gateway/src/api/wizard/steps/secrets.ts
import { SecretsBody } from "@sentient/wizard";
import type { Result } from "@sentient/protocol";
import type { StepHandler, WizardDeps, StepError } from "../step-pipeline.ts";
import type { SecretsStore } from "../../../admin/secrets-store.js";
import { getLog } from "../../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "secrets"]);

type Body = import("zod").infer<typeof SecretsBody>;

async function writeAll(store: SecretsStore, body: Body): Promise<string | null> {
  const ha = body.home_assistant;
  if (ha) {
    if (ha.url !== undefined) {
      const r = await store.setHomeAssistantUrl(ha.url);
      if (!r.ok) return r.error.kind;
    }
    if (ha.local_ip !== undefined) {
      const r = await store.setHomeAssistantLocalIp(ha.local_ip);
      if (!r.ok) return r.error.kind;
    }
    if (ha.observe_token !== undefined) {
      const r = await store.setHomeAssistantToken("observe_token", ha.observe_token);
      if (!r.ok) return r.error.kind;
    }
    if (ha.mcp_server_token !== undefined) {
      const r = await store.setHomeAssistantToken("mcp_server_token", ha.mcp_server_token);
      if (!r.ok) return r.error.kind;
    }
  }
  const ma = body.music_assistant;
  if (ma) {
    if (ma.url !== undefined) {
      const r = await store.setMusicAssistantUrl(ma.url);
      if (!r.ok) return r.error.kind;
    }
    if (ma.local_ip !== undefined) {
      const r = await store.setMusicAssistantLocalIp(ma.local_ip);
      if (!r.ok) return r.error.kind;
    }
    if (ma.token !== undefined) {
      const r = await store.setMusicAssistantToken(ma.token);
      if (!r.ok) return r.error.kind;
    }
  }
  return null;
}

async function parse(req: Request): Promise<Result<Body, "invalid-body">> {
  const raw = await req.json().catch(() => null);
  const parsed = SecretsBody.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: "invalid-body" };
  return { ok: true, value: parsed.data };
}

async function apply(deps: WizardDeps, body: Body): Promise<Result<void, StepError>> {
  const writeError = await writeAll(deps.secretsStore, body);
  if (writeError) {
    log.warn("write-failed", { error: writeError });
    return { ok: false, error: { kind: "secrets-write-failed", reason: writeError } };
  }
  return { ok: true, value: undefined };
}

function postAdvance(deps: WizardDeps): void {
  if (!deps.systemOrchestrator) {
    log.warn("first-apply.no-orchestrator", {});
    return;
  }
  void deps.systemOrchestrator.applyAll().catch((err: unknown) => {
    log.error("first-apply.crashed", { reason: String(err) });
  });
}

export const secretsStep: StepHandler<Body> = {
  id: "secrets",
  parse,
  apply,
  postAdvance,
};
```

- [ ] **Step 2: Write contract test**

```ts
// gateway/src/api/wizard/steps/__tests__/secrets.test.ts
import { describe, expect, it, vi } from "vitest";
import { secretsStep } from "../secrets.ts";

function makeStore() {
  return {
    setHomeAssistantUrl: vi.fn(async () => ({ ok: true, value: undefined })),
    setHomeAssistantLocalIp: vi.fn(async () => ({ ok: true, value: undefined })),
    setHomeAssistantToken: vi.fn(async () => ({ ok: true, value: undefined })),
    setMusicAssistantUrl: vi.fn(async () => ({ ok: true, value: undefined })),
    setMusicAssistantLocalIp: vi.fn(async () => ({ ok: true, value: undefined })),
    setMusicAssistantToken: vi.fn(async () => ({ ok: true, value: undefined })),
  };
}

describe("secretsStep", () => {
  it("parses empty body as { } (all fields optional)", async () => {
    const req = new Request("http://x/", { method: "POST", body: "{}" });
    const r = await secretsStep.parse(req);
    expect(r.ok).toBe(true);
  });

  it("apply writes both ha + ma fields when present", async () => {
    const secretsStore = makeStore();
    await secretsStep.apply({ secretsStore } as any, {
      home_assistant: { url: "http://h", local_ip: "1.2.3.4", observe_token: "o", mcp_server_token: "m" },
      music_assistant: { url: "http://m", local_ip: "1.2.3.4", token: "t" },
    } as any);
    expect(secretsStore.setHomeAssistantUrl).toHaveBeenCalledWith("http://h");
    expect(secretsStore.setHomeAssistantLocalIp).toHaveBeenCalledWith("1.2.3.4");
    expect(secretsStore.setHomeAssistantToken).toHaveBeenCalledWith("observe_token", "o");
    expect(secretsStore.setHomeAssistantToken).toHaveBeenCalledWith("mcp_server_token", "m");
    expect(secretsStore.setMusicAssistantUrl).toHaveBeenCalledWith("http://m");
    expect(secretsStore.setMusicAssistantToken).toHaveBeenCalledWith("t");
  });

  it("postAdvance kicks orchestrator.applyAll", () => {
    const applyAll = vi.fn(async () => ({}));
    secretsStep.postAdvance!({ systemOrchestrator: { applyAll } } as any);
    expect(applyAll).toHaveBeenCalledOnce();
  });

  it("postAdvance is no-op when orchestrator is null", () => {
    expect(() => secretsStep.postAdvance!({ systemOrchestrator: null } as any)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run, pass, commit**

```bash
cd gateway/src && bun test api/wizard/steps/__tests__/secrets.test.ts
git add gateway/src/api/wizard/steps/secrets.ts gateway/src/api/wizard/steps/__tests__/secrets.test.ts
git commit -m "feat(wizard): secrets step file with orchestrator post-advance kick"
```

---

### Task 10: Implement `steps/finish.ts`

**Files:**
- Create: `gateway/src/api/wizard/steps/finish.ts`
- Create: `gateway/src/api/wizard/steps/__tests__/finish.test.ts`

The `finish` step is the only step where the cursor → bootstrap_complete flip happens. It runs OUTSIDE the standard `runStep` pipeline because the side effect (flip + clear unlock code) doesn't fit the "advance cursor" pattern. We export a one-shot async handler that the router dispatches directly.

- [ ] **Step 1: Implement handler**

```ts
// gateway/src/api/wizard/steps/finish.ts
import { jsonResponse } from "../step-pipeline.ts";
import type { WizardDeps } from "../step-pipeline.ts";
import { getLog } from "../../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "finish"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_INTERNAL_ERROR = 500;

export async function handleFinish(deps: WizardDeps, _req: Request): Promise<Response> {
  const data = await deps.installState.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });
  if (data.wizard_cursor !== "finish") {
    return jsonResponse(HTTP_CONFLICT, {
      error: "wizard-cursor-mismatch",
      current_cursor: data.wizard_cursor,
      expected_cursor: "finish",
    });
  }

  const finishResult = await deps.installState.finish();
  if (!finishResult.ok) {
    log.warn("finish-failed", { error: finishResult.error.kind });
    return jsonResponse(HTTP_INTERNAL_ERROR, { error: "state-write-failed" });
  }

  await deps.unlockCode.clear();
  log.info("success", {});
  return jsonResponse(HTTP_OK, { ok: true });
}
```

- [ ] **Step 2: Write test**

```ts
// gateway/src/api/wizard/steps/__tests__/finish.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleFinish } from "../finish.ts";

function makeDeps(cursor: string, bootstrap_complete = false) {
  const installState = {
    load: vi.fn(async () => ({
      bootstrap_complete,
      unlock_verified: true,
      wizard_cursor: cursor,
      schema_version: "0.2.0",
      installed_version: "0.4.0",
      last_upgraded_from: null,
      last_upgraded_at: null,
    })),
    finish: vi.fn(async () => ({ ok: true, value: undefined })),
  };
  const unlockCode = { clear: vi.fn(async () => undefined) };
  return { installState, unlockCode } as any;
}

describe("handleFinish", () => {
  it("returns 200 and clears unlock when cursor=finish", async () => {
    const deps = makeDeps("finish");
    const res = await handleFinish(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(deps.installState.finish).toHaveBeenCalledOnce();
    expect(deps.unlockCode.clear).toHaveBeenCalledOnce();
  });

  it("returns 410 when bootstrap_complete=true", async () => {
    const deps = makeDeps("finish", true);
    const res = await handleFinish(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(410);
  });

  it("returns 409 when cursor != finish", async () => {
    const deps = makeDeps("admin");
    const res = await handleFinish(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(409);
    expect(deps.installState.finish).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run, pass, commit**

```bash
cd gateway/src && bun test api/wizard/steps/__tests__/finish.test.ts
git add gateway/src/api/wizard/steps/finish.ts gateway/src/api/wizard/steps/__tests__/finish.test.ts
git commit -m "feat(wizard): finish step flips bootstrap_complete on cursor=finish"
```

---

### Task 11: Implement `steps/bringup.ts`

**Files:**
- Create: `gateway/src/api/wizard/steps/bringup.ts`
- Create: `gateway/src/api/wizard/steps/__tests__/bringup.test.ts`

`bringup` step has no advance POST body. Two operations: `retry` (re-kick applyAll) and `complete` (advance cursor bringup → admin if orchestrator state is "ready"). Both run outside the standard runStep pipeline.

- [ ] **Step 1: Implement helpers**

```ts
// gateway/src/api/wizard/steps/bringup.ts
import { jsonResponse } from "../step-pipeline.ts";
import type { WizardDeps } from "../step-pipeline.ts";
import { getLog } from "../../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "step", "bringup"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_PRECONDITION_FAILED = 412;

export async function handleRetry(deps: WizardDeps, _req: Request): Promise<Response> {
  const data = await deps.installState.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });
  if (data.wizard_cursor !== "bringup") {
    return jsonResponse(HTTP_CONFLICT, {
      error: "wizard-cursor-mismatch",
      current_cursor: data.wizard_cursor,
      expected_cursor: "bringup",
    });
  }

  if (!deps.systemOrchestrator) {
    log.warn("retry.no-orchestrator", {});
    return jsonResponse(HTTP_PRECONDITION_FAILED, { error: "no-orchestrator" });
  }
  void deps.systemOrchestrator.applyAll().catch((err: unknown) => {
    log.error("retry.crashed", { reason: String(err) });
  });
  log.info("retry.kicked", {});
  return jsonResponse(HTTP_OK, { ok: true });
}

export async function handleComplete(deps: WizardDeps, _req: Request): Promise<Response> {
  const status = deps.systemOrchestrator?.getStatus() ?? null;
  if (!status || status.state !== "ready") {
    log.warn("complete.not-ready", { state: status?.state ?? "no-orchestrator" });
    return jsonResponse(HTTP_PRECONDITION_FAILED, { error: "not-ready", status });
  }

  const advance = await deps.installState.advanceCursor("bringup", "admin");
  if (!advance.ok) {
    log.warn("complete.advance-failed", { error: advance.error.kind });
    return jsonResponse(HTTP_CONFLICT, { error: "transition", kind: advance.error.kind });
  }

  log.info("complete.success", {});
  return jsonResponse(HTTP_OK, { ok: true, cursor: "admin" });
}
```

- [ ] **Step 2: Write test**

```ts
// gateway/src/api/wizard/steps/__tests__/bringup.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleRetry, handleComplete } from "../bringup.ts";

function makeDeps(opts: {
  cursor: string;
  bootstrap_complete?: boolean;
  status?: { state: string };
}) {
  return {
    installState: {
      load: async () => ({
        bootstrap_complete: opts.bootstrap_complete ?? false,
        unlock_verified: true,
        wizard_cursor: opts.cursor,
        schema_version: "0.2.0",
        installed_version: "0.4.0",
        last_upgraded_from: null,
        last_upgraded_at: null,
      }),
      advanceCursor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
    systemOrchestrator: {
      getStatus: () => opts.status ?? { state: "applying" },
      applyAll: vi.fn(async () => ({})),
    },
  } as any;
}

describe("bringup retry", () => {
  it("kicks applyAll when cursor=bringup", async () => {
    const deps = makeDeps({ cursor: "bringup" });
    const res = await handleRetry(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(deps.systemOrchestrator.applyAll).toHaveBeenCalledOnce();
  });

  it("returns 409 when cursor != bringup", async () => {
    const deps = makeDeps({ cursor: "secrets" });
    const res = await handleRetry(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(409);
  });
});

describe("bringup complete", () => {
  it("advances cursor bringup → admin when orchestrator ready", async () => {
    const deps = makeDeps({ cursor: "bringup", status: { state: "ready" } });
    const res = await handleComplete(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cursor).toBe("admin");
    expect(deps.installState.advanceCursor).toHaveBeenCalledWith("bringup", "admin");
  });

  it("returns 412 when orchestrator not ready", async () => {
    const deps = makeDeps({ cursor: "bringup", status: { state: "applying" } });
    const res = await handleComplete(deps, new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(412);
  });
});
```

- [ ] **Step 3: Run, pass, commit**

```bash
cd gateway/src && bun test api/wizard/steps/__tests__/bringup.test.ts
git add gateway/src/api/wizard/steps/bringup.ts gateway/src/api/wizard/steps/__tests__/bringup.test.ts
git commit -m "feat(wizard): bringup retry + complete helpers"
```

---

### Task 12: Implement `steps/admin.ts`

The `admin` step has no advance POST. The cursor advance fires from `auth.ts/handleSetup` (Task 5). This file exists only as a marker so the registry remains symmetrical and future devs find it.

**Files:**
- Create: `gateway/src/api/wizard/steps/admin.ts`

- [ ] **Step 1: Implement marker**

```ts
// gateway/src/api/wizard/steps/admin.ts
//
// The `admin` cursor maps to the AccountWizard step in the webui.
// Cursor advance (admin → finish) is triggered server-side by
// /api/v1/auth/setup on successful first-admin creation, NOT by a
// /api/v1/wizard/admin POST. This file documents that contract — there
// is no StepHandler to export.
export const ADMIN_STEP_NOTE =
  "advance triggered by gateway/src/api/handlers/auth.ts/handleSetup";
```

- [ ] **Step 2: Commit**

```bash
git add gateway/src/api/wizard/steps/admin.ts
git commit -m "docs(wizard): mark admin step — advance owned by auth/setup"
```

---

### Task 13: Implement `meta/unlock.ts`

**Files:**
- Create: `gateway/src/api/wizard/meta/unlock.ts`
- Create: `gateway/src/api/wizard/meta/__tests__/unlock.test.ts`

- [ ] **Step 1: Implement**

Lift the existing `handleUnlock` from `gateway/src/api/handlers/wizard.ts:106-128` verbatim into a new file. Update imports to use `WizardDeps` from `step-pipeline.ts` and `jsonResponse` helper.

```ts
// gateway/src/api/wizard/meta/unlock.ts
import { z } from "zod";
import { jsonResponse } from "../step-pipeline.ts";
import type { WizardDeps } from "../step-pipeline.ts";
import { getLog } from "../../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "meta", "unlock"]);

const UNLOCK_FAIL_DELAY_MS = 800;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_GONE = 410;
const HTTP_INTERNAL_ERROR = 500;

const UnlockBody = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function handleUnlock(deps: WizardDeps, req: Request): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = UnlockBody.safeParse(raw);
  if (!parsed.success) return jsonResponse(HTTP_BAD_REQUEST, { error: "invalid-body" });

  const data = await deps.installState.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });

  const valid = await deps.unlockCode.verify(parsed.data.code);
  if (!valid) {
    await new Promise<void>((resolve) => setTimeout(resolve, UNLOCK_FAIL_DELAY_MS));
    log.warn("failed", {});
    return jsonResponse(HTTP_UNAUTHORIZED, { error: "invalid-code" });
  }

  const result = await deps.installState.setUnlockVerified();
  if (!result.ok) {
    log.warn("set-verified-failed", { error: result.error.kind });
    return jsonResponse(HTTP_INTERNAL_ERROR, { error: "state-write-failed" });
  }
  log.info("success", {});
  return jsonResponse(HTTP_OK, { ok: true });
}
```

- [ ] **Step 2: Write test**

```ts
// gateway/src/api/wizard/meta/__tests__/unlock.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleUnlock } from "../unlock.ts";

function makeDeps(opts: { codeValid: boolean; bootstrap_complete?: boolean }) {
  return {
    installState: {
      load: async () => ({
        bootstrap_complete: opts.bootstrap_complete ?? false,
        unlock_verified: false,
        wizard_cursor: "provider",
        schema_version: "0.2.0",
      }),
      setUnlockVerified: vi.fn(async () => ({ ok: true, value: undefined })),
    },
    unlockCode: { verify: async () => opts.codeValid },
  } as any;
}

describe("handleUnlock", () => {
  it("400 on bad body", async () => {
    const deps = makeDeps({ codeValid: false });
    const res = await handleUnlock(deps, new Request("http://x/", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
  });

  it("410 when bootstrap_complete", async () => {
    const deps = makeDeps({ codeValid: true, bootstrap_complete: true });
    const res = await handleUnlock(deps, new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    }));
    expect(res.status).toBe(410);
  });

  it("401 on invalid code", async () => {
    const deps = makeDeps({ codeValid: false });
    const res = await handleUnlock(deps, new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ code: "999999" }),
    }));
    expect(res.status).toBe(401);
  });

  it("200 + sets unlock_verified on valid code", async () => {
    const deps = makeDeps({ codeValid: true });
    const res = await handleUnlock(deps, new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    }));
    expect(res.status).toBe(200);
    expect(deps.installState.setUnlockVerified).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run, pass, commit**

```bash
cd gateway/src && bun test api/wizard/meta/__tests__/unlock.test.ts
git add gateway/src/api/wizard/meta/unlock.ts gateway/src/api/wizard/meta/__tests__/unlock.test.ts
git commit -m "feat(wizard): unlock meta-handler"
```

---

### Task 14: Implement `meta/back.ts`

**Files:**
- Create: `gateway/src/api/wizard/meta/back.ts`
- Create: `gateway/src/api/wizard/meta/__tests__/back.test.ts`

- [ ] **Step 1: Implement**

```ts
// gateway/src/api/wizard/meta/back.ts
import { z } from "zod";
import { findStep, type WizardStepId } from "@sentient/wizard";
import { jsonResponse } from "../step-pipeline.ts";
import type { WizardDeps } from "../step-pipeline.ts";
import { getLog } from "../../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "meta", "back"]);

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;

const BackBody = z.object({
  from: z.enum(["voice", "secrets", "provider", "bringup", "admin", "finish"]),
});

export async function handleBack(deps: WizardDeps, req: Request): Promise<Response> {
  const data = await deps.installState.load();
  if (data.bootstrap_complete) return jsonResponse(HTTP_GONE, { error: "wizard-closed" });
  if (!data.unlock_verified) return jsonResponse(HTTP_UNAUTHORIZED, { error: "unlock-required" });

  const raw = await req.json().catch(() => null);
  const parsed = BackBody.safeParse(raw);
  if (!parsed.success) return jsonResponse(HTTP_BAD_REQUEST, { error: "invalid-body" });

  const def = findStep(parsed.data.from as WizardStepId);
  if (!def?.backTo) {
    log.warn("no-back-target", { from: parsed.data.from });
    return jsonResponse(HTTP_CONFLICT, { error: "no-back-target" });
  }

  const result = await deps.installState.retreatCursor(def.id, def.backTo);
  if (!result.ok) {
    log.warn("failed", { from: def.id, to: def.backTo, error: result.error.kind });
    return jsonResponse(HTTP_CONFLICT, { error: "transition", kind: result.error.kind });
  }

  log.info("success", { from: def.id, to: def.backTo });
  return jsonResponse(HTTP_OK, { ok: true, cursor: def.backTo });
}
```

- [ ] **Step 2: Write test**

```ts
// gateway/src/api/wizard/meta/__tests__/back.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleBack } from "../back.ts";

function makeDeps() {
  return {
    installState: {
      load: async () => ({
        bootstrap_complete: false,
        unlock_verified: true,
        wizard_cursor: "secrets",
        schema_version: "0.2.0",
      }),
      retreatCursor: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  } as any;
}

describe("handleBack", () => {
  it("derives target from registry: from=voice → to=provider", async () => {
    const deps = makeDeps();
    await handleBack(deps, new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ from: "voice" }),
    }));
    expect(deps.installState.retreatCursor).toHaveBeenCalledWith("voice", "provider");
  });

  it("derives target from registry: from=secrets → to=voice", async () => {
    const deps = makeDeps();
    await handleBack(deps, new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ from: "secrets" }),
    }));
    expect(deps.installState.retreatCursor).toHaveBeenCalledWith("secrets", "voice");
  });

  it("returns 409 when from has no backTo (e.g. provider)", async () => {
    const deps = makeDeps();
    const res = await handleBack(deps, new Request("http://x/", {
      method: "POST",
      body: JSON.stringify({ from: "provider" }),
    }));
    expect(res.status).toBe(409);
    expect(deps.installState.retreatCursor).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run, pass, commit**

```bash
cd gateway/src && bun test api/wizard/meta/__tests__/back.test.ts
git add gateway/src/api/wizard/meta/back.ts gateway/src/api/wizard/meta/__tests__/back.test.ts
git commit -m "feat(wizard): back handler derives target from registry"
```

---

### Task 15: Implement `meta/test-provider.ts`

Lift verbatim from `gateway/src/api/handlers/wizard.ts:353-367`. Same body schema, same dependency on `deps.testProvider`.

**Files:**
- Create: `gateway/src/api/wizard/meta/test-provider.ts`

- [ ] **Step 1: Implement**

```ts
// gateway/src/api/wizard/meta/test-provider.ts
import { ProviderBody } from "@sentient/wizard";
import { jsonResponse, assertUnlockVerified } from "../step-pipeline.ts";
import type { WizardDeps } from "../step-pipeline.ts";
import { getLog } from "../../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "meta", "test-provider"]);

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

export async function handleTestProvider(deps: WizardDeps, req: Request): Promise<Response> {
  const gate = await assertUnlockVerified(deps.installState);
  if (gate) return gate;

  const raw = await req.json().catch(() => null);
  const parsed = ProviderBody.safeParse(raw);
  if (!parsed.success) return jsonResponse(HTTP_BAD_REQUEST, { error: "invalid-body" });

  const { provider, api_key, base_url } = parsed.data;
  log.debug("start", { provider });
  const result = await deps.testProvider(provider, api_key ?? null, base_url ?? null);
  log.info("result", { provider, ok: result.ok, modelCount: result.modelCount });
  return jsonResponse(HTTP_OK, result);
}
```

- [ ] **Step 2: Commit**

```bash
git add gateway/src/api/wizard/meta/test-provider.ts
git commit -m "feat(wizard): test-provider meta-handler"
```

---

### Task 16: Implement `meta/catalog.ts`

Lift `handleWizardActiveLlm`, `handleWizardModels`, `handleWizardVoices`, `parseListVoicesOptions` verbatim from `gateway/src/api/handlers/wizard.ts:376-457`.

**Files:**
- Create: `gateway/src/api/wizard/meta/catalog.ts`

- [ ] **Step 1: Implement**

```ts
// gateway/src/api/wizard/meta/catalog.ts
import { jsonResponse, assertUnlockVerified } from "../step-pipeline.ts";
import type { WizardDeps, ListVoicesOptions } from "../step-pipeline.ts";
import { getLog } from "../../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "meta", "catalog"]);

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

export async function handleActiveLlm(deps: WizardDeps): Promise<Response> {
  const gate = await assertUnlockVerified(deps.installState);
  if (gate) return gate;

  const result = await deps.secretsStore.getActiveLlm();
  if (!result.ok) {
    log.warn("active-llm.failed", { kind: result.error.kind });
    return jsonResponse(HTTP_NOT_FOUND, { error: "no-provider-configured" });
  }
  log.debug("active-llm.ok", { provider: result.value.provider });
  return jsonResponse(HTTP_OK, { provider: result.value.provider });
}

export async function handleModels(deps: WizardDeps): Promise<Response> {
  const gate = await assertUnlockVerified(deps.installState);
  if (gate) return gate;

  if (!deps.listModels) {
    log.warn("models.no-impl", {});
    return jsonResponse(HTTP_NOT_FOUND, { error: "not-configured" });
  }

  const result = await deps.listModels();
  if (!result.ok) {
    log.warn("models.upstream-failed", { kind: result.error.kind });
    return jsonResponse(503, { error: "upstream-unavailable" });
  }
  const stale = result.stale ?? false;
  log.info("models.ok", { count: result.value.length, stale });
  return jsonResponse(HTTP_OK, { models: result.value, stale });
}

export async function handleVoices(deps: WizardDeps, url: URL): Promise<Response> {
  const gate = await assertUnlockVerified(deps.installState);
  if (gate) return gate;

  if (!deps.listVoices) {
    log.warn("voices.no-impl", {});
    return jsonResponse(HTTP_NOT_FOUND, { error: "not-configured" });
  }

  const opts = parseListVoicesOptions(url.searchParams);
  const result = await deps.listVoices(opts);
  if (!result.ok) {
    log.warn("voices.upstream-failed", { kind: result.error.kind });
    return jsonResponse(503, { error: "upstream-unavailable" });
  }
  const stale = result.stale ?? false;
  log.info("voices.ok", { count: result.value.voices.length, hasMore: result.value.hasMore, stale });
  return jsonResponse(HTTP_OK, { voices: result.value.voices, hasMore: result.value.hasMore, stale });
}

function parseListVoicesOptions(params: URLSearchParams): ListVoicesOptions {
  const opts: ListVoicesOptions = {};
  const title = params.get("title");
  if (title !== null) opts.title = title;
  const pageRaw = params.get("page");
  if (pageRaw !== null) {
    const page = Number.parseInt(pageRaw, 10);
    if (Number.isFinite(page) && page >= 1) opts.page = page;
  }
  return opts;
}
```

- [ ] **Step 2: Commit**

```bash
git add gateway/src/api/wizard/meta/catalog.ts
git commit -m "feat(wizard): catalog meta-handlers (active-llm + models + voices)"
```

---

### Task 17: Implement `router.ts`

**Files:**
- Create: `gateway/src/api/wizard/router.ts`

- [ ] **Step 1: Implement**

```ts
// gateway/src/api/wizard/router.ts
import { findStep, type WizardStepId } from "@sentient/wizard";
import { jsonResponse, runStep, type StepHandler, type WizardDeps } from "./step-pipeline.ts";
import { providerStep } from "./steps/provider.ts";
import { voiceStep } from "./steps/voice.ts";
import { secretsStep } from "./steps/secrets.ts";
import { handleRetry, handleComplete } from "./steps/bringup.ts";
import { handleFinish } from "./steps/finish.ts";
import { handleUnlock } from "./meta/unlock.ts";
import { handleBack } from "./meta/back.ts";
import { handleTestProvider } from "./meta/test-provider.ts";
import { handleActiveLlm, handleModels, handleVoices } from "./meta/catalog.ts";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard", "router"]);

const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;

const STEP_HANDLERS: Partial<Record<WizardStepId, StepHandler<unknown>>> = {
  provider: providerStep as StepHandler<unknown>,
  voice:    voiceStep    as StepHandler<unknown>,
  secrets:  secretsStep  as StepHandler<unknown>,
  // bringup, admin, finish use bespoke handlers (handleRetry/Complete/Finish).
};

export function createWizardRouter(deps: WizardDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    log.debug("request", { method: req.method, path });

    if (req.method === "GET") {
      if (path === "/api/v1/wizard/active-llm")        return handleActiveLlm(deps);
      if (path === "/api/v1/wizard/providers/models")  return handleModels(deps);
      if (path === "/api/v1/wizard/providers/voices")  return handleVoices(deps, url);
      return jsonResponse(HTTP_NOT_FOUND, { error: "not-found" });
    }

    if (req.method !== "POST") {
      return jsonResponse(HTTP_METHOD_NOT_ALLOWED, { error: "method-not-allowed" });
    }

    if (path === "/api/v1/wizard/unlock")            return handleUnlock(deps, req);
    if (path === "/api/v1/wizard/back")              return handleBack(deps, req);
    if (path === "/api/v1/wizard/test-provider")     return handleTestProvider(deps, req);
    if (path === "/api/v1/wizard/retry-bringup")     return handleRetry(deps, req);
    if (path === "/api/v1/wizard/complete-bringup")  return handleComplete(deps, req);
    if (path === "/api/v1/wizard/finalize")          return handleFinish(deps, req);

    // Step-pipeline dispatch: /api/v1/wizard/<step-id>
    const stepMatch = path.match(/^\/api\/v1\/wizard\/([a-z]+)$/);
    if (stepMatch) {
      const id = stepMatch[1] as WizardStepId;
      const handler = STEP_HANDLERS[id];
      const def = findStep(id);
      if (handler && def) return runStep(deps, handler, def, req);
    }

    return jsonResponse(HTTP_NOT_FOUND, { error: "not-found" });
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add gateway/src/api/wizard/router.ts
git commit -m "feat(wizard): router dispatches to step handlers + meta handlers"
```

---

### Task 18: Implement `gateway/src/api/wizard/index.ts`

**Files:**
- Create: `gateway/src/api/wizard/index.ts`

- [ ] **Step 1: Implement**

```ts
// gateway/src/api/wizard/index.ts
export { createWizardRouter as createWizardHandler } from "./router.ts";
export type { WizardDeps, SystemOrchestratorHandle, ListVoicesOptions, TestProviderResult } from "./step-pipeline.ts";
```

- [ ] **Step 2: Commit**

```bash
git add gateway/src/api/wizard/index.ts
git commit -m "feat(wizard): public api/wizard barrel"
```

---

## Phase 4: Switchover + cleanup

### Task 19: Swap server.ts wiring + delete old wizard.ts

**Files:**
- Modify: `gateway/src/server.ts`
- Delete: `gateway/src/api/handlers/wizard.ts`
- Delete: `gateway/src/api/handlers/wizard.test.ts`

- [ ] **Step 1: Update import in `gateway/src/server.ts`**

Find the line:

```ts
import { createWizardHandler } from "./api/handlers/wizard.ts";
```

Replace with:

```ts
import { createWizardHandler } from "./api/wizard/index.ts";
```

The `createWizardHandler` factory shape is identical (takes `WizardDeps`, returns `(req) => Promise<Response>`), so no other server.ts edits are needed.

- [ ] **Step 2: Delete the old files**

```bash
rm gateway/src/api/handlers/wizard.ts
rm gateway/src/api/handlers/wizard.test.ts
```

- [ ] **Step 3: Run full test suite**

Run: `bun run typecheck && cd gateway/src && bun test api/`
Expected: typecheck clean; all api tests pass.

- [ ] **Step 4: Run smoke build**

Run: `cd gateway && bun run build`
Expected: clean build, no missing imports.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/server.ts gateway/src/api/handlers/wizard.ts gateway/src/api/handlers/wizard.test.ts
git commit -m "refactor(wizard): cut over server.ts to api/wizard; delete legacy wizard.ts"
```

---

## Phase 5: Client refactor

### Task 20: Update `use-install-state.ts` to use shared cursor type

**Files:**
- Modify: `gateway/webui/src/hooks/use-install-state.ts`

- [ ] **Step 1: Replace local cursor union with import**

```ts
// gateway/webui/src/hooks/use-install-state.ts
import { createLogger } from "@sentient/web-sdk";
import type { WizardStepId } from "@sentient/wizard";
import { useCallback, useEffect, useState } from "preact/hooks";

const log = createLogger(["sentient", "webui", "install-state"]);

export interface InstallState {
  bootstrap_complete: boolean;
  wizard_cursor: WizardStepId;
  unlock_verified: boolean;
  installed_version: string;
  current_version: string;
}

// rest of file unchanged
```

- [ ] **Step 2: Verify webui typecheck**

Run: `cd gateway/webui && bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/hooks/use-install-state.ts
git commit -m "refactor(webui): WizardStepId imported from @sentient/wizard"
```

---

### Task 21: Create `step-registry.tsx`

**Files:**
- Create: `gateway/webui/src/components/wizard/step-registry.tsx`

- [ ] **Step 1: Implement**

```tsx
// gateway/webui/src/components/wizard/step-registry.tsx
import type { ComponentType } from "preact";
import type { WizardStepId } from "@sentient/wizard";
import { StepProvider } from "./steps/step-provider.tsx";
import { StepVoice } from "./steps/step-voice.tsx";
import { StepSecrets } from "./steps/step-secrets.tsx";
import { StepBringup } from "./steps/step-bringup.tsx";
import { StepAdmin } from "./steps/step-admin.tsx";
import { StepFinish } from "./steps/step-finish.tsx";

export interface StepProps {
  onAdvance: () => Promise<void>;
  onBack?: () => Promise<void>;
}

export const STEP_COMPONENTS: Record<WizardStepId, ComponentType<StepProps>> = {
  provider: StepProvider as ComponentType<StepProps>,
  voice:    StepVoice    as ComponentType<StepProps>,
  secrets:  StepSecrets  as ComponentType<StepProps>,
  bringup:  StepBringup  as ComponentType<StepProps>,
  admin:    StepAdmin    as ComponentType<StepProps>,
  finish:   StepFinish   as ComponentType<StepProps>,
};
```

- [ ] **Step 2: Commit**

```bash
git add gateway/webui/src/components/wizard/step-registry.tsx
git commit -m "feat(webui/wizard): step-registry maps WizardStepId → component"
```

---

### Task 22: Collapse `wizard-shell.tsx` to use the registry

**Files:**
- Modify: `gateway/webui/src/components/wizard/wizard-shell.tsx`

The new shell drops `adminDone`, `visualStep()`, and the per-step conditional renders.

- [ ] **Step 1: Rewrite**

```tsx
// gateway/webui/src/components/wizard/wizard-shell.tsx
import type { JSX } from "preact";
import { findStep, type WizardStepId } from "@sentient/wizard";
import { createLogger } from "@sentient/web-sdk";
import type { InstallState } from "../../hooks/use-install-state.ts";
import { WizardStepper } from "./wizard-stepper.tsx";
import { UnlockGate } from "./unlock-gate.tsx";
import { STEP_COMPONENTS } from "./step-registry.tsx";

const log = createLogger(["sentient", "webui", "wizard", "shell"]);

export interface WizardShellProps {
  state: InstallState;
  onChange: () => Promise<void>;
}

async function postBack(from: WizardStepId): Promise<boolean> {
  const res = await fetch("/api/v1/wizard/back", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from }),
  });
  return res.ok;
}

export function WizardShell({ state, onChange }: WizardShellProps): JSX.Element {
  if (!state.unlock_verified) {
    return (
      <div class="wizard-page">
        <div class="wizard-box">
          <UnlockGate onUnlocked={onChange} />
        </div>
      </div>
    );
  }

  const def = findStep(state.wizard_cursor);
  const Step = STEP_COMPONENTS[state.wizard_cursor];

  async function handleBack(): Promise<void> {
    if (!def?.backTo) return;
    const ok = await postBack(def.id);
    if (!ok) log.warn("back.failed", { from: def.id });
    await onChange();
  }

  return (
    <div class="wizard-page">
      <div class="wizard-box">
        <header class="wizard-box__header">
          <h1>Welcome to Sentient</h1>
          <WizardStepper current={state.wizard_cursor} />
        </header>
        <div class="wizard-box__content">
          <Step
            onAdvance={onChange}
            onBack={def?.backTo ? handleBack : undefined}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update existing step components to consume the new prop shape**

Each `step-*.tsx` must accept `{ onAdvance, onBack? }`. Most already do — verify by reading each file. Specifically:
- `step-admin.tsx` currently takes `{ onComplete }`. Change it to take `{ onAdvance }` and translate internally:

```tsx
// gateway/webui/src/components/wizard/steps/step-admin.tsx
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import { AccountWizard } from "../../account-wizard/AccountWizard.tsx";
import type { StepProps } from "../step-registry.tsx";

const log = createLogger(["sentient", "webui", "wizard", "step-admin"]);

export function StepAdmin({ onAdvance }: StepProps): JSX.Element {
  log.debug("render");
  return (
    <AccountWizard
      mode="first-admin"
      nested={true}
      onComplete={() => void onAdvance()}
    />
  );
}
```

- `step-finish.tsx`: change to `{ onAdvance }` (no behavioral change — it already calls `/wizard/finalize` then reloads):

```tsx
// gateway/webui/src/components/wizard/steps/step-finish.tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { StepProps } from "../step-registry.tsx";

export function StepFinish({ onAdvance: _onAdvance }: StepProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function finish() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/wizard/finalize", { method: "POST" });
      if (res.ok) window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="step-finish">
      <h2>All set</h2>
      <ul>
        <li>✓ Provider configured</li>
        <li>✓ Voice configured</li>
        <li>✓ Setup complete</li>
      </ul>
      <button type="button" disabled={busy} onClick={finish}>
        {busy ? "Finalizing..." : "Take me in →"}
      </button>
    </section>
  );
}
```

- [ ] **Step 3: Run webui typecheck and tests**

Run: `cd gateway/webui && bun run typecheck && bun run test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/wizard/wizard-shell.tsx \
        gateway/webui/src/components/wizard/steps/step-admin.tsx \
        gateway/webui/src/components/wizard/steps/step-finish.tsx
git commit -m "refactor(webui/wizard): registry-driven shell; drop adminDone + visualStep"
```

---

### Task 23: Update `wizard-stepper.tsx` to consume `WIZARD_STEPS`

**Files:**
- Modify: `gateway/webui/src/components/wizard/wizard-stepper.tsx`

- [ ] **Step 1: Rewrite stepper**

```tsx
// gateway/webui/src/components/wizard/wizard-stepper.tsx
import type { JSX } from "preact";
import { WIZARD_STEPS, type WizardStepId } from "@sentient/wizard";

export interface WizardStepperProps {
  current: WizardStepId;
}

export function WizardStepper({ current }: WizardStepperProps): JSX.Element {
  const idx = WIZARD_STEPS.findIndex((s) => s.id === current);
  return (
    <ol class="wizard-stepper">
      {WIZARD_STEPS.map((s, i) => (
        <li
          key={s.id}
          class={`wizard-stepper__item ${i === idx ? "is-current" : i < idx ? "is-done" : ""}`}
        >
          <span class="wizard-stepper__dot" />
          <span class="wizard-stepper__label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2: Run typecheck + tests**

Run: `cd gateway/webui && bun run typecheck && bun run test`

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/wizard/wizard-stepper.tsx
git commit -m "refactor(webui/wizard): stepper reads WIZARD_STEPS labels"
```

---

## Phase 6: Bootstrap split

### Task 24: Create `phase-config.ts`

**Files:**
- Create: `gateway/src/bootstrap/phase-config.ts`

- [ ] **Step 1: Extract config + logging init from `create-gateway-services.ts`**

Read `gateway/src/bootstrap/create-gateway-services.ts` lines 1-70 (the imports and the `loadStartupConfig` + `setupFileLogging` calls inside `createGatewayServices`). Extract those into a new file:

```ts
// gateway/src/bootstrap/phase-config.ts
import { type StartupConfig, loadStartupConfig } from "../config/startup-config.ts";
import { setupFileLogging } from "../logging/file-logger.ts";
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "bootstrap", "phase-config"]);

export interface PhaseConfigOutput {
  cfg: StartupConfig;
}

export async function runPhaseConfig(): Promise<PhaseConfigOutput> {
  const cfg = loadStartupConfig();
  await setupFileLogging({
    logDir: cfg.logging.logDir,
    level: cfg.logging.logLevel,
    retentionDays: cfg.logging.retentionDays,
  });
  log.info("phase-config.complete", { port: cfg.port });
  return { cfg };
}
```

- [ ] **Step 2: Commit**

```bash
git add gateway/src/bootstrap/phase-config.ts
git commit -m "refactor(bootstrap): extract phase-config (config + logging)"
```

---

### Task 25: Create `phase-state.ts`

**Files:**
- Create: `gateway/src/bootstrap/phase-state.ts`

Extracts the install-state, secrets-store, internal-secrets, and unlock-code wiring.

- [ ] **Step 1: Implement**

```ts
// gateway/src/bootstrap/phase-state.ts
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createInstallState, type InstallState } from "../admin/install-state.ts";
import { createSecretsStore, type SecretsStore } from "../admin/secrets-store.ts";
import { createInternalSecretsStore, type InternalSecretsStore } from "../admin/internal-secrets-store.ts";
import { createUnlockCode, type UnlockCode } from "../admin/unlock-code.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "bootstrap", "phase-state"]);

export interface PhaseStateOutput {
  installState: InstallState;
  secretsStore: SecretsStore;
  internalSecrets: InternalSecretsStore;
  unlockCode: UnlockCode;
}

export async function runPhaseState(cfg: StartupConfig, dataDir: string, gatewayVersion: string): Promise<PhaseStateOutput> {
  const installState = createInstallState({
    statePath: join(dataDir, "state.yaml"),
    templateDir: join(dataDir, "..", "..", "templates", "wizard"),
    gatewayVersion,
  });

  const secretsStore = createSecretsStore({
    keysPath: join(dataDir, "keys.yaml"),
    templatePath: join(dataDir, "..", "..", "templates", "wizard", "keys.yaml.tmpl"),
    generateAdminToken: () => randomBytes(32).toString("hex"),
  });

  const internalSecrets = createInternalSecretsStore(dataDir);
  await internalSecrets.loadOrInit();

  const unlockCode = createUnlockCode({ codePath: join(dataDir, "unlock-code") });

  const data = await installState.load();
  if (!data.bootstrap_complete) {
    const code = await unlockCode.ensure();
    log.info("unlock.banner", { path: join(dataDir, "unlock-code") });
    // Code itself printed elsewhere (legacy banner). Future spec to redact.
  }

  log.info("phase-state.complete", { bootstrap_complete: data.bootstrap_complete });
  return { installState, secretsStore, internalSecrets, unlockCode };
}
```

The exact paths and helper names must match what `create-gateway-services.ts` uses today. If a helper signature differs, follow the existing call site pattern verbatim.

- [ ] **Step 2: Commit**

```bash
git add gateway/src/bootstrap/phase-state.ts
git commit -m "refactor(bootstrap): extract phase-state (install/secrets/unlock)"
```

---

### Task 26: Create `phase-orchestrator.ts`

**Files:**
- Create: `gateway/src/bootstrap/phase-orchestrator.ts`

- [ ] **Step 1: Implement**

```ts
// gateway/src/bootstrap/phase-orchestrator.ts
import { join } from "node:path";
import { createSystemOrchestratorService, type SystemOrchestratorService } from "../system-orchestrator/index.ts";
import { createDefaultHealthIO } from "../system-orchestrator/health-io.ts";
import type { SecretAccessor } from "../system-orchestrator/template-loader.ts";
import type { InstallState } from "../admin/install-state.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "bootstrap", "phase-orchestrator"]);

export interface PhaseOrchestratorInput {
  cfg: StartupConfig;
  installState: InstallState;
  secretAccessor: SecretAccessor;
  templateDir: string;
  hostEnv: Record<string, string>;
}

export interface PhaseOrchestratorOutput {
  systemOrchestrator: SystemOrchestratorService | null;
}

export async function runPhaseOrchestrator(input: PhaseOrchestratorInput): Promise<PhaseOrchestratorOutput> {
  if (!input.cfg.managedServices) {
    log.warn("phase-orch.skip", { reason: "no managed_services in config" });
    return { systemOrchestrator: null };
  }

  const systemOrchestrator = await createSystemOrchestratorService({
    managedServicesConfig: input.cfg.managedServices,
    templateDir: join(input.templateDir, "services"),
    secrets: input.secretAccessor,
    healthIO: createDefaultHealthIO(),
    pollIntervalMs: 1000,
    applyTimeoutMs: 120000,
    hostEnv: input.hostEnv,
  });

  // Boot reconcile only when bootstrap is complete. Fresh installs let the
  // setup wizard own the first apply.
  const installed = await input.installState.load();
  if (installed.bootstrap_complete) {
    void systemOrchestrator.reconcile().catch((err: unknown) => {
      log.error("boot-reconcile.crashed", { reason: String(err) });
    });
    log.info("boot-reconcile.kicked");
  } else {
    log.info("boot-reconcile.skipped", { reason: "bootstrap-incomplete" });
  }

  return { systemOrchestrator };
}
```

Adjust signatures to match the actual current factory call sites in `create-gateway-services.ts`. Read those lines before writing the implementation; do not invent helper names.

- [ ] **Step 2: Commit**

```bash
git add gateway/src/bootstrap/phase-orchestrator.ts
git commit -m "refactor(bootstrap): extract phase-orchestrator with reconcile gate"
```

---

### Task 27: Create `phase-services.ts`

**Files:**
- Create: `gateway/src/bootstrap/phase-services.ts`

Extracts the TTS, STT, cerebrum, LLM, MCP-host wiring. Uses existing factories under `bootstrap/`.

- [ ] **Step 1: Implement**

Read the relevant blocks in `create-gateway-services.ts` (lines around 200-450 — the existing `tts = createTtsService(...)`, `stt = createSttService(...)`, etc.). Lift them into:

```ts
// gateway/src/bootstrap/phase-services.ts
import { createTtsService, type TtsService } from "./tts-factory.ts";
import { createSttService, type SttService } from "./stt-factory.ts";
import { createLlmFactory } from "./llm-factory.ts";
import { createCerebrumFactory } from "./cerebrum-factory.ts";
import { createContentTtsFactory } from "./content-tts-factory.ts";
import { createMcpHost } from "./create-mcp-host.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import type { SecretsStore } from "../admin/secrets-store.ts";
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "bootstrap", "phase-services"]);

export interface PhaseServicesInput {
  cfg: StartupConfig;
  secretsStore: SecretsStore;
}

export interface PhaseServicesOutput {
  tts: TtsService | null;
  stt: SttService | null;
  // Plus other services per existing create-gateway-services.ts pattern.
}

export function runPhaseServices(input: PhaseServicesInput): PhaseServicesOutput {
  const tts = createTtsService(input.cfg, {
    getFishAudioKey: () => input.secretsStore.getFishAudioKeySync(),
  });
  // ... lift the rest verbatim from create-gateway-services.ts
  log.info("phase-services.complete");
  return { tts, stt: null /* etc */ };
}
```

The exact return type must mirror what the existing `createGatewayServices` exports today. Treat this as a mechanical move — copy code blocks, adjust imports, do not refactor signatures.

- [ ] **Step 2: Commit**

```bash
git add gateway/src/bootstrap/phase-services.ts
git commit -m "refactor(bootstrap): extract phase-services (tts/stt/cerebrum/llm/mcp)"
```

---

### Task 28: Create `phase-routes.ts`

**Files:**
- Create: `gateway/src/bootstrap/phase-routes.ts`

Lifts the handler wiring + router build (the bottom of `create-gateway-services.ts`).

- [ ] **Step 1: Implement**

```ts
// gateway/src/bootstrap/phase-routes.ts
import { createApiRouter, type ApiRouter } from "../api/router.ts";
// import individual handler factories used today by createGatewayServices
import { createWizardHandler } from "../api/wizard/index.ts";
// ... etc

export interface PhaseRoutesInput {
  /* the union of all handler dependencies built by earlier phases */
}

export function runPhaseRoutes(input: PhaseRoutesInput): { router: ApiRouter } {
  // Build each handler with the dependencies it needs.
  // Wire them into createApiRouter.
  // Return the router.
  // Lift verbatim from the equivalent block in create-gateway-services.ts.
  return { router: createApiRouter({ /* ... */ }) };
}
```

Do not invent handler signatures — read `create-gateway-services.ts` and lift the code as-is, just relocated.

- [ ] **Step 2: Commit**

```bash
git add gateway/src/bootstrap/phase-routes.ts
git commit -m "refactor(bootstrap): extract phase-routes (handler wiring + router build)"
```

---

### Task 29: Slim `create-gateway-services.ts` into `bootstrap/index.ts`

**Files:**
- Modify: `gateway/src/bootstrap/create-gateway-services.ts` (rewrite, ~80 lines)
- Or rename to: `gateway/src/bootstrap/index.ts` (and update `server.ts` import)

- [ ] **Step 1: Rewrite as orchestrator**

```ts
// gateway/src/bootstrap/create-gateway-services.ts (or index.ts)
import { runPhaseConfig } from "./phase-config.ts";
import { runPhaseState } from "./phase-state.ts";
import { runPhaseOrchestrator } from "./phase-orchestrator.ts";
import { runPhaseServices } from "./phase-services.ts";
import { runPhaseRoutes } from "./phase-routes.ts";
import { makeSecretAccessor } from "./secret-accessor.ts"; // extracted from old file
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "bootstrap"]);

export interface GatewayServices {
  router: ReturnType<typeof runPhaseRoutes>["router"];
  // Plus whatever else the public surface used to expose. Keep the shape
  // identical so server.ts doesn't need to change.
}

export async function createGatewayServices(): Promise<GatewayServices> {
  const { cfg } = await runPhaseConfig();

  const dataDir = process.env.GATEWAY_DATA_DIR ?? "/app/gateway-data";
  const templateDir = /* mirror current logic */;
  const gatewayVersion = /* mirror current logic, e.g. read package.json */;

  const { installState, secretsStore, internalSecrets, unlockCode } =
    await runPhaseState(cfg, dataDir, gatewayVersion);

  const secretAccessor = makeSecretAccessor(secretsStore);

  const { systemOrchestrator } = await runPhaseOrchestrator({
    cfg,
    installState,
    secretAccessor,
    templateDir,
    hostEnv: { /* mirror */ },
  });

  const services = runPhaseServices({ cfg, secretsStore });

  const { router } = runPhaseRoutes({
    cfg,
    installState,
    secretsStore,
    internalSecrets,
    unlockCode,
    systemOrchestrator,
    services,
    /* ... */
  });

  log.info("bootstrap.complete");
  return { router /* + whatever else server.ts consumes */ };
}
```

- [ ] **Step 2: Move `makeSecretAccessor` + `extractHost` to their own file**

Create `gateway/src/bootstrap/secret-accessor.ts` containing both helpers (extracted verbatim from the old `create-gateway-services.ts:85-123`).

- [ ] **Step 3: Run full CI**

Run: `bun run ci`
Expected: lint clean, typecheck clean, all unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/bootstrap/
git commit -m "refactor(bootstrap): index.ts orchestrates phases (~80 lines)"
```

---

## Phase 7: Smoke procedure docs

### Task 30: Update `agents/docs/testing-knowledge.md`

**Files:**
- Modify: `agents/docs/testing-knowledge.md`

- [ ] **Step 1: Add wizard smoke section**

Append to `agents/docs/testing-knowledge.md`:

```md
## Setup Wizard — Fresh Walk

Run after any change touching `gateway/src/api/wizard/`, `gateway/src/admin/install-state.ts`, `gateway/templates/wizard/`, or the webui wizard components.

1. `rm -rf ~/.sentient/`
2. Bring up the stack: `cd deploy/docker && docker compose up -d`
3. Read the unlock code: `cat ~/.sentient/gateway/data/unlock-code` (or read from gateway log banner).
4. Open `https://localhost:8888`, enter the unlock code.
5. Walk fresh: `provider → voice → secrets → bringup → admin → finish`.
6. Confirm Back buttons present and functional on `voice` and `secrets` screens; absent on `provider`, `bringup`, `admin`, `finish`.
7. Mid-admin reload: refresh page during AccountWizard. Expect: lands back on AccountWizard.
8. Post-admin reload: complete admin step, refresh page. Expect: lands on StepFinish.
9. Click "Take me in →". Expect: wizard closes, login screen appears, can log in with the PIN you set.
10. Verify cursor field in `~/.sentient/gateway/data/state.yaml` matches each visible step during the walk (sample at provider, secrets, admin, finish).

## Setup Wizard — Migration smoke

After upgrading across the v0.1.0 → v0.2.0 install-state schema bump:

1. Generate a v0.1.0 fixture: write a state.yaml with `schema_version: "0.1.0"` and `wizard_cursor: "complete"`, `bootstrap_complete: false` to `~/.sentient/gateway/data/state.yaml`.
2. Restart gateway. Read the file again.
3. Expect: `schema_version: "0.2.0"`, `wizard_cursor: "admin"`.
4. Repeat with `bootstrap_complete: true`. Expect: `wizard_cursor: "finish"`.
```

- [ ] **Step 2: Commit**

```bash
git add agents/docs/testing-knowledge.md
git commit -m "docs(testing): wizard fresh-walk + migration smoke procedures"
```

---

## Self-review checklist (filled after writing the plan)

- [x] **Spec coverage:** All spec sections covered.
  - "Shared step contract" → Task 2.
  - "Server: 1 file per step" → Tasks 6–18.
  - "Client: existing pattern formalized" → Tasks 20–23.
  - "Admin cursor explicit" → Tasks 4–5.
  - "Bootstrap split" → Tasks 24–29.
  - "Migration order" → Phases 1–6 ordering.
  - "Tests + risks" → Per-step tests in each implementation task; smoke procedure in Task 30.
- [x] **Placeholder scan:** Tasks 25–28 contain "lift verbatim from create-gateway-services.ts" instructions where the source is large and reading-required. This is a deliberate instruction (mechanical move, do not invent), not a placeholder. The implementation prompt for the subagent must include a Read of the source file before writing the new file.
- [x] **Type consistency:** `WizardStepId`, `WizardStepDef`, `StepHandler<Body>`, `WizardDeps`, `StepError` — all defined once and reused throughout. `findStep` used in `back.ts`, `wizard-shell.tsx`. `STEP_COMPONENTS` matches `WizardStepId` keys exactly.
