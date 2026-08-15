# Mobile lifecycle details

This file expands `.claude/rules/mobile-shared.md` for lifecycle questions.

## Shipped ownership

On Android, `UserSessionManager` owns and builds the authenticated SDK/data components and shared `ChatComponent`. On iOS, the Swift `UserSession` wrapper owns the KMP `IosUserSession` and exposes its components. Both are platform owners of the same user/connection-scoped contract; there is no shared `MobileSession` abstraction. The scope survives navigation and is torn down on logout.

`ChatComponent` is the connection-scoped chat composition boundary. Its repositories are stateless passthroughs over one SDK; the chat VM owns screen state and its `OutboundCache`.

## Foreground/background

- Foreground calls the session's foreground/liveness hook. A healthy socket gets a liveness probe; a dead socket is reconnected.
- Background keeps the socket and authenticated connection scope; do not proactively disconnect on a routine background transition. Process suspension or death is separate and may require reconnect/rebuild later.
- Do not create a second connection from a cold-start foreground callback when initial connection is already being opened.
- Logout uses the full teardown path and returns the root to unauthenticated state.

The outbox is in memory. A process kill loses it; lifecycle handling must not imply durable replay. For send state, read `agents/docs/mobile-data/outbox-optimistic-send-details.md`.
