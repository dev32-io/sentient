# Evaluation Report: stage-mobile-platform-sessions-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Explicit AuthUser.userId plus normalized backend identity reaches both session boundaries before namespace derivation
- Android app-private AndroidSqliteDriver and iOS Application Support NativeSqliteDriver/Data Protection
- Authenticated-session lifetime, cancellation-before-purge, non-cancelled bounded purge/switch, close, and account/backend isolation
- No platform types in commonMain, native cache/policy duplication, SQLCipher, external storage, content-bearing paths, or diagnostics

## Observations

MERGE: NO
MPS-005 is repaired in code: both platforms build locally owned resources, publish through one generation-checked CalendarLifecycleGate critical section, and invalidate/capture under the same gate on close. Fresh Android, iOS, instrumentation, and diff checks pass. However, the manager-required deterministic platform barrier matrix is still absent. The Android and iOS boundary tests exercise only direct shutdown/close. The five tests named logout, auth expiry, account switch, backend switch, and successor creation all call the same generic gate.close helper with an inert label; they do not exercise either platform's actual auth/account/backend paths or create a real successor session. Because this is an explicit acceptance requirement for closing the remaining privacy/lifecycle race, MPS-005 remains a blocking Major finding.

## Evidence

- **EV-001:** Declared Android/shared stage gate, forced rerun — PASS
- **EV-002:** Android real-driver and direct-close barrier instrumentation — PASS; 4 tests
- **EV-003:** Declared iOS setup gate — PASS
- **EV-004:** Declared iOS simulator gate — PASS; 82/82 tests
- **EV-005:** Declared diff check — PASS; worktree clean

## Findings

- **MPS-005** (high, open): The implementation race is fenced, but the required platform scenario matrix is not present. Five differently named common tests execute the same generic close operation; platform tests cover direct close only and do not prove actual auth-expiry/account/backend paths or real successor runtime exposure.

## Verdict

fail

## Residual Risk

- The fenced implementation appears correct by inspection, but the required platform-level wiring and successor exposure proof remains unverified.
