# SearXNG + Fetch MCP — Web Search Replacement and Built-In MCP Reorg

**Date:** 2026-05-08
**Status:** Spec — pending implementation plan
**Branch (planned):** `feature/searxng-fetch-mcp-reorg`

## Summary

Replace the DuckDuckGo MCP (rate-limited, single engine) with a self-hosted SearXNG metasearch backend plus a small `searxng-mcp` HTTP adapter. Add a separate `fetch-mcp` (URL → cleaned markdown) so search and fetch are decoupled. Concurrently, relocate all built-in MCP source trees from `deploy/docker/mcp/<name>/` to `gateway/mcp/<name>/` so the gateway co-locates the MCPs it orchestrates.

Both changes ship as a single feature branch, integrated via existing boot-phase migrators (no operator wizard re-run required on upgrade).

## Motivation

- **Rate limit relief.** The DDG MCP (`duckduckgo-mcp-server` pip package) hits soft 429s during family burst (3+ users querying simultaneously). Each query = exactly one DDG call; no fanout, no fallback.
- **Engine diversity.** SearXNG fans each query out across N upstream engines (Bing, DDG, Wikipedia, Mojeek, Qwant, etc.) in parallel. A single engine going dark (Google CAPTCHA, Startpage anti-bot) does not break a query — other engines still return results.
- **Fetch capability is orthogonal.** The DDG MCP also exposes `fetch_content`. SearXNG itself is metasearch only. Without a dedicated fetch MCP, dropping DDG would lose the ability to read full article content (only snippets remain). A standalone `fetch-mcp` (Anthropic's `mcp-server-fetch`) cleanly separates these concerns.
- **Source-tree clarity.** Today: `deploy/docker/mcp/{ddg,ma}-mcp/` (build artifacts living next to deployment scripts) plus `deploy/searxng/` (config for an unstarted service) plus `gateway/templates/services/{ddg,ma,ha}-mcp.yaml` (compose templates). The gateway is what spawns and supervises these containers, so the source belongs under `gateway/mcp/`. Reorg consolidates ownership.

## Non-Goals

- Phase-3 SearXNG migration plan from `docs/superpowers/plans/2026-04-21-hermes-phase1.6-web-tools.md` — superseded by this spec.
- Engine-specific routing tools (`search_reddit`, `search_stackoverflow`, etc.) — single `web_search` tool only. SearXNG fanout already hits these engines as part of normal queries.
- Bang-syntax exposure to the model — model uses plain queries, SearXNG handles routing.
- Pi smoke beyond container-up + log check (per `.claude/rules/e2e-testing.md`).
- Engine selection UI / per-user search preferences. Not a v1 concern.

## Architecture

### Containers After Change

| Container | Image | Network | Purpose |
|---|---|---|---|
| `searxng` | `searxng/searxng:latest` (upstream) | `sentient-internal` | Metasearch backend. Listens 8080. No MCP surface. |
| `searxng-mcp` | `sentient/searxng-mcp:local` (built) | `sentient-internal` | MCP HTTP transport over SearXNG. Listens 8087. Single tool: `web_search`. |
| `fetch-mcp` | `sentient/fetch-mcp:local` (built) | `sentient-internal` | MCP wrapping `mcp-server-fetch`. Listens 8088. Single tool: `fetch`. |
| `ma-mcp`, `ha-mcp`, `egress-proxy`, `gateway`, `hermes`, `stt-service` | unchanged | unchanged | unchanged |
| ~~`ddg-mcp`~~ | — | — | **Removed.** |

**Net delta:** -1 container (ddg-mcp), +3 containers (searxng + searxng-mcp + fetch-mcp). Memory: ~+128 MB on a Pi 5 with 8 GB. Acceptable.

### Egress Flow

```
searxng-mcp ──▶ searxng ──▶ egress-proxy:3128 ──▶ {google,bing,ddg,wikipedia,mojeek,qwant,...}
fetch-mcp   ─────────────▶ egress-proxy:3128 ──▶ arbitrary URLs
```

Both MCPs join `sentient-internal` only. Outbound exits via `egress-proxy` per the existing pattern.

### Tool Surface (Visible to Hermes / Model)

- **`web_search(query: string, max_results?: number)`** — "Search the public web. Returns title/url/snippet ranked across multiple engines (Bing, DuckDuckGo, Wikipedia, Mojeek, etc.). Use for current events, opinions, restaurants, definitions, anything outside trained knowledge."
- **`fetch(url: string, max_length?: number, start_index?: number)`** — "Fetch a URL and return cleaned page text as markdown. Use after web_search to read full article content. Supports pagination via start_index."

Single `web_search` tool only — no per-engine variants. SearXNG fanout already covers Reddit, StackOverflow, Wikipedia, GitHub via configured engines. Splitting into multiple tools would inflate the catalog without measurable routing benefit at this scale.

## Data Flow

### Web Search End-to-End

```
User voice → STT → Hermes LLM
         → tool_call: web_search(query="best italian restaurants in seattle")
         → MCP transport (HTTP) over sentient-internal
         → searxng-mcp:8087
         → adapter forwards to searxng:8080/search?q=...&format=json
         → searxng fans out in parallel: bing, ddg, qwant, mojeek, wikipedia, ...
         → each upstream call exits via egress-proxy:3128
         → searxng aggregates + dedupes + ranks
         → searxng-mcp returns JSON [{title, url, snippet}, ...] to Hermes
         → Hermes synthesizes answer or chains fetch
```

### URL Fetch End-to-End

```
Hermes LLM
  → tool_call: fetch(url="https://example.com/article")
  → MCP transport over sentient-internal
  → fetch-mcp:8088
  → fetch-mcp uses HTTP_PROXY=egress-proxy:3128
  → upstream HTML → readabilipy → markdown
  → returns text (sliced to max_length, paginated via start_index)
```

## Components

### A. `gateway/mcp/searxng/`

**Files:**
- `settings.yml` — moved from `deploy/searxng/settings.yml`. Key changes:
  - `secret_key: "${SEARXNG_SECRET}"` (env-resolved at container start, populated by gateway from `internal-secrets.json`).
  - `limiter: false` — kept off; internal-only network, no public surface.
  - Engine list: `duckduckgo`, `bing`, `startpage`, `qwant`, `wikipedia`, `mojeek`, `github`, `arxiv`. Drop `reddit` and `stackoverflow` if smoke shows scrape fragility (re-evaluate).
- `README.md` — rewritten; the "Phase 3+ upgrade" framing no longer applies (this IS that upgrade).

**No Dockerfile** — uses upstream `searxng/searxng:latest`.

**Service template:** `gateway/templates/services/searxng.yaml` — references upstream image, mounts `gateway/mcp/searxng/settings.yml` into the container at `/etc/searxng/settings.yml`, binds `${SEARXNG_SECRET}`.

### B. `gateway/mcp/searxng-mcp/`

**Files:**
- `Dockerfile` — Python 3.13-slim base, installs the chosen `mcp-searxng` adapter package pinned by version, exposes 8087 HTTP MCP transport. Same shape as today's `ddg-mcp/Dockerfile`.
- Inline `CMD` overrides any hardcoded host/port in the upstream package (mirrors the DDG MCP pattern).

**Image:** `sentient/searxng-mcp:local`. **Listens:** 8087.
**Env:** `SEARXNG_URL=http://searxng:8080`.
**Network:** `sentient-internal` only.
**Service template:** `gateway/templates/services/searxng-mcp.yaml`.

### C. `gateway/mcp/fetch-mcp/`

**Files:**
- `Dockerfile` — Python 3.13-slim, installs `mcp-server-fetch` (Anthropic, pinned), exposes 8088 HTTP MCP transport.

**Image:** `sentient/fetch-mcp:local`. **Listens:** 8088.
**Env:** `HTTP_PROXY=http://sentient-egress-proxy:3128`, `HTTPS_PROXY=...`, `NO_PROXY=localhost,127.0.0.1`.
**Network:** `sentient-internal` only.
**Service template:** `gateway/templates/services/fetch-mcp.yaml`.

### D. Removed

- `deploy/docker/mcp/ddg-mcp/` (whole dir).
- `gateway/templates/services/ddg-mcp.yaml`.
- `mcp_servers.duckduckgo` block in `gateway/config.yaml`.
- `mcp_catalog.ddg-mcp` block in `gateway/config.yaml`.
- `"duckduckgo"` enum value + `duckduckgo` config block in `shared/config/src/schemas/hermes-config.ts`.

### E. Moved (no logical change)

- `deploy/docker/mcp/ma-mcp/` → `gateway/mcp/ma-mcp/` (Dockerfile + entrypoint.py).
- `deploy/searxng/` → `gateway/mcp/searxng/`.

### F. Unchanged

- `ha-mcp` — uses upstream `ghcr.io/homeassistant-ai/ha-mcp:stable`. No Dockerfile to move. Template `gateway/templates/services/ha-mcp.yaml` is touched only insofar as the catalog is reviewed during the wider refactor.

## Migration Strategy

The gateway already has a boot-phase migrator pattern (`gateway/src/bootstrap/phase-services.ts`). All upgrade-time work slots into existing infra; **no operator wizard re-run is required for an in-place upgrade.**

### Secret Key Migration (internal-secrets-store)

Existing file: `gateway/src/admin/internal-secrets-store.ts`. Today, schema v1 holds `hermesAuthToken: string`. Bump to v2:

```ts
interface InternalSecretsV2 {
  schemaVersion: 2;
  hermesAuthToken: string; // 64-char hex
  searxngSecret: string;   // 64-char hex
}
```

`migrate(raw)` detects v1 by absence of `searxngSecret`, generates a fresh 32-byte random hex, persists v2. Idempotent — second boot is a no-op. The service template `searxng.yaml` references `${SEARXNG_SECRET}`, populated from the loaded internal-secrets cache (same pattern as `${HERMES_AUTH_TOKEN}`).

### Profile-Config Migration (`duckduckgo` → `searxng`)

New module: `gateway/src/profiles/web-tools-migrator.ts`. At boot, before service start:

1. Enumerate profile configs at `~/.sentient/gateway/profiles/<name>/config.yaml`.
2. For each config, parse `web_tools.provider`. If `"duckduckgo"`, rewrite to `"searxng"`.
3. Atomically write back. Log `migration.web-tools-provider { profile, from: "duckduckgo", to: "searxng" }`.
4. Already-migrated configs (already `"searxng"`) → no-op.

Wired into `gateway/src/bootstrap/phase-services.ts` BEFORE service-start phase, alongside existing `migrateUnboundUsers` and similar boot-phase migrators.

### Schema Tightening

After the profile migrator runs at every boot, the `provider` enum in `shared/config/src/schemas/hermes-config.ts` can drop `"duckduckgo"` entirely. The migrator is the only path that ever sees the legacy value; downstream code only ever sees `"searxng"`. The `duckduckgo` config block (separate from the enum) is removed at the same time.

## Error Handling

| Failure | Behavior |
|---|---|
| Single SearXNG engine 429 / blocked | SearXNG marks engine dead for that query. Other engines carry the result. No error surfaced to model. |
| All engines fail simultaneously | SearXNG returns empty results array. `searxng-mcp` returns `[]`. Model decides: retry, rephrase, or surface "no results." |
| `searxng` container down | `searxng-mcp` returns MCP error. Hermes propagates as tool error. Cycle terminates clean. |
| `searxng-mcp` container down | Gateway MCP transport returns connect error. Hermes tool registry marks `web_search` unavailable for the cycle. |
| `fetch-mcp` URL > `max_length` | Returns first chunk + `next_start_index`. Model paginates via subsequent calls. |
| `fetch-mcp` non-HTML / paywall / 4xx | Returns whatever `readabilipy` salvages (often empty). Model surfaces "couldn't read." |
| Boot migration: profile config malformed (non-YAML) | Migrator logs `migration.parse-error { profile, reason }`, skips that profile, continues. Operator-fixable; not a hard fail. |
| Boot migration: internal-secrets file corrupt | Existing `loadOrInit` returns `{ kind: "corrupt-file" }` per current contract. Gateway boot fails loud (matches today's behavior). Operator must restore from backup or wipe. |

## Container Startup Ordering

- `searxng-mcp` `depends_on: [searxng]` (with healthcheck wait — must serve 200 on `/healthz` or TCP-reachable on 8080).
- `searxng` `depends_on: [egress-proxy]`.
- `fetch-mcp` `depends_on: [egress-proxy]`.

Healthchecks: TCP probe on listen port for each MCP. Pi compose pattern already in place for `ddg-mcp`; reuse.

## Configuration Changes

**`gateway/config.yaml`:**

```yaml
web_tools:
  provider: searxng    # was: duckduckgo
  searxng:
    enabled: true

mcp_servers:
  # duckduckgo block: REMOVED
  searxng:
    transport: http
    url: http://sentient-searxng-mcp:8087/mcp
    timeout: 30
    connect_timeout: 5
    description: SearXNG metasearch web search.
  fetch:
    transport: http
    url: http://sentient-fetch-mcp:8088/mcp
    timeout: 30
    connect_timeout: 5
    description: Fetch URL contents as markdown.

mcp_catalog:
  # ddg-mcp block: REMOVED
  searxng:
    template: searxng.yaml
    allowed_images: ["searxng/searxng:latest"]
    networks: ["sentient-internal"]
    healthcheck:
      tcp: "sentient-searxng:8080"
      timeout_ms: 30000
    depends_on: ["egress-proxy"]
    optional: false
  searxng-mcp:
    template: searxng-mcp.yaml
    allowed_images: ["sentient/searxng-mcp:local"]
    networks: ["sentient-internal"]
    healthcheck:
      tcp: "sentient-searxng-mcp:8087"
      timeout_ms: 30000
    depends_on: ["searxng"]
    optional: false
  fetch-mcp:
    template: fetch-mcp.yaml
    allowed_images: ["sentient/fetch-mcp:local"]
    networks: ["sentient-internal"]
    healthcheck:
      tcp: "sentient-fetch-mcp:8088"
      timeout_ms: 30000
    depends_on: ["egress-proxy"]
    optional: false
```

**`gateway/mcp-policy.yaml`:** drop DDG tool allowlist, add `web_search` and `fetch` tool allowlist.

## Path Rewrites

| File | Old | New |
|---|---|---|
| `deploy/pi/docker-compose.yml` | `context: ../docker/mcp/ma-mcp` | `context: ../../gateway/mcp/ma-mcp` |
| `deploy/pi/docker-compose.yml` | `ddg-mcp` build block | drop; add `searxng-mcp` (`context: ../../gateway/mcp/searxng-mcp`) and `fetch-mcp` (`context: ../../gateway/mcp/fetch-mcp`) |
| `deploy/docker/docker-compose.yml` | comment line 3 (`ha-mcp, ma-mcp, ddg-mcp`) | `ha-mcp, ma-mcp, searxng, searxng-mcp, fetch-mcp` |
| `deploy/setup-prod.py` | line 181 build prompt label | drop `ddg-mcp`; add `searxng-mcp`, `fetch-mcp` |
| `gateway/config.yaml` | path comments + `web_tools.provider` + `mcp_servers.duckduckgo` + `mcp_catalog.ddg-mcp` | path comments → `gateway/mcp/...`; new entries per above |
| `gateway/templates/services/` | `ddg-mcp.yaml` | delete; add `searxng.yaml`, `searxng-mcp.yaml`, `fetch-mcp.yaml` |
| `gateway/mcp-policy.yaml` | DDG tool allowlist | drop; add searxng + fetch tool allowlist |
| `shared/config/src/schemas/hermes-config.ts` | `provider: z.enum(["duckduckgo", "searxng"])` + `duckduckgo` block | drop `"duckduckgo"` enum value; drop `duckduckgo` config block |
| `.claude/rules/gateway/mcp-deployment.md` | `deploy/docker/mcp/<name>/Dockerfile` standard | `gateway/mcp/<name>/Dockerfile` |
| `agents/docs/gateway/mcp-deployment-details.md` | `context: ../mcp/ddg-mcp` examples + path text | `context: ../../gateway/mcp/<name>` |
| `gateway/src/admin/internal-secrets-store.ts` | schema v1, `hermesAuthToken` only | schema v2, add `searxngSecret`, migrate v1→v2 |
| `gateway/src/profiles/web-tools-migrator.ts` | — | NEW boot-phase migrator |
| `gateway/src/bootstrap/phase-services.ts` | existing migrator wiring | wire `web-tools-migrator` before service-start phase |

## Testing

### Unit Tests (vitest, no live deps)

- `internal-secrets-store.test.ts` — extend. v1→v2 migrate path: persisted v1 file → `loadOrInit` → `searxngSecret` materialized + persisted. Idempotency check (second `loadOrInit` is a no-op).
- `web-tools-migrator.test.ts` (new) — fixture profile config with `provider: duckduckgo` → migrator rewrites to `searxng`, leaves other keys untouched. Idempotency check on already-migrated config. Malformed YAML → logs and skips.
- Schema test on `hermes-config.ts` — zod schema rejects `duckduckgo` post-tightening.

### Skip (per `.claude/rules/testing.md`)

- searxng-mcp adapter wire test (covered in smoke).
- fetch-mcp adapter wire test (covered in smoke).
- SearXNG container itself (upstream image, not our surface).
- Tool description string match (copy strings excluded by testing rules).

### E2E Smoke (Playwright MCP, real running stack)

Drive against local Docker (`deploy/macos/`). All cases run on both desktop (1280×900) and mobile-sized (390×844) viewports.

| # | Surface | Case | Read-only verify |
|---|---|---|---|
| 1 | searxng-mcp | "search for italian restaurants in seattle" | `web_search` lands; multi-engine fanout in `searxng` logs; TTS reads results |
| 2 | fetch-mcp | "read me this article: <known URL>" | `fetch` lands; cleaned markdown returned; TTS reads summary |
| 3 | search → fetch chain | "find latest news about X and read top result" | Both tools chain in one cycle |
| 4 | searxng-mcp failure | stop `searxng` container mid-query | Tool error surfaces clean; no hang; cycle terminates |
| 5 | ha-mcp | "what's my current home status" / "are any lights on" | `ha_get_state` / `ha_search_entities` lands; entities returned; no state change |
| 6 | ha-mcp | "what's the temperature in the living room" | `ha_get_state` for sensor entity; value returned |
| 7 | ma-mcp | "what music players do I have" | MA list-players read; player array returned; no playback change |
| 8 | ma-mcp | "what's currently playing" | MA now-playing read; track or idle returned; no playback change |
| 9 | Boot migration: secret | pre-populate `internal-secrets.json` with v1 schema, start gateway | Migration runs; v2 written; SearXNG starts with generated secret; query succeeds |
| 10 | Boot migration: profile | pre-populate profile config with `provider: duckduckgo`, start gateway | Migrator rewrites; log line confirms; web search works |
| 11 | Container health | `docker ps` after `compose up -d` | All containers healthy in 30s: gateway, hermes, stt-service, ma-mcp, ha-mcp, searxng, searxng-mcp, fetch-mcp, egress-proxy |

**Read-only discipline (cases 5–8):** never call HA `call_service` or any MA playback control. The smoke run does not change family-environment state.

**Pre-handover gate (per `.claude/rules/e2e-testing.md`):**

- All cases green on both viewports.
- `bun run ci` clean.
- `docker compose up -d` brings new stack up clean.
- `searxng` container healthcheck passing within 30s.
- No unexpected WARN/ERROR in `gateway/logs/`.

## Commit Plan (single feature branch)

1. `refactor(mcp): move built-in MCPs to gateway/mcp/` — pure file moves + path updates. No behavior change. Builds clean.
2. `feat(mcp): add searxng + searxng-mcp + fetch-mcp` — Dockerfiles, templates, catalog entries.
3. `feat(secrets): searxng secret v2 schema migration` — `internal-secrets-store` extension + tests.
4. `feat(profiles): web-tools provider migrator (duckduckgo → searxng)` — migrator + wire-in + tests.
5. `feat(config): swap web_tools.provider default to searxng, drop ddg` — schema + config + catalog wiring.
6. `chore(deploy): update Pi compose + setup-prod.py + docs for new MCP set` — final reference cleanup, ddg-mcp removal.

Branch merges to `develop` after smoke green. `main` untouched.

## Open Questions

None at spec time. Engine list final selection (Reddit / StackOverflow keep-or-drop) is a tunable inside the SearXNG settings file and can be revised post-smoke without code change.

## References

- `.claude/rules/gateway/mcp-deployment.md` — MCP deployment standard (will be updated as part of this work).
- `agents/docs/gateway/mcp-deployment-details.md` — MCP deployment rationale.
- `docs/superpowers/plans/2026-04-21-hermes-phase1.6-web-tools.md` — original Phase-3 plan (superseded).
- `gateway/src/admin/internal-secrets-store.ts` — secret persistence pattern this spec extends.
- `gateway/src/bootstrap/phase-services.ts` — boot-phase migrator wiring point.
- `gateway/src/sessions/storage-migrator.ts` — existing boot-phase migrator (pattern reference).
