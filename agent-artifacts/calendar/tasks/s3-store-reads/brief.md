# Task Brief: CalendarStore get/list/filter with visibility and event-tz recurrence expansion

## Contribution Goal

Implement CalendarStore get and list/filter that expand recurring events via expandRecurrence in the event's own timezone, apply EXDATE/exception overrides, filter by date range/group/tags/importance, apply role-based visibility filtering (child/guest omit adults; adult/admin see them), and return tz-aware values.

## Boundary — Included

- Implement get(id) returning a base event with role-based visibility filtering
- Implement list(filter) expanding recurring events via expandRecurrence in the event's tz, applying EXDATE skips and exception overrides
- Filter by date range, group, tags, and importance
- Role-based visibility filtering omitting adults events for non-adult roles (child/guest)
- Typed get/list results including not-found, returning tz-aware values (UTC instant + event tz id, or all-day date)

## Required Work

- 1. Implement get(id) in calendar-store.ts returning the base event, omitting visibility:adults rows when isAdult(cap.role) is false.
- 2. Implement list(filter) selecting base events overlapping [start, end] and expanding recurring events via expandRecurrence in the event's tz, applying EXDATE skips and exception overrides.
- 3. Apply group, tags, and importance filters and role-based visibility filtering.
- 4. Return typed not-found for absent ids; return tz-aware values (UTC instant + event tz id, or all-day date).
- 5. Add tests for COUNT=10 BYDAY=MO,FR expansion, EXDATE/exception application, each filter dimension, child/guest adults-event omission, admin/adult visibility, event-tz expansion, and not-found.
- 6. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s3-store-reads.

## Context

- CalendarStore writes exist from s3-store-writes; expandRecurrence exists from s2-expand-recurrence.
- Role-based visibility is filtered at the store query layer via the structured visibility field (not an @adults suffix); isAdult(role)=adult|admin sees adults events; child/guest omit.
- expandRecurrence runs in the event's own tz (default household tz) over UTC-stored instants; the store read path applies EXDATE/exception overrides and returns tz-aware values.
- The store never needs a user current tz; that belongs to the future scheduler.

## Boundary — Excluded

- Create/update/delete (s3-store-writes)
- User-current-tz / scheduler (future)

## Interfaces and Dependencies

- Produces: CalendarStore get/list with expansion and visibility filtering consumed by tools, nudge, and REST.
- Consumes: expandRecurrence from s2-expand-recurrence; CalendarStore writes from s3-store-writes; isAdult and domain types from s1-domain-contracts.
