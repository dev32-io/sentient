---
description: Connection scope (transport+usecases, alive while authed, survives nav) vs screen scope (per-route state-holder).
paths:
  - "shared/mobile-data/**/di/**"
  - "shared/mobile-data/**/session/**"
---

# Connection Lifecycle

Separate the connection scope from the screen scope. The connection lives across screens; the screen state is per route.

- The connection scope owns the transport + data sources + the usecase graph. It is alive while authenticated and SURVIVES navigation between screens — switching screen or context must not drop the socket. Built on login, torn down on logout. NEVER a process-wide singleton tied to one screen.
- Lifecycle ops on the connection scope: open (connect in the background; the UI never blocks — optimistic send bridges the gap), pause (background entry: drop the socket, keep the scope), resume (foreground: re-arm reconnect, idempotent), close (auth end: disconnect + cancel the scope).
- pause/resume are driven by a tiny app-scoped presence observer, NOT by a screen. It MUST skip the cold-start foreground so init-connect and resume never double-connect.
- A context/conversation switch is a NAVIGATION that recreates the screen scope, NOT an in-place mutation — the connection survives it; only the per-screen state-holder is rebuilt.
- The cross-platform layer holds the wiring once; platform factories only construct the transport + scope and hand them in. Don't duplicate wiring per platform.

> When a rule is unclear, read `agents/docs/mobile-data/session-lifecycle-details.md`.
