# Task Brief: Android calendar Compose screen, nav, and ViewModel

## Contribution Goal

Deliver the Android calendar Compose screen, route, ViewModel (consuming shared use cases), Koin binding, and drawer settings-row icon consuming the mobile-data calendar use cases.

## Boundary — Included

- android CalendarScreen consuming a route-scoped CalendarViewModel that uses shared calendar use cases
- Routes.kt route constant and SettingsNav.kt composable destination
- Koin ViewModel binding and Compose screen with list/create/update/delete via the use cases
- Drawer/settings-row calendar icon and accessibility IDs
- Unit tests for the ViewModel state folding

## Required Work

- 1. Add a SETTINGS_CALENDAR route in Routes.kt and a composable destination in SettingsNav.kt.
- 2. Create CalendarViewModel (Koin) consuming the shared calendar use cases (not the raw repository) with state folding, and CalendarScreen rendering list/create/update/delete.
- 3. Add a drawer/settings-row calendar icon with accessibility IDs consistent with existing contracts.
- 4. Add unit tests for ViewModel state folding and screen wiring.
- 5. Run Android unit tests and Kotlin compile from the repo root.

## Integration Expectation

Deliver this contribution for integration in stage s8-android.

## Context

- Android precedent is android/src/main/kotlin/io/sentient/android/settings/memory/MemoryScreen.kt with a route-scoped Koin ViewModel.
- Navigation is Navigation Compose: android/.../nav/Routes.kt and SettingsNav.kt (e.g. SETTINGS_MEMORY).
- Drawer/settings seam is android/.../nav/ChatHost.kt and history/HistoryDrawer.kt; screens consume SettingsComponent, not raw SDK clients.
- Platform ViewModels must consume shared use cases (not raw repositories) per the mobile-data contract.
- Gradle is invoked from the repository root; accessibility IDs are part of mobile E2E contracts.

## Boundary — Excluded

- iOS screen
- mobile-data repo (s7-mobile-data)

## Interfaces and Dependencies

- Produces: Android calendar screen and nav consuming calendar use cases from s7-mobile-data.
- Consumes: mobile-data calendar use cases; existing Navigation Compose and Koin seams.
