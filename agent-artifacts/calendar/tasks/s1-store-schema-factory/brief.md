# Task Brief: CalendarStore schema, migration ladder, factory skeleton, and close() lifecycle

## Contribution Goal

Deliver a capability-gated, WAL-backed bun:sqlite CalendarStore factory with frozen baseline DDL (UTC-instant + event-tz-id + all-day-date columns) and a forward-only user_version migration ladder (including the forward-compatible notification column), a close() lifecycle, and an explicit ahead-of-binary policy, with empty query methods returning typed not-implemented results.

## Boundary — Included

- CalendarStore schema DDL (events, exceptions, EXDATE, tags, visibility, importance, notification policy column) as frozen baseline with UTC-instant + event-tz-id + all-day-date columns
- Forward-only user_version migration ladder starting at v0 (fresh db for existing users) with at least the baseline migration
- openCalendarStore(cap, cfg, deps) factory with ACCEPTED_CLASSES = {calendar-private, calendar-household}, WAL, open, migrate, path derivation <cap.rootPath>/calendar/calendar.db, and close() with closed-handle semantics
- Class-gate rejection before path work and an explicit, tested ahead-of-binary open policy
- Empty query method stubs returning typed not-implemented results so later tasks implement against a compiling interface

## Required Work

- 1. Create gateway/src/calendar/schema.ts with frozen baseline DDL (events, exceptions, EXDATE, tags, visibility, importance, notification column; UTC-instant + event-tz-id + all-day-date columns) and a migration ladder array following session-store's StoreMigration shape.
- 2. Create gateway/src/calendar/calendar-store.ts with openCalendarStore(cap, cfg, deps): ACCEPTED_CLASSES gate, ensure <cap.rootPath>/calendar dir, open bun:sqlite with WAL, run migrate-store-style migration, apply an explicit ahead-of-binary policy, and expose close() with closed-handle semantics plus compiling stub methods returning typed not-implemented results.
- 3. Reuse or extract a shared migrate helper consistent with gateway/src/store/migrate-store.ts; do not duplicate divergent migration logic.
- 4. Add tests: fresh db at v0 then migrated, each migration version, WAL pragmas, wrong-class rejection (resource class, not path), private-vs-household path isolation, ahead-of-binary policy, and close()/closed-handle semantics.
- 5. Run gateway tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s1-store-schema-factory.

## Context

- SQLite/WAL/migration precedent is gateway/src/store/session-store.ts, schema.ts, and migrate-store.ts (PRAGMA journal_mode=WAL, PRAGMA user_version, transaction-per-migration, forward-only, ahead-of-binary left untouched and warned).
- MemoryStore (gateway/src/memory/memory-store.ts) is the capability factory precedent: ACCEPTED_CLASSES gate before any path work, store under <cap.rootPath>/<subdir>.
- Household events resolve to <sharedDataRoot>/<householdId>/calendar/calendar.db (configured household id home for v1) and private to <userHomeDir>/calendar/calendar.db via cap.rootPath.
- The store must reject a calendar-private capability opening a household store and vice versa via the resource class, and must expose close() to avoid leaking SQLite/WAL/SHM descriptors.
- Timezone model: timed events store a UTC instant plus an event tz id (default household tz); all-day events store a local date (no time). Columns must carry the event tz id and an all-day flag/date so recurrence stays anchored.

## Boundary — Excluded

- CRUD implementation, recurrence expansion, visibility filtering, and write gates (later tasks)

## Interfaces and Dependencies

- Produces: openCalendarStore(cap, cfg, deps) returning a CalendarStore with close() and compiling stubs; schema.ts migration ladder.
- Consumes: Capability and ResourceClass from s1-resource-classes; domain types and close() contract from s1-domain-contracts; the migrate-store pattern.
