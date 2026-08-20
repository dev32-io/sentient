# Task Acceptance: Add atomic this-and-following series deletion

## Deliverables

- Deleting a selected recurring slot and all following slots atomically truncates the existing segment while preserving only earlier occurrences and creating no successor.

## Acceptance

- A middle this-and-following delete retains every earlier generated slot and removes the selected and all future slots.
- No successor is ever created.
- A first-slot delete removes the selected segment entirely.
- Surviving prefix revision increments once; stale revision or failure changes nothing.

## Boundary Proof

- Mutation tests inspect storage and covering occurrence lists for middle and first-slot deletion.
- Fault injection proves no partial prefix/child changes.
