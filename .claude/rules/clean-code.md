<!-- last-distilled: 2026-04-26 branch: develop -->
---
paths:
  - "gateway/**"
  - "shared/protocol/**"
  - "shared/config/**"
  - "shared/audio-prefs/**"
  - "shared/web-sdk/**"
  - "shared/wizard/**"
  - "shared/testing/**"
  - "shared/tls/**"
  - "sentient-auth/**"
  - "capabilityServices/**"
---
# Clean Code Rules

- Proactively decompose large monolithic files, functions, and god-classes along logical boundaries whenever a unit carries more than one clear responsibility. Cohesion sets size, never a line count.
- Max nesting depth: 3 levels. Use early returns to flatten.
- No magic numbers or hardcoded strings. Use named constants.
- No commented-out code. Delete it. Git has history.
- No unused imports, variables, or parameters.
- Prefer pure functions. Minimize side effects.
- Return new objects for state changes. Never mutate parameters.
- Name booleans as questions: `isReady`, `hasPermission`, `canExecute`.
- Name functions as actions: `createSession`, `validateToken`, `parseFrame`.
- Large prompt/template content (system prompts, persona docs, agent instructions) MUST live in `.md` files, not inline TS strings. Use a loader with override fallback (operator dir → baked-in dir) so operators can swap content without a code change or rebuild.

> When a rule is unclear, read `agents/docs/clean-code-details.md`.
