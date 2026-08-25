# Calendar implementation handoff

## Outcome

- Implement the reviewed household calendar as a source-true, responsive workspace under the authority of `DESIGN.MD`.
- Preserve day, week, month, and year behavior; direct filtering; readable event density; explicit preview and mutation flows; and native platform interaction conventions.
- Keep Preact, SwiftUI, and Compose implementations native. The prototype is a visual, semantic, responsive, and interaction contract—not a shared runtime dependency.
- Keep chat, composer, navigation, tool activity, assistant actions, reminders, places, conflict checking, and unsupported event fields outside this implementation scope.

## Source

- Entry point: `design/prototype/calendar/index.html`.
- Calendar composition, responsive behavior, material, overlays, and editor layout: `design/prototype/calendar/calendar.css`.
- Fixture projection, filters, navigation, preview, overflow, and mutation demonstrations: `design/prototype/calendar/calendar.js`.
- Foundation snapshot: `design/prototype/calendar/vendor/`; production must consume native foundation components rather than copied prototype CSS or JavaScript.
- Durable authority: `DESIGN.MD`.
- Primitive contract: `design/prototype/foundation-components/handoff.md`.
- Disclosure-shell contract: `design/prototype/common-composites/handoff.md`.
- The current Calendar prototype entry point, stylesheet, interaction simulation, and handoff are the consolidated visual and interaction authority.
- Current web behavior and projection: `gateway/webui/src/components/calendar/calendar-shell.tsx`, `gateway/webui/src/components/calendar/calendar-canvas-primitives.tsx`, `gateway/webui/src/components/calendar/calendar-projection-types.ts`, and `gateway/webui/src/services/calendar-api.ts`.
- No checkpoint snapshot was created; the current prototype entry point is the reviewed state.

## Behavior

- Support Day, Week, Month, and Year with previous, Today, and next navigation. The switcher shrink-wraps its labels and remains reachable above the calendar without reserving a broad bar.
- Month always presents the complete six-row grid without an internal vertical drag. Visible event density adapts to available cell height; remaining events stay reachable through a correctly counted `+N more` action.
- Compact-phone month cells retain semantic event buttons while presenting importance dots. Day and Week recompose into readable agendas instead of forcing a clipped wide grid.
- Selecting a Month date opens Day. Selecting a Year month opens Month. Today restores the current fixture date and selected-date context.
- Private and Household are independent native checkbox targets. Selecting both includes all events without adding a synthetic “All” control; selecting neither produces a recoverable no-match state without changing stored data.
- Search matches title and description only. Scope, importance, group, and tag filters intersect. Group and Tag options remain available through the reviewed common disclosure shell, and selected chips preserve fixed geometry.
- Active filter state stays at the filter controls. Desktop uses a compact sidebar; narrower layouts use a dismissible drawer with focusable controls and an explicit close action.
- Event preview names when, time-zone projection, scope, visibility, importance, group, tags, and recurrence only when those fields exist. Desktop anchors the preview near its source; compact layouts use a bottom sheet.
- Dense-day overflow opens a bounded event list and preserves access to every hidden event before previewing one.
- Create and Edit support title, description, all-day or timed start/end, calendar scope, visibility, importance, group, tags, recurrence, and recurring mutation scope. All day is grouped with Start and End under Date and time.
- The event editor keeps one clear title, supporting copy, and stable actions while only the form body scrolls. Cancel and Save remain reachable at every scroll position.
- Recurring edits and deletes require an explicit occurrence/following/series scope. Destructive commitment uses a separate confirmation surface.
- Preserve visible focus, native checkbox and form semantics, predictable Escape/dismissal, focus restoration, Reduced Motion, increased contrast, 200% zoom, native large text, and platform target sizes.

## Decisions

- The calendar itself is the date-selection surface. The toolbar intentionally contains only previous, Today, and next; a second calendar date picker was rejected as redundant.
- Production Dusk tokens, typography, type floors, elevated-slate construction, and accessibility rules override nearby values sampled from legacy prototypes.
- Month prioritizes seeing the complete calendar over showing the maximum number of full event rows in every cell. Overflow is explicit rather than hidden behind scrolling.
- Calendar scope is a checkbox list, not mutually exclusive chips. No “All” pseudo-scope is displayed.
- Importance, Group, and Tag values use fixed-geometry pressed label chips. Group and Tag collections use the common disclosure shell instead of large standalone wells.
- The view switcher wraps its content rather than stretching to an arbitrary fixed width.
- Preview and editor surfaces expose only source-supported V2 fields. Prototype-only category, place, reminder, conflict-check, and assistant-action concepts were rejected.
- Native date/time inputs remain acceptable inside the event editor; the rejected duplicate date picker applied to top-level calendar navigation.
- The fixture and local mutations demonstrate behavior only. They do not define persistence, authorization, revision conflict handling, or time-zone projection algorithms.

## Open

- **No blocker for implementing the reviewed calendar composition and interaction hierarchy.**
- Production ownership for shared filter state, URL/state restoration, and per-platform calendar projection still needs implementation planning.
- Keyboard grid conventions, screen-reader position announcements, very dense event days, and large-data virtualization require production boundary tests.
- Time-zone conversion, daylight-saving transitions, all-day end semantics, recurrence expansion, occurrence identity, and optimistic revision conflicts remain governed by current API/domain contracts.
- Authorization must continue to derive from the immutable principal and existing capability boundary; visual scope controls do not grant access.
- Exact native iOS and Android date/time input presentation should follow platform conventions while preserving the reviewed field grouping and consequence language.
- Explicit local-stack validation remains required at compact phone, large phone, tablet, desktop, 200% zoom, native large text, Reduced Motion, and increased contrast.
