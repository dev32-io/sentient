# Task Brief: Replace the calendar REST API with V2 paging and mutation commands

## Contribution Goal

Authenticated web/mobile consumers receive bounded V2 calendar reads and perform all updates/deletes through one typed mutation command endpoint over the shared domain services.

## Boundary — Included

- Version-2 GET list/get, POST create, and POST event mutation routes
- Raw temporal query strings, deterministic cursor pages, typed HTTP errors, and clean route removal
- Handler and local integration tests for paging, mutation, authority, privacy, and stale revision

## Required Work

- 1. Refactor gateway/src/api/handlers/calendar.ts route matching for GET /api/v1/calendar/events, GET /api/v1/calendar/events/{eventId}, POST /api/v1/calendar/events, and POST /api/v1/calendar/events/{eventId}/mutations only.
- 2. Parse list from/to as raw V2 temporal query strings rather than JSON CalendarTime, plus optional scope private/household/all, group, tags, importance, and opaque cursor. Omitted scope defaults private.
- 3. Route list/get through CalendarQueryService so pages contain events and optional nextCursor, deterministic order, effective filtering, and authorized all-scope behavior. Allow get to target an occurrence with originalStart query input if supplied.
- 4. Validate POST create with the authoritative V2 create schema, assign private default, and call the shared create service.
- 5. Validate mutation bodies containing operation update/delete, applyTo, optional originalStart, expectedRevision, scope, and changes for update; resolve path eventId into the command and call mutateCalendarEvent.
- 6. Return version:2 envelopes and typed mutation results exactly as pinned by calendar-v2-contracts. Map invalid_time/invalid_range/range_too_wide/invalid_scope/occurrence_not_found/result_too_large/recurrence_conflict/conflict/auth/io errors to stable appropriate 4xx/5xx statuses without exposing hidden state.
- 7. Remove PATCH and DELETE routing and V1 parseEvent/toWire compatibility helpers. Tests must prove old methods are rejected and no handler searches writable scopes when scope is omitted.
- 8. Mint capability-bound private and household stores from the authenticated immutable principal, pass role and resolved configuration into services, and close every opened handle once even on validation, auth, domain, or serialization failure.
- 9. Keep external calls bounded by existing bearer/user-store boundaries and catch failures only at those process/adapter seams. Do not log authorization headers, query values, event content, request bodies, or response bodies.
- 10. Extend gateway/src/api/handlers/calendar.test.ts with V2 golden create/list/get/mutation cases, cursor continuation, private default, all-scope child visibility, invalid ranges before store work, result overflow, recurrence conflict, stale revision, route removal, role gates, and close behavior.
- 11. Add a handler-level local integration path on fresh disposable V2 stores proving REST portions of E2E-004, E2E-008 through E2E-016. Retain only method/path/status/size/IDs/revisions as evidence; never raw payload content.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-rest.

## Context

- gateway/src/api/handlers/calendar.ts currently parses JSON CalendarTime query parameters, returns more:0, searches scopes implicitly, and implements legacy PATCH/DELETE.
- This is a clean wire cutover: old PATCH/DELETE and V1 request/response shapes are removed, not adapted.
- The handler derives UserPrincipal from bearer authentication and must keep capability-held stores request-scoped and closed in finally.

## Boundary — Excluded

- Tool provider behavior
- Web/KMP client implementation
- Calendar UI changes
- Legacy REST compatibility or data migration

## Interfaces and Dependencies

- Consumes bearer token/user lookup, AccessManager, CalendarConfig, CalendarQueryService, createCalendarEvent, mutateCalendarEvent, and V2 schemas.
- Produces version-2 JSON HTTP envelopes and deterministic page/mutation results on the documented routes.
