# Task Acceptance: Implement complete web calendar loading and preference state

## Deliverables

- The web calendar has a tested controller that loads every page for an explicit authorized-all interval, preserves valid content through refresh/failure, owns selected filter state, and restores account/backend-scoped presentation preferences.

## Acceptance

- Every visible interval is complete before being marked fresh and explicitly requests authorized scope all.
- Failed/cancelled pagination does not erase prior complete content.
- Preferences survive revisits only within the same authenticated account/backend namespace.
- Filter/facet derivation has one pure owner and calendar-view.tsx remains untouched until assembly.
- Controller tests expose no user content in errors or logs.

## Boundary Proof

- Vitest tests cover CAL-UX-001 pagination, CAL-UX-002 preference restore, CAL-UX-003 filters/facets, and account-scoped preference isolation.
- Existing calendar API integration tests continue to pass.
- A source diff proves controller work is isolated to new files and does not modify calendar-view.tsx.
- Review compares controller states to the exact web reference interaction states while confirming no prototype data source was adopted.
