# Task Brief: Wire the iOS calendar database into authenticated session lifecycle

## Contribution Goal

iOS supplies a NativeSqliteDriver in Application Support with Data Protection and binds CalendarExperience observation, namespace, purge, and close ordering to IosUserSession/UserSession using explicit authenticated identity.

## Boundary — Included

- Capture and transport authenticated userId into the iOS session boundary
- NativeSqliteDriver creation in protected Application Support storage
- iOS file Data Protection setup and fail-closed path handling
- Authenticated account/backend namespace and CalendarExperience lifecycle wiring
- Logout/account/backend cancellation, purge, switch, and close ordering
- Kotlin/iOS and Swift-facing lifecycle tests

## Required Work

- 1. Capture the server-authenticated AuthUser.userId at login/session creation and pass it explicitly into IosUserSession/UserSession. Never derive account identity from display name or token substrings.
- 2. Implement the iOS side of the common driver/path seam with NativeSqliteDriver at an app-specific Application Support location; create directories safely and exclude the database from inappropriate backup if repository policy requires it.
- 3. Apply iOS Data Protection appropriate for authenticated app-private calendar data and verify protection attributes after database creation/reopen. Do not add SQLCipher or a cross-platform key manager.
- 4. Derive the namespace from explicit authenticated userId plus normalized backend identity without placing tokens, raw credential-bearing URLs, or content in paths/logs.
- 5. Construct one CalendarDatabase/CalendarCacheStore/CalendarExperience inside IosUserSession and expose it through the existing UserSession boundary for SKIE consumption across NavigationStack route recreation.
- 6. On logout/auth expiry/account/backend replacement, stop observation/prefetch, perform purge/switch in a non-cancelled bounded context, then close the driver and prevent stale async-sequence emissions into a successor session.
- 7. Fail closed on Application Support, protection, migration, or driver-open failure and expose a typed unavailable state.
- 8. Add iOS target tests for authenticated userId plumbing, protected path creation, Data Protection attributes, create/open/migrate/reopen/close, session lifetime, namespace switch, cancellation-before-purge, non-cancelled purge, and no post-logout emission; keep diagnostics structural only.

## Integration Expectation

Deliver this contribution for integration in stage ios-calendar-database-session.

## Context

- shared/mobile-data owns schema, store, read/cache policy, mutations, and StateFlow. Swift code must not introduce UserDefaults event caches or duplicate repositories.
- IosUserSession/UserSession currently does not retain userId, so this task owns plumbing the server-authenticated AuthUser.userId into the session boundary before deriving a cache namespace.
- IosUserSession/UserSession owns the authenticated lifetime above NavigationStack; route recreation must not close the database.
- Exact mobile references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. This nonvisual task supplies persisted view/filter/cache state only; prototype assets/data are never persisted.

## Boundary — Excluded

- SwiftUI calendar rendering and ViewModel state mapping
- Shared cache/revalidation/mutation policy
- UserDefaults event storage, SQLCipher, or Keychain database keys
- Android driver setup
- Changes to sentient-design files

## Interfaces and Dependencies

- Consumes AuthUser.userId, normalized backend identity, the shared CalendarDatabase driver seam, and complete CalendarExperience factory.
- Produces a session-scoped shared CalendarExperience/StateFlow accessible to Swift through SKIE.
