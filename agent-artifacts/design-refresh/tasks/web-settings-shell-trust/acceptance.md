# Task Acceptance: Refresh the Web Settings shell, account/admin panes, and Diagnostics trust boundary

## Deliverables

- Migrate Settings navigation, apply feedback, account/member/secret/get-app states, and technical status presentation to shared components while keeping authorization and persistence unchanged.

## Acceptance

- Owned panes and all dirty/apply states use shared components with no page-local design literals.
- Harmless setting changes still persist/reload/restore through existing APIs.
- Technical names/versions appear only in Diagnostics; ordinary household navigation is implementation-neutral.
- Admin gating and secrets/PIN privacy remain unchanged.
- E2E-003 and Settings portions of E2E-005 have stable accessible selectors and fixture-safe state restoration.

## Boundary Proof

- Existing settings admin/apply tests plus new trust/privacy/responsive tests pin behavior.
- Inventory/static checks cover all owned states and reject ordinary-navigation Hermes/service-version copy.
