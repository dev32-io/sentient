# Task Brief: Calendar REST API over the shared CalendarStore

## Contribution Goal

Deliver the /api/v1/calendar/... REST handlers (events CRUD + list/filter) over the same CalendarStore, minting capabilities from the authenticated principal (single configured household), serving tz-aware values (UTC instant + event tz id, or all-day date), closing request-scoped handles, and matching the shared wire schema.

## Boundary — Included

- gateway/src/api/handlers/calendar.ts with GET/POST/PATCH/DELETE/list handlers over CalendarStore matching the golden wire fixtures
- ApiRouterDeps, createApiRouter dispatch, and server.ts wiring for /api/v1/calendar
- Capability minting from the authenticated principal (configured household id), ignoring body/query user and household ids
- Serving tz-aware values (UTC instant + event tz id, or all-day date) for client device-tz rendering
- Request-scoped store open + close() in try/finally
- Typed responses for success, not-found, validation, and auth failures matching the error mapping

## Required Work

- 1. Create gateway/src/api/handlers/calendar.ts following sessions.ts authority: validate bearer, read current user record, derive role, construct UserPrincipal with the configured household id, grant calendar-private and calendar-household, open CalendarStore.
- 2. Implement GET /api/v1/calendar/events (list/filter), GET .../events/:id, POST .../events, PATCH .../events/:id, DELETE .../events/:id over the store matching the golden wire fixtures, ignoring caller-supplied user/household ids.
- 3. Serve tz-aware values (UTC instant + event tz id, or all-day date); the client renders in its own device tz.
- 4. Open request-scoped store handles and close() them in a try/finally.
- 5. Wire ApiRouterDeps, createApiRouter dispatch, and server.ts handler construction and dependency wiring.
- 6. Add handler tests for CRUD, list/filter, missing/invalid bearer, not-found, isolation, caller-supplied-identity rejection, tz-aware value shape, request-scoped close, and golden-fixture wire shape.
- 7. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s4-rest-api.

## Context

- REST authority precedent is gateway/src/api/handlers/sessions.ts: validate bearer, read current user record, derive role, construct UserPrincipal, accessManager.grant, open scoped store; it deliberately ignores caller-supplied userId.
- Routing is added in gateway/src/api/router.ts (ApiRouterDeps + createApiRouter dispatch) and wired in gateway/src/server.ts (handler factory + GatewayServices).
- v1 uses the single configured household id (home) from the existing principal model; do NOT add household-identity storage or migration.
- REST must mint calendar-private/calendar-household capabilities and operate the same CalendarStore with the same visibility filtering as the tools.
- Timezone model: REST serves tz-aware values (UTC instant + event tz id, or all-day date) matching the existing gateway convention (explicit-offset stamps via TimeZoneProvider); the client renders in its own device tz. REST never needs a user current tz.
- Store handles expose close(); request-scoped handles must be closed in a try/finally to avoid leaking SQLite/WAL/SHM descriptors.
- REST, tools, web, and SDK share the JSON wire schema and golden fixtures from s1-domain-contracts.

## Boundary — Excluded

- Web and mobile UI clients
- Tool group and nudge
- User-current-tz / scheduler (future)

## Interfaces and Dependencies

- Produces: /api/v1/calendar/... REST surface consuming the shared wire schema, used by web and mobile clients.
- Consumes: CalendarStore from s3-store-reads; AccessManager from s1-resource-classes; wire schema and golden fixtures from s1-domain-contracts.
