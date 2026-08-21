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
Initial exhaustive review of bfe0d35bfea7d10de8f89dace420e2172d2eb347. Identity plumbing, platform-driver wiring, commonMain purity, and declared build/test commands pass, but the stage has four blocking findings: Android falls back to a live remote calendar repository when protected storage is unavailable; required platform lifecycle/isolation tests are missing; raw backend/error strings can enter diagnostics; and session construction performs synchronous database I/O on UI-bound paths. These violate explicit stage acceptance and merge criteria.

## Evidence

- **EV-001:** Sanitized check summary — PASS; BUILD SUCCESSFUL
- **EV-002:** Sanitized check summary — PASS; XCFramework/project generated
- **EV-003:** Sanitized check summary — PASS; 81 tests
- **EV-004:** Sanitized check summary — PASS; no output
- **EV-005:** Boundary inspection summary — No commonMain platform-type matches; no SQLCipher/external-storage/calendar native cache matches; worktree clean

## Findings

- **MPS-001** (high, open): Android database setup failure leaves SettingsComponent free to construct SdkCalendarRepository, so the typed unavailable state does not fail closed.
- **MPS-002** (high, open): Required real Android driver/session lifecycle tests and iOS purge, cancellation, isolation, and stale-emission tests are absent.
- **MPS-003** (high, open): Raw exception/input/backend URL strings can be emitted publicly; URL credentials and arbitrary server/error content are not structurally redacted.
- **MPS-004** (high, open): Android runBlocking parks the caller during open/migration, and iOS opens NativeSqliteDriver synchronously from the @MainActor session initializer.

## Verdict

fail

## Residual Risk

- The passing Android/iOS gates do not exercise the missing failure, purge, cancellation, and stale-emission boundaries.
- Existing Gradle/Xcode warnings were non-failing and are not treated as findings.
