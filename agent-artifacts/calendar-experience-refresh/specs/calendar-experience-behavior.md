# Cross-platform calendar experience behavior

## Context

Defines the user-visible web, Android, and iOS family calendar refresh over the existing calendar V2 domain. design-ref/calendar.png is the canonical visual reference. The reference's member names and routines/reminders rows are visual inspiration only; the shipped filters represent supported calendar scopes, groups, tags, and importance rather than fabricating member ownership or scheduler sources.

## Required Behaviors

- Calendar opens on the current month and explicitly queries all authorized scopes rather than inheriting the private default.
- Users can navigate previous and next months, return to Today, select a date, and use the mini-calendar.
- Month view displays locale-aware week structure, adjacent dates, current and selected day states, timed and all-day event pills, and a +N more overflow action.
- On compact mobile layouts, selecting a day exposes a readable selected-day agenda beneath or beside the compact month.
- Agenda view lists the visible month's events chronologically and grouped by date, preserving the selected month and date when switching views.
- The desktop web layout follows design-ref/calendar.png with a persistent left rail; narrow web and mobile layouts expose filters through an accessible drawer or sheet.
- The filter surface represents Calendars, Groups, Tags, Importance, and text search. Filters apply to an unfiltered visible-range data set.
- Filter and view preferences persist locally across visits, remain account- and backend-scoped, and remain removable when a selected facet has no events in the current month.
- Every bounded continuation page needed for the visible month is consumed; a first page is never presented as the complete month.
- Add Event opens a reusable web dialog or native mobile sheet with title, description, all-day or timed start/end, timezone-preserving timing, scope, visibility, importance, group, tags, and supported structured recurrence.
- Inspecting an event exposes its effective occurrence details and available actions without leaking hidden metadata.
- Editing or deleting a recurring occurrence requires an explicit applicable mutation scope and carries event scope, revision, and original start where required.
- Stale revision conflicts never silently overwrite newer data; the UI explains the conflict and supports reread and review.
- Deletion requires confirmation and reports success or typed failure without optimistic false success.
- Unauthorized and adults-only events remain absent. Mutation controls reflect role restrictions without revealing hidden events or counts.
- Network and API failures preserve already displayed valid data and expose actionable retry or freshness status instead of replacing content with a blank loading state.
- All-day dates remain fixed while timed events render in device locale and preserve their persisted event-timezone recurrence anchor.
- Accessibility includes semantic controls, keyboard and focus handling, screen-reader labels, Dynamic Type or font scaling, minimum touch targets, contrast, and reduced-motion compatibility.
- On mobile, opening Calendar causes the shared KMP layer to load persisted preferences and cached visible-month data, emit available cache immediately, asynchronously revalidate remotely, and prefetch previous and next months without blocking the visible month.
- Mobile retains up to twelve recently viewed months with bounded least-recently-used eviction. Cached months support offline navigation and filtering.
- Mobile remote success atomically updates protected cache and naturally emits fresh shared state; network failure retains cached events and updates only freshness or offline metadata.
- An uncached mobile month opened offline has a specific unavailable-offline state. Save and delete actions are unavailable offline with a clear connection-required explanation and no queued mutation.
- Mobile cache and preferences are isolated by authenticated account and backend and cleared on logout or account/backend replacement.
- Calendar content, descriptions, facet values, search text, and mutation payloads never enter diagnostics; only sanitized identifiers, types, counts, sizes, freshness, and transitions may be logged.

## Acceptance Criteria

- **AC-001:** Web, Android, and iOS visibly implement the approved month, agenda, navigation, filtering, event-management, recurrence-scope, conflict, permission, responsive, and accessibility behaviors.
- **AC-002:** design-ref/calendar.png is followed for visual hierarchy and desktop composition while unsupported member ownership, event colors, and scheduler sources are not fabricated.
- **AC-003:** Combined reads explicitly request authorized scope all, enforce existing visibility rules, and aggregate all required pages deterministically.
- **AC-004:** Create, edit, and delete use the current calendar V2 identity, scope, recurrence, revision, and mutation contracts and remain correct after refresh.
- **AC-005:** Filter and view preferences survive reopening without crossing authenticated account or backend boundaries.
- **AC-006:** Android and iOS render shared observable KMP state rather than separately coordinating cache and network calls.
- **AC-007:** With a delayed remote response, mobile displays cached data first and later updates from the same shared stream without a blank loading replacement.
- **AC-008:** With network unavailable, mobile supports cached navigation and filtering, clearly distinguishes uncached months, and never queues or implies a successful mutation.
- **AC-009:** Logout and account switching make prior calendar events, facet names, counts, and preferences unavailable to the next user.
- **AC-010:** All temporal, permission, conflict, privacy, and accessibility cases in the approved E2E matrix are user-observable on the real local stack.

## Domain Language

- Calendar scope is private or household; all is a read-only aggregate selector for the combined authorized calendar.
- Visible month is the month currently rendered and queried, distinct from the selected date within that month.
- Month view is the calendar grid; Agenda view is the visible month's chronological date-grouped event list.
- Facet is one supported filter value: calendar scope, group, tag, or importance. Text search is a separate filter.
- Persisted preference is account- and backend-scoped local state for view mode, filters, and relevant calendar selection; it is not server-owned event data.
- Cached month is a protected, unfiltered authorized occurrence snapshot for one month that supports local filtering and offline display.
- Freshness describes whether displayed mobile data is fresh, refreshing, stale, or unavailable offline; loading must not erase valid cached data.
- Event ID identifies a persisted event or series segment, occurrence ID identifies one expanded row, original start identifies a recurring slot, and revision supports optimistic conflict detection.
- Mutation scope is this_occurrence, this_and_following, or entire_series and is distinct from calendar scope.

## Actors

- Adult using the web, Android, or iOS calendar
- Child using authorized calendar reads and permitted mutations
- Authenticated returning mobile user with cached calendar data
- Authenticated mobile user without connectivity
- Screen-reader, keyboard, switch-control, Dynamic Type, or font-scaling user

## Scenarios

- An adult opens a combined month containing private, household, timed, all-day, recurring, and overflowing-day events and moves between Month and Agenda views.
- An adult filters by scope, group, tags, importance, and text, leaves Calendar, and returns with those preferences restored.
- An adult creates a complete timed household recurrence and later edits one occurrence, following occurrences, or the entire series.
- Two clients edit from the same revision and the stale client reviews authoritative data instead of overwriting it.
- A child opens the combined calendar without seeing adults-only content and receives a safe denial for a restricted mutation.
- A returning mobile user sees cached data immediately while delayed remote revalidation updates it in place.
- An offline mobile user navigates cached adjacent months, changes local filters, and encounters a clear unavailable state for an uncached month.
- Connectivity returns while stale mobile data is visible; the shared layer revalidates and prefetches adjacent months without native fetch orchestration.
- User A logs out after caching private events and user B cannot see any of A's events, facets, counts, or preferences.
- A user in another device timezone views and edits all-day and recurring timed events without moving the all-day date or losing the recurrence wall-clock anchor.

## Edge Cases

- A visible month requires multiple REST pages.
- A selected persisted facet has no matching event in the new visible month.
- A day has more event pills than its cell can display.
- A month begins or ends midweek and includes adjacent-month date cells.
- A recurring occurrence has moved from its original start.
- A this_and_following mutation returns a successor event ID.
- A stale expected revision conflicts after another client writes.
- A child cannot observe an adults-only effective occurrence override.
- Remote refresh fails after cached data has rendered.
- An offline user opens a month outside the bounded cache.
- The twelve-month cache reaches capacity and evicts the least recently viewed month.
- Logout, account replacement, backend change, or auth expiry occurs while cached content exists.
- A timed recurrence crosses daylight-saving time while an all-day event is viewed from another timezone.

## Out of Scope

- Offline event creation, editing, deletion, mutation queueing, synchronization, or conflict replay
- Web offline event caching
- Household-member ownership, attendee modeling, or member calendars
- User-defined event colors or persisted color catalogs
- Reminder delivery, scheduler records, notification implementation, or presenting Routines & reminders as a real source
- Group or tag catalog management beyond metadata attached to events
- Google Calendar synchronization
- Full RFC 5545 recurrence beyond the existing supported contract
