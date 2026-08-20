# Task Acceptance: Build the fresh revisioned calendar V2 persistence boundary

## Deliverables

- Capability-held calendar stores provide fresh V2 storage, revision compare-and-swap, child-state persistence, and atomic transaction primitives without interpreting legacy calendar data.

## Acceptance

- Fresh private and household stores create only the V2 schema at <cap.rootPath>/calendar-v2/calendar.db.
- Old V1 calendar files are untouched and never read.
- Revision compare-and-swap rejects stale writes without changing any row.
- Injected failure rolls back base, successor, exception, exclusion, tag, and revision changes atomically.
- Child/guest household writes and adults-hidden public reads remain denied without leakage.

## Boundary Proof

- Calendar store contract tests cover fresh schema, epoch isolation, revision CAS, transaction rollback, rich JSON validation, capability roots, role gates, visibility, and close semantics.
- E2E helper tests prove disposable cleanup targets only the V2 paths.
