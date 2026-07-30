<!-- last-distilled: 2026-04-27 branch: develop -->
# Testing Knowledge

Reusable smoke-case catalog referenced by `.claude/rules/e2e-testing.md`
and `agents/docs/e2e-testing-details.md`. Cases here are the source of
truth across features; per-spec smoke matrices reference them instead
of duplicating.

Each `### Case` entry has a scenario, a "why added" reason, callable
steps, and the expected user-visible + log-trail outcome. New reusable
cases are appended here, indexed by the surface they exercise.

> **Native-stack migration banner (2026-07-29):** every method and case
> below was authored against a **containerized gateway** (`docker compose
> ... gateway`
> bring-up/restart) and the **retired cerebrum/cycle wire** (`cycleId`,
> ACP-router framing). Neither reflects current reality — the gateway is a
> native binary under `launchd`/`bun --hot`, addons are docker-only, and the
> wire is 2.0's `turnId` / `turn.*` frames. Do not hand-fix each case's
> commands piecemeal; the native-stack migration plan's Tasks 9/10
> re-ground every case that survives against the current stack and wire as
> part of executing the 2.0 E2E matrix. Until then, treat the *scenario* and
> *why added* fields as still valid and the literal bring-up/restart
> commands and `cycleId` references as historical.

## Methods

Tools and techniques this project uses to verify changes on each surface,
and why those tools were chosen. One `###` subsection per surface.

### Browser Smoke Verification
**Tool:** Local Chrome against a freshly built `sentient-gateway` container.
**When:** After any cerebrum / SDK / webui change that could affect cycle lifecycle, audio playback, presence, or task visibility — before merging or shipping.
**Why this tool:** WebRTC AEC, AudioWorklet timing, jitter-buffer behaviour, and cycle-audio-queue state can only be exercised end-to-end in a real browser. Mocked playback misses these failure modes; they show up only as user-visible regressions.
**How:**
1. `source scripts/env.sh`
2. `docker compose -f deploy/macos/docker-compose.yml build gateway && docker compose -f deploy/macos/docker-compose.yml up -d gateway`
3. `until curl -sk -o /dev/null -w "%{http_code}" https://localhost:8888/ | grep -q 200; do sleep 1; done`
4. Open `https://localhost:8888` in Chrome. Self-signed cert → click Advanced → Proceed.

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

### Distinct cycleId per turn + many-entry turn renders distinctly (web)
**Scenario:** The gateway mints a server-unique `cycleId = String(Date.now())` per turn (one POSIX-ms id, never resetting on reconnect). Multiple turns each render under their own message; a single multi-tool turn renders every entry (intermediate narration + each tool pill + final answer) as its own row under ONE cycleId.
**Why added:** Regression guard for the cycleId render-key fix (2026-06-14). The old `cycle-${counter}` reset to `cycle-1` on every `session.configure` (reconnect), aliasing turns onto one render row → "follow-up reply missing / previous shown" + stale-bottom-on-scroll. cycleId is cycle-meta only; committed history is keyed by `entryId`.
**Steps:**
1. Two turns, no reconnect (desktop 1280×900): send msg 1 → await reply; send msg 2 → await reply.
2. Many-entry turn (desktop + mobile 390×844): send a multi-tool prompt (e.g. "search the web for X and summarize").
**Expected user-visible:** both single-turn replies render under their own messages (no alias); every entry of the multi-tool turn renders as its own row (tool pill + answer), no rows collapse; streaming bubble grows in place then commits with no duplicate.
**Expected log trail (gateway `~/.sentient/gateway/logs/YYYY-MM-DD.log`, local-date rotation):** each turn emits a DISTINCT numeric `[cerebrum:attention-gate] cycle dispatched | cycleId="<ms>"`; NO `cycleId="cycle-N"`. (The small-integer `[hermes-adapter-client:acp:per-profile-connection] cycle.start cycleId="N"` is Hermes' ACP-internal counter — a different namespace, ignore it.) Before/after proof: pre-fix turns logged `cycle-N`, post-fix turns log ms strings.

### Speaking state tracks audio drain, not cycle end
**Scenario:** When the assistant returns a long spoken reply, the speaking indicator must remain lit through the final word of audio, not drop on `cycle.done`.
**Why added:** Regression guard for the `onDrain` path — the speaking state needs to follow the playback adapter's drain signal, not the gateway-side `cycle.done` event (which fires before audio finishes playing).
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
**Why added:** There's a ~1–2 s gap between `cycle.done` (server-side) and `onAudioStart` (first TTS frame at the client). Without the AwaitingTracker FSM, the button flickers off in that gap.
**Steps:**
1. Click Send on any prompt.
2. Watch the Interrupt button continuously from click through end of TTS playback.
**Expected:** Button appears within one frame, stays visible the entire time, drops only on `onPlaybackEnded`. If it flickers off between `cycle.done` and `onAudioStart`, the AwaitingTracker FSM isn't wired correctly. (See `agents/docs/gateway/webui/awaiting-tracker-fsm-details.md`.)

### Cycle serialization (queued message does not overlap current TTS)
**Scenario:** Two cycles' TTS streams must never play simultaneously. The first drains, then the second starts; or, if elapsed > `min_eager_end_ms`, the second preempts with a ~30 ms fade.
**Why added:** Regression guard for the `CycleAudioQueue` preempt logic. A bug here causes overlapping speech, which is unintelligible and cannot be recovered from without a full reload.
**Steps:**
1. Send "what's the weather"; wait for audio to start.
2. While audio is playing, send "and turn off the kitchen light".
**Expected:** First cycle's audio drains naturally OR (if elapsed exceeds `min_eager_end_ms`) the second cycle preempts with a brief fade. No overlap.

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

## System orchestrator (Phase 6 setup wizard)

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
2. Bring up the stack: `cd deploy/macos && docker compose up -d`
3. Read the unlock code: `cat ~/.sentient/gateway/data/unlock-code` (or read from gateway log banner).
4. Open `https://localhost:8888`, enter the unlock code.
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

## Mobile (Android emulator + iOS simulator via Maestro)

**Tool:** Maestro CLI against a running Android emulator (`avd`) or iOS simulator (`xcrun simctl`), driven through the committed flow library at `qa/mobile/flows/{android,ios}/*.yaml` (97 flows, refactored 2026-07-17, commit `204f728`) via `qa/mobile/run-e2e.sh`. The old "write to `/tmp/<flow>.yaml` at run time, never commit" convention is retired for this library — flows here ARE the committed artifact. Evidence screenshots → `qa/mobile/screens/` (gitignored).
**When:** After any change to `android/`, `ios/`, or `shared/mobile-sdk/` that touches auth, chat UI, WS transport, or Settings — before merging.
**How:** `./qa/mobile/run-e2e.sh android --tags <t1,t2>` for a targeted change; `./qa/mobile/run-e2e.sh all` for a full pre-merge pass. See "Runner usage" below.
**testTags used:** `login-avatar-<userId>`, `pin-key-<n>`, `composer-input`, `chat-send`, `assistant-bubble`, `message-bubble-<index>`, `chat-message-list`, `login-error`, plus per-screen `settings-cat-*` / `settings-*` ids (see individual flow files).

### Tag taxonomy

Every flow's YAML frontmatter carries `tags:` from two orthogonal families. The runner's default batch always excludes `fault-armed`, `physical-only`, `helper`; `--no-slow` additionally drops `slow`.

- **Surface** (what's exercised — matches `--tags` selection): `auth chat session reconnect outbox voice-loop settings-root settings-soul settings-user settings-admin settings-voice settings-diagnostics update logout`.
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
