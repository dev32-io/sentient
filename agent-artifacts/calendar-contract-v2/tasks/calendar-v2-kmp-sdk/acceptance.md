# Task Acceptance: Cut the KMP calendar SDK over to REST V2

## Deliverables

- Android and iOS shared SDK consumers can page calendar reads and issue typed recurring mutation commands with exact gateway wire parity and no content-bearing diagnostics.

## Acceptance

- KMP models decode the gateway fixture without aliases or copied divergent literals.
- List supports raw temporal strings and nextCursor; mutation supports all three applyTo values.
- No PATCH/DELETE request or V1 more/baseEventId normalization remains.
- Existing platform callers continue to compile through source-level convenience adapters without UI changes.
- Calendar content, dates, queries, payloads, tokens, and error bodies never appear in diagnostics.

## Boundary Proof

- CalendarHttpClient tests inspect exact method/path/query/body and decode typed V2 results/errors.
- Generated golden fixture tests prove gateway/KMP wire parity.
- PrivacyGuardTest drives real client paths with canary content and captures zero leakage.
