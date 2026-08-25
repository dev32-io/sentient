# Task Brief: Refresh the complete native iOS Calendar workspace and overlays

## Contribution Goal

Migrate every reachable iOS Calendar state, view, filter, and CRUD overlay to the reviewed system while preserving session-owned calendar behavior and native platform interaction.

## Boundary — Included

- Calendar scaffold/header/view switcher, day agenda/week/month/year canvases, filters/search, event cells/dense days, preview, create/edit, native date/time controls, recurrence scope, delete/discard/conflict/outcome presentations, accessibility/responsive/reduced-motion states.

## Required Work

- 1. Migrate Calendar/** to iOS foundation/common components and native SwiftUI composition. Replicate the Dusk Calendar contract without importing prototype assets/code or adding local visual literals outside named structural constants.
- 2. Preserve UserSession-owned CalendarExperience, route-scoped collection, presentationReady, authorized occurrence identity, household/private scope, groups/tags/importance/search, recurrence/DST/time-zone behavior, cache/offline/stale/refreshing states, conflict reread/review, permission failures, and CRUD request semantics.
- 3. Refresh Day, Week, Month, and Year layouts and dense-day/overflow behavior for current iPhone/iPad widths. Preserve event ordering, current day/selection, scroll positions, safe areas, no clipped essential content, and large Dynamic Type adaptations.
- 4. Refresh filters and active summaries with native controls and non-color cues. Maintain 44pt targets, focus/accessibility labels, Reduced Motion, Increased Contrast, long-label wrapping, and predictable dismissal.
- 5. Refresh preview/editor/delete/discard/recurrence/conflict/outcome overlays. Preserve documented precedence, scrim/drag dismissal only where allowed, pinned reachable actions, internal scrolling, keyboard safe area, modal accessibility/focus restoration, 26pt top corners, 42×4 handle, 84% maximum height, and 48pt decisive actions where the reviewed Calendar overlay contract specifies them.
- 6. Use native SwiftUI DatePicker/Picker/Menu/text fields/sheets/alerts/confirmation dialogs where behavior requires them; document intentional native differences from HTML. Do not implement prototype-only fields or replace native navigation/back semantics.
- 7. Expand CalendarOverlayTests, CalendarSessionLifecycleTests, CalendarSurfaceTests, and CalendarViewModelTests for all view/state/overlay branches, precedence, focus/dismissal, CRUD identity, conflict/offline/permission, large Dynamic Type, long data, reduced motion, and no duplicate collectors.
- 8. Provide stable fixture/accessibility identifiers for E2E-009. Use only disposable local events and guarantee deletion/fixture cleanup; no production calendar access.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Sole owned path is ios/App/Settings/Calendar/** and its tests/reference docs. Existing state ownership is CalendarScreen/CalendarViewModel/CalendarExperience with Day/Week/Month/Year, filters, preview/editor, cache/offline/conflict/permission outcomes.
- Authority is design/prototype/calendar plus ios/App/Settings/Calendar/CalendarStateInventory.md and CalendarOverlayReference.md. These are reference context; production must replicate approved values/components, not import prototype files.
- Overlay precedence is outcome, conflict, delete confirmation, editor, preview and must remain deterministic.

## Boundary — Excluded

- Shared calendar domain/storage/recurrence changes
- Settings root or other pages
- Production testing
- Pixel-perfect assertions
- Prototype runtime imports
- Android/Web Calendar work

## Interfaces and Dependencies

- Consumes existing CalendarExperience/state/actions and iOS foundation/common components.
- Produces a refreshed native Calendar destination with unchanged session/lifecycle/API contracts.
