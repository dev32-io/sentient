### Task 12: Native mobile E2E (spec §10.1, build-order slice 9)

**Spec:** §10.1 (E2E matrix + acceptance list), §7.2 (client audio queueing — never cut the gateway's own audio), §5.4 (`delegateTask` background lifecycle), §7.1 (permission-prompt UI contract), §4.5 (turn serialization + steer + back-to-back follow-up).
**Depends on:** Task 1 (frozen wire contract + `TurnEmitter` log tags), Task 2 (voice pipeline log tags), Task 5 (KMP-SDK rebase — `cycleId → turnId`, `task.update → turn.tool.update` — NOT yet authored at the time this task body was written; flagged inline wherever this task relies on a Task-5 symbol that isn't frozen), Task 6 (permission wire + PDP fail-closed + `mcp-policy.yaml`'s `confirm_ha_service_call` rule), Task 8 (Android permission dialog UI — not yet authored; this task assumes it mirrors Task 9's iOS ids, flagged below), Task 9 (iOS permission dialog UI, already authored — `permission-allow` / `permission-deny` accessibility identifiers).
**Wave:** 5, alongside Task 11 (web E2E). **Runs serialized, never concurrently with Task 11** — see PARALLELISM CONSTRAINT below.

Driver is **Maestro only** — never Playwright for native mobile (`.claude/rules/e2e-testing.md`). Runner: `./qa/mobile/run-e2e.sh [android|ios|all] [--tags T1,T2] [--no-slow] [--fault-only|--no-fault] [--fresh-gateway|--no-fresh-gateway] [--no-anim-restore]`.

---

#### PARALLELISM CONSTRAINT (state this, don't relearn it mid-task)

Maestro drives one flow at a time per device (`emulator-5554` / the booted iOS sim), and one local gateway owns `:8888`. Native E2E (this task) and web E2E (Task 11, Playwright MCP) both point at the SAME local `deploy/macos/` stack and both restart/inspect that one gateway during their fault-armed phases. **Never run this task's batches concurrently with Task 11's** — serialize them (finish one, then the other) even though the two tasks touch disjoint files and could otherwise be executed in parallel.

---

#### Files

**Create**
- `qa/mobile/flows/android/70-tool-call.yaml`, `qa/mobile/flows/ios/70-tool-call.yaml`
- `qa/mobile/flows/android/71-permission-confirm-deny.yaml`, `qa/mobile/flows/ios/71-permission-confirm-deny.yaml`
- `qa/mobile/flows/android/72-permission-confirm-approve.yaml`, `qa/mobile/flows/android/72b-permission-confirm-approve-restore.yaml`
- `qa/mobile/flows/ios/72-permission-confirm-approve.yaml`, `qa/mobile/flows/ios/72b-permission-confirm-approve-restore.yaml`
- `qa/mobile/flows/android/73-steer-followup-audio.yaml`, `qa/mobile/flows/ios/73-steer-followup-audio.yaml`
- `qa/mobile/flows/android/74-reload-convergence.yaml`, `qa/mobile/flows/ios/74-reload-convergence.yaml`
- `qa/mobile/flows/android/75-voice-roundtrip.yaml` (Android only — see the iOS gap note in Step 21)
- `qa/mobile/flows/android/76-restart-persistence-part1.yaml`, `qa/mobile/flows/android/76b-restart-persistence-part2.yaml`
- `qa/mobile/flows/ios/76-restart-persistence-part1.yaml`, `qa/mobile/flows/ios/76b-restart-persistence-part2.yaml`
- `qa/mobile/fixtures/two-plus-two.pcm` (real speech fixture, generated in Step 22 — not hand-recorded)

**Modify**
- `qa/mobile/flows/android/01-send-stream.yaml`, `qa/mobile/flows/ios/01-send-stream.yaml` (native-turn-happy re-ground)
- `qa/mobile/flows/android/verify-newchat.yaml`, `qa/mobile/flows/android/04c-reconnect-continue-login-send.yaml`, `qa/mobile/flows/android/04c-reconnect-continue-followup.yaml`, `qa/mobile/flows/ios/04c-reconnect-continue-login-send.yaml`, `qa/mobile/flows/ios/04c-reconnect-continue-followup.yaml`, `qa/mobile/flows/android/18-auth-expired.yaml` (stale "Hermes" / "cerebrum" wording — comment-only)
- `qa/mobile/flows/android/05-interrupt.yaml`, `qa/mobile/flows/ios/05-interrupt.yaml` (resolve the interrupt gap — real tap, not just send→stream)
- `qa/mobile/run-e2e.sh` (`CANONICAL_ORDER`, `push_and_arm_fixture` generalized, new `check_native_services`, fault-phase orchestration for 75/76/76b, `android_log_trail` pattern broadened for the wire rename)
- `qa/mobile/fixtures/README.md` (fix "Hermes replies" wording; document the synth-fixture recipe actually used)
- `agents/docs/testing-knowledge.md` (T8's stale `cerebrum`/cycleId log-trail line; T3/T8's "Hermes round-trip" wording; new T11–T16 case entries for the rows this task adds)
- `docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md` (§10.1 matrix — add the missing native permission-confirm row; see Step 3)

**Test:** none (E2E flows ARE the test artifact; no unit tests in this task per the testing-bar rule — Maestro `.yaml` flows are not unit-test files).

---

#### Interfaces

**Consumes — verified against the actual tree / already-authored task bodies before writing a single flow.**

Grounded testTag / accessibilityIdentifier ids (identical strings on both platforms, confirmed by `grep` against `android/src/main/kotlin` and `ios/App`):
```
composer-input, chat-send, chat-mic, chat-interrupt, chat-tts-toggle, new-chat,
history-open, history-new-chat, history-search, history-row-<sessionId>,
message-bubble-<index>, assistant-bubble, chat-message-list,
login-avatar-u_8c866990, pin-key-1..4, login-backend-setup ("Who's here?" on iOS),
connection-lost-banner, connection-reconnect
```
`ToolPillStrip` (`android/src/main/kotlin/io/sentient/android/chat/tool/ToolPillStrip.kt`, `ios/App/Chat/tool/ToolPillStrip.swift`) renders one `Text(formatToolName(toolName))` pill per tool call with **no testTag/accessibilityIdentifier** — Maestro must text-match it (`{ text: ".*<toolName>.*" }`), not id-match. `formatToolName` (`shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/util/ToolNameFormatter.kt`) only strips an `(mcp|assistant)_<route>_` prefix; a bare MCP tool name like `search_web` or `ha_call_service` passes through unchanged, so a substring regex is safe either way.

Task 9 (`ios/App/Chat/banner/ChatPermissionAlert.swift`, already authored) fixes the permission-dialog ids as `.accessibilityIdentifier("permission-allow")` / `"permission-deny"` on a native SwiftUI `.alert`, message text `"\(formatToolName(toolName))\n\n\(description)"`. **Task 8 (Android) does not exist yet at the time this task was written.** Per this codebase's established convention (T1's own testing-knowledge.md note: "Same testTag IDs on both Android and iOS") and Task 9's explicit callout ("Task 8 must land the same two properties"), this task assumes Android's `AlertDialog` uses the identical ids `permission-allow` / `permission-deny`. **If Task 8 lands different ids, Step 8/9/10's flows need a one-line id update before they'll pass — flag this in your task's own handover, don't silently rename.**

Gateway log tags (file logs at `~/.sentient/gateway/logs/YYYY-MM-DD.log`, format `TIMESTAMP LEVEL [category] message | key="value"`, UTC — NOT `docker logs` stdout, per `deploy/macos/docker-compose.yml`'s bind mount), all grep-verified against already-written source or already-authored task bodies:
```
session-configured                          sessionId= userId= hasRuntime=          (gateway/src/session-handlers/ws-session-configure.ts, exists today)
session-runtime.turn.start                  userId= sessionId= turnId= trigger=      (Task 1)
session-runtime.turn.next-turn-trigger      previousTurnId= nextTurnId= trigger=     (Task 1 — the back-to-back follow-up firing)
session-runtime.turn.end                                                             (gateway/src/runtime/session-runtime.ts, exists today)
turn-emitter.turn-started / .turn-completed / .tool-update / .turn-aborted
turn-emitter.permission-request / .permission-resolved / .delegation-progress        (Task 1)
turn-voice.audio.start / .audio.done                                                 (Task 2 — TTS fork, proves no Hermes in the audio path)
stt.transcript.submit                       turnIdx= length=                         (Task 2 — STT→store)
tool-broker.pdp.decision                    action=allow|deny|confirm                (gateway/src/tools/tool-broker.ts, exists today)
tool-broker.dispatch.foreground.done / .dispatch.background.started / .completed     (exists today)
tool-broker.pdp.confirm-resolved            confirmed=                               (Task 6)
tool-broker.dispatch.denied                 reason="confirmation declined: …"        (Task 6)
permission-broker.request / .settled        reason=allowed|denied|timeout            (Task 6)
cancellation.abort                          cutoff=interrupt|barge-in                (gateway/src/runtime/cancellation.ts, exists today)
cancellation.background.cancel-all                                                   (exists today)
delegation-guard.evaluate                   tier=low|medium|high                     (gateway/src/tools/delegation-guard.ts, exists today)
```
`gateway/mcp-policy.yaml`'s `confirm_ha_service_call` rule (Task 6) is the ONE confirm-classified tool: `tool: ha_call_service`, `reason: "Calling a Home Assistant service changes device state"`. `gateway/config.yaml#mcp_catalog.home_assistant.tools.include` includes `ha_call_service` (write) and `ha_get_state`/`ha_search_entities`/etc. (reads, no rule → allow). `gateway/config.yaml#mcp_catalog.searxng.tools.include` includes `search_web` (free, no side effects, no confirm — used for the plain foreground-tool row so it doesn't share HA as a dependency with the permission rows).

Local native services on THIS dev machine, already running (verified live at authoring time — `launchctl list | grep sentient` showed both as loaded launchd agents, `lsof -iTCP:8768/8770 -sTCP:LISTEN` confirmed both bound):
```
io.dev32.sentient.whisper-stt   ws://host.docker.internal:8768   (~/.sentient/gateway/config/config.yaml#stt.url)
io.dev32.sentient.local-tts     ws://host.docker.internal:8770   (~/.sentient/gateway/config/config.yaml#tts.url)
```
This directly contradicts 05-interrupt.yaml's existing comment ("no reachable local-tts service") — see Step 6.

`run-e2e.sh` (existing, verified read in full): `push_and_arm_fixture()` (currently hardcodes `silence-500ms.pcm`), `arm_fault()`, `grep_logcat_for()`, `CANONICAL_ORDER` array, `fault_phase_android()` / `fault_phase_ios()`, `check_gateway()`, `gw_stop()`/`gw_start()`/`gw_restart()`, `android_log_trail()` (currently greps logcat for `"MessageDelta|message\.delta"` — a pre-2.0 wire-frame name).

**Produces — nothing downstream depends on this task; it is the terminal Wave-5 task.**

---

#### A documented spec gap (flag + correct, per the task brief)

The design spec's own §10.1 matrix has a `permission-confirm-web` row naming ONLY web viewports (`desktop 1280×900 + mobile 390×844` — both are Playwright-resized-browser viewports per the spec's own §10.1 preamble and `.claude/rules/e2e-testing.md`'s "native app behavior is the Maestro suites, not a resized browser"). There is **no native permission-dialog row** in the spec's matrix at all, even though §7.1 explicitly requires the dialog "on all live surfaces" including Android/iOS, and Task 6's own inline E2E matrix (§ "E2E matrix" at the bottom of Task 6's body) explicitly says its permission rows are "executed by T11 (web) and T12 (native)". This is a real gap in the frozen spec, not a stylistic choice — fixed in Step 3.

---

#### E2E matrix (inline, per `.claude/rules/e2e-testing.md` — BY TAG, not flow filename)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| native-turn-happy | Android emulator-5554 + iOS booted sim | authed, empty session | send "what is 2 plus 2" | assistant reply streams, persists | `session-runtime.turn.start` → `turn-emitter.turn-started`/`.turn-completed`; `session-configured` |
| native-tool-call | Android + iOS | authed, empty session | "what's the weather in Vancouver" (routes to `search_web`, foreground) | tool pill (text-matched `search_web`) appears while running, survives after reply | `tool-broker.pdp.decision action=allow`; `tool-broker.dispatch.foreground.done`; `turn-emitter.tool-update` |
| permission-confirm (native) | Android + iOS | authed | "turn on/off the kitchen light" (routes to `ha_call_service`, confirm-classified) | native dialog (AlertDialog / SwiftUI `.alert`) with tool name + reason; Allow → executes + reply streams; Deny → dismisses + reply adapts | `tool-broker.pdp.decision action=confirm`; `permission-broker.request`; `permission-broker.settled reason=allowed\|denied`; `tool-broker.pdp.confirm-resolved` or `tool-broker.dispatch.denied` |
| steer-followup-audio | Android + iOS | authed, TTS on | ask the model to `delegateTask("hermes",…)` AND reply immediately | two assistant bubbles, correct order, correct text, first never disappears | `session-runtime.turn.next-turn-trigger trigger=background-completion`; `tool-broker.dispatch.background.started`/`.completed`; `turn-voice.audio.start` twice, distinct turnIds |
| reload-convergence | Android + iOS | session with a tool call + a delegateTask, both settled | navigate away then back via the history drawer | identical feed — same texts, same tool pill, no duplication, no loss | client-side only (no gateway restart) — `session-configured` unchanged sessionId is the negative-control signal (no new session was minted) |
| voice-roundtrip | Android only (iOS gap flagged, Step 21) | authed, voice on | speak "what is two plus two" via a real-speech PCM fixture | STT transcript → reply, spoken via TTS | `stt.transcript.submit`; `session-runtime.turn.start trigger=user`; `turn-voice.audio.start`/`.audio.done` |
| restart-persistence | Android + iOS | session with history | `docker restart sentient-gateway` + app relaunch (force-stop/start, never `pm clear`) + reconnect | past-chat list (drawer) + full feed intact, exact reply text preserved | `session-configured` (post-restart) carries the SAME `sessionId`; SQLite store survived the process restart |

---

## Steps

### Phase 0 — Preconditions (verify, don't assume)

- [ ] **Step 1: Verify the local stack is up and both native voice services are reachable.**
  ```bash
  source scripts/env.sh
  docker ps --filter "name=sentient-gateway" --filter "health=healthy" --format "{{.Names}}"
  launchctl list | grep -E "sentient\.(whisper-stt|local-tts)"
  lsof -iTCP:8768 -sTCP:LISTEN -P; lsof -iTCP:8770 -sTCP:LISTEN -P
  grep -n "^stt:" -A5 ~/.sentient/gateway/config/config.yaml   # expect url: ws://host.docker.internal:8768
  grep -n "^tts:" -A5 ~/.sentient/gateway/config/config.yaml   # expect url: ws://host.docker.internal:8770
  ```
  Expected: gateway `healthy`; both launchd agents `0` exit status (loaded); both ports `LISTEN`; both config urls point at `host.docker.internal`. If either service is down, install/start it via its own `deploy/mac-prod/native/*.sh install && *.sh start` equivalent (or the operator's existing local launch method) BEFORE continuing — do not author voice/interrupt flows against a stack where TTS/STT are unreachable; that reintroduces the exact gap this task is closing.

- [ ] **Step 2: Verify Home Assistant MCP is reachable and the kitchen light entity responds.**
  ```bash
  docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=50 | grep -i "mcp.connect.ok.*home_assistant"
  ```
  If absent, send one throwaway text message from the webui asking "what's the state of the kitchen light" and confirm the assistant answers with a real state (not "I don't have access to that"). This is the same free HA credential already used by `agents/docs/testing-knowledge.md`'s existing "turn off the kitchen light" precedent (line 86) — no new setup, just a reachability check before scripting a Maestro flow against it.

### Phase 1 — Correct the spec's matrix gap

- [ ] **Step 3: Add the missing native permission-confirm row to the design spec's §10.1 matrix.**

  In `docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md`, immediately after the `permission-confirm-web` row:
  ```diff
   | permission-confirm-web | desktop 1280×900 + mobile 390×844 | authed | trigger a side-effecting tool | permission **dialog** shown in native design language; approve→executes, deny→blocked | L3 confirm frame out; decision frame in; PDP outcome logged |
  +| permission-confirm-native | Android emulator + iOS simulator (Maestro) | authed | trigger a side-effecting tool | native dialog (Compose `AlertDialog` / SwiftUI `.alert`) shown; approve→executes, deny→blocked | same as permission-confirm-web, observed via the gateway's file log (Maestro has no wire tap) |
  ```
  Also add one sentence to the paragraph right after the table (the one starting "Native-mobile cases run via Maestro…"):
  ```diff
  -Native-mobile cases run via Maestro (surface tags), web via Playwright MCP, against the local Docker stack — never prod, never mocks.
  +Native-mobile cases run via Maestro (surface tags), web via Playwright MCP, against the local Docker stack — never prod, never mocks. The permission dialog (§7.1) is required on ALL THREE live surfaces, so `permission-confirm-native` is listed explicitly rather than folded into the web row — an earlier draft of this table omitted it (corrected in Task 12).
  ```
  This is an additive, surgical correction — no other row changes.

- [ ] **Step 4: Commit the spec correction.**
  ```bash
  git add docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md
  git commit -m "docs(spec): add the missing native permission-confirm row to §10.1's matrix"
  ```

### Phase 2 — Re-ground existing flows (native-turn-happy + stale wording)

The five existing flows this task re-grounds (`01-send-stream.yaml`, `verify-newchat.yaml`, `04c-*.yaml` ×4, `18-auth-expired.yaml`) reference NO wire-message names and NO `cycleId` string anywhere (verified: `grep -rl "cycleId" qa/mobile/flows/` returns nothing) — every assertion is testTag-based, so **none of them need a structural change**. What they DO have is stale prose: comments describing the reply as "Hermes round-trip" / "LLM round-trip via Hermes", which is now wrong — under 2.0 the native loop answers chat turns directly; Hermes is invoked only via the background `delegateTask` tool, never in the plain chat path.

- [ ] **Step 5: Fix the "Hermes" wording in the five re-grounded comments.** One `Edit` per file, same substitution pattern (`old_string`/`new_string` shown for the first two; repeat identically for the rest):

  `qa/mobile/flows/android/01-send-stream.yaml`:
  ```diff
  -# 01-send-stream — type, send, and verify the assistant replies. Covers the full
  -# text-send → gateway → Hermes → streaming bubble path. assistant-bubble appears
  +# 01-send-stream — type, send, and verify the assistant replies (spec §10.1's
  +# native-turn-happy row). Covers the full text-send → gateway → native ReAct
  +# loop → streaming bubble path (Hermes is NOT in this path post-2.0 — it is a
  +# background delegateTask tool only). assistant-bubble appears
  ```
  and its footer comment:
  ```diff
  -# LLM round-trip via Hermes — genuinely slow, keep the long budget.
  +# LLM round-trip via the native OpenAI-compatible provider — genuinely slow,
  +# keep the long budget.
  ```
  Apply the same two substitutions (path comment + "LLM round-trip via Hermes" → "via the native OpenAI-compatible provider") to: `qa/mobile/flows/ios/01-send-stream.yaml`, `qa/mobile/flows/android/verify-newchat.yaml`, `qa/mobile/flows/android/04c-reconnect-continue-login-send.yaml`, `qa/mobile/flows/android/04c-reconnect-continue-followup.yaml`, `qa/mobile/flows/ios/04c-reconnect-continue-login-send.yaml`, `qa/mobile/flows/ios/04c-reconnect-continue-followup.yaml`. The two iOS `04c` files' header comments ALSO reference `resume.reanchor source=configure` / `dispatch.end conversationId` / `dispatch.session-new.lazy` — these are retired Hermes-adapter-client / ACP-wire concepts (per this repo's CLAUDE.md, "the ACP client is gone, not merely dormant"). Replace:
  ```diff
  -# GREEN is asserted from the GATEWAY LOG: the follow-up dispatch.end
  -# conversationId must equal the first turn's, with NO dispatch.session-new.lazy,
  -# and a `resume.reanchor source=configure` on the reconnect. The reply should
  -# reference "teal".
  +# GREEN is asserted from the GATEWAY LOG: both turns' session-runtime.turn.start
  +# lines must carry the SAME sessionId (no new session was minted on reconnect).
  +# The reply should reference "teal".
  ```
  (same substitution, `dispatch.end conversationId unchanged` phrasing in the Android `04c-reconnect-continue-followup.yaml` comment → `both session-runtime.turn.start lines carry the same sessionId`.)

  `qa/mobile/flows/android/18-auth-expired.yaml` — no Hermes wording, skip; it already reads correctly (auth path is orthogonal to the orchestrator rewrite).

- [ ] **Step 6: Run the batch to confirm the five re-grounded flows still pass unchanged.**
  ```bash
  ./qa/mobile/run-e2e.sh android --tags chat,session,reconnect --no-fault
  ./qa/mobile/run-e2e.sh ios --tags chat,session,reconnect --no-fault
  ```
  Expected: all green — this step only touched comments, so a red result here means the LOCAL STACK (not this task's edits) regressed; stop and diagnose before continuing.

- [ ] **Step 7: Commit the re-grounding.**
  ```bash
  git add qa/mobile/flows/android/01-send-stream.yaml qa/mobile/flows/ios/01-send-stream.yaml \
          qa/mobile/flows/android/verify-newchat.yaml \
          qa/mobile/flows/android/04c-reconnect-continue-login-send.yaml \
          qa/mobile/flows/android/04c-reconnect-continue-followup.yaml \
          qa/mobile/flows/ios/04c-reconnect-continue-login-send.yaml \
          qa/mobile/flows/ios/04c-reconnect-continue-followup.yaml
  git commit -m "docs(qa): re-ground native-turn-happy + reconnect flow comments off the retired Hermes-in-chat-path wording"
  ```

### Phase 3 — Resolve the interrupt row; flag barge-in honestly

`05-interrupt.yaml` (both platforms) currently only proves "send → stream, no crash" because its own comment claims TTS is unreachable in the default emulator setup. Step 1 already proved that's stale on this dev machine — `chat-interrupt`'s gate (`canInterrupt = cognition != IDLE || isSpeaking`, `android/src/main/kotlin/io/sentient/android/chat/ChatContent.kt:113`) is reachable once local-tts is actually running, which it now demonstrably is. `ttsEnabled` defaults to `true` (`shared/mobile-sdk/.../protocol/AudioPreferences.kt:8`), so no client-side toggle is needed either.

- [ ] **Step 8: Rewrite `qa/mobile/flows/android/05-interrupt.yaml` to actually tap Stop.**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - chat
  ---
  # 05-interrupt — send a long-reply prompt, wait for the TTS-speaking gate
  # (chat-interrupt becomes visible), tap Stop, assert the turn aborts cleanly.
  #
  # RESOLVED (was flagged unreachable): chat-interrupt's gate is
  # `cognition != IDLE || isSpeaking` (ChatContent.kt) — it needs local-tts
  # actually reachable from the gateway container (ws://host.docker.internal:8770),
  # NOT a client-side preference. Verified live on this dev machine (Step 1):
  # both io.dev32.sentient.whisper-stt and io.dev32.sentient.local-tts are
  # running launchd agents. Precondition for a GREEN run of this flow: both
  # services up (Step 1's check). If they are down, this flow degrades back to
  # the old send→stream-only assertion — treat a stuck `chat-interrupt` wait as
  # an infra signal, not a product regression.
  - launchApp
  - runFlow:
      when: { visible: { id: "login-backend-setup" } }
      file: "_helpers/login.yaml"
  - assertVisible: { id: "composer-input" }
  - tapOn: { id: "composer-input" }
  - inputText: "tell me a very long story about the history of computing in great detail"
  - tapOn: { id: "chat-send" }
  - hideKeyboard
  # canInterrupt gate: cognition running OR TTS speaking.
  - extendedWaitUntil:
      visible: { id: "chat-interrupt" }
      timeout: 40000
  - tapOn: { id: "chat-interrupt" }
  # turn.aborted + playback.stop land -> canInterrupt drops -> composer returns
  # to its idle (send) affordance.
  - extendedWaitUntil:
      notVisible: { id: "chat-interrupt" }
      timeout: 5000
  - assertVisible: { id: "composer-input" }
  ```

- [ ] **Step 9: Rewrite `qa/mobile/flows/ios/05-interrupt.yaml` identically (iOS ids).**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - chat
  ---
  # 05-interrupt — see android/05-interrupt.yaml for the full rationale
  # (RESOLVED: chat-interrupt's gate needs local-tts reachable from the
  # gateway container, verified up on this dev machine — Step 1).
  - runFlow: _helpers/login.yaml
  - tapOn: { id: "composer-input" }
  - inputText: "tell me a very long story about the history of computing in great detail"
  - tapOn: { id: "chat-send" }
  - tapOn: { id: "chat-message-list" }
  - extendedWaitUntil:
      visible: { id: "chat-interrupt" }
      timeout: 40000
  - tapOn: { id: "chat-interrupt" }
  - extendedWaitUntil:
      notVisible: { id: "chat-interrupt" }
      timeout: 5000
  - assertVisible: { id: "composer-input" }
  ```

- [ ] **Step 10: Flag barge-in as a genuine follow-up, not silently claimed.** Barge-in ("user speaks OVER TTS", spec §10.1) needs a REAL speech fixture playing concurrently with an in-progress TTS stream — the mic-onset VAD threshold that triggers barge-in cannot be satisfied by the silence fixture, and Step 22's new `two-plus-two.pcm` fixture is pushed BEFORE the mic taps on, not injected mid-playback. Automating true concurrent-injection timing is out of scope for this task (same category of gap already flagged for 08-voice-loop's silence-only fixture). Record this explicitly in the task's own handover — do not add a `06-barge-in.yaml` that only proves "no crash" and call it covered; that repeats the exact anti-pattern this task is fixing for interrupt.

- [ ] **Step 11: Run both re-written interrupt flows and confirm the real tap now fires.**
  ```bash
  ./qa/mobile/run-e2e.sh android --tags chat --no-fault
  ./qa/mobile/run-e2e.sh ios --tags chat --no-fault
  ```
  Expected: `chat-interrupt` becomes visible within 40s and the composer recovers within 5s of the tap. If `chat-interrupt` never appears, re-check Step 1's preconditions before touching the flow again.

- [ ] **Step 12: Commit the interrupt resolution.**
  ```bash
  git add qa/mobile/flows/android/05-interrupt.yaml qa/mobile/flows/ios/05-interrupt.yaml
  git commit -m "test(qa): drive a real interrupt tap now that local-tts is reachable; flag barge-in as a separate follow-up"
  ```

### Phase 4 — `inspect_screen`, then author every new-screen-touching flow in one pass

Per the authoring workflow rule, `inspect_screen` runs ONCE per new screen before authoring, not once per flow.

- [ ] **Step 13: `inspect_screen` the chat screen with a tool call in flight (both platforms).** Using the Maestro MCP tools: `list_devices` → pick the Android emulator id and the iOS sim id → `inspect_screen` each while a tool-triggering message is mid-flight (send "what's the weather in Vancouver" by hand first) to confirm `ToolPillStrip`'s rendered text node is queryable by the assumed regex before scripting Step 14–15's flows against it. This is a live verification, not a file edit — no commit.

- [ ] **Step 14: Author `qa/mobile/flows/android/70-tool-call.yaml` (native-tool-call).**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - chat
  ---
  # 70-tool-call — spec §10.1's native-tool-call row. search_web (searxng MCP,
  # foreground, no side effects) keeps this decoupled from the HA-dependent
  # permission rows (71/72/72b). ToolPillStrip has no testTag — text-matched.
  - launchApp
  - runFlow:
      when: { visible: { id: "login-backend-setup" } }
      file: "_helpers/login.yaml"
  - tapOn: { id: "new-chat" }
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 3000
  - tapOn: { id: "composer-input" }
  - inputText: "what's the weather in Vancouver"
  - tapOn: { id: "chat-send" }
  - hideKeyboard
  - extendedWaitUntil:
      visible: { text: ".*search_web.*" }
      timeout: 15000
  - extendedWaitUntil:
      visible: { id: "assistant-bubble" }
      timeout: 40000
  - assertVisible: { text: ".*search_web.*" }
  ```

- [ ] **Step 15: Author `qa/mobile/flows/ios/70-tool-call.yaml` (same case, iOS conventions).**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - chat
  ---
  # 70-tool-call — see android/70-tool-call.yaml for the full rationale.
  - runFlow: _helpers/login.yaml
  - tapOn: { id: "composer-input" }
  - inputText: "what's the weather in Vancouver"
  - tapOn: { id: "chat-send" }
  - tapOn: { id: "chat-message-list" }
  - extendedWaitUntil:
      visible: { text: ".*search_web.*" }
      timeout: 15000
  - extendedWaitUntil:
      visible: { id: "assistant-bubble" }
      timeout: 40000
  - assertVisible: { text: ".*search_web.*" }
  ```

- [ ] **Step 16: `inspect_screen` the chat screen with the permission dialog open (both platforms).** Send "turn on the kitchen light" by hand, wait for the dialog, `inspect_screen` on both devices to confirm `permission-allow`/`permission-deny` resolve as assumed (Interfaces section flags this as unverified until Task 8 lands — this is the live check). If Android's ids differ from `permission-allow`/`permission-deny`, update Step 17–19 to match BEFORE running the batch, and flag the naming drift in this task's own handover.

- [ ] **Step 17: Author `qa/mobile/flows/android/71-permission-confirm-deny.yaml`.**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - chat
  ---
  # 71-permission-confirm-deny — spec §10.1's permission-confirm row, Deny
  # path. ha_call_service is the ONE confirm-classified tool
  # (gateway/mcp-policy.yaml's confirm_ha_service_call rule, Task 6). Deny
  # never mutates device state, so this flow needs no restore pair.
  - launchApp
  - runFlow:
      when: { visible: { id: "login-backend-setup" } }
      file: "_helpers/login.yaml"
  - tapOn: { id: "new-chat" }
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 3000
  - tapOn: { id: "composer-input" }
  - inputText: "turn on the kitchen light"
  - tapOn: { id: "chat-send" }
  - hideKeyboard
  - extendedWaitUntil:
      visible: { id: "permission-deny" }
      timeout: 15000
  - assertVisible: { id: "permission-allow" }
  - tapOn: { id: "permission-deny" }
  - extendedWaitUntil:
      notVisible: { id: "permission-deny" }
      timeout: 3000
  - extendedWaitUntil:
      visible: { id: "assistant-bubble" }
      timeout: 30000
  ```

- [ ] **Step 18: Author `qa/mobile/flows/android/72-permission-confirm-approve.yaml` + `72b-permission-confirm-approve-restore.yaml`.** Tagged `destructive-profile` / `restore` — reused from the taxonomy's closest fit (a real external-state mutation needing a paired cleanup), not a literal server-profile mutation; noted inline.
  ```yaml
  # 72-permission-confirm-approve.yaml
  appId: io.dev32.sentient.debug
  tags:
    - chat
    - destructive-profile
  ---
  # 72-permission-confirm-approve — Allow path of 71's dialog. Real side
  # effect: flips the kitchen light ON via ha_call_service. `destructive-
  # profile`/`restore` is a taxonomy reuse (real fit is "mutates real
  # external state" — the taxonomy has no smart-home-specific tag) — paired
  # with 72b, which CANONICAL_ORDER keeps adjacent.
  - launchApp
  - runFlow:
      when: { visible: { id: "login-backend-setup" } }
      file: "_helpers/login.yaml"
  - tapOn: { id: "new-chat" }
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 3000
  - tapOn: { id: "composer-input" }
  - inputText: "turn on the kitchen light"
  - tapOn: { id: "chat-send" }
  - hideKeyboard
  - extendedWaitUntil:
      visible: { id: "permission-allow" }
      timeout: 15000
  - tapOn: { id: "permission-allow" }
  - extendedWaitUntil:
      notVisible: { id: "permission-allow" }
      timeout: 3000
  - extendedWaitUntil:
      visible: { id: "assistant-bubble" }
      timeout: 30000
  ```
  ```yaml
  # 72b-permission-confirm-approve-restore.yaml
  appId: io.dev32.sentient.debug
  tags:
    - chat
    - restore
  ---
  # 72b — restore pair for 72: flips the kitchen light back off.
  - assertVisible: { id: "composer-input" }
  - tapOn: { id: "new-chat" }
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 3000
  - tapOn: { id: "composer-input" }
  - inputText: "turn off the kitchen light"
  - tapOn: { id: "chat-send" }
  - hideKeyboard
  - extendedWaitUntil:
      visible: { id: "permission-allow" }
      timeout: 15000
  - tapOn: { id: "permission-allow" }
  - extendedWaitUntil:
      visible: { id: "assistant-bubble" }
      timeout: 30000
  ```

- [ ] **Step 19: Author the iOS twins `qa/mobile/flows/ios/71-permission-confirm-deny.yaml`, `72-permission-confirm-approve.yaml`, `72b-permission-confirm-approve-restore.yaml`** — identical bodies to Steps 17–18, swapping the launch/login prelude for the iOS `_helpers/login.yaml` pattern and `tapOn: { id: "chat-message-list" }` in place of `hideKeyboard` (mirroring `ios/05-interrupt.yaml`'s established convention). Same tags.

- [ ] **Step 20: Run the tool-call + permission batch and fix residuals.**
  ```bash
  ./qa/mobile/run-e2e.sh android --tags chat --no-fault
  ./qa/mobile/run-e2e.sh ios --tags chat --no-fault
  ```
  Expected first-run residuals to watch for: (a) the model picks a DIFFERENT search tool than `search_web` — loosen the regex or re-prompt; (b) the model declines to call `ha_call_service` for a phrasing that reads as a query, not a command — reword to an imperative ("turn on the kitchen light" not "can you turn on..."); (c) Android's permission ids don't match iOS's (Step 16's flag) — fix the id, not the assertion style.

- [ ] **Step 21: Commit the tool-call + permission flows.**
  ```bash
  git add qa/mobile/flows/android/70-tool-call.yaml qa/mobile/flows/ios/70-tool-call.yaml \
          qa/mobile/flows/android/71-permission-confirm-deny.yaml qa/mobile/flows/ios/71-permission-confirm-deny.yaml \
          qa/mobile/flows/android/72-permission-confirm-approve.yaml qa/mobile/flows/android/72b-permission-confirm-approve-restore.yaml \
          qa/mobile/flows/ios/72-permission-confirm-approve.yaml qa/mobile/flows/ios/72b-permission-confirm-approve-restore.yaml
  git commit -m "test(qa): native-tool-call + permission-confirm (native) rows — spec §10.1"
  ```

### Phase 5 — steer-followup-audio + reload-convergence (compound, LLM-nondeterministic — flagged inline)

Both rows below ask a live model to make a specific tool-choice decision (delegate in the background AND answer immediately; or call a tool AND background-delegate in the SAME turn). This is inherently less deterministic than a plain send/receive — flagged explicitly in each flow's header rather than silently assumed reliable, matching this repo's existing precedent for `61-apply-conflict-trigger`'s flagged variant.

- [ ] **Step 22: Author `qa/mobile/flows/android/73-steer-followup-audio.yaml`.**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - chat
    - slow
  ---
  # 73-steer-followup-audio — spec §10.1's steer-followup-audio row (§4.5
  # back-to-back follow-up; §7.2 client MUST queue by turn id, never cut the
  # first turn's audio). delegateTask("hermes", …) is a background tool
  # (§5.2); its completion lands AFTER this turn's final answer, so it fires
  # a NEW turn (session-runtime.turn.next-turn-trigger) — two distinct
  # assistant bubbles is the CORRECT outcome (contrast the desktop-only
  # steer-midloop spec row, which folds into one bubble).
  #
  # LLM NON-DETERMINISM (flagged): whether the model calls delegateTask AND
  # replies immediately (vs. waiting) is a live tool-choice decision. Retry
  # once before treating a stuck run as a product regression.
  #
  # ACOUSTIC CAVEAT: Maestro cannot listen to audio — "plays after, never
  # cut off" is NOT directly provable here. That invariant's authoritative
  # proof is the mobile-sdk audio-queue unit test (Task 5). This is the
  # UI-level smoke: two bubbles, correct order, correct text, no crash.
  - launchApp
  - runFlow:
      when: { visible: { id: "login-backend-setup" } }
      file: "_helpers/login.yaml"
  - tapOn: { id: "new-chat" }
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 3000
  - tapOn: { id: "composer-input" }
  - inputText: "Delegate this to hermes in the background right now, then immediately reply with exactly: KICKED-OFF. Do not wait for hermes before replying. Hermes task: reply with exactly the single word BRAVO99 and nothing else."
  - tapOn: { id: "chat-send" }
  - hideKeyboard
  - extendedWaitUntil:
      visible: { text: ".*KICKED-OFF.*" }
      timeout: 40000
  # hermes is a real subprocess invocation, off-loop — budget generously.
  - extendedWaitUntil:
      visible: { text: ".*BRAVO99.*" }
      timeout: 90000
  - assertVisible: { text: ".*KICKED-OFF.*" }
  - assertVisible: { text: ".*BRAVO99.*" }
  ```

- [ ] **Step 23: Author `qa/mobile/flows/ios/73-steer-followup-audio.yaml`** — same body, iOS login/prelude conventions (as Step 19).

- [ ] **Step 24: Author `qa/mobile/flows/android/74-reload-convergence.yaml`.**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - session
  ---
  # 74-reload-convergence — spec §10.1's reload-convergence row: replay
  # projection == live projection (§3.2/§3.4). Builds one turn carrying BOTH
  # a foreground tool call and a background delegateTask, then forces the
  # CLIENT to rebuild the feed from scratch via drawer navigation
  # (ChatHost.kt's koinViewModel<ChatViewModel>{parametersOf(sessionId)}
  # recreates the VM on route-arg change). NOTE: a cold relaunch does NOT
  # reopen the last session (AppNavHost.kt always routes to Routes.chat(null)
  # on entry) — the drawer's history-row-<sessionId> is the correct driver
  # for THIS row; 76/76b (restart-persistence) covers relaunch+gateway-
  # restart separately.
  #
  # LLM NON-DETERMINISM (flagged): this compounds TWO tool-choice decisions
  # in one turn (call search_web AND delegateTask, reply-order KICKED-OFF-
  # first). Retry once before treating a stuck run as a regression.
  - launchApp
  - runFlow:
      when: { visible: { id: "login-backend-setup" } }
      file: "_helpers/login.yaml"
  - tapOn: { id: "new-chat" }
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 3000
  - tapOn: { id: "composer-input" }
  - inputText: "Search the web for today's date, and ALSO delegate to hermes in the background: reply with exactly the single word RELOADCHECK. Reply to me first with exactly: SEARCHDONE."
  - tapOn: { id: "chat-send" }
  - hideKeyboard
  - extendedWaitUntil:
      visible: { text: ".*search_web.*" }
      timeout: 15000
  - extendedWaitUntil:
      visible: { text: ".*SEARCHDONE.*" }
      timeout: 40000
  - extendedWaitUntil:
      visible: { text: ".*RELOADCHECK.*" }
      timeout: 90000
  # navigate away (a fresh, uncommitted chat) then back via the drawer.
  - tapOn: { id: "new-chat" }
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 3000
  - tapOn: { id: "history-open" }
  - extendedWaitUntil:
      visible: { id: "history-new-chat" }
      timeout: 3000
  - tapOn:
      id: ".*history-row-.*"
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 5000
  # identical feed: no new/weird tiles, no duplication, no loss.
  - assertVisible: { text: ".*SEARCHDONE.*" }
  - assertVisible: { text: ".*RELOADCHECK.*" }
  - assertVisible: { text: ".*search_web.*" }
  ```

- [ ] **Step 25: Author `qa/mobile/flows/ios/74-reload-convergence.yaml`** — same body, iOS conventions.

- [ ] **Step 26: Run the batch and fix residuals.**
  ```bash
  ./qa/mobile/run-e2e.sh android --tags chat,session --no-fault
  ./qa/mobile/run-e2e.sh ios --tags chat,session --no-fault
  ```
  Expected first-run residual to watch for: the model answers "SEARCHDONE" but never actually calls `delegateTask` (treats the instruction as narrative, not a tool directive) — reword more imperatively ("You MUST call the delegateTask tool now") before concluding the feature is broken.

- [ ] **Step 27: Commit.**
  ```bash
  git add qa/mobile/flows/android/73-steer-followup-audio.yaml qa/mobile/flows/ios/73-steer-followup-audio.yaml \
          qa/mobile/flows/android/74-reload-convergence.yaml qa/mobile/flows/ios/74-reload-convergence.yaml
  git commit -m "test(qa): steer-followup-audio + reload-convergence rows — spec §10.1"
  ```

### Phase 6 — voice-roundtrip (real speech fixture, Android only)

- [ ] **Step 28: Generate a real speech fixture using the already-running local-tts service (not a hand recording).** `qa/mobile/fixtures/README.md`'s documented recipe assumes a `sox -t coreaudio` mic capture; this task instead synthesizes the utterance through the already-verified-live local-tts WS endpoint (`ws://127.0.0.1:8770`), matching the WS-probe method already documented in `agents/docs/testing-knowledge.md`'s "local-tts service (WS probe)" section:
  ```bash
  cd capabilityServices/LocalTTSService && source .venv/bin/activate
  python3 - <<'PY'
  import asyncio, websockets, struct

  async def synth():
      uri = "ws://127.0.0.1:8770/?format=pcm&sample_rate=16000"
      async with websockets.connect(uri, max_size=None) as ws:
          await ws.send('{"type":"text","text":"what is two plus two"}')
          await ws.send('{"type":"flush"}')
          frames = bytearray()
          async for msg in ws:
              if isinstance(msg, bytes):
                  frames.extend(msg)
              else:
                  if '"done"' in msg:
                      break
          with open("../../qa/mobile/fixtures/two-plus-two.pcm", "wb") as f:
              f.write(frames)
          print(f"wrote {len(frames)} bytes")

  asyncio.run(synth())
  PY
  ```
  Expected: a non-trivial `two-plus-two.pcm` (several hundred KB at 16kHz PCM16 mono for a ~2s utterance). Play it back locally to sanity-check it isn't silence:
  ```bash
  sox qa/mobile/fixtures/two-plus-two.pcm -t coreaudio -r 16000 -c 1 -e signed -b 16
  ```

- [ ] **Step 29: Generalize `push_and_arm_fixture` in `run-e2e.sh` to accept a fixture filename.**
  ```diff
   push_and_arm_fixture() {
  -  local fixture_local="$FIXTURES_DIR/silence-500ms.pcm"
  +  local fixture_name="${1:-silence-500ms.pcm}"
  +  local fixture_local="$FIXTURES_DIR/$fixture_name"
     local cache_path="/data/user/0/$ANDROID_APP/cache/sentient-fixture.pcm"
     info "  Pushing fixture to app cache: $cache_path"
     cat "$fixture_local" | adb -s "$ANDROID_DEVICE" shell "run-as $ANDROID_APP sh -c 'cat > $cache_path'" 2>/dev/null \
       || info "  WARNING: fixture push via run-as failed"
     adb -s "$ANDROID_DEVICE" shell am broadcast -a io.sentient.debug.FAULT -p "$ANDROID_APP" --es kind fixture --es name sentient-fixture.pcm 2>/dev/null || true
     sleep 1
   }
  ```
  (The broadcast's `--es name` stays `sentient-fixture.pcm` — that is the on-device cache filename the app reads, not the host source filename; only the SOURCE path changes.) The existing call site inside `fault_phase_android`'s 08-voice-loop block keeps working unchanged (`push_and_arm_fixture` with no arg still defaults to `silence-500ms.pcm`).

- [ ] **Step 30: Author `qa/mobile/flows/android/75-voice-roundtrip.yaml`.**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - voice-loop
    - fault-armed
  ---
  # 75-voice-roundtrip — spec §10.1's voice-roundtrip row: full STT -> native
  # loop -> TTS, no Hermes in the audio path (§6). Unlike 08-voice-loop
  # (silence fixture, plumbing-only), this pushes a REAL speech fixture
  # (two-plus-two.pcm, Step 28) so Whisper produces an actual transcript that
  # triggers a turn. No-relaunch: the runner pushes + arms the fixture on the
  # RUNNING app BEFORE this flow (push_and_arm_fixture two-plus-two.pcm).
  #
  # ANDROID ONLY: iOS has no adb-broadcast fault channel (ios-testing.md's
  # already-declared gap) — no ios/75-voice-roundtrip.yaml exists; flagged
  # as a known follow-up (needs a debug-arming UI on iOS), not skipped
  # silently.
  #
  # Pre-condition (runner, app already running):
  #   1. composer-input visible.
  #   2. two-plus-two.pcm pushed to the app cache via run-as.
  #   3. adb shell am broadcast -a io.sentient.debug.FAULT -p io.dev32.sentient.debug
  #        --es kind fixture --es name sentient-fixture.pcm
  - assertVisible: { id: "composer-input" }
  - tapOn: { id: "chat-mic" }
  - assertVisible: { id: "chat-mic" }
  - extendedWaitUntil:
      visible: { id: "chat-mic" }
      timeout: 4000
  - tapOn: { id: "chat-mic" }
  - extendedWaitUntil:
      visible: { id: "assistant-bubble" }
      timeout: 40000
  - assertVisible: { id: "composer-input" }
  ```

- [ ] **Step 31: Wire `75-voice-roundtrip` into `fault_phase_android`'s orchestration**, immediately after the existing `08-voice-loop` block in `run-e2e.sh`:
  ```diff
     # 08-voice-loop → push fixture + arm, then run.
     echo ""; info "-> 08-voice-loop"
     adb -s "$ANDROID_DEVICE" logcat -c 2>/dev/null || true
     push_and_arm_fixture
     if run_one "08-voice-loop"; then pass "  08-voice-loop"; sleep 1
       grep_logcat_for "fixture-utterance" "fixture-utterance" || BATCH_RESULT=1
       grep_logcat_for "startMic" "startMic" || BATCH_RESULT=1
       flag "  08-voice-loop: FULL STT->LLM->TTS needs a real speech fixture (silence only here)"
     else fail "  08-voice-loop"; BATCH_RESULT=1; fi

  +  # 75-voice-roundtrip → real speech fixture, full STT->loop->TTS.
  +  echo ""; info "-> 75-voice-roundtrip"
  +  adb -s "$ANDROID_DEVICE" logcat -c 2>/dev/null || true
  +  push_and_arm_fixture two-plus-two.pcm
  +  if run_one "75-voice-roundtrip"; then pass "  75-voice-roundtrip"; sleep 1
  +    grep_logcat_for "fixture-utterance" "fixture-utterance" || BATCH_RESULT=1
  +    grep_logcat_for "startMic" "startMic" || BATCH_RESULT=1
  +  else fail "  75-voice-roundtrip"; BATCH_RESULT=1; fi
  ```

- [ ] **Step 32: Run the fault-armed phase to confirm 75 fires.**
  ```bash
  ./qa/mobile/run-e2e.sh android --fault-only
  ```
  Expected: `75-voice-roundtrip` PASS, `assistant-bubble` visible within 40s. If Whisper produces no transcript (STT sees silence-equivalent noise), re-record the fixture at a higher gain or re-verify Step 28's playback sanity check.

- [ ] **Step 33: Commit.**
  ```bash
  git add qa/mobile/fixtures/two-plus-two.pcm qa/mobile/flows/android/75-voice-roundtrip.yaml qa/mobile/run-e2e.sh
  git commit -m "test(qa): voice-roundtrip row (Android, real speech fixture) — spec §10.1"
  ```

### Phase 7 — restart-persistence

- [ ] **Step 34: Author `qa/mobile/flows/android/76-restart-persistence-part1.yaml`.**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - session
    - reconnect
    - fault-armed
  ---
  # 76-restart-persistence-part1 — spec §10.1's restart-persistence row,
  # FIRST turn. The runner (between this file and 76b) does a FULL gateway
  # restart (docker restart sentient-gateway) AND relaunches the app
  # (am force-stop + am start — NEVER pm clear, which would wipe the token
  # and turn this into an auth test instead of a persistence one). Stronger
  # than 04c (WS-level reconnect, same app process) — proves the session
  # store (SQLite, durable) survives a real server restart.
  - launchApp
  - runFlow:
      when: { visible: { id: "login-backend-setup" } }
      file: "_helpers/login.yaml"
  - tapOn: { id: "new-chat" }
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 3000
  - tapOn: { id: "composer-input" }
  - inputText: "Reply with exactly: PERSISTCHECK7788"
  - tapOn: { id: "chat-send" }
  - hideKeyboard
  - extendedWaitUntil:
      visible: { text: ".*PERSISTCHECK7788.*" }
      timeout: 40000
  ```

- [ ] **Step 35: Author `qa/mobile/flows/android/76b-restart-persistence-part2.yaml`.**
  ```yaml
  appId: io.dev32.sentient.debug
  tags:
    - session
    - reconnect
    - fault-armed
  ---
  # 76b-restart-persistence-part2 — runner relaunched the app after a full
  # gateway restart (see 76-restart-persistence-part1.yaml). Cold entry
  # always routes to Routes.chat(null) (AppNavHost.kt) — a blank new chat,
  # NOT the prior session — so the past-chat list (drawer) is the only place
  # to prove durability.
  - launchApp
  - runFlow:
      when: { visible: { id: "login-backend-setup" } }
      file: "_helpers/login.yaml"
  - tapOn: { id: "history-open" }
  - extendedWaitUntil:
      visible: { id: "history-new-chat" }
      timeout: 3000
  - assertVisible: { id: "history-search" }
  - tapOn:
      id: ".*history-row-.*"
  - extendedWaitUntil:
      visible: { id: "composer-input" }
      timeout: 5000
  - assertVisible: { text: ".*PERSISTCHECK7788.*" }
  ```

- [ ] **Step 36: Author the iOS twins `qa/mobile/flows/ios/76-restart-persistence-part1.yaml` / `76b-restart-persistence-part2.yaml`** — same bodies, iOS `_helpers/login.yaml` prelude (which itself does `launchApp` unconditionally, so part2's explicit `launchApp` is omitted on iOS, matching the existing `_helpers/login.yaml` contract) and `tapOn: { id: "chat-message-list" }` in place of `hideKeyboard`.

- [ ] **Step 37: Wire the restart-persistence pair into both fault-phase orchestrations.** In `run-e2e.sh`'s `fault_phase_android`, after the existing `04c` warm-continuity block:
  ```diff
     run_one "04c-reconnect-continue-followup" && pass "  04c continuity" || { fail "  04c continuity"; flag "  verify gateway log: dispatch.end conversationId unchanged, NO dispatch.session-new.lazy"; BATCH_RESULT=1; }
     else fail "  04c part 1"; BATCH_RESULT=1; fi
  +
  +  # 76/76b restart-persistence — full gateway restart + app relaunch between parts.
  +  echo ""; info "-> 76/76b restart-persistence (gateway restart + app relaunch)"
  +  if run_one "76-restart-persistence-part1"; then
  +    info "  Restarting gateway (full process restart, not just a WS drop)"
  +    docker restart sentient-gateway >/dev/null 2>&1 || true
  +    until [[ "$(docker inspect --format '{{.State.Health.Status}}' sentient-gateway 2>/dev/null)" == "healthy" ]]; do sleep 2; done
  +    adb -s "$ANDROID_DEVICE" shell am force-stop "$ANDROID_APP" 2>/dev/null || true
  +    adb -s "$ANDROID_DEVICE" shell monkey -p "$ANDROID_APP" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  +    sleep 3
  +    run_one "76b-restart-persistence-part2" && pass "  76b restart-persistence" || { fail "  76b restart-persistence"; BATCH_RESULT=1; }
  +  else fail "  76 part 1"; BATCH_RESULT=1; fi
  ```
  (`monkey -c android.intent.category.LAUNCHER 1` is the same cold-relaunch mechanism T6's testing-knowledge entry describes as "`am force-stop` then `am start`" — `monkey`'s launcher-intent form is the scriptable equivalent when the exact package's launch `Activity` class name isn't hardcoded elsewhere in this file; if `run-e2e.sh` already has a named launch-activity constant elsewhere, prefer `am start -n <that constant>` instead for consistency.)

  In `fault_phase_ios`, after the existing `04c` block:
  ```diff
     run_ios_one "04c-reconnect-continue-followup" && pass "  04c continuity" || { fail "  04c continuity"; flag "  verify gateway log: dispatch.end conversationId unchanged, NO dispatch.session-new.lazy"; BATCH_RESULT=1; }
     else fail "  04c part 1"; BATCH_RESULT=1; fi
  +
  +  # 76/76b restart-persistence — full gateway restart + app relaunch.
  +  echo ""; info "-> 76/76b restart-persistence (gateway restart + app relaunch)"
  +  if run_ios_one "76-restart-persistence-part1"; then
  +    gw_restart
  +    xcrun simctl terminate "$IOS_DEVICE" "$IOS_APP" 2>/dev/null || true
  +    xcrun simctl launch "$IOS_DEVICE" "$IOS_APP" >/dev/null 2>&1 || true
  +    sleep 3
  +    run_ios_one "76b-restart-persistence-part2" && pass "  76b restart-persistence" || { fail "  76b restart-persistence"; BATCH_RESULT=1; }
  +  else fail "  76 part 1"; BATCH_RESULT=1; fi
  ```

- [ ] **Step 38: Run the fault-armed phase on both platforms and confirm the pair passes.**
  ```bash
  ./qa/mobile/run-e2e.sh android --fault-only
  ./qa/mobile/run-e2e.sh ios --fault-only
  ```
  Expected: `76b-restart-persistence-part2` finds `PERSISTCHECK7788` in the history-row-selected feed after a real gateway process restart + app relaunch.

- [ ] **Step 39: Commit.**
  ```bash
  git add qa/mobile/flows/android/76-restart-persistence-part1.yaml qa/mobile/flows/android/76b-restart-persistence-part2.yaml \
          qa/mobile/flows/ios/76-restart-persistence-part1.yaml qa/mobile/flows/ios/76b-restart-persistence-part2.yaml \
          qa/mobile/run-e2e.sh
  git commit -m "test(qa): restart-persistence row (full gateway restart + app relaunch) — spec §10.1"
  ```

### Phase 8 — CANONICAL_ORDER, log-trail pattern, remaining docs

- [ ] **Step 40: Add every new flow name to `run-e2e.sh`'s `CANONICAL_ORDER`.**
  ```diff
     50-personalities-create-activate 59-audio-dirty-back-discard
     51-account-rename 51b-account-restore 52-pin-wrong-current 53-devices-link-cancel
     54-voice-preview-pick 54b-voice-restore
     55-voice-create-record 55b-voice-delete-user-pack
     62-fish-clone-happy 62b-fish-clone-cleanup
     57-diagnostics-send 58-update-footer-check
     56-secrets-presence 41-members-add-cap 42-settings-non-admin-gate 43-members-delete-cleanup
  +  70-tool-call
  +  71-permission-confirm-deny
  +  72-permission-confirm-approve 72b-permission-confirm-approve-restore
  +  73-steer-followup-audio
  +  74-reload-convergence
     63-logout
     04-reconnect 04b-reconnect-recover
     04c-reconnect-continue-login-send 04c-reconnect-continue-followup
     08-voice-loop 18-auth-expired 20-malformed-frame 58b-update-footer-offline
  +  75-voice-roundtrip
  +  76-restart-persistence-part1 76b-restart-persistence-part2
     60-model-offline-save-setup 60-model-offline-save-trigger 60-model-offline-save-recover
     61-apply-conflict-setup 61-apply-conflict-trigger
  ```
  (70–74 sit in the normal-batch block, adjacent to the other `destructive-profile`/`restore` pairs, mirroring existing placement conventions; 75/76/76b sit in the fault-armed block since they're excluded from the default batch by tag and re-run individually by the dedicated fault-phase functions — listing them here is documentary, matching how `08-voice-loop`/`18-auth-expired` are already listed despite being fault-armed.)

- [ ] **Step 41: Broaden `android_log_trail`'s streaming-delta grep for the wire rename.** Task 5 (KMP-SDK rebase) renames the client-visible streaming event; its exact new log-tag string isn't frozen at the time this task was written, so widen the pattern rather than guessing wrong:
  ```diff
   android_log_trail() {
     echo ""
     info "Log-trail assertions (logcat sweep)"
  -  grep_logcat_for "MessageDelta|message\.delta" "MessageDelta (streaming, 01-send-stream)" || BATCH_RESULT=1
  +  grep_logcat_for "MessageDelta|message\.delta|turn\.text\.delta|TurnTextDelta" "streaming text delta (01-send-stream)" || BATCH_RESULT=1
     grep_logcat_for "startMic|stopMic" "startMic/stopMic (11-mic-control)" || flag "  mic log trail absent (hold-to-talk mic may not emit on a plain tap)"
     grep_logcat_for "pendingSend|flush" "pendingSend/flush (10-outbox)" || flag "  outbox flush trail absent"
   }
  ```
  If Task 5 landed with a different log-tag string by the time you run this, tighten the regex back down to the real one instead of leaving all four alternatives permanently.

- [ ] **Step 42: Add a native-service preflight to `check_gateway`'s call site.** In `run-e2e.sh`, immediately after the existing `check_gateway` function definition:
  ```diff
  +# check_native_services - non-fatal preflight for the two host-native voice
  +# services (whisper-stt :8768, local-tts :8770). A missing service degrades
  +# specific rows (05-interrupt's real tap, 75-voice-roundtrip) rather than
  +# failing the whole batch — flag, don't exit.
  +check_native_services() {
  +  info "Checking native voice services (whisper-stt :8768, local-tts :8770)..."
  +  if ! lsof -iTCP:8768 -sTCP:LISTEN >/dev/null 2>&1; then
  +    flag "  whisper-stt not listening on :8768 — voice-loop/voice-roundtrip rows will fail STT"
  +  fi
  +  if ! lsof -iTCP:8770 -sTCP:LISTEN >/dev/null 2>&1; then
  +    flag "  local-tts not listening on :8770 — 05-interrupt's real tap + voice-roundtrip's TTS leg will fail"
  +  fi
  +}
  +
   check_android() {
  ```
  And call it once, in `main`, right after `check_gateway`:
  ```diff
   check_gateway
  +check_native_services
   if should_reset_gateway; then reset_gateway; fi
  ```

- [ ] **Step 43: Fix `qa/mobile/fixtures/README.md`'s stale "Hermes replies" wording and document the synth-fixture recipe actually used (Step 28).**
  ```diff
   4. Arm via broadcast: `adb shell am broadcast -a io.sentient.debug.FAULT --es kind fixture --es path /sdcard/sentient-fixture.pcm`
  -5. Tap mic; the fixture feeds through the uplink; STT processes it; Hermes replies; TTS plays back.
  +5. Tap mic; the fixture feeds through the uplink; STT processes it; the native
  +   ReAct loop replies (Hermes is NOT in this path post-2.0 — it is a background
  +   `delegateTask` tool only); TTS plays back.
  ```
  and add a new section documenting the WS-synth approach actually used for `two-plus-two.pcm` (Step 28's exact script), so a future fixture doesn't require live mic access:
  ```diff
   ## Generating a Fixture with sox (on macOS)
  +
  +## Generating a Fixture via local-tts (no microphone needed)
  +
  +`two-plus-two.pcm` (used by qa/mobile/flows/android/75-voice-roundtrip.yaml) was
  +generated by synthesizing the utterance through the already-running local-tts
  +service rather than recording it — see Task 12's Step 28 for the exact script
  +(`ws://127.0.0.1:8770/?format=pcm&sample_rate=16000`, same WS-probe method as
  +agents/docs/testing-knowledge.md's "local-tts service (WS probe)" section).
  +Whether Whisper reliably transcribes TTS-synthesized (rather than human) speech
  +is worth re-checking if this fixture starts producing empty transcripts.
  ```

- [ ] **Step 44: Fix `agents/docs/testing-knowledge.md`'s stale wording + add case entries for the new rows.** Three targeted edits:
  1. T3's "Hermes round-trip" → "native ReAct loop round-trip" (line ~329 area, same substitution as Step 5).
  2. T8's stale log-trail line:
     ```diff
     -**Expected log trail (gateway):** the two `[cerebrum:attention-gate] cycle dispatched` lines carry DISTINCT numeric cycleIds (e.g. `1781509517090` then `1781509545080`); no `cycle-N`.
     +**Expected log trail (gateway):** the two `session-runtime.turn.start` lines carry DISTINCT `turnId` values (2.0 native orchestrator — `cerebrum`/`cycleId` are retired, see Task 12); the two turns' `sessionId` stays IDENTICAL across the reconnect.
     ```
  3. Append six new case entries (T11–T16) after T10, one per row this task adds — same terse format as the existing entries, each pointing at its flow file(s) instead of duplicating the body:
     ```markdown
     ### T11 — Mobile native-tool-call (foreground MCP read renders a tool pill)
     **Scenario:** A prompt routing to `search_web` (foreground, no side effects) renders a text-matched tool pill while running, surviving after the reply. **Flows:** `qa/mobile/flows/{android,ios}/70-tool-call.yaml`. See Task 12 (2026-07-27 plan) for full rationale + log-trail tags.

     ### T12 — Mobile permission-confirm (native dialog, Allow/Deny)
     **Scenario:** A prompt routing to the ONE confirm-classified tool (`ha_call_service`) renders a native dialog (Compose `AlertDialog` / SwiftUI `.alert`); Allow executes + replies, Deny dismisses + the model adapts. **Flows:** `71/72/72b-permission-confirm-*.yaml`. Requires HA MCP reachable (free credential). See Task 12.

     ### T13 — Mobile steer-followup-audio (back-to-back turn from a background delegate)
     **Scenario:** A background `delegateTask` completing AFTER the main turn's final answer fires a new back-to-back turn — two assistant bubbles, correct order, first never cut off. **Flow:** `73-steer-followup-audio.yaml`. LLM-nondeterministic (flagged inline); acoustic queueing invariant is NOT Maestro-provable, see Task 12.

     ### T14 — Mobile reload-convergence (drawer switch rebuilds an identical feed)
     **Scenario:** A session with a tool call + a delegateTask, navigated away and back via the history drawer, renders an identical feed — no duplication, no loss. **Flow:** `74-reload-convergence.yaml`. See Task 12.

     ### T15 — Mobile voice-roundtrip (real speech fixture, Android only)
     **Scenario:** A real-speech PCM fixture (`qa/mobile/fixtures/two-plus-two.pcm`, synthesized via local-tts — see the fixtures README) drives a full STT → native loop → TTS round trip. iOS has no fault-arming channel — Android only, flagged follow-up for iOS. **Flow:** `android/75-voice-roundtrip.yaml`.

     ### T16 — Mobile restart-persistence (full gateway restart + app relaunch)
     **Scenario:** A session's history survives a real `docker restart sentient-gateway` PLUS an app relaunch (force-stop/start) — the past-chat list (drawer) is the only place this is provable, since cold entry always lands on a blank new chat. **Flows:** `76/76b-restart-persistence-part*.yaml`.
     ```
  Also bump the mobile section's flow count note (`97 flows, refactored 2026-07-17`) to reflect the additions:
  ```diff
  -driven through the committed flow library at `qa/mobile/flows/{android,ios}/*.yaml` (97 flows, refactored 2026-07-17, commit `204f728`) via `qa/mobile/run-e2e.sh`.
  +driven through the committed flow library at `qa/mobile/flows/{android,ios}/*.yaml` (117 flows as of the 2.0 native-orchestrator E2E pass, Task 12) via `qa/mobile/run-e2e.sh`.
  ```

- [ ] **Step 45: Commit the remaining docs + run-e2e.sh wiring.**
  ```bash
  git add qa/mobile/run-e2e.sh qa/mobile/fixtures/README.md agents/docs/testing-knowledge.md
  git commit -m "docs(qa): wire the 2.0 native E2E rows into run-e2e.sh + the case library"
  ```

### Phase 9 — final full pass

- [ ] **Step 46: Run the complete default batch on both platforms (no `--tags` — full default batch + automatic fault-armed phase, per the runner's own contract).**
  ```bash
  ./qa/mobile/run-e2e.sh android --fresh-gateway
  ./qa/mobile/run-e2e.sh ios
  ```
  Expected: every flow this task touched or added is green, alongside the full pre-existing suite (this task's edits were comment-only or additive — nothing here should regress an untouched flow). Do NOT run this concurrently with Task 11's web batch (PARALLELISM CONSTRAINT, top of this task).

- [ ] **Step 47: Fix any residuals surfaced by the full-suite run, then re-run only the affected tag(s) (not the whole suite) until green.**
  ```bash
  ./qa/mobile/run-e2e.sh android --tags <affected-surface-tag>
  ```

- [ ] **Step 48: Final commit (only if Step 47 produced fixes beyond what was already committed in Steps 7/12/21/27/33/39/45).**
  ```bash
  git add -A qa/mobile/
  git commit -m "test(qa): fix residuals from the full native E2E pass"
  ```
