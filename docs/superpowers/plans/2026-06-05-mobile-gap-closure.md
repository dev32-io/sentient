# Mobile Gap-Closure — Implementation Plan (iOS + Android)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh subagent per task, spec-review then quality-review). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the functional bugs + missing affordances surfaced by on-device testing AFTER the
design-polish base (`2026-06-04-mobile-design-polish.md`, Phases 0–18) landed: silent iOS TTS on a real
device, no-typewriter/no-spinner UX gaps, blocking new-chat, Enter-sends-instead-of-newline, blank user
avatar, two-line day dividers, missing composer glow, no app icon / splash, and missing thinking-state
ring. iOS AND Android both reach webui parity + never hang/freeze.

**Branch:** `feature/mobile-client`
**Companion (base) plan:** `docs/superpowers/plans/2026-06-04-mobile-design-polish.md` (Phases 0–18 already implemented; the tasks below PATCH that shipped code or add net-new alongside it — do NOT re-run Phases 0–18).

**Architecture:** Single `StateFlow<SdkState>` surface unchanged. One shared-SDK touch (iOS audio engine,
Phase 1, `shared/mobile-sdk/src/iosMain/**`); everything else is disjoint `ios/**` vs `android/**` so the two
tracks run in parallel after Phase 1. Pure logic (send-queue, splash-gate, loading-affordance) is TDD'd; views
verified via `#Preview`/`@Preview` + the e2e matrix (Phase 14).

**Project conventions (override default TDD):** unit-test ONLY pure logic / wire / FSM / security (`.claude/rules/testing.md`) — NEVER views/tokens/constants. Files <300 lines, functions <40 (`.claude/rules/clean-code.md`). Tunable constants in design tokens, not magic numbers (`.claude/rules/config.md`). Tagged logger, no bare print/Log (`.claude/rules/logging.md`). Versions only in `gradle/libs.versions.toml` (`.claude/rules/mobile-sdk/kmp-gradle.md`).

**Build/verify (from repo root, after `source scripts/env.sh`):**
- Shared tests: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:iosSimulatorArm64Test` / `:testDebugUnitTest`.
- iOS framework: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:assembleMobileSdkDebugXCFramework`.
- iOS build/test: `cd ios && xcodegen generate && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build` (or `test -only-testing:SentientAppTests/<Suite>`).
- Android: `./gradlew :android:assembleDebug` ; unit `./gradlew :android:testDebugUnitTest --tests "<pattern>"`.
- e2e: local stack `deploy/macos` (`docker compose up -d`); Maestro `--device <udid>`; `xcrun simctl io <udid> screenshot` / `adb exec-out screencap`.

---

# iOS

## Phase 1 — iOS TTS engine fix (device-silent bug) — SHARED iosMain

> ⚠️ Touches `shared/mobile-sdk/src/iosMain/**`. Requires XCFramework rebuild; FINAL verify is DEVICE-ONLY (sim can't repro).

### Task 1.1: Defer prepare/start until the player graph is connected
**Root cause (do NOT re-investigate):** `StandalonePlaybackEngine.acquire()` (`StandalonePlaybackEngine.ios.kt:78–86`)
calls `enginePrepareGuarded/engineStartGuarded` on a FRESH `AVAudioEngine` with NO nodes connected → on a real
device `prepare()` trips the precondition `(inputNode != nullptr || outputNode != nullptr)` → NSException
(swallowed by the ObjC shim) → `acquire()` returns null → `start-failed (engine unavailable)` → no player → every
frame `enqueue-no-player` → silent. The player attach + `connect(node, to=mainMixerNode)` + `ensureRunningOn`
happens LATER in `AudioPlaybackAdapter.attachAndPlay()` (181–204), which already prepares+starts the NON-empty graph.

- [ ] **Step 1: Fix `acquire()`** — delete the `if (!engine.running) { …prepare/start… return null }` block. New body: `if (!ensureSession()) return null; active = true; log.debug("acquire", mapOf("running" to engine.running, "deferredStart" to true)); return engine`. Keep `ensureRunning()` (123–126) as the sole prepare/start site (called post-connect from the adapter).
- [ ] **Step 2:** Update the file-header NO-CRASH note: prepare/start are deferred to `ensureRunning()` after the adapter connects the player to `mainMixerNode`; the same ObjC guards apply there.
- [ ] **Step 3:** Re-read `AudioPlaybackAdapter.ios.kt` `start()`/`attachAndPlay()` to confirm no app change needed.
- [ ] **Step 4:** No unit test — platform glue, no commonTest fake (`.claude/rules/testing.md`).
- [ ] **Step 5:** `./gradlew :shared:mobile-sdk:assembleMobileSdkDebugXCFramework` then `cd ios && xcodegen generate && xcodebuild … build` → both succeed.
- [ ] **Step 6 (DEVICE):** physical iPhone, mic UNgranted, TTS on → send "say hi in 5 words" → AUDIBLE; logs `acquire deferredStart=true` → `session-open path=standalone playing=true`, NO `enqueue-no-player`.
- [ ] **Step 7:** `git commit -m "fix(mobile-sdk/ios): defer standalone-engine prepare/start until player connected (silent device TTS)"`

## Phase 2 — iOS app icon

### Task 2.1: AppIcon from the Sentient mark on `DuskColors.bg`
- [ ] Create `ios/App/Assets.xcassets/AppIcon.appiconset/{Contents.json,AppIcon-1024.png}` + `Assets.xcassets/Contents.json`; `project.yml` set `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon`.
- [ ] Render `SentientMark(size:640,.idle)` centered on opaque `Color(DuskColors.bg)` 1024² via an `ImageRenderer` helper (or rasterize `gateway/webui/public/sentient-mark.svg`). BG from token, not hex. No alpha (opaque).
- [ ] Build → no "missing AppIcon"; home-screen icon shows the mark on Dusk bg. No unit test (asset).
- [ ] `git commit -m "feat(ios): app icon — Sentient mark on the Dusk background"`

## Phase 3 — iOS in-app splash (animated speaking mark, min 2s, re-show on reconfigure)

> iOS `UILaunchScreen` is static → animated splash is an in-app SwiftUI overlay at `RootView`.

### Task 3.1: Splash overlay + min-duration + reconfigure re-show
- [ ] New `ios/App/SplashOverlay.swift`: `ZStack{ DuskColors.bg.ignoresSafeArea(); VStack(spacing:Space.lg){ SentientMark(size: SplashLayout.markSize,.speaking).overlay(AvatarRipple(active:true)); Text("Sentient").font(Typo.display(TypeScale.xl,.semibold)).foregroundStyle(DuskColors.ink) } }` a11y id `splash`.
- [ ] `SplashLayout` tokens in `Theme/Tokens.swift`: `markSize 96`, `minDisplay 2.0` (s), `fadeOut Motion.normal`.
- [ ] `RootView`: `@State showSplash=true`; `.overlay{ if showSplash SplashOverlay().transition(.opacity) }`; `.task(id: store.configGeneration){ showSplash=true; try? await Task.sleep(for:.seconds(SplashLayout.minDisplay)); withAnimation(.easeOut(duration:SplashLayout.fadeOut)){showSplash=false} }` + log show/hide.
- [ ] `SdkStore`: `@Published private(set) var configGeneration: Int = 0`, bump (+log) at end of `init` first build and end of `reconfigure(_:)`.
- [ ] Build + `#Preview`; e2e cold launch ≥2s then fade; backend change re-shows. No unit test (view/tokens).
- [ ] `git commit -m "feat(ios): in-app animated speaking splash (min 2s, reshow on reconfigure)"`

## Phase 4 — iOS always-typeable composer + async new-chat (web-sdk parity)

> Current: `ChatView` passes `canSend: status == .ready` (ChatView.swift:159); `Composer.sendEnabled` ANDs `canSend` → send dead while a new session creates. SDK `newChat()` is a blocking suspend but callers already wrap in `Task{}` — the gap is the composer gate + a send queue.

### Task 4.1: SDK send-queue (TDD pure policy)
- [ ] New `ios/App/SDK/SendQueue.swift` (pure): `SendQueueState{pending:[String]}`, `sendQueueOnSend(s,text,ready)->(state,[send-now])`, `sendQueueOnStatus(s,ready,wasReady)->(state,[drain])`.
- [ ] `SdkStore`: hold `SendQueueState`; `sendText` routes through `onSend` (queue when not ready); flush on rising edge to READY in `apply(_:)` via `onStatus`. Log queued/flush depth.
- [ ] Test `ios/Tests/SendQueueTests.swift` (4): send-when-ready, queue-when-not, drain-in-order-on-rising-edge, no-drain-when-already-ready.
- [ ] `git commit -m "feat(ios): queue outbound text until READY (web-sdk parity)"`

### Task 4.2: Ungate composer
- [ ] `ChatView` Composer call: `canSend: true` (field already always typeable; queue handles not-ready). Send button live; queued sends land on READY.
- [ ] Build; e2e tap "+" then type+send before ready → accepted (queued), lands on READY.
- [ ] `git commit -m "feat(ios): always-typeable composer (ungate send; queue handles not-ready)"`

## Phase 5 — iOS composer: Enter=newline, swipe-down dismiss, amber glow

### Task 5.1: Enter inserts newline (send = button only)  [patches base Task 7.1]
- [ ] `Composer.swift` `draftField` (92–93): DELETE `.submitLabel(.send)` and `.onSubmit(submit)`. `axis:.vertical`+`lineLimit(1...6)` → Return inserts a newline natively.
- [ ] Build; e2e Return inserts newline, field grows; only paper-plane sends.
- [ ] `git commit -m "fix(ios): Enter inserts newline in composer; send is the button only"`

### Task 5.2: Swipe-down dismisses keyboard
- [ ] `ComposerLayout.dismissDragThreshold = 24` (ComposerButtons.swift). `Composer.body`: add `DragGesture(minimumDistance: threshold).onEnded{ if $0.translation.height>threshold { inputFocused=false; log("keyboard.dismiss reason=swipe-down") } }` (`.simultaneousGesture` if it competes). Also `.scrollDismissesKeyboard(.interactively)` on the MessageList ScrollView.
- [ ] Build; e2e swipe-down hides keyboard (log present).
- [ ] `git commit -m "feat(ios): swipe-down on composer dismisses the keyboard"`

### Task 5.3: Soft amber glow halo (webui parity)
- [ ] `ComposerLayout`: `glowRadius 22`, `glowOpacity .28`, `glowListeningOpacity .45`. `Composer` card: `.shadow(color: DuskColors.amber.opacity(micActive ? glowListeningOpacity : glowOpacity), radius: glowRadius)` before the border overlay (or a blurred sibling rect in a ZStack). Color from `DuskColors.amber`.
- [ ] Build + 3 Composer `#Preview`s show the halo (brighter when mic on). Compare to the user's screenshot.
- [ ] `git commit -m "feat(ios): soft amber glow halo behind the composer (webui parity)"`

## Phase 6 — iOS avatar + divider parity

### Task 6.1: User avatar = initial on terra/amber (chat + login)  [patches base Task 5.2]
- [ ] New `ios/App/Chat/UserAvatar.swift`: `ZStack{ Circle().fill(DuskColors.accent); Text(initial).font(Typo.ui(size*UserAvatarLayout.glyphRatio,.semibold)).foregroundStyle(DuskColors.ink) }`, `UserAvatarLayout.glyphRatio = 0.5`. `initial` = first char uppercased, `"?"` when blank.
- [ ] `MessageBubble.userAvatar` (64–69, currently blank `Circle().fill(sageSoft)`) → `UserAvatar(name:userName,size:BubbleLayout.avatarSize)`. `Auth/AvatarTile.swift` login grid → same treatment, keep `login-avatar-<userId>` id.
- [ ] Build + previews; user bubble shows initial on terra; login grid terra initials. No unit test (view).
- [ ] `git commit -m "feat(ios): user avatar initials on terra/amber (chat + login)"`

### Task 6.2: Day divider one line  [patches base Task 5.2]
- [ ] `DayDivider` label `Text`: add `.lineLimit(1).fixedSize(horizontal:true,vertical:false).minimumScaleFactor(0.8)`.
- [ ] Build; e2e every "DAY · TIME" on one line at a11y3. No unit test.
- [ ] `git commit -m "fix(ios): day divider label stays on one line"`

### Task 6.3: Thinking-state avatar ring  [patches base Task 3.1]
- [ ] `MessageBubble.swift:48`: `AvatarRipple(active: avatarMode != .idle)` (was `.speaking || .listening`) — covers THINKING (`markMode(of:)` emits `.thinking` when `cognition != .idle`).
- [ ] Build + streaming previews show ring; e2e ring during "…" pre-token + speaking. No unit test.
- [ ] `git commit -m "feat(ios): avatar ring during thinking (awaiting response)"`

## Phase 7 — iOS loading states / spinners

### Task 7.1: Loading-affordance policy (TDD pure)
- [ ] New `ios/App/Chat/LoadingAffordance.swift`: `enum {none,connecting,sessionStarting}`; `chatLoading(status,cognition,hasMessages)` — connecting/authenticating→`.connecting`; ready & !hasMessages→`.sessionStarting`; ready&hasMessages / else → `.none` (disconnected/reconnecting/error owned by ConnectionBanner).
- [ ] Test `LoadingAffordanceTests.swift` (5).
- [ ] `git commit -m "feat(ios): pure loading-affordance policy bound to SDK state"`

### Task 7.2: Render affordances
- [ ] `ChatView`: overlay new `ChatLoadingView` (spinner+label "Connecting…"/"Starting a new chat…", id `chat-loading`) when `messages.isEmpty && affordance != .none`.
- [ ] `Composer`: swap paper-plane for `ProgressView` (id `chat-send-spinner`) while `sendInFlight` (`store.hasPendingSends`/`pendingSendCount`).
- [ ] `HistorySidePanel`: spinner (id `history-loading`) when `model.loading && model.visible.isEmpty`.
- [ ] Build; e2e connect / new-chat / in-flight / history spinners. No unit test (views; policy tested 7.1).
- [ ] `git commit -m "feat(ios): loading affordances — connect, session-starting, in-flight send, history"`

---

# Android

## Phase 8 — Android launcher icon (adaptive)

### Task 8.1: Adaptive icon from the Sentient mark on `Colors.bg`
- [ ] `res/values/colors.xml` `ic_launcher_background = #2B2621` (mirror of `Colors.bg 0xFF2B2621`, with sync comment). `res/drawable/ic_launcher_foreground.xml` (port `gateway/webui/public/sentient-mark.svg` gradients/orbits, inside 72dp safe zone). `res/mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml` (`<adaptive-icon>` bg=color, fg=drawable). `AndroidManifest.xml` `<application>` add `android:icon`/`android:roundIcon`.
- [ ] `./gradlew :android:assembleDebug`; verify squircle+round masks unclipped. No unit test (resource).
- [ ] `git commit -m "feat(android): adaptive launcher icon (Sentient mark on Colors.bg)"`

## Phase 9 — Android animated splash (speaking avatar, min 2s)

### Task 9.1: core-splashscreen handoff + in-app animated overlay
- [ ] `gradle/libs.versions.toml`: add `androidx-core-splashscreen = "1.0.1"` (version + library; no literal in build file). `android/build.gradle.kts`: `implementation(libs.androidx.core.splashscreen)`.
- [ ] `res/values/themes.xml` `Theme.Sentient.Splash` (parent `Theme.SplashScreen`, bg=`@color/ic_launcher_background`, animatedIcon=fg, post=DeviceDefault.NoActionBar); manifest `<application android:theme>` → it. `MainActivity`: `installSplashScreen()` before `setContent`, keep-on-screen until first frame.
- [ ] New `chat/SplashGate.kt` (pure): `SPLASH_MIN_MS=2000`, `splashVisible(shownAtMs,nowMs,minMs,ready) = (now-shown)<min || !ready`. Test `SplashGateTest.kt` (3).
- [ ] New `chat/AppSplashOverlay.kt`: `AnimatedVisibility(visible, exit=fadeOut){ Box(bg=Colors.bg, center){ SentientMark(96.dp, SPEAKING); AvatarRipple(active=true) } }` testTag `app-splash`.
- [ ] `AppRoot`: collect `sdkFlow`; `shownAtMs` reset on `LaunchedEffect(sdk)` (rebuild → null→fresh resets the clock); tick `nowMs` until floor; `AppSplashOverlay(visible = splashVisible(shownAtMs,nowMs,ready=configured))`. Tagged `splash` logger (show {trigger:cold|rebuild} / hide).
- [ ] `./gradlew :android:assembleDebug` + unit; e2e cold start animated ≥2s; backend change re-shows.
- [ ] `git commit -m "feat(android): animated speaking-avatar splash (min 2s, reshow on backend change)"`

## Phase 10 — Android async new-chat / always-typeable composer

### Task 10.1: Composer always typeable; send queues until READY  [web-sdk parity]
- [ ] New `chat/PendingSend.kt` (pure): `data class PendingSend(text){ enqueue(next)=copy(text=next); flushIfReady(status)= if(status==READY) text else null }` (latest-wins). Test `PendingSendTest.kt` (3).
- [ ] `Composer.submit()`: drop the `!canSend` send-drop → only empty-guard; `onSend(trimmed)` always fires; `sendEnabled = draft.isNotEmpty()` (drop `&& canSend`); keep `canSend` for glyph tint only.
- [ ] `ChatScreen`: own `pending`; `handleSend = if READY onSend else pending = pending?.enqueue(text) ?: PendingSend(text)`; `LaunchedEffect(status){ pending?.flushIfReady(status)?.let{ onSend(it); pending=null } }`. Wire `onSend=handleSend`.
- [ ] `./gradlew :android:assembleDebug` + unit; e2e new-chat instant typeable; pre-READY send dispatches at READY.
- [ ] `git commit -m "feat(android): always-typeable composer + queued send until READY (web-sdk parity)"`

## Phase 11 — Android composer: Enter=newline, swipe-down dismiss, amber glow

### Task 11.1: Enter inserts newline + swipe-down dismiss  [patches base Task 16.1]
- [ ] `ComposerField.kt` `DraftField`: DELETE `keyboardOptions = KeyboardOptions(imeAction=ImeAction.Send)` + `keyboardActions = KeyboardActions(onSend={onSubmit()})` + the `onSubmit` param; set `keyboardOptions = KeyboardOptions(imeAction=ImeAction.Default)` (multiline `maxLines=6` → Enter inserts `\n`). Drop `onSubmit=` from the `Composer` call site + unused imports.
- [ ] `Composer`: `SWIPE_DISMISS_DP=24`; `.pointerInput(Unit){ detectVerticalDragGestures(onDragEnd reset; onVerticalDrag accumulate dy → > thresholdPx → focusManager.clearFocus(); log "keyboardDismiss {gesture:swipeDown}") }`.
- [ ] Build; e2e Enter→newline; send via button; swipe-down hides keyboard.
- [ ] `git commit -m "fix(android): composer Enter=newline (send via button only) + swipe-down to dismiss"`

### Task 11.2: Soft amber glow halo
- [ ] `theme/Tokens.kt` new `ShadowTokens(composerGlowRadius 26.dp, composerGlowRadiusListening 48.dp, composerGlowYOffset 8.dp, composerGlowAlpha .22f, composerGlowAlphaListening .40f)` on `SentientTokens.shadow` (values from webui `.composer`/`.composer--listening` + `--shadow-2`).
- [ ] `Composer.composerGlow(listening,tokens)` = `drawBehind{ drawRoundRect(Brush.verticalGradient of Color(Colors.accent).alpha…, topLeft y-offset, corner = COMPOSER_RADIUS+radius) }`, inserted BEFORE `.clipCard(listening=micActive)`. Intensify on listening.
- [ ] Build + `@Preview` idle/listening; e2e halo intensifies with mic.
- [ ] `git commit -m "feat(android): soft amber composer glow halo (webui parity)"`

## Phase 12 — Android user-avatar parity + single-line day divider

### Task 12.1: Initials avatar (chat + login) + one-line divider  [patches base Task 14.2]
- [ ] New `chat/InitialAvatar.kt`: `Box(size, clip CircleShape, bg=Color(Colors.accent50)){ Text(initialOf(name), color=Colors.ink, SemiBold) }`, `initialOf` = first char uppercased / `"?"`.
- [ ] `MessageBubble.BubbleAvatar` user branch (currently blank `Colors.sageSoft`) → `InitialAvatar(name=userName, bg=Colors.accent50)` (thread `userName`). `auth/AvatarTile.kt` reuse `InitialAvatar(bg=tintColor(slug))`, keep `login-avatar-<id>` tag, delete dup `initialOf`.
- [ ] `chat/DayDivider.kt` label `Text`: add `maxLines=1, softWrap=false, overflow=TextOverflow.Visible`.
- [ ] Build; e2e user initial on terra; login parity; divider one line.
- [ ] `git commit -m "feat(android): initials user avatar (chat + login) + single-line day divider"`

## Phase 13 — Android thinking-state ring + loading affordances

### Task 13.1: Thinking ring + connecting/sending/history spinners  [patches base Task 12.1]
- [ ] `MessageBubble.BubbleAvatar`: `AvatarRipple(active = SPEAKING || LISTENING || THINKING)`.
- [ ] New `chat/LoadingState.kt` (pure): `enum {NONE,CONNECTING,SENDING}`; `loadingAffordance(status,connectionLost,hasPending)` — hasPending→SENDING; connectionLost→NONE (banner owns); CONNECTING/AUTHENTICATING→CONNECTING; else NONE. Test `LoadingStateTest.kt` (4).
- [ ] `ChatScreen`: `LoadingPill` (CircularProgressIndicator 14dp + "Connecting…"/"Sending…", testTag `loading-<name>`) bound to the mapping (session-creating surfaces as CONNECTING). `HistoryDrawer`: `history-loading` spinner when loading + empty (add `loading` to the VM UiState if absent).
- [ ] Build + unit; e2e thinking ring; connecting/sending/history spinners.
- [ ] `git commit -m "feat(android): thinking-state avatar ring + connecting/sending/history loading affordances"`

---

# Phase 14 — Verification (e2e, agentic)

Drive Maestro / `simctl` / `adb` against the local stack (`deploy/macos`). Text cases free; voice/audio
cases short-prompt only. Capture screenshots + log trails; diff against webui + cross-platform parity.
DEVICE-ONLY cases (the original repro) are flagged for the user's physical iPhone.

### Task 14.1: iOS matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|-----------------------|--------------------|
| TTS audible (DEVICE) | iPhone device | text chat, mic NOT granted, TTS on | send "say hi in 5 words" | reply AUDIBLE | `acquire deferredStart=true`→`session-open path=standalone playing=true`; NO `enqueue-no-player` |
| TTS no-regress (sim) | iPhone 16 sim | text chat, TTS on | send short prompt | runs, no crash (may be silent on sim) | `start path=standalone`; no SIGABRT |
| App icon | home screen | installed | view | Sentient mark on Dusk bg | — |
| Splash min-2s | iPhone 16 | cold launch | launch | speaking mark+wordmark ≥2s then fade | `splash.show generation=1` … `splash.hide` |
| Splash re-show | iPhone 16 | logged in | change backend, save | splash re-appears | `configGeneration -> N` then `splash.show generation=N` |
| Async new-chat typeable | iPhone 16 | in chat | tap "+", type+send immediately | field live; msg accepted, lands on READY | `sendText queued`→`sendText flush count=1` |
| Enter = newline | iPhone 16 | composer focused | press Return | newline; field grows; NO send | (no send log) |
| Swipe-down dismiss | iPhone 16 | keyboard up | swipe down on composer | keyboard hides | `keyboard.dismiss reason=swipe-down` |
| Composer glow | iPhone 16 | idle / mic on | observe | amber halo; brighter when mic on | — |
| User avatar initial | iPhone 16 | user msg (name "Alice") | observe | "A" on terra circle | — |
| Login avatar initial | iPhone 16 | login grid | observe | terra initials | — |
| Day divider 1 line | iPhone 16, a11y3 | multi-day history | scroll | each "DAY · TIME" one line | — |
| Thinking ring | iPhone 16 | in chat | send prompt | ring during "…" pre-token + speaking | `cognition IDLE->THINKING` |
| Connecting spinner | iPhone 16 | cold launch | launch | "Connecting…" until READY | `status CONNECTING->…->READY` |
| Session-starting | iPhone 16 | in chat | tap "+" | "Starting a new chat…" briefly | `newChat`→`session.created` |
| In-flight send | iPhone 16 | not-ready window | type+send | paper-plane→spinner until READY | `sendText queued`→`flush` |
| History loading | iPhone 16 | panel never opened | open panel | `history-loading` spinner then rows | `refresh`→`listSessions` |
| Typewriter (regress) | iPhone 16 | in chat | send prompt | streamed reply reveals progressively, no cursor | — |
| Autoscroll pin/unpin (regress) | iPhone 16 | long chat | scroll up mid-stream; back to bottom | holds, then re-pins | — |

### Task 14.2: Android matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|-----------------------|--------------------|
| Launcher icon | Pixel launcher | installed | view (squircle+round) | terra mark on `#2B2621`, orbits unclipped | — |
| Cold-start splash | Compact | killed | cold launch | static icon → animated speaking avatar ≥2s → login/chat | `splash.show {trigger:cold}` … `splash.hide` |
| Splash reshow | Compact | in chat | change backend, save | animated splash re-shows ≥2s | `splash.show {trigger:rebuild}` after sdkFlow flip |
| New-chat typeable | Compact | READY | tap "+", type immediately | field accepts text, no block during swap | `newChat`; no send-drop warn |
| Queued send flush | Compact | new chat, CONNECTING | type "hi"+send | field clears; "Sending…"; dispatch at READY | `sendText {len:2}` on READY edge |
| Enter = newline | Compact | composer focused | press Enter | caret→line 2; NO send | — |
| Send via button | Compact | 2-line draft | tap send | multiline sent | `sendText` |
| Swipe-down dismiss | Compact | keyboard up | swipe down on composer | keyboard hides, draft kept | `keyboardDismiss {gesture:swipeDown}` |
| Composer glow | Compact | READY / mic on | observe | amber halo; intensifies listening | `startMic` (listening) |
| User avatar initial | Compact | user msg | observe meta | initial on terra circle | — |
| Login avatar parity | Compact | login grid | observe | tinted initials (shared InitialAvatar) | — |
| Day divider 1 line | Small | multi-day history | scroll | "TODAY · 3:14 PM" one line | — |
| Thinking ripple | Compact | send prompt | observe avatar | ring while THINKING | cognition→THINKING |
| Connecting pill | Compact | fresh launch | observe | "Connecting…" (no banner) | DISCONNECTED→CONNECTING |
| Sending pill | Compact | pre-READY send | send | "Sending…" until dispatch | queued `sendText` |
| History loading | Compact | drawer pre-load | open | spinner then rows | VM loading→loaded |

- [ ] iOS sim/Maestro cases green; DEVICE cases handed to user (TTS audible, voice AEC).
- [ ] Android emulator/Maestro cases green.
- [ ] `git add qa/{ios,android}/charters && git commit -m "test(mobile): gap-closure Maestro flows + screenshots"`

---

## Folded edits to base-plan tasks (plan hygiene — real code change happens in the new phase above)
- iOS base Task 3.1 → Task 6.3 (ripple `active: avatarMode != .idle`); base Task 5.2 → 6.1 (user avatar = `UserAvatar`) + 6.2 (divider one-line); base Task 7.1 → 5.1 (drop `.submitLabel(.send)/.onSubmit`).
- Android base Task 12.1 → 13.1 (ripple += THINKING); base Task 14.2 → 12.1 (InitialAvatar + divider one-line); base Task 16.1 → 11.1 (Enter=newline).

## Parallelism
Phase 1 (shared iosMain) lands first (XCFramework rebuild). After that, iOS (2–7) ∥ Android (8–13) touch disjoint trees. Phase 14 verifies both. Within a platform, run phases in order.
