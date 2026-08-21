# Task Brief: Establish the shared SQLDelight calendar database

## Contribution Goal

shared/mobile-data has a compilable, migration-tested SQLDelight database and a platform-neutral driver seam for protected, account-scoped calendar snapshots and presentation preferences.

## Boundary — Included

- Version-catalog and shared/mobile-data Gradle configuration for SQLDelight
- Initial schema and explicit migration support for complete month snapshots, snapshot occurrences, freshness/LRU metadata, and calendar preferences
- A common platform-neutral driver/path injection contract with no Android or Apple types in commonMain
- Database creation, schema-version, open/close, and migration tests

## Required Work

- 1. Add SQLDelight plugin and runtime/driver/test dependencies through gradle/libs.versions.toml and shared/mobile-data/build.gradle.kts; keep shared/mobile-sdk free of persistence dependencies.
- 2. Define the SQLDelight database under shared/mobile-data with account/backend namespace, month window and timezone keys, complete-snapshot markers, occurrence payload/identity rows, fetched-at and last-accessed metadata, and one namespace-scoped preference record for view, anchor date, scopes, groups, tags, importance, and search.
- 3. Preserve eventId, occurrenceId, originalStart, revision, scope, visibility, recurrence, all-day identity, and raw timezone-bearing values needed to reconstruct current Calendar V2 models. Do not persist filtered subsets as authoritative month snapshots.
- 4. Define a minimal common driver factory or injected SqlDriver boundary; common signatures must contain no Context, NSURL, or other platform types. Platform-specific protected paths are implemented by later Android/iOS tasks.
- 5. Add explicit initial-schema and migration fixtures/tests that open an older schema, migrate without data leakage or partial rows, and prove namespace uniqueness and database close behavior.
- 6. Keep diagnostics structural only: schema version, namespace-safe hashes/ids, row counts, durations, and failure kinds; never log event payloads, titles, descriptions, facets, searches, or tokens.

## Integration Expectation

Deliver this contribution for integration in stage mobile-sqldelight-foundation.

## Context

- There is no SQLDelight setup in the repository today. shared/mobile-sdk remains the stateless REST/wire boundary; persistence belongs in shared/mobile-data.
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
