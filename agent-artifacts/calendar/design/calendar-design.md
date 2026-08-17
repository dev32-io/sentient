# Calendar Design

## Design Goal

Keep calendar storage, recurrence, visibility, tool surface, nudge, and UI behind established capability and tier-permission seams, with one recurrence engine shared by all consumers, and the timezone model aligned to the existing gateway TimeZoneProvider seam.

## Chosen Approach

- A native calendar product tool group backed by a per-scope bun:sqlite CalendarStore
- A shared expandRecurrence module consumed by the store queries, the agent tools, and the nudge composer
- UIs talk a new REST API over the same store
- The nudge composes on the existing session-prompt augmentPrompt seam
- The four HA calendar tools are removed from buildHomeTools
- Timezone model: align to the existing gateway convention (gateway/src/context/message-time.ts) — UTC instants rendered with an explicit offset via the swappable TimeZoneProvider (host zone today; household-location later). Three distinct tz roles are kept separate: event tz (anchor — each timed event stores a UTC instant plus an event tz id default household tz; all-day events store a local date; recurrence expands in the event's tz so a 9am Monday stays anchored and DST is preserved; per-event tz override allowed), household/session tz (rendering + nudge 'today' via resolveTimeZone()), and user current tz (scheduler only — needed for relative reminders like 'remind me tomorrow morning', '9am daily briefing', 'every 4h'; does NOT exist yet and is NOT introduced by the calendar; the future scheduler adds a UserTimeZoneProvider seam parallel to TimeZoneProvider). The calendar never needs the user current tz; event-attached reminders use the event's UTC instant (location-independent).
- Calendar vs scheduler boundary: the calendar is durable dated/timed event storage — literally a calendar, NOT the home for relative reminders, recurring briefings, or interval reminders. The calendar tool descriptions say so explicitly so the model does not file 'remind me tomorrow morning' or 'send a briefing every 9am Monday' as calendar events. Those are a future scheduler-owned record type (user-current-tz relative) that shares UTC instants as currency but is a separate system. The CalendarNotifier no-op interface and the event notification-policy column are the only calendar-side handoff to that future scheduler.

## Verification Boundaries

- CalendarStore contract tests: class gate (resource class, not path), path isolation, migration ladder, visibility filter, adult-gate, close()/closed-handle semantics, ahead-of-binary policy
- expandRecurrence tests: bounded subset, EXDATE, exceptions override, all-day, DST in the event tz
- Tool permission tests: tier defaults, role reachability, ask flow, and pre-PDP household-write rejection (zero confirm calls, zero store calls)
- Nudge composition and budget tests including empty-calendar omission, household-tz 'today', and prompt-cache stability across an in-session write
- HA deprecation: provider output and catalog assert the four home_*_calendar_event tools absent

## Components and Interfaces

- CalendarStore (new): factory openCalendarStore(cap, cfg, deps) with ACCEPTED_CLASSES = calendar-private, calendar-household; WAL; frozen DDL plus user_version migrations; UTC-instant + event-tz-id + all-day-date columns; close() with closed-handle semantics; query methods take cap.role for visibility filtering
- expandRecurrence(event, windowStart, windowEnd): pure module; the single recurrence engine, expanding in the event's own tz (default household tz)
- calendar tool group (new): calendar_list, calendar_get, calendar_search (read); calendar_create, calendar_update (write); calendar_delete (confirm); productGroup calendar, defaultExposure standard; descriptions scope the calendar to durable dated/timed events and steer the model away from relative reminders/briefings/interval reminders (future scheduler)
- Bootstrap: calendar-provider.ts; add calendar to FoundationProductGroup and provider slots; metadata in product-tool-metadata.ts; mint both capabilities in phase-services.ts alongside memory; close stores on session disposal
- Nudge composer: appends after the memory block in augmentPrompt; own char and line budget; deterministic drop order; 'today' via resolveTimeZone() (household tz)
- CalendarNotifier interface: no-op now; events carry a nullable notification policy column for future cron push (the only calendar→scheduler handoff)
- REST: /api/v1/calendar/... handlers over the same store; capability minted from the authenticated principal (single configured household); serves UTC instant + event tz id + all-day date; request-scoped store close() in try/finally
- Web: new top-level route icon in the chat/settings row; calendar feature over the REST client; renders in the device tz from the tz-aware value
- Mobile: calendar icon next to settings in the left-edge drawer; KMP mobile-data repository plus SDK REST client plus Compose/SwiftUI screens mirroring Memory; renders in the device tz from the tz-aware value

## Data and Control Flow

- Mint calendar-private and calendar-household capabilities at session build via AccessManager.grant
- CalendarStore opens under the capability root, class-gates before path derivation, and serves queries with role-based visibility filtering
- expandRecurrence produces occurrences within the requested window, in the event's tz, for store queries, tool calls, and nudge selection
- The nudge composer appends a capped summary after the memory block in the session-stable system prompt; 'today' is household-tz today
- The REST API and the calendar tool group both operate over the same CalendarStore with the same visibility filtering and serve tz-aware values (UTC instant + event tz)

## Failure and Recovery

- SQLite migrations are forward-only; an ahead-of-binary database is handled with an explicit, tested policy (reject open or warn-and-leave-untouched)
- Recurrence expansion is bounded by the query window; a malformed RRULE returns a typed tool failure with no partial expansion
- Nudge over-budget drops overflow summaries, then non-important weekly items, keeping today plus important or pinned
- Tool ask timeout, cancel, or closed session denies fail-closed
- Store handles expose close(); session and request scopes close them to avoid leaking SQLite/WAL/SHM descriptors

## Security and Privacy

- calendar-private and calendar-household added to ResourceClass; rootPathFor gains a household branch; capabilities frozen at mint and path-confined; no ambient authority (handles read only cap.ownerUserId, cap.role, cap.rootPath)
- Role-based visibility filtered at the store query layer via a structured visibility field, not an @adults suffix; isAdult(role) = adult | admin (admin is adult-equivalent, no bypass)
- Household writes adult-gated at the store (fail-fast, defense-in-depth) AND rejected pre-PDP in the provider validate() before the broker ask/confirm flow, so a non-adult household write returns a typed failure with no permission.request
- Tool tiers drive defaults via the existing defaultPermissionForTier (contract-tested read to allow, write to ask, confirm to ask); role reachability via canExecute; ask triggers permission.request with fail-closed deny on timeout or cancel
- Calendar tool activity surfaces as tasklist.state frames in the composer strip, not as conversation bubble pills (inherited from the existing tool-broker path)

## Compatibility and Migration

- New resource classes are additive. HA calendar tool removal leaves orphaned profile.tools.permissions entries (harmless; NO profile migrator is added — removal adds persistent-profile mutation and recovery risk without a success signal).
- The notification column is forward-compatible for future push. The raw rrule column lets the supported subset grow without schema change.
- The event-tz-id column makes the tz model forward-compatible with household-location and per-user-location support without a schema change.

## Alternatives Considered

- Markdown or text storage (rejected): calendar retrieval and recurrence logic warrants a real query engine
- Pre-materialized recurring rows (rejected): unbounded; expand-on-query with a shared engine is bounded and reused by tools, UI, and nudge
- Keep HA calendar tools and bridge them (rejected): overlapping surfaces confuse the model; deprecate entirely in v1, retain adapter methods for a future sync bridge
- @adults suffix visibility (rejected): events are structured records, not markdown lines; a structured visibility field fits
- Pure-UTC store + serve with no event tz (rejected): loses the wall-clock anchor for recurrence and breaks all-day events (no instant); the event-tz-anchored model keeps UTC instants as the exchange currency while preserving anchors
- File relative reminders / recurring briefings as calendar events (rejected): blurs durable event storage with user-current-tz scheduling; keep them as a separate future scheduler record type and enforce via tool descriptions
