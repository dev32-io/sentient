# Task Brief: Build the fresh revisioned calendar V2 persistence boundary

## Contribution Goal

Capability-held calendar stores provide fresh V2 storage, revision compare-and-swap, child-state persistence, and atomic transaction primitives without interpreting legacy calendar data.

## Boundary — Included

- Fresh V2 database location and baseline schema
- Revisioned base events, rich exception/exclusion/tag persistence, raw authorized reads, and transaction primitives
- Capability, visibility, stale-revision, rollback, and fresh-storage tests

## Required Work

- 1. Replace the calendar baseline schema with a fresh V2 schema containing integer event revision, canonical recurrence data, effective-event metadata, tags, exclusions, and one exception row per eventId/original occurrence key with rich sparse override JSON and cancellation state.
- 2. Open V2 storage exactly at <cap.rootPath>/calendar-v2/calendar.db so an old <cap.rootPath>/calendar/calendar.db is ignored rather than migrated, read, reset, or deleted. Update the calendar E2E path helper and tests to the same exact location.
- 3. Keep calendar-private and calendar-household class gates before path derivation, WAL/foreign-key setup, request/session close behavior, and user/household root isolation.
- 4. Replace whole-event compatibility overloads with explicit V2 persistence operations. Expose a capability-held transaction interface that can read one base event and child state, insert a successor, compare-and-swap a base revision, replace partitioned exceptions/exclusions/tags, delete a segment, and commit or rollback as one unit.
- 5. Assign revision 1 on create and increment exactly once for each successful mutation of a surviving segment. A supplied stale expectedRevision returns conflict before any write. Do not use updatedAt as the compare-and-swap token.
- 6. Validate persisted rows/JSON through the V2 domain schemas before treating them as trusted values. Invalid persisted state returns typed invalid/io_error without leaking row content.
- 7. Keep unauthorized or adults-hidden base events indistinguishable from not found at public read boundaries. Provide only the narrow internal raw-read seam required to project an explicitly less-restrictive occurrence visibility; never expose raw state outside the capability-held query/mutation services.
- 8. Enforce non-adult household write rejection inside every create/mutation transaction as defense in depth.
- 9. Preserve the invariant that one original key cannot simultaneously own an EXDATE and cancelled exception. Persist tags deterministically and support explicit null/empty clears in override JSON.
- 10. Rewrite gateway/src/calendar/calendar-store.test.ts around fresh V2 stores and add transaction fault injection proving prefix/successor/children/revisions roll back together. Retain tests for wrong resource class, path isolation, child visibility, household write gates, closed handles, and SQLite errors.
- 11. Do not add a migration, operator-config migrator entry, legacy database detector that mutates files, or automatic destructive reset.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-storage.

## Context

- Current gateway/src/calendar/schema.ts installs a V1 migration and gateway/src/calendar/calendar-store.ts rewrites whole events and child rows without revisions.
- The approved cutover does not migrate, preserve, or silently delete existing calendar databases.
- Private and household capabilities, adult household-write gates, hidden-event non-disclosure, and close semantics remain binding.

## Boundary — Excluded

- Recurrence split decisions and mutation orchestration
- Bounded aggregate query/paging
- Tool, REST, web, and mobile adapters
- Production data cleanup

## Interfaces and Dependencies

- Produces openCalendarStore/openCalendarPersistence at <cap.rootPath>/calendar-v2/calendar.db and an internal transaction contract consumed by query and mutation services.
- Consumes V2 CalendarEvent, exceptions, exclusions, revisions, CalendarConfig, and immutable Capability values.
