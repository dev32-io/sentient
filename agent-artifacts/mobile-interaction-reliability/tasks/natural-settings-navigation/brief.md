# Task Brief: Make settings Back follow the actual page stack

## Contribution Goal

Every settings Back action returns to the immediately previous visible page, including clone editor → filtered Fish results → Voice → Settings → Chat, with route-scoped state preserved.

## Boundary — Included

- Typed Android and iOS route entries for nested settings pages/editors
- Fish browser → clone editor push/pop with retained query, filters, sort, loaded results, and scroll position
- Unified top-bar, system, and gesture Back behavior
- Representative route-stack tests and unattended navigation flows

## Required Work

- 1. Instrument or unit-test the current Android NavController and iOS NavigationStack/path sequence for Chat → Settings → Voice → Fish results → clone editor, including top-bar Back and platform Back/gesture. Identify the concrete route loss/reset that produces the jump.
- 2. Represent every visible nested page/editor that needs independent Back behavior as a real typed stack entry. In particular, push the Fish clone editor above the Fish results page instead of replacing the results route or routing directly from Settings root.
- 3. Keep the Fish browser ViewModel/state owned by its results route so query, facets, sort, paging, loaded entries, and scroll position remain alive underneath the editor. Pass only the selected entry identity/data needed by the child; do not duplicate catalog state.
- 4. Make Android top-bar Back, system BackHandler/NavController Back, and iOS top-bar/native swipe Back invoke the same one-entry stack pop. Remove direct navigation to Settings root or hard-coded parent routes from nested pages.
- 5. Audit similar settings subpages and transient editors for the same reset/direct-parent pattern. Apply the stack invariant where touched, without redesigning settings information architecture or persisting transient state across process death.
- 6. Preserve fresh-chat host route identity and authenticated UserSession/ChatComponent lifetime changes already integrated from the predecessor task.
- 7. Add pure/router tests or controllable navigation-host tests on both platforms for exact stack sequences, child editor cancel/back, native/custom Back equivalence, and default-state recovery after process recreation.
- 8. Update Fish/settings Maestro flows and accessibility ids so an unattended agent can apply filters, scroll results, open the clone editor, Back to the same results, then Back through Voice, Settings, and Chat without cloning or mutating settings.
- 9. Run Android, iOS, and diff checks.

## Integration Expectation

Deliver this contribution for integration in stage state-and-navigation.

## Context

- Android and iOS top-level settings routes nominally pop one entry, but Fish browse and clone editor are currently two VM states inside one route rather than two navigation entries.
- The reported runtime behavior jumps from a nested cloning page to the Settings root. Static code does not prove the path that produced it, so the task must pin actual stack construction and all back affordances before correcting it.
- The fresh-chat task changes centralized mobile hosts, and the Fish filter task establishes the parent browser state this task must retain; consume those integrated boundaries rather than overwriting them.
- No destination may hard-code a presumed parent. Actual navigation history is authoritative.

## Boundary — Excluded

- Hard-coded parent destinations
- Changing Fish filter semantics or clone behavior
- Persisting navigation/filter state across process death
- Redesigning Settings categories or presentation
- Production testing

## Interfaces and Dependencies

- Consumes the integrated Android AppNavHost/SettingsNav and iOS UserSessionHost/Route boundaries plus the route-scoped Fish browser state from fish-filter-parity.
- Produces typed nested route entries and one-entry pop behavior shared by every Back affordance.
- Proof seam: exact route-sequence tests and agent-driveable E2E-008/E2E-009 paths with restored visible filter/scroll state.
