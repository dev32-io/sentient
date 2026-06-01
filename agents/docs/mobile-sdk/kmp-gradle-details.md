# KMP Gradle — Details

All build configuration for `shared/mobile-sdk` follows a strict version-catalog + target discipline.

## Examples

**libs.versions.toml snippet (versions centralized):**
```toml
[versions]
kotlin = "2.0.21"
skie = "0.10.1"
agp = "8.5.2"
coroutines = "1.9.0"
ktor = "3.0.3"

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

## Gotchas

- SKIE version MUST match the Kotlin version; a Kotlin bump with stale SKIE fails the iOS link with an opaque error. We pin Kotlin 2.3.10 to SKIE 0.10.11's ceiling — see gradle/libs.versions.toml.
- `iosX64()` adds an Intel simulator slice; only add it if CI actually has Intel runners — it doubles iOS build time for no mobile benefit on Apple-Silicon-only CI.
- Android library modules need `namespace` set in the `android {}` block or AGP 8+ throws a manifest-merger error.
