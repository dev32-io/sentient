# Task Brief: CalendarStore get with role-based visibility filtering

## Contribution Goal

Implement CalendarStore.get(id) returning a single base event by id with role-based visibility filtering that omits adults events for non-adult roles, and typed not-found.

## Boundary — Included

- Implement get(id) with role-based visibility filtering at the query layer
- Omit visibility:adults events for non-adult cap.role
- Typed get result including not-found

## Required Work

- 1. Implement get(id) in calendar-store.ts returning the base event by id.
- 2. Apply role-based visibility filtering at the query layer: omit visibility:adults rows when cap.role is not adult.
- 3. Return a typed not-found failure for absent ids.
- 4. Add tests for base fetch, child adults-event omission (AC-003 at the store), and not-found.
- 5. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s3-store-read-visibility.

## Context

- CalendarStore CRUD exists from s3-store-create/update/delete.
- Role-based visibility is filtered at the store query layer via the structured visibility field (not an @adults suffix); children omit adults events.
- get returns base events by id; occurrence expansion is handled by list/filter.

## Boundary — Excluded

- list/filter expansion, create/update/delete

## Interfaces and Dependencies

- Produces: CalendarStore.get with role-based visibility filtering.
- Consumes: CalendarStore from s3-store-create; domain visibility types from s1-domain-contracts.
