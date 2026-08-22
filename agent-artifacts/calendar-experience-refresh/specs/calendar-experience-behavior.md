# Cross-platform calendar experience behavior

## Context

Defines the user-visible web, Android, and iOS family calendar refresh over the existing calendar V2 domain. The authoritative adaptation references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html with sentient-design/components/web/sentient-web.js, and sentient-design/design/mobile/calendar.html with sentient-design/components/mobile/sentient-mobile.js. These WIP references define calendar hierarchy, geometry, controls, motion, transitions, effects, and interaction flow where supported; existing repository design systems and calendar V2 contracts remain implementation and domain authority.

## Required Behaviors

- Calendar opens on the current month and explicitly queries all authorized scopes rather than inheriting the private default.
- Day, Week, Month, and Year are first-class views exposed through the canonical floating view bar. The selected view persists locally.
- Today returns to the current date. Previous and next move by one day, week, month, or year according to the active view.
- Day renders one focused agenda; Week renders seven equal columns and the week's chronological events; Month renders 42 locale-aware cells with adjacent dates; Year renders twelve complete month summaries including days 29–31.
- Month displays current and selected day states, timed and all-day event indicators, and +N overflow. Week and Month never silently become a generic list because the viewport narrows.
- The roomy web composition follows the canonical web handoff: filter sidebar, primary calendar canvas, viewport-bound event-preview popover, and floating Day/Week/Month/Year control.
- At narrow web widths, the sidebar collapses Google-style and Add Event plus active filters remain reachable through compact in-flow web controls or an anchored popover. The calendar canvas remains the web calendar composition.
- Narrow web Month and Week use seven minmax(0,1fr) columns and fit the content viewport without page-level horizontal overflow. Event representation progressively compacts from full pills to truncated pills to semantic indicators and +N overflow while retaining accessible event access.
- Native mobile follows the canonical mobile handoff rather than inheriting web breakpoints: a 58px-style top bar, horizontal scope and tag rails, compact calendar canvas, agenda-first rows, and a floating Day/Week/Month/Year view bar above safe areas.
- In native Month, selecting a date transitions to focused Day view. Week date selection keeps Week active and changes the anchor. Year month summaries navigate intentionally rather than exposing inert or incomplete day dots.
- The filter surface maps prototype calendar/person labels onto supported product semantics: Calendars means private, household, or authorized all; Groups, Tags, Importance, and text search use current V2 metadata. Unsupported member ownership, event color identity, place, and reminders are not fabricated.
- Filters apply to an unfiltered visible-range data set and update the view immediately. Filter and view preferences persist across visits, remain account- and backend-scoped, and remain removable when a selected facet has no events in the current interval.
- Every bounded continuation page needed for the visible interval is consumed; a first page is never presented as the complete interval.
- Selecting an event opens the canonical web anchored preview popover or mobile preview bottom sheet with effective event details and supported actions. Web popovers stay within the viewport; mobile sheets respect safe areas and bounded height.
- Preview opening moves focus into the preview, traps or appropriately contains modal navigation, closes through its control, outside dismissal where safe, Escape or native Back, and restores the originating event control.
- Add Event and Edit use the canonical web modal or native bottom-sheet treatment while exposing complete supported fields: title, description, all-day or timed start/end, timezone-preserving timing, scope, visibility, importance, group, tags, and structured recurrence.
- Add/Edit opening focuses the first meaningful field. Cancel, Escape/native Back, scrim dismissal where safe, success, and failure restore focus predictably and do not leave hidden overlays in the accessibility tree.
- Editing or deleting a recurring occurrence requires an explicit applicable mutation scope and carries event scope, revision, and original start where required.
- Stale revision conflicts never silently overwrite newer data; the UI explains the conflict and supports reread and review.
- Deletion requires confirmation and reports success or typed failure without optimistic false success.
- Unauthorized and adults-only events remain absent. Mutation controls reflect role restrictions without revealing hidden events, facets, or counts.
- All-day dates remain fixed while timed events render in device locale and preserve their persisted event-timezone recurrence anchor.
- Direct interaction feedback uses the existing fast motion token, state and sheet transitions use the existing normal motion token, floating surfaces use the canonical Dusk blur/elevation treatment, and reduced motion collapses nonessential transitions without removing state communication.
- Accessibility includes semantic selected/pressed states, full-date labels, today/selected/outside-month announcements, live view/filter updates, keyboard and focus handling, screen-reader labels, Dynamic Type or font scaling, minimum 44px effective targets, contrast, safe areas, and reduced-motion compatibility.
- The WIP sentient-design runtimes are reference and verification surfaces, not production dependencies. Calendar work adapts their approved behavior into existing reusable web, Compose, and SwiftUI components without rebuilding the full token or component system.
- On mobile, opening Calendar causes the shared KMP layer to load SQLDelight-persisted preferences and cached visible-month data, emit available cache immediately, asynchronously revalidate remotely, and prefetch previous and next months without blocking the visible month.
- Mobile calendar snapshots and preferences persist in a SQLDelight-backed KMP SQLite database owned by shared/mobile-data. Android and iOS provide only driver/path creation and authenticated lifecycle wiring; they do not implement separate cache or fetch policy.
- Shared SQLDelight observable queries feed the mobile calendar StateFlow so atomic database updates naturally reach Android collectors and iOS SKIE async-sequence consumers.
- Mobile retains up to twelve recently viewed months with bounded least-recently-used eviction. Cached months support offline navigation and filtering.
- Mobile remote success atomically updates the SQLDelight cache only after complete pagination and naturally emits fresh shared state; network failure retains cached events and updates only freshness or offline metadata.
- An uncached mobile interval opened offline has a specific unavailable-offline state. Save and delete actions are unavailable offline with a clear connection-required explanation and no queued mutation.
- Mobile database rows and preferences are isolated by authenticated account and backend and cleared on logout or account/backend replacement.
- The mobile SQLite files use OS-protected app-private storage. Application-level SQLCipher encryption and cross-platform database-key management are not requirements of this story.
- Calendar content, descriptions, facet values, search text, and mutation payloads never enter diagnostics; only sanitized identifiers, types, counts, sizes, freshness, and transitions may be logged.

## Acceptance Criteria

- **AC-001:** Web, Android, and iOS visibly implement the approved Day, Week, Month, Year, navigation, filtering, preview, event-management, recurrence-scope, conflict, permission, responsive, motion, reduced-motion, and accessibility behaviors.
- **AC-002:** The calendar is adapted against the exact committed HANDOFF, brand specification, web entry/runtime, and mobile entry/runtime paths. Prototype-only semantics and defects are not copied into production.
- **AC-003:** Roomy web matches the canonical sidebar/canvas/preview/view-bar composition. Narrow web applies the reviewed Google-style correction: sidebar collapse, reachable compact filters/Add Event, seven-column calendar fit, and no generic mobile substitution or page-level horizontal overflow.
- **AC-004:** Native Android and iOS match the canonical mobile horizontal-filter, compact-calendar, agenda-row, floating-view-bar, and bottom-sheet composition while using native controls and lifecycle conventions.
- **AC-005:** Existing repository Dusk tokens, typography, icons, and reusable components are reused; the calendar refresh does not introduce page-local palettes, ad hoc motion, or wholesale WIP design-system adoption.
- **AC-006:** Combined reads explicitly request authorized scope all, enforce existing visibility rules, and aggregate all required pages deterministically.
- **AC-007:** Create, edit, and delete use the current calendar V2 identity, scope, recurrence, revision, and mutation contracts and remain correct after refresh.
- **AC-008:** Filter and view preferences survive reopening without crossing authenticated account or backend boundaries.
- **AC-009:** Android and iOS render shared observable KMP state rather than separately coordinating database, cache, filtering, network, or prefetch behavior.
- **AC-010:** The KMP SQLDelight database persistently stores complete month snapshots and preferences, applies migrations, performs atomic replacement, and drives observable mobile state.
- **AC-011:** With a delayed remote response, mobile displays SQLDelight-cached data first and later updates from the same shared stream without a blank loading replacement.
- **AC-012:** With network unavailable, mobile supports cached navigation and filtering, clearly distinguishes uncached intervals, and never queues or implies a successful mutation.
- **AC-013:** Logout and account switching make prior calendar events, facet names, counts, and preferences unavailable to the next user.
- **AC-014:** Visual evidence at reviewed web and mobile viewport sizes is compared to the committed design entry points, with intentional domain and responsive deviations documented rather than left to implementer judgment.
- **AC-015:** All temporal, permission, conflict, privacy, database-lifecycle, responsive, overlay, and accessibility cases in the approved E2E matrix are observable on the real local stack.

## Domain Language

- Calendar scope is private or household; all is a read-only aggregate selector for the combined authorized calendar.
- Visible interval is the day, week, month, or year currently rendered and queried, distinct from the selected or anchor date.
- Day view is a focused one-day agenda. Week view is a seven-column week plus chronological events. Month view is a six-row, seven-column month. Year view is twelve compact month summaries.
- Facet is one supported filter value: calendar scope, group, tag, or importance. Text search is a separate filter.
- Responsive web composition is the canonical web calendar adapted by industrial practice: a sidebar at roomy widths, Google-style sidebar collapse at narrow widths, and calendar views that shrink or reflow to fit without becoming the native mobile composition.
- Native mobile composition is the separate canonical mobile adaptation: horizontal filters, compact calendar summaries, agenda-first rows, floating view controls, and bottom sheets.
- Persisted preference is account- and backend-scoped local state for view mode, filters, selected date, and visible interval; it is not server-owned event data.
- Cached month is a protected, unfiltered authorized occurrence snapshot stored in the shared KMP SQLDelight database for one month, supporting local filtering and offline display.
- Calendar cache database is the SQLDelight-backed KMP SQLite store owned by shared/mobile-data. Shared code owns its schema, migrations, queries, cache policy, and observable state; native code supplies the platform driver and protected path.
- Freshness describes whether displayed mobile data is fresh, refreshing, stale, or unavailable offline; loading must not erase valid cached data.
- Event ID identifies a persisted event or series segment, occurrence ID identifies one expanded row, original start identifies a recurring slot, and revision supports optimistic conflict detection.
- Mutation scope is this_occurrence, this_and_following, or entire_series and is distinct from calendar scope.
- Prototype content is sample-only member names, locations, reminders, colors, fixed dates, status values, and in-memory event behavior in sentient-design. It is never product data or a domain contract.

## Actors

- Adult using the web, Android, or iOS calendar
- Child using authorized calendar reads and permitted mutations
- Authenticated returning mobile user with cached calendar data
- Authenticated mobile user without connectivity
- Web user at desktop, tablet, narrow, and phone-sized browser viewports
- Screen-reader, keyboard, switch-control, Dynamic Type, font-scaling, or reduced-motion user

## Scenarios

- An adult opens a combined month containing private, household, timed, all-day, recurring, and overflowing-day events and moves among Day, Week, Month, and Year.
- A desktop web user filters from the sidebar, opens an anchored event preview, and creates an event in the modal.
- A narrow-web user sees the sidebar collapse while Add Event and filters remain reachable and the seven-column calendar shrinks to fit without horizontal page overflow.
- An Android or iOS user scrolls horizontal filters, selects a Month date to enter Day view, opens an event-preview sheet, and opens the Add/Edit sheet.
- An adult filters by scope, group, tags, importance, and text, leaves Calendar, and returns with those preferences restored.
- An adult creates a complete timed household recurrence and later edits one occurrence, following occurrences, or the entire series.
- Two clients edit from the same revision and the stale client reviews authoritative data instead of overwriting it.
- A child opens the combined calendar without seeing adults-only content and receives a safe denial for a restricted mutation.
- A returning mobile user sees a SQLDelight-cached month immediately while delayed remote revalidation atomically updates the shared database and observable UI state.
- An offline mobile user navigates cached adjacent months, changes locally persisted filters, and encounters a clear unavailable state for an uncached interval.
- Connectivity returns while stale mobile data is visible; the shared layer revalidates and prefetches adjacent months without native fetch orchestration.
- User A logs out after caching private events and user B cannot see any of A's database rows, facets, counts, or preferences.
- A user in another device timezone views and edits all-day and recurring timed events without moving the all-day date or losing the recurrence wall-clock anchor.

## Edge Cases

- A visible interval requires multiple REST pages.
- A selected persisted facet has no matching event in the new interval.
- A day has more event pills than its cell can display.
- A month begins or ends midweek and includes adjacent-month date cells.
- A narrow browser reaches 390px while Month and Week retain seven usable columns and no page-level horizontal overflow.
- A web preview would overflow right, left, below, or the viewport height and must reposition or bound its own scroll area.
- A mobile sheet opens near the safe-area edge, closes by native Back, and restores focus without leaving hidden controls accessible.
- A Year view includes complete month dates through 29–31 and exposes meaningful month navigation.
- A recurring occurrence has moved from its original start.
- A this_and_following mutation returns a successor event ID.
- A stale expected revision conflicts after another client writes.
- A child cannot observe an adults-only effective occurrence override.
- Remote refresh fails after SQLDelight-cached data has rendered.
- An offline user opens an interval outside the bounded cache.
- The twelve-month SQLDelight cache reaches capacity and evicts the least recently viewed month.
- A database migration, decode, or atomic replacement fails without exposing partial content.
- Logout, account replacement, backend change, or auth expiry occurs while cached database content exists.
- A timed recurrence crosses daylight-saving time while an all-day event is viewed from another timezone.

## Out of Scope

- Offline event creation, editing, deletion, mutation queueing, synchronization, or conflict replay
- Web offline event caching
- Household-member ownership, attendee modeling, or member calendars
- User-defined event colors or persisted color catalogs
- Place/location modeling not present in the current calendar V2 contract
- Reminder delivery, scheduler records, notification implementation, or presenting Routines & reminders as a real source
- Group or tag catalog management beyond metadata attached to events
- Google Calendar synchronization
- Application-level SQLCipher encryption and cross-platform database-key management
- Wholesale replacement of existing web, Android, or iOS design systems with sentient-design prototype runtimes
- Full RFC 5545 recurrence beyond the existing supported contract
