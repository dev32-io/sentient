# Task Acceptance: Implement the observable shared calendar store

## Deliverables

- shared/mobile-data can atomically persist and observe complete authorized month snapshots and account/backend-scoped preferences through a narrow CalendarCacheStore.

## Acceptance

- One completed transaction produces one coherent observable snapshot and failed transactions preserve the previous complete snapshot.
- Rows and preferences cannot cross account/backend namespaces.
- Serialization round-trips current Calendar V2 identities and temporal data without moving all-day dates or recurrence anchors.
- Store APIs remain commonMain-safe and generated SQLDelight types remain internal.

## Boundary Proof

- SQLDelight-backed tests cover atomicity, rollback, observation, close/reopen, decode failure, and namespace purge.
- A preference round-trip proves all supported controls from the exact mobile reference can be restored without unsupported prototype fields.
- Sanitized logging tests or assertions prove event content and filter text are absent.
