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
