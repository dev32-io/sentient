# Cross-platform calendar experience E2E matrix

## Cases

### E2E-001 — Adult browses the family calendar on web, Android, and iOS.

**Classification:** golden-path

#### Setup

- Disposable adult with timed, all-day, recurring, adjacent-month, and overflowing-day events.

#### Actions

- Open Calendar; navigate previous/next; return to Today; select a mini-calendar date.

#### Expected Outcomes

- Correct month grid, localized weekday structure, current/selected-day states, event pills, adjacent dates, and overflow; no first-page truncation.

#### Evidence

- Approved checkpoint ID: CAL-UX-001.
- Visible client state and disposable REST fixtures.

#### Safety

- Local stack only; remove disposable calendar data.

### E2E-002 — User changes calendar presentation.

**Classification:** golden-path

#### Setup

- Visible month containing events across several dates.

#### Actions

- Switch Month to Agenda and back; on mobile select a populated date.

#### Expected Outcomes

- Agenda is chronological and date-grouped; compact mobile month exposes the selected-day agenda; selected month/date remains stable.

#### Evidence

- Approved checkpoint ID: CAL-UX-002.
- User-visible view state on each client.

#### Safety

- Synthetic event content only.

### E2E-003 — Adult filters a combined calendar and returns later.

**Classification:** golden-path

#### Setup

- Private and household events with multiple groups, tags, and importance levels.

#### Actions

- Select filters and search; leave Calendar; reopen it; navigate to a month without one selected facet.

#### Expected Outcomes

- Results match all active filters; preferences survive reopening; selected facets remain removable when absent from the current month.

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

- Open Add Event; complete supported metadata; save private and household examples.

#### Expected Outcomes

- Validation is accessible; created events appear on correct dates with correct timezone/all-day behavior and survive refresh.

#### Evidence

- Approved checkpoint ID: CAL-UX-004.
- Visible event and authenticated REST reread.

#### Safety

- Delete created events afterward.

### E2E-005 — Adult modifies one occurrence, following occurrences, and an entire series.

**Classification:** edge

#### Setup

- Disposable recurring series with known slots.

#### Actions

- Edit and delete using each applicable scope.

#### Expected Outcomes

- Explicit scope prompt; selected occurrence identity is preserved; neighboring/prefix/successor behavior matches REST V2 semantics.

#### Evidence

- Approved checkpoint ID: CAL-UX-005.
- Visible calendar plus reread of disposable series segments.

#### Safety

- Isolated synthetic series and complete cleanup.

### E2E-006 — Two clients edit from the same revision.

**Classification:** recovery

#### Setup

- Disposable event loaded by two local clients.

#### Actions

- Save from client A, then save stale changes from client B.

#### Expected Outcomes

- Client B does not overwrite A; conflict UI explains the change and supports reread/review.

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

- Open combined calendar; inspect filters; attempt an unauthorized household mutation.

#### Expected Outcomes

- Adults-only events and counts are not exposed; restricted mutation fails safely without revealing hidden data.

#### Evidence

- Approved checkpoint ID: CAL-UX-007.
- Child-visible UI and sanitized typed failure.

#### Safety

- Disposable principals only.

### E2E-008 — Returning Android/iOS user opens Calendar with cached data.

**Classification:** golden-path

#### Setup

- Populate cache from an earlier successful online visit, then relaunch.

#### Actions

- Open Calendar while online with delayed REST response.

#### Expected Outcomes

- Cached month appears before the remote response; revalidation updates the same UI stream without explicit native fetch orchestration or blank loading replacement.

#### Evidence

- Approved checkpoint ID: CAL-UX-008.
- User-visible sequence plus sanitized cache/freshness state.

#### Safety

- Synthetic content; no content-bearing logs.

### E2E-009 — User opens Calendar without connectivity.

**Classification:** edge

#### Setup

- Cached current and adjacent months with persisted filters; network disabled locally.

#### Actions

- Open Calendar; navigate cached months; apply filters.

#### Expected Outcomes

- Cached events remain usable, offline/freshness status is visible, and filtering works.

#### Evidence

- Approved checkpoint ID: CAL-UX-009.
- Android/iOS UI under local network isolation.

#### Safety

- Restore connectivity after the case.

### E2E-010 — Offline user navigates beyond cached data and attempts mutation.

**Classification:** failure

#### Setup

- Mobile offline with a bounded cache.

#### Actions

- Open an uncached month; attempt Add/Edit/Delete.

#### Expected Outcomes

- Specific offline-unavailable state; mutation controls do not imply success and explain that connection is required.

#### Evidence

- Approved checkpoint ID: CAL-UX-010.
- User-visible mobile state.

#### Safety

- No queued mutation is created.

### E2E-011 — Mobile connectivity returns.

**Classification:** recovery

#### Setup

- Calendar showing stale cached data offline.

#### Actions

- Restore local connectivity while Calendar remains open.

#### Expected Outcomes

- Shared layer revalidates, updates events/freshness naturally, and asynchronously caches adjacent months without disrupting the visible month.

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

- User A’s events, facet names, counts, and preferences are absent; no cross-account cache fallback occurs.

#### Evidence

- Approved checkpoint ID: CAL-UX-012.
- User B-visible state and cache namespace inspection without content capture.

#### Safety

- Disposable users; purge test storage.

### E2E-013 — User views and edits all-day and timed events across timezone/DST boundaries.

**Classification:** edge

#### Setup

- Synthetic all-day event and timed recurrence anchored in a known timezone.

#### Actions

- View from a different device timezone; edit an occurrence without changing its intended wall-clock anchor.

#### Expected Outcomes

- All-day date remains fixed; timed display follows the device locale; persisted event timezone and recurrence identity remain correct.

#### Evidence

- Approved checkpoint ID: CAL-UX-013.
- Visible values and sanitized REST temporal fields.

#### Safety

- Synthetic dates only.

## Scope

- Web, Android, and iOS month, agenda, navigation, filtering, event-management, recurrence, conflict, permission, temporal, responsive, and accessibility behavior
- Android and iOS cache-first, offline-browse, automatic revalidation, adjacent-prefetch, and account-isolation behavior
- Canonical visual reference: design-ref/calendar.png

## Safety

- Run against the real local stack only.
- Never execute calendar mutations or smoke tests against production.
- Use disposable users/events and deterministic cleanup.
- Screenshots may contain only synthetic content.
- Logs and diagnostics may contain identifiers, types, counts, sizes, freshness, and transitions—but no event text, filters, descriptions, or payloads.
