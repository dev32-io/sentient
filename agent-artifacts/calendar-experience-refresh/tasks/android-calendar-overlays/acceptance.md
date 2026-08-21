# Task Acceptance: Build Android calendar preview and editor sheets

## Deliverables

- Controlled Compose bottom sheets deliver exact reference-adapted event preview, complete Add/Edit, recurrence scope, delete confirmation, conflict, permission, and offline-write states with correct accessibility and safe-area behavior.

## Acceptance

- Sheets match the exact mobile reference at both viewport sizes while exposing complete supported Calendar V2 fields.
- Safe-area, bounded-height, internal scrolling, Back/scrim/close, focus restoration, target size, font scaling, and reduced motion are correct.
- Recurring and offline/conflict controls display shared policy without rebuilding it in Compose.

## Boundary Proof

- Compose previews compare every overlay state to `sentient-design/design/mobile/calendar.html` at 390x844 and 430x932.
- JVM/pure tests cover action identity, recurrence options, disabled offline writes, accessibility labels, and focus origin.
- Build review explicitly checks 84% bounded height, 26dp radius, 48dp actions, safe-area/IME clearance, hidden semantics, and motion roles.
