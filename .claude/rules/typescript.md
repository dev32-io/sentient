---
paths:
  - "gateway/**/*.ts"
  - "gateway/webui/**/*.ts"
  - "gateway/webui/**/*.tsx"
  - "shared/**/*.ts"
---
# TypeScript Rules

- Shared types live in `shared/`. NEVER duplicate type definitions across projects.
- One behavior per `it()` block. Name: `it('returns X when Y')`.
- Use `unknown` for caught errors, narrow with type guards.
