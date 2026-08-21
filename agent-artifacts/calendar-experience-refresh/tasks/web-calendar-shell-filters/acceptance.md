# Task Acceptance: Implement the responsive web calendar shell and filters

## Deliverables

- The web calendar has reusable roomy and narrow workspace controls that preserve the canonical sidebar/canvas/floating-bar composition and keep Add Event and all supported filters reachable after Google-style sidebar collapse.

## Acceptance

- Roomy widths present the sidebar/canvas/floating-bar hierarchy of the exact reference.
- At 768px and 390px Add Event and every active filter remain reachable after sidebar collapse without a generic mobile substitution.
- Roomy and compact controls mutate the same state and every supported facet remains removable.
- All controls meet keyboard, focus, target-size, announcement, and reduced-motion requirements.

## Boundary Proof

- Vitest component tests cover state continuity, supported filters, collapsed reachability, focus, labels, and reduced motion.
- Side-by-side screenshots use `sentient-design/design/web/calendar.html` at all four required viewports.
- Semantic evidence confirms Add Event, filter entry, active filters, and all four view controls remain reachable at 390x844.
