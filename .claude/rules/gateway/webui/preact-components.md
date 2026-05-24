---
paths:
  - "gateway/webui/src/**/*.tsx"
  - "gateway/webui/src/**/*.ts"
---
# Preact Component Rules

- One component per file. File name matches component name.
- Props type defined and exported in same file as component.
- Container components own data loading. Presentational components receive props and are pure.
- Use signals for local state. Use context sparingly (auth, theme only).
- Derive computed values. Never store redundant state.
- Semantic HTML first. No generic div stacks.
- CSS custom properties for all design tokens (colors, spacing, type scale).
- Suffix screens with `Screen`, reusable components with no suffix.

> When a rule is unclear, read `agents/docs/preact-components-details.md`.
