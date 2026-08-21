# Task Acceptance: Assemble and verify the complete Android calendar experience

## Deliverables

- The Android Calendar route delivers the full shared-state, reference-faithful four-view calendar with native sheets, offline browsing, exact mutation behavior, accessibility, and repeatable local Maestro evidence.

## Acceptance

- Android matches the exact mobile reference at 390x844 and 430x932 for supported behavior and documents only approved corrections.
- All four views, filters, overlays, mutations, conflicts, permissions, cache-first/offline/reconnect/isolation, temporal behavior, accessibility, safe areas, and reduced motion work through shared state.
- Calendar Maestro flows are deterministic, local-only, cleanup-safe, and selectable with `./qa/mobile/run-e2e.sh android --tags calendar`.
- No native database/network/cache policy or content-bearing diagnostics are introduced.

## Boundary Proof

- JVM tests and debug build cover state wiring and stable Android boundaries.
- Calendar-tagged Maestro evidence covers Android portions of CAL-UX-001..014 on the real local stack.
- Screenshots compare production to `sentient-design/design/mobile/calendar.html` at exact 390x844 and 430x932 sizes for every major view/overlay/offline state; accessibility evidence records TalkBack/focus/target/safe-area/reduced-motion checks.
