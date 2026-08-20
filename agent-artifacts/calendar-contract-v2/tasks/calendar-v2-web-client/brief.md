# Task Brief: Cut the web calendar service over to REST V2

## Contribution Goal

Web consumers can page calendar reads and issue every recurring mutation scope through the V2 command while current calendar components remain unchanged.

## Boundary — Included

- Web service V2 models, paging, create/get/list, mutate, and typed errors
- Whole-series update/delete convenience adapters for untouched components
- Service contract tests and sanitized request evidence

## Required Work

- 1. Replace the V1 wire types in gateway/webui/src/services/calendar-api.ts with V2 event/occurrence/page/recurrence/mutation/error types matching the gateway fixture, including revision, eventId, occurrenceId, originalStart, nextCursor, and CalendarMutationResult.
- 2. Serialize list from/to as raw approved temporal strings and support scope private/household/all, filters, and opaque cursor. Omitted scope remains omitted on wire so the gateway applies private default.
- 3. Add mutate(token,eventId,command) that POSTs JSON only to /api/v1/calendar/events/{eventId}/mutations and decodes the version-2 typed result/error envelope.
- 4. Update create/get to the V2 envelope and payload. Strip server-owned identity, revision, occurrence, and timestamp fields from create.
- 5. Preserve current component-facing update/delete convenience methods without editing calendar-view.tsx: map update to operation update/applyTo entire_series/changes and map delete to operation delete/applyTo entire_series. Carry expectedRevision when available; omission remains legal.
- 6. Remove all PATCH/DELETE requests, more counters, JSON CalendarTime query encoding, baseEventId normalization hacks, and V1 envelope assumptions.
- 7. Keep bearer token handling and generic fetch error boundaries. Never log tokens, temporal query strings, event fields, mutation payloads, or response bodies.
- 8. Expand gateway/webui/src/services/calendar-api.test.ts to assert exact raw query strings, continuation, all scope, create stripping, every mutation scope, entire-series convenience mapping, stale-revision error decoding, and absence of PATCH/DELETE.
- 9. Add a contract integration test using an injected fetch/handler seam to run the web service against the real V2 calendar handler with disposable authenticated dependencies, covering the web portion of E2E-014 and E2E-015 without rendering UI or retaining payload content.
- 10. Run the untouched calendar view tests and web typecheck to prove existing screens compile and use the convenience methods without visual behavior changes.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-web-client.

## Context

- gateway/webui/src/services/calendar-api.ts currently mirrors V1 CalendarTime JSON query parameters and PATCH/DELETE routes.
- UI component and visual files are explicitly out of scope. Existing service convenience methods may adapt their current whole-series calls to V2 entire_series commands.
- The REST V2 contract and golden fixture are authoritative; no old wire fallback is needed.

## Boundary — Excluded

- Any calendar component, CSS, route, dialog, or visual change
- KMP/mobile implementation
- Legacy REST fallback

## Interfaces and Dependencies

- Consumes version-2 REST routes/envelopes and bearerHeaders/handleFetch helpers.
- Produces CalendarApi list/get/create/mutate plus source-level update/delete convenience methods for existing components.
