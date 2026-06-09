# Repositories — Details

Repositories sit between the blackbox SDK (`shared/mobile-sdk`) and the per-screen ViewModels. They translate the SDK's three observable surfaces into `SentientResult` streams the UI can fold.

## The SDK surfaces a repository consumes

```kotlin
// SentientSdk public surface (blackbox to the app)
val connection: StateFlow<ConnectionState>     // transport + voice axis
val timeline:   StateFlow<List<ChatMessage>>   // committed history
val events:     SharedFlow<SdkEvent>           // no-loss one-shot notifications
```

## ChatRepository — fold events, combine with timeline + outbox

The streaming fix lives here: the no-loss `events` SharedFlow is folded by a PURE reducer so deltas/tasks never conflate away.

```kotlin
// Pure reducer — no I/O, consumes every SdkEvent in order
fun reduce(s: LiveState, e: SdkEvent): LiveState = when (e) {
    is SdkEvent.MessageStarted   -> s.copy(live = ChatMessage(role = "assistant", content = "", streaming = true, cycleId = e.cycleId), tasks = emptyList())
    is SdkEvent.MessageDelta     -> s.copy(live = (s.live ?: blankBubble(e.cycleId)).let { it.copy(content = it.content + e.chunk) })
    is SdkEvent.TaskUpserted     -> s.copy(tasks = upsert(s.tasks, e.task))
    is SdkEvent.MessageCommitted -> s.copy(live = null, tasks = emptyList())  // committed text arrives via timeline
    else                         -> s
}
```

```kotlin
// chatStream — the single thing the chat ViewModel collects
val chatStream: Flow<SentientResult<ChatModel>> =
    combine(timeline, liveState, outboxState) { committed, ls, pending ->
        val committedPendingIds = committed.mapNotNull { it.pendingId }.toSet()
        val visiblePending = pending.filter { it.id !in committedPendingIds }   // reconcile by id
        SentientResult.Success(ChatModel(committed = committed, pending = visiblePending, live = ls.live, tasks = ls.tasks))
    }
```

`ChatModel.messagesForUi()` appends the live bubble (with its tasks grafted on) to the committed list for rendering.

## ConnectionRepository — status as a Result

See `result-envelope-details.md` for the full `connection.map { … }` mapping. It is the reachability source the offline/lifecycle rules refer to.

## HistoryRepository — cache-then-refresh

```kotlin
fun load(): Flow<SentientResult<List<SessionRowData>>> = flow {
    emit(SentientResult.Loading(partial = cache))            // instant first paint from cache
    runCatching { fetch() }.fold(
        onSuccess = { cache = it; emit(SentientResult.Success(it)) },
        onFailure = { emit(SentientResult.Failure(SentientError.Timeout("Couldn't load chats", cause = it))) },
    )
}
```

`seedCache(rows)` lets a prior screen warm the cache so the drawer never opens empty.

## Gotchas

- **The no-loss guarantee is at `reduce`, not at the `StateFlow`.** `liveState` is a `MutableStateFlow` and MAY conflate intermediate emissions — that is fine because `reduce` already accumulated them; content only grows. Do NOT try to make the StateFlow itself lossless.
- Do not fold `events` in a ViewModel. The repository owns the collector (on the session scope); the ViewModel collects the already-folded `chatStream`.
- `MessageCommitted` clears `live`/`tasks` — the authoritative committed text comes back through `timeline`, not from the event payload. Don't render committed text off the event.
- Repositories never reach back into the SDK for one-off imperative calls from the UI path; commands (send/switch/newChat) go through the session, reads go through repositories.
