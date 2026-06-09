---
paths: ["shared/mobile-sdk/build.gradle.kts", "shared/mobile-data/build.gradle.kts", "settings.gradle.kts", "build.gradle.kts", "gradle/**"]
---
# KMP Gradle

- Applies to every shared KMP module.
- ALL versions live in `gradle/libs.versions.toml`. No version literals in any build file.
- Targets: `androidTarget()`, `iosArm64()`, `iosSimulatorArm64()` (+ `iosX64()` only if an Intel CI needs it).
- Each module's iOS output is its own SKIE-built XCFramework; its Android output is a `com.android.library`.
- Apply `co.touchlab.skie` so the Swift API gets Flow→AsyncSequence / suspend→async / sealed→enum. Verify SKIE supports the pinned Kotlin version BEFORE bumping Kotlin.
- commonTest uses kotlin-test + kotlinx-coroutines-test. No Robolectric/XCTest in the shared module.
- Keep the module under the 300-line/40-line clean-code limits per file (split early).


> When a rule is unclear, read `agents/docs/mobile-sdk/kmp-gradle-details.md`.
