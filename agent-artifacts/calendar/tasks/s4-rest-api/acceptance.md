# Task Acceptance: Calendar REST API over the shared CalendarStore

## Deliverables

- Deliver the /api/v1/calendar/... REST handlers (events CRUD + list/filter) over the same CalendarStore, minting capabilities from the authenticated connection principal and ignoring caller-supplied identity, with typed responses.

## Acceptance

- Authenticated REST CRUD persists and reads through the same CalendarStore as the agent tools
- Missing/invalid bearer and caller-supplied user/household ids are ignored in favor of the authenticated principal
- Isolation and not-found behaviors return typed responses

## Boundary Proof

- Handler tests cover CRUD, list/filter, auth failures, isolation, and caller-supplied-identity rejection
