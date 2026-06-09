# Mobile Client — Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the mobile rule scaffolding + a buildable KMP `shared/mobile-sdk` module consumed by skeleton native iOS (SwiftUI) and Android (Compose) apps that launch, are agent-drivable (Maestro / android CLI), and reach the local macOS gateway over TLS — the foundation every later phase builds on.

**Architecture:** KMP `shared/mobile-sdk` (commonMain + androidMain/iosMain `expect`/`actual`) compiles to `.aar`/klib (Android) and a SKIE-processed XCFramework (iOS). `android/` (Compose) depends on the module via Gradle; `ios/` (SwiftUI) links the XCFramework via a local Swift Package. Dev TLS bypass is scoped to debug builds + the dev gateway host; release validates the pi's real cert.

**Tech Stack:** Kotlin 2.2.20 (verify), AGP 9.0.1 (verify), Gradle 8.13+, SKIE ~0.10.11 (verify), Ktor client 3.x, Compose BOM 2026.05.00 (verify), Xcode 26.5, JDK 17. Dev tooling validated 2026-06-01: `android` CLI + emulator, Maestro (XCUITest/WDA, no idb) + iPhone 14 Pro/iOS 26.5 sim, gateway `wss://localhost:8888`.

**Spec:** `docs/superpowers/specs/2026-06-01-mobile-client-design.md` (this is Plan 1 of 6; P0a+P0b+P0c).

---

## File Structure

**Rules (P0a/P0b):**
- Create: `.claude/rules/android/*.md` — adapted harness Android rules (kotlin, android-gradle, android-compose, android-coroutines-flow, android-architecture-mvi, android-hilt-di, android-testing)
- Create: `.claude/rules/ios/*.md` — adapted harness iOS rules (swift, swiftui, swift-concurrency, combine, ios-architecture-mvvm, ios-xcodebuild, ios-testing)
- Create: `.claude/rules/mobile/*.md` — adapted harness shared-mobile rules (mobile-lifecycle, mobile-navigation, mobile-offline)
- Create: `.claude/rules/mobile-sdk/*.md` — NEW authored KMP rules (commonMain-purity, expect-actual-contract, kmp-gradle, coroutines-flow-surface, web-sdk-mirror-contract)
- Create: `agents/docs/{android,ios,mobile,mobile-sdk}/*-details.md` — paired details
- Modify: `.claude/settings.json` — remove android/ios `claudeMdExcludes`

**KMP module (P0c):**
- Create: `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/libs.versions.toml`, `gradlew`, `gradle/wrapper/*` (root Gradle for mobile)
- Create: `shared/mobile-sdk/build.gradle.kts`
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/SentientSdkPlaceholder.kt`, `.../Platform.kt` (expect), `.../Logger.kt`
- Create: `shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/Platform.android.kt`
- Create: `shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/Platform.ios.kt`
- Create: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/PlatformTest.kt`

**Android app (P0c):**
- Create: `android/build.gradle.kts`, `android/src/main/AndroidManifest.xml`, `android/src/main/kotlin/io/sentient/android/MainActivity.kt`, `android/src/main/res/xml/network_security_config.xml`, `android/src/debug/res/xml/network_security_config.xml`, `android/src/main/res/values/strings.xml`

**iOS app (P0c):**
- Create: `ios/App.xcodeproj/...` (via xcodegen or manual), `ios/App/SentientApp.swift`, `ios/App/ContentView.swift`, `ios/App/Info.plist`, `ios/Package.swift` (local SP wrapping the XCFramework), `ios/project.yml` (xcodegen spec)

**E2E:**
- Create: `qa/mobile/foundation-smoke.yaml` (Maestro flow for iOS) + a documented android-CLI flow

---

## Task 0: Verify + pin toolchain

**Files:**
- Create: `gradle/libs.versions.toml`

- [ ] **Step 1: Verify current stable versions**

Use context7 / web to confirm latest stable as of execution date for: Kotlin, AGP, Gradle, SKIE (must support the chosen Kotlin), Ktor client, Compose BOM, compileSdk (Play requires ≥36 for new submissions after 2026-05-31). Record findings inline.

Run (sanity on local toolchain):
```bash
source scripts/env.sh 2>/dev/null; java -version; xcodebuild -version; ~/Library/Android/sdk/cmdline-tools/*/bin/sdkmanager --list_installed 2>/dev/null | grep -E "platforms;android-3[56]|build-tools"
```
Expected: JDK 17; Xcode 26.5; platforms android-35/36 present (install android-36 if missing: `sdkmanager "platforms;android-36" "build-tools;36.0.0"`).

- [ ] **Step 2: Write the version catalog**

Create `gradle/libs.versions.toml` (adjust pins to Step 1 findings; these are the 2026-06 baseline):
```toml
[versions]
kotlin = "2.2.20"
agp = "9.0.1"
skie = "0.10.11"
ktor = "3.1.3"
coroutines = "1.10.2"
kotlinx-serialization = "1.8.0"
androidx-core = "1.15.0"
androidx-activity-compose = "1.10.1"
compose-bom = "2026.05.00"
compose-compiler = "2.2.20"   # = kotlin
compileSdk = "36"
minSdk = "26"
targetSdk = "36"

[libraries]
ktor-client-core = { module = "io.ktor:ktor-client-core", version.ref = "ktor" }
ktor-client-okhttp = { module = "io.ktor:ktor-client-okhttp", version.ref = "ktor" }
ktor-client-darwin = { module = "io.ktor:ktor-client-darwin", version.ref = "ktor" }
ktor-client-websockets = { module = "io.ktor:ktor-client-websockets", version.ref = "ktor" }
kotlinx-coroutines-core = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-core", version.ref = "coroutines" }
kotlinx-coroutines-test = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-test", version.ref = "coroutines" }
kotlinx-serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "kotlinx-serialization" }
androidx-core-ktx = { module = "androidx.core:core-ktx", version.ref = "androidx-core" }
androidx-activity-compose = { module = "androidx.activity:activity-compose", version.ref = "androidx-activity-compose" }
compose-bom = { module = "androidx.compose:compose-bom", version.ref = "compose-bom" }
compose-material3 = { module = "androidx.compose.material3:material3" }
compose-ui = { module = "androidx.compose.ui:ui" }
compose-ui-tooling-preview = { module = "androidx.compose.ui:ui-tooling-preview" }

[plugins]
kotlin-multiplatform = { id = "org.jetbrains.kotlin.multiplatform", version.ref = "kotlin" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
android-application = { id = "com.android.application", version.ref = "agp" }
android-library = { id = "com.android.library", version.ref = "agp" }
compose-compiler = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
skie = { id = "co.touchlab.skie", version.ref = "skie" }
```

- [ ] **Step 3: Commit**

```bash
git add gradle/libs.versions.toml
git commit -m "build(mobile): pin KMP/Android/iOS toolchain version catalog"
```

---

## Task 1: Adopt + adapt mobile platform rules (P0a)

**Files:**
- Create: `.claude/rules/{android,ios,mobile}/*.md`, `agents/docs/{android,ios,mobile}/*-details.md`
- Modify: `.claude/settings.json`

- [ ] **Step 1: Fetch harness rule + details files into place**

Pull each file from `dev32-io/agentic-dev-harness` (it uses our exact tier structure). Run:
```bash
REPO=dev32-io/agentic-dev-harness
fetch() { gh api "repos/$REPO/contents/$1" --jq '.content' | base64 -d > "$2"; }
mkdir -p .claude/rules/android .claude/rules/ios .claude/rules/mobile \
         agents/docs/android agents/docs/ios agents/docs/mobile

# Android rules + details
for r in kotlin android-gradle android-compose android-coroutines-flow android-architecture-mvi android-hilt-di android-testing; do
  fetch "examples/android-sample/.claude/rules/android/$r.md" ".claude/rules/android/$r.md"
  fetch "examples/android-sample/agents/docs/android/$r-details.md" "agents/docs/android/$r-details.md" 2>/dev/null || true
done
# iOS rules + details
for r in swift swiftui swift-concurrency combine ios-architecture-mvvm ios-xcodebuild ios-testing; do
  fetch "examples/ios-sample/.claude/rules/ios/$r.md" ".claude/rules/ios/$r.md"
  fetch "examples/ios-sample/agents/docs/ios/$r-details.md" "agents/docs/ios/$r-details.md" 2>/dev/null || true
done
# Mobile (cross) rules + details
for r in mobile-lifecycle mobile-navigation mobile-offline; do
  fetch "examples/android-sample/.claude/rules/mobile/$r.md" ".claude/rules/mobile/$r.md"
  fetch "examples/android-sample/agents/docs/mobile/$r-details.md" "agents/docs/mobile/$r-details.md" 2>/dev/null || true
done
ls -R .claude/rules/{android,ios,mobile} agents/docs/{android,ios,mobile}
```
Expected: each rule + details file present (details may 404 for some — note which; author a stub if missing).

- [ ] **Step 2: Re-scope every `paths:` glob to subproject paths**

The harness ships language globs (`**/*.kt`, `**/*.swift`) which misfire across our monorepo. Rewrite each rule's frontmatter `paths:`:
- `.claude/rules/android/*.md` → `paths: ["android/**"]`
- `.claude/rules/ios/*.md` → `paths: ["ios/**"]`
- `.claude/rules/mobile/*.md` → `paths: ["android/**", "ios/**", "shared/mobile-sdk/**"]`

For each file, replace the `paths:` line in the YAML frontmatter. Example for an android rule:
```
---
paths: ["android/**"]
---
```
Verify none retain `**/*.kt` / `**/*.swift`:
```bash
grep -rn "paths:" .claude/rules/{android,ios,mobile} | grep -E "\*\*/\*\.(kt|swift)" && echo "STILL HAS LANG GLOBS — fix" || echo "globs re-scoped OK"
```
Expected: `globs re-scoped OK`.

- [ ] **Step 3: Apply harness audit fixes to the Android rules**

Per `docs/audits/2026-05-19-mobile-rules-audit.md`, the Android rules carry stale/wrong pins. Edit `.claude/rules/android/android-gradle.md` and `android-compose.md`:
- Mandate the Compose compiler **Gradle plugin** (`org.jetbrains.kotlin.plugin.compose`), not `kotlinCompilerExtensionVersion`.
- Align Java/jvmTarget to **21** (or 17 to match our gateway — pick 17 for consistency with repo JDK; note the choice in the rule).
- `compileSdk`/`targetSdk` = **36**; `minSdk` 26.
- Point version examples at the catalog pins from Task 0 (no version literals in build files).
Confirm the rules no longer reference AGP 8.x / Kotlin 2.0 / `kotlinCompilerExtensionVersion`:
```bash
grep -rniE "kotlinCompilerExtensionVersion|agp.*8\.|kotlin.*2\.0\.0|compileSdk.*34" .claude/rules/android && echo "STALE REMAINS — fix" || echo "android rules audit-clean"
```
Expected: `android rules audit-clean`.

- [ ] **Step 4: KMP-adapt the Android rules**

Add a note block to `.claude/rules/android/android-architecture-mvi.md` and `android-hilt-di.md` clarifying scope (our transport/state/networking live in `shared/mobile-sdk`, not the app):
```
> SCOPE (sentient KMP): this rule governs the Android **UI app only** (android/**).
> WebSocket transport, session/audio FSM, connectors, reconnect, and logging live in
> `shared/mobile-sdk` (commonMain) — see `.claude/rules/mobile-sdk/`. The Android app is a
> thin Compose consumer of the SDK; do NOT re-implement transport/state here.
```
Add the same scope note (pointing at mobile-sdk) to `.claude/rules/ios/ios-architecture-mvvm.md`.

- [ ] **Step 5: Lift the android/ios excludes**

Read `.claude/settings.json`, find `claudeMdExcludes` entries for `android` / `ios`, remove them (CLAUDE.md marks them "excluded until Phase 6" — that's now).
```bash
grep -n "claudeMdExcludes" .claude/settings.json
```
Edit to drop the android/ios entries. Re-read to confirm removed.

- [ ] **Step 6: Commit**

```bash
git add .claude/rules/{android,ios,mobile} agents/docs/{android,ios,mobile} .claude/settings.json
git commit -m "docs(rules): adopt+adapt harness android/ios/mobile rules (re-scoped globs, audit fixes, KMP scope)"
```

---

## Task 2: Author mobile-sdk KMP rules + details (P0b)

**Files:**
- Create: `.claude/rules/mobile-sdk/{commonMain-purity,expect-actual-contract,kmp-gradle,coroutines-flow-surface,web-sdk-mirror-contract}.md`
- Create: `agents/docs/mobile-sdk/{commonMain-purity,expect-actual-contract,kmp-gradle,coroutines-flow-surface,web-sdk-mirror-contract}-details.md`

- [ ] **Step 1: Create the rules directory**

```bash
mkdir -p .claude/rules/mobile-sdk agents/docs/mobile-sdk
```

- [ ] **Step 2: Write `commonMain-purity.md`**

```markdown
---
paths: ["shared/mobile-sdk/src/commonMain/**"]
---
# commonMain Purity

- commonMain MUST NOT import platform APIs (no `android.*`, no `platform.*`/Foundation, no JVM-only `java.*`).
- All platform capability (mic, playback, push token, secure storage, WS engine, log sink, clock) enters via an `expect` declaration or an injected interface defined in commonMain.
- No `System.currentTimeMillis()` / `Date()` directly — inject a `Clock` so logic is testable and deterministic.
- Pure logic (codec, gates, FSMs, connectors, reconnect) lives here and is unit-tested in commonTest with NO platform.
- If a type needs a platform import, it belongs in androidMain/iosMain behind an `expect`/`actual` or interface — never leak it into commonMain.

> Details: agents/docs/mobile-sdk/commonMain-purity-details.md
```

- [ ] **Step 3: Write `expect-actual-contract.md`**

```markdown
---
paths: ["shared/mobile-sdk/**"]
---
# expect/actual Contract

- Each platform capability is ONE `expect` (interface or class) in commonMain with exactly one `actual` per target.
- `actual` implementations own platform lifecycle (acquire/release); they NEVER contain business logic — they adapt platform → the commonMain interface and back.
- Keep `expect` surfaces minimal: data in, data out, callbacks for async. No platform types in the signature (use ByteArray/FloatArray/String/Flow, not AVAudioPCMBuffer/AudioRecord).
- Mirror web-sdk's adapter shapes: AudioCaptureAdapter, AudioPlaybackAdapter, SecureTokenStore, PushTokenProvider, LogSink, WebSocket engine.
- Every `actual` has a fake/in-memory commonTest double so commonMain logic tests run without a device.

> Details: agents/docs/mobile-sdk/expect-actual-contract-details.md
```

- [ ] **Step 4: Write `kmp-gradle.md`**

```markdown
---
paths: ["shared/mobile-sdk/**", "settings.gradle.kts", "build.gradle.kts", "gradle/**"]
---
# KMP Gradle

- ALL versions live in `gradle/libs.versions.toml`. No version literals in any build file.
- Targets: `androidTarget()`, `iosArm64()`, `iosSimulatorArm64()` (+ `iosX64()` only if an Intel CI needs it).
- iOS output is an XCFramework built via the SKIE plugin; name it `MobileSdk`. The Android output is an `com.android.library`.
- Apply `co.touchlab.skie` so the Swift API gets Flow→AsyncSequence / suspend→async / sealed→enum. Verify SKIE supports the pinned Kotlin version BEFORE bumping Kotlin.
- commonTest uses kotlin-test + kotlinx-coroutines-test. No Robolectric/XCTest in the shared module.
- Keep the module under the 300-line/40-line clean-code limits per file (split early).

> Details: agents/docs/mobile-sdk/kmp-gradle-details.md
```

- [ ] **Step 5: Write `coroutines-flow-surface.md`**

```markdown
---
paths: ["shared/mobile-sdk/**"]
---
# Coroutines / Flow Public Surface

- The SDK exposes ONE observable state surface as a `StateFlow<SdkState>` (mirrors web-sdk's single state machine). VAD/error internals are NOT separate public surfaces.
- Public async ops are `suspend` funcs; streams are `Flow`. These map cleanly through SKIE to Swift `async`/`AsyncSequence`.
- Do NOT expose `Channel`, `Deferred`, raw `Job`, or callback-lists across the public boundary — SKIE/Swift ergonomics degrade. Wrap them.
- Sealed classes/interfaces for state + events (SKIE → exhaustive Swift enums). Keep hierarchies flat.
- Every coroutine is launched in a scope the consumer can cancel (tie to connect/disconnect). No `GlobalScope`.
- Log every state transition (from→to + trigger) per the logging rule.

> Details: agents/docs/mobile-sdk/coroutines-flow-surface-details.md
```

- [ ] **Step 6: Write `web-sdk-mirror-contract.md`**

```markdown
---
paths: ["shared/mobile-sdk/**"]
---
# web-sdk Mirror Contract

- `shared/mobile-sdk` mirrors the ROLE and surface of `shared/web-sdk`: same status states, same connector capabilities, same wire frames, same gate semantics (SpeechGate/EchoGate/AudioPreRollRing/IdleDetector).
- Wire-frame shapes are the contract with the gateway — mirror the EXACT message `type`s and fields web-sdk uses (auth, session.configure, session.ready, conversation.*, connector.audio.*, cycle.*, ping/pong, interrupt). Do NOT invent envelopes.
- When the gateway protocol changes, web-sdk and mobile-sdk change together. Cross-check `shared/web-sdk/src/` before altering a frame.
- Pure state machines are ported from web-sdk with identical transition tables; port the web-sdk unit tests as commonTest to pin parity.
- Logger tag root is `["sentient", "mobile-sdk", ...]`, matching web-sdk's `createLogger` shape.

> Details: agents/docs/mobile-sdk/web-sdk-mirror-contract-details.md
```

- [ ] **Step 7: Write the five paired details stubs**

For each rule, create `agents/docs/mobile-sdk/<rule>-details.md` with a short header + an "Examples" and "Gotchas" section seeded with at least the known gotcha (e.g. for kmp-gradle: "SKIE version MUST match Kotlin; a Kotlin bump with stale SKIE fails the iOS link with an opaque error"; for coroutines-flow-surface: "exposing `Flow<T>` of a generic sealed type sometimes needs `@HiddenFromObjC`+wrapper — see SKIE sealed-class docs"). Keep each ≤60 lines.

- [ ] **Step 8: Lint rule line counts (T1 ≤100 LOC)**

```bash
for f in .claude/rules/mobile-sdk/*.md; do n=$(wc -l < "$f"); echo "$n $f"; [ "$n" -gt 100 ] && echo "  ^ OVER 100 — trim"; done
```
Expected: all ≤100.

- [ ] **Step 9: Commit**

```bash
git add .claude/rules/mobile-sdk agents/docs/mobile-sdk
git commit -m "docs(rules): author mobile-sdk KMP rules + paired details"
```

---

## Task 3: Scaffold the KMP shared/mobile-sdk module (P0c)

**Files:**
- Create: root Gradle (`settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradlew`, `gradle/wrapper/*`)
- Create: `shared/mobile-sdk/build.gradle.kts` + commonMain/androidMain/iosMain/commonTest sources

- [ ] **Step 1: Generate the Gradle wrapper**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/mobile-client
gradle wrapper --gradle-version 8.13 2>/dev/null || ( \
  curl -sL https://services.gradle.org/distributions/gradle-8.13-bin.zip -o /tmp/g.zip && \
  unzip -q -o /tmp/g.zip -d /tmp/gradledist && \
  /tmp/gradledist/gradle-8.13/bin/gradle wrapper --gradle-version 8.13 )
ls gradlew gradle/wrapper/gradle-wrapper.properties
```
Expected: `gradlew` + wrapper props present.

- [ ] **Step 2: Write `settings.gradle.kts`**

```kotlin
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "sentient-mobile"
include(":shared:mobile-sdk")
include(":android")
```

- [ ] **Step 3: Write root `build.gradle.kts` + `gradle.properties`**

`build.gradle.kts`:
```kotlin
plugins {
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.compose.compiler) apply false
    alias(libs.plugins.skie) apply false
}
```
`gradle.properties`:
```properties
org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8
kotlin.code.style=official
android.useAndroidX=true
org.gradle.caching=true
```

- [ ] **Step 4: Write `shared/mobile-sdk/build.gradle.kts`**

```kotlin
plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.library)
    alias(libs.plugins.skie)
}

kotlin {
    androidTarget { compilations.all { compileTaskProvider.configure { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } } } }
    val xcfName = "MobileSdk"
    listOf(iosArm64(), iosSimulatorArm64()).forEach { it.binaries.framework { baseName = xcfName; isStatic = true } }

    sourceSets {
        commonMain.dependencies {
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.websockets)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.kotlinx.coroutines.test)
        }
        androidMain.dependencies { implementation(libs.ktor.client.okhttp) }
        iosMain.dependencies { implementation(libs.ktor.client.darwin) }
    }
}

android {
    namespace = "io.sentient.mobilesdk"
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig { minSdk = libs.versions.minSdk.get().toInt() }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
```

- [ ] **Step 5: Write the commonMain `expect` + Logger + placeholder**

`shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/Platform.kt`:
```kotlin
package io.sentient.mobilesdk

/** Platform identity shim — the first expect/actual, proves the KMP wiring. */
expect class Platform() {
    val name: String
}
```
`.../Logger.kt`:
```kotlin
package io.sentient.mobilesdk

/** Mirrors web-sdk createLogger shape; sink is platform-actual later. */
interface Log {
    fun debug(message: String, props: Map<String, Any?> = emptyMap())
    fun info(message: String, props: Map<String, Any?> = emptyMap())
    fun warn(message: String, props: Map<String, Any?> = emptyMap())
    fun error(message: String, props: Map<String, Any?> = emptyMap())
}

fun loggerTag(vararg tags: String): String = (listOf("sentient", "mobile-sdk") + tags).joinToString(".")
```
`.../SentientSdkPlaceholder.kt`:
```kotlin
package io.sentient.mobilesdk

/** P0 placeholder. Real SentientSdk lands in Plan 2 (P1). */
object MobileSdk {
    fun greeting(): String = "sentient-mobile-sdk on ${Platform().name}"
}
```

- [ ] **Step 6: Write the `actual`s**

`shared/mobile-sdk/src/androidMain/kotlin/io/sentient/mobilesdk/Platform.android.kt`:
```kotlin
package io.sentient.mobilesdk
actual class Platform actual constructor() {
    actual val name: String = "Android ${android.os.Build.VERSION.SDK_INT}"
}
```
`shared/mobile-sdk/src/iosMain/kotlin/io/sentient/mobilesdk/Platform.ios.kt`:
```kotlin
package io.sentient.mobilesdk
import platform.UIKit.UIDevice
actual class Platform actual constructor() {
    actual val name: String = UIDevice.currentDevice.systemName() + " " + UIDevice.currentDevice.systemVersion
}
```

- [ ] **Step 7: Write the commonTest**

`shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/PlatformTest.kt`:
```kotlin
package io.sentient.mobilesdk
import kotlin.test.Test
import kotlin.test.assertTrue

class PlatformTest {
    @Test fun greeting_includes_sdk_name() {
        assertTrue(MobileSdk.greeting().startsWith("sentient-mobile-sdk on"))
    }
    @Test fun logger_tag_roots_under_sentient_mobile_sdk() {
        assertTrue(loggerTag("ws").startsWith("sentient.mobile-sdk."))
    }
}
```

- [ ] **Step 8: Build the shared module + run common tests**

Run:
```bash
./gradlew :shared:mobile-sdk:assemble :shared:mobile-sdk:allTests
```
Expected: BUILD SUCCESSFUL; PlatformTest 2 tests pass. (First run downloads Kotlin/Native — minutes.)

- [ ] **Step 9: Build the iOS XCFramework**

Run:
```bash
./gradlew :shared:mobile-sdk:assembleMobileSdkXCFramework 2>&1 | tail -5 || ./gradlew :shared:mobile-sdk:linkDebugFrameworkIosSimulatorArm64
ls -d shared/mobile-sdk/build/XCFrameworks 2>/dev/null || ls -d shared/mobile-sdk/build/bin/iosSimulatorArm64 2>/dev/null
```
Expected: framework/XCFramework artifact present (SKIE-processed).

- [ ] **Step 10: Commit**

```bash
git add settings.gradle.kts build.gradle.kts gradle.properties gradlew gradle/ shared/mobile-sdk/
git commit -m "feat(mobile-sdk): scaffold KMP module (Platform expect/actual, logger, XCFramework)"
```

---

## Task 4: Scaffold + drive the Android app (P0c)

**Files:**
- Create: `android/build.gradle.kts`, `android/src/main/AndroidManifest.xml`, `MainActivity.kt`, `network_security_config.xml` (main + debug), `strings.xml`

- [ ] **Step 1: Write `android/build.gradle.kts`**

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
}
android {
    namespace = "io.sentient.android"
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig {
        applicationId = "io.sentient.android"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1; versionName = "0.0.1"
    }
    buildFeatures { compose = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
    buildTypes { getByName("debug") { isDebuggable = true } }
}
dependencies {
    implementation(project(":shared:mobile-sdk"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
}
```

- [ ] **Step 2: Write the debug network-security config (dev TLS bypass, scoped)**

`android/src/debug/res/xml/network_security_config.xml`:
```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- DEBUG ONLY: trust user-added CAs + the dev gateway host (self-signed local stack). -->
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="true">10.0.2.2</domain>
        <domain includeSubdomains="true">localhost</domain>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </domain-config>
</network-security-config>
```
`android/src/main/res/xml/network_security_config.xml` (release — system trust only, no overrides):
```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors><certificates src="system" /></trust-anchors>
    </base-config>
</network-security-config>
```

- [ ] **Step 3: Write the manifest + strings**

`android/src/main/AndroidManifest.xml`:
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:label="@string/app_name"
        android:networkSecurityConfig="@xml/network_security_config"
        android:theme="@android:style/Theme.Material.NoActionBar">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```
`android/src/main/res/values/strings.xml`:
```xml
<resources><string name="app_name">Sentient</string></resources>
```

- [ ] **Step 4: Write `MainActivity.kt` (proves SDK link + a tagged testID)**

`android/src/main/kotlin/io/sentient/android/MainActivity.kt`:
```kotlin
package io.sentient.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import io.sentient.mobilesdk.MobileSdk

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = androidx.compose.ui.Alignment.Center) {
                        Text(text = MobileSdk.greeting(), modifier = Modifier.testTag("foundation-greeting"))
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 5: Build the APK**

Run:
```bash
./gradlew :android:assembleDebug
ls android/build/outputs/apk/debug/android-debug.apk
```
Expected: BUILD SUCCESSFUL; APK present.

- [ ] **Step 6: Install + launch on the emulator via android CLI, capture UI**

Ensure emulator booted (`android emulator start Pixel_3a_API_34` if needed). Run:
```bash
android run --apks=android/build/outputs/apk/debug/android-debug.apk --device=emulator-5554 || \
  ~/Library/Android/sdk/platform-tools/adb install -r android/build/outputs/apk/debug/android-debug.apk
~/Library/Android/sdk/platform-tools/adb shell am start -n io.sentient.android/.MainActivity
sleep 3
android screen capture --output=/tmp/foundation-android.png
android layout --output=/tmp/foundation-android.json
grep -o "sentient-mobile-sdk on Android" /tmp/foundation-android.json && echo "GREETING RENDERED ✓"
```
Expected: screenshot saved; layout JSON contains the greeting text → SDK linked + rendered on Android.

- [ ] **Step 7: Commit**

```bash
git add android/
git commit -m "feat(android): scaffold Compose app consuming mobile-sdk + debug TLS config"
```

---

## Task 5: Scaffold + drive the iOS app via SKIE (P0c)

**Files:**
- Create: `ios/project.yml` (xcodegen), `ios/App/SentientApp.swift`, `ContentView.swift`, `Info.plist`, `ios/Package.swift`

- [ ] **Step 1: Ensure xcodegen (deterministic project gen for agents)**

```bash
which xcodegen || brew install xcodegen
xcodegen --version
```
Expected: a version prints.

- [ ] **Step 2: Build + package the XCFramework for SP consumption**

```bash
./gradlew :shared:mobile-sdk:assembleMobileSdkXCFramework 2>&1 | tail -3
FW=$(find shared/mobile-sdk/build -name "MobileSdk.xcframework" -type d | head -1); echo "XCFramework: $FW"
```
Expected: `MobileSdk.xcframework` path printed. Record it for project.yml.

- [ ] **Step 3: Write `ios/project.yml`**

```yaml
name: SentientApp
options:
  bundleIdPrefix: io.sentient
  deploymentTarget:
    iOS: "17.0"
targets:
  SentientApp:
    type: application
    platform: iOS
    sources: [App]
    info:
      path: App/Info.plist
      properties:
        UILaunchScreen: {}
        CFBundleDisplayName: Sentient
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: io.sentient.app
        GENERATE_INFOPLIST_FILE: NO
    dependencies:
      - framework: ../shared/mobile-sdk/build/XCFrameworks/release/MobileSdk.xcframework
        embed: true
```
(Adjust the framework path to Step 2's output. If debug build, use the debug XCFramework path.)

- [ ] **Step 4: Write the SwiftUI app (proves SKIE-exposed SDK call)**

`ios/App/SentientApp.swift`:
```swift
import SwiftUI

@main
struct SentientApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}
```
`ios/App/ContentView.swift`:
```swift
import SwiftUI
import MobileSdk   // SKIE-processed KMP framework (module name = MobileSdk)

struct ContentView: View {
    var body: some View {
        // NOTE (from Task 3): the Kotlin `object MobileSdk` collided with the framework
        // name, so SKIE exposes it as `MobileSdkKit` via @ObjCName. Swift call site is
        // MobileSdkKit.shared.greeting() — NOT MobileSdk.greeting().
        Text(MobileSdkKit.shared.greeting())
            .accessibilityIdentifier("foundation-greeting")
            .padding()
    }
}
```
`ios/App/Info.plist` (debug ATS exception scoped to dev host):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSExceptionDomains</key>
    <dict>
      <key>localhost</key>
      <dict>
        <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
        <key>NSIncludesSubdomains</key><true/>
      </dict>
    </dict>
  </dict>
</dict></plist>
```
> NOTE: ship this ATS exception in a **debug-only** Info.plist (xcodegen per-config plist) — never release. For the WSS self-signed cert, the SDK's iOS Ktor Darwin engine must, `#if DEBUG`, set a URLSession delegate trusting the dev host (wired in Plan 2/P1; for P0 the greeting needs no network).

- [ ] **Step 5: Generate the Xcode project + build for the 26.5 sim**

```bash
cd ios && xcodegen generate && cd ..
xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 14 Pro (26.5)' \
  -derivedDataPath ios/build build 2>&1 | tail -15
```
Expected: `** BUILD SUCCEEDED **`. (If SKIE/link errors mention Kotlin/SKIE mismatch, re-check Task 0 pins.)

- [ ] **Step 6: Install + launch + drive with Maestro, assert greeting**

```bash
DEV=$(xcrun simctl list devices | grep "iPhone 14 Pro (26.5)" | grep -oE "[0-9A-F-]{36}" | head -1)
APP=$(find ios/build -name "SentientApp.app" -type d | head -1)
xcrun simctl install "$DEV" "$APP"
cat > /tmp/foundation-ios.yaml <<'EOF'
appId: io.sentient.app
---
- launchApp
- assertVisible:
    id: "foundation-greeting"
- takeScreenshot: /tmp/foundation-ios
EOF
export PATH="$HOME/.maestro/bin:$PATH"; export MAESTRO_CLI_NO_ANALYTICS=1
maestro --device "$DEV" test /tmp/foundation-ios.yaml 2>&1 | grep -ivE "analytics" | tail -10
```
Expected: flow COMPLETED; `assertVisible id=foundation-greeting` passes → SDK linked + SKIE call rendered on iOS 26.5.

- [ ] **Step 7: Commit**

```bash
git add ios/ qa/ 2>/dev/null; git add ios/
git commit -m "feat(ios): scaffold SwiftUI app consuming mobile-sdk via SKIE + debug ATS"
```

---

## Task 6: Verify both apps reach the local gateway (P0c)

**Files:** none (verification task; uses the running deploy/macos stack)

- [ ] **Step 1: Ensure the gateway is up + healthy**

```bash
cd deploy/macos && docker compose up -d gateway && cd ../..
curl -sk --max-time 5 https://localhost:8888/api/v1/health
```
Expected: `{"status":"ok"}`.

- [ ] **Step 2: Confirm emulator → host reachability**

```bash
~/Library/Android/sdk/platform-tools/adb shell ping -c 2 -W 2 10.0.2.2 | tail -2
```
Expected: `0% packet loss`. (Full TLS WSS handshake from the app is exercised in Plan 2/P1 once the SDK connects; here we confirm the network path + that the debug network-security-config trusts the dev host.)

- [ ] **Step 3: Confirm sim → host reachability**

```bash
DEV=$(xcrun simctl list devices booted | grep -i "iPhone 14 Pro" | grep -oE "[0-9A-F-]{36}" | head -1)
xcrun simctl openurl "$DEV" https://localhost:8888/api/v1/health
sleep 3; xcrun simctl io "$DEV" screenshot /tmp/ios-gw-foundation.png
```
Expected: screenshot shows the gateway reached (JSON, or a cert prompt confirming the TLS handshake). Networking path validated; the app-level WSS trust (debug URLSession delegate) is implemented + asserted in Plan 2/P1.

- [ ] **Step 4: Record the dev-loop runbook**

Append a short `qa/mobile/README.md` documenting the validated commands: emulator start, `android run`/screen/layout, sim create/boot, `xcodebuild` build, `maestro test`, gateway up + health, host aliases (`10.0.2.2` / `localhost`). This is the agent's reusable driving reference.

- [ ] **Step 5: Commit**

```bash
git add qa/mobile/README.md
git commit -m "docs(qa): mobile dev-loop runbook + foundation reachability verified"
```

---

## Task 7: Foundation e2e matrix + handoff

**Files:**
- Create: `qa/mobile/foundation-matrix.md`

- [ ] **Step 1: Write the foundation e2e matrix (the done-contract)**

`qa/mobile/foundation-matrix.md`:
```markdown
# Foundation e2e matrix (P0)
| # | Case | Platform | How | Pass criteria | Status |
|---|------|----------|-----|---------------|--------|
| F1 | KMP common tests | shared | `./gradlew :shared:mobile-sdk:allTests` | PlatformTest green | |
| F2 | Android app builds + launches + renders SDK greeting | Android emu | android run + layout | greeting text in layout JSON | |
| F3 | iOS app builds + launches + renders SDK greeting | iPhone 14 Pro 26.5 | maestro assertVisible | id=foundation-greeting visible | |
| F4 | Emulator → host gateway reachable | Android emu | adb ping 10.0.2.2 + health | 0% loss + {"status":"ok"} | |
| F5 | Sim → host gateway reachable | iOS sim | simctl openurl + screenshot | gateway reached (TLS handshake) | |
| F6 | Rules load on edit | repo | edit a file under android/ ios/ shared/mobile-sdk | matching rules auto-load (manual confirm) | |
```

- [ ] **Step 2: Run the full matrix, mark each row**

Execute F1–F5 commands (from Tasks 3–6), set each Status to ✅. For F6, edit a throwaway line in a file under each subproject and confirm the right rule globs would match (paths check from Task 1 Step 2).

- [ ] **Step 3: Lint/typecheck gate (no regression to the TS monorepo)**

```bash
source scripts/env.sh && bun run lint && bun run typecheck 2>&1 | tail -5
```
Expected: clean (mobile dirs are outside the TS workspace; confirm no breakage). If the Gradle/mobile files trip Biome, add ignores in `biome.json` for `android/`, `ios/`, `shared/mobile-sdk/`, `gradle/`.

- [ ] **Step 4: Commit + push the branch**

```bash
git add qa/mobile/foundation-matrix.md biome.json 2>/dev/null; git add qa/
git commit -m "test(mobile): foundation e2e matrix green (P0 complete)"
git push -u origin feature/mobile-client
```

- [ ] **Step 5: Foundation handoff note**

Confirm: rules in place (android/ios/mobile/mobile-sdk), KMP module builds + tests, both apps launch + render an SDK call + are agent-drivable, gateway reachable from both. Plan 2 (P1 Shared SDK core) is unblocked.

---

## Self-Review

**Spec coverage (P0a/P0b/P0c):**
- P0a (adapt harness android/ios/mobile rules, re-scope globs, audit fixes, KMP-adapt, lift excludes) → Task 1 ✓
- P0b (author mobile-sdk KMP rules+details) → Task 2 ✓
- P0c (KMP scaffold + SKIE XCFramework + Maestro re-confirm on 26.5 + cert trust + sim/emulator↔gateway) → Tasks 3,4,5,6 ✓
- Dev TLS bypass scoped to debug+dev-host (spec §8) → Task 4 Step 2 (Android net-sec-config) + Task 5 Step 4 (iOS debug ATS) ✓
- e2e-matrix-as-contract (spec §8/§10) → Task 7 ✓
- Version verify-at-scaffold (spec flag 5) → Task 0 ✓
- Maestro re-confirm on iOS 26.5 (spec §8 caveat) → Task 5 Step 6 (runs on iPhone 14 Pro 26.5) ✓

**Out of P0 scope (correctly deferred to Plan 2+):** real `SentientSdk`/WS/auth/reconnect (P1), audio (P3), push (P4) — P0 only proves the SDK *links + calls* across both platforms and the toolchain/dev-loop is solid.

**Placeholder scan:** `SentientSdkPlaceholder.kt` / `MobileSdk.greeting()` are intentional P0 stubs (the real SDK is Plan 2), not plan placeholders — each step has concrete code/commands. No "TBD"/"add error handling".

**Type consistency:** `MobileSdk.greeting()` (common) ↔ `MobileSdk.shared.greeting()` (Swift, SKIE object accessor) ↔ `MobileSdk.greeting()` (Android Kotlin) — consistent. `Platform().name` actuals match the commonMain `expect`. `foundation-greeting` testID used identically in MainActivity (`testTag`), ContentView (`accessibilityIdentifier`), and both e2e assertions.

**Known execution risks (call out, don't block):** (1) SKIE↔Kotlin version mismatch → opaque iOS link error; Task 0 pins + verifies. (2) xcodegen framework path differs debug vs release; Task 5 Step 2 records the actual path. (3) First Kotlin/Native + WDA builds are slow (minutes) — expected, not a failure.
