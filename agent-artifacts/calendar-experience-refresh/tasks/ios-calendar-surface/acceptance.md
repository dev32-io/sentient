# Task Acceptance: Build the iOS calendar views, filters, agenda, and floating controls

## Deliverables

- Reusable controlled SwiftUI components implement the exact approved mobile calendar shell, horizontal filters, four compact views, agenda rows, and floating selector without owning I/O or shared policy.

## Acceptance

- At 390x844 and 430x932 components match the exact mobile reference hierarchy/geometry for supported states.
- Month/Week/Day/Year selection, complete dates, agenda order, filters, safe areas, and floating-bar clearance are correct.
- VoiceOver, 44pt targets, Dynamic Type, reduced motion, and contrast satisfy the contract.
- No side effects or duplicated shared policy exist in SwiftUI views.

## Boundary Proof

- SwiftUI previews/review notes compare all four views at both target sizes to `sentient-design/design/mobile/calendar.html`.
- Swift tests cover callbacks, labels, view completeness, and filter state; Xcode build validates integration.
- Proof explicitly checks 58pt top bar, 16pt inset, 44pt targets, 46pt view controls, ~64pt rows, 42 Month cells, complete Year, and home-indicator clearance.
