# Outcome: Cross-platform family calendar experience

## Delivered

- Cross-platform calendar refresh across web, Android, and iOS using the committed Sentient calendar references.
- Shared KMP calendar projections, SQLDelight cache/persistence, authenticated namespace isolation, cache-first reads, revalidation, prefetch/retention, offline browsing, and online mutation/conflict handling.
- Responsive web Day/Week/Month/Year workspace with filters, previews, complete editor flows, narrow-layout behavior, accessibility, and focus handling.
- Thin Android and iOS session/ViewModel adapters with native calendar surfaces, overlays, persistence lifecycle, and platform accessibility behavior.
- Disposable local calendar fixtures and direct Playwright/Maestro verification assets.

## Verification

- stage-calendar-core-foundations-review: passed
- stage-calendar-store-and-web-components-review: passed
- stage-calendar-experience-and-web-assembly-review: passed
- stage-mobile-calendar-policies-review: passed
- stage-mobile-platform-sessions-review: passed
- stage-mobile-viewmodel-adapters-review: passed
- stage-native-calendar-components-review: passed
- stage-calendar-delivery-completion-review: passed
- final-e2e: passed (risk report: risk-acceptance.md)
- final-branch-review: passed (risk report: risk-acceptance.md)

## Contract Deviations

- The final branch was approved with explicit user acceptance of incomplete current final-E2E evidence: 2 of 14 cases are recorded passing and 12 remain blocked.
- Current exact-size Android/iOS visual and reduced-motion evidence for E2E-014 remains incomplete.
- A host-Wi-Fi toggle used during iOS reconnection verification disconnected the harness; the resulting transport failure was treated as an operational verification issue, not an unresolved product finding.

## Remaining Findings

- **MVA-002** (low, open; stage-mobile-viewmodel-adapters-review): Repair-added test uses a mutable captured continuation that becomes an error in Swift 6 mode.
- **FINAL-MAJOR-001** (high, accepted; final-branch-review): Only 2 of 14 required E2E cases pass; 12 remain blocked while the checkpoint is marked passed.
- **FINAL-MAJOR-002** (high, accepted; final-branch-review): Required current Android/iOS exact-size visual and reduced-motion evidence remains absent and E2E-014 is blocked.

## Residual Risks

- Some cross-platform E2E paths remain unproven in the current evidence set despite resolved bounded repair findings.
- Exact native visual fidelity, safe-area behavior, and reduced-motion behavior lack the requested complete current evidence at both logical profiles.
- The iOS host-network reconnection method is unsafe for future harness runs and should be replaced with simulator-isolated fault control before repeating that case.

## Follow-up

- Review the accepted final-review risks before merging.
- Use a simulator-scoped iOS network isolation mechanism for future offline/reconnect E2E; never disable the operator host network.
- Optionally rerun the full 14-case matrix and native visual evidence before release.
- Inspect or safely clean inactive retained task worktrees with `/harness worktrees`.
