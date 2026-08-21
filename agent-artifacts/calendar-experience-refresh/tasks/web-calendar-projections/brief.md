# Task Brief: Build deterministic web calendar projections

## Contribution Goal

The web client has tested Day, Week, Month, and Year projection utilities plus shared temporal helpers with correct navigation, filtering, density, accessibility, and Calendar V2 identity semantics.

## Boundary — Included

- Pure TypeScript interval/navigation calculations
- Shared calendar-time input/format/parse helpers extracted from calendar-view.tsx
- Day/Week/Month/Year cell and agenda projections
- Supported local filter and facet derivation
- Event density, indicator, overflow, and accessible label models
- Stable tests for locale/timezone and responsive representation thresholds

## Required Work

- 1. Add focused projection modules and a shared `calendar-time.ts` under gateway/webui/src/components/calendar without coupling them to DOM size measurement or network I/O. Move the existing browser timezone, input formatting/parsing, all-day, and display formatting behavior out of calendar-view.tsx so editor and assembly import one implementation.
- 2. Generate Day focused agenda, Week seven-date model, Month 42 locale-aware cells with adjacent dates, and Year twelve complete months including days 29–31.
- 3. Implement Today and previous/next stepping by selected view; preserve an explicit anchor and selected date.
- 4. Project all-day dates without timezone movement and timed occurrences in device locale while preserving eventId, occurrenceId, raw RFC3339 offset-bearing originalStart, revision, and scope for actions. Do not infer a named timezone from the compatibility timeZoneId field.
- 5. Own the pure `(complete authorized occurrences, selected filters) -> filtered projection and derived facets` functions for private/household/all, groups, tags, importance, and text. The controller owns selected filter state and invokes these functions rather than duplicating derivation.
- 6. Represent full pills, truncated pills, semantic dots, and +N overflow as presentation choices without discarding event access or full accessible names.
- 7. Add pure tests for leap years, locale week starts, DST/offset inputs, all-day stability, recurrence identities, dense days, filter intersection, absent facets, active-view navigation, and the extracted editor/display temporal helpers.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-projections.

## Context

- The current gateway/webui calendar is a one-week CRUD list, and its reusable browserTimeZone/format/parse helpers still live in calendar-view.tsx. This task creates pure shared seams before editor and assembly work.
- Exact visual and interaction references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. Use their hierarchy and four-view behavior, while applying the reviewed narrow-web correction and rejecting prototype fixture semantics.
- Calendar V2 models and raw RFC3339 offset-bearing values in gateway/webui/src/services/calendar-api.ts remain temporal and identity authority; do not treat the compatibility timeZoneId value as an IANA zone.

## Boundary — Excluded

- REST fetching and pagination
- DOM layout, CSS, popovers, dialogs, or route integration
- Backend calendar changes
- Prototype member calendars, colors, place, reminders, or fixture events

## Interfaces and Dependencies

- Produces pure CalendarProjection/filter/facet models and shared calendar-time helpers consumed by web controller, canvas, editor, and assembly tasks.
- Consumes CalendarOccurrence and CalendarEventV2-compatible values from gateway/webui/src/services/calendar-api.ts while preserving raw wire temporal strings.
