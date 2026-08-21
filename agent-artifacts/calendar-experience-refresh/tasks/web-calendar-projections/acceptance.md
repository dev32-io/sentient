# Task Acceptance: Build deterministic web calendar projections

## Deliverables

- The web client has tested Day, Week, Month, and Year projection utilities with correct temporal, navigation, filtering, density, and accessibility semantics.

## Acceptance

- Month has exactly 42 cells, Week seven dates, and Year complete valid dates.
- All supported filter combinations and interval navigation are deterministic and covered.
- Event action identity and timezone/all-day semantics survive every projection.
- Models permit seven-column shrink-to-fit rendering without prescribing horizontal overflow.

## Boundary Proof

- Vitest tests pin CAL-UX-001, CAL-UX-002, CAL-UX-003, and CAL-UX-013 projection behavior.
- Review runs the exact web reference URL from `python3 -m http.server 8799 --directory sentient-design` and confirms the state vocabulary covers Day/Week/Month/Year, overflow, selected/today/outside states, with the approved Year/domain corrections.
