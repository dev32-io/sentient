# Task Brief: Make cold launch and New Chat establish a fresh conversation boundary

## Contribution Goal

Cold launch and every intentional New Chat eagerly prepare a fresh gateway boundary exactly once, keep the composer immediately usable, and prevent the first queued message from entering the prior conversation.

## Boundary — Included

- Shared SDK/data operation for explicit eager fresh-chat preparation
- Cold-launch and title-bar/drawer/recovery New Chat wiring on Android and iOS
- Pre-READY retry, outbound queue attachment, local clear, and old/new identity isolation
- Focused shared/native regression tests and agent-driveable New Chat/cold-launch flow coverage

## Required Work

- 1. Trace SessionsConnector, SentientSdk, SdkLifecycle, SwitchConversationUseCase, SendMessageUseCase, Android AppNavHost/ChatViewModel, and iOS UserSessionHost/ChatViewModel; preserve the existing session.draft and first-message mint wire contract.
- 2. Introduce a clearly named shared startFreshChat fire-and-forget operation that sends session.new with intent=explicit, synchronously clears old conversation-scoped client state/anchor, and retains exactly one pending explicit preparation across a pre-READY transport edge.
- 3. Keep implicit session.new support for compatibility where still required, but stop using implicit reattachment for mobile cold launch and mobile New Chat. Correct stale comments and tests that describe the old mobile launch behavior.
- 4. Give each cold-launch or intentional New Chat navigation a stable route-entry identity/once boundary on Android and iOS. Ensure recomposition or duplicate ViewModel observation cannot send again, while a genuinely new route entry does.
- 5. Preserve immediate typing/sending: OutboundCache accepts the message before preparation settles, SendMessageUseCase waits for session.draft/attachment, and the queued message can never flush against the previous session id.
- 6. Add deterministic connector, SDK, mobile-data, Android, and iOS-facing tests for cold-launch explicit intent, user-triggered explicit intent, one request per route entry, pre-READY retry, rapid-action debounce/idempotence, immediate-send queueing, session.draft attachment, and old/new conversation isolation.
- 7. Update or replace contradictory mobile Maestro flows, including New Chat and relaunch behavior, so agent-driven journeys can prove user-triggered and cold-launch marker isolation without waiting for manual intervention. Preserve stable accessibility ids and disposable local markers.
- 8. Run the focused shared, Android, iOS, and gateway compatibility checks and finish with git diff --check.

## Integration Expectation

Deliver this contribution for integration in stage foundation.

## Context

- Current Android and iOS null-session ChatViewModel initialization calls SwitchConversationUseCase(null), which reaches SessionsConnector.sendNew() without intent=explicit; the gateway therefore reattaches the bound conversation while the client only clears its local timeline.
- The gateway already supports the required non-blocking lifecycle: session.new(intent=explicit) unbinds the old conversation, returns session.draft, and allocates the durable session when the first message arrives.
- Cold launch intentionally starts fresh. There is no client-generated or persisted draft model; the existing outbound queue waits for the gateway attachment without blocking the composer.
- One fresh-chat route entry must issue one preparation request. Recomposition or ViewModel recreation within that route is not a new user action.

## Boundary — Excluded

- Changing the gateway's session.draft/first-message durable allocation model
- Adding client-side draft persistence
- Resuming the prior conversation on cold launch
- Blocking or disabling the composer while preparation settles
- Production smoke testing

## Interfaces and Dependencies

- Consumes the existing session.new intent field, session.draft/session.created frames, SentientSdk currentSessionId, OutboundCache, and SendMessageUseCase attachment gate.
- Produces a shared explicit startFreshChat command and platform route-entry invocation that is once-per-entry and non-blocking.
- Proof seam: wire-frame tests, pre-READY lifecycle tests, queued-send tests, route identity tests, and agent-driveable old/new marker isolation flows.
