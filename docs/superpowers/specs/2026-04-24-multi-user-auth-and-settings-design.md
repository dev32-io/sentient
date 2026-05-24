# Multi-User Auth + Gateway-Owned Settings Design

**Date:** 2026-04-24
**Status:** Draft for approval
**Replaces (partially):** elements of `2026-04-21-hermes-cerebrum-integration-design-v4.md` concerning multi-profile session binding and on-disk config ownership.
**Branch context:** `feature/hermes-cerebrum-integration`; pivots mid-implementation to hit a hard 2-week family-demo deadline.

## 1. Goals

Ship the following within 2 weeks so two trusted adults (primary user + wife) can each use Sentient on a shared LAN-only web UI without touching the terminal:

1. **Web login** — per-user account (PIN), per-user data isolation.
2. **Per-user settings UI** — persona, voice, model provider + model, advanced fields (system prompt extras, tool allow-lists, compression).
3. **Admin user management** — create, delete, reset PIN, promote/demote.
4. **Live model provider switching** — OpenRouter + Ollama Cloud from the UI, with graceful Hermes restart that preserves memory.
5. **Warm always-on Hermes instances** — remove cold-start from the voice loop.
6. **Gateway as single source of truth** — nobody edits `config.yaml` or `SOUL.md` by hand; the gateway renders them.

Non-goals for this cycle: kids-with-restrictions / role-based capabilities, multi-factor auth, passkey upgrade, internet exposure (LAN-only is assumed), per-user provider API keys, voice cloning upload.

## 2. Constraints

- LAN-only deployment. Threat model is "someone already on the home network"; no TLS requirement for the demo.
- Hermes sidecar is a near-black-box; we interact via documented surfaces only. Our codebase owns the gateway + the renderer, not Hermes internals.
- Existing `webui` design vocabulary is mandatory — warm earthy palette, Fraunces/DM Sans typography, `.settings-panel` card idiom, BEM naming, CSS custom properties. No new CSS framework.
- Hermes reads `config.yaml` + `SOUL.md` at container start. There is no documented hot-reload. On-the-fly changes require an orchestrated restart.
- Hermes **bakes the system prompt into each `/v1/responses` chain at chain creation** (verified 2026-04-24 PoC, see §12.1). Continuing a chain via `previous_response_id` reuses the original SOUL.md. The only way new persona/system-prompt config takes effect is to start a new chain.
- Memory extraction in Hermes runs **lazily** via the built-in idle-expiry watcher (≤1h after a chain becomes orphan). Hermes does **not** flush memory on SIGTERM. Verified against a live `nousresearch/hermes-agent:v2026.4.16` container.

## 3. Architecture Decision

**Gateway is the canonical owner of all per-user configuration.** Hermes reads only gateway-rendered artifacts. Webui talks only to the gateway API; never directly to files.

Rejected alternatives:
- **Hermes-native (thin)**: webui edits `config.yaml` directly. Rejected — couples UI to Hermes upstream schema drift and can't host gateway-only fields (PIN hash, voice_id, display name).
- **Hybrid**: gateway owns auth/UI fields, Hermes-native for model/tools. Rejected after discussion — user wants one authoritative store and renderer flexibility for future shared-template work.

### 3.1 Storage Layout

```
~/.sentient/gateway/
  users.json                       # {user_id, display_name, pin_hash, is_admin, created_at}[]
  secrets.json                     # system-wide API keys; chmod 0600, process-readable only
  shared/
    templates/
      default-system.md            # shared system-prompt fragment, referenced by profile.json
    catalogs/
      ollama-models.json           # hand-maintained catalog (Ollama API too thin for rich picker)
  _archive/
    <user_id>-<timestamp>/         # soft-deleted profiles; gateway never reads these back
  <user_id>/
    profile.json                   # canonical gateway-owned per-user config; schema_version: 1
    .generated/
      config.yaml                  # rendered from profile.json + secrets.json at container start
      SOUL.md                      # rendered from profile.json + shared templates
    MEMORY.md                      # Hermes-owned (never overwritten by renderer)
    conversations/                 # Hermes-owned (existing)
```

**Ownership zones:**
- Gateway-only writes: `users.json`, `secrets.json`, `shared/**`, `profile.json`, `.generated/**`.
- Hermes-only writes: `MEMORY.md`, `conversations/**`.
- No concurrent write paths exist.

**Atomic writes:** every gateway write goes to `<path>.tmp` → fsync → rename. No torn files on power loss.

**Schema versioning:** `profile.json.schema_version: 1`. Migrations run at gateway start. Hermes config-key renames become renderer-only changes; stored profiles and UI are unaffected.

### 3.2 Hermes Lifecycle

- Containers are **always-on**. Docker Compose starts all profile containers at boot. The existing `multi-user` compose profile gating is removed (or applied by default) so every user's Hermes starts with the gateway rather than waiting for first attach.
- Pre-warm ping on gateway startup: gateway sends a cheap request per container to prime MCP handshakes and prompt-cache prefix.
- Graceful shutdown: Docker Compose `stop_grace_period: 10s`. Hermes does not need a long grace window — it does not flush memory on SIGTERM (§3.3). The 10s window is purely for clean SQLite checkpoint of `response_store.db`.

### 3.3 Memory + Conversation-Continuity Model

Verified against the live container 2026-04-24 (see §12.1 for the PoC log). The design here matches Hermes's actual behavior, not a hoped-for behavior.

**What Hermes persists to disk (bind-mounted volume `profiles/<user>/`):**

- `response_store.db` — SQLite chain index. Survives `docker restart` cleanly.
- `memories/MEMORY.md`, `memories/USER.md` — long-term memory.
- `state.db`, `gateway_state.json` — runtime state.

**Apply behavior:**

1. User clicks Apply → gateway writes new config files (`SOUL.md`, profile `config.yaml`, etc.) to the bind-mounted volume.
2. Gateway clears `binding.conversationId` for that user's PersonSession(s). The next user turn will send no `previous_response_id` → Hermes starts a **fresh chain** that reads the new SOUL.md.
3. Gateway issues `docker restart hermes-<user>` (~7s to healthy). Restart is required because Hermes also reads MCP / model config at process boot.
4. Gateway polls `/health` until 200. UI unlocks.

The just-ended chain (the one before the apply) becomes an orphan in `response_store.db`. Hermes's built-in **idle-expiry watcher** catches it within ≤1h and runs `_flush_memories_for_session` on it, extracting salient bits into `MEMORY.md`. We do nothing — the flush is lazy and reliable.

**Why fresh chain on apply (not a UX preference, a correctness requirement):** Hermes bakes the system prompt into a chain at creation. Continuing a chain via `previous_response_id` reuses the **original** SOUL.md, regardless of on-disk changes. So apply MUST start a new chain — otherwise the user's persona/prompt edits would never take effect. Side benefit: the new persona avoids contamination from prior assistant turns written in the old persona's voice.

**Voice changes** are gateway-side (TTS pipeline), so they do not require any Hermes restart or chain break. **Model swaps** technically don't require chain break (chain still resolves, new model adapts), but apply uses the same chain-break path uniformly — the overhead is a single response_id clear, the upside is a clean slate for the new model.

Explicitly **not** implemented in this cycle:
- Synchronous memory flush via a Hermes plugin. Pure follow-up, completely additive (see §11).
- Periodic safety flush. The lazy idle-watcher path covers this.

## 4. Authentication

### 4.1 Credential Storage

- PIN: 4 digits. Stored as `argon2id` hash with per-user salt in `users.json`.
- Token: PASETO v4.local (library already in repo). Payload: `{user_id, issued_at, expires_at, is_admin}`. Lifetime 7 days, rolling-refreshed on successful auth-check.
- No rate-limit / lockout on failed PIN entry (family LAN trust model).

### 4.2 First-Run Setup

If `users.json` is empty or missing, gateway serves a single-use Setup screen at `/login`:

- Inputs: display name, PIN, confirm PIN.
- On submit: creates first admin entry, issues token, redirects to chat.
- Subsequent Setup requests return 409 unless `users.json` is again empty.

### 4.3 Login Flow

1. Client `GET /api/auth/users` → list of `{user_id, display_name, avatar_tint}`. No secret material.
2. User picks avatar → PIN pad → client `POST /api/auth/login {user_id, pin}`.
3. On match: gateway returns `{token, user: {user_id, display_name, is_admin}}`. On mismatch: 401 with generic message. No lockout.
4. Client persists token in `localStorage` under `sentient:auth`.

### 4.4 WebSocket Binding

WS protocol extended with a required first message:

```json
{"type": "auth", "token": "v4.local..."}
```

- Gateway validates within `auth.ws_auth_timeout_ms` (default 5000). Missing/invalid → `{type: "auth.error", code, message}` + close.
- On success: PersonSession is bound to `user_id` for the WS lifetime. SessionRouter routes all cycles to that user's Hermes.
- `identify_user` MCP tool becomes **channel-gated**: callable only when `channel === "satellite"`. Calls from the web channel return an error.

### 4.5 Admin Operations (MVP)

- `POST /api/admin/users` — create user: display name, initial PIN, `is_admin` bool. Seeds `profile.json` from defaults, starts container.
- `DELETE /api/admin/users/:id` — soft-delete: triggers Hermes session-end + flush → stops container → moves `~/.sentient/gateway/<user_id>/` → `_archive/<user_id>-<ts>/` → removes `users.json` entry. Typed-confirmation gate in UI ("type `delete` to confirm").
- `POST /api/admin/users/:id/reset-pin` — admin sets new PIN; user logs in with it next time. No email loop, no forced-change step.
- `PATCH /api/admin/users/:id {is_admin}` — promote/demote. Gateway refuses to demote the last remaining admin.

Non-admin users have zero access to `/api/admin/**`.

## 5. Provider + Voice Catalogs

### 5.1 Model Picker (unified dropdown)

Gateway exposes `GET /api/models`. Merges two sources:

1. **OpenRouter** — `GET /api/v1/models` (bearer from `secrets.json`). Rich metadata: `name`, `description`, `context_length`, `pricing.prompt`, `pricing.completion`, `supported_parameters` (contains `"tools"` if model supports tool-calls).
2. **Ollama Cloud** — `GET https://ollama.com/api/tags` returns only id + size + digest. Rich metadata comes from hand-maintained `~/.sentient/gateway/shared/catalogs/ollama-models.json` — name, description, context_length, capability tags. Pricing shown as "Included" (free tier).

Gateway merges into a unified shape:

```ts
type ModelEntry = {
  id: string;
  provider: "openrouter" | "ollama-cloud";
  name: string;
  description: string;
  context_length: number;
  pricing_per_1m_prompt: number | "included";
  pricing_per_1m_completion: number | "included";
  supports_tools: boolean;
  supports_vision: boolean;
};
```

Cache TTL: 1h. On fetch failure: serve stale cache, log warn.

### 5.2 Voice Picker (Fish Audio)

Gateway exposes `GET /api/voices`. Proxies Fish Audio `GET /model` (same bearer as TTS). Cache TTL 10min.

Per-voice fields exposed to UI: `_id`, `title`, `description`, `languages[]`, `tags[]`, `cover_image`, `samples[0].audio` (preview URL), `visibility`.

UI dropdown: search box, language filter chip, "My voices only" toggle (`self=true`), cover thumbnail + title + tag chips per row, ▶ preview button plays `samples[0].audio` inline.

### 5.3 API Key Security Wall

- Keys live in `~/.sentient/gateway/secrets.json`, `chmod 0600`, process-readable only.
- Never returned by any HTTP or WS response. Admin UI shows `••••••••` + "Replace" button. `GET /api/admin/secrets` returns only `{openrouter: {configured: true}, ollama: {configured: false}, ...}`.
- Keys used only by gateway: (a) proxying catalog fetches, (b) injecting as env vars at Hermes container start.
- SDK, webui, and WS transport never carry keys.

### 5.4 Hermes Rendering for Ollama Cloud

Official Hermes docs cover local Ollama only. OpenAI-compat shape is identical; gateway renders:

```yaml
model:
  provider: openai
  base_url: https://ollama.com/v1
  model: gpt-oss:120b-cloud
  api_key_env: OLLAMA_API_KEY
```

`OLLAMA_API_KEY` injected by gateway at container start. Verification required that Hermes respects `api_key_env` for arbitrary OpenAI-compat endpoints.

## 6. UI / UX

### 6.1 App Shell

Extend `TopbarRoute` to `"setup" | "login" | "chat" | "settings"`. Load order:
- `users.json` empty → `"setup"`.
- Has users, no/invalid token → `"login"`.
- Otherwise → last persisted route from `localStorage`.

Topbar hidden on `"setup"` and `"login"`. Existing 3-row grid shell is reused.

### 6.2 Login + Setup Screens

Centered `.settings-panel` card, 420px wide.

**Login:**
- Stage 1: avatar grid (reuse existing `Avatar` component + `MEMBERS_FIXTURE` row pattern, now fed from `users.json`).
- Stage 2 (after tapping an avatar): 3×4 numpad PIN pad, 4 ink circles above, auto-submit on 4th digit. Wrong PIN → `color-stop` shake + inline "Wrong PIN". No lockout.
- "Back" link returns to avatar picker.

**Setup (first-run only):**
- Single form: display name + PIN + confirm PIN → creates first admin.

### 6.3 Topbar User Menu

Right side of topbar gets `Avatar` + display name. Click → small popover (new component) with "My Account" + "Log out". Uses existing `--color-paper` background.

### 6.4 Settings Tab Restructure

Existing placeholder tabs are repurposed, not removed (future work stays visible).

| Tab | Visible to | Status |
|---|---|---|
| My Agent | every user (self) | MVP — persona, voice, model, tools, advanced accordion |
| My Account | every user (self) | MVP — display name, change PIN, logout |
| Members | admin only | MVP — wire fixtures → `users.json`; add/delete/reset PIN/admin-toggle |
| System | admin only | MVP — provider keys (masked + Replace), shared templates editor |
| Permissions | admin only | WIP badge, deferred |
| Voice Profiles | admin only | WIP badge, deferred (custom upload is future) |
| Invites | admin only | WIP badge, deferred |
| Devices & Sessions | admin only | WIP badge, deferred |

Non-admin users see only "My Agent" and "My Account".

### 6.5 My Agent Tab

Sections, stacked as `.settings-panel` cards:

1. **Persona** — textarea; default text loaded from `shared/templates/default-system.md`; dropdown to pick a different shared template.
2. **Voice** — picker described in §5.2.
3. **Model** — picker described in §5.1.
4. **Tools** — toggle rows for each MCP server in `profile.json.mcp_servers`.
5. **Advanced** (collapsed by default) — compression threshold, max tokens, extra system prompt fragment.

**Dirty state tracking:** each field knows whether it's a "live" field (saved immediately, no restart) or a "restart" field. Dirty restart fields trigger the sticky footer.

### 6.6 Apply & Restart

When any restart-field is dirty, a sticky footer appears at the bottom of the My Agent tab:

- Amber `color-warn` background.
- Label: "N pending changes".
- Buttons: "Discard" (revert fields) + "Apply & Restart" (primary, terra-accent).

**Apply flow** (matches the design verified in §3.3):

1. UI locks with full-screen `spinner-overlay`: Fraunces heading "Updating your agent…", DM Sans body "Do not close this tab", motion-normal fade-in.
2. Gateway state machine — **5 states**: `idle → writing-config → restarting → health-checking → ready | failed`.
   - `writing-config`: render new `SOUL.md` + profile `config.yaml` to the bind-mounted volume; clear `binding.conversationId` on the user's active PersonSession(s).
   - `restarting`: invoke `docker restart hermes-<user>` via the docker control adapter.
   - `health-checking`: poll Hermes `GET /health` until 200 or `health_check_timeout_ms`.
3. Success → overlay fades → `toast` "Agent updated", terra accent. Next user turn starts a fresh Hermes chain that reads the new SOUL.md/config.
4. Failure paths:
   - `render-error` → config didn't validate, nothing changed; "Config looks invalid. Changes discarded."
   - `docker-restart-failed` → docker SDK call returned non-zero; "Couldn't restart the agent container."
   - `health-check-timeout` → container didn't come back; UI shows "Agent didn't come back in time" + retry. Old config files remain on disk; user can fix and reapply.

UI does NOT release the lock until ACK (per user requirement). No rollback step is needed because the apply does not delete or move any prior config — it only overwrites with new content.

### 6.7 New Shared UI Primitives

- `spinner-overlay.tsx` — full-screen lock with Fraunces + DM Sans text, fade transitions.
- `confirm-dialog.tsx` — modal with typed-confirmation for destructive actions (delete user).
- `toast.tsx` — ~40 lines, terra accent, auto-dismiss 4s.
- `popover.tsx` — small anchored popover for topbar user menu.

All follow BEM + existing color/radius/motion tokens. All new components target <300 lines.

## 7. Runtime Flows

### 7.1 Login

```
Client                        Gateway                     Users store
  |                             |                             |
  |-- GET /api/auth/users ----->|                             |
  |                             |-- read users.json --------->|
  |<-- [{user_id, name, tint}]--|                             |
  |                             |                             |
  |-- POST /api/auth/login ---->|                             |
  |   {user_id, pin}            |-- argon2.verify ----------->|
  |<-- {token, user} -----------|                             |
```

### 7.2 WS Cycle Dispatch

```
Client            Gateway              SessionRouter    HermesClient(user)
  |                 |                        |                 |
  |-- ws connect -->|                        |                 |
  |-- auth token -->|--- validate token ---->|                 |
  |<-- auth.ok -----|--- bind user_id ------>|                 |
  |-- user says ... >|                       |                 |
  |                  |----------- cycle.start ---------------->|
  |<----------------- cycle.events -------------------------- -|
```

### 7.3 Apply & Restart

```
User      UI                 Gateway                       Docker       Hermes(user)
  |        |                    |                            |               |
  |-Apply->|                    |                            |               |
  |        |-POST /apply ------>|                            |               |
  |        |                    |- write SOUL.md, config.yaml ---->volume    |
  |        |                    |- SessionRouter.clearConversationId(user)   |
  |        |                    |- docker restart hermes-<u> >|               |
  |        |                    |                            |---SIGTERM---->|
  |        |                    |                            |<--exit--------|
  |        |                    |                            |---start------>|
  |        |                    |-poll GET /health (~7s) ----------------->|
  |        |                    |<-200 OK------------------------------------|
  |        |<-200 {status:ready}|                            |               |
  |        |-unlock, toast ---->|                            |               |
```

The orphan chain remains in `response_store.db`; Hermes's idle-expiry watcher extracts salient bits into `memories/MEMORY.md` within ≤1h, asynchronously to apply.

## 8. Error Handling

Per `.claude/rules/error-handling.md`:

- All new services return `Result<T, E>` typed unions. No throws from business logic.
- Boundaries that catch: REST handlers in `gateway/src/http/`, WS auth handler in `gateway/src/session-handlers/`, CLI setup entries.
- Apply-restart failure modes surface to UI with specific copy:
  - `render-error` → "Config looks invalid. Changes discarded."
  - `docker-restart-failed` → "Couldn't restart the agent container."
  - `health-check-timeout` → "Agent didn't come back in time."
- Catalog-fetch failures (OpenRouter/Ollama/Fish): serve stale cache, log warn, badge UI dropdown with "⚠ outdated".
- First-time setup race: `users.json` write uses atomic-rename semantics; second concurrent POST returns 409.
- Soft-delete means "wrong click" is a recoverable mistake via `mv`; no destructive step 1.
- Timeouts on all external calls: OpenRouter/Ollama/Fish fetch 5s; docker restart 30s; health-check 30s. All knobs in `gateway/config.yaml` under new `auth:`, `apply:`, and `providers:` sections.

## 9. Testing

Per `.claude/rules/testing.md` and Voice-Pipeline-Test-Philosophy principles:

- **State-machine tests, no internal mocks:**
  - Apply-restart FSM: every state reachable, every waiting state has a timeout test, every sad path fires.
  - Auth FSM: unauthed → pending → authed; expired-token path; missing-auth-message path.
- **Pure renderer tests (golden-file fixtures):** `profile.json → {config.yaml, SOUL.md}` for each provider combo. Snapshot testing.
- **Atomic-write tests:** add user → read back; crash-during-rename simulation → old file intact; concurrent write → second write waits.
- **Integration:** WS auth handshake (valid, invalid, missing, timeout). First-run setup (empty → create admin, second POST returns 409). Login + logout round trip.
- **Smoke (manual, pre-demo checklist):**
  1. Setup → login → chat → works.
  2. Change model via UI → Apply & Restart → verify new model answers.
  3. MEMORY.md preserved across restart (grep for pre-restart fact).
  4. Delete user → `_archive/` dir exists → container stopped.
  5. Wife's account in parallel session → isolated conversation, isolated memory.
- **Zero-cost by default:** provider/voice list fetches mocked. Real API hits only in a tagged `@live` suite run manually.
- Unit tests under 100ms each, ≥80% statements, ≥75% branches.

## 10. Config Additions (`gateway/config.yaml`)

```yaml
auth:
  token_ttl_seconds: 604800        # 7d; rolling-refreshed on every auth-check
  ws_auth_timeout_ms: 5000         # close WS if auth message not received in this window
  argon2_memory_kb: 65536          # ~64MB; tune if Pi-5 is under memory pressure
  argon2_iterations: 3
  argon2_parallelism: 1

apply:
  docker_restart_timeout_ms: 30000 # max wait for `docker restart` to return
  health_check_timeout_ms: 30000   # max wait for Hermes /health to return 200 after restart
  health_poll_interval_ms: 1000    # poll cadence during health-checking state

providers:
  openrouter_cache_ttl_ms: 3600000 # 1h
  ollama_cloud_base_url: https://ollama.com/v1
  ollama_cache_ttl_ms: 3600000     # 1h
  fish_cache_ttl_ms: 600000        # 10min (Fish rate limits undocumented)
  external_fetch_timeout_ms: 5000  # applies to all catalog fetches
```

Every constant is documented inline, ranges implied by type + comment where non-obvious. Per `.claude/rules/config.md`: no magic numbers in source files.

## 11. Deferred / Out of Scope

- Multi-factor or passkey auth.
- Internet exposure (Cloudflare Tunnel / Tailscale).
- Per-user provider API keys (bring-your-own-key).
- Voice cloning upload UI (Fish `POST /model` endpoint is architecturally aligned for a Phase-2 feature).
- Kids-with-restrictions / capability-based permissions (existing `PermissionsPanel` placeholder stays WIP).
- Admin editing another user's per-agent settings (persona, voice, model, tools). Admin power this cycle is limited to create, delete, reset-PIN, and promote/demote.
- Device + session inventory (existing `SessionsPanel` placeholder stays WIP).
- Rate-limit / lockout on failed PIN (family LAN trust model).
- Periodic safety memory flush (Hermes's idle-expiry watcher is sufficient).
- Synchronous memory flush on apply via a Hermes plugin (`profiles/<user>/plugins/` registering `on_session_finalize`). Lazy idle-watcher path is acceptable for MVP; the plugin is a clean post-launch upgrade and would not change any consumer.

## 12. Open Questions / Validation Required

### 12.1 Hermes session-end / memory-flush — RESOLVED 2026-04-24

Verified empirically against `nousresearch/hermes-agent:v2026.4.16` running as `hermes-alice`:

- **No external HTTP endpoint exists** for forcing `on_session_end` / memory flush. All probed paths (`/v1/sessions/*/end`, `/finalize`, `/flush`, `/reset`) return 404. Confirmed via OpenAPI/source-code review in upstream `gateway/platforms/api_server.py` route table and direct probe of the live container.
- **Hermes does NOT flush memory on SIGTERM.** `docker restart` confirmed: `MEMORY.md` and `USER.md` mtime unchanged across restart. The flush LLM turn fires only via the 300s idle-expiry watcher when a session crosses the idle policy threshold.
- **`response_store.db` persists across restart** (SQLite + WAL on the bind-mounted volume). `previous_response_id` resolves cleanly post-restart; chain continuity is preserved by default.
- **System prompt is baked at chain creation.** Tested: edit SOUL.md → restart → continuation turn ignores the new SOUL.md; fresh chain (no `previous_response_id`) honors it. This is the load-bearing finding behind the §3.3 design: apply MUST start a new chain, otherwise persona/system-prompt edits never take effect.

Design implication adopted in §3.3: clear `binding.conversationId` on apply + `docker restart`. Lazy memory flush via Hermes's own idle-expiry watcher (≤1h). No plugin, no FSM gymnastics, no external session-end RPC.

### 12.2 Outstanding validation

1. **Hermes honoring `api_key_env` for arbitrary OpenAI-compat providers** — official Ollama-Cloud + Hermes combo is not documented. Confirm via a quick PoC before wiring it into the UI.
2. **Fish Audio `samples[].audio` coverage** — OpenAPI types `samples` as optional/default-empty. Confirm public voices return samples; if not, UI needs a "no preview" fallback state.

## 13. Risks

- **Two-week deadline + four new screens + state machine + renderer** is tight. Recommend parallel-stream execution: renderer/store + apply FSM as one track; UI shell + login + settings tabs as a second track; admin panel + catalog proxies as a third.
- **Memory-flush latency on apply** — orphan chain is flushed lazily by Hermes's idle watcher within ≤1h. If a user starts a new chat immediately after apply and references something from the just-ended conversation, the new chain may not yet have it in MEMORY.md. Bounded; acceptable for MVP. Mitigated by the optional plugin path (§11) post-launch.
- **Memory loss on crash** — `response_store.db` is SQLite WAL on disk; transcript loss on power loss is bounded to the unsynced WAL window (typically a few seconds of recent turns). Long-term `MEMORY.md` is unaffected.
- **Fish + Ollama + OpenRouter external dependencies** can all fail independently. Catalog caching mitigates; model + voice fallbacks on empty list need defined copy.
- **Hermes upstream schema drift** is the risk the renderer pattern is designed to absorb. One renderer update per Hermes upgrade; UI untouched.
