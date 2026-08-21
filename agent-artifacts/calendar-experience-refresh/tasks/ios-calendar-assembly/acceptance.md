# Task Acceptance: Assemble and verify the complete iOS calendar experience

## Deliverables

- The iOS Calendar route delivers the full shared-state, reference-faithful four-view calendar with native sheets, offline browsing, exact mutation behavior, accessibility, and repeatable local Maestro evidence.

## Acceptance

- iOS matches the exact mobile reference at 390x844 and 430x932 for supported behavior and documents only approved corrections.
- All views, filters, overlays, mutations, conflicts, permissions, cache-first/offline/reconnect/isolation, temporal behavior, accessibility, safe areas, and reduced motion work through shared state.
- Calendar Maestro flows are deterministic, local-only, cleanup-safe, and selectable with `./qa/mobile/run-e2e.sh ios --tags calendar`.
- No native cache/repository policy, Combine bridge, generated-project edit, or content-bearing diagnostics are introduced.

## Boundary Proof

- Swift/Xcode tests and simulator build cover state wiring and stable iOS boundaries.
- Calendar-tagged Maestro evidence covers iOS portions of CAL-UX-001..014 on the real local stack.
- Screenshots compare production to `sentient-design/design/mobile/calendar.html` at exact 390x844 and 430x932 for every major view/overlay/offline state; accessibility evidence records VoiceOver/focus/target/safe-area/Dynamic-Type/reduced-motion checks.
