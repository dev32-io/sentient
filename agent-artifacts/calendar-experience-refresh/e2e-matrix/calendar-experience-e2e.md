# Cross-platform calendar experience E2E matrix

## Cases

### E2E-001 — Adult browses the family calendar on web, Android, and iOS.

**Classification:** golden-path

#### Setup

- Disposable adult with timed, all-day, recurring, adjacent-interval, and overflowing-day events.

#### Actions

- Open Calendar; switch through Day, Week, Month, and Year; navigate previous/next in each view; return to Today; select dates and month summaries.

#### Expected Outcomes

- Each view presents the correct interval and navigation step; Month has 42 locale-aware cells, Week has seven columns, Year contains complete months, current/selected states remain clear, event indicators and +N overflow are reachable, and no first-page truncation occurs.

#### Evidence

- Approved checkpoint ID: CAL-UX-001.
- Visible client state, accessibility state, and disposable REST fixtures.

#### Safety

- Local stack only; remove disposable calendar data.

### E2E-002 — User changes and restores calendar presentation.

**Classification:** golden-path

#### Setup

- Visible month containing events across several dates.

#### Actions

- Switch Day, Week, Month, and Year; on mobile select a Month date; leave Calendar and reopen it.

#### Expected Outcomes

- View bar selection is visible and accessible; Day and agenda projections are chronological; mobile Month selection enters focused Day; selected view/date persist across reopening without changing event data.

#### Evidence

- Approved checkpoint ID: CAL-UX-002.
- User-visible view state on each client and restored local preference state.

#### Safety

- Synthetic event content only.

### E2E-003 — Adult filters a combined calendar and returns later.

**Classification:** golden-path

#### Setup

- Private and household events with multiple groups, tags, and importance levels; no prototype member-calendar semantics.

#### Actions

- Select supported calendar scopes, groups, tags, importance, and search; leave Calendar; reopen it; navigate to an interval without one selected facet.

#### Expected Outcomes

- Results match all active supported filters; preferences survive reopening; selected facets remain removable when absent; hidden content does not contribute labels or counts.

#### Evidence

- Approved checkpoint ID: CAL-UX-003.
- Visible filtered results and restored controls.

#### Safety

- Account-scoped disposable preferences are cleared during cleanup.

### E2E-004 — Authorized adult creates all-day, timed, and recurring events.

**Classification:** golden-path

#### Setup

- Disposable adult online.

#### Actions

- Open Add Event from roomy and collapsed web controls and from mobile; complete supported metadata; save private and household examples.

#### Expected Outcomes

- Web modal and mobile sheet match the canonical adaptation, focus the first field, validate accessibly, restore focus on close, and show created events on correct dates with correct timezone/all-day behavior after refresh.

#### Evidence

- Approved checkpoint ID: CAL-UX-004.
- Visible event, overlay focus behavior, and authenticated REST reread.

#### Safety

- Delete created events afterward.

### E2E-005 — Adult previews, edits, and deletes recurrence scopes.

**Classification:** edge

#### Setup

- Disposable recurring series with known slots.

#### Actions

- Open event preview; edit and delete using each applicable occurrence, following, and entire-series scope.

#### Expected Outcomes

- Web preview stays viewport-bound; mobile preview uses a bounded sheet; explicit mutation-scope prompt appears; selected occurrence identity is preserved; neighboring/prefix/successor behavior matches REST V2; overlays close and restore focus.

#### Evidence

- Approved checkpoint ID: CAL-UX-005.
- Visible calendar, overlay accessibility state, and reread of disposable series segments.

#### Safety

- Isolated synthetic series and complete cleanup.

### E2E-006 — Two clients edit from the same revision.

**Classification:** recovery

#### Setup

- Disposable event loaded by two local clients.

#### Actions

- Save from client A, then save stale changes from client B.

#### Expected Outcomes

- Client B does not overwrite A; conflict UI explains the change, preserves relevant draft intent, and supports reread/review.

#### Evidence

- Approved checkpoint ID: CAL-UX-006.
- Visible conflict state and authoritative event revision.

#### Safety

- No production or personal events.

### E2E-007 — Child browses and attempts restricted behavior.

**Classification:** failure

#### Setup

- Disposable child and adult with household events of both visibility levels.

#### Actions

- Open combined calendar; inspect supported filters; attempt an unauthorized household mutation.

#### Expected Outcomes

- Adults-only events, facets, and counts are not exposed; restricted mutation fails safely without revealing hidden data.

#### Evidence

- Approved checkpoint ID: CAL-UX-007.
- Child-visible UI and sanitized typed failure.

#### Safety

- Disposable principals only.

### E2E-008 — Returning Android/iOS user opens Calendar with SQLDelight-cached data.

**Classification:** golden-path

#### Setup

- Populate the account/backend-scoped cache from an earlier successful online visit, then relaunch.

#### Actions

- Open Calendar while online with delayed REST response.

#### Expected Outcomes

- Cached interval and persisted preferences appear before the remote response; revalidation atomically updates the same shared UI stream without explicit native fetch orchestration or blank loading replacement.

#### Evidence

- Approved checkpoint ID: CAL-UX-008.
- User-visible sequence plus sanitized cache/freshness and database-namespace state.

#### Safety

- Synthetic content; no content-bearing logs.

### E2E-009 — User opens Calendar without connectivity.

**Classification:** edge

#### Setup

- Cached current and adjacent months with persisted filters; network disabled locally.

#### Actions

- Open Calendar; navigate cached Day, Week, and Month intervals; apply filters.

#### Expected Outcomes

- SQLDelight-cached events remain usable, offline/freshness status is visible, filters work locally, and native calendar composition remains intact.

#### Evidence

- Approved checkpoint ID: CAL-UX-009.
- Android/iOS UI under local network isolation.

#### Safety

- Restore connectivity after the case.

### E2E-010 — Offline user navigates beyond cached data and attempts mutation.

**Classification:** failure

#### Setup

- Mobile offline with a bounded twelve-month cache.

#### Actions

- Open an uncached interval; attempt Add/Edit/Delete.

#### Expected Outcomes

- Specific offline-unavailable state appears; mutation controls do not imply success, explain that connection is required, and create no durable mutation record.

#### Evidence

- Approved checkpoint ID: CAL-UX-010.
- User-visible mobile state and sanitized database inspection.

#### Safety

- No queued mutation is created.

### E2E-011 — Mobile connectivity returns.

**Classification:** recovery

#### Setup

- Calendar showing stale SQLDelight-cached data offline.

#### Actions

- Restore local connectivity while Calendar remains open.

#### Expected Outcomes

- Shared layer revalidates, atomically updates database and freshness, naturally updates UI, and asynchronously caches adjacent months without disrupting the visible interval.

#### Evidence

- Approved checkpoint ID: CAL-UX-011.
- Visible state transition and sanitized month/cache identifiers.

#### Safety

- No event text in diagnostics.

### E2E-012 — One user logs out and another authenticates.

**Classification:** failure

#### Setup

- User A has cached private and household calendar data and filters.

#### Actions

- Log out; authenticate as user B; open Calendar offline.

#### Expected Outcomes

- User A’s events, facet names, counts, preferences, and SQLDelight rows are unavailable; no cross-account or cross-backend cache fallback occurs.

#### Evidence

- Approved checkpoint ID: CAL-UX-012.
- User B-visible state and cache namespace inspection without content capture.

#### Safety

- Disposable users; purge test storage.

### E2E-013 — User views and edits all-day and timed events across timezone and daylight-saving boundaries.

**Classification:** edge

#### Setup

- Synthetic all-day event and timed recurrence anchored in a known timezone.

#### Actions

- View from a different device timezone; navigate all four views; edit an occurrence without changing its intended wall-clock anchor.

#### Expected Outcomes

- All-day date remains fixed; timed display follows device locale; persisted event timezone, original occurrence identity, and recurrence anchor remain correct.

#### Evidence

- Approved checkpoint ID: CAL-UX-013.
- Visible values and sanitized REST temporal fields.

#### Safety

- Synthetic dates only.

### E2E-014 — Calendar composition adapts faithfully across reviewed web and mobile viewports.

**Classification:** edge

#### Setup

- Use synthetic events that exercise normal, long-title, dense-day, filtered, preview, and editor states on the real local stack.

#### Actions

- Capture web at 1440x1000, 1024x900, 768x900, and 390x844; capture Android and iOS at approximately 390x844 and 430x932; exercise all four views, filters, preview, editor, scrolling, and reduced motion.

#### Expected Outcomes

- Roomy web matches the committed sidebar/canvas/popover/floating-bar reference; narrow web collapses the sidebar Google-style while retaining reachable Add Event and filters, seven-column shrink-to-fit Month/Week, and no page-level horizontal overflow; native matches horizontal filters, compact summaries, agenda rows, floating bar, safe-area-aware preview/editor sheets, and one-handed control sizing; prototype accessibility and overflow defects are corrected; reduced motion preserves state without animation.

#### Evidence

- Approved checkpoint ID: CAL-UX-014.
- Screenshots and semantic DOM/accessibility checkpoints from production compared with sentient-design/design/web/calendar.html and sentient-design/design/mobile/calendar.html.
- Documented intentional deviations for supported domain semantics and reviewed responsive corrections.

#### Safety

- Real local stack only; screenshots contain synthetic content; no prototype in-memory event behavior is used as product evidence.

## Scope

- Web, Android, and iOS Day, Week, Month, Year, navigation, filtering, preview, event-management, recurrence, conflict, permission, temporal, responsive, motion, and accessibility behavior
- Android and iOS SQLDelight cache-first, offline-browse, automatic revalidation, adjacent-prefetch, and account-isolation behavior
- Canonical adaptation references: sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html with sentient-design/components/web/sentient-web.js, and sentient-design/design/mobile/calendar.html with sentient-design/components/mobile/sentient-mobile.js
- Reviewed responsive correction: narrow web uses Google-style sidebar collapse and shrink-to-fit calendar views rather than prototype horizontal overflow or generic mobile substitution

## Safety

- Run against the real local stack only.
- Never execute calendar mutations or smoke tests against production.
- Use disposable users/events and deterministic cleanup.
- Screenshots may contain only synthetic content.
- Logs and diagnostics may contain identifiers, types, counts, sizes, freshness, and transitions—but no event text, filters, descriptions, or payloads.
- The sentient-design runtimes are visual/interaction comparison surfaces only; their hard-coded events and local mutations are not verification oracles.
