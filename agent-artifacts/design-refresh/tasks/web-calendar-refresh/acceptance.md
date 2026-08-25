# Task Acceptance: Refresh the complete Web Calendar workspace and overlays

## Deliverables

- Migrate every reachable Day/Week/Month/Year Calendar state and CRUD overlay to the reviewed composition while preserving existing calendar projection, authorization, recurrence, conflict, cache, and mutation behavior.

## Acceptance

- All four views and every current overlay/state use the refreshed component/material system.
- Disposable create/preview/edit/delete behavior and final cleanup remain correct.
- Authorization, recurrence, occurrence identity, conflict, cache/offline, and filter semantics are unchanged.
- Focus, keyboard, 44px targets, Reduced Motion, narrow viewports, and 200% zoom remain usable with no page overflow.

## Boundary Proof

- Existing and expanded Calendar unit tests pin behavior and visual-state structure.
- Safe fixture/charter metadata maps E2E-004 without touching production.
