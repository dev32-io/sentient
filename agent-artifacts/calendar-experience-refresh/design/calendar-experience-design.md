# Cross-platform calendar experience design

## Design Goal

Present one coherent, accessible calendar experience across web, Android, and iOS by adapting the committed Sentient calendar handoffs into existing production design systems, preserving calendar V2 authority, applying Google-style responsive behavior on narrow web, and consolidating mobile persistence and business logic in shared KMP.

## Chosen Approach

- Use this reference order: reviewed story decisions; sentient-design/HANDOFF.md calendar and design-system sections; sentient-design/brand-spec.md; running sentient-design/design/web/calendar.html through components/web/sentient-web.js; running sentient-design/design/mobile/calendar.html through components/mobile/sentient-mobile.js; existing production tokens and reusable components. Calendar V2 remains authority for data, security, time, recurrence, identity, and mutation semantics.
- Treat sentient-design as committed WIP adaptation evidence, not code to import wholesale or a request to rebuild production design systems. Production calendar code reuses existing CSS tokens/primitives, Compose theme/components, SwiftUI theme/components, and shared mobile architecture.
- Where WIP prose and runtime disagree, use the observed running calendar unless a reviewed story decision supersedes it. The web event preview is therefore an anchored popover rather than an always-reserved preview rail. Reviewed Google-style narrow-web behavior supersedes the prototype's hidden controls and forced horizontal scrolling.
- Implement Day, Week, Month, and Year as explicit projections over one selected anchor date and active filter set. Today and previous/next operate by the active interval; view and filter preferences persist locally.
- Roomy web follows the observed reference baseline: sticky product top bar, approximately 244px filter sidebar, flexible primary canvas, anchored preview popover, and floating Day/Week/Month/Year bar. Exact values map onto existing production tokens and shell geometry rather than duplicating prototype CSS literals.
- At the sidebar-collapse breakpoint, remove the sidebar layout column Google-style but re-home Add Event and active filters into a compact in-flow toolbar or anchored filter popover. Do not make controls unreachable and do not replace Month/Week with the native agenda composition.
- At narrow web widths, Month and Week remain seven equal minmax(0,1fr) columns inside the content viewport. Remove the prototype's 680px month minimum and 116px week-column minimum. No page-level horizontal overflow is allowed.
- Progressively compact narrow-web event representation: retain title/time pills where space supports them, hide secondary time metadata next, truncate with accessible full labels, then use semantic dots and +N overflow. Every event remains reachable through day overflow or preview; visual compaction never discards data.
- Use the observed web preview behavior: event buttons open a paper-surface popover positioned right, left, or below and clamped within the viewport. Bound popover height with internal scrolling at small viewports. Opening transfers focus into the dialog; Escape, close, and safe outside click restore the trigger.
- Use the existing accessible web Dialog for Add/Edit while matching the handoff's modal treatment. Open on the first field, preserve drafts on typed failure, and restore the opener on close.
- Native Android and iOS follow the dedicated mobile handoff, not web breakpoints: 58px-style top bar, Terra Add action, heading/date controls, full-bleed horizontal scope and tag rails, compact view canvas, agenda-first event rows, floating four-view bar, and preview/editor bottom sheets.
- Implement native view semantics exactly: Month has 42 cells and up to three semantic indicators; selecting a Month date enters Day. Week has seven equal dates and remains Week when anchor selection changes. Day renders focused agenda without an empty canvas shell. Year renders all twelve complete month summaries and supports intentional month selection.
- Keep one native scroll region beneath fixed top controls; reserve enough bottom content inset so event rows clear the floating view bar. Keep the bar above home indicators and system gesture areas. Sheets use bounded height, safe-area padding, and internal scrolling.
- Match interaction geometry from the mobile reference using production tokens: 16px-style horizontal content inset, 44px minimum primary controls and scope chips, 46px view controls, 48px sheet actions, compact visual tag chips with at least 44px effective hit targets, and 64px-style agenda rows.
- Match canonical motion roles using existing tokens: fast approximately 150ms feedback/scrim transitions, normal approximately 250ms sheet/state transitions, subtle press scale, tonal translucent floating surfaces with blur/elevation, and no decorative competing motion. Reduced motion reduces nonessential animation to immediate state changes.
- Do not copy prototype defects: hidden dialogs remain inert and absent from accessibility; overlays have names/descriptions and focus containment; view/date/filter states are announced; mobile Back and web Escape dismiss; focus restores; Year includes days 29–31; fixed fixture dates/status values are replaced by real state.
- Map prototype scope/persona labels and sample colors only onto supported semantics. Product controls expose private, household, authorized all, groups, tags, importance, and search. Place, fixed reminder text, member calendar ownership, Routines source, and hard-coded persona colors remain prototype-only.
- Explicitly request read scope all for the primary combined view, aggregate continuation pages for the complete unfiltered visible interval, derive facet options from that data, and apply interactive filters locally.
- Use exact V2 mutation commands for event and recurrence operations, including scope, mutation scope, original start, and expected revision. Preserve typed conflict and authorization outcomes through the UI.
- Keep CalendarHttpClient and the SDK repository as stateless wire/transport boundaries. Own calendar database, cache, observation, filtering, revalidation, pagination, prefetch, and freshness policy in shared/mobile-data commonMain and export that shared KMP surface to native clients.
- Add a SQLDelight-backed KMP SQLite database to shared/mobile-data. Shared code owns schema, migrations, typesafe queries, transactions, observable query flows, serialization, namespace rules, and retention policy.
- Persist complete unfiltered month snapshots rather than partial pages. Cache rows are keyed by authenticated account/backend namespace plus month window and timezone and include fetched and last-accessed metadata. Persist account/backend-scoped calendar view/filter preferences in the same shared database.
- Expose one shared observable mobile calendar state. SQLDelight query flows, preferences, revalidation status, and local projections combine into StateFlow. Native ViewModels send window and interaction intents and collect state; they do not coordinate database reads, remote calls, or prefetch jobs.
- Use AndroidSqliteDriver in app-private storage and NativeSqliteDriver in iOS Application Support with Data Protection. Rely on OS-protected app-private storage rather than SQLCipher for this story.
- Apply stale-while-revalidate behavior: emit SQLDelight cache first, automatically revalidate, atomically store complete fresh data, and emit query updates without clearing valid content. Prefetch previous/current/next months, coalesce equivalent requests, cancel obsolete foreground work, and retain twelve recently viewed months by transactional LRU.
- Treat offline mutations as deferred. Offline native UI browses cached intervals and filters locally but disables save/delete with explicit connection-required feedback and creates no queue record.

## Verification Boundaries

- Treat the committed design pages as executable visual references. Serve them locally and compare production behavior; do not use their in-memory event arrays as product evidence.
- Web visual checkpoints: 1440x1000 and 1024x900 roomy/sidebar layouts; 768x900 Google-style collapsed sidebar with reachable compact controls; 390x844 shrink-to-fit seven-column calendar with no page overflow. Compare Day/Week/Month/Year, filters, preview, editor, floating bar, Dusk hierarchy, and motion.
- Native visual checkpoints: 390x844 and 430x932 for Android and iOS. Compare horizontal filters, Month/Week/Day/Year, agenda rows, floating bar, preview sheet, editor sheet, scrolling clearance, safe areas, Dusk hierarchy, and motion.
- Reference Playwright observations document prototype corrections: at 390px the web runtime currently forces a 680px grid and preview overflow; mobile currently has overlay focus/inert gaps, tag hit targets below 44px, incomplete Year dates, and a device-height strip. Production evidence must demonstrate these are corrected.
- Stable projection tests cover locale-aware Day/Week/Month/Year generation, complete Year dates, selected/current/outside states, overflow, chronological agenda grouping, filter intersection, facet retention, and narrow event compaction.
- Web component/service tests cover explicit all-scope reads, continuation aggregation, all four views, preference restoration, sidebar-collapse state continuity, no horizontal overflow, accessible preview positioning/focus, Dialog editor behavior, exact mutations, and conflict states.
- Shared mobile-data SQLDelight tests cover schema/migration, complete-window transactions, observable emissions, preference persistence, namespace isolation, cache-first behavior, automatic revalidation, coalescing, pagination, prefetch, LRU, network fallback, and no offline mutation record.
- Shared tests prove failed/cancelled page aggregation never replaces complete cache and failed transactions expose no partial snapshot.
- Android tests create real AndroidSqliteDriver in app-private test storage; iOS tests create NativeSqliteDriver, verify Application Support/Data Protection, and exercise migration/open/close.
- Android/iOS ViewModel tests prove thin state collection and intents without duplicate database/call management. UI tests cover native controls, accessibility, filters, sheets, freshness, and disabled offline mutation.
- Accessibility verification covers keyboard and screen-reader traversal, modal containment/restoration, full-date/today/selected semantics, live filter/view updates, Dynamic Type/font scale, 44px targets, reduced motion, contrast, and safe areas.
- Calendar V2 integration tests remain authority for temporal normalization, effective occurrences, paging, role visibility, conflicts, and recurrence mutations.
- The approved E2E matrix verifies touched user journeys on the real local stack with disposable principals and synthetic content. Production is never mutated.
- Run narrow package checks while iterating, affected package checks, and git diff --check.

## Components and Interfaces

- Committed reference surfaces: sentient-design/HANDOFF.md, brand-spec.md, design/web/calendar.html, components/web/sentient-web.js, design/mobile/calendar.html, and components/mobile/sentient-mobile.js. They are read-only comparison inputs during production implementation.
- Reusable production calendar presentation primitives per platform: CalendarScaffold, DateNavigation, FloatingViewBar, DayView, WeekGrid, MonthGrid, YearGrid, DayCell, EventIndicator, OverflowControl, AgendaSection, AgendaRow, FilterControls, EventPreview, EventEditor, recurrence controls, mutation-scope chooser, freshness notice, and empty/error/conflict presentations.
- Web CalendarWorkspace owns the responsive sidebar/canvas structure. CalendarFilterSidebar is present at roomy widths; CalendarCompactControls preserves Add Event and filters after Google-style collapse. CalendarCanvas never swaps to native mobile composition solely because viewport width decreases.
- Web EventPreview uses an anchored accessible popover/dialog positioning utility; EventEditor uses existing accessible Dialog infrastructure and shared form primitives.
- Shared calendar projection utilities generate locale-aware day/week/month/year cells, chronological agenda sections, event compaction/overflow, selected/today/outside states, and facet options from complete occurrences.
- Shared mobile CalendarExperience owns visible-window observation, persisted filters, projections, pagination aggregation, stale-while-revalidate, request coalescing, adjacent prefetch, freshness, and LRU policy.
- CalendarDatabase is SQLDelight-generated in shared/mobile-data. Its cache table stores complete month snapshots and freshness/LRU metadata; its preferences table stores account/backend-scoped presentation state.
- CalendarCacheStore wraps SQLDelight transactions and observable queries; SdkCalendarRepository remains stateless and remote-only.
- CalendarDatabaseDriverFactory is the narrow platform seam. Android supplies Context-backed AndroidSqliteDriver; iOS supplies Application Support-backed NativeSqliteDriver and file-protection setup.
- Authenticated mobile session scope owns database namespace, CalendarExperience, collectors, and cancellation lifecycle. Logout/account/backend replacement cancels observation before purging or switching namespace.
- Android CalendarViewModel collects shared StateFlow and translates native intents; Compose renders thin components and platform date/time controls.
- iOS CalendarViewModel consumes SKIE async sequences directly, owns/cancels collection tasks, and translates SwiftUI intents without a Combine bridge or duplicate repository state.
- Existing calendar V2 REST handler, temporal semantics, visibility enforcement, effective occurrence projection, pagination, and mutation services remain authoritative backend boundaries.

## Data and Control Flow

- Calendar opens on current Month, restores persisted view/filter/anchor preferences, and starts a combined authorized read for the visible interval.
- Web loads the complete unfiltered interval with explicit scope all and follows continuation cursors. Shared web projections render the active Day/Week/Month/Year view and apply local filters.
- At roomy web widths, sidebar filters update the same projection. At narrow widths, Google-style compact controls update identical state; no separate narrow-web calendar state or fetch path exists.
- Selecting a web event opens a viewport-aware anchored preview. Preview Edit opens the complete editor with selected occurrence metadata. Close paths restore the originating event.
- On native session creation, platform code supplies the SQLDelight driver; shared code opens CalendarDatabase, establishes account/backend namespace, and exposes CalendarExperience.
- Native Calendar opens by observing SQLDelight preferences and the visible month cache. Cached complete data emits immediately, then shared code revalidates the visible month and prefetches adjacent months.
- Complete authorized REST pages are aggregated before one transaction replaces the window, updates freshness/access metadata, and evicts excess LRU rows. Incomplete results never replace complete cache.
- SQLDelight query invalidation recomputes shared CalendarExperienceState, naturally reaching Android collectors and iOS SKIE consumers without native follow-up fetches.
- Shared native projections feed compact calendar summaries, agenda rows, filters, view state, and freshness. Selecting Month date changes shared view to Day; view bar and filters persist through the same preference boundary.
- Add/Edit submits online V2 commands through shared intent boundaries. Success invalidates affected intervals and revalidates; failure preserves draft and displayed data.
- Recurring edit/delete selects mutation scope and targets event ID, original start, scope, and revision. Conflict preserves current data and supports reread/review; delete confirms before mutation.
- Network failure retains cache and filters, updates freshness, and disables online-only mutation. Connectivity recovery or explicit refresh uses the same shared revalidation path.
- Logout/backend/account replacement cancels observers/work and transactionally purges or switches namespace before exposing the next session.

## Failure and Recovery

- Prototype visual defects are not accepted implementation behavior. Reference comparison must account for documented corrections rather than reproduce hidden controls, horizontal overflow, incomplete focus semantics, incomplete year dates, or inaccessible overlays.
- Narrow web never loses Add Event or filters when the sidebar collapses. If compact controls cannot render, keep the last usable state and surface an accessible control error rather than hiding functionality.
- Month and Week use shrink-to-fit columns. Long titles truncate visually with accessible full names; dense days expose +N or day-detail access rather than clipping or horizontal page scrolling.
- Preview positioning tries preferred side then alternatives, clamps to viewport, and uses internal scrolling. It never extend beyond the reachable viewport as the prototype does at 390px.
- Hidden overlays are inert and not present in the accessibility tree. Open overlays receive focus and contain modal navigation. Close, Escape/native Back, cancel, success, and safe scrim dismissal restore a meaningful origin.
- Cached content is never replaced by an empty Loading envelope. Loading without cache shows accessible loading; loading with cache shows content plus refreshing status.
- Network failure is distinguished from authorization, forbidden, malformed, or conflict outcomes. Cache fallback applies to connectivity failure, not to hide security/contract errors.
- Incomplete pagination never replaces complete SQLDelight cache. Existing snapshots remain stale and the user receives retryable status.
- Uncached offline intervals show specific unavailable-offline state and retain navigation to cached intervals.
- Stale revision never retries blindly. Recurrence conflict preserves draft and series state and explains corrective action.
- Unauthorized/hidden targets remain non-disclosing; UI cannot infer hidden identifiers, counts, groups, or tags.
- Prefetch failure does not fail the visible interval and logs only sanitized structural status.
- SQLDelight migrations are explicit and tested on Android/iOS. Migration, decode, or transaction failure exposes no partial snapshot and falls back to remote when available.
- Database I/O stays off the UI thread. Driver shutdown follows authenticated session disposal. Protected path failure fails closed.
- Namespace changes and logout cancel collectors before transactional purge/switch so stale private data cannot emit into the next session.
- Offline save/delete produces no optimistic success, queue record, or hidden retry. In-memory draft retention is limited to the current editor lifecycle.
- Timezone formatting failures use safe fallbacks without rewriting event timezone or all-day identity.

## Alternatives Considered

- Replacing narrow web with a generic mobile filter drawer and selected-day agenda was rejected. Industrial calendar practice collapses the sidebar while keeping the web calendar canvas and active view responsive.
- Copying the prototype's 680px minimum month grid or 116px week columns was rejected because it creates horizontal overflow instead of shrink-to-fit behavior.
- Keeping the sidebar physically visible at every width was rejected because Google-style collapse preserves calendar space and moves utilities into compact controls.
- Treating HANDOFF.md's preview-rail wording as an always-reserved layout column was rejected because the running canonical web calendar demonstrates an anchored preview popover and the user selected industrial responsive practice.
- Importing sentient-design runtime CSS/JavaScript directly or rebuilding all production tokens/components was rejected because the folder is WIP adaptation guidance and the repository already has reviewed design systems.
- Copying prototype Maya/Jordan/Routines calendars, place, fixed reminders, local arrays, or persona colors was rejected because those semantics are unsupported.
- Putting SQLDelight/cache/synchronization policy in native ViewModels was rejected because it duplicates business logic and violates thin-native clients.
- Putting database/cache policy inside shared/mobile-sdk was rejected because that module is the transport/wire boundary; shared/mobile-data is the reusable business/data layer exported to native clients.
- Using ad hoc platform snapshot files was rejected because SQLDelight provides shared schema, migrations, transactions, observable queries, LRU metadata, and testability.
- Using only the last exact filtered response was rejected because offline filter changes require an unfiltered authorized snapshot.
- Normalizing every event field into an offline-first relational model was deferred because this story needs bounded read snapshots, not offline mutation. SQLDelight migrations preserve the evolution path.
- Adding a backend group/tag catalog was rejected because visible-interval metadata satisfies this refresh.
- Reusing chat OutboundCache for calendar writes was rejected for this story because it is VM-owned, in-memory, and chat-deduplication-specific; offline mutation remains deferred.
- Application-level SQLCipher was not selected because the approved threat boundary relies on OS-protected app-private storage and account/backend isolation.
