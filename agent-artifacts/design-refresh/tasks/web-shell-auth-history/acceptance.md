# Task Acceptance: Refresh the Web gates, shell, authentication, History, and global overlays

## Deliverables

- Migrate every reachable Web setup/auth/shell/History/global-overlay state to the shared component system while preserving route, session, authorization, and dismissal behavior.

## Acceptance

- All included reachable states use shared components/tokens and no page-local visual controls.
- No fabricated device count, no listening avatar mode, and no implementation service names appear in the shell.
- History/new-chat/prior-session behavior and overlay focus/dismissal remain coherent.
- Visible no-op controls are honest and nonfunctional.
- E2E-001 and shell portions of E2E-005 have stable selectors/accessibility names and safe fixture hooks.

## Boundary Proof

- Focused gate/shell/drawer/permission tests pin behavior and focus restoration.
- Web build plus inventory checker confirms every included state has implementation ownership and no prototype runtime import.
