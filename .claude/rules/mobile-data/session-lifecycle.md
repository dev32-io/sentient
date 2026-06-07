---
description: Chat-scoped session -- owns SDK+repos on one scope, open/pause/resume/close, no singletons.
paths:
  - "shared/mobile-data/**/session/**"
---

# Session Lifecycle

The chat session is a chat-scoped unit owning the SDK + repositories on one coroutine scope. Built on chat entry, torn down on exit — NEVER a singleton, NEVER app-scoped.

- The cross-platform session holds the wiring once; platform factories only construct the SDK + scope and hand them in. Don't duplicate wiring per platform.
- The session exposes exactly four lifecycle ops:
  - open — connect in the background; the UI never blocks on it (optimistic send bridges the gap).
  - pause — background entry: drop the socket, keep the scope alive.
  - resume — foreground entry: re-arm reconnect. Idempotent.
  - close — screen exit: disconnect + cancel the scope.
- pause/resume are driven by a tiny app-scoped presence relay, NOT by the session. The relay MUST skip the cold-start foreground so it never double-connects.
- Everything chat-related is bound to the session scope: socket, mic/audio, connectors, repositories. Nothing chat-related lives across screens.
- One session per chat entry; re-entry builds a fresh one. Never cache or reuse a closed session.

> When a rule is unclear, read `agents/docs/mobile-data/session-lifecycle-details.md`.
