# Task Acceptance: Implement complete web calendar create, edit, and delete dialogs

## Deliverables

- The web client has controlled, accessible Dusk dialogs for complete Calendar V2 create/edit/delete flows, recurrence mutation scopes, typed conflicts, permission failures, safe dismissal, and draft-preserving recovery.

## Acceptance

- Create/edit/delete preserve exact Calendar V2 identity, scope, recurrence, revision, and raw originalStart semantics.
- Background content is inert while the dialog is open; every close path cleans up inert state and restores focus.
- Dirty drafts cannot be silently discarded by backdrop/Escape, failures preserve drafts, and restricted outcomes reveal no hidden data.
- Role/capability presentation uses explicit authenticated capability state rather than inference.
- Dialogs match the exact reference treatment for supported fields and satisfy keyboard/focus/reduced-motion requirements.

## Boundary Proof

- Vitest tests cover Dialog inert cleanup/safe dismissal, payloads, recurrence scopes, revisions, typed outcomes, capability gating, confirmation, draft retention, and focus.
- Existing Dialog consumers and calendar-api/handler integration tests continue to pass.
- Screenshots/semantic snapshots compare all overlay states to `sentient-design/design/web/calendar.html` at 1440x1000 and 390x844.
