# Task Acceptance: Implement the accessible viewport-bound web event preview

## Deliverables

- Web event controls can open a canonical Dusk preview popover that remains reachable within every reviewed viewport and preserves complete focus/dismissal behavior.

## Acceptance

- Preview matches the exact reference surface for supported fields and never leaves the viewport at any reviewed size.
- Every open/close path restores the originating event and hidden content is inaccessible.
- Edge placement, internal scrolling, keyboard behavior, and reduced motion are deterministic and tested.

## Boundary Proof

- Vitest/jsdom tests cover positioning math, supported fields, focus, dismissal, and action identity.
- Screenshots compare production with `sentient-design/design/web/calendar.html` at 1440x1000 and 390x844 for center and edge anchors.
- Semantic DOM evidence proves no hidden preview controls remain in the accessibility tree.
