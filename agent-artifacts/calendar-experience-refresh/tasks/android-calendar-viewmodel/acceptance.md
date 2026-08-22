# Task Acceptance: Make Android CalendarViewModel a thin shared-state adapter

## Deliverables

- Android CalendarViewModel lifecycle-collects shared CalendarExperience StateFlow and translates Compose intents without duplicating database, fetch, filtering, pagination, prefetch, recurrence, or conflict policy.

## Acceptance

- No Android calendar code fetches pages, filters events, schedules prefetch, evicts cache, builds recurrence policy, or writes SQL directly.
- Every exact mobile reference state for supported semantics is representable in CalendarUiState.
- Lifecycle cancellation and route recreation do not close or duplicate the shared experience.
- Temporal and mutation identities pass through unchanged.

## Boundary Proof

- JVM tests cover thin mapping/forwarding for CAL-UX-001..013 native state seams.
- Test doubles assert no duplicate repository/database orchestration and exact shared intents.
- A state inventory is compared to the exact mobile reference files and includes all approved corrections/offline states.
