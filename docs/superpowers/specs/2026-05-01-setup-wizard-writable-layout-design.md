# Setup Wizard + Writable Host Layout — Design

**Date:** 2026-05-01
**Branch target:** `feature/setup-wizard-writable-layout`
**Release target:** 1.0
**Status:** approved (this revision)

## 1. Goal

Make the operator's first-install path "`docker compose up` → browser → done." No CLI editing of `.env`, no `python3 deploy/setup.py`, no manually placing files under `~/.sentient/`. The webui gains a one-shot setup wizard at first launch that captures provider keys and creates the admin user, then hands off to the existing app.

A version-hint is anchored in `~/.sentient/state.yaml` from day one so 1.1+ migration tooling has somewhere to look.

Out of scope: full migration runner, backup/restore, config.yaml editor, hermes worker safe-upgrade — each gets its own spec. This spec only ships the foundations (volume layout, version-hint, writable secrets store) and the wizard.

## 2. Non-goals

- Not removing `deploy/setup.py` in this PR. It coexists during a transition window.
- Not enabling write to `~/.sentient/gateway/config/config.yaml` from the webui. Phase 2.
- Not designing the migration runner. Anchoring the version-hint only.
- Not addressing hermes-overlay worker upgrade orchestration. Out of scope.
- Not changing the `~/.sentient/auth/tokens/`, `~/.sentient/certs/`, or per-user profile data layout — those continue to be gateway-owned and writable as today.

## 3. Trust model

The webui is **trusted** in the sense that it is served by the gateway, talks to the gateway over TLS, and reaches the gateway only over a private LAN bound to the operator's machine. We do not raise the bar against host compromise: anyone with shell access already has every secret on the box. What we do raise the bar against:

- **Drive-by setup hijack on a network during the bootstrap window.** Anyone reaching the gateway URL before the operator does can run setup. Mitigated by a one-time unlock code printed to stdout and `~/.sentient/.bootstrap-unlock`.
- **Webui logic bugs that re-trigger setup after bootstrap.** Mitigated by hard backend gating (`bootstrap_complete=true` → wizard endpoints return 410). Server never trusts client state.
- **Accidental secret echo.** Mitigated by an absolute "GET never returns secrets, PUT response body never echoes value" contract on the secrets API. Webui renders only static masked dots.
- **Accidental commit of secrets.** Mitigated by extending lefthook's pre-commit `secrets-guard` with new filename + content-scan patterns.

## 4. Architecture overview

### 4.1 New host filesystem layout

```
~/.sentient/
├── state.yaml              ← install-state, version-hint, wizard cursor (NEW)
├── .bootstrap-unlock       ← one-time 6-digit code, mode 0600 (NEW, deleted on bootstrap_complete)
├── secrets/                ← mode 0700 (NEW)
│   ├── keys.yaml           ← all provider keys + admin_token, mode 0600 (NEW)
│   └── .gitignore          ← belt-and-braces local exclusion
├── gateway/                ← unchanged surface
│   ├── config/             ← still :ro to gateway in this phase
│   ├── data/               ← per-user profile data, hermes-owned (RW today)
│   └── logs/
├── stt-service/            ← unchanged
├── run/sentient/           ← MCP UDS, supervisord socket+programs (RW today)
├── certs/                  ← TLS, auto-bootstrapped (RW today)
└── auth/                   ← gateway-minted bearers + manifests (RW today)
```

### 4.2 Compose changes

- Mount `~/.sentient/secrets/` at `/app/secrets/` (RW) into `sentient-gateway`.
- Mount `~/.sentient/state.yaml` (RW) into `sentient-gateway` (file mount, not dir, so inode swaps via temp+rename work).
- Mount `~/.sentient/.bootstrap-unlock` (RW) into `sentient-gateway` (file mount).
- `.env` shrinks to deploy-time only: `HOST_DOCKER_GID` is the only entry. Provider keys, `ADMIN_TOKEN`, `HA_*`, `MA_TOKEN`, `FISH_AUDIO_API_KEY`, `OPENROUTER_API_KEY` all move to `keys.yaml`. Compose interpolation is no longer needed for them.
- `.env.example` is rewritten to reflect this and points at the wizard for keys.

### 4.3 New gateway modules

```
gateway/src/admin/
├── install-state.ts        ← read/write state.yaml; version comparison
├── secrets-store.ts        ← read/write keys.yaml; enforces 0600; mtime watch
├── key-rotation.ts         ← per-user re-render + restartProfile loop on key change
├── unlock-code.ts          ← generate, verify, persist one-time code
gateway/src/api/handlers/
├── install-state.ts        ← GET /api/v1/install-state
├── wizard.ts               ← POST /api/v1/wizard/{unlock,provider,voice,finish}
├── secrets.ts              ← GET/PUT/DELETE /api/v1/admin/secrets/*
```

### 4.4 New templates

```
gateway/templates/wizard/
├── state.yaml.tmpl
├── keys.yaml.tmpl
└── bootstrap-unlock.txt.tmpl
```

Plus extracted-from-source: `gateway/templates/persona/default.md` (replaces `DEFAULT_PERSONA` literal duplicated across `system-prompt-loader.ts:8` and `cerebrum-factory.ts:11`).

### 4.5 Webui additions

```
gateway/webui/src/
├── components/wizard/
│   ├── wizard-shell.tsx        ← chrome (progress dots, brand)
│   ├── wizard-stepper.tsx
│   ├── unlock-gate.tsx
│   └── steps/
│       ├── step-welcome.tsx    ← client-only
│       ├── step-provider.tsx   ← Ollama Cloud (default) / OpenRouter / Custom tabs
│       ├── step-voice.tsx      ← Fish Audio + skip
│       └── step-finish.tsx
├── components/wizard/shared/
│   ├── secret-input.tsx        ← masked input pattern (REUSED in Settings/Secrets)
│   └── test-connection.tsx
├── hooks/use-install-state.ts
├── hooks/use-service-versions.ts
├── components/settings/secrets-tab.tsx  ← renamed from existing provider-keys tab
└── components/settings/status-footer.tsx ← removes "4 MCP connected" placeholder, renders version chips
```

`app.tsx` gains a top-level branch above the existing auth provider:
```tsx
if (loading) return <BootSpinner />;
if (state && !state.bootstrap_complete) return <WizardShell ... />;
return <AuthProvider>...</AuthProvider>;
```

### 4.6 Settings page tab swap

Wherever LLM provider tabs render today (settings persona/provider area), reorder so `ollama-cloud` is the leading/default tab. Same swap in the wizard's step-provider.

## 5. State machine

### 5.1 Install-state lifecycle

```
Container boot → InstallStateService.load()
  ├─ file missing                       → write template (bootstrap_complete=false), return
  ├─ file exists, schema_version older  → migration screen (1.1+ concern; logs warning today)
  ├─ file exists, installed_version
     less than current_version          → migration screen (1.1+ concern; logs warning today)
  └─ file exists, OK                    → return loaded state
```

In 1.0 the "migration screen" is a stub: log warning, proceed normally. The screen ships in 1.1.

### 5.2 Wizard cursor transitions

```
bootstrap_complete=false:
   provider → voice → complete → POST /finish flips bootstrap_complete=true

bootstrap_complete=true:
   AnonymousGate (existing):
     hasAnyUser==false → SetupScreen (existing first-user flow) ← create-admin
     hasAnyUser==true  → LoginScreen
```

The wizard does **not** include a create-admin step. It only configures install-level concerns (keys). Admin user creation is the existing `SetupScreen`, which already kicks in whenever `hasAnyUser==false`. This cleanly separates install-level state from user-level state and lets future migrations reuse the wizard chrome without re-creating the admin form.

### 5.3 Welcome screen

Pure client-side render. No server cursor for it. `wizard_cursor` initial value is `"provider"`.

### 5.4 Recovery semantics

- All state.yaml writes use temp-file + `rename(2)`. `fchmod` before rename so the file never exists with broader permissions mid-flight.
- Wizard endpoints check `wizard_cursor` matches the expected step. Mismatch → 409 with current cursor; webui re-fetches install-state and re-renders the correct step.
- Crash mid-step (e.g., between key save and cursor advance): on next boot, key is saved but cursor hasn't moved. Webui shows the same step. Re-submitting overwrites the key; both writes are idempotent.
- `state.yaml` deleted manually → gateway boots into wizard mode again. Existing users in DB persist; if `hasAnyUser==true` after bootstrap, `SetupScreen` is skipped and `LoginScreen` runs as normal.

## 6. state.yaml schema

```yaml
schema_version: "1.0.0"          # of state.yaml itself
installed_version: "1.0.0"       # sentient release that bootstrapped this install;
                                 # source of truth: gateway/package.json "version" field
last_upgraded_from: null         # set on each upgrade migration run
last_upgraded_at: null           # ISO-8601, UTC

bootstrap_complete: false
wizard_cursor: "provider"        # provider | voice | complete
unlock_verified: false           # flipped true after POST /wizard/unlock succeeds;
                                 # required precondition for /wizard/{provider,voice,finish,test-provider}

services:
  gateway: "1.0.0"
  hermes: "v2026.4.23"           # mirrors deploy/hermes-overlay/HERMES_VERSION
  stt_service: "1.0.0"

# Reserved for 1.1+ (declared here so the shape is stable):
# migrations_applied: []
# backup_history: []
```

`installed_version` and `services.*` are the **load-bearing migration anchors**. By the time 1.1 ships, every 1.0 install will have these populated, so the migration runner has known-good metadata to compare against. Without this anchor, 1.1 would be flying blind on existing 1.0 installs.

`installed_version` value is read from `gateway/package.json` `version` field at runtime (single source of truth, no separate VERSION file).

## 7. keys.yaml schema

```yaml
schema_version: "1.0.0"

llm:
  active: "ollama-cloud"          # ollama-cloud | openrouter | custom

  ollama_cloud:
    api_key: null                 # null = use signed-in host daemon
    base_url: "http://host.docker.internal:11434/v1"

  openrouter:
    api_key: null                 # "sk-or-..." when set
    base_url: null                # null = https://openrouter.ai/api/v1

  custom:
    api_key: null
    base_url: null                # required when active=custom

tts:
  fish_audio:
    api_key: null                 # null = TTS disabled, voice button hides

home_assistant:
  observe_token: null
  mcp_server_token: null

music_assistant:
  token: null

admin_token: "<auto-generated 32-byte random hex on gateway first boot, before serving any request>"
```

### 7.1 Permissions

- `~/.sentient/secrets/` — mode 0700.
- `~/.sentient/secrets/keys.yaml` — mode 0600.
- Gateway enforces mode on every write via `fchmod(2)` after `open(O_CREAT)`.
- Reads check `lstat`. If mode is broader than 0600 and the process is not root, log a warning and refuse to read. Loud failure is the goal.

### 7.2 What keys.yaml is not

- Not the per-user gateway↔hermes bearer (`~/.sentient/auth/tokens/`, gateway-minted).
- Not TLS material (`~/.sentient/certs/`, auto-bootstrapped).
- Not user PINs (DB, argon2id hashed).

`keys.yaml` is exclusively the operator's external-provider credentials store.

## 8. SecretsStore

```ts
interface SecretsStore {
  get(): Promise<KeysYaml>;            // memoized; reloads on file mtime change
  setProviderKey(provider: "ollama-cloud" | "openrouter" | "custom", patch: ProviderPatch): Promise<Result<void, SecretsError>>;
  setTtsKey(provider: "fish_audio", apiKey: string | null): Promise<Result<void, SecretsError>>;
  setActiveProvider(provider: "ollama-cloud" | "openrouter" | "custom"): Promise<Result<void, SecretsError>>;
  setIntegrationToken(domain: "home_assistant" | "music_assistant", kind: string, token: string | null): Promise<Result<void, SecretsError>>;
}
```

- No general `set()` — explicit setters per domain so callers can't dump arbitrary YAML.
- Atomic write: temp file + rename(2). `fchmod` before rename.
- `fs.watch` on `keys.yaml` triggers in-process cache reload, debounced 250ms.
- Read failures during reload do not invalidate cached value — last-known-good wins until the next successful read.

## 9. Hermes worker integration (path B)

`UpsertInput` in `gateway/src/admin/supervisord-control.ts` already takes `openrouterKey` + `ollamaKey`. Generalize to provider-agnostic `llmApiKey` + `llmBaseUrl`. Rendered template substitutes them:

```ini
[program:hermes-{{userId}}]
command=hermes -p {{userId}} gateway run
environment=
  HERMES_HOME="{{hermesHome}}",
  SENTIENT_GATEWAY_TOKEN="{{token}}",
  SENTIENT_GATEWAY_PORT="{{port}}",
  TZ="{{timezone}}",
  OPENROUTER_API_KEY="{{llmApiKey}}",
  OPENROUTER_BASE_URL="{{llmBaseUrl}}"
```

Hermes upstream reads `OPENROUTER_API_KEY` regardless of which OpenAI-compatible endpoint we point at; the variable name is sticky for backward-compat, the value is whatever the user picked.

User-provisioner flow (existing, slightly extended):
1. Allocate port from `UserPortStore`.
2. Mint per-user gateway↔hermes bearer.
3. **Read `secretsStore.get()`** → resolve active provider's `api_key` + `base_url`.
4. Call `supervisordControl.upsertProgram({ ..., llmApiKey, llmBaseUrl })`.
5. supervisorctl `reread` + `update` → worker spawns with embedded env.

### 9.1 Key rotation orchestrator

`KeyRotationOrchestrator.rotate(provider)`:
1. Snapshot list of active users.
2. For each user, sequentially:
   - Re-render program with new key.
   - `supervisorctl restart hermes-<userId>`.
   - Wait for worker to reach RUNNING (status poll, max 10s).
   - On failure: stop, return partial-failure result; webui shows "X of N users updated, Y failed — retry?"
3. Tracked in memory only; if rotation crashes mid-loop, on next admin "rotate" call it picks up surviving running workers and finishes.

Sequential not parallel: each restart kills any in-flight cycle for that user; burst of simultaneous restarts amplifies disruption. Sequential gives webui a progress indicator.

### 9.2 Logging redaction

Extend the existing log sanitizer with a new field-name pattern: any key in `keys.yaml` that contains `_token`, `_key`, `api_key`, or `secret` is redacted in any log line where the value passes through. Plus the value patterns listed in §11 (sk-or-*, sk-ant-*, fa-*, etc.).

## 10. Admin endpoint surface

### 10.1 Wizard endpoints (only callable when `bootstrap_complete=false`)

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/v1/install-state` | — | `{ bootstrap_complete, wizard_cursor, unlock_verified, installed_version, current_version, services }` |
| `GET` | `/api/v1/services/versions` | — | `{ gateway, hermes, stt_service }` — versions only; see §10.5 |
| `POST` | `/api/v1/wizard/unlock` | `{ code }` | `{ ok }` (sets `unlock_verified=true`; cursor unchanged) or 401 (≥800ms sleep on wrong code) |
| `POST` | `/api/v1/wizard/provider` | `{ provider, api_key?, base_url? }` | `{ ok, next_cursor: "voice" }` |
| `POST` | `/api/v1/wizard/voice` | `{ skip: true }` OR `{ api_key }` | `{ ok, next_cursor: "complete" }` |
| `POST` | `/api/v1/wizard/finish` | `{}` | `{ ok }` (bootstrap_complete flips true; `.bootstrap-unlock` deleted) |
| `POST` | `/api/v1/wizard/test-provider` | `{ provider, api_key?, base_url? }` | `{ ok, model_count, sample_models[] }` or `{ ok: false, error }` (non-mutating; cursor unchanged) |

### 10.2 Wizard backend gating contract

```ts
function assertWizardOpen(state, expectedCursor, requireUnlock = true): Result<void, ApiError> {
  if (state.bootstrap_complete) return err(410, "wizard-closed");
  if (requireUnlock && !state.unlock_verified) return err(401, "unlock-required");
  if (state.wizard_cursor !== expectedCursor) return err(409, "wizard-cursor-mismatch");
  return ok();
}
```

First call in every wizard handler. No bypass flag, no override. Re-running setup requires manual ops intervention (delete `state.yaml`, restart container) — explicit and physical.

Wizard endpoints require **no auth bearer** before bootstrap is complete (admin token doesn't exist yet). The unlock code is the sole gate during the bootstrap window:

- `POST /wizard/unlock` skips the `unlock_verified` check (it sets the flag).
- All other `/wizard/*` endpoints (including `/test-provider`) require `unlock_verified=true`.
- After `bootstrap_complete=true` the endpoints all return 410 (functionally cease to exist).

### 10.3 Secrets endpoints (only callable when `bootstrap_complete=true`, admin-token + `is_admin=true` gated)

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/v1/admin/secrets` | — | presence flags + non-secret values (URLs); see §10.4 |
| `PUT` | `/api/v1/admin/secrets/llm/active` | `{ provider }` | `{ ok, rotation: { started: bool, user_count: number } }` |
| `PUT` | `/api/v1/admin/secrets/llm/<provider>` | `{ api_key?, base_url? }` (omit field = unchanged; explicit `null` = clear) | `{ ok, rotation: { started: bool, user_count: number } }` |
| `PUT` | `/api/v1/admin/secrets/tts/fish_audio` | `{ api_key }` (or `null` to clear) | `{ ok }` (next TTS init picks up; in-flight unaffected) |
| `PUT` | `/api/v1/admin/secrets/home_assistant/<token_kind>` | `{ token }` | `{ ok }` |
| `PUT` | `/api/v1/admin/secrets/music_assistant` | `{ token }` | `{ ok }` |
| `GET` | `/api/v1/admin/secrets/rotation-status` | — | `{ active: bool, current_user?, completed: number, total: number, failures: [...] }` |
| `DELETE` | `/api/v1/admin/secrets/<path>` | — | `{ ok }` (clears) |

**Key-rotation semantics:**
- LLM provider key change triggers per-user worker restart (§9.1). PUT response returns immediately with `rotation.started=true` and `user_count=N`. Rotation runs in background; webui polls `/rotation-status` to drive a progress UI.
- Only the `active` provider's key change triggers rotation. Editing OpenRouter key while `active=ollama-cloud` writes the key but does NOT restart workers (the new key is only consulted if/when `active` flips to OpenRouter, at which point `setActiveProvider` triggers its own rotation).
- TTS key change does NOT restart workers — TTS init re-reads the secrets store on next pipeline construction (per-cycle cost is negligible). In-flight cycles use the prior key.

```ts
function assertAdminAndBootstrapped(state, user): Result<void, ApiError> {
  if (!state.bootstrap_complete) return err(412, "bootstrap-incomplete");
  if (!user.is_admin) return err(403, "not-admin");
  return ok();
}
```

First call in every secrets handler.

### 10.4 Never-echo-secrets contract

GET `/api/v1/admin/secrets` returns:

```json
{
  "llm": {
    "active": "ollama-cloud",
    "ollama_cloud": { "has_key": false, "has_base_url": true,  "base_url": "http://host.docker.internal:11434/v1" },
    "openrouter":   { "has_key": true,  "has_base_url": false, "base_url": null },
    "custom":       { "has_key": false, "has_base_url": false, "base_url": null }
  },
  "tts": {
    "fish_audio": { "has_key": true }
  },
  "home_assistant": {
    "observe_token":    { "has_key": false },
    "mcp_server_token": { "has_key": false }
  },
  "music_assistant": {
    "token": { "has_key": false }
  }
}
```

Rules:
- GET returns presence flags + non-secret values (`base_url` only). Never the key itself.
- PUT response body is `{ ok: true }`. Never reflects the value back. Client re-GETs to verify (and still gets presence-only).
- 4xx error bodies do NOT include the submitted value.
- Server logs never include the request body for these endpoints; only `path + outcome`.

### 10.5 `/api/v1/services/versions` — minimal version-info endpoint

Separate from `/install-state` by design. The settings page footer renders service versions for operator visibility (replacing the existing "4 MCP connected" placeholder text in the bottom-left status row). It does NOT need wizard cursor, bootstrap flag, last-upgraded timestamps, or any of the install-state metadata. Exposing only what's needed shrinks the attack surface for any flaw that lets an unauthenticated caller hit this path.

**Response:**
```json
{
  "gateway": "1.0.0",
  "hermes": "v2026.4.23",
  "stt_service": "1.0.0"
}
```

Versions only. No bootstrap state, no upgrade history, no schema version, no service status (no health flags — health goes through other endpoints).

**Auth:** same as the rest of authenticated webui surface — PASETO session cookie, any logged-in user (not admin-only). Versions are not secret in any meaningful sense (any UI element from any user can already infer them by behavior), but unauthenticated exposure is gratuitous. Reject pre-bootstrap calls with 412 (the wizard chrome doesn't render the status footer).

**Source:** read from `state.yaml#services` via the existing `InstallStateService.load()`. Single read per request; no caching needed.

**Webui change:** `gateway/webui/src/components/settings/status-footer.tsx` (new or updated, wherever the existing footer lives):
- Remove "4 MCP connected" placeholder string.
- Replace with a row of pill-style version chips, e.g. `Sentient v1.0.0 · Hermes v2026.4.23 · STT v1.0.0`.
- Hook: `useServiceVersions()` calls `GET /api/v1/services/versions`, caches in app context (versions are static for a session — only refresh on page reload).
- Existing "Healthy" indicator stays; only the placeholder text changes.

## 11. lefthook secrets-guard updates

Current `lefthook.yml` blocks files matching `\.env($|\..*)$|\.env\.local$|(^|/)secrets?\.|credentials|\.pem$|\.key$|\.p12$|\.pfx$|\.jks$` (except `.env.example` and `.ts/.tsx`).

### 11.1 Filename pattern extension

Block any `keys\.yaml$` or `state\.yaml$` outside `gateway/templates/`:

```
\.env($|\..*)$|\.env\.local$|(^|/)secrets?\.|credentials|\.pem$|\.key$|\.p12$|\.pfx$|\.jks$|(^|/)keys\.yaml$|(^|/)state\.yaml$
```

Allow-list still: `\.env\.example$|\.(ts|tsx)$|gateway/templates/`.

### 11.2 Content scan on staged diffs

New `secrets-content-scan` lefthook command. Greps `git diff --cached -U0` for known prefixes:

| Pattern | Source |
|---|---|
| `sk-or-[a-zA-Z0-9]{32,}` | OpenRouter |
| `sk-[a-zA-Z0-9]{20,}` | OpenAI |
| `sk-ant-[a-zA-Z0-9-]{32,}` | Anthropic |
| `fa[-_][a-zA-Z0-9]{20,}` | Fish Audio (verify exact prefix at impl time) |
| `v4\.local\.[A-Za-z0-9_-]{40,}` | PASETO v4.local |
| `Bearer\s+[A-Za-z0-9_=-]{40,}` | Generic high-entropy bearer (non-test files) |

Block on match with rule name + line. False-positive escape: `# allow-secret: <reason>` trailing comment on the line.

### 11.3 Test fixtures

`gateway/test/fixtures/` may contain shaped-but-fake secrets. Add path exception, but require fixtures use the literal prefix `FAKE_` (e.g., `FAKE_sk-or-...`) so even leaked fixtures grep-block downstream.

### 11.4 CI mirror

Add `.github/workflows/secrets-scan.yml` (if/when CI exists) running the same script. Pre-commit catches local; CI catches force-push and direct pushes from misconfigured clones.

## 12. Webui wizard UX details

### 12.1 Unlock gate

```
┌──────────────────────────────────────────────────┐
│  Verify it's you                                 │
│                                                  │
│  An unlock code was printed to the gateway logs  │
│  on first boot. Find it in:                      │
│    docker compose logs sentient-gateway          │
│                                                  │
│  Or run on the host:                             │
│    cat ~/.sentient/.bootstrap-unlock             │
│                                                  │
│  Code: [ _ _ _  _ _ _ ]                          │
│                                                  │
│                              [Verify and start]  │
└──────────────────────────────────────────────────┘
```

- 6-digit code generated on first gateway boot, written to stdout AND `~/.sentient/.bootstrap-unlock` (mode 0600).
- Verified once via `POST /api/v1/wizard/unlock { code }`. On success, server stores unlock-verified flag in state.yaml; wizard endpoints accept calls without the code afterwards (only valid until `bootstrap_complete=true`).
- Wrong code: 401, sleep ≥800ms before responding (rate-limit brute-force).

### 12.2 Step-provider

Tab order:
```
[ Ollama Cloud ]  ( OpenRouter )  ( Custom )
```

- **Ollama Cloud (default)**: help text, "Daemon URL" (default `http://host.docker.internal:11434/v1`), optional "API key" (revealed via "Use API key instead" link), `[Test connection]`, `[Continue]`.
- **OpenRouter**: API key required, base URL optional (default empty = use upstream).
- **Custom**: base URL required, API key optional.

`[Test connection]` calls `POST /api/v1/wizard/test-provider` server-side (server makes the actual probe, not the browser, so we don't expose the key in the browser network tab).

`[Continue]` enabled when test passes OR "I'll fix this later" override checkbox is ticked.

### 12.3 Step-voice

```
┌──────────────────────────────────────────────────┐
│  Voice replies                                   │
│  Sentient uses Fish Audio for spoken responses.  │
│  Skip this if you only want text chat — you can  │
│  add it later in Secrets.                        │
│                                                  │
│  ○ Set up Fish Audio                             │
│    [API key __________________] [Test]           │
│                                                  │
│  ○ Skip — text only for now                      │
│                                                  │
│                            [Back]    [Continue]  │
└──────────────────────────────────────────────────┘
```

### 12.4 Step-finish

```
✔ Provider configured
✔ Voice configured (or "Skipped — voice disabled")
✔ Setup complete

[ Take me in → ]   ← clicking POSTs /finish, then reloads page
```

After reload: `bootstrap_complete=true` → `AnonymousGate` → `hasAnyUser==false` → `SetupScreen` → admin user is created → home.

The first user created via `SetupScreen` MUST have `is_admin=true`. This is the existing behavior of the user-provisioner first-user path (the only user is by definition the admin); this spec relies on that and adds no new logic. Subsequent users default to `is_admin=false` and require an existing admin to elevate them.

### 12.5 SecretInput (shared component)

States:
1. `hasKey=true`, idle: `••••••••••••` + `[Change]`
2. editing: empty input + `[Save]` `[Cancel]`; on Save → PUT
3. `hasKey=false`, idle: "Not set" + `[Add]`
4. saving: spinner; disabled
5. saved: brief checkmark, fade back to dots

**Crucial UX detail**: on `[Change]`, the input is empty (not pre-filled with dots). Reason: dots are not a valid edit state, and pre-filling invites confused "delete the last 4 chars" attempts. Empty input + label "Replacing existing key" makes the all-or-nothing nature explicit.

### 12.6 Settings → Secrets tab (renamed from "Provider keys")

```
┌─ Secrets ────────────────────────────────────────┐
│  LLM Provider                                    │
│    ◉ Ollama Cloud (active)                       │
│    ○ OpenRouter                                  │
│    ○ Custom                                      │
│                                                  │
│    Ollama Cloud                                  │
│      API key      ••••••••••••     [Change]      │
│      Daemon URL   http://host.docker...  [Edit]  │
│                                                  │
│    OpenRouter                                    │
│      API key      Not set            [Add]       │
│                                                  │
│  Voice                                           │
│    Fish Audio                                    │
│      API key      ••••••••••••     [Change]      │
│                                                  │
│  Home Assistant                                  │
│    Observe token  Not set            [Add]       │
│    MCP token      Not set            [Add]       │
│                                                  │
│  Music Assistant                                 │
│    Token          Not set            [Add]       │
└──────────────────────────────────────────────────┘
```

## 13. Template extraction

Per the project's clean-code rule (large prompt/template content lives in `.md`/template files, not inline TS strings):

| Current location | Symbol | New template path |
|---|---|---|
| `gateway/src/context/system-prompt-loader.ts:8` | `DEFAULT_PERSONA = "You are Sentient..."` | `gateway/templates/persona/default.md` |
| `gateway/src/bootstrap/cerebrum-factory.ts:11` | `DEFAULT_PERSONA` (DUP) | delete; import from same loader |

Plus the new templates introduced by this PR (§4.4).

Audit script `scripts/find-inline-templates.sh` greps `gateway/src/**/*.ts` for template literals containing ≥3 newlines that look like yaml/conf/markdown. False-positive escape via `// template-ok` comment. Anything else found gets extracted in this PR or filed for follow-up.

## 14. Testing approach

Per `.claude/rules/testing.md`: tests pin contracts, FSMs, security boundaries, smoke. No per-file unit tests for plumbing.

### 14.1 Wire contract tests

`gateway/src/api/handlers/install-state.test.ts`:
- GET returns shape `{ bootstrap_complete, wizard_cursor, installed_version, current_version, services }`. Field presence + types.

### 14.2 FSM tests

`gateway/src/admin/install-state.test.ts`:
- State.yaml round-trip: load missing file → returns initial state. Load existing → exact preserved.
- Cursor advance: `provider → voice → complete → bootstrap_complete=true`. Each flip is atomic (temp+rename verified by mock fs).
- Reverse direction blocked: writing `provider` when cursor is `voice` → error.
- Crash recovery: write started, no rename → next load returns previous state (because temp file is ignored).

### 14.3 Security boundary tests

`gateway/src/api/handlers/wizard.test.ts`:
- `POST /wizard/provider` when `bootstrap_complete=true` → 410. **No side effect on disk.**
- `POST /wizard/voice` when `wizard_cursor==provider` → 409. **No side effect.**
- `POST /wizard/unlock` with wrong code → 401, sleep ≥800ms before responding.
- `POST /wizard/unlock` after successful unlock → 410 (one-shot).

`gateway/src/api/handlers/secrets.test.ts`:
- `PUT /admin/secrets/llm/openrouter { api_key: "sk-or-XYZ" }` → response body does not contain `XYZ`.
- `GET /admin/secrets` → response body for OpenRouter section does not contain any character that would match `sk-or-`.
- Log capture during `PUT` → captured log lines do not contain `XYZ`.

### 14.4 Smoke — wizard happy path via Playwright MCP (`@live`)

`gateway/test/smoke/wizard-bootstrap.spec.ts` (`@live` flagged):

- Spin up gateway against fresh `~/.sentient.test/` overlay (env override of `SENTIENT_HOME`).
- Read unlock code from `~/.sentient.test/.bootstrap-unlock`.
- Drive wizard via `mcp__plugin_playwright_playwright__browser_*`:
  - `navigate` → wizard URL
  - **screenshot** → verify unlock-gate rendered with code input
  - `fill` unlock code → `click` Verify
  - **screenshot** → verify provider step rendered, Ollama Cloud tab active by default
  - Switch to OpenRouter tab → `fill` API key `FAKE_sk-or-PLAYWRIGHT-TEST-KEY` → `click` Test (mocked endpoint returns success) → `click` Continue
  - **screenshot** → verify voice step rendered
  - `click` Skip → `click` Continue
  - **screenshot** → verify finish step rendered with checkmarks
  - `click` Take me in
  - **screenshot** → verify SetupScreen (existing first-user flow) now showing
- Server-side asserts:
  - `~/.sentient.test/secrets/keys.yaml` exists, mode 0600, contains the FAKE key under `llm.openrouter.api_key`, `llm.active=="openrouter"`.
  - `~/.sentient.test/state.yaml` has `bootstrap_complete: true`, `wizard_cursor: "complete"`, `installed_version` matches package.json.
- Negative-path check (separate spec):
  - After bootstrap_complete=true, hit `POST /api/v1/wizard/provider` directly → expect 410. `keys.yaml` mtime unchanged.
- Visual regression: each screenshot saved with stable name; baseline-update flow documented in `agents/docs/testing-knowledge.md`.

Marked `@live`; runs separately from `bun run test:unit`.

### 14.5 Tests deliberately NOT written

- SecretInput component rendering states (UI plumbing; visual smoke covers it).
- KeyRotationOrchestrator per-step (sequential loop logic; `restartProfile` already tested elsewhere).
- Secrets-store atomic write (filesystem primitive; covered by install-state's atomic-write test indirectly).
- Provider tab order in settings (CSS/markup, not behavior).
- Webui hooks (`useInstallState`); mocking the fetch is plumbing.

### 14.6 lefthook self-test

`gateway/test/fixtures/lefthook/should-block.txt` — each known-bad pattern with `# allow-secret: test-fixture` escape.
`gateway/test/fixtures/lefthook/should-not-block.txt` — clean diffs.
`bun run test:secrets-guard` pipes each through the script and asserts exit codes.

## 15. Out-of-scope (anchored, not designed)

These are explicitly deferred. The version-hint in `state.yaml` is the only seed laid here so 1.1+ can pick them up:

- **Migration runner** — 1.1. Reads `installed_version` vs `current_version`, runs ordered migration scripts (`gateway/migrations/<from>-to-<to>.ts`). Webui shows migration progress screen.
- **Backup / snapshot** — 1.1+. Pre-upgrade snapshot of `~/.sentient/` (excluding `logs/` + ephemeral state). Restore-on-failure flow.
- **Hermes worker safe upgrade** — 1.1+. Per-user rolling restart on `services.hermes` version mismatch. Profile schema migration adapter (hermes-internal).
- **Settings-page YAML editor** — Phase 2 of this initiative. `config.yaml` write API + UI editor with diff preview. Triggers existing apply pipeline.
- **`setup.py` deletion** — follow-up PR after the wizard ships and proves stable. Both coexist in the transition window.

## 16. Risks

| Risk | Mitigation |
|---|---|
| Bootstrap-window network exposure | Unlock code printed to logs + `~/.sentient/.bootstrap-unlock` (mode 0600); 401+sleep on wrong code |
| Two browser tabs both advance wizard simultaneously | Cursor mismatch returns 409; webui re-syncs |
| Operator deletes `state.yaml` to redo setup | Documented escape hatch; works as designed; pre-existing users persist |
| Operator commits real `keys.yaml` from a test deployment | lefthook secrets-guard filename + content scan catches it |
| Wizard finishes but Ollama daemon offline at first chat | First user hits LLM → friendly chat-UI error; same path post-bootstrap (existing behavior) |
| Hermes upstream changes `OPENROUTER_API_KEY` env var name | Pin (HERMES_VERSION) + integration tests catch on rebase |

## 17. Acceptance criteria

- Fresh host: `docker compose up` → browser at `https://<host>/` → unlock-gate → wizard → admin user creation → working chat.
- No CLI editing of `.env` or running `setup.py` required for first install.
- `~/.sentient/state.yaml` and `~/.sentient/secrets/keys.yaml` exist with correct schema and modes after bootstrap.
- Existing operators upgrading from a pre-1.0 install: see "migration screen" stub (logs warning today; full screen ships in 1.1). `setup.py` continues to work for them.
- Settings page Secrets tab: presence-only display, redacted dots, save without echo. Verified by security tests in §14.3.
- All wizard endpoints return 410 after `bootstrap_complete=true`. Verified by §14.3.
- Playwright smoke (§14.4) passes end-to-end against a fresh test overlay.
