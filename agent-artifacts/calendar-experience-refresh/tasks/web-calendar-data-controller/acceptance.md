# Task Acceptance: Implement complete web calendar loading and preference state

## Deliverables

- The web calendar has a tested controller that loads every page for an explicit authorized-all interval, preserves valid content through refresh/failure, applies local filters, and restores account/backend-scoped presentation preferences.

## Acceptance

- Every visible interval is complete before being marked fresh and explicitly requests authorized scope all.
- Failed/cancelled pagination does not erase prior complete content.
- Preferences survive revisits only within the same authenticated account/backend namespace.
- Controller tests expose no user content in errors or logs.

## Boundary Proof

- Vitest tests cover CAL-UX-001 pagination, CAL-UX-002 preference restore, CAL-UX-003 filters/facets, and account isolation from CAL-UX-007/012.
- Existing calendar API integration tests continue to pass.
- Review compares controller states to the exact web reference interaction states while confirming no prototype data source was adopted.
