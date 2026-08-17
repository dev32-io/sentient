# Task Acceptance: Calendar REST API over the shared CalendarStore

## Deliverables

- Deliver the /api/v1/calendar/... REST handlers (events CRUD + list/filter) over the same CalendarStore, minting capabilities from the authenticated principal (single configured household), serving events in the configured timezone, closing request-scoped handles, and matching the shared wire schema.

## Acceptance

- Authenticated REST CRUD persists and reads through the same CalendarStore as the agent tools
- Missing/invalid bearer and caller-supplied user/household ids are ignored in favor of the authenticated principal (single configured household id)
- Events are served in the configured serving timezone (America/Vancouver) over UTC-stored instants
- Request-scoped store handles are closed in a try/finally; isolation and not-found return typed responses
- REST wire shape matches the shared golden fixtures from s1-domain-contracts

## Boundary Proof

- Handler tests cover CRUD, list/filter, auth failures, isolation, caller-supplied-identity rejection, serving-tz rendering, request-scoped close, and golden-fixture wire shape
