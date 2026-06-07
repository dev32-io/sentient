# Gradle Conventions — Details & Templates

This file expands `.claude/rules/android/android-gradle.md`. The mobile build is three modules — `:shared:mobile-sdk`, `:shared:mobile-data`, `:android` — with the app as a single module. No `build-logic/`, no annotation processors, no `:feature:*`/`:core:*` split.

## `settings.gradle.kts` (real)

```kotlin
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "sentient-mobile"
include(":shared:mobile-sdk")
include(":shared:mobile-data")
include(":android")
```

## `gradle/libs.versions.toml` (shape — keep aligned with the real catalog)

```toml
[versions]
kotlin = "2.3.10"
agp = "8.13.2"
skie = "0.10.11"
coroutines = "1.11.0"
ktor = "3.5.0"
androidx-lifecycle = "2.10.0"
compileSdk = "36"
minSdk = "26"
targetSdk = "36"

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
android-library     = { id = "com.android.library",     version.ref = "agp" }
kotlin-android      = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlinMultiplatform = { id = "org.jetbrains.kotlin.multiplatform", version.ref = "kotlin" }
compose-compiler    = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
skie                = { id = "co.touchlab.skie", version.ref = "skie" }
```

There is NO `hilt`, `ksp`, `mockk`, or `junit4` entry — the app has no DI framework and tests use `kotlin-test` only.

## `android/build.gradle.kts` (real, single module)

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
        applicationId = "io.dev32.sentient"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }
    buildTypes {
        getByName("debug")   { applicationIdSuffix = ".debug"; buildConfigField("String", "GATEWAY_WS_URL", "\"$debugGatewayUrl\"") }
        getByName("release") {
            buildConfigField("String", "GATEWAY_WS_URL", "\"\"")    // empty → in-app setup page
            isMinifyEnabled = true; isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}
dependencies {
    implementation(project(":shared:mobile-sdk"))
    implementation(project(":shared:mobile-data"))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)          // ProcessLifecycleOwner → PresenceCoordinator
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.ktor.client.okhttp)                  // AuthClient REST engine
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3); implementation(libs.compose.ui)
    implementation(libs.markdown.renderer.m3)                // assistant-bubble GFM
    implementation(libs.androidx.core.splashscreen)
    testImplementation(libs.kotlin.test)                     // Layer 1 JVM unit tests only
}
```

The debug gateway URL is read from gitignored `local.properties` (`sentient.gatewayUrl`, default `wss://10.0.2.2:8888/...` emulator loopback). Debug suffix `.debug` lets both variants co-install.

## `proguard-rules.pro` reference

```proguard
# kotlinx.serialization — keep generated serializers (wire protocol DTOs).
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class **$$serializer { *; }
-keepclassmembers class * { *** Companion; }
-keepclasseswithmembers class * { kotlinx.serialization.KSerializer serializer(...); }
```

## Pinned toolchain values (sentient repo)

These live in `gradle/libs.versions.toml` — update the catalog entry, not the rule or source.

- `compileSdk` / `targetSdk` = **36**; `minSdk` = **26**
- Kotlin = **2.3.10**; SKIE = **0.10.11** (must match Kotlin)
- AGP = **8.13.2** (paired with Gradle 8.13). Do NOT bump to AGP 9.x — needs Gradle 9.1+.
- `sourceCompatibility`/`targetCompatibility` = `VERSION_17`; `jvmTarget = JVM_17`
- Compose compiler = `org.jetbrains.kotlin.plugin.compose`, version pinned WITH Kotlin

Verify all pins against upstream latest before any bump (per verify-pinned-versions feedback).

## Future — NOT adopted (do not add preemptively)

These are migration TARGETS if the app outgrows a single module — none are wired today:

- **Convention plugins + multi-module**: a `build-logic/` included build hosting `androidApplication`/`androidLibrary`/`androidFeature` convention plugins, with a `:app` + `:feature:*` + `:core:*` graph (the "Now in Android" shape). Only worthwhile past a handful of screens.
- **Hilt + KSP**: add `com.google.dagger.hilt.android` + `com.google.devtools.ksp` plugins and `ksp(libs.hilt.compiler)` (KSP, never KAPT). Until adopted, DI is hand-wired (`android-di`).
- **Baseline Profile + Macrobenchmark**: `androidx.baselineprofile` in `:android` + a `:benchmark` module + JankStats. A release-perf step for later.
