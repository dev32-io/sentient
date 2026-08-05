<!-- last-distilled: 2026-04-27 branch: develop -->
# Testing Knowledge

Reusable smoke-case catalog referenced by `.claude/rules/e2e-testing.md`
and `agents/docs/e2e-testing-details.md`. Cases here are the source of
truth across features; per-spec smoke matrices reference them instead
of duplicating.

Each `### Case` entry has a scenario, a "why added" reason, callable
steps, and the expected user-visible + log-trail outcome. New reusable
cases are appended here, indexed by the surface they exercise.

> ## Local-stack credentials — read this before reporting a login blocker
>
> **On the LOCAL DEV stack, log in as `Ada` — PIN `1234`.** It is a
> local-only test credential, not a secret, and it is written here on
> purpose so no agent ever stalls at the login gate again.
>
> **Only Ada.** Verified against the stored hashes 2026-08-01: `1234` is
> Ada's PIN and is *not* Grace's or Delegate Proof's, whose PINs are the
> owner's and are not written down anywhere. Earlier evidence files show
> runs driven as Grace — that was a human typing a PIN, not something an
> agent can reproduce. Never guess another user's PIN and never probe a
> second account after one rejects you; pick Ada and move on.
>
> This is not hypothetical. Task 9c abandoned **two** matrix rows
> (`steer-followup-audio`'s audio half, `interrupt`'s browser-Stop
> trigger) and filed them as operator work, reasoning that creating a
> user needs an admin token, which needs a PIN — *"circular. PIN
> guessing was not attempted."* Several voice-pack rows below were handed
> to the operator for the same reason. Every one of them was drivable.
>
> So: **an unknown PIN is never a valid reason to stop.** Log in with
> `1234`, drive the row, and only escalate something the browser genuinely
> cannot reach (a real microphone, real acoustics, interactive `sudo`, a
> second machine). Applies to the local dev stack ONLY — production is
> observational-only and is never driven by Playwright or Maestro.

> **Native-stack migration banner — re-grounded 2026-07-30 (Task 9, web).**
> Cases below that named the retired cerebrum/cycle wire (`cycleId`,
> `[cerebrum:attention-gate] cycle dispatched`, `cycle.done`,
> `CycleAudioQueue`) have been rewritten onto the 2.0 wire: turns carry a
> server-minted `turnId` (a uuid, not a counter — see
> `runtime:react-loop react-loop.start turnId=...`), and the live log tags
> are `[runtime:react-loop]`, `[runtime:session-runtime]`,
> `[runtime:turn-voice]`, `[ws:turn-emitter]`, `[provider:openai]`,
> `[tools:tool-broker]`, `[runtime:permission-broker]`,
> `[security:policy-engine]`. Verified against a real driven turn
> 2026-07-30 — see `qa/web/evidence/2026-07-30-native-turn-happy/`. One
> thing that is NOT stale and was deliberately left alone: the **presence**
> layer's `cycle.start` / `cycle.end` signal `kind` (idle-detector,
> presence-source) is current, real code — a generic "an interaction cycle
> ran" signal name, unrelated to the retired wire's `cycleId`. Bring-up is
> also re-grounded: no more `docker compose ... gateway`; dev is
> `cd gateway && bun --watch src/main.ts` (never `--hot` — refused outright at
> startup, see `gateway/CLAUDE.md`; needs `SENTIENT_CODE` pointing at a
> `<code>/whisper-stt/{venv,src}` + `<code>/local-tts/{venv,src}` layout for
> the native addons — see the Native-stack migration section below) plus
> `cd gateway/webui && bun run dev` (Vite, `:5173`, proxies `/api/v1` to the
> gateway's `:8888`). **Superseded 2026-08-04:** the repo-root `bun run dev`
> is now the whole-stack launcher (preflight + gateway + vite + every addon +
> `inbound-proxy`), and `https://localhost` (443) is the URL all browser
> smoke drives against — see the root `CLAUDE.md`. Docker still fronts the
> MCP/searxng/proxy addons only.
> Remaining containerized-era literal commands elsewhere in this file
> (Setup Wizard walks, System-orchestrator Phase 6 section) are Task 10 /
> follow-up scope, not re-driven here — treat their *scenario* and
> *why added* fields as still valid and their literal `docker compose`
> commands as historical until re-walked.

## Methods

Tools and techniques this project uses to verify changes on each surface,
and why those tools were chosen. One `###` subsection per surface.

### Browser Smoke Verification
**Tool:** Local Chrome against a freshly built `sentient-gateway` container.
**When:** After any cerebrum / SDK / webui change that could affect cycle lifecycle, audio playback, presence, or task visibility — before merging or shipping.
**Why this tool:** WebRTC AEC, AudioWorklet timing, jitter-buffer behaviour, and cycle-audio-queue state can only be exercised end-to-end in a real browser. Mocked playback misses these failure modes; they show up only as user-visible regressions.
**How:**
1. `source scripts/env.sh`
2. Start the whole stack: `bun run dev` (repo root — preflight + gateway [`bun --watch`, never `--hot`] + vite + every addon + `inbound-proxy`)
3. `until curl -sk -o /dev/null -w "%{http_code}" https://localhost/ | grep -q 200; do sleep 1; done`
4. Open `https://localhost` in Chrome. Self-signed cert → click Advanced → Proceed.

**Debugging hooks:**
- Wire-message tap: `window.__sentWsTx` / `window.__sentWsRx` after injecting a WebSocket shim via `navigate_page` `initScript`.
- Console filters: `[sentient.webui.audio-playback]` for the audio path; `[sentient.webui.cycle-audio-queue]` for cycle serialization; `[sentient.web-sdk.presence]` for idle-detector state transitions; `[sentient.webui.voice-client]` for SDK construction.
- Gateway logs: `docker compose logs gateway --tail=200 | grep -E "cycle|hermes"`.
- For presence cases: `IDLE_THRESHOLD_MS` and `IDLE_TICK_INTERVAL_MS` live in `gateway/webui/src/constants.ts`. For hand-testing, edit `IDLE_THRESHOLD_MS` down to e.g. `30_000` locally so the matrix finishes in minutes instead of hours — revert before committing.

## Cases

Reusable test scenarios. Each case has explicit steps and expected outcome.
One `###` subsection per case.

### Tool pill renders on tool call
**Scenario:** A user prompt that triggers a tool (e.g. "what's the weather", which fires `mcp_searxng_search_web`, or any home-assistant query) renders a tool pill both on the assistant message bubble AND in the composer task strip.
**Why added:** Regression guard for the Task 0 wiring — previously regressed when a webui shell refactor didn't pipe `tasks` into `ComposerTaskStrip`. Tool visibility is the user's only signal that work is happening.
**Steps:**
1. Send a tool-triggering prompt (e.g. "what's the weather in Vancouver").
2. Observe the assistant message bubble while the cycle runs.
3. Observe the composer task strip simultaneously.
**Expected:** A tool pill appears on the bubble for the duration of the tool call; the composer strip shows the same pill as a persistent mirror until the cycle completes.

### Distinct turnId per turn + many-entry turn renders distinctly (web)
**Scenario:** The gateway mints a server-unique `turnId` (uuid) per turn, never resetting on reconnect. Multiple turns each render under their own message; a single multi-tool turn renders every entry (intermediate narration + each tool pill + final answer) as its own row under ONE turnId.
**Why added:** Regression guard for the render-key discipline the old cycleId fix (2026-06-14, pre-2.0) established — a per-turn id that resets or aliases collapses turns onto one render row ("follow-up reply missing / previous shown" + stale-bottom-on-scroll). Re-grounded 2026-07-30 onto the 2.0 wire: `turnId` is minted once in `runtime:react-loop react-loop.start` and threaded through every frame of that turn (`turn.started` → `turn.text.delta`* → `conversation.entry` → `turn.completed` → `turn.audio.*`); committed history is keyed by `entryId`, turnId is turn-meta only — same shape as the old invariant, new names.
**Steps:**
1. Two turns, no reconnect (desktop 1280×900): send msg 1 → await reply; send msg 2 → await reply.
2. Many-entry turn (desktop + mobile 390×844): send a multi-tool prompt (e.g. "what's the state of the kitchen light" — triggers `ha_get_state` then a follow-up tool call).
**Expected user-visible:** both single-turn replies render under their own messages (no alias); every entry of the multi-tool turn renders as its own row (tool pill + answer), no rows collapse; streaming bubble grows in place (`turn.text.delta` chunks) then commits with no duplicate.
**Expected log trail (gateway `~/.sentient/gateway/logs/YYYY-MM-DD.log`, LOCAL-time rotation — not UTC, see the native-stack migration section's log-trail trap):** each turn emits ONE `[runtime:react-loop] react-loop.start | turnId="<uuid>"` and that same `turnId` recurs on every subsequent line for the turn (`[ws:turn-emitter] turn-emitter.turn-started/turn-completed`, `[runtime:session-runtime] session-runtime.turn.start/turn.end`); two turns in the same session never share a `turnId`. Verified live 2026-07-30 — two real turns logged distinct uuids (`235ab571-…`, `5dc1691a-…`); see `qa/web/evidence/2026-07-30-native-turn-happy/gateway-log-excerpt.txt` and `2026-07-30-native-tool-call/gateway-log-excerpt.txt`.

### Speaking state tracks audio drain, not turn end
**Scenario:** When the assistant returns a long spoken reply, the speaking indicator must remain lit through the final word of audio, not drop on `turn.completed`.
**Why added:** Regression guard for the `onDrain` path — the speaking state needs to follow the playback adapter's drain signal, not the gateway-side `turn.completed` frame (which fires before `turn.audio.start`/`turn.audio.done` — audio streams as a separate phase after the text turn settles, confirmed live: `turn.completed` then `turn-emitter.audio-start` land as two distinct log lines, sometimes seconds apart while local-tts synthesizes).
**Steps:**
1. Send a prompt that yields a long spoken reply (e.g. "tell me a story about ravens, ~200 words").
2. Watch the speaking indicator while audio plays.
**Expected:** Indicator stays lit continuously through the last syllable of TTS audio; drops only after `onDrain` (not on `cycle.done`).

### Interrupt stops audio within ~30 ms
**Scenario:** Clicking Stop during active TTS playback cuts audio within the preempt-fadeout window.
**Why added:** WebRTC peer destruction must happen in `clear()` to flush the jitter buffer; if the peer is kept alive and only `replaceTrack()` is called, the receiver replays buffered frames and audio continues for 200–500 ms after Stop.
**Steps:**
1. Send "write a 500-word essay on X".
2. Once audio begins, click Stop.
**Expected:** Audio cuts within `preempt_fadeout_ms` (default 30 ms). If audio bleeds for hundreds of ms, the WebRTC peer wasn't destroyed in `clear()`.

### Interrupt button visibility bridge (AwaitingTracker FSM)
**Scenario:** After clicking Send, the Interrupt button must appear within one render frame and stay visible continuously through the end of audio drain.
**Why added:** There's a real, measured gap between `turn.completed` (server-side, text settles) and `turn.audio.start`/`onAudioStart` (first TTS frame at the client) — live 2026-07-30 samples ranged ~0.9s to ~17s (local-tts synth time scales with reply length). Without the AwaitingTracker FSM, the button flickers off in that gap.
**Steps:**
1. Click Send on any prompt.
2. Watch the Interrupt button continuously from click through end of TTS playback.
**Expected:** Button appears within one frame, stays visible the entire time, drops only on `onPlaybackEnded`. If it flickers off between `turn.completed` and `onAudioStart`, the AwaitingTracker FSM isn't wired correctly. (See `agents/docs/gateway/webui/awaiting-tracker-fsm-details.md`.) AwaitingTracker itself is unchanged by the migration — still `gateway/webui/src/hooks/awaiting-tracker.ts`, disarms on client `audio-start`.

### Turn serialization (queued message does not overlap current TTS)
**Scenario:** Two turns' TTS streams must never play simultaneously. The first drains, then the second starts; or, if elapsed > `min_eager_end_ms`, the second preempts with a ~30 ms fade.
**Why added:** Regression guard for the preempt logic, now in `shared/web-sdk/src/turn-audio-queue.ts`'s `TurnAudioQueue` (renamed from `CycleAudioQueue` pre-2.0; live-confirmed 2026-07-30 via console tag `sentient.sdk.turn-audio-queue`, `slot-appended {turnId, depth}`). A bug here causes overlapping speech, which is unintelligible and cannot be recovered from without a full reload.
**Steps:**
1. Send "what's the state of the kitchen light"; wait for audio to start.
2. While audio is playing, send a second prompt (e.g. "and search the web for today's date").
**Expected:** First turn's audio drains naturally OR (if elapsed exceeds `min_eager_end_ms`) the second turn preempts with a brief fade. No overlap.

### Cross-turn tool pill persistence
**Scenario:** Tool pills attached to a previous assistant bubble must persist across subsequent turns, scoped to that bubble's cycle.
**Why added:** Regression guard for cycle-scoped tool rendering. A bug here either (a) drops earlier pills when a new turn starts, or (b) leaks the new turn's pills into the older bubble.
**Steps:**
1. Send a tool-triggering message (e.g. "what's the weather").
2. After the first cycle completes, send another tool-triggering message (e.g. "are there any calendar events tomorrow?").
**Expected:** First bubble's pill stays put after the second turn finishes; each bubble shows only its own cycle's tools.

### Idle close fires after threshold
**Scenario:** After user interaction stops, the WebSocket must close with code `1000` and reason `idle-timeout` once inactivity exceeds `IDLE_THRESHOLD_MS` (~1 hr default).
**Why added:** Presence/lifecycle regression guard; idle clients must release the connection so the gateway can archive their session.
**Steps:**
1. Bring up the gateway and open the webui in Chrome.
2. Interact (send a message), then leave the tab untouched for > `IDLE_THRESHOLD_MS` (or use the dev-override of `30_000` ms to compress).
3. DevTools → Network → WS: inspect the close frame.
**Expected:** Close code `1000`, reason `idle-timeout`.

### Return reopens within memory window
**Scenario:** After an idle close, returning to the tab reopens the WS. If < ~30 min has passed since close, the prior PersonSession is still warm and the conversation re-renders. Past 30 min, the session was archived and history starts fresh.
**Why added:** Validates the composed memory window (client idle + gateway PersonSession archive). The reopen path must send `session.configure` and inherit the existing conversation when within the window.
**Steps:**
1. Trigger an idle close (see "Idle close fires").
2. Refocus or click the tab; observe a new WS connection.
3. Verify whether the prior conversation re-renders (within window) vs starts blank (past window).
**Expected:** New WS opens, sends `session.configure`. Within 30 min: prior conversation re-renders. Past 30 min: history is empty (gateway archived the session).

### Background tab follows idle contract
**Scenario:** Switching to another tab follows the same threshold-based contract. Visibility change alone does not trip the close before the threshold.
**Why added:** The presence coordinator must treat hidden-tab and unfocused-tab the same — visibility transitions are not idle by themselves.
**Steps:**
1. Open the webui, interact, then switch to another tab.
2. Wait < `IDLE_THRESHOLD_MS`. Switch back.
3. Wait > `IDLE_THRESHOLD_MS`. Switch back.
**Expected:** WS still open in the first case (no early close on visibility change). Closed with `idle-timeout` in the second case; refocus reopens.

### Active TTS playback blocks the idle close
**Scenario:** Active TTS playback past the idle threshold must NOT trigger the close.
**Why added:** The idle detector must respect playback as activity. Otherwise long replies could be cut off mid-sentence.
**Steps:**
1. Send a prompt that yields a long spoken reply.
2. Do not interact while it plays.
3. Wait until total elapsed exceeds `IDLE_THRESHOLD_MS`.
**Expected:** WS stays open until after playback drains; only then the idle countdown resumes.

### Active cycle blocks the idle close
**Scenario:** A long-running cycle (slow tool call) past the idle threshold must NOT trigger the close.
**Why added:** Same family as the playback-blocks rule, but for the LLM/tool side. A slow tool execution shouldn't drop the connection mid-cycle.
**Steps:**
1. Trigger a long-running tool (or use the dev `IDLE_THRESHOLD_MS = 30_000` override and a slow MCP tool).
2. Wait until total elapsed exceeds the threshold.
**Expected:** WS stays open through `cycle.done`; idle countdown resumes only after the cycle completes.

### `demandStay()` holds the connection
**Scenario:** A devtools call to `sdk.demandStay()` must keep the WS open past the idle threshold; releasing the handle allows the next idle window to close it.
**Why added:** Manual hold lets the host page (e.g. an embed) suppress idle close during operations the SDK can't see (tutorials, walkthroughs). Implementation: `shared/web-sdk/src/presence/idle-detector.ts`.
**Steps:**
1. Open devtools console, grab the SDK instance, call `const release = sdk.demandStay()`.
2. Leave the tab untouched past `IDLE_THRESHOLD_MS`.
3. Observe WS still open.
4. Call `release()` and wait through one more idle window.
**Expected:** WS holds open while the demand-stay handle is alive; closes on `idle-timeout` once released.

## Wizard smoke (Playwright MCP)

Drive the full setup wizard end-to-end via the Playwright MCP server. The spec
at `gateway/test/smoke/wizard-bootstrap.spec.ts` documents the click-by-click
sequence; the actual execution is interactive (not auto-runnable in vitest).

**When to run:** any change to the wizard handlers, install-state service,
secrets-store, or webui chrome (`InstallGate`, `WizardShell`, step components).

**Pre-flight:**
1. Stop any running gateway containers/processes.
2. `rm -rf ~/.sentient.smoke-test`
3. Boot gateway dev server with `SENTIENT_HOME=~/.sentient.smoke-test bun run dev`
4. Read unlock code from `~/.sentient.smoke-test/.bootstrap-unlock`
5. Open Claude Code session with Playwright MCP enabled
6. Walk the spec file step-by-step, capturing screenshots at each major
   transition (unlock-gate → provider → voice → finish → SetupScreen)

**Baseline screenshot management:**
Screenshots live under `gateway/test/smoke/baselines/wizard/` (gitignored
per directory; create the directory locally as needed). Visual checks are
manual — compare to the previous baseline if one exists, otherwise capture
a fresh baseline after a known-good run.

**Server-side post-conditions** (verify after browser flow):
- `~/.sentient.smoke-test/secrets/keys.yaml` exists at mode 0600
- `keys.yaml` contains `llm.active: openrouter` and the FAKE key
- `~/.sentient.smoke-test/state.yaml` has `bootstrap_complete: true`
- `~/.sentient.smoke-test/.bootstrap-unlock` is removed
- `curl -X POST .../wizard/provider -d ...` returns 410

**On failure:** capture the failing screenshot + the gateway log lines for
the wizard handler. Wizard rejections look like `wizard.unlock.failed`,
`wizard.provider.saved`, etc.

## Tool-surface coverage — the denominator, and why it is the deliverable

**Read this before writing another "the model called a tool" case.**

Across every piece of web E2E evidence on this branch, **exactly five tools were
ever exercised**: `ha_get_overview`, `ha_get_state`, `ha_search`,
`ha_call_service`, and `search_web` once via the delegated path. The catalog has
**28**. The gateway's own ReAct loop has never called `search_web` or `fetch` in
a test. The cause was matrix design, not sloppiness: one row, `native-tool-call`,
stood in for the entire tool surface, and the model happened to pick Home
Assistant every time.

**Denominator, measured 2026-07-31 from `mcp.list-tools.ok` on a live boot** —
re-measure it, never copy it forward:

| server | upstream tools | in catalog (`filteredCount`) |
|---|---|---|
| home_assistant | 78 | 16 |
| music_assistant | 10 | 10 |
| searxng | 5 | 1 |
| fetch | 1 | 1 |
| **total** | 94 | **28** |

Plus `delegateTask`, which is a background tool rather than an MCP server.

**Coverage as of 2026-07-31: 6 / 28**, driven by NM-T12's per-server rows
(`qa/web/evidence/2026-07-31-t12-tool-surface/`). It went up by **two**, and the
starting figure was not what the record claimed:

**The old "5 exercised" counted a tool that does not exist.** The five named
were `ha_get_overview`, `ha_get_state`, `ha_search`, `ha_call_service`,
`search_web`. `ha_search` is the *hallucinated* name from the step-5 defect —
the catalog has `ha_search_entities` (`gateway/config.yaml:422`) and
`grep -n "ha_search\b" gateway/config.yaml` matches nothing. The honest prior
figure was **4**. When a coverage number is assembled from what a model was
observed calling, check each name against the catalog before counting it.

| Tool | Status |
|---|---|
| `ha_get_overview` | prior |
| `ha_get_state` | prior — but only ever at `isError=true`; first **verified-good** drive 2026-07-31 |
| `ha_call_service` | prior (`permission-confirm-web` allow arm) |
| `search_web` | prior via the **delegated** path only; now through the gateway's own loop |
| `ma_search` | NEW 2026-07-31 |
| `fetch` | NEW 2026-07-31 |

Four of five catalog servers now have a real row, but **22 of 28 tools remain
untouched**, mostly HA's 16-tool surface. Per-server coverage is the win;
per-tool coverage is still thin. `delegateTask` is exercised too but is a
background tool, not one of the 28.

**The oracle matters more than the row.** `native-tool-call`'s own recorded
evidence reads `toolName="ha_get_state" isError=true` — **and it passed**,
because its oracle was "a tool was dispatched". A row that cannot tell a working
tool from a broken one is worse than no row: it reports coverage it does not
have. Any new tool row must assert **result content** and fail on
`isError=true`, capturing both `tool-broker.pdp.decision` and
`tool-broker.dispatch.foreground.done` with `isError` and `contentLength`.

**Safety, non-negotiable on this project.** The stack runs against the owner's
real home. Reads and temp-writes only: `ha_get_state` / `ha_get_overview` /
`ma_search` / `ma_browse` yes; `ha_call_service` against a real device, and
`ma_playback` / `ma_volume` at all, never. For a `confirm`-tier row, assert the
**prompt and the deny path**, never the allow path.

### tool-ha-read · tool-ma-read · tool-websearch · tool-fetch · tool-multi
**Scenario:** one row per catalog **server**, each driven through the gateway's
own ReAct loop in a real browser, each asserting the tool's RESULT.
**Driver:** webui at `http://localhost:5173` (the vite dev server proxies
`/api/v1` to the gateway with `secure:false`; hitting `https://localhost:8888`
directly fails Playwright on `ERR_CERT_AUTHORITY_INVALID`, self-signed).
**The oracle needs a second, independent path** — the gateway log carries
`isError` and `contentLength` but deliberately **no result content**, so an
oracle built only from logs can only re-assert what the gateway already
believes. Use `bun qa/web/tool-truth.ts <server> <tool> '<json-args>'`, which
dials the same MCP server directly (hand-rolled streamable-HTTP, not the
gateway's SDK), then compare the on-screen reply to it. `--list` shows the
dialable servers and the read-only allowlist.
**Pass bar:** `isError=false` on BOTH `mcp.call-tool.ok` and
`tool-broker.dispatch.foreground.done`, **and** the reply names a value the
prober independently returned. Any `isError=true` is FAIL whatever the bubble says.
**Gotchas found live:** `ma_search` nests its arguments under a `params` object
(`{"params":{"query":…}}`) — a flat `{"query":…}` returns `isError=true` with a
pydantic "Field required". `tool-multi` (two servers in one turn) runs
`iterations=3` on one `turnId`.
**Safety:** `tool-truth.ts`'s `READ_ONLY_TOOLS` is deliberately **stricter than
`mcp-policy.yaml`'s allow tier** — that tier contains `ma_playback`,
`ma_play_media` and `ma_volume`, prompt-free by design, which would start audio
in the house. Never widen it for convenience.

## System orchestrator (Phase 6 setup wizard)

### Stack integrity — the declared services are the running ones, by identity
**Scenario:** Read the service list from `config.yaml#managed_services` and
assert every one is running, is the unit the orchestrator recorded, and passes
its declared health probe — plus no `reapply.gave-up` in the current boot window.
**Driver:** `bun qa/web/stack-integrity.ts` (add `--config <path>` /
`--run-dir <path>` for negative controls, `--json` for machine output). Exit 0
only when every gate passes.
**Why added:** nothing anywhere asserted this, so `egress-proxy` could exhaust
its retries with all 11 web cases still green. And the *identity* half exists
because **"something is listening" is the oracle that hid broken native
supervision for a whole branch** — two stray LaunchAgents held 8768/8769/8770,
every gateway child died on `[Errno 48]`, and the TCP probe was answered by
launchd's agent, so `apply.complete state="ready"` was true and meaningless.
**Gates:**

| | docker | native |
|---|---|---|
| running | a container labelled `sentient.service=<name>` is `running` | the pid in `~/.sentient/run/<name>.pid` is alive |
| identity | **that** container publishes the declared probe port on loopback | the pid holding the LISTEN socket **is** the recorded pid, and is the only one |
| health | TCP connect to the declared `healthcheck.tcp` | same |
| quiet | no `reapply.gave-up`, and the boot's last `apply.complete` carries `state="ready" failed=0 blocked=0` | same |

**Expected (healthy):** `RESULT PASS — pass=9 fail=0 skip-optional=0 of 9 declared`.
**Run the negative control before trusting a green** — a guard nobody has watched
fail is just another green light:
`bun qa/web/stack-integrity.ts --config qa/web/fixtures/stack-integrity-negative-control.yaml --run-dir <scratch>`
where `<scratch>/qa-port-impostor.pid` holds a live-but-wrong pid. Its impostor
row reports `health tcp ... ok` and still FAILS, which is exactly the shape of
the bug the weak oracle missed.
**Evidence:** `qa/web/evidence/2026-07-31-t12-stack-integrity/`.

### Why `bun --hot` is refused outright — a hot reload leaks a supervisor per reload
**Why added:** learned by wedging the dev stack on 2026-07-31 in about ten
minutes — the actual case study behind the startup guard now in
`gateway/src/main.ts:81-93`. `bun --hot src/main.ts` re-evaluates the module
graph **in the same process**; nothing tears the old graph down, so every
reload constructed another `SystemOrchestratorService` and called
`healthWatch.start()` again while the previous watchdog kept ticking
(`stopHealthWatch()` runs only on gateway shutdown, which a hot reload never
performs). Twelve `health-watch started` lines in one process is what that
looked like in the log.

They then raced for the native ports: **five `native.started service="whisper-stt"`
lines landed within 10 ms**, pids 46537–46541, four of which were promptly
signalled by the others; ownership records were lost, so the survivors read as
foreign — `native.port-held ... it is not a child of this gateway` — and eight
`reapply.gave-up reason="max-attempts-exhausted"` followed. It did **not**
self-heal; only a real process restart cleared it.

**Now prevented at the source, not worked around.** This incident is exactly
why `--hot` is refused outright at startup: `gateway/src/main.ts` claims a
single in-process evaluation and exits 1 with the fix the moment a second one
would run, so the race above can no longer happen — there is no "edit
carefully, one at a time" discipline left to maintain. Use `bun --watch
src/main.ts` for the gateway alone (a real process restart per edit;
`config.yaml` still needs a manual restart either way, since it isn't in the
module graph) or `bun run dev` from the repo root for the whole stack.
Seeing this log signature again would mean the startup guard itself
regressed, not that source was edited too fast — confirm with `bun
qa/web/stack-integrity.ts` either way.

### Cold-path smoke

1. Tear down: `docker compose down -v && rm -rf ~/.sentient`
2. Bring up: `docker compose up -d`
3. Open `https://localhost:8888`. Wizard renders.
4. Walk: unlock → provider (LLM key) → voice (acknowledge-and-advance — local-tts needs no key) → secrets (HA URL+tokens, MA URL+token; or skip).
5. Click Continue on the secrets step. Page transitions to "Starting up services…".
6. Per-service rows tick from "Queued" → "Starting…" → "Checking health…" → "Ready ✓" in dependency order. Required first; optional services last.
7. When all required are Ready, page auto-advances to step-admin (account creation). Continue through admin → "All set" → reload into chat.

### Warm restart

1. With a bootstrapped deployment, run `docker compose down && docker compose up -d`.
2. Reload the webui. No wizard appears. Sidebar shows "All services online". No re-bringup screen.

### Settings rotation (admin)

1. Log in as admin. Settings → Smart-home → rotate the HA token.
2. Apply bar shows `ha-mcp` going through `recreating` → `health-checking` → `ready`.
3. Other services are not touched.

### RBAC

1. Log in as a non-admin user.
2. From the browser console, POST to `/api/v1/apply` with `{ "secrets": { "home_assistant": { "mcp_server_token": "x" } } }`.
3. Response is 403, no orchestrator activity in logs.

### Power-loss recovery

1. With a healthy deployment running, `docker kill sentient-ha-mcp`.
2. Restart the gateway: `docker restart sentient-gateway`.
3. Boot reconciler logs `reconcile.applying`, then `applyAll` brings ha-mcp back to ready (assuming HA is still reachable).

### Orphan reap

1. `docker run -d --label sentient.managed=true --label sentient.service=fake nginx`
2. Restart the gateway: `docker restart sentient-gateway`.
3. The fake container is gone. Logs include `reconcile.orphan-reap` for `sentient.service=fake`.

## Setup Wizard — Fresh Walk

Run after any change touching `gateway/src/api/wizard/`, `gateway/src/admin/install-state.ts`, `gateway/templates/wizard/`, or the webui wizard components.

1. `rm -rf ~/.sentient/`
2. Bring up the stack: `bun run dev` from the repo root (see `deploy/README.md`)
3. Read the unlock code: `cat ~/.sentient/gateway/data/unlock-code` (or read from gateway log banner).
4. Open `https://localhost`, enter the unlock code.
5. Walk fresh: `provider → voice → secrets → bringup → admin → finish`.
6. Confirm Back buttons present and functional on `voice` and `secrets` screens; absent on `provider`, `bringup`, `admin`, `finish`.
7. Mid-admin reload: refresh page during AccountWizard. Expect: lands back on AccountWizard.
8. Post-admin reload: complete admin step, refresh page. Expect: lands on StepFinish.
9. Click "Take me in →". Expect: wizard closes, login screen appears, can log in with the PIN you set.
10. Verify cursor field in `~/.sentient/gateway/data/state.yaml` matches each visible step during the walk (sample at provider, secrets, admin, finish).

## Setup Wizard — Migration smoke

After upgrading across the v0.1.0 → v0.2.0 install-state schema bump:

1. Generate a v0.1.0 fixture: write a state.yaml with `schema_version: "0.1.0"` and `wizard_cursor: "complete"`, `bootstrap_complete: false` to `~/.sentient/gateway/data/state.yaml`.
2. Restart gateway. Read the file again.
3. Expect: `schema_version: "0.2.0"`, `wizard_cursor: "admin"`.
4. Repeat with `bootstrap_complete: true`. Expect: `wizard_cursor: "finish"`.

## Native-stack migration (Task 8, `qa/native/`)

Six cases proving the migration itself (native gateway + native/docker addon
supervision + the installer), run BEFORE the 2.0 web/native matrices — a red
migration case makes every later row untrustworthy. Full runnable commands and
2026-07-29 results (2 PASS, 2 real FAIL, 2 root-BLOCKED) are in
`qa/native/README.md`'s "Migration E2E cases" section; per-case evidence in
`qa/native/evidence/<date>-<case>/` (gitignored, regenerate by re-running).
Pre-state for every case: native gateway installed per the installer task,
addons up via `docker compose ... --profile build-only build` +
`qa/native/apply-addons.ts`, `launchctl print system/io.sentient.gateway`
(or, rootless, a `gui/<uid>` rehearsal per `deploy/mac-prod/tests/
test_launchd_live.py`'s pattern) showing `state = running`.

### `native-addon-lifecycle`

1. Confirm no `whisper_stt`/`local_tts` processes running.
2. Start/kickstart the gateway. Wait ~20-25s.
3. Expect: `pgrep -fl "whisper_stt|local_tts"` shows both; `[system-orch:native-driver] native.started` ×2 with pids; `[system-orch:service-registry] registry.built` listing both.
4. SIGTERM the gateway job. Within 5s, both processes gone.
5. Log trail for step 4: `[sentient] shutdown | signal="SIGTERM"` then (via the NEXT boot's `reapOrphans()`, not the terminating process itself) `native.orphan-reaped` for both — orphans are cleaned by `KeepAlive`'s auto-restart, not a proactive SIGTERM handler. A supervisor without auto-restart (or a permanent `launchctl bootout`) would NOT self-clean.

### `addon-crash-restart`

1. Gateway running, both addons healthy.
2. `kill -9` the local-tts pid.
3. Wait ≥60s (15s is NOT enough to conclude — see below).
4. **As of 2026-07-29: FAILS.** No periodic health-watch/re-apply loop exists in `gateway/src/system-orchestrator/` — `applyAll()`/`applySubset()` are called only at boot, from the manual `POST /api/v1/apply`, or from the setup wizard. The crashed addon stays down until an operator manually re-triggers apply (`launchctl kickstart -k` or the apply endpoint). See `qa/native/evidence/2026-07-29-addon-crash-restart/`.

### `loopback-only-exposure` — security assertion, prove both directions

1. Probe every addon port (docker AND native) on `127.0.0.1` and the host's LAN IP; probe gateway `8888` on both.
2. Expect: every addon loopback-answers/LAN-refuses; gateway answers both.
3. **As of 2026-07-29: FAILS for whisper-stt** (native, port 8768) — answers on the LAN. Root cause: `capabilityServices/WhisperSTTService/config/config.example.yaml` still has the pre-migration container-era `host: "0.0.0.0"` (local-tts's equivalent already correctly says `127.0.0.1`). **Blocks Tasks 9/10 per the migration task's own gate until fixed.**

### `code-immutability`

Attempt to write the installed binary as the service user. Expect `Permission denied`; binary + parent dirs `root:wheel`. Needs a real root-owned `/opt/sentient` install — no rootless equivalent exists for this one (the assertion IS root ownership). BLOCKED without real sudo.

### `upgrade-rollback`

Install a release that fails health; expect the installer reverts `current` and the service is healthy on the previous version. The FSM (checksum, health-gate, rollback, idempotency, prune, config-preservation) is provable rootless via `bash deploy/mac-prod/tests/e2e-install.sh <workdir>` (stubs only `launchctl`/`chown`, both root-only) — ran clean 2026-07-29, including the exact rollback case. The `chown -R root:wheel` / `system` domain / `UserName`-switching remainder still needs a real first run.

### `offline-install`

Run the installer with networking disabled; expect success (nothing fetches at deploy). Root-blocked same as above. Structural substitute: `deploy/mac-prod/native/install-venv.sh` uses `pip install --no-index --find-links=`, making PyPI access impossible regardless of network state — proven live already. Do not toggle the host's Wi-Fi off to "test harder" once the case is already root-blocked; it adds no coverage and risks the box's own connectivity.

### `release-host-ports` (one-time migration, not a numbered case above but worth its own entry)

Any host that ran the pre-ingress-proxy shape has `sentient-fetch-mcp`/
`sentient-searxng-mcp` still holding `127.0.0.1:8088`/`:8087` directly, which
blocks `ingress-proxy` from binding them (`port is already allocated`). Fix:
`docker rm -f sentient-fetch-mcp sentient-searxng-mcp` — the orchestrator
recreates both under the new topology on the next apply. Idempotent, no-op on
a host that never ran the old shape. Cannot be expressed as a `depends_on`
(`ingress-proxy` must precede the MCPs for reachability, so waiting on them
would be a cycle) — see `qa/native/README.md`'s "One-time migration" section.

## Multi-window session cases — two clients on ONE session

Added 2026-08-03 (session-model wave, plan task 11). **These are the first cases in this repo that need two clients attached to a single session**, which the pre-wave `(userId, surfaceId)` runtime key made impossible: a second connection naming the same conversation used to *evict* the first. Tags: `multisurface`, `permission`, `security`, `session`, `reconnect`.

**Driver (web).** Two Playwright tabs in one browser context. Both must reach the *same* `sessionId`: tab A gets there however you like, tab B opens the same row from the Past-chats drawer (`conversation.activate`). Confirm the join before asserting anything — `[ws:session-binding] session-binding.attached … subscribers=2` is the only proof that you have two windows rather than one window twice.

**The instrument.** Assert on a per-tab inbound frame tap, not on the DOM alone. Install it with Playwright's `context.addInitScript` (it must exist *before* the SDK constructs its socket, so `browser_evaluate` after load is too late) subclassing `WebSocket` and pushing every parsed inbound frame onto `window.__rx`. Reset `__rx` immediately before each action.

> **The tap must be shown alive before an empty tap can mean anything.** `connection-lane-private` passes by asserting window B received *nothing*. That is worthless unless the same tap has been seen recording frames — so run a `two-windows-live`-shaped case first on the same socket and keep its non-empty result as the control. An empty array from a dead instrument looks identical to correct isolation.

**Credentials:** Ada / `1234` (see the banner at the top of this file). **Never** drive `ha_call_service`, `ma_playback`, `ma_play_media`, or `ma_volume` — a permission prompt is best exercised by **denying** it, which resolves the prompt without executing anything.

### two-windows-live · two-windows-race · two-windows-steer
**Scenario:** One session, two attached windows. (a) A sends, B renders the same streaming reply; (b) both send inside the arbitration window, one wins; (c) B sends mid-turn on A.
**Why added:** These three are the whole point of the identity rewrite — a shared journal with N cursors. (b) and (c) are the same seam under different timing and are easy to confuse: the discriminator is `elapsedMs` against `windowMs` in `input-arbiter.busy`.
**Steps:**
1. `two-windows-live` — reset both taps; send from A; read B's tap.
2. `two-windows-race` — fire both composers with `Promise.all` on the two Playwright pages (sequential MCP calls are hundreds of ms apart and will *steer* instead of racing; the `input_arbitration_window_ms` default is **100**).
3. `two-windows-steer` — A starts a long reply; **wait ≥2 s**, then send from B.
**Expected user-visible:** (a) B shows the reply streaming and plays its audio, having sent nothing; (b) the loser's composer clears and a toast reads *"Someone else was sending at the same moment — try again."* — it lives ~1.5–3 s, so **sample within 1 s or you will wrongly report a silent drop**; (c) the message folds into the running turn.
**Expected log trail:** (a) exactly one `[runtime:react-loop] react-loop.start` for the turn, and B's tap carries that same `turnId` on `turn.started` / `turn.text.delta` / `turn.completed`; (b) `[ws:input-arbiter] input-arbiter.busy … attachmentId=<loser> holderAttachmentId=<winner> elapsedMs=<n> windowMs=100` plus `[ws:command-mediator] command.refused … reason="session_busy"`, and still only one `react-loop.start`; (c) `[runtime:session-runtime] session-runtime.submit.steer … turnId=<the RUNNING turn>` with **no** second `react-loop.start` and **no** `session_busy`.
**Known-red (D22):** the steer is appended to the running turn but a turn that ends on iteration 1 never re-reads the store, so the instruction is ignored and the compensating follow-up turn commits a durable *"Sorry — something went wrong while I was answering."* Reproduces with **one** window too. Assert the seam (`submit.steer`, same `turn_id` in the store) — do **not** assert the steer was obeyed until D22 closes.

### join-midturn · join-race
**Scenario:** B attaches while A's turn is streaming.
**Why added:** The attach answer and the live session lane are two delivery paths for the same entries; where they overlap is where duplicates live.
**Steps:** Park B on a *different* session; start a long, tool-using turn on A; ~2 s in, open A's session from B's drawer; let the turn finish.
**Expected user-visible:** B renders the in-flight turn coherently and shows an enabled **Interrupt** button (the joiner turn-state handshake); no audio is replayed from before the join.
**Expected log trail:** `[ws:fan-out] fan-out.turn-state-sent … turnId=… trigger="user" runningTools=<n> openPrompts=<n> audioTurnId=<id|null>` followed by `fan-out.attached … committedFeed="client-refetch"`. The audio half asserts `fan-out.audio-skipped … audio.skip-reason="midturn-join"` — **only reachable when `audioTurnId` is non-null at the join instant.** TTS starts after the text turn settles, so a join during tool calls has no audio to skip and does not exercise it; say so rather than counting it.
**Oracle:** count `.tool-pill` nodes in **both** windows against `select count(*) from entries where session_id=? and kind='tool_call'`. Do not diff the two panes' `innerText` — the composer task strip mirrors the pills as one grouped node and makes the builder look short.
**Known-red (D23):** the joiner renders one **extra** pill (5 rendered for 4 real calls) while the long-attached window renders the correct count.

### permission-either-answers · permission-issuer-leaves · permission-timeout-denies
**Scenario:** A confirm-tier prompt raised by A's turn is answered on B; then answered on B after A has closed; then answered by nobody.
**Why added:** The broker moved from connection scope to session scope in this wave. "Whose socket raised it" must stop mattering.
**Steps:** From A, ask *"Show me what is currently in the music queue"* — `ma_queue` is confirm-tier and read-shaped. **Click Deny**, never Allow. Note that a denial makes the model retry, so a second, *different* `requestId` appears within seconds; read the `requestId` before concluding a dialog "did not close".
**Expected user-visible:** the dialog appears in **both** windows with identical text; answering in either closes it in both.
**Expected log trail:** `[runtime:session-permission] session-permission.request … requestId=… windows=2 pending=1`, then exactly one `session-permission.settled … requestId=<same> reason="denied" attachmentId=<the window that ANSWERED> pending=0`. For `permission-issuer-leaves`, close A first and expect the settle line to carry `windows=1` and still succeed. For `permission-timeout-denies`, answer nobody: the settle arrives `orchestrator.permission.request_timeout_ms` (120 000) after the raise with `reason="timeout"` and **`attachmentId=null`** — that null is the assertion; an answered prompt always names an attachment.

### connection-lane-private
**Scenario:** Frames addressed to one connection must never reach a peer window on the same session.
**Why added:** The privacy row of the lane split. One leaked `auth.error` or `conversation.snapshot` is a cross-window information leak.
**Steps:** Reset B's tap. On A, force **all three** frame classes: an auth refresh and a resume (reload A onto the session — that alone yields `auth.ok`, `session.ready`, `session.attached`, `conversation.snapshot`), and a `pong` (send a raw `{"type":"ping"}` on a third socket attached to the same session; the SDK's own heartbeat is not reliably inside your sampling window).
**Expected:** B's tap contains **none** of the 16 connection-lane types (`frame-lanes.ts` is the authority; `conversation.snapshot` is on it — it is the attach *answer*, not conversation content). Read the control paragraph above before trusting an empty tap.

### last-one-out · retention-holds-work · retention-drops-idle
**Scenario:** Session lifetime is a derived predicate over observable work, not a flag.
**Why added:** Under the old registry the *owner* leaving tore the session down; now only "nothing holds it" does, and a background task counts as holding it.
**Steps:** `last-one-out` — close A, keep B, complete a turn on B. `retention-holds-work` — approve a `delegateTask`, close **every** window while it runs, reattach after it finishes. `retention-drops-idle` — reattach to a session the sweeper already disposed (don't wait out `retention_ms`; take one from the log).
**Expected log trail:** `session-binding.detached … subscribers=1` with **no** `[ws:session-registry] session-registry.disposed` for that id (the dispose line firing for *other* sessions in the same log is what proves the check is alive); `[runtime:session-retention-policy] session-retention.timer-armed kind="recheck" … reasons=hasUnfinishedBackgroundTask` while the task runs, and only afterwards `timer-armed kind="disposal" delayMs=900000 reasons=`; on reattach after disposal, `session.attached generation=1` plus a `conversation.snapshot` whose item count matches the store.
**Note on the feared audio replay:** a background-completion turn that runs with zero windows attached is *silent* — `[runtime:turn-voice] turn-voice.silent reason="no window is attached — synthesising this turn would occupy the on-host TTS for zero listeners"` — so a window returning inside the retention window gets the **text** and no audio (verified: 0 binary frames, 0 `turn.audio.start` on reattach). The "reconnecting window hears the whole delegated answer re-spoken" hazard is therefore reachable only when a window was attached when synthesis *began* and then dropped, not in the all-windows-closed case.

### unknown-session-refused · cross-user-refused · expired-credential-refused
**Scenario:** Presenting an id the server never minted, another user's id, and acting on a lapsed token.
**Why added:** `sessionId` stopped being derived from identity in this wave, so "can I open it" is now purely a membership question and must be driven, never reasoned about.
**Steps:** Open a raw WS, `{"type":"auth",token}`, then `session.configure` with the id under test. **Always drive a legitimate id through the same probe first** — a refusal proves nothing unless the identical path is seen returning `session.attached` + a populated `conversation.snapshot` for an id that *should* work.
**Expected:** no `session.attached` for the presented id; a fresh `session.draft` and `conversation.snapshot` with `items: 0` instead. Log: `[session:session-id] session.resolve.unknown … reason="not present in the store this caller's capability opened — refusing to create it"` and `[ws:session-configure] session-configure.session.refused`. **A cross-user id produces the identical line** — the other user's store is a different SQLite file the capability never opened, so "not yours" and "not there" are structurally indistinguishable, which is the intended design and not a weak assertion. A malformed id logs `session.resolve.malformed` with only `presentedLength`, never the id itself.
**`expired-credential-refused` is `fault-armed`** and needs a gateway restart: set `auth.token_ttl_seconds` to **60** in `gateway/config.yaml` (the schema floor is 60 — 45 fails zod at boot), restart (`config.yaml` is not in the module graph, so `bun --watch` will *not* pick it up), log in fresh, wait out the TTL, then send a message. Expect `[ws:command-mediator] command.refused … reason="credential_expired"`, `auth.error{code:"expired"}`, the socket closed, the webui dropped to the login screen, and **zero** rows for the probe text in the store. Restore the config and restart when done.

### Cross-cutting oracle rules for all of the above
- **Never accept the model's self-report.** Check `[provider:openai] stream-start | messageCount` for what the model was actually sent, and re-ask any recall probe **without an escape hatch** ("repeat back, verbatim, the exact marker string"), never "say NO-CONTEXT if this is fresh".
- **Assert refusals against the database, not the pane.** `select count(*) from entries where text like '%<probe marker>%'` returning `0` is the real "it never landed"; an empty pane is not.
- **Never use page-level `scrollWidth <= innerWidth` to check for clipping** — an ancestor's `overflow: hidden` suppresses the very scroll it looks for. Walk the ancestor chain comparing each element's `scrollWidth` to its `clientWidth`.

## Mobile (Android emulator + iOS simulator via Maestro)

**Tool:** Maestro CLI against a running Android emulator (`avd`) or iOS simulator (`xcrun simctl`), driven through the committed flow library at `qa/mobile/flows/{android,ios}/*.yaml` (97 flows, refactored 2026-07-17, commit `204f728`) via `qa/mobile/run-e2e.sh`. The old "write to `/tmp/<flow>.yaml` at run time, never commit" convention is retired for this library — flows here ARE the committed artifact. Evidence screenshots → `qa/mobile/screens/` (gitignored).
**When:** After any change to `android/`, `ios/`, or `shared/mobile-sdk/` that touches auth, chat UI, WS transport, or Settings — before merging.
**How:** `./qa/mobile/run-e2e.sh android --tags <t1,t2>` for a targeted change; `./qa/mobile/run-e2e.sh all` for a full pre-merge pass. See "Runner usage" below.
**testTags used:** `login-avatar-<userId>`, `pin-key-<n>`, `composer-input`, `chat-send`, `assistant-bubble`, `message-bubble-<index>`, `chat-message-list`, `login-error`, plus per-screen `settings-cat-*` / `settings-*` ids (see individual flow files).

### Tag taxonomy

Every flow's YAML frontmatter carries `tags:` from two orthogonal families. The runner's default batch always excludes `fault-armed`, `physical-only`, `helper`; `--no-slow` additionally drops `slow`.

- **Surface** (what's exercised — matches `--tags` selection): `auth chat session reconnect outbox voice-loop settings-root settings-soul settings-user settings-admin settings-voice settings-diagnostics update logout multisurface permission security`.
  - `multisurface`, `permission`, `security` were added 2026-08-03 by the session-model wave. They are **driven on web today** and have no Maestro flows yet — see "Multi-window session cases" below for what a mobile port needs (chiefly: a second client, which on mobile means emulator + simulator on one session, not two app instances).
- **Behavior** (orthogonal, controls execution regime):
  - `fault-armed` — needs harness-side arming (adb broadcast / network kill / gateway stop); excluded from the default batch, run individually in the runner's dedicated fault phase.
  - `physical-only` — needs a real device (emulator loopback masks the network drop being tested, e.g. WiFi toggle on `emulator-*`); flagged and skipped on emulator.
  - `slow` — >2min flow; dropped by `--no-slow`.
  - `destructive-profile` — mutates seeded server-side profile state (personalities, account, voice packs, members); always paired with a `restore` flow that runs immediately after it (the runner's `CANONICAL_ORDER` keeps every pair adjacent).
  - `restore` — the paired cleanup/restore flow for a `destructive-profile` flow. `continueOnFailure: true` in `config.yaml` guarantees the restore still runs even if its primary failed.
  - `helper` — reusable subflow under `_helpers/`; never run standalone. Three independent guards keep it out of batch runs: `_helpers/` isn't recursed into by a folder run, `config.yaml`'s `flows: ["*.yaml"]` scopes to top-level only, and the runner's `BASE_EXCLUDE` always excludes `helper`.

### Runner usage

```bash
./qa/mobile/run-e2e.sh android --tags settings-voice,settings-soul   # targeted batch: one warm JVM, no fault phase
./qa/mobile/run-e2e.sh android --no-slow                             # drop >2min flows from the default batch
./qa/mobile/run-e2e.sh android --fault-only                          # only the harness-armed flows (with their arming)
./qa/mobile/run-e2e.sh android --fresh-gateway                       # restart gateway first (clears the WS session cap)
./qa/mobile/run-e2e.sh all                                           # full default batch, both platforms + fault phases
```
No `--tags` = default batch (every flow except `fault-armed`/`physical-only`/`helper`), followed automatically by the fault-armed phase. Any `--tags` = one `--include-tags`-equivalent batch only (still excludes fault-armed/physical-only/helper) — no fault phase, so targeted runs stay fast.

### `_helpers/` subflow pattern

Reusable subflows (`_helpers/login.yaml`, `_helpers/login-temp1.yaml`; iOS also `_helpers/open-settings.yaml`) are pulled in via `runFlow:`. Every authed flow conditionally logs in so it is safe mid-batch (a flow that lands mid-session, already authenticated, never re-triggers a fresh login):
```yaml
- runFlow:
    when: { visible: { id: "login-backend-setup" } }   # Android; iOS checks visible: "Who's here?" text
    file: "_helpers/login.yaml"
```
The standalone auth-smoke flow (`login.yaml` on Android, `00-login.yaml` on iOS) instead calls the helper unconditionally after a `clearState: true` launch, which forces the login screen.

### Maestro gotchas (load-bearing)

- **`--include-tags` is order-nondeterministic AND incompatible with `executionOrder.flowsOrder`** — `flowsOrder` requires every listed flow to be present in the run set, which breaks any `--include-tags` subset (verified: throws "Could not find flows needed for execution in order"). Fix: `run-e2e.sh` resolves the selected tags into an explicit, canonically-ordered file list and calls `maestro test f1 f2 ... fN` directly — Maestro DOES honor explicit multi-file arg order.
- **Maestro's default folder order is non-deterministic** — never rely on filename sort for ordering; the runner's `CANONICAL_ORDER` array (restore pairs adjacent, `logout` last) is the single source of truth on both platforms.
- **A folder/dir batch does not recurse into subdirectories** — `_helpers/` is invisible to `maestro test <dir>` by construction; the `helper` tag exclude is belt-and-braces, not load-bearing on its own.
- **Gateway 40-session cap** — every `launchApp` opens a new WS session; the gateway caps a user at 40 concurrent and only archives idle sessions after ~30min. Repeated batches across a long day can exhaust the cap → new connects get `auth.reject code=session-limit` → WS/chat flows fail while REST-only settings flows keep passing (a confusing partial-failure signature). Fix: `--fresh-gateway` before a big run.
- **iOS fault-armed = gateway-stop orchestration, no broadcast channel** — Android arms faults via `adb shell am broadcast -a io.sentient.debug.FAULT`; iOS has no equivalent, so its fault-armed flows (58b, 60, 04c) are driven by `docker stop`/`start`/`restart sentient-gateway` around the flow instead. 08-voice-loop / 18-auth-expired / 20-malformed-frame (broadcast-only faults) are Android-only and skipped on iOS.
- **id-fragile flows need id re-sync**: 41/42/43 (members trio) and 55b/62b (voice/fish cleanup pairs) reference server-generated ids that change on every fresh run of the flow that creates them — e.g. `_helpers/login-temp1.yaml`'s Temp1 `userId` (currently `u_50104890`, created by 41's real "Add user" UI). Re-sync the id in the dependent flow(s) after any fresh run of the creating flow, or the dependent flow fails on a stale id.

### Timing rationale

Cold Maestro-CLI/JVM startup + device attach costs a fixed ~42-65s PER invocation, independent of flow content. The old per-flow loop (one `maestro test` call per `.yaml`) paid this cost on every single flow. Measured under the new batched model: a 13-flow targeted batch ran in 515s total wall time, vs ~650s of JVM startup ALONE under the old per-flow model for the same 13 flows — i.e. the entire batch's actual flow-execution time was cheaper than the old model paid in overhead before a single assertion ran. This is why `--tags` batching (one warm invocation per selected set), not per-flow invocation, is the mandatory execution model (`.claude/rules/e2e-testing.md`).

### T1 — Mobile login happy path
**Scenario:** Avatar tap + correct 4-digit PIN lands the user on the chat screen.
**Why added:** D-A2 phase gate; regression guard for the login path on both platforms: the auth screen writes the token, then chat entry builds a chat-scoped `MobileSession` whose `open()` drives the SDK to READY. (No SDK singleton — the deleted `SdkStore` path is gone.)
**Steps:**
1. Pre-state: gateway running, users seeded, app at login screen (logged out).
2. `tapOn id: login-avatar-<userId>` (the target user's avatar).
3. `tapOn id: pin-key-1`, `pin-key-2`, `pin-key-3`, `pin-key-4` (valid PIN).
4. `assertVisible id: chat-screen`.
**Expected user-visible:** Chat screen renders. **Expected log trail:** `auth.ok`; `session.ready` in gateway logs.
**Platform notes:** Same testTag IDs on both Android (Compose `Modifier.testTag`) and iOS (SwiftUI `.accessibilityIdentifier`). Write one `/tmp/login-happy.yaml` per platform, identical flow body.

### T2 — Mobile login bad PIN
**Scenario:** Wrong PIN is rejected; error indicator shown; user stays on login screen.
**Why added:** D-A2 phase gate; validates that `login-error` testTag renders and no token is persisted on credential failure.
**Steps:**
1. Pre-state: logged out.
2. `tapOn id: login-avatar-<userId>`.
3. Enter four wrong digits via `pin-key-*`.
4. `assertVisible id: login-error`.
5. `assertNotVisible id: chat-screen`.
**Expected user-visible:** Error state on the PIN pad; login screen stays. **Expected log trail:** one WARN `invalid-credentials` in gateway; no auth token written.

### T3 — Mobile send/receive (login → chat → assistant reply)
**Scenario:** After login, the user types a message, sends it, and receives an LLM reply — both committed to the message list.
**Why added:** D-A3 phase gate; end-to-end contract across login → WS `READY` → `ClientMessage.TextInput` → Hermes round-trip → `ConversationEntry` rendering. Builds on T1.
**Steps:**
1. Pre-state: logged in, connection READY (`ConnectionState.status == READY`) (complete T1 first, or launch into a pre-authenticated session).
2. `tapOn id: chat-input` → `inputText: "hello"` → `tapOn id: chat-send`.
3. `hideKeyboard` (soft keyboard obscures list on Android).
4. `assertVisible id: message-bubble-0` (user bubble commits immediately).
5. `extendedWaitUntil id: message-bubble-1, timeout: 40000` (LLM round-trip via Hermes, ~40 s budget).
6. `assertVisible id: chat-message-list`.
**Expected user-visible:** User bubble at index 0; assistant bubble at index 1 with non-empty text. **Expected log trail:** `text.input` frame out on transport; `conversation.entry` event received and rendered.
**Platform notes:** Maestro YAML written to `/tmp/send-receive-android.yaml` (appId `io.sentient.android`) and `/tmp/send-receive-ios.yaml` (appId `io.sentient.ios`) at run time. Same step body; only `appId` differs. iOS simulator does not require `hideKeyboard` between send and assert.

### T6 — Mobile settings logout (version + clear-token + disconnect → login)
**Scenario:** From chat, open Settings, confirm the app-version string, tap Log out, and land back on the login screen — proving the token was cleared + the WS disconnected. Relaunch (without clearing app data) and confirm login again, proving the clear was persistent.
**Why added:** D-A5 phase gate. Logout clears the token + display name; the chat view's teardown (VM clear / `deinit` → `MobileSession.close`) disconnects the WS. Regression guard: a future change that disconnects but forgets to clear the token would silently auto-resume on relaunch — only the relaunch leg catches it.
**testTags used:** `settings-open` (chat top bar gear), `settings-screen`, `settings-version`, `settings-logout`, `settings-back`, plus `login-avatar-<userId>` for the return assertion.
**Steps:**
1. Pre-state: logged in, connection READY (`ConnectionState.status == READY`), chat showing (complete T1 first).
2. `tapOn id: settings-open` → `assertVisible id: settings-screen`.
3. `assertVisible id: settings-version` AND assert its text is a non-empty version string (`<name> (<code>)`, e.g. `0.0.1 (1)`).
4. `tapOn id: settings-logout`.
5. `assertVisible id: login-avatar-<userId>` (avatar grid OR PIN pad — both are the login screen; see platform note) AND `assertNotVisible id: chat-input`.
6. Relaunch: `am force-stop` then `am start` (NEVER `pm clear` — that clears the token artificially and voids the proof). `assertVisible id: login-avatar-<userId>`; gateway shows NO new `attach` / `session.ready` (no auto-resume).
**Expected user-visible:** Settings shows version + Log out; after logout the login screen returns; relaunch returns to login. **Expected log trail (gateway):** on logout — `[ws] client-disconnected`, `[ws] session-cleanup`, `[hermes-adapter-client:wire-bootstrap] ws.close code=1000`, `[person-session] detach attachmentCount=0`, `[gateway:session-router] release remainingBindings=0`; on relaunch — silence (no attach).
**Platform notes:** Drive method on this stack was the **`android` CLI + adb** (Maestro not installed): `android layout --device=<serial> --pretty` yields each element's `center` coord → `adb shell input tap <x> <y>`; assertions are `android layout | grep <resource-id>`; screenshots via `adb exec-out screencap -p`. Same flow body for iOS via `xcrun simctl` + `.accessibilityIdentifier`. **Logout return state:** after logout *within the same process* the login screen re-renders in the PIN phase (Android `AuthViewModel` retains `selectedUser`), so step 5's `login-avatar` assertion may need a preceding `settings-back`-style back tap OR is satisfied by the PIN pad (`pin-key-1`); the avatar grid reliably reappears on the *relaunch* leg (fresh ViewModel ⇒ PICK_USER). Gateway logs on the macOS deploy write to `~/.sentient/gateway/logs/YYYY-MM-DD.log` (UTC), NOT `docker logs` stdout.

### T7 — Mobile send diagnostic log (SentientMobileVitals upload)
**Scenario:** From Settings, "Send diagnostic log" → pick "This session" → the control morphs in place into a progress bar → "Sent ✓ — ref XXXX"; the gateway stores the file under `clientLogs/mobile/`.
**Why added:** SentientMobileVitals manual-upload lane — the always-on diagnostic ring → rolling per-launch file → authenticated `POST /api/v1/diagnostics/logs`. Regression guard for the client→gateway diagnostic contract, the session-meta/device-state header, and the **metadata-only privacy** guarantee.
**testTags used:** `settings-send-logs` (Android Compose `testTag`; on iOS SwiftUI elides the inner button's id → drive/assert the iOS row by visible text "Send" / "Sent ✓"). `settings-log-progress` (iOS progress view).
**Steps:**
1. Pre-state: gateway rebuilt WITH the diagnostics endpoint + the `~/.sentient/gateway/clientLogs:/app/clientLogs` volume; logged in (T1); one chat turn sent (T3) so the log has content.
2. Open Settings → `tapOn id: settings-send-logs`.
3. The session list reveals with "This session" (newest) selected; tap its Send.
4. `assertVisible` the progress view, then the "Sent ✓" + ref text.
**Expected user-visible:** button → progress bar → "Sent ✓ — ref XXXX" (or "Upload failed — retry"). **Expected log trail (gateway):** `[*:api:diagnostics] received` with `userId`/`bytes`/`crashed`/`ref`; a new `~/.sentient/gateway/clientLogs/mobile/<userId>-<ts>[-crash]-<ref>.log` whose header carries `platform`/`device`/`os`/`appVersion`/`deviceId`/`network` + a `=== STATE @init ===` block (battery/mem/thermal). **Privacy assertion (security boundary):** grep the uploaded file — it MUST contain ZERO chat text; `recv-text` lines must read `len=` not raw frames.
**Platform notes:** Flows are COMMITTED at `qa/mobile/flows/{android,ios}/30-send-diagnostic.yaml` (the vitals work commits Maestro flows under `qa/`, unlike the `/tmp` convention in the Mobile method header above). **Crash auto-upload is NOT yet E2E-coverable** — no in-app way to trigger a Kotlin unhandled exception (adb/simctl signals don't fire the `UncaughtExceptionHandler`/K-N hook); needs a debug-only crash trigger (follow-up). iOS app version may show build `(1)` vs Android `(N)`; both must read `0.1.2+`.

### T8 — Mobile follow-up across reconnect + scroll stability (cycleId fix)
**Scenario:** A chat with a completed turn; force a WS reconnect, then send a follow-up. The follow-up's reply renders under the follow-up message; the previous response is shown exactly once (not re-shown, not missing). Separately, scrolling up past the latest reply then back down keeps the bottom reply visible + correct.
**Why added:** E2E guard for the cycleId render-key fix (2026-06-14) — the production iOS bug "follow-up reply missing / previous response shown" + "scroll bottom stale". The fix is server cycleId uniqueness + mobile `entryId` dedup in `ConversationHistoryConnector`.
**Flows (committed):** `qa/ios/charters/cycleid-reconnect-followup-part1.yaml` (login + turn 1), then a shell `docker restart sentient-gateway` (wait healthy), then `…-part2.yaml` (foreground → reconnect → follow-up + assertions); `qa/ios/charters/cycleid-scroll-stability.yaml`. Findings + cycleId values in `qa/ios/findings/cycleid-fix/findings.md` (PNGs gitignored repo-wide).
**testTags used:** `composer-input` (NOT `chat-input`), `chat-send`, `assistant-bubble` (NOT `message-bubble-1`), `message-bubble-0` (user), `connection-lost-banner`, `connection-reconnect`, `new-chat`. Assert on reply TEXT, not bubble indices.
**Steps:**
1. Login (avatar + PIN 1234), fresh chat. Send "Reply with exactly: ALPHA"; await reply.
2. Shell: `docker restart sentient-gateway`; wait `docker inspect --format '{{.State.Health.Status}}'` == healthy.
3. Foreground app → tap `connection-reconnect` if `connection-lost-banner` shows → wait banner notVisible + `composer-input` visible.
4. Send "Reply with exactly: BRAVO"; await reply. Assert BOTH ALPHA and BRAVO replies visible, in order, ALPHA exactly once.
5. Scroll: build ≥2 turns incl. a long reply; swipe to top (first user msg visible) then back to bottom; assert last reply still visible + correct.
**Expected user-visible:** follow-up reply renders under the follow-up; prior reply not duplicated/missing; bottom reply stable across scroll.
**Expected log trail (gateway):** the two `[cerebrum:attention-gate] cycle dispatched` lines carry DISTINCT numeric cycleIds (e.g. `1781509517090` then `1781509545080`); no `cycle-N`.
**Known limitation (flagged):** the exact cross-gate colliding-id repro (resumable socket drop that KEEPS the same conversation but rebuilds the AttentionGate) is NOT cleanly agent-reproducible on-sim — `docker restart` / `launchApp` both hit `configure.resume.skip-no-cursor` → a fresh empty chat, and a brief network blip leaves loopback TCP intact (same gate). That collision path is covered server-side (cycleId-uniqueness, gateway unit test) + by the mobile `entryId`-dedup unit guard. **Build note:** the sim app MUST be signed (`CODE_SIGN_IDENTITY=- CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES`); `CODE_SIGNING_ALLOWED=NO` strips the keychain entitlement → `errSecMissingEntitlement (-34018)` → empty WS auth token → WS rejected `1008 "first message must be type:auth"` → login fails. (Note `CODE_SIGNING_ALLOWED=NO` is fine for a COMPILE check, never for a runnable E2E.)

### T9 — Mobile auth-expiry routes to login (not infinite "reconnecting")
**Scenario:** A logged-in chat where the auth token is invalid/expired on the next reconnect. The app routes to the **login screen**, never sits in a permanent "Reconnecting…" banner.
**Why added:** Regression guard for the expired-token auth fix (2026-06-27). The gateway sends `auth.error` frame `code:"expired"` (also `malformed`/`signature-invalid`/`wrong-purpose`) then closes 1008; the mobile SDK previously classified these as `NETWORK` (not in its terminal set) → reconnect loop forever, never `authExpired`. Fix inverts the handshake-frame classifier (`AuthErrorClass.isTerminalAuthError(code)` is terminal unless explicitly retryable). Web-sdk never had this (treats any auth-phase error as terminal).
**Driver — Android is deterministic via the debug fault channel.** Arm the expired-token fault, then force a reconnect:
1. Pre-state: gateway running, logged in (T1), chat READY.
2. `adb shell am broadcast -a io.sentient.debug.FAULT -p io.dev32.sentient.debug --es kind expired` → expect logcat `fault.arm kind=expired-token`.
3. Force a reconnect cycle: background→foreground (`adb shell input keyevent KEYCODE_HOME` then re-launch) OR toggle wifi (T10 driver) — the next connect sends the now-expired token.
4. `assertVisible` the login screen (`login-avatar-<userId>` / PIN pad); `assertNotVisible id: chat-input`.
**Expected user-visible:** routes to login (NOT a stuck "Reconnecting…"). **Expected log trail (logcat, tag `sentient`):** `fault.arm kind=expired-token` → handshake `auth.error` code=`expired` → terminal-auth → `signalAuthExpired` / `scope.auth-failure → login` → NO repeating `transport.reconnect attempt` loop. **Gateway:** `auth.reject code=expired`.
**Platform notes:** **iOS — real-device/manual only (flagged gap):** no `adb`-broadcast fault-arming channel on iOS (see ios-testing rule), and `armExpiredToken` cannot be triggered from the sim. Drive iOS by issuing a short-TTL token on a local gateway (or a genuinely expired one) then foregrounding; assert os_log `auth.error code=expired` → `onAuthFailed`/authExpired → login route. Fault API: `FaultHooks.armExpiredToken()` (`shared/mobile-sdk/.../dev/FaultHooks.kt`), receiver `android/src/debug/.../DebugFaultReceiver.kt` (`--es kind expired`).

### T10 — Mobile network-change recovers a queued send (not stuck "Retry")
**Scenario:** A message typed then sent across a network-path change (e.g. VPN→WiFi) recovers — it flushes and gets a reply — instead of stranding on a permanent "Retry" chip on a dead-but-"READY" socket.
**Why added:** Regression guard for the network-change reconnect fix (2026-06-27). There was NO persistent network observer; a path change under a half-open socket left the SDK at `READY` on a dead socket, and `retry()` re-sent to the same dead socket (`if !isReady` trusted the stale flag). Fix adds a persistent observer (iOS `NWPathMonitor`, Android `registerDefaultNetworkCallback`) → `component.ensureConnected()` on path change, and routes `retry()` through `ensureConnected()`.
**Driver — Android is deterministic via `svc` transport toggle** (a real socket break, unlike loopback blips):
1. Pre-state: gateway running, logged in (T1), chat READY. (Gateway reachable from the emulator — `10.0.2.2` or the configured backend.)
2. Type a message into `chat-input` but before/while sending, kill the network: `adb shell svc wifi disable` (and `svc data disable` if on data). Tap `chat-send`.
3. Wait > unacked-timeout (~10 s) → the message shows the **Retry** chip.
4. Restore: `adb shell svc wifi enable`. The default-network callback fires → `ensureConnected` → reconnect.
5. `assertVisible` the assistant reply (message flushes; gateway dedups by `pendingId`); Retry chip clears. If still showing Retry, tap it once and assert recovery (retry now verifies the socket).
**Expected user-visible:** message recovers (no permanent Retry). **Expected log trail (logcat):** `net-change network-lost`/`network-available → ensureConnected` → `foreground.not-ready → reconnect` or probe-timeout → `transport.reconnect success` → `send-message flush count=1` → committed echo.
**Platform notes:** **iOS — real-device/manual only (flagged gap):** the simulator shares the Mac's network, so a VPN half-open path change is not deterministically reproducible on-sim; verify on a real device (background → switch VPN→WiFi → foreground → send). os_log trail: `net-path-monitor path-changed → ensureConnected` → reconnect → flush. **No socket-drop fault exists** — `svc wifi` is the closest deterministic Android stand-in; a debug `armDropSocket` fault would tighten this (follow-up).

## Fish voice browse & clone (Settings → Voice → ＋ Add voice, Playwright MCP)

Self-contained, removable module — see `docs/fish-integration.md` for the
disable/removal guide. `fish_browse_enabled` defaults `true`; browse is
public (no Fish API key needed). Gateway log tags: `[api:fish:browse]`,
`[api:fish:clone]`, `[providers:fish:fetcher]`.

### fish-browse (grid loads + search + facet filter)
**Scenario:** Opening the "Clone from Fish Audio" tab loads a grid of Fish voices with preview/tags; typing a name re-queries the server (`?title=`); clicking a language/gender/vibe chip narrows the already-loaded grid client-side (no new request).
**Why added:** Regression guard for the Fish browse proxy (`gateway/src/api/handlers/fish/fish-browse.ts`) and the webui's split between server-side title search and client-side facet filtering.
**Steps:**
1. Settings → Voice → ＋ Add voice → click "Clone from Fish Audio" (3rd tab, only present when `fish_browse_enabled` is true).
2. Observe the grid loads with tiles (name, language, gender/age, tags, preview ▶) and a total count.
3. Type a common name into the search box.
4. Clear it, then click a Gender/Age/Tag chip.
**Expected user-visible:** grid loads on tab open; typing narrows the grid (server round-trip); clicking a facet chip narrows further with no visible reload.
**Expected log trail (gateway):** tab-open emits `[api:fish:browse] voices.begin hasTitleFilter=false` → `voices.done count=<n>`. Search emits a second `GET /api/v1/providers/voices?title=<q>` → `voices.begin hasTitleFilter=true` → `voices.done`. Facet click emits **no** new `/providers/voices` request (network tab confirms — purely client-side over the already-fetched page).

### fish-clone (pick a voice → clone → pack appears, auto-picked)
**Scenario:** Picking a Fish voice with a sample ≥ ~6s, confirming name/tags, and clicking "Clone voice" downloads the sample server-side, creates a local-tts voice pack, and auto-activates it — the new pack appears under "Yours" as Active.
**Why added:** Regression guard for the full clone round-trip (gateway SSRF host-check → sample download → TTS `voice.create` → profile activation). The SSRF guard allowlists Fish's CDN hosts (`*.fish.audio` + `*.r2.cloudflarestorage.com` — single-voice `GET /model/:id` serves presigned R2 URLs), is https-only, and uses `redirect:"manual"` (3xx = download failure) so an allowlisted host can't redirect to an internal address. See `docs/fish-integration.md`.
**Steps:**
1. In the Fish tab, click a voice tile (not the ▶ preview) to select it — name/description/tags pre-fill from Fish metadata, "Clone voice" enables.
2. Click "Clone voice".
**Expected user-visible:** a success toast ("Voice created") and the new pack appears under "Yours", auto-picked (Active). The success toast auto-dismisses after `TOAST_DISMISS_MS` (4s) — assert promptly or poll `.toast-host`, don't rely on a screenshot taken >2s after the click.
**Expected log trail (gateway):** `[providers:fish:fetcher] fetchFishVoiceById.begin/done` → `[api:fish:clone] clone.create.request` → `[tts:voice-mgmt] create.success` → `[person-session] voiceId.update` → `[api:fish:clone] clone.success`, and `POST /api/v1/providers/voices/<id>/clone` → 200.

### fish-tab-hidden (feature flag off)
**Scenario:** With `providers.fish_browse_enabled: false` in the operator config, the "Clone from Fish Audio" tab never renders, and the browse/clone routes 404 even with a valid bearer token.
**Why added:** Regression guard for the kill-switch — the route must 404 before auth is checked (no route-existence leak), and the webui must read the flag from `services/versions`, not hardcode the tab.
**Steps:**
1. Set `providers.fish_browse_enabled: false` in `~/.sentient/gateway/config/config.yaml` (`providers:` section), restart the gateway container (no rebuild — read at boot).
2. Reload the webui, open Settings → Voice → ＋ Add voice.
3. From the browser console (already-authenticated session), `fetch('/api/v1/providers/voices', { headers: { Authorization: 'Bearer ' + <token> } })`.
4. `fetch('/api/v1/services/versions', ...)` and inspect `body.features`.
**Expected user-visible:** only Record / Upload tabs — no Fish tab. `GET /api/v1/providers/voices` with a valid token → `404`.
**Expected log trail / response:** `services/versions` response body has `features.fish_browse_enabled: false` (DEBUG-level `[services-versions] services-versions.fetched` log line exists but won't print at the default `info` log level — assert via the response body, not the log). Revert the config key and restart to re-enable after this case.

## local-tts service (WS probe) — engine-level smoke

Direct WebSocket smoke against the native local-tts service (`ws://127.0.0.1:8770`), bypassing the gateway. Re-run whenever the TTS **engine** changes (this is how the Chatterbox→Qwen3-TTS swap was validated). Drive with the service venv python + the `websockets` lib; the wire contract is `CONTRACT.md` (`text`→`flush`→`ready`/`started`→binary PCM frames→`done`; `voice.create`+one binary ref clip; `voice.list`/`voice.delete`). Connect with `?format=pcm` so frame bytes → samples is trivial (`<i2`/32768, duration = samples ÷ ready.sample_rate). The agent can't audition audio — assert non-empty audio of plausible duration + `started`/`done` + the `local_tts.*` log trail; **save the zh wav for the user to audition quality**.

### tts-multilingual (en + zh synth, default voice)
**Scenario:** Synthesize an English line and a Mandarin line through the default voice; both must return non-empty PCM. This is the Qwen-swap headline (Chatterbox-Turbo was English-only → Mandarin was nonsense).
**Expected:** en ≈ text-length-appropriate seconds, zh non-empty (~5s for a short sentence). Log: `local_tts local-tts starting: model=…Qwen3-TTS… default_lang=auto`, `engine.warm done`, no `chatterbox` in the live logs. `@live` unit equivalent: `test_local_tts_engine.py::test_streams_pcm_chunks_default_voice_zh`.

### tts-builtin-voice + clone-roundtrip
**Scenario:** `voice.list` returns the 5 built-ins (nova/wren/flint/briar/ember, all `ref.wav`); synth with `?voice=wren` renders; `voice.create` (upload a >5s wav/mp3) → `voice.list` shows it → synth in it → `voice.delete`.
**Expected:** `voice_store.get resolved voice_id=wren path=…/wren/ref.wav`; `voice_store.create done … ref_duration_ms=<n>`; synth non-empty in the cloned voice; `voice.deleted`.

### tts-stale-voice-degrades (sad path — migration edge)
**Scenario:** A user voice pack created under the OLD Chatterbox engine holds `conds.safetensors` (no `ref.wav`). Under Qwen, synth with that voiceId must degrade to the default voice, never crash.
**Expected:** `local_tts.voice_store voice_store.get fallback=default reason=unknown_voice voice_id=<id>` (WARNING) → normal `done` with default-voice audio. Pre-swap clones need re-cloning to sound like themselves; the service never errors on them.

> **Webui UI rows** (chat→en/zh reply→TTS audio; fish-clone-zh through the Add-voice modal; record/upload+mp3/preview/pick/delete on qwen; mobile 390 viewport) exercise the gateway↔local-tts wire through the real product but require the profile **PIN** to pass the login gate — hand to the operator to run, or supply the PIN. The wire itself is engine-neutral (unchanged port/protocol across the swap) and is proven at the service level by the probe cases above.

## Voice-pack language metadata (Settings → Voice)

A voice pack carries a single optional `language` (one of Qwen's 10: zh/en/ja/ko/de/fr/ru/pt/es/it, or unset). Verified live on :8888 (hot-copied build) — filter Select + modal dropdown render, preview `?lang` wire fires, service stores/lists it. Rows needing the PIN + audio audition are the operator's.

### lang-service-store (WS probe — agent-verifiable)
**Scenario:** `voice.create` with `language` → `voice.list` returns it. Drive with the service venv python (see the WS-probe cases above); create a pack with `{"language":"ja"}`, list, assert the entry's `language == "ja"`; delete to clean up.
**Expected:** service stores the string verbatim + `voice.list` returns it. The service does NOT log the language on create (its create log carries `voice_id`/`name`/sizes only) — assert via the LIST output, not a log line. Built-in packs list `language: ""`.

### lang-preview-wire (agent-verifiable via log trail)
**Scenario:** Click a pack's "Play a sample". The gateway picks a greeting in the pack's language.
**Expected log trail (gateway):** `[gateway:api:voices:preview] preview.request voiceId=<id> lang=<code-or-(unset)> greetingLen=<n>` → `preview.success`. Unset language → `lang="(unset)"` + the English greeting; a zh-tagged pack → `lang="zh"` + a Mandarin greeting (audition the audio to confirm the language — operator step).

### lang-ui + lang-fish-import + lang-filter (operator — PIN + audio)
**Scenario:** (a) Add-voice modal shows a **Language** single-select dropdown ("No language" default) next to Description; picking one + creating stores it → tile shows a flag badge. (b) Clone-from-Fish prefills the language from the Fish voice's `languages[0]` (∩ the 10; unsupported → unset). (c) The Voice-Packs **"All languages"** filter narrows the grid to packs whose `language` matches. (d) mobile 390 — filter + modal usable, no overflow. Reuses the Fish search `Select` + the shared `@sentient/config` LANGUAGE_DISPLAY map.

## Sentient 2.0 turn wire — web (Playwright MCP)

Reusable cases for the native orchestrator's turn lifecycle, driven live
2026-07-30 (native-stack migration Task 9) against a real gateway
(`bun --watch src/main.ts`, `SENTIENT_CODE` pointed at a staged
`<code>/whisper-stt|local-tts/{venv,src}` layout) + Vite webui dev server.
Full per-case evidence, gateway log excerpts and defect diagnoses live
under `qa/web/evidence/2026-07-30-<case>/`. Log tags:
`[runtime:react-loop]`, `[runtime:session-runtime]`, `[runtime:turn-voice]`,
`[ws:turn-emitter]`, `[provider:openai]`, `[tools:tool-broker]`,
`[runtime:permission-broker]`, `[runtime:cancellation]`,
`[runtime:compaction]`. See the migration banner near the top of this file
for the full bring-up + re-grounding notes.

Both viewports are in scope for every case here (`.claude/rules/e2e-testing.md`):
desktop 1280×900 and mobile-sized 390×844. The 390 re-drive of this whole
section lives in `qa/web/evidence/2026-07-30-mobile-390-matrix/` — read
**Mobile-sized viewport (390×844)** at the end of this section before driving
it, the resize-only shortcut produces false layout findings.

**Driving quirk worth knowing:** in this environment, `browser_click` on
a fresh element sometimes silently no-ops (composer Send, PIN-pad digits)
— confirmed NOT tied to `page.evaluate(() => el.click())`, which worked
reliably every time. When a click seems to do nothing, don't assume the
product is broken — retry via a script-dispatched click and check for a
visual signal (e.g. PIN-pad fill dots aren't in the accessibility tree,
only the screenshot) before concluding a real bug.

### native-turn-happy
**Scenario:** A plain text turn streams token-by-token and the committed bubble survives after `turn.completed`.
**Why added:** the committed feed is new in 2.0 and was broken twice during development — this is the base-case regression guard.
**Steps:** send any short prompt; watch the bubble grow via `turn.text.delta`; confirm it stays after `turn.completed` (no revert/duplicate).
**Expected log trail:** one `turnId` (uuid) through `react-loop.start` → `provider:openai stream-start/stream-end` → `turn.completed` → `turn-voice.audio.start/done` (audio is a separate phase, starts after text settles — can be seconds later on a long reply).

### native-tool-call
**Scenario:** A prompt needing a foreground MCP read renders a running→done tool pill and a correct final answer.
**Steps:** ask something needing a live HA/searxng/etc. read.
**Expected log trail:** `tools:tool-broker tool-broker.pdp.decision action="allow"` → `mcp-client mcp.call-tool.ok` → `tool-dispatch.foreground`. A hallucinated tool name (small models do this) correctly hits `tool-broker.dispatch.unknown-tool` and the model self-corrects with a real tool — not a bug, the fail-safe working.

### permission-confirm-web — all 3 arms
**Scenario:** A side-effecting tool (e.g. `ha_call_service`) blocks on a real confirm dialog.
**Steps:** trigger the tool; **Allow** it once, **Deny** it once, and once let the 120s timeout expire un-answered.
**Expected log trail:** `runtime:permission-broker permission-broker.request timeoutMs=120000` → **Allow:** `permission-resolved outcome="allowed"` → tool dispatches. **Deny:** `outcome="denied"` → `tool-broker.dispatch.denied` → model informed, gives a coherent answer. **Timeout:** `outcome="timeout"` at exactly `request time + 120000ms` (verified to the ms) → tool dispatch shows `isError=true`.

### interrupt (turn+TTS-stop arm)
**Scenario:** Clicking Stop aborts the current turn's audio immediately, whether text is still streaming or already committed and mid-playback.
**Steps:** click Stop while TTS is actively streaming.
**Expected log trail:** `runtime:cancellation cancellation.abort` (or `cancellation.no-turn-in-flight` if text already settled — still valid, audio-stop runs unconditionally either way) → `turn-voice.audio.cancel` → `tts:streaming-tts-synthesizer synthesize-aborted` → `local-tts-socket ws-closed`, all within ~1ms of the click. `background-registry.cancel-all` always fires too, even with nothing to cancel.
**background-task-cancel sub-arm — DRIVEN AND PASSING (NM-T12, 2026-07-31).** The trigger is now exercised end to end from a real webui Stop click. **Make the oracle a pid, not a log line:** a gateway line saying "cancelled" is the gateway's opinion about itself, so sample `pgrep -P <gateway pid>` every 200 ms alongside the drive. Evidence: hermes child pid alive across **61 consecutive samples** (~15 s, so not a race against a process about to exit), Stop clicked while `hermes-runner.run.ok` had not fired, then `run.aborted` → `background-registry.cancel-all count=1` → `run.done-after-abort` → `delegate-task.run.failed reason="aborted"` in **9 ms**, and the pid failed `ps -p` (exit 1) with zero hermes children ever after. `qa/web/evidence/2026-07-31-t12-tool-surface/STEP6-interrupt.md`.
**Reaching the button:** `canInterrupt = cycleStatus !== "idle" || runningTasks > 0` (`app.tsx:179`), so the control stays up while a background task runs even after the turn's text settles — dispatch a long delegation (a "3000-word essay" ask buys ~15 s) and click `button.interrupt-btn`. Expect `cancellation.no-turn-in-flight` rather than `cancellation.abort` on that path; it is correct, and `cancelBackground=true` is what carries the kill.
**`barge-in`, NOT this case:** the webui's Stop button always produces `cutoff="interrupt"`, never `"barge-in"` — `runtime.bargeIn()`'s only production caller is real STT speech-onset detection (`stt-session.ts`). There is no UI control that produces a `barge-in` cutoff; that whole case needs a real microphone, hand to Task 11.

### steer-midloop (core mechanism)
**Scenario:** A background-completion stimulus landing while a turn's react-loop is still running folds into that SAME turn/reply — one bubble, not two.
**Expected log trail:** `session-runtime.submit.steer kind="background-completion"` appended mid-loop; the SAME `turnId` continues across iterations picking it up on the next provider call.
**Known defect found alongside this (not fixed, out of `qa/web/**` ownership):** `session-runtime.ts`'s `nextTurnTrigger()` re-detects an already-consumed mid-loop steer as unconsumed (stale `lastProcessedSeq` snapshot) and spuriously fires an extra, empty follow-up turn every time this case fires — wastes one LLM call and leaves a dangling local-tts WebSocket open (recoverable via one Interrupt click, not a permanent leak). See `qa/web/evidence/2026-07-30-steer-midloop/README.md`.

### delegate-hermes-bg — PASS · steer-followup-audio — PARTIAL (text half only)
**Scenario:** `delegateTask` returns `{taskId}` immediately; a background completion arriving AFTER the dispatching turn's own final answer starts a back-to-back follow-up turn (new bubble, audio queued after the first finishes).
**delegate-hermes-bg: PASS** (NM-T9b re-drive `74385db`) — 5x `hermes-runner.run.ok`, 0 non-zero exits, the first real delegated completions in the project. Both original blockers are fixed: the provisioner now runs `hermes profile create --clone-from <operator profile>` per user at creation and at boot backfill, so the profile exists AND inherits a model + credential. Evidence: `qa/web/evidence/2026-07-30-delegate-hermes-bg/RE-DRIVE-T9b.md` (the README beside it is the historical failing drive).
**steer-followup-audio: PASS including the audio half (NM-T12, 2026-07-31).** A real browser negotiates `audio.output`, so the downlink the WS-seam driver never opened is simply there — no mobile surface needed. **An uncontended sample does not prove the queue.** The first drive had the completion land 2.3 s *after* turn 1's audio finished: that shows sequencing, and flipping on it would be this file's own false-green warning in a new costume. Force contention instead — ask for a delegation **plus** a long inline answer, so turn 1 has ~50 s of speech against a ~3.5 s hermes run. Then the oracle is exact: turn 2's `turn-voice.begin` fired at 18:26:43.813 and its text completed at 18:26:45.634, but its `synthesize-start` was held to **18:27:27.661 — the same millisecond as turn 1's `turn-voice.audio.done`**, 43.8 s later. The two audio windows do not overlap by a frame (86 frames/631909 B, then 91 frames/47346 B). Evidence: `qa/web/evidence/2026-07-31-t12-tool-surface/STEP6-delegate-and-audio.md`.
**D7 (the 10× `delegateTask` refire) is fixed** — the same drives show `grep -c hermes-runner.run.start` = **1** per request, against ten in T9b.
**OPEN — the follow-up bubble does not relay the delegated result.** Reproduced on both drives: `outputLength=476` then `137` come back non-empty, the follow-up turn runs, and its bubble only *acknowledges* ("Got it—thanks for the update!") without ever stating the answer the user asked for. The mechanism is green; the user-visible outcome is not. Do not let a delegation row pass on "a follow-up bubble appeared" — read what it says.
**OPEN DEFECT D11 — the delegated agent has NO gateway/HA/MA/searxng tools, on any fresh install.** The gateway renders `mcp_servers` + `enabled_toolsets` into `~/.sentient/gateway/<id>/profiles/<id>/`; hermes reads `~/.hermes/profiles/<id>/`. The `HERMES_HOME` bridge between them was the supervisord program env, deleted in the native cutover, so the render is dead output. NM-T9c fixed one necessary half (per-user MCP socket off SIP-read-only `/run`) and proved that socket end-to-end, but only after a manual `hermes -p <id> mcp add`. **When driving any delegation case:** dispatch / steer / follow-up / cancel are all drivable, but never assert a delegated agent *used* a gateway tool, never file this as new, and never let a case pass vacuously on "a reply came back". Grep handle for the live symptom: `hermes-profile.bridge.not-live` (WARN, once per user per boot). Root cause, hand-proven fix route and the design decision left open on purpose: `qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md` § D11.

### reload-convergence
**Scenario:** `render(replay) == render(live)` — a hard reload shows the identical feed, including every entry kind (tool pills, permission-confirm outcomes, delegate errors), not just plain text turns.
**Expected:** same article count + same tool-pill/code-element count before/after; server `turn-emitter.conversation-snapshot itemCount=<n>` matches.

### restart-persistence
**Scenario:** A real gateway process restart (native — the migration's actual path, not `docker restart`) preserves the full feed via the persisted store, even though the live-stream resume buffer correctly does NOT survive a restart.
**Expected log trail:** `resume.not-recovered reason="fresh-journal-or-epoch-mismatch"` (correct — no resume buffer across a restart) → `turn-emitter.conversation-snapshot itemCount=<n>` (correct fallback — full history refetch). Client logs 4-5 reconnect attempts with backoff while the gateway is down, then succeeds.
**Reminder:** `bun --watch` does NOT reload `config.yaml` either — it isn't in the module graph, so a config edit needs this same restart to take effect (only one `config-loaded` log line per process lifetime).

### compaction-continue
**Scenario:** Chatting past `orchestrator.compaction.compact_threshold_tokens` triggers `maybeCompact()` at the next turn boundary.
**Drive tip:** track the real running total directly via `sqlite3 ~/.sentient/gateway/users/<userId>/sessions.db "SELECT SUM(LENGTH(text)+LENGTH(tool_args)) FROM entries WHERE kind != 'compaction'"` divided by ~4 — much faster than guessing from the chat transcript.
**Expected log trail on trigger:** `runtime:compaction compaction.summarizing estimatedTokens=<n> thresholdTokens=<threshold>`.
**Expected log trail on success:** `compaction.committed seq=<n> compactedThroughSeq=<tail> summaryChars=<n>`, and the model window collapses — verify it with `projectForModel` + `estimateTokens` against the live DB, not by eye (measured 9434 → 2186 est. tokens, `projectedMessages=1`, while the client feed still rendered 54 items).
**Was a defect, now FIXED and live-verified 2/2** (`summarizer_max_output_tokens: 4000` — the summarizer needs its own budget because the loop's `max_output_tokens: 1024` is an ANSWER cap that gpt-oss:20b spends entirely on Harmony's reasoning channel, yielding `finishReason="length"` with zero visible text → `compaction.skipped reason="empty-summary"` forever). Evidence: `qa/web/evidence/2026-07-30-compaction-continue/RE-DRIVE-T9b.md` (+ `-sample2`).
**Durable lesson — a fake provider cannot prove this class of fix.** The defect was a real model's *token-budget behaviour*; unit tests with a mocked provider pass identically before and after. Anything that tunes a budget, a threshold or a cap against a reasoning model must be re-driven on the streaming production path. Cheapest way to re-drive: resume the surface whose store is already grown past the threshold (`surfaceId` in `session.configure` selects the partition — `c::<userId>::<surfaceId>`) and send ONE turn, rather than regrowing a conversation.
**Known defect D8 (open):** the same cap silently ships an **empty assistant answer** on the ordinary turn path once the prompt grows — `stream-end finishReason="length" completionTokens=1024` → a committed `assistant` entry of 0 chars with `cutoff=NULL`, logged as a normal `react-loop.completed` with no WARN. Observed 1/9 turns at `promptTokens≈12300`. Expect blank bubbles in any long-session drive; see `RE-DRIVE-T9b-sample2.md`.

### multi-user-isolation
**Scenario:** A second member's session shares nothing with the first — no client-side history leakage, no server-side conversation crossover, no cross-user API access.
**Expected:** on identity switch, `sdk.connectors.conversation-history mirror.reset reason="session identity teardown" previousCount=<n>` (Ada's entries explicitly discarded, not hidden); the new user's WS connect opens `conversation-feed.snapshot itemCount=0` on a distinct `conversationId`/sqlite store; a direct REST probe from the non-admin user's own real token gets `403` on an admin-only endpoint.

### Mobile-sized viewport (390×844) — how to drive it, and what is already known

**Resize alone is NOT a mobile check — always reload after resizing.**
`browser_resize(390,844)` on an already-loaded page leaves a stale layout:
the app paints with the desktop-width geometry, and a screenshot taken then
shows the whole shell clipped ~53px to the left (bubble text cut mid-word,
composer placeholder reading "sage Sentient"). That is a driver artifact,
not the product. Sequence is always `browser_resize(390,844)` →
`browser_navigate(<url>)` → assert.

**Assert overflow numerically, not by eye.** Per screen:
`document.documentElement.scrollWidth > clientWidth` for page overflow, plus
`el.scrollWidth - el.clientWidth` on the app shell and any strip. Eyeballing
a screenshot cannot distinguish an intentionally scrollable row from a break.

Measured-intentional at 390 (do not re-report these as defects):
`.suggestion-chips` is `overflow-x: auto` with `scrollWidth 511 > clientWidth 370`;
`.tool-strip__pills` is `overflow-x: auto` with `scrollWidth 344 > clientWidth 332`.
A pill or chip clipped at the right edge is the design.

Green at 390 as of 2026-07-30 (driven as a non-admin member, real stack):
`native-turn-happy`, `native-tool-call`, `permission-confirm-web` Allow + Deny
(the dialog is a full-width bottom sheet, `.app-dialog`, buttons 348×47 —
comfortable tap targets), `interrupt` turn+TTS-stop (Interrupt control is
28×28 at x341-369, in-viewport; server saw the click 7ms later and aborted
mid-synthesis at `frameCount=3`), `reload-convergence` (14/14 articles,
4/4 tool pills, `conversation-snapshot itemCount=18`), and the data-isolation
arm of `multi-user-isolation`.

Viewport-independent by construction — do not spend a drive re-proving these
at 390: the `permission-confirm-web` 120s timeout (server-side
`permission-broker` deadline), `compaction-continue`'s trigger (server-side
token threshold), and `restart-persistence`'s resume protocol (transport
layer; the mobile `reload-convergence` row already exercises the same
snapshot path). Record the reasoning rather than the row.

**Known defect at 390 (webui CSS, not fixed — outside `qa/web/**` ownership):**
`.app-shell` computes `overflow-x: hidden` with `scrollWidth 443 > clientWidth 390`,
so the layout does not fit a 390px viewport. One click on the right-most header
control (`.user-menu__trigger`) scrolls the shell to `scrollLeft = 53` and the
whole app stays shifted — the `Past chats` button moves to x −39…5 (untappable)
and the left 53px of every bubble/placeholder is clipped mid-glyph. Because
overflow is `hidden` there is no scrollbar and no pan gesture to undo it; only a
reload restores the layout. Zero overflow at 1280×900, so it is mobile-only.
Repro + measurements: `qa/web/evidence/2026-07-30-mobile-390-matrix/README.md`.

### Native-restart local-tts hang (found, not a numbered case — real defect)
**Scenario:** On a real gateway process restart, the native driver's `local-tts` spawn can hang completely — no `native.started`, no `native.prepare-failed`, `apply.complete` never fires, so the post-boot health watchdog never even starts. Reproduced 2 of 2 consecutive restarts in this drive; ruled out the command itself (clean manual run, ~3s) and port conflicts (`lsof`/`ps` both clean). Full diagnosis: `qa/web/evidence/2026-07-30-native-restart-tts-hang/README.md`. A P1 for whoever owns `gateway/src/system-orchestrator/**`.

## Sentient 2.0 turn wire — NATIVE mobile (Maestro)

Driven 2026-07-30 (native-stack migration Task 10) against the local dev stack:
native gateway `bun --hot src/main.ts` on `:8888` (binds `0.0.0.0`), docker
addons on loopback, native whisper-stt + local-tts both healthy. Devices:
Android `emulator-5554` (Pixel_3a_API_34, dials `10.0.2.2:8888`) and iOS sim
`iPhone 17 / iOS 26.5` (shares the host network). Both apps rebuilt from the 2.0
SDK first — the pre-2.0 installed builds predate the `turn.*` wire. Evidence:
`qa/mobile/evidence/2026-07-30-native-mobile-matrix/`.

**Bring-up notes that cost real time — read before driving this suite:**
- `SENTIENT_CODE` is unset in dev, so `managed_services.{whisper-stt,local-tts}`
  expand to `/whisper-stt/venv/bin/python` and log
  `native.prepare-failed … argv[0] is not an executable file`. Stage a tree of
  symlinks (`<code>/{whisper-stt,local-tts}/{venv,src}` →
  `capabilityServices/{WhisperSTTService,LocalTTSService}/{.venv,src}`) and export it.
  STT/TTS still answer either way — the providers dial the ports directly.
- The login-picker avatar id is **server-minted** and does not survive a state
  reset. It is now the Maestro env var `QA_USER_ID` (default `u_0417d3b0`), and
  `run-e2e.sh check_qa_user` pre-flights it against `GET /api/v1/auth/users`
  before any JVM starts. A stale id fails at the SELECTOR, which looks like a
  product regression and is not one.
- The `settings-admin` trio (41/42/43) needs a **one-user household**; at the
  3-user cap "Add user" is correctly disabled and 41 dies at the dialog.

### native-turn-happy — D12 CLOSED (task 9e), and what it was hiding
**Scenario:** any text send from Android or iOS.
**Was:** FAIL on both platforms — `ws-handlers.ts` routed `session.new` to `default:`, nothing
emitted `session.created`, and the KMP `SendMessageUseCase` gates its outbox drain on the id that
frame sets, so every send died on the device at `flush-skipped reason=no-id-attached`.
**Now: PASS on both platforms.** `session.new` is answered with `session.created` carrying the
connection's durable conversation id (`gateway/src/session-handlers/ws-session-new.ts`); the device
line is now `data.send-message: flush count=1 sessionId=c::<userId>::<surfaceId>`. Android `chat`
went 0/6 → 5/6 and iOS 0/5 → 4/5 with **every flow unedited**. Evidence:
`qa/mobile/evidence/2026-07-30-t9e-session-new/`.

**D12 was masking three further defects. Two are now closed (task 9f); one is deferred by design:**
- **D14 — CLOSED.** `pendingId` is persisted on the user entry, echoed on the committed feed and
  deduped in `SessionRuntime.submit`. Store reads and turn counts are trustworthy again. Measured
  0 duplicate `(session_id, pending_id)` groups over 10 device sends, against 2× on the identical
  message pre-fix and a 30× worst group in the polluted store.
- **D13 — CLOSED.** Android's permission dialog exports its test ids (below).
- **D15 — OPEN, deferred to the multi-conversation project.** "+" does not reset the server-side
  conversation, so a "new" chat inherits the previous one's context. Its blast radius is wider than
  `01-newchat`: see the `session`-tag rows below.
None of the three is a reason to re-diagnose a red `chat` row as D12 again. D12 is closed.

### permission-confirm (native) — PASS on BOTH platforms since task 9f (D13 closed)
`qa/mobile/flows/{android,ios}/12-permission-confirm.yaml` is the native arm the predecessor spec
never had. **iOS PASSES** (30s) — `permission-request` → user tap → `permission-resolved
outcome="allowed"` — which proves the gateway's L3 round trip end to end from a device and localises
the Android red to the client.

**Android was red for a reason no budget change could fix, and is now green (24 s, flow UNEDITED).**
The dialog always rendered and the app always logged `permission.pending.changed hasPending=true`,
but `uiautomator dump` showed **every node with `resource-id=""`** — so `id: chat-permission-allow`
could never resolve. `testTagsAsResourceId` was enabled once, on `AppNavHost.kt:77`'s `Surface`, and
a Compose `AlertDialog` composes into its own window outside that subtree. `PermissionPromptDialog.kt`
now sets it on the dialog's own modifier, exactly as `settings/components/RowSelect.kt:87` already did
for its dropdown. The flow was never edited — its ids were the ids in the source all along.

**Durable rule:** any Compose surface in its OWN WINDOW — `AlertDialog`, `DropdownMenu`,
`ModalBottomSheet`, `Popup` — needs its own `Modifier.semantics { testTagsAsResourceId = true }`.
A testTag that is present in Kotlin and absent from the UIAutomator dump is this, every time.
Selectors are also **not symmetric** across platforms: Android `chat-permission-allow` /
`chat-permission-deny`, iOS `permission-allow` / `permission-deny` (`ChatPermissionAlert.swift`),
and iOS has no description testTag (SwiftUI alert `message`, assert by text).

### assertVisible means ON SCREEN — with the IME up, the chat viewport is ~300 px
`01-chat-send` was the only chat flow without `hideKeyboard`, and it went red on a message that was
committed, echoed and rendered. `MessageList`'s `animateScrollToItem(lastIndex)` aligns the last
row's TOP with the viewport top, and with the keyboard open that viewport is a few hundred pixels —
so the bubble under test sits above the fold and `assertVisible` (which requires an on-screen node)
fails. Measured both ways the same minute on `emulator-5554`: without `hideKeyboard`, FAIL even at a
15 s budget; with it, PASS. **Rule: any flow asserting a chat bubble calls `hideKeyboard` first.**
It became reachable only when D14's fix stopped the optimistic bubble lingering as a second copy of
the same text — a red that appears the moment a duplicate stops being painted is a flow that was
passing on the duplicate.

### migrating the session store — a fresh-DB test cannot see the bug that matters
`gateway/src/store/schema.ts` had no migration mechanism: no `user_version`, no `ALTER TABLE`, just
`CREATE TABLE IF NOT EXISTS`. Every per-user database under `~/.sentient` already exists, so a column
added to the DDL reaches **none** of them and the first query naming it fails at runtime for real
users while every fresh-database test stays green. That is how D14's `pending_id` went missing.
Now a `user_version` ladder over a **frozen** baseline DDL: fresh and long-lived databases run the
same migration code, so the fresh-DB test covers the real path. **When you touch this schema:** never
edit `STORE_DDL`, add a `StoreMigration`; and write the test that opens a database built from a
verbatim copy of the OLD DDL, not a reference to the current one. Verified against a real 166-row
pre-migration artifact: `user_version` 0 → 1, column added, all rows intact, reads still serve.

### settings apply — the 45 s budgets were padding for a machine that no longer exists
`apply:orchestrator apply.ready elapsedMs=5..12` (4 samples). No supervisord, no
Hermes worker to restart. Consequences, both real regressions the padding hid:
`settings-apply-notice` is now a ~10 ms transient, so a hard `assertVisible` on it
is a race the runner loses (45/45b failed exactly that way); and every
`notVisible` budget is now **8000 ms**, not 45000. Untouched on purpose: `04c`
(real LLM round-trip) and `60`/`61` (offline recovery).

**Verified on BOTH platforms, not extrapolated.** The re-baseline was first
measured on Android and the 7 iOS twins were edited to match without a drive —
a budget "verified" on one platform is a hypothesis on the other. The iOS batch
was then run: `45, 45b, 48, 48b, 49, 49b` all PASS at 8000 ms, and `47` fails at
a step *after* its first 8000 ms wait is already crossed, so the re-timing is not
implicated there either. iOS-side server timing during that run: `apply.ready
elapsedMs=6` / `elapsedMs=8`, inside the Android band. Evidence:
`qa/mobile/evidence/2026-07-30-native-mobile-matrix/ios-settings-batches.txt`.

### percentage point-taps carry an UNSTATED device-geometry dependency
Where an accessibilityIdentifier is inherited by every descendant of a row (iOS
`RowToggle`, personality cards), `tapOn: id:` resolves to the row's bounds centre
— the label — and silently no-ops, so several iOS flows point-tap a percentage
instead. That percentage is only valid for the screen it was measured on, and
nothing in the flow said which one. On iPhone 17 / iOS 26.5 (402x874) the audio
switch is `[305,214][366,242]`; the committed `85%,24%` resolved to (342,210),
**4 px above the switch**, and `44`/`44b`/`59` all died at
`settings-audio-save is visible` — which reads like a broken save and is not one.
Re-measured to `83%,26%` = (334,227); all three pass. **Rule: a point-tap MUST
record the sim model, the screen size, and the measured element bounds in a
comment. Re-measure with Maestro `inspect_screen`; never nudge the number.**
`50`'s `89%,21%` chevron is the same class, still red, still unmeasured.

### personality activate — a flow that asserted a DEFECT as its expected outcome
`50-personalities-create-activate` asserted "Activate wipes the personality
(DEFECT-4)". That race was the supervisord restart; it is gone, the personality
survives (`profiles/<user>/config.yaml` still lists it), and the flow failed
**because the bug was fixed**. Re-grounded to assert survival + a real delete.

### EXPECTED-INERT (2.0) — soul / personality / long-term memory
These render and persist but do not change assistant behaviour: the gateway owns
the loop and those surfaces transition in a later spec. A flow asserting
render/persist MUST still pass — `46-memory-cap` does on both platforms, and
`47`/`50` do on Android. On iOS `47` and `50` are RED for reasons unrelated to
inertness (a selector the keyboard hides, and an unmeasured point-tap); see the
per-platform table below. Only a behaviour assertion is inert. Never delete such
a flow, and never let `EXPECTED-INERT` absorb a red that has a real cause.

### voice-roundtrip (native) — NOT DRIVABLE, handed to Task 11
Two independent blockers. (1) The fixture-injection channel is **gone**:
`FaultHooks` kept only `armExpiredToken`/`armMalformedFrame`, and
`DebugFaultReceiver` logs `fault.broadcast.unknown-kind` for anything else, so
`--es kind fixture` is delivered and discarded. (2) The mic is **hold**-to-talk:
Maestro's `tapOn` gives `pressMic`→`releaseMic` ~147 ms apart, `record-stop
captured=1`, and gateway-side `stt.audio-start`→`stt.audio-end` 180 ms apart.
A real speech fixture now exists and is proven at the service seam
(`transcript_ready {"text": "What is 2 plus 2?", "decodeMs": 439.751}`) —
`qa/mobile/fixtures/README.md` has the regeneration + validation recipe.
Note the voice path calls `runtime.submit()` **server-side**, so it was never
blocked by D12 (which is closed anyway — task 9e).

### interrupt (native) — the flow PASSES; the interrupt ARM is still unasserted
`05-interrupt` is **green on both platforms** since task 9e (Android 27s, iOS 41s),
driven, not statically edited. Read what it actually asserts: send → a streaming
`assistant-bubble` → app alive. It never taps `chat-interrupt`, so a green row here
is NOT evidence that interrupt works.
Two stated blockers are dead and must not be re-quoted. (1) "No local-tts reachable
from the device" was always wrong — local-tts is dialled by the **gateway** over
loopback and the device only receives the downlink. (2) **D12 is CLOSED** (task 9e);
it is not a reason for anything to stay undriven.
The one live blocker: `chat-interrupt` is gated on TTS audio state (`isSpeaking ||
PROCESSING/ASSISTANT_SPEAKING/INTERRUPTING`) rather than cognition, so the session
needs `speak=true` plus an armed downlink before the button exists to tap.

### STT dial retry has no backoff (observation, NOT filed as a defect)
Against a hung STT, the gateway logged 33 `stt.connect-failed` in 751 ms — one
retry per mic frame. That is documented, deliberate design
(`stt-session.ts:10-19`: "no timers, no backoff constants, no new config") and it
self-heals within one frame. Recorded for the owner, not filed.

### Per-row status — PER PLATFORM, because "driven" is not a property of a row
A row driven on Android and merely *edited* on iOS is two different states, and
collapsing them into one verdict is how an unrun static edit ships looking green.
`—` means the platform was never driven for that row; it is not a pass.

| Row / flow | Android | iOS | Note |
|---|---|---|---|
| login / auth (T1) | PASS | PASS | `login-avatar-${QA_USER_ID}` → `composer-input` |
| `native-turn-happy` | **PASS** (9e) | **PASS** (9e) | D12 closed; `01-send-stream` 17s / 31s |
| `native-tool-call` | **PASS** (9f) | **PASS** (9e) | Android unblocked by D13's close: prompt → Allow → `assistant-bubble`. **No `allow`-tier tool has been exercised on either platform** — the only tool the model chose was `confirm`-tier |
| `permission-confirm` (native) | **PASS** (9f) 24s | **PASS** (9e) 30s | D13 closed — the dialog exports its own testTags; flow UNEDITED |
| `new-chat` (`03` / `verify-newchat`) | **PASS** (9e) | **PASS** (9e) | composer returns; server thread NOT reset (D15) |
| `01-newchat` (iOS only) | — | **FAIL — D15** | asserts a fresh chain 2.0 does not provide |
| `steer-followup-audio` | → Task 11 | → Task 11 | text half already PASS on web. The AUDIO half needs the downlink, which is lazy-armed on `audio.start`; the mic is hold-to-talk and Maestro's tap gives ~147 ms — the same harness blocker as `voice-roundtrip`, on the same seam |
| `reload-convergence` | **PASS** (9f) | — | Re-driven with D14 closed, so the store is no longer polluted. `projectForClient` over the live DB = 25 items; device cold relaunch logs `snapshot-legacy count=25`; gateway logs `turn-emitter.conversation-snapshot itemCount=25`. Counted, not eyeballed |
| `restart-persistence` | **PASS** (9f) | — | Real native gateway process restart (kill + `bun --hot src/main.ts`), then cold relaunch: `resume.not-recovered reason="fresh-journal-or-epoch-mismatch"` → `conversation-snapshot itemCount=25`, unchanged across the restart. `store.opened schemaVersion=1` on every open |
| `session` tag — `06-switch-session`, `07-rename-delete` | **FAIL** (9f) | — | Not a regression: **the 2.0 gateway serves no `/api/v1/sessions` route** (`grep -rn "api/v1/sessions" gateway/src` is empty; `ws-handlers.ts:212` says so). The drawer's list/rename/delete/search all dial it, so zero `history-row-*` render whatever the store holds → multi-conversation project, not Task 11 |
| `10-outbox` | **FAIL** (9f) | — | Not a regression: `message-bubble-0` is the **list index** (`MessageBubble.kt:68`), so index 0 is the oldest message. Written for an empty chat; on 2.0 one durable conversation never resets (D15), so it is permanently off-screen. Needs re-grounding onto the newest bubble → multi-conversation project |
| `voice-roundtrip` | → Task 11 | → Task 11 | fixture channel deleted + hold-vs-tap |
| `interrupt` (native) | **PASS** (9e) | **PASS** (9e) | `05-interrupt` 27s / 41s — D12 closed. Asserts send→stream→alive ONLY; the interrupt tap is still unasserted (TTS audio-state gate) |
| barge-in / acoustic | → Task 11 | → Task 11 | `physical-only`; needs real mic + speaker |
| `40-settings-root` | PASS 19s | PASS 16s | the Task 6b static edit, now proven on both |
| `56-secrets-presence` | PASS 29s | PASS 20s | |
| `41-members-add-cap` | FAIL — pre-state | FAIL — pre-state | 3-user household; cap half proven separately |
| `42-settings-non-admin-gate` | FAIL — cascade | FAIL — cascade | driven at last; dies at the Temp1 41 never made |
| `43-members-delete-cleanup` | FAIL — cascade | FAIL — cascade | |
| `44` / `44b` / `59` audio | PASS | PASS (after fix) | iOS point-tap was 4 px off; re-measured |
| `45` / `45b` model apply | PASS | PASS | 8000 ms budget verified on BOTH |
| `46-memory-cap` | PASS (after fix) | PASS 1m50s | iOS already typed 9 chunks; Android needed the 9th |
| `47-system-prompt-restore` | PASS | **FAIL** | iOS-only; dies AFTER the 8000 ms wait, at the Restore tap |
| `48` / `48b` / `49` / `49b` | PASS | PASS | 8000 ms budget verified on BOTH |
| `50-personalities` | PASS (re-grounded) | **FAIL** | iOS-only; unmeasured chevron point-tap + stale DEFECT-4 header |
| soul / personality / memory behaviour | EXPECTED-INERT (2.0) | EXPECTED-INERT (2.0) | render+persist only |
| delegated agent used a gateway tool | not asserted, by instruction | not asserted, by instruction | D11 — never assert it, never pass vacuously |

## Inbound proxy + one-command launcher (Task 14, `scripts/stack.sh`)

Nine reusable cases proving the inbound-proxy/web-serving feature composes as a
whole: nginx owns host 80/443 as the one outward door, the gateway binds
loopback only, `bun run dev` is the whole-stack launcher, and the boot order
protects the fresh-install wizard. Driven live 2026-08-04 against the real
local dev stack (LAN IP `192.168.0.197`, `en0`) — no mocks, no `docker compose
up` (the gateway's own orchestrator creates the containers). Full per-case
evidence (screenshots, curl/log transcripts): `qa/web/evidence/2026-08-04-t14-inbound-proxy-e2e/`.
Log tags: `[system-orch:docker-driver]`, `[system-orch:factory]`,
`[system-orch:orchestrator]`, `[ws:session-binding]`, `[runtime:react-loop]`.
`relaunch-refreshes-443` and `preflight-refuses-foreign-port` were re-driven
after a same-day fix (`6fc0f7ec`) to `scripts/stack.sh`'s preflight — see
those two entries for the before/after and the process-group testing gotcha
the fix's own verification surfaced.

**Correction to carry forward:** the install-state file some earlier docs and
task briefs call `~/.sentient/gateway/install-state.json` or
`~/.sentient/gateway/data/state.yaml` does not exist under either name anymore
— `gateway/src/bootstrap/phase-state.ts` resolves it to
**`~/.sentient/state.yaml`** (`SENTIENT_HOME` = `~/.sentient`, not the
`gateway/` subdirectory). Always back up and restore this exact path.

### inbound-https · inbound-http-redirect
**Scenario:** `https://localhost/` serves the real built UI through the proxy; `http://localhost/` 301s to it; the gateway never answers on 80.
**Driver:** Playwright MCP at 1280×900 and 390×844 (self-signed cert — click through the `chrome-error://chromewebdata/` interstitial's Advanced → "Proceed to localhost (unsafe)" **once per port**; the exception is remembered per-hostname for the rest of the session, so a later `https://localhost:8888/` needs no second click-through) + a plain curl for the redirect.
**Verified:** `curl -sk https://localhost/api/v1/health` → `{"status":"ok"}` / `200`; `curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' http://localhost/` → `301 https://localhost/`; Playwright network tab on `https://localhost/` shows `GET / => 200`, real `<title>Sentient</title>` HTML, hashed JS/CSS assets all 200 (not a SPA-fallback 404 in disguise); `docker logs sentient-inbound-proxy` access log carries the matching `"GET / HTTP/2.0" 200 939` / `"GET / HTTP/1.1" 301 162` lines. Screenshots: `inbound-https-1280.png`, `inbound-https-390.png`.
**Expected log trail:** zero WARN/ERROR in the gateway log attributable to either request.

### inbound-ws
**Scenario:** Log in as Ada, send a chat message through `https://localhost/` — the WS round-trips a real turn over the proxy, not a direct 8888 connection.
**Driver:** Playwright MCP, both viewports. Login: avatar "Ada" → PIN `1234` (see the credentials banner at the top of this file).
**Steps:** send `"Reply with exactly: PROXY-SMOKE-OK"` (1280×900) and, after a resize+reload, `"Reply with exactly: PROXY-SMOKE-MOBILE"` (390×844) — both come back verbatim.
**Expected log trail:** `[ws:session-binding] session-binding.attached` (the WS-open proof — the gateway is loopback-only, so this line firing at all proves the browser's socket transited the proxy) → `[runtime:react-loop] react-loop.start turnId=<uuid>` → `[ws:turn-emitter] turn-emitter.turn-completed` for the SAME `turnId`, once per send, zero WARN/ERROR in the window, no repeated `session-binding.attached` for the same connection (would indicate a reconnect loop).
**Gotcha:** nginx's access log line for `/api/v1/ws` only appears **after the socket closes** (`proxy_buffering off` doesn't change when the access log itself is written) — a browser tab left open for the rest of the session will never show a `GET /api/v1/ws` line while it's live. Don't read an absent access-log line as a failed upgrade; a short-lived client (the mobile Ktor WS in the `mobile-connects-443` case below) closes between flows and DOES show `"GET /api/v1/ws HTTP/1.1" 101 <bytes>"` promptly — use that shape as the positive control instead.

### webui-served-natively (bonus row — proves Task 1, not in the required 9)
**Scenario:** `https://localhost:8888/` (bypassing the proxy entirely) still serves the real UI — proves `webDistDir` resolves independent of the proxy.
**Verified:** title "Sentient", static assets 200; one **expected** `401` on `/api/v1/auth/me` (this origin has no session token — a diagnostic 401, not a server error). Screenshot: `webui-served-natively-8888.png`.

### gateway-not-lan-reachable
**Scenario:** The security claim itself — the gateway's `8888` is unreachable from another host on the LAN; the door's `443` is not.
**Steps:** `LAN_IP="$(ipconfig getifaddr en0)"`; `curl -sk --max-time 3 https://$LAN_IP:8888/api/v1/health`; `curl -sk --max-time 3 https://$LAN_IP/api/v1/health`.
**Verified 2026-08-04** (`LAN_IP=192.168.0.197`): the 8888 probe returns curl exit `7` ("Failed to connect" — connection refused, not a timeout) inside the 3 s budget; the 443 probe returns `{"status":"ok"}` / `200`. `gateway/config.yaml#host: 127.0.0.1` is the enforcing line.
**Why the exit code matters:** exit `7` (refused) is the fast, deterministic signal of "nothing is listening there for this interface" — an exit `28` (timeout) would instead suggest a firewall drop and is a different failure shape; don't conflate them if this case ever goes red.

### proxy-survives-save
**Scenario:** Task 5's skip proving itself live — a `bun --watch` gateway-process restart (source edit, NOT a full `bun run stack:down && bun run dev` cycle) must NOT recreate the already-running `inbound-proxy` container.
**Steps:** record `docker inspect -f '{{.Id}}' sentient-inbound-proxy`; edit a gateway source file; wait for the restart; re-check the container id and `https://localhost/`; `grep -c 'driver.recreate-skipped' ~/.sentient/gateway/logs/$(date +%F).log`.
**Verified:** container id byte-for-byte unchanged (`220d3c37…`) across the restart; door still `200`; log carries `[system-orch:docker-driver] driver.recreate-skipped | service="inbound-proxy" reason="infra-unchanged-and-running"`.
**Gotcha (cost real time) — `touch` alone did not trigger the restart.** A bare `touch gateway/src/main.ts` (mtime-only, no content change) produced NO restart after 45 s of waiting — `bun --watch`'s watcher did not fire. Appending a real byte (`echo "" >> gateway/src/main.ts`, then reverted) triggered the restart within ~4 s, immediately followed by the `recreate-skipped` line. Always make a real content edit for this case, never a bare `touch`, or you'll misdiagnose a live gateway as hung.

### fresh-install-wizard
**Scenario:** On a fresh/reset install (`bootstrap_complete: false`), the boot sequence brings up `inbound-proxy` alone — the wizard's own route to the outside world — BEFORE any capability addon (HA/MA/searxng/fetch/whisper-stt/local-tts) is ever applied.
**Steps:** stop the stack; back up `~/.sentient/state.yaml`; flip `bootstrap_complete: true` → `false` (leave `wizard_cursor` alone — it renders whatever step the cursor already names, "finish" in our run showed "All set", which still counts as "the wizard is reachable"); remove every `sentient.managed=true` container; `bun run dev`; restore the backup afterward and cycle the stack once more so the gateway re-reads it (install-state is cached in-process, so a restore on disk alone does not take effect until the next boot).
**Expected log trail, in this exact order:** `[sentient] bootstrap-mode` → `[system-orch:factory] boot-reconcile.infra-only | services=inbound-proxy` → `[system-orch:orchestrator] apply.start | targets=inbound-proxy mode="subset"` → `apply.complete | state="ready" ready=1 degraded=0 failed=0 blocked=0` — the `ready=1` is the assertion: exactly one service (inbound-proxy), never more, applied before `gateway-started`/wizard reachability.
**Verified 2026-08-04:** exact sequence above at `17:31:50.539–17:31:51.220`; `https://localhost/` served the wizard (`WizardShell`, "All set" step) within the same second. Screenshot: `fresh-install-wizard.png`.
**Expected, not a defect:** `[system-orch:health-watch] service.unhealthy | service="egress-proxy"` fires ~15 s later — egress-proxy was removed by the test setup and correctly stays down until the wizard/bootstrap path applies the full service set; this is the intended fresh-install shape, not a fault.

### stack-up-from-cold
**Scenario:** `bun run stack:down` + remove every managed container + `bun run dev` reaches `✓ ready` printing all three URLs, from nothing.
**Verified 2026-08-04:** ready in **~7 s** wall-clock (images already baked from a prior run — `preflight_images` only pays a real `docker compose build` cost the first time an image tag is missing; that is a separate, much longer one-time cost, not part of this case's steady-state number). All 8 `sentient.managed=true` containers `Up`; `https://localhost/`, `https://localhost:8888/api/v1/health`, `http://localhost:5173/` all `200`.
**Re-verified 2026-08-04 after `6fc0f7ec`** (the `preflight_ports` rewrite below): ready in **~9 s** from a fully-removed-container state, all 8 containers up, all three probes 200. The empty-`RECLAIM_TARGETS[@]`-under-bash-3.2 guard the fix added did not throw on this, the most common path (nothing to reclaim on a genuine cold start) — confirming the fix's own regression note.

### preflight-refuses-foreign-port
**Scenario:** A real, unrelated process squatting on `8888` makes `bun run dev` refuse cleanly — name the pid + holder, exit non-zero, leave the foreign process untouched — rather than silently taking over or killing something it doesn't own.
**Steps:** `python3 -m http.server 8888 &`; `bun run dev`; check its exit code; confirm the python pid is still alive; kill it yourself.
**Verified 2026-08-04:** `✗ port 8888 (gateway) is held by a process we did not start: pid 81855 (…/Python.app/Contents/MacOS/Python)` with the exact `lsof` fix command printed; `bun run dev` exited `1`; the python pid was still running afterward (killed by the test, not by the script).
**Re-verified 2026-08-04 after `6fc0f7ec`:** same shape, new hint text — the fix message now points at all four ports in one line (`lsof -nP -iTCP:80,443,8888,5173 -sTCP:LISTEN`) instead of just the one that failed, since `preflight_ports` now examines all four before deciding. `pid 38776 (…/Python.app/…)` on `8888`, exit `1`, foreign pid still alive after.
**Stronger regression case added post-fix — "decide before mutate," not just "refuse foreign."** The bug this whole case family exists to catch was never really about a *bare* foreign port (that always worked) — it was about a foreign port discovered *after* an earlier port had already been proven "ours" and killed. Reproduced the exact shape: brought up a real stack, killed **only** vite out-of-band (gateway legitimately still "ours" and running), planted a foreign `python3 -m http.server` on `5173` (vite's port), then ran `bun run dev` again. **Before `6fc0f7ec`** this ordering would have already killed the gateway (examined and reclaimed before vite) by the time vite's foreign holder was discovered. **After the fix:** refused citing only `port 5173`, and the gateway — provably "ours," definitely reclaimable — was left **completely untouched**: same pid, `https://localhost:8888` still 200, `https://localhost/` still 200, proxy container id unchanged, the foreign process on 5173 unharmed. This is the assertion that actually matters for this fix; a bare single-foreign-port test alone would have passed even on the old, buggy code (there was nothing else running yet to torn-half-kill).

### relaunch-refreshes-443
**Scenario:** `:5173` (vite) reflects a webui source edit immediately; `:443` (gateway-served `dist/`) only after a relaunch, because `build_webui()` runs unconditionally on every `bun run dev` start.
**Steps:** edit a visible string (composer placeholder); confirm `:5173` shows it via a fresh navigation + login (5173 and 443 are separate origins — no shared localStorage/session, log in on each independently); confirm `:443` still shows the OLD string; relaunch **in a genuinely separate session** (see the gotcha below); confirm `:443` now shows the new string; confirm `· building the web UI (this is what :443 serves)` is printed on every successful start.
**FIXED in `6fc0f7ec` — verified live 2026-08-04, both original repro steps AND the brief's literal "just run `bun run dev` again" path now succeed.** Two separate `bun run dev` invocations (session A pgid `34586`, session B pgid `36248` — confirmed distinct via `ps -o pgid=` before running session B; see the gotcha below for why this check matters): session B's log read `stopping our previous gateway (pid 34704) on 8888` → `stopping our previous vite (pid 34707) on 5173` → `stopping our previous vite (pid 34705) on 5173` (**both** the actual grandchild listener AND the recorded supervisor pid get their own kill now — see `RECLAIM_TARGETS` in the fix) → `· building the web UI` → `✓ ready`. Session A's whole tree (`34590/34704/34705/34707`) was confirmed gone afterward; `https://localhost/`'s placeholder read the new marker (`"Message Sentient [T14-REFIX-MARKER]"`); `docker inspect -f '{{.Id}}' sentient-inbound-proxy` was **byte-for-byte unchanged** across the relaunch, with `driver.recreate-skipped | service="inbound-proxy" reason="infra-unchanged-and-running"` in the log — the door survived a real, successful relaunch, not just a `bun --watch` in-place restart.
**Original defect (now closed) — kept for context.** Root cause was `scripts/stack.sh#preflight_port`'s (pre-fix name) exact-pid-match ownership check: `bun run --filter './gateway/webui' dev` interposes a supervisor between the recorded pid and the actual grandchild `node .../vite` listener, so the two could never match. The pre-fix code also mutated (killed the gateway) BEFORE reaching vite's unprovable ownership, so a refusal there left the stack half-torn — gateway dead, door 502, vite orphaned — worse than either success or a clean refusal. `6fc0f7ec` fixes both halves: `is_descendant_of()` walks the PPID chain (capped at `ANCESTRY_MAX_DEPTH=32`, unproven = FOREIGN, never widened to a command-name match) to recognize the grandchild as ours, and `preflight_ports()` now examines **all four ports fully before acting on any of them** — see the stronger regression case filed under `preflight-refuses-foreign-port` above, which specifically proves the "already-mutated-then-refused" failure mode is gone, not just that the vite pid match works.
**Gotcha for testing this case (or anything relying on `preflight_ports`'s ownership proof): the two `bun run dev` invocations MUST be in genuinely separate process groups, not just separate-looking shell calls.** A non-interactive bash script (no `set -m`) does not allocate a new process group per background job, so if both invocations end up sharing one pgid (e.g., both launched from the same interactive shell session without an intervening `setsid`/new-terminal boundary), `cmd_up`'s own `trap 'kill 0' EXIT` (kill the caller's *own* process group on exit) can cross-kill the OTHER invocation's processes — producing a failure that looks like a `stack.sh` bug but is actually a test-harness artifact. Verify separation before trusting a relaunch result: `ps -o pid,pgid,ppid,command -p <known pids from session A>` immediately before starting session B, and confirm session B's own `$$`/pgid differs. This is exactly how one verification attempt against this fix was initially flawed.
**Older gotcha, still true:** a bare `touch gateway/src/main.ts` (mtime-only, no content change) did not trigger `bun --watch`'s restart even after 45s; appending real content did, within ~4s. Make a real content edit for `proxy-survives-save`, never a bare `touch`.

### mobile-connects-443 (bonus row — Android only, not in the required 9)
**Scenario:** a native mobile client also connects through 443, never 8888.
**Android: GREEN, live-driven 2026-08-04.** The prebuilt debug APK predates this feature (`android/build/outputs/apk/debug/android-debug.apk`, Jul 30, still baked with the old `wss://10.0.2.2:8888/...` default), so a fresh `:android:assembleDebug` was built after seeding `local.properties` with `sentient.gatewayUrl=wss://10.0.2.2:443/api/v1/ws` (gitignored, removed after the test — see `android/build.gradle.kts:32-40` for the precedence: runtime override → this build-time default → unconfigured). `emulator-5554` (Pixel_3a_API_34). `qa/mobile/run-e2e.sh android --tags chat` → `01-chat-send` and `01-send-stream` **PASS** (real login + message round-trip); `qa/mobile/run-e2e.sh android --tags reconnect,settings-voice` (the brief's literal tag set) selected **zero** `reconnect` flows — every `reconnect`-tagged flow (`04`, `04b`, `04c` pair) is ALSO tagged `physical-only` or `fault-armed`, both permanently excluded from a targeted `--tags` batch by design (`BASE_EXCLUDE`); use `--tags chat` for the round-trip proof instead, or the full default batch (no `--tags`) to reach 04c's fault-armed phase. Evidence: `adb logcat` shows `wss://10.0.2.2:443/api/v1/ws` on every `transport.ws.android open`/`connected` line and **zero** occurrences of `8888` anywhere in the session; `docker logs sentient-inbound-proxy` shows `"GET /api/v1/ws HTTP/1.1" 101 <bytes>"` and `"GET /api/v1/auth/me|voices|services/versions HTTP/2.0" 200 …"`, all `"ktor-client"`; gateway log shows matching `session-binding.attached` → `react-loop.start` → `turn-emitter.turn-completed` triples.
**iOS: DEFERRED.** No booted simulator at task start; the only iOS build artifact on disk (`ios/build/Debug-iphonesimulator/SentientApp.app`) is an empty directory (0 bytes of content) predating this feature. Producing a current one needs the KMP XCFramework build (`scripts/ios-setup.sh`) plus an Xcode simulator build — a substantially heavier side-build than Android's `gradlew assembleDebug`, out of proportion to a verification task; not attempted. Record as deferred, not green, per the e2e rule.
