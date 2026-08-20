# Task Acceptance: Define the calendar V2 domain and wire contracts

## Deliverables

- All gateway, tool, REST, web, and mobile work can consume one explicit calendar V2 contract without internal CalendarTime-shaped model arguments or unresolved wire decisions.

## Acceptance

- No model-facing schema requires kind/instant/timeZoneId CalendarTime objects.
- Update and delete commands cannot omit applyTo or confuse calendar scope with mutation scope.
- A single-occurrence change schema permits every approved event-local field and rejects recurrence, scope, identity, revision, and notification policy.
- The version-2 fixture round-trips through strict request, page, mutation-result, and error schemas.
- Old V1 list/mutation fixture shapes are rejected rather than silently accepted.

## Boundary Proof

- Focused gateway type/schema tests cover valid and invalid model, REST, recurrence, clear, identity, and error examples.
- The shared golden fixture remains JSON-only and contains no private calendar content.
