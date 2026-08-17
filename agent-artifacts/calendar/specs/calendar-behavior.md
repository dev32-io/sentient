# Calendar Behavior

## Context

Defines the gateway-owned family calendar from the user, agent, and UI perspective. Replaces the HA-backed calendar tool surface with first-class gateway-owned storage.

## Required Behaviors

- Create, read, update, and delete events in private or household scope
- Expand recurring events into occurrences within a bounded [start, end] window
- Filter events by date range, scope, group, tags, and importance
- Apply role-based visibility filtering at the query layer (children omit adults events)
- Reject household writes from non-adult roles at the store layer (fail-fast, no prompt)
- Compose a nudge once per session: today's events plus this week's important or pinned, hard-capped, with an '...and N more' overflow line
- Expose calendar tools with read to allow, write to ask, delete to confirm tier defaults
- Serve a REST API over the same store for web and mobile UIs
- Hide the four HA home_*_calendar_event tools entirely

## Acceptance Criteria

- **AC-001:** A user's private events are path-isolated from every other user; household events resolve to <sharedDataRoot>/<householdId>/calendar/calendar.db
- **AC-002:** A calendar-private capability cannot open a household store and vice versa (resource-class gate)
- **AC-003:** A child cannot observe visibility:adults events through the UI, the agent tools, or the nudge
- **AC-004:** A child agent call to create or update a household event returns a typed failure without emitting permission.request
- **AC-005:** A recurring event FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10 yields exactly 10 occurrences in a covering window; EXDATE removes a named instance; an exceptions-table override replaces one instance
- **AC-006:** An all-day event and a DST-boundary timed event expand correctly in the user's timezone
- **AC-007:** The nudge never exceeds its cap; an empty calendar renders no nudge block
- **AC-008:** The four HA calendar tools are absent from the provider output, /api/v1/mcp-catalog, and the role-default template

## Domain Language

- CalendarEvent: a durable record (single or recurring base) owned by a scope
- Occurrence: a concrete instance produced by expanding a recurring event within a query window; not persisted
- Scope: private (user-isolated) or household (family-shared), determined by capability resource class
- Visibility: everyone or adults; a content-level field filtered by cap.role at the store query layer
- Importance: normal, important, or pinned; drives nudge selection
- Group: a singular filtering facet on an event; Tags: a set of filtering facets
- RRULE: bounded subset (FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT or UNTIL, BYDAY for weekly); stored as raw string; EXDATE plus an exceptions table for overrides
- Nudge: the session-start calendar summary appended to the system prompt
- CalendarStore: the capability-held resource handle over calendar/calendar.db
- calendar tool group: the agent-facing product tool group

## Actors

- Adult
- Child
- Guest (existing roles)
- The agent (model) operating the calendar tool group
- The user via web or mobile UI

## Scenarios

- Adult creates a one-off private event via the agent and sees it in the web calendar
- Adult creates a weekly recurring household event that expands in the week view and in the nudge
- Child opens the family calendar and adults-only events are hidden
- Child agent attempts a family create and receives a fail-fast typed error with no permission prompt
- Guest agent attempts calendar_create and is role-denied at the broker
- Long session: the nudge today drifts and the agent calls calendar_list for fresh data
- Empty calendar at session start: no nudge block is rendered
- Recurring event with EXDATE and a single-instance override
- Existing user receives a fresh calendar.db on first calendar access

## Edge Cases

- Recurring event with EXDATE and a single-instance override via the exceptions table
- All-day event and a DST-boundary timed event
- Long session: nudge today goes stale; agent calls calendar_list for fresh data
- Empty calendar at session start: nudge omitted entirely
- Existing user gets a fresh calendar.db on first calendar access (migration from v0)
- Orphaned profile.tools.permissions entries for removed HA calendar tools are harmless

## Out of Scope

- Push notification delivery
- Cron scheduler
- HA sync bridge
- Full RFC 5545 recurrence
- Multi-household identity isolation
