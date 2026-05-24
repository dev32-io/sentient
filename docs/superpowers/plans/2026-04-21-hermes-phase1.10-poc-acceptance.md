# Phase 1.10 — POC Acceptance

> **Parent plan:** `2026-04-21-hermes-phase1-overview.md`
> **Previous:** `2026-04-21-hermes-phase1.9-cleanup.md`

**Goal:** run the acceptance checklist from spec v4 §16 with a real human in the loop. Tune SOUL.md, salience map, and config based on observation. Produce a retrospective and update memory.

**Builds on:** Phases 1.0–1.9 complete and green.

**Spec reference:** v4 §16 (Phase 1 acceptance criterion).

---

## 1. Prerequisites for a demo

- Pi 5 (or powerful workstation acting as Pi substitute) with:
  - Docker + docker-compose.
  - `deploy/pi/docker-compose.yml` brought up successfully.
  - HA reachable on the network, with `mcp_server` integration enabled and entities Exposed via Voice Assistants → Expose UI.
  - `OPENROUTER_API_KEY`, `HA_MCP_TOKEN`, `HA_OBSERVE_TOKEN`, and Hermes API keys configured in `deploy/docker/secrets/` and/or profile `.env` files.
- A real user (ideally NOT you). A family member works best for the authenticity of the tests.
- Webui accessible at `https://<pi>:8888` in a browser.

---

## Task 1.10.1 — Pre-demo dry run

Run through every acceptance item yourself before handing the device to a family member. Issues found here get fixed ahead of the real demo.

### Step 1.10.1a: Bring up the stack

- [ ] Boot:

```bash
cd deploy/docker && docker compose up -d && cd ../..
```

- [ ] Wait for healthy status on all Hermes containers:

```bash
for c in hermes-alice hermes-bob hermes-family; do
  docker ps --filter "name=$c" --format "{{.Status}}"
done
```

Expected: each `(healthy)` within 30 s.

- [ ] Tail logs for boot errors:

```bash
docker logs gateway --tail 50
docker logs hermes-alice --tail 30
```

No errors at boot.

### Step 1.10.1b: Run the acceptance checklist yourself

Tick each box. For each failure, file a note in `docs/superpowers/plans/notes/phase1.10-findings.md` with reproducible steps.

- [ ] Open webui in a browser. Auth as alice (however dev auth is set up — usually a login flow or pre-shared token for dev).
- [ ] Confirm voice state indicator shows "listening" (or equivalent idle state).
- [ ] **Voice conversation:** tap/hold the mic button (or whatever the UI requires), say "Hello", release. Verify:
  - Transcript shows up.
  - `cycle.started` + `message.delta` + `cycle.completed` arrive (check webui network tab or gateway logs).
  - Audio plays back.
- [ ] **Barge-in:** ask a long question, then speak over the response. Audio should cut instantly; typewriter continues updating the chat with the full assistant text; a cutoff badge appears on the assistant bubble.
- [ ] **Hard interrupt:** ask something long; click the stop button. Audio stops instantly; assistant bubble shows interrupt cutoff; pressing mic to ask again works cleanly.
- [ ] **Identity rebind:** say "I am Bob." Verify:
  - `identify_user` tool call in task sidebar.
  - Audio confirms ("got it, Bob" or similar).
  - Next turn uses Bob's Hermes profile (check by asking "what's my name" — assistant should say Bob).
- [ ] **HA control (lights):** say "turn on the living room lights." Expect:
  - `HassCallService` or equivalent tool call.
  - Actual lights respond within 5 s.
  - Audio confirmation.
- [ ] **HA query:** "is the front door locked?" Expect:
  - `HassGetState` or list-entities call.
  - Accurate answer.
- [ ] **Approval flow (dangerous action):** say "disarm the alarm." Expect:
  - `tool.confirm_request` modal in webui.
  - Approval → action completes.
  - Denial → no action, assistant says "ok, cancelled."
- [ ] **Web search:** "what's the weather in San Francisco tomorrow?" Expect:
  - `search` tool call.
  - 1-3 sentence spoken answer.
- [ ] **Web fetch:** "fetch https://en.wikipedia.org/wiki/Eiffel_Tower and give me three fun facts." Expect:
  - `fetch_content` tool call.
  - Concise spoken reply.
- [ ] **Persistence across sessions:** close webui tab, reopen, auth as alice. Verify:
  - Past conversation replay shows in the feed.
  - Ask "do you remember what I asked earlier?" — should recall via Hermes's MEMORY.md (may or may not depending on Hermes's memory auto-curation; note the result).
- [ ] **Multi-user isolation:** log in as bob in a separate browser window. Ask "what's my name?" — should say Bob, NOT leak Alice's identity.
- [ ] **Resource check:** `docker stats --no-stream` — total gateway + hermes-* + stt + egress should sum within the Pi 5 RAM budget (~5 GiB, per v4 §5.1).

### Step 1.10.1c: Fix critical issues

- [ ] Each FAIL either blocks the demo or requires a disclaimer. Fix blockers:
  - SOUL.md prompt tweaks (length/behavior hints).
  - Salience thresholds in `hermes.cerebrum.cycle.*` config.
  - HA Expose UI settings.
  - Policy rules in `gateway/config/mcp-policy.yaml`.
- [ ] Commit fixes as they land, one per commit.

---

## Task 1.10.2 — Real demo with a family member

- [ ] Reset Hermes memory for the demo user (optional — lets them "meet" the assistant fresh):

```bash
# Wipe alice's memory + conversation. Keep profile + SOUL.
docker exec hermes-alice rm -f /data/MEMORY.md /data/USER.md
docker restart hermes-alice
```

- [ ] Hand the device over. Watch them interact for 15–30 minutes without intervening unless asked. Take notes on:
  - Moments they seem confused or surprised.
  - Utterances that caused misrouting (e.g., Hermes didn't understand, or took a wrong action).
  - Audio UX hiccups (too loud, too soft, too fast, too slow).
  - Any wire-protocol error toasts.

### Step 1.10.2a: Record findings

- [ ] Append to `docs/superpowers/plans/notes/phase1.10-findings.md`:

```markdown
## Real demo — 2026-MM-DD

Tester: <name, relation>
Duration: <minutes>
Environment: Pi 5 + <browser/device>

### What went well
- <bullets>

### What was awkward
- <bullets>

### Clear bugs
- <bullets with repro>

### Open questions for next iteration
- <bullets>
```

### Step 1.10.2b: Commit findings

```bash
git add docs/superpowers/plans/notes/phase1.10-findings.md
git commit -m "$(cat <<'EOF'
docs(plans): Phase 1.10 demo findings

Real-user observations from a live family-member session.
Feeds Phase 2 prioritization.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.10.3 — Retrospective

**Files:**
- Create: `docs/superpowers/retros/2026-MM-DD-hermes-phase1-retro.md`

Use today's actual completion date.

### Step 1.10.3a: Write the retro

Structure (free-form beyond this):

```markdown
# Hermes Phase 1 — Retrospective

**Completed:** YYYY-MM-DD
**Branch:** feature/hermes-cerebrum-integration
**Spec:** docs/superpowers/specs/2026-04-21-hermes-cerebrum-integration-design-v4.md

## Scope delivered

Tick vs the v4 §16 acceptance checklist. For each item, note any caveat.

## What we changed vs the spec

- <decision that drifted + why>

## What was harder than expected

- <things that cost more time>

## What was easier than expected

- <things that went smoothly>

## LOC ledger

- Added: <N>
- Deleted (Phase 1.9): <N>
- Net: <delta>

## Biggest surprises

- <3–5 bullets of "I did not expect...">

## Ready for Phase 2?

- <yes/no + top 3 items to tackle next>

## Updates to rules/docs needed

- <anything in .claude/rules/ or agent/docs/ that needs updating>
```

### Step 1.10.3b: Commit

```bash
git add docs/superpowers/retros/
git commit -m "$(cat <<'EOF'
docs(retros): Phase 1 Hermes integration retrospective

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.10.4 — Update memory

The user-level memory system at `/Users/kevinye/.claude/projects/-Users-kevinye-Development-sentient/memory/` tracks milestones.

### Step 1.10.4a: Add milestone

- [ ] Create `/Users/kevinye/.claude/projects/-Users-kevinye-Development-sentient/memory/project_phase1_hermes_complete.md`:

```markdown
---
name: Phase 1 Hermes integration complete
description: Hermes Agent sidecar now provides ReAct/memory/tools; gateway is thin voice + attention
type: project
---

Phase 1 merged to develop on YYYY-MM-DD. Per-user Hermes containers (alice/bob/family)
replace custom cerebrum. HA action via HA MCP (no tools.exclude, HA Expose UI is allowlist);
web search/fetch via DuckDuckGo MCP. TTS decorator chain consumes Hermes text.delta.
Gateway-hosted MCP for identify_user/pause_audio/resume_audio/set_channel. Multi-profile
Strategy A (always-on). Satellite ESP32 device identity + voice-phrase rebind.

Key files:
- spec: docs/superpowers/specs/2026-04-21-hermes-cerebrum-integration-design-v4.md
- retro: docs/superpowers/retros/YYYY-MM-DD-hermes-phase1-retro.md
- findings: docs/superpowers/plans/notes/phase1.10-findings.md

Next: Steward agent (v1.5, Phase 10+) for ambient reactivity.

**Why:** milestone captured so future sessions know v1 ships.
**How to apply:** reference when asked about current capabilities or Phase 2 priorities.
```

### Step 1.10.4b: Add to MEMORY.md index

- [ ] Edit `/Users/kevinye/.claude/projects/-Users-kevinye-Development-sentient/memory/MEMORY.md` — append:

```
- [Phase 1 Hermes complete](project_phase1_hermes_complete.md) — Hermes sidecar swapped in; custom cerebrum deleted; multi-profile + HA + web tools live
```

---

## Task 1.10.5 — Merge to develop

### Step 1.10.5a: Self-review

- [ ] `git log --oneline develop..HEAD` — scan all commits. Anything sloppy? Fix up before merge.
- [ ] `git diff --stat develop...HEAD` — sanity check scope.
- [ ] Run CI one more time: `source scripts/env.sh && bun run ci` — green.

### Step 1.10.5b: Merge

- [ ] Switch + merge with no-ff:

```bash
git checkout develop
git merge --no-ff feature/hermes-cerebrum-integration -m "$(cat <<'EOF'
Merge Phase 1: Hermes cerebrum integration

Replaces ~4500 LOC of custom cerebrum with Hermes Agent sidecar
containers (per-user). Voice UX preserved — STT, TTS, AttentionGate,
barge-in, interrupt all gateway-owned. Hermes handles ReAct, memory,
skills, tool dispatch. HA via HA MCP. Web via DuckDuckGo MCP.
Multi-profile always-on strategy (Strategy A). ESP32 satellite
identity + "I am X" voice-phrase rebind. Security: rootless containers,
network isolation, egress proxy, policy-as-code, risk accumulator.

Spec: docs/superpowers/specs/2026-04-21-hermes-cerebrum-integration-design-v4.md
Retro: docs/superpowers/retros/YYYY-MM-DD-hermes-phase1-retro.md

Co-Authored-By: <your-model-id>
EOF
)"
```

- [ ] Delete the feature branch:

```bash
git branch -d feature/hermes-cerebrum-integration
```

### Step 1.10.5c: Final confirmation

```bash
git log --oneline develop -n 10
```

- [ ] Verify the merge commit is at HEAD and recent Hermes commits trail underneath.

---

## Done

Phase 1 complete when:

- [ ] Acceptance checklist ticked with a real user.
- [ ] Findings notes committed.
- [ ] Retrospective committed.
- [ ] Memory updated with the milestone entry.
- [ ] Branch merged to `develop` with a descriptive merge commit.
- [ ] `develop` CI green.

**What's next:**

- Phase 2: polish, observability, dashboards, session reconnect replay tests.
- Phase 3: SearXNG privacy upgrade (if DDG quality or privacy signals demand).
- Phase 10+: Steward agent (v1.5) for ambient reactivity — see spec §5.15.

You did it. Tell the user you're done.
