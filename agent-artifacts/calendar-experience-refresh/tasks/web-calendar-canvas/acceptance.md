# Task Acceptance: Implement responsive web Day, Week, Month, and Year canvases

## Deliverables

- Reusable web calendar canvas components render all four views with the exact approved Dusk hierarchy and shrink-to-fit behavior, without owning network or mutation state.

## Acceptance

- All four views match the exact reference hierarchy and Dusk treatment for supported semantics.
- Canvas components satisfy the public workspace slot without private shell coupling.
- Month and Week retain seven usable equal columns at 390x844 and never create page-level horizontal overflow.
- Dense events remain discoverable and accessible after visual compaction.
- Year includes every valid date through 29–31 and all controls have visible focus and semantic labels.

## Boundary Proof

- Vitest component tests cover slot compatibility, renderer semantics, overflow, focusability, and all four views.
- Screenshots compare production and `sentient-design/design/web/calendar.html` at 1440x1000, 1024x900, 768x900, and 390x844 for Day/Week/Month/Year.
- Evidence explicitly verifies scrollWidth does not exceed viewport width at 768px and 390px.
