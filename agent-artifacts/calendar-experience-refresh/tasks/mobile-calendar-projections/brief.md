# Task Brief: Build shared mobile calendar projections and filter semantics

## Contribution Goal

shared/mobile-data can deterministically project complete authorized occurrences into accessible Day, Week, Month, and Year models and apply supported local filters without native duplication.

## Boundary — Included

- Pure commonMain Day/Week/Month/Year interval and cell projection
- Chronological agenda grouping and stable occurrence identity
- Local intersection filtering for private/household/all, groups, tags, importance, and text search
- Preference/state models for view, anchor/selected date, active facets, and locale/timezone inputs
- Overflow/indicator semantics needed by compact mobile rendering

## Required Work

- 1. Introduce pure shared projection types and functions in shared/mobile-data that accept a complete unfiltered authorized occurrence set, locale/week-start/timezone inputs, anchor date, selected view, and supported filters.
- 2. Generate Day as a focused chronological agenda; Week as seven equal dates plus chronological events; Month as 42 locale-aware cells including adjacent dates; and Year as twelve complete month summaries including days 29–31.
- 3. Preserve all-day dates as date identities while formatting timed events in the device locale without rewriting their persisted event timezone or recurring originalStart anchor.
- 4. Apply filter intersection locally for supported calendar scopes, groups, tags, importance, and text. Derive facet options only from authorized unfiltered data and keep selected absent facets removable.
- 5. Model selected, today, outside-month, all-day/timed, up-to-three-indicator, +N overflow, full-date accessibility labels, and stable event-action identity without embedding platform UI types.
- 6. Encode interaction transitions: Month date selection requests Day; Week date selection keeps Week; Year month selection produces an intentional Month navigation target; Today and previous/next step by active view.
- 7. Add deterministic tests for leap years, locale week starts, DST boundaries, all-day stability, complete Year dates, dense-day overflow, filter intersections, absent selected facets, and navigation transitions.

## Integration Expectation

Deliver this contribution for integration in stage mobile-calendar-projections.

## Context

- Android and iOS must consume the same shared calendar projection and filter behavior. Native code remains responsible only for rendering and platform controls.
- Canonical visual/interaction inputs are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Use their four-view hierarchy and selection behavior; reject their fixed dates, persona calendars, reminder/location fields, sample colors, and 28-day Year defect.
- Calendar V2 temporal, recurrence, scope, visibility, identity, and authorization contracts remain authoritative.

## Boundary — Excluded

- SQLDelight storage and observable queries
- Remote calls, pagination, revalidation, prefetch, LRU, and mutation side effects
- Compose or SwiftUI components
- Prototype member ownership, colors, reminders, place, or Routines semantics

## Interfaces and Dependencies

- Produces platform-neutral CalendarExperience projection/state types consumed by the shared coordinator and native ViewModels.
- Consumes current Calendar V2 effective occurrences and explicit locale/timezone inputs.
