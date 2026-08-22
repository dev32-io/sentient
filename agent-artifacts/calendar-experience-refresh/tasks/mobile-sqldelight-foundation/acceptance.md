# Task Acceptance: Establish the shared SQLDelight calendar database

## Deliverables

- shared/mobile-data has a compilable, migration-tested SQLDelight database and a platform-neutral driver seam for protected, account-scoped calendar snapshots and presentation preferences.

## Acceptance

- A pinned SQLDelight version is proven compatible with Kotlin 2.3.10, Android, iosArm64, and iosSimulatorArm64 before downstream schema work proceeds.
- shared/mobile-data builds with source-set-correct SQLDelight dependencies and no platform API in commonMain.
- Fresh database creation and migration tests pass and expose no partial snapshots after a failed transaction.
- Schema keys and constraints isolate every row and preference by authenticated account/backend namespace and preserve complete month identity.
- No calendar content enters diagnostics.

## Boundary Proof

- A minimal generated-database build proves the pinned SQLDelight/Kotlin 2.3.10 combination on Android and both iOS targets.
- Focused SQLDelight tests exercise fresh creation, migration, uniqueness, transaction rollback, and close/reopen behavior.
- Generated Android and iOS framework builds prove source-set and driver dependency correctness.
- Review confirms the persisted preference vocabulary supports the four-view mobile reference without copying prototype data.
