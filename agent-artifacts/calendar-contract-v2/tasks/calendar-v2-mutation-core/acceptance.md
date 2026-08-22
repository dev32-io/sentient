# Task Acceptance: Create the mutation command boundary and whole-event operations

## Deliverables

- One authorized mutation service creates events and performs entire-series update/delete with canonical recurrence, revisions, atomicity, and typed results ready for scoped recurrence branches.

## Acceptance

- Create stores canonical finite recurrence and revision 1 from model-friendly input.
- Entire-series update changes only the selected segment and increments its revision once.
- Entire-series delete removes only the selected segment and children.
- Stale revision, invalid mutation scope, recurrence conflict, cancellation, or SQLite failure performs no partial write.
- The service requires no REST or tool context and logs no calendar content.

## Boundary Proof

- Mutation service tests cover create, update, delete, revision conflict, independent segments, recurrence-child conflicts, authority, cancellation, and rollback.
- E2E-006 domain behavior is pinned without a UI dependency.
