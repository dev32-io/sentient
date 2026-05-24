---
paths:
  - "gateway/webui/src/**/*.tsx"
  - "gateway/webui/src/**/*.ts"
---
# State Management Rules

- Server state (data from gateway): managed by WebSocket hook, never duplicated.
- Client state (UI state): signals or useState. Keep local to component when possible.
- URL state (shareable): use URL params for filters, tabs, search.
- Form state: controlled inputs with local state.
- NEVER duplicate server state into client stores.
- Derive computed values from source state. Never store computed values.

> When a rule is unclear, read `agents/docs/state-management-details.md`.
