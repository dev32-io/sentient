# Repositories and Chat Projection — Details

This file expands `.claude/rules/mobile-shared.md`. Repositories are stateless SDK passthroughs. Usecases own event folding and multi-source projection; native chat VMs own `OutboundCache` and UI state.

## SDK surfaces

```kotlin
val connection: StateFlow<ConnectionState>
val timeline: StateFlow<List<ChatMessage>>
val tasks: StateFlow<List<TaskListItem>>
val events: SharedFlow<SdkEvent>
val currentSessionId: StateFlow<String?>
```

`timeline`, `tasks`, and connection are complete latest-value state. `events` carries ordered one-shots such as streamed text chunks, turn completion/abort, session switches, permission events, delegation progress, protocol errors, and reopen failure.

## Stateless repositories

`SdkConversationRepository` exposes SDK state/events and forwards `send(text, pendingId)`. It does not combine, buffer live text, gate on connection state, or own the outbox:

```kotlin
class SdkConversationRepository(private val sdk: SentientSdk) : ConversationRepository {
    override val timeline get() = sdk.timeline
    override val tasks get() = sdk.tasks
    override val liveEvents get() = sdk.events
    override fun send(text: String, pendingId: String) = sdk.sendText(text, pendingId)
    override val echoedPendingIds =
        sdk.timeline.scan(emptySet()) { acc, rows -> acc + rows.mapNotNull { it.pendingId } }
}
```

`SdkConnectionStateRepository.state` is a direct flow of `sdk.connection`. `SdkSessionsRepository` forwards the current REST-backed session commands. Repositories do not cache screen state.

## ObserveChatUseCase folds SdkEvent

`ObserveChatUseCase` creates collection-owned reveal state by serially scanning `ConversationRepository.liveEvents`:

- `SdkEvent.MessageStarted(turnId, replyId)` opens/adopts a live reply bubble.
- Every `SdkEvent.MessageDelta(turnId, chunk, replyId)` appends its chunk in order.
- `SdkEvent.MessageCommitted` (or matching `TurnDone`) moves the live reveal to DRAINING; the ticker clears it after all accumulated text is shown. Committed text is authoritative through `timeline`.
- `SdkEvent.TurnAborted` and `SessionSwitched` reset the applicable transient reveal state.

The usecase combines that fold with committed `timeline`, full-state `tasks`, the VM's pending-flow, history-loading state, and accumulated echoed pending ids to produce `ChatModel`. Tool rows remain in the composer task strip; they are not grafted onto message bubbles.

A `replyId` identifies one assistant bubble. `turnId` identifies the server turn and may span more than one reply bubble when a user steers mid-turn. Suppress a committed/live twin by exact `replyId`, never by guessed turn or text.

## Outbox reconciliation

The native VM passes `OutboundCache.pending` into `observeChat`. The projection hides entries whose exact `pendingId` appears in the accumulated live echo set, and the VM removes those ids from its cache. A cold REST history replacement has no pending ids; its explicit cold-replace signal drops remaining optimistic entries to avoid duplicates.

`SendMessageUseCase.flushIfReady` sends only when transport is READY and
`currentSessionId` is non-null. That value may temporarily be a draft key: the
first send is what mints and attaches the durable session. All QUEUED entries
are eligible, including sent-but-unechoed entries after reconnect; the gateway
deduplicates by `pendingId`.

## Gotchas

- Do not fold `SdkEvent` in repositories or native VMs; `ObserveChatUseCase` owns the conversation projection.
- Do not model token deltas as `StateFlow`; every chunk must reach the reducer.
- Do not derive tool rows from `SdkEvent`; `tasks` is server-authoritative full state.
- Do not reconcile optimistic sends by text or by a cold history row's `pendingId`.
- Do not add mutable repository caches to reset on conversation switch. Collection/route lifetime is the reset boundary.
