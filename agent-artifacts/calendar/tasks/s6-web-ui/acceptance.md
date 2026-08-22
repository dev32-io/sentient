# Task Acceptance: Web calendar route, REST client, and view

## Deliverables

- Deliver the web calendar feature: a REST client service matching the golden wire fixtures, a calendar icon, a top-level route, and a calendar view that lists/creates/updates/deletes events via the /api/v1/calendar REST surface and renders tz-aware values in the browser device tz.

## Acceptance

- The web calendar route lists, creates, updates, and deletes events via the REST client
- A new calendar icon and top-level route render the calendar view
- Calendar writes are immediate REST mutations with local refresh (not the profile Apply bar)
- The calendar-api client wire shape matches the shared golden fixtures from s1-domain-contracts and renders tz-aware values (UTC instant + event tz id, or all-day date) in the browser device tz

## Boundary Proof

- Vitest tests cover calendar-api golden-fixture wire shape, device-tz rendering of tz-aware values, and the view's list/create/update/delete behavior
