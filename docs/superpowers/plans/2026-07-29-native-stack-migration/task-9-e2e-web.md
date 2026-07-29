### Task 9: The 2.0 web E2E matrix

**Wave 5 · model: sonnet · spec §9.2, predecessor spec §10.1**

Runs after Task 8 is green. **Serialized with Task 10** — one gateway owns `:8888`.

There is **no automated Playwright runner** in this repo (no `playwright.config` anywhere). Web E2E is 100% agent-driven via Playwright MCP tools, per `.claude/rules/e2e-testing.md`. Viewports: `browser_resize(1280,900)` desktop and `browser_resize(390,844)` mobile-sized.

**Files:**
- Create: `qa/web/evidence/<date>-<case>/` per case (establish this convention — only the mobile side has one today)
- Modify: `agents/docs/testing-knowledge.md`
- Modify: `gateway/config.yaml` — **only** `orchestrator.compaction.compact_threshold_tokens` (Step 3)

---

**⚠️ Re-grounding is mandatory before any case is a valid guard.** Every reusable case in `agents/docs/testing-knowledge.md` was authored against the **retired** cerebrum/cycle wire: log tag `[cerebrum:attention-gate] cycle dispatched`, `cycleId`, `message.delta` / `cycle.*` frames. None of that exists in 2.0. Re-ground each to `turnId`, `turn.*` frames, and the live log tags `[runtime:react-loop]`, `[runtime:session-runtime]`, `[ws:turn-emitter]`, `[provider:openai]`.

**⚠️ Three rows have never run in any form.** `delegate-hermes-bg`, `steer-midloop` and interrupt's background-cancel arm were impossible before this migration, because the containerized gateway could not spawn hermes. Expect real bugs, not a formality. Budget time for them.

---

- [ ] **Step 1: Bring up the stack and confirm the pre-state**

```bash
source scripts/env.sh
HOST_DOCKER_GID=0 docker compose -f deploy/macos/docker-compose.yml up -d   # addons only now
sudo launchctl kickstart -k system/io.sentient.gateway
until curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1:8888/api/v1/health | grep -q 200; do sleep 1; done
echo "stack ready"
```

- [ ] **Step 2: Re-ground the reusable case library**

Read `agents/docs/testing-knowledge.md` and, for each web case, rewrite its log-trail expectations onto the 2.0 wire. Record a before/after table in your report. A case still asserting `cycleId` or `cycle.done` is not a guard — it can never fire.

- [ ] **Step 3: Tune `compact_threshold_tokens` against the live model**

The default `24000` was chosen blind against `gpt-oss:20b-cloud`, whose real context window was never verified. If it is too high, `compaction-continue` never triggers inside a test session and the row silently passes without exercising anything.

Determine the model's real window, set the threshold so compaction fires within a reasonable test conversation, and **record the value and the reasoning** in your report and as an inline comment in `gateway/config.yaml`.

- [ ] **Step 4: Drive each row and record it in the fixed-column format**

For every case below, produce a row: `Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail`, plus a screenshot and the log excerpt under `qa/web/evidence/<date>-<case>/`.

| Case | Action | Key assertion |
|---|---|---|
| `native-turn-happy` | send a text message | reply streams token-by-token **and persists** after `turn.completed` — the committed feed is new in this branch and was broken twice; verify the bubble survives |
| `native-tool-call` | ask something needing a foreground MCP read | tool tile running→done; MCPs are on loopback now |
| `delegate-hermes-bg` | request a long/complex task | **never run before.** Model keeps responding; `{taskId}` returns immediately; delegation progress renders; result arrives later |
| `permission-confirm-web` | trigger a side-effecting tool (`ha_call_service`) | real blocking dialog; Allow executes; Deny blocks and informs the model; 2-min timeout auto-denies |
| `interrupt` | Stop during a reply with a background task running | turn + TTS stop; **background task cancelled** (the arm that could never run before) |
| `steer-midloop` | background task completes mid-loop | **never run before.** Result folds into the SAME reply, one bubble |
| `steer-followup-audio` | background task completes after the final answer | second bubble; its audio plays **after** the first finishes; the first is never cut |
| `barge-in` (UI arm only) | press Stop while TTS speaks | audio stops; partial committed with `cutoff: "barge-in"` |
| `reload-convergence` | reload mid-session | identical feed; `render(replay) == render(live)`; **tool tiles present** after reload |
| `compaction-continue` | chat past the tuned threshold | conversation stays coherent; full history still visible |
| `restart-persistence` | `launchctl kickstart -k`, reconnect | feed intact; **now exercises the native restart path** |
| `multi-user-isolation` | second user loads while the first is active | no cross-user data; cross-user file read denied |

- [ ] **Step 5: Hand the acoustic arm to Task 11**

The acoustic mic-onset trigger for `barge-in` is **not agent-drivable** — headless Chromium has no microphone, and fake-device flags do not reproduce acoustic echo, which is the actual thing under test. Record it for Task 11 with the exact manual steps and log lines. **Do not fake it and do not mark the row green on the UI arm alone.**

- [ ] **Step 6: Record every failure honestly**

For any red row: capture the evidence, determine whether it is a test-harness problem or a real product bug, and record which. A row that cannot be made green is either a bug to fix or a Task 11 handoff — never a silent omission.

- [ ] **Step 7: Add new reusable cases back to the library**

```bash
git commit -m "test(e2e): 2.0 web matrix re-grounded on the turn wire" -- \
  qa/web/ agents/docs/testing-knowledge.md gateway/config.yaml
```
