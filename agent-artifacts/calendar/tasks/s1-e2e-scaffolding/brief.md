# Task Brief: Calendar E2E scaffolding: disposable users, calendar cleanup, evidence capture

## Contribution Goal

Deliver reusable disposable-user and disposable-calendar-db setup/teardown helpers plus an evidence-capture convention so the harness-owned final E2E over the approved matrix can run each case on a clean local stack.

## Boundary — Included

- Disposable adult/child provisioning helper for the configured household (home)
- Per-user and per-household calendar.db isolation and cleanup (private + household)
- Evidence-capture directory convention for local-stack E2E
- Failure-safe teardown (cleanup runs on case failure)

## Required Work

- 1. Create gateway/src/calendar/e2e-helpers.ts with disposable adult/child provisioning for the configured household and per-user/household calendar.db isolation.
- 2. Implement failure-safe teardown that removes private and household calendar.db even when a case fails.
- 3. Define an evidence-capture directory convention for local-stack E2E; log ids/sizes, never content or secrets.
- 4. Add tests for provisioning, cleanup, and failure-safe teardown idempotency.
- 5. Run the helper tests.

## Integration Expectation

Deliver this contribution for integration in stage s1-e2e-scaffolding.

## Context

- Local E2E uses the real local stack, not mocks; agents/docs/e2e-testing-details.md requires resetting local state between cases rather than reusing a fixture session.
- Disposable-user lifecycle lives around gateway/src/admin/user-provisioner.ts and QA helpers (qa/web, qa/mobile/run-e2e.sh); the canonical fixture location for calendar E2E was unresolved in the seam map.
- The approved E2E matrix is binding verification context run by the harness; this task builds the reusable setup/teardown the harness final E2E consumes, not the cases themselves.
- Household identity is the single configured household id (home) for v1.

## Boundary — Excluded

- Authoring E2E cases (harness-owned final E2E)
- CalendarStore implementation

## Interfaces and Dependencies

- Produces: E2E setup/teardown helpers consumed by the harness final E2E; evidence directory convention.
- Consumes: existing admin user provisioning and local-stack helpers.
