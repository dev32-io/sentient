# Task Acceptance: Calendar E2E scaffolding: disposable users, calendar cleanup, evidence capture

## Deliverables

- Deliver reusable disposable-user and disposable-calendar-db setup/teardown helpers plus an evidence-capture convention so the harness-owned final E2E over the approved matrix can run each case on a clean local stack.

## Acceptance

- A disposable adult and child in the configured household can be provisioned and torn down with their private and household calendar.db removed
- Cleanup runs even when a case fails mid-way
- No production mutation and no secrets/content logged

## Boundary Proof

- Helper tests cover provisioning, calendar.db cleanup, and failure-safe teardown idempotency
