# Task Acceptance: Build iOS calendar preview and editor sheets

## Deliverables

- Controlled SwiftUI sheets deliver exact reference-adapted event preview, complete Add/Edit, recurrence scope, delete confirmation, conflict, permission, and offline-write states with correct accessibility and safe-area behavior.

## Acceptance

- Sheets match the exact mobile reference at both target sizes and expose every supported Calendar V2 field.
- Safe-area, bounded height, internal scroll, dismissal, focus restoration, Dynamic Type, targets, and reduced motion are correct.
- Recurring/offline/conflict behavior renders shared policy without native duplication.

## Boundary Proof

- SwiftUI previews compare every overlay state to `sentient-design/design/mobile/calendar.html` at 390x844 and 430x932.
- Swift tests cover action identity, recurrence, disabled offline writes, labels, and focus origin.
- Review explicitly verifies 84% height, 26pt radius, 48pt actions, keyboard/safe-area clearance, closed accessibility, and motion roles.
