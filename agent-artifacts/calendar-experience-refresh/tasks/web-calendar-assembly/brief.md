# Task Brief: Assemble and verify the complete web calendar workspace

## Contribution Goal

The production web Calendar route delivers the full reference-adapted four-view experience, complete V2 data and mutations, responsive behavior, deterministic local fixtures, and agent-driven MCP visual/accessibility proof.

## Boundary — Included

- CalendarView route assembly and state/action wiring
- Complete loading/empty/stale/error/permission/conflict/confirmation states
- Add/preview/edit/delete integration and post-mutation refresh
- Explicit authenticated calendar capability projection for editor controls
- Minimal local-only disposable calendar fixture/cleanup adapter over existing gateway calendar E2E helpers
- Responsive and reduced-motion integration fixes
- Expanded web component/integration tests
- Real-local-stack Playwright MCP evidence for approved web CAL-UX cases

## Required Work

- 1. Replace the fixed-week CRUD list in calendar-view.tsx with CalendarWorkspace using the typed canvas slot, complete controller, all four canvases, responsive filters/navigation/view bar, EventPreview, EventEditor, scope chooser, delete confirmation, and typed outcome presentations.
- 2. Supply EventEditor with explicit calendar mutation capabilities from the authenticated principal/access projection. If the existing web auth state lacks the safe non-content role/capability field, add the narrow field at the auth boundary; never infer access from hidden calendar data.
- 3. Wire event actions using eventId, occurrenceId, raw originalStart, scope, expectedRevision, and returned successor IDs; after successful online mutations invalidate/reload affected intervals without erasing current content.
- 4. Preserve unauthorized/adults-only non-disclosure, typed conflict review, deletion confirmation, loading-with-cache, empty, retryable failure, and permission states across every view.
- 5. Reconcile component-scoped CSS through existing Dusk tokens, remove invalid calendar aliases/page-local colors, retain the canonical hierarchy/effects/motion, and ensure prefers-reduced-motion collapses nonessential transitions.
- 6. Extend the existing gateway calendar E2E helper with a minimal local-only seed/cleanup adapter usable by web and later native evidence. It must create unique disposable adult/child principals and synthetic timed, all-day, recurring, dense-day, conflict, visibility, and timezone cases; return only sanitized IDs; deterministically delete events/users/databases; refuse production/non-local targets; and never log content.
- 7. Expand calendar-view/API/helper tests for route entry, fixture refusal/cleanup, complete interval data, all views, filters/preferences, capability projection, preview/editor flows, recurrence scopes, conflict/permission states, focus restoration, and narrow state continuity.
- 8. Start the real local stack through documented commands, seed a unique run namespace, and use Playwright MCP to exercise Day/Week/Month/Year, filters, preview, CRUD, recurrence, conflict, child visibility, and timezone behavior. Cleanup runs in a guaranteed final step; never touch production.
- 9. Serve the exact reference and capture side-by-side screenshots for Day/Week/Month/Year, filters, preview, Add/Edit, dense days, and reduced motion at exactly 1440x1000, 1024x900, 768x900, and 390x844. Assert no page horizontal overflow and record only approved deviations.
- 10. Capture semantic DOM/focus evidence for keyboard traversal, selected/today/outside labels, filter/view announcements, overflow access, modal inertness/containment/restoration, hidden overlays, 44px targets, and Escape/safe-backdrop dismissal. Do not claim this is equivalent to an actual screen-reader run.
- 11. Add/update a maintainable local web calendar QA charter/evidence recipe naming exact reference URLs, production URL, viewport matrix, fixture/cleanup commands, sanitized evidence path, MCP steps, and CAL-UX checkpoints; do not add a separate Playwright test-runner project.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-assembly.

## Context

- This task is the sole owner of replacing gateway/webui/src/components/calendar/calendar-view.tsx and assembling the independently built controller, canvas, shell, preview, and editor components.
- Exact comparison authority: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Serve with `python3 -m http.server 8799 --directory sentient-design`; compare production `https://localhost/` at exactly 1440x1000, 1024x900, 768x900, and 390x844.
- The approved deviations are explicit all-scope Calendar V2 semantics, Google-style 900px sidebar collapse, seven-column shrink-to-fit, complete Year dates, viewport-safe overlays, and corrected accessibility.
- Web E2E remains agent-driven through Playwright MCP; this task does not create a separate checked-in browser-runner project. Semantic DOM, keyboard, focus, ARIA, geometry, and screenshot evidence are required; an actual screen-reader session is not a delivery gate for this WIP refresh.

## Boundary — Excluded

- Backend Calendar V2 behavior changes other than local-only fixture adaptation around existing helpers
- A new checked-in web E2E runner/project
- Mandatory actual screen-reader execution
- Web offline caching
- Native mobile code
- Importing sentient-design runtime into production
- Unsupported prototype member/place/reminder/color semantics

## Interfaces and Dependencies

- Consumes web CalendarController, projections/time helpers, typed canvas slot, shell/filter, EventPreview, EventEditor, and authenticated capability state.
- Preserves App route and CalendarApi boundaries; produces complete production CalendarView behavior.
- Produces a local-only disposable fixture/cleanup adapter reused by final Android/iOS evidence without becoming production API surface.
