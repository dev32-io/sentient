# Phase 1.0 — Empirical Gates

> **Parent plan:** `2026-04-21-hermes-phase1-overview.md`
> **Sub-skill:** `superpowers:executing-plans`

**Goal:** produce data (not code) that answers five open questions about Hermes's real behavior. Commit these measurements as a single reference document. This unblocks Phase 1.1+ by confirming our assumptions.

**Builds on:** nothing. First sub-phase.

**Duration:** 1–3 days.

**Deliverable:** `docs/superpowers/plans/notes/2026-04-21-phase1.0-measurements.md` with numeric results for every measurement below.

**Spec reference:** v4 §13, decisions D-3, D-5, D-8, D-16.

---

## Context and prerequisites

We made five conditional design commitments in the v4 spec. Each is a gate: the numeric result changes what Phase 1.1+ builds. Specifically:

- **M-1** (idle RAM) decides if Strategy A (always-on per-user Hermes) fits our 8 GiB Pi.
- **M-2** (cold-start) decides if Strategy B (on-demand pause/unpause) is feasible as a fallback.
- **M-3** (SSE event fidelity) decides if `speak-as-streaming-tool` can be unlocked (D-3 conditional).
- **M-4** (SSE disconnect behavior) validates our interrupt design (D-8).
- **M-5** (concurrent request isolation) confirms whether we need per-profile mutex in `HermesClient`.

Run these measurements BEFORE writing any Phase 1.1+ code.

### Prerequisites

- A Raspberry Pi 5 (8 GiB) available with Docker installed. If you're measuring on a laptop instead, note that idle RAM figures may be 10–20% higher on ARM64 Pi than amd64 laptop — record both if possible.
- OpenRouter API key (for real LLM calls during M-3/M-4/M-5 measurement). Stored in `~/.sentient/.env` as `OPENROUTER_API_KEY` per project convention.
- `curl`, `jq`, `docker`, `docker compose` available.
- Network access to `openrouter.ai` and `hub.docker.com`.

---

## Task 0.1 — Build a minimal Hermes container for measurement

**Files:**
- Create: `/tmp/hermes-measure/Dockerfile`
- Create: `/tmp/hermes-measure/compose.yml`
- Create: `/tmp/hermes-measure/profile/config.yaml`
- Create: `/tmp/hermes-measure/profile/.env`

**Why `/tmp`:** these are one-shot measurement artifacts. They do NOT belong in the repo. We keep only the final measurements doc.

### Step 0.1a: Write the minimal Dockerfile

- [ ] Create `/tmp/hermes-measure/Dockerfile`:

```dockerfile
FROM python:3.12-slim-bookworm
RUN pip install --no-cache-dir hermes-agent
# intentionally no [all], no [voice], no [browser], no [vision] — curated slim
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
WORKDIR /data
ENV HERMES_HOME=/data
ENV API_SERVER_ENABLED=true
ENV API_SERVER_PORT=8642
EXPOSE 8642
CMD ["hermes", "gateway", "start", "--api-only"]
```

**Verification:**
```bash
cd /tmp/hermes-measure && docker build -t hermes-measure:slim .
```
Expected: builds cleanly in 1–3 minutes.

### Step 0.1b: Write the minimal profile config

- [ ] Create `/tmp/hermes-measure/profile/config.yaml`:

```yaml
model:
  provider: openrouter
  model: google/gemini-2.5-flash

providers:
  openrouter:
    api_key_env: OPENROUTER_API_KEY

agent:
  max_turns: 4
  reasoning_effort: medium

memory:
  memory_enabled: true
  user_profile_enabled: true

compression:
  enabled: true

approvals:
  mode: off   # measurement only; POC runs it ON

terminal:
  backend: local

platforms:
  homeassistant:
    enabled: false
```

- [ ] Create `/tmp/hermes-measure/profile/.env`:

```bash
OPENROUTER_API_KEY=sk-or-v1-<your-key>
API_SERVER_KEY=measure-key-do-not-reuse-in-prod
```

**Set file permissions:**
```bash
chmod 600 /tmp/hermes-measure/profile/.env
```

### Step 0.1c: Write the compose file

- [ ] Create `/tmp/hermes-measure/compose.yml`:

```yaml
services:
  hermes-measure:
    image: hermes-measure:slim
    volumes:
      - ./profile:/data
    env_file:
      - ./profile/.env
    ports:
      - "8642:8642"
    mem_limit: 768m
    cpus: "1.0"
    restart: "no"
```

**Verification:**
```bash
cd /tmp/hermes-measure && docker compose up -d && sleep 5 && docker compose logs --tail 30
```
Expected: Hermes starts, logs show "API server listening on 0.0.0.0:8642" or similar.

---

## Task 0.2 — M-1: Idle RAM measurement

**Question:** What's the idle RAM of our curated slim Hermes container with no active conversation?

**Threshold:** ≤ 500 MiB → Strategy A default (always-on 5 profiles in 2.5 GiB). Above 500 MiB → Strategy B (on-demand with eviction).

### Step 0.2a: Establish idle baseline

- [ ] With the container running from Task 0.1, wait 60 seconds for any startup settling.
- [ ] Measure:

```bash
docker stats hermes-measure --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}"
```

- [ ] Record the "MEM USAGE" value. Also capture the output of:

```bash
docker exec hermes-measure cat /proc/self/status | grep VmRSS
```

- [ ] Repeat the measurement 3 times at 30-second intervals. Record all 3 + the median.

### Step 0.2b: Record in measurements doc

- [ ] Create the measurements doc (if not exists): `docs/superpowers/plans/notes/2026-04-21-phase1.0-measurements.md` — start with:

```markdown
# Phase 1.0 Measurements — 2026-04-21

## M-1: Idle RAM

- Image: `hermes-measure:slim` (from /tmp/hermes-measure/Dockerfile, Hermes v<pinned>)
- Platform: <Pi 5 8GiB aarch64 | laptop amd64>
- Measurements:
  - T+60s: <value> MiB
  - T+90s: <value> MiB
  - T+120s: <value> MiB
- Median: <value> MiB
- Threshold (≤500 MiB): **PASS | FAIL**

### Implication
- If PASS: Strategy A (always-on per-user). 5 users × <median> MiB = <total> MiB.
- If FAIL: Strategy B (on-demand with eviction). See Phase 1.7.
```

### Step 0.2c: Decide

- [ ] Record the verdict (PASS/FAIL) in the doc.
- [ ] If FAIL: note the gap (`measured_median - 500`) and flag Phase 1.7 to default to Strategy B.

---

## Task 0.3 — M-2: Cold-start time

**Question:** How fast can a Hermes container go from `docker compose up` to `/health` returning 200?

**Threshold:** ≤ 3 s → Strategy B viable with filler UX ("one sec, Alice"). Above 3 s → re-engineer filler or stay Strategy A regardless.

### Step 0.3a: Time the cold start

- [ ] Stop the measurement container: `cd /tmp/hermes-measure && docker compose down`.
- [ ] Script a timed start:

```bash
cd /tmp/hermes-measure
start=$(date +%s.%N)
docker compose up -d
# poll /health
while true; do
  if curl -fsS -H "Authorization: Bearer measure-key-do-not-reuse-in-prod" http://localhost:8642/health >/dev/null 2>&1; then
    end=$(date +%s.%N)
    echo "Ready in $(echo "$end - $start" | bc) seconds"
    break
  fi
  sleep 0.1
done
docker compose down
```

- [ ] Repeat 3 times. Record all + median.

### Step 0.3b: Record and decide

- [ ] Append to the measurements doc:

```markdown
## M-2: Cold-start time

- Run 1: <value> s
- Run 2: <value> s
- Run 3: <value> s
- Median: <value> s
- Threshold (≤3 s): **PASS | FAIL**

### Implication
- If PASS: Strategy B fallback viable. Filler "one sec" tactic works.
- If FAIL: Strategy B adds noticeable lag; stay Strategy A regardless.
```

---

## Task 0.4 — M-3: SSE event fidelity (critical for D-3)

**Question:** Does Hermes's `/v1/responses` emit `response.function_call_arguments.delta` during tool calls (i.e., streaming the `text` arg token-by-token)?

**Threshold:** Yes → unlock `speak-as-streaming-tool` (register `speak` on gateway-hosted MCP, stream its text arg to TTS). No → default TTS decorator chain on `response.output_text.delta` only.

### Step 0.4a: Construct a test request with a custom tool

- [ ] With the measurement container running, register a trivial MCP tool OR use a request body that asks for a function call explicitly:

```bash
curl -N -X POST http://localhost:8642/v1/responses \
  -H "Authorization: Bearer measure-key-do-not-reuse-in-prod" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.5-flash",
    "input": "Please call the set_location tool with city=\"San Francisco\" and country=\"USA\"",
    "tools": [{
      "type": "function",
      "name": "set_location",
      "description": "Sets location",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string"},
          "country": {"type": "string"}
        },
        "required": ["city", "country"]
      }
    }],
    "stream": true,
    "max_output_tokens": 512
  }' 2>&1 | tee /tmp/sse-trace.txt
```

### Step 0.4b: Analyze the SSE trace

- [ ] `grep -E '^event:|^data:' /tmp/sse-trace.txt | head -100`
- [ ] Look specifically for:
  - `event: response.function_call_arguments.delta` OR `data: {"type":"response.function_call_arguments.delta", ...}`
  - The exact JSON shape of any event relating to function_call arguments.
- [ ] Record both (a) whether the delta events exist AND (b) their exact JSON schema.

### Step 0.4c: Record and decide

- [ ] Append:

```markdown
## M-3: SSE function_call arguments streaming

- Test tool: `set_location`
- Events observed (enumerated from SSE trace):
  - `response.created` <count>
  - `response.output_item.added` <count>
  - `response.function_call_arguments.delta` <count>   ← key
  - `response.function_call_arguments.done` <count>
  - `response.output_item.done` <count>
  - `response.completed` <count>
- `function_call_arguments.delta` JSON schema (if present):
  ```json
  { "type": "response.function_call_arguments.delta", "item_id": "...", "delta": "..." }
  ```
- Verdict: **PRESENT | ABSENT**

### Implication
- If PRESENT: `speak-as-streaming-tool` unlocked. Phase 1.3 includes a `speak` MCP tool registration on gateway-hosted MCP; TTS decorator chain consumes EITHER `response.output_text.delta` (when model returns plain text) OR arg-delta stream (when model calls `speak`).
- If ABSENT: keep text-delta-only TTS (v4 default). Document here for future reference.
```

---

## Task 0.5 — M-4: SSE disconnect behavior

**Question:** When we close the SSE connection mid-stream, does Hermes actually stop generating tokens server-side (per PR #3427), or does it just drop packet delivery to us?

**Threshold:** Server stops generating within ~2 s. Above that → add a follow-up `DELETE /v1/responses/{id}` call if supported, or document the gap.

### Step 0.5a: Test disconnect behavior

- [ ] Issue a streaming request that we expect to generate ~20+ seconds of text:

```bash
# Start request, pipe to a reader that disconnects after 1 second of receiving data
timeout 2 curl -N -X POST http://localhost:8642/v1/responses \
  -H "Authorization: Bearer measure-key-do-not-reuse-in-prod" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.5-flash",
    "input": "Write an extremely detailed 2000-word essay about the history of bread. Be exhaustive.",
    "stream": true,
    "max_output_tokens": 4096
  }' > /tmp/sse-disconnect-trace.txt 2>&1
```

- [ ] Immediately after, inspect OpenRouter (or your LLM provider's) usage dashboard if available, OR re-query Hermes:

```bash
# If Hermes persists runs, check its audit log
docker exec hermes-measure cat /data/logs/*.log | grep -E 'run_id|tokens|complete' | tail -20
```

- [ ] Check how many tokens were charged vs how many were delivered in the trace file.

### Step 0.5b: Record

- [ ] Append:

```markdown
## M-4: SSE disconnect → server-side halt

- Disconnect at: T+2s (timeout)
- Tokens delivered to client: <count>
- Tokens charged upstream (OpenRouter dashboard or proxy log): <count>
- Ratio: delivered/charged = <X>
- Server-side halt time estimate: <seconds after disconnect>
- Verdict: **HALTS | CONTINUES**

### Implication
- If HALTS: SSE disconnect is our reliable interrupt primitive. Proceed with D-8 as-is.
- If CONTINUES: document the gap. For Phase 1.7+, we may add a `DELETE /v1/responses/{id}` call after disconnect if Hermes supports it (check docs). Upstream contribution F-1 in spec §14 becomes higher priority.
```

---

## Task 0.6 — M-5: Concurrent request isolation

**Question:** Can a single Hermes process handle 3 simultaneous `/v1/responses` requests against the same profile without cross-leaking state?

**Threshold:** Isolated → no per-profile mutex needed. Cross-leak → `HermesClient` serializes requests per profile.

### Step 0.6a: Fire 3 concurrent requests

- [ ] Script:

```bash
for i in 1 2 3; do
  curl -N -X POST http://localhost:8642/v1/responses \
    -H "Authorization: Bearer measure-key-do-not-reuse-in-prod" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"google/gemini-2.5-flash\",\"input\":\"Say request $i and ONLY say 'request $i'. Stop.\",\"stream\":true,\"max_output_tokens\":32}" > /tmp/conc-$i.txt 2>&1 &
done
wait
```

### Step 0.6b: Check each response

- [ ] For each trace file, verify the response text contains the correct request number:

```bash
for i in 1 2 3; do
  result=$(grep -oE '"delta":"[^"]*"' /tmp/conc-$i.txt | head -20 | tr -d '"delta:"' | tr -d '"')
  echo "Request $i got: $result"
done
```

### Step 0.6c: Record

- [ ] Append:

```markdown
## M-5: Concurrent request isolation

- 3 concurrent requests fired to same profile
- Request 1 output: "<actual>"
- Request 2 output: "<actual>"
- Request 3 output: "<actual>"
- Verdict: **ISOLATED | CROSS-LEAK**

### Implication
- If ISOLATED: no per-profile mutex needed in HermesClient (Phase 1.2).
- If CROSS-LEAK: HermesClient.dispatch() must serialize requests per userId. Note for Phase 1.2.
```

---

## Task 0.7 — Commit the measurements

### Step 0.7a: Summary section

- [ ] Add a TL;DR to the top of the measurements doc:

```markdown
# Phase 1.0 Measurements — 2026-04-21

## Verdict summary

| Gate | Result | Decision for Phase 1.1+ |
|---|---|---|
| M-1 | <PASS/FAIL>, <value> MiB | <Strategy A | Strategy B> |
| M-2 | <PASS/FAIL>, <value> s | <Cold-start filler works | Stay always-on> |
| M-3 | <PRESENT/ABSENT> | <Unlock speak-as-tool | Text-delta only> |
| M-4 | <HALTS/CONTINUES> | <SSE disconnect reliable | Add explicit cancel> |
| M-5 | <ISOLATED/CROSS-LEAK> | <No mutex needed | Per-profile mutex> |

Details below.

---

<existing content>
```

### Step 0.7b: Teardown

- [ ] `cd /tmp/hermes-measure && docker compose down && docker volume rm $(docker volume ls -q | grep hermes-measure) 2>/dev/null || true`
- [ ] `rm -rf /tmp/hermes-measure /tmp/sse-*.txt /tmp/conc-*.txt`
- [ ] `docker rmi hermes-measure:slim` (optional; saves a few hundred MiB)

### Step 0.7c: Commit

- [ ] Check we're on the feature branch:

```bash
git branch --show-current
# should print: feature/hermes-cerebrum-integration
```

- [ ] Verify file is in git's view:

```bash
git status docs/superpowers/plans/notes/
```

- [ ] Commit:

```bash
git add docs/superpowers/plans/notes/2026-04-21-phase1.0-measurements.md
git commit -m "$(cat <<'EOF'
docs(plans): Phase 1.0 empirical measurements

Verdicts for M-1..M-5 recorded. These numbers are load-bearing for
Phase 1.1+ architecture choices (multi-profile strategy, interrupt
primitive, streaming-tool unlock, concurrent-request isolation).

Co-Authored-By: <your-model-id>
EOF
)"
```

- [ ] `git log --oneline -n 3` to confirm the commit landed.

---

## Done

Phase 1.0 complete when:

- [ ] `docs/superpowers/plans/notes/2026-04-21-phase1.0-measurements.md` exists with all 5 gate verdicts filled in.
- [ ] Verdict summary table at the top.
- [ ] Measurement artifacts torn down from /tmp.
- [ ] Single commit on `feature/hermes-cerebrum-integration`.

**Proceed to** `2026-04-21-hermes-phase1.1-scaffolding.md`. The M-1/M-2/M-3/M-4/M-5 verdicts you just wrote will be referenced throughout Phase 1.1+.
