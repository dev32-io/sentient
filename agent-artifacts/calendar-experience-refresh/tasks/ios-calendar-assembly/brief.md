# Task Brief: Assemble and verify the complete iOS calendar experience

## Contribution Goal

The iOS Calendar route delivers the full shared-state, reference-faithful four-view calendar with native sheets, offline browsing, exact mutation behavior, accessibility, and repeatable local Maestro evidence.

## Boundary — Included

- CalendarScreen/UserSession assembly
- Surface, filters, all views, agenda, floating bar, preview/editor sheets, mutation and freshness state wiring
- Native SwiftUI date/time controls and focus/dismissal/safe-area integration
- Swift/Xcode tests and stable accessibility IDs
- Calendar-tagged iOS Maestro flows/screenshots for approved mobile E2E cases
- Exact reference, VoiceOver, Dynamic Type, and reduced-motion evidence

## Required Work

- 1. Replace the settings CRUD form with controlled CalendarScaffold, all four views, filters, agenda, floating view bar, preview/editor/scope/confirmation sheets, and loading/empty/freshness/offline/error/conflict/permission states.
- 2. Wire the route-local thin CalendarViewModel to UserSession's CalendarExperience using its owned SKIE collection task; preserve NavigationStack behavior and avoid SwiftUI side effects or native data policy.
- 3. Integrate native SwiftUI date/time controls while preserving shared all-day, timezone, recurrence originalStart, revision, scope, and occurrence identity. Dismiss the top sheet before navigation and restore focus to the exact opener.
- 4. Add stable accessibility identifiers for view/date/filter/event/overflow/freshness/Add/preview/editor/recurrence/conflict/confirmation/retry/offline controls without fixture content; preserve VoiceOver grouping/order.
- 5. Expand Swift tests for screen mapping, navigation/dismissal precedence, identifiers, date/time conversion, route recreation, collection cancellation, and exact shared intent forwarding. Regenerate only through xcodegen; do not commit hand-edited generated project files.
- 6. Add ordered `calendar` Maestro flows under qa/mobile/flows/ios plus runner/config integration. Cover iOS portions of CAL-UX-001..014: views/navigation; preferences; filters; create; recurrence preview/edit/delete; conflict; child restriction; cache-first; cached/uncached offline; reconnect; account isolation; timezone/DST; visuals/accessibility/reduced motion.
- 7. Use the real local stack and disposable/synthetic events only. Make fixture/login/cleanup deterministic, keep production untouched, and record structural evidence only. Use established gateway-stop/restart orchestration for iOS offline/recovery, never arbitrary sleeps.
- 8. Capture iOS screenshots at 390x844 and 430x932 for Day/Week/Month/Year, filters, dense agenda, preview, Add/Edit, recurrence scope, conflict, cached-offline, unavailable-offline, Dynamic Type, and reduced motion; compare with the exact served reference and document approved domain/accessibility corrections.
- 9. Verify VoiceOver order/labels, selected/today/outside values, live view/filter/freshness announcements, 44pt targets, Dynamic Type, contrast, one scroll region, floating-bar/home-indicator clearance, bounded keyboard-safe sheets, closed-overlay accessibility, swipe/close/Cancel, focus restoration, and no content logs.

## Integration Expectation

Deliver this contribution for integration in stage ios-calendar-assembly.

## Context

- This task owns replacing ios/App/Settings/Calendar/CalendarScreen.swift and integrating the completed SwiftUI surface, overlays, thin ViewModel, and session CalendarExperience.
- Exact comparison authority: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Serve `http://127.0.0.1:8799/design/mobile/calendar.html` with `python3 -m http.server 8799 --directory sentient-design`; compare iOS at 390x844 and 430x932.
- Reject prototype fixed data, incomplete Year, sub-44pt targets, hidden overlay/focus defects, and device-height overflow. ios/project.yml/XcodeGen remains project authority.

## Boundary — Excluded

- Changes to shared calendar policy unless a concrete integration defect is proven
- Android or web code
- Production tests/mutations
- Importing sentient-design runtime/assets into SwiftUI
- Unsupported prototype fields or hand-edited Xcode project files

## Interfaces and Dependencies

- Consumes ios CalendarViewModel, controlled SwiftUI surface/overlays, and session CalendarExperience.
- Produces final iOS CalendarScreen plus calendar-tagged Maestro/E2E contract.
