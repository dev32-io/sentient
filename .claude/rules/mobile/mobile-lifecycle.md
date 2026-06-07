---
description: Mobile lifecycle -- chat-scoped session, presence relay cold-start-skip, transitions, restore.
paths:
  - "android/**"
  - "ios/**"
  - "shared/mobile-data/**"
---

# Mobile Lifecycle

The OS suspends, kills, and resurrects mobile processes on its own schedule. Treat every transition as routine. The chat session is bound to a scope, and a tiny app-scoped relay drives its pause/resume.

## Chat-scoped session + presence relay

- The SDK + socket + mic + repositories live in a chat-scoped session, built on entry, torn down on exit. Lifecycle ops: open (background connect), pause (drop socket, keep scope), resume (re-arm reconnect), close (disconnect + cancel scope).
- An app-scoped presence relay forwards foreground/background to the active session via the platform's process/scene lifecycle observer. It holds NO session state.
- COLD-START-SKIP: the relay MUST skip the first foreground after launch — init already connected. Without the skip, init-connect and presence-resume race into a double connect. Only resume after a real background.

## Transitions — first-class state

- Background → foreground is a state, not an edge case. On resume: re-arm reconnect, refresh staleable inputs (clocks, tokens, reachability).
- Cover the triple: cold start, background+resume, background+kill+restore.

## Process death + restore — what actually persists

- On restart, the root gate re-derives from PERSISTED state (backend config + token). The chat session is rebuilt FRESH on entry — not restored from a snapshot.
- The in-memory outbox does NOT survive process death. Durable chat/outbox restore is not implemented — do not assume a session snapshot exists.

## Permissions — at point of use

- Notifications, microphone, and local-network permissions are requested at point of use, not at launch. Rationale UI before re-asking; settings-bounce fallback if denied.

## Observability

- Log every transition (foreground, background, cold-start-skip, pause, resume, close) as a structured event.

## When applicable — foreground services / deferred work (Future)

- No foreground service or scheduled background work today. If added: declare the foreground-service type in manifest and at start; use the platform deferred-work scheduler, never a raw thread. (Server-initiated heartbeats are an antipattern on mobile — use visibility-triggered probes.)

> When a rule is unclear, read `agents/docs/mobile/mobile-lifecycle-details.md`.
