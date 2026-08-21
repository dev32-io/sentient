# Task Brief: Assemble and verify the complete Android calendar experience

## Contribution Goal

The Android Calendar route delivers the full shared-state, reference-faithful four-view calendar with native sheets, offline browsing, exact mutation behavior, accessibility, and repeatable local Maestro evidence.

## Boundary — Included

- CalendarScreen route/Koin assembly
- Surface, filters, all views, agenda, floating bar, preview/editor sheets, mutation and freshness state wiring
- Native date/time controls and focus/back/safe-area integration
- Android unit/build integration and stable test tags
- Calendar-tagged Maestro flows and screenshots for approved Android E2E cases
- Exact reference comparison and accessibility/reduced-motion evidence

## Required Work

- 1. Replace the settings CRUD form with the controlled CalendarScaffold, all four views, filters, agenda rows, floating view bar, preview/editor/scope/confirmation sheets, and all loading/empty/freshness/offline/error/conflict/permission states.
- 2. Wire Koin and the thin CalendarViewModel to the session CalendarExperience; collect lifecycle-aware, preserve route navigation, and ensure no Compose I/O or duplicate fetch/cache/filter/prefetch/mutation policy.
- 3. Integrate Android date/time controls while preserving shared all-day, timezone, recurrence originalStart, revision, scope, and occurrence identity; make Back dismiss the top overlay before navigating away and restore focus correctly.
- 4. Add stable calendar test tags/accessibility IDs for view controls, dates, filters, events, overflow, freshness, Add, preview, editor fields, recurrence scopes, conflict, confirmation, retry, and offline states without encoding fixture content.
- 5. Expand JVM tests for screen-state wiring, navigation/back precedence, test-tag/accessibility contracts, date/time conversion, route recreation, and shared intent forwarding.
- 6. Add ordered `calendar` Maestro flows under qa/mobile/flows/android plus runner/config integration. Cover Android portions of CAL-UX-001..014: views/navigation; preferences; filters; create; recurrence preview/edit/delete; conflict; child restriction; cache-first; cached/uncached offline; reconnect; account isolation; timezone/DST; visuals/accessibility/reduced motion.
- 7. Use the real local stack with disposable/synthetic events only. Make fixture/login/cleanup steps deterministic, keep production untouched, and record only sanitized IDs/types/counts/freshness. Network fault steps must use the established local harness, not arbitrary sleeps.
- 8. Capture Android screenshots at 390x844 and 430x932 for Day/Week/Month/Year, filters, dense agenda, preview, Add/Edit, recurrence scope, conflict, cached-offline, unavailable-offline, large font, and reduced motion; compare side-by-side with the exact served mobile reference and document approved domain/accessibility corrections.
- 9. Verify TalkBack semantics/order, selected/today/outside labels, live view/filter/freshness updates, 44dp targets, font scaling, contrast, one scroll region, floating-bar/gesture clearance, bounded sheets, hidden-overlay semantics, Back/scrim/close, focus restoration, and no content logs.

## Integration Expectation

Deliver this contribution for integration in stage android-calendar-assembly.

## Context

- This task owns replacing android/src/main/kotlin/io/sentient/android/settings/calendar/CalendarScreen.kt and integrating the completed surface, overlays, thin ViewModel, and session-scoped CalendarExperience.
- Exact comparison authority: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Serve `http://127.0.0.1:8799/design/mobile/calendar.html` using `python3 -m http.server 8799 --directory sentient-design`; compare Android at 390x844 and 430x932.
- Prototype defects are explicitly rejected: fixed data, incomplete Year dates, sub-44dp tag targets, hidden overlay semantics, focus gaps, and device-height overflow.

## Boundary — Excluded

- Changes to shared calendar policy unless a concrete integration defect is proven
- iOS or web code
- Production tests/mutations
- Importing sentient-design runtime/assets into Compose
- Unsupported prototype fields

## Interfaces and Dependencies

- Consumes android CalendarViewModel, controlled surface and overlay components, and authenticated CalendarExperience dependency.
- Produces the final Android CalendarScreen plus calendar-tagged Maestro/E2E contract.
