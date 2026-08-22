# Task Brief: Add calendar resource classes and capability roots

## Contribution Goal

Establish calendar-private and calendar-household as first-class capability resource classes with household-aware path derivation, so a CalendarStore can be opened under a frozen, path-confined capability.

## Boundary — Included

- Add 'calendar-private' and 'calendar-household' to the ResourceClass union
- Extend rootPathFor in access-manager.ts so calendar-household roots under sharedDataRoot/<householdId> and calendar-private roots under the user home dir, matching the memory pattern
- Update access-manager tests and capability tests to cover both new classes, household path derivation, and that a calendar-private cap cannot cover a household path and vice versa

## Required Work

- 1. Add the two new ResourceClass values to gateway/src/access/capability.ts and update any exhaustive switches.
- 2. Extend rootPathFor in gateway/src/access/access-manager.ts with the calendar branches; reuse the existing household root derivation.
- 3. Add/extend tests in access-manager.test.ts and capability.test.ts for grant, rootPathFor, and capabilityCoversPath isolation between calendar-private, calendar-household, memory-private, and memory-household.
- 4. Run gateway typecheck and the access tests.

## Integration Expectation

Deliver this contribution for integration in stage s1-resource-classes.

## Context

- ResourceClass is a union in gateway/src/access/capability.ts; Capability is a frozen handle (ownerUserId, resource, rootPath, role).
- AccessManager.grant(principal, resource) in gateway/src/access/access-manager.ts builds the capability via rootPathFor; only memory-household currently roots under sharedDataRoot/<householdId>.
- capabilityCoversPath(cap, path) in capability.ts enforces root-prefix confinement and blocks traversal.

## Boundary — Excluded

- CalendarStore implementation, schema, and migrations
- Tool group, REST, nudge, and UI

## Interfaces and Dependencies

- Produces: ResourceClass now includes calendar-private/calendar-household; grant(principal, 'calendar-private'|'calendar-household') yields a frozen Capability with a confined rootPath and principal.role.
- Consumes: existing AccessManager and Capability surface; no store changes.
