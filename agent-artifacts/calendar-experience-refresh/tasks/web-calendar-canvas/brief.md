# Task Brief: Implement responsive web Day, Week, Month, and Year canvases

## Contribution Goal

Reusable web calendar canvas components render all four views with the exact approved Dusk hierarchy and shrink-to-fit behavior, without owning network or mutation state.

## Boundary — Included

- Leaf Day, Week, Month, and Year Preact renderers
- Day/date cells, event pills/indicators, agenda sections/rows, and +N overflow controls
- Canvas component-scoped CSS for seven-column shrink-to-fit and progressive event compaction
- Selected/today/outside-month/empty/loading semantics
- Component tests and exact viewport visual comparison evidence

## Required Work

- 1. Build leaf components that consume the pure web projection models and callbacks only and satisfy CalendarWorkspace's typed canvas-slot contract; do not fetch, persist, mutate, or edit shell/filter files.
- 2. Match the reference Dusk typography, paper/ink hierarchy, cell rhythm, radii, shadows, and event density through existing gateway/webui token files; do not copy prototype CSS wholesale or introduce page-local color constants.
- 3. Own canvas CSS in component-scoped files only. Render Month as six rows by seven `minmax(0,1fr)` columns, Week as seven equal columns, Day as a focused chronological agenda, and Year as twelve complete month summaries.
- 4. Implement progressive narrow representation: full title/time pills where supported, then hidden secondary time, accessible truncation, then semantic dots and +N. Overflow opens a reachable day-detail/event path through callbacks.
- 5. Add full-date labels, today/selected/outside announcements, pressed/selected state, keyboard activation, visible focus, and complete accessible names for truncated/dot events.
- 6. Keep the canvas inside its parent width at 768x900 and 390x844 with no page-level horizontal overflow and no substitution of the native mobile agenda composition.
- 7. Add component tests for the public canvas slot, all four renderers, empty/dense days, overflow access, keyboard semantics, and responsive layout invariants.
- 8. Capture implementation screenshots for all four views at the four exact web viewport sizes and compare side-by-side with the served reference; record intentional reviewed corrections rather than silently diverging.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-canvas.

## Context

- Implement in new focused files under gateway/webui/src/components/calendar so concurrent shell, preview, and editor work does not edit calendar-view.tsx.
- Exact visual references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Before editing, serve them with `python3 -m http.server 8799 --directory sentient-design` and inspect `http://127.0.0.1:8799/design/web/calendar.html` at 1440x1000, 1024x900, 768x900, and 390x844.
- Reviewed corrections override the prototype: remove its 680px Month and 116px Week minimums, fit seven columns at 390px, complete Year dates, and keep every compacted event accessible.
- CalendarWorkspace provides a typed children/render slot; canvas components implement that public slot and do not edit shell/filter files.

## Boundary — Excluded

- Workspace/sidebar/compact filter implementation and CSS
- Floating view bar and date-navigation ownership
- Preview positioning or editor dialogs
- Network controller and route assembly
- Modifying sentient-design references

## Interfaces and Dependencies

- Consumes CalendarProjection models from web-calendar-projections and implements the typed CalendarWorkspace canvas slot.
- Produces DayView, WeekGrid, MonthGrid, YearGrid, DayCell, EventIndicator, OverflowControl, AgendaSection, and AgendaRow components for CalendarWorkspace.
