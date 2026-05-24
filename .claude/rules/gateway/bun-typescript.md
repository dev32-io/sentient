---
paths:
  - "gateway/**/*.ts"
  - "shared/**/*.ts"
---
# Bun TypeScript Rules

- Use `unknown` for all external input. Validate with zod schemas.
- Explicit return types on all exported functions.
- Use string literal unions over enums.
- Use `interface` for extendable shapes, `type` for unions and utilities.
- AsyncGenerator for all streaming operations. Always call `.return()` on cleanup.
- AbortSignal threads through every async operation for cancel propagation.
- Prefer `Bun.serve()` over Express/Hono. Use built-in WebSocket server.
- Use `structuredClone()` for deep copies, spread for shallow.

> When a rule is unclear, read `agents/docs/bun-typescript-details.md`.
