# Task Brief: Implement complete web calendar create, edit, and delete dialogs

## Contribution Goal

The web client has controlled, accessible Dusk dialogs for complete Calendar V2 create/edit/delete flows, recurrence mutation scopes, typed conflicts, permission failures, and safe recovery.

## Boundary — Included

- Controlled EventEditor form for create and edit
- All supported fields and native date/time inputs
- Recurring mutation-scope chooser and delete confirmation
- Typed validation, stale-revision conflict, forbidden/not-found, success/failure recovery
- Dialog focus, dismissal, draft retention, reduced motion, tests, and exact visual comparison

## Required Work

- 1. Build a controlled EventEditor using existing Dialog, form, button, and token surfaces; map Calendar V2 title, description, all-day or timed start/end, timezone, private/household scope, visibility, importance, group, tags, and structured recurrence.
- 2. Preserve all-day date identity and timed timezone recurrence anchor while using native date/time controls; validate required fields, ordering, ranges, recurrence, and role restrictions accessibly.
- 3. For recurring edit/delete, require an explicit applicable `this_occurrence`, `this_and_following`, or `entire_series` choice and submit eventId, calendar scope, originalStart, and expectedRevision exactly. Handle successor IDs returned by following mutations.
- 4. Require delete confirmation. Never show optimistic success before the typed result; on stale revision show authoritative conflict guidance with reread/review, on forbidden remain non-disclosing, and on failure retain the draft.
- 5. Focus the first meaningful field on open; support Cancel, Escape, safe scrim dismissal, success, and failure; keep hidden dialogs inert and restore the opener predictably.
- 6. Match reference Dusk modal geometry, typography, spacing, action hierarchy, blur/elevation, fast feedback, normal state transition, and reduced-motion behavior through existing production tokens.
- 7. Add tests for complete create payloads, all-day/timed edits, every recurrence mutation scope, originalStart/revision, successor IDs, delete confirmation, conflict/forbidden/not-found outcomes, draft retention, focus restoration, and hidden accessibility state.
- 8. Capture Add, Edit, mutation-scope, delete-confirmation, and conflict-state screenshots against the exact served web reference at 1440x1000 and 390x844; document field additions required by Calendar V2.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-editor.

## Context

- Reuse gateway/webui/src/components/common/dialog.tsx and shared form primitives rather than creating an ad hoc modal system. Use CalendarApi.mutate() for scoped recurring operations instead of convenience adapters that force entire_series.
- Exact references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Serve and inspect the Add/Edit treatment at `http://127.0.0.1:8799/design/web/calendar.html`; adapt its geometry/effects, but expose current Calendar V2 fields rather than prototype member/place/reminder semantics.
- Keep implementation in isolated editor files until final assembly.

## Boundary — Excluded

- Calendar loading/controller state
- Preview positioning
- Workspace/canvas assembly
- Offline web mutations
- Unsupported member ownership, event colors, place, reminders, or scheduler delivery

## Interfaces and Dependencies

- Consumes CalendarApi create/mutate/get/list boundaries and controlled occurrence/draft state.
- Produces EventEditor, MutationScopeChooser, DeleteConfirmation, and typed outcome callbacks for CalendarWorkspace.
