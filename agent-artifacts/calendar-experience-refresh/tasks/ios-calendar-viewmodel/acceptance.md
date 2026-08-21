# Task Acceptance: Make iOS CalendarViewModel a thin SKIE state adapter

## Deliverables

- iOS CalendarViewModel consumes shared CalendarExperience as a cancellable SKIE AsyncSequence and translates SwiftUI intents without duplicating database, network, filtering, pagination, prefetch, recurrence, or conflict policy.

## Acceptance

- No Swift calendar code fetches pages, filters events, schedules prefetch, evicts cache, builds recurrence policy, or accesses SQLite.
- Every exact mobile reference state for supported semantics is representable.
- Collection is cancellable, MainActor-safe, and cannot leak old-session emissions.
- Temporal and mutation identities pass through unchanged.

## Boundary Proof

- Swift tests cover thin mapping/forwarding for CAL-UX-001..013 native state seams.
- Test spies assert exact shared intents and no native repository/database calls.
- A state inventory is compared directly to the exact mobile reference files and includes approved complete-Year/offline/accessibility states.
