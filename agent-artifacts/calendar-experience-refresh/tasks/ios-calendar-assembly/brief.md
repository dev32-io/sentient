# Task Brief: Assemble and verify the complete iOS calendar experience

## Contribution Goal

The iOS Calendar route delivers the full shared-state, reference-faithful four-view calendar with native sheets, offline browsing, exact mutation behavior, accessibility semantics, and agent-driven local evidence.

## Boundary — Included

- CalendarScreen/UserSession assembly
- Surface, filters, all views, agenda, floating bar, preview/editor sheets, mutation and freshness state wiring
- Native SwiftUI date/time controls and focus/dismissal/safe-area integration
- Swift/Xcode tests and stable accessibility IDs
- Reusable direct-Maestro calendar flows/steps without runner changes
- Exact reference screenshots plus semantic accessibility/Dynamic Type/reduced-motion evidence

## Required Work

- 1. Replace the settings CRUD form with controlled CalendarScaffold, all four views, filters, agenda, floating view bar, preview/editor/scope/confirmation sheets, and loading/empty/freshness/offline/error/conflict/permission states.
- 2. Wire the route-local thin CalendarViewModel to UserSession's CalendarExperience using its owned SKIE collection task; preserve NavigationStack behavior and avoid SwiftUI side effects or native data policy.
- 3. Integrate native SwiftUI date/time controls while preserving shared all-day, raw offset-bearing recurrence originalStart, revision, scope, and occurrence identity. Dismiss the top sheet before navigation and restore focus to the exact opener.
- 4. Add stable content-free accessibility identifiers for view/date/filter/event/overflow/freshness/Add/preview/editor/recurrence/conflict/confirmation/retry/offline controls; preserve logical accessibility grouping/order.
- 5. Expand Swift tests for screen mapping, navigation/dismissal precedence, identifiers, date/time conversion, route recreation, collection cancellation, and exact shared intent forwarding. Regenerate only through scripts/ios-setup.sh; do not commit hand-edited generated project files.
- 6. Add reusable direct Maestro calendar flows/steps under qa/mobile/flows/ios for navigation, preferences, filters, CRUD, recurrence, conflict, child restriction, cache-first, cached/uncached offline, reconnect, account isolation, timezone/DST, visuals, and reduced motion. Do not modify the runner taxonomy/fault phase merely to create a calendar command.
- 7. Consume the local-only disposable fixture adapter produced by web-calendar-assembly. Every evidence run uses a unique namespace and guaranteed cleanup; never share a mutable principal with concurrent Android evidence and never target production.
- 8. For offline/recovery evidence, let the final E2E agent directly orchestrate Maestro plus existing gateway-stop/restart or simulator network controls with observable readiness, not arbitrary sleeps or a new runner subsystem.
- 9. Provision/select simulator profiles with exact logical 390x844 and 430x932 dimensions (for example compatible 390pt and 430pt iPhone profiles), documenting actual device/OS and restoring changed simulator state. Capture all four views, filters, dense agenda, overlays, recurrence, conflict, cached/unavailable offline, Dynamic Type, and reduced motion against the exact reference.
- 10. Verify accessibility grouping/labels, selected/today/outside values, live view/filter/freshness announcements, 44pt targets, Dynamic Type, contrast, one scroll region, floating-bar/home-indicator clearance, bounded keyboard-safe sheets, closed-overlay accessibility, swipe/close/Cancel, focus restoration, and no content logs. An actual VoiceOver session is optional, not a delivery gate; do not claim semantic inspection is equivalent.

## Integration Expectation

Deliver this contribution for integration in stage ios-calendar-assembly.

## Context

- This task owns replacing ios/App/Settings/Calendar/CalendarScreen.swift and integrating the completed SwiftUI surface, overlays, thin ViewModel, and session CalendarExperience.
- Exact comparison authority: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Serve `http://127.0.0.1:8799/design/mobile/calendar.html` with `python3 -m http.server 8799 --directory sentient-design`; compare iOS at exact logical 390x844 and 430x932 profiles.
- Reject prototype fixed data, incomplete Year, sub-44pt targets, hidden overlay/focus defects, and device-height overflow. ios/project.yml/XcodeGen remains project authority.
- Full Android/iOS E2E is run sequentially by the final E2E agent using direct Maestro and existing network/gateway controls. This task does not extend qa/mobile/run-e2e.sh or run shared-fixture E2E concurrently.

## Boundary — Excluded

- Changes to shared calendar policy unless a concrete integration defect is proven
- Changes to qa/mobile/run-e2e.sh or a new native E2E runner subsystem
- Concurrent shared-principal Android/iOS E2E
- Mandatory actual VoiceOver execution
- Android or web production code
- Production tests/mutations
- Importing sentient-design runtime/assets into SwiftUI
- Unsupported prototype fields or hand-edited Xcode project files

## Interfaces and Dependencies

- Consumes iOS CalendarViewModel, controlled SwiftUI surface/overlays, session CalendarExperience, and the local-only disposable fixture adapter.
- Produces final iOS CalendarScreen, stable accessibility IDs, and direct-Maestro steps for the final E2E agent.
