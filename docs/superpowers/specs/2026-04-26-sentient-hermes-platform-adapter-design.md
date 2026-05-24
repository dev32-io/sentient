# Sentient as a Hermes Platform Adapter — Design

**Date:** 2026-04-26
**Status:** Draft, ready for implementation plan
**Branch:** new feature branch off `develop` after `feature/multi-user-auth-and-settings` merges. Suggested name: `feature/sentient-hermes-platform-adapter`. Final name decided by writing-plans phase.
**Supersedes:** parts of `docs/superpowers/plans/2026-04-25-phase7.5-gateway-owned-hermes-pool.md` (Phase 7.5 is retired by this work)
**Builds on (unchanged):** `docs/superpowers/specs/2026-04-21-hermes-cerebrum-integration-design-v4.md` — multi-profile strategy, MCP roster, HA dual-path, Steward, voice pipeline. v4 still describes those correctly.

---

## 1. Motivation

Phase 7 / 7.5 integrated with Hermes through Hermes' OpenAI-compat `/v1/responses` adapter and built our own Bun-side container reconciler to manage one Hermes container per user. Source-reading and a live runtime probe both confirmed:

1. **`/v1/responses` (`gateway/platforms/api_server.py`) bypasses `GatewayRunner` entirely.** It instantiates `AIAgent` directly. Slash commands, hooks, allowlists, native personality persistence, tool-progress callbacks — none of it runs.
2. **Hermes' platform-adapter system already provides everything we were reimplementing**: per-process per-profile isolation, native `/personality` (writes to `agent.system_prompt`, persists, survives restart), native tool-call hooks (`tool_start_callback` / `tool_progress_callback` / `tool_complete_callback`), allowlists, slash dispatch.
3. **Hermes' `terminal.backend: docker`** provides per-tool-call sandbox containers with `--cap-drop ALL`, `pids-limit`, `container_cpu/memory/disk` per profile — strictly stronger isolation than what our reconciler builds.

Our voice/STT/TTS pipeline is genuinely better than Hermes' (token-streaming, sub-500ms first-audio, barge-in). We keep it. But for the LLM/agent loop, we are a platform to Hermes — same status as Discord — and we should integrate as one.

This spec defines that integration.

## 2. Scope

**In scope:**
- A new `deploy/hermes-overlay/` directory that builds our customized Hermes image over a pinned upstream version, with a custom platform adapter (`sentient_gateway.py`) and ~5 small source patches.
- A single `sentient-hermes` container running supervisord, hosting one `hermes -p <userId> gateway run` process per active user.
- A WS-based IPC contract between the Bun gateway and the Python adapter (replaces our current `/v1/responses` SSE consumer).
- Tool-call progress tracking through the new WS protocol.
- Self-service per-user editing of SOUL.md and `agent.personalities` from the webui, with a "save → restart that user's agent (5–10s spinner) → reconnect" UX.
- Retirement of Phase 7.5 components (`hermes-pool-reconciler`, `hermes-container-spec`, custom `Dockerfile.slim`, per-user `hermes_api_key_*` secrets, Bun-side docker socket).
- Migration from the current container-per-user state to the new overlay model.

**Out of scope (explicitly deferred):**
- Cron-fired proactive delivery (`tools/send_message_tool.py` + `cron/scheduler.py` integration). Picks up when ESP32 / notifications come online.
- ESP32 satellites; Steward agent; multi-profile strategy details (all in v4 cerebrum spec).
- Per-token streaming on `assistant.message` (additive future change to the WS protocol).
- Live SOUL.md preview, personality versioning/undo, BLOCKED-SOUL detection surfaced in webui.
- The 8 deferred Hermes integration points listed in `deploy/hermes-overlay/README.md` (`PLATFORM_HINTS`, `SessionSource` extensions, cron, send_message routing, channel_directory, redact, status display, setup wizard). Each has a recorded future trigger.

## 3. Architecture overview

```
                  Voice clients (browser / RPi puck / ESP32)
                              │
                  audio + WS protocol (ours)
                              │
              ┌───────────────▼───────────────┐
              │       Bun gateway             │
              │  STT, TTS, barge-in,          │
              │  attention gate, cognitive    │
              │  cycle, presence, auth        │
              │  (all unchanged)              │
              │                               │
              │  hermes-adapter-client (NEW)  │ ──── supervisorctl
              │  ─ N WS connections,          │      (Unix socket)
              │  ─ one per active profile     │            │
              └──────────────┬────────────────┘            │
                             │                             │
                  WS  (per-profile)                        │
                             │                             ▼
              ┌──────────────▼──────────────────────────────┐
              │         sentient-hermes (single container)   │
              │              (deploy/hermes-overlay/)        │
              │                                              │
              │  supervisord (PID 1)                         │
              │   ├─ hermes -p alice  gateway run  :8650     │
              │   ├─ hermes -p bob    gateway run  :8651     │
              │   └─ hermes -p family gateway run  :8652     │
              │                                              │
              │  Each profile process loads:                 │
              │   • SentientGatewayAdapter (our code)        │
              │     ─ WS server on its port                  │
              │     ─ goes through GatewayRunner             │
              │     ─ tool callbacks → WS frames             │
              │   • Hermes' GatewayRunner / AIAgent          │
              │   • terminal.backend: docker (host socket)   │
              └──────────────────────────────────────────────┘
```

## 4. Overlay & process topology

**Repo layout:**
```
deploy/hermes-overlay/
├── README.md             # rebase strategy, pin policy, deferred-integration record
├── HERMES_VERSION        # single line, e.g. v2026.4.16
├── Dockerfile            # FROM nousresearch/hermes-agent:${HERMES_VERSION}
├── supervisord.conf      # daemon-only; programs rendered into /data/supervisor/programs/
├── sentient_gateway.py   # custom platform adapter
└── patches/              # 5 surgical patches (see §6)
```

**Container build:**
1. `FROM nousresearch/hermes-agent:${HERMES_VERSION}`.
2. `apt-get install supervisor patch`.
3. Copy `sentient_gateway.py` → `/opt/hermes/gateway/platforms/`.
4. Apply each patch in `patches/` against `/opt/hermes/`. Build fails fast if any patch doesn't apply (rebase signal).
5. Copy `supervisord.conf` → `/etc/supervisor/`.
6. `CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]`.

**Runtime:**
- `supervisord` runs as PID 1.
- Per-profile programs live at `/data/supervisor/programs/<userId>.conf`. Rendered by the Bun gateway when admin adds a user; removed when admin deletes.
- `supervisord` includes them via glob; gateway calls `supervisorctl reread && supervisorctl update` after rendering.
- Each program runs `hermes -p <userId> gateway run`, with `HERMES_HOME=/data/profiles/<userId>` and a per-user `SENTIENT_GATEWAY_PORT`. Port assignment is owned by `slot-allocator.ts` (extended to record `port` alongside `slotKey` in `slot-binding-store.ts`); the renderer reads it when generating the supervisord program.

**Bind mounts on the `sentient-hermes` container:**
- `~/.sentient/gateway/data/<userId>/` → `/data/profiles/<userId>` (one mount per active user — the host-side path is per-user, the in-container path is per-user).
- `/var/run/docker.sock` → for `terminal.backend: docker` per-tool sandboxes.
- Supervisord Unix socket at `/data/supervisor/supervisor.sock` is also bind-mounted into the Bun gateway container so the gateway can run `supervisorctl`.

## 5. Platform adapter contract (`sentient_gateway.py`)

Subclass of `BasePlatformAdapter` (Hermes' `gateway/platforms/base.py`). One adapter instance per Hermes process = one user.

**Required methods (Hermes' contract — signatures fixed):**

| Method | Behavior |
|---|---|
| `__init__(config)` | Parse `PlatformConfig`, init state, `super().__init__(config, Platform.SENTIENT_GATEWAY)`. |
| `connect() → bool` | Start embedded WS server on `0.0.0.0:${SENTIENT_GATEWAY_PORT}`. Validate `SENTIENT_GATEWAY_TOKEN` env var present. |
| `disconnect()` | Stop WS server, close any open client. |
| `send(chat_id, content, …) → SendResult` | Push `{type:"assistant.message", seq, ref, text}` to the connected Bun client. v1 = one frame per logical message; per-token streaming deferred. |
| `send_typing(chat_id)` | No-op (voice has no typing indicator). |
| `send_image / send_voice / send_video / send_document` | No-op. Return `SendResult(success=True, message="ignored")`. |
| `get_chat_info(chat_id)` | Return `{name: chat_id, type: "voice", chat_id: chat_id}`. |
| `check_sentient_gateway_requirements()` (module-level) | Returns `True` (no external deps). |

**Tool-progress callbacks:** the adapter exposes a per-session callback bundle that Patch 5 wires into `AIAgent` construction so `tool_start_callback` / `tool_progress_callback` / `tool_complete_callback` push WS frames (§7).

**Auth:** WS upgrade requires `Authorization: Bearer <SENTIENT_GATEWAY_TOKEN>`. Adapter rejects with `HTTP 401` on mismatch. Same token both sides; sourced from `internal-secrets-store.ts`, injected into the overlay container as env var.

**Single-client invariant:** new connection while one is open closes the old. Bun is the only legitimate client.

## 6. Source patches against upstream

Five patches in `deploy/hermes-overlay/patches/`. All small, surgical, on integration points that don't sit on refactor-prone logic.

| Patch | File | Change |
|---|---|---|
| `0001-config-platform-enum.patch` | `gateway/config.py` | Add `SENTIENT_GATEWAY = "sentient_gateway"` to `Platform` enum + env-var loader for `SENTIENT_GATEWAY_TOKEN` / `SENTIENT_GATEWAY_PORT`. |
| `0002-run-adapter-factory.patch` | `gateway/run.py` | `elif platform == Platform.SENTIENT_GATEWAY:` branch in `_create_adapter()` returning `SentientGatewayAdapter(config)`. |
| `0003-run-auth-maps.patch` | `gateway/run.py` | Add `Platform.SENTIENT_GATEWAY` to `platform_env_map` and `platform_allow_all_map` (allowlist plumbing). |
| `0004-toolsets.patch` | `toolsets.py` | New `"hermes-sentient-gateway"` toolset entry; include in `hermes-gateway` composite. |
| `0005-run-adapter-tool-callbacks.patch` | `gateway/run.py` | In `_handle_message_with_agent`, when `event.source.platform == SENTIENT_GATEWAY`, fetch the adapter's per-session callback bundle and pass through as `tool_start_callback` / `tool_progress_callback` / `tool_complete_callback` to `AIAgent(...)`. |

**Skipped from `ADDING_A_PLATFORM.md` (recorded in `deploy/hermes-overlay/README.md`):**

| Hook | File | Future trigger |
|---|---|---|
| `PLATFORM_HINTS` | `agent/prompt_builder.py` | If we ever want LLM-side voice-formatting hints in Hermes rather than SOUL.md. We keep them in SOUL.md. |
| `SessionSource` extra fields | `gateway/session.py` | Per-device identity at the Hermes session level. ESP32 phase. |
| Cron delivery `platform_map` | `cron/scheduler.py` | Proactive notifications. ESP32 phase. |
| Send-message routing | `tools/send_message_tool.py` | Same. |
| `channel_directory` | `gateway/channel_directory.py` | Webui chat enumeration. |
| `redact` patterns | `agent/redact.py` | If userIds become PII-shaped. |
| `status` display | `hermes_cli/status.py` | Diagnostic — no consumer today. |
| `setup` wizard entry | `hermes_cli/gateway.py` | Webui owns provisioning; Hermes wizard never used. |

## 7. WS IPC protocol (Bun ↔ Python adapter)

**Connection:** one WS per Hermes profile process. Bun dials, adapter accepts. Single user per connection (chat_id implicit). N profiles = N connections held by Bun.

**Endpoint:** `ws://sentient-hermes:${PORT}/ws`. `PORT` is the per-profile port supervisord assigned.

**Auth:** WebSocket upgrade carries `Authorization: Bearer <SENTIENT_GATEWAY_TOKEN>`. `HTTP 401` on mismatch.

**Frame format:** JSON, one frame per WS message. Every frame carries `type` and `seq` (monotonic per-side per-connection, reset on each new WS).

### Bun → Hermes frames

| `type` | Fields | Meaning |
|---|---|---|
| `hello` | `version` (`"1.0"`), `client` (`"sentient-bun"`) | Sent immediately after WS open. Required before any `user.*` frame. |
| `user.message` | `seq`, `text`, `internal?` (bool, default `false`) | User said this. Adapter constructs `MessageEvent(text=text, source=…, internal=internal)` and dispatches via `self.handle_message(event)` → enters `GatewayRunner._handle_message`. Slash commands fire here. `internal:true` is used by the gateway to send admin-driven slash commands like `/personality concise` without TTS feedback. |
| `user.cancel` | `seq`, `ref` (the user.message seq being canceled) | Barge-in / stop. Adapter triggers Hermes' per-session `asyncio.Event` to abort the in-flight cycle. |
| `ping` | `seq` | App-level liveness probe. |

### Hermes → Bun frames

| `type` | Fields | Meaning |
|---|---|---|
| `hello.ack` | `version`, `server` (`"sentient-gateway-adapter"`) | Response to `hello`. WS is ready. |
| `assistant.message` | `seq`, `ref`, `text` | Hermes' agent loop called `adapter.send(chat_id, content)`. Adapter forwards. |
| `assistant.error` | `seq`, `ref`, `reason` | Cycle failed. Bun surfaces graceful failure. |
| `tool.start` | `seq`, `ref`, `tool_call_id`, `name`, `args_summary` | LLM decided to call a tool. `args_summary` truncated/redacted to ≤120 chars per log-sanitizer rule. |
| `tool.progress` | `seq`, `ref`, `tool_call_id`, `message` | Optional intermediate update from long-running tools. |
| `tool.end` | `seq`, `ref`, `tool_call_id`, `status` (`"ok"\|"error"`), `result_summary` | Tool finished. `result_summary` ≤120 chars; full result lives in transcript. |
| `pong` | `seq`, `ref` | Response to `ping`. |

**Frame ordering within one `ref`:** zero or more `tool.start` … (`tool.progress`) … `tool.end` cycles, then exactly one `assistant.message` (or `assistant.error`). The webui's existing tool-progress display logic (built against `/v1/responses` events) is preserved: Bun's adapter client maps WS frames to the same internal event shape the cerebrum already emits to the webui.

**Versioning:** `hello.version: "1.0"`. Future major bumps reject unknown majors with WS close 1008.

**Reconnect / liveness:**
- WS-level ping/pong (RFC 6455), 30s interval, 10s timeout.
- If Bun's WS drops: exponential-backoff reconnect (250ms → 4s, jitter). Hermes session state lives in `state.db` and survives independently — conversation continues. No app-level resume protocol in v1.
- If the Hermes profile process dies: supervisord restarts; Bun's reconnect loop re-establishes when adapter listens again.

**Errors:** malformed JSON → close 1003. Unknown frame `type` → log + ignore. Two `hello` frames → close 1002. Auth fail → 401.

## 8. Permission model & per-user editing flows

All edits below are **self-service**: each user can edit their own profile only. No admin-only / kid / guest distinctions in v1 — per-user Hermes-process isolation gives us the boundary we need.

| Action | Restart that user's agent? | Latency |
|---|---|---|
| Select existing personality | No | Instant |
| Personality CRUD | Yes | ~5–10s |
| Edit SOUL.md | Yes | ~5–10s |

### Endpoints (gateway, served to webui)

```
GET    /api/profiles/<userId>/soul                       → { content: "..." }
PUT    /api/profiles/<userId>/soul        body: { content }   (triggers restart)

GET    /api/profiles/<userId>/personalities
   → { personalities: [{ name, body }, …], active_name: "warm" | null }

POST   /api/profiles/<userId>/personalities       body: { name, body }    (restart)
PUT    /api/profiles/<userId>/personalities/<n>   body: { body }          (restart)
DELETE /api/profiles/<userId>/personalities/<n>                            (restart)

POST   /api/profiles/<userId>/active-personality  body: { name | null }    (instant, no restart)
```

`active_name` resolution: gateway reads `agent.system_prompt` from the user's `config.yaml`, matches it against each `agent.personalities` entry's resolved body (Hermes' `_resolve_prompt` algorithm: string, or dict-with-`system_prompt`/`tone`/`style`), returns the matching name or `null`.

### Path A — select existing (no restart)

```
webui POST /active-personality { name: "concise" }
  → Bun WS frame to that profile's adapter:
      { type:"user.message", seq:N, text:"/personality concise", internal:true }
  → Adapter constructs MessageEvent(internal=True), self.handle_message(event)
  → GatewayRunner intercepts /personality (gateway/run.py:5788)
  → atomic_yaml_write("agent.system_prompt", <body>) into config.yaml
  → updates in-memory self._ephemeral_system_prompt
  → adapter.send() returns "Personality set to concise"
  → Bun: do NOT pipe to TTS, surface as toast in webui
  → Bun returns 200 to webui
```

### Path B — SOUL or personality CRUD (with restart)

```
webui POST /soul    or POST /personalities    or PUT/DELETE
  → Bun gateway:
      1. Validate request matches authenticated user's profile.
      2. Render new file content (atomic write).
      3. Mark profile <userId> as "restarting".
      4. Close upstream WS to that profile's Hermes adapter cleanly.
      5. supervisorctl restart hermes-<userId>.
      6. Poll: dial new WS until success or 30s timeout.
      7. Clear "restarting" flag.
      8. Return 200 with elapsed_ms.
  → webui: spinner overlay "Saving… Restarting your assistant… Ready"
  → Voice clients on this user: see "agent.restarting" presence state; UI shows same spinner.
  → Other users: unaffected — their Hermes processes never touched.
```

**Active-personality edge case:** if a PUT modifies the personality whose body currently matches `agent.system_prompt` (i.e., it's active), the gateway re-fires `/personality <name>` after the restart so the new body becomes active. One spinner, end state correct.

**SOUL.md content scanning:** Hermes' `prompt_builder.py` scans for `_CONTEXT_THREAT_PATTERNS` (prompt-injection markers, hidden divs, exfil patterns). On a hit, Hermes loads `[BLOCKED: SOUL.md contained …]` placeholder. v1 trusts the loader and does not pre-validate gateway-side; the user notices via assistant behavior. Surfacing BLOCKED state in webui = future polish.

## 9. Phase 7.5 retirement & component changes

### Retired

| Component | Reason |
|---|---|
| `gateway/src/admin/hermes-pool-reconciler.ts` (+ test) | Lifecycle owned by supervisord. Replaced by new `supervisord-control.ts`. |
| `gateway/src/admin/hermes-container-spec.ts` (+ test) | We don't build per-user containers. |
| `gateway/src/admin/profile-dir-migration.ts` (+ test) | If shipped — migration is now "render supervisord program + start"; data layout unchanged. |
| `gateway/src/infrastructure/docker-control.ts` `create/start/stop/remove/inspect` extensions (+ tests) | Lifecycle moved out of docker engine. Keep `restart` if any non-Hermes consumer remains; otherwise retire. |
| `deploy/docker/hermes/Dockerfile.slim` and surrounding files | Replaced by `deploy/hermes-overlay/Dockerfile`. |
| `deploy/docker/secrets/hermes_api_key_*` | One `SENTIENT_GATEWAY_TOKEN` replaces all per-user keys. |
| `hermes-alice` / `hermes-bob` / `hermes-family` services in `deploy/docker/docker-compose.yml` | Replaced by single `sentient-hermes` service. |
| `/var/run/docker.sock` mount on Bun gateway container | No longer needed there. |

### Kept (with small amendments)

| Component | Amendment |
|---|---|
| `gateway/src/admin/secrets-store.ts` | Unchanged. Provider keys (OpenRouter/Fish/etc.) still gateway-owned. |
| `gateway/src/admin/internal-secrets-store.ts` | Now stores `SENTIENT_GATEWAY_TOKEN` (single shared token), no longer per-user Hermes API keys. |
| `gateway/src/admin/user-provisioner.ts` | `createUser` now writes a supervisord program via the new control module. `deleteUser` removes it. |
| `gateway/src/admin/slot-allocator.ts`, `slot-binding-store.ts` | Slot key is now a supervisord program identifier (e.g. `hermes-alice`) rather than a docker container name. Each binding also records the per-profile WS port. |
| `gateway/src/admin/archive-user-dir.ts`, `boot-migration.ts` | Unchanged. |
| `gateway/src/profile-store/profile-renderer.ts` | Also renders the supervisord program (in addition to SOUL.md / config.yaml). |
| `gateway/src/apply/orchestrator.ts` | Calls `supervisord-control.restartProfile(userId)` instead of `dockerControl.restart`. |
| All Phase 7 webui admin panels (Members + System) | Unchanged. |
| Auth perimeter (PASETO, sessions, allowlists) | Unchanged. |

### New components

| Component | Purpose |
|---|---|
| `gateway/src/admin/supervisord-control.ts` (+ test) | Wrapper over supervisorctl: render-program / reread / update / restart / status. Talks over a Unix socket bind-mounted from the overlay container. |
| `gateway/src/hermes-adapter-client/` (new dir) | Bun-side WS client. One connection per running profile, reconnect, frame-to-internal-event translation. Replaces the `/v1/responses` SSE consumer in `gateway/src/cerebrum/hermes-client.ts`. |
| `gateway/src/profile-store/supervisord-program.tmpl` | Per-user supervisord program template (program name, command, env, autorestart). |

## 10. Migration (one-shot, on first boot after this lands)

1. Stop existing Hermes containers: `docker compose stop hermes-alice hermes-bob hermes-family && docker compose rm -f hermes-*`.
2. Build overlay image: `docker build deploy/hermes-overlay -t sentient/hermes:local`.
3. Update `deploy/docker/docker-compose.yml`: drop per-user Hermes services; add single `sentient-hermes` service.
4. Boot Bun gateway. Boot-migration step renders one supervisord program per existing user into `/data/supervisor/programs/`.
5. Boot overlay container: supervisord starts; spawns one `hermes -p X gateway run` per program.
6. Bun gateway dials each program's adapter WS; once connected, normal operation resumes.
7. Cleanup: drop `deploy/docker/secrets/hermes_api_key_*`, drop `/var/run/docker.sock` from gateway service.

Idempotent: re-running on an already-migrated system is a no-op.

## 11. Maintenance strategy

- **Pin** Hermes version in `deploy/hermes-overlay/HERMES_VERSION`. Bumped deliberately, never auto-tracked.
- **Patches** in `deploy/hermes-overlay/patches/`. CI image build fails if any patch doesn't apply — that's the rebase signal.
- **Rebase workflow on version bump:** read each failing patch's target file at the new tag; manually apply equivalent change; save new patch via `diff -u`. Worst case 1–2h on a major release given how surgical the patches are.
- **Future improvement:** scheduled GitHub Action diffing upstream `HEAD` against `HERMES_VERSION` and opening an issue when any patched file changes upstream. Deferred — not blocking v1.

## 12. Verification & UX validation approach

The implementation plan derived from this spec **must** include, as an explicit final task:

1. Build the overlay image; verify all 5 patches apply cleanly.
2. Boot the full local docker stack (Bun gateway + sentient-hermes + STT + ha-mcp + egress proxy).
3. Use **Chrome DevTools MCP** to drive the webui as a real user would, exercising:
   - Login + onboarding flow.
   - SOUL.md edit → save → spinner → reconnect → verify new SOUL is active (e.g., assistant responds in the new persona).
   - Personality add → save → spinner → reconnect → select via dropdown → verify behavior changed without restart.
   - Personality edit on currently-active entry → verify edge-case (auto re-fire of `/personality` after restart).
   - Personality delete → spinner → reconnect → verify entry gone from dropdown.
   - Send a real conversation that triggers tool calls (e.g., "what's the weather"); verify `tool.start` / `tool.end` events render in the webui's tool-progress UI.
   - Trigger barge-in mid-response; verify cycle aborts cleanly.
4. **Be critical.** Every spinner that lingers, every console error, every UI element that flickers or jumps, every confusing copy string — file as a finding, then fix before declaring done. The plan should not allow "feature works at all" to be confused with "feature is good." UX/UI iteration is the work.

## 13. Risks

| Risk | Mitigation |
|---|---|
| supervisorctl reach across containers | Bind-mount `/data/supervisor/supervisor.sock` from overlay into gateway container (rw). |
| `terminal.backend: docker` still requires `/var/run/docker.sock` | Mounted on the overlay container only. Net neutral vs. today (gateway no longer needs it). |
| Restart hangs (program won't come back) | 30s timeout in `supervisord-control.ts`; webui surfaces failure with logs link; other users unaffected. |
| Patch rebase pain on Hermes upgrades | Patches are surgical (enum entries, factory branches, dict additions). CI watcher (deferred) front-loads warnings. |
| Single overlay image is large (≈8 GB) | Pi 5 has plenty of disk; one image vs. N copies in Phase 7. Net neutral. |
| Per-token streaming missing → first-audio latency may rise vs. `/v1/responses` SSE | Bun's existing sentence aggregator absorbs this; acceptable for v1; explicit future work. |
| BLOCKED-SOUL not surfaced in webui | User notices via assistant behavior; v2 surfaces explicitly. |

## 14. Deferred (explicit out-of-scope list)

- Per-token streaming for `assistant.message` (additive WS protocol change — new `assistant.partial` frame).
- Cron / proactive delivery (`tools/send_message_tool.py`, `cron/scheduler.py` integration).
- ESP32 satellite devices.
- Steward agent (v1.5+ in v4 cerebrum spec).
- The 8 deferred Hermes integration points (recorded in `deploy/hermes-overlay/README.md`): `PLATFORM_HINTS`, `SessionSource` extras, cron, send_message routing, `channel_directory`, `redact`, status display, setup wizard.
- Personality versioning / undo / live preview.
- BLOCKED-SOUL detection surfaced in webui.
- CI watcher on upstream Hermes commits.

## 15. Open implementation questions (handed to the plan)

These are deliberately left for the writing-plans phase to resolve, not the spec:

1. Exact wire layout of the `hermes-adapter-client` Bun module — file split, where reconnect logic lives, how tool-frame translation maps to existing internal cerebrum events.
2. Whether `gateway/src/cerebrum/hermes-client.ts` is replaced wholesale or wrapped (depends on call-site count).
3. Whether the supervisord Unix socket bind-mount needs a sidecar service for permissions, or works cross-container as-is on macOS Docker / Linux Pi.
4. Test coverage choices per `.claude/rules/testing.md`'s test-lean doctrine: which boundaries pin (1) wire/protocol contract, (2) FSM/invariant, (3) security, (4) `@live`/browser-smoke. Current best guesses: (1) WS frame schema + adapter MessageEvent construction; (2) restart state machine; (3) WS auth; (4) the Chrome-DevTools-MCP UX flow itself.
