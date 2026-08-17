# Task Acceptance: Android calendar Compose screen, nav, and ViewModel

## Deliverables

- Deliver the Android calendar Compose screen, route, ViewModel (consuming shared use cases), Koin binding, and drawer settings-row icon consuming the mobile-data calendar use cases.

## Acceptance

- The Android calendar screen lists events from the route-scoped ViewModel
- The ViewModel consumes shared calendar use cases (not the raw repository)
- A calendar route, SettingsNav destination, Koin binding, and drawer settings-row icon are added
- Accessibility identifiers follow existing mobile E2E contracts

## Boundary Proof

- Android unit tests cover ViewModel state folding and screen wiring
