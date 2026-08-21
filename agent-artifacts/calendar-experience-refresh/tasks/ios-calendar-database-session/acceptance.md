# Task Acceptance: Wire the iOS calendar database into authenticated session lifecycle

## Deliverables

- iOS supplies a NativeSqliteDriver in Application Support with Data Protection and binds CalendarExperience observation, namespace, purge, and close ordering to IosUserSession/UserSession.

## Acceptance

- iOS stores the calendar database only in protected app-private Application Support storage.
- One database/experience survives route recreation and closes only with authenticated session disposal.
- Logout/account/backend replacement cannot expose old rows/preferences or stale async-sequence emissions.
- Protection/open/migration failures fail closed and content-free.

## Boundary Proof

- Kotlin native/Swift tests cover path, protection, migration, route-independent lifetime, cancellation-before-purge, namespace replacement, and close.
- XCFramework plus simulator tests prove NativeSqliteDriver and SKIE export correctness.
- Sanitized inspection proves User B cannot observe User A rows/preferences after switch.
