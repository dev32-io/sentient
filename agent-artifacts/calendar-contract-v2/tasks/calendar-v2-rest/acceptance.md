# Task Acceptance: Replace the calendar REST API with V2 paging and mutation commands

## Deliverables

- Authenticated web/mobile consumers receive bounded V2 calendar reads and perform all updates/deletes through one typed mutation command endpoint over the shared domain services.

## Acceptance

- Equivalent bounded reads use raw string dates and deterministic continuation instead of more:0.
- Every update/delete uses POST /events/{eventId}/mutations; PATCH and DELETE no longer mutate calendars.
- Omitted scope reads/writes private only; explicit all is read-only.
- Domain errors map to stable actionable HTTP errors without hidden-data leakage.
- Every request-scoped store closes under success and every failure path.

## Boundary Proof

- Handler unit/integration tests cover routes, schemas, paging, authority, error status/envelopes, mutation scopes, stale revisions, old-method rejection, and handle closure.
- Sanitized local evidence covers direct REST portions of E2E-004 and E2E-008 through E2E-016.
