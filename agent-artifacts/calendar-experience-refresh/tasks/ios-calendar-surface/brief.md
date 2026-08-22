# Task Brief: Build the iOS calendar views, filters, agenda, and floating controls

## Contribution Goal

Reusable controlled SwiftUI components implement the exact approved mobile calendar shell, horizontal filters, four compact views, agenda rows, and floating selector without owning I/O or shared policy.

## Boundary — Included

- Controlled CalendarScaffold/top bar/date navigation
- Horizontal scope and tag/filter rails
- Day, Week, Month, and Year SwiftUI renderers
- Agenda sections/rows, indicators, overflow, freshness/empty/error states
- Floating four-view bar, safe areas, motion/reduced-motion, previews, and focused tests

## Required Work

- 1. Build leaf views receiving immutable CalendarUiState slices and closures only; SwiftUI bodies remain side-effect free and perform no I/O.
- 2. Match the reference 58pt-style top bar, Terra Add action, 16pt content inset, heading/date controls, full-bleed filter rails, compact canvas, approximately 64pt agenda rows, and floating four-view bar above the home indicator using existing token projections.
- 3. Render Month as 42 cells with up to three indicators and +N access; Month date invokes Day. Render Week as seven equal dates and remains Week on selection; Day is focused agenda; Year has twelve complete summaries and intentional month selection.
- 4. Keep one scroll region beneath fixed controls and reserve bottom content inset so agenda rows clear approximately 46pt view controls and safe areas.
- 5. Expose supported private/household/all, groups, tags, importance, and search only; retain selected absent facets as removable and omit prototype member/place/reminder/color semantics.
- 6. Implement 44pt minimum effective targets, selected/pressed/full-date/today/outside accessibility values, VoiceOver order/labels, Dynamic Type, focus, contrast, and state announcements. Compact 34pt tag visuals require 44pt hit areas.
- 7. Use shared approximately 150ms feedback and 250ms state motion, restrained press scale, material/blur/elevation equivalents, and `accessibilityReduceMotion` to make nonessential changes immediate.
- 8. Add SwiftUI previews at 390x844 and 430x932 for Day/Week/Month/Year, dense/empty/offline/error, safe-area, and Dynamic Type states; compare directly to the served exact reference and annotate approved corrections only.
- 9. Add focused Swift tests for interaction closures/model mapping, accessibility-label builders, filter retention, complete dates, and stable layout semantics without snapshotting incidental internals.

## Integration Expectation

Deliver this contribution for integration in stage ios-calendar-surface.

## Context

- Create leaf SwiftUI files and previews; do not replace CalendarScreen yet so overlay and surface work remain independent.
- Exact visual references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Serve with `python3 -m http.server 8799 --directory sentient-design` and inspect `http://127.0.0.1:8799/design/mobile/calendar.html` at 390x844 and 430x932 before editing.
- Use existing shared Dusk token projections in ios/App/Theme. Apply approved corrections: complete Year dates, 44pt effective tag targets, safe-area clearance, real state, and accessible semantics.

## Boundary — Excluded

- Preview/editor/mutation sheets
- CalendarScreen/ViewModel assembly and Maestro route flow
- Database/session/network policy
- New app-wide design system or hand-edited Xcode project
- Changes to sentient-design runtime

## Interfaces and Dependencies

- Consumes Swift CalendarUiState from ios-calendar-viewmodel.
- Produces controlled SwiftUI scaffold, filters, view canvases, agenda, freshness/error presentations, and FloatingViewBar for CalendarScreen.
