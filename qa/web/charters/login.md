---
id: login
area: auth
auth: fresh
concurrency_key: auth-state
risk_hint: high
oracles:
  - shared.console-error-free
  - shared.network-no-5xx
  - shared.no-uncaught-promise-rejection
  - shared.few-hiccupps.user-expectations
  - web.aria-required-fields
role: default
---

# Charter: login (sentient)

**Mission:** Exercise the avatar+PIN login flow from a fresh browser
context. Confirm a real user can authenticate, the app lands on the
chat view, and no oracle fires during the flow. Save the resulting
browser storage state to `.playwright/profiles/default.json` so seeded
charters can reuse it.

## What the UI looks like

Login is implemented in `gateway/webui/src/components/auth/`:

- `login-screen.tsx` — top-level component, handles stages
  `loading → avatars / empty / error → pin`.
- `avatar-tile.tsx` — clickable user tile (props: `userId`,
  `displayName`, `avatarTint`).
- `pin-pad.tsx` — numeric PIN input, fires `onSubmit(pin)` when
  complete.

Logger tag for tracing: `[sentient.webui.auth.login-screen]` (visible
via `browser_console_messages`). Look for `pin-submit`, `login-success`,
`wrong-pin`, `login-error` log lines as state markers.

## Test credentials

- **PIN:** `1234` (local dev — already documented in
  `agents/docs/testing-knowledge.md`).
- **User:** the first avatar in the grid is fine for the smoke seed.

## Suggested steps

1. Open `https://localhost:8888` in a fresh browser context (no
   storage state). Accept the self-signed cert if Playwright surfaces
   the dialog (`browser_handle_dialog`).
2. Wait for the login screen to settle. Take a `browser_snapshot` and
   confirm the avatar grid renders. If the snapshot shows the
   `error`, `empty`, or stuck-`loading` view → fire
   `shared.few-hiccupps.user-expectations` and abort the charter
   (no profiles configured, can't continue).
3. Click the first `AvatarTile`. Expect the screen to transition to
   the PinPad view with the user's display name in the title.
4. Enter PIN `1234` via the PinPad. Submit (the PinPad auto-submits
   when 4 digits are entered).
5. Wait for the chat view to appear (`gateway/webui/src/components/
   shell/app-shell.tsx` swaps in the chat layout when authenticated).
   Verify by snapshot — the composer (`composer.tsx`) and topbar
   (`topbar.tsx`) should both be present.
6. Save the browser's storage state to
   `qa/web/.playwright/profiles/default.json` for downstream seeded
   charters to use.
7. **Negative path** (optional, in a second fresh context): repeat
   steps 1–4 with PIN `9999`. Confirm the "Wrong PIN" error message
   renders, the PinPad clears, and the app does NOT navigate to the
   chat view.

## Things to actively look for

- Console errors during any step — fire `console-error-free`. Watch
  particularly for unhandled promise rejections from the AuthApi
  client.
- 5xx HTTP responses — fire `network-no-5xx`. The auth endpoint is
  `POST /api/auth/login`; a 5xx here is a critical bug.
- PIN field without `aria-required` — fire `web.aria-required-fields`.
- "Loading..." that never resolves on the avatar grid — there's a real
  failure mode where `listUsers()` hangs and the UI stays in the
  `loading` stage; fire `shared.no-stuck-state`.
- Wrong PIN should produce a human-readable message ("Wrong PIN"), not
  a technical error like "401" or "ECONNREFUSED" leaking into the UI.

## Notes for the Reporter

A login failure is severity:critical — every seeded charter in the run
falls back to manual seeding without it. Surface in
`needs_fixer_agent`. UX issues (PIN pad too small on mobile viewport,
focus order, slow transition) belong in `issues`.
