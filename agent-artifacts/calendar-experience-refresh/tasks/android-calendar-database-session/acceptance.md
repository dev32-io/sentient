# Task Acceptance: Wire the Android calendar database into authenticated session lifecycle

## Deliverables

- Android supplies a Context-backed SQLDelight driver in app-private storage and binds CalendarExperience observation, namespace, purge, and close ordering to UserSessionManager using explicit authenticated identity.
- The narrow Android compatibility update path uses recurring/base event identity for occurrence edits and preserves occurrence/originalStart separately.

## Acceptance

- Android uses explicit authenticated userId plus backend identity for its private namespace and app-private SQLite for storage.
- One shared calendar experience lives for the authenticated session and survives navigation.
- Logout/account/backend changes cancel observers, complete purge/switch outside the cancelled session scope, close the driver, and cannot emit prior namespace rows.
- Driver open/migration/close failures are typed, fail closed, and content-free.
- `CalendarViewModelTest.update_uses_base_id_and_keeps_timed_start_kind` passes without weakening or skipping its recurring/base identity assertion, and the complete declared Android unit-test gate passes.

## Boundary Proof

- Android lifecycle/driver tests cover userId plumbing, open, migrate, route survival, cancellation-before-purge, non-cancelled purge, namespace replacement, and close.
- A shared test/build confirms AndroidSqliteDriver integration compiles without platform types in commonMain.
- Sanitized inspection proves User B cannot observe User A rows/preferences after switch.
- Focused recurrence compatibility proof confirms base event ID, occurrenceId, originalStart, and timed start kind remain distinct and correct.
