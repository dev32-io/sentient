---
description: Android testing -- JVM unit, JVM Compose (Robolectric/Roborazzi), Compose UI, instrumented, E2E, Macrobenchmark.
paths:
  - "android/**"
---

# Android Testing

Six layers, each with a clear cost / scope tier. Picking the wrong tier means slow runs or weak assertions.

## Layer 1 — JVM unit

- ViewModels, reducers, pure use-cases, mappers, parsers; no Android framework.
- `runTest { ... }` + `TestDispatcher` for time control. `MainDispatcherRule` swaps `Dispatchers.Main`.

## Layer 1.5 — JVM with Android facades (G2)

- Robolectric + `createComposeRule()` runs Compose tests on JVM (no emulator). Roborazzi/Paparazzi for screenshot regression.

## Layer 2 — Compose UI tests (on-device)

- `createComposeRule()` stateless; `createAndroidComposeRule<HiltTestActivity>()` for DI-injected screens.
- Drive with `onNodeWithText` / `onNodeWithTag` / `performClick` / `assertIsDisplayed`. NEVER `Thread.sleep`.
- Hilt swaps via `@TestInstallIn`.

## Layers 3-4 — instrumented + E2E

- Layer 3 (`androidTest`): real Android runtime for Room migrations, DataStore I/O, deep links, permissions.
- Layer 4 (Maestro): `.yaml` flows in `qa/android/charters/`; happy path + critical regressions only.

## Layer 5 — Macrobenchmark + JankStats (G2b)

- `:benchmark` module with `MacrobenchmarkRule`; measure cold start, frame timing.
- `androidx.metrics.performance:JankStats` registered in Activity for production frame metrics.

## Discipline

- Fakes over mocks for repo-shaped deps; mocks only at adapter/SDK boundaries.
- Test names: `` `returns NotFound when id is unknown`() ``. One assertion per claim. Arrange-Act-Assert.


> When a rule is unclear, read `agents/docs/android/android-testing-details.md`.
