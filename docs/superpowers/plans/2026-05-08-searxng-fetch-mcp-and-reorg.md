# SearXNG + Fetch MCP and Built-In MCP Reorg — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rate-limited DuckDuckGo MCP with self-hosted SearXNG + searxng-mcp adapter, add a fetch-mcp for URL retrieval, and relocate all built-in MCP source trees from `deploy/docker/mcp/<name>/` to `gateway/mcp/<name>/`.

**Architecture:** Three new containers (`searxng`, `searxng-mcp`, `fetch-mcp`) replace the single `ddg-mcp`. Search fans out across multiple upstream engines via SearXNG; fetch runs as an independent MCP via Anthropic's `mcp-server-fetch`. Both join `sentient-internal` only and egress through `egress-proxy`. Per-user state migration runs as a boot-phase migrator alongside existing migrators in `gateway/src/bootstrap/phase-services.ts`. The shared `internal-secrets.json` schema bumps from v1 → v2 to add `searxngSecret`.

**Tech Stack:** Bun/TypeScript gateway, vitest, Python 3.13-slim MCP containers (pip-installed adapter packages), upstream `searxng/searxng:latest`, docker compose, zod schemas in `shared/config/`.

**Spec:** `docs/superpowers/specs/2026-05-08-searxng-fetch-mcp-and-reorg-design.md`

**Branch:** `feature/searxng-fetch-mcp-reorg` (already created and contains the spec commit).

---

## Spec Correction (applies before Task 1)

The spec described profile-config migration as rewriting `web_tools.provider: duckduckgo` → `searxng`. Investigation in `gateway/src/profile-store/profile-types.ts` and `gateway/src/profile-store/profile-defaults.ts` shows the actual per-user state is `profile.tools.enabled` — a `Record<string, string[]>` keyed by MCP-server name. The legacy key is `duckduckgo`; the new keys are `searxng` and `fetch`. The `web_tools.provider` field is single-process gateway-level config in `gateway/config.yaml` (governed by `shared/config/src/schemas/hermes-config.ts`), not per-user. Tasks below reflect that.

---

## Pre-Flight: Verify Upstream Adapter Packages

Per global memory: pinned upstream versions must be verified before grounding work. Two adapter packages back this work; verify both BEFORE Task 5 / Task 6 to fail fast.

- [ ] **Verify `mcp-searxng` adapter availability and version**

  Run:
  ```bash
  pip index versions mcp-searxng 2>&1 || pip install --dry-run mcp-searxng 2>&1 | head -20
  ```
  Expected: a package providing an HTTP MCP transport that wraps a SearXNG `/search?format=json` upstream. If the canonical pip name differs (e.g., `searxng-mcp-server`, `mcp-server-searxng`), record the correct name + latest version in this file under "Resolved Adapter Names" before proceeding.

- [ ] **Verify `mcp-server-fetch` adapter availability and version**

  Run:
  ```bash
  pip index versions mcp-server-fetch 2>&1 || pip install --dry-run mcp-server-fetch 2>&1 | head -20
  ```
  Expected: Anthropic's reference fetch MCP server. Record the resolved name + version.

- [ ] **Record resolved names**

  Edit this section before continuing:

  ```
  Resolved Adapter Names:
  - SearXNG → MCP adapter:  <package-name>==<version>
  - Fetch MCP server:       <package-name>==<version>
  ```

---

## File Structure (final state under `gateway/mcp/`)

```
gateway/mcp/
├── ma-mcp/
│   ├── Dockerfile           (moved from deploy/docker/mcp/ma-mcp/)
│   └── entrypoint.py        (moved)
├── searxng/
│   ├── settings.yml         (moved + edited; secret_key now ${SEARXNG_SECRET})
│   └── README.md            (moved + rewritten)
├── searxng-mcp/
│   └── Dockerfile           (NEW — wraps mcp-searxng adapter)
├── fetch-mcp/
│   └── Dockerfile           (NEW — wraps mcp-server-fetch)
└── README.md                (NEW — index of built-in MCPs)
```

`deploy/docker/mcp/` and `deploy/searxng/` are deleted at end-of-plan.

---

## Task 1: Move `ma-mcp` to `gateway/mcp/ma-mcp/`

**Files:**
- Move: `deploy/docker/mcp/ma-mcp/Dockerfile` → `gateway/mcp/ma-mcp/Dockerfile`
- Move: `deploy/docker/mcp/ma-mcp/entrypoint.py` → `gateway/mcp/ma-mcp/entrypoint.py`
- Modify: `deploy/pi/docker-compose.yml` — update `ma-mcp.build.context`
- Modify: `gateway/config.yaml` — update path comment for ma-mcp

**Steps:**

- [ ] **Step 1: Create the destination directory**

  Run:
  ```bash
  mkdir -p gateway/mcp/ma-mcp
  ```

- [ ] **Step 2: Move ma-mcp source tree using git mv (preserves history)**

  Run:
  ```bash
  git mv deploy/docker/mcp/ma-mcp/Dockerfile gateway/mcp/ma-mcp/Dockerfile
  git mv deploy/docker/mcp/ma-mcp/entrypoint.py gateway/mcp/ma-mcp/entrypoint.py
  ```
  Expected: no stderr; `git status` shows two renames staged.

- [ ] **Step 3: Update Pi compose build context for ma-mcp**

  Edit `deploy/pi/docker-compose.yml`. Locate the `ma-mcp:` service block and change:
  ```yaml
    ma-mcp:
      build:
        context: ../docker/mcp/ma-mcp
  ```
  to:
  ```yaml
    ma-mcp:
      build:
        context: ../../gateway/mcp/ma-mcp
  ```

- [ ] **Step 4: Update path comment in `gateway/config.yaml`**

  In the `mcp_servers.music_assistant` block, change the comment line that reads:
  ```yaml
    # Music Assistant — dockerized HTTP MCP at deploy/docker/mcp/ma-mcp/.
  ```
  to:
  ```yaml
    # Music Assistant — dockerized HTTP MCP at gateway/mcp/ma-mcp/.
  ```

- [ ] **Step 5: Verify ma-mcp still builds**

  Run:
  ```bash
  source scripts/env.sh
  docker compose -f deploy/pi/docker-compose.yml --profile build-only build ma-mcp
  ```
  Expected: build completes successfully; image `sentient/ma-mcp:local` produced (`docker images sentient/ma-mcp:local` shows a fresh entry).

- [ ] **Step 6: Commit**

  Run:
  ```bash
  git add gateway/mcp/ma-mcp/ deploy/pi/docker-compose.yml gateway/config.yaml
  git status
  git commit -m "$(cat <<'EOF'
  refactor(mcp): move ma-mcp to gateway/mcp/ma-mcp/

  Co-locates the MCP container source under the gateway that orchestrates
  it. No behavior change; build context paths updated.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 2: Move SearXNG config tree to `gateway/mcp/searxng/`

**Files:**
- Move: `deploy/searxng/settings.yml` → `gateway/mcp/searxng/settings.yml`
- Move: `deploy/searxng/README.md` → `gateway/mcp/searxng/README.md`
- Modify: `gateway/mcp/searxng/settings.yml` (engine list, secret_key binding)
- Modify: `gateway/mcp/searxng/README.md` (rewritten — no longer "Phase 3+")

**Steps:**

- [ ] **Step 1: Create destination directory and move files**

  Run:
  ```bash
  mkdir -p gateway/mcp/searxng
  git mv deploy/searxng/settings.yml gateway/mcp/searxng/settings.yml
  git mv deploy/searxng/README.md gateway/mcp/searxng/README.md
  ```

- [ ] **Step 2: Edit `gateway/mcp/searxng/settings.yml`**

  Replace the entire file contents with:

  ```yaml
  # SearXNG settings — operator-tunable.
  #
  # Loaded by the searxng container at /etc/searxng/settings.yml.
  # secret_key is resolved from gateway-managed internal secrets at apply time
  # (see gateway/templates/services/searxng.yaml — the ${SEARXNG_SECRET}
  # binding is populated from internal-secrets.json schema v2).
  use_default_settings: true

  server:
    base_url: "http://searxng:8080/"
    secret_key: "${SEARXNG_SECRET}"
    limiter: false   # internal-only network, no inbound public surface

  search:
    formats:
      - html
      - json    # required for the searxng-mcp adapter

  engines:
    - name: duckduckgo
    - name: bing
    - name: startpage
    - name: qwant
    - name: wikipedia
    - name: mojeek
    - name: github
    - name: arxiv
    - name: reddit
    - name: stackoverflow

  ui:
    query_in_title: false
  ```

- [ ] **Step 3: Replace `gateway/mcp/searxng/README.md`**

  Replace the entire file contents with:

  ```markdown
  # SearXNG (built-in metasearch backend)

  Self-hosted SearXNG instance. Backs the `searxng-mcp` adapter (sibling
  directory) which exposes a `web_search` MCP tool to Hermes.

  - Image: `searxng/searxng:latest` (upstream — no Dockerfile here).
  - Network: `sentient-internal` only. Outbound to upstream engines via `egress-proxy`.
  - Config: `settings.yml` mounted at `/etc/searxng/settings.yml`.
  - Secret: `secret_key` resolved from `${SEARXNG_SECRET}` (internal-secrets v2).

  See `gateway/templates/services/searxng.yaml` for the orchestrator
  template, `.claude/rules/gateway/mcp-deployment.md` for the deployment
  standard, and `agents/docs/gateway/mcp-deployment-details.md` for the
  rationale.

  ## Engine list

  See `settings.yml`. The list is the operator-tunable surface for
  search behavior: drop fragile scrape-based engines (e.g. `reddit`
  post-2023) if smoke shows breakage; add engines for new domains
  (e.g. `arxiv` for science).
  ```

- [ ] **Step 4: Remove the now-empty deploy/searxng directory**

  Run:
  ```bash
  rmdir deploy/searxng
  ```
  Expected: directory removed (the two files were the only contents).

- [ ] **Step 5: Commit**

  Run:
  ```bash
  git add gateway/mcp/searxng/ deploy/searxng
  git status
  git commit -m "$(cat <<'EOF'
  refactor(mcp): move searxng config to gateway/mcp/searxng/

  Engine list expanded; secret_key wired to ${SEARXNG_SECRET} for
  population from gateway-managed internal-secrets at apply time. README
  rewritten — no longer describes a deferred Phase-3 upgrade.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 3: Add `internal-secrets-store` v2 schema with `searxngSecret`

**Files:**
- Modify: `gateway/src/admin/internal-secrets-store.ts`
- Modify: `gateway/src/admin/internal-secrets-store.test.ts`

**Steps:**

- [ ] **Step 1: Add a v1→v2 migration test (failing test first)**

  Append to `gateway/src/admin/internal-secrets-store.test.ts`:

  ```ts
  it("migrates a v1 file to v2 by generating searxngSecret on loadOrInit", async () => {
    const file = join(dir, "internal-secrets.json");
    const v1Token = "a".repeat(64);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, hermesAuthToken: v1Token }), { mode: 0o600 });

    const store = createInternalSecretsStore(dir);
    const result = await store.loadOrInit();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hermesAuthToken).toBe(v1Token);
    expect(result.value.searxngSecret).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.hermesAuthToken).toBe(v1Token);
    expect(onDisk.searxngSecret).toBe(result.value.searxngSecret);
  });

  it("returns the existing searxngSecret on subsequent loadOrInit calls (idempotent)", async () => {
    const store = createInternalSecretsStore(dir);
    const a = await store.loadOrInit();
    const b = await store.loadOrInit();
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(b.value.searxngSecret).toBe(a.value.searxngSecret);
  });

  it("generates both tokens fresh on a missing file (v2 schema)", async () => {
    const store = createInternalSecretsStore(dir);
    const result = await store.loadOrInit();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hermesAuthToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.value.searxngSecret).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = JSON.parse(readFileSync(file_in_dir(dir), "utf8"));
    expect(onDisk.schemaVersion).toBe(2);
  });

  it("exposes searxngSecret synchronously after loadOrInit", async () => {
    const store = createInternalSecretsStore(dir);
    await store.loadOrInit();
    expect(store.getSearxngSecretSync()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws from getSearxngSecretSync if loadOrInit was never called", () => {
    const store = createInternalSecretsStore(dir);
    expect(() => store.getSearxngSecretSync()).toThrow(/loadOrInit/);
  });
  ```

  Add at the top of the file (with the other imports):
  ```ts
  import { writeFileSync } from "node:fs";
  ```

  And add this helper above the `describe`:
  ```ts
  function file_in_dir(dir: string): string {
    return join(dir, "internal-secrets.json");
  }
  ```

- [ ] **Step 2: Run test to verify failures**

  Run:
  ```bash
  source scripts/env.sh
  cd gateway && bun run test src/admin/internal-secrets-store.test.ts
  ```
  Expected: the five new tests fail with errors like `searxngSecret is undefined`, `getSearxngSecretSync is not a function`, and `schemaVersion expected 2 but got 1`.

- [ ] **Step 3: Implement v2 schema in `internal-secrets-store.ts`**

  Replace the entire contents of `gateway/src/admin/internal-secrets-store.ts` with:

  ```ts
  import { randomBytes } from "node:crypto";
  import { promises as fs } from "node:fs";
  import { join } from "node:path";
  import type { Result } from "@sentient/protocol";
  import { getLog } from "../logging/logger.js";
  import { writeFileAtomic } from "../user-auth/atomic-write.js";

  const log = getLog(["sentient", "gateway", "admin", "internal-secrets"]);
  const FILE_NAME = "internal-secrets.json";
  const FILE_MODE = 0o600;
  const TOKEN_BYTES = 32;
  const SCHEMA_VERSION = 2;

  export interface InternalSecrets {
    hermesAuthToken: string; // 64-char hex
    searxngSecret: string;   // 64-char hex
  }

  interface PersistedV1 {
    schemaVersion: 1;
    hermesAuthToken: string;
  }

  interface PersistedV2 {
    schemaVersion: 2;
    hermesAuthToken: string;
    searxngSecret: string;
  }

  type Persisted = PersistedV1 | PersistedV2;

  export type InternalSecretsError = { kind: "io-error"; reason: string } | { kind: "corrupt-file"; reason: string };

  export interface InternalSecretsStore {
    loadOrInit(): Promise<Result<InternalSecrets, InternalSecretsError>>;
    getHermesAuthTokenSync(): string;
    getSearxngSecretSync(): string;
  }

  export function createInternalSecretsStore(dataDir: string): InternalSecretsStore {
    const path = join(dataDir, FILE_NAME);
    let cached: InternalSecrets | null = null;

    return {
      async loadOrInit() {
        if (cached) return { ok: true, value: cached };
        try {
          let raw: string;
          try {
            raw = await fs.readFile(path, "utf8");
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            raw = "";
          }
          if (raw !== "") {
            const parsed = JSON.parse(raw) as Persisted;
            if (typeof parsed.hermesAuthToken !== "string" || !/^[0-9a-f]{64}$/.test(parsed.hermesAuthToken)) {
              return { ok: false, error: { kind: "corrupt-file", reason: "invalid hermesAuthToken" } };
            }
            const hermesAuthToken = parsed.hermesAuthToken;
            let searxngSecret: string;
            if (parsed.schemaVersion === 2) {
              if (typeof parsed.searxngSecret !== "string" || !/^[0-9a-f]{64}$/.test(parsed.searxngSecret)) {
                return { ok: false, error: { kind: "corrupt-file", reason: "invalid searxngSecret" } };
              }
              searxngSecret = parsed.searxngSecret;
              cached = { hermesAuthToken, searxngSecret };
              log.info("loadOrInit.loaded", {
                schemaVersion: 2,
                hermesFp: fingerprint(hermesAuthToken),
                searxngFp: fingerprint(searxngSecret),
              });
              return { ok: true, value: cached };
            }
            // v1 → v2 migration: keep the existing hermes token, generate searxng secret.
            searxngSecret = randomBytes(TOKEN_BYTES).toString("hex");
            cached = { hermesAuthToken, searxngSecret };
            const payload: PersistedV2 = { schemaVersion: 2, hermesAuthToken, searxngSecret };
            await writeFileAtomic(path, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
            log.info("loadOrInit.migrated-v1-to-v2", {
              hermesFp: fingerprint(hermesAuthToken),
              searxngFp: fingerprint(searxngSecret),
            });
            return { ok: true, value: cached };
          }
          // Fresh file: generate both.
          const fresh: InternalSecrets = {
            hermesAuthToken: randomBytes(TOKEN_BYTES).toString("hex"),
            searxngSecret: randomBytes(TOKEN_BYTES).toString("hex"),
          };
          const payload: PersistedV2 = { schemaVersion: 2, ...fresh };
          await writeFileAtomic(path, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
          cached = fresh;
          log.info("loadOrInit.generated", {
            schemaVersion: 2,
            hermesFp: fingerprint(fresh.hermesAuthToken),
            searxngFp: fingerprint(fresh.searxngSecret),
          });
          return { ok: true, value: cached };
        } catch (e: unknown) {
          const reason = (e as Error).message;
          log.error("loadOrInit.failed", { reason });
          return { ok: false, error: { kind: "io-error", reason } };
        }
      },
      getHermesAuthTokenSync() {
        if (!cached) throw new Error("InternalSecretsStore: getHermesAuthTokenSync called before loadOrInit");
        return cached.hermesAuthToken;
      },
      getSearxngSecretSync() {
        if (!cached) throw new Error("InternalSecretsStore: getSearxngSecretSync called before loadOrInit");
        return cached.searxngSecret;
      },
    };
  }

  function fingerprint(token: string): string {
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
  }
  ```

- [ ] **Step 4: Update the existing v1-on-disk test to assert v2 schema after first call**

  In `gateway/src/admin/internal-secrets-store.test.ts`, find the existing test:
  ```ts
  it("generates a 64-char hex token on first loadOrInit and persists it", ...
  ```
  and update its assertion `expect(onDisk.schemaVersion).toBe(1);` to `expect(onDisk.schemaVersion).toBe(2);`.

- [ ] **Step 5: Run all internal-secrets-store tests**

  Run:
  ```bash
  cd gateway && bun run test src/admin/internal-secrets-store.test.ts
  ```
  Expected: all tests (existing + new) pass.

- [ ] **Step 6: Run gateway typecheck**

  Run:
  ```bash
  cd gateway && bun run typecheck
  ```
  Expected: no type errors. (The `getSearxngSecretSync` addition expands the interface; existing callers don't reference it yet, so no callsite changes are required at this step.)

- [ ] **Step 7: Commit**

  Run:
  ```bash
  git add gateway/src/admin/internal-secrets-store.ts gateway/src/admin/internal-secrets-store.test.ts
  git status
  git commit -m "$(cat <<'EOF'
  feat(secrets): internal-secrets v2 schema with searxngSecret

  Adds a 64-char hex searxngSecret alongside hermesAuthToken. v1 files
  on disk migrate to v2 on first loadOrInit (idempotent). New
  getSearxngSecretSync() exposes the value to apply-time template
  rendering.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 4: Add `fetch-mcp` container

**Files:**
- Create: `gateway/mcp/fetch-mcp/Dockerfile`
- Create: `gateway/templates/services/fetch-mcp.yaml`
- Modify: `gateway/config.yaml` (add `mcp_servers.fetch` + `mcp_catalog.fetch-mcp`)
- Modify: `deploy/pi/docker-compose.yml` (add `fetch-mcp` build-only block)

**Steps:**

- [ ] **Step 1: Create `gateway/mcp/fetch-mcp/Dockerfile`**

  Replace `<resolved-fetch-version>` with the version recorded under "Resolved Adapter Names" in pre-flight.

  Write file content:

  ```dockerfile
  # fetch-mcp — dockerized HTTP MCP server.
  #
  # Wraps the upstream mcp-server-fetch package. Outbound URL fetches
  # route through `egress-proxy` because the container joins
  # `sentient-internal` only.
  #
  # See .claude/rules/gateway/mcp-deployment.md for the deployment standard.

  FROM python:3.13-slim

  ARG FETCH_MCP_VERSION=<resolved-fetch-version>

  RUN pip install --no-cache-dir "mcp-server-fetch==${FETCH_MCP_VERSION}"

  ENV PYTHONUNBUFFERED=1

  EXPOSE 8088

  CMD ["python", "-m", "mcp_server_fetch", "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8088"]
  ```

  > **If the resolved package's CLI flags differ:** run `python -m mcp_server_fetch --help` inside a scratch container during pre-flight and record the actual flags. Update the `CMD` accordingly. The two requirements: bind 0.0.0.0:8088, transport = streamable-http.

- [ ] **Step 2: Create `gateway/templates/services/fetch-mcp.yaml`**

  Write file content:

  ```yaml
  image: sentient/fetch-mcp:local
  container_name: sentient-fetch-mcp
  networks: [sentient-internal]
  env:
    HTTP_PROXY: http://sentient-egress-proxy:3128
    HTTPS_PROXY: http://sentient-egress-proxy:3128
    NO_PROXY: localhost,127.0.0.1
  mem_limit_bytes: 268435456
  cpus: 0.5
  ```

- [ ] **Step 3: Add `mcp_servers.fetch` block to `gateway/config.yaml`**

  In `gateway/config.yaml`, locate the `mcp_servers:` map (the one that currently contains `duckduckgo:` and `music_assistant:`). Append, immediately after the `music_assistant:` block:

  ```yaml
    # fetch-mcp — dockerized HTTP MCP at gateway/mcp/fetch-mcp/.
    # Outbound HTTP fetches route through egress-proxy.
    fetch:
      transport: http
      url: http://sentient-fetch-mcp:8088/mcp
      timeout: 30
      connect_timeout: 5
      description: Fetch URL contents as markdown.
  ```

- [ ] **Step 4: Add `mcp_catalog.fetch-mcp` block to `gateway/config.yaml`**

  In the `managed_services:` map, append (after `ma-mcp:`):

  ```yaml
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

- [ ] **Step 5: Add fetch-mcp build-only block to `deploy/pi/docker-compose.yml`**

  Locate the `ddg-mcp:` build block (still present at this point). Immediately after it, append:

  ```yaml
    fetch-mcp:
      build:
        context: ../../gateway/mcp/fetch-mcp
      image: sentient/fetch-mcp:local
      pull_policy: never
      profiles: ["build-only"]
  ```

- [ ] **Step 6: Build the fetch-mcp image to confirm Dockerfile is valid**

  Run:
  ```bash
  source scripts/env.sh
  docker compose -f deploy/pi/docker-compose.yml --profile build-only build fetch-mcp
  ```
  Expected: build completes; `docker images sentient/fetch-mcp:local` shows the new image. If the `CMD` flags are wrong the build will succeed but `docker run` will fail — proceed to step 7 to verify runtime.

- [ ] **Step 7: Smoke-run fetch-mcp standalone**

  Run:
  ```bash
  docker run --rm --name fetch-mcp-smoke -p 8088:8088 sentient/fetch-mcp:local &
  sleep 3
  curl -sS -X POST http://localhost:8088/mcp -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' || true
  docker rm -f fetch-mcp-smoke
  ```
  Expected: the curl returns a JSON-RPC response listing a `fetch` tool. If the response is empty or 404, adjust the `CMD` in step 1 (transport / endpoint path) and rebuild.

- [ ] **Step 8: Commit**

  Run:
  ```bash
  git add gateway/mcp/fetch-mcp/ gateway/templates/services/fetch-mcp.yaml gateway/config.yaml deploy/pi/docker-compose.yml
  git status
  git commit -m "$(cat <<'EOF'
  feat(mcp): add fetch-mcp container and catalog entry

  Wraps the upstream mcp-server-fetch package as a sibling MCP container.
  Provides URL → cleaned markdown via a single fetch tool. Replaces the
  fetch capability that today is bundled into ddg-mcp.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 5: Add `searxng` container (upstream image, no Dockerfile)

**Files:**
- Create: `gateway/templates/services/searxng.yaml`
- Modify: `gateway/config.yaml` (add `mcp_catalog.searxng` block; no `mcp_servers.searxng` yet — that wraps the adapter, added in Task 6)
- Modify: `gateway/mcp-policy.yaml` (no changes here — searxng has no tools; the adapter is what exposes tools)

**Steps:**

- [ ] **Step 1: Create `gateway/templates/services/searxng.yaml`**

  Write file content:

  ```yaml
  image: searxng/searxng:latest
  container_name: sentient-searxng
  networks: [sentient-internal]
  env:
    HTTP_PROXY: http://sentient-egress-proxy:3128
    HTTPS_PROXY: http://sentient-egress-proxy:3128
    NO_PROXY: localhost,127.0.0.1
    SEARXNG_SECRET: ${SEARXNG_SECRET}
  volumes:
    - source: gateway/mcp/searxng/settings.yml
      target: /etc/searxng/settings.yml
      read_only: true
  mem_limit_bytes: 536870912
  cpus: 0.5
  ```

  > The `volumes` shape matches existing template conventions; if the
  > template-loader uses a different syntax (e.g. flat string list),
  > inspect `gateway/templates/services/sentient-hermes.yaml` for an
  > example before committing.

- [ ] **Step 2: Add `mcp_catalog.searxng` block to `gateway/config.yaml`**

  In the `managed_services:` map, append (after `fetch-mcp:` from Task 4):

  ```yaml
    searxng:
      template: searxng.yaml
      allowed_images: ["searxng/searxng:latest"]
      networks: ["sentient-internal"]
      secrets:
        SEARXNG_SECRET: internal.searxng_secret
      healthcheck:
        tcp: "sentient-searxng:8080"
        timeout_ms: 30000
      depends_on: ["egress-proxy"]
      optional: false
  ```

  > **Verify the secret-binding syntax.** Inspect existing entries
  > (`ha-mcp`, `ma-mcp`) in `mcp_catalog` to confirm the binding key
  > format. If the orchestrator only resolves bindings from
  > `secrets-store.ts` (operator-supplied) and not from
  > `internal-secrets-store.ts`, Task 7 below adds the bridge.

- [ ] **Step 3: Pull the upstream image to confirm availability**

  Run:
  ```bash
  docker pull searxng/searxng:latest
  ```
  Expected: image pulls cleanly. Capture the digest (`docker inspect searxng/searxng:latest --format '{{.Id}}'`) and paste into the commit body for traceability.

- [ ] **Step 4: Commit**

  Run:
  ```bash
  git add gateway/templates/services/searxng.yaml gateway/config.yaml
  git status
  git commit -m "$(cat <<'EOF'
  feat(mcp): add searxng container template + catalog entry

  Upstream searxng/searxng:latest (no Dockerfile). settings.yml mounted
  read-only from gateway/mcp/searxng/. Secret binding routes the
  internal-secrets v2 searxngSecret into the container env as
  SEARXNG_SECRET.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 6: Add `searxng-mcp` adapter container

**Files:**
- Create: `gateway/mcp/searxng-mcp/Dockerfile`
- Create: `gateway/templates/services/searxng-mcp.yaml`
- Modify: `gateway/config.yaml` (add `mcp_servers.searxng` and `mcp_catalog.searxng-mcp`)
- Modify: `deploy/pi/docker-compose.yml` (add `searxng-mcp` build-only block)

**Steps:**

- [ ] **Step 1: Create `gateway/mcp/searxng-mcp/Dockerfile`**

  Replace `<resolved-searxng-mcp-package>` and `<resolved-version>` with the values recorded in pre-flight.

  Write file content:

  ```dockerfile
  # searxng-mcp — dockerized HTTP MCP adapter for SearXNG.
  #
  # Wraps the upstream <resolved-searxng-mcp-package> in streamable-http
  # transport. Forwards search queries to the sibling `searxng` container
  # over the sentient-internal network. No direct upstream egress here —
  # SearXNG is the one that fans out to engines via egress-proxy.

  FROM python:3.13-slim

  ARG SEARXNG_MCP_VERSION=<resolved-version>

  RUN pip install --no-cache-dir "<resolved-searxng-mcp-package>==${SEARXNG_MCP_VERSION}"

  ENV PYTHONUNBUFFERED=1

  EXPOSE 8087

  ENV SEARXNG_URL=http://searxng:8080

  CMD ["python", "-m", "<resolved-searxng-mcp-module>", "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8087"]
  ```

  > Replace `<resolved-searxng-mcp-module>` with the actual python
  > module path (e.g., `searxng_mcp_server`). Pre-flight discovery
  > should establish this; if the package uses a console-script
  > entry-point instead of `python -m`, swap to `["the-script-name", ...]`.

- [ ] **Step 2: Create `gateway/templates/services/searxng-mcp.yaml`**

  Write file content:

  ```yaml
  image: sentient/searxng-mcp:local
  container_name: sentient-searxng-mcp
  networks: [sentient-internal]
  env:
    SEARXNG_URL: http://sentient-searxng:8080
  mem_limit_bytes: 134217728
  cpus: 0.25
  ```

- [ ] **Step 3: Add `mcp_servers.searxng` block to `gateway/config.yaml`**

  In the `mcp_servers:` map, append (immediately after the `fetch:` block from Task 4):

  ```yaml
    # SearXNG metasearch — dockerized HTTP MCP at gateway/mcp/searxng-mcp/.
    # Adapter forwards queries to the sibling searxng container which
    # fans out across configured upstream engines via egress-proxy.
    searxng:
      transport: http
      url: http://sentient-searxng-mcp:8087/mcp
      timeout: 30
      connect_timeout: 5
      description: SearXNG metasearch web search.
  ```

- [ ] **Step 4: Add `mcp_catalog.searxng-mcp` block to `gateway/config.yaml`**

  In the `managed_services:` map, append (after the `searxng:` block from Task 5):

  ```yaml
    searxng-mcp:
      template: searxng-mcp.yaml
      allowed_images: ["sentient/searxng-mcp:local"]
      networks: ["sentient-internal"]
      healthcheck:
        tcp: "sentient-searxng-mcp:8087"
        timeout_ms: 30000
      depends_on: ["searxng"]
      optional: false
  ```

- [ ] **Step 5: Add searxng-mcp build-only block to `deploy/pi/docker-compose.yml`**

  Append (after the `fetch-mcp:` block from Task 4):

  ```yaml
    searxng-mcp:
      build:
        context: ../../gateway/mcp/searxng-mcp
      image: sentient/searxng-mcp:local
      pull_policy: never
      profiles: ["build-only"]
  ```

- [ ] **Step 6: Build the searxng-mcp image**

  Run:
  ```bash
  source scripts/env.sh
  docker compose -f deploy/pi/docker-compose.yml --profile build-only build searxng-mcp
  ```
  Expected: build completes.

- [ ] **Step 7: Smoke-run searxng-mcp + searxng together**

  Run:
  ```bash
  docker network create searxng-smoke 2>/dev/null || true
  docker run --rm -d --name smoke-searxng --network searxng-smoke \
    -v "$(pwd)/gateway/mcp/searxng/settings.yml:/etc/searxng/settings.yml:ro" \
    -e SEARXNG_SECRET=$(openssl rand -hex 32) \
    searxng/searxng:latest
  sleep 5
  docker run --rm -d --name smoke-searxng-mcp --network searxng-smoke \
    -p 8087:8087 \
    -e SEARXNG_URL=http://smoke-searxng:8080 \
    sentient/searxng-mcp:local
  sleep 3
  curl -sS -X POST http://localhost:8087/mcp -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  docker rm -f smoke-searxng-mcp smoke-searxng
  docker network rm searxng-smoke
  ```
  Expected: tools/list response includes a `web_search` (or similarly named) tool. If empty or 404, fix the Dockerfile `CMD` per pre-flight discovery and rebuild.

- [ ] **Step 8: Commit**

  Run:
  ```bash
  git add gateway/mcp/searxng-mcp/ gateway/templates/services/searxng-mcp.yaml gateway/config.yaml deploy/pi/docker-compose.yml
  git status
  git commit -m "$(cat <<'EOF'
  feat(mcp): add searxng-mcp adapter container

  Wraps the upstream searxng-mcp adapter as a sibling container that
  forwards web_search to the searxng backend via SEARXNG_URL. Pinned
  package version recorded in Dockerfile ARG.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 7: Wire `SEARXNG_SECRET` from internal-secrets into apply-time render

**Files:**
- Modify: `gateway/src/apply/apply-deps.ts` (add `searxngSecret` to the apply context if it isn't already wired through)
- Modify: `gateway/src/apply/orchestrator.ts` or its render code path (the place that resolves template `${...}` env bindings)
- Modify: tests for the above

**Investigation step (required first because the binding-resolution path varies by codebase area):**

- [ ] **Step 1: Locate the secret-binding resolver**

  Run:
  ```bash
  grep -rn "secrets:" gateway/src --include="*.ts" | head -20
  grep -rn "renderTemplate\|resolveBinding\|secret-resolver" gateway/src --include="*.ts" | head -20
  ```
  Expected: identify the function that takes a `mcp_catalog.<name>.secrets:` map and resolves each binding key (e.g. `home_assistant.url`) against the operator's `secrets-store`. Record the file path here for use in Step 2.

- [ ] **Step 2: Extend the binding resolver to accept the `internal.<key>` namespace**

  Add an `internal.` prefix branch to the resolver such that:
  ```yaml
  secrets:
    SEARXNG_SECRET: internal.searxng_secret
  ```
  resolves by calling `internalSecretsStore.getSearxngSecretSync()` rather than `secretsStore.get(...)`. The existing behavior for non-prefixed keys (operator secrets) is preserved.

  TDD: add a unit test in the same directory as the resolver. Fixture: a service template with `secrets: { FOO: "internal.searxng_secret" }`; mock internal-secrets returning a fixed value; assert the rendered env contains `FOO=<value>`.

- [ ] **Step 3: Run all gateway tests**

  Run:
  ```bash
  cd gateway && bun run test
  ```
  Expected: all green, including the new resolver test.

- [ ] **Step 4: Run typecheck**

  Run:
  ```bash
  cd gateway && bun run typecheck
  ```
  Expected: no errors.

- [ ] **Step 5: Commit**

  Run:
  ```bash
  git add gateway/src
  git status
  git commit -m "$(cat <<'EOF'
  feat(apply): resolve `internal.<key>` secret bindings via internal-secrets-store

  Adds an internal.* namespace to the secret-binding resolver so service
  templates can declare gateway-managed secrets (today: searxngSecret) in
  the same shape as operator-supplied bindings.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 8: Add per-user `tools.enabled` migrator

**Files:**
- Create: `gateway/src/admin/web-tools-migrator.ts`
- Create: `gateway/src/admin/web-tools-migrator.test.ts`
- Modify: `gateway/src/bootstrap/phase-services.ts` (wire the migrator)
- Modify: `gateway/src/profile-store/profile-defaults.ts` (replace `duckduckgo: []` with `searxng: []` and `fetch: []` in `DEFAULT_TOOLS_ENABLED`)
- Modify: `gateway/src/profile-store/profile-defaults.test.ts` (update fixture)

**Steps:**

- [ ] **Step 1: Write failing migrator unit tests**

  Create `gateway/src/admin/web-tools-migrator.test.ts`:

  ```ts
  import { describe, expect, it, vi } from "vitest";
  import type { ProfileV1 } from "../profile-store/profile-types.js";
  import { migrateWebToolsEnabled } from "./web-tools-migrator.ts";

  function makeProfile(overrides: Partial<ProfileV1["tools"]["enabled"]>): ProfileV1 {
    return {
      schemaVersion: 1,
      userId: "u1",
      model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
      voice: { provider: "fish-audio", id: "v1" },
      audio: { ttsEnabled: true, channel: "voice" },
      persona: { template: "default", overrides: "" },
      tools: { enabled: overrides as Record<string, string[]>, toolsets: [] },
      compression: { threshold: 0.8 },
      advanced: { extraSystemPrompt: "", maxTokens: 512 },
    };
  }

  describe("migrateWebToolsEnabled", () => {
    it("renames duckduckgo key to searxng + fetch when present", async () => {
      const profile = makeProfile({ duckduckgo: ["search"] });
      const profileStore = {
        get: vi.fn().mockResolvedValue({ ok: true, value: profile }),
        save: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      };
      const userStore = { list: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u1" }] }) };

      await migrateWebToolsEnabled({ userStore, profileStore });

      expect(profileStore.save).toHaveBeenCalledTimes(1);
      const saved = profileStore.save.mock.calls[0][0] as ProfileV1;
      expect(saved.tools.enabled.duckduckgo).toBeUndefined();
      expect(saved.tools.enabled.searxng).toEqual([]);
      expect(saved.tools.enabled.fetch).toEqual([]);
    });

    it("is a no-op when duckduckgo key is absent (idempotent)", async () => {
      const profile = makeProfile({ searxng: [], fetch: [] });
      const profileStore = {
        get: vi.fn().mockResolvedValue({ ok: true, value: profile }),
        save: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      };
      const userStore = { list: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u1" }] }) };

      await migrateWebToolsEnabled({ userStore, profileStore });

      expect(profileStore.save).not.toHaveBeenCalled();
    });

    it("preserves other entries in tools.enabled", async () => {
      const profile = makeProfile({
        duckduckgo: ["search"],
        home_assistant: ["ha_get_state"],
        music_assistant: [],
      });
      const profileStore = {
        get: vi.fn().mockResolvedValue({ ok: true, value: profile }),
        save: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      };
      const userStore = { list: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u1" }] }) };

      await migrateWebToolsEnabled({ userStore, profileStore });

      const saved = profileStore.save.mock.calls[0][0] as ProfileV1;
      expect(saved.tools.enabled.home_assistant).toEqual(["ha_get_state"]);
      expect(saved.tools.enabled.music_assistant).toEqual([]);
    });

    it("logs and skips users whose profile fails to load", async () => {
      const profileStore = {
        get: vi.fn().mockResolvedValue({ ok: false, error: "io-error" }),
        save: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      };
      const userStore = {
        list: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u1" }, { userId: "u2" }] }),
      };

      await migrateWebToolsEnabled({ userStore, profileStore });

      expect(profileStore.get).toHaveBeenCalledTimes(2);
      expect(profileStore.save).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run test to verify failures**

  Run:
  ```bash
  cd gateway && bun run test src/admin/web-tools-migrator.test.ts
  ```
  Expected: every test fails with `Cannot find module './web-tools-migrator.ts'` or similar.

- [ ] **Step 3: Implement the migrator**

  Create `gateway/src/admin/web-tools-migrator.ts`:

  ```ts
  import type { Result } from "@sentient/protocol";
  import { getLog } from "../logging/logger.js";
  import type { ProfileStore } from "../profile-store/profile-store.js";
  import type { ProfileV1 } from "../profile-store/profile-types.js";
  import type { UserStore } from "../user-auth/user-store.js";

  const log = getLog(["sentient", "gateway", "admin", "web-tools-migrator"]);

  export interface WebToolsMigrationDeps {
    userStore: Pick<UserStore, "list">;
    profileStore: Pick<ProfileStore, "get" | "save">;
  }

  /**
   * One-shot, idempotent boot migration: rename per-user
   * `tools.enabled.duckduckgo` to `tools.enabled.searxng` + `tools.enabled.fetch`
   * (both initialized to `[]`, meaning "inherit catalog defaults").
   *
   * No-op for users whose profile has neither the legacy key nor needs the
   * new keys (already migrated). Best-effort: per-user failures log and
   * continue.
   */
  export async function migrateWebToolsEnabled(deps: WebToolsMigrationDeps): Promise<void> {
    const usersResult = await deps.userStore.list();
    if (!usersResult.ok) {
      log.warn("migration.user-store-error", { error: usersResult.error });
      return;
    }
    const users = usersResult.value;

    let migrated = 0;
    let skipped = 0;
    for (const user of users) {
      const profileResult = await deps.profileStore.get(user.userId);
      if (!profileResult.ok) {
        log.warn("migration.profile-load-error", { userId: user.userId, error: profileResult.error });
        skipped++;
        continue;
      }
      const profile = profileResult.value;
      const enabled = profile.tools.enabled;
      const hasLegacy = "duckduckgo" in enabled;
      if (!hasLegacy) {
        log.debug("migration.noop", { userId: user.userId });
        continue;
      }

      const next: Record<string, string[]> = { ...enabled };
      delete next.duckduckgo;
      if (!("searxng" in next)) next.searxng = [];
      if (!("fetch" in next)) next.fetch = [];

      const updated: ProfileV1 = { ...profile, tools: { ...profile.tools, enabled: next } };
      const saveResult = await deps.profileStore.save(updated);
      if (!saveResult.ok) {
        log.warn("migration.save-error", { userId: user.userId, error: saveResult.error });
        continue;
      }
      log.info("migration.web-tools-renamed", {
        userId: user.userId,
        from: "duckduckgo",
        to: ["searxng", "fetch"],
      });
      migrated++;
    }
    log.info("migration.complete", { migrated, skipped, total: users.length });
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  Run:
  ```bash
  cd gateway && bun run test src/admin/web-tools-migrator.test.ts
  ```
  Expected: all four tests pass.

- [ ] **Step 5: Wire migrator into `phase-services.ts`**

  Edit `gateway/src/bootstrap/phase-services.ts`. Add an import near the existing boot-migration imports:

  ```ts
  import { migrateWebToolsEnabled } from "../admin/web-tools-migrator.js";
  ```

  Locate the block beginning `// Boot migration: bind any existing users that lack a port binding.` (around line 171). Immediately AFTER the existing `migrateUnboundUsers` call but BEFORE `renderConfigsForExistingUsers`, insert:

  ```ts
    // Boot migration: rename per-user tools.enabled.duckduckgo →
    // tools.enabled.searxng + tools.enabled.fetch. Idempotent.
    if (cfg.hermes) {
      await migrateWebToolsEnabled({ userStore: auth.users, profileStore });
    }
  ```

- [ ] **Step 6: Update `DEFAULT_TOOLS_ENABLED`**

  Edit `gateway/src/profile-store/profile-defaults.ts`. Change:
  ```ts
  const DEFAULT_TOOLS_ENABLED: Record<string, string[]> = {
    home_assistant: [],
    gateway: [],
    music_assistant: [],
    duckduckgo: [],
  };
  ```
  to:
  ```ts
  const DEFAULT_TOOLS_ENABLED: Record<string, string[]> = {
    home_assistant: [],
    gateway: [],
    music_assistant: [],
    searxng: [],
    fetch: [],
  };
  ```

- [ ] **Step 7: Update `profile-defaults.test.ts` fixture**

  Edit `gateway/src/profile-store/profile-defaults.test.ts`. Replace the fixture line:
  ```ts
  duckduckgo: [],
  ```
  with:
  ```ts
  searxng: [],
  fetch: [],
  ```
  Also update any assertion that compares `out.tools.enabled` against `{ duckduckgo: ["search"] }` — change the test that exercises "caller-provided enabled wins" to use `{ searxng: ["search"] }` instead. (Read the current test body before editing to keep semantics intact.)

- [ ] **Step 8: Run profile-store tests**

  Run:
  ```bash
  cd gateway && bun run test src/profile-store/
  ```
  Expected: all green.

- [ ] **Step 9: Commit**

  Run:
  ```bash
  git add gateway/src/admin/web-tools-migrator.ts gateway/src/admin/web-tools-migrator.test.ts gateway/src/bootstrap/phase-services.ts gateway/src/profile-store/profile-defaults.ts gateway/src/profile-store/profile-defaults.test.ts
  git status
  git commit -m "$(cat <<'EOF'
  feat(profiles): boot-phase migrator for tools.enabled (duckduckgo → searxng+fetch)

  Renames the legacy per-user tools.enabled.duckduckgo key to searxng +
  fetch (both empty arrays = inherit catalog defaults). Idempotent
  no-op once migrated. Wired into phase-services before
  renderConfigsForExistingUsers so the next per-user render picks up the
  new shape. DEFAULT_TOOLS_ENABLED in profile-defaults updated for new
  user creation.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 9: Drop DDG MCP and switch the global default

**Files:**
- Delete: `deploy/docker/mcp/ddg-mcp/`
- Delete: `gateway/templates/services/ddg-mcp.yaml`
- Modify: `gateway/config.yaml` (drop `mcp_servers.duckduckgo` + `mcp_catalog.ddg-mcp`; switch `web_tools.provider` → `searxng`; remove `web_tools.duckduckgo` block)
- Modify: `deploy/pi/docker-compose.yml` (drop `ddg-mcp` build block)
- Modify: `shared/config/src/schemas/hermes-config.ts` (drop `"duckduckgo"` enum value + `duckduckgo` block from `hermesWebToolsSchema`)
- Modify: `gateway/src/person-session/person-session-registry.test.ts` (replace `provider: "duckduckgo"` fixtures)
- Modify: `gateway/src/session-router.test.ts` (same)
- Modify: `gateway/src/admin/user-provisioner.test.ts` (replace `duckduckgo: []` with `searxng: [], fetch: []`)

**Steps:**

- [ ] **Step 1: Delete the ddg-mcp source tree**

  Run:
  ```bash
  git rm -r deploy/docker/mcp/ddg-mcp
  git rm gateway/templates/services/ddg-mcp.yaml
  ```

- [ ] **Step 2: Remove ddg-mcp from `gateway/config.yaml`**

  Open `gateway/config.yaml`. Make four edits:

  1. In `web_tools:`, change:
     ```yaml
     web_tools:
       provider: duckduckgo                    # or "searxng" post-Phase-3
       duckduckgo:
         enabled: true
     ```
     to:
     ```yaml
     web_tools:
       provider: searxng
       searxng:
         enabled: true
     ```

  2. In `mcp_servers:`, delete the entire `duckduckgo:` block (transport/url/timeout/connect_timeout/description) and its preceding two-line comment.

  3. In `managed_services:`, delete the entire `ddg-mcp:` block.

  4. Verify the path comment for ma-mcp (touched in Task 1) still reads `gateway/mcp/ma-mcp/`. No further change.

- [ ] **Step 3: Remove ddg-mcp from Pi compose**

  Edit `deploy/pi/docker-compose.yml`. Delete the `ddg-mcp:` build-only block in its entirety.

  In the same file, find the header comment that lists sibling images (around line 8: `# All sibling images (sentient-hermes, stt-service, ma-mcp, ddg-mcp) live`). Update to:
  ```
  # All sibling images (sentient-hermes, stt-service, ma-mcp, searxng-mcp, fetch-mcp) live
  ```

- [ ] **Step 4: Remove the `duckduckgo` enum value + block from the schema**

  Edit `shared/config/src/schemas/hermes-config.ts`. Replace the `hermesWebToolsSchema` with:

  ```ts
  export const hermesWebToolsSchema = z
    .object({
      provider: z.enum(["searxng"]).default("searxng"),
      searxng: z
        .object({
          enabled: z.boolean().default(true),
          url: z.string().url().optional(),
        })
        .default({}),
      voice_wrapper: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({}),
    })
    .default({});
  export type HermesWebTools = z.infer<typeof hermesWebToolsSchema>;
  ```

- [ ] **Step 5: Update test fixtures that reference `duckduckgo`**

  Run:
  ```bash
  grep -rn "duckduckgo" gateway/src --include="*.ts"
  ```
  Expected matches in: `person-session-registry.test.ts`, `session-router.test.ts`, `user-provisioner.test.ts`.

  In `person-session-registry.test.ts` and `session-router.test.ts`, replace:
  ```ts
  provider: "duckduckgo",
  duckduckgo: { enabled: true },
  searxng: { enabled: false },
  ```
  with:
  ```ts
  provider: "searxng",
  searxng: { enabled: true },
  ```

  In `user-provisioner.test.ts`, replace:
  ```ts
  enabled: { home_assistant: [], gateway: [], music_assistant: [], duckduckgo: [] },
  ```
  with:
  ```ts
  enabled: { home_assistant: [], gateway: [], music_assistant: [], searxng: [], fetch: [] },
  ```

- [ ] **Step 6: Update setup-prod.py prompt label**

  Edit `deploy/setup-prod.py`. On line 181, change:
  ```python
  "Build all sibling images now? (gateway, stt-service, hermes, ma-mcp, ddg-mcp)"
  ```
  to:
  ```python
  "Build all sibling images now? (gateway, stt-service, hermes, ma-mcp, searxng-mcp, fetch-mcp)"
  ```

- [ ] **Step 7: Update path-list comments**

  Edit `deploy/docker/docker-compose.yml`. Line 3 currently lists `(ha-mcp, ma-mcp, ddg-mcp)`. Update to `(ha-mcp, ma-mcp, searxng, searxng-mcp, fetch-mcp)`.

- [ ] **Step 8: Update deployment-rule docs**

  Edit `.claude/rules/gateway/mcp-deployment.md`. Find the line:
  ```
  - Each per-MCP image lives at `deploy/docker/mcp/<name>/Dockerfile`. Pin the upstream package version.
  ```
  Change to:
  ```
  - Each built-in MCP image lives at `gateway/mcp/<name>/Dockerfile`. Pin the upstream package version.
  ```

  Edit `agents/docs/gateway/mcp-deployment-details.md`. Find the example block referencing `context: ../mcp/ddg-mcp` (around line 91). Update to a current-shape example using one of the surviving MCPs (ma-mcp at `context: ../../gateway/mcp/ma-mcp` or fetch-mcp at `context: ../../gateway/mcp/fetch-mcp`). The line at 149 (`Add deploy/docker/mcp/<name>/Dockerfile that installs the package`) updates to `Add gateway/mcp/<name>/Dockerfile that installs the package`.

- [ ] **Step 9: Run full local CI**

  Run:
  ```bash
  source scripts/env.sh
  bun run ci
  ```
  Expected: lint clean, typecheck clean, all unit tests green. If any test still references `duckduckgo`, locate it via the grep in step 5 and fix.

- [ ] **Step 10: Commit**

  Run:
  ```bash
  git add deploy/docker/mcp deploy/pi/docker-compose.yml deploy/docker/docker-compose.yml deploy/setup-prod.py gateway/config.yaml gateway/templates/services shared/config/src/schemas/hermes-config.ts gateway/src .claude/rules/gateway/mcp-deployment.md agents/docs/gateway/mcp-deployment-details.md
  git status
  git commit -m "$(cat <<'EOF'
  feat(config): drop ddg-mcp; switch web_tools.provider default to searxng

  Removes deploy/docker/mcp/ddg-mcp/, the ddg-mcp service template, the
  mcp_servers.duckduckgo + mcp_catalog.ddg-mcp blocks, and the
  duckduckgo enum value from hermesWebToolsSchema. Test fixtures and
  deployment docs updated. setup-prod.py prompt label refreshed for the
  new image set.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 10: Add `gateway/mcp/README.md` index

**Files:**
- Create: `gateway/mcp/README.md`

**Steps:**

- [ ] **Step 1: Write `gateway/mcp/README.md`**

  Write file content:

  ```markdown
  # Built-in MCPs

  Each subdirectory packages one MCP server that the gateway orchestrates as a
  sibling container. The deployment standard (`Dockerfile` location, build
  context, network membership, healthcheck) is documented in
  `.claude/rules/gateway/mcp-deployment.md`.

  | Directory | Tool surface | Image | Notes |
  |---|---|---|---|
  | `searxng/` | (backend, no MCP) | `searxng/searxng:latest` (upstream) | Metasearch engine. Backs `searxng-mcp`. |
  | `searxng-mcp/` | `web_search` | `sentient/searxng-mcp:local` | Wraps the searxng-mcp adapter; talks to `searxng:8080`. |
  | `fetch-mcp/` | `fetch` | `sentient/fetch-mcp:local` | Wraps Anthropic's `mcp-server-fetch`. |
  | `ma-mcp/` | Music Assistant tools | `sentient/ma-mcp:local` | Davidpadbury fork; LAN egress on `sentient-external`. |

  Templates that bind these images to their per-container config (env,
  networks, secrets, healthcheck) live at
  `gateway/templates/services/<name>.yaml`. The catalog policy (image
  allowlist, secret bindings, optional/required) lives in
  `gateway/config.yaml#mcp_catalog`.
  ```

- [ ] **Step 2: Commit**

  Run:
  ```bash
  git add gateway/mcp/README.md
  git status
  git commit -m "$(cat <<'EOF'
  docs(mcp): index README for gateway/mcp/

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 11: E2E smoke matrix (per spec §Testing)

This task does NOT produce a commit; it gates handover. Drive Playwright MCP against the local stack (`deploy/macos/`).

**Setup:**

- [ ] **Step 1: Build all images and bring the stack up**

  Run:
  ```bash
  source scripts/env.sh
  docker compose -f deploy/pi/docker-compose.yml --profile build-only build
  docker compose -f deploy/macos/docker-compose.yml up -d
  ```
  Expected: build completes for `gateway`, `stt-service`, `sentient-hermes`, `ma-mcp`, `searxng-mcp`, `fetch-mcp`. Stack comes up. (The macos compose only starts the gateway; orchestrator-managed siblings spawn via dockerode after wizard completion.)

- [ ] **Step 2: Wait for container health**

  Run:
  ```bash
  docker ps --filter "label=sentient.managed=true" --format "table {{.Names}}\t{{.Status}}"
  docker ps --filter "name=sentient-gateway" --format "table {{.Names}}\t{{.Status}}"
  ```
  Expected: within 30s of orchestrator spawning siblings, all containers report `healthy` (or `Up` for noop-healthcheck containers): `sentient-gateway`, `sentient-hermes`, `sentient-stt-service`, `sentient-ma-mcp` (if MA configured), `sentient-ha-mcp` (if HA configured), `sentient-searxng`, `sentient-searxng-mcp`, `sentient-fetch-mcp`, `sentient-egress-proxy`.

**Smoke cases (run via Playwright MCP, capture screenshots + console + logs):**

For each case below:
1. Navigate to `https://localhost:8888`, log in.
2. Speak / type the prompt.
3. Wait for cycle completion.
4. Verify the listed expectations.
5. Re-run on mobile viewport (390×844) via `browser_resize`.

| # | Surface | Prompt | Expectation |
|---|---|---|---|
| 1 | searxng-mcp | "search for italian restaurants in seattle" | `web_search` tool call lands; `docker logs sentient-searxng` shows fanout to multiple engines; TTS reads top results. |
| 2 | fetch-mcp | "read me this article: <known-good URL>" | `fetch` tool call lands; cleaned markdown returned; TTS reads summary. |
| 3 | search→fetch | "find latest news about claude AI and read top result" | Both tool calls land in one cycle; cycle log shows `web_search` then `fetch`. |
| 4 | searxng failure | While query is in flight, run `docker stop sentient-searxng`. | Cycle terminates with tool error surfaced to user. No hang. Restart: `docker start sentient-searxng`. |
| 5 | ha-mcp (read-only) | "what's my current home status" or "are any lights on" | `ha_get_state` or `ha_search_entities` lands; entities returned; **no `call_service` invoked**. |
| 6 | ha-mcp (read-only) | "what's the temperature in the living room" | `ha_get_state` for the sensor entity; numeric value returned. |
| 7 | ma-mcp (read-only) | "what music players do I have" | MA list-players read; player array returned; **no playback control invoked**. |
| 8 | ma-mcp (read-only) | "what's currently playing" | MA now-playing read; track or idle; no playback change. |
| 9 | Boot migration: secret | Stop gateway. Edit `~/.sentient/gateway/internal-secrets.json` to v1 shape (`{schemaVersion:1, hermesAuthToken:"<existing>"}`). Restart gateway. | Log `loadOrInit.migrated-v1-to-v2`; file on disk is v2 with `searxngSecret`; SearXNG starts; case 1 still passes. |
| 10 | Boot migration: profile | Stop gateway. Edit a user's `profile.json`: insert `tools.enabled.duckduckgo: ["search"]`, remove searxng/fetch keys. Restart gateway. | Log `migration.web-tools-renamed`; profile file shows `searxng: []` and `fetch: []`, no `duckduckgo`. Web search still works. |
| 11 | No regressions | `bun run ci`; `docker compose ... logs gateway --since 5m \| grep -E "WARN\|ERROR"` | No unexpected WARN/ERROR. |

- [ ] **Step 3: Capture evidence**

  Save screenshots under `.playwright-mcp/2026-05-08-searxng-fetch-mcp-smoke/`. Save the relevant `gateway/logs/<date>.log` excerpts for cases 9 and 10.

- [ ] **Step 4: Repeat the case set on mobile viewport**

  Use `browser_resize` to switch to 390×844 between case sets. Each case must pass on both.

- [ ] **Step 5: Pre-handover gate check**

  - All 11 cases green on both viewports.
  - `bun run ci` clean.
  - All containers healthy in 30s after orchestrator spawn.
  - No unexpected WARN/ERROR in `gateway/logs/`.

  If any case fails, return to the relevant task and fix; do not declare done.

---

## Self-Review (already run by plan author — kept for transparency)

- **Spec coverage:**
  - Architecture (replaces ddg with searxng + searxng-mcp + fetch-mcp): Tasks 4, 5, 6, 9.
  - File reorg (deploy/docker/mcp/ → gateway/mcp/): Tasks 1, 2, 9 (deletion).
  - internal-secrets v1→v2: Task 3.
  - Profile per-user migration: Task 8 (note: spec described this as `web_tools.provider`; correction documented above — actual state is `tools.enabled.duckduckgo`).
  - Service templates + catalog wiring: Tasks 4, 5, 6.
  - Pi compose, setup-prod.py, docs: Tasks 1, 4, 5, 6, 9.
  - Schema tightening: Task 9.
  - Smoke matrix (HA, MA, search, fetch, migrations): Task 11.
- **Placeholder scan:** the only placeholders are `<resolved-fetch-version>` / `<resolved-searxng-mcp-package>` etc., which are explicit fail-fast pre-flight items by design.
- **Type consistency:** `getSearxngSecretSync` defined Task 3, consumed Task 7. `migrateWebToolsEnabled` signature defined Task 8, called Task 8 step 5. `internal.searxng_secret` binding key declared Task 5, resolved Task 7.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-08-searxng-fetch-mcp-and-reorg.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
