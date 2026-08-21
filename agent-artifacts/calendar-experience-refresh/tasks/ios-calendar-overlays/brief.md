# Task Brief: Build iOS calendar preview and editor sheets

## Contribution Goal

Controlled SwiftUI sheets deliver exact reference-adapted event preview, complete Add/Edit, recurrence scope, delete confirmation, conflict, permission, and offline-write states with correct accessibility and safe-area behavior.

## Boundary — Included

- Event preview sheet
- Complete Add/Edit form sheet using native SwiftUI date/time controls
- Recurrence mutation-scope and delete confirmation surfaces
- Typed conflict/permission/offline/failure presentations
- Safe-area, bounded height, internal scrolling, focus/dismissal, reduced motion, previews, and tests

## Required Work

- 1. Build controlled preview/editor/scope/confirmation sheets from CalendarUiState and closures; SwiftUI bodies perform no repository/database/network work.
- 2. Match the reference Dusk surface, 26pt-style top radius, 42x4 handle, maximum approximately 84% height, internal scrolling, safe-area padding, 48pt actions, Terra primary action, typography, material/elevation, and scrim via existing tokens.
- 3. Preview only supported effective fields/actions. Editor renders title, description, all-day/timed start/end, timezone-preserving native controls, private/household scope, visibility, importance, group, tags, and structured recurrence.
- 4. Render explicit applicable occurrence/following/series choice, delete confirmation, submitting/success/failure, stale-revision reread/review, forbidden non-disclosure, and connection-required disabled save/delete directly from shared state.
- 5. Focus the first meaningful field, contain VoiceOver/focus, dismiss through close/Cancel, native swipe/Back-equivalent and safe scrim rules, restore originating event/Add control, and remove closed overlays from accessibility.
- 6. Use approximately 150ms feedback/scrim and 250ms sheet/state transitions with restrained press scale; honor `accessibilityReduceMotion`.
- 7. Support Dynamic Type, 44pt targets, keyboard-safe scrolling, VoiceOver errors/labels, and safe-area/home-indicator clearance.
- 8. Add SwiftUI previews at 390x844 and 430x932 for preview, Add, timed/all-day Edit, recurrence scope, delete, conflict, offline, error, and large Dynamic Type; compare directly with the exact served reference and document V2 field additions.
- 9. Add Swift tests for closure identity, enabled/disabled actions, field mapping, recurrence options, focus-origin state, accessibility labels/errors, and closed-overlay state.

## Integration Expectation

Deliver this contribution for integration in stage ios-calendar-overlays.

## Context

- Implement new overlay views without editing CalendarScreen so they integrate after the surface task.
- Exact visual references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Serve and inspect preview/Add overlays at 390x844 and 430x932; adapt their visual treatment without sample events or unsupported place/reminder fields.
- Shared CalendarExperience owns draft, mutation, recurrence/conflict/offline policy. SwiftUI renders state and forwards closures.

## Boundary — Excluded

- CalendarScreen assembly
- Shared mutation/conflict policy
- SQLDelight/session lifecycle
- Unsupported member ownership, color, place, reminders
- Changes to generated Xcode project or prototype

## Interfaces and Dependencies

- Consumes Swift CalendarUiState overlay/draft/outcome slices and forwards ios CalendarViewModel intents.
- Produces controlled preview/editor/scope/confirmation views for CalendarScreen.
