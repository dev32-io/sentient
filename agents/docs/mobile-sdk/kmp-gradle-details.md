# KMP Gradle — Details

All build configuration for the shared KMP modules (`shared/mobile-sdk` and `shared/mobile-data`) follows a strict version-catalog + target discipline.

## Examples

**libs.versions.toml snippet (versions centralized — keep these aligned with the real catalog):**
```toml
[versions]
kotlin = "2.3.10"
skie = "0.10.11"
agp = "8.13.2"
coroutines = "1.11.0"
ktor = "3.5.0"

[libraries]
kotlinx-coroutines-core = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-core", version.ref = "coroutines" }
kotlinx-coroutines-test  = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-test",  version.ref = "coroutines" }
ktor-client-core         = { module = "io.ktor:ktor-client-core",         version.ref = "ktor" }

[plugins]
skie = { id = "co.touchlab.skie", version.ref = "skie" }
```

**build.gradle.kts for shared/mobile-sdk:**
```kotlin
plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidLibrary)
    alias(libs.plugins.skie)
}
kotlin {
    androidTarget { compilations.all { kotlinOptions.jvmTarget = "17" } }
    iosArm64(); iosSimulatorArm64()
    sourceSets {
        commonMain.dependencies { implementation(libs.kotlinx.coroutines.core) }
        commonTest.dependencies { implementation(kotlin("test")); implementation(libs.kotlinx.coroutines.test) }
        androidMain.dependencies { implementation(libs.ktor.client.okhttp) }
        iosMain.dependencies     { implementation(libs.ktor.client.darwin) }
    }
}
val xcf = XCFramework("MobileSdk")
listOf(iosArm64(), iosSimulatorArm64()).forEach {
    it.binaries.framework { baseName = "MobileSdk"; xcf.add(this) }
}
```

`shared/mobile-data` has its own identical block producing the **`MobileData`** XCFramework (also SKIE-bridged). The iOS app links BOTH frameworks (see `ios/App/project.yml`); the Android app depends on both `:shared:mobile-sdk` and `:shared:mobile-data`. Module graph: `settings.gradle.kts` declares `:shared:mobile-sdk`, `:shared:mobile-data`, `:android` (single app module — no `build-logic/` convention plugins, no `:feature:*`/`:core:*` split).

## Gotchas

- SKIE version MUST match the Kotlin version; a Kotlin bump with stale SKIE fails the iOS link with an opaque error. We pin Kotlin 2.3.10 to SKIE 0.10.11's ceiling — see gradle/libs.versions.toml.
- Both XCFrameworks must rebuild together when a shared type crosses the module boundary (e.g. `SentientError` lives in mobile-sdk but `SentientResult` in mobile-data references it) — a stale `MobileData.xcframework` against a fresh `MobileSdk` link-fails on iOS.
- `iosX64()` adds an Intel simulator slice; only add it if CI actually has Intel runners — it doubles iOS build time for no mobile benefit on Apple-Silicon-only CI.
- Android library modules need `namespace` set in the `android {}` block or AGP 8+ throws a manifest-merger error.
