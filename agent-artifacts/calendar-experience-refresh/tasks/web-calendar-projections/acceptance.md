# Task Acceptance: Build deterministic web calendar projections

## Deliverables

- The web client has tested Day, Week, Month, and Year projection utilities plus shared temporal helpers with correct navigation, filtering, density, accessibility, and Calendar V2 identity semantics.

## Acceptance

- Month has exactly 42 cells, Week seven dates, and Year complete valid dates.
- All supported filter combinations and interval navigation are deterministic and covered through one pure derivation seam.
- Editor/display temporal helpers share one implementation and preserve raw occurrence identity/all-day behavior.
- Event action identity and raw offset-bearing originalStart survive every projection.
- Models permit seven-column shrink-to-fit rendering without prescribing horizontal overflow.

## Boundary Proof

- Vitest tests pin CAL-UX-001, CAL-UX-002, CAL-UX-003, and CAL-UX-013 projection/temporal behavior.
- Tests prove editor and calendar display consume the same extracted temporal helpers.
- Review runs the exact web reference URL from `python3 -m http.server 8799 --directory sentient-design` and confirms the state vocabulary covers Day/Week/Month/Year, overflow, selected/today/outside states, with approved corrections.
