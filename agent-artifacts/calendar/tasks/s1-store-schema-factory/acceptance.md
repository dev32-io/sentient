# Task Acceptance: CalendarStore schema, migration ladder, factory skeleton, and close() lifecycle

## Deliverables

- Deliver a capability-gated, WAL-backed bun:sqlite CalendarStore factory with frozen baseline DDL and a forward-only user_version migration ladder (including the forward-compatible notification column), a close() lifecycle, and an explicit ahead-of-binary policy, with empty query methods returning typed not-implemented results.

## Acceptance

- AC-001: a user's private db is at <userHomeDir>/calendar/calendar.db and a household db at <sharedDataRoot>/home/calendar/calendar.db (configured household id)
- AC-002: openCalendarStore rejects a wrong resource class (e.g. a calendar-private cap for a household store) via the resource-class gate, not merely path checks
- A fresh calendar.db is created and migrated from v0 for an existing user on first calendar access
- An ahead-of-binary database is handled with an explicit policy (reject open or warn-and-leave-untouched) that is tested
- The factory exposes close() and closed-handle semantics

## Boundary Proof

- Store factory tests cover fresh v0 migration, each migration version, WAL, wrong-class rejection (not just path), path isolation, ahead-of-binary policy, and close()/closed-handle semantics
