# Oracles — web platform

This file declares which oracles the Explorer subagent should actively
check during every session on this platform. Built-in oracle
definitions live in the qa-session skill at
`${CLAUDE_SKILL_DIR}/oracles/{shared,web}.md`. Reference them by name
below.

## Inherits

- `shared` — cross-platform heuristics (FEW HICCUPPS, console errors,
  network errors, etc.)
- `web` — web-specific heuristics (tap-target size, viewport overflow,
  ARIA, etc.)

## Built-in oracles enabled

Comment out a line to disable that oracle for this platform.

- `shared.console-error-free`
- `shared.network-no-5xx`
- `shared.few-hiccupps.product-consistency`
- `shared.few-hiccupps.history`
- `shared.few-hiccupps.user-expectations`
- `shared.few-hiccupps.claims`
- `web.tap-target-min-44px`
- `web.viewport-no-horizontal-scroll`
- `web.aria-required-fields`
- `web.no-broken-images`
- `web.no-blank-render-after-3s`

## Project-specific oracles

Add oracles unique to this project below. Each entry needs a name,
what it checks, how to detect it, and a severity hint.

### example-no-stuck-loading-spinner
**Checks:** A loading spinner remains visible for more than 5 seconds
without other progress (text changing, new elements appearing).
**How:** After clicking any action that may take time, check whether a
visible loader is still present after 5 s; if yes, capture a screenshot
and log a `?` line with this oracle name.
**Severity:** minor — unless the spinner blocks content the user is
trying to see, in which case major.

### settings.apply-bar-only-when-dirty
**Checks:** The docked apply-bar at the bottom of the settings page is
visible IFF the active sidebar tab belongs to the Soul group AND at
least one Soul-group field is dirty. It MUST NOT appear on Account,
Members, or Provider keys panes regardless of dirty state.
**How:** After every interactive action in the settings page, query
`document.querySelector('.settings-v2 .apply-bar')` visibility. Fire
if visible on User/Admin panes, or if hidden when Soul fields show
dirty dots.
**Severity:** critical (contract regression).

### settings.restart-spinner-resolves
**Checks:** When Apply & Restart is clicked, the spinner must
transition saving → restarting → ready (or failed) within 30s. Never
stick on "Restarting…" forever.
**How:** After clicking Apply & Restart, watch the spinner element for
≤ 30s. Capture screenshot if it doesn't reach a terminal state.
**Severity:** major (user-blocking).

<!--
Add more project-specific oracles here. Examples that often pay off:
- "no-uncaught-promise-rejection" — listen for window 'unhandledrejection'
- "ws-stays-open-during-active-cycle" — for streaming apps
- "form-error-message-near-field" — accessibility / UX consistency
-->
