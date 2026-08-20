# Task Acceptance: Expose calendar V2 paging and mutations through mobile-data

## Deliverables

- Shared mobile repositories and use cases expose typed V2 reads and recurring mutations while remaining stateless at the repository layer and requiring no Android/iOS screen changes.

## Acceptance

- Repository mutate exposes all three recurrence scopes and preserves typed failures.
- One V2 list request returns mixed timed/all-day events and nextCursor; listBoth no longer issues two network requests.
- Current Android/iOS-facing convenience interfaces continue to compile without screen changes.
- StateFlow and SentientResult behavior remains exhaustive and repositories remain stateless.
- No calendar payload or diagnostic cause is logged or placed into UI messages.

## Boundary Proof

- CalendarDataTest covers V2 list, cursor, mutation, convenience mapping, errors, state transitions, DI exports, and call counts.
- Android/shared compile proves current platform consumers remain source-compatible.
- Sanitized client/repository integration covers mobile-data portions of E2E-015/E2E-016.
