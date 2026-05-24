# Multi-User Auth + Gateway-Owned Settings — Overview

> **For agentic workers:** This is the top-level index. Each phase has its own detailed plan file. Execute phases in the order listed (some have parallel lanes — see dependency graph). Detailed plans use checkbox (`- [ ]`) syntax; use superpowers:subagent-driven-development to implement.

**Spec:** `docs/superpowers/specs/2026-04-24-multi-user-auth-and-settings-design.md`
**Deadline:** 2-week family demo.
**Branch:** `develop` (existing integration branch, per project git-workflow rules).
**Goal:** Ship web login, per-user settings, gateway-owned config rendering, live model switching, admin user management.

## Phase Map

| # | Phase | File | Primary Output | Depends On |
|---|---|---|---|---|
| 0 | Foundation | [phase0-foundation.md](2026-04-24-multi-user-phase0-foundation.md) | `users.json` store, PIN hash, token service, config schema | — |
| 1+2 | Auth + Profile (bundled) | [phase1-2-auth-and-profile.md](2026-04-24-multi-user-phase1-2-auth-and-profile.md) | REST login/setup/me, WS auth gate, PersonSession user binding, `profile.json` CRUD + renderer to `config.yaml` + `SOUL.md` | 0 |
| 3+4 | Apply orchestrator + catalogs (bundled) | [phase3-4-apply-and-catalogs.md](2026-04-24-multi-user-phase3-4-apply-and-catalogs.md) | `/api/v1/profile/apply` (clear conversationId → docker restart → poll health), `/api/v1/providers/models` + `/voices` proxies with cache | 1+2 (apply); 0 (catalogs) |
| 5 | Webui auth UX | `2026-04-24-multi-user-phase5-webui-auth.md` | login screen, setup screen, auth state, topbar user menu | 1+2 |
| 6 | Webui My Agent + My Account | [phase6-webui-settings.md](2026-04-25-multi-user-phase6-webui-settings.md) | self-service profile/auth endpoints, settings tabs (My Agent + My Account), spinner-overlay + toast, apply integration | 3+4, 5 |
| 7 | Webui admin panels | [phase7-webui-admin.md](2026-04-25-multi-user-phase7-webui-admin.md) | Members + System tabs, create/delete user flows | 5, 6 |
| 8 | Deploy + smoke | `2026-04-24-multi-user-phase8-deploy.md` | docker compose, always-on mode, end-to-end checklist | all |

## Dependency Graph (parallel lanes)

```
Phase 0 ──> Phase 1+2 ──> Phase 3+4 ──┐
                  │                    │
                  └──> Phase 5 ────────┴──> Phase 6 ──> Phase 7 ──> Phase 8
```

**Bundled and parallel tracks after Phase 0:**
- **Bundle 1+2** (one plan file): auth endpoints + WS gate + profile store + renderer. Cannot ship without 0; enables 3+4 and 5.
- **Bundle 3+4** (one plan file): apply orchestrator + provider/voice catalog proxies. Phase 3's design was simplified after the 2026-04-24 PoC resolved spec §12.1 (no Hermes RPC needed; clear `conversationId` + `docker restart` is sufficient — see spec §3.3). Phase 4 is pure HTTP fetchers with cache. The two phases are file-orthogonal; bundling cuts the plan-writing overhead in half without coupling them at runtime.
- **Phase 5:** Webui auth UX. Independent of 3+4; can be developed in parallel.
- **Phase 6/7:** Frontend settings + admin panels. 6 needs 3+4+5; 7 needs 6.

Phase 8 serialises all tracks and is the demo gate.

## Acceptance Criteria Per Phase

**Phase 0** — `bun run test` passes with:
- `~/.sentient/gateway/users.json` round-trip (write → atomic rename → read-back identical).
- PIN hash/verify: `hash("1234") → verify("1234", hash) === true`; `verify("9999", hash) === false`.
- Token service: issue → validate returns payload; expired token → rejected; tampered token → rejected.
- New `auth`, `apply`, `providers` sections in config schema validate a fixture yaml.

**Phase 1** — manual curl + WS smoke:
- Empty `users.json` → `GET /api/auth/users` returns 200 with empty array.
- `POST /api/auth/setup` seeds admin; subsequent call returns 409.
- `POST /api/auth/login` with correct PIN → `{token}`; wrong PIN → 401.
- WS connect without auth message within 5s → closed. WS auth with valid token → `{type: "auth.ok"}` and subsequent cycles dispatch to that user's Hermes.

**Phase 2** — pure-function test passes:
- `renderProfile(profile.json)` produces byte-stable `config.yaml` + `SOUL.md` for fixture inputs.
- `profile.json` write uses atomic rename; concurrent write yields one winner.

**Phase 3+4** — apply orchestrator + catalogs:
- 5-state apply FSM (`idle → writing-config → restarting → health-checking → ready | failed`); every waiting state has a timeout test; failure paths surface typed errors to the HTTP boundary.
- `POST /api/v1/profile/apply` writes new SOUL.md + profile config, calls `SessionRouter.clearConversationId`, runs the docker control adapter, polls `/health`, returns `{status:"ready"}` only after Hermes is healthy.
- Mocked docker control adapter for tests; one tagged `@live` integration test against `hermes-alice` exercises the real path.
- `/api/v1/providers/models` returns merged OpenRouter + Ollama-Cloud list with capability flags + pricing; `/api/v1/providers/voices` returns Fish list with preview URLs. Both proxies survive upstream failure by serving stale cache.

**Phase 5** — browser smoke:
- Empty `users.json` → setup screen on first load; creates admin; token persisted in `localStorage`.
- Existing users → login screen; avatar pick + PIN → redirect to chat.
- Topbar shows avatar; click → logout button; logout clears token and returns to login.

**Phase 6** — browser smoke (executed inside a git worktree on `feature/multi-user-phase6-webui-settings`):
- Backend prereq endpoints: `GET/PUT /api/v1/profile/me`, `PUT /api/v1/auth/me`, `PUT /api/v1/auth/me/pin` ship and pass contract tests.
- My Agent tab: change voice → preview plays → apply restart → toast "Agent updated"; MEMORY.md retained.
- My Agent tab: change model provider OpenRouter → Ollama → apply works, new model answers.
- My Account tab: change display name, change PIN, logout. Wrong current-PIN shows inline error.
- Settings tab gating: non-admin sees only My Agent + My Account; admin sees all.
- Apply error paths surface typed errors via toast (`render-error`, `docker-restart-failed`, `health-check-timeout`).

**Phase 7** — browser smoke (executed inside a git worktree on `feature/multi-user-phase7-webui-admin`, admin-only criteria):
- Backend prereqs: slot-binding store, slot allocator (pure FSM), secrets store (mode 0600), and the six admin endpoints (`GET/POST /admin/users`, `DELETE/PATCH /admin/users/:id`, `POST /admin/users/:id/reset-pin`, `GET /admin/secrets`, `PUT /admin/secrets/:provider`) ship with contract tests.
- Members tab: add user → new avatar shows on login screen; new user lands in their own Hermes container; delete user → `_archive/` directory exists → slot returns to pool.
- System tab: Replace OpenRouter key → next `/api/v1/providers/models` call uses new key; keys never exposed in any response or log.
- Non-admin user cannot see Members/System tabs.
- Pool-full guard: 4th user creation when 3 slots are filled returns 422.
- Last-admin guard: PATCH demoting the only admin returns 422.

**Phase 8** — demo rehearsal:
- Two users log in simultaneously from two browsers → isolated conversations, isolated memory.
- Pi reboot → all containers restart → no MEMORY.md loss for in-flight conversations (via 60s grace).
- Docker compose up from clean slate → gateway responds → setup screen available.

## Scope Notes

**Pivots from `2026-04-21-hermes-cerebrum-integration-design-v4.md`:**
- Multi-profile config no longer hand-edited; gateway renders it.
- `identify_user` MCP tool is channel-gated (satellite only); web channel uses token-bound user_id.
- `HermesConfig.profiles` becomes a rendered artifact, not a source of truth.

**Already landed, do not rebuild:**
- SessionRouter bind/rebind API (`gateway/src/session-router.ts`) — reuse as-is.
- `HermesProfileBinding` type (`gateway/src/cerebrum/hermes-client.ts`) — reuse.
- Existing settings placeholder components (`gateway/webui/src/components/settings/`) — repurpose per spec §6.4.
- `MembersPanel`, `PermissionsPanel`, `SessionsPanel` — wire to real data or keep WIP per phase.

**Out of scope this cycle** (from spec §11):
- MFA, passkey, internet exposure, per-user API keys, voice upload, permission roles, admin-edits-others-settings, PIN lockout, periodic memory flush.

## Risk Mitigations

- **Hermes external session-end endpoint** — RESOLVED (spec §12.1). PoC 2026-04-24 confirmed the simpler design: clear `conversationId` + `docker restart` is the right primitive. No spike needed; bundle 3+4 is direct execution.
- **Hermes Ollama-Cloud combo unverified** (spec §12.2) — Phase 4 Task 2 runs a manual PoC before wiring the UI dropdown.
- **Fish preview coverage unverified** (spec §12.2 item 2) — Phase 4 includes a "no preview" fallback UI state.

## Execution Mode

Recommended: **subagent-driven**. Dispatch one subagent per task with the relevant phase file + this overview in context. Review between tasks; merge into `develop` when each phase's acceptance criteria clear.

Each detailed phase file is written just-in-time when its predecessors validate, so Phase 0 is the only one enumerated at full task granularity on day 1.
