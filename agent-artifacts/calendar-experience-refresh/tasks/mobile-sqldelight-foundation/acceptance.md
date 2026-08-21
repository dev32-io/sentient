# Task Acceptance: Establish the shared SQLDelight calendar database

## Deliverables

- shared/mobile-data has a compilable, migration-tested SQLDelight database and a platform-neutral driver seam for protected, account-scoped calendar snapshots and presentation preferences.

## Acceptance

- shared/mobile-data builds with SQLDelight for Android and both iOS targets.
- Fresh database creation and migration tests pass and expose no partial snapshots after a failed transaction.
- Schema keys and constraints isolate every row and preference by authenticated account/backend namespace and preserve complete month identity.
- No platform API appears in commonMain and no calendar content enters diagnostics.

## Boundary Proof

- Focused SQLDelight tests exercise fresh creation, migration, uniqueness, transaction rollback, and close/reopen behavior.
- Generated Android and iOS framework builds prove source-set and driver dependency correctness.
- Review confirms the persisted preference vocabulary supports the four-view mobile reference without copying prototype data.
