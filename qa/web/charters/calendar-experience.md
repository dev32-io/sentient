# Web calendar experience QA charter

This is the maintainable local-stack recipe for CAL-UX web evidence. It is an agent-driven Playwright MCP charter, not a checked-in Playwright test-runner project.

## Comparison authority

- Handoff: `sentient-design/HANDOFF.md`
- Brand: `sentient-design/brand-spec.md`
- Exact web reference entry: `sentient-design/design/web/calendar.html`
- Exact web reference runtime: `sentient-design/components/web/sentient-web.js`
- Reference server: `python3 -m http.server 8799 --directory sentient-design`
- Reference URL: `http://127.0.0.1:8799/design/web/calendar.html`
- Production URL under observation: `https://localhost/`

The reference runtime is comparison input only. Its in-memory events are never product evidence. Production mutations are prohibited.

## Local stack and fixture lifecycle

Start and inspect only the real local stack:

```sh
source scripts/env.sh
scripts/stack.sh up
scripts/stack.sh status
```

Create a unique run namespace through the directly invokable local-only adapter. It uses existing authenticated REST controls and returns only adult/child/event/occurrence IDs:

```sh
CALENDAR_E2E_ADMIN_USER_ID=... CALENDAR_E2E_ADMIN_PIN=... \
CALENDAR_E2E_ADULT_PIN=... CALENDAR_E2E_CHILD_PIN=... \
bun run calendar:fixture provision --target https://localhost:8888 --state /tmp/calendar-web-fixture.json
# After cache prime when recovery evidence needs a newly published sentinel:
bun run calendar:fixture seed-recovery --target https://localhost:8888 --state /tmp/calendar-web-fixture.json
# Guaranteed final step:
bun run calendar:fixture cleanup --target https://localhost:8888 --state /tmp/calendar-web-fixture.json
```

HTTPS requires the explicit local-only command and non-loopback targets are refused before credentials are read.

The final cleanup order is event IDs (reverse seed order), both calendar databases, then both disposable users. Do not print event content, descriptions, filter text, credentials, or mutation payloads. Stop the local stack after the run:

```sh
scripts/stack.sh down
```

Sanitized evidence belongs under `qa/web/evidence/calendar-e2e/<run-id>/<case-id>/`; only screenshots, DOM/focus geometry JSON, and structural notes are allowed.

## Viewport and state matrix

Capture every listed state at exactly these viewport sizes: `1440x1000`, `1024x900`, `768x900`, and `390x844`.

| State | Required observations |
| --- | --- |
| Day | Focused chronological agenda, selected/today labels, empty/loading/stale/error variants |
| Week | Seven equal columns, navigation, dense events, no page overflow |
| Month | 42 cells, outside/today/selected labels, timed/all-day indicators, `+N` overflow |
| Year | Twelve complete month summaries, dates 29/30/31, month navigation |
| Filters | Private/household/all, groups, tags, importance, search, active removal and persisted state |
| Preview | Anchored right/left/below placement, internal scroll, Escape/backdrop/close, focus restoration |
| Add/Edit | Explicit capability controls, all-day/timed timezone fields, recurrence scope, confirmation, conflict review |
| Dense/reduced motion | Full event access through overflow and `prefers-reduced-motion: reduce` without nonessential transitions |

For every viewport assert `document.documentElement.scrollWidth <= document.documentElement.clientWidth` and record the numeric widths. Month and Week must retain seven `minmax(0, 1fr)` columns at `390x844`.

## Playwright MCP recipe

1. Open `https://localhost/` and enter Calendar through the production route; never open the reference and use its data as a backend oracle.
2. Set each viewport in the matrix and capture a production screenshot named `<case>-production-<width>x<height>.png`.
3. Open the exact reference URL at the same viewport and capture `<case>-reference-<width>x<height>.png`; compare side by side against the committed reference files, documenting only the approved deviations: V2 all-scope semantics, 900px sidebar collapse, seven-column shrink-to-fit, complete Year dates, viewport-safe overlays, and corrected accessibility.
4. Exercise Day/Week/Month/Year, Today, previous/next, Month date selection, Year month selection, and view/filter announcements.
5. Exercise preview, overflow, Add/Edit, recurrence (`this_occurrence`, `this_and_following`, `entire_series`), delete confirmation, stale conflict reread, permission denial, child visibility, and timezone/all-day behavior using only the unique fixture IDs.
6. Collect semantic evidence: focused element before/after overlays, `aria-current`, `aria-pressed`, outside-month labels, live status text, `aria-expanded`, hidden-overlay absence, dialog containment/inert siblings, Escape/safe-backdrop dismissal, and computed target rectangles. This is DOM/keyboard evidence only and must not be described as an actual screen-reader run.
7. Set `prefers-reduced-motion: reduce`, repeat the relevant preview/editor/view transitions, and record that state communication remains while animation/transition durations collapse.
8. In a `finally` step delete fixture IDs/users/databases and stop the local stack. If cleanup fails, record sanitized IDs and structural reasons only.

## Checkpoints

- `CAL-UX-001`: four views, navigation, complete pagination, overflow, temporal identity
- `CAL-UX-002`: view/date preference restoration
- `CAL-UX-003`: supported filters and non-disclosing facet behavior
- `CAL-UX-004`: add private/household, all-day/timed/recurring, focus restoration
- `CAL-UX-005`: preview, edit/delete scopes, successor IDs, confirmation
- `CAL-UX-006`: stale revision conflict and reread/review
- `CAL-UX-007`: child/adults-only non-disclosure and typed permission state
- `CAL-UX-013`: timezone and DST/all-day identity
- `CAL-UX-014`: reference comparison, responsive geometry, no overflow, reduced motion

Residual limitation: semantic and keyboard inspection does not replace a real assistive-technology session; an actual screen-reader run is intentionally not a delivery gate for this WIP refresh.
