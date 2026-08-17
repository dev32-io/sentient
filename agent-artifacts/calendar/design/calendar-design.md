# Calendar Design

## Design Goal

Keep calendar storage, recurrence, visibility, tool surface, nudge, and UI behind established capability and tier-permission seams, with one recurrence engine shared by all consumers.

## Chosen Approach

- A native calendar product tool group backed by a per-scope bun:sqlite CalendarStore
- A shared expandRecurrence module consumed by the store queries, the agent tools, and the nudge composer
- UIs talk a new REST API over the same store
- The nudge composes on the existing session-prompt augmentPrompt seam
- The four HA calendar tools are removed from buildHomeTools

## Verification Boundaries

- CalendarStore contract tests: class gate, path isolation, migration ladder, visibility filter, adult-gate
- expandRecurrence tests: bounded subset, EXDATE, exceptions override, all-day, DST
- Tool permission tests: tier defaults, role reachability, ask flow
- Nudge composition and budget tests including empty-calendar omission
- HA deprecation: provider output and catalog assert the four home_*_calendar_event tools absent

## Components and Interfaces

- CalendarStore (new): factory openCalendarStore(cap, cfg, deps) with ACCEPTED_CLASSES = calendar-private, calendar-household; WAL; frozen DDL plus user_version migrations; query methods take cap.role for visibility filtering
- expandRecurrence(event, windowStart, windowEnd, tz): pure module; the single recurrence engine
- calendar tool group (new): calendar_list, calendar_get, calendar_search (read); calendar_create, calendar_update (write); calendar_delete (confirm); productGroup calendar, defaultExposure standard
- Bootstrap: calendar-provider.ts; add calendar to FoundationProductGroup and provider slots; metadata in product-tool-metadata.ts; mint both capabilities in phase-services.ts alongside memory
- Nudge composer: appends after the memory block in augmentPrompt; own char and line budget; deterministic drop order
- CalendarNotifier interface: no-op now; events carry a nullable notification policy column for future cron push
- REST: /api/v1/calendar/... handlers over the same store; capability minted from the authenticated connection principal
- Web: new top-level route icon in the chat/settings row; calendar feature over the REST client
- Mobile: calendar icon next to settings in the left-edge drawer; KMP mobile-data repository plus SDK REST client plus Compose/SwiftUI screens mirroring Memory

## Data and Control Flow

- Mint calendar-private and calendar-household capabilities at session build via AccessManager.grant
- CalendarStore opens under the capability root, class-gates before path derivation, and serves queries with role-based visibility filtering
- expandRecurrence produces occurrences within the requested window for store queries, tool calls, and nudge selection
- The nudge composer appends a capped summary after the memory block in the session-stable system prompt
- The REST API and the calendar tool group both operate over the same CalendarStore with the same visibility filtering

## Failure and Recovery

- SQLite migrations are forward-only; an ahead-of-binary database is left untouched and warned
- Recurrence expansion is bounded by the query window; a malformed RRULE returns a typed tool failure with no partial expansion
- Nudge over-budget drops overflow summaries, then non-important weekly items, keeping today plus important or pinned
- Tool ask timeout, cancel, or closed session denies fail-closed

## Alternatives Considered

- Markdown or text storage (rejected): calendar retrieval and recurrence logic warrants a real query engine
- Pre-materialized recurring rows (rejected): unbounded; expand-on-query with a shared engine is bounded and reused by tools, UI, and nudge
- Keep HA calendar tools and bridge them (rejected): overlapping surfaces confuse the model; deprecate entirely in v1, retain adapter methods for a future sync bridge
- @adults suffix visibility (rejected): events are structured records, not markdown lines; a structured visibility field fits
