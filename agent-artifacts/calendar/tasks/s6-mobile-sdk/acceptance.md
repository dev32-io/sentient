# Task Acceptance: Mobile SDK CalendarHttpClient and models

## Deliverables

- Deliver the KMP mobile SDK calendar REST client (CalendarHttpClient) and models mirroring the gateway domain, deriving REST base and token per request like the profile client.

## Acceptance

- CalendarHttpClient performs typed GET/POST/PATCH/DELETE/list against /api/v1/calendar
- Calendar models mirror the gateway domain (event, occurrence, RRULE subset, visibility, importance, group, tags, exceptions)
- REST base URL and token are derived per request like ProfileEditHttpClient

## Boundary Proof

- SDK unit tests cover client calls and model mapping
