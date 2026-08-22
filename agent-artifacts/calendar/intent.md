# Intent: Gateway-owned family calendar

## Problem

The stack has no gateway-owned calendar. The only calendar surface today is four HA-backed tools (home_*_calendar_event) that require per-user Home Assistant configuration, are a poor integration experience, and confuse the model by overlapping with what should be a first-class family calendar.

## Desired Outcome

A gateway-owned, per-user plus family-shared calendar with a real storage engine, recurring events, tag/group filtering, a concise session-start nudge, an agent tool group, and web and mobile UIs.

## Scope — Included

- SQLite CalendarStore
- calendar-private and calendar-household resource classes
- bounded-RRULE recurrence with expand-on-query
- tags/group/importance/visibility fields
- role-based visibility filtering
- the calendar agent tool group
- session-start nudge on the memory seam
- REST API for UI
- web top-level route
- mobile drawer screen
- deprecation and hiding of the four HA calendar tools

## Success Signals

- Specified scenarios observable on local stack
- Private and household isolation enforced
- Child visibility filtering enforced across UI, tools, and nudge
- HA calendar tools absent from model tool list and catalog

## Scope — Excluded

- Push notification delivery and cron scheduler (interface only)
- HA to tablet sync bridge
- Full RFC 5545 recurrence
- Real multi-household isolation

## Constraints

- Reuse bun:sqlite and the user_version migration pattern
- Reuse capability-by-value and tier-permission seams
- Preserve prompt-cache stability
- Local-stack E2E only; no production mutation
