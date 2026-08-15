# Gradle details

This expands `.claude/rules/android.md`. Build files use Kotlin DSL and `gradle/libs.versions.toml`.

## Modules and toolchain

The Android graph is the single app module `:android` plus shared `:shared:mobile-sdk` and `:shared:mobile-data`; settings includes those three modules. Do not add `build-logic`, feature/core splits, or annotation processors.

Current pins in the catalog:

- Kotlin `2.3.10`; Compose compiler plugin follows Kotlin.
- AGP `8.13.2`, Gradle `8.13`, Java/Kotlin JVM target 17.
- compile/target SDK `36`; min SDK `26`.
- Koin `4.1.0`; Navigation Compose `2.9.5`.
- Compose BOM `2026.05.01`; coroutines `1.11.0`.

The app applies the Android application, Kotlin Android, and Compose compiler plugins. Compose dependencies use the BOM. Production DI dependencies are Koin runtime, Android, Compose, and navigation integrations; there is no Hilt or KSP.

## Backend build configuration

Debug reads `sentient.gatewayUrl` from gitignored `local.properties`. If absent, `GATEWAY_WS_URL` is:

```text
wss://10.0.2.2:443/api/v1/ws
```

Release bakes an empty URL so the app opens backend setup. Debug has application ID suffix `.debug`; application IDs are `io.dev32.sentient.debug` and `io.dev32.sentient`.

## Tests and build

JVM tests use `kotlin-test` and `kotlinx-coroutines-test`; the app has no configured MockK, Robolectric, Roborazzi, Macrobenchmark, or JankStats. Do not document or add those tools as if they were present. Keep dependency changes in the catalog and module build file together, and run the repository's normal Gradle checks after build changes.
