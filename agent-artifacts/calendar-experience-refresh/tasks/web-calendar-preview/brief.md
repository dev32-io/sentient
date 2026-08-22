# Task Brief: Implement the accessible viewport-bound web event preview

## Contribution Goal

Web event controls can open a canonical Dusk preview popover that remains reachable within every reviewed viewport and preserves complete focus/dismissal behavior.

## Boundary — Included

- Controlled EventPreview popover component
- Anchor measurement and right/left/below fallback positioning
- Viewport clamping, bounded height, and internal scrolling
- Preview details/actions for supported Calendar V2 fields
- Focus transfer, containment, dismissal, restoration, reduced motion, and tests

## Required Work

- 1. Build EventPreview in isolated calendar files with a controlled open occurrence, anchor element/rect, close, edit, and delete callbacks.
- 2. Match the exact reference paper surface, Dusk blur/elevation, spacing, typography, supported details, action hierarchy, and approximately 150ms scrim/feedback plus 250ms state transition roles through existing tokens.
- 3. Position on the preferred right side, then left or below, clamp within viewport margins, and constrain height with internal scrolling; recompute on resize/scroll and never extend beyond the reachable viewport at 390x844.
- 4. Render only supported effective event details: title, description, all-day/timed values, timezone, scope, visibility, importance, group, tags, and recurrence. Exclude prototype member, color, place, and reminder semantics.
- 5. Move focus into the named preview, contain modal navigation as appropriate, support close, Escape, and safe outside click, make hidden preview inert/absent from the accessibility tree, and restore the exact originating event control.
- 6. Respect prefers-reduced-motion by collapsing nonessential transitions without removing state change feedback.
- 7. Add tests for every placement fallback, viewport clamping, bounded scroll, action identity, details mapping, Escape/outside/close paths, focus containment/restoration, hidden state, and reduced motion.
- 8. Capture open-preview comparisons against the exact web reference at 1440x1000 and 390x844, including anchors near every viewport edge.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-preview.

## Context

- There is no generic production popover positioning utility. Implement a calendar-local accessible preview in new files unless a genuinely reusable primitive can be added without destabilizing other menus.
- Exact references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Serve `http://127.0.0.1:8799/design/web/calendar.html` with `python3 -m http.server 8799 --directory sentient-design` and inspect the observed anchored preview rather than the prose-only preview-rail wording.
- Reviewed corrections require viewport clamping/internal scroll at 390x844 and complete accessible modal/popover semantics; do not copy the prototype overflow/focus defects.

## Boundary — Excluded

- Editor form or mutation execution
- Canvas and workspace assembly
- Generic menu refactoring outside calendar
- Unsupported prototype fields
- Changes to the reference runtime

## Interfaces and Dependencies

- Consumes effective occurrence details and stable action identity; emits close/edit/delete intents.
- Produces EventPreview for final CalendarWorkspace assembly.
