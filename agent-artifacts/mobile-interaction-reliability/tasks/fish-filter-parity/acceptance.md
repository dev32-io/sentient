# Task Acceptance: Bring web-equivalent Fish catalog filters to mobile

## Deliverables

- Android and iOS Fish browsing provide the same title, language, gender, age, vibe, sort, active-state, and reset semantics as web while using the current mobile settings design language.

## Acceptance

- Mobile exposes title, language, gender, age, vibe, popular/recent/A–Z sort, active state, and clear/reset on both platforms
- Equivalent loaded entries and selections produce the same subset/order as web
- Title search remains debounced server-side; other facets and sort are client-side
- Mixed-case tags do not create duplicate facets or mismatches
- Reset restores default popular ordering and no active filters
- The UI follows current mobile settings design language and is fully agent-driveable

## Boundary Proof

- Common fixture tests pin web-equivalent bucketing/filter/sort semantics
- Android and iOS tests pin state transitions, paging interaction, and reset
- Stable controls and visible result titles support E2E-007
