# Task Brief: Refresh the complete Web Calendar workspace and overlays

## Contribution Goal

Migrate every reachable Day/Week/Month/Year Calendar state and CRUD overlay to the reviewed composition while preserving existing calendar projection, authorization, recurrence, conflict, cache, and mutation behavior.

## Boundary — Included

- Calendar shell/header/view switcher, filters/search/active summary, Day/Week/Month/Year canvases, event chips/dense-day behavior, preview, create/edit editor, native browser date/time controls, recurrence scope, confirmation/conflict/outcome overlays, focus/responsive/reduced-motion behavior.

## Required Work

- 1. Migrate Calendar components to shared primitives/common composites and task-owned product CSS. Replicate the reviewed Dusk composition and exact generated tokens; do not import prototype CSS/JS or add page-local color/type/radius/shadow/motion literals.
- 2. Preserve CalendarExperience/controller/API as behavioral authority: authorized occurrence identity, household/private scope, filters/groups/tags/importance, recurrence/DST/time-zone semantics, cache/offline/stale states, conflict reread, permission errors, and CRUD payloads must not be redesigned.
- 3. Refresh Day, Week, Month, and Year layouts with the reviewed responsive density. Preserve deterministic event ordering, overlap/overflow affordances, current day/selection, keyboard navigation, and no page-level horizontal overflow at desktop/tablet/mobile/200% zoom.
- 4. Refresh filters/search and active-filter summary. Keep labels and status readable without all-caps, maintain 44px coarse-pointer targets and visible focus, and preserve URL/component state only where already owned.
- 5. Refresh event preview anchoring/dismissal/focus restoration and the editor/recurrence/delete/discard/conflict/outcome overlays using the shared Dialog or a justified Calendar product overlay. Escape/backdrop policy, focus trap, scrolling body, pinned actions, keyboard visibility, and Reduced Motion must remain explicit.
- 6. Preserve native browser date/time inputs and validation. Do not implement prototype-only fields or alter recurrence/domain APIs. Visible unavailable editor actions remain honest.
- 7. Add/extend existing Calendar component/controller/projection/editor/preview tests for all states, four views, dense day, filters, overlay precedence/dismissal/focus, CRUD request identity, conflict, long labels, zoom/overflow, and reduced motion.
- 8. Update the Calendar QA charter only as needed to use the safe design-refresh harness and canonical reference path. E2E fixture setup/cleanup must remain loopback-only, unique, and guaranteed in finally-style cleanup.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Owned paths are gateway/webui/src/components/calendar/**, Calendar-specific CSS, and UI/service tests only where presentation contracts require them.
- Current states include sign-in/access unavailable, loading/stale/refreshing/empty/error, all four views, filters, dense-day overflow, preview, editor, recurring scope, delete/discard confirmation, conflict reread, and mutation outcomes.
- Authority is design/prototype/calendar/{README.md,handoff.md,index.html,calendar.css,calendar.js}; these are reference context only and cannot be imported/executed by production.

## Boundary — Excluded

- Gateway calendar domain/storage/recurrence redesign
- App route/topbar, Settings, Chat
- Production calendars or nonlocal fixture targets
- Pixel-perfect automated comparison
- Prototype runtime imports

## Interfaces and Dependencies

- Consumes existing Calendar services/controller/projection and Web shared components.
- Produces a refreshed CalendarView with unchanged route/API contracts and stable selectors for E2E-004/E2E-005.
