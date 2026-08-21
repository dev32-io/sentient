# Task Acceptance: Implement the responsive web calendar shell and filters

## Deliverables

- The web calendar has reusable roomy and narrow workspace controls that preserve the canonical sidebar/canvas/floating-bar composition and keep Add Event and all supported filters reachable after Google-style sidebar collapse.

## Acceptance

- Roomy widths present the sidebar/canvas/floating-bar hierarchy of the exact reference.
- The typed canvas slot allows concurrent canvas implementation without a private coupling.
- At the 900px breakpoint, 768px and 390px retain reachable Add Event and filters without a generic mobile substitution, while 1024px remains roomy.
- Roomy and compact controls mutate the same state and every supported facet remains removable.
- Component-scoped CSS uses production tokens and all controls meet keyboard, focus, target-size, announcement, and reduced-motion requirements.

## Boundary Proof

- Vitest component tests cover canvas-slot composition, exact breakpoint/state continuity, supported filters, collapsed reachability, focus, labels, and reduced motion.
- Side-by-side screenshots use `sentient-design/design/web/calendar.html` at all four required viewports.
- Semantic evidence confirms Add Event, filter entry, active filters, and all four view controls remain reachable at 390x844.
