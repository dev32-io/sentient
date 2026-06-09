# MobileSession Lifecycle — Details

`MobileSession` is the one place the SDK + repositories are wired together, scoped to a single chat screen's lifetime. It replaced the per-platform singletons (`SdkHolder` / `SdkStore`) that the clean-architecture refactor deleted.

## Construction + wiring (shared)

```kotlin
// shared/mobile-data/.../session/MobileSession.kt
class MobileSession(val sdk: SentientSdk, private val scope: CoroutineScope, ...) {
    val chatRepo = ChatRepository(
        events = sdk.events, timeline = sdk.timeline, scope = scope,
        send = { text, pendingId -> sdk.sendText(text, pendingId) },
        newId = { Random.nextLong().toString(16) },
    )
    val connectionRepo = ConnectionRepository(connection = sdk.connection)
    val historyRepo = HistoryRepository(fetch = { sdk.listSessions(limit = 50, offset = 0).items.map { it.toRow() } })

    init {
        // forward connection READY → chatRepo.setConnected so the outbox flushes
        scope.launch { sdk.connection.collect { chatRepo.setConnected(it.status == READY) } }
    }
}
```

## Lifecycle ops

```kotlin
suspend fun open()  { sdk.connect() }                       // → READY; call in background from VM init
fun pause()         { sdk.disconnect(clearSession = false) } // background: drop WS, KEEP scope
fun resume()        { sdk.forceReconnect() }                 // foreground: re-arm reconnect (idempotent)
fun close()         { sdk.disconnect(clearSession = false); scope.cancel() }  // screen exit: full teardown
```

`pause` vs `close`: `pause` keeps the scope (and the in-memory outbox) alive so `resume` can reconnect via session-resume; only `close` cancels the scope.

## Platform construction

- **Android** — `SdkSessionFactory.create(...)` builds `SdkConfig` + `PlatformBundle` + `SentientSdk` + a scope, then `MobileSession(...)`. Held by `ChatViewModel`; `onCleared()` → `close()`.
- **iOS** — `createMobileSession(...)` in `iosMain` does the same; held by a `@StateObject` ViewModel; the view teardown path calls `close()`.

## PresenceCoordinator cold-start-skip (the double-connect bug)

`pause`/`resume` are driven by an app-scoped presence relay, NOT by the session:

- Android: `PresenceCoordinator` observes `ProcessLifecycleOwner`.
- iOS: a `scenePhase` observer in the chat VM with a `hasBackgrounded` guard.

The relay MUST skip the first foreground after a cold start. Otherwise `ChatViewModel.init` calls `open()` AND the presence `onStart` fires `resume()`/`forceReconnect()` at the same time → racing WS opens, auth timeout, churn. The fix: only relay foreground→`resume` once a real background has happened.

## Gotchas

- **Never make `MobileSession` a singleton.** One per chat identity; re-entry builds a fresh one. A cached session reuses a cancelled scope and a stale WS.
- `open()` is backgrounded — the UI does not await it. Optimistic send (the outbox) is what lets the user type before READY.
- `close()` cancels the scope, which cancels the `events`/`connection` collectors and the repositories. Do not hold references to a closed session's repos.
- `pause` uses `clearSession = false` so the user stays "in session" and the gate stays on chat; only logout (`disconnect(clearSession = true)`) falls back to login.
