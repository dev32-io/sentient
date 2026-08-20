# Task Acceptance: Implement effective occurrences and recurrence split arithmetic

## Deliverables

- The recurrence engine can project rich effective occurrences and compute safe COUNT/UNTIL series partitions from stable original slots.

## Acceptance

- Moving or richly overriding an occurrence never changes its original identity.
- COUNT and UNTIL splits have no duplicate or missing generated slots and count hidden/cancelled slots correctly.
- An incompatible successor rule reports recurrence_conflict without proposing partial child migration.
- DST expansion preserves the event timezone wall-clock anchor.

## Boundary Proof

- expand-recurrence and recurrence-splitter tests cover the approved COUNT, UNTIL, DST, override, exclusion, and conflict cases.
- Pure tests demonstrate split arithmetic without reading filtered occurrence lists.
