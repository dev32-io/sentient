# Task Brief: Build deterministic web calendar projections

## Contribution Goal

The web client has tested Day, Week, Month, and Year projection utilities with correct temporal, navigation, filtering, density, and accessibility semantics.

## Boundary — Included

- Pure TypeScript interval/navigation calculations
- Day/Week/Month/Year cell and agenda projections
- Supported local filter and facet derivation
- Event density, indicator, overflow, and accessible label models
- Stable tests for locale/timezone and responsive representation thresholds

## Required Work

- 1. Add focused projection modules under gateway/webui/src/components/calendar without coupling them to DOM size measurement or network I/O.
- 2. Generate Day focused agenda, Week seven-date model, Month 42 locale-aware cells with adjacent dates, and Year twelve complete months including days 29–31.
- 3. Implement Today and previous/next stepping by selected view; preserve an explicit anchor and selected date.
- 4. Project all-day dates without timezone movement and timed occurrences in device locale while preserving eventId, occurrenceId, originalStart, revision, and persisted timezone metadata for actions.
- 5. Apply local intersection filters for private/household/all, groups, tags, importance, and text; derive facets from the complete authorized interval and retain selected absent facets as removable controls.
- 6. Represent full pills, truncated pills, semantic dots, and +N overflow as presentation choices without discarding event access or full accessible names.
- 7. Add pure tests for leap years, locale week starts, DST, all-day stability, recurrence identities, dense days, filter intersection, absent facets, and active-view navigation.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-projections.

## Context

- The current gateway/webui calendar is a one-week CRUD list. This task creates pure TypeScript projection seams before visual integration.
- Exact visual and interaction references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Use their hierarchy and four-view behavior, while applying the reviewed narrow-web correction and rejecting prototype fixture semantics.
- Calendar V2 models in gateway/webui/src/services/calendar-api.ts remain temporal and identity authority.

## Boundary — Excluded

- REST fetching and pagination
- DOM layout, CSS, popovers, dialogs, or route integration
- Backend calendar changes
- Prototype member calendars, colors, place, reminders, or fixture events

## Interfaces and Dependencies

- Produces pure CalendarProjection models consumed by web calendar canvas and workspace tasks.
- Consumes CalendarOccurrence and CalendarEventV2-compatible values from gateway/webui/src/services/calendar-api.ts.
