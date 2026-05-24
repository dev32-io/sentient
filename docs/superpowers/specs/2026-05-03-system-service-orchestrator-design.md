# System Service Orchestrator Design

**Status:** Approved (brainstorm 2026-05-03)
**Author:** Kevin Ye + Claude Opus 4.7
**Scope:** Single subproject — gateway-owned lifecycle of all shared service containers (everything except per-user hermes workers).

---

## Goal

Give the gateway full ownership of the lifecycle of every shared service container in the deployment. The gateway becomes the single source of truth for what services run, what versions, with what secrets, in what dependency order. Compose's role shrinks to bringing up the gateway alone.

This solves four problems simultaneously:

1. **Race-free bootstrap.** Setup wizard writes secrets, then triggers system bringup. No chicken-and-egg between `compose up` and operator-supplied tokens.
2. **No CLI scripts at install.** A `docker compose up -d` is the only command an operator runs. Everything else is wizard-driven.
3. **Settings-driven reconfiguration.** Rotating an HA/MA token in Settings restarts only the affected containers via the same code path used for bootstrap.
4. **Clean separation of concerns.** Per-user orchestrator (existing) keeps owning hermes worker lifecycle. The new orchestrator owns deployment-shared infra. Two orchestrators with non-overlapping scopes.

## Architecture

Two orchestrators, one apply path.

- **Per-user orchestrator** (existing, `gateway/src/apply/orchestrator.ts`) — owns per-user supervisord program lifecycle inside `sentient-hermes`. Renders per-user hermes config, restarts `hermes-<userId>`, fires `/reset`. Scope: anything keyed by userId.
- **System orchestrator** (new, `gateway/src/system-orchestrator/`) — owns lifecycle of every shared container via the docker socket. Templates baked into the gateway image. Boots services at gateway startup; recreates services on system-secret change.
- **Apply router** (new, `gateway/src/apply/router.ts`) — single `POST /api/v1/apply` endpoint. Validates submitter, splits the config blob into user-level vs. system-level diffs, runs RBAC gate, dispatches each diff to its orchestrator. Returns unified apply state.

```
            webui
              │ POST /apply  { user-level..., system-level... }
              ▼
        ┌─ apply router ─┐
        │  • auth check   │
        │  • split blob   │
        │  • RBAC gate    │
        └────┬───────┬────┘
             │       │
       user-level    system-level
             ▼       ▼
       per-user      system
       orch (exist)  orch (new)
             │       │
             ▼       ▼
       supervisord   docker socket
       per-user      managed containers
       hermes        (egress, hermes container,
                      stt, ddg, ha, ma)
```

The webui is scope-blind. It submits a config blob and reads unified apply state. Privilege enforcement lives entirely in the gateway. A non-admin who hand-crafts a request body containing a system-level field is rejected at the router, never reaching the orchestrator.

## Compose footprint after this work

```yaml
services:
  gateway:
    # ... (image, healthcheck, mounts including docker socket)

networks:
  sentient-internal: { internal: true }
  sentient-external:

volumes:
  sentient-supervisor:
```

Approximately 30 lines. Every other service moves into a gateway-baked template.

## Components

### `gateway/src/system-orchestrator/`

| File | Responsibility |
|------|----------------|
| `service-registry.ts` | Loads `gateway/config.yaml#managed_services` + baked templates. Returns typed `ManagedService[]`. Validates each entry against allowlist (image, networks, no host ports). |
| `template-loader.ts` | Reads `gateway/templates/services/<name>.yaml`. Substitutes `${SECRET}` placeholders from secrets-store. Validates result before handing to docker. |
| `docker-driver.ts` | Thin dockerode wrapper. Methods: `inspect`, `recreate`, `start`, `stop`, `pollHealthy`, `listManaged`. Enforces label `sentient.managed=true` on every create. Rejects specs with port bindings or non-allowlisted networks. |
| `dep-graph.ts` | Topological sort over `depends_on`. Computes start/restart order. Detects cycles at boot. |
| `orchestrator.ts` | State machine: `idle → planning → applying → health-checking → ready/failed`. Drives per-service substates in parallel where deps allow. Emits events for the apply bar. |
| `boot-reconciler.ts` | On gateway start: list `sentient.managed=true` containers; kill any not in registry (orphans); start required services. |
| `secret-binding.ts` | Maps `secret-kind → affected services`. Decides which services to recreate when a secret changes. |
| `health.ts` | Per-service health probe (HTTP, TCP, exec). Polls until healthy or timeout. |

### `gateway/src/apply/router.ts` (new)

Single endpoint for all apply operations. Splits incoming blob into user-level + system-level diffs, runs RBAC gate, dispatches.

### `gateway/templates/services/*.yaml` (new, baked)

One template per managed service: `egress-proxy`, `sentient-hermes`, `stt-service`, `ddg-mcp`, `ha-mcp`, `ma-mcp`. Files baked into the gateway image at build time, read-only at runtime. **Never** mounted into any container that hermes can reach.

### `gateway/config.yaml#managed_services` (new section)

Policy layer. For each service, declares:

- `template:` — filename under `templates/services/`
- `allowed_images:` — strict allowlist; image not in list → policy violation
- `networks:` — approved set
- `secrets:` — map of env-var name → secrets-store key path
- `healthcheck:` — `{ url | tcp | exec, timeout_ms }`
- `depends_on:` — list of other managed-service names
- `optional:` — boolean; `true` means service starts only when all required secrets are present

Example:

```yaml
managed_services:
  ha-mcp:
    template: ha-mcp.yaml
    allowed_images: ["ghcr.io/homeassistant-ai/ha-mcp:stable"]
    networks: ["sentient-internal"]
    secrets:
      HOMEASSISTANT_TOKEN: home_assistant.mcp_server_token
      HOMEASSISTANT_URL:   home_assistant.url
    healthcheck:
      url: "http://ha-mcp:8086/health"
      timeout_ms: 30000
    depends_on: [egress-proxy]
    optional: true
```

### Affected existing files

- `deploy/docker/docker-compose.yml` — shrinks to gateway + networks + named volumes.
- `gateway/src/api/handlers/version.ts` — refactored to read health + version from `systemOrchestrator.getRequiredServicesStatus()` instead of the lazy resolver. The lazy resolver introduced in the previous round is removed; the orchestrator becomes the single source of truth.
- `gateway/webui/src/components/wizard/` — new step `step-secrets.tsx` (HA + MA tokens) and new step `step-bringup.tsx` (Starting up services…).
- `gateway/webui/src/components/apply-bar/` — generalized to render N rows of `{name, state, version?}`. Same component used by per-user apply (1 row) and Settings system apply (N rows). Wizard's step-bringup uses its own minimal layout consistent with wizard step look, not the apply bar.
- `gateway/src/profile-store/profile-defaults.ts` — re-added; restores DEFAULT_TOOLS_ENABLED + DEFAULT_TOOLSETS so new users start with the curated MCP/tool selection.

## Setup wizard sequence (with new steps)

1. **unlock**
2. **provider** (LLM key)
3. **voice** (Fish key)
4. **secrets** (NEW — HA URL/tokens + MA URL/token, all optional)
5. **submit** → POST `/api/v1/wizard/finish` → gateway flips `bootstrap_complete=true`, persists secrets, kicks off the system orchestrator's first apply
6. **bringup** (NEW — "Starting up services…", polls orchestrator status, auto-advances when required services are ready)
7. **admin** (existing — first-admin account creation; runs against the now-healthy hermes container)
8. **finish** (existing — "All set" → button → reload into chat)

`step-bringup.tsx`:

- Lives under `gateway/webui/src/components/wizard/steps/`.
- Renders inside wizard chrome (same styling as other steps — `aw-step` shell, sticky footer).
- Footer: "Retry" button visible only when a required service is failed. No Back, no Next. Auto-advances on `all-required-ready`.
- Polls every ~1 s while orchestrator state is non-terminal.

`step-bringup` must precede step-admin because user creation provisions a per-user supervisord program inside `sentient-hermes`, which needs that container running first.

## Data flow

### Boot path (cold start, first time)

1. `docker compose up -d` → only gateway starts. Networks + named volumes are created.
2. Gateway boots. Reads `install-state.yaml`. `bootstrap_complete=false`.
3. Wizard renders at `https://localhost:8888`: unlock → provider → voice → secrets → review.
4. Review → Finish → POST `/api/v1/wizard/finish`. Gateway flips `bootstrap_complete=true`, persists secrets, dispatches first system apply.
5. Webui transitions to `step-bringup`. Polls `GET /api/v1/system/apply-status`. Per-service rows: `pending → starting → health-checking → ready`.
6. All required services `ready` → step-bringup auto-advances to step-admin.
7. Optional service failure → step-bringup still advances; degraded badge surfaces in Settings later.
8. Required service failure → step-bringup stays, shows error row + Retry button. No backward path; the wizard cannot proceed without required deps.

### Boot path (warm start, already bootstrapped)

1. `docker compose up -d` → gateway starts.
2. `boot-reconciler` runs: lists `sentient.managed=true` containers; reaps orphans not in the registry.
3. For each registry entry: if container exists + healthy → leave alone; if exists + unhealthy → restart; if missing → start.
4. Gateway opens to logged-in users immediately if everything healthy.

### Apply path (settings change)

1. UI submits `POST /api/v1/apply` with config blob + JWT.
2. `apply/router.ts`:
   - Auth gate: extract user from JWT.
   - Parse blob → diff against current state.
   - Split: `userLevelChanges` (model, voice, persona, tools.enabled, …) vs `systemLevelChanges` (HA URL, HA tokens, MA URL, MA token, future system fields).
   - **RBAC gate**: if `systemLevelChanges` non-empty AND user not admin → return 403, drop the body.
   - Run per-user orchestrator with `userLevelChanges` (existing path).
   - Run system orchestrator with `systemLevelChanges` — for each changed secret, look up affected services via `secret-binding.ts` and recreate those services in dependency order.
3. Both orchestrators emit progress events. Apply bar reads unified state.
4. On success: response includes a fresh health snapshot for the version sidebar.

### Version + health endpoint

`GET /api/v1/services/version` reads from `systemOrchestrator.getRequiredServicesStatus()`:

```json
[
  { "name": "gateway",         "version": "0.4.0",     "healthy": true },
  { "name": "sentient-hermes", "version": "2026.4.23", "healthy": true },
  { "name": "stt-service",     "version": "2026.5.0",  "healthy": true }
]
```

Optional services are excluded from this list (deferred UX).

## Failure semantics

### Required vs optional

- Required failed → orchestrator state = `failed`. step-bringup blocks. The system-level part of an in-app apply blocks (the user-level part of the same submission still runs to completion — the two orchestrators are independent). Subsequent system applies remain available so the operator can fix and retry.
- Optional failed → orchestrator state stays `ready` if all required are. Service marked degraded. Future Settings UX surfaces this; not designed today.

### Error kinds

| Kind | Cause | Handling |
|------|-------|----------|
| `template-load-error` | YAML parse / file missing / override invalid | Fail the apply, surface `service-name + parse error`. Cannot recover without operator fix. |
| `policy-violation` | Template specifies port binding / disallowed image / disallowed network | Fail apply, log loudly. Means template was tampered with — orchestrator refuses. |
| `secret-missing` | Required secret absent for required service | Fail apply for required; mark optional service as `pending-secrets` (won't start, no degraded). |
| `docker-create-error` | dockerode rejects spec | Mark service failed; preceding state preserved (old container still running if recreate, or absent if first-time). |
| `health-timeout` | container started but never reached healthy | Mark failed (required) / degraded (optional). Logs include last health-check error. |
| `dependency-failed` | upstream service in `depends_on` is failed | Service skipped, marked `blocked-by-dep`. |

### Apply atomicity

Recreate is **not** atomic across services. Each service recreates independently in dep order. If service N succeeds and service N+1 fails, services 1..N stay on new state; N+1+ stay on old. The orchestrator surfaces partial-failure to the UI. There is no automatic rollback. The operator decides via Settings — retry, fix the secret, or restore the previous value.

Single-service recreate IS atomic: stop + remove + create is one orchestrator-level operation; failure leaves either the old or the new container, never half.

### Boot reconciler errors

- Orphan container (labeled but not in registry) → killed unconditionally on boot.
- Registry entry missing image locally → `docker pull` first, then create. Pull failure = service `failed` until next apply.
- Registry entry references network that doesn't exist → fail loudly at boot, surface in apply bar.

### Security failures

- Any spec rejected by the policy gate → never reaches docker. Logged at WARN with full diff.
- Docker socket access lost (e.g., dev mode without socket mount) → orchestrator stays in `idle`, gateway runs in degraded mode (warn banner, no system apply). Per-user apply still works because per-user uses supervisord socket, not docker socket.

### Apply timeout

- Each service has `healthcheck.timeout_ms` from config. Default per-service ~30 s; STT longer because of model load.
- Whole apply has a wall-clock cap. Default 5 min. Exceeded → mark unfinished services failed, return.

## Security model

The hermes worker container is treated as **untrusted**. It already holds the docker socket for spawning per-task sandboxes — anyone who pwns it can launch arbitrary host containers. The orchestrator therefore cannot prevent a sufficiently determined sandbox escape from running custom containers, but it must prevent the orchestrator's own machinery from being a vector.

Defenses:

1. **Templates baked into gateway image.** Read-only at runtime. Inside gateway container only. Hermes mount set is verified to have **zero overlap** with the template directory.
2. **No template files on shared volumes.** Specifically, `sentient-supervisor` named volume (which hermes mounts) does not carry templates. Templates live at `/app/templates/services/` inside gateway, full stop.
3. **Operator override (optional).** If we add an override directory in future (e.g. `/sentient/gateway/templates/`), it lives at a path that is **not** mounted into hermes. Operator change → gateway restart picks it up.
4. **Policy gate at every spec load.** Rejects: `HostConfig.PortBindings` non-empty, image not in `allowed_images`, networks outside approved set, missing `sentient.managed=true` label.
5. **RBAC at apply router.** Non-admin requests with system-level fields → 403. Even if a body is hand-crafted, the orchestrator never sees system-level changes from non-admins.
6. **Docker label requirement.** Every managed container carries `sentient.managed=true` + `sentient.service=<name>`. Boot reconciler relies on these to identify orphans. The orchestrator refuses to operate on containers it didn't create.

## Testing

### Unit tests (no docker required)

| File | Pins |
|------|------|
| `service-registry.test.ts` | Loads `managed_services` from config + matches templates. Rejects entries with disallowed image, port binding, unknown network. Cycle detection in `depends_on`. |
| `template-loader.test.ts` | YAML parse → spec. `${SECRET}` substitution from injected secrets-store stub. Missing required secret → typed error. Missing optional secret → `pending-secrets`. Override file precedence. |
| `dep-graph.test.ts` | Topo sort over registry. Parallelizable cohorts. Cycle detection. `blocked-by-dep` propagation when upstream failed. |
| `secret-binding.test.ts` | `secret-kind → service-set` mapping. Setting `home_assistant.mcp_server_token` returns `[ha-mcp]`. Setting `tts.fish_audio.api_key` returns `[]` (gateway-internal, no recreate). |
| `orchestrator.test.ts` | State-machine transitions. Required failure → `failed`. Optional failure → still `ready`. Partial-success surfaces correctly. Apply timeout enforced. |
| `boot-reconciler.test.ts` | Stub docker driver. Orphan kill (labeled-but-not-in-registry). Re-use healthy. Restart unhealthy. Start missing. |
| `apply-router.test.ts` | Splits blob into user-level + system-level diffs. RBAC: non-admin submits system-level → 403, never reaches orchestrator. Empty diff → no-op. |
| `version.test.ts` | `getRequiredServicesStatus()` shape. Optional services excluded. Cached + invalidated on apply. |

### Integration tests (need docker)

| File | Pins |
|------|------|
| `docker-driver.integration.test.ts` | `@live` only. Real dockerode. Create + label + recreate + remove on a noop alpine container. Reject port-binding spec. Reject non-allowlisted image. |
| `system-bringup.integration.test.ts` | `@live`. Cold start: only gateway up. POST `/wizard/finish` with all secrets → required services come up healthy in dep order. ha-mcp + ma-mcp come up if tokens present. |

### Browser smoke (manual, in `agents/docs/testing-knowledge.md`)

- Wizard cold path: unlock → provider → voice → secrets → submit → bringup spinner shows per-service progress → admin → "All set" → chat works.
- Settings apply (admin): rotate HA token → apply bar shows ha-mcp recreate → green within ~10 s.
- Settings apply (non-admin): non-admin user POSTs system-level field directly → 403, ignored.
- Power-loss recovery: `docker kill sentient-ha-mcp` while gateway runs → reconcile picks up on next apply or boot.
- Orphan reap: `docker run -d --label sentient.managed=true --label sentient.service=fake nginx` → restart gateway → fake container killed.

### Out of scope for tests

- Template file content (operator-authored, validated at load).
- Boot order math beyond cycle detection (verified once, stable).
- dockerode internals.
- Apply bar visuals (visual smoke only).

## Open questions deferred to implementation plan

- Exact wire shape of `GET /api/v1/system/apply-status` (event stream vs poll). Recommend poll for simplicity, ~1 s cadence; revisit if perceived latency is bad.
- Exact format of step-bringup row UI (consistent with wizard step look; precise styling decided when writing the component).
- Background retry policy for degraded optional services (deferred per Q6 — not designed today).
- Operator override directory for templates (omitted from MVP; can be added later without API change).

## Out of scope

- TTS bug (`ttsEnabled=false` in latest run) is a separate diagnosis path. Tracked outside this design.
- Profile defaults restoration is included in this work because the current bootstrap lacks default tools/toolsets, but the implementation is a small standalone change (`profile-defaults.ts` re-added) and does not depend on the orchestrator.
- UX design for optional service failure surfaces (deferred per Q6).
- Multi-host / multi-deployment orchestration. Single-host docker socket only.
