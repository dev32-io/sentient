# Task Brief: Build the Android calendar views, filters, agenda, and floating controls

## Contribution Goal

Reusable controlled Compose components implement the exact approved mobile calendar shell, horizontal filters, four compact views, agenda rows, and floating selector without owning I/O or overlay mutation policy.

## Boundary — Included

- Controlled CalendarScaffold/top bar/date navigation
- Horizontal scope and tag/filter rails
- Day, Week, Month, and Year Compose renderers
- Agenda sections/rows, indicators, overflow, freshness/empty/error states
- Floating four-view bar, insets, motion/reduced-motion, previews, and pure/component tests

## Required Work

- 1. Build controlled leaf composables receiving CalendarUiState slices and callbacks only; composables perform no I/O and do not construct shared policy.
- 2. Match the reference 58dp-style top bar, Terra Add action, 16dp horizontal content inset, heading/date controls, full-bleed horizontal filter rails, compact canvas, approximately 64dp agenda rows, and floating four-view bar above system gesture insets using existing tokens.
- 3. Render Month as 42 cells with up to three semantic indicators and +N access; Month date invokes Day. Render Week as seven equal dates and keep Week active on selection; Day is a focused agenda; Year has twelve complete month summaries and intentional month selection.
- 4. Keep one scroll region under fixed top controls and reserve bottom content inset so agenda rows clear the approximately 46dp view controls and home/gesture area.
- 5. Expose private/household/all scopes, groups, tags, importance, and search only. Horizontal rails retain selected absent facets as removable and never render prototype member/place/reminder/color semantics.
- 6. Implement 44dp minimum effective targets, selected/pressed/full-date/today/outside semantics, TalkBack labels, font scaling, visible focus, contrast, and state announcements. Compact tag visuals may be 34dp only with a 44dp hit area.
- 7. Use existing approximately 150ms feedback and 250ms state tokens, restrained press scale, Dusk blur/elevation equivalents, and LocalInspection/accessibility-safe reduced-motion behavior.
- 8. Add previews for 390x844 and 430x932 Day/Week/Month/Year, dense/empty/offline/error/font-scale states; compare each directly to the served exact reference and annotate only approved corrections.
- 9. Add focused pure/JVM tests for callback semantics, complete view models, accessibility-label builders, filter retention, and layout invariants that can be tested without coupling to incidental Compose internals.

## Integration Expectation

Deliver this contribution for integration in stage android-calendar-surface.

## Context

- Create leaf components in new Android calendar files; do not replace CalendarScreen yet so overlay and surface work can proceed independently.
- Exact visual references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Serve with `python3 -m http.server 8799 --directory sentient-design` and inspect `http://127.0.0.1:8799/design/mobile/calendar.html` at 390x844 and 430x932 before editing.
- Use existing Compose Dusk tokens/theme. Apply approved corrections: complete Year dates, 44dp effective tag targets, safe-area clearance, real state, and accessible semantics.

## Boundary — Excluded

- Preview/editor/mutation sheets
- CalendarScreen/ViewModel assembly and Maestro route flow
- Database/session/network policy
- New app-wide design system
- Changes to sentient-design runtime

## Interfaces and Dependencies

- Consumes Android CalendarUiState from android-calendar-viewmodel.
- Produces controlled Compose scaffold, filters, view canvases, agenda rows, freshness/error presentations, and FloatingViewBar for CalendarScreen.
