# Task Brief: Assemble and verify the complete web calendar workspace

## Contribution Goal

The production web Calendar route delivers the full reference-adapted four-view experience, complete V2 data and mutations, responsive behavior, and local-stack visual/accessibility proof.

## Boundary — Included

- CalendarView route assembly and state/action wiring
- Complete loading/empty/stale/error/permission/conflict/confirmation states
- Add/preview/edit/delete integration and post-mutation refresh
- Responsive and reduced-motion integration fixes
- Expanded web component/integration tests
- Real-local-stack browser charter/evidence for the approved web portions of CAL-UX-001..007, 013, and 014

## Required Work

- 1. Replace the fixed-week CRUD list in calendar-view.tsx with CalendarWorkspace using the complete controller, all four canvases, responsive filters/navigation/view bar, EventPreview, EventEditor, scope chooser, delete confirmation, and typed outcome presentations.
- 2. Wire event actions using eventId, occurrenceId, originalStart, scope, expectedRevision, and returned successor IDs; after successful online mutations invalidate/reload affected visible intervals without erasing current content.
- 3. Preserve unauthorized/adults-only non-disclosure, typed conflict review, deletion confirmation, loading-with-cache, empty, retryable failure, and permission states across every view.
- 4. Reconcile CSS through existing Dusk tokens/components, remove invalid calendar aliases and page-local colors, retain the canonical web hierarchy/effects/motion, and ensure prefers-reduced-motion collapses nonessential transitions.
- 5. Expand calendar-view and API integration tests for route entry, complete interval data, all views, filters/preferences, preview/editor flows, recurrence scopes, conflict/permission states, focus restoration, and narrow state continuity.
- 6. Start the real local stack through documented commands, use synthetic disposable calendar data only, and exercise Day/Week/Month/Year, filters, preview, create/edit/delete, recurrence, conflict, child visibility, and timezone behavior; never touch production.
- 7. Serve the exact reference and capture side-by-side screenshots for Day/Week/Month/Year, filters, preview, Add/Edit, dense days, and reduced motion at 1440x1000, 1024x900, 768x900, and 390x844. Assert no page horizontal overflow and record only approved deviations.
- 8. Capture semantic DOM/focus evidence for keyboard traversal, selected/today/outside labels, filter/view announcements, overflow access, modal containment/restoration, hidden overlays, 44px targets, and Escape/outside dismissal.
- 9. Add or update a maintainable local web calendar QA charter/evidence recipe that names the exact reference URLs, production URL, viewport matrix, synthetic fixture/cleanup steps, and CAL-UX checkpoints without logging content.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-assembly.

## Context

- This task is the sole owner of replacing the monolithic gateway/webui/src/components/calendar/calendar-view.tsx and assembling the independently built controller, canvas, shell, preview, and editor components.
- Exact comparison authority: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Serve with `python3 -m http.server 8799 --directory sentient-design`; compare production `https://localhost/` at 1440x1000, 1024x900, 768x900, and 390x844.
- The approved deviations are explicit all-scope Calendar V2 semantics, Google-style narrow sidebar collapse, seven-column shrink-to-fit, complete Year dates, viewport-safe overlays, and corrected accessibility.

## Boundary — Excluded

- Backend Calendar V2 behavior changes
- Web offline caching
- Native mobile code
- Importing sentient-design runtime into production
- Unsupported prototype member/place/reminder/color semantics

## Interfaces and Dependencies

- Consumes web CalendarController, projections, canvas, shell/filter, EventPreview, and EventEditor components.
- Preserves App route and CalendarApi boundaries; produces the complete production CalendarView behavior.
