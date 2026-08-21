# Task Brief: Establish the shared SQLDelight calendar database

## Contribution Goal

shared/mobile-data has a compilable, migration-tested SQLDelight database and a platform-neutral driver seam for protected, account-scoped calendar snapshots and presentation preferences.

## Boundary — Included

- Version-catalog and shared/mobile-data Gradle configuration for a verified SQLDelight release
- Initial schema and explicit migration support for complete month snapshots, snapshot occurrences, freshness/LRU metadata, and calendar preferences
- A common platform-neutral driver/path injection contract with no Android or Apple types in commonMain
- Database creation, schema-version, open/close, migration, and toolchain-compatibility tests

## Required Work

- 1. Before schema work, identify and pin a stable SQLDelight release that demonstrably builds with Kotlin 2.3.10/K2, the Android target, iosArm64, and iosSimulatorArm64. Record the version in gradle/libs.versions.toml; if no compatible release exists, stop and report the toolchain blocker rather than forcing an incompatible plugin.
- 2. Add the verified SQLDelight plugin and dependencies through the version catalog. Put SQLDelight runtime/coroutine support in commonMain with visibility sufficient for the injected SqlDriver seam, native-driver only in iosMain, Android driver only in the later Android platform task/app source set, and a JVM SQLite driver only in tests. Keep shared/mobile-sdk free of persistence dependencies.
- 3. Define the SQLDelight database under shared/mobile-data with account/backend namespace, month window and timezone-input keys, complete-snapshot markers, occurrence payload/identity rows, fetched-at and last-accessed metadata, and one namespace-scoped preference record for view, anchor date, scopes, groups, tags, importance, and search.
- 4. Preserve eventId, occurrenceId, originalStart, revision, scope, visibility, recurrence, all-day identity, and raw RFC3339 offset-bearing values needed to reconstruct current Calendar V2 models. Do not invent an IANA timezone field and do not persist filtered subsets as authoritative month snapshots.
- 5. Define a minimal common driver factory or injected SqlDriver boundary; common signatures must contain no Context, NSURL, or other platform types. Platform-specific protected paths are implemented by later Android/iOS tasks.
- 6. Add explicit initial-schema and migration fixtures/tests that open an older schema, migrate without data leakage or partial rows, and prove namespace uniqueness and database close behavior.
- 7. Keep diagnostics structural only: schema version, namespace-safe hashes/ids, row counts, durations, and failure kinds; never log event payloads, titles, descriptions, facets, searches, raw backend URLs, or tokens.

## Integration Expectation

Deliver this contribution for integration in stage mobile-sqldelight-foundation.

## Context

- There is no SQLDelight setup in the repository today. shared/mobile-sdk remains the stateless REST/wire boundary; persistence belongs in shared/mobile-data.
- Kotlin is pinned to 2.3.10 and SQLDelight was previously removed from an unrelated chat mirror because that design was over-complex. Reintroduction here is limited to bounded calendar read snapshots and must first prove toolchain compatibility.
- The authenticated account/backend namespace must prevent private events, facet names, counts, and preferences from crossing logout, account, or backend boundaries.
- The exact calendar visual references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. They motivate persisted view/filter state but do not define database schema or permit copying prototype event data.

## Boundary — Excluded

- Android Context-backed driver construction
- iOS Application Support path and Data Protection setup
- Cache policy, remote revalidation, pagination, filtering, prefetch, or mutations
- SQLCipher or cross-platform database-key management
- Changes to sentient-design reference files

## Interfaces and Dependencies

- Produces the generated CalendarDatabase plus a minimal common driver/open-close seam for CalendarCacheStore.
- Consumes current Calendar V2 model identities from shared/mobile-sdk without changing the wire contract.
