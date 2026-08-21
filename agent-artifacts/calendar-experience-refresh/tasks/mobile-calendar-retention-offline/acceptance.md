# Task Acceptance: Add adjacent prefetch, bounded retention, and offline recovery

## Deliverables

- Shared CalendarExperience asynchronously prefetches adjacent months, retains the twelve most recently viewed complete months, and exposes correct cached, stale, refreshing, and unavailable-offline states.

## Acceptance

- Visible data never waits for adjacent prefetch and prefetch failure never fails the active interval.
- No namespace retains more than twelve complete recently viewed months after transactional eviction.
- Offline cached navigation/filtering works; uncached navigation is specifically unavailable offline.
- Recovery and namespace transitions cannot leak old account/backend content.

## Boundary Proof

- Shared tests pin CAL-UX-009, CAL-UX-010 read behavior, CAL-UX-011 recovery, and CAL-UX-012 isolation.
- A delayed-prefetch test proves active cached/fresh content is uninterrupted.
- State vocabulary is checked against the exact mobile reference paths so later UI can render freshness without inventing native policy.
