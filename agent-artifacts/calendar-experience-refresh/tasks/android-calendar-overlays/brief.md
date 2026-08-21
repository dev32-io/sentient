# Task Brief: Build Android calendar preview and editor sheets

## Contribution Goal

Controlled Compose bottom sheets deliver exact reference-adapted event preview, complete Add/Edit, recurrence scope, delete confirmation, conflict, permission, and offline-write states with correct accessibility and safe-area behavior.

## Boundary — Included

- Event preview bottom sheet
- Complete Add/Edit form sheet with native Material date/time controls
- Recurrence mutation-scope sheet/section and delete confirmation
- Typed conflict/permission/offline/failure presentations
- Safe-area, bounded-height, focus/Back/scrim, reduced motion, previews, and tests

## Required Work

- 1. Build controlled preview and editor ModalBottomSheet components consuming CalendarUiState and callbacks, with no direct repository/database/network access.
- 2. Match the reference Dusk surface, 26dp-style top radii, 42x4 handle, maximum approximately 84% height, internal scrolling, safe-area bottom padding, 48dp actions, Terra primary action, typography, blur/elevation, and scrim treatment using production tokens.
- 3. Preview only supported effective details and actions. Editor renders title, description, all-day/timed start/end, timezone-preserving native controls, private/household scope, visibility, importance, group, tags, and structured recurrence.
- 4. Render explicit applicable this-occurrence/following/entire-series choice, delete confirmation, submitting/success/failure, stale-revision reread/review, forbidden non-disclosure, and connection-required disabled save/delete states from shared state.
- 5. Focus first meaningful field on open, contain accessibility focus, dismiss by close/Cancel, Android Back, and safe scrim, restore the originating event/Add control, and keep closed sheets absent from the semantics tree.
- 6. Use approximately 150ms feedback/scrim and 250ms sheet/state transitions plus subtle press scale; disable nonessential animation when system reduced motion is active.
- 7. Support TalkBack labels, error announcements, large font scaling, 44dp targets, keyboard/IME-safe internal scrolling, and no controls hidden behind gesture/navigation areas.
- 8. Add previews at 390x844 and 430x932 for preview, Add, timed/all-day Edit, recurrence scope, delete confirm, conflict, offline, error, and large-font states; compare directly to the exact served reference and document Calendar V2 field additions.
- 9. Add focused tests for callback identity, enabled/disabled actions, field mapping, recurrence choices, focus-origin model, accessibility labels/errors, and hidden state.

## Integration Expectation

Deliver this contribution for integration in stage android-calendar-overlays.

## Context

- Implement new overlay components without editing CalendarScreen so they can be integrated after the surface task.
- Exact visual references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Serve and inspect the preview/Add overlays at 390x844 and 430x932; adapt visual treatment, not sample Maya/Jordan events or unsupported place/reminder fields.
- Shared CalendarExperience owns drafts, mutation payloads, online gates, recurrence/conflict policy, and outcomes. Compose renders state and forwards callbacks.

## Boundary — Excluded

- CalendarScreen assembly
- Shared mutation or conflict policy
- SQLDelight/session lifecycle
- Unsupported member ownership, color, place, or reminder semantics
- Changes to the prototype

## Interfaces and Dependencies

- Consumes Android CalendarUiState overlay/draft/outcome slices and forwards Android CalendarViewModel intents.
- Produces controlled preview/editor/scope/confirmation sheet components for CalendarScreen.
