---
description: Gradle conventions -- version catalog, Kotlin DSL, single app module, R8 on release.
paths:
  - "android/build.gradle.kts"
  - "settings.gradle.kts"
  - "gradle/**"
---

# Gradle Build Conventions

Build files are production code: typed, single-sourced. The app is a SINGLE module — no `build-logic/`, no feature/core module split, no annotation processors.

## Version catalog — single source

- ALL versions/libraries/plugins live in the version catalog. NO version literals in any build script.
- Module scripts reference catalog aliases only.

## Kotlin DSL

- All build scripts are `.kts`. NO Groovy.
- Keep the app module's applied plugins minimal; add one only for a real need.

## Toolchain — catalog is the source of truth

- SDK levels, Kotlin/AGP versions, and JVM target are pinned in the catalog and read from it; never hardcoded in a script.
- Compile-options JVM target matches the catalog JVM entry.
- The Compose compiler plugin is versioned with Kotlin.
- Don't bump AGP to a major requiring a newer Gradle major than pinned — verify first.

## Release — R8

- Release enables minify + resource shrink with the optimize + project ProGuard files.
- Debug appends an application-id suffix so both variants install side by side; the gateway URL is a build-config field.

## Future — NOT adopted (don't add preemptively)

- Convention plugins + a multi-module graph: only past a single screen-set.
- KSP: only when a KSP-based library is adopted — KSP, never KAPT.
- Baseline Profile + a benchmark module: a later perf step.

> When a rule is unclear, read `agents/docs/android/android-gradle-details.md`.
