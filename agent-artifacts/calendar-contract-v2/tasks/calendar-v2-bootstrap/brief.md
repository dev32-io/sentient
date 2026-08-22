# Task Brief: Wire calendar V2 services into sessions and REST

## Contribution Goal

Session tools, calendar nudge, and HTTP routes receive the same resolved limits, timezone, capability-held stores, query service, and mutation service through existing composition roots.

## Boundary — Included

- Resolved CalendarConfig mapping and service construction
- Session tool/nudge lifecycle and HTTP handler wiring
- Bootstrap/config fixture, close, and security tests

## Required Work

- 1. Update buildSessionCalendar to resolve the household timezone sentinel once and construct the immutable V2 CalendarConfig from orchestrator.calendar recurrence/query/input/output/nudge settings.
- 2. Mint private and household capabilities through AccessManager exactly as today, open fresh V2 stores, and construct shared query/create/mutation services over those handles. Do not introduce ambient current-user state.
- 3. Pass service dependencies, capabilities, resolved role/timezone, and limits into calendarProductToolProvider while preserving existing six tool metadata and session-owned close lifecycle.
- 4. Adapt composeCalendarNudge to the bounded effective-occurrence query seam so its existing cap, household-today, role visibility, and prompt-cache behavior remain unchanged. Nudge must not gain recurrence mutation or unbounded query behavior.
- 5. Update createCalendarHandler wiring in gateway/src/server.ts and any create-gateway-services/bootstrap types so authenticated REST requests construct/use the same V2 factories and resolved calendar config.
- 6. Keep calendar disabled behavior unchanged: no grants, stores, tools, query, nudge, or REST mutation service should be created for a disabled session path beyond the existing HTTP route policy.
- 7. Update direct OrchestratorConfig test fixtures and bootstrap tests for the new dependencies. Assert stores close exactly once on session/request disposal and partial construction failure closes already-opened handles.
- 8. Preserve production guardrails: do not hand-start production, delete live storage, add an automatic reset, or log calendar content/config secrets.
- 9. Run focused session runtime and prompt/nudge tests to ensure the composition change does not alter unrelated runtime behavior.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-bootstrap.

## Context

- buildSessionCalendar in gateway/src/bootstrap/phase-services.ts currently opens two stores, passes them directly to the provider, and composes the nudge.
- gateway/src/server.ts constructs createCalendarHandler separately from authenticated services.
- Tool and REST adapter tasks preserve their exported provider/handler entry points but require V2 dependency objects.

## Boundary — Excluded

- Domain algorithms and adapter request schemas
- Web or mobile client changes
- UI behavior
- Calendar data migration or production cleanup

## Interfaces and Dependencies

- Consumes V2 store/query/mutation factories, calendarProductToolProvider, createCalendarHandler, AccessManager, UserPrincipal, resolved OrchestratorConfig, and TimeZoneProvider.
- Produces SessionCalendar tools/nudge/close and server calendar handler dependencies with no new global authority.
