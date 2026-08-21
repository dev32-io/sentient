# Evaluation Report: stage-mobile-platform-sessions-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Explicit AuthUser.userId plus normalized backend identity reaches both session boundaries before namespace derivation
- Android app-private AndroidSqliteDriver and iOS Application Support NativeSqliteDriver/Data Protection
- Authenticated-session lifetime, cancellation-before-purge, non-cancelled bounded purge/switch, close, and account/backend isolation
- No platform types in commonMain, native cache/policy duplication, SQLCipher, external storage, content-bearing paths, or diagnostics

## Observations

MERGE: YES

MPS-005 is resolved. The bounded repair replaces the prior renamed generic proofs with distinct Android UserSessionManager and iOS IosUserSession platform-path scenarios for explicit logout, authentication expiry, account replacement, backend replacement, and successor creation. Deterministic pre-publish barriers and real temporary platform SQLite drivers prove that the losing initializer closes and purges its namespace, publishes no stale predecessor state, cannot replace the active slot, and leaves only the successor experience/namespace exposed.

No repair-introduced regressions or remaining findings were found. All declared stage checks pass; the additional Android connected suite also passes 8/8.

## Evidence

- **EV-001:** Declared shared/Android gate; forced rerun, including 138 iOS simulator KMP tests, 152 shared Android unit tests, and 105 Android app unit tests. — PASS
- **EV-002:** Additional real-driver Android instrumentation including five platform publication-race scenarios. — PASS; 8/8
- **EV-003:** Declared iOS setup gate. — PASS
- **EV-004:** Declared iOS simulator application tests. — PASS; 82/82
- **EV-005:** Declared diff check. — PASS; worktree clean

## Findings

- **MPS-005** (high, resolved): Resolved: both platform suites independently exercise all five required lifecycle scenarios with deterministic barriers and real temporary SQLite drivers, proving close/purge, stale-publication rejection, slot integrity, and successor-only exposure.

## Verdict

pass

## Residual Risk

None recorded.
