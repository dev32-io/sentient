# Mobile Chat Fixes (Bugs 1–5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five native-chat defects — live typewriter + live tool pills + THINKING ring + no 1969 date (Bugs 3+4), drawer drag rebuilt on a SwiftUI foundation (Bug 1), terminal-WS-auth routes to login (Bug 5), composer clears on send (Bug 2).

**Architecture:** Live reveal+drain becomes **data-layer state** in `mobile-data` (pure reducer + clock-injected ticker); bubbles render the *revealed substring* (no view typewriter). `cognition` is projected onto `ConnectionState` for the ring. The drawer is rebuilt as **SwiftUI rendering + a thin `UIPanGestureRecognizerRepresentable`** (iOS 18) — no `UIViewController`, so layout passes can't clobber the drag. Terminal auth rejection sets `authExpired`. No gateway change.

**Tech Stack:** Kotlin Multiplatform (coroutines Flow), `mobile-data`/`mobile-sdk`, SwiftUI + iOS-18 `UIGestureRecognizerRepresentable`, Jetpack Compose, Maestro e2e.

**Sequence:** Phase 1 (Bugs 3+4, shared+both platforms) → Phase 2 (Bug 1 drawer, iOS) → Phase 3 (Bug 5 auth, shared+both) → Phase 4 (Bug 2 composer, iOS). Each task is independently committable.

**Test doctrine (project override of blanket TDD):** Unit-test ONLY pure logic at a real boundary — the reveal/drain reducer (FSM/invariant) and the auth-error classifier (security boundary). Cognition projection, UI rendering, drawer, pills, composer → verified via the Maestro e2e matrix, NOT unit tests (`testing.md`/`e2e-testing.md`: never test wiring/UI). **Before any iOS verification: rebuild the KMP XCFramework and build the sim app SIGNED** (no `CODE_SIGNING_ALLOWED=NO` — that strips the keychain entitlement → `-34018` → empty token → auth fails).

**Constants/devices:** iOS sim `2BB144EC-281C-4E5E-883F-65A21EF67056` (iPhone 14 Pro, iOS 26.5). Android emulator `emulator-5554`. App id `io.dev32.sentient.debug`. Maestro `~/.maestro/bin/maestro`. Login: Kevin avatar `login-avatar-u_8c866990`, PIN `1234`.

---

## File structure

**Phase 1 (shared + iOS + Android):**
- `shared/mobile-data/.../repository/Reveal.kt` *(new)* — pure rate fn + `RevealEvent`.
- `shared/mobile-data/.../repository/ChatRepository.kt` — `LiveState`/`LiveBubble`, `reduce` (+`RevealTick`,drain), ticker, `chatStream`.
- `shared/mobile-data/src/commonTest/.../repository/LiveRevealReducerTest.kt` *(new)*.
- `shared/mobile-data/.../model/ChatModel.kt` — `messagesForUi()` reads revealed substring.
- `shared/mobile-sdk/.../sdk/SdkState.kt` — `ConnectionState += cognition`.
- `shared/mobile-sdk/.../sdk/StateDeriver.kt` — `deriveConnection()` projects cognition.
- iOS: `ios/App/Chat/message/{MessageBubble,BubbleAnimations,ChatRows,DayDivider,MessageMeta,MessageList}.swift`, `ChatView.swift`.
- Android: `android/.../chat/message/{MessageBubble,Typewriter,ChatRows,MessageMeta}.kt`, `chat/{ChatContent,MessageList}.kt`.
- DI: `android/.../sdk/SdkSessionFactory.kt` + iOS `createMobileSession` — pass `Clock` to `ChatRepository`.

**Phase 2 (iOS):**
- `ios/project.yml` — `deploymentTarget.iOS: "18.0"`.
- `ios/App/Chat/drawer/SideDrawer.swift` — REPLACE with SwiftUI render + gesture.
- `ios/App/Chat/drawer/DrawerPanGesture.swift` *(new)* — `UIPanGestureRecognizerRepresentable` bridge.
- DELETE `ios/App/Chat/drawer/SideDrawerController.swift`.

**Phase 3 (shared + both):**
- `shared/mobile-sdk/.../sdk/Handshake.kt` + the orchestrator/lifecycle (`SdkLifecycle.kt`) — classify terminal auth.error.
- `shared/mobile-sdk/.../sdk/AuthErrorClass.kt` *(new)* — pure classifier (terminal vs transient).
- `shared/mobile-sdk/src/commonTest/.../sdk/AuthErrorClassTest.kt` *(new)*.

**Phase 4 (iOS):**
- `ios/App/Chat/composer/Composer.swift` — reliable clear on submit.

---

## PHASE 1 — Live in-flight bubble (Bugs 3+4)

### Task 1: Pure reveal + drain reducer (mobile-data)

**Files:** Create `repository/Reveal.kt`; modify `repository/ChatRepository.kt` (`LiveState`+`reduce`); test `commonTest/.../LiveRevealReducerTest.kt`.

Design: `LiveState` carries cumulative full text + `revealed` count + `phase`. `MessageStarted` seeds streaming; `MessageDelta` appends; `RevealEvent.Tick(nowMs)` advances `revealed` at the ported webui rate; `MessageCommitted` enters `DRAINING` (does NOT drop the bubble or clear tasks) and only settles to idle once `revealed >= full.length`. UI reads `full.take(revealed)`.

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.mobiledata.repository

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobiledata.repository.ChatRepository.Companion.reduce
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LiveRevealReducerTest {
    private val C = "cycle-1"

    @Test fun `delta accumulates full text but reveal lags`() {
        var s = reduce(LiveState(), SdkEvent.MessageStarted(C))
        s = reduce(s, SdkEvent.MessageDelta(C, "Hello world"))
        assertEquals("Hello world", s.live?.fullContent)
        assertEquals(0, s.live?.revealed)
        assertEquals("", s.visibleContent())
    }

    @Test fun `reveal tick advances visible toward full at the rate`() {
        var s = reduce(LiveState(), SdkEvent.MessageStarted(C))
        s = reduce(s, SdkEvent.MessageDelta(C, "abcdefghij"))
        s = reduce(s, RevealEvent.Tick(nowMs = 1_000))
        s = reduce(s, RevealEvent.Tick(nowMs = 1_100)) // +100ms @ >=30ch/s => >=3
        assertTrue((s.live?.revealed ?: 0) in 3..10)
        assertEquals(s.live?.revealed, s.visibleContent().length)
    }

    @Test fun `commit drains - bubble persists until reveal catches up`() {
        var s = reduce(LiveState(), SdkEvent.MessageStarted(C))
        s = reduce(s, SdkEvent.MessageDelta(C, "abcde"))
        s = reduce(s, SdkEvent.MessageCommitted(committedAssistant(C, "abcde")))
        assertTrue(s.live != null, "bubble dropped before reveal completed")
        assertEquals(LivePhase.DRAINING, s.live?.phase)
        s = reduce(s, RevealEvent.Tick(nowMs = 1_000))
        s = reduce(s, RevealEvent.Tick(nowMs = 5_000)) // large dt drains fully
        assertNull(s.live, "bubble not cleared after full reveal during drain")
    }

    @Test fun `tasks survive into drain`() {
        var s = reduce(LiveState(), SdkEvent.MessageStarted(C))
        s = reduce(s, SdkEvent.TaskUpserted(task(C, "t1", "running")))
        s = reduce(s, SdkEvent.MessageDelta(C, "x"))
        s = reduce(s, SdkEvent.MessageCommitted(committedAssistant(C, "x")))
        assertEquals(1, s.tasks.size)
    }
}
```

(`committedAssistant`/`task` build `ChatMessage`/`TaskSnapshotItem` via existing constructors — see `SdkState.kt`.)

- [ ] **Step 2: Run, verify it fails** — `./gradlew :shared:mobile-data:allTests` → FAIL (unresolved `fullContent`/`revealed`/`phase`/`RevealEvent`/`visibleContent`).

- [ ] **Step 3: Create `Reveal.kt`**

```kotlin
package io.sentient.mobiledata.repository

sealed class RevealEvent { data class Tick(val nowMs: Long) : RevealEvent() }

/** Typewriter pacing — ports webui src/config/typewriter.ts. Pure. */
object RevealRate {
    const val BASE = 30.0; const val MIN = 15.0; const val MAX = 150.0; const val GAP_GAIN = 0.02
    fun advance(revealed: Int, fullLen: Int, dtMs: Long, drain: Boolean): Int {
        if (revealed >= fullLen) return 0
        val gap = (fullLen - revealed).toDouble()
        val rate = if (drain) MAX else (BASE * (1 + gap * GAP_GAIN)).coerceIn(MIN, MAX)
        return (rate * dtMs / 1000.0).toInt().coerceAtMost(fullLen - revealed)
    }
}

enum class LivePhase { STREAMING, DRAINING }
```

- [ ] **Step 4: Extend `LiveState` + `reduce` in `ChatRepository.kt`**

```kotlin
data class LiveState(
    val live: LiveBubble? = null,
    val tasks: List<TaskSnapshotItem> = emptyList(),
    val lastTickMs: Long = 0,
) { fun visibleContent(): String = live?.let { it.fullContent.take(it.revealed) } ?: "" }

data class LiveBubble(val cycleId: String, val fullContent: String, val revealed: Int, val phase: LivePhase)

// companion reduce — fold both SdkEvent and RevealEvent:
fun reduce(s: LiveState, e: Any): LiveState = when (e) {
    is SdkEvent.MessageStarted -> s.copy(live = LiveBubble(e.cycleId, "", 0, LivePhase.STREAMING), tasks = emptyList())
    is SdkEvent.MessageDelta -> {
        val cur = s.live ?: LiveBubble(e.cycleId, "", 0, LivePhase.STREAMING)
        s.copy(live = cur.copy(fullContent = cur.fullContent + e.chunk))
    }
    is SdkEvent.TaskUpserted -> s.copy(tasks = upsert(s.tasks, e.task))
    is SdkEvent.MessageCommitted -> s.copy(live = s.live?.copy(phase = LivePhase.DRAINING))
    is RevealEvent.Tick -> {
        val cur = s.live ?: return s
        val dt = if (s.lastTickMs == 0L) 0 else e.nowMs - s.lastTickMs
        val revealed = cur.revealed + RevealRate.advance(cur.revealed, cur.fullContent.length, dt, cur.phase == LivePhase.DRAINING)
        val done = cur.phase == LivePhase.DRAINING && revealed >= cur.fullContent.length
        s.copy(live = if (done) null else cur.copy(revealed = revealed), tasks = if (done) emptyList() else s.tasks, lastTickMs = e.nowMs)
    }
    else -> s
}
```

- [ ] **Step 5: Run tests** → PASS. **Step 6: Commit** — `git commit -am "feat(mobile-data): reveal+drain live bubble state (pure reducer)"`

### Task 2: Reveal ticker + chatStream wiring (mobile-data)

**Files:** `ChatRepository.kt` (clock param, ticker, `chatStream`), `ChatModel.kt`, DI factories.

- [ ] **Step 1:** Add `clock: Clock` (`io.sentient.mobilesdk.util.Clock`) constructor param; launch a sibling ticker beside the existing event collector:

```kotlin
scope.launch {
    while (true) {
        if (liveState.value.live != null) liveState.value = reduce(liveState.value, RevealEvent.Tick(clock.nowMs()))
        delay(REVEAL_TICK_MS) // 16
    }
}
```

- [ ] **Step 2:** `chatStream`/`ChatModel.messagesForUi()` build the in-flight bubble from `visibleContent()` + `streaming=true` + `cycleId` + `tasks`, and **carry no `ts`** (the streaming bubble has no timestamp). Update every `LiveState.live` read (type changed `ChatMessage?`→`LiveBubble?`).
- [ ] **Step 3:** Pass the platform `Clock` into `ChatRepository` in `android/.../sdk/SdkSessionFactory.kt` and the iOS `createMobileSession` wiring.
- [ ] **Step 4: Build** — `./gradlew :shared:mobile-data:compileKotlinIosArm64 :shared:mobile-data:compileDebugKotlinAndroid` → SUCCESS. **Step 5: Commit** — `"feat(mobile-data): clock-driven reveal ticker; chatStream exposes revealed text"`

### Task 3: Project cognition into ConnectionState (mobile-sdk)

**Files:** `SdkState.kt` (`ConnectionState`), `StateDeriver.kt` (`deriveConnection`).

- [ ] **Step 1:** Add `val cognition: CognitionState = CognitionState.IDLE` to `ConnectionState`.
- [ ] **Step 2:** In `deriveConnection()` add `cognition = cognition,` (the slice already exists at `StateDeriver` line ~67, updated by `CognitionStatusConnector`).
- [ ] **Step 3: Build** both targets → SUCCESS. **Step 4: Commit** — `"feat(mobile-sdk): surface cognition on ConnectionState"` (no unit test — one-field projection = wiring; verified by the ring e2e row).

### Task 4: iOS bubble — reveal substring, no streaming time, ring, live pills

**Files:** `MessageBubble.swift`, `BubbleAnimations.swift`, `ChatRows.swift`, `DayDivider.swift`, `MessageMeta.swift`, `MessageList.swift`, `ChatView.swift`.

- [ ] **Step 1:** Remove `StreamingText`'s `TimelineView`/`typewriterTick` reveal in `BubbleAnimations.swift`; the bubble renders `message.content` directly (already the revealed substring). Streaming-empty keeps `PulseDots`.
- [ ] **Step 2:** `ChatRows.swift` skips the day-divider for `message.streaming` rows; `MessageMeta.swift` hides the timestamp when `message.streaming`.
- [ ] **Step 3:** In `ChatView.swift`, extend `markModeOfConnection(connection)` to map `connection.cognition == .thinking || .acting` → active (thinking) `MarkMode` (in addition to the voice axis). The streaming bubble's `AvatarRipple(active: avatarMode != .idle)` then animates during THINKING.
- [ ] **Step 4:** Confirm `ToolPillStrip(tools: message.tools)` shows on the streaming bubble (tasks now delivered no-loss).
- [ ] **Step 5: Rebuild XCFramework + sign + install:**

```bash
./gradlew :shared:mobile-data:assembleDebugIosSimulatorFatFrameworkForMobileDataXCFramework
cd ios && xcodegen generate
xcodebuild -project SentientApp.xcodeproj -scheme SentientApp -destination 'id=2BB144EC-281C-4E5E-883F-65A21EF67056' -configuration Debug build
xcrun simctl install 2BB144EC-281C-4E5E-883F-65A21EF67056 "$(ls -d ~/Library/Developer/Xcode/DerivedData/SentientApp-*/Build/Products/Debug-iphonesimulator/SentientApp.app | head -1)"
```

- [ ] **Step 6: Commit** — `"feat(ios): live in-flight bubble — data-driven reveal, no streaming timestamp, THINKING ring"`

### Task 5: Android bubble — mirror Task 4

**Files:** `chat/message/{MessageBubble,Typewriter,ChatRows,MessageMeta}.kt`, `chat/{ChatContent,MessageList}.kt`.

- [ ] **Step 1:** Bubble renders the revealed substring (`message.content`); remove the Compose `Typewriter` reveal.
- [ ] **Step 2:** Streaming rows → no `DayDivider`, no `MessageMeta` time.
- [ ] **Step 3:** Mark-mode/ring keys off `connection.cognition` (thinking/acting) + voice axis.
- [ ] **Step 4: Build** — `./gradlew :android:compileDebugKotlin :android:testDebugUnitTest` → PASS. **Step 5: Commit** — `"feat(android): live in-flight bubble — data-driven reveal, no streaming timestamp, THINKING ring"`

---

## PHASE 2 — Drawer SwiftUI rebuild (Bug 1)

Root cause: the UIKit `SideDrawerController.viewDidLayoutSubviews` resets the drawer position to the static `isOpen` state on every layout pass; SwiftUI churns layout mid-gesture → drag offset overwritten (open jumps, close impossible). Rebuild in SwiftUI; layout can't clobber SwiftUI state.

### Task 6: Bump deployment target to iOS 18

**Files:** `ios/project.yml`.

- [ ] **Step 1:** Set `options.deploymentTarget.iOS: "18.0"`.
- [ ] **Step 2:** `cd ios && xcodegen generate` → regenerates project. **Step 3: Commit** — `"chore(ios): raise deployment target to iOS 18 (UIGestureRecognizerRepresentable)"`

### Task 7: SwiftUI drawer + pan-gesture bridge

**Files:** Create `ios/App/Chat/drawer/DrawerPanGesture.swift`; replace `ios/App/Chat/drawer/SideDrawer.swift`; DELETE `ios/App/Chat/drawer/SideDrawerController.swift`.

- [ ] **Step 1:** Create `DrawerPanGesture` conforming to `UIGestureRecognizerRepresentable`, wrapping a `UIPanGestureRecognizer`:
  - `makeUIGestureRecognizer` → `UIPanGestureRecognizer`.
  - `makeCoordinator` → a `UIGestureRecognizerDelegate` that: `gestureRecognizerShouldBegin` returns `abs(translation.x) > abs(translation.y)` (use **translation**, not the begin-velocity the old code used) so vertical list scroll passes through; `shouldRecognizeSimultaneouslyWith` returns `true`.
  - `handleUIGestureRecognizerAction` → on `.changed` write `translation.x` to a bound `dragX`; on `.ended` call an `onEnd(translationX, velocityX)` closure.
- [ ] **Step 2:** Rewrite `SideDrawer<Content, Drawer>` as a SwiftUI `ZStack`: content; a dim `Color.black.opacity(progress * dimMax)` (tap-to-close, `allowsHitTesting(progress>0)`); the drawer `.frame(width:).offset(x: drawerX)`. `drawerX`/`progress` derive from a `@State openFraction: CGFloat` (0…1) + the live `dragX` from `DrawerPanGesture`. Attach the gesture via `.gesture(DrawerPanGesture(...))` on a left-edge strip overlay (open) and on the drawer+dim (close).
- [ ] **Step 3:** On gesture end, snap: `shouldOpen = abs(velocityX) > 350 ? velocityX > 0 : openFraction > 0.5`; `withAnimation(.snappy) { openFraction = shouldOpen ? 1 : 0 }`. Keep the `$drawerOpen` Binding in sync (set true on open-settle for the host's `onOpen` refresh; false on close).
- [ ] **Step 4:** Delete `SideDrawerController.swift`; `cd ios && xcodegen generate`.
- [ ] **Step 5: Build + install** (XCFramework already current from Phase 1; signed build) per Task 4 Step 5 commands.
- [ ] **Step 6: Commit** — `"feat(ios): rebuild side drawer in SwiftUI with UIGestureRecognizerRepresentable (interactive drag + velocity snap)"`

---

## PHASE 3 — Terminal auth → login (Bug 5)

Root cause: terminal WS `auth.error` (auth-required / token-validation-failed / user-not-found) is treated as a retryable drop (reconnect loop) → user sits in a typable chat. Map terminal auth failures to `authExpired` (RootView already logs out on it); leave transient network drops on the reconnect path.

### Task 8: Auth-error classifier (mobile-sdk) + test

**Files:** Create `shared/mobile-sdk/.../sdk/AuthErrorClass.kt`; test `commonTest/.../sdk/AuthErrorClassTest.kt`.

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.mobilesdk.sdk
import kotlin.test.Test; import kotlin.test.assertTrue; import kotlin.test.assertFalse
class AuthErrorClassTest {
    @Test fun `token + user errors are terminal`() {
        assertTrue(isTerminalAuthError("auth-required"))
        assertTrue(isTerminalAuthError("token-validation-failed"))
        assertTrue(isTerminalAuthError("user-not-found"))
    }
    @Test fun `unknown codes are not terminal (stay retryable)`() {
        assertFalse(isTerminalAuthError("rate-limited"))
        assertFalse(isTerminalAuthError(null))
    }
}
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement**

```kotlin
package io.sentient.mobilesdk.sdk
private val TERMINAL_AUTH_CODES = setOf("auth-required", "token-validation-failed", "user-not-found")
fun isTerminalAuthError(code: String?): Boolean = code != null && code in TERMINAL_AUTH_CODES
```

- [ ] **Step 4: Run → PASS.**

### Task 9: Wire terminal auth → authExpired (mobile-sdk orchestrator)

**Files:** `Handshake.kt` (auth.error path) + the orchestrator/lifecycle (`SdkLifecycle.kt`). READ both before editing to find where `auth.error` currently triggers the reconnect transition and where `authExpired` is set.

- [ ] **Step 1:** On `auth.error`, if `isTerminalAuthError(code)` → set the connection slice `authExpired = true` (clear token/hasSession) and DO NOT schedule a reconnect; else keep the existing reconnect behavior.
- [ ] **Step 2:** Confirm `RootView` (iOS) + the Android nav gate already route to login on `authExpired` (they do — `AppConfiguredRoot`/`RootView` log out on `connection.authExpired`). No nav change expected.
- [ ] **Step 3: Build** both targets → SUCCESS. **Step 4: Commit** — `"fix(mobile-sdk): terminal WS auth rejection sets authExpired (route to login), not reconnect loop"`

---

## PHASE 4 — Composer clear on send (Bug 2)

### Task 10: Reliable draft clear (iOS)

**Files:** `ios/App/Chat/composer/Composer.swift` (`submit()`).

Root cause: `draft = ""` can fail to redraw the focused multiline `TextField(axis:.vertical)` until a focus change. Make the clear reliable.

- [ ] **Step 1:** In `submit()`, after `onSend(trimmed)`, clear and force the field to re-sync by resigning focus on send:

```swift
func submit() {
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, canSend else { return }
    onSend(trimmed)
    draft = ""
    inputFocused = false   // guarantees the multiline field redraws empty (defeats the focus/IME race)
}
```

- [ ] **Step 2:** Confirm Android composer (`android/.../chat/composer/Composer*.kt`) clears reliably (Compose `TextField` clears on state change — expected no change); note if a parallel fix is needed.
- [ ] **Step 3: Build + install** (signed). **Step 4: Commit** — `"fix(ios): clear composer draft reliably on send (resign focus to defeat multiline redraw race)"`

---

## Final verification — E2E (Maestro, both platforms)

Run the full spec e2e matrix. Pre-state: stack healthy, sim/emulator booted, fresh SIGNED debug build installed, XCFramework rebuilt.

- [ ] Live typewriter — `"..."` then progressive reveal, no jump. Trail: `cycle.started`→`message.delta`→`cycle.completed`.
- [ ] Live tool pill — web-search prompt → pill `running`→`done` on the in-flight bubble. Trail: `task.update running`→`finished` mid-cycle.
- [ ] Think ring — ring animates during `"..."`. Trail: cognition `IDLE→THINKING→IDLE`.
- [ ] No-1969 — in-flight bubble: no separator, no timestamp until commit.
- [ ] Auth-terminal — terminal token rejection → error + login (not typable chat). Trail: `auth.error` terminal → token cleared.
- [ ] Transient drop — WS drop → stays in chat with reconnect banner (unchanged). Trail: `RECONNECTING`, no token clear.
- [ ] Composer clear — focused, typed, Send → field clears immediately.
- [ ] Drawer open-drag — left-edge swipe partial+release: tracks finger; <50%&slow → snaps closed; >50%/fast → opens.
- [ ] Drawer close-drag — drag open drawer left+release: tracks; snaps closed; inner list still scrolls vertically.
- [ ] Drawer scroll coexist — vertical scroll inside panel: list scrolls, drawer doesn't move.
- [ ] Pre-handover gate: every row green both platforms, `bun run`-side lint/typecheck N/A (mobile), `:android` unit tests + `mobile-data`/`mobile-sdk` `allTests` green, signed artifacts built, evidence captured under the mobile QA dir.

---

## Self-review notes
- Spec coverage: Bug4 → T1,2,4,5; Bug3 ts → T2/T4.2/T5.2; Bug3 ring → T3,4.3,5.3; Bug1 → T6,7; Bug5 → T8,9; Bug2 → T10. ✓ All matrix rows mapped.
- Signature change `reduce(s, e: SdkEvent)` → `reduce(s, e: Any)` (folds `RevealEvent`); `else -> s` covers other events. Confirm no caller depends on the old typed param.
- `LiveState.live` type `ChatMessage?` → `LiveBubble?` — update every read (T2.2 covers `chatStream`/`messagesForUi`).
- iOS 18 bump (T6) precedes the gesture bridge (T7) — order matters.
- Phase 3 reuses the existing `authExpired` nav path; verify before assuming (T9.2).
