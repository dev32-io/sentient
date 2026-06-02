---
description: Gradle conventions -- version catalog, Kotlin DSL, convention plugins, KSP, R8 + Baseline Profile on release, module-shape catalog.
paths:
  - "android/**"
---

# Gradle Build Conventions

Build files are production code: typed, single-sourced, modular.

## Version catalog — single source

- ALL versions/libraries/plugins in `gradle/libs.versions.toml`. NO version literals elsewhere.
- Module scripts reference `libs.kotlinx.coroutines`, `alias(libs.plugins.compose.compiler)`, etc.

## Kotlin DSL + convention plugins

- All build scripts `.kts`. NO Groovy `.gradle` for new modules.
- `build-logic/` included build hosts custom Gradle plugins. One convention per module shape.
- Module scripts reduce to "apply convention + declare deps."

## KSP, not KAPT

- Apply `com.google.devtools.ksp` plugin; replace every `kapt(...)` with `ksp(...)`.
- KAPT is on deprecation path; KSP is ~2x faster on incremental.

## Module-shape catalog (G1)

- `:app` — wires DI root. `:feature:<name>` — depends on `:core:*` only; no feature→feature deps.
- `:core:designsystem` theme/tokens, `:core:ui` shared composables, `:core:data` repos+sources.
- `:core:domain` use-cases+models, `:core:testing` fakes+rules. Bottom-up deps only.

## Toolchain — version catalog is the source of truth

- All SDK levels (`compileSdk`, `targetSdk`, `minSdk`), Kotlin version, AGP version, and JVM target are pinned in `gradle/libs.versions.toml`. Concrete values live there and in the details file.
- `compileOptions` sourceCompatibility + targetCompatibility must match the catalog JVM target entry.
- Compose compiler plugin version **must equal** Kotlin version (see catalog `compose-compiler` entry).
- Do NOT bump AGP to a major version that requires a newer Gradle major version than the repo pins — verify compatibility before any Kotlin/AGP bump.

## R8 + Baseline Profile (G2a)

- Release: `isMinifyEnabled = true`, `isShrinkResources = true`.
- Apply `androidx.baselineprofile` in `:app` + `:benchmark`; baseline profile rules ship with APK.


> When a rule is unclear, read `agents/docs/android/android-gradle-details.md`.
