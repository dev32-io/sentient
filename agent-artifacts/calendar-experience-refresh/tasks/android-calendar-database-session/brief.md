# Task Brief: Wire the Android calendar database into authenticated session lifecycle

## Contribution Goal

Android supplies a Context-backed SQLDelight driver in app-private storage and binds CalendarExperience observation, namespace, purge, and close ordering to UserSessionManager.

## Boundary — Included

- Context-backed AndroidSqliteDriver creation in app-private storage
- Authenticated account/backend namespace derivation and dependency injection
- CalendarExperience construction/disposal through UserSessionManager/Koin
- Logout/account/backend purge and close ordering
- Android driver/open/migration/lifecycle tests

## Required Work

- 1. Implement the Android side of the common driver/path seam using AndroidSqliteDriver and an app-private database path; expose no Context through commonMain.
- 2. Derive the database namespace from authenticated account identity plus normalized backend identity without placing tokens or private content in filenames/logs.
- 3. Construct CalendarDatabase, CalendarCacheStore, and CalendarExperience once inside UserSessionManager's authenticated lifetime and expose the shared experience through existing Koin/session boundaries.
- 4. Keep the shared experience alive across Navigation Compose route recreation. On logout/auth expiry/account/backend replacement, cancel collectors and background work first, transactionally purge or switch namespace as specified, then close the database/driver and clear DI references.
- 5. Fail closed on protected path/open/migration errors and expose a typed unavailable state without falling back to shared or external storage.
- 6. Add Android JVM/instrumentable boundary tests with a real temporary AndroidSqliteDriver where supported, covering create/open/migrate/reopen/close, route-independent lifetime, namespace switch, purge, and no post-logout emission.
- 7. Preserve sanitized diagnostics only and never include backend URL credentials, event content, facets, searches, or database payloads.

## Integration Expectation

Deliver this contribution for integration in stage android-calendar-database-session.

## Context

- shared/mobile-data owns schema, store, read/cache policy, mutations, and StateFlow. Android must not create a separate cache or repository.
- The authenticated UserSessionManager is the lifecycle owner; route changes must not close the calendar database and logout/account/backend replacement must not allow stale emissions.
- Exact mobile references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. This nonvisual task supplies persistence needed for their restored view/filter state; it must not import prototype assets or data.

## Boundary — Excluded

- CalendarScreen and CalendarViewModel rendering
- Shared cache/revalidation/mutation policy
- External/shared storage or SQLCipher
- iOS driver setup
- Changes to visual references

## Interfaces and Dependencies

- Consumes the shared CalendarDatabase driver seam and complete CalendarExperience factory.
- Produces an authenticated-session CalendarExperience dependency for Android CalendarViewModel.
