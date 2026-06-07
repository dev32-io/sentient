---
description: Jetpack Compose -- Compose Compiler plugin, pure composables, state hoisting, effects, strong-skipping, edge-to-edge, adaptive layouts.
paths:
  - "android/**"
---

# Jetpack Compose

The Compose runtime relies on purity, identity, and stability to skip work.

## Compose Compiler plugin — mandatory with Kotlin 2.0+

- Apply `org.jetbrains.kotlin.plugin.compose` Gradle plugin per Compose module; version **must equal** the Kotlin version.
- Declare the plugin in the version catalog `[plugins]` section and apply via `alias(libs.plugins.compose.compiler)`. Catalog entry shape is in the details file.
- Remove any legacy `composeOptions { … }` block that sets the compiler extension version — that pre-Kotlin-2.0 mechanism is ignored/errors with the new plugin.

## Pure composables + state hoisting

- `@Composable` body has NO side effects; use `LaunchedEffect` / `DisposableEffect` / `SideEffect`.
- `remember { }` survives recomposition; `rememberSaveable { }` survives process death.
- Stateless components take `state: T` + `onEvent: (Event) -> Unit`. Screen-level composables receive their ViewModel from the host (built via the platform ViewModel factory), NOT `hiltViewModel()`. NEVER reference a ViewModel in a leaf composable.

## Effects, stability, previews

- `LaunchedEffect(key)` — keyed coroutine; `DisposableEffect(key)` — setup+teardown; `SideEffect` — every recomposition.
- Strong-skipping (Compose Compiler 2.0+): all restartable composables are skippable. `@Stable` / `@Immutable` still pay off for cross-module types. Inspect via `metricsDestination` / `reportsDestination`.
- Every screen-level composable needs a `@Preview` (one per state). Use `@PreviewLightDark` + `@PreviewFontScale` for production screens.

## Edge-to-edge (A5)

- Call `enableEdgeToEdge()` before `setContent`; targetSdk 35+ enforces it.
- Theme: `Theme.Material3.DayNight.NoActionBar`. NEVER `@android:style/Theme.Material.*`.

## Adaptive layouts (G3)

- Read `WindowSizeClass`; branch on Compact/Medium/Expanded.
- `NavigationSuiteScaffold` (Material3 adaptive) auto-switches nav bottom/rail/drawer.


> When a rule is unclear, read `agents/docs/android/android-compose-details.md`.
