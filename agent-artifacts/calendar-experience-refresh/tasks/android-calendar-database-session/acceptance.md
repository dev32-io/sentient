# Task Acceptance: Wire the Android calendar database into authenticated session lifecycle

## Deliverables

- Android supplies a Context-backed SQLDelight driver in app-private storage and binds CalendarExperience observation, namespace, purge, and close ordering to UserSessionManager.

## Acceptance

- Android uses app-private SQLite and opens one shared calendar experience per authenticated session.
- Navigation does not recreate policy/database state; logout/account/backend changes cannot emit prior namespace rows.
- Driver open/migration/close failures are typed, fail closed, and content-free.

## Boundary Proof

- Android lifecycle/driver tests cover open, migrate, route survival, cancellation-before-purge, namespace replacement, and close.
- A shared test/build confirms AndroidSqliteDriver integration compiles without platform types in commonMain.
- Sanitized inspection proves User B cannot observe User A rows/preferences after switch.
