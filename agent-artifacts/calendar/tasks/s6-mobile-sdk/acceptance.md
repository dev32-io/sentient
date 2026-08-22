# Task Acceptance: Mobile SDK CalendarHttpClient and models

## Deliverables

- Deliver the KMP mobile SDK calendar REST client (CalendarHttpClient) and models mirroring the gateway domain and golden wire fixtures, deriving REST base and token per request like the profile client, receiving tz-aware values for device-tz rendering.

## Acceptance

- CalendarHttpClient performs typed GET/POST/PATCH/DELETE/list against /api/v1/calendar matching the shared golden fixtures
- Calendar models mirror the gateway domain (event, occurrence, RRULE subset, visibility, importance, group, tags, exceptions) and the tz-aware value (UTC instant + event tz id, or all-day date); the client renders in its own device tz
- REST base URL and token are derived per request like ProfileEditHttpClient

## Boundary Proof

- SDK unit tests cover client calls and golden-fixture model mapping
