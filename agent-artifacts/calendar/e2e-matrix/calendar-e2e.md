# Calendar E2e

## Cases

### E2E-001 — Adult creates a single private event via the agent

**Classification:** golden-path

#### Setup

- Disposable adult user on local stack

#### Actions

- Agent calls calendar_create on private scope
- Open the web calendar route

#### Expected Outcomes

- Event persists in the user private calendar.db
- Event appears in the web calendar

#### Evidence

- Persisted calendar.db row
- Web calendar list includes the event

#### Safety

- Drop disposable user and calendar.db

### E2E-002 — Recurring household event expands in week view and nudge

**Classification:** golden-path

#### Setup

- Disposable adult user on local stack

#### Actions

- Agent calls calendar_create with FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10 on household scope
- Open the week view
- Read the session-start nudge

#### Expected Outcomes

- Exactly 10 occurrences render in the week view
- The nudge includes today's occurrence

#### Evidence

- Expansion output shows 10 occurrences
- Nudge text includes today's instance

#### Safety

- Drop disposable calendar.db

### E2E-003 — Child cannot see adults-only family events

**Classification:** edge

#### Setup

- Disposable adult and child in the same household

#### Actions

- Adult creates a visibility:adults household event
- Child opens the calendar
- Start a child session and read the nudge

#### Expected Outcomes

- Event is hidden from the child UI
- Event is hidden from the child agent tools
- Event is hidden from the child nudge

#### Evidence

- Child query result omits the event
- Child nudge omits the event

#### Safety

- Drop disposable users

### E2E-004 — Child family write fails fast without a permission prompt

**Classification:** failure

#### Setup

- Disposable child user in a household

#### Actions

- Child agent calls calendar_create on household scope

#### Expected Outcomes

- Typed tool failure returned
- No permission.request emitted

#### Evidence

- Typed tool failure result
- No permission.request frame emitted

#### Safety

- Drop disposable user

### E2E-005 — Nudge is capped with an overflow summary

**Classification:** golden-path

#### Setup

- Disposable adult with more today and important events than the nudge cap

#### Actions

- Start a session

#### Expected Outcomes

- Nudge is at or below the cap
- Nudge ends with an '...and N more' line
- Today and important or pinned events are kept

#### Evidence

- Nudge text
- Nudge length at or below cap

#### Safety

- Drop disposable calendar.db

### E2E-006 — Empty calendar omits the nudge

**Classification:** edge

#### Setup

- Disposable adult with no calendar events

#### Actions

- Start a session

#### Expected Outcomes

- No calendar nudge block is rendered in the system prompt

#### Evidence

- System prompt assembly shows no calendar nudge block

#### Safety

- Drop disposable calendar.db

### E2E-007 — Recurring EXDATE skip plus exception override

**Classification:** recovery

#### Setup

- Disposable adult on local stack

#### Actions

- Create a weekly recurring event
- Add an EXDATE for one instance
- Override one instance via the exceptions table
- Expand over a covering window

#### Expected Outcomes

- The EXDATE instance is absent
- The overridden instance reflects the override

#### Evidence

- Expansion output reflects the override and the skip

#### Safety

- Drop disposable calendar.db

### E2E-008 — Web top-level route lists and creates events over REST

**Classification:** golden-path

#### Setup

- Disposable adult user, web client on local stack

#### Actions

- Open the calendar route
- Create an event via the UI

#### Expected Outcomes

- Event persists via REST
- Event lists in the web UI

#### Evidence

- REST response
- Web calendar render

#### Safety

- Drop disposable calendar.db

### E2E-009 — Mobile drawer calendar screen lists events

**Classification:** golden-path

#### Setup

- Disposable adult user, mobile client on local stack

#### Actions

- Open the calendar from the drawer
- List events

#### Expected Outcomes

- Events render on the mobile calendar screen

#### Evidence

- Mobile screen state shows events

#### Safety

- Drop disposable calendar.db

### E2E-010 — Guest denied create at the broker

**Classification:** failure

#### Setup

- Disposable guest user on local stack

#### Actions

- Guest agent calls calendar_create

#### Expected Outcomes

- Role-denied at the broker before any store execution

#### Evidence

- Broker decision denies before execution

#### Safety

- Drop disposable user

### E2E-011 — HA calendar tools absent after deprecation

**Classification:** edge

#### Setup

- Local stack running

#### Actions

- Query the home provider output
- Query /api/v1/mcp-catalog

#### Expected Outcomes

- None of home_get_calendar_events, home_create_calendar_event, home_update_calendar_event, home_remove_calendar_event are present

#### Evidence

- Provider output and catalog dump show none of the four tools

#### Safety

- No disposable state needed; local stack only

### E2E-012 — DST-boundary timed event expands correctly

**Classification:** edge

#### Setup

- Disposable adult with timezone set to a DST-observing zone

#### Actions

- Create a timed event spanning a DST boundary
- Expand over the boundary in the user timezone

#### Expected Outcomes

- Occurrence times are correct in the user timezone

#### Evidence

- Expansion output shows correct occurrence times

#### Safety

- Drop disposable calendar.db

## Scope

- Touched calendar store, recurrence, visibility, tool permission, nudge, web and mobile UI, and HA calendar tool deprecation paths

## Safety

- Local stack only
- Disposable users and calendar databases
- No production mutation
- No real household data
- No secrets logged
