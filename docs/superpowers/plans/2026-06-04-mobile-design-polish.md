# Mobile Design-Polish — Implementation Plan (iOS + Android)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the iOS AND Android clients to current-webui visual+behavioral parity (fonts, typewriter-expand, bubble speaking-wave + avatar ripple, follow-latest autoscroll, name·time meta, day dividers, tool pills, polished composer + listening waveform, left history side surface with edge-swipe), on top of one shared `mobile-sdk` derivation that adds `cycleId`+`tools` to `ChatMessage`.

**Architecture:** Single `StateFlow<SdkState>` surface is unchanged. Phase 0 (shared) adds the only SDK logic touch (tool-pill data join). Phases 1–9 polish existing SwiftUI in place; Phases 10–18 mirror the same in Jetpack Compose. Pure logic (typewriter tick, follow-latest pin, day grouping, tools-attach) is TDD'd once per platform; view changes are verified by `#Preview`/`@Preview` + the agentic Maestro + `simctl`/`adb` e2e matrix. iOS history becomes a hand-rolled draggable-snapping panel; Android keeps the native `ModalNavigationDrawer` (already gesture-enabled) and restyles its content.

**Tech Stack:** Kotlin Multiplatform (`shared/mobile-sdk`, SKIE), Swift 6 / SwiftUI (iOS 17), Kotlin / Jetpack Compose Material3 (Android), MarkdownUI + mikepenz markdown-renderer-m3, xcodegen, Maestro, `xcrun simctl` + `adb`.

## Parallel execution (iOS ∥ Android) — same quality gate

The plan is built to run iOS and Android **concurrently** without weakening the superpowers flow or the project quality gate.

**Dependency shape:**
- **Phase 0 (shared `mobile-sdk`) is the only cross-platform prerequisite.** It MUST land first: complete Tasks 0.1–0.3, run the commonTest, **rebuild the XCFramework** (`assembleMobileSdkDebugXCFramework`), and commit. Both UIs consume the new `ChatMessage.cycleId`/`tools`.
- **After Phase 0, iOS (Phases 1–9) and Android (Phases 10–18) touch disjoint file trees** (`ios/**` vs `android/**`) — zero shared-file mutation — so they proceed fully in parallel with no merge conflicts. The only shared artifacts are docs (this plan's checkboxes); edit those on whichever branch and reconcile trivially.
- **Within a platform**, run phases in order (later view tasks depend on files/params from earlier ones).

**How to run in parallel (recommended):**
1. Land Phase 0 on `feature/mobile-client` (or a `feature/mobile-design-foundation` branch merged first).
2. Use `superpowers:using-git-worktrees` to create two worktrees off that commit — one per platform. (CI/lefthook + tokens are per-checkout, so each worktree is independently buildable.)
3. Drive each worktree with `superpowers:subagent-driven-development` (fresh subagent per task, two-stage review) — one track for iOS, one for Android. Both can run at once.
4. Converge both back onto `feature/mobile-client` (disjoint trees → clean merges).

**Quality gate is identical and per-platform — parallelism does not relax it:**
- Every task keeps its TDD step where the testing rule applies (pure logic) and `#Preview`/`@Preview` + the e2e matrix for views.
- The `lefthook` pre-commit hook (typecheck / secrets-scan) runs on **every** commit in **every** worktree — unchanged.
- Each platform runs its full §9/§18 e2e matrix (agentic Maestro + `simctl`/`adb`) against the same local stack before its branch is considered done.
- Pre-merge gate per platform: all its tasks green, build succeeds, e2e captured + visually compared, lint/typecheck clean.

**Execution order summary:** Phase 0 → (iOS 1–9 ∥ Android 10–18) → merge both.

**Spec:** `docs/superpowers/specs/2026-06-04-mobile-design-polish-design.md`
**Branch:** `feature/mobile-client`

**Project conventions that override default TDD:**
- Per `.claude/rules/testing.md`: unit-test ONLY wire/FSM/contract/security/`@live`. Pure logic units below qualify (contract/FSM). DO NOT write unit tests for SwiftUI views, tokens, or constants — verify those via `#Preview` + the e2e matrix.
- Files < 300 lines, functions < 40 (`.claude/rules/clean-code.md`). Split when approaching.
- Tagged logger, no bare `print` (`.claude/rules/logging.md`).
- Tunable constants live in shared tokens, not inline (`.claude/rules/config.md`).

**Build/verify commands (run from repo root):**
- Shared tests: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:allTests` (or `:testDebugUnitTest` for android target). Use the repo's existing gradle wrapper.
- iOS framework: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:assembleMobileSdkDebugXCFramework` (regenerates `MobileSdk.xcframework` after any SDK change).
- iOS build: `cd ios && xcodegen generate && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
- iOS run/screenshot (agentic): `xcrun simctl boot <udid>`, `xcrun simctl io <udid> screenshot out.png`.
- Android unit tests: `./gradlew :android:testDebugUnitTest --tests "<pattern>"`.
- Android build/install: `./gradlew :android:assembleDebug` then `adb install -r android/build/outputs/apk/debug/android-debug.apk`.
- Android run/screenshot (agentic): `adb shell am start ...`, `adb exec-out screencap -p > out.png` / Maestro `takeScreenshot`.
- Local stack for e2e: `deploy/macos` (`docker compose up -d`). Text path is free; voice cases short-prompt only.

---

## File Structure

**Phase 0 — shared (`shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/`):**
- Modify `design/DesignTokens.kt` — add `Fonts` (family names) + `Typewriter` (rates).
- Modify `sdk/SdkState.kt` — add `cycleId` + `tools` to `ChatMessage`.
- Modify `sdk/StateDeriver.kt` — stamp cycleId (in-flight + committed-by-memory), attach tools.
- Test `src/commonTest/kotlin/io/sentient/mobilesdk/sdk/StateDeriverToolsTest.kt` (new).

**Phase 1–8 — iOS (`ios/App/`):**
- New: `Theme/Typo.swift`, `Chat/Typewriter.swift`, `Chat/BubbleSpeakingWave.swift`, `Chat/FollowLatest.swift`, `Chat/ChatRows.swift` (day grouping + row model), `Chat/DayDivider.swift`, `Chat/ToolPillStrip.swift`, `Chat/ListeningWaveform.swift`, `Chat/MessageMeta.swift`, `History/HistorySidePanel.swift`, `History/HistoryAccountHeader.swift`.
- Modify: `Chat/MessageBubble.swift`, `Chat/MessageList.swift`, `Chat/Composer.swift`, `Chat/ChatView.swift`, `Chat/SentientMark.swift`, `App/Info.plist`, `project.yml`.
- New tests (`ios` Swift Testing): `ios/Tests/TypewriterTests.swift`, `ios/Tests/FollowLatestTests.swift`, `ios/Tests/ChatRowsTests.swift`.

**Phase 10–18 — Android (`android/src/main/kotlin/io/sentient/android/`):**
- New: `theme/Type.kt` (FontFamily), `chat/Typewriter.kt`, `chat/BubbleSpeakingWave.kt`, `chat/FollowLatest.kt`, `chat/ChatRows.kt`, `chat/DayDivider.kt`, `chat/MessageMeta.kt`, `chat/ToolPillStrip.kt`, `chat/ListeningWaveform.kt`, `history/HistoryAccountHeader.kt`.
- New resources: `android/src/main/res/font/*` (fraunces, dm_sans_*, jetbrains_mono_*), `res/drawable/ic_attach.xml`.
- Modify: `chat/MessageBubble.kt`, `chat/MessageList.kt`, `chat/Composer.kt`, `chat/ChatScreen.kt`, `chat/SentientMark.kt`/`SentientMarkAnim.kt`, `history/HistoryDrawer.kt`, `theme/Theme.kt`.
- New tests (`android` JVM unit): `android/src/test/kotlin/io/sentient/android/chat/{TypewriterTest,FollowLatestTest,ChatRowsTest}.kt`.

---

## Phase 0 — Shared foundation (mobile-sdk)

### Task 0.1: Add Fonts + Typewriter tokens

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt`

- [ ] **Step 1: Add the token objects** (place beside the existing `Motion` object)

```kotlin
/** Font family NAMES (registered per-platform). Mirrors webui tokens/typography.css. */
object Fonts {
    const val display = "Fraunces"        // brand wordmark, section titles
    const val ui = "DM Sans"              // body / UI
    const val mono = "JetBrains Mono"     // tool argsPreview / code
}

/**
 * Typewriter reveal cadence — transcribed from webui config/typewriter.ts.
 * rate is chars/sec; pauses are ms held after a boundary.
 */
object Typewriter {
    const val baseRate = 30
    const val minRate = 15
    const val maxRate = 150
    const val gapGain = 0.02
    const val sentencePauseMs = 80
    const val paragraphPauseMs = 220
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:compileKotlinMetadata`
Expected: BUILD SUCCESSFUL. (No unit test — constants/tokens are excluded by the testing rule.)

- [ ] **Step 3: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt
git commit -m "feat(mobile-sdk): add Fonts + Typewriter design tokens"
```

---

### Task 0.2: Add `cycleId` + `tools` to `ChatMessage`

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkState.kt`

- [ ] **Step 1: Extend `ChatMessage`** (add the import + two fields)

Add the import near the existing connector imports:
```kotlin
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
```
Replace the `ChatMessage` data class with:
```kotlin
data class ChatMessage(
    val ts: Long,
    val role: String,
    val content: String,
    val streaming: Boolean = false,
    val cutoffKind: String? = null,
    /** Cycle that produced this assistant message (UI join key for tools). Null when unknown. */
    val cycleId: String? = null,
    /** Tasks grouped onto this message by shared cycleId (mirrors web-sdk ChatMessage.tools). */
    val tools: List<TaskSnapshotItem> = emptyList(),
)
```
(`SdkState.kt` already imports `TaskSnapshotItem` for `tasks` — if so, skip the duplicate import.)

- [ ] **Step 2: Verify it compiles**

Run: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:compileKotlinMetadata`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkState.kt
git commit -m "feat(mobile-sdk): add cycleId + tools to ChatMessage"
```

---

### Task 0.3: StateDeriver — stamp cycleId + attach tools (TDD)

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/StateDeriver.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/StateDeriverToolsTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.InFlightMessage
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.util.Clock
import kotlin.test.Test
import kotlin.test.assertEquals

private class FixedClock(val t: Long) : Clock { override fun nowMs(): Long = t }

private fun task(id: String, cycle: String) = TaskSnapshotItem(
    taskId = id, toolName = "search", cycleId = cycle, status = "finished",
    argsPreview = "q=1", startedAtMs = 1, endedAtMs = 2,
)

class StateDeriverToolsTest {
    @Test
    fun inflightBubbleGetsItsCycleTools() {
        val d = StateDeriver(FixedClock(100))
        d.tasks = listOf(task("t1", "c1"), task("t2", "other"))
        d.inflight = InFlightMessage(cycleId = "c1", text = "hi")
        val last = d.derive().messages.last()
        assertEquals("c1", last.cycleId)
        assertEquals(listOf("t1"), last.tools.map { it.taskId })
    }

    @Test
    fun committedMessageRetainsCycleToolsAfterCommit() {
        val d = StateDeriver(FixedClock(100))
        d.tasks = listOf(task("t1", "c1"))
        // stream then commit: inflight seen, then cleared + feed gains the assistant entry
        d.inflight = InFlightMessage(cycleId = "c1", text = "answer")
        d.inflight = null
        d.applyFeed(listOf(ConversationFeedItem.Assistant(ts = 50, content = "answer")))
        val committed = d.derive().messages.single()
        assertEquals("c1", committed.cycleId)
        assertEquals(listOf("t1"), committed.tools.map { it.taskId })
    }

    @Test
    fun reloadedHistoryWithoutSeenCycleHasNoTools() {
        val d = StateDeriver(FixedClock(100))
        d.tasks = listOf(task("t1", "c1"))
        d.applyFeed(listOf(ConversationFeedItem.Assistant(ts = 50, content = "old reply")))
        val committed = d.derive().messages.single()
        assertEquals(null, committed.cycleId)
        assertEquals(emptyList(), committed.tools)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:iosSimulatorArm64Test --tests "*StateDeriverToolsTest*"`
Expected: FAIL — `cycleId`/`tools` not populated (all null/empty).

- [ ] **Step 3: Implement cycleId capture + tools attach in StateDeriver**

In `StateDeriver`, change the `inflight` property to a capturing setter and add the cycle memory + helper:
```kotlin
var inflight: InFlightMessage? = null
    set(value) {
        field = value
        if (value != null) { lastInflightCycleId = value.cycleId; lastInflightText = value.text }
    }

private var lastInflightCycleId: String? = null
private var lastInflightText: String = ""
private val cycleByTs = HashMap<Long, String>()
```
In `applyFeed`, after `feed = items`, stamp any assistant entry whose content matches the last in-flight buffer (the commit of that cycle):
```kotlin
val cycle = lastInflightCycleId
if (cycle != null && lastInflightText.isNotEmpty()) {
    items.forEach { item ->
        if (item is ConversationFeedItem.Assistant &&
            item.content == lastInflightText &&
            item.ts !in cycleByTs
        ) {
            cycleByTs[item.ts] = cycle
        }
    }
}
```
Update `derive()` to pass tasks + cycleByTs:
```kotlin
messages = deriveMessages(feed, inflight, clock.nowMs(), tasks, cycleByTs),
```
Update `deriveMessages` + `committedMessage` to stamp cycleId and attach tools:
```kotlin
internal fun deriveMessages(
    feed: List<ConversationFeedItem>,
    inflight: InFlightMessage?,
    nowMs: Long,
    tasks: List<TaskSnapshotItem>,
    cycleByTs: Map<Long, String>,
): List<ChatMessage> {
    val out = ArrayList<ChatMessage>(feed.size + 1)
    for (item in feed) committedMessage(item, tasks, cycleByTs)?.let(out::add)
    if (inflight != null) {
        out.add(
            ChatMessage(
                ts = nowMs, role = ROLE_ASSISTANT, content = inflight.text, streaming = true,
                cycleId = inflight.cycleId, tools = toolsFor(inflight.cycleId, tasks),
            ),
        )
    }
    return out
}

private fun toolsFor(cycleId: String?, tasks: List<TaskSnapshotItem>): List<TaskSnapshotItem> =
    if (cycleId == null) emptyList() else tasks.filter { it.cycleId == cycleId }

private fun committedMessage(
    item: ConversationFeedItem,
    tasks: List<TaskSnapshotItem>,
    cycleByTs: Map<Long, String>,
): ChatMessage? = when (item) {
    is ConversationFeedItem.User ->
        if (item.content.isEmpty()) null
        else ChatMessage(ts = item.ts, role = ROLE_USER, content = item.content)

    is ConversationFeedItem.Assistant ->
        if (item.content.isEmpty() && item.cutoff == null) null
        else {
            val cycleId = cycleByTs[item.ts]
            ChatMessage(
                ts = item.ts, role = ROLE_ASSISTANT, content = item.content,
                cutoffKind = item.cutoff?.kind, cycleId = cycleId,
                tools = toolsFor(cycleId, tasks),
            )
        }

    is ConversationFeedItem.Tool -> null
    is ConversationFeedItem.Trigger -> null
}
```
Add the `TaskSnapshotItem` import to `StateDeriver.kt` (it already imports it for the `tasks` slice — confirm).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:iosSimulatorArm64Test --tests "*StateDeriverToolsTest*"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the existing deriver/connector tests for regressions**

Run: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:iosSimulatorArm64Test --tests "*ConversationHistory*" --tests "*StateDeriver*" --tests "*TaskStatus*"`
Expected: PASS (no regressions; deriveMessages signature change compiles existing callers).

- [ ] **Step 6: Rebuild the XCFramework so iOS picks up the new fields**

Run: `cd shared/mobile-sdk && ./gradlew :shared:mobile-sdk:assembleMobileSdkDebugXCFramework`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/StateDeriver.kt \
        shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/sdk/StateDeriverToolsTest.kt
git commit -m "feat(mobile-sdk): stamp cycleId + attach tools to ChatMessage in StateDeriver"
```

---

## Phase 1 — iOS fonts

### Task 1.1: Bundle fonts + Typo token

**Files:**
- Create: `ios/App/Resources/Fonts/` (drop `Fraunces[opsz,wght].ttf` or static `Fraunces-Regular/Medium/SemiBold.ttf`, `DMSans-Regular/Medium/SemiBold/Bold.ttf`, `JetBrainsMono-Regular/Medium.ttf`)
- Create: `ios/App/Theme/Typo.swift`
- Modify: `ios/App/Info.plist`
- Modify: `ios/project.yml`

- [ ] **Step 1: Add font files**

Download the OFL/Apache families and place the `.ttf` files under `ios/App/Resources/Fonts/`. Prefer the **Fraunces variable** font (`Fraunces[opsz,wght].ttf`) to bound size; static DM Sans + JetBrains Mono weights are fine.

- [ ] **Step 2: Register fonts in Info.plist**

Add to `ios/App/Info.plist`:
```xml
<key>UIAppFonts</key>
<array>
    <string>Fraunces[opsz,wght].ttf</string>
    <string>DMSans-Regular.ttf</string>
    <string>DMSans-Medium.ttf</string>
    <string>DMSans-SemiBold.ttf</string>
    <string>DMSans-Bold.ttf</string>
    <string>JetBrainsMono-Regular.ttf</string>
    <string>JetBrainsMono-Medium.ttf</string>
</array>
```

- [ ] **Step 3: Include the resources in project.yml**

Under the `SentientApp` target `sources:`, ensure the fonts dir is bundled (xcodegen copies folder resources):
```yaml
    sources:
      - path: App
      - path: App/Resources/Fonts
        buildPhase: resources
```

- [ ] **Step 4: Create the Typo token layer**

```swift
// Typo — design font tokens. Family names come from the shared SDK (MobileSdk.Fonts);
// the registered PostScript/family names must match the bundled .ttf. Falls back to the
// system font if a family is missing so the UI never renders blank.
import SwiftUI
import MobileSdk

enum Typo {
    static func display(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
        .custom(MobileSdk.Fonts.shared.display, size: size).weight(weight)
    }
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(MobileSdk.Fonts.shared.ui, size: size).weight(weight)
    }
    static func mono(_ size: CGFloat) -> Font {
        .custom(MobileSdk.Fonts.shared.mono, size: size)
    }
}
```

- [ ] **Step 5: Verify fonts load (build + preview)**

Run: `cd ios && xcodegen generate && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: BUILD SUCCEEDED. Open `Typo` in a scratch `#Preview` rendering `Text("Sentient").font(Typo.display(28))` — confirm Fraunces (serif), not system. (Verify PostScript family names with `fc-scan` if a family fails to resolve.)

- [ ] **Step 6: Commit**

```bash
git add ios/App/Resources/Fonts ios/App/Theme/Typo.swift ios/App/Info.plist ios/project.yml
git commit -m "feat(ios): bundle Fraunces/DM Sans/JetBrains Mono + Typo token"
```

---

## Phase 2 — iOS typewriter

### Task 2.1: Typewriter pure engine (TDD)

**Files:**
- Create: `ios/App/Chat/Typewriter.swift`
- Test: `ios/Tests/TypewriterTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import SentientApp

struct TypewriterTests {
    let cfg = TypewriterConfig.default

    @Test func revealsTowardTargetAtBaseRate() {
        let target = Array("hello world")
        var s = TypewriterState()
        // 1s at baseRate 30 with small gap → reveals all 11 chars
        s = typewriterTick(s, target: target, streamComplete: false, dt: 1.0, now: 0, cfg: cfg)
        #expect(s.visibleCount == target.count)
    }

    @Test func clampsToMinRate() {
        let target = Array(String(repeating: "a", count: 1000))
        var s = TypewriterState()
        // tiny dt → advance floored to >= 1
        s = typewriterTick(s, target: target, streamComplete: false, dt: 0.001, now: 0, cfg: cfg)
        #expect(s.visibleCount == 1)
    }

    @Test func drainsAtMaxRateWhenComplete() {
        let target = Array(String(repeating: "a", count: 100))
        var s = TypewriterState()
        s = typewriterTick(s, target: target, streamComplete: true, dt: 1.0, now: 0, cfg: cfg)
        #expect(s.visibleCount == 100) // maxRate 150/s * 1s >= 100
    }

    @Test func holdsAfterSentenceBoundary() {
        let target = Array("Hi. More")
        var s = TypewriterState()
        // reveal up to and including "Hi." → boundary sets pauseUntil
        s = typewriterTick(s, target: target, streamComplete: false, dt: 0.12, now: 0, cfg: cfg)
        let afterDot = s.visibleCount
        #expect(s.pauseUntil > 0)
        // next tick still inside the pause window does not advance
        s = typewriterTick(s, target: target, streamComplete: false, dt: 0.02, now: 0.01, cfg: cfg)
        #expect(s.visibleCount == afterDot)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && xcodebuild test -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SentientAppTests/TypewriterTests`
Expected: FAIL — `TypewriterConfig`/`typewriterTick` undefined.

- [ ] **Step 3: Implement the pure engine**

```swift
// Typewriter — pure time→reveal engine porting webui use-typewriter-buffer.ts.
// Rates from the shared SDK tokens (MobileSdk.Typewriter). Pure + testable; a
// TimelineView driver in the streaming bubble calls `typewriterTick` per frame.
import Foundation
import MobileSdk

struct TypewriterConfig {
    let baseRate: Double, minRate: Double, maxRate: Double, gapGain: Double
    let sentencePause: Double, paragraphPause: Double  // seconds
    static let `default` = TypewriterConfig(
        baseRate: Double(MobileSdk.Typewriter.shared.baseRate),
        minRate: Double(MobileSdk.Typewriter.shared.minRate),
        maxRate: Double(MobileSdk.Typewriter.shared.maxRate),
        gapGain: MobileSdk.Typewriter.shared.gapGain,
        sentencePause: Double(MobileSdk.Typewriter.shared.sentencePauseMs) / 1000.0,
        paragraphPause: Double(MobileSdk.Typewriter.shared.paragraphPauseMs) / 1000.0
    )
}

struct TypewriterState {
    var visibleCount: Int = 0
    var pauseUntil: Double = 0   // absolute seconds; reveal holds while now < pauseUntil
}

/// Advance `visibleCount` toward `target.count` for elapsed `dt` at clock `now`.
func typewriterTick(_ s: TypewriterState, target: [Character], streamComplete: Bool,
                    dt: Double, now: Double, cfg: TypewriterConfig = .default) -> TypewriterState {
    var st = s
    let n = target.count
    if st.visibleCount >= n { return st }
    if now < st.pauseUntil { return st }
    let gap = n - st.visibleCount
    let raw = streamComplete ? cfg.maxRate : cfg.baseRate * (1 + Double(gap) * cfg.gapGain)
    let rate = min(cfg.maxRate, max(cfg.minRate, raw))
    let advance = max(1, Int(rate * dt))
    st.visibleCount = min(n, st.visibleCount + advance)
    if let pause = boundaryPause(target, upto: st.visibleCount, cfg: cfg) {
        st.pauseUntil = now + pause
    }
    return st
}

/// Semantic pause after the just-revealed char: paragraph (\n\n) > sentence (.!?).
private func boundaryPause(_ target: [Character], upto: Int, cfg: TypewriterConfig) -> Double? {
    guard upto >= 1, upto <= target.count else { return nil }
    let last = target[upto - 1]
    if last == "\n", upto >= 2, target[upto - 2] == "\n" { return cfg.paragraphPause }
    if last == "." || last == "!" || last == "?" { return cfg.sentencePause }
    return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && xcodebuild test -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SentientAppTests/TypewriterTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ios/App/Chat/Typewriter.swift ios/Tests/TypewriterTests.swift
git commit -m "feat(ios): typewriter reveal engine (ported from web-sdk)"
```

---

### Task 2.2: Wire typewriter into the streaming bubble; drop the cursor

**Files:**
- Modify: `ios/App/Chat/MessageBubble.swift`

- [ ] **Step 1: Add a TimelineView driver for the streaming bubble**

Replace `bubbleContent` + `bubbleText` + `cursorSuffix` in `MessageBubble.swift` with a typewriter-driven streaming path. Add a small driver view:
```swift
@ViewBuilder
private var bubbleContent: some View {
    if message.streaming && message.content.isEmpty {
        PulseDots()
    } else if message.streaming {
        StreamingText(content: message.content)   // typewriter reveal; tools wired in Task 6.1
    } else {
        committedText                              // tools wired in Task 6.1
    }
}

private var committedText: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
        Markdown(message.content).markdownTheme(.dusk)
            .frame(maxWidth: .infinity, alignment: .leading)
        if cutoffLabel != nil { interruptedMarker }
    }
}
```
Add the driver (new private struct in the same file, or `Typewriter.swift`):
```swift
/// Reveals streamed assistant text via the typewriter engine. No block cursor
/// (webui parity); the growing text IS the streaming affordance.
private struct StreamingText: View {
    let content: String
    @State private var state = TypewriterState()
    @State private var lastTick: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let chars = Array(content)
        Group {
            if reduceMotion {
                Markdown(content).markdownTheme(.dusk)
            } else {
                TimelineView(.animation) { tl in
                    let now = tl.date.timeIntervalSinceReferenceDate
                    let dt = lastTick == 0 ? 0 : now - lastTick
                    let next = typewriterTick(state, target: chars, streamComplete: false, dt: dt, now: now)
                    Markdown(String(chars.prefix(next.visibleCount))).markdownTheme(.dusk)
                        .onChange(of: now) { _, t in state = next; lastTick = t }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
```
Delete the old `cursorSuffix` usage (the ` ▍` cursor) entirely.

- [ ] **Step 2: Build + preview the streaming state**

Run: `cd ios && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: BUILD SUCCEEDED. The existing `#Preview` index-2 (streaming) reveals text progressively, **no cursor**, pulse-dots only before first token.

- [ ] **Step 3: Commit**

```bash
git add ios/App/Chat/MessageBubble.swift
git commit -m "feat(ios): typewriter-reveal streaming bubble, drop block cursor"
```

---

## Phase 3 — iOS speaking-wave + avatar ripple

### Task 3.1: Bubble speaking-wave view

**Files:**
- Create: `ios/App/Chat/BubbleSpeakingWave.swift`
- Modify: `ios/App/Chat/SentientMark.swift` (remove the wave-on-mark)
- Modify: `ios/App/Chat/MessageBubble.swift` (overlay wave + avatar ripple)

- [ ] **Step 1: Create the speaking-wave overlay**

```swift
// BubbleSpeakingWave — terra gradient sweeping left→right across the bubble while
// the assistant is speaking. Ports webui .bubble-speaking-wave (Motion.wave 3.4s).
// Lives BELOW the text (z 0); the bubble clips it. Reduced-motion → nothing.
import SwiftUI
import MobileSdk

struct BubbleSpeakingWave: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var period: Double { Double(MobileSdk.Motion.shared.waveMs) / 1000.0 }

    var body: some View {
        if reduceMotion { Color.clear } else {
            TimelineView(.animation) { tl in
                let phase = (tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period)) / period
                GeometryReader { geo in
                    let w = geo.size.width
                    let x = CGFloat(phase) * w * 2.2 - w * 0.6
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: DuskColors.accent.opacity(0.22), location: 0.5),
                            .init(color: .clear, location: 1),
                        ],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .frame(width: w * 1.2)
                    .offset(x: x - w * 0.1)
                }
            }
            .allowsHitTesting(false)
        }
    }
}
```

- [ ] **Step 2: Remove the wave from the mark**

In `SentientMark.swift`, delete the `drawWave` call line in `markCanvas` (`if anim.wavePos >= 0 { drawWave(...) }`) and the `drawWave` function — the wave now lives on the bubble. Leave `wavePos` in `MarkAnim`/`runningAnim` harmless or remove for cleanliness (remove the `wavePos` field + its use in `runningAnim`).

- [ ] **Step 3: Overlay wave + ripple in MessageBubble**

In `MessageBubble.bubbleBody`, layer the wave under the content when speaking:
```swift
private var bubbleBody: some View {
    bubbleContent
        .padding(Space.padMsg)
        .frame(maxWidth: Space.msgMax, alignment: .leading)
        .background(isUser ? BubbleLayout.userBg : DuskColors.paper)
        .background(isSpeaking ? AnyView(BubbleSpeakingWave()) : AnyView(Color.clear))
        .clipShape(bubbleShape)
        .overlay(bubbleShape.stroke(DuskColors.lineSoft, lineWidth: 1))
        .fixedSize(horizontal: false, vertical: true)
}

private var isSpeaking: Bool { !isUser && avatarMode == .speaking }
```
Add an avatar ripple overlay to the assistant avatar:
```swift
// in body, replace the assistant SentientMark with a ripple-wrapped one:
SentientMark(size: BubbleLayout.avatarSize, mode: avatarMode)
    .overlay(AvatarRipple(active: avatarMode == .speaking || avatarMode == .listening))
    .padding(.trailing, Space.md)
```
Add the ripple view (in `BubbleSpeakingWave.swift`):
```swift
/// Two phased expanding rings + ring glow around the avatar (webui .avatar--running).
struct AvatarRipple: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        if !active || reduceMotion { Color.clear } else {
            TimelineView(.animation) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                ZStack {
                    ring(t, delay: 0)
                    ring(t, delay: 0.9)
                }
            }
            .allowsHitTesting(false)
        }
    }
    private func ring(_ t: Double, delay: Double) -> some View {
        let p = ((t - delay).truncatingRemainder(dividingBy: 1.8)) / 1.8
        let phase = max(0, p)
        return Circle()
            .stroke(DuskColors.accent, lineWidth: 1.5)
            .scaleEffect(1 + 0.8 * phase)
            .opacity(0.7 * (1 - phase))
    }
}
```

- [ ] **Step 4: Build + verify**

Run: `cd ios && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: BUILD SUCCEEDED. e2e (Task 9 matrix, "Speaking"): terra wave sweeps the bubble, avatar shows ripple rings.

- [ ] **Step 5: Commit**

```bash
git add ios/App/Chat/BubbleSpeakingWave.swift ios/App/Chat/SentientMark.swift ios/App/Chat/MessageBubble.swift
git commit -m "feat(ios): bubble speaking-wave + avatar ripple, move wave off the mark"
```

---

## Phase 4 — iOS follow-latest autoscroll

### Task 4.1: Follow-latest pin logic (TDD)

**Files:**
- Create: `ios/App/Chat/FollowLatest.swift`
- Test: `ios/Tests/FollowLatestTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import SentientApp

struct FollowLatestTests {
    @Test func startsPinned() { #expect(FollowLatestState().pinned) }

    @Test func userScrollUpUnpins() {
        var s = FollowLatestState(pinned: true, lastTop: 100, lastHeight: 500)
        s = followLatestOnScroll(s, top: 40, height: 500, clientHeight: 300) // moved up, dist=160>8
        #expect(!s.pinned)
    }

    @Test func backInSnapZoneRepins() {
        var s = FollowLatestState(pinned: false, lastTop: 40, lastHeight: 500)
        s = followLatestOnScroll(s, top: 200, height: 500, clientHeight: 300) // dist = 0 <= 8
        #expect(s.pinned)
    }

    @Test func contentShrinkDoesNotUnpin() {
        var s = FollowLatestState(pinned: true, lastTop: 200, lastHeight: 500)
        s = followLatestOnScroll(s, top: 150, height: 400, clientHeight: 300) // shrank
        #expect(s.pinned)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && xcodebuild test -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SentientAppTests/FollowLatestTests`
Expected: FAIL — symbols undefined.

- [ ] **Step 3: Implement**

```swift
// FollowLatest — pin-to-bottom logic ported from webui use-follow-latest.ts.
// Pure; a MessageList scroll observer feeds offsets, and scrolls to end while pinned.
import Foundation

struct FollowLatestState {
    var pinned: Bool = true
    var lastTop: Double = 0
    var lastHeight: Double = 0
}

/// Update pin state from a scroll sample. Unpin only on a real user scroll-up
/// (top decreased, height stable/growing) landing outside `snapPx`; re-pin in zone.
func followLatestOnScroll(_ s: FollowLatestState, top: Double, height: Double,
                          clientHeight: Double, snapPx: Double = 8, epsilon: Double = 1) -> FollowLatestState {
    var st = s
    let shrank = height < st.lastHeight
    let prevTop = st.lastTop
    st.lastTop = top; st.lastHeight = height
    if shrank && st.pinned { return st }
    let movedUp = top < prevTop - epsilon
    let dist = height - top - clientHeight
    let atBottom = dist <= snapPx
    if st.pinned && movedUp && !atBottom { st.pinned = false; return st }
    if !st.pinned && atBottom { st.pinned = true }
    return st
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && xcodebuild test -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SentientAppTests/FollowLatestTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ios/App/Chat/FollowLatest.swift ios/Tests/FollowLatestTests.swift
git commit -m "feat(ios): follow-latest pin logic (ported from web-sdk)"
```

---

### Task 4.2: Wire follow-latest into MessageList

**Files:**
- Modify: `ios/App/Chat/MessageList.swift`

- [ ] **Step 1: Replace always-scroll with pin-driven scroll**

In `MessageList.list`, track scroll geometry and only auto-scroll while pinned. Use `onScrollGeometryChange` (iOS 18) with an availability fallback to the existing growth-based scroll for iOS 17:
```swift
@State private var follow = FollowLatestState()

// inside ScrollView { ... }:
.onScrollGeometryChange(for: ScrollGeometry.self, of: { $0 }) { _, geo in
    let top = geo.contentOffset.y + geo.contentInsets.top
    follow = followLatestOnScroll(follow, top: top,
                                  height: geo.contentSize.height,
                                  clientHeight: geo.containerSize.height)
}
.onChange(of: messages.count) { if follow.pinned { scrollToBottom(proxy) } }
.onChange(of: messages.last?.content) { if follow.pinned { scrollToBottom(proxy) } }
```
Keep `scrollToBottom` and `.onAppear` (initial land). Gate `onScrollGeometryChange` with `if #available(iOS 18, *)`; on iOS 17 keep current behavior (always-follow) as the documented fallback.

- [ ] **Step 2: Build + e2e verify (autoscroll pin/unpin case)**

Run: `cd ios && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: BUILD SUCCEEDED. e2e: scrolling up mid-stream holds position; re-entering the bottom zone re-pins.

- [ ] **Step 3: Commit**

```bash
git add ios/App/Chat/MessageList.swift
git commit -m "feat(ios): pin-to-bottom autoscroll via follow-latest"
```

---

## Phase 5 — iOS meta row + day dividers

### Task 5.1: Day-grouped rows (TDD)

**Files:**
- Create: `ios/App/Chat/ChatRows.swift`
- Test: `ios/Tests/ChatRowsTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
import MobileSdk
@testable import SentientApp

struct ChatRowsTests {
    private func msg(_ ts: Int64) -> ChatMessage { ChatMessage(ts: ts, role: "user", content: "x") }
    private let cal = Calendar(identifier: .gregorian)

    @Test func sameDayGetsOneDivider() {
        let day: Int64 = 1_700_000_000_000
        let rows = chatRows([msg(day), msg(day + 60_000)], calendar: cal)
        #expect(rows.filter { if case .divider = $0 { return true } else { return false } }.count == 1)
    }

    @Test func twoDaysGetTwoDividers() {
        let d1: Int64 = 1_700_000_000_000
        let d2 = d1 + 24 * 3600 * 1000
        let rows = chatRows([msg(d1), msg(d2)], calendar: cal)
        #expect(rows.filter { if case .divider = $0 { return true } else { return false } }.count == 2)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && xcodebuild test -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SentientAppTests/ChatRowsTests`
Expected: FAIL — `chatRows`/`ChatRow` undefined.

- [ ] **Step 3: Implement row model + grouping**

```swift
// ChatRows — fold messages into a render list with day dividers (webui .day-divider).
// A divider precedes the first message of each calendar day; label = day name + first ts.
import Foundation
import MobileSdk

enum ChatRow: Identifiable {
    case divider(label: String, id: String)
    case message(ChatMessage, index: Int)
    var id: String {
        switch self {
        case let .divider(_, id): return "div-\(id)"
        case let .message(m, i): return "msg-\(i)-\(m.ts)"
        }
    }
}

func chatRows(_ messages: [ChatMessage], calendar: Calendar = .current,
              now: Date = Date()) -> [ChatRow] {
    var rows: [ChatRow] = []
    var lastDay: DateComponents?
    for (i, m) in messages.enumerated() {
        let date = Date(timeIntervalSince1970: Double(m.ts) / 1000)
        let day = calendar.dateComponents([.year, .month, .day], from: date)
        if day != lastDay {
            rows.append(.divider(label: dividerLabel(date, calendar: calendar, now: now),
                                 id: "\(m.ts)"))
            lastDay = day
        }
        rows.append(.message(m, index: i))
    }
    return rows
}

private func dividerLabel(_ date: Date, calendar: Calendar, now: Date) -> String {
    let day: String
    if calendar.isDateInToday(date) { day = "Today" }
    else if calendar.isDateInYesterday(date) { day = "Yesterday" }
    else {
        let f = DateFormatter(); f.dateFormat = "EEEE"; day = f.string(from: date)
    }
    let t = DateFormatter(); t.timeStyle = .short; t.dateStyle = .none
    return "\(day) · \(t.string(from: date))"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && xcodebuild test -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SentientAppTests/ChatRowsTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ios/App/Chat/ChatRows.swift ios/Tests/ChatRowsTests.swift
git commit -m "feat(ios): day-grouped chat rows for dividers"
```

---

### Task 5.2: Render dividers + meta row

**Files:**
- Create: `ios/App/Chat/DayDivider.swift`
- Create: `ios/App/Chat/MessageMeta.swift`
- Modify: `ios/App/Chat/MessageList.swift` (iterate `chatRows`)
- Modify: `ios/App/Chat/MessageBubble.swift` (add meta row; accept displayName)

- [ ] **Step 1: Day divider view**

```swift
// DayDivider — "Today · 7:42 AM" with hairline rules either side (webui .day-divider).
import SwiftUI

struct DayDivider: View {
    let label: String
    var body: some View {
        HStack(spacing: Space.md) {
            line; Text(label.uppercased())
                .font(Typo.ui(TypeScale.xs, .medium)).tracking(1)
                .foregroundStyle(DuskColors.ink3)
            line
        }
        .padding(.vertical, Space.xs)
    }
    private var line: some View {
        Rectangle().fill(DuskColors.lineSoft).frame(height: 1)
    }
}
```

- [ ] **Step 2: Meta row view**

```swift
// MessageMeta — "name · time" row above a bubble (webui .message-bubble__meta).
import SwiftUI
import MobileSdk

struct MessageMeta: View {
    let message: ChatMessage
    let userName: String
    private var name: String { message.role == "user" ? userName : "Sentient" }
    private var time: String {
        let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none
        return f.string(from: Date(timeIntervalSince1970: Double(message.ts) / 1000))
    }
    var body: some View {
        HStack(spacing: Space.sm) {
            Text(name).font(Typo.ui(TypeScale.sm, .semibold)).foregroundStyle(DuskColors.ink)
            Text("·").foregroundStyle(DuskColors.ink4)
            Text(time).font(Typo.ui(TypeScale.xs)).foregroundStyle(DuskColors.ink3)
        }
    }
}
```

- [ ] **Step 3: Add meta to MessageBubble**

Give `MessageBubble` a `userName: String` parameter (default `"You"`), and stack the meta above the bubble inside `body`'s body column:
```swift
struct MessageBubble: View {
    let message: ChatMessage
    let index: Int
    var avatarMode: MarkMode = .idle
    var userName: String = "You"
    ...
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if isUser {
                Spacer(minLength: BubbleLayout.edgeMin)
                VStack(alignment: .trailing, spacing: Space.xs) { MessageMeta(message: message, userName: userName); bubbleBody }
                userAvatar
            } else {
                SentientMark(size: BubbleLayout.avatarSize, mode: avatarMode)
                    .overlay(AvatarRipple(active: avatarMode == .speaking || avatarMode == .listening))
                    .padding(.trailing, Space.md)
                VStack(alignment: .leading, spacing: Space.xs) { MessageMeta(message: message, userName: userName); bubbleBody }
                Spacer(minLength: BubbleLayout.edgeMin)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("message-bubble-\(index)")
    }
}
```

- [ ] **Step 4: Iterate chatRows in MessageList**

Replace the `ForEach(Array(messages.enumerated())...)` with a `ForEach(chatRows(messages))` switching on the row, passing `userName` (thread it from `ChatView`):
```swift
struct MessageList: View {
    let messages: [ChatMessage]
    var activeMarkMode: MarkMode = .idle
    var userName: String = "You"
    ...
    LazyVStack(alignment: .leading, spacing: Space.gapMsg) {
        ForEach(chatRows(messages)) { row in
            switch row {
            case let .divider(label, _): DayDivider(label: label)
            case let .message(m, i):
                MessageBubble(message: m, index: i, avatarMode: avatarMode(for: m), userName: userName)
            }
        }
        Color.clear.frame(height: 1).id(Self.bottomAnchor)
    }
}
```

- [ ] **Step 5: Thread userName from ChatView**

In `ChatView`, pass the logged-in user's display name (from the auth profile available to `SdkStore`/the app; if not yet surfaced, pass `"You"` and file a follow-up). Add `userName:` to the `MessageList(...)` call.

- [ ] **Step 6: Build + preview**

Run: `cd ios && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: BUILD SUCCEEDED. Previews show name·time above bubbles + a day divider.

- [ ] **Step 7: Commit**

```bash
git add ios/App/Chat/DayDivider.swift ios/App/Chat/MessageMeta.swift ios/App/Chat/MessageList.swift ios/App/Chat/MessageBubble.swift ios/App/Chat/ChatView.swift
git commit -m "feat(ios): name·time meta row + day dividers"
```

---

## Phase 6 — iOS tool pills

### Task 6.1: Tool pill strip

**Files:**
- Create: `ios/App/Chat/ToolPillStrip.swift`

- [ ] **Step 1: Create the strip + inline detail**

```swift
// ToolPillStrip — flush pills at the bubble bottom, one per task on the message
// (webui tool-pill-strip.tsx). Tap a pill → expand its argsPreview (kv detail).
import SwiftUI
import MobileSdk

struct ToolPillStrip: View {
    let tools: [TaskSnapshotItem]
    @State private var openTaskId: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(tools, id: \.taskId) { t in pill(t) }
            }
            if let open = tools.first(where: { $0.taskId == openTaskId }) {
                detail(open)
            }
        }
        .padding(.top, Space.md)
        .padding(.horizontal, -Space.padMsg)        // negate bubble padding → flush edges
        .padding(.bottom, -Space.padMsg)
    }

    private func pill(_ t: TaskSnapshotItem) -> some View {
        Button { openTaskId = (openTaskId == t.taskId) ? nil : t.taskId } label: {
            HStack(spacing: Space.sm) {
                StatusDot(status: t.status)
                Text(t.toolName).font(Typo.mono(TypeScale.sm)).lineLimit(1)
                    .foregroundStyle(DuskColors.ink)
                if !t.argsPreview.isEmpty {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10))
                        .rotationEffect(.degrees(openTaskId == t.taskId ? 90 : 0))
                        .foregroundStyle(openTaskId == t.taskId ? DuskColors.accent : DuskColors.ink4)
                }
            }
            .padding(.vertical, Space.sm).padding(.horizontal, Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .background(DuskColors.ink.opacity(0.04))
    }

    private func detail(_ t: TaskSnapshotItem) -> some View {
        Text(t.argsPreview)
            .font(Typo.mono(TypeScale.sm)).foregroundStyle(DuskColors.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.md)
            .background(DuskColors.accent.opacity(0.10))
    }
}

/// Status dot — queued (ink), running (spinner), finished (ok), failed (stop), cancelled (ink3).
private struct StatusDot: View {
    let status: String
    var body: some View {
        switch status {
        case "running":
            ProgressView().controlSize(.mini).tint(DuskColors.amber)
        default:
            Circle().fill(color).frame(width: 6, height: 6)
        }
    }
    private var color: Color {
        switch status {
        case "finished": return DuskColors.ok
        case "failed": return DuskColors.stop
        case "cancelled": return DuskColors.ink3
        default: return DuskColors.ink4
        }
    }
}
```

- [ ] **Step 1b: Wire the strip into `MessageBubble.bubbleContent`** (now that `ToolPillStrip` exists)

```swift
} else if message.streaming {
    StreamingText(content: message.content)
    if !message.tools.isEmpty { ToolPillStrip(tools: message.tools) }
} else {
    committedText
    if !message.tools.isEmpty { ToolPillStrip(tools: message.tools) }
}
```

- [ ] **Step 2: Build + e2e verify (tools case)**

Run: `cd ios && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: BUILD SUCCEEDED. e2e: a live cycle with tools shows flush pills + status dots; tapping expands argsPreview.

- [ ] **Step 3: Commit**

```bash
git add ios/App/Chat/ToolPillStrip.swift ios/App/Chat/MessageBubble.swift
git commit -m "feat(ios): tool pill strip on assistant bubbles"
```

---

## Phase 7 — iOS composer polish

### Task 7.1: Listening waveform + attach + radius + stop restyle

**Files:**
- Create: `ios/App/Chat/ListeningWaveform.swift`
- Modify: `ios/App/Chat/Composer.swift`

- [ ] **Step 1: Listening waveform overlay**

```swift
// ListeningWaveform — 11 bouncing bars + "Listening…" over the empty field while the
// mic is active (design mobile.css .m-listening / .m-wave). Reduced-motion → static bars.
import SwiftUI

struct ListeningWaveform: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let heights: [CGFloat] = [6, 12, 18, 10, 15, 8, 16, 11, 18, 7, 13]

    var body: some View {
        HStack(spacing: Space.sm) {
            HStack(alignment: .center, spacing: 2.5) {
                if reduceMotion {
                    ForEach(heights.indices, id: \.self) { i in bar(heights[i], scale: 1) }
                } else {
                    TimelineView(.animation) { tl in
                        let t = tl.date.timeIntervalSinceReferenceDate
                        HStack(alignment: .center, spacing: 2.5) {
                            ForEach(heights.indices, id: \.self) { i in
                                let phase = (t / 1.1 + Double(i) * 0.08).truncatingRemainder(dividingBy: 1)
                                bar(heights[i], scale: 0.4 + 0.6 * (0.5 - 0.5 * cos(phase * 2 * .pi)))
                            }
                        }
                    }
                }
            }
            .frame(height: 18)
            Text("Listening…").font(Typo.ui(13.5, .medium))
                .foregroundStyle(DuskColors.accent.opacity(0.85))
        }
        .allowsHitTesting(false)
    }
    private func bar(_ h: CGFloat, scale: Double) -> some View {
        Capsule().fill(DuskColors.accent).frame(width: 2.5, height: h * scale)
    }
}
```

- [ ] **Step 2: Composer edits — radius, attach, waveform, placeholder, stop**

In `Composer.swift`:
- Change `ComposerLayout.radius` from `14` to `24`.
- Add `let showWave: Bool` driven from `micActive && draft.isEmpty`; overlay `ListeningWaveform()` on the input zone when `showWave`, and blank the placeholder then.
- Dynamic placeholder: `streaming ? "Type to interrupt…" : "Message Sentient…"` (add a `canInterrupt`-derived `streaming` flag already available as `canInterrupt`).
- Add an attach toggle (noop) after the TTS toggle in `buttonRow`:
```swift
ComposerToggle(systemName: "paperclip", on: false, action: {})
    .accessibilityLabel("Attach")
    .accessibilityIdentifier("chat-attach")
```
- Restyle stop as a tinted rounded square (replace the `ComposerAction(systemName: "stop.fill", ...)` interrupt button):
```swift
if canInterrupt {
    Button(action: onInterrupt) {
        RoundedRectangle(cornerRadius: 2).fill(DuskColors.stop)
            .frame(width: 11, height: 11)
            .frame(width: ComposerLayout.buttonSize, height: ComposerLayout.buttonSize)
            .background(DuskColors.stop.opacity(0.16), in: RoundedRectangle(cornerRadius: Radii.sm))
            .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.stop.opacity(0.35), lineWidth: 1))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Stop").accessibilityIdentifier("chat-interrupt")
}
```
Input-zone overlay:
```swift
private var draftField: some View {
    ZStack(alignment: .leading) {
        TextField(showWave ? "" : (canInterrupt ? "Type to interrupt…" : "Message Sentient"),
                  text: $draft, axis: .vertical)
            .lineLimit(1...6).font(Typo.ui(TypeScale.base))
            .foregroundStyle(DuskColors.ink).tint(DuskColors.accent)
            .focused($inputFocused).submitLabel(.send).onSubmit(submit)
            .padding(.vertical, Space.xs).accessibilityIdentifier("chat-input")
        if showWave { ListeningWaveform() }
    }
}
private var showWave: Bool { micActive && draft.isEmpty }
```

- [ ] **Step 3: Build + e2e verify (composer listening + streaming)**

Run: `cd ios && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: BUILD SUCCEEDED. e2e: mic-on empty field shows waveform + "Listening…"; streaming shows "Type to interrupt…" + tinted square stop; attach renders (noop).

- [ ] **Step 4: Commit**

```bash
git add ios/App/Chat/ListeningWaveform.swift ios/App/Chat/Composer.swift
git commit -m "feat(ios): composer listening waveform, attach, radius 24, stop restyle"
```

---

## Phase 8 — iOS history side panel

### Task 8.1: Account header + static panel content

**Files:**
- Create: `ios/App/History/HistoryAccountHeader.swift`
- Create: `ios/App/History/HistorySidePanel.swift`
- Reuse: `ios/App/History/HistoryModel.swift`, `HistoryRow.swift`

- [ ] **Step 1: Account header**

```swift
// HistoryAccountHeader — terra avatar initial + name + household + settings gear
// (design .m-hx-account). Gear opens settings (relocated from the topbar).
import SwiftUI

struct HistoryAccountHeader: View {
    let name: String
    let household: String
    let onSettings: () -> Void
    var body: some View {
        HStack(spacing: Space.md) {
            Text(String(name.prefix(1)))
                .font(Typo.ui(15, .bold)).foregroundStyle(Color(red: 0.17, green: 0.10, blue: 0.06))
                .frame(width: 38, height: 38).background(DuskColors.accent, in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(Typo.ui(14, .semibold)).foregroundStyle(DuskColors.ink)
                Text(household).font(Typo.ui(12)).foregroundStyle(DuskColors.ink3)
            }
            Spacer()
            Button(action: onSettings) {
                Image(systemName: "gearshape").font(.system(size: 19)).foregroundStyle(DuskColors.ink2)
            }
            .buttonStyle(.plain).accessibilityIdentifier("settings-open")
        }
        .padding(Space.md)
    }
}
```

- [ ] **Step 2: Panel content (header + search + grouped list + FAB)**

```swift
// HistorySidePanel — left panel content (design .m-hx). Account header, search pill,
// Fraunces "Past chats", day-grouped rows (active = terra-50 + terra text), "+" FAB.
// Owns no transport — reads HistoryModel built over the single SdkStore.
import SwiftUI

struct HistorySidePanel: View {
    @StateObject var model: HistoryModel
    let userName: String
    let household: String
    let onSelect: (String) -> Void
    let onNewChat: () -> Void
    let onSettings: () -> Void

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                HistoryAccountHeader(name: userName, household: household, onSettings: onSettings)
                searchField
                Text("Past chats").font(Typo.display(19, .medium)).foregroundStyle(DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Space.md)
                list
            }
            fab
        }
        .background(DuskColors.bg)
    }

    private var searchField: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: "magnifyingglass").foregroundStyle(DuskColors.ink3)
            TextField("Search past chats", text: $model.query)
                .font(Typo.ui(14)).foregroundStyle(DuskColors.ink)
        }
        .padding(.horizontal, Space.lg).frame(height: 40)
        .background(DuskColors.bgElev, in: Capsule())
        .overlay(Capsule().stroke(DuskColors.lineSoft, lineWidth: 1))
        .padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Space.xs) {
                ForEach(model.visible) { row in HistoryRow(row: row, onSelect: onSelect) }
            }
            .padding(.horizontal, Space.md)
        }
    }

    private var fab: some View {
        Button(action: onNewChat) {
            Image(systemName: "plus").font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Color(red: 0.17, green: 0.10, blue: 0.06))
                .frame(width: 52, height: 52)
                .background(DuskColors.accent, in: RoundedRectangle(cornerRadius: 16))
                .shadow(color: .black.opacity(0.4), radius: 10, y: 6)
        }
        .buttonStyle(.plain).padding(Space.lg).accessibilityIdentifier("history-new-chat")
    }
}
```
(Confirm `HistoryRow` exposes a `row`/`onSelect` API; adapt the call to its actual signature. Apply the active-row styling — `terra-50` bg + terra text — inside `HistoryRow` if not already.)

- [ ] **Step 3: Build (panel renders standalone in a #Preview)**

Run: `cd ios && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: BUILD SUCCEEDED. Add a `#Preview` rendering the panel with a fake `HistoryModel`.

- [ ] **Step 4: Commit**

```bash
git add ios/App/History/HistoryAccountHeader.swift ios/App/History/HistorySidePanel.swift ios/App/History/HistoryRow.swift
git commit -m "feat(ios): history side-panel content + account header + FAB"
```

---

### Task 8.2: Draggable-snapping presentation + edge-swipe; topbar rewire

**Files:**
- Modify: `ios/App/Chat/ChatView.swift`

- [ ] **Step 1: Replace the `.sheet` history with an overlaid draggable panel**

In `ChatView`, drop `.sheet(isPresented: $historyPresented)`; overlay the panel + scrim, driven by an offset with an edge `DragGesture`:
```swift
private let panelWidth: CGFloat = UIScreen.main.bounds.width * 0.86

@State private var panelX: CGFloat   // current offset; -panelWidth = closed, 0 = open
@State private var dragStartX: CGFloat = 0

// in body, wrap the main VStack in a ZStack(alignment: .leading):
ZStack(alignment: .leading) {
    mainColumn
        // edge-zone open gesture
        .overlay(alignment: .leading) {
            Color.clear.frame(width: 20).contentShape(Rectangle())
                .gesture(panelDrag)
        }
    if panelX > -panelWidth {
        Color.black.opacity(0.5 * Double(1 + panelX / panelWidth))   // scrim tracks progress
            .ignoresSafeArea()
            .onTapGesture { closePanel() }
        panel
            .frame(width: panelWidth)
            .offset(x: panelX)
            .gesture(panelDrag)
    }
}
.onAppear { panelX = -panelWidth }
```
Gesture + snap (velocity via `predictedEndTranslation`, interruptible `interactiveSpring`):
```swift
private var panelDrag: some Gesture {
    DragGesture(minimumDistance: 8)
        .onChanged { v in
            let proposed = dragStartXOr(panelX) + v.translation.width
            panelX = max(-panelWidth, min(0, proposed))   // rubber-band to bounds
        }
        .onEnded { v in
            let projected = panelX + (v.predictedEndTranslation.width - v.translation.width)
            let open = projected > -panelWidth / 2
            withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.86)) {
                panelX = open ? 0 : -panelWidth
            }
            dragStartX = panelX
        }
}
private func dragStartXOr(_ x: CGFloat) -> CGFloat { dragStartX == 0 && x == 0 ? 0 : x }
private func openPanel() { withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.86)) { panelX = 0 } }
private func closePanel() { withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.86)) { panelX = -panelWidth } }
```
(Track drag origin cleanly: capture `panelX` into a `@GestureState` start value instead of the `dragStartXOr` shim if preferred — the executor may refine; the contract is: 1:1 follow in `onChanged`, velocity-projected snap in `onEnded`, interruptible spring.)

- [ ] **Step 2: Rewire the topbar — hamburger opens panel, "+" new chat, settings → panel**

Replace the title-bar trailing `settings` gear with a "+" new-chat button; the hamburger calls `openPanel()`; settings now lives in the panel's account header (Task 8.1):
```swift
private var titleBar: some View {
    HStack(spacing: Space.sm) {
        Button { openPanel() } label: {
            Image(systemName: "line.3.horizontal").font(.system(size: TypeScale.lg)).foregroundStyle(DuskColors.ink2)
        }
        .buttonStyle(.plain).accessibilityLabel("History").accessibilityIdentifier("history-open")
        Spacer()
        HStack(spacing: Space.sm) {
            SentientMark(size: ChatLayout.markSize, mode: currentMarkMode)
            Text(Self.title).font(Typo.display(TypeScale.lg, .semibold)).foregroundStyle(DuskColors.ink)
                .accessibilityIdentifier("chat-screen")
        }
        Spacer()
        Button { store.newChat() } label: {
            Image(systemName: "plus").font(.system(size: TypeScale.lg)).foregroundStyle(DuskColors.ink2)
        }
        .buttonStyle(.plain).accessibilityLabel("New chat").accessibilityIdentifier("new-chat")
    }
    .padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
}
```
Wire the panel instance with `onSelect`/`onNewChat`/`onSettings` (settings still presents `SettingsSheet` via `settingsPresented`):
```swift
private var panel: some View {
    HistorySidePanel(
        model: HistoryModel(store: store, nowMs: Int64(Date().timeIntervalSince1970 * 1000)),
        userName: store.userDisplayName ?? "You",     // add accessor or pass "You"
        household: store.householdName ?? "",
        onSelect: { store.switchSession($0); closePanel() },
        onNewChat: { store.newChat(); closePanel() },
        onSettings: { settingsPresented = true; closePanel() }
    )
}
```
Keep the existing `.sheet(isPresented: $settingsPresented) { SettingsSheet(...) }`.

- [ ] **Step 3: Build + e2e verify (drawer button + edge-swipe + new chat + settings)**

Run: `cd ios && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build`
Expected: BUILD SUCCEEDED. e2e: hamburger opens panel; edge-swipe drags it in/out 1:1 with scrim; flick snaps; "+" starts a new chat; account-header gear opens settings. Verify the edge gesture doesn't block chat vertical scroll.

- [ ] **Step 4: Commit**

```bash
git add ios/App/Chat/ChatView.swift
git commit -m "feat(ios): history as draggable-snapping side panel + edge-swipe; topbar new-chat"
```

---

## Phase 9 — iOS verification (e2e matrix, agentic)

### Task 9.1: Maestro flows + live screenshot diff

**Files:**
- Create: `qa/ios/charters/chat-smoke.yaml`, `qa/ios/charters/history-panel.yaml`

- [ ] **Step 1: Bring up the local stack + simulator**

```bash
cd deploy/macos && docker compose up -d      # free text path
xcrun simctl boot "iPhone 16" || true
cd ios && xcodegen generate && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' build
xcrun simctl install booted <app.app path from DerivedData>
```

- [ ] **Step 2: Author Maestro flows (agent-driveable)**

`qa/ios/charters/chat-smoke.yaml` (text path — free): launch → login → type "say hi in 5 words" → assert streaming bubble appears → `takeScreenshot chat-streaming`. `history-panel.yaml`: open via hamburger → screenshot → swipe-to-close → screenshot.

- [ ] **Step 3: Run the matrix, capture + visually diff**

For each spec §9 case, drive via Maestro / `xcrun simctl io booted screenshot`, save under `.playwright-mcp/ios/`, and visually compare to the rendered design (`sentient-webui-design/project/Sentient Mobile.html` on `:8799`) + webui. **Text cases run freely; voice cases (speaking, listening) use a short prompt that yields a short reply.** Confirm: fonts (Fraunces brand), typewriter reveal w/o cursor, bubble wave + ripple, tool pills expand, composer waveform, day divider, draggable panel + edge-swipe, autoscroll pin/unpin.

- [ ] **Step 4: Commit the flows**

```bash
git add qa/ios/charters
git commit -m "test(ios): Maestro chat + history-panel smoke flows"
```

---

## Phase 10 — Android fonts

### Task 10.1: Bundle fonts + FontFamily + apply

**Files:**
- Create: `android/src/main/res/font/` (`fraunces_variable.ttf`, `dm_sans_regular/medium/semibold/bold.ttf`, `jetbrains_mono_regular/medium.ttf` — lowercase, no hyphens; Android resource names must be `[a-z0-9_]`)
- Create: `android/src/main/kotlin/io/sentient/android/theme/Type.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/theme/Theme.kt`

- [ ] **Step 1: Add the font resources** under `res/font/` with the names above.

- [ ] **Step 2: Define the families + DM-Sans-based typography**

```kotlin
package io.sentient.android.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import io.sentient.android.R

val Fraunces = FontFamily(
    Font(R.font.fraunces_variable, FontWeight.Normal),
    Font(R.font.fraunces_variable, FontWeight.Medium),
    Font(R.font.fraunces_variable, FontWeight.SemiBold),
)
val DMSans = FontFamily(
    Font(R.font.dm_sans_regular, FontWeight.Normal),
    Font(R.font.dm_sans_medium, FontWeight.Medium),
    Font(R.font.dm_sans_semibold, FontWeight.SemiBold),
    Font(R.font.dm_sans_bold, FontWeight.Bold),
)
val JetBrainsMono = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
)

/** Material typography rebased on DM Sans (body/UI). Brand/titles use Fraunces directly. */
val DuskTypography: Typography = Typography().let { t ->
    t.copy(
        bodyLarge = t.bodyLarge.copy(fontFamily = DMSans),
        bodyMedium = t.bodyMedium.copy(fontFamily = DMSans),
        bodySmall = t.bodySmall.copy(fontFamily = DMSans),
        labelLarge = t.labelLarge.copy(fontFamily = DMSans),
        labelMedium = t.labelMedium.copy(fontFamily = DMSans),
        labelSmall = t.labelSmall.copy(fontFamily = DMSans),
        titleLarge = t.titleLarge.copy(fontFamily = DMSans),
        titleMedium = t.titleMedium.copy(fontFamily = DMSans),
        titleSmall = t.titleSmall.copy(fontFamily = DMSans),
    )
}
```

- [ ] **Step 3: Apply the typography in the theme**

In `Theme.kt`, pass it to `MaterialTheme`:
```kotlin
MaterialTheme(
    colorScheme = DuskColorScheme,
    typography = DuskTypography,
    content = content,
)
```

- [ ] **Step 4: Build + verify**

Run: `./gradlew :android:assembleDebug`
Expected: BUILD SUCCESSFUL. (No unit test — fonts/theme excluded by the testing rule.) Brand/title Fraunces wiring lands with the topbar edit in Task 17.2; body text is DM Sans now via the theme.

- [ ] **Step 5: Commit**

```bash
git add android/src/main/res/font android/src/main/kotlin/io/sentient/android/theme/Type.kt android/src/main/kotlin/io/sentient/android/theme/Theme.kt
git commit -m "feat(android): bundle Fraunces/DM Sans/JetBrains Mono + DM Sans typography"
```

---

## Phase 11 — Android typewriter

### Task 11.1: Typewriter pure engine (TDD)

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/chat/Typewriter.kt`
- Test: `android/src/test/kotlin/io/sentient/android/chat/TypewriterTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.android.chat

import kotlin.test.Test
import kotlin.test.assertEquals

class TypewriterTest {
    @Test fun revealsTowardTargetAtBaseRate() {
        val t = "hello world".toList()
        val s = typewriterTick(TypewriterState(), t, streamComplete = false, dt = 1.0, now = 0.0)
        assertEquals(t.size, s.visibleCount)
    }

    @Test fun clampsToMinAdvanceOne() {
        val t = "a".repeat(1000).toList()
        val s = typewriterTick(TypewriterState(), t, streamComplete = false, dt = 0.001, now = 0.0)
        assertEquals(1, s.visibleCount)
    }

    @Test fun drainsAtMaxRateWhenComplete() {
        val t = "a".repeat(100).toList()
        val s = typewriterTick(TypewriterState(), t, streamComplete = true, dt = 1.0, now = 0.0)
        assertEquals(100, s.visibleCount)
    }

    @Test fun holdsAfterSentenceBoundary() {
        val t = "Hi. More".toList()
        val s1 = typewriterTick(TypewriterState(), t, streamComplete = false, dt = 0.12, now = 0.0)
        val after = s1.visibleCount
        val s2 = typewriterTick(s1, t, streamComplete = false, dt = 0.02, now = 0.01)
        assertEquals(after, s2.visibleCount)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :android:testDebugUnitTest --tests "*TypewriterTest*"`
Expected: FAIL — symbols undefined.

- [ ] **Step 3: Implement the engine**

```kotlin
// Typewriter — pure time→reveal engine porting webui use-typewriter-buffer.ts.
// Rates from shared tokens (mobilesdk.design.Typewriter). A Compose driver
// (rememberTypewriterText) calls typewriterTick per frame; this stays pure/testable.
package io.sentient.android.chat

import io.sentient.mobilesdk.design.Typewriter as Cfg

data class TypewriterState(val visibleCount: Int = 0, val pauseUntil: Double = 0.0)

private val sentencePause = Cfg.sentencePauseMs / 1000.0
private val paragraphPause = Cfg.paragraphPauseMs / 1000.0

/** Advance visibleCount toward target.size for elapsed [dt] at clock [now] (seconds). */
fun typewriterTick(
    s: TypewriterState,
    target: List<Char>,
    streamComplete: Boolean,
    dt: Double,
    now: Double,
): TypewriterState {
    val n = target.size
    if (s.visibleCount >= n) return s
    if (now < s.pauseUntil) return s
    val gap = n - s.visibleCount
    val raw = if (streamComplete) Cfg.maxRate.toDouble() else Cfg.baseRate * (1 + gap * Cfg.gapGain)
    val rate = minOf(Cfg.maxRate.toDouble(), maxOf(Cfg.minRate.toDouble(), raw))
    val advance = maxOf(1, (rate * dt).toInt())
    val newCount = minOf(n, s.visibleCount + advance)
    val pause = boundaryPause(target, newCount)
    return s.copy(visibleCount = newCount, pauseUntil = if (pause != null) now + pause else s.pauseUntil)
}

private fun boundaryPause(t: List<Char>, upto: Int): Double? {
    if (upto < 1 || upto > t.size) return null
    val last = t[upto - 1]
    if (last == '\n' && upto >= 2 && t[upto - 2] == '\n') return paragraphPause
    if (last == '.' || last == '!' || last == '?') return sentencePause
    return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :android:testDebugUnitTest --tests "*TypewriterTest*"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/chat/Typewriter.kt android/src/test/kotlin/io/sentient/android/chat/TypewriterTest.kt
git commit -m "feat(android): typewriter reveal engine (ported from web-sdk)"
```

---

### Task 11.2: Wire typewriter into the bubble; drop the cursor

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/chat/Typewriter.kt` (add the Compose driver)
- Modify: `android/src/main/kotlin/io/sentient/android/chat/MessageBubble.kt`

- [ ] **Step 1: Add the Compose driver to Typewriter.kt**

```kotlin
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.withFrameNanos

/** Revealed text for a streaming bubble; full text when not streaming. No cursor. */
@Composable
fun rememberTypewriterText(content: String, streaming: Boolean): String {
    if (!streaming) return content
    val latest by rememberUpdatedState(content)
    var state by remember { mutableStateOf(TypewriterState()) }
    LaunchedEffect(Unit) {
        var last = 0.0
        while (true) {
            withFrameNanos { nanos ->
                val now = nanos / 1_000_000_000.0
                val dt = if (last == 0.0) 0.0 else now - last
                last = now
                state = typewriterTick(state, latest.toList(), streamComplete = false, dt = dt, now = now)
            }
        }
    }
    val chars = latest.toList()
    return chars.subList(0, state.visibleCount.coerceAtMost(chars.size)).joinToString("")
}
```

- [ ] **Step 2: Use it in BubbleText; remove the ` ▍` cursor**

In `MessageBubble.kt` `BubbleText`, replace the cursor logic:
```kotlin
@Composable
private fun BubbleText(text: String, streaming: Boolean, cutoffKind: String?) {
    val tokens = LocalTokens.current
    val shown = rememberTypewriterText(text, streaming)   // typewriter reveal, no cursor
    val body = TextStyle(
        color = Color(Colors.ink),
        fontSize = tokens.type.base,
        lineHeight = tokens.type.base * tokens.type.lineRelaxed,
    )
    Column(verticalArrangement = Arrangement.spacedBy(tokens.space.xs)) {
        Markdown(
            content = shown,
            colors = markdownColor(
                text = Color(Colors.ink),
                codeBackground = Color(Colors.bgElev),
                inlineCodeBackground = Color(Colors.bgElev),
            ),
            typography = markdownTypography(
                h1 = body.copy(fontSize = tokens.type.xl, fontWeight = FontWeight.Bold),
                h2 = body.copy(fontSize = tokens.type.lg, fontWeight = FontWeight.Bold),
                h3 = body.copy(fontSize = tokens.type.base, fontWeight = FontWeight.Bold),
                text = body, paragraph = body, ordered = body, bullet = body, list = body,
                textLink = TextLinkStyles(
                    style = SpanStyle(color = Color(Colors.accent), textDecoration = TextDecoration.Underline),
                ),
            ),
        )
        if (cutoffLabel(cutoffKind) != null) {
            Text(text = "⏹ interrupted", color = Color(Colors.ink3), fontSize = tokens.type.sm)
        }
    }
}
```
Delete the `val cursor = if (streaming) " ▍" else ""` and the `text + cursor` usage.

- [ ] **Step 3: Build + verify**

Run: `./gradlew :android:assembleDebug`
Expected: BUILD SUCCESSFUL. The streaming bubble reveals text progressively, no cursor; pulse-dots only before the first token (unchanged path).

- [ ] **Step 4: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/chat/Typewriter.kt android/src/main/kotlin/io/sentient/android/chat/MessageBubble.kt
git commit -m "feat(android): typewriter-reveal streaming bubble, drop block cursor"
```

---

## Phase 12 — Android speaking-wave + avatar ripple

### Task 12.1: Bubble wave + ripple

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/chat/BubbleSpeakingWave.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/chat/MessageBubble.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/chat/SentientMarkAnim.kt` (remove wave-on-mark)

- [ ] **Step 1: Wave modifier + ripple composable**

```kotlin
// BubbleSpeakingWave — terra gradient sweep across the bubble while speaking
// (webui .bubble-speaking-wave, Motion.wave). Avatar ripple = phased expanding rings.
package io.sentient.android.chat

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

@Composable
fun Modifier.bubbleSpeakingWave(active: Boolean): Modifier {
    if (!active) return this
    val period = LocalTokens.current.motion.waveMs
    val transition = rememberInfiniteTransition(label = "wave")
    val phase by transition.animateFloat(
        initialValue = 0f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(period, easing = LinearEasing)),
        label = "phase",
    )
    val accent = Color(Colors.accent)
    return this.drawBehind {
        val w = size.width
        val x = phase * w * 2.2f - w * 0.6f
        drawRect(
            brush = Brush.linearGradient(
                colorStops = arrayOf(0f to Color.Transparent, 0.5f to accent.copy(alpha = 0.22f), 1f to Color.Transparent),
                start = Offset(x - w * 0.6f, 0f),
                end = Offset(x + w * 0.6f, 0f),
            ),
        )
    }
}

@Composable
fun AvatarRipple(active: Boolean, modifier: Modifier = Modifier) {
    if (!active) return
    val t = rememberInfiniteTransition(label = "ripple")
    val p by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1800, easing = LinearEasing)), label = "p")
    val accent = Color(Colors.accent)
    Canvas(modifier = modifier.fillMaxSize()) {
        fun ring(phase: Float) {
            val r = size.minDimension / 2f * (1f + 0.8f * phase)
            drawCircle(color = accent.copy(alpha = 0.7f * (1f - phase)), radius = r, style = Stroke(width = 1.5.dp.toPx()))
        }
        ring(p); ring((p + 0.5f) % 1f)
    }
}
```

- [ ] **Step 2: Apply wave + ripple in MessageBubble**

Thread `avatarMode` into `BubbleBody`; compute `isSpeaking`. In `BubbleBody`, add the wave to the bubble surface (after `.background(bg)`, before `.border`):
```kotlin
@Composable
private fun BubbleBody(message: ChatMessage, isUser: Boolean, isSpeaking: Boolean) {
    val tokens = LocalTokens.current
    val r = tokens.radii.lg
    val shape = if (isUser) RoundedCornerShape(topStart = r, topEnd = FLUSH_CORNER, bottomEnd = r, bottomStart = r)
                else RoundedCornerShape(topStart = FLUSH_CORNER, topEnd = r, bottomEnd = r, bottomStart = r)
    val bg = if (isUser) USER_BUBBLE_BG else Color(Colors.paper)
    Box(
        modifier = Modifier
            .widthIn(max = tokens.space.msgMax)
            .clip(shape)
            .background(bg)
            .bubbleSpeakingWave(active = isSpeaking)
            .border(1.dp, Color(Colors.lineSoft), shape)
            .padding(tokens.space.padMsg),
    ) { /* existing pulse / BubbleText body unchanged */ }
}
```
Pass `isSpeaking = !isUser && avatarMode == MarkMode.SPEAKING` from `MessageBubble` (and `BubbleBody(message, isUser, isSpeaking)`). In `BubbleAvatar` assistant branch, overlay the ripple:
```kotlin
Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(end = gap)) {
    SentientMark(size = AVATAR_SIZE, mode = avatarMode)
    AvatarRipple(active = avatarMode == MarkMode.SPEAKING || avatarMode == MarkMode.LISTENING,
                 modifier = Modifier.size(AVATAR_SIZE))
}
```

- [ ] **Step 3: Remove wave-on-mark**

Read `SentientMarkAnim.kt`; if it carries a `wavePos`/speaking-wave on the mark (mirror of the iOS `drawWave`), remove it — the wave now lives on the bubble. (If the Android mark never drew a wave, no change; note it in the commit.)

- [ ] **Step 4: Build + e2e verify (speaking case)**

Run: `./gradlew :android:assembleDebug`
Expected: BUILD SUCCESSFUL. e2e: terra wave sweeps the bubble; avatar shows ripple rings while speaking.

- [ ] **Step 5: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/chat/BubbleSpeakingWave.kt android/src/main/kotlin/io/sentient/android/chat/MessageBubble.kt android/src/main/kotlin/io/sentient/android/chat/SentientMarkAnim.kt
git commit -m "feat(android): bubble speaking-wave + avatar ripple, move wave off the mark"
```

---

## Phase 13 — Android follow-latest autoscroll

### Task 13.1: Pin-to-bottom driver in MessageList

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/chat/MessageList.kt`

(No new pure file/test on Android: Compose's `LazyListState` exposes scroll direction + `canScrollForward` directly, so the idiomatic driver below IS the follow-latest semantics — pin while at bottom, unpin on user scroll-up, re-pin in the bottom zone, re-pin on growth. This is view-integration logic; per the testing rule it is verified by the e2e autoscroll case, not a unit test.)

- [ ] **Step 1: Replace the always-scroll `LaunchedEffect` with pin-driven scroll**

```kotlin
val listState = rememberLazyListState()
val atBottom by remember { derivedStateOf { !listState.canScrollForward } }
var pinned by remember { mutableStateOf(true) }
var prevFirst by remember { mutableStateOf(0) }
var prevOffset by remember { mutableStateOf(0) }

// Unpin on a real user scroll-up; re-pin when back in the bottom zone.
LaunchedEffect(listState) {
    snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
        .collect { (idx, off) ->
            val movedUp = idx < prevFirst || (idx == prevFirst && off < prevOffset - 1)
            prevFirst = idx; prevOffset = off
            if (pinned && movedUp && !atBottom) pinned = false
        }
}
LaunchedEffect(atBottom) { if (atBottom) pinned = true }

// Follow latest while pinned (growth or streaming-token change).
LaunchedEffect(messages.size, messages.lastOrNull()?.content) {
    if (pinned && messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
}
```
Add the imports: `androidx.compose.runtime.derivedStateOf`, `getValue`, `mutableStateOf`, `setValue`, `snapshotFlow`. Remove the old unconditional `animateScrollToItem` effect.

- [ ] **Step 2: Build + e2e verify (autoscroll pin/unpin)**

Run: `./gradlew :android:assembleDebug`
Expected: BUILD SUCCESSFUL. e2e: scrolling up mid-stream holds position; returning to the bottom re-pins and follows again.

- [ ] **Step 3: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/chat/MessageList.kt
git commit -m "feat(android): pin-to-bottom autoscroll (follow-latest semantics)"
```

---

## Phase 14 — Android meta row + day dividers

### Task 14.1: Day-grouped rows (TDD)

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/chat/ChatRows.kt`
- Test: `android/src/test/kotlin/io/sentient/android/chat/ChatRowsTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package io.sentient.android.chat

import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class ChatRowsTest {
    private fun m(ts: Long) = ChatMessage(ts = ts, role = "user", content = "x")

    @Test fun sameDayOneDivider() {
        val day = 1_700_000_000_000L
        val rows = chatRows(listOf(m(day), m(day + 60_000)), nowMs = day)
        assertEquals(1, rows.count { it is ChatRow.Divider })
    }

    @Test fun twoDaysTwoDividers() {
        val d1 = 1_700_000_000_000L
        val d2 = d1 + 86_400_000L
        val rows = chatRows(listOf(m(d1), m(d2)), nowMs = d2)
        assertEquals(2, rows.count { it is ChatRow.Divider })
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :android:testDebugUnitTest --tests "*ChatRowsTest*"`
Expected: FAIL — `chatRows`/`ChatRow` undefined.

- [ ] **Step 3: Implement (java.util.Calendar — no desugaring needed on minSdk 24)**

```kotlin
// ChatRows — fold messages into a render list with day dividers (webui .day-divider).
// A divider precedes the first message of each calendar day; label = day + first ts.
package io.sentient.android.chat

import io.sentient.mobilesdk.sdk.ChatMessage
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

sealed interface ChatRow {
    data class Divider(val label: String, val key: String) : ChatRow
    data class Msg(val message: ChatMessage, val index: Int) : ChatRow
}

fun chatRows(messages: List<ChatMessage>, nowMs: Long): List<ChatRow> {
    val out = ArrayList<ChatRow>(messages.size + 4)
    var lastKey: String? = null
    for ((i, m) in messages.withIndex()) {
        val key = dayKey(m.ts)
        if (key != lastKey) { out.add(ChatRow.Divider(dividerLabel(m.ts, nowMs), key)); lastKey = key }
        out.add(ChatRow.Msg(m, i))
    }
    return out
}

private fun dayKey(ts: Long): String {
    val c = Calendar.getInstance().apply { timeInMillis = ts }
    return "${c.get(Calendar.YEAR)}-${c.get(Calendar.DAY_OF_YEAR)}"
}

private fun dividerLabel(ts: Long, nowMs: Long): String {
    val day = when (dayKey(ts)) {
        dayKey(nowMs) -> "Today"
        dayKey(nowMs - 86_400_000L) -> "Yesterday"
        else -> SimpleDateFormat("EEEE", Locale.getDefault()).format(Date(ts))
    }
    val time = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(ts))
    return "$day · $time"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :android:testDebugUnitTest --tests "*ChatRowsTest*"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/chat/ChatRows.kt android/src/test/kotlin/io/sentient/android/chat/ChatRowsTest.kt
git commit -m "feat(android): day-grouped chat rows for dividers"
```

---

### Task 14.2: Render dividers + meta

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/chat/DayDivider.kt`
- Create: `android/src/main/kotlin/io/sentient/android/chat/MessageMeta.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/chat/MessageList.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/chat/MessageBubble.kt`

- [ ] **Step 1: DayDivider**

```kotlin
package io.sentient.android.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

@Composable
fun DayDivider(label: String) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = tokens.space.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        HorizontalDivider(modifier = Modifier.weight(1f), color = Color(Colors.lineSoft))
        Text(label.uppercase(), color = Color(Colors.ink3), fontSize = tokens.type.xs, fontWeight = FontWeight.Medium)
        HorizontalDivider(modifier = Modifier.weight(1f), color = Color(Colors.lineSoft))
    }
}
```

- [ ] **Step 2: MessageMeta**

```kotlin
package io.sentient.android.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.ChatMessage
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun MessageMeta(message: ChatMessage, userName: String) {
    val tokens = LocalTokens.current
    val name = if (message.role == "user") userName else "Sentient"
    val time = remember(message.ts) { SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(message.ts)) }
    Row(horizontalArrangement = Arrangement.spacedBy(tokens.space.sm), verticalAlignment = Alignment.CenterVertically) {
        Text(name, color = Color(Colors.ink), fontSize = tokens.type.sm, fontWeight = FontWeight.SemiBold)
        Text("·", color = Color(Colors.ink4))
        Text(time, color = Color(Colors.ink3), fontSize = tokens.type.xs)
    }
}
```

- [ ] **Step 3: MessageBubble — add `userName`, stack meta above the bubble**

Add `userName: String = "You"` to `MessageBubble`. Replace the body of each branch's bubble with a `Column { MessageMeta(...) ; BubbleBody(...) }`:
```kotlin
if (isUser) {
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(tokens.space.xs)) {
        MessageMeta(message, userName); BubbleBody(message, isUser = true, isSpeaking = false)
    }
    BubbleAvatar(message = message, avatarMode = avatarMode)
} else {
    BubbleAvatar(message = message, avatarMode = avatarMode)
    Column(verticalArrangement = Arrangement.spacedBy(tokens.space.xs)) {
        MessageMeta(message, userName)
        BubbleBody(message, isUser = false, isSpeaking = avatarMode == MarkMode.SPEAKING)
    }
}
```
(`tokens` via `LocalTokens.current` at the top of `MessageBubble`.)

- [ ] **Step 4: MessageList — iterate chatRows; thread `userName`**

Add `userName: String = "You"` to `MessageList`. Replace `itemsIndexed(messages...)` with rows:
```kotlin
val rows = chatRows(messages, nowMs = System.currentTimeMillis())
items(rows, key = { row -> when (row) { is ChatRow.Divider -> "div-${row.key}"; is ChatRow.Msg -> "msg-${row.index}-${row.message.ts}" } }) { row ->
    when (row) {
        is ChatRow.Divider -> DayDivider(row.label)
        is ChatRow.Msg -> {
            val mode = if (row.message.streaming && row.message.role == "assistant") activeMarkMode else MarkMode.IDLE
            MessageBubble(message = row.message, index = row.index, avatarMode = mode, userName = userName, modifier = Modifier.fillMaxWidth())
        }
    }
}
```
Use `import androidx.compose.foundation.lazy.items`.

- [ ] **Step 5: Thread `userName` from ChatScreen**

Add `userName: String = "You"` to `ChatScreen`, pass to `MessageList`. MainActivity supplies the logged-in user's display name if available; else `"You"` (file a follow-up — mirrors the iOS caveat).

- [ ] **Step 6: Build + verify**

Run: `./gradlew :android:assembleDebug`
Expected: BUILD SUCCESSFUL. Bubbles show name·time; day dividers separate days.

- [ ] **Step 7: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/chat/DayDivider.kt android/src/main/kotlin/io/sentient/android/chat/MessageMeta.kt android/src/main/kotlin/io/sentient/android/chat/MessageList.kt android/src/main/kotlin/io/sentient/android/chat/MessageBubble.kt android/src/main/kotlin/io/sentient/android/chat/ChatScreen.kt
git commit -m "feat(android): name·time meta row + day dividers"
```

---

## Phase 15 — Android tool pills

### Task 15.1: Tool pill strip

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/chat/ToolPillStrip.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/chat/MessageBubble.kt`

- [ ] **Step 1: Create the strip**

```kotlin
package io.sentient.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.JetBrainsMono
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.design.Colors

@Composable
fun ToolPillStrip(tools: List<TaskSnapshotItem>) {
    val tokens = LocalTokens.current
    var openId by remember { mutableStateOf<String?>(null) }
    Column(modifier = Modifier.fillMaxWidth().padding(top = tokens.space.md)) {
        Row(modifier = Modifier.fillMaxWidth()) {
            tools.forEach { t ->
                Pill(t, isOpen = openId == t.taskId, modifier = Modifier.weight(1f)) {
                    openId = if (openId == t.taskId) null else t.taskId
                }
            }
        }
        tools.firstOrNull { it.taskId == openId }?.let { t ->
            Text(
                text = t.argsPreview,
                fontFamily = JetBrainsMono,
                fontSize = tokens.type.sm,
                color = Color(Colors.ink2),
                modifier = Modifier.fillMaxWidth().background(Color(Colors.accent).copy(alpha = 0.10f)).padding(tokens.space.md),
            )
        }
    }
}

@Composable
private fun Pill(t: TaskSnapshotItem, isOpen: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .clickable(onClick = onClick)
            .background(Color(Colors.ink).copy(alpha = if (isOpen) 0.08f else 0.04f))
            .padding(vertical = tokens.space.sm, horizontal = tokens.space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        StatusDot(t.status)
        Text(t.toolName, fontFamily = JetBrainsMono, fontSize = tokens.type.sm, color = Color(Colors.ink),
             maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun StatusDot(status: String) {
    when (status) {
        "running" -> CircularProgressIndicator(modifier = Modifier.size(10.dp), strokeWidth = 1.5.dp, color = Color(Colors.amber))
        else -> {
            val c = when (status) {
                "finished" -> Colors.ok; "failed" -> Colors.stop; "cancelled" -> Colors.ink3; else -> Colors.ink4
            }
            Box(Modifier.size(6.dp).clip(CircleShape).background(Color(c)))
        }
    }
}
```

- [ ] **Step 2: Render tools in the bubble**

In `MessageBubble.kt` `BubbleText`, add a `tools: List<TaskSnapshotItem>` param and render the strip after the markdown (before/after the cutoff row). Pass `message.tools` from `BubbleBody`'s `BubbleText(...)` call:
```kotlin
// in BubbleText(...) signature: add `tools: List<TaskSnapshotItem>`
// after the Markdown(...) block, inside the Column:
if (tools.isNotEmpty()) ToolPillStrip(tools)
// in BubbleBody, the call:
BubbleText(text = message.content, streaming = message.streaming, cutoffKind = message.cutoffKind, tools = message.tools)
```

- [ ] **Step 3: Build + e2e verify (tools case)**

Run: `./gradlew :android:assembleDebug`
Expected: BUILD SUCCESSFUL. e2e: live cycle with tools shows flush pills + status dots; tap expands `argsPreview`.

- [ ] **Step 4: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/chat/ToolPillStrip.kt android/src/main/kotlin/io/sentient/android/chat/MessageBubble.kt
git commit -m "feat(android): tool pill strip on assistant bubbles"
```

---

## Phase 16 — Android composer polish

### Task 16.1: Listening waveform + attach + radius + stop restyle

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/chat/ListeningWaveform.kt`
- Create: `android/src/main/res/drawable/ic_attach.xml` (paperclip vector)
- Modify: `android/src/main/kotlin/io/sentient/android/chat/Composer.kt`

- [ ] **Step 1: Listening waveform**

```kotlin
package io.sentient.android.chat

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import kotlin.math.PI
import kotlin.math.cos

@Composable
fun ListeningWaveform() {
    val tokens = LocalTokens.current
    val heights = listOf(6, 12, 18, 10, 15, 8, 16, 11, 18, 7, 13)
    val transition = rememberInfiniteTransition(label = "lwave")
    val phase by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(1100, easing = LinearEasing)), label = "p")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.5.dp)) {
            heights.forEachIndexed { i, h ->
                val local = (phase + i * 0.08f) % 1f
                val scale = 0.4f + 0.6f * (0.5f - 0.5f * cos(local * 2f * PI.toFloat()))
                androidx.compose.foundation.layout.Box(
                    Modifier.width(2.5.dp).height((h * scale).dp).clip(CircleShape).background(Color(Colors.accent)),
                )
            }
        }
        Text("Listening…", color = Color(Colors.accent).copy(alpha = 0.85f), fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
    }
}
```

- [ ] **Step 2: Composer edits**

In `Composer.kt`:
- Change `COMPOSER_RADIUS` `14.dp` → `24.dp`.
- `DraftField`: take `micActive`, `streaming`, `draft`; overlay the waveform on an empty field while `micActive`; dynamic placeholder:
```kotlin
@Composable
private fun DraftField(draft: String, micActive: Boolean, streaming: Boolean, onChange: (String) -> Unit, onSubmit: () -> Unit) {
    val tokens = LocalTokens.current
    val showWave = micActive && draft.isEmpty()
    Box(modifier = Modifier.fillMaxWidth()) {
        TextField(
            value = draft, onValueChange = onChange,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("chat-input"),
            placeholder = {
                if (!showWave) Text(if (streaming) "Type to interrupt…" else "Message Sentient", color = Color(Colors.ink3))
            },
            textStyle = LocalTextStyle.current.copy(color = Color(Colors.ink), fontSize = tokens.type.base),
            maxLines = 6,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSubmit() }),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                disabledContainerColor = Color.Transparent, focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent, cursorColor = Color(Colors.accent),
            ),
        )
        if (showWave) {
            Box(Modifier.matchParentSize().padding(start = 16.dp), contentAlignment = Alignment.CenterStart) { ListeningWaveform() }
        }
    }
}
```
Pass `micActive`/`streaming` from `Composer` (`streaming = canInterrupt`) into `DraftField(draft, micActive, canInterrupt, ...)`.
- Add an attach toggle (noop) in `ButtonRow` after the TTS toggle:
```kotlin
ComposerToggle(iconRes = R.drawable.ic_attach, on = false, contentDescription = "Attach", testTag = "chat-attach", onClick = {})
```
- Restyle stop: replace the interrupt `ComposerAction` with a tinted square:
```kotlin
if (canInterrupt) {
    Box(
        modifier = Modifier.size(BUTTON_SIZE).clip(RoundedCornerShape(BUTTON_RADIUS))
            .background(Color(Colors.stop).copy(alpha = 0.16f))
            .border(1.dp, Color(Colors.stop).copy(alpha = 0.35f), RoundedCornerShape(BUTTON_RADIUS))
            .clickable(onClick = onInterrupt).testTag("chat-interrupt"),
        contentAlignment = Alignment.Center,
    ) { Box(Modifier.size(11.dp).clip(RoundedCornerShape(2.dp)).background(Color(Colors.stop))) }
}
```

- [ ] **Step 3: ic_attach drawable**

`android/src/main/res/drawable/ic_attach.xml` — a 24dp paperclip vector (single path, `?attr/colorControlNormal` tint overridden by Icon tint).

- [ ] **Step 4: Build + e2e verify (composer listening + streaming)**

Run: `./gradlew :android:assembleDebug`
Expected: BUILD SUCCESSFUL. e2e: mic-on empty field shows waveform + "Listening…"; streaming → "Type to interrupt…" + tinted square stop; attach renders (noop).

- [ ] **Step 5: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/chat/ListeningWaveform.kt android/src/main/res/drawable/ic_attach.xml android/src/main/kotlin/io/sentient/android/chat/Composer.kt
git commit -m "feat(android): composer listening waveform, attach, radius 24, stop restyle"
```

---

## Phase 17 — Android history restyle (native drawer)

Android keeps the native `ModalNavigationDrawer` (already gesture-enabled — edge-swipe in/out works out of the box). This phase restyles its content to the design + relocates settings.

### Task 17.1: Account header + FAB + Fraunces title + active-row style

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/history/HistoryAccountHeader.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/history/HistoryDrawer.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/history/HistoryRow.kt` (active-row terra style)

- [ ] **Step 1: Account header**

```kotlin
package io.sentient.android.history

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

@Composable
fun HistoryAccountHeader(name: String, household: String, onSettings: () -> Unit) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(tokens.space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        Box(Modifier.size(38.dp).clip(CircleShape).background(Color(Colors.accent)), contentAlignment = Alignment.Center) {
            Text(name.take(1), color = Color(0xFF2B1A10), fontWeight = FontWeight.Bold)
        }
        Column(Modifier.weight(1f)) {
            Text(name, color = Color(Colors.ink), fontWeight = FontWeight.SemiBold, fontSize = tokens.type.base)
            Text(household, color = Color(Colors.ink3), fontSize = tokens.type.sm)
        }
        Text("⚙", color = Color(Colors.ink2), fontSize = tokens.type.lg,
             modifier = Modifier.clickable(onClick = onSettings).testTag("settings-open"))
    }
}
```

- [ ] **Step 2: HistoryDrawer — header, Fraunces title, search pill, FAB, settings callback**

In `HistoryDrawer.kt`: add `onOpenSettings: () -> Unit` to the `HistoryDrawer`/`HistoryContent` params. In `HistoryContent`, prepend `HistoryAccountHeader(userName, household, onOpenSettings)` (thread `userName`/`household` down — default `"You"`/`""`), make the "Past chats" title `fontFamily = Fraunces`, restyle the search field as a pill (rounded `Colors.bgElev` background), and replace the bottom `NewChatButton` with a floating "+" FAB overlay (wrap `HistoryContent` in a `Box` and place a `FloatingActionButton` `Alignment.BottomEnd`):
```kotlin
Box(Modifier.fillMaxSize()) {
    Column(...) { HistoryAccountHeader(...); searchPill(...); Text("Past chats", fontFamily = Fraunces, ...); SessionListBody(...) }
    FloatingActionButton(
        onClick = onNewChat,
        containerColor = Color(Colors.accent), contentColor = Color(0xFF2B1A10),
        modifier = Modifier.align(Alignment.BottomEnd).padding(tokens.space.lg).testTag("history-new-chat"),
    ) { Text("+", fontSize = tokens.type.xl) }
}
```

- [ ] **Step 3: Active-row terra style in HistoryRow**

Read `HistoryRow.kt`; when `row.isActive`, set the row background to `Color(Colors.accent50)` and the title color to `Color(Colors.accent)` (mirrors design `.m-hx-item.active`). Keep the rest.

- [ ] **Step 4: Build + verify**

Run: `./gradlew :android:assembleDebug`
Expected: BUILD SUCCESSFUL. Drawer shows account header + gear, Fraunces "Past chats", search pill, active row terra-tinted, "+" FAB; swipe-to-open/close works (native).

- [ ] **Step 5: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/history/HistoryAccountHeader.kt android/src/main/kotlin/io/sentient/android/history/HistoryDrawer.kt android/src/main/kotlin/io/sentient/android/history/HistoryRow.kt
git commit -m "feat(android): history drawer account header, FAB, Fraunces title, active-row style"
```

---

### Task 17.2: Topbar rewire — "+" new chat, settings → drawer, Fraunces brand

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/chat/ChatScreen.kt`
- Modify: `android/MainActivity.kt`

- [ ] **Step 1: ChatScreen TitleBar — hamburger · centered brand (Fraunces) · "+" new chat**

Add `onNewChat: () -> Unit` to `ChatScreen`. In `TitleBar`, drop the trailing settings `TextButton`, add a "+" new-chat button, center the brand, and use Fraunces for the wordmark:
```kotlin
@Composable
private fun TitleBar(markMode: MarkMode, onOpenHistory: () -> Unit, onNewChat: () -> Unit) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.md, vertical = tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onOpenHistory, modifier = Modifier.testTag("history-open")) {
            Text("☰", color = Color(Colors.ink2), fontSize = tokens.type.lg)
        }
        Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically) {
            SentientMark(size = MARK_SIZE, mode = markMode, modifier = Modifier.testTag("chat-mark").padding(end = tokens.space.xs))
            Text(TITLE, color = Color(Colors.ink), fontSize = tokens.type.lg, fontWeight = FontWeight.SemiBold, fontFamily = Fraunces)
        }
        TextButton(onClick = onNewChat, modifier = Modifier.testTag("new-chat")) {
            Text("+", color = Color(Colors.ink2), fontSize = tokens.type.xl)
        }
    }
}
```
(Import `io.sentient.android.theme.Fraunces`. Remove the now-unused `onOpenSettings` param from `ChatScreen`/`TitleBar` — settings moved to the drawer header.)

- [ ] **Step 2: MainActivity — wire onNewChat + route settings through the drawer header**

In `AppConfiguredRoot` (`MainActivity.kt`): pass `onNewChat = { sdkViewModel.newChat() }` to `ChatScreen`; pass `onOpenSettings = { showSettings = true }` into `HistoryDrawer` (→ `HistoryContent` → `HistoryAccountHeader`) instead of into `ChatScreen`. Keep the existing `SettingsScreen` gate on `showSettings`.

- [ ] **Step 3: Build + e2e verify (topbar + drawer settings + edge-swipe)**

Run: `./gradlew :android:assembleDebug`
Expected: BUILD SUCCESSFUL. e2e: hamburger opens drawer (and edge-swipe does too); "+" starts a new chat; drawer account-header gear opens settings; brand renders in Fraunces.

- [ ] **Step 4: Commit**

```bash
git add android/src/main/kotlin/io/sentient/android/chat/ChatScreen.kt android/MainActivity.kt
git commit -m "feat(android): topbar new-chat + Fraunces brand; settings relocated to drawer"
```

---

## Phase 18 — Android verification (e2e matrix, agentic)

### Task 18.1: Maestro flows + live screenshot diff

**Files:**
- Create: `qa/android/charters/chat-smoke.yaml`, `qa/android/charters/history-drawer.yaml`

- [ ] **Step 1: Bring up the local stack + emulator**

```bash
cd deploy/macos && docker compose up -d          # free text path
emulator -avd <avd> & adb wait-for-device
./gradlew :android:assembleDebug && adb install -r android/build/outputs/apk/debug/android-debug.apk
```

- [ ] **Step 2: Author Maestro flows (agent-driveable)**

`qa/android/charters/chat-smoke.yaml` (text — free): launch → login → input "say hi in 5 words" → assert streaming bubble → `takeScreenshot chat-streaming`. `history-drawer.yaml`: open via hamburger → screenshot → swipe-left to close → screenshot.

- [ ] **Step 3: Run the matrix, capture + visually diff**

For each spec §9 case, drive via Maestro / `adb exec-out screencap -p`, save under `.playwright-mcp/android/`, and visually compare to the rendered design (`Sentient Mobile.html` on `:8799`) + webui + the iOS captures (cross-platform parity). **Text cases free; voice cases short-prompt only.** Confirm: Fraunces brand, typewriter reveal w/o cursor, bubble wave + ripple, tool pills expand, composer waveform, day divider, drawer (button + edge-swipe), autoscroll pin/unpin.

- [ ] **Step 4: Commit the flows**

```bash
git add qa/android/charters
git commit -m "test(android): Maestro chat + history-drawer smoke flows"
```

---

## Self-Review (completed)

- **Spec coverage:** §3.1 fonts → T1.1 (iOS) + T10.1 (Android); §3.2 tokens → T0.1; §4.1 typewriter → T2.1/2.2 + T11.1/11.2; §4.2 wave+ripple → T3.1 + T12.1; §4.3 autoscroll → T4.1/4.2 + T13.1; §5 meta/day-divider → T5 + T14; §5 topbar → T8.2 + T17.2; §5 tool strip → T0.3 + T6.1 + T15.1; §5 composer → T7.1 + T16.1; §5 history + §5.1 gesture → T8 (iOS draggable panel) + T17 (Android native drawer, edge-swipe built-in); §6 SDK → T0.2/0.3; §9 e2e → T9.1 + T18.1. No gaps.
- **Placeholders:** none — every code step has real code. Two explicit data-availability caveats (`userName` source on both platforms; remove wave-on-mark only if present) carry concrete fallbacks, not TODOs.
- **Type consistency:** iOS `typewriterTick`/`TypewriterState`, `followLatestOnScroll`/`FollowLatestState`, `chatRows`/`ChatRow`, `ToolPillStrip(tools:)`, `MessageBubble(... userName:)`. Android `typewriterTick`/`TypewriterState`, `rememberTypewriterText`, `chatRows`/`ChatRow.{Divider,Msg}`, `bubbleSpeakingWave`/`AvatarRipple`, `ToolPillStrip(tools)`, `MessageBubble(... userName)`, `ChatScreen(... onNewChat, userName)`. `cycleId`/`tools` on shared `ChatMessage` (T0.2) consumed by T0.3 + iOS T6.1 + Android T15.1. ToolPillStrip is created BEFORE it is referenced on each platform (iOS T6.1 wires it into the bubble; Android T15.1 creates + wires together) — no forward references.
- **MarkMode values** (`IDLE`/`LISTENING`/`THINKING`/`SPEAKING`) referenced in T12/T14 must match the existing `SentientMark` enum on each platform — the executor confirms the enum case names when reading the file.

## Out of scope (this plan)
- voice-inline "Spoken" tag, design's inline "interrupted" pill, fake device chrome, reloaded-history tool pills (feed lacks cycleId) — per spec §7.
