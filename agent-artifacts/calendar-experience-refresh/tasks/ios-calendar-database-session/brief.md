# Task Brief: Wire the iOS calendar database into authenticated session lifecycle

## Contribution Goal

iOS supplies a NativeSqliteDriver in Application Support with Data Protection and binds CalendarExperience observation, namespace, purge, and close ordering to IosUserSession/UserSession.

## Boundary — Included

- NativeSqliteDriver creation in protected Application Support storage
- iOS file Data Protection setup and fail-closed path handling
- Authenticated account/backend namespace and CalendarExperience lifecycle wiring
- Logout/account/backend cancellation, purge, switch, and close ordering
- Kotlin/iOS and Swift-facing lifecycle tests

## Required Work

- 1. Implement the iOS side of the common driver/path seam with NativeSqliteDriver at an app-specific Application Support location; create directories safely and exclude the database from inappropriate backup if repository policy requires it.
- 2. Apply iOS Data Protection appropriate for authenticated app-private calendar data and verify protection attributes after database creation/reopen. Do not add SQLCipher or a cross-platform key manager.
- 3. Derive the namespace from authenticated account plus normalized backend identity without placing tokens, raw URLs with credentials, or content in paths/logs.
- 4. Construct one CalendarDatabase/CalendarCacheStore/CalendarExperience inside IosUserSession and expose it through the existing UserSession boundary for SKIE consumption across NavigationStack route recreation.
- 5. On logout/auth expiry/account/backend replacement, cancel observation and prefetch first, transactionally purge or switch namespace, close the driver, and prevent stale async-sequence emissions into a successor session.
- 6. Fail closed on Application Support, protection, migration, or driver-open failure and expose a typed unavailable state.
- 7. Add iOS target tests for protected path creation, Data Protection attributes, create/open/migrate/reopen/close, session lifetime, namespace switch/purge, and no post-logout emission; keep diagnostics structural only.

## Integration Expectation

Deliver this contribution for integration in stage ios-calendar-database-session.

## Context

- shared/mobile-data owns schema, store, read/cache policy, mutations, and StateFlow. Swift code must not introduce UserDefaults event caches or duplicate repositories.
- IosUserSession/UserSession owns the authenticated lifetime above NavigationStack; route recreation must not close the database.
- Exact mobile references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. This nonvisual task supplies persisted view/filter/cache state only; prototype assets/data are never persisted.

## Boundary — Excluded

- SwiftUI calendar rendering and ViewModel state mapping
- Shared cache/revalidation/mutation policy
- UserDefaults event storage, SQLCipher, or Keychain database keys
- Android driver setup
- Changes to sentient-design files

## Interfaces and Dependencies

- Consumes the shared CalendarDatabase driver seam and complete CalendarExperience factory.
- Produces a session-scoped shared CalendarExperience/StateFlow accessible to Swift through SKIE.
