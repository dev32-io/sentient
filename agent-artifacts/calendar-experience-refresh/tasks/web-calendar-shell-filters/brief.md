# Task Brief: Implement the responsive web calendar shell and filters

## Contribution Goal

The web calendar has reusable roomy and narrow workspace controls that preserve the canonical sidebar/canvas/floating-bar composition and keep Add Event and all supported filters reachable after Google-style sidebar collapse.

## Boundary — Included

- CalendarWorkspace shell, roomy CalendarFilterSidebar, and narrow CalendarCompactControls
- DateNavigation and floating Day/Week/Month/Year view bar
- Scope/group/tag/importance/search controls and active-filter summary/removal
- Responsive CSS, token reuse, reduced motion, and accessible filter popover semantics
- Component tests and exact viewport comparison evidence

## Required Work

- 1. Build controlled shell, sidebar, compact controls, date navigation, and floating view-bar components in new calendar files; receive state/callbacks and perform no data fetching.
- 2. Match the reference approximately 244px roomy sidebar, flexible canvas, Dusk paper hierarchy, Terra Add emphasis, heading/navigation rhythm, and floating translucent Dusk view bar using existing production tokens and reusable controls.
- 3. Collapse the sidebar Google-style at the reviewed breakpoint and re-home Add Event, filter entry, active-filter state, and clear/remove actions into compact in-flow controls or a viewport-bound anchored popover.
- 4. Expose only supported private/household/all scopes, groups, tags, importance, and text search. Do not render member ownership, persona colors, Routines, places, or reminders from prototype content.
- 5. Keep selected facets removable when absent from the current interval and preserve identical controlled filter state between roomy and collapsed layouts.
- 6. Implement semantic selected/pressed states, keyboard traversal, labels, live result/view announcements, 44px effective targets, visible focus, Escape/outside dismissal where safe, focus restore, and reduced-motion behavior.
- 7. Add component tests for breakpoint-independent state continuity, supported/unsupported facets, compact-control reachability, view/date actions, focus restoration, and accessibility names.
- 8. Capture screenshots against the exact served web reference at 1440x1000, 1024x900, 768x900, and 390x844, explicitly proving the reviewed collapsed-sidebar correction at the two narrow sizes.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-shell-filters.

## Context

- Implement new shell/filter files without assembling calendar-view.tsx, so this task can run concurrently with canvas, preview, and editor work.
- Exact references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Serve with `python3 -m http.server 8799 --directory sentient-design` and inspect the web calendar at 1440x1000, 1024x900, 768x900, and 390x844.
- The reviewed responsive correction is binding: the reference sidebar may collapse, but Add Event and active filters must move into compact in-flow controls or an anchored filter popover; the canvas does not become the native mobile layout.

## Boundary — Excluded

- Calendar canvas renderers
- Event preview and editor overlays
- REST loading, preference persistence, or route assembly
- Generic redesign of gateway/webui Dialog or shell
- Modifying prototype files

## Interfaces and Dependencies

- Consumes controlled calendar view/filter/anchor state and callbacks from CalendarController.
- Produces CalendarWorkspace, CalendarFilterSidebar, CalendarCompactControls, DateNavigation, and FloatingViewBar for final assembly.
