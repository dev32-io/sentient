# Task Brief: Bring web-equivalent Fish catalog filters to mobile

## Contribution Goal

Android and iOS Fish browsing provide the same title, language, gender, age, vibe, sort, active-state, and reset semantics as web while using the current mobile settings design language.

## Boundary — Included

- Canonical mobile Fish facet derivation, matching, sorting, and reset semantics
- Android and iOS filter state and current-design controls
- Client-side filtering of loaded/paged results alongside existing server title search
- Focused fixtures/tests and stable accessibility selectors for unattended E2E

## Required Work

- 1. Port the behavior of web fish-bucket.ts into a pure commonMain mobile helper/model: gender male/female, ordered ages young/middle-aged/old, case-normalized vibes, supported-language options, filter-active detection, OR-within-facet and AND-across-facet matching, popular/recent/A–Z sorting, canonical vibe toggling, and deterministic option ordering.
- 2. Add shared fixture tests using dirty mixed-case Fish data and timestamps to prove parity with the web semantics. Do not change the gateway Fish API or send facet parameters upstream; title remains the only server search input.
- 3. Extend Android FishCloneUiState/ViewModel and iOS VoiceFishViewModel with query, language, multi-select gender/age/vibe, sort, derived options/results, active-filter indication, and clear/reset. Preserve paging, id dedupe, preview, clone fields, and error handling.
- 4. Render the controls using existing mobile settings components, chips, selects, spacing, colors, typography, and accessibility conventions. Do not introduce a new visual system; handle empty option groups and no-match results cleanly.
- 5. Ensure load-more and new title-search results recompute options/results without losing compatible selections; reset restores unfiltered server ordering and default controls.
- 6. Keep filter state route-scoped and available for the later navigation task to restore after pushing/popping the clone editor. Do not hard-code navigation behavior in this task.
- 7. Add Android and iOS ViewModel/pure-state tests for combined facets, case normalization, sort, reset, paging, stale search response protection, empty matches, and filter state retention through selection/cancel.
- 8. Add stable test tags/accessibility identifiers and update the Fish mobile flow so an unattended agent can combine every filter and reset without cloning or exposing credentials.
- 9. Run shared data/SDK, Android, iOS, and diff checks.

## Integration Expectation

Deliver this contribution for integration in stage foundation.

## Context

- Both mobile Fish view-models currently implement debounced title search, paging, preview, selection, and clone only.
- The web authority is fish-bucket.ts plus FishClonePanel/FishToolbar: title is server-side, other facets are client-side over loaded entries, comparisons are case-insensitive, unsupported clone languages are excluded, age order is young/middle-aged/old, popular preserves server order, and recent/A–Z are client sorts.
- Native screen state remains route-scoped. A canonical pure commonMain helper should own taxonomy and matching so Swift and Kotlin do not drift, while native ViewModels own UI lifecycle and controls.

## Boundary — Excluded

- Changing Fish availability, import, cloning, preview, or local-TTS bundling
- Changing the web implementation
- Adding new server-side facet query parameters
- Implementing the settings navigation-stack fix
- Persisting Fish filters across process death
- Using production Fish credentials or performing a clone in filter E2E

## Interfaces and Dependencies

- Consumes FishVoiceEntry loaded by the existing fishBrowse(title,page) API and the canonical supported-language list.
- Produces a pure shared filter result/options contract and native route-scoped filter UI state.
- Proof seam: shared mixed-case fixtures, native ViewModel tests, and unattended Fish filter controls supporting E2E-007.
