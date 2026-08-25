# Task Brief: Refresh iOS setup/login, update, account, members, and secrets surfaces

## Contribution Goal

Migrate access, update, user-account, and administrator flows to shared native components while preserving configuration, authentication, authorization, and secret boundaries.

## Boundary — Included

- Backend setup/edit/probe/permission states, user loading/selection/PIN login/errors, forced/available update states, account profile/PIN/coming-soon states, members roster/add/promote/demote/delete, secrets presence/edit/apply feedback, native sheets/alerts/navigation/accessibility.

## Required Work

- 1. Migrate included screens to iOS foundation/common components and native SwiftUI APIs. Replicate reviewed composition without importing prototype CSS/HTML/JS/assets or embedding page-local design literals.
- 2. Preserve Backend setup host/port/TLS choices, validation, Local Network primer/system permission, probe retry, failure, save, and setup override behavior. Catch external failures at adapter boundaries with bounded waits; never log host credentials/tokens.
- 3. Preserve login user loading/empty/actionable error, user selection, PIN entry/delete/back/submitting, invalid PIN/network/server errors, and authenticated identity. Never persist/display/log PINs or credentials. Expose readiness outcomes to the startup coordinator without bypassing its 1500ms floor.
- 4. Preserve UpdateGate/force update/banner/installer behavior, progress, unavailable/error/retry and safe app lifecycle. Do not change update service semantics or production deployment.
- 5. Preserve Account display-name loading/dirty/save/saved/failure, native Change PIN sheet and validation, logout flow, and honest Voice Print coming-soon state without adding behavior.
- 6. Preserve Members loading/not-admin/ready/error, self row, slot cap, Add Member native sheet, submitting/error, promote/demote confirmation, destructive delete confirmation, and backend authorization. Keep 403 recovery explicit.
- 7. Preserve Secrets loading/error/ready, presence-only keys, masked edit/base URL fields, saving/applying/applied/already-applying/failure/retry/dismiss. Raw secret values never return to display/evidence and are never logged.
- 8. Retain one outer NavigationStack, native back behavior, sheet, alert, confirmationDialog, menu, focus, keyboard, safe areas, 44pt targets, Dynamic Type accessibility size, Reduced Motion, Increased Contrast, and visible non-color errors.
- 9. Add focused tests/previews for all branches, privacy redaction, admin/non-admin behavior, setup validation/probe failure, login readiness/error, update states, account restore/logout, member mutations, secret presence/apply, and native large-text reachability.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Owned paths are ios/App/Auth/**, SDK/BackendSetupView*.swift and LocalNetworkPrimer presentation, Update/**, Settings/Account/**, Settings/Members/**, Settings/Secrets/**, plus owned tests/previews.
- Root startup/readiness and NavigationStack ownership remain with ios-identity-startup-history; SettingsView route composition remains with ios-settings-system.
- Secrets are presence-only; admin visibility is presentation, never authority; PIN/token/config values must not appear in logs/evidence.

## Boundary — Excluded

- Startup clock/Rive/History implementation
- Soul/Voice/Calendar settings
- Backend auth/config/update/member/secret API redesign
- Production update/deployment actions
- Android UI or prototype imports

## Interfaces and Dependencies

- Consumes native common components and existing ViewModels/services; reports setup/login readiness to ios-identity-startup-history.
- Produces refreshed route destinations without changing RootView/UserSessionHost ownership.
