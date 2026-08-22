# Task Brief: Implement complete web calendar create, edit, and delete dialogs

## Contribution Goal

The web client has controlled, accessible Dusk dialogs for complete Calendar V2 create/edit/delete flows, recurrence mutation scopes, typed conflicts, permission failures, safe dismissal, and draft-preserving recovery.

## Boundary — Included

- Controlled EventEditor with explicit editor-local draft ownership
- Narrow reusable Dialog options for background inertness and safe backdrop dismissal
- All supported fields and native date/time inputs using shared calendar-time helpers
- Explicit mutation-capability input, recurring mutation-scope chooser, and delete confirmation
- Typed validation, stale-revision conflict, forbidden/not-found, success/failure recovery
- Dialog focus, dismissal, draft retention, reduced motion, tests, and exact visual comparison

## Required Work

- 1. Build EventEditor using existing Dialog, form, button, token, and shared calendar-time surfaces. Own the current editor draft locally until cancel/success; expose submitted commands/outcomes through callbacks rather than putting draft state in CalendarController.
- 2. Narrowly enhance Dialog with an opt-in safe-close/backdrop policy and background inert/aria-hidden management while open. Preserve existing consumers by default, restore prior sibling state on close, and add regression tests for focus trap, inert cleanup, Escape, backdrop, and restore-focus.
- 3. For a dirty calendar draft, backdrop/Escape requests a safe cancel path or is ignored until explicit confirmation; it never silently discards the draft. Cancel/success/failure restore the opener predictably and closed dialogs are absent from the accessibility tree.
- 4. Map Calendar V2 title, description, all-day or timed start/end, private/household scope, visibility, importance, group, tags, and structured recurrence. Preserve all-day date identity and raw offset-bearing recurrence anchors through shared calendar-time helpers and native controls.
- 5. Consume an explicit CalendarAccessCapabilities input supplied by final assembly from authenticated principal/access state. Do not infer role from hidden events, facets, display name, or response counts. If a safe capability signal is unavailable, remain conservative and rely on typed backend denial without revealing hidden information.
- 6. For recurring edit/delete, require explicit applicable `this_occurrence`, `this_and_following`, or `entire_series` and submit eventId, calendar scope, raw originalStart, and expectedRevision. Handle successor IDs returned by following mutations.
- 7. Require delete confirmation. Never show optimistic success before the typed result; stale revision shows reread/review, forbidden remains non-disclosing, and failure retains the local draft.
- 8. Match reference Dusk modal geometry, typography, spacing, action hierarchy, blur/elevation, fast feedback, normal transition, and reduced-motion behavior through production tokens and component-scoped editor CSS with no page-local colors.
- 9. Add tests for Dialog inert/safe-close behavior, editor draft ownership, capability gating, complete payloads, all-day/timed edits, every recurrence scope, originalStart/revision, successor IDs, delete confirmation, conflicts/forbidden/not-found, draft retention, focus restoration, and hidden accessibility state.
- 10. Capture Add, Edit, mutation-scope, delete-confirmation, and conflict-state screenshots against the exact served web reference at 1440x1000 and 390x844; document fields added for Calendar V2.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-editor.

## Context

- Reuse and narrowly enhance gateway/webui/src/components/common/dialog.tsx rather than creating an ad hoc modal system. The current primitive traps Tab but does not inert background siblings and always dismisses on scrim; this task owns opt-in reusable fixes with regression tests for existing Dialog consumers.
- Use CalendarApi.mutate() for scoped recurring operations instead of convenience adapters that force entire_series, and use the shared calendar-time helpers from web-calendar-projections rather than importing from calendar-view.tsx.
- Exact references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Serve and inspect the Add/Edit treatment at `http://127.0.0.1:8799/design/web/calendar.html`; adapt geometry/effects while exposing current Calendar V2 fields.
- Keep calendar editor implementation in isolated files until final assembly. This task owns editor-local draft state; the controller does not.

## Boundary — Excluded

- Calendar loading/controller state
- Preview positioning
- Workspace/canvas assembly
- Offline web mutations
- Unsupported member ownership, event colors, place, reminders, or scheduler delivery
- Broad redesign of Dialog styling or unrelated consumers

## Interfaces and Dependencies

- Consumes shared calendar-time helpers, CalendarApi create/mutate/get boundaries, CalendarAccessCapabilities, and controlled occurrence/open state.
- Produces EventEditor, MutationScopeChooser, DeleteConfirmation, editor-local draft lifecycle, and typed outcome callbacks for CalendarWorkspace.
- May add backward-compatible Dialog close/inert options used by the calendar editor and covered against existing consumers.
