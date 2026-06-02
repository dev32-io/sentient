<!-- last-distilled: 2026-04-27 branch: develop -->
# Testing Knowledge

Reusable smoke-case catalog referenced by `.claude/rules/e2e-testing.md`
and `agents/docs/e2e-testing-details.md`. Cases here are the source of
truth across features; per-spec smoke matrices reference them instead
of duplicating.

Each `### Case` entry has a scenario, a "why added" reason, callable
steps, and the expected user-visible + log-trail outcome. New reusable
cases are appended here, indexed by the surface they exercise.

## Methods

Tools and techniques this project uses to verify changes on each surface,
and why those tools were chosen. One `###` subsection per surface.

### Browser Smoke Verification
**Tool:** Local Chrome against a freshly built `sentient-gateway` container.
**When:** After any cerebrum / SDK / webui change that could affect cycle lifecycle, audio playback, presence, or task visibility — before merging or shipping.
**Why this tool:** WebRTC AEC, AudioWorklet timing, jitter-buffer behaviour, and cycle-audio-queue state can only be exercised end-to-end in a real browser. Mocked playback misses these failure modes; they show up only as user-visible regressions.
**How:**
1. `source scripts/env.sh`
2. `docker compose -f deploy/docker/docker-compose.yml build gateway && docker compose up -d gateway`
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
4. Walk: unlock → provider (LLM key) → voice (Fish key) → secrets (HA URL+tokens, MA URL+token; or skip).
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
2. Bring up the stack: `cd deploy/docker && docker compose up -d`
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

**Tool:** Maestro CLI against a running Android emulator (`avd`) or iOS simulator (`xcrun simctl`).
**When:** After any change to `android/`, `ios/`, or `shared/mobile-sdk/` that touches auth, chat UI, or WS transport — before merging.
**How:** Write the Maestro YAML to `/tmp/<flow>.yaml` at run time (never commit it). Execute with `maestro test /tmp/<flow>.yaml`. Evidence screenshots → `qa/mobile/screens/` (gitignored).
**testTags used:** `login-avatar-<userId>`, `pin-key-<n>`, `chat-screen`, `chat-input`, `chat-send`, `message-bubble-<index>`, `chat-message-list`, `login-error`.

### T1 — Mobile login happy path
**Scenario:** Avatar tap + correct 4-digit PIN lands the user on the chat screen.
**Why added:** D-A2 phase gate; regression guard for `AuthViewModel` → `SdkStore` → `SentientSdk.login()` path on both platforms.
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
1. Pre-state: logged in, `SdkState = READY` (complete T1 first, or launch into a pre-authenticated session).
2. `tapOn id: chat-input` → `inputText: "hello"` → `tapOn id: chat-send`.
3. `hideKeyboard` (soft keyboard obscures list on Android).
4. `assertVisible id: message-bubble-0` (user bubble commits immediately).
5. `extendedWaitUntil id: message-bubble-1, timeout: 40000` (LLM round-trip via Hermes, ~40 s budget).
6. `assertVisible id: chat-message-list`.
**Expected user-visible:** User bubble at index 0; assistant bubble at index 1 with non-empty text. **Expected log trail:** `text.input` frame out on transport; `conversation.entry` event received and rendered.
**Platform notes:** Maestro YAML written to `/tmp/send-receive-android.yaml` (appId `io.sentient.android`) and `/tmp/send-receive-ios.yaml` (appId `io.sentient.ios`) at run time. Same step body; only `appId` differs. iOS simulator does not require `hideKeyboard` between send and assert.

### T6 — Mobile settings logout (version + clear-token + disconnect → login)
**Scenario:** From chat, open Settings, confirm the app-version string, tap Log out, and land back on the login screen — proving the token was cleared + the WS disconnected. Relaunch (without clearing app data) and confirm login again, proving the clear was persistent.
**Why added:** D-A5 phase gate. Logout is the inverse of login (`tokenStore.save → sdk.connect`); logout = `sdk.disconnect()` then `tokenStore.clear()`. Regression guard: a future change that disconnects but forgets to clear the token would silently auto-resume on relaunch — only the relaunch leg catches it.
**testTags used:** `settings-open` (chat top bar gear), `settings-screen`, `settings-version`, `settings-logout`, `settings-back`, plus `login-avatar-<userId>` for the return assertion.
**Steps:**
1. Pre-state: logged in, `SdkState = READY`, chat showing (complete T1 first).
2. `tapOn id: settings-open` → `assertVisible id: settings-screen`.
3. `assertVisible id: settings-version` AND assert its text is a non-empty version string (`<name> (<code>)`, e.g. `0.0.1 (1)`).
4. `tapOn id: settings-logout`.
5. `assertVisible id: login-avatar-<userId>` (avatar grid OR PIN pad — both are the login screen; see platform note) AND `assertNotVisible id: chat-input`.
6. Relaunch: `am force-stop` then `am start` (NEVER `pm clear` — that clears the token artificially and voids the proof). `assertVisible id: login-avatar-<userId>`; gateway shows NO new `attach` / `session.ready` (no auto-resume).
**Expected user-visible:** Settings shows version + Log out; after logout the login screen returns; relaunch returns to login. **Expected log trail (gateway):** on logout — `[ws] client-disconnected`, `[ws] session-cleanup`, `[hermes-adapter-client:wire-bootstrap] ws.close code=1000`, `[person-session] detach attachmentCount=0`, `[gateway:session-router] release remainingBindings=0`; on relaunch — silence (no attach).
**Platform notes:** Drive method on this stack was the **`android` CLI + adb** (Maestro not installed): `android layout --device=<serial> --pretty` yields each element's `center` coord → `adb shell input tap <x> <y>`; assertions are `android layout | grep <resource-id>`; screenshots via `adb exec-out screencap -p`. Same flow body for iOS via `xcrun simctl` + `.accessibilityIdentifier`. **Logout return state:** after logout *within the same process* the login screen re-renders in the PIN phase (Android `AuthViewModel` retains `selectedUser`), so step 5's `login-avatar` assertion may need a preceding `settings-back`-style back tap OR is satisfied by the PIN pad (`pin-key-1`); the avatar grid reliably reappears on the *relaunch* leg (fresh ViewModel ⇒ PICK_USER). Gateway logs on the macOS deploy write to `~/.sentient/gateway/logs/YYYY-MM-DD.log` (UTC), NOT `docker logs` stdout.
