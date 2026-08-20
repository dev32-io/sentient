# Task Brief: Replace all six model-facing calendar tool adapters

## Contribution Goal

The model can safely use every calendar tool with concise strings, explicit recurrence mutation scope, complete bounded results, and actionable failures while existing tiers and role gates remain unchanged.

## Boundary — Included

- V2 definitions and runners for calendar_list, calendar_search, calendar_get, calendar_create, calendar_update, and calendar_delete
- Model-oriented errors, private defaults, all-scope reads, complete-result enforcement, and cancellation
- Provider contract/security/privacy tests covering E2E-001 through E2E-013 at the tool boundary

## Required Work

- 1. Rewrite the provider schemas and JSON Schema definitions to use V2 strings and structured recurrence. Remove nested kind/instant/timeZoneId parameters, raw RRULE input, patch/event aliases, and optional search bounds.
- 2. Define calendar_list as from/to plus optional read scope private/household/all and filters; calendar_search as query plus required from/to and the same filters; calendar_get as eventId plus optional originalStart and optional read scope. Omitted scope resolves private.
- 3. Define calendar_create with title, start, optional end/description/structured recurrence/visibility/importance/group/tags/scope. Omitted scope, visibility, importance, and tags become private/everyone/normal/empty at the validated boundary.
- 4. Define calendar_update with eventId, required applyTo, optional originalStart, expectedRevision and private/household scope, plus one changes object. Define calendar_delete with the same targeting fields except changes. Do not accept scope all on writes.
- 5. Keep the existing tiers: list/get/search read, create/update write, delete confirm. Reject a non-adult household write in validate() before broker ask/confirm and before any query/store/service call; retain store defense in depth.
- 6. Route reads only through CalendarQueryService and writes only through the shared create/mutation service. Thread ctx.signal, return aborted before work when cancelled, and never call the REST handler.
- 7. Replace ambiguous id output with concise V2 eventId, occurrenceId, originalStart, recurring, scope, revision, title, and time fields. Get/create/mutation results follow the authoritative V2 projections/results.
- 8. Convert temporal/schema/domain failures into stable isError tool JSON with outcome error, code, message, and only safe corrective metadata. Aggregate useful Zod path information rather than returning generic Invalid input, but never echo calendar values.
- 9. For all-scope read failures, return no partial events and direct the model to retry private or household. For invalid/overwide input, fail before service/store calls.
- 10. Treat query continuation, aggregate overflow, or output.max_result_chars overflow as result_too_large with narrowing guidance. Assert the complete tool JSON stays below the generic broker cap and no calendar path relies on generic truncation.
- 11. Preserve scheduler-fence descriptions and existing tool names/tier metadata. Do not expose internal exceptions, exclusions, notification policy, created timestamps, or raw RRULE in concise list/search output.
- 12. Expand gateway/src/bootstrap/product-tools/calendar-provider.test.ts with valid and invalid shapes for every tool, private default, explicit all, search-required bounds, actionable paths, permission behavior, complete-or-error overflow, recurrence conflicts, stale revisions, occurrence identity, and cancellation. Include canary content and assert no logs or returned diagnostics leak it.
- 13. Add/extend a local handler-level integration test using disposable V2 stores and capabilities to pin the tool-visible outcomes of E2E-001 through E2E-013 without browser/UI dependencies.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-tools.

## Context

- gateway/src/bootstrap/product-tools/calendar-provider.ts currently exposes nested CalendarTime, raw-plus-parsed RRULE, optional unbounded search dates, ambiguous occurrence id, and first-Zod-issue errors.
- The shared V2 query and mutation services own calendar behavior; this provider validates/model-projects and never calls REST through loopback.
- Tool names, read/write/confirm tiers, product group, default exposure, and pre-PDP household write denial must remain stable.

## Boundary — Excluded

- Calendar domain/query/mutation implementation
- REST routing
- Web/mobile clients and calendar UI
- Changing broker tier policy or generic result-cap behavior

## Interfaces and Dependencies

- Consumes CalendarQueryService, createCalendarEvent/mutateCalendarEvent, V2 schemas, CalendarConfig, private/household capabilities, and AbortSignal.
- Produces the same six NativeToolRunner names with stable tier metadata and V2 JSON results/errors.
