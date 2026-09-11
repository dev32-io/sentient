# Task Brief: Refresh the Web gates, shell, authentication, History, and global overlays

## Contribution Goal

Migrate every reachable Web setup/auth/shell/History/global-overlay state to the shared component system while preserving route, session, authorization, and dismissal behavior.

## Boundary — Included

- Install/setup and login composition, authenticated app shell/topbar/user menu, History drawer/session rows/search/new chat, shell-level connection/toast/permission overlays, explicit no-op affordances, route/session wiring, and fabricated telemetry cleanup.

## Required Work

- 1. Keep app.tsx as route/data composition only and migrate all raw styled controls in the included directories to web-foundation-components primitives/common composites. Replicate scoped prototype composition; never import design/prototype runtime files.
- 2. Refresh loading, setup, user selection, PIN, validation/submission/error, authenticated, and auth-expired states. Preserve credential handling, admin authority, session restoration, route sessionStorage semantics, fresh-login-to-chat behavior, and backend setup behavior.
- 3. Refresh AppShell/topbar/user menu at desktop and narrow widths. Remove DEVICE_COUNT and any implied device-online telemetry. Keep notifications visible as an intentional unavailable/coming-soon control without inventing behavior. Do not expose service implementation names in ordinary shell copy.
- 4. Refresh History drawer states and interactions: explicit close/backdrop/Escape, focus restoration, search, date groups, active row, loading/empty/no-match/stale/error+retry, New Chat, prior-session restore, and safe narrow layout. Preserve ROW_ACTIONS_AVAILABLE=false until APIs exist; rename/delete UI may remain intentionally unreachable rather than pretending success.
- 5. Refresh permission confirmation through the common Dialog while preserving authenticated request IDs, Allow/Deny only, stale/expiry behavior, focus trapping/restoration, and user-facing action/target/scope/consequence. Never log raw tool arguments or content.
- 6. Remove the current voiceMode='active' to listening avatar override. Shell identity may request only idle/thinking/responding from actual cognition/playback state; microphone capture remains composer-owned.
- 7. Add/extend stable tests for gate branches, wrong PIN/error, route restoration, new/prior chat selection, drawer dismissal/focus, unavailable notification semantics, permission decisions, non-admin presentation, and absence of fabricated telemetry. Cover 1280×900, 390×844, keyboard operation, and 200% zoom through component/structured checks.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Sole root owner is gateway/webui/src/app.tsx. Reachable gates are InstallGate/WizardShell, anonymous SetupScreen/LoginScreen, failed auth, then authenticated chat/calendar/settings AppShell.
- Product paths are components/wizard/**, account-wizard/**, auth/**, shell/**, sessions/**, permission/** and their styles. History includes loading/empty/search-no-match/stale/error, new chat, disabled rename/delete affordances, and focus/backdrop dismissal.
- Current app.tsx defines fabricated DEVICE_COUNT=14 and topbar renders '14 devices online'; this must be removed until real telemetry exists.

## Boundary — Excluded

- Chat message/composer internals
- Settings pane internals
- Calendar internals
- New notification/session rename/delete behavior
- Domain/API/auth/session redesign
- Prototype runtime imports

## Interfaces and Dependencies

- Consumes Web foundation/common components and existing auth/session hooks/services.
- Owns app.tsx composition and provides unchanged route props to Chat, Settings, and Calendar product components.
