# Phase 1.6 — Web Tools (DuckDuckGo MCP)

> **Parent plan:** `2026-04-21-hermes-phase1-overview.md`
> **Previous:** `2026-04-21-hermes-phase1.5-ha-mcp.md`

**Goal:** Hermes can call `search` and `fetch_content` tools. POC uses `nickclyde/duckduckgo-mcp-server` — zero config, no API key. Egress proxy allowlist extended. SearXNG upgrade documented but deferred to Phase 3+.

**Builds on:** Phase 1.1 (slim Dockerfile already bundles `duckduckgo-mcp-server`), 1.5 (per-profile MCP config pattern).

**Spec reference:** v4 §5.16, D-20.

---

## 1. Context and prerequisites

### Why DuckDuckGo MCP

- Zero setup (no API key / account).
- Single MIT package (`duckduckgo-mcp-server`, 900+ stars).
- Exposes both `search` and `fetch_content`.
- Built-in rate limits (30 searches/min, 20 fetches/min) — fine for family use.
- Fragility (DDG HTML scraping) is the main trade-off; SearXNG upgrade path (Phase 3) is drop-in via config swap.

### Egress proxy allowlist additions

The Hermes container's outbound access is restricted to the egress proxy (Phase 1.8 builds the proxy properly; for Phase 1.6 we add the allowed domains so Phase 1.8 inherits the right list).

Domains to allow:
- `duckduckgo.com`
- `html.duckduckgo.com`

These layer on top of the existing allowlist (`openrouter.ai`, `api.anthropic.com`, `api.openai.com`, `homeassistant.local`).

---

## Task 1.6.1 — Confirm slim image has `duckduckgo-mcp-server`

Phase 1.1's Dockerfile.slim already `pip install`s it. Confirm.

- [ ] Inspect the Dockerfile:

```bash
grep duckduckgo-mcp-server deploy/docker/hermes/Dockerfile.slim
```

Expected: `duckduckgo-mcp-server` appears in the `pip install` line.

- [ ] If missing, add to the install command:

```dockerfile
RUN pip install --no-cache-dir \
      hermes-agent==${HERMES_VERSION} \
      duckduckgo-mcp-server
```

- [ ] Rebuild image:

```bash
cd deploy/docker/hermes && docker build -f Dockerfile.slim -t sentient-hermes:slim . && cd ../..
```

- [ ] Verify the tool is callable inside the image:

```bash
docker run --rm -it sentient-hermes:slim sh -c "which duckduckgo-mcp-server && duckduckgo-mcp-server --help" 2>&1 | head -20
```

Expected: path printed, help text or no error.

- [ ] If you changed the Dockerfile, commit:

```bash
git add deploy/docker/hermes/Dockerfile.slim
git commit -m "$(cat <<'EOF'
chore(deploy): confirm duckduckgo-mcp-server in slim image

POC web tools depend on it. Verify pip install line contains the
package. Rebuild and verify the binary is on PATH in the container.

Co-Authored-By: <your-model-id>
EOF
)" 2>/dev/null || true
```

---

## Task 1.6.2 — Add DDG MCP entry to profile config

**Files:**
- Modify: `gateway/templates/hermes-profile.yaml.tmpl` (template)
- Modify: `profiles/alice/config.yaml` (rendered)

### Step 1.6.2a: Template update

Phase 1.1 template already includes DDG entry — confirm:

- [ ] Open `gateway/templates/hermes-profile.yaml.tmpl`. Ensure the `mcp_servers` block contains:

```yaml
mcp_servers:
  home_assistant:
    # ...

  duckduckgo:
    command: duckduckgo-mcp-server
    timeout: 30
    connect_timeout: 10

  gateway:
    # ...
```

- [ ] If missing, add it.

### Step 1.6.2b: Rendered alice profile

- [ ] Confirm `profiles/alice/config.yaml` has the `duckduckgo` MCP entry. If it was rendered from the template before DDG was added, re-render:

```bash
sed -e "s/{{USER_NAME}}/alice/g" \
    -e "s/{{RENDERED_AT}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" \
    gateway/templates/hermes-profile.yaml.tmpl \
    > profiles/alice/config.yaml
```

- [ ] Verify:

```bash
grep -A 3 "duckduckgo" profiles/alice/config.yaml
```

Expected: 4 lines of DDG config.

### Step 1.6.2c: Commit

```bash
git add gateway/templates/hermes-profile.yaml.tmpl profiles/alice/config.yaml
git commit -m "$(cat <<'EOF'
feat(profile): DDG MCP in user profiles for web_search + web_fetch

Zero-config DuckDuckGo MCP server runs as a subprocess inside each
Hermes container. Exposes search + fetch_content tools. v1 POC choice
per D-20; SearXNG is the Phase 3+ privacy upgrade.

Co-Authored-By: <your-model-id>
EOF
)" 2>/dev/null || true
```

---

## Task 1.6.3 — Egress proxy allowlist additions

**Files:**
- Modify: `deploy/egress-proxy/tinyproxy.conf` (create if missing; Phase 1.8 hardens this)
- Modify: `deploy/egress-proxy/filter.txt` (allowlist regexes)

### Step 1.6.3a: Create egress proxy stub

- [ ] Create `deploy/egress-proxy/tinyproxy.conf`:

```conf
# POC egress proxy. Phase 1.8 adds TLS + finer policy.

User tinyproxy
Group tinyproxy

Port 3128
Listen 0.0.0.0

Timeout 600
DefaultErrorFile "/usr/share/tinyproxy/default.html"
Logfile "/var/log/tinyproxy/tinyproxy.log"
LogLevel Info

# Upstream hosts allowed. Deny all others.
FilterURLs On
FilterDefaultDeny Yes
Filter "/etc/tinyproxy/filter.txt"

ConnectPort 443
ConnectPort 80
```

- [ ] Create `deploy/egress-proxy/filter.txt`:

```
# Allowlist of hosts Hermes containers can reach.
# Phase 1.6 adds DuckDuckGo.

# LLM providers
^https?://openrouter\.ai(:[0-9]+)?(/|$)
^https?://api\.anthropic\.com(:[0-9]+)?(/|$)
^https?://api\.openai\.com(:[0-9]+)?(/|$)

# Home Assistant (if Hermes needs to talk to it directly — usually via gateway)
^https?://homeassistant\.local(:[0-9]+)?(/|$)

# DuckDuckGo (Phase 1.6)
^https?://duckduckgo\.com(:[0-9]+)?(/|$)
^https?://html\.duckduckgo\.com(:[0-9]+)?(/|$)
```

### Step 1.6.3b: Egress proxy service in compose

- [ ] Add to `deploy/docker/docker-compose.yml`:

```yaml
services:
  egress-proxy:
    image: kalaksi/tinyproxy:latest
    networks: [sentient-internal, sentient-external]
    volumes:
      - ../egress-proxy/tinyproxy.conf:/etc/tinyproxy/tinyproxy.conf:ro
      - ../egress-proxy/filter.txt:/etc/tinyproxy/filter.txt:ro
    mem_limit: 64m
    cpus: "0.25"
    restart: unless-stopped
```

- [ ] Ensure networks declared (should be from Phase 1.1):

```yaml
networks:
  sentient-internal:
    driver: bridge
    internal: true
  sentient-external:
    driver: bridge
```

- [ ] Update `hermes-alice` to use the proxy for outbound:

```yaml
  hermes-alice:
    # ... existing ...
    environment:
      # ... existing ...
      HTTP_PROXY: "http://egress-proxy:3128"
      HTTPS_PROXY: "http://egress-proxy:3128"
      NO_PROXY: "localhost,127.0.0.1,/run/sentient/mcp.sock"
    depends_on:
      - egress-proxy
```

### Step 1.6.3c: Smoke test

- [ ] Boot:

```bash
cd deploy/docker && docker compose up -d egress-proxy hermes-alice && cd ../..
```

- [ ] From inside the Hermes container, confirm allowlisted + denied domains:

```bash
# Allowed
docker exec hermes-alice sh -c 'curl -fsS -o /dev/null -w "%{http_code}\n" https://duckduckgo.com'
# Expected: 200

# Denied
docker exec hermes-alice sh -c 'curl -fsS -o /dev/null -w "%{http_code}\n" https://evil.example.com 2>&1 | head -1'
# Expected: non-2xx (403 or proxy error)
```

- [ ] Tear down:

```bash
cd deploy/docker && docker compose down && cd ../..
```

### Step 1.6.3d: Commit

```bash
git add deploy/egress-proxy/ deploy/docker/docker-compose.yml
git commit -m "$(cat <<'EOF'
feat(deploy): egress-proxy container with Phase 1.6 DDG allowlist

Tinyproxy container enforces outbound host allowlist. Hermes containers
route HTTP(S) through http://egress-proxy:3128. Phase 1.6 adds DDG
domains; Phase 1.8 hardens the proxy further. Default-deny policy;
every new external service needs a filter.txt entry.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.6.4 — SOUL.md guidance for web tools

Per spec §5.16.5 (trust-the-pipeline). SOUL.md template already covers this; confirm and adjust if drift.

### Step 1.6.4a: Check SOUL template

- [ ] Open `gateway/templates/SOUL.md.tmpl`. Ensure the web-tools section reads approximately:

```markdown
## Web search

- You have `search` and `fetch_content` tools for current information.
- Lead with the direct answer; cite the source by name ("according to Wikipedia...") when useful.
- Keep spoken replies conversational — 1-3 sentences for casual questions, longer for explanations.
- Rich formatting in your reply is fine; the UI renders it visibly and it's stripped before speech.
```

- [ ] If the section is missing OR has obsolete "no markdown" constraints, replace.

### Step 1.6.4b: Re-render alice's SOUL

- [ ] Re-render:

```bash
sed -e "s/{{USER_NAME}}/Alice/g" \
    -e "s/{{RENDERED_AT}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" \
    gateway/templates/SOUL.md.tmpl \
    > profiles/alice/SOUL.md
```

- [ ] Verify it looks right.

### Step 1.6.4c: Commit

```bash
git add gateway/templates/SOUL.md.tmpl profiles/alice/SOUL.md
git commit -m "$(cat <<'EOF'
chore(profile): SOUL.md web-tool guidance is length-focused

Per v4 §5.16.5: pipeline owns markdown stripping. SOUL.md guides on
length, not format. Alice's rendered SOUL refreshed.

Co-Authored-By: <your-model-id>
EOF
)" 2>/dev/null || true
```

---

## Task 1.6.5 — Manual smoke test of web tools via real Hermes

- [ ] Build image + boot compose:

```bash
cd deploy/docker/hermes && docker build -f Dockerfile.slim -t sentient-hermes:slim . && cd ../..
cd deploy/docker && docker compose up -d && cd ../..
```

- [ ] Wait for healthy:

```bash
sleep 30
docker ps --filter "name=hermes-alice" --format "{{.Status}}"
```

- [ ] Send a web-search prompt:

```bash
curl -N -X POST http://localhost:8643/v1/responses \
  -H "Authorization: Bearer $(cat deploy/docker/secrets/hermes_api_key_alice)" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.5-flash",
    "input": "Use the search tool to find out when the Eiffel Tower was built. Give a brief one-sentence answer.",
    "stream": true,
    "max_output_tokens": 256
  }' 2>&1 | tee /tmp/phase1.6-websearch.txt
```

- [ ] Look for `function_call` with name `search` or `search_duckduckgo`:

```bash
grep -E 'function_call|tool' /tmp/phase1.6-websearch.txt | head -20
```

Expected: Hermes calls the search tool, then produces a brief answer like "The Eiffel Tower was completed in 1889."

- [ ] Test fetch_content:

```bash
curl -N -X POST http://localhost:8643/v1/responses \
  -H "Authorization: Bearer $(cat deploy/docker/secrets/hermes_api_key_alice)" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.5-flash",
    "input": "Fetch https://en.wikipedia.org/wiki/Eiffel_Tower and summarize it in 3 sentences.",
    "stream": true,
    "max_output_tokens": 512
  }' 2>&1 | tee /tmp/phase1.6-fetch.txt
```

- [ ] Inspect:

```bash
grep -E 'function_call|fetch_content|response.output_text' /tmp/phase1.6-fetch.txt | head -30
```

Expected: Hermes calls `fetch_content`, then summarizes.

- [ ] Tear down:

```bash
cd deploy/docker && docker compose down && cd ../..
rm /tmp/phase1.6-*.txt
```

- [ ] If anything failed, check:
  - DDG MCP process started: `docker logs hermes-alice | grep -i "duckduckgo\|search\|mcp"`
  - Egress proxy allows DDG: `docker logs egress-proxy | grep -i duckduckgo`
  - Tool visibility: try `curl POST /v1/responses` with `input: "List the tools you have available."` — Hermes should mention search/fetch.

---

## Task 1.6.6 — Document SearXNG upgrade path

**Files:**
- Create: `deploy/searxng/settings.yml` (commented stub; not started in v1)
- Create: `deploy/searxng/README.md`

### Step 1.6.6a: Stub for future use

- [ ] Create `deploy/searxng/settings.yml`:

```yaml
# SearXNG settings for Phase 3+ privacy upgrade (v4 §5.16.2).
# Not active in Phase 1. Do NOT start the SearXNG container from Phase 1
# docker-compose — add it via a Phase-3 compose overlay.

use_default_settings: true

server:
  base_url: "http://searxng:8080/"
  secret_key: "CHANGE_ME_TO_LONG_RANDOM"
  limiter: false

search:
  formats:
    - html
    - json    # required for mcp-searxng adapter

engines:
  - name: duckduckgo
  - name: bing
  - name: startpage
  - name: qwant
  - name: wikipedia
  - name: reddit
  - name: stackoverflow
  # trim any that seem noisy; full list in upstream defaults.

ui:
  query_in_title: false
```

### Step 1.6.6b: Upgrade runbook

- [ ] Create `deploy/searxng/README.md`:

```markdown
# SearXNG upgrade (Phase 3+, not active in v1)

Follow the v4 spec Appendix G for the full runbook. Summary:

1. Add SearXNG + mcp-searxng services to `docker-compose.yml` (Phase 3 overlay).
2. Swap per-profile `mcp_servers.duckduckgo` → `mcp_servers.searxng`.
3. Restart Hermes containers.
4. Smoke-test with 3–5 representative queries.
5. Keep DDG MCP installed as fallback for 1 release cycle.
6. Rollback: revert profile config, restart; SearXNG container can stay
   stopped.

When to upgrade:
- DDG search quality falls short in user testing.
- Privacy becomes a requirement (sharing beyond family).
- Hit DDG rate limits regularly.
```

### Step 1.6.6c: Commit

```bash
git add deploy/searxng/
git commit -m "$(cat <<'EOF'
docs(deploy): SearXNG upgrade path documented for Phase 3+

Config stub + runbook. Not active in Phase 1. Drop-in swap from DDG
MCP when privacy/quality needs justify the sidecar container.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.6.7 — Quality gate

- [ ] `source scripts/env.sh && bun run ci`

---

## Done

Phase 1.6 complete when:

- [ ] Slim image has `duckduckgo-mcp-server` installed.
- [ ] Alice profile's `config.yaml` has the DDG MCP entry.
- [ ] Egress proxy allows `duckduckgo.com` + `html.duckduckgo.com`, denies others.
- [ ] SOUL.md template + rendered alice SOUL reflect trust-the-pipeline guidance.
- [ ] Manual smoke test: Hermes calls `search` and `fetch_content` successfully.
- [ ] SearXNG upgrade path documented in `deploy/searxng/`.
- [ ] `bun run ci` green.

**Proceed to** `2026-04-21-hermes-phase1.7-multi-profile-satellite.md`.
