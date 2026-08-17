# Task Acceptance: Web calendar route, REST client, and view

## Deliverables

- Deliver the web calendar feature: a REST client service, a calendar icon, a top-level route, and a calendar view that lists/creates/updates/deletes events via the /api/v1/calendar REST surface.

## Acceptance

- The web calendar route lists, creates, updates, and deletes events via the REST client
- A new calendar icon and top-level route render the calendar view
- Calendar writes are immediate REST mutations with local refresh (not the profile Apply bar)

## Boundary Proof

- Vitest tests cover calendar-api calls and view list/create/update/delete behavior
