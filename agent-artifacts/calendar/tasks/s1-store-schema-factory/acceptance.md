# Task Acceptance: CalendarStore schema, migration ladder, and factory skeleton

## Deliverables

- Deliver a capability-gated, WAL-backed bun:sqlite CalendarStore factory with frozen baseline DDL and a forward-only user_version migration ladder, including the forward-compatible notification column, with empty query methods returning typed not-implemented results.

## Acceptance

- AC-001: a user's private db is at <userHomeDir>/calendar/calendar.db and a household db at <sharedDataRoot>/<householdId>/calendar/calendar.db
- AC-002: openCalendarStore rejects a calendar-private cap for a household path and vice versa via the resource-class gate
- A fresh calendar.db is created and migrated from v0 for an existing user on first calendar access
- An ahead-of-binary database is left untouched and warned

## Boundary Proof

- Store factory tests cover fresh v0 migration, each migration version, WAL, wrong-class rejection, path isolation, and ahead-of-binary warning
