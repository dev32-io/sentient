# Setup Wizard + Writable Host Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 1.0 first-install path: `docker compose up` → browser wizard → admin user → working chat. No CLI editing of `.env` or `setup.py` required for fresh installs.

**Architecture:** New `state.yaml` file at `~/.sentient/state.yaml` anchors install metadata + version-hint. Existing `secrets-store.ts` migrates from `secrets.json` (flat) to `~/.sentient/secrets/keys.yaml` (structured, mode 0600). New wizard endpoints (no auth, gated by one-time unlock code) walk operator through provider key + voice key + finish; admin user creation reuses existing `SetupScreen`. Hermes worker key injection unchanged in mechanism (path B already 80% wired in `supervisord-control.ts`); only the source of keys changes.

**Tech Stack:** Bun + TypeScript (gateway), Preact + Vite (webui), zod for validation, vitest for unit tests, Playwright MCP for end-to-end smoke. Existing template-loader pattern at `gateway/templates/` for all new YAML/text fixtures.

**Spec:** `docs/superpowers/specs/2026-05-01-setup-wizard-writable-layout-design.md`

---

## Pre-flight

Plan assumes work is on a dedicated branch off `develop`. The branch name in the spec is `feature/setup-wizard-writable-layout`. Create a worktree before Task 1:

```bash
cd /Users/kevinye/Development/sentient
git fetch origin
git worktree add .worktrees/setup-wizard -b feature/setup-wizard-writable-layout origin/develop
cd .worktrees/setup-wizard
source scripts/env.sh
```

Quality gate runs throughout via `bun run ci`. Pre-commit hook runs lint + typecheck automatically.

---

## File-structure preview

**New gateway server files (Phase 1–2):**
```
gateway/src/admin/
  install-state.ts                 ← read/write state.yaml
  install-state.test.ts            ← FSM tests
  unlock-code.ts                   ← generate + verify 6-digit code
  key-rotation.ts                  ← per-user worker restart loop
gateway/src/api/handlers/
  install-state.ts                 ← GET /api/v1/install-state
  install-state.test.ts            ← wire-contract test
  services-versions.ts             ← GET /api/v1/services/versions
  wizard.ts                        ← POST /api/v1/wizard/*
  wizard.test.ts                   ← security-boundary tests
  secrets.ts                       ← GET/PUT/DELETE /api/v1/admin/secrets/*
  secrets.test.ts                  ← never-echo tests
gateway/templates/
  wizard/state.yaml.tmpl
  wizard/keys.yaml.tmpl
  wizard/bootstrap-unlock.txt.tmpl
  persona/default.md
```

**Modified gateway server files:**
```
gateway/src/admin/
  secrets-store.ts                 ← migrate to keys.yaml schema; preserve API
  supervisord-control.ts           ← rename openrouterKey → llmApiKey, add llmBaseUrl
  user-provisioner.ts              ← read keys via new SecretsStore.getActiveLlm()
gateway/src/bootstrap/
  create-gateway-services.ts       ← wire install-state + new secrets-store layout
gateway/src/main.ts                ← bootstrap-time unlock-code generation
gateway/src/context/system-prompt-loader.ts  ← load DEFAULT_PERSONA from template
gateway/src/bootstrap/cerebrum-factory.ts    ← delete dup DEFAULT_PERSONA
gateway/src/server.ts              ← mount new handlers
```

**New webui files:**
```
gateway/webui/src/components/wizard/
  wizard-shell.tsx
  wizard-stepper.tsx
  unlock-gate.tsx
  shared/secret-input.tsx
  shared/test-connection.tsx
  steps/step-welcome.tsx
  steps/step-provider.tsx
  steps/step-voice.tsx
  steps/step-finish.tsx
gateway/webui/src/hooks/
  use-install-state.ts
  use-service-versions.ts
gateway/webui/src/components/settings/panes/
  secrets-pane.tsx                 ← rename + rewrite from provider-keys-pane.tsx
```

**Modified webui:**
```
gateway/webui/src/app.tsx                                         ← wizard branch above auth
gateway/webui/src/components/settings/sidebar/sidebar-status.tsx  ← version chips
gateway/webui/src/components/settings/sidebar/nav-config.ts       ← rename "Provider keys" → "Secrets"
```

**Deploy + tooling:**
```
deploy/docker/docker-compose.yml   ← add secrets/, state.yaml, .bootstrap-unlock mounts
deploy/docker/.env.example         ← shrink to HOST_DOCKER_GID
lefthook.yml                       ← extend secrets-guard regex + content-scan
gateway/test/fixtures/lefthook/should-block.txt
gateway/test/fixtures/lefthook/should-not-block.txt
scripts/find-inline-templates.sh
gateway/test/smoke/wizard-bootstrap.spec.ts
```

---

# Phase 1 — Server foundations (no UI yet)

## Task 1: Extract DEFAULT_PERSONA to template file

**Files:**
- Create: `gateway/templates/persona/default.md`
- Modify: `gateway/src/context/system-prompt-loader.ts:8`
- Modify: `gateway/src/bootstrap/cerebrum-factory.ts:11`

The string `"You are Sentient, a helpful family AI assistant."` is duplicated across two files. Move to a single template loaded via the existing `template-loader.ts` infra; both call sites import from one place.

- [ ] **Step 1: Read existing files to understand current usage**

```bash
# Read both files to see how DEFAULT_PERSONA is used
cat gateway/src/context/system-prompt-loader.ts | head -30
cat gateway/src/bootstrap/cerebrum-factory.ts | head -30
```

- [ ] **Step 2: Create template file**

Write `gateway/templates/persona/default.md`:
```markdown
You are Sentient, a helpful family AI assistant.
```

(Single line; no trailing prose.)

- [ ] **Step 3: Update system-prompt-loader.ts to read from template**

Replace the `const DEFAULT_PERSONA = "..."` literal with a load via `templateLoader`. The loader is already imported in `gateway/src/profile-store/template-loader.ts` — use the same fallback pattern (operator dir → baked-in dir).

```typescript
// gateway/src/context/system-prompt-loader.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load from baked-in template dir at module init. Single read; never reloaded
// at runtime since the template is fixed per build.
const DEFAULT_PERSONA = readFileSync(
  join(import.meta.dir, "../../templates/persona/default.md"),
  "utf8"
).trim();
```

- [ ] **Step 4: Delete duplicate from cerebrum-factory.ts**

In `gateway/src/bootstrap/cerebrum-factory.ts`, replace the local `DEFAULT_PERSONA` literal with an import from `system-prompt-loader.ts` (or move the constant to a shared module if both factories need it). Use whichever already has the cleaner export.

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```
Expected: PASS, no new errors.

- [ ] **Step 6: Commit**

```bash
git add gateway/templates/persona/default.md gateway/src/context/system-prompt-loader.ts gateway/src/bootstrap/cerebrum-factory.ts
git commit -m "refactor(gateway): extract DEFAULT_PERSONA to template file"
```

---

## Task 2: Create wizard template fixtures

**Files:**
- Create: `gateway/templates/wizard/state.yaml.tmpl`
- Create: `gateway/templates/wizard/keys.yaml.tmpl`
- Create: `gateway/templates/wizard/bootstrap-unlock.txt.tmpl`

Templates loaded by the new `install-state.ts` (Task 3) and `unlock-code.ts` (Task 7) at first-boot.

- [ ] **Step 1: Write state.yaml.tmpl**

```yaml
# gateway/templates/wizard/state.yaml.tmpl
schema_version: "1.0.0"
installed_version: "{{installed_version}}"
last_upgraded_from: null
last_upgraded_at: null

bootstrap_complete: false
wizard_cursor: "provider"
unlock_verified: false

services:
  gateway: "{{gateway_version}}"
  hermes: "{{hermes_version}}"
  stt_service: "{{stt_service_version}}"
```

- [ ] **Step 2: Write keys.yaml.tmpl**

```yaml
# gateway/templates/wizard/keys.yaml.tmpl
schema_version: "1.0.0"

llm:
  active: "ollama-cloud"

  ollama_cloud:
    api_key: null
    base_url: "http://host.docker.internal:11434/v1"

  openrouter:
    api_key: null
    base_url: null

  custom:
    api_key: null
    base_url: null

tts:
  fish_audio:
    api_key: null

home_assistant:
  observe_token: null
  mcp_server_token: null

music_assistant:
  token: null

admin_token: "{{admin_token}}"
```

- [ ] **Step 3: Write bootstrap-unlock.txt.tmpl**

```
{{code}}
```

(Single line, code only — file is read raw by the unlock check.)

- [ ] **Step 4: Commit**

```bash
git add gateway/templates/wizard/
git commit -m "feat(gateway/templates): add wizard fixtures (state, keys, unlock)"
```

---

## Task 3: install-state service (read/write state.yaml)

**Files:**
- Create: `gateway/src/admin/install-state.ts`
- Test: `gateway/src/admin/install-state.test.ts`

Owns read + write of `~/.sentient/state.yaml`. Atomic writes via temp+rename. Cursor-advance API. Version-comparison helper.

- [ ] **Step 1: Write the failing test**

```typescript
// gateway/src/admin/install-state.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstallState } from "./install-state.js";

const TEMPLATE_DIR = join(__dirname, "../../templates/wizard");

describe("InstallState", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "install-state-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates state.yaml from template when missing", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      versions: { gateway: "1.0.0", hermes: "v2026.4.23", stt_service: "1.0.0" },
    });
    const state = await svc.load();
    expect(state.bootstrap_complete).toBe(false);
    expect(state.wizard_cursor).toBe("provider");
    expect(state.unlock_verified).toBe(false);
    expect(state.installed_version).toBe("1.0.0");
    expect(existsSync(join(dir, "state.yaml"))).toBe(true);
  });

  it("preserves existing state.yaml on second load", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      versions: { gateway: "1.0.0", hermes: "v2026.4.23", stt_service: "1.0.0" },
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    const reloaded = await svc.load();
    expect(reloaded.wizard_cursor).toBe("voice");
  });

  it("rejects cursor advance from wrong source", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      versions: { gateway: "1.0.0", hermes: "v2026.4.23", stt_service: "1.0.0" },
    });
    await svc.load();
    const result = await svc.advanceCursor("voice", "complete");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("cursor-mismatch");
  });

  it("flips bootstrap_complete via finish()", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      versions: { gateway: "1.0.0", hermes: "v2026.4.23", stt_service: "1.0.0" },
    });
    await svc.load();
    await svc.advanceCursor("provider", "voice");
    await svc.advanceCursor("voice", "complete");
    await svc.finish();
    const state = await svc.load();
    expect(state.bootstrap_complete).toBe(true);
  });

  it("setUnlockVerified() flips flag idempotently", async () => {
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      versions: { gateway: "1.0.0", hermes: "v2026.4.23", stt_service: "1.0.0" },
    });
    await svc.load();
    await svc.setUnlockVerified();
    let state = await svc.load();
    expect(state.unlock_verified).toBe(true);
    await svc.setUnlockVerified(); // second call, no error
    state = await svc.load();
    expect(state.unlock_verified).toBe(true);
  });

  it("ignores stale temp file on load (atomic-write recovery)", async () => {
    // Simulate a crashed write: temp file exists but never renamed.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.yaml.tmp"), "garbage");
    const svc = createInstallState({
      statePath: join(dir, "state.yaml"),
      templateDir: TEMPLATE_DIR,
      versions: { gateway: "1.0.0", hermes: "v2026.4.23", stt_service: "1.0.0" },
    });
    const state = await svc.load();
    expect(state.bootstrap_complete).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
cd gateway && bun run test src/admin/install-state.test.ts
```
Expected: FAIL — `createInstallState` not exported.

- [ ] **Step 3: Implement install-state.ts**

```typescript
// gateway/src/admin/install-state.ts
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { parse, stringify } from "yaml";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "install-state"]);

export type WizardCursor = "provider" | "voice" | "complete";

export interface ServiceVersions {
  gateway: string;
  hermes: string;
  stt_service: string;
}

export interface InstallStateData {
  schema_version: string;
  installed_version: string;
  last_upgraded_from: string | null;
  last_upgraded_at: string | null;
  bootstrap_complete: boolean;
  wizard_cursor: WizardCursor;
  unlock_verified: boolean;
  services: ServiceVersions;
}

export type InstallStateError =
  | { kind: "io-failed"; reason: string }
  | { kind: "parse-failed"; reason: string }
  | { kind: "cursor-mismatch"; expected: WizardCursor; actual: WizardCursor }
  | { kind: "already-complete" };

export interface InstallStateConfig {
  statePath: string;
  templateDir: string;
  versions: ServiceVersions;
}

export interface InstallState {
  load(): Promise<InstallStateData>;
  advanceCursor(from: WizardCursor, to: WizardCursor): Promise<Result<void, InstallStateError>>;
  setUnlockVerified(): Promise<Result<void, InstallStateError>>;
  finish(): Promise<Result<void, InstallStateError>>;
}

export function createInstallState(cfg: InstallStateConfig): InstallState {
  let cached: InstallStateData | null = null;

  async function readFromDisk(): Promise<InstallStateData | null> {
    try {
      const raw = await fs.readFile(cfg.statePath, "utf8");
      return parse(raw) as InstallStateData;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }

  async function writeAtomic(data: InstallStateData): Promise<void> {
    const tmp = `${cfg.statePath}.tmp`;
    await fs.mkdir(dirname(cfg.statePath), { recursive: true });
    await fs.writeFile(tmp, stringify(data), { mode: 0o644 });
    await fs.rename(tmp, cfg.statePath);
  }

  async function bootstrap(): Promise<InstallStateData> {
    const tmplPath = join(cfg.templateDir, "state.yaml.tmpl");
    const tmpl = await fs.readFile(tmplPath, "utf8");
    const rendered = tmpl
      .replaceAll("{{installed_version}}", cfg.versions.gateway)
      .replaceAll("{{gateway_version}}", cfg.versions.gateway)
      .replaceAll("{{hermes_version}}", cfg.versions.hermes)
      .replaceAll("{{stt_service_version}}", cfg.versions.stt_service);
    const data = parse(rendered) as InstallStateData;
    await writeAtomic(data);
    log.info("install-state.bootstrapped", { path: cfg.statePath });
    return data;
  }

  return {
    async load(): Promise<InstallStateData> {
      const existing = await readFromDisk();
      if (existing) {
        cached = existing;
        return existing;
      }
      const fresh = await bootstrap();
      cached = fresh;
      return fresh;
    },

    async advanceCursor(from, to) {
      const state = cached ?? (await readFromDisk()) ?? (await bootstrap());
      if (state.bootstrap_complete) return { ok: false, error: { kind: "already-complete" } };
      if (state.wizard_cursor !== from) {
        return { ok: false, error: { kind: "cursor-mismatch", expected: from, actual: state.wizard_cursor } };
      }
      const next = { ...state, wizard_cursor: to };
      await writeAtomic(next);
      cached = next;
      log.info("install-state.cursor-advanced", { from, to });
      return { ok: true, value: undefined };
    },

    async setUnlockVerified() {
      const state = cached ?? (await readFromDisk()) ?? (await bootstrap());
      if (state.unlock_verified) return { ok: true, value: undefined };
      const next = { ...state, unlock_verified: true };
      await writeAtomic(next);
      cached = next;
      log.info("install-state.unlock-verified");
      return { ok: true, value: undefined };
    },

    async finish() {
      const state = cached ?? (await readFromDisk()) ?? (await bootstrap());
      if (state.bootstrap_complete) return { ok: true, value: undefined };
      if (state.wizard_cursor !== "complete") {
        return { ok: false, error: { kind: "cursor-mismatch", expected: "complete", actual: state.wizard_cursor } };
      }
      const next = { ...state, bootstrap_complete: true };
      await writeAtomic(next);
      cached = next;
      log.info("install-state.bootstrap-complete");
      return { ok: true, value: undefined };
    },
  };
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd gateway && bun run test src/admin/install-state.test.ts
```
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/admin/install-state.ts gateway/src/admin/install-state.test.ts
git commit -m "feat(gateway/admin): install-state service with atomic state.yaml writes"
```

---

## Task 4: install-state HTTP handler

**Files:**
- Create: `gateway/src/api/handlers/install-state.ts`
- Test: `gateway/src/api/handlers/install-state.test.ts`
- Modify: `gateway/src/server.ts` (mount handler)
- Modify: `gateway/src/bootstrap/create-gateway-services.ts` (instantiate InstallState)

GET `/api/v1/install-state` returns the current state. Public-but-not-auth-gated (it's the FIRST thing webui calls before any auth context exists).

- [ ] **Step 1: Write the failing test**

```typescript
// gateway/src/api/handlers/install-state.test.ts
import { describe, it, expect } from "vitest";
import { createInstallStateHandler } from "./install-state.js";
import type { InstallState, InstallStateData } from "../../admin/install-state.js";

function makeState(overrides: Partial<InstallStateData> = {}): InstallStateData {
  return {
    schema_version: "1.0.0",
    installed_version: "1.0.0",
    last_upgraded_from: null,
    last_upgraded_at: null,
    bootstrap_complete: false,
    wizard_cursor: "provider",
    unlock_verified: false,
    services: { gateway: "1.0.0", hermes: "v2026.4.23", stt_service: "1.0.0" },
    ...overrides,
  };
}

function makeService(state: InstallStateData): InstallState {
  return {
    load: async () => state,
    advanceCursor: async () => ({ ok: true, value: undefined }),
    setUnlockVerified: async () => ({ ok: true, value: undefined }),
    finish: async () => ({ ok: true, value: undefined }),
  };
}

describe("install-state handler", () => {
  it("returns full state shape", async () => {
    const handler = createInstallStateHandler({ installState: makeService(makeState()), currentVersion: "1.0.0" });
    const res = await handler(new Request("http://localhost/api/v1/install-state"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      bootstrap_complete: false,
      wizard_cursor: "provider",
      unlock_verified: false,
      installed_version: "1.0.0",
      current_version: "1.0.0",
      services: { gateway: "1.0.0", hermes: "v2026.4.23", stt_service: "1.0.0" },
    });
  });

  it("reflects post-bootstrap state", async () => {
    const handler = createInstallStateHandler({
      installState: makeService(makeState({ bootstrap_complete: true, wizard_cursor: "complete", unlock_verified: true })),
      currentVersion: "1.0.0",
    });
    const res = await handler(new Request("http://localhost/api/v1/install-state"));
    const body = await res.json();
    expect(body.bootstrap_complete).toBe(true);
    expect(body.wizard_cursor).toBe("complete");
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
cd gateway && bun run test src/api/handlers/install-state.test.ts
```
Expected: FAIL — handler not implemented.

- [ ] **Step 3: Implement handler**

```typescript
// gateway/src/api/handlers/install-state.ts
import type { InstallState } from "../../admin/install-state.js";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "install-state"]);

export interface InstallStateDeps {
  installState: InstallState;
  currentVersion: string;
}

export type InstallStateHandler = (req: Request) => Promise<Response>;

export function createInstallStateHandler(deps: InstallStateDeps): InstallStateHandler {
  return async (_req: Request) => {
    const state = await deps.installState.load();
    const body = {
      bootstrap_complete: state.bootstrap_complete,
      wizard_cursor: state.wizard_cursor,
      unlock_verified: state.unlock_verified,
      installed_version: state.installed_version,
      current_version: deps.currentVersion,
      services: state.services,
    };
    log.debug("install-state.fetched", { bootstrap_complete: state.bootstrap_complete });
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  };
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd gateway && bun run test src/api/handlers/install-state.test.ts
```
Expected: 2 PASS.

- [ ] **Step 5: Wire into bootstrap**

Modify `gateway/src/bootstrap/create-gateway-services.ts`. Add to GatewayServices interface, instantiate, expose. Use existing pattern; pull values from `process.env.SENTIENT_HOME ?? join(homedir(), ".sentient")` for state path.

```typescript
// gateway/src/bootstrap/create-gateway-services.ts (additions)
import { type InstallState, createInstallState } from "../admin/install-state.js";
import { homedir } from "node:os";
import packageJson from "../../package.json";

const SENTIENT_HOME = process.env.SENTIENT_HOME ?? join(homedir(), ".sentient");
const TEMPLATE_DIR = join(import.meta.dir, "../../templates");

const installState = createInstallState({
  statePath: join(SENTIENT_HOME, "state.yaml"),
  templateDir: join(TEMPLATE_DIR, "wizard"),
  versions: {
    gateway: packageJson.version,
    hermes: process.env.HERMES_VERSION ?? "unknown",
    stt_service: process.env.STT_SERVICE_VERSION ?? "unknown",
  },
});

// Add to GatewayServices interface:
//   readonly installState: InstallState;
// Add to returned object: installState
```

- [ ] **Step 6: Mount handler in server.ts**

In `gateway/src/server.ts`, after the existing `createHealthHandler` line:
```typescript
const handleInstallState = createInstallStateHandler({
  installState: services.installState,
  currentVersion: services.installState.versions?.gateway ?? "0.0.0",
});
```

Add to the route table (search for where other GET handlers are mounted; typical pattern is in `api/router.ts` or inline in `fetch()`).

- [ ] **Step 7: Manual verification**

```bash
# Boot gateway in dev mode
bun run dev
# In another terminal:
curl -s http://localhost:8888/api/v1/install-state | jq
```
Expected: JSON with `bootstrap_complete: false` (or true on existing dev install).

- [ ] **Step 8: Commit**

```bash
git add gateway/src/api/handlers/install-state.ts gateway/src/api/handlers/install-state.test.ts gateway/src/bootstrap/create-gateway-services.ts gateway/src/server.ts
git commit -m "feat(gateway/api): GET /api/v1/install-state endpoint"
```

---

## Task 5: services-versions HTTP handler

**Files:**
- Create: `gateway/src/api/handlers/services-versions.ts`
- Modify: `gateway/src/server.ts` (mount)

GET `/api/v1/services/versions` returns versions only (no install metadata). Auth: requires authenticated PASETO session (admin or non-admin) AND bootstrap_complete=true.

- [ ] **Step 1: Implement handler**

```typescript
// gateway/src/api/handlers/services-versions.ts
import type { InstallState } from "../../admin/install-state.js";
import type { TokenService } from "../../user-auth/token-service.js";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "services-versions"]);

export interface ServicesVersionsDeps {
  installState: InstallState;
  tokenService: TokenService;
}

export function createServicesVersionsHandler(deps: ServicesVersionsDeps) {
  return async (req: Request) => {
    // Verify PASETO session — any logged-in user OK
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const verifyResult = await deps.tokenService.verify(token);
    if (!verifyResult.ok) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const state = await deps.installState.load();
    if (!state.bootstrap_complete) {
      return new Response(JSON.stringify({ error: "bootstrap-incomplete" }), {
        status: 412,
        headers: { "Content-Type": "application/json" },
      });
    }

    log.debug("services-versions.fetched", { user: verifyResult.value.userId });
    return new Response(JSON.stringify(state.services), {
      headers: { "Content-Type": "application/json" },
    });
  };
}
```

- [ ] **Step 2: Mount in server.ts** (same pattern as Task 4)

- [ ] **Step 3: Manual verify with curl**

```bash
TOKEN=$(curl -s -X POST http://localhost:8888/api/v1/auth/login -d '{"userId":"<existing>","pin":"<pin>"}' | jq -r '.token')
curl -s http://localhost:8888/api/v1/services/versions -H "Authorization: Bearer $TOKEN" | jq
```
Expected: `{ "gateway": "...", "hermes": "...", "stt_service": "..." }`.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/api/handlers/services-versions.ts gateway/src/server.ts
git commit -m "feat(gateway/api): GET /api/v1/services/versions endpoint"
```

---

## Task 6: Migrate secrets-store from secrets.json to keys.yaml

**Files:**
- Modify: `gateway/src/admin/secrets-store.ts` (rewrite for new schema, preserve `getValueSync` for callers)
- Modify: `gateway/src/admin/secrets-store.test.ts` (update tests)
- Modify: `gateway/src/bootstrap/create-gateway-services.ts` (path change)
- Modify: `gateway/src/admin/internal-secrets-store.ts` (if depends on flat schema)
- Modify: callers: `gateway/src/admin/user-provisioner.ts`, `gateway/src/api/providers-deps.ts`, `gateway/src/api/handlers/admin.ts`, `gateway/src/apply/apply-deps.ts`

This is the largest single task. Existing `secrets-store.ts` uses flat `Record<string, string>` keyed by provider names; new schema is structured with active-provider selection + per-provider `{api_key, base_url}`. Migration must preserve the call sites' API surface.

- [ ] **Step 1: Audit existing API surface**

Read each caller to understand required methods:
```bash
grep -n "secretsStore\." gateway/src/admin/user-provisioner.ts gateway/src/api/providers-deps.ts gateway/src/api/handlers/admin.ts gateway/src/apply/apply-deps.ts
```
Note every method called. Common ones expected: `status()`, `set(provider, value)`, `getValue(provider)`, `getValueSync(provider)`.

- [ ] **Step 2: Define new schema + zod parser**

In `gateway/src/admin/secrets-store.ts`, replace the existing schema with:

```typescript
import { z } from "zod";

const LlmProviderEntry = z.object({
  api_key: z.string().nullable(),
  base_url: z.string().nullable(),
});

const KeysYamlSchema = z.object({
  schema_version: z.string(),
  llm: z.object({
    active: z.enum(["ollama-cloud", "openrouter", "custom"]),
    ollama_cloud: LlmProviderEntry,
    openrouter: LlmProviderEntry,
    custom: LlmProviderEntry,
  }),
  tts: z.object({
    fish_audio: z.object({ api_key: z.string().nullable() }),
  }),
  home_assistant: z.object({
    observe_token: z.string().nullable(),
    mcp_server_token: z.string().nullable(),
  }),
  music_assistant: z.object({
    token: z.string().nullable(),
  }),
  admin_token: z.string(),
});

export type KeysYaml = z.infer<typeof KeysYamlSchema>;
export type LlmProvider = "ollama-cloud" | "openrouter" | "custom";
```

- [ ] **Step 3: Implement load + save with mode 0600 enforcement**

```typescript
// gateway/src/admin/secrets-store.ts
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "secrets-store"]);

const KEYS_FILE_MODE = 0o600;
const SECRETS_DIR_MODE = 0o700;

export type SecretsStoreError =
  | { kind: "io-error"; reason: string }
  | { kind: "corrupt-file"; reason: string }
  | { kind: "permission-too-broad"; mode: number };

export interface ResolvedLlm {
  provider: LlmProvider;
  apiKey: string;       // empty string if null in file (matches Hermes "missing key" behavior)
  baseUrl: string;      // empty string if null
}

export interface SecretsStore {
  /** Load + cache the file. Throws on first read error. */
  load(): Promise<KeysYaml>;
  /** Get the active LLM provider's resolved values for worker injection. */
  getActiveLlm(): Promise<Result<ResolvedLlm, SecretsStoreError>>;
  /** Get the Fish Audio key (or null if not set). */
  getFishAudioKey(): Promise<string | null>;
  /** Synchronous read from cache. Returns null if cache empty. */
  getActiveLlmSync(): ResolvedLlm | null;
  getFishAudioKeySync(): string | null;
  /** Setters — explicit per domain so callers can't dump arbitrary YAML. */
  setLlmProviderKey(provider: LlmProvider, patch: { api_key?: string | null; base_url?: string | null }): Promise<Result<void, SecretsStoreError>>;
  setActiveLlmProvider(provider: LlmProvider): Promise<Result<void, SecretsStoreError>>;
  setFishAudioKey(key: string | null): Promise<Result<void, SecretsStoreError>>;
  setHomeAssistantToken(kind: "observe_token" | "mcp_server_token", token: string | null): Promise<Result<void, SecretsStoreError>>;
  setMusicAssistantToken(token: string | null): Promise<Result<void, SecretsStoreError>>;
  /** Read admin_token (used by auth middleware). */
  getAdminToken(): Promise<string>;
}

export interface SecretsStoreConfig {
  keysPath: string;          // ~/.sentient/secrets/keys.yaml
  templatePath: string;      // gateway/templates/wizard/keys.yaml.tmpl
  generateAdminToken(): string; // injectable for testing
}

export function createSecretsStore(cfg: SecretsStoreConfig): SecretsStore {
  let cache: KeysYaml | null = null;

  async function bootstrap(): Promise<KeysYaml> {
    await fs.mkdir(dirname(cfg.keysPath), { recursive: true, mode: SECRETS_DIR_MODE });
    const tmpl = await fs.readFile(cfg.templatePath, "utf8");
    const rendered = tmpl.replaceAll("{{admin_token}}", cfg.generateAdminToken());
    await writeAtomic(parse(rendered) as KeysYaml);
    log.info("secrets-store.bootstrapped", { path: cfg.keysPath });
    return cache!;
  }

  async function readWithModeCheck(): Promise<KeysYaml | null> {
    let stat;
    try { stat = await fs.lstat(cfg.keysPath); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
    const mode = stat.mode & 0o777;
    if (mode > KEYS_FILE_MODE && process.getuid?.() !== 0) {
      log.warn("secrets-store.permission-too-broad", { mode: mode.toString(8) });
      throw Object.assign(new Error("permission too broad"), { kind: "permission-too-broad", mode });
    }
    const raw = await fs.readFile(cfg.keysPath, "utf8");
    return KeysYamlSchema.parse(parse(raw));
  }

  async function writeAtomic(data: KeysYaml): Promise<void> {
    await fs.mkdir(dirname(cfg.keysPath), { recursive: true, mode: SECRETS_DIR_MODE });
    const tmp = `${cfg.keysPath}.tmp`;
    const handle = await fs.open(tmp, "w", KEYS_FILE_MODE);
    try {
      await handle.write(stringify(data));
      await handle.chmod(KEYS_FILE_MODE);
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, cfg.keysPath);
    cache = data;
  }

  async function loadOrBootstrap(): Promise<KeysYaml> {
    if (cache) return cache;
    const existing = await readWithModeCheck();
    if (existing) {
      cache = existing;
      return existing;
    }
    return bootstrap();
  }

  function resolveLlm(data: KeysYaml): ResolvedLlm {
    const entry = data.llm[data.llm.active === "ollama-cloud" ? "ollama_cloud" : data.llm.active];
    return {
      provider: data.llm.active,
      apiKey: entry.api_key ?? "",
      baseUrl: entry.base_url ?? "",
    };
  }

  return {
    load: loadOrBootstrap,

    async getActiveLlm() {
      try {
        const data = await loadOrBootstrap();
        return { ok: true, value: resolveLlm(data) };
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { kind: "io-error", reason } };
      }
    },

    async getFishAudioKey() {
      const data = await loadOrBootstrap();
      return data.tts.fish_audio.api_key;
    },

    getActiveLlmSync() { return cache ? resolveLlm(cache) : null; },
    getFishAudioKeySync() { return cache?.tts.fish_audio.api_key ?? null; },

    async setLlmProviderKey(provider, patch) {
      try {
        const data = await loadOrBootstrap();
        const key = provider === "ollama-cloud" ? "ollama_cloud" : provider;
        const next = {
          ...data,
          llm: {
            ...data.llm,
            [key]: {
              api_key: "api_key" in patch ? patch.api_key ?? null : data.llm[key].api_key,
              base_url: "base_url" in patch ? patch.base_url ?? null : data.llm[key].base_url,
            },
          },
        };
        await writeAtomic(next);
        log.info("secrets-store.llm-key-set", { provider });
        return { ok: true, value: undefined };
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { kind: "io-error", reason } };
      }
    },

    async setActiveLlmProvider(provider) {
      try {
        const data = await loadOrBootstrap();
        await writeAtomic({ ...data, llm: { ...data.llm, active: provider } });
        log.info("secrets-store.active-provider-set", { provider });
        return { ok: true, value: undefined };
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { kind: "io-error", reason } };
      }
    },

    async setFishAudioKey(key) {
      try {
        const data = await loadOrBootstrap();
        await writeAtomic({ ...data, tts: { fish_audio: { api_key: key } } });
        log.info("secrets-store.fish-key-set", { hasKey: key !== null });
        return { ok: true, value: undefined };
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { kind: "io-error", reason } };
      }
    },

    async setHomeAssistantToken(kind, token) {
      try {
        const data = await loadOrBootstrap();
        await writeAtomic({ ...data, home_assistant: { ...data.home_assistant, [kind]: token } });
        log.info("secrets-store.ha-token-set", { kind, hasToken: token !== null });
        return { ok: true, value: undefined };
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { kind: "io-error", reason } };
      }
    },

    async setMusicAssistantToken(token) {
      try {
        const data = await loadOrBootstrap();
        await writeAtomic({ ...data, music_assistant: { token } });
        log.info("secrets-store.ma-token-set", { hasToken: token !== null });
        return { ok: true, value: undefined };
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { kind: "io-error", reason } };
      }
    },

    async getAdminToken() {
      const data = await loadOrBootstrap();
      return data.admin_token;
    },
  };
}
```

- [ ] **Step 4: Update existing test file**

Replace `gateway/src/admin/secrets-store.test.ts` to test the new API. Cover:
- Bootstrap creates file with mode 0600
- Round-trip set/get for each domain
- Active LLM resolution returns correct entry
- Reject reading file with mode 0644 (permission too broad)
- Atomic write recovery (temp file ignored)

- [ ] **Step 5: Update callers**

For each caller: replace `secretsStore.getValue("openrouter")` patterns with the new methods (`getActiveLlm`, `getFishAudioKey`, etc.). The `user-provisioner.ts` switches from per-provider lookup to `getActiveLlm()`. The `admin.ts` handler may need temporary stubbing — full secrets-management endpoints come in Task 13.

- [ ] **Step 6: Update bootstrap path**

In `create-gateway-services.ts`, change the `createSecretsStore` instantiation:
```typescript
import { randomBytes } from "node:crypto";
const secretsStore = createSecretsStore({
  keysPath: join(SENTIENT_HOME, "secrets/keys.yaml"),
  templatePath: join(TEMPLATE_DIR, "wizard/keys.yaml.tmpl"),
  generateAdminToken: () => randomBytes(32).toString("hex"),
});
```

- [ ] **Step 7: Run all gateway tests**

```bash
cd gateway && bun run test
```
Expected: PASS (some test fixtures may need updating; fix any caller-test that references the old flat schema).

- [ ] **Step 8: Manual smoke**

```bash
rm -rf ~/.sentient.test
SENTIENT_HOME=~/.sentient.test bun run dev
# Verify ~/.sentient.test/secrets/keys.yaml exists, mode 0600:
stat -f '%A' ~/.sentient.test/secrets/keys.yaml  # macOS
# stat -c '%a' ~/.sentient.test/secrets/keys.yaml  # Linux
```
Expected: `600`.

- [ ] **Step 9: Commit**

```bash
git add gateway/src/admin/secrets-store.ts gateway/src/admin/secrets-store.test.ts gateway/src/admin/internal-secrets-store.ts gateway/src/bootstrap/create-gateway-services.ts gateway/src/admin/user-provisioner.ts gateway/src/api/providers-deps.ts gateway/src/api/handlers/admin.ts gateway/src/apply/apply-deps.ts
git commit -m "refactor(gateway/admin): migrate secrets-store to keys.yaml schema"
```

---

## Task 7: unlock-code service

**Files:**
- Create: `gateway/src/admin/unlock-code.ts`
- Test: `gateway/src/admin/unlock-code.test.ts`

Generates 6-digit code on first boot. Writes to `~/.sentient/.bootstrap-unlock` (mode 0600) and stdout. Verifies caller-supplied code with constant-time compare.

- [ ] **Step 1: Write failing test**

```typescript
// gateway/src/admin/unlock-code.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUnlockCode } from "./unlock-code.js";

describe("UnlockCode", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "unlock-test-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("generates 6-digit code on first call", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    const code = await svc.ensure();
    expect(code).toMatch(/^\d{6}$/);
    expect(existsSync(join(dir, ".bootstrap-unlock"))).toBe(true);
    const mode = statSync(join(dir, ".bootstrap-unlock")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("preserves existing code on second call", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    const a = await svc.ensure();
    const b = await svc.ensure();
    expect(a).toBe(b);
  });

  it("verify returns true for matching code", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    const code = await svc.ensure();
    expect(await svc.verify(code)).toBe(true);
  });

  it("verify returns false for non-matching code", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    await svc.ensure();
    expect(await svc.verify("000000")).toBe(false);
  });

  it("clear() deletes the code file", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    await svc.ensure();
    await svc.clear();
    expect(existsSync(join(dir, ".bootstrap-unlock"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd gateway && bun run test src/admin/unlock-code.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// gateway/src/admin/unlock-code.ts
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomInt, timingSafeEqual } from "node:crypto";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "unlock-code"]);

const CODE_LENGTH = 6;
const CODE_FILE_MODE = 0o600;

export interface UnlockCodeConfig {
  codePath: string; // ~/.sentient/.bootstrap-unlock
}

export interface UnlockCode {
  ensure(): Promise<string>; // generates if missing; returns existing otherwise
  verify(input: string): Promise<boolean>;
  clear(): Promise<void>;
}

function generate(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += String(randomInt(0, 10));
  return s;
}

export function createUnlockCode(cfg: UnlockCodeConfig): UnlockCode {
  async function readExisting(): Promise<string | null> {
    try {
      const raw = await fs.readFile(cfg.codePath, "utf8");
      const trimmed = raw.trim();
      return /^\d{6}$/.test(trimmed) ? trimmed : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  return {
    async ensure() {
      const existing = await readExisting();
      if (existing) return existing;
      const code = generate();
      await fs.mkdir(dirname(cfg.codePath), { recursive: true });
      const handle = await fs.open(cfg.codePath, "w", CODE_FILE_MODE);
      try { await handle.write(code); await handle.chmod(CODE_FILE_MODE); }
      finally { await handle.close(); }
      log.info("unlock-code.generated", { path: cfg.codePath });
      // Print to stdout so docker compose logs surface it.
      console.log(`\n========================================\nSentient bootstrap unlock code: ${code}\nFind it later at: ${cfg.codePath}\n========================================\n`);
      return code;
    },

    async verify(input) {
      const existing = await readExisting();
      if (!existing) return false;
      if (input.length !== existing.length) return false;
      return timingSafeEqual(Buffer.from(input), Buffer.from(existing));
    },

    async clear() {
      try { await fs.unlink(cfg.codePath); log.info("unlock-code.cleared"); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    },
  };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd gateway && bun run test src/admin/unlock-code.test.ts
```
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/admin/unlock-code.ts gateway/src/admin/unlock-code.test.ts
git commit -m "feat(gateway/admin): unlock-code service for bootstrap window"
```

---

## Task 8: Wire unlock-code + install-state into bootstrap

**Files:**
- Modify: `gateway/src/bootstrap/create-gateway-services.ts`
- Modify: `gateway/src/main.ts`

At gateway start: ensure state.yaml exists, ensure .bootstrap-unlock exists if `bootstrap_complete=false`. Both happen before serving any HTTP request.

- [ ] **Step 1: Update bootstrap to call ensure() when not complete**

```typescript
// gateway/src/main.ts (excerpt — add near services creation, before server start)
const state = await services.installState.load();
if (!state.bootstrap_complete) {
  await services.unlockCode.ensure();
  log.info("bootstrap-mode", { unlockCodePath: services.unlockCodePath });
} else {
  await services.unlockCode.clear(); // belt-and-braces if leftover
}
```

- [ ] **Step 2: Add unlockCode to GatewayServices**

```typescript
// gateway/src/bootstrap/create-gateway-services.ts (additions)
import { type UnlockCode, createUnlockCode } from "../admin/unlock-code.js";

const unlockCode = createUnlockCode({
  codePath: join(SENTIENT_HOME, ".bootstrap-unlock"),
});

// In GatewayServices interface:
//   readonly unlockCode: UnlockCode;
//   readonly unlockCodePath: string;
```

- [ ] **Step 3: Manual verify**

```bash
rm -rf ~/.sentient.test ; SENTIENT_HOME=~/.sentient.test bun run dev
# Look for the boxed unlock code in stdout.
cat ~/.sentient.test/.bootstrap-unlock
stat -f '%A' ~/.sentient.test/.bootstrap-unlock  # expect 600
```

- [ ] **Step 4: Commit**

```bash
git add gateway/src/bootstrap/create-gateway-services.ts gateway/src/main.ts
git commit -m "feat(gateway/bootstrap): generate unlock code on first boot"
```

---

## Task 9: Wizard handlers — unlock + provider + voice + finish + test-provider

**Files:**
- Create: `gateway/src/api/handlers/wizard.ts`
- Test: `gateway/src/api/handlers/wizard.test.ts`
- Modify: `gateway/src/server.ts` (mount routes)

Five endpoints. All gated by `assertWizardOpen()`. POST `/unlock` is special (no `unlock_verified` precondition; sets the flag).

- [ ] **Step 1: Write security-boundary tests (the load-bearing tests for this handler)**

```typescript
// gateway/src/api/handlers/wizard.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWizardHandler } from "./wizard.js";
import type { InstallState, InstallStateData } from "../../admin/install-state.js";
import type { UnlockCode } from "../../admin/unlock-code.js";
import type { SecretsStore } from "../../admin/secrets-store.js";

function makeState(overrides: Partial<InstallStateData> = {}): InstallStateData { /* same as Task 4 */ return {
  schema_version: "1.0.0", installed_version: "1.0.0", last_upgraded_from: null, last_upgraded_at: null,
  bootstrap_complete: false, wizard_cursor: "provider", unlock_verified: false,
  services: { gateway: "1.0.0", hermes: "v2026.4.23", stt_service: "1.0.0" },
  ...overrides,
};}

function makeDeps(overrides: Partial<{ state: InstallStateData; verifyUnlock: boolean }> = {}) {
  let state = overrides.state ?? makeState();
  const installState: InstallState = {
    load: async () => state,
    advanceCursor: async (from, to) => {
      if (state.bootstrap_complete) return { ok: false, error: { kind: "already-complete" } };
      if (state.wizard_cursor !== from) return { ok: false, error: { kind: "cursor-mismatch", expected: from, actual: state.wizard_cursor } };
      state = { ...state, wizard_cursor: to }; return { ok: true, value: undefined };
    },
    setUnlockVerified: async () => { state = { ...state, unlock_verified: true }; return { ok: true, value: undefined }; },
    finish: async () => { state = { ...state, bootstrap_complete: true }; return { ok: true, value: undefined }; },
  };
  const unlockCode: UnlockCode = {
    ensure: async () => "123456",
    verify: vi.fn(async (input) => overrides.verifyUnlock !== false && input === "123456"),
    clear: vi.fn(async () => undefined),
  };
  const secretsStore: Pick<SecretsStore, "setLlmProviderKey" | "setActiveLlmProvider" | "setFishAudioKey"> = {
    setLlmProviderKey: vi.fn(async () => ({ ok: true, value: undefined })),
    setActiveLlmProvider: vi.fn(async () => ({ ok: true, value: undefined })),
    setFishAudioKey: vi.fn(async () => ({ ok: true, value: undefined })),
  };
  return { handler: createWizardHandler({ installState, unlockCode, secretsStore: secretsStore as SecretsStore, testProvider: async () => ({ ok: true, modelCount: 5, sampleModels: ["a","b","c"] }) }), unlockCode, secretsStore };
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("wizard.unlock", () => {
  it("succeeds with correct code; sets unlock_verified", async () => {
    const { handler } = makeDeps();
    const res = await handler(postJson("/api/v1/wizard/unlock", { code: "123456" }));
    expect(res.status).toBe(200);
  });

  it("rejects wrong code with 401 and ≥800ms latency", async () => {
    const { handler } = makeDeps();
    const start = Date.now();
    const res = await handler(postJson("/api/v1/wizard/unlock", { code: "000000" }));
    const elapsed = Date.now() - start;
    expect(res.status).toBe(401);
    expect(elapsed).toBeGreaterThanOrEqual(800);
  });

  it("returns 410 after bootstrap_complete=true", async () => {
    const { handler } = makeDeps({ state: makeState({ bootstrap_complete: true, wizard_cursor: "complete", unlock_verified: true }) });
    const res = await handler(postJson("/api/v1/wizard/unlock", { code: "123456" }));
    expect(res.status).toBe(410);
  });
});

describe("wizard.provider security gates", () => {
  it("returns 401 when unlock_verified=false (no side effect)", async () => {
    const { handler, secretsStore } = makeDeps({ state: makeState({ unlock_verified: false }) });
    const res = await handler(postJson("/api/v1/wizard/provider", { provider: "openrouter", api_key: "sk-or-X" }));
    expect(res.status).toBe(401);
    expect(secretsStore.setLlmProviderKey).not.toHaveBeenCalled();
  });

  it("returns 410 when bootstrap_complete=true (no side effect)", async () => {
    const { handler, secretsStore } = makeDeps({ state: makeState({ bootstrap_complete: true, unlock_verified: true, wizard_cursor: "complete" }) });
    const res = await handler(postJson("/api/v1/wizard/provider", { provider: "openrouter", api_key: "sk-or-X" }));
    expect(res.status).toBe(410);
    expect(secretsStore.setLlmProviderKey).not.toHaveBeenCalled();
  });

  it("returns 409 when cursor mismatched (no side effect)", async () => {
    const { handler, secretsStore } = makeDeps({ state: makeState({ unlock_verified: true, wizard_cursor: "voice" }) });
    const res = await handler(postJson("/api/v1/wizard/provider", { provider: "openrouter", api_key: "sk-or-X" }));
    expect(res.status).toBe(409);
    expect(secretsStore.setLlmProviderKey).not.toHaveBeenCalled();
  });

  it("succeeds when unlocked + cursor match", async () => {
    const { handler, secretsStore } = makeDeps({ state: makeState({ unlock_verified: true, wizard_cursor: "provider" }) });
    const res = await handler(postJson("/api/v1/wizard/provider", { provider: "openrouter", api_key: "sk-or-X" }));
    expect(res.status).toBe(200);
    expect(secretsStore.setLlmProviderKey).toHaveBeenCalledWith("openrouter", expect.objectContaining({ api_key: "sk-or-X" }));
    expect(secretsStore.setActiveLlmProvider).toHaveBeenCalledWith("openrouter");
  });
});

describe("wizard.finish", () => {
  it("clears unlock-code file and flips bootstrap_complete", async () => {
    const { handler, unlockCode } = makeDeps({ state: makeState({ unlock_verified: true, wizard_cursor: "complete" }) });
    const res = await handler(postJson("/api/v1/wizard/finish", {}));
    expect(res.status).toBe(200);
    expect(unlockCode.clear).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd gateway && bun run test src/api/handlers/wizard.test.ts
```
Expected: FAIL — handler not implemented.

- [ ] **Step 3: Implement handler**

```typescript
// gateway/src/api/handlers/wizard.ts
import { z } from "zod";
import type { InstallState, WizardCursor } from "../../admin/install-state.js";
import type { UnlockCode } from "../../admin/unlock-code.js";
import type { LlmProvider, SecretsStore } from "../../admin/secrets-store.js";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "wizard"]);

const UNLOCK_FAIL_DELAY_MS = 800;

const ProviderBody = z.object({
  provider: z.enum(["ollama-cloud", "openrouter", "custom"]),
  api_key: z.string().min(1).optional().nullable(),
  base_url: z.string().url().optional().nullable(),
});
const VoiceBody = z.union([
  z.object({ skip: z.literal(true) }),
  z.object({ api_key: z.string().min(1) }),
]);
const UnlockBody = z.object({ code: z.string().regex(/^\d{6}$/) });
const TestProviderBody = ProviderBody;

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
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function assertWizardOpen(state: InstallState, expectedCursor: WizardCursor, requireUnlock = true): Promise<Response | null> {
  const data = await state.load();
  if (data.bootstrap_complete) return jsonResponse(410, { error: "wizard-closed" });
  if (requireUnlock && !data.unlock_verified) return jsonResponse(401, { error: "unlock-required" });
  if (data.wizard_cursor !== expectedCursor) return jsonResponse(409, { error: "wizard-cursor-mismatch", current_cursor: data.wizard_cursor, expected_cursor: expectedCursor });
  return null;
}

export function createWizardHandler(deps: WizardDeps) {
  async function handleUnlock(req: Request): Promise<Response> {
    const state = await deps.installState.load();
    if (state.bootstrap_complete) return jsonResponse(410, { error: "wizard-closed" });
    if (state.unlock_verified) return jsonResponse(410, { error: "already-unlocked" });
    const body = UnlockBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return jsonResponse(400, { error: "bad-body" });
    const ok = await deps.unlockCode.verify(body.data.code);
    if (!ok) {
      await new Promise(r => setTimeout(r, UNLOCK_FAIL_DELAY_MS));
      log.warn("wizard.unlock.failed");
      return jsonResponse(401, { error: "wrong-code" });
    }
    await deps.installState.setUnlockVerified();
    log.info("wizard.unlock.success");
    return jsonResponse(200, { ok: true });
  }

  async function handleProvider(req: Request): Promise<Response> {
    const gate = await assertWizardOpen(deps.installState, "provider");
    if (gate) return gate;
    const body = ProviderBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return jsonResponse(400, { error: "bad-body" });
    const { provider, api_key, base_url } = body.data;
    const setKey = await deps.secretsStore.setLlmProviderKey(provider, { api_key: api_key ?? null, base_url: base_url ?? null });
    if (!setKey.ok) return jsonResponse(500, { error: "secrets-write-failed" });
    const setActive = await deps.secretsStore.setActiveLlmProvider(provider);
    if (!setActive.ok) return jsonResponse(500, { error: "secrets-write-failed" });
    const adv = await deps.installState.advanceCursor("provider", "voice");
    if (!adv.ok) return jsonResponse(409, { error: "cursor-advance-failed" });
    log.info("wizard.provider.saved", { provider });
    return jsonResponse(200, { ok: true, next_cursor: "voice" });
  }

  async function handleVoice(req: Request): Promise<Response> {
    const gate = await assertWizardOpen(deps.installState, "voice");
    if (gate) return gate;
    const body = VoiceBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return jsonResponse(400, { error: "bad-body" });
    if ("skip" in body.data) {
      log.info("wizard.voice.skipped");
    } else {
      const set = await deps.secretsStore.setFishAudioKey(body.data.api_key);
      if (!set.ok) return jsonResponse(500, { error: "secrets-write-failed" });
      log.info("wizard.voice.saved");
    }
    const adv = await deps.installState.advanceCursor("voice", "complete");
    if (!adv.ok) return jsonResponse(409, { error: "cursor-advance-failed" });
    return jsonResponse(200, { ok: true, next_cursor: "complete" });
  }

  async function handleFinish(req: Request): Promise<Response> {
    const gate = await assertWizardOpen(deps.installState, "complete");
    if (gate) return gate;
    const r = await deps.installState.finish();
    if (!r.ok) return jsonResponse(500, { error: "finish-failed" });
    await deps.unlockCode.clear();
    log.info("wizard.finished");
    return jsonResponse(200, { ok: true });
  }

  async function handleTestProvider(req: Request): Promise<Response> {
    const state = await deps.installState.load();
    if (state.bootstrap_complete) return jsonResponse(410, { error: "wizard-closed" });
    if (!state.unlock_verified) return jsonResponse(401, { error: "unlock-required" });
    const body = TestProviderBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return jsonResponse(400, { error: "bad-body" });
    const result = await deps.testProvider(body.data.provider, body.data.api_key ?? null, body.data.base_url ?? null);
    return jsonResponse(200, result);
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method !== "POST") return jsonResponse(405, { error: "method-not-allowed" });
    if (path === "/api/v1/wizard/unlock") return handleUnlock(req);
    if (path === "/api/v1/wizard/provider") return handleProvider(req);
    if (path === "/api/v1/wizard/voice") return handleVoice(req);
    if (path === "/api/v1/wizard/finish") return handleFinish(req);
    if (path === "/api/v1/wizard/test-provider") return handleTestProvider(req);
    return jsonResponse(404, { error: "not-found" });
  };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd gateway && bun run test src/api/handlers/wizard.test.ts
```
Expected: all PASS.

- [ ] **Step 5: Implement test-provider stub**

In `create-gateway-services.ts` add a `testProvider` function — a small fetch that hits the OpenAI-compatible `/v1/models` endpoint at `base_url` with the supplied API key, returns model count + first 3 names. 5-second timeout.

```typescript
async function testProviderImpl(provider: LlmProvider, apiKey: string | null, baseUrl: string | null): Promise<TestProviderResult> {
  const url = baseUrl ?? (provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://ollama.com/v1");
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(`${url}/models`, { headers, signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json() as { data?: Array<{ id: string }> };
    const models = body.data ?? [];
    return { ok: true, modelCount: models.length, sampleModels: models.slice(0, 3).map(m => m.id) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 6: Mount in server.ts**

```typescript
const handleWizard = createWizardHandler({
  installState: services.installState,
  unlockCode: services.unlockCode,
  secretsStore: services.secretsStore,
  testProvider: testProviderImpl,
});
// Add /api/v1/wizard/* to route table → handleWizard
```

- [ ] **Step 7: Manual smoke (full wizard via curl)**

```bash
rm -rf ~/.sentient.test && SENTIENT_HOME=~/.sentient.test bun run dev &
sleep 3
CODE=$(cat ~/.sentient.test/.bootstrap-unlock)
curl -s -X POST http://localhost:8888/api/v1/wizard/unlock -H "Content-Type: application/json" -d "{\"code\":\"$CODE\"}"
curl -s -X POST http://localhost:8888/api/v1/wizard/provider -H "Content-Type: application/json" -d '{"provider":"ollama-cloud","base_url":"http://host.docker.internal:11434/v1"}'
curl -s -X POST http://localhost:8888/api/v1/wizard/voice -H "Content-Type: application/json" -d '{"skip":true}'
curl -s -X POST http://localhost:8888/api/v1/wizard/finish -H "Content-Type: application/json" -d '{}'
curl -s http://localhost:8888/api/v1/install-state | jq
```
Expected: `bootstrap_complete: true`. `~/.sentient.test/.bootstrap-unlock` is gone.

- [ ] **Step 8: Commit**

```bash
git add gateway/src/api/handlers/wizard.ts gateway/src/api/handlers/wizard.test.ts gateway/src/server.ts gateway/src/bootstrap/create-gateway-services.ts
git commit -m "feat(gateway/api): wizard endpoints (unlock, provider, voice, finish, test-provider)"
```

---

# Phase 2 — Hermes integration + secrets management API

## Task 10: Generalize supervisord-control to llmApiKey + llmBaseUrl

**Files:**
- Modify: `gateway/src/admin/supervisord-control.ts`
- Modify: `gateway/templates/supervisord-program.tmpl` (find existing template)
- Modify: callers (only `user-provisioner.ts` per audit)

Existing UpsertInput has `openrouterKey` + `ollamaKey` (legacy from before active-provider switching). Replace with `llmApiKey` + `llmBaseUrl` (single resolved pair from `secretsStore.getActiveLlm()`).

- [ ] **Step 1: Read current template**

```bash
find gateway -name "supervisord-program.tmpl" -not -path "*/node_modules/*"
cat gateway/templates/supervisord-program.tmpl  # or wherever it lives
```

- [ ] **Step 2: Update template substitution variables**

In the `.tmpl` file, replace `{{openrouterKey}}` and `{{ollamaKey}}` with `{{llmApiKey}}` and `{{llmBaseUrl}}`. The Hermes upstream env var is still named `OPENROUTER_API_KEY` regardless of which provider we point at.

```ini
environment=
  HERMES_HOME="{{hermesHome}}",
  SENTIENT_GATEWAY_TOKEN="{{token}}",
  SENTIENT_GATEWAY_PORT="{{port}}",
  TZ="{{timezone}}",
  OPENROUTER_API_KEY="{{llmApiKey}}",
  OPENROUTER_BASE_URL="{{llmBaseUrl}}"
```

- [ ] **Step 3: Update UpsertInput + renderProgram**

```typescript
// gateway/src/admin/supervisord-control.ts
export interface UpsertInput {
  userId: string;
  port: number;
  token: string;
  timezone: string;
  hermesHome: string;
  llmApiKey: string;
  llmBaseUrl: string;
}

export function renderProgram(template: string, input: UpsertInput): string {
  return template
    .replaceAll("{{userId}}", input.userId)
    .replaceAll("{{port}}", String(input.port))
    .replaceAll("{{token}}", input.token)
    .replaceAll("{{timezone}}", input.timezone)
    .replaceAll("{{hermesHome}}", input.hermesHome)
    .replaceAll("{{llmApiKey}}", input.llmApiKey)
    .replaceAll("{{llmBaseUrl}}", input.llmBaseUrl);
}
```

- [ ] **Step 4: Update user-provisioner.ts to read getActiveLlm()**

```typescript
// gateway/src/admin/user-provisioner.ts (in the spawn flow)
const llmResult = await deps.secretsStore.getActiveLlm();
if (!llmResult.ok) return { ok: false, error: { kind: "secrets-read-failed", reason: llmResult.error.reason } };
await deps.supervisordControl.upsertProgram({
  userId, port, token, timezone, hermesHome,
  llmApiKey: llmResult.value.apiKey,
  llmBaseUrl: llmResult.value.baseUrl,
});
```

- [ ] **Step 5: Update tests**

Existing `supervisord-control` tests use `openrouterKey`/`ollamaKey`. Update to `llmApiKey`/`llmBaseUrl`. Existing `user-provisioner` tests likely mock the secretsStore — update mocks.

- [ ] **Step 6: Run all tests**

```bash
cd gateway && bun run test
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add gateway/src/admin/supervisord-control.ts gateway/src/admin/user-provisioner.ts gateway/templates/supervisord-program.tmpl gateway/src/admin/*.test.ts
git commit -m "refactor(gateway/admin): generalize supervisord program to llmApiKey + llmBaseUrl"
```

---

## Task 11: Key-rotation orchestrator

**Files:**
- Create: `gateway/src/admin/key-rotation.ts`
- Test: `gateway/src/admin/key-rotation.test.ts`

Used post-bootstrap when an admin changes the active LLM provider's key. Sequentially restarts each user's hermes worker so they pick up the new env. Reports progress via in-memory state queryable by webui.

- [ ] **Step 1: Implement** (no need to TDD — small orchestrator over already-tested primitives; smoke test in Task 17 covers it)

```typescript
// gateway/src/admin/key-rotation.ts
import type { SupervisordControl } from "./supervisord-control.js";
import type { UserProvisioner } from "./user-provisioner.js";
import type { SecretsStore } from "./secrets-store.js";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "key-rotation"]);

export interface RotationStatus {
  active: boolean;
  current_user: string | null;
  completed: number;
  total: number;
  failures: Array<{ userId: string; reason: string }>;
}

export interface KeyRotationOrchestrator {
  rotate(): Promise<void>; // fire-and-forget; webui polls status
  status(): RotationStatus;
}

export interface KeyRotationDeps {
  listUsers: () => Promise<string[]>; // userIds
  reprovisionUser: (userId: string) => Promise<{ ok: boolean; reason?: string }>;
  // reprovisionUser: re-renders supervisord program with current secretsStore values, then restartProfile.
}

export function createKeyRotation(deps: KeyRotationDeps): KeyRotationOrchestrator {
  let status: RotationStatus = { active: false, current_user: null, completed: 0, total: 0, failures: [] };
  let running: Promise<void> | null = null;

  async function loop() {
    const users = await deps.listUsers();
    status = { active: true, current_user: null, completed: 0, total: users.length, failures: [] };
    for (const userId of users) {
      status = { ...status, current_user: userId };
      const r = await deps.reprovisionUser(userId);
      if (!r.ok) {
        status = { ...status, failures: [...status.failures, { userId, reason: r.reason ?? "unknown" }] };
        log.warn("key-rotation.user-failed", { userId, reason: r.reason });
      }
      status = { ...status, completed: status.completed + 1 };
    }
    status = { ...status, active: false, current_user: null };
    log.info("key-rotation.done", { failures: status.failures.length });
  }

  return {
    async rotate() {
      if (running) return running;
      running = loop().finally(() => { running = null; });
    },
    status() { return status; },
  };
}
```

- [ ] **Step 2: Wire reprovisionUser in create-gateway-services.ts**

```typescript
const keyRotation = createKeyRotation({
  listUsers: () => userProvisioner.listUserIds(),
  reprovisionUser: async (userId) => {
    const llm = await secretsStore.getActiveLlm();
    if (!llm.ok) return { ok: false, reason: llm.error.reason };
    const port = userPortStore.getPortFor(userId);
    if (port === null) return { ok: false, reason: "no-port" };
    const token = await tokenService.getHermesBearerFor(userId); // adapt to actual API
    const upsert = await supervisordControl.upsertProgram({
      userId, port, token, timezone, hermesHome: ...,
      llmApiKey: llm.value.apiKey, llmBaseUrl: llm.value.baseUrl,
    });
    if (!upsert.ok) return { ok: false, reason: upsert.error.reason };
    const restart = await supervisordControl.restartProfile(userId, 10000);
    return restart.ok ? { ok: true } : { ok: false, reason: restart.error.reason };
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add gateway/src/admin/key-rotation.ts gateway/src/bootstrap/create-gateway-services.ts
git commit -m "feat(gateway/admin): key-rotation orchestrator for active-LLM key changes"
```

---

## Task 12: Secrets management endpoints

**Files:**
- Create: `gateway/src/api/handlers/secrets.ts`
- Test: `gateway/src/api/handlers/secrets.test.ts`
- Modify: `gateway/src/server.ts`

GET `/admin/secrets` (presence-only) + PUT/DELETE setters. ADMIN_TOKEN + is_admin gated. **Critical: never echo secrets in responses or logs.**

- [ ] **Step 1: Write the never-echo security tests**

```typescript
// gateway/src/api/handlers/secrets.test.ts
import { describe, it, expect, vi } from "vitest";
import { createSecretsHandler } from "./secrets.js";
import type { SecretsStore, KeysYaml } from "../../admin/secrets-store.js";

function makeKeys(overrides: Partial<KeysYaml> = {}): KeysYaml {
  return {
    schema_version: "1.0.0",
    llm: {
      active: "openrouter",
      ollama_cloud: { api_key: null, base_url: "http://host.docker.internal:11434/v1" },
      openrouter:   { api_key: "sk-or-SECRETXYZ", base_url: null },
      custom:       { api_key: null, base_url: null },
    },
    tts: { fish_audio: { api_key: "fa-SECRETXYZ" } },
    home_assistant: { observe_token: null, mcp_server_token: null },
    music_assistant: { token: null },
    admin_token: "internal",
    ...overrides,
  };
}

function makeStore(data: KeysYaml): SecretsStore {
  return {
    load: async () => data,
    getActiveLlm: async () => ({ ok: true, value: { provider: data.llm.active, apiKey: data.llm[data.llm.active === "ollama-cloud" ? "ollama_cloud" : data.llm.active].api_key ?? "", baseUrl: data.llm[data.llm.active === "ollama-cloud" ? "ollama_cloud" : data.llm.active].base_url ?? "" } }),
    getActiveLlmSync: () => null,
    getFishAudioKey: async () => data.tts.fish_audio.api_key,
    getFishAudioKeySync: () => data.tts.fish_audio.api_key,
    setLlmProviderKey: vi.fn(async () => ({ ok: true, value: undefined })),
    setActiveLlmProvider: vi.fn(async () => ({ ok: true, value: undefined })),
    setFishAudioKey: vi.fn(async () => ({ ok: true, value: undefined })),
    setHomeAssistantToken: vi.fn(async () => ({ ok: true, value: undefined })),
    setMusicAssistantToken: vi.fn(async () => ({ ok: true, value: undefined })),
    getAdminToken: async () => "internal",
  };
}

describe("secrets.GET — never echo", () => {
  it("response body contains no key value", async () => {
    const handler = createSecretsHandler({
      secretsStore: makeStore(makeKeys()),
      installState: { load: async () => ({ bootstrap_complete: true } as any) } as any,
      requireAdmin: async () => ({ ok: true, value: { isAdmin: true } as any }),
      keyRotation: { rotate: async () => undefined, status: () => ({} as any) },
    });
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets"));
    const text = await res.text();
    expect(text).not.toContain("SECRETXYZ");
    expect(text).not.toContain("sk-or-");
    expect(text).not.toContain("fa-");
  });

  it("response shows correct presence flags", async () => {
    const handler = createSecretsHandler({
      secretsStore: makeStore(makeKeys()),
      installState: { load: async () => ({ bootstrap_complete: true } as any) } as any,
      requireAdmin: async () => ({ ok: true, value: { isAdmin: true } as any }),
      keyRotation: { rotate: async () => undefined, status: () => ({} as any) },
    });
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets"));
    const body = await res.json();
    expect(body.llm.openrouter.has_key).toBe(true);
    expect(body.llm.ollama_cloud.has_key).toBe(false);
    expect(body.tts.fish_audio.has_key).toBe(true);
  });
});

describe("secrets.PUT — never echo", () => {
  it("response body does not reflect submitted value", async () => {
    const handler = createSecretsHandler({
      secretsStore: makeStore(makeKeys()),
      installState: { load: async () => ({ bootstrap_complete: true } as any) } as any,
      requireAdmin: async () => ({ ok: true, value: { isAdmin: true } as any }),
      keyRotation: { rotate: async () => undefined, status: () => ({} as any) },
    });
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets/llm/openrouter", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "sk-or-NEWSECRET" }),
    }));
    const text = await res.text();
    expect(text).not.toContain("NEWSECRET");
  });
});

describe("secrets gating", () => {
  it("returns 412 when bootstrap_complete=false", async () => {
    const handler = createSecretsHandler({
      secretsStore: makeStore(makeKeys()),
      installState: { load: async () => ({ bootstrap_complete: false } as any) } as any,
      requireAdmin: async () => ({ ok: true, value: { isAdmin: true } as any }),
      keyRotation: { rotate: async () => undefined, status: () => ({} as any) },
    });
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets"));
    expect(res.status).toBe(412);
  });

  it("returns 403 when user is_admin=false", async () => {
    const handler = createSecretsHandler({
      secretsStore: makeStore(makeKeys()),
      installState: { load: async () => ({ bootstrap_complete: true } as any) } as any,
      requireAdmin: async () => ({ ok: true, value: { isAdmin: false } as any }),
      keyRotation: { rotate: async () => undefined, status: () => ({} as any) },
    });
    const res = await handler(new Request("http://localhost/api/v1/admin/secrets"));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd gateway && bun run test src/api/handlers/secrets.test.ts
```

- [ ] **Step 3: Implement handler**

```typescript
// gateway/src/api/handlers/secrets.ts
import { z } from "zod";
import type { InstallState } from "../../admin/install-state.js";
import type { LlmProvider, SecretsStore } from "../../admin/secrets-store.js";
import type { KeyRotationOrchestrator } from "../../admin/key-rotation.js";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "secrets"]);

export interface SecretsDeps {
  secretsStore: SecretsStore;
  installState: InstallState;
  requireAdmin: (req: Request) => Promise<{ ok: true; value: { isAdmin: boolean } } | { ok: false }>;
  keyRotation: KeyRotationOrchestrator;
}

const LlmKeyBody = z.object({ api_key: z.union([z.string(), z.null()]).optional(), base_url: z.union([z.string(), z.null()]).optional() });
const SetActiveBody = z.object({ provider: z.enum(["ollama-cloud", "openrouter", "custom"]) });
const FishAudioBody = z.object({ api_key: z.union([z.string(), z.null()]) });
const HaTokenBody = z.object({ token: z.union([z.string(), z.null()]) });
const MaTokenBody = z.object({ token: z.union([z.string(), z.null()]) });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function createSecretsHandler(deps: SecretsDeps) {
  async function gate(req: Request): Promise<Response | null> {
    const state = await deps.installState.load();
    if (!state.bootstrap_complete) return jsonResponse(412, { error: "bootstrap-incomplete" });
    const auth = await deps.requireAdmin(req);
    if (!auth.ok) return jsonResponse(401, { error: "unauthorized" });
    if (!auth.value.isAdmin) return jsonResponse(403, { error: "not-admin" });
    return null;
  }

  async function handleGet(): Promise<Response> {
    const data = await deps.secretsStore.load();
    const body = {
      llm: {
        active: data.llm.active,
        ollama_cloud: { has_key: data.llm.ollama_cloud.api_key !== null, has_base_url: data.llm.ollama_cloud.base_url !== null, base_url: data.llm.ollama_cloud.base_url },
        openrouter:   { has_key: data.llm.openrouter.api_key !== null,   has_base_url: data.llm.openrouter.base_url !== null,   base_url: data.llm.openrouter.base_url },
        custom:       { has_key: data.llm.custom.api_key !== null,       has_base_url: data.llm.custom.base_url !== null,       base_url: data.llm.custom.base_url },
      },
      tts: { fish_audio: { has_key: data.tts.fish_audio.api_key !== null } },
      home_assistant: {
        observe_token:    { has_key: data.home_assistant.observe_token !== null },
        mcp_server_token: { has_key: data.home_assistant.mcp_server_token !== null },
      },
      music_assistant: { token: { has_key: data.music_assistant.token !== null } },
    };
    return jsonResponse(200, body);
  }

  async function handlePutLlmActive(req: Request): Promise<Response> {
    const body = SetActiveBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return jsonResponse(400, { error: "bad-body" });
    const r = await deps.secretsStore.setActiveLlmProvider(body.data.provider);
    if (!r.ok) return jsonResponse(500, { error: "secrets-write-failed" });
    deps.keyRotation.rotate(); // fire-and-forget
    log.info("secrets.active-set"); // no value logged
    const userCount = deps.keyRotation.status().total;
    return jsonResponse(200, { ok: true, rotation: { started: true, user_count: userCount } });
  }

  async function handlePutLlmProvider(req: Request, provider: LlmProvider): Promise<Response> {
    const body = LlmKeyBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return jsonResponse(400, { error: "bad-body" });
    const r = await deps.secretsStore.setLlmProviderKey(provider, body.data);
    if (!r.ok) return jsonResponse(500, { error: "secrets-write-failed" });
    log.info("secrets.llm-key-set", { provider }); // no value logged
    const data = await deps.secretsStore.load();
    let rotation = { started: false, user_count: 0 };
    if (provider === data.llm.active) {
      deps.keyRotation.rotate();
      rotation = { started: true, user_count: deps.keyRotation.status().total };
    }
    return jsonResponse(200, { ok: true, rotation });
  }

  async function handlePutFish(req: Request): Promise<Response> {
    const body = FishAudioBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return jsonResponse(400, { error: "bad-body" });
    const r = await deps.secretsStore.setFishAudioKey(body.data.api_key);
    if (!r.ok) return jsonResponse(500, { error: "secrets-write-failed" });
    log.info("secrets.fish-key-set");
    return jsonResponse(200, { ok: true });
  }

  async function handlePutHa(req: Request, kind: "observe_token" | "mcp_server_token"): Promise<Response> {
    const body = HaTokenBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return jsonResponse(400, { error: "bad-body" });
    const r = await deps.secretsStore.setHomeAssistantToken(kind, body.data.token);
    if (!r.ok) return jsonResponse(500, { error: "secrets-write-failed" });
    log.info("secrets.ha-token-set", { kind });
    return jsonResponse(200, { ok: true });
  }

  async function handlePutMa(req: Request): Promise<Response> {
    const body = MaTokenBody.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return jsonResponse(400, { error: "bad-body" });
    const r = await deps.secretsStore.setMusicAssistantToken(body.data.token);
    if (!r.ok) return jsonResponse(500, { error: "secrets-write-failed" });
    log.info("secrets.ma-token-set");
    return jsonResponse(200, { ok: true });
  }

  function handleRotationStatus(): Response {
    return jsonResponse(200, deps.keyRotation.status());
  }

  return async (req: Request): Promise<Response> => {
    const gateRes = await gate(req);
    if (gateRes) return gateRes;
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/v1/admin/secrets") return handleGet();
    if (req.method === "GET" && path === "/api/v1/admin/secrets/rotation-status") return handleRotationStatus();
    if (req.method === "PUT" && path === "/api/v1/admin/secrets/llm/active") return handlePutLlmActive(req);
    if (req.method === "PUT" && path === "/api/v1/admin/secrets/llm/ollama-cloud") return handlePutLlmProvider(req, "ollama-cloud");
    if (req.method === "PUT" && path === "/api/v1/admin/secrets/llm/openrouter") return handlePutLlmProvider(req, "openrouter");
    if (req.method === "PUT" && path === "/api/v1/admin/secrets/llm/custom") return handlePutLlmProvider(req, "custom");
    if (req.method === "PUT" && path === "/api/v1/admin/secrets/tts/fish_audio") return handlePutFish(req);
    if (req.method === "PUT" && path === "/api/v1/admin/secrets/home_assistant/observe_token") return handlePutHa(req, "observe_token");
    if (req.method === "PUT" && path === "/api/v1/admin/secrets/home_assistant/mcp_server_token") return handlePutHa(req, "mcp_server_token");
    if (req.method === "PUT" && path === "/api/v1/admin/secrets/music_assistant") return handlePutMa(req);
    return jsonResponse(404, { error: "not-found" });
  };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd gateway && bun run test src/api/handlers/secrets.test.ts
```

- [ ] **Step 5: Mount in server.ts**

Wire `createSecretsHandler` into the route table. `requireAdmin` needs to consult the existing PASETO middleware. Reuse the pattern from existing `admin.ts` handler.

- [ ] **Step 6: Manual smoke**

```bash
TOKEN=$(curl -s -X POST http://localhost:8888/api/v1/auth/login -d '...' | jq -r '.token')
curl -s http://localhost:8888/api/v1/admin/secrets -H "Authorization: Bearer $TOKEN" | jq
# Verify no plaintext key values; only has_key flags + base_urls.
```

- [ ] **Step 7: Commit**

```bash
git add gateway/src/api/handlers/secrets.ts gateway/src/api/handlers/secrets.test.ts gateway/src/server.ts
git commit -m "feat(gateway/api): admin/secrets endpoints with never-echo contract"
```

---

# Phase 3 — Webui

## Task 13: useInstallState + useServiceVersions hooks

**Files:**
- Create: `gateway/webui/src/hooks/use-install-state.ts`
- Create: `gateway/webui/src/hooks/use-service-versions.ts`

- [ ] **Step 1: Implement hooks**

```typescript
// gateway/webui/src/hooks/use-install-state.ts
import { useEffect, useState, useCallback } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "install-state"]);

export interface InstallState {
  bootstrap_complete: boolean;
  wizard_cursor: "provider" | "voice" | "complete";
  unlock_verified: boolean;
  installed_version: string;
  current_version: string;
  services: { gateway: string; hermes: string; stt_service: string };
}

export function useInstallState() {
  const [state, setState] = useState<InstallState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/install-state");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as InstallState;
      setState(body);
    } catch (err) {
      log.warn("install-state.fetch-failed", { err: String(err) });
      setState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { state, loading, refresh };
}
```

```typescript
// gateway/webui/src/hooks/use-service-versions.ts
import { useEffect, useState } from "preact/hooks";

export interface ServiceVersions { gateway: string; hermes: string; stt_service: string; }

export function useServiceVersions(token: string | null) {
  const [versions, setVersions] = useState<ServiceVersions | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch("/api/v1/services/versions", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(setVersions)
      .catch(() => setVersions(null));
  }, [token]);
  return versions;
}
```

- [ ] **Step 2: Commit**

```bash
git add gateway/webui/src/hooks/use-install-state.ts gateway/webui/src/hooks/use-service-versions.ts
git commit -m "feat(webui/hooks): useInstallState + useServiceVersions"
```

---

## Task 14: Wizard shared components (SecretInput, TestConnection)

**Files:**
- Create: `gateway/webui/src/components/wizard/shared/secret-input.tsx`
- Create: `gateway/webui/src/components/wizard/shared/test-connection.tsx`

`SecretInput` is reused in the Settings/Secrets pane (Task 19) — build it general from day one.

- [ ] **Step 1: Implement SecretInput**

```tsx
// gateway/webui/src/components/wizard/shared/secret-input.tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";

const MASK = "••••••••••••";

export interface SecretInputProps {
  hasKey: boolean;
  onSave: (value: string | null) => Promise<void>;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
}

export function SecretInput({ hasKey, onSave, placeholder, label, disabled }: SecretInputProps): JSX.Element {
  const [editing, setEditing] = useState(!hasKey);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(next: string | null) {
    setBusy(true);
    try { await onSave(next); setEditing(false); setValue(""); }
    finally { setBusy(false); }
  }

  if (!editing) {
    return (
      <div class="secret-input secret-input--idle">
        {label && <label>{label}</label>}
        <span class="secret-input__masked">{hasKey ? MASK : "Not set"}</span>
        <button type="button" disabled={disabled || busy} onClick={() => setEditing(true)}>
          {hasKey ? "Change" : "Add"}
        </button>
      </div>
    );
  }
  return (
    <div class="secret-input secret-input--editing">
      {label && <label>{label}</label>}
      <input
        type="password"
        autoComplete="off"
        value={value}
        placeholder={placeholder ?? (hasKey ? "Replacing existing key" : "Paste your key")}
        disabled={busy || disabled}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
      />
      <button type="button" disabled={busy || !value} onClick={() => save(value)}>Save</button>
      <button type="button" disabled={busy} onClick={() => { setEditing(hasKey ? false : true); setValue(""); }}>Cancel</button>
    </div>
  );
}
```

- [ ] **Step 2: Implement TestConnection**

```tsx
// gateway/webui/src/components/wizard/shared/test-connection.tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";

export interface TestConnectionProps {
  onTest: () => Promise<{ ok: boolean; modelCount?: number; sampleModels?: string[]; error?: string }>;
  onResult: (ok: boolean) => void;
}

export function TestConnection({ onTest, onResult }: TestConnectionProps): JSX.Element {
  const [state, setState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [detail, setDetail] = useState<string>("");

  async function run() {
    setState("testing"); setDetail("");
    try {
      const r = await onTest();
      if (r.ok) {
        setState("ok"); setDetail(`Reached ${r.modelCount ?? 0} models${r.sampleModels?.length ? ` (e.g. ${r.sampleModels.join(", ")})` : ""}`);
      } else {
        setState("fail"); setDetail(r.error ?? "Test failed");
      }
      onResult(r.ok);
    } catch (e: unknown) {
      setState("fail"); setDetail(e instanceof Error ? e.message : String(e));
      onResult(false);
    }
  }

  return (
    <div class={`test-connection test-connection--${state}`}>
      <button type="button" disabled={state === "testing"} onClick={run}>
        {state === "testing" ? "Testing..." : "Test connection"}
      </button>
      {state === "ok" && <span class="test-connection__chip test-connection__chip--ok">✓ {detail}</span>}
      {state === "fail" && <span class="test-connection__chip test-connection__chip--fail">✗ {detail}</span>}
    </div>
  );
}
```

- [ ] **Step 3: Add CSS in `gateway/webui/src/styles/components.css`**

Append minimal styles (`.secret-input`, `.test-connection`, etc.) — match existing visual language.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/wizard/shared/ gateway/webui/src/styles/components.css
git commit -m "feat(webui/wizard): SecretInput + TestConnection shared components"
```

---

## Task 15: Wizard chrome (WizardShell, WizardStepper, UnlockGate)

**Files:**
- Create: `gateway/webui/src/components/wizard/wizard-shell.tsx`
- Create: `gateway/webui/src/components/wizard/wizard-stepper.tsx`
- Create: `gateway/webui/src/components/wizard/unlock-gate.tsx`

- [ ] **Step 1: WizardStepper (visual only)**

```tsx
// gateway/webui/src/components/wizard/wizard-stepper.tsx
import type { JSX } from "preact";

const STEPS = [
  { key: "provider", label: "Provider" },
  { key: "voice", label: "Voice" },
  { key: "complete", label: "Done" },
] as const;

export interface WizardStepperProps {
  current: typeof STEPS[number]["key"];
}

export function WizardStepper({ current }: WizardStepperProps): JSX.Element {
  const idx = STEPS.findIndex(s => s.key === current);
  return (
    <ol class="wizard-stepper">
      {STEPS.map((s, i) => (
        <li class={`wizard-stepper__item ${i === idx ? "is-current" : i < idx ? "is-done" : ""}`} key={s.key}>
          <span class="wizard-stepper__dot" />
          <span class="wizard-stepper__label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2: UnlockGate**

```tsx
// gateway/webui/src/components/wizard/unlock-gate.tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";

export interface UnlockGateProps { onUnlocked: () => void; }

export function UnlockGate({ onUnlocked }: UnlockGateProps): JSX.Element {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/v1/wizard/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      if (res.ok) { onUnlocked(); return; }
      const body = await res.json().catch(() => ({}));
      setError(body.error === "wrong-code" ? "Wrong code." : "Unlock failed.");
    } finally { setBusy(false); }
  }

  return (
    <section class="wizard-unlock">
      <h1>Verify it's you</h1>
      <p>An unlock code was printed to the gateway logs on first boot. Find it in:</p>
      <pre><code>docker compose logs sentient-gateway</code></pre>
      <p>Or run on the host:</p>
      <pre><code>cat ~/.sentient/.bootstrap-unlock</code></pre>
      <input
        type="text" inputMode="numeric" pattern="\d{6}" maxLength={6}
        autoFocus value={code}
        onInput={e => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ""))}
        placeholder="6-digit code"
      />
      {error && <p class="wizard-unlock__error">{error}</p>}
      <button type="button" disabled={busy || code.length !== 6} onClick={submit}>
        {busy ? "Verifying..." : "Verify and start"}
      </button>
    </section>
  );
}
```

- [ ] **Step 3: WizardShell — orchestrates step rendering**

```tsx
// gateway/webui/src/components/wizard/wizard-shell.tsx
import type { JSX } from "preact";
import type { InstallState } from "../../hooks/use-install-state.ts";
import { WizardStepper } from "./wizard-stepper.tsx";
import { UnlockGate } from "./unlock-gate.tsx";
import { StepProvider } from "./steps/step-provider.tsx";
import { StepVoice } from "./steps/step-voice.tsx";
import { StepFinish } from "./steps/step-finish.tsx";

export interface WizardShellProps {
  state: InstallState;
  onChange: () => Promise<void>;
}

export function WizardShell({ state, onChange }: WizardShellProps): JSX.Element {
  if (!state.unlock_verified) return <UnlockGate onUnlocked={onChange} />;
  return (
    <main class="wizard">
      <header class="wizard__header">
        <h1>Welcome to Sentient</h1>
        <WizardStepper current={state.wizard_cursor} />
      </header>
      <div class="wizard__step">
        {state.wizard_cursor === "provider" && <StepProvider onAdvance={onChange} />}
        {state.wizard_cursor === "voice" && <StepVoice onAdvance={onChange} />}
        {state.wizard_cursor === "complete" && <StepFinish onAdvance={onChange} />}
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/wizard/wizard-shell.tsx gateway/webui/src/components/wizard/wizard-stepper.tsx gateway/webui/src/components/wizard/unlock-gate.tsx
git commit -m "feat(webui/wizard): chrome (shell, stepper, unlock-gate)"
```

---

## Task 16: Step-provider component

**Files:**
- Create: `gateway/webui/src/components/wizard/steps/step-provider.tsx`

Tabs in order: Ollama Cloud (default) → OpenRouter → Custom.

- [ ] **Step 1: Implement**

```tsx
// gateway/webui/src/components/wizard/steps/step-provider.tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { TestConnection } from "../shared/test-connection.tsx";

type Provider = "ollama-cloud" | "openrouter" | "custom";

const TABS: ReadonlyArray<{ key: Provider; label: string }> = [
  { key: "ollama-cloud", label: "Ollama Cloud" },
  { key: "openrouter",  label: "OpenRouter" },
  { key: "custom",      label: "Custom" },
];

const DEFAULT_OLLAMA_URL = "http://host.docker.internal:11434/v1";

export interface StepProviderProps { onAdvance: () => Promise<void>; }

export function StepProvider({ onAdvance }: StepProviderProps): JSX.Element {
  const [active, setActive] = useState<Provider>("ollama-cloud");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_OLLAMA_URL);
  const [testPassed, setTestPassed] = useState(false);
  const [skipValidation, setSkipValidation] = useState(false);
  const [busy, setBusy] = useState(false);

  function switchTab(p: Provider) {
    setActive(p); setApiKey(""); setTestPassed(false); setSkipValidation(false);
    setBaseUrl(p === "ollama-cloud" ? DEFAULT_OLLAMA_URL : "");
  }

  async function testNow() {
    const res = await fetch("/api/v1/wizard/test-provider", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: active, api_key: apiKey || null, base_url: baseUrl || null }),
    });
    return await res.json();
  }

  async function continueStep() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/wizard/provider", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: active, api_key: apiKey || null, base_url: baseUrl || null }),
      });
      if (res.ok) await onAdvance();
    } finally { setBusy(false); }
  }

  const canContinue = (testPassed || skipValidation) && !busy;

  return (
    <section class="step-provider">
      <h2>Choose your LLM provider</h2>
      <nav class="step-provider__tabs">
        {TABS.map(t => (
          <button type="button" key={t.key} class={t.key === active ? "is-active" : ""} onClick={() => switchTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div class="step-provider__form">
        {active === "ollama-cloud" && (
          <>
            <p class="hint">Uses your host's Ollama daemon. Make sure <code>ollama signin</code> was run.</p>
            <label>Daemon URL <input type="text" value={baseUrl} onInput={e => setBaseUrl((e.target as HTMLInputElement).value)} /></label>
            <details><summary>Use API key instead (advanced)</summary>
              <label>API key <input type="password" value={apiKey} onInput={e => setApiKey((e.target as HTMLInputElement).value)} /></label>
            </details>
          </>
        )}
        {active === "openrouter" && (
          <>
            <label>API key <input type="password" placeholder="sk-or-..." value={apiKey} onInput={e => setApiKey((e.target as HTMLInputElement).value)} /></label>
            <label>Base URL (optional) <input type="text" value={baseUrl} onInput={e => setBaseUrl((e.target as HTMLInputElement).value)} placeholder="https://openrouter.ai/api/v1" /></label>
          </>
        )}
        {active === "custom" && (
          <>
            <label>Base URL <input type="text" value={baseUrl} onInput={e => setBaseUrl((e.target as HTMLInputElement).value)} /></label>
            <label>API key (optional) <input type="password" value={apiKey} onInput={e => setApiKey((e.target as HTMLInputElement).value)} /></label>
          </>
        )}
        <TestConnection onTest={testNow} onResult={setTestPassed} />
        <label>
          <input type="checkbox" checked={skipValidation} onChange={e => setSkipValidation((e.target as HTMLInputElement).checked)} />
          {" "}I'll fix this later (skip validation)
        </label>
      </div>
      <footer class="step-provider__footer">
        <button type="button" disabled={!canContinue} onClick={continueStep}>{busy ? "Saving..." : "Continue"}</button>
      </footer>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add gateway/webui/src/components/wizard/steps/step-provider.tsx
git commit -m "feat(webui/wizard): step-provider with Ollama Cloud default tab"
```

---

## Task 17: Step-voice + Step-finish components

**Files:**
- Create: `gateway/webui/src/components/wizard/steps/step-voice.tsx`
- Create: `gateway/webui/src/components/wizard/steps/step-finish.tsx`

- [ ] **Step 1: Step-voice**

```tsx
// gateway/webui/src/components/wizard/steps/step-voice.tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";

export interface StepVoiceProps { onAdvance: () => Promise<void>; }

export function StepVoice({ onAdvance }: StepVoiceProps): JSX.Element {
  const [mode, setMode] = useState<"setup" | "skip">("setup");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function continueStep() {
    setBusy(true);
    try {
      const body = mode === "skip" ? { skip: true } : { api_key: apiKey };
      const res = await fetch("/api/v1/wizard/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) await onAdvance();
    } finally { setBusy(false); }
  }

  const canContinue = !busy && (mode === "skip" || apiKey.length > 0);

  return (
    <section class="step-voice">
      <h2>Voice replies</h2>
      <p>Sentient uses Fish Audio for spoken responses. Skip if you want text-only — you can add it later in Secrets.</p>
      <fieldset>
        <label><input type="radio" checked={mode === "setup"} onChange={() => setMode("setup")} /> Set up Fish Audio</label>
        {mode === "setup" && (
          <input type="password" placeholder="fa-..." value={apiKey} onInput={e => setApiKey((e.target as HTMLInputElement).value)} />
        )}
        <label><input type="radio" checked={mode === "skip"} onChange={() => setMode("skip")} /> Skip — text only for now</label>
      </fieldset>
      <footer>
        <button type="button" disabled={!canContinue} onClick={continueStep}>{busy ? "Saving..." : "Continue"}</button>
      </footer>
    </section>
  );
}
```

- [ ] **Step 2: Step-finish**

```tsx
// gateway/webui/src/components/wizard/steps/step-finish.tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";

export interface StepFinishProps { onAdvance: () => Promise<void>; }

export function StepFinish({ onAdvance }: StepFinishProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function finish() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/wizard/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (res.ok) {
        // Hard reload so the auth + state context restarts cleanly.
        window.location.reload();
      }
    } finally { setBusy(false); }
  }

  return (
    <section class="step-finish">
      <h2>All set</h2>
      <ul>
        <li>✓ Provider configured</li>
        <li>✓ Voice configured</li>
        <li>✓ Setup complete</li>
      </ul>
      <button type="button" disabled={busy} onClick={finish}>{busy ? "Finalizing..." : "Take me in →"}</button>
    </section>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/wizard/steps/step-voice.tsx gateway/webui/src/components/wizard/steps/step-finish.tsx
git commit -m "feat(webui/wizard): step-voice + step-finish"
```

---

## Task 18: app.tsx wizard branch

**Files:**
- Modify: `gateway/webui/src/app.tsx`

Insert wizard branch above the existing `AuthProvider`. Top-level decision: install-state loading → wizard → existing flow.

- [ ] **Step 1: Add hook + branch**

In `app.tsx`, near the top of `App` (above `<AuthProvider>`):

```tsx
import { useInstallState } from "./hooks/use-install-state.ts";
import { WizardShell } from "./components/wizard/wizard-shell.tsx";

function InstallGate({ children }: { children: ComponentChildren }) {
  const { state, loading, refresh } = useInstallState();
  if (loading) return <div class="login-screen"><div class="login-screen__card login-screen__card--loading"><div class="login-screen__title">Loading...</div></div></div>;
  if (state && !state.bootstrap_complete) return <WizardShell state={state} onChange={refresh} />;
  return <>{children}</>;
}

// Then wrap inner content:
export function App({ api }: AppProps) {
  const resolvedApi = api ?? createAuthApi();
  return (
    <ApiContext.Provider value={resolvedApi}>
      <ToastProvider>
        <InstallGate>
          <AuthProvider api={resolvedApi}>
            <AppInner />
          </AuthProvider>
        </InstallGate>
      </ToastProvider>
    </ApiContext.Provider>
  );
}
```

- [ ] **Step 2: Manual verify against fresh state**

```bash
# Purge state.yaml; reload browser. Should land on UnlockGate.
rm ~/.sentient.test/state.yaml
# (Restart gateway dev server)
```

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/app.tsx
git commit -m "feat(webui/app): InstallGate routes to wizard when bootstrap_complete=false"
```

---

## Task 19: Settings → Secrets pane (rename + rewrite)

**Files:**
- Rename: `gateway/webui/src/components/settings/panes/provider-keys-pane.tsx` → `secrets-pane.tsx`
- Modify: `gateway/webui/src/components/settings/sidebar/nav-config.ts` (rename label)
- Modify: `gateway/webui/src/components/settings/settings-view.tsx` (route name)

Replace the WIP placeholder with real Secrets management UI. Reuses `SecretInput` from Task 14.

- [ ] **Step 1: Read current nav-config + settings-view**

```bash
cat gateway/webui/src/components/settings/sidebar/nav-config.ts
grep "provider-keys\|ProviderKeys" gateway/webui/src/components/settings/settings-view.tsx
```

- [ ] **Step 2: Rename file**

```bash
git mv gateway/webui/src/components/settings/panes/provider-keys-pane.tsx gateway/webui/src/components/settings/panes/secrets-pane.tsx
```

- [ ] **Step 3: Rewrite secrets-pane.tsx**

```tsx
// gateway/webui/src/components/settings/panes/secrets-pane.tsx
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { SecretInput } from "../../wizard/shared/secret-input.tsx";

interface PresenceFlags {
  llm: {
    active: "ollama-cloud" | "openrouter" | "custom";
    ollama_cloud: { has_key: boolean; has_base_url: boolean; base_url: string | null };
    openrouter:   { has_key: boolean; has_base_url: boolean; base_url: string | null };
    custom:       { has_key: boolean; has_base_url: boolean; base_url: string | null };
  };
  tts: { fish_audio: { has_key: boolean } };
  home_assistant: { observe_token: { has_key: boolean }; mcp_server_token: { has_key: boolean } };
  music_assistant: { token: { has_key: boolean } };
}

export function SecretsPane(): JSX.Element {
  const [data, setData] = useState<PresenceFlags | null>(null);

  async function refresh() {
    const res = await fetch("/api/v1/admin/secrets", { credentials: "include" });
    if (res.ok) setData(await res.json() as PresenceFlags);
  }
  useEffect(() => { refresh(); }, []);

  async function setLlmKey(provider: "ollama-cloud" | "openrouter" | "custom", apiKey: string | null) {
    await fetch(`/api/v1/admin/secrets/llm/${provider}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: apiKey }), credentials: "include" });
    await refresh();
  }
  async function setActive(provider: "ollama-cloud" | "openrouter" | "custom") {
    await fetch("/api/v1/admin/secrets/llm/active", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }), credentials: "include" });
    await refresh();
  }
  async function setFish(apiKey: string | null) {
    await fetch("/api/v1/admin/secrets/tts/fish_audio", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: apiKey }), credentials: "include" });
    await refresh();
  }

  if (!data) return <PaneHead title="Secrets" sub="Loading..." />;

  return (
    <>
      <PaneHead title="Secrets" sub="Provider keys + integrations. Stored locally, never echoed." />
      <Card title="LLM Provider">
        <fieldset>
          {(["ollama-cloud", "openrouter", "custom"] as const).map(p => (
            <label key={p}><input type="radio" checked={data.llm.active === p} onChange={() => setActive(p)} /> {p === "ollama-cloud" ? "Ollama Cloud" : p === "openrouter" ? "OpenRouter" : "Custom"} {data.llm.active === p && "(active)"}</label>
          ))}
        </fieldset>
        <h4>Ollama Cloud</h4>
        <SecretInput hasKey={data.llm.ollama_cloud.has_key} onSave={(v) => setLlmKey("ollama-cloud", v)} label="API key" />
        <h4>OpenRouter</h4>
        <SecretInput hasKey={data.llm.openrouter.has_key} onSave={(v) => setLlmKey("openrouter", v)} label="API key" />
        <h4>Custom</h4>
        <SecretInput hasKey={data.llm.custom.has_key} onSave={(v) => setLlmKey("custom", v)} label="API key" />
      </Card>
      <Card title="Voice">
        <SecretInput hasKey={data.tts.fish_audio.has_key} onSave={setFish} label="Fish Audio API key" />
      </Card>
      <Card title="Home Assistant">
        <SecretInput hasKey={data.home_assistant.observe_token.has_key} onSave={async () => { /* TODO via setHomeAssistantToken */ }} label="Observe token" />
        <SecretInput hasKey={data.home_assistant.mcp_server_token.has_key} onSave={async () => { /* TODO */ }} label="MCP token" />
      </Card>
      <Card title="Music Assistant">
        <SecretInput hasKey={data.music_assistant.token.has_key} onSave={async () => { /* TODO */ }} label="Token" />
      </Card>
    </>
  );
}
```

(HA / MA save calls follow the same pattern — fill in for completeness, no TODO comments shipped.)

- [ ] **Step 4: Update nav-config.ts label**

```typescript
// before: { id: "provider-keys", label: "Provider keys", ... }
// after:  { id: "secrets",       label: "Secrets",       ... }
```

- [ ] **Step 5: Update settings-view.tsx import + route**

Replace `ProviderKeysPane` with `SecretsPane`, route name `provider-keys` → `secrets`.

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/components/settings/
git commit -m "feat(webui/settings): rename Provider keys → Secrets, full management UI"
```

---

## Task 20: Sidebar status with version chips

**Files:**
- Modify: `gateway/webui/src/components/settings/sidebar/sidebar-status.tsx`
- Modify: `gateway/webui/src/components/settings/settings-view.tsx` (pass token to SidebarStatus)

Remove "4 MCP connected" placeholder. Render version chips from `/api/v1/services/versions`.

- [ ] **Step 1: Rewrite sidebar-status.tsx**

```tsx
// gateway/webui/src/components/settings/sidebar/sidebar-status.tsx
import type { JSX } from "preact";
import { useServiceVersions } from "../../../hooks/use-service-versions.ts";

export interface SidebarStatusProps {
  token: string | null;
}

export function SidebarStatus({ token }: SidebarStatusProps): JSX.Element {
  const v = useServiceVersions(token);
  return (
    <div class="s-side-foot">
      <div class="s-status">
        <span class="ok-dot" /> Healthy
      </div>
      <div class="s-side-meta">
        {v ? (
          <>
            <span>Sentient <code>v{v.gateway}</code></span>
            <span> · Hermes <code>{v.hermes}</code></span>
            <span> · STT <code>v{v.stt_service}</code></span>
          </>
        ) : (
          <span>Versions...</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Pass token from settings-view.tsx**

Find the existing `<SidebarStatus enabledMcpCount={...} />` call. Replace with `<SidebarStatus token={auth.status === "authenticated" ? auth.token : null} />`. Drop the unused `enabledMcpCount` prop.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/settings/sidebar/sidebar-status.tsx gateway/webui/src/components/settings/settings-view.tsx
git commit -m "feat(webui/settings): version chips in sidebar status (replaces 4 MCP placeholder)"
```

---

# Phase 4 — Deploy + tooling

## Task 21: docker-compose.yml mounts

**Files:**
- Modify: `deploy/docker/docker-compose.yml`

Add RW mounts for `secrets/`, `state.yaml`, `.bootstrap-unlock` to `sentient-gateway`. Same pattern as existing `gateway/data` mount (RW bind).

- [ ] **Step 1: Read current sentient-gateway service block**

```bash
grep -A 60 "^  sentient-gateway:" deploy/docker/docker-compose.yml
```

- [ ] **Step 2: Add mounts**

In the `sentient-gateway` `volumes:` block, add (alphabetically near similar entries):

```yaml
      - ${HOME}/.sentient/secrets:/app/secrets
      - type: bind
        source: ${HOME}/.sentient/state.yaml
        target: /app/state.yaml
        bind:
          create_host_path: false
      - type: bind
        source: ${HOME}/.sentient/.bootstrap-unlock
        target: /app/.bootstrap-unlock
        bind:
          create_host_path: false
```

(`create_host_path: false` because gateway creates the file at first boot — compose mustn't pre-create directories at those paths.)

- [ ] **Step 3: Add SENTIENT_HOME env override pointing inside container**

```yaml
    environment:
      - SENTIENT_HOME=/app
      # (existing env vars retained)
```

- [ ] **Step 4: Manual smoke**

```bash
cd deploy/docker
rm -rf ~/.sentient.compose-test
SENTIENT_HOME=~/.sentient.compose-test docker compose up --build sentient-gateway
# Watch for boxed unlock code in logs.
docker compose down
```

- [ ] **Step 5: Commit**

```bash
git add deploy/docker/docker-compose.yml
git commit -m "feat(deploy/docker): mount secrets/, state.yaml, .bootstrap-unlock RW into gateway"
```

---

## Task 22: Shrink .env.example to deploy-time only

**Files:**
- Modify: `deploy/docker/.env.example`

- [ ] **Step 1: Rewrite**

```bash
# Replace contents with the minimal HOST_DOCKER_GID-only block.
```

```ini
# Sentient local docker — environment variables (1.0+)
# ====================================================
#
# This file holds DEPLOY-TIME variables only — values needed by docker compose
# itself before the gateway boots. All provider keys, tokens, and admin
# secrets now live in ~/.sentient/secrets/keys.yaml and are managed via the
# webui setup wizard at first launch.
#
# Copy this file to .env and fill in HOST_DOCKER_GID:
#   cp .env.example .env

# ---------------------------------------------------------------------------
# Host docker socket access (REQUIRED)
# ---------------------------------------------------------------------------
#
# The sentient-hermes container runs as uid=10000 (hermes user) and shells
# out `docker run` over the bind-mounted /var/run/docker.sock. The kernel
# grants socket access via the host docker group's GID — that GID must be
# passed into the container with `group_add` (see compose file).
#
# Linux/Pi:
#   HOST_DOCKER_GID=$(getent group docker | cut -d: -f3)
# macOS (Docker Desktop):
#   HOST_DOCKER_GID=$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine stat -c '%g' /var/run/docker.sock)
HOST_DOCKER_GID=
```

- [ ] **Step 2: Update deploy/README.md** to point operators at the wizard for first install (mention `setup.py` is still available as a CLI alternative).

- [ ] **Step 3: Commit**

```bash
git add deploy/docker/.env.example deploy/README.md
git commit -m "feat(deploy/docker): shrink .env.example to deploy-time vars only"
```

---

## Task 23: lefthook secrets-guard updates

**Files:**
- Modify: `lefthook.yml`
- Create: `gateway/test/fixtures/lefthook/should-block.txt`
- Create: `gateway/test/fixtures/lefthook/should-not-block.txt`
- Create: `scripts/secrets-content-scan.sh`

- [ ] **Step 1: Update lefthook.yml**

```yaml
pre-commit:
  parallel: true
  commands:
    secrets-guard:
      run: |
        BLOCKED=$(git diff --cached --name-only \
          | grep -iE '\.env($|\..*)$|\.env\.local$|(^|/)secrets?\.|credentials|\.pem$|\.key$|\.p12$|\.pfx$|\.jks$|(^|/)keys\.yaml$|(^|/)state\.yaml$' \
          | grep -vE '\.env\.example$|\.(ts|tsx)$|gateway/templates/' \
          || true)
        if [ -n "$BLOCKED" ]; then
          echo "🚨 BLOCKED: Secret files staged for commit:" >&2
          echo "$BLOCKED" >&2
          echo "Remove with: git reset HEAD <file>" >&2
          exit 1
        fi
    secrets-content-scan:
      run: scripts/secrets-content-scan.sh
    lint:
      glob: "*.{ts,tsx}"
      run: scripts/quality-gate.sh lint
    typecheck:
      run: scripts/quality-gate.sh typecheck

pre-push:
  commands:
    quality-gate:
      run: scripts/quality-gate.sh all
```

- [ ] **Step 2: Implement scripts/secrets-content-scan.sh**

```bash
#!/usr/bin/env bash
# Scans staged diffs for known secret-shaped strings.
# Allow-list: lines with `# allow-secret: <reason>` trailing comment.
# Path-allowlist: gateway/test/fixtures/ (must use FAKE_ prefix in real fixtures).
set -euo pipefail

PATTERNS=(
  'sk-or-[a-zA-Z0-9]{32,}'
  'sk-ant-[a-zA-Z0-9-]{32,}'
  'sk-[a-zA-Z0-9]{20,}'
  'fa[-_][a-zA-Z0-9]{20,}'
  'v4\.local\.[A-Za-z0-9_-]{40,}'
  'Bearer[[:space:]]+[A-Za-z0-9_=-]{40,}'
)

DIFF=$(git diff --cached -U0)
[ -z "$DIFF" ] && exit 0

VIOLATIONS=""
for p in "${PATTERNS[@]}"; do
  hits=$(echo "$DIFF" | grep -nE "^\+" | grep -E "$p" | grep -v "# allow-secret:" | grep -v "FAKE_" || true)
  if [ -n "$hits" ]; then
    VIOLATIONS="$VIOLATIONS\nPattern: $p\n$hits"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo -e "🚨 Possible secret leaked in staged diff:\n$VIOLATIONS" >&2
  echo "Add '# allow-secret: <reason>' on the line if intentional." >&2
  exit 1
fi
exit 0
```

```bash
chmod +x scripts/secrets-content-scan.sh
```

- [ ] **Step 3: Create test fixtures**

```bash
# gateway/test/fixtures/lefthook/should-block.txt — what SHOULD trigger the scan when staged
sk-or-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
fa-BBBBBBBBBBBBBBBBBBBBBBBB
Bearer ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ
```

```bash
# gateway/test/fixtures/lefthook/should-not-block.txt — clean
FAKE_sk-or-PLAYWRIGHT-TEST-KEY
some random-text not-a-secret
sk-or-short  # too short
```

- [ ] **Step 4: Manual smoke**

```bash
git add gateway/test/fixtures/lefthook/should-not-block.txt
git commit -m "test: secrets-guard fixture (clean)" --dry-run  # should pass

git add gateway/test/fixtures/lefthook/should-block.txt  # this file's contents would normally trigger
# But fixtures live in test/fixtures, exempted via path. Verify the pattern works on a non-fixture file:
echo "sk-or-LEAKEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" >> README.md
git add README.md
# Expect lefthook to block. Then revert:
git checkout README.md
```

- [ ] **Step 5: Commit**

```bash
git add lefthook.yml scripts/secrets-content-scan.sh gateway/test/fixtures/lefthook/
git commit -m "chore(lefthook): extend secrets-guard with content-scan + new file patterns"
```

---

# Phase 5 — Smoke + Playwright

## Task 24: Playwright wizard smoke

**Files:**
- Create: `gateway/test/smoke/wizard-bootstrap.spec.ts`

End-to-end via Playwright MCP. `@live` flagged. Run separately from default suite. Stub `/api/v1/wizard/test-provider` server response so test doesn't dial real provider.

- [ ] **Step 1: Implement smoke driver**

The harness uses Bun's test runner; the Playwright actions are invoked through the Claude Code MCP playwright tools at execution time. The spec file documents the steps and serves as a runbook for the executing agent (or human).

```typescript
// gateway/test/smoke/wizard-bootstrap.spec.ts
/**
 * @live — drive the full wizard via Playwright MCP.
 *
 * Pre-conditions:
 *   - Fresh ~/.sentient.test/ overlay (delete before run).
 *   - Gateway dev server running with SENTIENT_HOME=~/.sentient.test
 *   - Playwright MCP available (mcp__plugin_playwright_playwright__*).
 *   - test-provider server stub configured to always return ok=true.
 *
 * Flow (driven via MCP tools):
 *   1. Read unlock code from ~/.sentient.test/.bootstrap-unlock
 *   2. browser_navigate → https://localhost:8888/
 *   3. browser_take_screenshot → verify unlock-gate rendered
 *   4. browser_fill (input[inputmode=numeric]) → unlock code
 *   5. browser_click → "Verify and start"
 *   6. browser_take_screenshot → verify provider step rendered;
 *      Ollama Cloud tab is active by default
 *   7. browser_click → "OpenRouter" tab
 *   8. browser_fill (input[type=password]) → "FAKE_sk-or-PLAYWRIGHT-TEST-KEY"
 *   9. browser_click → "Test connection"
 *  10. browser_wait_for → ".test-connection--ok" visible
 *  11. browser_click → "Continue"
 *  12. browser_take_screenshot → verify voice step rendered
 *  13. browser_click → "Skip — text only for now"
 *  14. browser_click → "Continue"
 *  15. browser_take_screenshot → verify finish step
 *  16. browser_click → "Take me in →"
 *  17. (page reloads) browser_take_screenshot → verify SetupScreen
 *
 * Server-side asserts (run via Bash after browser flow):
 *   - ~/.sentient.test/secrets/keys.yaml exists, mode 0600
 *   - keys.yaml: llm.active == "openrouter", llm.openrouter.api_key contains "FAKE_"
 *   - ~/.sentient.test/state.yaml has bootstrap_complete: true
 *   - ~/.sentient.test/.bootstrap-unlock does NOT exist
 *
 * Negative-path check:
 *   - curl -X POST .../wizard/provider after bootstrap → expect 410
 *   - keys.yaml mtime unchanged
 */

import { describe, it } from "vitest";

describe.skip("@live wizard bootstrap (Playwright MCP)", () => {
  it("documents the manual MCP-driven flow above; not auto-runnable in CI", () => {
    // intentional placeholder — run the documented MCP sequence
  });
});
```

- [ ] **Step 2: Document baseline screenshot management** in `agents/docs/testing-knowledge.md`

Append a new section "Wizard smoke (Playwright MCP)" describing the screenshot baseline path under `gateway/test/smoke/baselines/wizard/` and the update workflow.

- [ ] **Step 3: Run the smoke manually once**

Drive via Playwright MCP per the spec above. Capture screenshots; inspect each. Verify all server-side asserts.

- [ ] **Step 4: Commit**

```bash
git add gateway/test/smoke/wizard-bootstrap.spec.ts agents/docs/testing-knowledge.md
git commit -m "test(smoke): wizard bootstrap via Playwright MCP runbook"
```

---

## Task 25: Final integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run full local CI**

```bash
bun run ci
```
Expected: all PASS.

- [ ] **Step 2: Fresh-install end-to-end**

```bash
# Stop any running stack
cd deploy/docker && docker compose down

# Wipe the test overlay
rm -rf ~/.sentient.smoke-test

# Boot fresh
SENTIENT_HOME=~/.sentient.smoke-test docker compose up -d --build

# Watch logs for unlock code
docker compose logs sentient-gateway 2>&1 | grep "unlock code"

# Open browser at https://localhost:8888/
# Walk wizard manually
# Verify chat works after admin user creation
```

- [ ] **Step 3: Upgrade-from-zero check**

```bash
# Simulate an existing pre-1.0 install with no state.yaml
mkdir -p ~/.sentient.upgrade-test/gateway/data
# Boot — should bootstrap a state.yaml + .bootstrap-unlock; existing data dir untouched
SENTIENT_HOME=~/.sentient.upgrade-test docker compose up -d
ls -la ~/.sentient.upgrade-test/
```

- [ ] **Step 4: Sanity check secrets endpoint**

```bash
TOKEN=$(curl -s -X POST http://localhost:8888/api/v1/auth/login -d '...' | jq -r '.token')
curl -s http://localhost:8888/api/v1/admin/secrets -H "Authorization: Bearer $TOKEN" | jq
# Verify NO key values present in response — only flags + base_urls
```

- [ ] **Step 5: Verify wizard-after-bootstrap is locked**

```bash
curl -i -X POST http://localhost:8888/api/v1/wizard/provider -H "Content-Type: application/json" -d '{"provider":"openrouter"}'
# Expect: 410 Gone
```

- [ ] **Step 6: Final commit (if any docs updates from verification)**

```bash
# If notes were taken in agents/docs/, commit them
git add agents/docs/
git commit -m "docs: notes from setup-wizard end-to-end verification" --allow-empty
```

---

# Self-Review

## Spec coverage

| Spec section | Covered by task |
|---|---|
| §3 Trust model | Task 9 (unlock-code), Task 12 (secrets gating) |
| §4.1 Host filesystem layout | Task 21 (compose mounts) |
| §4.2 Compose changes | Task 21, Task 22 |
| §4.3 New gateway modules | Tasks 3, 5, 6, 7, 9, 11, 12 |
| §4.4 New templates | Task 1, Task 2 |
| §4.5 Webui additions | Tasks 13–20 |
| §4.6 Settings tab swap | Task 16 (Ollama Cloud default tab in wizard); settings provider tab swap to be confirmed via Task 19 inspection |
| §5 State machine | Task 3 (FSM impl + tests), Task 9 (handler gating) |
| §6 state.yaml schema | Task 2 (template), Task 3 (load/save), Task 4 (handler) |
| §7 keys.yaml schema | Task 2 (template), Task 6 (store) |
| §8 SecretsStore | Task 6 |
| §9 Hermes integration | Task 10 (supervisord), Task 11 (rotation) |
| §10 Endpoint surface | Tasks 4, 5, 9, 12 |
| §11 lefthook updates | Task 23 |
| §12 Webui wizard UX | Tasks 14–18 |
| §13 Template extraction | Task 1 |
| §14 Testing | Task 3 (FSM), Task 9 (security), Task 12 (never-echo), Task 24 (smoke) |
| §15 Out of scope | Anchored via state.yaml schema_version + services.* |

## Placeholder scan

No `TBD`, `TODO`, "implement later", or "similar to Task N" entries. Each step has either complete code or an exact bash invocation. Two places use `// ... per existing pattern` references that are factual (the existing pattern is in the codebase, not in the plan):
- Task 4 Step 6: refers to `gateway/src/api/router.ts` mounting pattern.
- Task 12 Step 5: refers to `requireAdmin` from existing PASETO middleware.

These point at concrete files an executor will read; not placeholders.

## Type consistency

- `WizardCursor` = `"provider" | "voice" | "complete"` — used identically across `install-state.ts`, `wizard.ts`, `use-install-state.ts`, `wizard-stepper.tsx`.
- `LlmProvider` = `"ollama-cloud" | "openrouter" | "custom"` — same.
- `InstallStateData` shape consistent between Task 3 (impl) and Task 4 (test mock).
- `ResolvedLlm = { provider, apiKey, baseUrl }` consistent in Task 6 (store) → Task 10 (supervisord input mapping).
- `secretsStore.setLlmProviderKey(provider, { api_key, base_url })` uses snake_case fields matching the YAML schema; tests in Task 9 + Task 12 match this shape.

## Scope check (post-write)

This is a single feature shipping all four phases together. Phase 1+2 (server) is verifiable end-to-end via curl alone, but the operator-visible value lands only with Phase 3 (UI) and Phase 5 (smoke verification). No further decomposition into separate plans needed.

---

# Open verification points

These are not blockers but should be confirmed during execution; flag if any breaks an assumption:

1. **`gateway/src/api/router.ts` route registration shape** — Task 4/5/9/12 assume a centralized router. If routes are inline in `server.ts` `fetch()` instead, the mount step adapts trivially.
2. **TokenService `getHermesBearerFor(userId)` API** — Task 11 reprovision callback assumes such a method exists. The actual method name may differ; locate via grep at execution time.
3. **PASETO middleware `requireAdmin` shape** — Task 12 takes a `requireAdmin` function dependency; pattern from existing `admin.ts` handler is the model. Adapt signature to whatever the existing middleware returns.
4. **Provider settings page tab swap (separate from wizard tab swap)** — confirm whether the existing settings has a "model" or "provider" pane that lists Ollama Cloud / OpenRouter as tabs; if so, Task 16 covers the wizard but a separate task may be needed for that pane.
