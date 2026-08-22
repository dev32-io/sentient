# Task Brief: Wire the Android calendar database into authenticated session lifecycle

## Contribution Goal

Android supplies a Context-backed SQLDelight driver in app-private storage and binds CalendarExperience observation, namespace, purge, and close ordering to UserSessionManager using explicit authenticated identity.

## Boundary — Included

- Capture and transport authenticated userId into the Android session boundary
- Context-backed AndroidSqliteDriver creation in app-private storage
- Authenticated account/backend namespace derivation and dependency injection
- CalendarExperience construction/disposal through UserSessionManager/Koin
- Logout/account/backend purge and close ordering
- Android driver/open/migration/lifecycle tests
- Narrow compatibility repair required for the declared Android unit-test gate: recurring occurrence updates address the recurring/base event identity while preserving occurrenceId and originalStart separately

## Required Work

- 1. Capture the server-authenticated AuthUser.userId at login/session creation and pass it explicitly into UserSessionManager. Never derive account identity from display name or token substrings.
- 2. Implement the Android side of the common driver/path seam using AndroidSqliteDriver and an app-private database path; add the Android driver dependency only to the Android platform/app source set and expose no Context through commonMain.
- 3. Derive the database namespace from explicit authenticated userId plus normalized backend identity without placing tokens, raw credential-bearing URLs, or private content in filenames/logs.
- 4. Construct CalendarDatabase, CalendarCacheStore, and CalendarExperience once inside UserSessionManager's authenticated lifetime and expose the shared experience through existing Koin/session boundaries.
- 5. Keep the shared experience alive across Navigation Compose route recreation. On logout/auth expiry/account/backend replacement, stop collectors/background work, perform namespace purge/switch in a non-cancelled blocking or fresh bounded context, then close the database/driver and clear DI references. Do not attempt purge on the already-cancelled session scope.
- 6. Fail closed on protected path/open/migration errors and expose a typed unavailable state without falling back to shared or external storage.
- 7. Add Android JVM/instrumentable boundary tests with a real temporary AndroidSqliteDriver where supported, covering authenticated userId plumbing, create/open/migrate/reopen/close, route-independent lifetime, namespace switch, cancellation-before-purge, non-cancelled purge, and no post-logout emission.
- 8. Preserve sanitized diagnostics only and never include backend URL credentials, event content, facets, searches, or database payloads.
- 9. Repair the narrow legacy CalendarViewModel compatibility path required by the declared `:android:testDebugUnitTest` gate: occurrence updates must use the recurring/base event ID expected by Calendar V2 while carrying occurrenceId/originalStart independently. Keep the semantic test assertion; do not weaken or skip it, and do not broaden this into the later thin-ViewModel rewrite.

## Integration Expectation

Deliver this contribution for integration in stage android-calendar-database-session.

## Context

- shared/mobile-data owns schema, store, read/cache policy, mutations, and StateFlow. Android must not create a separate cache or repository.
- UserSessionManager currently does not retain userId, so this task owns plumbing the server-authenticated AuthUser.userId into the session boundary before deriving a cache namespace.
- The authenticated UserSessionManager is the lifecycle owner; route changes must not close the calendar database and logout/account/backend replacement must not allow stale emissions.
- The declared Android unit-test gate currently fails because the compatibility update path sends occurrenceId where the reviewed Calendar V2 contract requires the recurring/base event ID; this task owns only that narrow repair so the stage can integrate safely.
- Exact mobile references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. This nonvisual task supplies persistence needed for restored view/filter state; it must not import prototype assets or data.

## Boundary — Excluded

- CalendarScreen rendering or broad CalendarViewModel architecture changes
- Shared cache/revalidation/mutation policy
- External/shared storage or SQLCipher
- iOS driver setup
- Changes to visual references

## Interfaces and Dependencies

- Consumes AuthUser.userId, normalized backend identity, the shared CalendarDatabase driver seam, complete CalendarExperience factory, and the established Calendar V2 recurring identity contract.
- Produces an authenticated-session CalendarExperience dependency for Android CalendarViewModel and a passing recurrence-compatible Android unit-test boundary.
