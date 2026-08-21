# Task Acceptance: Implement complete web calendar create, edit, and delete dialogs

## Deliverables

- The web client has controlled, accessible Dusk dialogs for complete Calendar V2 create/edit/delete flows, recurrence mutation scopes, typed conflicts, permission failures, and safe recovery.

## Acceptance

- Create/edit/delete preserve exact Calendar V2 identity, scope, recurrence, revision, and originalStart semantics.
- Conflicts never overwrite, failures preserve drafts, and restricted outcomes reveal no hidden data.
- Dialogs match the exact reference treatment for supported fields and satisfy keyboard/focus/reduced-motion requirements.

## Boundary Proof

- Vitest tests cover payloads, recurrence scopes, revisions, typed outcomes, confirmation, draft retention, and focus.
- Existing calendar-api and handler integration tests continue to pass.
- Screenshots/semantic snapshots compare all overlay states to `sentient-design/design/web/calendar.html` at roomy and 390px widths.
