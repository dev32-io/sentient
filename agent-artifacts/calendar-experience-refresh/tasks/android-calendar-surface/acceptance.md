# Task Acceptance: Build the Android calendar views, filters, agenda, and floating controls

## Deliverables

- Reusable controlled Compose components implement the exact approved mobile calendar shell, horizontal filters, four compact views, agenda rows, and floating selector without owning I/O or overlay mutation policy.

## Acceptance

- At 390x844 and 430x932 the components match the exact mobile reference geometry/hierarchy for supported states.
- Month/Week/Day/Year selection semantics, complete dates, agenda order, and filter controls are correct.
- All targets, labels, scaling, insets, scrolling clearance, and reduced motion meet the approved mobile contract.
- No I/O or duplicated shared calendar policy exists in composables.

## Boundary Proof

- Compose previews and review notes compare all four views at 390x844 and 430x932 with `sentient-design/design/mobile/calendar.html`.
- JVM/pure tests cover interaction callbacks, labels, view completeness, and filter state; Android build validates Compose integration.
- Proof explicitly checks 58dp top bar, 16dp inset, 44dp targets, 46dp view controls, ~64dp rows, 42 Month cells, complete Year, and floating-bar clearance.
