# Task Acceptance: Implement shared online calendar mutation intents and recovery

## Deliverables

- CalendarExperience owns complete online create, edit, and delete intent handling with exact V2 recurrence/revision semantics, offline write gates, typed conflicts, draft-preserving failures, and affected-window revalidation.

## Acceptance

- Every mutation carries exact V2 identity, scope, recurrence, originalStart, and expectedRevision data.
- Offline actions cannot imply success or create durable mutation records.
- Conflicts preserve intent and require reread/review; permissions remain non-disclosing.
- Success refreshes affected intervals without erasing valid cached content.

## Boundary Proof

- Shared tests pin CAL-UX-004, CAL-UX-005, CAL-UX-006, CAL-UX-007, CAL-UX-010, and CAL-UX-013 mutation seams.
- Database inspection tests prove offline intents create no queue/store rows.
- State inspection confirms exact mobile preview/editor reference flows are representable without native policy duplication.
