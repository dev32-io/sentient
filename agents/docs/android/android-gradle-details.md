# Gradle Conventions -- Details & Templates

This file expands `platforms/android/rules/android-gradle.md`.
Templates for the version catalog, a convention plugin, and the
ProGuard rules every Android app ships with.

## `gradle/libs.versions.toml`

The whole point: one file holds every version number. Bumping
Kotlin is one edit; the build graph re-resolves.

```toml
[versions]
agp = "8.5.0"
kotlin = "2.0.0"
ksp = "2.0.0-1.0.21"
hilt = "2.51.1"
hilt-navigation-compose = "1.2.0"
compose-bom = "2024.06.00"
coroutines = "1.8.1"
lifecycle = "2.8.2"
junit4 = "4.13.2"
mockk = "1.13.10"

[libraries]
# Compose BoM aligns versioned-by-bom modules.
compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }
compose-ui = { group = "androidx.compose.ui", name = "ui" }
compose-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
compose-ui-tooling = { group = "androidx.compose.ui", name = "ui-tooling" }
compose-material3 = { group = "androidx.compose.material3", name = "material3" }
compose-runtime = { group = "androidx.compose.runtime", name = "runtime" }

# Lifecycle + Compose integration.
lifecycle-runtime-ktx = { group = "androidx.lifecycle", name = "lifecycle-runtime-ktx", version.ref = "lifecycle" }
lifecycle-runtime-compose = { group = "androidx.lifecycle", name = "lifecycle-runtime-compose", version.ref = "lifecycle" }
lifecycle-viewmodel-compose = { group = "androidx.lifecycle", name = "lifecycle-viewmodel-compose", version.ref = "lifecycle" }

# Coroutines.
kotlinx-coroutines-core = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-core", version.ref = "coroutines" }
kotlinx-coroutines-android = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-android", version.ref = "coroutines" }
kotlinx-coroutines-test = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-test", version.ref = "coroutines" }

# Hilt.
hilt-android = { group = "com.google.dagger", name = "hilt-android", version.ref = "hilt" }
hilt-compiler = { group = "com.google.dagger", name = "hilt-compiler", version.ref = "hilt" }
hilt-navigation-compose = { group = "androidx.hilt", name = "hilt-navigation-compose", version.ref = "hilt-navigation-compose" }

# Test.
junit = { group = "junit", name = "junit", version.ref = "junit4" }
mockk = { group = "io.mockk", name = "mockk", version.ref = "mockk" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
android-library = { id = "com.android.library", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
ksp = { id = "com.google.devtools.ksp", version.ref = "ksp" }
hilt = { id = "com.google.dagger.hilt.android", version.ref = "hilt" }
```

Usage in a module's `build.gradle.kts`:

```kotlin
dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
```

No version strings appear in the module script.

## Convention plugin -- Android application

`buildLogic/convention/build.gradle.kts`:

```kotlin
plugins {
    `kotlin-dsl`
}

dependencies {
    compileOnly(libs.android.gradle.plugin)
    compileOnly(libs.kotlin.gradle.plugin)
}

gradlePlugin {
    plugins {
        register("androidApplication") {
            id = "com.example.android.application"
            implementationClass =
                "com.example.buildLogic.AndroidApplicationConventionPlugin"
        }
        register("androidLibrary") {
            id = "com.example.android.library"
            implementationClass =
                "com.example.buildLogic.AndroidLibraryConventionPlugin"
        }
    }
}
```

`AndroidApplicationConventionPlugin.kt`:

```kotlin
class AndroidApplicationConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        with(pluginManager) {
            apply("com.android.application")
            apply("org.jetbrains.kotlin.android")
        }
        extensions.configure<ApplicationExtension> {
            compileSdk = 34
            defaultConfig {
                minSdk = 24
                targetSdk = 34
            }
            compileOptions {
                sourceCompatibility = JavaVersion.VERSION_21
                targetCompatibility = JavaVersion.VERSION_21
            }
            buildTypes {
                getByName("release") {
                    isMinifyEnabled = true
                    isShrinkResources = true
                    proguardFiles(
                        getDefaultProguardFile("proguard-android-optimize.txt"),
                        "proguard-rules.pro",
                    )
                }
            }
        }
        extensions.configure<KotlinAndroidProjectExtension> {
            compilerOptions {
                jvmTarget.set(JvmTarget.JVM_21)
            }
        }
    }
}
```

App-module usage:

```kotlin
// app/build.gradle.kts
plugins {
    id("com.example.android.application")
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.example.app"
    defaultConfig {
        applicationId = "com.example.app"
        versionCode = 1
        versionName = "0.1"
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    // ... feature modules and libs ...
}
```

The module script is short. The convention plugin owns the
boring repetition.

## `proguard-rules.pro` reference snippets

App-module rules tend to focus on serialization libs and
reflection-using frameworks.

```proguard
# kotlinx.serialization -- keep generated serializers.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.SerializationKt
-keep,includedescriptorclasses class **$$serializer { *; }
-keepclassmembers class * {
    *** Companion;
}
-keepclasseswithmembers class * {
    kotlinx.serialization.KSerializer serializer(...);
}

# Moshi (if used) -- keep adapters.
-keep class com.squareup.moshi.JsonAdapter
-keepclasseswithmembers class * {
    @com.squareup.moshi.* <methods>;
}

# Hilt-generated classes -- safe by default; rules here ensure
# reflection-based introspection (if any) still works.
-keep class dagger.hilt.** { *; }
-keep class * extends dagger.hilt.android.internal.managers.ViewComponentManager$* { *; }

# Coroutines -- keep nothing-by-default works; uncomment if R8
# strips a flow operator you reflect on.
# -keep class kotlinx.coroutines.** { *; }
```

For library modules, ship rules to consumers via
`consumerProguardFiles("consumer-rules.pro")` in the library
convention plugin. Consumer rules ride along with the AAR.

## Settings file pattern

`settings.gradle.kts`:

```kotlin
pluginManagement {
    includeBuild("buildLogic")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ExampleApp"
include(":app")
include(":feature:login")
include(":feature:home")
include(":core:data")
include(":core:designsystem")
```

`includeBuild("buildLogic")` is what makes the convention
plugins available to the rest of the build.

## Module-shape catalog (audit G1)

Mirrors Google's "Now in Android" pattern:

```
:app                        — wires DI, single Application class, Activity entry
:feature:home               — composables + VM + nav for home flow
:feature:profile            — same for profile
:core:designsystem          — MaterialTheme, color/typography tokens
:core:ui                    — reusable composables (loading states, scaffolds)
:core:data                  — Room + DataStore + Retrofit repository impls
:core:domain                — pure-Kotlin use-cases + models
:core:network               — Retrofit + OkHttp setup, interceptors
:core:testing               — Fakes, MainDispatcherRule, HiltTestActivity
:benchmark                  — Baseline Profile + Macrobenchmark suite
```

Convention plugins (under `build-logic/convention/`):
- `com.example.android.application` — applies Android + Kotlin + Compose plugins, sets compileSdk/minSdk, configures release R8.
- `com.example.android.library` — Android library equivalent.
- `com.example.android.feature` — library + Hilt plugin + Compose plugin.
- `com.example.android.hilt` — applies Hilt + KSP plugin and depends on `:core:domain`.

## KSP migration (audit A8)

Old (KAPT):

```kotlin
plugins {
    id("kotlin-kapt")
}
dependencies {
    kapt(libs.hilt.compiler)
}
```

New (KSP):

```kotlin
plugins {
    alias(libs.plugins.ksp)
}
dependencies {
    ksp(libs.hilt.compiler)
}
```

Catalog adds:

```toml
[versions]
ksp = "2.1.20-1.0.31"
[plugins]
ksp = { id = "com.google.devtools.ksp", version.ref = "ksp" }
```

Generated source paths shift slightly (`build/generated/ksp/...` vs `build/generated/source/kapt/...`); IDE indexing picks them up automatically.

## Baseline Profile + Macrobenchmark (audit G2)

Apply `androidx.baselineprofile` plugin in `:app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.baselineprofile)
}
baselineProfile {
    saveInSrc = true
}
dependencies {
    baselineProfile(project(":benchmark"))
}
```

`:benchmark/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.test)
    alias(libs.plugins.baselineprofile)
}
android {
    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true
}
dependencies {
    implementation(libs.androidx.benchmark.macro.junit4)
}
```

`:benchmark/src/main/java/.../BaselineProfileGenerator.kt`:

```kotlin
@RunWith(AndroidJUnit4::class)
class BaselineProfileGenerator {
    @get:Rule val rule = BaselineProfileRule()

    @Test
    fun generate() = rule.collect(packageName = "io.dev32.sample") {
        pressHome()
        startActivityAndWait()
        // exercise critical user flows here
    }
}
```

Run on a real device (rooted or `-PuseConnectedDeviceForBaselineProfile=true`); the plugin generates `baseline-prof.txt` in `:app/src/main/`. R8 reads it on release builds and pre-compiles those paths.

## Module-shape convention plugin example

`build-logic/convention/src/main/kotlin/AndroidApplicationConventionPlugin.kt`:

```kotlin
class AndroidApplicationConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        with(pluginManager) {
            apply("com.android.application")
            apply("org.jetbrains.kotlin.android")
            apply("org.jetbrains.kotlin.plugin.compose")
        }
        extensions.configure<ApplicationExtension> {
            compileSdk = 36
            defaultConfig {
                minSdk = 24
                targetSdk = 36
            }
            compileOptions {
                sourceCompatibility = JavaVersion.VERSION_21
                targetCompatibility = JavaVersion.VERSION_21
            }
        }
    }
}
```

Module declares:

```kotlin
plugins {
    `kotlin-dsl`
}
gradlePlugin {
    plugins {
        register("androidApplication") {
            id = "com.example.android.application"
            implementationClass = "AndroidApplicationConventionPlugin"
        }
    }
}
```
