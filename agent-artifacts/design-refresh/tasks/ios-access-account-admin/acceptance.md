# Task Acceptance: Refresh iOS setup/login, update, account, members, and secrets surfaces

## Deliverables

- Migrate access, update, user-account, and administrator flows to shared native components while preserving configuration, authentication, authorization, and secret boundaries.

## Acceptance

- All included reachable states use shared components and native controls.
- Configuration/auth/update/account/admin/secret behavior and authorization remain unchanged.
- PINs, tokens, secrets, and private values are absent from logs/evidence and secrets remain presence-only.
- Setup/login actionable errors cooperate with readiness rather than hiding behind startup.
- Large Dynamic Type, keyboard, focus, native navigation/sheets/alerts, and honest no-op states remain usable.

## Boundary Proof

- Focused iOS tests cover state transitions, privacy/authorization, and readiness output.
- Signed simulator build/test covers route destinations and native presentations.
