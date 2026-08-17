# Task Brief: Calendar REST API over the shared CalendarStore

## Contribution Goal

Deliver the /api/v1/calendar/... REST handlers (events CRUD + list/filter) over the same CalendarStore, minting capabilities from the authenticated connection principal and ignoring caller-supplied identity, with typed responses.

## Boundary — Included

- gateway/src/api/handlers/calendar.ts with GET/POST/PATCH/DELETE/list handlers over CalendarStore
- ApiRouterDeps, createApiRouter dispatch, and server.ts wiring for /api/v1/calendar
- Capability minting from the authenticated principal (real household id), ignoring body/query user and household ids
- Typed responses for success, not-found, validation, and auth failures

## Required Work

- 1. Create gateway/src/api/handlers/calendar.ts following sessions.ts authority: validate bearer, read current user record, derive role, construct UserPrincipal with the real household id, grant calendar-private and calendar-household, open CalendarStore.
- 2. Implement GET /api/v1/calendar/events (list/filter), GET .../events/:id, POST .../events, PATCH .../events/:id, DELETE .../events/:id over the store, ignoring caller-supplied user/household ids.
- 3. Wire ApiRouterDeps, createApiRouter dispatch, and server.ts handler construction and dependency wiring.
- 4. Add handler tests for CRUD, list/filter, missing/invalid bearer, not-found, isolation, and caller-supplied-identity rejection.
- 5. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s4-rest-api.

## Context

- REST authority precedent is gateway/src/api/handlers/sessions.ts: validate bearer, read current user record, derive role, construct UserPrincipal, accessManager.grant, open scoped store; it deliberately ignores caller-supplied userId.
- Routing is added in gateway/src/api/router.ts (ApiRouterDeps + createApiRouter dispatch) and wired in gateway/src/server.ts (handler factory + GatewayServices).
- REST must mint calendar-private/calendar-household capabilities from the authenticated principal and operate the same CalendarStore with the same visibility filtering as the tools.
- The REST_HOUSEHOLD_ID placeholder in sessions is explicitly not real-household; the calendar handler must use the real household identity.

## Boundary — Excluded

- Web and mobile UI clients
- Tool group and nudge

## Interfaces and Dependencies

- Produces: /api/v1/calendar/... REST surface consumed by web and mobile clients.
- Consumes: CalendarStore from s3 tasks; AccessManager from s1-resource-classes; existing router/server handler patterns.
