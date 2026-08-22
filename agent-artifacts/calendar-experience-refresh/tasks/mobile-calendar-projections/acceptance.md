# Task Acceptance: Build shared mobile calendar projections and filter semantics

## Deliverables

- shared/mobile-data can deterministically project complete authorized occurrences into accessible Day, Week, Month, and Year models and apply supported local filters without native duplication.

## Acceptance

- All four projections are deterministic, complete, and equivalent on Android and iOS.
- Month always has 42 cells; Week always has seven dates; Year contains all valid dates including 29–31.
- All-day and timed recurrence behavior survives timezone and DST cases.
- Unsupported prototype semantics cannot appear in projection types or filters.

## Boundary Proof

- Pure common tests cover CAL-UX view, filter, temporal, and overflow contracts at stable data boundaries.
- Tests explicitly pin Month-to-Day, Week anchor retention, Year-to-Month navigation, and active-view interval stepping.
- A review compares produced state vocabulary to the exact mobile reference paths and documents only the approved complete-Year/domain corrections.
