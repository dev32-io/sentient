# Cross-platform calendar experience design

## Design Goal

Present one coherent, accessible calendar experience across web, Android, and iOS while preserving the existing calendar V2 domain, reusing each platform's design system, and hiding mobile cache/network orchestration behind shared observable KMP business logic.

## Chosen Approach

- Use design-ref/calendar.png as the canonical visual reference for hierarchy, desktop composition, mini-calendar, navigation, Month/Agenda control, grid, event pills, and filter rail.
- Adapt the reference responsively rather than shrinking it: desktop web keeps a persistent rail and full grid; narrow web and native mobile use an accessible filter drawer or sheet plus compact month and selected-day agenda.
- Represent only supported semantics. Replace the reference's named household members and routines/reminders source with Calendars, Groups, Tags, Importance, and text search. Do not fabricate ownership, attendees, color persistence, or scheduler behavior.
- Build reusable platform calendar primitives and consume existing tokens, typography, icons, cards, dialogs, sheets, and controls. New visual constants belong in shared platform token surfaces, not calendar-local magic values.
- Explicitly request read scope all for the primary combined view, aggregate deterministic continuation pages for the unfiltered visible month, derive available facet options from that data, and apply interactive filters locally.
- Use the exact V2 mutation command for event and recurrence operations, including scope, mutation scope, original start, and expected revision. Preserve typed conflict and authorization outcomes through the UI.
- Keep the web calendar as a REST-backed screen/container with local derived view state and account-scoped persisted preferences. Web event bodies are not persisted for offline use.
- Keep CalendarHttpClient and the SDK repository as stateless wire/transport boundaries. Add cache, observation, filter, revalidation, pagination, and prefetch policy in shared/mobile-data commonMain.
- Expose one shared observable mobile calendar state. Native ViewModels express visible range and user intents and collect state; they do not coordinate cache reads, remote calls, or prefetch jobs.
- Back the shared mobile cache with protected platform persistence, atomic replacement, account/backend namespacing, and bounded twelve-month least-recently-used retention.
- Apply stale-while-revalidate behavior: emit cached data first, automatically revalidate, atomically persist fresh data, and emit the update without clearing valid content during loading or network failure.
- Start non-blocking previous/current/next-month prefetch when the calendar screen opens, coalesce duplicate month requests, and cancel obsolete foreground work when visible range changes.
- Treat offline mutations as deferred. Offline UI remains browse-capable for cached months but disables save/delete with an explicit explanation and creates no queue record.

## Verification Boundaries

- Stable pure calendar projection tests cover month cell generation, locale-aware weeks, selected/current day, overflow, chronological agenda grouping, filter intersection, and facet retention.
- Web component and service tests cover explicit all-scope reads, continuation aggregation, Month/Agenda behavior, preference restoration, accessible dialog/focus behavior, exact mutation commands, and conflict states.
- Shared mobile-data tests use fake remote and cache boundaries to prove cache-first emission, no blank loading replacement, automatic revalidation, request coalescing, pagination completeness, adjacent prefetch, LRU eviction, network fallback, account isolation, and no offline mutation record.
- Android and iOS ViewModel tests prove native layers collect shared state and send intents without duplicate call management. UI tests cover responsive/native controls, accessibility, filter sheets, editor sheets, offline notice, and disabled mutation states.
- Calendar V2 integration tests remain the authority for temporal normalization, effective occurrences, pagination, role visibility, revision conflicts, and recurrence mutation semantics.
- The approved E2E matrix verifies the complete touched-area user journeys on the real local stack with disposable principals and synthetic events.
- Run narrow package tests while iterating, affected package checks, and git diff --check. Never use production for calendar writes or smoke evidence.

## Components and Interfaces

- Reusable calendar page scaffold, MonthGrid, DayCell, MiniCalendar, EventPill, overflow control, AgendaList, day-event list, FilterPanel, EventEditor, recurrence controls, mutation-scope chooser, freshness notice, empty/error/conflict presentations on each platform.
- Web calendar screen/container and calendar REST service consume existing accessible Dialog, Button, Icon, form, card, chip, select, and segmented-control primitives and token styles.
- Shared mobile CalendarExperience use case/coordinator owns visible-window observation, persisted filters, local projection, pagination aggregation, stale-while-revalidate, request coalescing, adjacent prefetch, freshness, and LRU policy.
- CalendarCacheStore is a separate persistence boundary with common models and Android/iOS protected implementations; SdkCalendarRepository remains stateless.
- Authenticated mobile session scope owns the calendar experience, cache namespace, and cancellation lifecycle. Logout/account/backend replacement purges or isolates prior state before another user can observe it.
- Android calendar ViewModel collects shared StateFlow and translates native user intents; Compose renders thin reusable components and platform date/time controls.
- iOS calendar ViewModel consumes SKIE async sequences directly, owns and cancels collection tasks, and translates SwiftUI intents without a Combine bridge or duplicate repository state.
- Existing calendar V2 REST handler, temporal semantics, visibility enforcement, effective occurrence projection, pagination, and mutation services remain authoritative backend boundaries.

## Data and Control Flow

- Calendar opens and restores account-scoped view mode, filters, selected date, and visible month.
- Web requests the unfiltered visible month with explicit scope all and follows continuation cursors; mobile subscribes to the shared calendar experience for that window.
- Mobile shared data reads a protected cached snapshot and emits it immediately with freshness metadata when present.
- The shared layer asynchronously revalidates the visible month and prefetches adjacent months; equivalent in-flight month requests are coalesced.
- Authorized REST pages are aggregated into one deterministic month snapshot before atomic cache replacement. Only complete successful snapshots replace cache.
- Fresh shared state naturally reaches Android StateFlow collectors and iOS SKIE async-sequence collectors; native code does not issue a second fetch.
- UI derives MonthGrid, AgendaList, day overflow, and facet options from the unfiltered month and applies persisted filters and search locally.
- Month change updates the requested window, cancels obsolete foreground work, preserves still-valid display state during transition, and starts the same cache/revalidation flow.
- Add or edit submits an online V2 create or mutation command. Success invalidates affected cached months and triggers shared revalidation; failure preserves the draft and current displayed data.
- Recurring edit/delete asks for mutation scope before submission and targets the selected occurrence through event ID, original start, scope, and revision.
- Conflict leaves current data intact, presents the authoritative-change condition, and allows reread/review. Delete requires confirmation before the online command.
- Network failure leaves cached data and filter functionality available, changes freshness/offline metadata, and makes online-only mutation controls unavailable.
- Connectivity recovery or explicit refresh invalidates freshness and revalidates through the same shared path rather than native call orchestration.
- Logout or authenticated-backend replacement cancels work and clears or switches the cache/preference namespace before the next user session is exposed.

## Failure and Recovery

- Cached content is never replaced by an empty Loading envelope. Loading without cache shows the accessible loading state; loading with cache shows content plus refreshing status.
- Network failure is distinguished from authorization, forbidden, malformed, or conflict outcomes. Cache fallback applies to connectivity failure, not as a way to hide security or contract errors.
- An incomplete paginated response never replaces a complete cached month. The existing snapshot remains stale and the user receives a retryable failure state.
- Uncached offline navigation shows a specific unavailable-offline state and retains navigation back to cached months.
- A stale revision does not retry blindly or overwrite. The UI offers authoritative reread and intentional review.
- A recurrence conflict preserves the editor draft and existing series state and explains that recurrence or scope must be reconsidered.
- Unauthorized and hidden targets remain non-disclosing; UI cannot infer hidden event identifiers, counts, groups, or tags.
- Prefetch failure does not fail the visible month. It records only sanitized structural status and is retried on later demand or connectivity recovery.
- Cache decode, version, or atomic-write failure fails closed for that entry, retains no partially decoded content, and falls back to remote retrieval when available.
- Cache namespace changes and logout cancel collectors before purge/switch so stale private data cannot be emitted into the next authenticated session.
- Offline save/delete produces no optimistic success, no durable queue record, and no hidden retry. The editor can retain its in-memory draft only for the current native presentation lifecycle.
- Timezone formatting failures use safe explicit fallbacks without rewriting stored event timezone or all-day identity.

## Alternatives Considered

- Putting cache and synchronization policy in each native ViewModel was rejected because it duplicates business logic and violates the thin-native-client direction.
- Putting cache policy inside shared/mobile-sdk was rejected because that module is the transport and wire boundary; shared/mobile-data is the established reusable business/data layer while the SDK repository remains stateless.
- Using only the last exact filtered response as cache was rejected because persisted filters and offline filter changes require an unfiltered authorized month snapshot.
- Adding a new backend group/tag catalog was rejected because current event metadata and visible-month derivation satisfy this refresh without a new taxonomy lifecycle.
- Treating Maya/Jordan as tags or groups was rejected because it would misrepresent unsupported household-member ownership.
- Implementing persistent event colors was rejected because the event contract has no color identity; existing token accents may communicate supported scope, importance, selection, and state only.
- Shrinking the desktop reference sidebar into the mobile viewport was rejected in favor of a native sheet/drawer and selected-day agenda.
- Reusing the chat OutboundCache for calendar writes was rejected for this story because it is in-memory and chat-deduplication-specific; offline calendar mutation is deferred without declaring a future synchronization approach impossible.
- Adding a KMP database immediately was not selected as a requirement; the persistence boundary permits an appropriately protected bounded snapshot implementation and can evolve if measured storage/query needs justify a database.
