# Task Brief: Assemble and verify the complete Android calendar experience

## Contribution Goal

The Android Calendar route delivers the full shared-state, reference-faithful four-view calendar with native sheets, offline browsing, exact mutation behavior, accessibility semantics, and agent-driven local evidence.

## Boundary — Included

- CalendarScreen route/Koin assembly
- Surface, filters, all views, agenda, floating bar, preview/editor sheets, mutation and freshness state wiring
- Native date/time controls and focus/back/safe-area integration
- Android unit/build integration and stable test tags
- Reusable direct-Maestro calendar flows/steps without runner changes
- Exact reference screenshots plus semantic accessibility/reduced-motion evidence

## Required Work

- 1. Replace the settings CRUD form with controlled CalendarScaffold, all four views, filters, agenda rows, floating view bar, preview/editor/scope/confirmation sheets, and all loading/empty/freshness/offline/error/conflict/permission states.
- 2. Wire Koin and the thin CalendarViewModel to the session CalendarExperience; collect lifecycle-aware, preserve route navigation, and ensure no Compose I/O or duplicate fetch/cache/filter/prefetch/mutation policy.
- 3. Integrate Android date/time controls while preserving shared all-day, raw offset-bearing recurrence originalStart, revision, scope, and occurrence identity; make Back dismiss the top overlay before navigating away and restore focus correctly.
- 4. Add stable content-free calendar test tags/accessibility IDs for view controls, dates, filters, events, overflow, freshness, Add, preview, editor fields, recurrence scopes, conflict, confirmation, retry, and offline states.
- 5. Expand JVM tests for screen-state wiring, navigation/back precedence, test-tag/accessibility contracts, date/time conversion, route recreation, and shared intent forwarding.
- 6. Add reusable direct Maestro calendar flows/steps under qa/mobile/flows/android for navigation, preferences, filters, CRUD, recurrence, conflict, child restriction, cache-first, cached/uncached offline, reconnect, account isolation, timezone/DST, visuals, and reduced motion. Do not modify the runner taxonomy/fault phase merely to create a calendar command.
- 7. Consume the local-only disposable fixture adapter produced by web-calendar-assembly. Every evidence run uses a unique namespace and guaranteed cleanup; never share a mutable principal with concurrent iOS evidence and never target production.
- 8. For offline/recovery evidence, let the final E2E agent directly orchestrate Maestro plus existing Android network controls and observable readiness, not arbitrary sleeps or a new runner subsystem.
- 9. Provision or select Android emulator display profiles with exact logical 390x844 and 430x932 dimensions and restore changed emulator settings afterward. Capture Day/Week/Month/Year, filters, dense agenda, preview, Add/Edit, recurrence, conflict, cached/unavailable offline, large-font, and reduced-motion screenshots against the exact reference.
- 10. Verify semantics/order, selected/today/outside labels, live view/filter/freshness updates, 44dp targets, font scaling, contrast, one scroll region, floating-bar/gesture clearance, bounded sheets, hidden-overlay semantics, Back/scrim/close, focus restoration, and no content logs. An actual TalkBack session is optional, not a delivery gate; do not claim semantic inspection is equivalent.

## Integration Expectation

Deliver this contribution for integration in stage android-calendar-assembly.

## Context

- This task owns replacing android/src/main/kotlin/io/sentient/android/settings/calendar/CalendarScreen.kt and integrating the completed surface, overlays, thin ViewModel, and session-scoped CalendarExperience.
- Exact comparison authority: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Serve `http://127.0.0.1:8799/design/mobile/calendar.html` using `python3 -m http.server 8799 --directory sentient-design`; compare Android at exact logical 390x844 and 430x932 profiles.
- Prototype defects are explicitly rejected: fixed data, incomplete Year dates, sub-44dp tag targets, hidden overlay semantics, focus gaps, and device-height overflow.
- Full Android/iOS E2E is run sequentially by the final E2E agent using direct Maestro and existing network/gateway controls. This task does not extend qa/mobile/run-e2e.sh or run shared-fixture E2E concurrently.

## Boundary — Excluded

- Changes to shared calendar policy unless a concrete integration defect is proven
- Changes to qa/mobile/run-e2e.sh or a new native E2E runner subsystem
- Concurrent shared-principal Android/iOS E2E
- Mandatory actual TalkBack execution
- iOS or web production code
- Production tests/mutations
- Importing sentient-design runtime/assets into Compose
- Unsupported prototype fields

## Interfaces and Dependencies

- Consumes Android CalendarViewModel, controlled surface/overlays, authenticated CalendarExperience, and the local-only disposable fixture adapter.
- Produces final Android CalendarScreen, stable test tags, and direct-Maestro steps for the final E2E agent.
