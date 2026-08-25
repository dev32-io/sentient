# Task Acceptance: Refresh iOS Settings root and system/Soul panes

## Deliverables

- Migrate the native Settings root, Memory, Personalities, Audio, Model, Tools, System Prompt, Advanced, and Diagnostics surfaces to shared components while preserving all current data and apply behavior.

## Acceptance

- Every owned surface/state uses shared components and exact v2 semantics with no unauthorized visual literals.
- Persistence/restart/discard/permission behavior remains unchanged.
- Implementation names appear only in Diagnostics and all diagnostics remain sanitized.
- Accessibility Dynamic Type, native back/sheets/alerts/menus, 44pt targets, and Reduced Motion remain usable.
- A reversible harmless setting is selectable for text-only E2E-008 and restored after the case.

## Boundary Proof

- Focused iOS unit/view/previews cover state, persistence, trust/privacy, and accessibility contracts.
- Signed simulator tests compile the complete Settings route graph.
