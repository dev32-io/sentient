# Task Acceptance: Integrate iOS Rive identity, readiness-gated startup, native shell, and History

## Deliverables

- Package the canonical identity as an iOS-owned resource, expose exactly three semantic states, and refresh startup/navigation/History while preserving native lifecycle and session behavior.

## Acceptance

- Startup thinking is visible immediately, lasts at least 1500ms, waits for resolved readiness, and reveals actionable failure rather than hanging.
- Packaged .riv bytes equal the canonical checksum; fallback is usable; production has no prototype path dependency.
- Identity exposes only idle/thinking/responding and capture never drives it.
- Native NavigationStack/back/sheets/alerts/menus/safe areas and History behavior remain correct.
- E2E-006 has stable timestamps/selectors without network manipulation.

## Boundary Proof

- Unit tests use injected clocks/readiness and fake Rive loading to pin startup/fallback/state contracts.
- Signed simulator tests/build pin native navigation and resource packaging; design:avatar verifies reference fidelity.
