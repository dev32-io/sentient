# Task Acceptance: CalendarStore get with role-based visibility filtering

## Deliverables

- Implement CalendarStore.get(id) returning a single base event by id with role-based visibility filtering that omits adults events for non-adult roles, and typed not-found.

## Acceptance

- AC-003: a child cannot observe visibility:adults events through get
- get returns single and recurring base events by id
- A non-existent id returns a typed not-found failure

## Boundary Proof

- get tests cover single/recurring base fetch, child adults-event omission, and not-found
