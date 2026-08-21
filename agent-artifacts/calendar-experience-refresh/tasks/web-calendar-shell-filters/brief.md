# Task Brief: Implement the responsive web calendar shell and filters

## Contribution Goal

The web calendar has reusable roomy and narrow workspace controls that preserve the canonical sidebar/canvas/floating-bar composition and keep Add Event and all supported filters reachable after Google-style sidebar collapse.

## Boundary — Included

- CalendarWorkspace shell with a typed canvas slot, roomy CalendarFilterSidebar, and narrow CalendarCompactControls
- DateNavigation and floating Day/Week/Month/Year view bar
- Scope/group/tag/importance/search controls and active-filter summary/removal
- Calendar-shell/filter component-scoped CSS using production tokens
- Responsive behavior, reduced motion, accessible filter popover semantics, tests, and exact viewport comparison

## Required Work

- 1. Build controlled shell, sidebar, compact controls, date navigation, and floating view-bar components in new calendar files; receive state/callbacks and perform no data fetching.
- 2. Define CalendarWorkspace's typed children/render-slot contract for the active canvas before implementation. Shell code owns layout around the slot and does not import Day/Week/Month/Year component internals.
- 3. Match the reference approximately 244px roomy sidebar, flexible canvas, Dusk paper hierarchy, Terra Add emphasis, heading/navigation rhythm, and floating translucent Dusk view bar using existing production tokens and reusable controls.
- 4. Collapse the sidebar at a pinned 900px breakpoint and re-home Add Event, filter entry, active-filter state, and clear/remove actions into compact in-flow controls or a viewport-bound anchored popover. 1024px remains roomy; 768px and 390px are collapsed.
- 5. Expose only supported private/household/all scopes, groups, tags, importance, and text search. Do not render member ownership, persona colors, Routines, places, or reminders from prototype content.
- 6. Keep selected facets removable when absent from the current interval and preserve identical controlled filter state between roomy and collapsed layouts.
- 7. Own shell/filter CSS in component-scoped files and use existing Dusk tokens only; do not edit canvas/preview/editor CSS or introduce page-local color constants.
- 8. Implement semantic selected/pressed states, keyboard traversal, labels, live result/view announcements, 44px effective targets, visible focus, Escape/outside dismissal where safe, focus restore, and reduced-motion behavior.
- 9. Add component tests for the canvas slot, exact breakpoint behavior, state continuity, supported/unsupported facets, compact-control reachability, view/date actions, focus restoration, and accessibility names.
- 10. Capture screenshots against the exact served web reference at 1440x1000, 1024x900, 768x900, and 390x844, explicitly proving the reviewed collapsed-sidebar correction at the two narrow sizes.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-shell-filters.

## Context

- Implement new shell/filter files without assembling calendar-view.tsx, so this task can run concurrently with canvas, preview, and editor work.
- Exact references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Serve with `python3 -m http.server 8799 --directory sentient-design` and inspect the web calendar at 1440x1000, 1024x900, 768x900, and 390x844.
- Use a deterministic 900px sidebar-collapse breakpoint: 1024x900 remains roomy and 768x900/390x844 use compact controls. The canvas remains the web calendar composition.
- CalendarWorkspace accepts the active calendar canvas through an explicit typed children/render-slot contract; this task must not import or assume private canvas implementation details.

## Boundary — Excluded

- Calendar canvas renderers or their CSS
- Event preview and editor overlays
- REST loading, preference persistence, or route assembly
- Generic redesign of gateway/webui Dialog or shell
- Modifying prototype files

## Interfaces and Dependencies

- Consumes controlled calendar view/filter/anchor state and callbacks from CalendarController.
- Produces a typed canvas-slot CalendarWorkspace, CalendarFilterSidebar, CalendarCompactControls, DateNavigation, and FloatingViewBar for final assembly.
