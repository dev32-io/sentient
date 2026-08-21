# Task Acceptance: Assemble and verify the complete iOS calendar experience

## Deliverables

- The iOS Calendar route delivers the full shared-state, reference-faithful four-view calendar with native sheets, offline browsing, exact mutation behavior, accessibility semantics, and agent-driven local evidence.

## Acceptance

- iOS matches the exact mobile reference at logical 390x844 and 430x932 for supported behavior and documents only approved corrections.
- All views, filters, overlays, mutations, conflicts, permissions, cache-first/offline/reconnect/isolation, temporal behavior, accessibility semantics, safe areas, and reduced motion work through shared state.
- Evidence uses unique local fixtures and direct agent orchestration; no runner project/change or concurrent cross-platform fixture mutation is required.
- No native cache/repository policy, Combine bridge, generated-project edit, or content-bearing diagnostics are introduced.

## Boundary Proof

- Swift/Xcode tests and simulator build cover state wiring and stable iOS boundaries.
- The final E2E agent can drive the committed direct-Maestro steps sequentially with unique fixtures for iOS portions of CAL-UX-001..014.
- Screenshots compare production to `sentient-design/design/mobile/calendar.html` and behavior to `sentient-design/components/mobile/sentient-mobile.js` at exact logical 390x844 and 430x932; semantic evidence records focus/target/safe-area/Dynamic-Type/reduced-motion checks.
- Residual risk notes that semantic inspection is not an actual VoiceOver session.
