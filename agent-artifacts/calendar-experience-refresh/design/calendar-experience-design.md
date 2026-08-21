# Cross-platform calendar experience design

## Design Goal

Present one coherent, accessible calendar experience across web, Android, and iOS while preserving the existing calendar V2 domain, reusing each platform's design system, and consolidating mobile persistence, cache, network, filtering, and observable-state business logic in the shared KMP layer.

## Chosen Approach

- Use design-ref/calendar.png as the canonical visual reference for hierarchy, desktop composition, mini-calendar, navigation, Month/Agenda control, grid, event pills, and filter rail.
- Adapt the reference responsively rather than shrinking it: desktop web keeps a persistent rail and full grid; narrow web and native mobile use an accessible filter drawer or sheet plus compact month and selected-day agenda.
- Represent only supported semantics. Replace the reference's named household members and routines/reminders source with Calendars, Groups, Tags, Importance, and text search. Do not fabricate ownership, attendees, color persistence, or scheduler behavior.
- Build reusable platform calendar primitives and consume existing tokens, typography, icons, cards, dialogs, sheets, and controls. New visual constants belong in shared platform token surfaces, not calendar-local magic values.
- Explicitly request read scope all for the primary combined view, aggregate deterministic continuation pages for the unfiltered visible month, derive available facet options from that data, and apply interactive filters locally.
- Use the exact V2 mutation command for event and recurrence operations, including scope, mutation scope, original start, and expected revision. Preserve typed conflict and authorization outcomes through the UI.
- Keep the web calendar as a REST-backed screen/container with local derived view state and account-scoped persisted preferences. Web event bodies are not persisted for offline use.
- Keep CalendarHttpClient and the SDK repository as stateless wire/transport boundaries. Own calendar database, cache, observation, filtering, revalidation, pagination, prefetch, and freshness policy in shared/mobile-data commonMain and export that shared KMP surface to native clients.
- Add a SQLDelight-backed KMP SQLite database to shared/mobile-data. Shared code owns the schema, migrations, typesafe queries, transactions, observable query flows, serialization, namespace rules, and retention policy.
- Persist complete unfiltered month snapshots rather than partially downloaded pages. A cache row is keyed by authenticated account/backend namespace plus month window and timezone, records fetched and last-accessed metadata, and stores the complete serialized occurrence snapshot needed by shared projections.
- Persist account/backend-scoped calendar preferences in the same shared database, including view mode, selected date, visible month, filter facets, and search state.
- Expose one shared observable mobile calendar state. SQLDelight query flows, persisted preferences, revalidation status, and local projection combine into a StateFlow. Native ViewModels express visible range and user intents and collect state; they do not coordinate database reads, remote calls, or prefetch jobs.
- Use platform-specific SQLDelight driver factories only where required: Android creates AndroidSqliteDriver in app-private storage; iOS creates NativeSqliteDriver in Application Support and applies iOS Data Protection to database-related files.
- Rely on OS-protected app-private storage rather than application-level SQLCipher in this story. Android uses application-private storage under device file-based encryption; iOS uses protected Application Support storage. SQLCipher and cross-platform database-key management are explicitly excluded.
- Apply stale-while-revalidate behavior: emit SQLDelight-cached data first, automatically revalidate, atomically persist fresh data, and emit the query update without clearing valid content during loading or network failure.
- Start non-blocking previous/current/next-month prefetch when the calendar screen opens, coalesce duplicate month requests, and cancel obsolete foreground work when visible range changes.
- Retain twelve recently viewed months by shared SQLDelight LRU metadata and transactional eviction.
- Treat offline mutations as deferred. Offline UI remains browse-capable for cached months but disables save/delete with an explicit explanation and creates no queue record.

## Verification Boundaries

- Stable pure calendar projection tests cover month cell generation, locale-aware weeks, selected/current day, overflow, chronological agenda grouping, filter intersection, and facet retention.
- Web component and service tests cover explicit all-scope reads, continuation aggregation, Month/Agenda behavior, preference restoration, accessible dialog/focus behavior, exact mutation commands, and conflict states.
- Shared mobile-data SQLDelight tests cover schema creation and migration, complete-window transactions, observable query emission, preference persistence, namespace isolation, cache-first emission, no blank loading replacement, automatic revalidation, request coalescing, pagination completeness, adjacent prefetch, LRU eviction, network fallback, and absence of offline mutation records.
- Shared tests verify a failed or cancelled page aggregation never replaces a complete cached month and a failed transaction exposes no partial snapshot.
- Android tests create the real Android SQLDelight driver in app-private test storage; iOS simulator/device tests create the NativeSqliteDriver, verify Application Support placement and Data Protection handling, and exercise migration/open/close behavior.
- Android and iOS ViewModel tests prove native layers collect shared state and send intents without duplicate database or call management. UI tests cover responsive/native controls, accessibility, filter sheets, editor sheets, offline notice, and disabled mutation states.
- iOS consumes shared Kotlin Flow directly through SKIE async sequences rather than introducing a Combine persistence bridge, consistent with the reviewed interop contract.
- Calendar V2 integration tests remain the authority for temporal normalization, effective occurrences, pagination, role visibility, revision conflicts, and recurrence mutation semantics.
- The approved E2E matrix verifies the complete touched-area user journeys on the real local stack with disposable principals and synthetic events.
- Run narrow package tests while iterating, affected package checks, and git diff --check. Never use production for calendar writes or smoke evidence.

## Components and Interfaces

- Reusable calendar page scaffold, MonthGrid, DayCell, MiniCalendar, EventPill, overflow control, AgendaList, day-event list, FilterPanel, EventEditor, recurrence controls, mutation-scope chooser, freshness notice, empty/error/conflict presentations on each platform.
- Web calendar screen/container and calendar REST service consume existing accessible Dialog, Button, Icon, form, card, chip, select, and segmented-control primitives and token styles.
- Shared mobile CalendarExperience use case/coordinator owns visible-window observation, persisted filters, local projection, pagination aggregation, stale-while-revalidate, request coalescing, adjacent prefetch, freshness, and LRU policy.
- CalendarDatabase is a SQLDelight database generated in shared/mobile-data from common schema and migrations. Its cache table stores complete month snapshots and freshness/LRU metadata; its preferences table stores account/backend-scoped calendar presentation state.
- CalendarCacheStore is the shared interface over SQLDelight transactions and observable queries; SdkCalendarRepository remains stateless and remote-only.
- CalendarDatabaseDriverFactory is the narrow platform seam. Android supplies Context-backed AndroidSqliteDriver; iOS supplies Application Support-backed NativeSqliteDriver and file-protection setup.
- Authenticated mobile session scope owns the database namespace, calendar experience, collectors, and cancellation lifecycle. Logout/account/backend replacement cancels observation before purging or switching namespace so another principal cannot observe stale rows.
- Android calendar ViewModel collects shared StateFlow and translates native user intents; Compose renders thin reusable components and platform date/time controls.
- iOS calendar ViewModel consumes SKIE async sequences directly, owns and cancels collection tasks, and translates SwiftUI intents without a Combine bridge or duplicate repository state.
- Existing calendar V2 REST handler, temporal semantics, visibility enforcement, effective occurrence projection, pagination, and mutation services remain authoritative backend boundaries.

## Data and Control Flow

- Authenticated mobile session creates the platform SQLDelight driver and shared CalendarDatabase, establishes the account/backend namespace, and exposes CalendarExperience to native code.
- Calendar opens and the shared experience observes SQLDelight preferences and the visible month cache row. Native code sends only window and user-intent changes.
- Web requests the unfiltered visible month with explicit scope all and follows continuation cursors; mobile emits a decoded complete SQLDelight snapshot immediately with freshness metadata when present.
- The shared layer asynchronously revalidates the visible month and prefetches adjacent months; equivalent in-flight month requests are coalesced.
- Authorized REST pages are aggregated into one deterministic month snapshot before a SQLDelight transaction replaces that window, updates freshness/access metadata, and evicts excess LRU rows. Incomplete results never replace a complete row.
- SQLDelight invalidates the affected observable query. Shared Flow recomputes CalendarExperienceState, which naturally reaches Android StateFlow collectors and iOS SKIE async-sequence consumers without a native follow-up fetch.
- Shared KMP projection derives MonthGrid, AgendaList, day overflow, and facet options from the unfiltered decoded month and applies SQLDelight-persisted filters and search.
- Month change updates the requested window, records access, cancels obsolete foreground work, preserves still-valid display state during transition, and starts the same database/revalidation flow.
- Add or edit submits an online V2 create or mutation command through the shared layer. Success invalidates affected cached windows and triggers revalidation; failure preserves the draft and current displayed data.
- Recurring edit/delete asks for mutation scope before submission and targets the selected occurrence through event ID, original start, scope, and revision.
- Conflict leaves current data intact, presents the authoritative-change condition, and allows reread/review. Delete requires confirmation before the online command.
- Network failure leaves SQLDelight-cached data and filter functionality available, changes freshness/offline metadata, and makes online-only mutation controls unavailable.
- Connectivity recovery or explicit refresh invalidates freshness and revalidates through the same shared path rather than native call orchestration.
- Logout or authenticated-backend replacement cancels SQLDelight observation and remote work, then transactionally purges or switches the cache/preference namespace before the next user session is exposed.

## Failure and Recovery

- Cached content is never replaced by an empty Loading envelope. Loading without cache shows the accessible loading state; loading with cache shows content plus refreshing status.
- Network failure is distinguished from authorization, forbidden, malformed, or conflict outcomes. Cache fallback applies to connectivity failure, not as a way to hide security or contract errors.
- An incomplete paginated response never replaces a complete SQLDelight month row. The existing snapshot remains stale and the user receives a retryable failure state.
- Uncached offline navigation shows a specific unavailable-offline state and retains navigation back to cached months.
- A stale revision does not retry blindly or overwrite. The UI offers authoritative reread and intentional review.
- A recurrence conflict preserves the editor draft and existing series state and explains that recurrence or scope must be reconsidered.
- Unauthorized and hidden targets remain non-disclosing; UI cannot infer hidden event identifiers, counts, groups, or tags.
- Prefetch failure does not fail the visible month. It records only sanitized structural status and is retried on later demand or connectivity recovery.
- SQLDelight schema migrations are explicit and tested on Android and iOS. Migration, decode, or transaction failure fails closed for the affected row, retains no partially replaced content, and falls back to remote retrieval when available.
- Database creation and I/O remain off the UI thread through shared coroutine dispatching. Driver shutdown follows authenticated session disposal.
- iOS Data Protection covers the database and relevant SQLite sidecar files; Android database files remain application-private. Failure to establish the required protected path fails closed rather than writing calendar data to an unapproved location.
- Cache namespace changes and logout cancel collectors before transactional purge/switch so stale private data cannot be emitted into the next authenticated session.
- Offline save/delete produces no optimistic success, no durable queue record, and no hidden retry. The editor can retain its in-memory draft only for the current native presentation lifecycle.
- Timezone formatting failures use safe explicit fallbacks without rewriting stored event timezone or all-day identity.

## Alternatives Considered

- Putting SQLDelight, cache, or synchronization policy in each native ViewModel was rejected because it duplicates business logic and violates the thin-native-client direction.
- Putting database and cache policy inside shared/mobile-sdk was rejected because that module is the transport and wire boundary; shared/mobile-data is the established reusable business/data layer exported to native clients while the SDK repository remains stateless.
- Using ad hoc platform snapshot files or preference blobs was rejected because SQLDelight provides one shared schema, migrations, transactions, observable queries, LRU metadata, testability, and a cleaner future evolution path.
- Using only the last exact filtered response as cache was rejected because persisted filters and offline filter changes require an unfiltered authorized month snapshot.
- Normalizing every event field and tag into a broad offline-first relational model was deferred because this story needs complete bounded read snapshots, not offline mutation or arbitrary local data mining. SQLDelight migrations allow later normalization without changing the native consumer boundary.
- Adding a new backend group/tag catalog was rejected because current event metadata and visible-month derivation satisfy this refresh without a new taxonomy lifecycle.
- Treating Maya/Jordan as tags or groups was rejected because it would misrepresent unsupported household-member ownership.
- Implementing persistent event colors was rejected because the event contract has no color identity; existing token accents may communicate supported scope, importance, selection, and state only.
- Shrinking the desktop reference sidebar into the mobile viewport was rejected in favor of a native sheet/drawer and selected-day agenda.
- Reusing the chat OutboundCache for calendar writes was rejected for this story because it is VM-owned, in-memory, and chat-deduplication-specific; offline calendar mutation is deferred without declaring a future synchronization approach impossible.
- Application-level SQLCipher was not selected because the approved cache threat boundary relies on OS-protected app-private storage and account/backend isolation. SQLCipher and cross-platform key management can be shaped separately if the threat model changes.
