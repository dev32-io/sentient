# Task Acceptance: Add atomic this-and-following series updates

## Deliverables

- Updating one recurring slot and all following slots atomically creates a correct successor segment for COUNT- and UNTIL-bounded recurrences without data loss.

## Acceptance

- COUNT and UNTIL splits preserve exactly the intended generated slots with no overlap or gap.
- Compatible future exceptions/exclusions move to the successor once; incompatible ones cause atomic recurrence_conflict.
- The selected occurrence and future segment receive requested changes without changing past effective occurrences.
- First-slot update persists no empty prefix.
- Stale revision, abort, or storage failure leaves prefix, successor, child state, and revisions unchanged.

## Boundary Proof

- Mutation tests inspect both persisted segments and covering expansion output for COUNT and UNTIL scenarios.
- Fault-injection and before/after equivalence prove recurrence-conflict and transaction rollback.
