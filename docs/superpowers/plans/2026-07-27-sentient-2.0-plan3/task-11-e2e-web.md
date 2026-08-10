### Task 11: Web E2E — full 2.0 matrix on the frozen wire (spec §10.1, build-order slice 9)

**Implements:** spec §10 (walking-skeleton acceptance, all 12 criteria except voice §6) and §10.1's inline matrix, web rows. **Build-order slice 9.** Consumes T1's frozen wire contract verbatim, T2's audio wiring, T3's compaction, T4's `web-sdk` rebase, T6's permission round-trip, T7's webui permission dialog + tool tiles + delegation UI, T10's reconnect/replay journal — every prior task in this plan.

**Why this task exists:** every task from T1 through T10 is provable in isolation (unit + `bun run ci`), but the walking skeleton's actual acceptance bar (spec §10, items 1–12 minus the voice item) is "against the real local stack and real web + mobile clients." Nothing before this task has driven a real browser against the real dockerized gateway on the real 2.0 wire. This is where the whole plan either demonstrably walks or a gap between two tasks' assumptions (a renamed frame, a config key neither task actually wired, a log line that changed) surfaces for the first time. There is **no automated Playwright runner** in this repo — E2E is 100% agent-driven via Playwright MCP tools, per `.claude/rules/e2e-testing.md`.

**Wave:** 5 — the last wave. **Hard parallelism constraint (state this to whoever executes the task, not just to read once): one gateway container owns `:8888`.** T12 (native/Maestro E2E) drives the *same* local stack. Web and native E2E in this plan **MUST NOT run concurrently** — check nothing else is mid-run against `deploy/macos/` before Step 1, and do not start a native Maestro batch while this task's steps are in flight. If both are queued, finish one fully (including the gateway restarts inside it) before starting the other.

---

#### Files

**Create**
- `qa/web/evidence/2026-07-27-native-orchestrator-e2e/results.md` — the run's summary: one row per matrix case with verdict + evidence links.
- `qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-<NN>-<slug>/gateway-log-trail.txt` — grepped gateway log lines proving each case, one dir per case (12 dirs, `<NN>` = matrix row order below).
- `qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-<NN>-<slug>/console.txt` — `browser_console_messages` dump for that case.
- `qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-<NN>-<slug>/network.txt` — `browser_network_requests` dump where the case's Expected column references a specific request (most don't need this; WS-only cases skip it).
- `qa/web/evidence/2026-07-27-native-orchestrator-e2e/README.md` — one-time convention doc: this is the first `qa/web/evidence/` run, mirroring the existing `qa/mobile/evidence/<date>-<name>/` convention (see `agents/docs/testing-knowledge.md`'s Mobile section header) — establishes the pattern for future web E2E runs, not a special case of this one.

**Modify**
- `agents/docs/testing-knowledge.md` — regrounds every stale cerebrum-era case this task's run touches (see the regrounding table below) and appends the new reusable cases this run establishes.

**Do NOT touch:** any `gateway/**`, `shared/**`, or `gateway/webui/**` source file. This task drives the already-shipped product; if a case fails because a prior task's implementation is wrong, that is a bug report against that task (fix it there, re-run this task), never a patch applied from inside T11.

**Test:** none in the unit-suite sense — this task **is** the test. No `.test.ts` file is created or modified.

---

#### Pre-flight (read before Step 1)

- **Hermes reachability.** `delegateTask("hermes", …)` (cases 3, 8, 9, 10 below) shells out via `Bun.spawn(["hermes", "-p", <userId>, "-z", <prompt>])` (`gateway/src/tools/hermes-runner.ts`) from **inside whatever process the gateway runs in**. `deploy/macos/docker-compose.yml`'s `gateway` service Dockerfile does not install a `hermes` binary — the spec's own §1.2 flags the native-Hermes install/deploy story as an explicit follow-up, **not** part of this plan. Step 1 below includes a reachability probe; if it fails, every delegation-dependent case in this task is blocked, not broken — record it in `results.md` as `BLOCKED (hermes unreachable in gateway container)` with the probe output, do not attempt to fix the container image from this task, and hand off to the operator.
- **Two seeded family members exist.** `multi-user-isolation` (case 12) needs two already-provisioned users. This task does not create them — Step 2 discovers whichever userIds the login screen already lists (`GET` via the avatar grid, not hardcoded) and uses the first two.
- **Compaction's config key is not yet known to this task's author.** T3 (Wave 2) adds a `compaction` block to `orchestrator-config.ts` / `gateway/config.yaml` under `orchestrator:` (spec §8, following the exact pattern T6 used for `orchestrator.permission.request_timeout_ms`). Case 6 (`compaction-continue`) starts with a **discovery** step — grep the live `orchestrator:` block for the key — rather than a hardcoded path, because inventing one here would silently drift from whatever T3 actually shipped.
- **Case ordering is deliberate, not alphabetical.** Cases 1–4 build one continuous conversation (so reload/compaction/restart in cases 5–7 have real accumulated history to rebuild); cases 8–11 are short, isolated single-purpose conversations; case 12 is two-user. Follow the numbering — do not parallelize across cases within this task (one browser, one gateway, sequential by design).

---

#### Interfaces

**Consumes — the frozen wire contract (plan header, authored verbatim by T1; do not re-derive):**

```
Gateway → client: turn.started, turn.text.delta, turn.completed, turn.aborted,
  turn.tool.update, turn.audio.start, turn.audio.done, permission.request,
  permission.resolved, delegation.progress, playback.stop
  (retained: auth.ok, session.ready, error, pong, session.expired, sessions.*,
  stream.resumed; conversation.snapshot/entry retained but rekeyed cycleId→turnId)
Client → gateway: permission.response (replaces tool.confirm)
  (retained: session.configure incl. resume, audio.start{turnMode}, audio.end,
  text.input, interrupt, session.end, ping, session.new, conversation.activate)
```

**Consumes — verified log tags + exact message strings (grepped from the real source tree; every one of these already exists on disk except the three marked "T2/T3/T6/T7 — not yet landed when this task is authored, verify at execution time"):**

```
[runtime:react-loop]        react-loop.start | .tool-dispatch.foreground | .tool-dispatch.background |
                             .completed | .aborted-mid-stream | .aborted-mid-dispatch
[runtime:session-runtime]   session-runtime.turn.start | .turn.end | .turn.next-turn-trigger |
                             .submit.steer | .submit.start-turn
[runtime:turn-emitter]      turn-emitter.turn-started | .text-delta | .tool-update | .turn-completed |
                             .turn-aborted | .audio-start | .audio-frame | .audio-done |
                             .permission-request | .permission-resolved | .delegation-progress
                             (headless-harness default; the real client wire is [ws:turn-emitter])
[ws:turn-emitter]           same event names as above, over the real WS — this is the tag to grep
                             for browser-driven evidence (gateway/src/session-handlers/ws-turn-emitter.ts)
[provider:openai]           (streaming request/response lifecycle — exact event names verified at
                             execution time; T1/T2 own this file)
[tools:tool-broker]         tool-broker.pdp.decision action=<allow|deny|confirm> | .pdp.confirm-resolved |
                             .dispatch.foreground.done | .dispatch.background.started |
                             .dispatch.background.completed
[tools:delegate-task]       delegate-task.run.guard-decision action=<allow|confirm|deny> | .run.ok | .run.failed
[tools:delegation-guard]    delegation-guard.evaluate agent=hermes action=<allow|confirm|deny> tier=<low|medium|high>
[tools:hermes-runner]       hermes-runner.run.start | .run.ok
[tools:background-registry] background-registry.cancel-all
[runtime:cancellation]      cancellation.abort cutoff=<interrupt|barge-in> | .cutoff.committed |
                             .background.cancel-all
[access:access-manager]     capability.minted userId=<id> resource=<class>
[store:session-store]       store.opened userId=<id> | store.closed
[store:model-projection]    projection.compacted compactedThroughSeq=<n>
[ws:session-configure]      (session.ready lifecycle — exact event names verified at execution time)
permission-broker.*         T6-produced tag/messages — verify exact tag at execution time
                             (task-6.md's own inline matrix cites permission-broker.request /
                             .settled reason=<allowed|denied|timeout> / .deny-all)
```

The gateway logs to BOTH stderr (always) and a daily-rotating file (`~/.sentient/gateway/logs/YYYY-MM-DD.log` on the macOS host, bind-mounted from `/app/logs` — see `deploy/macos/docker-compose.yml`'s gateway volumes), both through the identical formatter (`gateway/src/logging/logger.ts#createGatewayLogger`). `docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=N` is a valid, already-established way to grep recent lines (used throughout `agents/docs/e2e-testing-details.md`) — but it only covers the CURRENT container process's stdout buffer, which resets on `docker compose restart`. Case 7 (restart-persistence) only asserts POST-restart lines, so `docker compose logs` is fine there; if a step ever needs to look BACK across a restart boundary, grep the host file directly instead.

**Consumes — browser console tags (verified from `shared/web-sdk/src/logger.ts`'s `[${tags.join(".")}]` format and each connector's actual `createLogger` call; T4's rebase — confirm these landed under these exact names at execution time, they do not exist under the pre-rebase names below):**

```
[sentient.sdk.turn-audio-queue]                  — replaces the retired [sentient.webui.cycle-audio-queue]
[sentient.sdk.connectors.inflight-message]
[sentient.sdk.connectors.cognition-status]
[sentient.sdk.connectors.tool-status]             — new in T4, no pre-2.0 equivalent
[sentient.sdk.connectors.assistant-audio-response]
[sentient.sdk.connectors.permission-confirm]      — new in T4, no pre-2.0 equivalent
[sentient.sdk.connectors.delegation-progress]     — new in T4, no pre-2.0 equivalent
[sentient.webui.audio-playback]                   — unchanged, still webui-owned
[sentient.webui.voice-client]                     — unchanged, still webui-owned
```

**Consumes — reusable cases by short name (do not duplicate bodies; drive exactly as documented there once T6/T7 land):** `permission-confirm-approve`, `permission-confirm-deny`, `permission-timeout`, `delegation-progress`, `tool-tile-timing`, `turn-aborted-frame` — all six defined in Task 6's own inline E2E matrix (`docs/superpowers/plans/2026-07-27-sentient-2.0-plan3-voice-wire-clients-compaction-e2e.md`, Task 6 section). This task's case 4 (`permission-confirm-web`) and case 9 (`interrupt`) execute those, and — per this task's own finalize step — this task is what actually promotes them into `agents/docs/testing-knowledge.md` (Task 6 only *defined* them inline; nothing added them to the reusable-case library until a task actually ran them).

**Produces (for future E2E runs to extend, not for any code to import):**
- The `qa/web/evidence/<date>-<slug>/` directory convention — mirrors `qa/mobile/evidence/<date>-<name>/`, described once in this run's `README.md`.
- Regrounded + newly-appended entries in `agents/docs/testing-knowledge.md` under a new `## Native orchestrator (2.0 wire)` section.

---

#### The matrix (inline, per `.claude/rules/e2e-testing.md`) — web rows of the spec §10.1 13-row table

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| 1. native-turn-happy | desktop 1280×900 + mobile 390×844 | authed, empty session (fresh chat) | send "Give me a two-sentence fun fact about octopuses." | reply streams token-by-token into one assistant bubble; reply persists after streaming ends | `[access:access-manager] capability.minted`; `[runtime:session-runtime] session-runtime.turn.start` then `.turn.end`; `[provider:openai]` stream lifecycle; `[ws:turn-emitter] turn-emitter.turn-started trigger=user` → repeated `.text-delta` → `.turn-completed`; `[store:session-store]` append (user, assistant) |
| 2. native-tool-call | desktop only (mobile covered by case 1's viewport; tool-tile layout is case 7's job on T7, not re-verified here) | continues case 1's session | ask "What's the state of the living room light?" | a tool tile appears on the bubble (running → done) before the final answer streams | `[tools:tool-broker] tool-broker.pdp.decision tool=ha_get_state action=allow` (or `ha_search_entities`, whichever the model picks from the `home_assistant` catalog's `include` list); `.dispatch.foreground.done`; `[ws:turn-emitter] turn-emitter.tool-update` with `argsPreview`, `startedAtMs`, and (on the terminal update) `endedAtMs`; store append (tool_call, tool_result) |
| 3. delegate-hermes-bg | desktop only | continues case 2's session | ask "Please delegate this to Hermes: research the top 3 noise-cancelling headphones under $200 and summarize the trade-offs." | assistant keeps responding/streaming without blocking; a delegation tile shows running, then flips to done when Hermes returns (result may arrive well after the turn ends — that's expected, note it in evidence, do not wait synchronously) | `[tools:delegation-guard] delegation-guard.evaluate agent=hermes action=allow tier=low` (a plain research prompt has no injection-scanner hits); `[tools:tool-broker] tool-broker.dispatch.background.started`; `[ws:turn-emitter] turn-emitter.delegation-progress status=running`; loop is NOT blocked — `turn.completed` for THIS turn fires before Hermes returns; later, off-turn: `[tools:hermes-runner] hermes-runner.run.ok`; `tool-broker.dispatch.background.completed`; `turn-emitter.delegation-progress status=done` |
| 4. permission-confirm-web | desktop 1280×900 + mobile 390×844 | continues case 3's session (desktop); fresh short session (mobile) | ask "Please turn on the kitchen light" (routes to `ha_call_service`, which T6 adds a `confirm` policy rule for); Approve on desktop, Deny on mobile | real permission **dialog** (T7's webui component) — tool name, human-readable action summary, Allow/Deny; NOT auto-approved. Desktop: Allow → tool executes, answer streams. Mobile: Deny → dialog dismisses, assistant explains it wasn't permitted | drives T6's `permission-confirm-approve` (desktop) and `permission-confirm-deny` (mobile) reusable cases verbatim — see those for the exact log lines (`tool-broker.pdp.decision action=confirm`, `permission-broker.request`, `permission-broker.settled reason=<allowed\|denied>`, `permission.resolved` frame out) |
| 5. reload-convergence | desktop 1280×900 + mobile 390×844 | the case-1→4 desktop session now has: 1 plain turn, 1 foreground tool call, 1 background delegation, 1 confirmed permission tool call | hard-reload the tab | identical feed to pre-reload — same bubbles, same tool tiles, same order, no extra/missing tiles, no "weird tile only on reload" | `render(replay) == render(live)` per spec §3.2 — no gateway-side assertion possible from the browser; this case's oracle IS the two `browser_snapshot` captures (pre- and post-reload) matching bubble-for-bubble. `conversation.snapshot`/`conversation.entry` frames arrive rekeyed (`turnId`, not `cycleId`) |
| 6. compaction-continue | desktop 1280×900 | same session, `orchestrator.compaction.*` threshold temporarily lowered (see Step — discover the real key first) | send several more short turns to cross the lowered threshold, then one more normal turn | conversation continues coherently (model still has enough context to reference the earlier headphone/light exchange); full history — including cases 1–5's tiles — still visible in the feed, nothing collapses or disappears | `[store:model-projection] projection.compacted compactedThroughSeq=<n>`; a `compaction` entry appended (never a mutation — Invariant A); the NEXT turn's `[provider:openai]` request carries the compacted-forward slice, not the full history (verify via request size/log, not by reading the raw prompt) |
| 7. restart-persistence | desktop 1280×900 + mobile 390×844 | the full case-1→6 session exists on disk | `docker compose -f deploy/macos/docker-compose.yml restart gateway`; wait for health; reload the tab | past-chat list still lists this conversation; full feed (all of cases 1–6's tiles, including the compaction marker) rebuilds identically; message timestamps are still present and correct (not reset to restart time) | `[store:session-store] store.opened userId=<id>` on gateway boot; no `WARN`/`ERROR` during store open; feed matches the pre-restart `browser_snapshot` from case 6 |
| 8. barge-in | desktop 1280×900 | fresh short session; a turn is mid-flight with TTS audio playing | user presses-and-holds the mic control and speaks over the assistant | TTS audio stops; the bubble renders as cut off (interrupted marker, cutoff kind barge-in); any background task from the same turn keeps running, unaffected | `[runtime:cancellation] cancellation.abort cutoff=barge-in`; `.cutoff.committed`; `[ws:turn-emitter] turn-emitter.turn-aborted cutoff=barge-in` → `turn.aborted` frame out; **NO** `background.cancel-all` line (background tasks are untouched on barge-in, only on interrupt) — see the caveat below, this case has a real acoustic-input dependency and a documented two-tier drive procedure |
| 9. interrupt | desktop 1280×900 | fresh short session; a turn is mid-flight with a background delegation running AND TTS audio playing | click the Interrupt button | turn + TTS stop; the running background task is cancelled; bubble renders cut off (cutoff kind interrupt) | drives T6's `turn-aborted-frame` reusable case, plus the background-cancel half: `[runtime:cancellation] cancellation.abort cutoff=interrupt` → `.background.cancel-all`; `[tools:background-registry] background-registry.cancel-all`; `turn.aborted` frame out exactly once even if the user double-clicks (idempotent) |
| 10. steer-midloop | desktop 1280×900 | fresh short session | one message that both delegates to Hermes (background) AND asks the assistant to check 2–3 more things itself (multiple foreground tool calls, buying wall-clock time) | the delegation's result is folded into the SAME reply — one bubble, not two — if the background completion lands before the loop's final `stop` | `[tools:tool-broker] tool-broker.dispatch.background.started` then, WHILE `[runtime:react-loop]` is still iterating (more `.tool-dispatch.foreground` lines after it), `.dispatch.background.completed`; `[runtime:session-runtime] session-runtime.submit.steer` (NOT `.submit.start-turn`) — this is the log line that proves steer, not a second turn; exactly one `turn.completed` for the whole exchange. **Timing is real and non-deterministic** — see the retry note below |
| 11. steer-followup-audio | desktop 1280×900 | fresh short session, TTS on | one message that delegates to Hermes (background) then gives its own short final answer immediately ("say 'Okay, working on it!' and stop") | the quick reply's audio finishes (or is still playing) before Hermes returns; when Hermes completes, a SECOND bubble appears with its own audio that plays AFTER the first — never cutting the first off | `[runtime:session-runtime] session-runtime.turn.next-turn-trigger` (NOT `.submit.steer`) — proves a fresh back-to-back turn, not a fold; a second `turn.started trigger=background-completion`; **no** `playback.stop` frame anywhere in this case (the gateway never stops its own audio, spec §4.7/§7.2); client audio queues by turnId, does not replace |
| 12. multi-user-isolation | desktop 1280×900, two tabs | two already-provisioned family members, each logged into their own tab (per-tab `sessionStorage`, confirmed isolated by `gateway/webui/src/hooks/use-auth.tsx`'s "two tabs, two accounts" design) | user B sends a message while user A's session is mid-turn; observe both tabs | tab B's chat shows only B's own history (never A's); tab A's turn is unaffected by B's activity; neither tab can see the other's past-chat list | `[access:access-manager] capability.minted userId=<A>` and a SEPARATE `capability.minted userId=<B>`; TWO distinct `[store:session-store] store.opened userId=<...>` lines with different userIds; on disk, `~/.sentient/gateway/users/<A>/sessions.db` and `~/.sentient/gateway/users/<B>/sessions.db` are separate files. **Cross-user file-path denial itself is a security-boundary unit test** (`gateway/src/access/file-scope.test.ts`, `access-manager.test.ts` — already green per this plan's "Already DONE" slices), not re-driven here: no MCP tool in `gateway/config.yaml#mcp_catalog` currently exposes an arbitrary filesystem path argument a user could point at another user's home dir, so there is no live UI action that attempts it. This case proves DATA isolation (the reachable half); note the PATH-deny mechanism as already-covered, not skipped |

**voice-roundtrip has no web equivalent — stated explicitly, not silently dropped.** Per the existing charter (`qa/web/charters/smoke.md`'s "Things to skip"): "Voice/mic flow — requires real audio input; can't be verified in headless Chrome without `--use-fake-device-for-media-stream`." The Playwright MCP browser session this task drives has no fake-audio-capture device configured and no tool surface to add one mid-session. STT→native-loop→TTS is instead covered by: the STT/TTS wire itself (unit + `@live` per T2), and — partially — case 8 below, which hits the identical acoustic-input wall and documents the same limitation rather than pretending around it.

---

#### Regrounding note — every stale reusable case gets remapped before use

`agents/docs/testing-knowledge.md` was authored entirely against the retired cerebrum/cycle wire. Do not run any of its existing cases as-is against the 2.0 gateway; the log lines it asserts (`[cerebrum:attention-gate] cycle dispatched`, `cycleId`, `message.delta`, `cycle.*`) no longer exist. The Step below applies this table when editing the doc:

| Stale (cerebrum-era) | 2.0 replacement |
|---|---|
| `[cerebrum:attention-gate] cycle dispatched \| cycleId="<ms>"` | `[runtime:session-runtime] session-runtime.turn.start \| turnId="<uuid>"` |
| `cycleId` (server-unique `Date.now()` string) | `turnId` (`crypto.randomUUID()`) |
| `message.delta` / `message.done` | `turn.text.delta` / `turn.completed` |
| `cycle.started` / `cycle.aborted` / `cycle.completed` | `turn.started` / `turn.aborted` / `turn.completed` |
| `task.update` | `turn.tool.update` |
| `tool.confirm_request` / `tool.confirm` | `permission.request` / `permission.response` |
| `connector.audio.start` / `connector.audio.done` | `turn.audio.start` / `turn.audio.done` |
| `[sentient.webui.cycle-audio-queue]` | `[sentient.sdk.turn-audio-queue]` (moved from webui into `shared/web-sdk` — the webui adapter is deleted by T7) |
| `[hermes-adapter-client:...]` anything | gone — the ACP client is retired, not dormant (per this project's own CLAUDE.md) |

Cases this run's Step 20 regrounds: **"Tool pill renders on tool call"**, **"Distinct cycleId per turn…"** (rename to "Distinct turnId per turn…", drop the small-integer-ACP-counter caveat entirely — that counter's source no longer exists), **"Speaking state tracks audio drain, not cycle end"**, **"Interrupt stops audio within ~30ms"**, **"Cycle serialization (queued message does not overlap current TTS)"** → rename to "Turn audio queueing (queued message never overlaps or cancels current TTS)" and flip its expectation from *preempt-with-fade* to *strict FIFO append* (spec §7.2 — this is a real behavior change, not just a rename), **"Cross-turn tool pill persistence"**. Cases NOT touched (genuinely orthogonal to the wire rewrite): all idle/presence cases, the wizard smoke, the Fish voice cases, the local-tts WS-probe cases, the voice-pack language cases, all Mobile (`T1`–`T10`) cases (those are a different task's problem — T12).

---

#### Steps

- [ ] **Step 1: Confirm no concurrent native E2E run, then bring up the stack.**
  ```bash
  # Parallelism gate — do not proceed if a Maestro batch (T12) is mid-run against this stack.
  docker compose -f /Users/kevinye/Development/sentient/deploy/macos/docker-compose.yml ps
  source /Users/kevinye/Development/sentient/scripts/env.sh
  HOST_DOCKER_GID=0 docker compose -f deploy/macos/docker-compose.yml build gateway
  HOST_DOCKER_GID=0 docker compose -f deploy/macos/docker-compose.yml up -d
  until curl -sk -o /dev/null -w "%{http_code}" https://localhost:8888/ | grep -q 200; do sleep 1; done
  ```

- [ ] **Step 2: Hermes reachability probe (pre-flight).**
  ```bash
  docker compose -f deploy/macos/docker-compose.yml exec gateway which hermes
  ```
  Record the result. If `hermes` is NOT found, write `qa/web/evidence/2026-07-27-native-orchestrator-e2e/results.md`'s cases 3, 8 (partially), 9 (partially), 10, 11 as `BLOCKED (hermes unreachable in gateway container — see spec §1.2, native-Hermes install is an explicit follow-up outside this plan)` immediately, and skip straight to Step 22 (the non-delegation cases still run). Do not attempt a container-image fix here.

- [ ] **Step 3: Create the evidence directory tree and the one-time README.**
  ```bash
  cd qa/web/evidence/2026-07-27-native-orchestrator-e2e 2>/dev/null || mkdir -p qa/web/evidence/2026-07-27-native-orchestrator-e2e
  cd /Users/kevinye/Development/sentient
  for d in 01-native-turn-happy 02-native-tool-call 03-delegate-hermes-bg 04-permission-confirm-web \
           05-reload-convergence 06-compaction-continue 07-restart-persistence 08-barge-in \
           09-interrupt 10-steer-midloop 11-steer-followup-audio 12-multi-user-isolation; do
    mkdir -p "qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-$d"
  done
  ```
  Write `qa/web/evidence/2026-07-27-native-orchestrator-e2e/README.md`:
  ```markdown
  # qa/web/evidence/ convention

  Mirrors `qa/mobile/evidence/<date>-<name>/` (see `agents/docs/testing-knowledge.md`'s
  Mobile section header). Each dated run directory holds:
  - `results.md` — one row per matrix case, verdict + links.
  - `case-<NN>-<slug>/gateway-log-trail.txt` — grepped log lines proving the case.
  - `case-<NN>-<slug>/console.txt` — `browser_console_messages` dump.
  - `case-<NN>-<slug>/network.txt` — where the case's Expected column names a request.

  Screenshots are captured during the run but not committed — the repo-wide
  `*.png` gitignore rule (see root `.gitignore`) already excludes them from
  every directory, `qa/web/evidence/` included. Text evidence (log/console/
  network dumps, markdown notes) IS committed — same as `qa/mobile/evidence/`.
  ```

- [ ] **Step 4: Discover the two seeded users for case 12, and note them in `results.md`.**
  Open `https://localhost:8888` via `browser_navigate`, `browser_resize(1280, 900)`, `browser_snapshot` — read the avatar grid's accessible names/ids. Record the first two userIds found as `<userA>` / `<userB>` for later steps. If fewer than two users exist, note case 12 as `BLOCKED (needs a second family member — none provisioned)` and continue; do not create one from this task (user provisioning is out of this task's scope).

- [ ] **Step 5 (case 1, desktop): Log in and start the primary session.**
  `browser_navigate` to `https://localhost:8888`, resize to 1280×900, log in as `<userA>` (avatar tap → PIN pad). `browser_snapshot` to confirm the chat view renders empty.

- [ ] **Step 6 (case 1, desktop): Send the plain-text turn.**
  `browser_type` (or `browser_fill`) into the composer textarea (placeholder "Type or speak — Sentient will listen"), text: `Give me a two-sentence fun fact about octopuses.` `browser_press_key("Enter")`.

- [ ] **Step 7 (case 1, desktop): Capture the streamed reply and evidence.**
  `browser_snapshot` once the reply finishes streaming (bubble stops growing). `browser_take_screenshot`. `browser_console_messages` → save to `case-01-native-turn-happy/console.txt`.
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=500 \
    | grep -E "turn-emitter|session-runtime.turn|capability.minted" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-01-native-turn-happy/gateway-log-trail.txt
  ```
  Verify the log file shows `capability.minted`, `session-runtime.turn.start` → `.turn.end`, and a `turn-emitter.turn-started` → repeated `.text-delta` → `.turn-completed` sequence for a SINGLE `turnId`. No `WARN`/`ERROR`.

- [ ] **Step 8 (case 1, mobile): Repeat at 390×844.**
  Open a second tab (`browser_tabs`) OR reuse the same tab resized to 390×844 for a FRESH short exchange (do not reuse case 1's desktop turnId — mobile viewport gets its own short "what's 9 times 6" turn). Capture screenshot only; the log-trail assertion from Step 7 already pins the mechanism, this pass is layout/viewport verification (composer doesn't clip, bubble text wraps, no horizontal scroll).

- [ ] **Step 9 (case 2): Trigger a foreground MCP tool call in the SAME desktop session.**
  Resize back to 1280×900 if you switched. Send: `What's the state of the living room light?` Watch for a tool tile appearing on the bubble mid-stream (running) then flipping to done before the final answer.

- [ ] **Step 10 (case 2): Capture and assert the tool-call log trail.**
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=200 \
    | grep -E "tool-broker.pdp.decision|dispatch.foreground.done|turn-emitter.tool-update" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-02-native-tool-call/gateway-log-trail.txt
  ```
  Verify `tool-broker.pdp.decision` shows `action=allow` for whichever `ha_*` read tool the model picked, `dispatch.foreground.done isError=false`, and the `turn-emitter.tool-update` lines carry `argsPreview`/`startedAtMs` (running) then also `endedAtMs` (the terminal one, per the frozen `turn.tool.update` shape).

- [ ] **Step 11 (case 3): Trigger `delegateTask` in the SAME session.**
  Skip if Step 2 flagged Hermes unreachable. Send: `Please delegate this to Hermes: research the top 3 noise-cancelling headphones under $200 and summarize the trade-offs.` `browser_snapshot` immediately once the turn's OWN text finishes (do not wait for Hermes) — confirm a delegation tile shows `running` and the assistant's own reply is NOT blocked.

- [ ] **Step 12 (case 3): Verify the model actually called `delegateTask` (LLM compliance is not guaranteed).**
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=100 \
    | grep -E "delegation-guard.evaluate|dispatch.background.started"
  ```
  If neither line appears, the model didn't call the tool this time — retry with a more explicit prompt: `Use the delegateTask tool with agent="hermes" to research...`. Do not proceed past this step without confirming a real background dispatch happened; a case that silently skips the tool call is not testing what it claims to.

- [ ] **Step 13 (case 3): Poll for the delegation's completion (off-turn, may take minutes — `hermes_timeout_ms` defaults to 600000).**
  Send a throwaway follow-up turn a few minutes later (e.g. "any update?") to force a fresh `browser_snapshot`, or poll the gateway log directly:
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=50 -f \
    | grep -m1 "delegation-progress status=done"
  ```
  Once seen, `browser_snapshot` to confirm the delegation tile flipped to done and its result rendered. Save the full trail to `case-03-delegate-hermes-bg/gateway-log-trail.txt`.

- [ ] **Step 14 (case 4, desktop Approve): Trigger the confirm-tier tool.**
  Send: `Please turn on the kitchen light`. `browser_snapshot` — a permission dialog must render (tool name, args summary, Allow/Deny). Click Allow.

- [ ] **Step 15 (case 4, desktop): Assert approve log trail, save evidence.**
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=100 \
    | grep -E "tool-broker.pdp.decision action=confirm|permission-broker|confirm-resolved|dispatch.foreground.done" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-04-permission-confirm-web/gateway-log-trail.txt
  ```
  This is T6's `permission-confirm-approve` reusable case — verify against its exact expected lines in Task 6's own matrix (`tool-broker.pdp.decision action=confirm`, `permission-broker.request`, `permission-broker.settled reason=allowed`, `confirm-resolved confirmed=true`, `dispatch.foreground.done`).

- [ ] **Step 16 (case 4, mobile Deny): Fresh short session, deny path.**
  New tab or same tab resized to 390×844, fresh chat (this is intentionally NOT the accumulated session — deny needs a clean turn to observe "assistant adapts"). Log in as `<userA>` again, send `Turn on the kitchen light`, click Deny on the dialog. Confirm the assistant's next text explicitly says the action wasn't permitted (not a silent failure). Append the deny log lines (`permission-broker.settled reason=denied`, `dispatch.denied`) to the same evidence file, labeled separately.

- [ ] **Step 17 (case 5, desktop): Snapshot before reload.**
  Back on the case-1→4 desktop tab (1280×900). `browser_snapshot` — save the full accessibility tree text as `case-05-reload-convergence/pre-reload-snapshot.txt`.

- [ ] **Step 18 (case 5, desktop): Reload and re-snapshot.**
  `browser_navigate` to the same URL (or hard refresh). Wait for the feed to finish rebuilding. `browser_snapshot` → save as `post-reload-snapshot.txt`. Diff the two by eye: same bubble count, same tool/delegation tiles, same order, same text. Any bubble present in one and not the other is a FAIL — file it as a bug against whichever task owns the diverging projection (most likely T1's `conversation.entry` rekey or T7's client rendering), not something this task patches.

- [ ] **Step 19 (case 5, mobile): Repeat the reload check at 390×844.**
  Same session, resized tab. Screenshot only (the desktop pass already pins the mechanism); this confirms layout survives reload at the narrow viewport too.

- [ ] **Step 20 (case 6): Discover the real compaction config key.**
  ```bash
  grep -n "orchestrator:" -A 40 gateway/config.yaml | grep -B2 -A6 -i compact
  ```
  If T3 hasn't landed a `compaction` block yet, this case is `BLOCKED (T3 not landed)` — record and skip to Step 24. Otherwise note the exact key path (following the `orchestrator.permission.request_timeout_ms` pattern, expect something like `orchestrator.compaction.compact_threshold` — use whatever is ACTUALLY there, do not assume this name).

- [ ] **Step 21 (case 6): Lower the threshold in the operator config, restart, continue chatting.**
  Edit `~/.sentient/gateway/config/config.yaml` in place (never overwrite from the repo template — per this project's own config rule) to set the discovered key to a small value that cases 1–5's accumulated history should already exceed or nearly exceed. Restart: `docker compose -f deploy/macos/docker-compose.yml restart gateway`; wait for health. Reload the desktop tab, send 2–3 more short turns (e.g. "what's 2+2", "and 3+3", "summarize what we've talked about so far — mention the headphones and the kitchen light").

- [ ] **Step 22 (case 6): Assert compaction happened and history still renders.**
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=300 \
    | grep -E "projection.compacted|compaction" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-06-compaction-continue/gateway-log-trail.txt
  ```
  Verify `projection.compacted compactedThroughSeq=<n>` appears, the "summarize" turn's answer coherently references the pre-compaction headphones/light exchange (proves the compacted-forward model context still has enough signal — a summary, not amnesia), and `browser_snapshot` shows ALL prior tiles (cases 1–5) still present in the client feed (client projection never shrinks, spec §3.4). **Restore the operator config to its original value and restart the gateway** before proceeding — do not leave the threshold artificially lowered for the rest of this task's cases.

- [ ] **Step 23 (case 7): Restart the gateway, verify persistence.**
  ```bash
  docker compose -f deploy/macos/docker-compose.yml restart gateway
  until curl -sk -o /dev/null -w "%{http_code}" https://localhost:8888/ | grep -q 200; do sleep 1; done
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=50 \
    | grep -E "store.opened|WARN|ERROR" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-07-restart-persistence/gateway-log-trail.txt
  ```
  Reload both the desktop and mobile-viewport tabs. Confirm the past-chat list still shows this conversation and the full feed (including the compaction marker from case 6) rebuilds identically to case 6's post-compaction `browser_snapshot`; message timestamps are unchanged (not reset to the restart time — verify against a `<time>` element's `dateTime` attribute, not just the rendered label).

- [ ] **Step 24 (case 8, part 1): Attempt barge-in via the real mic gesture.**
  Fresh short session. Send a prompt likely to produce a long spoken reply (e.g. "tell me a 200-word story about a lighthouse") so TTS has time to be playing. Once `turn.audio.start` fires (audio visibly/audibly playing, or confirm via console `[sentient.sdk.connectors.assistant-audio-response]`), press-and-hold the mic control (`aria-label="..."` on `MicCorner` — confirm the exact label via `browser_snapshot` at execution time) and, if the sandbox has a working system microphone, speak. Wait up to 5s for `turn.aborted{cutoff:"barge-in"}` / a `cancellation.abort cutoff=barge-in` log line.
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=100 \
    | grep -E "cancellation.abort|turn-emitter.turn-aborted|mic-start-failed" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-08-barge-in/gateway-log-trail.txt
  ```

- [ ] **Step 25 (case 8, part 2 — fallback if Step 24 doesn't fire).**
  Mic-onset barge-in requires the STT service's real VAD (Silero) to detect genuine speech energy in the inbound PCM (`vad_start` → the adapter's `turn_started` event) — this is the SAME acoustic-input class the project's own `qa/web/charters/smoke.md` already defers ("Voice/mic flow — requires real audio input; can't be verified in headless Chrome without `--use-fake-device-for-media-stream`"), and this Playwright MCP session has no fake-audio-file device configured. If Step 24 produced no `getUserMedia` grant (mic-corner resets to idle, `mic-start-failed` in console) OR produced `audio.start` with no subsequent VAD onset, **do not fabricate synthetic PCM to trick the VAD model** (that would test the VAD's tolerance, not the real user flow, and violates the "no mocking in smoke" rule). Instead: mark case 8 `PARTIAL — mechanism-only` in `results.md`. The abort MECHANISM itself (abort turn + TTS, keep background tasks, commit cutoff=barge-in) is already pinned by `cancellation.ts`'s dedicated unit/FSM regression tests (Global Constraints — these exist before this task runs); what's unverified here is only the acoustic TRIGGER. File it in the `## Operator follow-up` section alongside voice-roundtrip: same root cause, needs a real device or a `--use-file-for-fake-audio-capture` Playwright launch config this task cannot configure.

- [ ] **Step 26 (case 9): Interrupt with a background task in flight.**
  Skip the delegation half if Step 2 flagged Hermes unreachable (still run the plain-interrupt half). Fresh short session. Send: `Please delegate to Hermes: write a 200-word essay about volcanoes — that can take a while. While it's running, tell me a detailed 300-word explanation of how photosynthesis works yourself.` Once both the delegation tile shows running AND the assistant's own text is streaming, click the Interrupt button (`aria-label="Interrupt"`).

- [ ] **Step 27 (case 9): Assert interrupt log trail — turn, TTS, AND background all stop.**
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=100 \
    | grep -E "cancellation.abort|background.cancel-all|turn-emitter.turn-aborted" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-09-interrupt/gateway-log-trail.txt
  ```
  Verify `cancellation.abort cutoff=interrupt` → `background.cancel-all`, exactly one `turn-emitter.turn-aborted`, and the bubble renders with an interrupted marker. Click Interrupt a second time on a settled turn (idempotency check per T6's `turn-aborted-frame` case) — confirm no second `turn.aborted` frame.

- [ ] **Step 28 (case 10): Bias the timing toward mid-loop steer.**
  Skip if Hermes unreachable. Fresh short session. Send: `Delegate to Hermes: research three good desk-lamp brands and summarize (background task). While that's running, check the state of the living room light, then the kitchen light, then the bedroom light, and tell me if any are on.` — the three sequential HA reads buy loop iterations for the delegation to land mid-flight.

- [ ] **Step 29 (case 10): Verify from the timestamps which branch actually happened, retry if wrong.**
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=150 \
    | grep -E "dispatch.background.started|dispatch.background.completed|tool-dispatch.foreground|submit.steer|submit.start-turn|turn-emitter.turn-completed" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-10-steer-midloop/gateway-log-trail.txt
  ```
  This case is only proven if `dispatch.background.completed` appears BEFORE the loop's own `turn-emitter.turn-completed`, AND the log shows `session-runtime.submit.steer` (not `.submit.start-turn`) for the completion stimulus, AND the client shows exactly ONE bubble containing both the light-check answers and the desk-lamp summary. If Hermes finished too fast or too slow (real wall-clock, not controllable), the log trail will show `.submit.start-turn` instead — that's case 11's shape, not a case-10 failure; re-run Step 28 with a longer foreground chain (add a 4th/5th HA read) and retry.

- [ ] **Step 30 (case 11): Bias the timing toward after-final-answer steer.**
  Skip if Hermes unreachable. Fresh short session, TTS on. Send: `Delegate to Hermes: write a haiku about the ocean (background task), then just say "Okay, working on it!" to me right away and stop.`

- [ ] **Step 31 (case 11): Verify two bubbles, two audio streams, correct queueing.**
  Wait for the quick first reply to finish (turn completed, audio playing or done). Then wait for the delegation to complete (poll per Step 13's pattern). Confirm a SECOND bubble appears with the haiku, its own `turn.started{trigger:"background-completion"}`, and — if the first bubble's audio was still playing when the second's `turn.audio.start` arrived — that the second audio visibly queues (does not cut off / overlap the first). Console-check for `[sentient.sdk.turn-audio-queue]` append events (not a preempt/fade). Assert via log:
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=100 \
    | grep -E "next-turn-trigger|turn-started|playback.stop" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-11-steer-followup-audio/gateway-log-trail.txt
  ```
  There must be NO `playback.stop` line anywhere in this trail — the gateway never stops its own audio (spec §4.7/§7.2 invariant; a `playback.stop` here is a hard fail, not a flake to retry).

- [ ] **Step 32 (case 12): Two tabs, two users, concurrent activity.**
  Use `<userA>`/`<userB>` from Step 4. Open tab B (`browser_tabs`, new tab), navigate to `https://localhost:8888`, log in as `<userB>` (independent PIN entry — sessionStorage keeps tab A's `<userA>` token untouched, per `use-auth.tsx`'s per-tab design). In tab A, send a message and, WHILE it's streaming, switch to tab B and send a different message.

- [ ] **Step 33 (case 12): Assert isolation — UI and logs.**
  Confirm tab B's history shows ONLY `<userB>`'s messages (no bleed from A), tab A's turn completes normally undisturbed by B's activity, and neither tab's past-chat list shows the other user's conversations.
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=100 \
    | grep -E "capability.minted|store.opened" \
    > qa/web/evidence/2026-07-27-native-orchestrator-e2e/case-12-multi-user-isolation/gateway-log-trail.txt
  ls -la ~/.sentient/gateway/users/
  ```
  Confirm two distinct `capability.minted userId=...` lines (one per user), two distinct `store.opened userId=...` lines, and two separate directories under `~/.sentient/gateway/users/` each containing their own `sessions.db`. Note in `results.md` that the path-deny half of isolation is covered by the existing `file-scope.test.ts`/`access-manager.test.ts` unit suite, not re-driven here (no reachable tool surface — see the matrix row's own note).

- [ ] **Step 34: Write `results.md` — the run summary.**
  One row per case (1–12), columns: Case | Verdict (PASS / PARTIAL / BLOCKED / FAIL) | Evidence dir | Notes. Every PARTIAL/BLOCKED/FAIL gets a one-line reason cross-referencing the relevant step.

- [ ] **Step 35: Reground the stale cases in `agents/docs/testing-knowledge.md`.**
  Apply the regrounding table above. For each of the six named cases ("Tool pill renders on tool call", "Distinct cycleId per turn…" → rename, "Speaking state tracks audio drain…", "Interrupt stops audio within ~30ms", "Cycle serialization…" → rename + flip expectation, "Cross-turn tool pill persistence"): update every `cycle.*`/`cycleId`/`message.*`/`[cerebrum:...]`/`[sentient.webui.cycle-audio-queue]` reference in place to its 2.0 equivalent from the table. Do not touch the Mobile (`T1`–`T10`), Wizard, Fish, local-tts, or voice-pack-language sections — those are unaffected by the wire rewrite.

- [ ] **Step 36: Append the new reusable cases this run establishes.**
  Add a new `## Native orchestrator (2.0 wire)` section to `agents/docs/testing-knowledge.md`, after the existing `## Cases` section, with one `###` entry per case this task proved end-to-end for the first time (native-turn-happy through multi-user-isolation, using this task's own case numbering as the anchor, Scenario/Why added/Steps/Expected shape matching the rest of the file). Cross-reference T6's `permission-confirm-approve`/`permission-confirm-deny`/`turn-aborted-frame` by name rather than re-describing them. Explicitly note voice-roundtrip's "no web equivalent" and barge-in's acoustic-input caveat (Steps 24–25) as a shared `### Voice/mic-onset flows — real audio required` entry, so the NEXT agent who reads this file doesn't rediscover the same wall.

- [ ] **Step 37: Commit the evidence and the doc update.**
  ```bash
  git add qa/web/evidence/2026-07-27-native-orchestrator-e2e/ agents/docs/testing-knowledge.md
  git commit -m "test(e2e): web E2E for the 2.0 native-orchestrator wire (spec §10.1)

  Drives the full walking-skeleton acceptance matrix (minus voice-roundtrip,
  no web equivalent) against the real local stack via Playwright MCP.
  Regrounds six stale cerebrum-era reusable cases to the turn.*/permission.*
  wire and adds the native-orchestrator case set to the reusable library."
  ```

---

#### Definition of done

- `results.md` has a verdict for all 12 rows — PASS, or a documented PARTIAL/BLOCKED with a concrete cause (hermes unreachable, mic acoustic input, missing second user, T3 not landed), never a silently skipped row.
- Every PASS row has a `gateway-log-trail.txt` whose greps match the Expected log trail column, and either a console dump or a network dump where the row's Expected column names one.
- `agents/docs/testing-knowledge.md` no longer asserts against any retired frame/tag anywhere it documents a case this task touched (Step 35's table fully applied), and carries the new `## Native orchestrator (2.0 wire)` section (Step 36).
- The commit from Step 37 exists on `feature/native-orchestrator`, touches only `qa/web/evidence/**` and `agents/docs/testing-knowledge.md` — no `gateway/**`/`shared/**`/`gateway/webui/**` diff.
- The `## Operator follow-up` entries (barge-in's acoustic trigger, voice-roundtrip, and any BLOCKED case from Steps 2/4/20) are listed in `results.md` with the smallest reproduction steps, per `agents/docs/e2e-testing-details.md`'s "When a case is genuinely unreachable" convention.
